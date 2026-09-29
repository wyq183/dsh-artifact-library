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
import { runEsQuery, runEsCount } from './es.js'

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
    child.unref()
  }

  /** 等实例就绪：能拿到 result-count（0 也算就绪） */
  async function waitReady(maxMs = 90000) {
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

        if (!fs.existsSync(EVERYTHING_EXE)) {
          state.phase = 'error'
          state.ready = false
          state.lastError = `内置 Everything 缺失：${EVERYTHING_EXE}`
          persistState()
          return { ok: false, error: state.lastError, ...snapshot() }
        }

        const ini = ensureIni({ scopeDirs, dbDir: dbDir(dataDir) })
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
            state.phase = 'error'
            state.ready = false
            state.lastError = 'Everything 实例启动后未在 90 秒内就绪'
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
      const up = await ensureReady({ scopeDirs: state.scope })
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
    shutdown,
    snapshot,
  }
}
