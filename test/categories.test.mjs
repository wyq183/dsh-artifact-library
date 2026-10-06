/**
 * 离线 harness：分类（Step 2b）—— 后缀 ↔ 分类的规则层 + store 的接线
 *
 * 这个文件的靶子是**「归类只准往前、不准回头」**这条纪律，分四块：
 *   A normalizeExt：后缀口径（`.gitignore` 不算、`a.tar.gz`→gz、超长不认）
 *   B buildExtIndex / inferCategoryFromPath：跨类取先出现、目录不猜、认不出回落
 *   C groupByCategory：顺序 = 分类表顺序、0 条也返回、孤儿必须报出来
 *   D ★ store 接线：显式优先 / 未传按后缀 / **已有记录一条都不动**
 *   E 形状守卫：两份常量必须同值（防止 category id 的正则和兜底 id 漂移）
 *
 * 用法：node test/categories.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  normalizeExt, buildExtIndex, inferCategoryFromPath, categoryLabel,
  groupByCategory, checkCategoryId, findCategory, FALLBACK_CATEGORY_ID,
} from '../lib/categories.js'
import {
  DEFAULT_CATEGORIES, CATEGORY_ID_RE, LOCKED_CATEGORY_ID, validateCategories,
} from '../lib/settings.js'
import { ArtifactStore } from '../lib/store.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

const TMP_DIRS = []
function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  TMP_DIRS.push(dir)
  return dir
}
/** 建一个临时文件并返回绝对路径（真实文件：store.register 会 stat 它） */
function touch(dir, name) {
  const full = path.join(dir, name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, 'x')
  return full
}

// ═══ [A] normalizeExt ═════════════════════════════════════════════════════
console.log('\n=== [A] normalizeExt：后缀口径 ===')
{
  check('基本：取小写、去点、只看最后一段', () => {
    assert(normalizeExt('a.MD') === 'md', normalizeExt('a.MD'))
    assert(normalizeExt('C:\\x\\y\\Report.PDF') === 'pdf', normalizeExt('C:\\x\\y\\Report.PDF'))
    assert(normalizeExt('/home/u/a.tar.gz') === 'gz', '多层后缀取最后一段：' + normalizeExt('/home/u/a.tar.gz'))
  })
  check('★ dotfile 不算后缀（`.gitignore` 的后缀是空的，不是 gitignore）', () => {
    assert(normalizeExt('.gitignore') === '', '得到 ' + JSON.stringify(normalizeExt('.gitignore')))
    assert(normalizeExt('/a/b/.env') === '', '得到 ' + JSON.stringify(normalizeExt('/a/b/.env')))
  })
  check('没有点 / 点在末尾 → 空', () => {
    assert(normalizeExt('Makefile') === '', normalizeExt('Makefile'))
    assert(normalizeExt('weird.') === '', normalizeExt('weird.'))
    assert(normalizeExt('') === '', normalizeExt(''))
    assert(normalizeExt(undefined) === '', 'undefined 该回空串')
    assert(normalizeExt(null) === '', 'null 该回空串')
  })
  check('★ 含非字母数字的「后缀」不认（`file.a b` / `file.a/b`）', () => {
    assert(normalizeExt('file.a b') === '', normalizeExt('file.a b'))
    assert(normalizeExt('file.-x') === '', normalizeExt('file.-x'))
    assert(normalizeExt('file.a_b') === '', normalizeExt('file.a_b'))
  })
  check('★ 超长后缀不认（真实后缀没有超过 16 字符的）', () => {
    assert(normalizeExt('a.' + 'x'.repeat(16)) === 'x'.repeat(16), '16 字符该认')
    assert(normalizeExt('a.' + 'x'.repeat(17)) === '', '17 字符该不认')
  })
  check('目录名带点也会被读出后缀 —— 所以调用方必须传 isDir（见 B 节）', () => {
    assert(normalizeExt('C:\\proj\\v1.2') === '2', '这正是必须传 isDir 的原因：' + normalizeExt('C:\\proj\\v1.2'))
  })
}

// ═══ [B] buildExtIndex / inferCategoryFromPath ════════════════════════════
console.log('\n=== [B] 后缀 → 分类 ===')
{
  check('默认分类表能编出索引，且覆盖常见后缀', () => {
    const { owner, conflicts } = buildExtIndex(DEFAULT_CATEGORIES)
    assert(owner.get('md') === 'document', 'md → ' + owner.get('md'))
    assert(owner.get('png') === 'image', 'png → ' + owner.get('png'))
    assert(owner.get('py') === 'code', 'py → ' + owner.get('py'))
    assert(owner.get('mp4') === 'video', 'mp4 → ' + owner.get('mp4'))
    assert(owner.get('zip') === 'archive', 'zip → ' + owner.get('zip'))
    assert(owner.get('mp3') === 'audio', 'mp3 → ' + owner.get('mp3'))
    // 默认表本身不该有冲突（它就是照 CHIP_EXTS 对齐写的）
    assert(conflicts.length === 0, '默认表有内部冲突：' + JSON.stringify(conflicts))
  })
  check('★ 同一后缀跨类 → 取**先出现**的，并把冲突报出来', () => {
    const cats = [
      { id: 'code', label: '代码', exts: ['exe'] },
      { id: 'archive', label: '压缩包', exts: ['exe'] },
    ]
    const { owner, conflicts } = buildExtIndex(cats)
    assert(owner.get('exe') === 'code', '该取先出现的 code，得到 ' + owner.get('exe'))
    assert(conflicts.length === 1, '冲突该被报出来：' + JSON.stringify(conflicts))
    assert(conflicts[0].kept === 'code' && conflicts[0].shadowed === 'archive', JSON.stringify(conflicts[0]))
  })
  check('inferCategoryFromPath：按后缀归类', () => {
    assert(inferCategoryFromPath('D:\\a\\报告.docx', DEFAULT_CATEGORIES) === 'document')
    assert(inferCategoryFromPath('D:\\a\\shot.PNG', DEFAULT_CATEGORIES) === 'image', '大写后缀也要认')
    assert(inferCategoryFromPath('D:\\a\\main.py', DEFAULT_CATEGORIES) === 'code')
  })
  check('★ 认不出的后缀 / 没后缀 → 回落兜底（= 改动前的行为）', () => {
    assert(inferCategoryFromPath('D:\\a\\x.qqq', DEFAULT_CATEGORIES) === FALLBACK_CATEGORY_ID)
    assert(inferCategoryFromPath('D:\\a\\Makefile', DEFAULT_CATEGORIES) === FALLBACK_CATEGORY_ID)
    assert(inferCategoryFromPath('D:\\a\\data.zzz', DEFAULT_CATEGORIES, { fallback: 'mine' }) === 'mine', '自定义 fallback 该生效')
  })
  check('★★ 目录不猜（`v1.2` 这种目录名会被读出后缀 `2`）', () => {
    assert(inferCategoryFromPath('D:\\proj\\v1.2', DEFAULT_CATEGORIES, { isDir: true }) === FALLBACK_CATEGORY_ID,
      '目录该直接回落，得到 ' + inferCategoryFromPath('D:\\proj\\v1.2', DEFAULT_CATEGORIES, { isDir: true }))
    // 对照：不传 isDir 时会误判成后缀 2 → 认不出 → 也是 other（所以这条断言只证明 isDir 路径走通了）
    assert(inferCategoryFromPath('D:\\proj\\v1.2', DEFAULT_CATEGORIES) === FALLBACK_CATEGORY_ID)
  })
  check('分类表为空/脏 → 一律回落，不抛', () => {
    assert(inferCategoryFromPath('a.md', []) === FALLBACK_CATEGORY_ID)
    assert(inferCategoryFromPath('a.md', null) === FALLBACK_CATEGORY_ID)
    assert(inferCategoryFromPath('a.md', [null, 1, { id: 2 }]) === FALLBACK_CATEGORY_ID)
  })
  check('buildExtIndex 容错：exts 里的脏项跳过（`.` / `..` / 空串 / 非字符串）', () => {
    const { owner } = buildExtIndex([{ id: 'x', exts: ['.', '..', '', '  ', 42, '.MD'] }])
    assert(owner.get('md') === 'x', '干净的那个该进索引')
    assert(owner.size === 1, '只有 md 该进索引，得到 ' + JSON.stringify([...owner.keys()]))
  })
}

// ═══ [C] categoryLabel / groupByCategory ══════════════════════════════════
console.log('\n=== [C] 显示名与分组 ===')
{
  check('categoryLabel：认识的回 label，不认识的**回 id 而不是「未知」**', () => {
    assert(categoryLabel(DEFAULT_CATEGORIES, 'document') === '文档')
    assert(categoryLabel(DEFAULT_CATEGORIES, 'other') === '未分类')
    // ★ 孤儿不隐藏：这是有意的 —— 用户删了分类后必须还能看出记录指向了什么
    assert(categoryLabel(DEFAULT_CATEGORIES, 'deleted_cat') === 'deleted_cat',
      '孤儿该原样返回 id，得到 ' + categoryLabel(DEFAULT_CATEGORIES, 'deleted_cat'))
    assert(categoryLabel(DEFAULT_CATEGORIES, '') === FALLBACK_CATEGORY_ID)
  })
  check('★ groupByCategory：顺序 = 分类表顺序、**0 条的空分类也返回**', () => {
    const recs = [{ artifact_type: 'image' }, { artifact_type: 'image' }, { artifact_type: 'code' }]
    const g = groupByCategory(recs, DEFAULT_CATEGORIES)
    assert(g.buckets.map((b) => b.id).join(',') === DEFAULT_CATEGORIES.map((c) => c.id).join(','),
      '顺序必须跟分类表一致（用户排的序就是界面的序）')
    assert(g.buckets.find((b) => b.id === 'image').count === 2, 'image 该是 2')
    assert(g.buckets.find((b) => b.id === 'code').count === 1, 'code 该是 1')
    assert(g.buckets.find((b) => b.id === 'audio').count === 0, '0 条的空分类也要返回（否则没法往里拖）')
    assert(g.total === 3, 'total: ' + g.total)
  })
  check('★ groupByCategory：孤儿单独报出来，不混进兜底类', () => {
    const recs = [{ artifact_type: 'other' }, { artifact_type: 'ghost' }, { artifact_type: 'ghost' }]
    const g = groupByCategory(recs, DEFAULT_CATEGORIES)
    assert(g.buckets.find((b) => b.id === FALLBACK_CATEGORY_ID).count === 1,
      '兜底类只该数**真的**指向 other 的记录，不该把孤儿折进来')
    assert(g.orphans.length === 1 && g.orphans[0].id === 'ghost' && g.orphans[0].count === 2,
      '孤儿: ' + JSON.stringify(g.orphans))
  })
  check('groupByCategory：没给 artifact_type 的记录算兜底类', () => {
    const g = groupByCategory([{}, { artifact_type: '' }, { artifact_type: null }], DEFAULT_CATEGORIES)
    assert(g.buckets.find((b) => b.id === FALLBACK_CATEGORY_ID).count === 3, JSON.stringify(g.buckets))
  })
  check('groupByCategory：bucket 带 icon / locked，供界面直接渲染', () => {
    const g = groupByCategory([], DEFAULT_CATEGORIES)
    const other = g.buckets.find((b) => b.id === FALLBACK_CATEGORY_ID)
    assert(other.icon === 'other' && other.locked === true, JSON.stringify(other))
    const doc = g.buckets.find((b) => b.id === 'document')
    assert(doc.icon === 'doc' && doc.locked === false, JSON.stringify(doc))
  })
}

// ═══ [D] ★ store 接线 ═════════════════════════════════════════════════════
console.log('\n=== [D] store 接线（★ 归类只准往前、不准回头）===')
{
  check('★★ 不注入 provider 时行为**与改动前完全一致**（一律 other，不猜）', () => {
    const dir = mkTmp('alf-cat-none-')
    const store = new ArtifactStore(dir)
    const rec = store.register({ path: touch(dir, 'a.md') })
    assert(rec.artifact_type === 'other',
      '没注入分类表时不该猜后缀，得到 ' + rec.artifact_type)
  })
  check('注入了分类表 → 未传 artifact_type 时**按后缀**给默认归类', () => {
    const dir = mkTmp('alf-cat-infer-')
    const store = new ArtifactStore(dir).setCategoriesProvider(() => DEFAULT_CATEGORIES)
    assert(store.register({ path: touch(dir, 'a.md') }).artifact_type === 'document', 'md')
    assert(store.register({ path: touch(dir, 'a.png') }).artifact_type === 'image', 'png')
    assert(store.register({ path: touch(dir, 'a.py') }).artifact_type === 'code', 'py')
    assert(store.register({ path: touch(dir, 'a.mp4') }).artifact_type === 'video', 'mp4')
  })
  check('★ 显式传的 artifact_type **永远优先**（哪怕和后缀不一致）', () => {
    const dir = mkTmp('alf-cat-explicit-')
    const store = new ArtifactStore(dir).setCategoriesProvider(() => DEFAULT_CATEGORIES)
    const rec = store.register({ path: touch(dir, 'notes.md'), artifact_type: 'code' })
    assert(rec.artifact_type === 'code', '显式值被后缀覆盖了：' + rec.artifact_type)
  })
  check('认不出的后缀 → other（不是空串、不是 undefined）', () => {
    const dir = mkTmp('alf-cat-unknown-')
    const store = new ArtifactStore(dir).setCategoriesProvider(() => DEFAULT_CATEGORIES)
    assert(store.register({ path: touch(dir, 'a.qqq') }).artifact_type === 'other')
    assert(store.register({ path: touch(dir, 'Makefile') }).artifact_type === 'other')
  })
  check('★ 目录不按后缀归类（真建一个叫 v1.2 的目录）', () => {
    const dir = mkTmp('alf-cat-dir-')
    const store = new ArtifactStore(dir).setCategoriesProvider(() => DEFAULT_CATEGORIES)
    const sub = path.join(dir, 'v1.2')
    fs.mkdirSync(sub, { recursive: true })
    const rec = store.register({ path: sub })
    assert(rec.is_dir === true, '前置：该被认出是目录')
    assert(rec.artifact_type === 'other', '目录被按后缀猜成 ' + rec.artifact_type)
  })
  check('★ provider 是**每次现取**的：改了设置不用重建 store', () => {
    const dir = mkTmp('alf-cat-live-')
    let cats = [{ id: 'mine', label: '我的', exts: ['qqq'] }, { id: 'other', label: '未分类', exts: [] }]
    const store = new ArtifactStore(dir).setCategoriesProvider(() => cats)
    assert(store.register({ path: touch(dir, 'a.qqq') }).artifact_type === 'mine', '前置')
    // 用户改了分类表 → 立刻生效（不需要重建 store / 不需要重启）
    cats = [{ id: 'mine2', label: '我的2', exts: ['qqq'] }, { id: 'other', label: '未分类', exts: [] }]
    assert(store.register({ path: touch(dir, 'b.qqq') }).artifact_type === 'mine2',
      '改了分类表后没生效 —— 又一处「存进去了但不生效」')
  })
  check('provider 抛异常 → 退化成 other，不把 register 带崩', () => {
    const dir = mkTmp('alf-cat-throw-')
    const store = new ArtifactStore(dir).setCategoriesProvider(() => { throw new Error('设置存储炸了') })
    const rec = store.register({ path: touch(dir, 'a.md') })
    assert(rec.artifact_type === 'other', '该退化，得到 ' + rec.artifact_type)
    assert(store.getCategories().length === 0)
  })
  check('★★★ 已有记录**一条都不动**：注入分类表不会回头改写老数据', () => {
    const dir = mkTmp('alf-cat-legacy-')
    // 先在「没有分类表」的世界里造一条老记录（artifact_type 是当初的语义判断）
    const store1 = new ArtifactStore(dir)
    const legacyPath = touch(dir, 'old.md')
    const legacy = store1.register({ path: legacyPath, artifact_type: 'code' })
    store1.save()
    assert(legacy.artifact_type === 'code', '前置：老记录是 code')
    // 再挂上分类表，重新 load（模拟升级后重启）
    const store2 = new ArtifactStore(dir).load().setCategoriesProvider(() => DEFAULT_CATEGORIES)
    const after = store2.items.find((r) => r.id === legacy.id)
    assert(after.artifact_type === 'code',
      `老记录的 type 被按后缀改成 ${after.artifact_type} 了 —— 「不回头改写」被破坏`)
  })
  check('categories() 返回分类表 + buckets + orphans（types 保留给老消费方）', () => {
    const dir = mkTmp('alf-cat-endpoint-')
    const store = new ArtifactStore(dir).setCategoriesProvider(() => DEFAULT_CATEGORIES)
    store.register({ path: touch(dir, 'a.md') })                 // → document
    store.register({ path: touch(dir, 'b.png') })                // → image
    store.register({ path: touch(dir, 'c.txt'), artifact_type: 'ghost_cat' }) // 孤儿
    const c = store.categories()
    assert(Array.isArray(c.types), 'types 必须保留（老消费方还在读）')
    assert(Array.isArray(c.projects) && Array.isArray(c.tags), 'projects/tags 必须保留')
    assert(c.categories.length === DEFAULT_CATEGORIES.length, 'categories 该是设置里的表')
    assert(c.buckets.find((b) => b.id === 'document').count === 1, JSON.stringify(c.buckets))
    assert(c.buckets.find((b) => b.id === 'image').count === 1, JSON.stringify(c.buckets))
    assert(c.orphans.length === 1 && c.orphans[0].id === 'ghost_cat', '孤儿: ' + JSON.stringify(c.orphans))
  })
  check('categories() 不注入 provider 时：categories 是空表、buckets 空、记录仍全部报成孤儿', () => {
    const dir = mkTmp('alf-cat-bare-')
    const store = new ArtifactStore(dir)
    store.register({ path: touch(dir, 'a.md'), artifact_type: 'document' })
    const c = store.categories()
    assert(c.categories.length === 0, '没注入就没有表')
    assert(c.buckets.length === 0, '没有表就没有 buckets')
    assert(c.orphans.length === 1 && c.orphans[0].id === 'document',
      '★ 没有表时**所有**记录都是孤儿（而不是被悄悄折进 other）—— 这是诚实的：无表 = 无法判定')
  })
}

// ═══ [E] 形状守卫：两份常量不许漂移 ═══════════════════════════════════════
console.log('\n=== [E] 形状守卫 ===')
{
  check('★ FALLBACK_CATEGORY_ID 必须等于 settings 的 LOCKED_CATEGORY_ID', () => {
    assert(FALLBACK_CATEGORY_ID === LOCKED_CATEGORY_ID,
      `两份常量漂了：categories.js=${FALLBACK_CATEGORY_ID} / settings.js=${LOCKED_CATEGORY_ID} —— ` +
      '漂了的后果是「归类到兜底」和「兜底不可删」指向两个不同的 id')
  })
  check('★ checkCategoryId 的正则与 settings 的 CATEGORY_ID_RE 同源', () => {
    const samples = ['doc', 'my-cat', 'a_b', 'A', '1x', '', 'has space', 'x'.repeat(33), '__proto__']
    for (const s of samples) {
      const a = CATEGORY_ID_RE.test(s)
      const b = checkCategoryId(DEFAULT_CATEGORIES, s).ok
      assert(a === b, `对 ${JSON.stringify(s)} 两份判定不一致：settings=${a} categories=${b}`)
    }
  })
  check('checkCategoryId：空/非法被拒，合法通过', () => {
    assert(checkCategoryId([], 'ok_id').ok === true)
    assert(checkCategoryId([], '  ok_id  ').id === 'ok_id', '该 trim')
    assert(checkCategoryId([], '').ok === false)
    assert(checkCategoryId([], 'Bad').ok === false)
    assert(checkCategoryId([], null).ok === false)
  })
  check('findCategory：按 id / 按 label（含大小写不敏感）都能找到', () => {
    assert(findCategory(DEFAULT_CATEGORIES, 'document').id === 'document', '按 id')
    assert(findCategory(DEFAULT_CATEGORIES, '文档').id === 'document', '按 label')
    assert(findCategory(DEFAULT_CATEGORIES, '未分类').id === LOCKED_CATEGORY_ID, '兜底类按 label')
    assert(findCategory(DEFAULT_CATEGORIES, 'nope') === null, '找不到回 null')
    assert(findCategory(DEFAULT_CATEGORIES, '') === null, '空串回 null')
  })
  check('默认分类表能被 validateCategories 原样接受（两份定义自洽）', () => {
    const r = validateCategories(DEFAULT_CATEGORIES)
    assert(r.ok, '默认表自身没通过校验：' + r.reason)
    assert(JSON.stringify(r.value) === JSON.stringify(DEFAULT_CATEGORIES),
      'normalize 之后变了 —— 默认表与校验器口径不一致')
  })
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
for (const dir of TMP_DIRS) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ } }

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
