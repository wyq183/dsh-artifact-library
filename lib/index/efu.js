/**
 * dsh-artifact-library — 文件索引：EFU 文件清单生成
 *
 * ── 为什么用「文件清单」而不是让 Everything 自己索引 ──────────────────────
 *
 * Everything 的两种索引模式在真实用户环境里都不可靠（2026-09-30 逐一实测）：
 *
 *   · **folder 模式**（`folders=` 白名单）—— 让 Everything **自己逐层遍历目录树**：
 *       遇到 junction / 符号链接（如 pnpm 的 node_modules）或特定目录组合会
 *       **僵死**（CPU 0%、IPC 无响应）或**活锁**（CPU 100% 永不完成）。
 *       实测 11 万项范围烧到 215 秒仍不就绪。
 *
 *   · **NTFS 模式**（`ntfs_volume_paths=` + `ntfs_volume_include_onlys=`）：
 *       快且稳（2~6 秒就绪），但**需要管理员权限**，且官方文档说是「分号分隔的
 *       文件夹列表」而**实测只认第一个路径** —— 多目录场景直接残废。
 *       另外它要读整卷的 MFT，隐私上也不如清单干净。
 *
 *   · **filelists 模式**（`filelists=` + `.efu`）★ 本文件负责生成：
 *       让 Everything **只加载一份文件清单**，不遍历目录、不索引任何卷。
 *       于是：不需要管理员权限、不挑磁盘格式（exFAT 也行）、
 *       **完全绕开 folder 模式的所有遍历陷阱**、隐私边界天然成立
 *       （清单里只有我们主动放进去的文件）。实测 2.3 秒就绪、多目录全部生效、
 *       范围外查询 0 泄漏。
 *
 * ── 代价（如实记录）────────────────────────────────────────────────────
 *
 * `.efu` 是**快照**：文件增删后清单不会自动更新，需要重新生成。
 * 对「搜项目产出」这个场景够用（产出不是每分钟都在变），重建在后台做。
 *
 * ── 格式（官方 EFU，纯文本 CSV，UTF-8 带 BOM）──────────────────────────
 *
 *   Filename,Size,Date Modified,Date Created,Attributes
 *   "C:\path\to\file",1234,134352118891819011,134352118891644060,32
 *
 *   时间是 **FILETIME**（1601-01-01 起的 100ns 数，见 toFileTime）。
 *   Attributes：16 = 目录，32 = 文件（与 Everything 导出的清单一致）。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  NOISE_DIR_NAMES,
  NOISE_DIR_PREFIXES,
  isNoiseDirName,
  canonical,
} from './scope.js'

/** Unix 毫秒 → Windows FILETIME（1601-01-01 起的 100ns）的偏移量 */
const FILETIME_EPOCH_OFFSET_MS = 11644473600000

/** 单份清单的项数上限（防御：范围失控时不要把内存撑爆） */
export const EFU_ITEM_LIMIT = 800000

/**
 * Unix 毫秒 → FILETIME 字符串。
 * @param {number} ms
 * @returns {string}
 */
export function toFileTime(ms) {
  const value = Number.isFinite(ms) ? ms : 0
  return String(Math.round((value + FILETIME_EPOCH_OFFSET_MS) * 10000))
}

/** EFU 里的字段转义：路径含逗号/引号时要用双引号包住，内部引号翻倍 */
function csvField(value) {
  const text = String(value)
  return '"' + text.replace(/"/g, '""') + '"'
}

/**
 * 扫描若干目录，生成一份 EFU 清单。
 *
 * 自己扫描（而不是调 `Everything.exe -create-file-list`）的原因：
 *   · 可以**复用插件的噪音排除规则**（node_modules 等一律不进清单，体积小得多）
 *   · 链接（junction/symlink）**只记录条目本身、不跟随**，不会掉进外部大目录
 *   · 可以设**项数上限与时间上限**，范围失控时不会把机器拖死
 *
 * @param {string[]} scopeDirs 要纳入清单的目录（绝对路径）
 * @param {string} outFile 输出的 .efu 路径
 * @param {{excludes?: string[], deadlineMs?: number, maxItems?: number, logger?: any}} [options]
 * @returns {{ok: boolean, count: number, outFile: string, truncated: boolean, elapsedMs: number, error?: string}}
 */
export function generateEfu(scopeDirs, outFile, options = {}) {
  const startedAt = Date.now()
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : 180000
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : EFU_ITEM_LIMIT

  const dirs = (scopeDirs || []).filter((d) => typeof d === 'string' && d.trim() && fs.existsSync(d))
  const excludeSet = new Set((options.excludes || []).map((d) => canonical(d)))
  const skipNames = new Set(NOISE_DIR_NAMES.map((n) => String(n).toLowerCase()))
  const skipPrefixes = NOISE_DIR_PREFIXES.map((p) => String(p).toLowerCase())

  const lines = ['Filename,Size,Date Modified,Date Created,Attributes']
  let count = 0
  let truncated = false

  const stack = dirs.slice()
  const seenDirs = new Set(dirs.map((d) => canonical(d)))

  while (stack.length > 0) {
    if (count >= maxItems || Date.now() - startedAt > deadlineMs) {
      truncated = true
      break
    }
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue // 没权限/已消失的目录：跳过，不中断整份清单
    }

    for (const entry of entries) {
      if (count >= maxItems) { truncated = true; break }
      const full = path.join(current, entry.name)
      if (excludeSet.has(canonical(full))) continue

      // ⚠️ junction / 符号链接的 isDirectory() 是 false，必须单独判断
      const isDirLike = entry.isDirectory() || entry.isSymbolicLink()
      if (isDirLike) {
        if (isNoiseDirName(entry.name, skipNames, skipPrefixes)) continue // 噪音目录：连条目都不记
        // 只把「真目录」继续展开；链接只记录条目本身，**不跟随**（避免掉进外部大目录）
        if (entry.isDirectory()) {
          const key = canonical(full)
          if (!seenDirs.has(key)) {
            seenDirs.add(key)
            stack.push(full)
          }
        }
      }

      let stat = null
      try {
        stat = fs.lstatSync(full)
      } catch {
        continue
      }
      const attributes = isDirLike ? 16 : 32
      // 目录条目带尾部反斜杠 —— 与官方 Everything.exe -create-file-list 的输出一致
      const listedPath = isDirLike && !full.endsWith('\\') ? full + '\\' : full
      lines.push(
        csvField(listedPath)
        + ',' + (isDirLike ? 0 : stat.size)
        + ',' + toFileTime(stat.mtimeMs)
        + ',' + toFileTime(stat.birthtimeMs || stat.ctimeMs)
        + ',' + attributes,
      )
      count += 1
    }
  }

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    // ⚠️ 必须带 UTF-8 BOM：Everything 靠它判断编码，否则中文路径会乱码
    fs.writeFileSync(outFile, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8')
  } catch (error) {
    return {
      ok: false,
      count: 0,
      outFile,
      truncated,
      elapsedMs: Date.now() - startedAt,
      error: String((error && error.message) || error),
    }
  }

  return { ok: true, count, outFile, truncated, elapsedMs: Date.now() - startedAt }
}
