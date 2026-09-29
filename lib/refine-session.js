/**
 * dsh-artifact-library — 立即精炼会话
 *
 * 用户点「立即精炼」：在专属工作区创建/复用一个精化会话，
 * 派发一条"精化全部待精化条目"的 prompt，让 agent 当场干活。
 *
 * DSH 0.1.2-rc.1 起移除 ctx.apiProxy，本文件改为直接调用 Host 服务：
 *   ctx.workspaceController.create({ path })
 *   ctx.sessionController.create({ workspaceId })
 *   ctx.sessionController.rename({ sessionId, title })
 *   ctx.sessionController.prompt({ requestId, sessionId, mode, content }, signal)
 *
 * 复用：meta.refineSessionId 存精化会话 id，存在则直接 prompt。
 *
 * 临时模型（可选）：调用方可在 opts 传 provider/model，本次精炼会话改用该模型。
 * DSH 的 selectModel 会顺手把选择写进「部署默认模型」，所以派发后立即把默认改回原值——
 * 只恢复默认，不动精炼会话自己的选择（saveSelection 与 selectForNextRequest 是两处独立状态）。
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

const REFINE_WORKSPACE = dshHomePath('artifact-refine')

/** 批量上限兜底值（真正取值见设置项 refineBatchSize） */
const DEFAULT_BATCH_SIZE = 20

const PROMPT_TEMPLATE = `你是 DSH 产物库的精化专员。请把产物库中的待精化条目逐一精化，目标是让库从"文件名堆"变成"AI 整理过的档案库"：

1. 用 artifact_list 查看待精化条目（refine=1，带「⚡优先」标记的排最前、先处理）
2. 对每一条：
   - artifact_get 看记录
   - 若文件存在且可读（文本类），用 read 读一下内容
   - artifact_update 补全：summary（一句话说清这是什么、干什么用）、tags（2-5 个关键词）、project（合理的项目归属）、title（如有更好的命名）
3. 全部处理完后，再用 artifact_list refine=1 复核一遍，确保没有遗漏

注意：精化要基于真实文件内容，不要编造；图片类无法读内容的，至少补上合理的项目与类型。`

/**
 * 立即精炼：标记目标 → 确保工作区 → 复用/创建会话 → 派发 prompt。
 * @param {object} ctx - cordis 上下文（需注入 sessionController / workspaceController）
 * @param {import('./store.js').ArtifactStore} store
 * @param {{ids?:string[], project?:string, folder?:boolean, all?:boolean, provider?:string, model?:string}} opts
 *   provider/model 非空时，本次精炼临时使用该模型（不改部署默认）
 * @returns {Promise<{sessionId:string|undefined, ok:boolean, error?:string}>}
 */
export async function runRefineSession(ctx, store, opts = {}) {
  try {
    // 1. 标记目标（不传目标则全部待精化）
    if (opts.ids && opts.ids.length) store.requestRefine({ ids: opts.ids })
    else if (opts.project) store.requestRefine({ project: opts.project })
    else if (opts.folder) store.requestRefine({ folder: true })
    else {
      const pending = store.list({ refine: '1' }).map((r) => r.id)
      store.requestRefine({ ids: pending })
    }
    const pendingIds = store.list({ refine: '1' }).map((r) => r.id)
    const pendingCount = pendingIds.length

    // 2. 确保精化工作区（目录必须已存在，workspace.create 才接受该路径）
    //    缓存 workspaceId，避免每次点「立即精炼」都重复 create 同一路径的工作区
    let workspaceId = store.meta.refineWorkspaceId
    if (!workspaceId) {
      try {
        fs.mkdirSync(REFINE_WORKSPACE, { recursive: true })
        const wr = await ctx.workspaceController.create({ path: REFINE_WORKSPACE })
        workspaceId = wr?.workspace?.workspaceId
        if (!workspaceId) return { sessionId: undefined, ok: false, error: 'workspace.create 未返回 workspaceId' }
        store.meta.refineWorkspaceId = workspaceId
        store.saveMeta()
      } catch (err) {
        return { sessionId: undefined, ok: false, error: `workspace 准备失败: ${err.message}` }
      }
    }

    // 3. 复用或创建精化会话
    let sessionId = store.meta.refineSessionId
    if (!sessionId) {
      try {
        const cr = await ctx.sessionController.create({ workspaceId })
        sessionId = cr?.sessionId
        if (!sessionId) throw new Error('session.create 未返回 sessionId')
        // 旧版 API 创建会话时带 title；新 API 的 create 不带 title，改为 best-effort rename。
        try { await ctx.sessionController.rename({ sessionId, title: '产物精化' }) } catch { /* 标题失败不阻断精化 */ }
        store.meta.refineSessionId = sessionId
        store.saveMeta()
      } catch (err) {
        return { sessionId: undefined, ok: false, error: `会话准备失败: ${err.message}` }
      }
    }

    // 4. 临时指定模型（可选）：只让本次精炼用该模型；派发后立刻恢复部署默认，不影响其它会话
    const wantProvider = String(opts.provider || '').trim()
    const wantModel = String(opts.model || '').trim()
    const defaultModelSvc = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    let restoreDefault = null
    if (wantProvider && wantModel) {
      try {
        const before = defaultModelSvc?.currentSelection?.()
        if (before?.provider && before?.model) restoreDefault = { provider: before.provider, model: before.model }
        await ctx.sessionController.selectModel({ sessionId, provider: wantProvider, model: wantModel })
        store.meta.refineModelLast = `${wantProvider}/${wantModel}`
        store.saveMeta()
      } catch (err) {
        const code = err?.code ? ` (${err.code})` : ''
        return { sessionId: undefined, ok: false, error: `模型选择失败${code}: ${err?.message || err}` }
      }
    }

    // 5. 派发精化任务（Host 服务直接返回业务结果，失败会 throw RemoteError）
    //    分批：一次 prompt 只给明确的一批 id，避免上百条时中途失败且无法续做
    const batchSize = store.getSettings().refineBatchSize || DEFAULT_BATCH_SIZE
    const batchIds = pendingIds.slice(0, batchSize)
    const text = batchIds.length
      ? `${PROMPT_TEMPLATE}\n\n本次只精化下列 ${batchIds.length} 条（id 清单，逐条处理）：\n${batchIds.map((id) => `- ${id}`).join('\n')}\n\n（库中共 ${pendingCount} 条待精化；本批做完后回复「本批完成」，剩余条目下次派发。）`
      : `${PROMPT_TEMPLATE}\n\n（当前待精化为 0，已全部精化完成，简短确认即可。）`
    try {
      await ctx.sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      )
    } catch (err) {
      // 会话可能已被删除/失效：清掉缓存 id，下次重新创建，避免永久失败
      store.meta.refineSessionId = ''
      store.saveMeta()
      const code = err?.code ? ` (${err.code})` : ''
      return { sessionId: undefined, ok: false, error: `prompt 被拒${code}: ${err?.message || err}` }
    }
    // 6. 恢复部署默认模型：selectModel 会顺手改默认，这里只把默认改回去；
    //    精炼会话自己的选择（selectForNextRequest）不受影响，本次精炼仍用临时选的模型
    if (restoreDefault && defaultModelSvc?.saveSelection) {
      try { await defaultModelSvc.saveSelection(restoreDefault) } catch { /* 恢复失败不影响精炼 */ }
    }
    return { sessionId, ok: true, pendingCount }
  } catch (e) {
    // 同样自愈：任何异常都视为会话可能失效，下次重建
    if (store.meta.refineSessionId) {
      store.meta.refineSessionId = ''
      store.saveMeta()
    }
    return { sessionId: undefined, ok: false, error: e.message }
  }
}
