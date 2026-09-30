/**
 * dsh-artifact-library — 文件索引：索引范围计算
 *
 * 范围定义（依琪 2026-09-30 选定）：
 *   **DSH 工作区（会话 cwd）+ 已登记产出所在目录**
 * 不索引全盘 —— 这既是隐私边界，也是免管理员权限的前提。
 *
 * 本模块是**纯函数**：不碰文件系统、不依赖 ctx，便于离线单测。
 */

import fs from 'node:fs'
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

// ═══════════════════════════════════════════════════════════════════════════
// 范围守卫（2026-09-30 真机实测后加的，**不是优化，是必需**）
//
// 背景：Everything 的 **folder 模式**（folders= 白名单）遇到超大目录树时，
// 会在**启动阶段就僵死** —— 进程活着、CPU 约 0%、库文件一个字节都不写、
// **IPC 完全不响应**（连 -get-everything-version 都超时）。
//
// 实测对照（同一台机器、同一份 Everything 1.5.0.1423b）：
//   · 2 / 7 / 144 / 331 / 501 项的目录            → ✅ 全部正常
//   · .dsh\profiles（41 万项）                    → ❌ 僵死，60 秒后 CPU 仍只 0.5s
//   · 同目录 + exclude_folders 排掉 11 个 node_modules → ✅ **立刻恢复正常**
//
// 所以：默认排除噪音目录是**让插件可用的前提**。
// ═══════════════════════════════════════════════════════════════════════════

/** 默认排除的噪音目录名（比较时统一转小写） */
export const NOISE_DIR_NAMES = [
  // 包管理器 / 依赖
  'node_modules', '.pnpm', '.yarn', 'bower_components', 'vendor',
  // 版本控制
  '.git', '.hg', '.svn',
  // 语言生态
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache',
  'target', 'obj', '.gradle', '.m2',
  // 构建产物
  'dist', 'build', 'out', '.output', 'coverage',
  // 缓存
  'cache', '.cache', 'code cache', 'gpucache', 'cachestorage',
  'tmp', 'temp', '.tmp',
]

/**
 * 按**前缀**匹配的噪音目录名（小写）。
 *
 * 用途：回收站这类目录名带日期/随机后缀（`.trash-20260905`、`.Trash-1000`），
 * 精确名匹配抓不到。而**实测触发 Everything 僵死的正是 `.dsh\.trash-20260905`**。
 */
export const NOISE_DIR_PREFIXES = ['.trash', '$recycle', 'recycler', '.recycle']

/** 判断一个目录名是否属于噪音（精确名或前缀） */
function isNoiseDirName(name, names, prefixes) {
  const lower = String(name).toLowerCase()
  if (names.has(lower)) return true
  return prefixes.some((p) => lower.startsWith(p))
}

/** 单个范围目录的项数上限（超过就不纳入默认范围，避免拖死实例） */
export const SCOPE_ITEM_LIMIT = 60000

/**
 * 在范围目录下找出需要排除的噪音子目录（**命中即剪枝**，不往噪音目录内部走）。
 *
 * @param {string[]} scopeDirs
 * @param {{maxDepth?: number, extraNames?: string[]}} [options]
 * @returns {string[]} 绝对路径列表（可直接喂给 ini 的 exclude_folders）
 */
export function collectNoiseExcludes(scopeDirs, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 3
  const names = new Set(
    NOISE_DIR_NAMES.map((n) => n.toLowerCase())
      .concat(Array.isArray(options.extraNames) ? options.extraNames.map((n) => String(n).toLowerCase()) : []),
  )
  const prefixes = NOISE_DIR_PREFIXES.map((p) => String(p).toLowerCase())
  const out = []
  const seen = new Set()

  const walk = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // ⚠️ 关键：junction / 符号链接的 isDirectory() 返回 **false**（它是链接，不是目录），
      //    但它恰恰是让 Everything 僵死的元凶之一（实测：pnpm 风格的 node_modules junction）。
      //    所以必须把 isSymbolicLink() 也当作目录处理。
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      const key = full.toLowerCase()
      if (seen.has(key)) continue
      if (isNoiseDirName(entry.name, names, prefixes)) {
        seen.add(key)
        out.push(full)
        continue // 命中就不再往里走（剪枝，node_modules 内部动辄几万项）
      }
      if (depth < maxDepth) walk(full, depth + 1)
    }
  }

  for (const dir of scopeDirs || []) {
    if (typeof dir === 'string' && dir.trim()) walk(dir, 0)
  }
  return out
}

/**
 * 快速估算目录规模（项数），**带项数上限与时间上限**，用于范围守卫。
 *
 * 超限就提前返回 `truncated: true` —— 我们只需要知道「它很大」，
 * 不需要精确值，更不能为此遍历几十万项。
 *
 * @param {string} dir
 * @param {{limit?: number, deadlineMs?: number}} [options]
 * @returns {{count: number, truncated: boolean, elapsedMs: number}}
 */
export function measureDir(dir, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : SCOPE_ITEM_LIMIT
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : 2000
  const startedAt = Date.now()
  const skip = new Set((options.skipNames || NOISE_DIR_NAMES).map((n) => String(n).toLowerCase()))
  const skipPrefixes = NOISE_DIR_PREFIXES.map((p) => String(p).toLowerCase())
  let count = 0
  let truncated = false
  const stack = [dir]

  while (stack.length) {
    if (count > limit || Date.now() - startedAt >= deadlineMs) {
      truncated = true
      break
    }
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      count += 1
      if (count > limit) {
        truncated = true
        break
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // 噪音目录本身计入（它确实是个项），但不往里深挖 ——
        // 否则 node_modules 内部几万项会把整个目录误判成"超大"。
        if (isNoiseDirName(entry.name, skip, skipPrefixes)) continue
        stack.push(path.join(current, entry.name))
      }
    }
  }

  return { count, truncated, elapsedMs: Date.now() - startedAt }
}
