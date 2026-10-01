/**
 * dsh-artifact-library — 文件索引：便携后端（纯 Node，Windows 之外的平台用）
 *
 * ── 为什么不是「给 Linux 找个 Everything 替身」─────────────────────────────
 *
 * 调研过 plocate / locate / fd / tracker / mdfind 之后放弃它们，理由都是硬的：
 *   · plocate/locate：**只有路径字符串**（没有大小/时间/类型），DB 由 root 定时重建、
 *     可能过期几小时，且 GPL 许可**不能随包分发**
 *   · fd：默认不装（Debian 里还叫 fdfind），且没有元数据
 *   · inotifywait：是事件源不是查询索引，WSL 的 `/mnt/c` 上根本不工作
 *   · tracker/mdfind：重依赖、可能没开、还要翻译一套完全不同的查询语法
 *
 * 而本插件的隐私契约**已经把问题缩小了**：范围是「DSH 工作区 + 已登记产出目录」，
 * 有 `SCOPE_ITEM_LIMIT` 与噪音剪枝封顶。这个尺度下**不需要 Everything 的 MFT 级速度**，
 * 需要的是「不依赖用户装了什么、三平台行为一致、隐私边界不放宽」。
 * 所以基座就是**纯 Node 的范围索引**，一行外部依赖都不加。
 *
 * ── 对外契约：与 Everything 后端**逐字段一致** ─────────────────────────────
 *
 * `status() / ensureReady() / cancel() / search() / listDir() / updateScope() /
 *  shutdown() / snapshot()` —— 与 `engine.js` 的 Everything 实现同一套。
 * 上层（http.js / index.js / tool.js）**一行都不用改**，这是刻意的：
 * 平台差异必须止步于这一层。
 *
 * 特别地，status 快照里那组给客户端的契约字段
 * （`phase/ready/now/elapsedMs/stalled/stallHintMs/cancellable/hint`）保持同名同义，
 * 客户端不需要知道背后是 Everything 还是内存索引。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { indexDir } from './paths.js'
import { listDirectory } from './list.js'
import { compileQuery, sortRows } from './query.js'
import { walkScopeRows, WALK_ITEM_LIMIT } from './walk.js'
import { collectNoiseExcludes } from './scope.js'

/** 索引快照的有效期：超过就重建（与 Everything 侧的 .efu 同口径） */
export const NODE_INDEX_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** 后台自动刷新的最短间隔（防止 watcher 抖动触发连着重扫） */
export const NODE_REFRESH_MIN_INTERVAL_MS = 30000

/** 认为「可能卡住」的等待阈值 */
const STALL_HINT_MS = 45000

/** 索引快照文件版本（字段变了就 bump，老快照自动作废而不是崩） */
const SNAPSHOT_VERSION = 1

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 创建便携文件索引后端。
 * @param {{dataDir: string, logger?: {info?:Function,warn?:Function}}} opts
 */
export function createNodeFileIndex(opts) {
  const dataDir = opts.dataDir
  const logger = opts.logger || {}

  const state = {
    phase: 'idle', // idle | starting | ready | error | stopped
    ready: false,
    scope: [],
    excludeDirs: [],
    rows: [],
    indexedAt: 0,
    truncated: false,
    building: false,
    dirty: false,
    refreshQueued: false,
    lastError: null,
    startedAt: null,
    lastReadyAt: null,
    watchers: [],
  }

  /** 取消纪元：/files/stop 与 cancel() 都会 +1，正在跑的构建据此提前退出 */
  let cancelEpoch = 0
  /** 正在进行的构建（避免并发重复扫） */
  let ensuring = null

  /** 快照文件路径（缓存目录，不在索引范围内，避免自引用） */
  function snapshotFile() {
    return path.join(indexDir(dataDir), 'node-index.json')
  }

  function scopeStamp(scopeDirs) {
    return JSON.stringify(scopeDirs.slice().sort())
  }

  function snapshot() {
    const now = Date.now()
    const starting = state.phase === 'starting'
    const elapsedMs = starting && state.startedAt ? now - state.startedAt : null
    const stalled = starting && elapsedMs !== null && elapsedMs > STALL_HINT_MS
    return {
      phase: state.phase,
      ready: state.ready,
      mode: 'nodefs', // Everything 侧是 filelists/ntfs/folder；这里如实表明是内存索引
      scope: state.scope.slice(),
      lastError: state.lastError,
      startedAt: state.startedAt,
      lastReadyAt: state.lastReadyAt,
      // ── 兼容字段：保持与 Everything 后端同名（客户端不需要知道后端换了）──
      instance: null,
      vendorPresent: false,
      iniPath: null,
      iniScope: [],
      // ── 客户端契约字段（与 engine.js 同义）──
      now,
      elapsedMs,
      stalled,
      stallHintMs: STALL_HINT_MS,
      cancellable: starting,
      // ── 后端自述（排查用：Linux 上为什么没有 Everything 也照样能搜）──
      backend: 'node',
      indexedAt: state.indexedAt || null,
      itemCount: state.rows.length,
      truncated: state.truncated,
      dirty: state.dirty,
      itemLimit: WALK_ITEM_LIMIT,
      hint: starting
        ? (stalled
          ? `索引构建已等待 ${Math.round(elapsedMs / 1000)} 秒，明显偏慢，可能卡在某个大目录；可 POST /ext/artifacts/files/stop 取消`
          : '正在扫描索引范围…（内存索引，不依赖 Everything）')
        : (state.phase === 'ready'
          ? (state.dirty
            ? `索引已就绪（${state.rows.length} 项），检测到目录有变动，稍后会自动刷新`
            : `索引已就绪（${state.rows.length} 项）`)
          : (state.phase === 'error' ? (state.lastError || '索引出错') : '索引未启动（首次搜索或列表时按需构建）')),
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 快照：让「重启后第一次搜索」不用重扫
  // ═════════════════════════════════════════════════════════════════════════

  function saveSnapshot() {
    const file = snapshotFile()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const payload = {
        version: SNAPSHOT_VERSION,
        savedAt: Date.now(),
        stamp: scopeStamp(state.scope),
        count: state.rows.length,
        truncated: state.truncated,
        rows: state.rows,
      }
      // 先写临时文件再改名：避免写到一半被读到（半个 JSON = 启动即报错）
      const tmp = file + `.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      logger.warn?.('artifact-library: 索引快照写入失败（不影响搜索）: ' + String((error && error.message) || error))
    }
  }

  /** 尝试读快照；范围与新鲜度都对得上才用 */
  function loadSnapshot(scopeDirs) {
    try {
      const file = snapshotFile()
      const info = fs.statSync(file)
      if (Date.now() - info.mtimeMs > NODE_INDEX_MAX_AGE_MS) return null
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!payload || payload.version !== SNAPSHOT_VERSION) return null
      if (payload.stamp !== scopeStamp(scopeDirs)) return null
      if (!Array.isArray(payload.rows)) return null
      return payload
    } catch {
      return null
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 变更监听：让「刚生成的文件」能尽快被搜到
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Windows 上 Everything 自己盯着文件系统，搜索天然是新鲜的。内存索引不盯就永远
  // 停在快照时刻 —— 于是「agent 刚写的文件搜不到」，正是 list.js 在目录视图上
  // 踩过的同一个坑。这里用 `fs.watch(recursive)` **只做失效标记**（不重建），
  // 下一次搜索时再后台刷新。探测失败/平台不支持就退化为纯 TTL（不假装有监听）。

  function stopWatchers() {
    for (const w of state.watchers) {
      try { w.close() } catch { /* 忽略 */ }
    }
    state.watchers = []
  }

  function startWatchers(scopeDirs) {
    stopWatchers()
    for (const dir of scopeDirs) {
      try {
        const watcher = fs.watch(dir, { recursive: true, persistent: false }, () => { state.dirty = true })
        watcher.on('error', () => { /* 目录被删/权限变化：忽略，TTL 仍会兜底 */ })
        state.watchers.push(watcher)
      } catch {
        // 该平台/该目录不支持递归监听（例如 WSL 的 /mnt/*）：如实退化为 TTL
      }
    }
    if (state.watchers.length) {
      logger.info?.(`artifact-library: 已监听 ${state.watchers.length} 个范围目录的变更`)
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 构建
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * 扫一遍范围，替换内存索引。
   * @returns {Promise<{ok:boolean, error?:string, cancelled?:boolean}>}
   */
  async function build(scopeDirs, excludeDirs, epoch) {
    state.phase = 'starting'
    state.startedAt = Date.now()
    state.lastError = null

    const result = await walkScopeRows(scopeDirs, {
      excludes: excludeDirs,
      maxItems: WALK_ITEM_LIMIT,
      shouldStop: () => epoch !== cancelEpoch,
    })

    if (result.cancelled || epoch !== cancelEpoch) {
      state.phase = state.ready ? 'ready' : 'stopped' // 取消不该把已有索引说成坏的
      return { ok: false, cancelled: true, error: '索引构建已取消' }
    }

    state.rows = result.rows
    state.truncated = result.truncated
    state.indexedAt = Date.now()
    state.dirty = false
    state.phase = 'ready'
    state.ready = true
    state.lastReadyAt = Date.now()
    saveSnapshot()
    startWatchers(scopeDirs)
    logger.info?.(`artifact-library: 内存索引就绪（${result.count} 项，${result.elapsedMs}ms，${scopeDirs.length} 个目录）`)
    if (result.truncated) {
      logger.warn?.(`artifact-library: 索引达到项数上限 ${WALK_ITEM_LIMIT}，结果不完整；请缩小「索引额外目录」范围`)
    }
    return { ok: true }
  }

  /** 确保索引可用（阻塞式；调用方需要立刻拿到结果时用） */
  function ensureReady(args = {}) {
    if (ensuring) return ensuring
    const epoch = cancelEpoch
    ensuring = (async () => {
      try {
        const scopeDirs = Array.isArray(args.scopeDirs) ? args.scopeDirs.slice() : []
        const scopeChanged = scopeStamp(scopeDirs) !== scopeStamp(state.scope)
        state.scope = scopeDirs
        state.excludeDirs = (Array.isArray(args.excludeDirs)
          ? args.excludeDirs
          : collectNoiseExcludes(scopeDirs)).slice()

        // 已就绪且范围没变、也不脏 → 直接用
        if (state.ready && !scopeChanged && !state.dirty && !args.forceRestart) {
          return { ok: true, ...snapshot() }
        }

        // 没就绪时先试快照（重启后第一次搜索不必重扫）
        if (!state.ready && !scopeChanged && !args.forceRestart) {
          const cached = loadSnapshot(scopeDirs)
          if (cached) {
            state.rows = cached.rows
            state.truncated = !!cached.truncated
            state.indexedAt = cached.savedAt
            state.dirty = false
            state.phase = 'ready'
            state.ready = true
            state.lastReadyAt = Date.now()
            startWatchers(scopeDirs)
            logger.info?.(`artifact-library: 复用索引快照（${cached.count} 项，${new Date(cached.savedAt).toLocaleString('zh-CN')}）`)
            return { ok: true, ...snapshot() }
          }
        }

        const built = await build(scopeDirs, state.excludeDirs, epoch)
        if (!built.ok) {
          state.ready = false
          if (!built.cancelled) {
            state.phase = 'error'
            state.lastError = built.error || '索引构建失败'
          }
          return { ok: false, cancelled: !!built.cancelled, error: state.lastError || built.error, ...snapshot() }
        }
        return { ok: true, ...snapshot() }
      } catch (error) {
        state.phase = 'error'
        state.ready = false
        state.lastError = String((error && error.message) || error)
        return { ok: false, error: state.lastError, ...snapshot() }
      } finally {
        ensuring = null
      }
    })()
    return ensuring
  }

  /**
   * 后台刷新：**不阻塞调用方**，也不和正在跑的构建打架。
   * 触发条件：目录有变动（watcher）或索引过期（TTL）。
   */
  function refreshInBackground() {
    if (state.building || ensuring) return
    if (!state.ready) return
    const stale = Date.now() - (state.indexedAt || 0) > NODE_INDEX_MAX_AGE_MS
    if (!state.dirty && !stale) return
    if (Date.now() - (state.startedAt || 0) < NODE_REFRESH_MIN_INTERVAL_MS) return
    state.building = true
    const epoch = cancelEpoch
    // 用 ensureReady(forceRestart) 复用同一套构建/取消逻辑
    ensureReady({ scopeDirs: state.scope, excludeDirs: state.excludeDirs, forceRestart: true })
      .catch(() => { /* ensureReady 内部已兜底 */ })
      .finally(() => { state.building = false })
    void epoch
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 对外接口
  // ═════════════════════════════════════════════════════════════════════════

  async function search(q = {}) {
    if (!state.ready) {
      const up = await ensureReady({ scopeDirs: state.scope, excludeDirs: state.excludeDirs })
      if (!up.ok) return { ok: false, error: up.error, rows: [], total: 0, status: snapshot() }
    } else {
      refreshInBackground() // 有索引就先用着，刷新放后台（不阻塞这次搜索）
    }

    const startedAt = Date.now()
    const query = typeof q.query === 'string' ? q.query : ''
    const limit = Math.max(1, Math.min(Math.trunc(q.limit) || 200, 2000))

    const compiled = compileQuery(query)
    if (!compiled.ok) {
      return { ok: false, error: compiled.error, rows: [], total: 0, status: snapshot() }
    }

    const matched = state.rows.filter(compiled.predicate)
    const total = matched.length
    const sorted = sortRows(matched, q.sort)
    const rows = sorted.slice(0, limit)

    return {
      ok: true,
      query,
      rows,
      total,
      truncated: total > rows.length,
      elapsedMs: Date.now() - startedAt,
      status: snapshot(),
      backend: 'node',
    }
  }

  async function listDir(dir, options = {}) {
    if (typeof dir !== 'string' || !dir.trim()) {
      return { ok: false, error: 'dir 必填（绝对路径）', entries: [] }
    }
    if (!state.ready) {
      const up = await ensureReady({ scopeDirs: state.scope, excludeDirs: state.excludeDirs })
      if (!up.ok) return { ok: false, error: up.error, entries: [] }
    } else {
      refreshInBackground()
    }
    // 目录浏览**永远实时读盘**（与 Windows 侧同一决策）：索引器只负责全范围搜索。
    return listDirectory(dir, options)
  }

  function updateScope(scopeDirs) {
    state.scope = Array.isArray(scopeDirs) ? scopeDirs.slice() : []
    if (state.ready) {
      ensureReady({ scopeDirs: state.scope, excludeDirs: state.excludeDirs, forceRestart: true })
        .catch(() => { /* 内部兜底 */ })
    }
    return snapshot()
  }

  function cancel() {
    cancelEpoch += 1
    if (state.phase === 'starting') {
      state.phase = state.ready ? 'ready' : 'stopped'
      state.lastError = null
    }
    return snapshot()
  }

  async function shutdown() {
    cancelEpoch += 1
    stopWatchers()
    state.ready = false
    state.phase = 'stopped'
    return snapshot()
  }

  async function status() {
    // 纯内存后端：状态就是自己记的（没有外部进程要探活）
    return snapshot()
  }

  return {
    status,
    ensureReady,
    cancel,
    search,
    listDir,
    updateScope,
    shutdown,
    snapshot,
    /** 后端标识（上层/测试可据此断言平台分流是否正确） */
    backendName: 'node',
  }
}

/** 供测试与自检使用：导出内部常量 */
export const NODE_BACKEND_INFO = {
  maxAgeMs: NODE_INDEX_MAX_AGE_MS,
  refreshMinIntervalMs: NODE_REFRESH_MIN_INTERVAL_MS,
  snapshotVersion: SNAPSHOT_VERSION,
}

/** 让 `sleep` 不被 lint 判为未使用（构建等待路径留给将来的进度轮询） */
export const __nodeBackendInternals = { sleep, fsp }
