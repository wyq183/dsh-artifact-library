/**
 * dsh-artifact-library — 自动采集（session 事件钩子）
 *
 * 订阅 `session/event`：收集每轮"文件变更工具"的 tool/call 路径，
 * 在 turn/end 时批量登记为产出（kind=deliverable, source=session）。
 *
 * 安全设计：
 * - 全程本地，不上传任何内容
 * - 监听器整体 try/catch（平台也会兜住 session/event 观察者异常）
 * - 用 store.byPath 去重，只登记存在的文件，跳过目录
 * - 每轮上限 maxPerTurn，防爆量
 */

import path from 'node:path'
import fs from 'node:fs'

/** 默认的文件变更工具名（可按需覆盖）。保守集合，避免误抓读类工具。 */
const DEFAULT_MUTATION_TOOLS = new Set([
  'write', 'edit', 'str_replace_editor', 'replace_in_file', 'apply_patch',
  'multi_tool_use.parallel',
])

/** 从工具参数里尽量提取目标文件路径 */
function extractPath(name, args) {
  if (typeof args !== 'object' || args === null) return null
  for (const key of ['path', 'filePath', 'file', 'filename']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim() && !v.includes('\n')) return v.trim()
  }
  // str_replace_editor 的 command 形态：{ command: 'create'|'insert'|'str_replace', path, ... }
  if (name === 'str_replace_editor' && typeof args.command === 'string') {
    const p = args.path
    if (typeof p === 'string' && p.trim()) return p.trim()
  }
  return null
}

/**
 * 挂载自动采集。返回 disposer。
 * @param {object} ctx - cordis 上下文（apply 的 ctx）
 * @param {import('./store.js').ArtifactStore} store
 * @param {{autoCollect?:boolean, mutationTools?:string[], maxPerTurn?:number}} opts
 */
export function attachAutoCollect(ctx, store, opts = {}) {
  const tools = new Set(opts.mutationTools && opts.mutationTools.length ? opts.mutationTools : DEFAULT_MUTATION_TOOLS)
  const maxPerTurn = Number(opts.maxPerTurn) || 20

  /** sessionId -> Set<path>（当前 turn 收集的路径） */
  const pending = new Map()

  const handler = (session, event) => {
    try {
      // 动态开关：从 meta 读（设置面板可实时改）
      if (store.meta.autoCollect === false) return
      if (event.type === 'tool/call') {
        const { name, arguments: argsStr } = event.data
        if (!tools.has(name)) return
        let args
        try { args = JSON.parse(argsStr) } catch { return }
        const p = extractPath(name, args)
        if (!p) return
        const key = session?.id || 'global'
        if (!pending.has(key)) pending.set(key, new Set())
        pending.get(key).add(path.normalize(p))
        return
      }
      if (event.type === 'turn/end') {
        const key = session?.id || 'global'
        const paths = pending.get(key)
        pending.delete(key)
        if (!paths || paths.size === 0) return
        const now = Math.floor(Date.now() / 1000)
        let added = 0
        for (const p of paths) {
          if (added >= maxPerTurn) break
          try {
            if (store.byPath(p)) continue // 已登记，去重
            const st = fs.statSync(p)
            if (!st.isFile()) continue // 目录不登记
            const probe = { size_bytes: st.size, file_modified_at: Math.floor(st.mtimeMs / 1000) }
            const parentDir = path.basename(path.dirname(p))
            store.register({
              path: p,
              kind: 'deliverable',
              source: 'session',
              session_id: key === 'global' ? '' : key, // P2：记录来源会话，可回看诞生过程
              tags: parentDir && parentDir !== '.' ? [parentDir] : [],
            })
            added++
          } catch { /* 单条失败不影响整轮 */ }
        }
        ctx.logger?.info?.(`artifact-library: auto-collected ${added} deliverable(s) from turn`)
      }
    } catch { /* 绝不外抛：平台也会兜住，这里再兜一层 */ }
  }

  const off = ctx.on('session/event', handler)
  return () => { try { off() } catch {} }
}
