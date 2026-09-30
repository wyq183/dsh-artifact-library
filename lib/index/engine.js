/**
 * dsh-artifact-library — 文件索引：引擎门面
 *
 * 生命周期（**懒启动**：不搜索就不占用任何资源）：
 *   ensureReady()  → 写 ini（只在内容变化时）→ 探测实例 → 没跑就拉起 → 等就绪
 *   search()       → 走 es.js 的 export 通道
 *   shutdown()     → es -exit，让 Everything 自己保存配置（强杀会丢配置）
 *
 * 硬约束（实测换来，别改）：
 *   · **绝不用 taskkill/Stop-Process 关实例** —— Everything 退出时才写 ini，
 *     强杀会导致范围配置丢失、下次按默认索引全盘（隐私事故）。
 *   · 实例名固定 `DSHArtifacts`，与用户自己装的 Everything 完全隔离。
 *   · ini 内容变化后**必须重启实例**才生效。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EVERYTHING_EXE, INSTANCE_NAME, indexDir, dbDir, iniPath, statePath } from './paths.js'
import { ensureIni, readScopeFromIni } from './ini.js'
import { runEsQuery, runEsCount, runEsListDir } from './es.js'
import { collectNoiseExcludes, measureDir, SCOPE_ITEM_LIMIT } from './scope.js'

/** 跑一个探测型 es 命令（不走 export 通道，输出都是 ASCII） */
function runProbe(args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let child
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { if (child) child.kill() } catch { /* 忽略 */ }
      resolve({ code: -2, out: '' })
    }, timeoutMs)
    try {
      child = spawn(ES_EXE_PATH(), args, { windowsHide: true })
    } catch {
      clearTimeout(timer)
      return resolve({ code: -1, out: '' })
    }
    const out = []
    child.stdout.on('data', (c) => out.push(c))
    const settle = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out: Buffer.concat(out).toString('utf8').trim() })
    }
    child.on('close', (code) => settle(Number(code)))
    child.on('error', () => settle(-1))
  })
}

// ES 路径通过函数取，方便单测替换（保持模块降温）
function ES_EXE_PATH() {
  // eslint-disable-next-line no-undef
  return path.join(path.dirname(EVERYTHING_EXE), 'es.exe')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 创建文件索引门面。
 * @param {{dataDir: string, logger?: {info?:Function,warn?:Function}}} opts
 */
export function createFileIndex(opts) {
  const dataDir = opts.dataDir
  const logger = opts.logger || {}

  /** 运行态（内存，不持久化敏感信息） */
  const state = {
    phase: 'idle',        // idle | starting | ready | error | stopped
    ready: false,
    scope: [],
    excludeDirs: [],
    instancePid: null,
    lastError: null,
    startedAt: null,
    lastReadyAt: null,
  }

  /** 正在进行的 ensureReady（避免并发重复拉起） */
  let ensuring = null

  function snapshot() {
    return {
      phase: state.phase,
      ready: state.ready,
      mode: state.mode,
      scope: state.scope.slice(),
      lastError: state.lastError,
      startedAt: state.startedAt,
      lastReadyAt: state.lastReadyAt,
      instance: INSTANCE_NAME,
      vendorPresent: fs.existsSync(EVERYTHING_EXE),
      iniPath: iniPath(),
      iniScope: readScopeFromIni(),
    }
  }

  function persistState() {
    try {
      const file = statePath(dataDir)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ ...snapshot(), savedAt: Date.now() }, null, 2), 'utf8')
    } catch { /* 状态落盘失败不影响功能 */ }
  }

  /** 实例活着吗（退出码 0 = 有 IPC 应答） */
  async function ping() {
    const r = await runProbe(['-instance', INSTANCE_NAME, '-get-everything-version'])
    return r.code === 0
  }

  /** 拉起实例（detached：独立于宿主进程存活；忽略 stdio 避免管道） */
  function spawnInstance() {
    const child = spawn(EVERYTHING_EXE, ['-instance', INSTANCE_NAME, '-minimized'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    // 记下 PID：万一实例僵死，只有靠它才能**精确**清理（绝不能按进程名批量杀，
    // 用户机器上可能有别的 Everything —— 例如被 pcsuite 之类软件捆绑安装的）。
    state.instancePid = child.pid || null
    child.unref()
  }

  /**
   * 清理**僵死**的实例。
   *
   * 背景（2026-09-30 实测）：Everything 的 folder 模式遇到特定目录组合会启动即僵死，
   * 此时它**不响应任何 IPC**（连 `-exit` 都超时），会一直占着内存与句柄。
   *
   * 安全设计：
   *   ① 先尝试正常 `-exit`（它可能只是慢）
   *   ② 仍然活着 → 只杀**我们自己 spawn 记录下来的 PID**
   *   ③ **绝不** `taskkill /IM Everything.exe` 这类按名批量杀（会误伤用户的 Everything）
   * @returns {Promise<boolean>} 是否已确认清理
   */
  async function forceKillStuckInstance() {
    try {
      await runProbe(['-instance', INSTANCE_NAME, '-exit'], 8000)
    } catch { /* 忽略 */ }
    await sleep(1200)
    let alive = true
    try { alive = await ping() } catch { alive = false }
    if (!alive) {
      state.instancePid = null
      return true
    }
    const pid = state.instancePid
    if (!pid) {
      logger.warn?.('artifact-library: 实例无响应，但没有记录到 PID，为免误伤用户的 Everything 不做强杀')
      return false
    }
    try {
      process.kill(pid, 'SIGKILL')
      logger.info?.(`artifact-library: 已强杀僵死的索引实例（PID ${pid}）`)
      state.instancePid = null
      await sleep(800)
      return true
    } catch (error) {
      logger.warn?.('artifact-library: 清理僵死实例失败: ' + String((error && error.message) || error))
      return false
    }
  }

  /** 等实例就绪：能拿到 result-count（0 也算就绪） */
  async function waitReady(maxMs = 300000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      const r = await runProbe(['-instance', INSTANCE_NAME, '-get-result-count', '*'], 8000)
      if (r.code === 0 && /^\d+$/.test(r.out)) return true
      await sleep(2000)
    }
    return false
  }

  /** 正常关闭实例（让它保存 ini） */
  async function shutdown() {
    try {
      await runProbe(['-instance', INSTANCE_NAME, '-exit'], 15000)
    } catch { /* 忽略 */ }
    state.ready = false
    state.phase = 'stopped'
    persistState()
  }

  /**
   * 确保引擎可用。
   * @param {{scopeDirs: string[], forceRestart?: boolean}} args
   */
  function ensureReady(args) {
    if (ensuring) return ensuring
    ensuring = (async () => {
      try {
        const scopeDirs = Array.isArray(args && args.scopeDirs) ? args.scopeDirs : []
        state.scope = scopeDirs.slice()

        // ⚠️ 排除噪音目录是**必需**的（不是优化）：范围里一旦有 node_modules
        //    这类超大目录树，Everything 会启动即僵死（2026-09-30 实测）。
        //    调用方一般不用传，这里默认自动算；传了就尊重调用方。
        state.excludeDirs = (Array.isArray(args && args.excludeDirs)
          ? args.excludeDirs
          : collectNoiseExcludes(scopeDirs)).slice()

        if (!fs.existsSync(EVERYTHING_EXE)) {
          state.phase = 'error'
          state.ready = false
          state.lastError = `内置 Everything 缺失：${EVERYTHING_EXE}`
          persistState()
          return { ok: false, error: state.lastError, ...snapshot() }
        }

        const ini = ensureIni({ scopeDirs, excludeDirs: state.excludeDirs, dbDir: dbDir(dataDir) })
        const alive = await ping()

        const needStart = !alive || ini.changed || (args && args.forceRestart)
        if (needStart) {
          state.phase = 'starting'
          state.lastError = null
          if (alive) {
            logger.info?.('artifact-library: 索引范围变化，重启 Everything 实例以生效')
            await shutdown()
            await sleep(1500)
          }
          spawnInstance()
          state.startedAt = Date.now()
          const ok = await waitReady()
          if (!ok) {
            // ⚠️ 不等就绪的实例往往是**僵死**的（不响应 IPC），必须先清掉再报错，
            //    否则用户机器上会留一个卡死的 Everything 进程。
            const cleaned = await forceKillStuckInstance()
            state.phase = 'error'
            state.ready = false
            state.lastError = 'Everything 实例启动后未在 300 秒内就绪'
              + (cleaned ? '（僵死实例已清理）' : '（僵死实例未能清理，请手动结束 Everything (DSHArtifacts) 进程）')
            persistState()
            return { ok: false, error: state.lastError, ...snapshot() }
          }
        }

        state.phase = 'ready'
        state.ready = true
        state.lastReadyAt = Date.now()
        persistState()
        logger.info?.(`artifact-library: 文件索引就绪（范围 ${scopeDirs.length} 个目录）`)
        return { ok: true, ...snapshot() }
      } catch (error) {
        state.phase = 'error'
        state.ready = false
        state.lastError = String((error && error.message) || error)
        persistState()
        return { ok: false, error: state.lastError, ...snapshot() }
      } finally {
        ensuring = null
      }
    })()
    return ensuring
  }

  /**
   * 搜索。若引擎未就绪则先确保就绪（懒启动）。
   * @param {{query?:string, limit?:number, sort?:string}} q
   */
  async function search(q = {}) {
    if (!state.ready) {
      const up = await ensureReady({ scopeDirs: state.scope, excludeDirs: state.excludeDirs })
      if (!up.ok) return { ok: false, error: up.error, rows: [], total: 0, status: snapshot() }
    }
    const query = typeof q.query === 'string' ? q.query : ''
    const limit = Math.max(1, Math.min(Math.trunc(q.limit) || 200, 2000))
    const result = await runEsQuery({ dataDir, query, limit, sort: q.sort })
    if (!result.ok) {
      state.lastError = result.error || result.reason
      return { ok: false, error: state.lastError, rows: [], total: 0, elapsedMs: result.elapsedMs, status: snapshot() }
    }
    const counted = await runEsCount(dataDir, query)
    return {
      ok: true,
      query,
      rows: result.rows,
      total: counted.ok ? counted.total : result.rows.length,
      truncated: result.rows.length >= limit,
      elapsedMs: result.elapsedMs,
      status: snapshot(),
    }
  }

  /**
   * 列出目录的**直接子项**（目录树用）。
   *
   * 走 `-parent` 选项（实测：把 parent:"…" 当搜索串用会返回空）。
   * 每项的 `isDirectory` 来自尾部分隔符 —— 结果里没有类型字段。
   *
   * @param {string} dir 绝对路径
   * @param {{limit?:number}} [options]
   */
  async function listDir(dir, options = {}) {
    if (typeof dir !== 'string' || !dir.trim()) {
      return { ok: false, error: 'dir 必填（绝对路径）', entries: [] }
    }
    if (!state.ready) {
      const up = await ensureReady({ scopeDirs: state.scope, excludeDirs: state.excludeDirs })
      if (!up.ok) return { ok: false, error: up.error, entries: [] }
    }
    const result = await runEsListDir({ dataDir, dir, limit: options.limit })
    if (!result.ok) {
      return { ok: false, error: result.error || result.reason, entries: [], elapsedMs: result.elapsedMs }
    }
    const dirs = result.rows.filter((row) => row.isDirectory)
    const files = result.rows.filter((row) => !row.isDirectory)
    return {
      ok: true,
      dir,
      entries: result.rows,
      dirCount: dirs.length,
      fileCount: files.length,
      elapsedMs: result.elapsedMs,
      status: snapshot(),
    }
  }

  /**
   * 更新索引范围（供「主动纳管」调用）。
   *
   * 语义：
   *   · 只记录新的范围到内存
   *   · **若引擎已就绪**，在后台重启实例让新范围生效（不阻塞调用方）
   *   · 若未就绪，什么都不做 —— 下次 ensureReady 自然会用新范围
   *
   * ⚠️ 重启走 `es -exit`（Everything 退出才写 ini），绝不强杀。
   *
   * @param {string[]} scopeDirs 新的范围目录
   * @returns {object} 更新后的状态快照
   */
  function updateScope(scopeDirs) {
    state.scope = Array.isArray(scopeDirs) ? scopeDirs.slice() : []
    if (state.ready) {
      // 后台执行：调用方（事件回调）不该被几十秒的建索引阻塞
      ensureReady({ scopeDirs: state.scope, forceRestart: true })
        .catch(() => { /* ensureReady 内部已兜底并记录 lastError */ })
    }
    return snapshot()
  }

  return {
    status: async () => {
      const alive = await ping()
      state.ready = alive
      if (alive && state.phase !== 'ready') state.phase = 'ready'
      if (!alive && state.phase === 'ready') state.phase = 'stopped'
      return snapshot()
    },
    ensureReady,
    search,
    listDir,
    updateScope,
    shutdown,
    snapshot,
  }
}
