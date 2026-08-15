/**
 * dsh-artifact-library — 产物库助手会话（P3）
 *
 * 在专属工作区创建/复用一个「产物库助手」会话，派发开场指令：
 * 让 agent 明确自己是产物库助手，任何会话里的自然语言提问
 * （「上次那个视频素材在哪」「这周产出了啥」）都由它调 artifact_* 工具回答。
 *
 * 机制与精化会话同款：
 *   workspace.create({payload:{path}}) → sessions.create({payload:{workspaceId}})
 *   → sessions.prompt({sessionId, mode:'queue', content:[{type:'text',text}]})
 *
 * 复用：meta.assistantSessionId 存助手会话 id，存在则直接 prompt。
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import fs from 'node:fs'

const ASSISTANT_WORKSPACE = dshHomePath('artifact-assistant')

const ASSISTANT_PROMPT = `你是「产物库助手」——DSH 产物库的专属问答员。用户会在这里用自然语言问你关于产物库的问题，例如：
- 「上次那个视频素材在哪」「番茄的封面图帮我找找」（用 artifact_find 语义搜索）
- 「这周产出了什么」「帮我看看这个项目」（用 artifact_list / artifact_stats / project_overview）
- 「这个产物和哪些资料相关」（用 artifact_suggest_links / artifact_get）
- 「库里有啥要整理的」（用 artifact_suggest_cleanup）

回答原则：
1. 先查库再回答，不要凭记忆编造；查不到就明确说没有，并给出接近的候选或建议换个说法。
2. 回答简洁：直接给结论 + 关键记录（ID/标题/项目/路径），不要长篇大论。
3. 需要整理/补全时，先说明建议，等用户确认再动手（artifact_trash / artifact_update）。
4. 管理页：http://127.0.0.1:3080/ext/artifact-library/`

/**
 * 打开/复用产物库助手会话并派发开场指令。
 * @param {object} api - ctx.apiProxy
 * @param {import('./store.js').ArtifactStore} store
 * @returns {Promise<{sessionId:string|undefined, ok:boolean, error?:string, reused:boolean}>}
 */
export async function openAssistantSession(api, store) {
  try {
    // 1. 复用已存在的助手会话：开场指令只需派发一次，直接返回
    let sessionId = store.meta.assistantSessionId
    let reused = !!sessionId
    if (sessionId) return { sessionId, ok: true, reused }

    // 2. 确保助手工作区（目录必须已存在，workspace.create 才接受该路径）
    let workspaceId
    try {
      fs.mkdirSync(ASSISTANT_WORKSPACE, { recursive: true })
      const wr = await api.workspace.create({ payload: { path: ASSISTANT_WORKSPACE } })
      workspaceId = wr?.result?.value?.workspace?.workspaceId
      if (!workspaceId) {
        const e = wr?.result?.error
        if (e) return { sessionId: undefined, ok: false, error: `workspace.create 失败: ${e.code}: ${e.message}` }
      }
    } catch (err) {
      return { sessionId: undefined, ok: false, error: `workspace 准备失败: ${err.message}` }
    }

    // 3. 创建助手会话
    try {
      const cr = await api.sessions.create({ payload: { workspaceId, title: '产物库助手' } })
      sessionId = cr?.result?.value?.sessionId
      if (!sessionId) throw new Error('sessions.create 未返回 sessionId')
      store.meta.assistantSessionId = sessionId
      store.saveMeta()
    } catch (err) {
      return { sessionId: undefined, ok: false, error: `会话创建失败: ${err.message}` }
    }

    // 4. 派发开场指令（仅新建时；apiProxy 是 RPC 形状：{payload:{...}}，业务错误要检查 result.ok）
    try {
      const pr = await api.sessions.prompt({ payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: ASSISTANT_PROMPT }] } })
      if (!pr?.result?.ok) {
        const e = pr?.result?.error
        const reason = e?.details?.reason ? ` (${e.details.reason})` : ''
        return { sessionId, ok: false, error: `prompt 被拒: ${e?.code}${reason}`, reused }
      }
    } catch (err) {
      return { sessionId, ok: false, error: `prompt 派发失败: ${err.message}`, reused }
    }
    return { sessionId, ok: true, reused }
  } catch (e) {
    return { sessionId: undefined, ok: false, error: e.message }
  }
}
