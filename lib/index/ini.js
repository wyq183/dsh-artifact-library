/**
 * dsh-artifact-library — 文件索引：Everything 配置生成
 *
 * 生成的 ini 把索引**严格限制在指定目录**内。这几行是范围边界，
 * 也是「不需要管理员权限」的前提（官方：folder indexing 标准用户即可）：
 *
 *   auto_include_fixed_volumes=0   不自动索引所有固定卷
 *   ntfs_volume_paths=             清空卷列表
 *   ntfs_volume_includes=          清空（与上面对应）
 *   ntfs_volume_monitors=
 *   folders=<范围目录，逗号分隔>     只索引这些
 *
 * 实测（2026-09-30）：限定前入库 3,217,522 条 / 库 118 MB；
 * 限定后 6 条 / 库 422 bytes，`ext:md` 搜索返回空。
 */

import fs from 'node:fs'
import path from 'node:path'
import { iniPath } from './paths.js'

/**
 * ini 列表值的转义：含逗号的路径要用双引号包起来，且反斜杠写成两个。
 * 不含逗号的普通路径直接写单反斜杠（实测可行）。
 */
function listValue(p) {
  const s = String(p)
  if (!s.includes(',')) return s
  return '"' + s.replace(/\\/g, '\\\\') + '"'
}

/**
 * 构造 ini 文本。
 * @param {{scopeDirs: string[], excludeDirs?: string[], dbDir: string}} opts
 * @returns {string}
 */
/** 取路径所在的盘符（`C:\\a\\b` → `C:`），取不到返回空串 */
function volumeOf(dir) {
  const m = /^([A-Za-z]):/.exec(String(dir))
  return m ? m[1].toUpperCase() + ':' : ''
}

/**
 * 判断这批范围能不能走 **NTFS 模式**：
 * 全部落在**同一个盘**上（多卷时 include_onlys 的对应关系复杂，直接用 folder 更稳）。
 * @returns {string} 盘符（如 `C:`），不能走则返回空串
 */
export function ntfsVolumeFor(scopeDirs) {
  const vols = new Set()
  for (const dir of scopeDirs || []) {
    const v = volumeOf(dir)
    if (!v) return ''
    vols.add(v)
  }
  return vols.size === 1 ? [...vols][0] : ''
}

/**
 * 构造 ini 文本。
 *
 * 三种模式（2026-09-30 逐一实测对比，见文件头注释）：
 *   · mode='filelists' ★首选 —— 只加载 .efu 文件清单：不遍历目录、不索引卷，
 *       不需要管理员权限、不挑磁盘格式、不怕 junction，隐私边界天然成立
 *   · mode='ntfs'      —— 读卷 MFT + include_onlys 限制：快且稳，但需要管理员权限，
 *       且实测只认一个范围路径（多目录时只有第一个生效）
 *   · mode='folder'    —— 逐层遍历指定目录：不需要管理员，但容易被 junction/特殊目录
 *       搞成僵死或活锁（保底用）
 *
 * @param {{scopeDirs: string[], excludeDirs?: string[], dbDir: string,
 *   mode?: 'filelists'|'ntfs'|'folder', efuFiles?: string[]}} opts
 * @returns {string}
 */
export function buildIni(opts) {
  const scope = (opts.scopeDirs || []).filter((d) => typeof d === 'string' && d.trim())
  const exclude = (opts.excludeDirs || []).filter((d) => typeof d === 'string' && d.trim())
  const lines = [
    '; dsh-artifact-library 自动生成 —— 请勿手工编辑（每次启动会按范围重写）',
    '; 实例：DSHArtifacts（与用户自己安装的 Everything 完全隔离）',
    '[Everything]',
    'app_data=0',
    'run_as_admin=0',
    'show_tray_icon=0',
    'allow_multiple_windows=0',
    'run_in_background=1',
    'check_for_updates_on_startup=0',
    'auto_include_fixed_volumes=0',
  ]

  const efuFiles = (opts.efuFiles || []).filter((f) => typeof f === 'string' && f.trim())
  if (opts.mode === 'filelists' && efuFiles.length > 0) {
    // ── filelists 模式：只加载文件清单 ──
    // 不索引任何卷、不索引任何文件夹 —— 于是 owner 不需要管理员权限，
    // 也不会有「文件夹遍历被 junction 搞死」的问题；清单里只有我们放进去的文件，
    // 所以范围外的路径天然搜不到（隐私边界成立）。
    // 多目录：生成多份 .efu，这里逗号分隔（实测多份全部生效）。
    lines.push(
      `filelists=${efuFiles.map(listValue).join(',')}`,
      'folders=',
      'ntfs_volume_paths=',
      'ntfs_volume_includes=',
      'ntfs_volume_monitors=',
      'exclude_folders=',
    )
    if (opts.dbDir) lines.push(`db_location=${listValue(opts.dbDir)}`)
    lines.push('index_size=1', 'index_date_modified=1', 'index_date_created=1')
    return lines.join('\r\n') + '\r\n'
  }

  const volume = opts.mode === 'ntfs' ? ntfsVolumeFor(scope) : ''
  if (opts.mode === 'ntfs' && volume) {
    // ── NTFS 模式：索引该卷的 MFT，但**只加载**范围里的文件夹 ──
    lines.push(
      `ntfs_volume_paths=${volume}`,
      'ntfs_volume_includes=1',
      'ntfs_volume_monitors=1',
      'ntfs_volume_load_recent_changes=1',
      `ntfs_volume_include_onlys=${scope.join(';')}`,
      'folders=',
      'exclude_folders=',
    )
  } else {
    // ── folder 模式：只索引指定文件夹，不索引任何 NTFS 卷 ──
    lines.push(
      'ntfs_volume_paths=',
      'ntfs_volume_includes=',
      'ntfs_volume_monitors=',
      `folders=${scope.map(listValue).join(',')}`,
      `folder_monitor_changes=${scope.map(() => '1').join(',')}`,
      `folder_update_types=${scope.map(() => '0').join(',')}`,
      // 排除列表：范围里一旦有 node_modules / junction 这类东西，
      // folder 模式会僵死或活锁（2026-09-30 实测）
      `exclude_folders=${exclude.map(listValue).join(',')}`,
    )
  }

  lines.push(
    'index_size=1',
    'index_date_modified=1',
    'index_date_created=1',
    'fast_size_sort=0',
  )
  if (opts.dbDir) lines.push(`db_location=${listValue(opts.dbDir)}`)
  return lines.join('\r\n') + '\r\n'
}

/**
 * 确保 ini 存在且内容与期望一致。
 * **只在内容变化时写盘**（写盘后需要重启实例才生效，所以要避免无谓改动）。
 *
 * @param {{scopeDirs: string[], excludeDirs?: string[], dbDir: string}} opts
 * @returns {{changed: boolean, file: string, scopeCount: number}}
 */
export function ensureIni(opts) {
  const content = buildIni(opts)
  const file = iniPath()
  let existing = null
  try {
    existing = fs.readFileSync(file, 'utf8')
  } catch {
    existing = null
  }
  if (existing === content) {
    return { changed: false, file, scopeCount: (opts.scopeDirs || []).length }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return { changed: true, file, scopeCount: (opts.scopeDirs || []).length }
}

/** 读回 ini 里的范围（供诊断/展示用）。 */
export function readScopeFromIni() {
  try {
    const text = fs.readFileSync(iniPath(), 'utf8')
    const line = text.split(/\r?\n/).find((l) => l.startsWith('folders='))
    if (!line) return []
    return line.slice('folders='.length).split(',').filter(Boolean)
  } catch {
    return []
  }
}
