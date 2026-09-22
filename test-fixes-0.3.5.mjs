// v0.3.5 修复回归测试：整理收敛 / 精化判定 / 优先标记清除 / 统计口径
// 临时目录，不碰真实库。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArtifactStore, isActiveRecord } from './lib/store.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-fixes-test-'))
let ok = true
const check = (label, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`)
  if (!cond) ok = false
}

const store = new ArtifactStore(dir).load()

// ── P0-1/P0-2：同路径重复 → 去重 → 建议单必须收敛 ──────────────
const dupPath = path.join(dir, 'dup.txt')
fs.writeFileSync(dupPath, 'x')
for (const t of ['v1', 'v2', 'v3']) {
  store.register({ path: dupPath, title: t, summary: 's', tags: ['t'], project: 'proj' })
}
check('重复组被识别（1 组）', store.findDuplicateGroups().length === 1)
check('建议单报出重复（1 组）', store.suggestCleanup().duplicates.length === 1)

const d = store.dedupExactDuplicates()
check('去重归档 2 条（保留最新 1 条 final）', d.deduped === 2)
const survivors = store.items.filter((r) => r.path === dupPath && isActiveRecord(r))
check('存活记录恰好 1 条且为最新（v3）', survivors.length === 1 && survivors[0].title === 'v3')
check('★ 去重后重复组归零（整理真正收敛）', store.findDuplicateGroups().length === 0)
check('★ 去重后建议单不再报重复（不再反复清不掉）', store.suggestCleanup().duplicates.length === 0)

// ── P0-3：精化判定纳入 project ────────────────────────────────
const noProj = path.join(dir, 'noproj.txt')
fs.writeFileSync(noProj, 'y')
const r2 = store.register({ path: noProj, title: '无项目', summary: 's', tags: ['t'] })
check('缺 project 的记录被判为待精化', r2.needsRefine === true)

// ── P0-4：精化完成后清除 refineRequested ──────────────────────
store.requestRefine({ ids: [r2.id] })
check('请求精化后 refineRequested=true', store.get(r2.id).refineRequested === true)
store.update(r2.id, { project: 'proj' }) // 补齐 project → 视为精化完成
check('补齐 project 后 needsRefine=false', store.get(r2.id).needsRefine === false)
check('★ 精化完成后 refineRequested 被清除', store.get(r2.id).refineRequested === false)

// ── 统计口径：归档不再计入有效数 ──────────────────────────────
const s = store.stats()
check('stats.total 含归档（4 条未回收）', s.total === 4)
check('★ stats.activeCount 排除归档（2 条有效）', s.activeCount === 2)
check('stats.archived=2', s.archived === 2)

fs.rmSync(dir, { recursive: true, force: true })
console.log(ok ? '\n✅ v0.3.5 修复回归全部通过' : '\n❌ v0.3.5 修复回归存在失败')
process.exit(ok ? 0 : 1)
