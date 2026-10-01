/**
 * dsh-artifact-library — 文件索引：范围扫描器（异步、有界、平台中立）
 *
 * ── 它和 `efu.js` 的关系 ───────────────────────────────────────────────────
 *
 * `efu.js` 的 `generateEfu()` 做的事**一模一样**，只是两处不同：
 *   · 它是**同步**的（`readdirSync`/`lstatSync`）—— 因为 Everything 只接受一个 .efu 文件
 *   · 它把结果**序列化**成 EFU（FILETIME / CRLF / BOM / 目录加尾部反斜杠）
 *
 * 同步扫描在 Windows 上没暴露问题（清单最长 6 小时才重建一次，且是后台触发），
 * 但 Linux 的内存索引要**直接吃这份结果**，同步遍历几十万项会**卡死事件循环**
 * —— dsh web 会整段无响应。所以这里单独给一份异步实现，而**规则从 scope.js 统一取**
 * （噪音目录名单、大小写折叠、链接不跟随、项数与时限封顶），保证两边语义不分叉。
 *
 * ⚠️ 两边的规则必须同步改：改 `NOISE_DIR_NAMES` 只改 scope.js 一处即可，
 *    改「扫描方式」才需要动这里。
 *
 * ── 三条安全/稳定性约束（与 efu.js 同源）──────────────────────────────────
 *   ① 链接（symlink/junction）**只记录条目本身、不跟随** —— 不然会掉进外部大目录
 *   ② 噪音目录**命中即剪枝**（node_modules 内部动辄几万项）
 *   ③ 项数与时间**双封顶** —— 范围失控时不能把机器拖死、把内存撑爆
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  NOISE_DIR_NAMES, NOISE_DIR_PREFIXES, canonical, isNoiseDirName,
} from './scope.js'

/** 单次扫描的项数上限（内存行集约 200B/项 → 30 万项 ≈ 60MB，是能接受的上界） */
export const WALK_ITEM_LIMIT = 300000

/** 单次扫描的时间上限 */
export const WALK_DEADLINE_MS = 120000

/** 目录内并发 lstat 数（纯 readdir 拿不到体积/时间，必须逐条 stat） */
export const WALK_CONCURRENCY = 64

/** 有并发上限的 map（保持顺序；失败项返回 null 由调用方过滤） */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length || 1))
  let cursor = 0
  const runners = new Array(width).fill(null).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** 一个目录项 → 索引行（形状与 es.js 的 normalizeRow 对齐） */
function rowFromStat(full, name, isDirectory, info) {
  const ext = path.extname(name).replace(/^\./, '').toLowerCase()
  const mtimeMs = Number(info.mtimeMs) || 0
  const birthMs = Number(info.birthtimeMs) || Number(info.ctimeMs) || 0
  return {
    path: full,
    name,
    dir: path.dirname(full),
    ext,
    isDirectory,
    size: isDirectory ? 0 : (Number(info.size) || 0),
    mtimeMs,
    // 秒级，与 Everything 行契约一致（上层不用区分后端）
    modified: Math.floor(mtimeMs / 1000),
    created: Math.floor(birthMs / 1000),
  }
}

/**
 * 扫描若干目录，产出索引行。
 *
 * @param {string[]} scopeDirs 范围目录（绝对路径）
 * @param {{
 *   excludes?: string[],
 *   maxItems?: number,
 *   deadlineMs?: number,
 *   shouldStop?: () => boolean,
 *   onBatch?: (rows: object[]) => void,
 *   logger?: object,
 * }} [options]
 * @returns {Promise<{ok:boolean, rows:object[], count:number, truncated:boolean,
 *   cancelled:boolean, elapsedMs:number, error?:string}>}
 */
export async function walkScopeRows(scopeDirs, options = {}) {
  const startedAt = Date.now()
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : WALK_ITEM_LIMIT
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : WALK_DEADLINE_MS
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false
  const onBatch = typeof options.onBatch === 'function' ? options.onBatch : null

  const dirs = (scopeDirs || []).filter((d) => typeof d === 'string' && d.trim())
  const excludeSet = new Set((options.excludes || []).map((d) => canonical(d)))
  const skipNames = new Set(NOISE_DIR_NAMES.map((n) => String(n).toLowerCase()))
  const skipPrefixes = NOISE_DIR_PREFIXES.map((p) => String(p).toLowerCase())

  const rows = []
  let truncated = false
  let cancelled = false

  const stack = dirs.slice()
  const seenDirs = new Set(dirs.map((d) => canonical(d)))

  while (stack.length > 0) {
    if (shouldStop()) { cancelled = true; break }
    if (rows.length >= maxItems || Date.now() - startedAt > deadlineMs) { truncated = true; break }

    const current = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue // 没权限/已消失的目录：跳过，不中断整轮
    }

    const kept = []
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (excludeSet.has(canonical(full))) continue

      // ⚠️ 链接的 isDirectory() 是 false，必须单独判断（否则会当文件，点不进去）
      const isDirLike = entry.isDirectory() || entry.isSymbolicLink()
      if (isDirLike) {
        if (isNoiseDirName(entry.name, skipNames, skipPrefixes)) continue // 噪音目录：连条目都不记
        // 只把「真目录」继续展开；链接只记录条目本身，**不跟随**
        if (entry.isDirectory()) {
          const key = canonical(full)
          if (!seenDirs.has(key)) {
            seenDirs.add(key)
            stack.push(full)
          }
        }
      }

      if (rows.length + kept.length >= maxItems) { truncated = true; break }
      kept.push({ full, name: entry.name, isDirectory: isDirLike })
    }

    if (kept.length) {
      const described = await mapLimit(kept, WALK_CONCURRENCY, async (item) => {
        if (shouldStop()) return null
        let info
        try {
          // lstat 而不是 stat：不解析链接，绝不跟随
          info = await fsp.lstat(item.full)
        } catch {
          return null // 竞态删除 / 权限拒绝：跳过这一条
        }
        return rowFromStat(item.full, item.name, item.isDirectory, info)
      })
      const batch = described.filter(Boolean)
      if (batch.length) {
        rows.push(...batch)
        if (onBatch) onBatch(batch)
      }
    }
  }

  if (shouldStop() && !cancelled) cancelled = true

  return {
    ok: true,
    rows,
    count: rows.length,
    truncated,
    cancelled,
    elapsedMs: Date.now() - startedAt,
  }
}
