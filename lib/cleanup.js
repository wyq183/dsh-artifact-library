/**
 * dsh-artifact-library — 定时整理
 *
 * 插件自跑定时器（DSH 的 schedule 包是会话内提醒，不适合全局维护任务）。
 * 挂载时先补跑一次，之后每小时检查是否到期（lastCleanupAt + cleanupIntervalDays），到期执行：
 *   0. 先备份整库快照（整理若写坏数据，回滚还有干净副本）
 *   1. 同路径去重（仅保留最新，其余归档；判重与建议单共用 findDuplicateGroups）
 *   2. 刷新文件存在性（exists 标记）
 * 全部本地，绝不上传。
 */

import fs from 'node:fs'
import path from 'node:path'

const CHECK_INTERVAL_MS = 60 * 60 * 1000 // 每小时检查
const DAY_MS = 24 * 60 * 60 * 1000
const BACKUP_KEEP = 10

/** 自动备份：把整库快照写入 <dataDir>/backups/，保留最近 keep 份（默认 BACKUP_KEEP） */
export function backupStore(store, keep = BACKUP_KEEP) {
  const dir = path.join(store.dir, 'backups')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `artifact-library-${Math.floor(Date.now() / 1000)}.json`)
    fs.writeFileSync(file, JSON.stringify(store.exportData(), null, 2), 'utf8')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    const keepCount = Number(keep) > 0 ? Number(keep) : BACKUP_KEEP
    while (files.length > keepCount) {
      const old = files.shift()
      try { fs.unlinkSync(path.join(dir, old)) } catch { /* ignore */ }
    }
    return { backedUp: true, file }
  } catch {
    return { backedUp: false }
  }
}

/** 执行一次整理；返回本次做了什么 */
export function runCleanup(store) {
  const result = { deduped: 0, refreshed: 0, missing: 0 }
  try {
    const d = store.dedupExactDuplicates()
    result.deduped = d.deduped
  } catch { /* 去重失败不阻断 */ }
  for (const r of store.items) {
    if (r.trashed_at !== null) continue
    try {
      const st = fs.statSync(r.path)
      const exists = st.isFile()
      if (!!r.exists !== exists) { r.exists = exists; result.refreshed++ }
      if (!exists) result.missing++
    } catch {
      if (r.exists !== false) { r.exists = false; result.refreshed++ }
      result.missing++
    }
  }
  try { store.save() } catch { /* 保存失败忽略 */ }
  return result
}

/** 挂载定时整理；返回 disposer */
export function attachCleanup(ctx, store) {
  const tick = () => {
    try {
      const s = store.getSettings()
      if (!s.cleanupEnabled) return
      if (store.meta.lastCleanupAt + s.cleanupIntervalDays * DAY_MS > Date.now()) return
      // 先备份再整理：整理若写坏数据，回滚还有干净快照（备份开关/保留份数可在设置里调）
      const bk = s.backupOnCleanup ? backupStore(store, s.backupKeep) : { backedUp: false }
      const result = runCleanup(store)
      store.markCleanupDone()
      ctx.logger?.info?.(`artifact-library: cleanup done ${JSON.stringify(result)}${bk.backedUp ? ' + backup' : ''}`)
    } catch { /* 定时任务异常不影响宿主 */ }
  }
  tick() // 启动时先补跑一次：关机很久后不必再等一个轮询周期
  const timer = setInterval(tick, CHECK_INTERVAL_MS)
  return () => { try { clearInterval(timer) } catch {} }
}
