/**
 * dsh-artifact-library — 文件索引：索引范围计算
 *
 * 范围定义（依琪 2026-09-30 选定）：
 *   **DSH 工作区（会话 cwd）+ 已登记产出所在目录**
 * 不索引全盘 —— 这既是隐私边界，也是免管理员权限的前提。
 *
 * 本模块是**纯函数**：不碰文件系统、不依赖 ctx，便于离线单测。
 */

import path from 'node:path'

/** 规范化用于比较：去掉尾部分隔符并统一小写（Windows 路径大小写不敏感） */
function canonical(p) {
  return String(p).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * child 是否等于 parent、或位于 parent 之内。
 * 用于父子目录合并（父目录已覆盖子目录，不需要重复交给索引器）。
 */
export function isInside(child, parent) {
  const c = canonical(child)
  const p = canonical(parent)
  if (c === p) return true
  const sep = c.includes('\\') ? '\\' : '/'
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/**
 * 规范化索引范围：
 *   · 丢掉空值 / 非字符串 / 非绝对路径
 *   · 去重
 *   · **父子合并**：若 A 是 B 的祖先目录，只保留 A
 *   · 排序输出（稳定，便于比对）
 *
 * @param {Iterable<string>} dirs 候选目录（可含重复、可含子目录）
 * @returns {string[]} 规范化后的目录列表
 */
export function normalizeScope(dirs) {
  const set = new Set()
  for (const raw of dirs || []) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (!path.isAbsolute(trimmed)) continue
    set.add(path.resolve(trimmed))
  }
  // ⚠️ 先按规范化形式（小写、去尾分隔符）去重，再做父子合并。
  // 否则 `C:\A` 与 `c:\a` 会被 isInside 判定为「互相包含」，
  // 于是两者同时被滤掉 → 返回空数组（2026-09-30 自验抓到的真 bug）。
  const byCanonical = new Map()
  for (const p of set) {
    const key = canonical(p)
    if (!byCanonical.has(key)) byCanonical.set(key, p)
  }
  const list = Array.from(byCanonical.values())
  const kept = list.filter((candidate) =>
    !list.some((other) => other !== candidate && isInside(candidate, other)),
  )
  return kept.sort((a, b) => a.localeCompare(b))
}

/**
 * 从产物记录里提取「所在目录」。
 * 目录型记录（path 指向文件夹）直接取自身。
 *
 * @param {Array<{path?:string, artifact_type?:string}>} items 产物记录
 * @returns {string[]} 目录列表（未去重，交给 normalizeScope 处理）
 */
export function dirsFromArtifacts(items) {
  const out = []
  for (const record of items || []) {
    if (!record || typeof record.path !== 'string' || !record.path) continue
    try {
      out.push(path.dirname(record.path))
    } catch {
      /* 坏路径跳过，不影响其余 */
    }
  }
  return out
}

/**
 * 合并所有来源，得到最终索引范围。
 *
 * @param {object} input
 * @param {string[]} [input.workspaces]   DSH 工作区目录
 * @param {string[]} [input.artifactDirs] 已登记产出所在目录
 * @param {string[]} [input.extra]        用户在设置里手工添加的目录
 * @returns {string[]}
 */
export function buildScope(input = {}) {
  return normalizeScope([
    ...(input.workspaces || []),
    ...(input.artifactDirs || []),
    ...(input.extra || []),
  ])
}
