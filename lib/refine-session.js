/**
 * dsh-artifact-library — 立即精炼会话
 *
 * 用户点「立即精炼」：在专属工作区创建/复用一个精化会话，
 * 派发一条"精化全部待精化条目"的 prompt，让 agent 当场干活。
 *
 * 机制（与 dsh-browser 桥接插件同款）：
 *   workspace.create({payload:{path}}) → sessions.create({payload:{workspaceId}})
 *   → sessions.prompt({sessionId, mode:'queue', content:[{type:'text',text}]})
 *
 * 复用：meta.refineSessionId 存精化会话 id，存在则直接 prompt。
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import fs from 'node:fs'

const REFINE_WORKSPACE = dshHomePath('artifact-refine')

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
 * @param {object} api - ctx.apiProxy
 * @param {import('./store.js').ArtifactStore} store
 * @param {{ids?:string[], project?:string, folder?:boolean, all?:boolean}} opts
 * @returns {Promise<{sessionId:string|undefined, ok:boolean, error?:string}>}
 */
export async function runRefineSession(api, store, opts = {}) {
  try {
    // 1. 标记目标（不传目标则全部待精化）
    if (opts.ids && opts.ids.length) store.requestRefine({ ids: opts.ids })
    else if (opts.project) store.requestRefine({ project: opts.project })
    else if (opts.folder) store.requestRefine({ folder: true })
    else {
      const pending = store.list({ refine: '1' }).map((r) => r.id)
      store.requestRefine({ ids: pending })
    }
    const pendingCount = store.list({ refine: '1' }).length

    // 2. 确保精化工作区（目录必须已存在，workspace.create 才接受该路径）
    let workspaceId
    try {
      fs.mkdirSync(REFINE_WORKSPACE, { recursive: true })
      const wr = await api.workspace.create({ payload: { path: REFINE_WORKSPACE } })
      workspaceId = wr?.result?.value?.workspace?.workspaceId
      if (!workspaceId) {
        const e = wr?.result?.error
        if (e) return { sessionId: undefined, ok: false, error: `workspace.create 失败: ${e.code}: ${e.message}` }
      }
    } catch (err) {
      return { sessionId: undefined, ok: false, error: `workspace 准备失败: ${err.message}` }
    }

    // 3. 复用或创建精化会话
    let sessionId = store.meta.refineSessionId
    if (!sessionId) {
      const cr = await api.sessions.create({ payload: { workspaceId, title: '产物精化' } })
      sessionId = cr?.result?.value?.sessionId
      if (!sessionId) throw new Error('sessions.create 未返回 sessionId')
      store.meta.refineSessionId = sessionId
      store.saveMeta()
    }

    // 4. 派发精化任务（apiProxy 是 RPC 形状：{payload:{...}}；业务错误不抛异常，要检查 result.ok）
    const text = `${PROMPT_TEMPLATE}\n\n（本次共 ${pendingCount} 条待精化；若为 0，说明已全部精化完成，简短确认即可。）`
    const pr = await api.sessions.prompt({ payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] } })
    if (!pr?.result?.ok) {
      const e = pr?.result?.error
      const reason = e?.details?.reason ? ` (${e.details.reason})` : ''
      return { sessionId, ok: false, error: `prompt 被拒: ${e?.code}${reason}` }
    }
    return { sessionId, ok: true, pendingCount }
  } catch (e) {
    return { sessionId: undefined, ok: false, error: e.message }
  }
}
