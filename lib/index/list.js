/**
 * dsh-artifact-library — 实时目录列举（`fs.readdir` + `fs.lstat`）
 *
 * ── 为什么要有这个模块（2026-09-30 实测，不是推测）────────────────────────
 *
 * 目录浏览原先走 Everything 的 **filelists 快照**，于是：
 *
 *     在范围内目录新建文件 → 立刻查 /files/list → 条目 = 0
 *     重启索引实例后再查       → 条目 = 0   ← 清单没到 6 小时过期就不重建
 *
 * 「agent 刚生成的文件，用户在目录视图里看不见」直接毁掉「找回」这个核心体验。
 * 所以目录浏览**不再走索引**：直接读文件系统，永远是此刻的真相。
 *
 * 全范围**搜索**（Everything 语法 `ext:png dm:today`）仍走索引 —— 那是索引器
 * 该干的活；但「某个目录里现在有什么」不该问索引器。
 *
 * ── 设计要点 ─────────────────────────────────────────────────────────────
 *   · **不跟随链接**：条目一律用 `lstat`，绝不 `stat`（不解析 reparse point），
 *     也绝不递归。目录列举只做一层，掉不进外部大目录。
 *   · **junction / 符号链接**：`Dirent.isDirectory()` 对它们返回 **false**
 *     （Windows 上 junctions 是 reparse point，libuv 归类成 `UV_DIRENT_LINK`）。
 *     所以判目录要同时看 `isSymbolicLink()` —— 否则 pnpm 风格的 junction
 *     会在目录树里变成「文件」。（同一个坑在 `index/scope.js` 里也记了一笔。）
 *   · **单条失败不拖垮整单**：某个子项 `lstat` 失败（权限/竞态删除）就跳过它，
 *     其余条目照常返回，并在 `skipped` 里报个数。
 *   · **大目录设上限**：`readdir` 之后先排序再切片，返回 `truncated`，
 *     不把几万条的响应撑爆。
 *
 * 本模块是纯 Node 实现（只依赖 node:fs / node:path），不碰 ctx，便于离线测试。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

/** 默认返回条数（也是 `/files/list` 未显式给 limit 时的值） */
export const DEFAULT_LIST_LIMIT = 2000

/** 上限：再大也不给（防止 `?limit=99999999` 把响应撑爆） */
export const MAX_LIST_LIMIT = 10000

/** 并发 lstat 数：Windows 上几百条目录在毫秒级，2000 条也不至于打满句柄 */
export const STAT_CONCURRENCY = 48

/** 单个文件可走缩略图通道的上限（超过就让前端退回类型图标） */
export const MAX_THUMB_BYTES = 5 * 1024 * 1024

/**
 * 名称排序器。
 * ⚠️ 后端只保证**稳定**顺序（名称序）；真正的展示排序由前端做
 * （前端已有 `Intl.Collator` 自然序 + 目录优先），这里不越界。
 */
const nameCollator = (() => {
  try {
    return new Intl.Collator('zh-CN', { numeric: true })
  } catch {
    return null
  }
})()

/** 稳定的名称比较（大小写敏感，保证同一次 readdir 的输出去重且确定） */
export function compareEntryNames(a, b) {
  const left = String(a || '')
  const right = String(b || '')
  if (nameCollator) {
    const result = nameCollator.compare(left, right)
    if (result !== 0) return result
  }
  return left < right ? -1 : left > right ? 1 : 0
}

/** 把 errno 翻成人话（UI 直接显示它） */
function describeFsError(error, dir) {
  const code = error && error.code ? String(error.code) : ''
  switch (code) {
    case 'ENOENT': return `目录不存在：${dir}`
    case 'ENOTDIR': return `不是目录：${dir}`
    case 'EACCES':
    case 'EPERM': return `没有读取权限：${dir}`
    case 'EBUSY': return `目录被占用：${dir}`
    case 'EMFILE':
    case 'ENFILE': return '系统打开的文件句柄过多，请稍后重试'
    default: return String((error && error.message) || error)
  }
}

/**
 * 有并发上限的 map（保持下标顺序，结果里没有 undefined 的占位）。
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<any>} worker
 * @returns {Promise<any[]>}
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length || 1))
  const runners = new Array(width).fill(null).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results.filter((row) => row !== undefined && row !== null)
}

/** 单个目录项 → 前端要的行对象 */
async function describeEntry(dir, dirent) {
  const full = path.join(dir, dirent.name)
  let info
  try {
    // ⚠️ lstat 而不是 stat：不解析链接，绝不跟随（junction 指向外部大目录也不会掉进去）
    info = await fsp.lstat(full)
  } catch {
    return null // 竞态删除 / 权限拒绝：跳过这一条，不影响其余
  }
  const isSymbolicLink = typeof info.isSymbolicLink === 'function' ? info.isSymbolicLink() : dirent.isSymbolicLink()
  // junction / symlink 的 Dirent.isDirectory() 是 false —— 要把它当目录，否则
  // pnpm 风格的 junction 在树里会变成「文件」，用户点不进去。
  const isDirectory = dirent.isDirectory() || isSymbolicLink
  const mtimeMs = Number(info.mtimeMs) || 0
  return {
    path: full,
    name: dirent.name,
    isDirectory,
    isSymbolicLink,
    isFile: !isDirectory && (typeof info.isFile === 'function' ? info.isFile() : true),
    size: isDirectory ? 0 : Number(info.size) || 0,
    mtimeMs,
    // 兼容旧 Everything 形状（秒级 `modified`）：老前端/老缓存不用改
    modified: Math.floor(mtimeMs / 1000),
    exists: true,
  }
}

/**
 * 列出目录的**直接子项**（实时读盘，不走索引）。
 *
 * @param {string} dir 绝对路径
 * @param {{limit?:number}} [options]
 * @returns {Promise<{ok:boolean, dir:string, entries:object[], dirCount:number, fileCount:number,
 *   total?:number, truncated?:boolean, limit?:number, skipped?:number, elapsedMs:number,
 *   source?:string, error?:string, code?:string}>}
 */
export async function listDirectory(dir, options = {}) {
  const startedAt = Date.now()
  const requested = typeof dir === 'string' ? dir : ''
  const empty = { entries: [], dirCount: 0, fileCount: 0 }
  if (!requested.trim()) {
    return { ok: false, dir: requested, error: 'dir 必填（绝对路径）', elapsedMs: 0, ...empty }
  }
  if (!path.isAbsolute(requested)) {
    return { ok: false, dir: requested, error: '需要绝对路径', elapsedMs: Date.now() - startedAt, ...empty }
  }

  const limit = Math.max(
    1,
    Math.min(Math.trunc(Number(options.limit)) || DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
  )

  let dirents
  try {
    dirents = await fsp.readdir(requested, { withFileTypes: true })
  } catch (error) {
    return {
      ok: false,
      dir: requested,
      error: describeFsError(error, requested),
      code: error && error.code ? String(error.code) : undefined,
      elapsedMs: Date.now() - startedAt,
      ...empty,
    }
  }

  const total = dirents.length
  const truncated = total > limit
  const kept = dirents
    .slice()
    .sort((a, b) => compareEntryNames(a.name, b.name))
    .slice(0, limit)

  const described = await mapLimit(kept, STAT_CONCURRENCY, (dirent) => describeEntry(requested, dirent))
  const entries = described
  const fileCount = entries.reduce((n, row) => n + (row.isDirectory ? 0 : 1), 0)

  return {
    ok: true,
    dir: requested,
    entries,
    dirCount: entries.length - fileCount,
    fileCount,
    total,
    truncated,
    limit,
    skipped: kept.length - entries.length,
    elapsedMs: Date.now() - startedAt,
    // 标明数据源，排查「为什么看不到新文件」时一眼可辨（fs = 实时，index = 索引）
    source: 'fs',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 缩略图通道：扩展名 → MIME
//
// 只有**图片**走这条路：`/files/thumb` 不该变成随便读文件的通道
// （哪怕它已经过了 assertInScope 闸门，也不给第二用途）。
// ═══════════════════════════════════════════════════════════════════════════

/** 允许走缩略图通道的扩展名 → Content-Type */
export const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}

/**
 * 该路径能不能当图片给。
 * @param {string} filePath
 * @returns {string} Content-Type，非图片返回空串
 */
export function imageMimeFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  return IMAGE_MIME_BY_EXT[ext] || ''
}

/** 判断是不是「能出缩略图」的图片路径 */
export function isImagePath(filePath) {
  return imageMimeFor(filePath) !== ''
}
