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
  CONTENT_KEYS, PRESETS, settingsSchema,
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

// ═══ [F] 客户端接线守卫（Step 2d）═════════════════════════════════════════
//
// 为什么这一节是**读源码文本**而不是渲染：
//   `listQuery` / 工具条那段在 client.js 的一个闭包里，而 client-pure 的注入锚点
//   （`exports.apply = apply;`）在模块作用域 —— 注入钩子看不见它们（实测）。
//   而这一类 bug 恰恰是**「宿主支持、前端不传」**：2b 之前 `store.list` 早就认
//   `artifact_type` 这个参数，缺的只有前端。这种「静默断线」用源码守卫抓最直接。
console.log('\n=== [F] 客户端接线守卫（防「图能点、请求不带上」）===')
{
  const clientSrc = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  check('★★ listQuery 必须把 artifact_type 拼进查询串（否则筛选器是死的）', () => {
    const m = clientSrc.match(/function listQuery\(filters\)\s*\{[\s\S]*?\n {4}\}/)
    assert(m, '找不到 listQuery 函数体（改名/改形了？请同步本测试）')
    assert(/add\("artifact_type",\s*filters\.artifact_type\)/.test(m[0]),
      'listQuery 没带上 artifact_type —— 用户选了分类，请求里没有，列表不会变')
  })
  check('★★ 筛选状态必须有 artifact_type 这个键（否则下拉的 value 是 undefined）', () => {
    const m = clientSrc.match(/var stateFilters = React\.useState\(\{([^}]*)\}\)/)
    assert(m, '找不到 stateFilters 初值')
    assert(/artifact_type:/.test(m[1]), 'stateFilters 缺 artifact_type 键：' + m[1].trim())
  })
  check('★★★ 重拉的依赖数组里必须有 filters.artifact_type（否则选了分类不刷新）', () => {
    // 这是「存进去了但不生效」的典型形状：UI 会变、请求会带上，但**没人重新拉**
    const m = clientSrc.match(/\}, \[reload, ([^\]]*)\]\)/)
    assert(m, '找不到重拉 effect 的依赖数组')
    assert(/filters\.artifact_type/.test(m[1]),
      '依赖数组里没有 filters.artifact_type —— 切分类不会重新拉数据。当前依赖：' + m[1].trim())
  })
  check('★ 工具条里真的有分类下拉，且选项来自 buckets（带计数）', () => {
    assert(/catBuckets/.test(clientSrc) && /data\.cats\.buckets/.test(clientSrc), '没读 buckets')
    assert(/"aria-label": "按分类筛选"/.test(clientSrc), '找不到分类下拉')
    // 计数要拼进选项文案，否则「更醒目」只体现在名字上
    assert(/bucket\.count/.test(clientSrc), '选项里没带计数')
  })
  check('★ 0 条的空分类也要列出来（否则用户没法选中它往里归东西）', () => {
    // 判据：选项由 catOptions 整体 map 生成，**没有** `count > 0` 之类的过滤
    const m = clientSrc.match(/catOptions\.map\(function[\s\S]*?\n {10}\}\)/)
    assert(m, '找不到 catOptions.map 那段')
    assert(!/count\s*>\s*0/.test(m[0]), '选项被按 count>0 过滤了 —— 空分类会消失')
  })
  check('★ 失效分类走 optgroup，且明确标注（不静默混进正常分类里）', () => {
    assert(/optgroup/.test(clientSrc) && /已失效的分类/.test(clientSrc), '孤儿没有单独分组')
  })
  check('★ 产物面板的「产出/资料」下拉不再叫「按类型筛选」（它筛的不是分类）', () => {
    // ⚠️ 只针对**产物面板那个 filters.kind 下拉**。
    //    文件浏览器里另有一处 `aria-label: "按类型筛选"`（`__chips` 那组扩展名按钮，
    //    见 client.js 的 chips 段）—— 那个标签是**对的**：它确实按文件类型筛。
    //    第一版这条守卫全文件搜、于是误伤了那一处，已收窄到 kind 下拉本身。
    // 直接对**那一行**做字面断言（比正则匹配整段可靠：那段里嵌着 `{...}` 的箭头/函数体）
    assert(clientSrc.includes('value: filters.kind, "aria-label": "按产出/资料筛选"'),
      '找不到「产出/资料」下拉的正确标签（是不是又改回「按类型筛选」了？）')
    assert(!clientSrc.includes('value: filters.kind, "aria-label": "按类型筛选"'),
      '这个下拉还挂着「按类型筛选」—— 它筛的是产出/资料，不是分类')
  })
  check('★ 清空筛选与 hasFilter 都要算上 artifact_type（否则「清空」后仍被分类卡着）', () => {
    assert(/patchFilters\(\{ q: "", kind: "", refine: "", project: "", artifact_type: "" \}\)/.test(clientSrc),
      '「清空筛选看全部」没有清 artifact_type')
    assert(/hasFilter = !!\(filters\.q \|\| filters\.kind \|\| filters\.artifact_type/.test(clientSrc),
      'hasFilter 没算 artifact_type —— 空态会误判成「首次使用」')
  })
}

// ═══ [G] schema 暴露预设的分类（Step 2e）══════════════════════════════════
//
// 为什么必须暴露：预设的**外观是重置、分类是合并（只增不删）**。
// 不告诉用户「套这个预设会多出哪些分类」，他套完「办公」发现「脚本」还在，
// 只会以为是 bug。这一节同时钉住「别用不存在的 class」——
// 热载不重插 CSS，新 class 在真机上就是没有样式的裸文字。
console.log('\n=== [G] schema 暴露预设分类（Step 2e）===')
{
  const s = settingsSchema()

  check('settingsSchema 报出 contentKeys（与 APPEARANCE_KEYS 对称）', () => {
    assert(Array.isArray(s.contentKeys), 'contentKeys 缺失')
    assert(JSON.stringify(s.contentKeys) === JSON.stringify(CONTENT_KEYS), JSON.stringify(s.contentKeys))
  })
  check('★ 每个预设都带 contentCategories（哪怕是空数组，不能是 undefined）', () => {
    for (const p of s.presets) {
      assert(Array.isArray(p.contentCategories),
        `${p.id} 的 contentCategories 不是数组：${JSON.stringify(p.contentCategories)}`)
    }
  })
  check('★ contentCategories 与 PRESETS 的 content.categories 逐条一致', () => {
    for (const p of s.presets) {
      const src = (PRESETS[p.id].content || {}).categories || []
      assert(p.contentCategories.length === src.length,
        `${p.id}: schema ${p.contentCategories.length} 条 vs 源 ${src.length} 条`)
      for (let i = 0; i < src.length; i += 1) {
        assert(p.contentCategories[i].id === src[i].id && p.contentCategories[i].label === src[i].label,
          `${p.id}[${i}] 不一致：${JSON.stringify(p.contentCategories[i])} vs ${JSON.stringify(src[i])}`)
      }
    }
  })
  check('★ 开发者预设的分类在 schema 里可见（依琪要的「代码方面的预设分类」）', () => {
    const dev = s.presets.find((p) => p.id === 'developer')
    const labels = dev.contentCategories.map((c) => c.label)
    for (const need of ['代码', '脚本', '配置']) {
      assert(labels.includes(need), `schema 里看不到 ${need}：${labels.join('/')}`)
    }
  })
  check('general 预设不带分类（空数组，不是 undefined）', () => {
    const g = s.presets.find((p) => p.id === 'general')
    assert(Array.isArray(g.contentCategories) && g.contentCategories.length === 0)
  })
  check('★ contentCategories 只摘 id/label，不泄漏完整定义', () => {
    for (const p of s.presets) {
      for (const c of p.contentCategories) {
        assert(JSON.stringify(Object.keys(c).sort()) === JSON.stringify(['id', 'label']),
          `${p.id} 的 ${c.id} 多带了字段：${JSON.stringify(Object.keys(c))}`)
      }
    }
  })
  check('★ 设置页新代码用的 class 必须都已存在（否则真机上是裸文字）', () => {
    const clientSrc2 = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    // 「预设带的分类」那一块实际用到的 class：**各自都必须在别处也被用过**，
    // 否则说明它是我新造的名字 —— 而新 class 在本轮是没有样式的（CSS 不随热载重插）。
    for (const cls of ['__setgroup', '__setgh', '__sethint', '__setrow', '__setlabel']) {
      const hits = clientSrc2.split('"' + cls + '"').length - 1
      assert(hits > 1, `class ${cls} 只出现 ${hits} 次 —— 它可能是我新造的名字，真机上没有样式`)
    }
  })
  check('★ 新增代码里不得**使用** __settags / __settag（我第一版造的两个不存在的 class）', () => {
    const clientSrc2 = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    // ⚠️ 只看**实际用法**（`NS + "__settag"` 这种拼 class 的地方），不看注释 ——
    //    上面那段注释里就写着这两个名字（用来记这个教训），
    //    第一版这条断言搜全文，于是被自己的注释绊倒。
    assert(!/NS\s*\+\s*"__settags?"/.test(clientSrc2),
      '又用上了不存在的 __settags/__settag —— 热载不重插 CSS，它们在真机上没有样式')
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
