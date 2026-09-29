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
 * @param {{scopeDirs: string[], dbDir: string}} opts
 * @returns {string}
 */
export function buildIni(opts) {
  const scope = (opts.scopeDirs || []).filter((d) => typeof d === 'string' && d.trim())
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
    // ── 索引范围：只索引指定文件夹，不索引任何 NTFS 卷 ──
    'auto_include_fixed_volumes=0',
    'ntfs_volume_paths=',
    'ntfs_volume_includes=',
    'ntfs_volume_monitors=',
    `folders=${scope.map(listValue).join(',')}`,
    `folder_monitor_changes=${scope.map(() => '1').join(',')}`,
    `folder_update_types=${scope.map(() => '0').join(',')}`,
    // ── 索引哪些元数据 ──
    'index_size=1',
    'index_date_modified=1',
    'index_date_created=1',
    'fast_size_sort=0',
  ]
  if (opts.dbDir) lines.push(`db_location=${listValue(opts.dbDir)}`)
  return lines.join('\r\n') + '\r\n'
}

/**
 * 确保 ini 存在且内容与期望一致。
 * **只在内容变化时写盘**（写盘后需要重启实例才生效，所以要避免无谓改动）。
 *
 * @param {{scopeDirs: string[], dbDir: string}} opts
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
