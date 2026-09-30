/**
 * dsh-artifact-library — 自动采集（session 事件钩子）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 先澄清一件事（2026-09-30 实测，任务描述里的前提与代码不符）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 本插件**从来没有「扫全盘」这回事**。这个模块只订阅 `session/event`，
 * 只从**变更工具的调用参数**里取路径。它**不 readdir、不遍历目录、不按扩展名发现文件**。
 * （`lib/index/watch.js` 会把会话 cwd 加进**文件索引范围**，那是给搜索用的，**不登记产物**。）
 *
 * 数据也支持这一点：artifacts.json 233 条记录的 `source` **100% 是三者之一**
 * （manual 177 / session 52 / folder-import 4），**没有一条是「扫描发现」**；
 * 52 条 session 记录**全部带 session_id**（= 来自工具调用钩子）。
 * ⚠️ 上面是**全量**口径；只算**用户看得见的有效记录**（191 条 = 未归档未回收）时是
 * manual 144 / session 43 / folder-import 4 —— 报告数字时请用后者，别用全量吓自己。
 *
 * 所以本模块的采集来源按置信度分三档：
 *   · **A. `deliverables/presented`**（模型用官方 present 工具**明确声明**）→ `source: 'present'`
 *   · **B. 变更工具的路径**（write/edit/apply_patch … 真的动过）        → `source: 'session'`
 *   · **C. 用户手动登记 / 文件夹导入**（不在本模块，走 tools.js / HTTP）→ `source: 'manual' | 'folder-import'`
 *
 * 「全盘扫描」那类低置信来源**不存在**，将来也不该加 —— 噪声会淹没信号。
 *
 * 安全设计：
 * - 全程本地，不上传任何内容
 * - 监听器整体 try/catch（平台也会兜住 session/event 观察者异常）
 * - 用 store.byPath 去重，只登记存在的文件，跳过目录
 * - 每轮上限 maxPerTurn，防爆量
 * - 尊重 `meta.autoCollect` 开关（设置面板可实时关）
 */

import path from 'node:path'
import fs from 'node:fs'
import { extractCwd } from './index/watch.js'

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
  // 每轮上限：调用方显式传入优先，否则实时读设置（设置面板改完立即生效）
  const maxPerTurnOverride = Number(opts.maxPerTurn) || 0

  /** sessionId -> Set<path>（当前 turn 收集的路径） */
  const pending = new Map()

  const handler = (session, event) => {
    try {
      // 动态开关：从 meta 读（设置面板可实时改）
      if (store.meta.autoCollect === false) return

      // ── A 类：官方 present 工具声明的交付物（最高置信来源）─────────────
      //
      // 事件形状（查证 @deepseek-ai/dsh-tool-present/lib/index.js:116）：
      //   session.append('deliverables/presented', { turn, callId, files: [{ path, description? }] })
      //   · 只在工具调用**成功**时追加（`ctx.on('tools/result')` 里 `result.isError` 就直接 return）
      //   · 追加前官方已经校验过「文件存在且是普通文件」——所以这是**已验证**的信号
      //   · `path` 是**作者原样写的路径**，"Relative paths use the Session working directory"
      //     → 相对路径必须按 session 的工作目录解析成绝对路径才能登记
      //
      // ⚠️ 时序：本事件在 `tools/result` 时追加（**回合进行中**），而 B 类的登记在 `turn/end`。
      //    所以同一回合里被 present 的文件，会先以 'present' 落库；turn/end 再看到它时
      //    只做 byPath 命中 → 跳过（不会降级成 'session'）。
      if (event.type === 'deliverables/presented') {
        const files = event.data && Array.isArray(event.data.files) ? event.data.files : []
        if (files.length === 0) return
        const cwd = extractCwd(session)
        const key = session?.id || ''
        const maxPerTurn = maxPerTurnOverride || store.getSettings().maxPerTurn || 20
        let added = 0
        let skipped = 0
        for (const file of files) {
          if (added >= maxPerTurn) break
          const raw = file && typeof file.path === 'string' ? file.path.trim() : ''
          if (!raw) continue
          // 相对路径按会话工作目录解析；解析不出来（没有 cwd）就跳过，绝不猜
          const abs = path.isAbsolute(raw) ? path.normalize(raw) : (cwd ? path.resolve(cwd, raw) : '')
          if (!abs) { skipped++; continue }
          try {
            if (store.byPath(abs)) { skipped++; continue }
            const st = fs.statSync(abs)
            if (!st.isFile()) { skipped++; continue }
            store.register({
              path: abs,
              kind: 'deliverable',
              source: 'present',
              session_id: key,
              // 官方 present 允许一句 description，放 notes（不污染 tags：那会让标签云长出一堆合成词）
              notes: file && typeof file.description === 'string' ? file.description : '',
            })
            added++
          } catch { /* 单条失败不影响其余 */ }
        }
        if (added > 0) ctx.logger?.info?.(`artifact-library: present 声明登记 ${added} 个交付物（跳过 ${skipped}）`)
        return
      }

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
        const maxPerTurn = maxPerTurnOverride || store.getSettings().maxPerTurn || 20
        const key = session?.id || 'global'
        const paths = pending.get(key)
        pending.delete(key)
        if (!paths || paths.size === 0) return
        const now = Math.floor(Date.now() / 1000)
        let added = 0
        let refreshed = 0
        let dropped = 0
        for (const p of paths) {
          if (added >= maxPerTurn) { dropped++; continue }
          try {
            const existing = store.byPath(p)
            if (existing) {
              // 已登记：文件若被改动，刷新体积/时间/存在性
              // （否则记录里的快照永远停在首次登记那一刻，missing/size 会失真）
              try {
                const st = fs.statSync(p)
                if (!st.isFile()) continue
                const size = st.size
                const mtime = Math.floor(st.mtimeMs / 1000)
                if (existing.size_bytes !== size || existing.file_modified_at !== mtime || existing.exists !== true) {
                  existing.size_bytes = size
                  existing.file_modified_at = mtime
                  existing.exists = true
                  existing.updated_at = now
                  refreshed++
                }
              } catch {
                if (existing.exists !== false) { existing.exists = false; refreshed++ }
              }
              continue
            }
            const st = fs.statSync(p)
            if (!st.isFile()) continue // 目录不登记
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
        if (refreshed > 0) { try { store.save() } catch { /* 刷新落盘失败不影响整轮 */ } }
        // 超上限丢弃时留痕，不再静默
        if (dropped > 0) ctx.logger?.warn?.(`artifact-library: auto-collect hit maxPerTurn=${maxPerTurn}, dropped ${dropped} path(s) this turn`)
        ctx.logger?.info?.(`artifact-library: auto-collected ${added} deliverable(s), refreshed ${refreshed} from turn`)
      }
    } catch { /* 绝不外抛：平台也会兜住，这里再兜一层 */ }
  }

  const off = ctx.on('session/event', handler)
  return () => { try { off() } catch {} }
}
