/**
 * dsh-artifact-library — 文件索引：ES（Everything 命令行）调用封装
 *
 * ── 为什么走 `-export-json <文件>` 而不是读 stdout ⚠️ 2026-09-30 实测 ──────────
 * `es.exe` 的 stdout 是**系统 ANSI（GBK）**编码，而 Node **内置不支持 GBK 解码**：
 *   · buf.toString('utf8')   → "…\\���� ����(����).txt"      （乱码）
 *   · buf.toString('latin1') → "…\\ÖÐÎÄ Ãû×Ö(²âÊÔ).txt"    （「中文」的 GBK 字节）
 * 改用 `-export-json <file> -utf8-bom` 写文件后是 **UTF-8 + BOM**（hex `efbbbf`），
 * JSON.parse 拿到完全正确的中文路径。代价只是每次查询多写一个几毫秒的小文件。
 *
 * ── 其它实测结论 ────────────────────────────────────────────────────────────
 * · 字段名：`filename`（完整路径）/ `size` / `date_modified` / `date_created`
 * · 时间默认是 **Windows FILETIME**（100ns since 1601）；加 `-date-format 1` 走 ISO-8601
 * · **不要用 `-path-column`**：它把 `filename` 拆成 `path` 并丢掉文件名
 * · 空结果是「stdout 空 + 退码 0」，与出错（退码非 0）可区分
 * · Everything **只索引文件名/路径，不索引内容** —— 内容检索是另一回事
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ES_EXE, INSTANCE_NAME, indexDir } from './paths.js'

/** ES 退出码语义（官方文档 CLI 页） */
const EXIT_REASONS = {
  1: 'register-window-class-failed',
  2: 'create-window-failed',
  3: 'out-of-memory',
  4: 'bad-option',
  5: 'export-file-failed',
  6: 'unknown-switch',
  7: 'ipc-query-failed',
  8: 'ipc-window-not-found',
  9: 'no-results',
}

export function describeExitCode(code) {
  if (code === 0) return 'ok'
  return EXIT_REASONS[code] || `unknown(${code})`
}

/** FILETIME（1601-01-01 起的 100ns 数）→ Unix 秒 */
const FILETIME_UNIX_DIFF = 116444736000000000n

function toUnixSeconds(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const t = Date.parse(value) // -date-format 1 → ISO-8601
    return Number.isFinite(t) ? Math.floor(t / 1000) : null
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  try {
    return Number((BigInt(Math.trunc(n)) - FILETIME_UNIX_DIFF) / 10000000n)
  } catch {
    return null
  }
}

/** 把 ES 的一行结果归一化成插件内部形状 */
export function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null
  const full = String(row.filename || row.name || '').trim()
  if (!full) return null
  const ext = path.extname(full).replace(/^\./, '').toLowerCase()
  // Everything 的目录路径带尾部分隔符（除非显式关掉）—— 靠它判断类型，
  // 因为结果里**没有**类型字段（2026-09-30 实测）。
  const isDirectory = /[\\/]$/.test(full)
  return {
    path: full,
    isDirectory,
    name: path.basename(full),
    dir: path.dirname(full),
    ext,
    size: Number(row.size) || 0,
    modified: toUnixSeconds(row.date_modified),
    created: toUnixSeconds(row.date_created),
  }
}

/**
 * 串行队列 —— Everything 查询本身很快，没必要并发；
 * 串行还能保证临时文件不撞名、不把磁盘 I/O 打满。
 */
let queueTail = Promise.resolve()

function enqueue(task) {
  const result = queueTail.then(task, task)
  queueTail = result.then(() => undefined, () => undefined)
  return result
}

let tempSeq = 0

/**
 * 跑一次查询。
 *
 * @param {object} opts
 * @param {string} opts.dataDir  插件数据目录（临时文件放它下面的 index/tmp）
 * @param {string} opts.query    Everything 搜索语法；空串表示全部
 * @param {number} [opts.limit]  最多返回条数
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.sort]   Everything 排序名（name/path/size/date-modified…）
 * @returns {Promise<{ok:boolean, code:number, reason:string, rows:Array, elapsedMs:number, error?:string}>}
 */
export function runEsQuery(opts) {
  return enqueue(() => runOnce(opts))
}

function runOnce({ dataDir, query, limit = 200, timeoutMs = 15000, sort, buildArgs }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tmpDir = path.join(indexDir(dataDir), 'tmp')
    tempSeq += 1
    const outFile = path.join(tmpDir, `es-${process.pid}-${Date.now()}-${tempSeq}.json`)

    const finish = (payload) => {
      try { fs.unlinkSync(outFile) } catch { /* 没生成就算了 */ }
      resolve({ elapsedMs: Date.now() - started, ...payload })
    }

    try {
      fs.mkdirSync(tmpDir, { recursive: true })
    } catch (error) {
      return finish({ ok: false, code: -1, reason: 'tmp-dir-failed', rows: [], error: String(error && error.message || error) })
    }

    let args
    if (typeof buildArgs === 'function') {
      args = buildArgs(outFile)
    } else {
      args = [
        '-instance', INSTANCE_NAME,
        '-export-json', outFile,
        '-utf8-bom',
        '-date-format', '1',
        '-size', '-dm', '-dc',
        '-n', String(Math.max(1, Math.min(Math.trunc(limit) || 200, 10000))),
      ]
      if (sort) args.push('-sort', String(sort))
      args.push(query && query.trim() ? query : '*')
    }

    let child
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child && child.kill() } catch { /* 忽略 */ }
      finish({ ok: false, code: -2, reason: 'timeout', rows: [], error: `es.exe 超时（${timeoutMs}ms）` })
    }, Math.max(1000, timeoutMs))

    try {
      child = spawn(ES_EXE, args, { windowsHide: true })
    } catch (error) {
      clearTimeout(timer)
      return finish({ ok: false, code: -1, reason: 'spawn-failed', rows: [], error: String(error && error.message || error) })
    }

    const stderrChunks = []
    child.stderr.on('data', (c) => stderrChunks.push(c))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish({ ok: false, code: -1, reason: 'spawn-error', rows: [], error: String(error && error.message || error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      // 退出码非 0：直接报错（8 = Everything 实例没在跑，是最常见的）
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('latin1').trim()
        return finish({
          ok: false,
          code: Number(code),
          reason: describeExitCode(Number(code)),
          rows: [],
          error: stderr || `es.exe 退出码 ${code}（${describeExitCode(Number(code))}）`,
        })
      }

      // 读导出文件（UTF-8 + BOM）
      let text
      try {
        text = fs.readFileSync(outFile, 'utf8')
      } catch {
        // 没有文件 = 没结果（空查询也会生成文件，所以这里通常是"确实没有"）
        return finish({ ok: true, code: 0, reason: 'ok', rows: [] })
      }

      let parsed
      try {
        // 零结果时 es 写出的文件**只有 BOM**（实测 3 bytes、退出码 0），
        // 此时 JSON.parse('') 会抛 "Unexpected end of JSON input" ——
        // 那是**正常结果**（没匹配到），不是错误。
        // 2026-09-30 真机踩到：界面把「没搜到」显示成了 HTTP 500。
        const cleaned = text.replace(/^\uFEFF/, '').trim()
        parsed = cleaned ? JSON.parse(cleaned) : []
      } catch (error) {
        return finish({ ok: false, code: -3, reason: 'parse-failed', rows: [], error: String(error && error.message || error), rawHead: text.slice(0, 200) })
      }

      const list = Array.isArray(parsed) ? parsed : []
      const rows = list.map(normalizeRow).filter(Boolean)
      return finish({ ok: true, code: 0, reason: 'ok', rows })
    })
  })
}

/**
 * 列出某目录的**直接子项**（目录树用）。
 *
 * ⚠️ 必须用 `-parent` **选项**：2026-09-30 实测，把 `parent:"…"` 当搜索串用、
 * 或用 `path:"…" depth:1`，**都返回空**。
 *
 * 返回项的 `isDirectory` 来自尾部分隔符（结果里没有类型字段）。
 *
 * @param {{dataDir:string, dir:string, limit?:number, timeoutMs?:number}} opts
 */
export function runEsListDir(opts) {
  const { dataDir, dir, limit = 500, timeoutMs = 15000 } = opts || {}
  return enqueue(() => runOnce({
    dataDir,
    timeoutMs,
    buildArgs: (outFile) => [
      '-instance', INSTANCE_NAME,
      '-export-json', outFile,
      '-utf8-bom',
      '-date-format', '1',
      '-size', '-dm', '-dc',
      '-n', String(Math.max(1, Math.min(Math.trunc(limit) || 500, 5000))),
      '-parent', String(dir),
    ],
  }))
}

/**
 * 取结果总数（不拉全量结果，用于"共 N 条"）。
 * @returns {Promise<{ok:boolean, total:number, error?:string}>}
 */
export function runEsCount(dataDir, query, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let child
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child && child.kill() } catch { /* 忽略 */ }
      resolve({ ok: false, total: 0, error: 'get-result-count 超时' })
    }, Math.max(1000, timeoutMs))

    try {
      child = spawn(ES_EXE, ['-instance', INSTANCE_NAME, '-get-result-count', query && query.trim() ? query : '*'], { windowsHide: true })
    } catch (error) {
      clearTimeout(timer)
      return resolve({ ok: false, total: 0, error: String(error && error.message || error) })
    }

    const out = []
    child.stdout.on('data', (c) => out.push(c))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, total: 0, error: String(error && error.message || error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const text = Buffer.concat(out).toString('utf8').trim()
      const total = Number.parseInt(text, 10)
      if (code !== 0 || !Number.isFinite(total)) {
        return resolve({ ok: false, total: 0, error: `退出码 ${code}（${describeExitCode(Number(code))}）` })
      }
      resolve({ ok: true, total })
    })
  })
}
