/**
 * 老数据只读体检（Step 2 宿主侧离线验证）
 *
 * ⚠️ **为什么要有这个脚本**：宿主侧 `lib/*.js` 不热载（实测，见任务板 §七），
 *    而重启应用会杀掉依琪的会话 ⇒ 真机上**验不到** 2b/2c/2e。
 *    所以走 `docs/ARCHITECTURE.md` §8.1 那条路：**在进程外直接跑**。
 *
 * ⚠️ **绝不动真数据**：先把 `artifacts.json` / `settings.json` **复制**到系统临时目录，
 *    再在副本上跑。脚本结尾删掉临时目录。想验的话请保持这个形状。
 *
 * 用法：node test/healthcheck-real-data.mjs [数据目录]
 *   · 缺省取 DSH 的产物库目录（`~/.dsh/artifact-library`）
 *   · 也可以用环境变量 `ALF_DATA_DIR` 指定
 *
 * ⚠️ **不在 `*.test.mjs` 里**，所以 `node --test test/*.test.mjs` **不会**自动跑它 ——
 *    这是**故意**的：它读的是**用户真实数据**，而在别人的机器上那目录可能不存在。
 *    想跑就手点。退出码：有断言失败 → 1
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArtifactStore } from '../lib/store.js'
import { SettingsStore, settingsSchema, DEFAULT_CATEGORIES } from '../lib/settings.js'
import { inferCategoryFromPath, normalizeExt, groupByCategory } from '../lib/categories.js'

/**
 * 解析数据目录（argv[2] > $ALF_DATA_DIR > ~/.dsh/artifact-library）。
 * 不写死绝对路径 —— 那会让这个脚本只在一个人机器上能跑。
 */
function resolveDataDir() {
  const fromArgv = process.argv[2]
  if (fromArgv) return fromArgv
  const fromEnv = process.env.ALF_DATA_DIR
  if (fromEnv) return fromEnv
  return path.join(os.homedir(), '.dsh', 'artifact-library')
}

const REAL_DIR = resolveDataDir()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-healthcheck-'))

let passed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (e) { failures.push(name + ' → ' + (e && e.message ? e.message : String(e))); console.log('  FAIL ' + name + ' → ' + e.message) }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed') }

try {
  // ── 复制真数据到副本（只读真数据，一个字节都不写）─────────────────────
  console.log('=== 复制真数据到临时副本 ===')
  fs.mkdirSync(TMP, { recursive: true })
  for (const f of ['artifacts.json', 'settings.json', 'meta.json']) {
    const src = path.join(REAL_DIR, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP, f))
  }
  const realItems = JSON.parse(fs.readFileSync(path.join(TMP, 'artifacts.json'), 'utf8'))
  const realLive = realItems.filter((r) => !r.trashed_at)
  console.log(`真库：${realItems.length} 条（有效 ${realLive.length}，回收站 ${realItems.length - realLive.length}）`)
  console.log(`副本：${TMP}`)

  const store = new ArtifactStore(TMP).load()
  const settings = new SettingsStore({ file: path.join(TMP, 'settings.json') }).load()
  store.setCategoriesProvider(() => settings.get().categories)

  // ── [1] 2b：老数据一条都没被改动 ─────────────────────────────────────
  console.log('\n=== [1] 2b：加载设置后老数据是否被动过 ===')
  check('★ 加载并挂上分类表后，每条记录的 artifact_type 与磁盘原值逐条一致', () => {
    const byId = new Map(store.items.map((r) => [r.id, r]))
    for (const orig of realItems) {
      const now = byId.get(orig.id)
      assert(now, `记录 ${orig.id} 不见了`)
      assert(now.artifact_type === orig.artifact_type,
        `${orig.id}「${orig.title}」的 type 从 ${orig.artifact_type} 变成了 ${now.artifact_type}`)
    }
  })
  check('★ 记录总数不变（没有凭空多出/少掉）', () => {
    assert(store.items.length === realItems.length, `${store.items.length} vs ${realItems.length}`)
  })

  // ── [2] 2b：默认分类表能否覆盖真实数据（孤儿检查）────────────────────
  console.log('\n=== [2] 2b：默认分类表 vs 真实数据 ===')
  const cats = settings.get().categories
  const catIds = new Set(cats.map((c) => c.id))
  const realTypes = [...new Set(realLive.map((r) => r.artifact_type || 'other'))].sort()
  check('★ 真实数据里每个 artifact_type 都能在默认分类表里找到（零孤儿）', () => {
    const orphan = realTypes.filter((t) => !catIds.has(t))
    assert(orphan.length === 0, `孤儿分类：${orphan.join(', ')}（指向它们的 ${realLive.filter((r) => orphan.includes(r.artifact_type)).length} 条记录会失联）`)
  })
  check('分类表与 DEFAULT_CATEGORIES 一致（用户还没改过）', () => {
    assert(JSON.stringify(cats) === JSON.stringify(DEFAULT_CATEGORIES), '分类表被改过？')
  })

  // ── [3] 2b：按后缀归类对真实数据的表现（只报告，不断言"全对"）────────
  console.log('\n=== [3] 2b：后缀归类 vs 真实 type（这是"只往前不回头"的实证）===')
  let agree = 0, disagree = 0
  const examples = []
  for (const rec of realLive) {
    if (rec.is_dir) continue
    const guessed = inferCategoryFromPath(rec.path, cats, { isDir: false })
    const actual = rec.artifact_type || 'other'
    if (guessed === actual) agree += 1
    else {
      disagree += 1
      if (examples.length < 6) examples.push(`    ${normalizeExt(rec.path) || '(无后缀)'}: 记录是 ${actual}，按后缀会猜成 ${guessed}`)
    }
  }
  const total = agree + disagree
  const rate = total ? Math.round((agree / total) * 100) : 0
  console.log(`  一致 ${agree} / 不一致 ${disagree} → 一致率约 ${rate}%（非目录 ${total} 条）`)
  if (examples.length) console.log(examples.join('\n'))
  check('★ 一致率落在 80%~95%（证明"够高到能当默认、不够高到能覆盖语义"）', () => {
    assert(rate >= 80 && rate <= 95,
      `一致率 ${rate}% —— 若接近 100% 才该考虑回头改写老数据；若低于 80% 则该重新想默认归类`)
  })
  check('★ 存在不一致的样本（这就是"不能回头改写"的理由）', () => {
    assert(disagree > 0, '竟然 100% 一致 —— 那本脚本的论证前提要重新检查')
  })

  // ── [4] 2b：/categories 端点的形状（面板筛选靠它）─────────────────────
  console.log('\n=== [4] 2b：store.categories() 的实际返回 ===')
  const c = store.categories()
  check('★ 返回 categories / buckets / orphans，且 projects/types/tags 仍在', () => {
    for (const k of ['projects', 'types', 'tags', 'categories', 'buckets', 'orphans']) {
      assert(Array.isArray(c[k]), `${k} 不是数组：${typeof c[k]}`)
    }
  })
  check('★ buckets 覆盖分类表每一项，且计数之和 == 有效记录数', () => {
    assert(c.buckets.length === cats.length, `buckets ${c.buckets.length} vs 分类表 ${cats.length}`)
    const sum = c.buckets.reduce((a, b) => a + b.count, 0) + c.orphans.reduce((a, o) => a + o.count, 0)
    assert(sum === realLive.length, `计数之和 ${sum} != 有效记录 ${realLive.length}`)
  })
  check('★ 每个 bucket 的计数与直接数出来的记录数一致', () => {
    for (const b of c.buckets) {
      const manual = realLive.filter((r) => (r.artifact_type || 'other') === b.id).length
      assert(b.count === manual, `${b.id}: bucket 说 ${b.count}，手动数 ${manual}`)
    }
  })
  check('真实数据的 buckets（给依琪看的数字）', () => {
    const line = c.buckets.map((b) => `${b.label}:${b.count}`).join('  ')
    console.log('    ' + line)
    assert(c.buckets.some((b) => b.count > 0), '全是 0 条？那不对')
  })

  // ── [5] 2e：schema 里预设带的分类 ────────────────────────────────────
  console.log('\n=== [5] 2e：schema 暴露预设分类 ===')
  const s = settingsSchema()
  check('contentKeys 与预设的 contentCategories 都在', () => {
    assert(Array.isArray(s.contentKeys), 'contentKeys 缺失')
    for (const p of s.presets) assert(Array.isArray(p.contentCategories), `${p.id} 缺 contentCategories`)
  })
  check('每个预设会新增哪些分类（给依琪看的清单）', () => {
    for (const p of s.presets) {
      const line = p.contentCategories.length ? p.contentCategories.map((x) => x.label).join('、') : '（不带分类）'
      console.log(`    ${(p.label || p.id).padEnd(10)} 额外带来：${line}`)
    }
  })

  // ── [6] 2c：分类 id 校验对真实数据是否安全 ───────────────────────────
  console.log('\n=== [6] 2c：把真实数据的 type 当分类 id 校验 ===')
  check('★ 真实出现过的每个 type 都能通过 id 形状校验（否则删/改它们会被误拒）', () => {
    const bad = realTypes.filter((t) => !/^[a-z][a-z0-9_-]{0,31}$/.test(t))
    assert(bad.length === 0, `这些真实 type 形状不合法：${bad.join(', ')}`)
  })
  check('★ 真实记录里没有超长 label 风险（分类显示名来自设置，不是记录）', () => {
    for (const cat of cats) assert(String(cat.label).length <= 24, `${cat.id} 的 label 过长`)
  })

  // ── [7] groupByCategory 对真实数据的直接调用 ─────────────────────────
  console.log('\n=== [7] 分组函数对真实数据的输出 ===')
  const g = groupByCategory(realLive, cats)
  check('groupByCategory 的 orphans 与端点一致（都应为空）', () => {
    assert(g.orphans.length === c.orphans.length, `${g.orphans.length} vs ${c.orphans.length}`)
  })
  check('total 等于有效记录数', () => {
    assert(g.total === realLive.length, `${g.total} vs ${realLive.length}`)
  })
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log('\n' + '─'.repeat(64))
console.log(`结果：${passed} 通过 / ${failures.length} 失败`)
if (failures.length) { console.log('\n失败列表：'); for (const f of failures) console.log('  · ' + f) }
process.exit(failures.length ? 1 : 0)
