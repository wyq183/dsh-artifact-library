/**
 * dsh-artifact-library — 主动纳管：会话工作区 → 索引范围
 *
 * 这是依琪最强调的一条需求：「**主动读取 dsh 的工作区里面的内容来进行管理**」。
 *
 * 做法：订阅 `session/event`，从会话 header 上取 cwd（工作目录），
 * 新的工作区出现时通知上层（上层做防抖攒批 → 更新索引范围）。
 *
 * ⚠️ `session.header.cwd` 的取法有实证（2026-09-30 查证）：
 *   · 官方包 `dsh-api-session-controller/lib/index.js:1464` 就是
 *     `ctx.on("session/event", (session, event) => …)` 这个签名的
 *   · 社区插件 dsh-compaction-tune 用的是 `const header = session?.header`
 *   · 官方类型定义里 `agent.session.header.cwd` / `observation.header.cwd` 反复出现
 *   所以从 `session.header.cwd` 取；取不到再退回 `session.cwd`（防御式）。
 *
 * 安全：整体 try/catch（观察者异常会污染平台事件总线）；去重避免同一个 cwd 反复通知。
 */

import { canonical } from './scope.js'

/**
 * 挂载工作区监视器。
 *
 * @param {object} ctx cordis 上下文
 * @param {{
 *   onChange: (cwd: string) => void,
 *   logger?: {warn?:Function, info?:Function}
 * }} options
 * @returns {Function} disposer
 */
export function attachWorkspaceWatcher(ctx, options = {}) {
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {}
  const logger = options.logger || {}
  /**
   * 已经通知过的 cwd。
   *
   * ⚠️ 2026-10-01 改：原来是 `cwd.toLowerCase()`（无条件折叠）。后果是 Linux 上
   *    `/home/A` 与 `/home/a` 被当成同一个工作区，**第二个真实工作区永远不会被纳管**。
   *    现在走 `canonical()` —— **按路径形态折叠**：`C:\Proj`/`c:\proj` 仍然算同一个
   *    （Windows 语义不变），POSIX 路径不再被误合并。
   */
  const seen = new Set()

  const handler = (session, event) => {
    try {
      const cwd = extractCwd(session)
      if (!cwd) return
      const key = canonical(cwd)
      if (seen.has(key)) return
      seen.add(key)
      logger.info?.(`artifact-library: 发现新工作区 ${cwd}，将纳入文件索引范围`)
      onChange(cwd)
    } catch (error) {
      // 绝不外抛：事件观察者异常会影响平台
      logger.warn?.('artifact-library: 工作区监视器出错（已忽略）: ' + String((error && error.message) || error))
    }
    // event 目前用不到（将来可按 turn/end 做增量刷新），显式标注避免 lint 疑惑
    void event
  }

  let off
  try {
    off = ctx.on('session/event', handler)
  } catch (error) {
    logger.warn?.('artifact-library: 无法订阅 session/event，主动纳管未启用: ' + String((error && error.message) || error))
    return () => {}
  }

  return () => {
    try { off() } catch { /* 忽略 */ }
  }
}

/** 从会话对象里尽力取出工作目录 */
export function extractCwd(session) {
  if (!session || typeof session !== 'object') return ''
  const candidates = [
    session.header && session.header.cwd,
    session.cwd,
    session.header && session.header.workspace && session.header.workspace.path,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** 取会话 id（诊断用） */
export function extractSessionId(session) {
  if (!session || typeof session !== 'object') return ''
  const id = (session.header && session.header.id) || session.id
  return typeof id === 'string' ? id : ''
}
