/**
 * dsh-artifact-library — 文件索引：工作区目录收集
 *
 * 「DSH 工作区」是索引范围的两路来源之一（另一路是已登记产出目录）。
 *
 * ⚠️ API 形态说明（2026-09-30 读官方 README 得出，**不猜死一种**）：
 *   · `ctx.workspaceController` 拥有「创建 / 重命名 / 移除 / 重排 Workspace」
 *   · 官方文档记载的**完整投影**入口是 `follow()`：订阅后先发一份 baseline，
 *     再按顺序发 upsert / remove / order 等增量
 *   · 但 `follow()` 的具体返回形态（AsyncIterable / Observable / thenable）
 *     没有在 README 里写死，所以这里做**多形态兼容**，并且在任何失败下
 *     都只是「这一路拿不到」，绝不影响「已登记产出目录」那一路。
 *
 * 因此本模块的定位是「尽力而为」：拿得到就纳入索引范围，拿不到就安静跳过。
 */

/** 从任意形态的投影里抽出工作区路径 */
function extractPaths(value) {
  if (!value) return []
  const rows = Array.isArray(value)
    ? value
    : (Array.isArray(value.workspaces) ? value.workspaces
      : (Array.isArray(value.items) ? value.items
        : (Array.isArray(value.rows) ? value.rows : [])))
  const out = []
  for (const row of rows) {
    if (!row) continue
    if (typeof row === 'string') { out.push(row); continue }
    const p = row.path || row.directory || row.cwd || row.root
    if (typeof p === 'string' && p.trim()) out.push(p.trim())
  }
  return out
}

/**
 * 收集 DSH 工作区目录。
 * @param {object} ctx cordis 上下文（需已有 workspaceController）
 * @param {{warn?:Function}} [logger]
 * @returns {Promise<string[]>} 目录列表（拿不到就是空数组）
 */
export async function collectWorkspaceDirs(ctx, logger) {
  try {
    const controller = ctx && ctx.workspaceController
    if (!controller) return []

    // ① 最直接：如果有 list()，用它
    if (typeof controller.list === 'function') {
      const value = await controller.list()
      const paths = extractPaths(value)
      if (paths.length) return paths
    }

    // ② 官方文档记载的完整投影：follow()
    if (typeof controller.follow === 'function') {
      const stream = controller.follow()

      // AsyncIterable：取第一份 baseline 即返回（不长期占用流）
      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        const iterator = stream[Symbol.asyncIterator]()
        const first = await iterator.next()
        try { if (typeof iterator.return === 'function') await iterator.return() } catch { /* 忽略 */ }
        const paths = extractPaths(first && first.value)
        if (paths.length) return paths
      }

      // thenable：一次投影
      if (stream && typeof stream.then === 'function') {
        const paths = extractPaths(await stream)
        if (paths.length) return paths
      }

      // 形如 { getSnapshot(), subscribe() } 的可观察对象
      if (stream && typeof stream.getSnapshot === 'function') {
        const paths = extractPaths(stream.getSnapshot())
        if (paths.length) return paths
      }
    }

    // ③ 退一步：某些版本把投影挂在 controller 自身
    for (const key of ['workspaces', 'current', 'snapshot']) {
      const candidate = controller[key]
      if (typeof candidate === 'function') {
        const paths = extractPaths(await candidate.call(controller))
        if (paths.length) return paths
      } else if (candidate) {
        const paths = extractPaths(candidate)
        if (paths.length) return paths
      }
    }
  } catch (error) {
    logger?.warn?.('artifact-library: 读取 DSH 工作区列表失败（不影响已登记产出目录的索引）: ' + String((error && error.message) || error))
  }
  return []
}
