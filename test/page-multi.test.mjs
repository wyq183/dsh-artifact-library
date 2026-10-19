/**
 * 管理页多选筛选（2026-10-19 第 4 步）
 * ══════════════════════════════════════════════════════════════════════════
 * 依琪：「同样是下拉式展开**多选择分类**加可以拖动的分割线更清晰的 ui 分割」
 *
 * 【为什么必须前端过滤】
 * 宿主 `store.list()` 是**单值相等**签名（没有 `kind[]`），多选没法下推。
 * ⇒ 拉一次全量，本地 `mfMatch` 过滤（与侧栏 `rpMatchPicks` 同口径）。
 *
 * 【本文件守什么】
 *   · 语义：维度内 OR / 维度间 AND / 空 = 不筛
 *   · 搜索仍走服务端（唯一不能下放的维度）
 *   · 真机踩过的两个坑：机器值显示、loadMeta 空指针
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../', import.meta.url))
const PAGE = path.join(REPO, 'ui', 'index.html')

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) {
    failed += 1
    const msg = error && error.message ? error.message : String(error)
    failures.push({ name, msg })
    console.log('  FAIL ' + name + ' -> ' + msg)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

console.log('\n═══ 管理页多选筛选 ═══')

const html = fs.readFileSync(PAGE, 'utf8')
const m = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(html)
const js = m ? m[1] : ''

// ══════════════════════════════════════════════════════════════════════════
// [A] 语法 + 空指针（真机踩过）
// ══════════════════════════════════════════════════════════════════════════

check('A1 ★★ 内联 JS 能过语法解析', () => {
  try { new vm.Script(js, { filename: 'inline' }) }
  catch (e) { throw new Error('语法错：' + e.message) }
})

check('A2 ★★ 不许再给已删掉的 `<select>` 写 innerHTML（真机踩了空指针）', () => {
  // ⚠️ 真机报：`Cannot set properties of null (setting 'innerHTML')`
  //    原因：`loadMeta()` 还在给 fProject/fType/fTag 灌选项，而它们已改成多选容器。
  assert(!/\$\('fProject'\)\.innerHTML/.test(js), '★ 还在给 fProject 写 innerHTML')
  assert(!/\$\('fType'\)\.innerHTML/.test(js), '★ 还在给 fType 写 innerHTML')
  assert(!/\$\('fTag'\)\.innerHTML/.test(js), '★ 还在给 fTag 写 innerHTML')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 语义：从真源码抠 mfMatch/mfToggle 求值
// ══════════════════════════════════════════════════════════════════════════

/**
 * 抠出 MF + mfMatch + mfToggle + mfCount 求值。
 * ⚠️ mfRender 依赖 DOM，不抠；只抠**判定**部分。
 */
function loadMF() {
  const a = js.indexOf('const MF = {')
  // ⚠️ 切片必须覆盖 mfMatch / mfToggle / mfCount —— 它们排在 mfOptions **之后**，
  //    第一版切到 mfOptions 注释就停了 ⇒ ReferenceError: mfToggle is not defined。
  const b = js.indexOf('function mfRender(key)')
  assert(a > 0 && b > a, '抠不出 MF 判定层')
  const box = { Object, String, Array, state: { allItems: [] } }
  vm.createContext(box)
  vm.runInContext(js.slice(a, b) + '\n;this.MF=MF;this.mfMatch=mfMatch;this.mfToggle=mfToggle;this.mfCount=mfCount;', box)
  return box
}
const T = loadMF()

const ITEMS = [
  { kind: 'deliverable', artifact_type: 'document', project: '甲', tags: ['a', 'b'] },
  { kind: 'deliverable', artifact_type: 'image', project: '甲', tags: ['b'] },
  { kind: 'reference', artifact_type: 'document', project: '乙', tags: ['c'] },
  { kind: 'reference', artifact_type: 'code', project: '', tags: [] },
]
// ⚠️ 必须先取**原下标**再过滤 ——
//    `filter(...).map((r, i) => i)` 里的 i 是**新数组下标**，
//    不是原数组下标（这里踩过：document 命中原 0/2，过滤后错报成 0,1）。
const ids = () => ITEMS.map((r, i) => (T.mfMatch(r) ? i : -1)).filter((i) => i >= 0).join(',')
const reset = () => { for (const k of Object.keys(T.MF)) T.MF[k].picked.length = 0 }

check('B1 ★★ 空 = **不筛**（全部通过）', () => {
  reset()
  assert(ids() === '0,1,2,3', '★ 空选择筛掉了东西：' + ids())
})

check('B2 ★★ 同一维度多值 = **OR**（产出 + 资料 = 全部）', () => {
  reset()
  T.MF.kind.picked.push('deliverable', 'reference')
  assert(ids() === '0,1,2,3', '★ OR 不对：' + ids())
})

check('B3 ★★ 不同维度 = **AND**', () => {
  reset()
  T.MF.kind.picked.push('deliverable')
  T.MF.tag.picked.push('b')
  assert(ids() === '0,1', '★ AND 不对：' + ids())
})

check('B4 ★★ 标签是**多值字段**：选 a+b = 带 a **或** 带 b', () => {
  reset()
  T.MF.tag.picked.push('a', 'b')
  // 0(tags a,b) + 1(tags b) = 0,1；若错写成"必须同时有"则只有 0
  assert(ids() === '0,1', '★ 标签当成了"必须同时有"：' + ids())
})

check('B5 ★ 单维度单选正确', () => {
  // ⚠️ 每次断言前必须 reset() —— 第一版第二次忘了，残留了上一次的 artifact_type
  //    ⇒ 测出 0,1 而不是 0,1（project=甲 时 0,1 是对的，但当时的实际筛选条件不是"只有甲"）。
  reset()
  T.MF.artifact_type.picked.push('document')
  assert(ids() === '0,2', '★ document：' + ids())

  reset()
  T.MF.project.picked.push('甲')
  assert(ids() === '0,1', '★ 甲：' + ids())
})

check('B6 ★ mfToggle 是"切换"（再点取消）', () => {
  reset()
  T.mfToggle('kind', 'deliverable')
  assert(T.MF.kind.picked.length === 1, '没加上')
  T.mfToggle('kind', 'deliverable')
  assert(T.MF.kind.picked.length === 0, '★ 再点一次没取消')
})

check('B7 ★ mfCount 全维度求和', () => {
  reset()
  assert(T.mfCount() === 0, '空应为 0')
  T.MF.kind.picked.push('x')
  T.MF.tag.picked.push('y', 'z')
  assert(T.mfCount() === 3, '应为 3，实际 ' + T.mfCount())
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 数据流：搜索下推、多选不下推
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★ 搜索 `q` **仍走服务端**（要搜正文，本地会漏）', () => {
  const fn = js.slice(js.indexOf('async function reload()'), js.indexOf('async function reload()') + 1800)
  assert(/p\.set\('q', q\)/.test(fn), '★ 搜索没走服务端 —— 本地搜不到正文')
})

check('C2 ★★ 多选维度**不许**拼进 URL（宿主是单值相等，拼不了多个）', () => {
  const fn = js.slice(js.indexOf('async function reload()'), js.indexOf('async function reload()') + 1800)
  for (const bad of ["p.set('kind'", "p.set('artifact_type'", "p.set('project'", "p.set('tag'"]) {
    assert(fn.indexOf(bad) < 0, '★ ' + bad + ' 还在 —— 多选被当成单值下推，只会筛出一个')
  }
  assert(fn.indexOf('mfMatch') >= 0, '★ 没在本地过滤')
})

check('C3 ★ 全量存在 `state.allItems`，筛选结果在 `state.items`', () => {
  assert(/allItems:\s*\[\]/.test(js), 'state 里没有 allItems')
  const fn = js.slice(js.indexOf('async function reload()'), js.indexOf('async function reload()') + 1800)
  assert(/state\.allItems\s*=/.test(fn), '没存全量')
  assert(/state\.items\s*=\s*state\.allItems\.filter/.test(fn), '★ 没从全量过滤出 items')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 人话显示（真机踩过：显示 deliverable）
// ══════════════════════════════════════════════════════════════════════════

check('D1 ★★ 类别显示**中文**（真机看到 deliverable / reference）', () => {
  assert(/deliverable:\s*'产出'/.test(js) && /reference:\s*'资料'/.test(js),
    '★ 没把机器值翻成人话')
  assert(js.indexOf('mfLabelOf') >= 0, '没有 mfLabelOf')
})

check('D2 ★ 选项与摘要都用 mfLabelOf（不许一处翻一处不翻）', () => {
  const fn = js.slice(js.indexOf('function mfRender'), js.indexOf('function mfRenderAll'))
  assert(fn.indexOf('mfLabelOf') >= 0, '★ 选项没用人话')
})

// ══════════════════════════════════════════════════════════════════════════
// [E] 交互（展开/收起/点外/Esc）
// ══════════════════════════════════════════════════════════════════════════

check('E1 ★★ 4 个多选容器都在 HTML 里', () => {
  for (const id of ['mfKind', 'mfType', 'mfProject', 'mfTag']) {
    assert(new RegExp('id="' + id + '"').test(html), '缺容器 ' + id)
  }
})

check('E2 ★★ 同时只展开一个 + 点外关闭 + Esc 关闭', () => {
  // ⚠️ 不是原生 <details>，浏览器不会自动收 ⇒ 必须自己补
  assert(/querySelectorAll\(['"]\.mfwrap\.mfopen['"]\)\.forEach/.test(js),
    '★ 没有"先关全部再开一个"')
  assert(/closest\(['"]\.mfwrap['"]\)/.test(js), '★ 没有点外关闭的判断')
  assert(/Escape/.test(js), '★ 没有 Esc 关闭')
})

check('E3 ★★ 选完**不自动收**（多选时自动收会让人反复点开）', () => {
  const seg = js.slice(js.indexOf("const ck = t.closest"), js.indexOf("const clr = t.closest"))
  assert(seg.indexOf('mfopen') >= 0 && seg.indexOf('add') >= 0,
    '★ 勾选后没保持展开 —— 每选一个值就要重新点开')
})

check('E4 ★ 事件**委托**（4 个下拉一处代码，不绑 4 套）', () => {
  assert(/document\.addEventListener\(['"]click['"]/.test(js), '没有委托')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
