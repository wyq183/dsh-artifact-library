/**
 * 管理页列表：可拖列宽 + 可拖行高（2026-10-19 第 3 步）
 * ══════════════════════════════════════════════════════════════════════════
 * 依琪：「同样是下拉式展开多选择分类加**可以拖动的分割线**更清晰的 ui 分割」
 *       「a 都使用分割线来自由控制」
 *       「列表就可以……但只要列表可以**调节高度展示出预览缩略图**就够了」
 *
 * ⚠️ 这里的每一条都对应这轮**真机踩到**或**侧栏已经栽过**的坑。
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

console.log('\n═══ 列表可拖列宽 + 行高 ═══')

const html = fs.readFileSync(PAGE, 'utf8')
const m = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(html)
const js = m ? m[1] : ''

// ══════════════════════════════════════════════════════════════════════════
// [A] 语法护栏（白屏）
// ══════════════════════════════════════════════════════════════════════════

check('A1 ★★ 内联 JS 能过语法解析（这轮真踩了：模板里多一个反引号）', () => {
  // ⚠️ 我把 `+ moreBtn` 后面多写了一个反引号 ⇒ 后面的代码全被当字符串 ⇒ 整页白屏。
  //    而 eslint 看不了 .html、node --check 也不管 —— 只有这条能拦。
  try { new vm.Script(js, { filename: 'inline' }) }
  catch (e) { throw new Error('语法错：' + e.message) }
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 列模型（照抄侧栏 —— 侧栏已经在这上面栽过）
// ══════════════════════════════════════════════════════════════════════════

check('B1 ★★ 列宽用 `<colgroup>`（不是给每个 td 写 style）', () => {
  // 447 行 × 9 列 = 4023 个 style，改宽度还要全量重渲
  assert(js.indexOf('colgroup') >= 0, '没有 colgroup')
  assert(/<col data-k="/.test(js), '没有带 data-k 的 col')
})

check('B2 ★★ 表格必须 `table-layout:fixed`（否则设的 width 会被"参考"而不是"遵守"）', () => {
  // ⚠️ 不开 fixed 时浏览器按内容重新分配列宽，拖完会弹回去（用户以为坏了）
  assert(/\.pvtable\{table-layout:fixed/.test(html),
    '★ 没开 table-layout:fixed —— 拖了会弹回去')
})

check('B3 ★★ 尾部多一个**空列**吃剩余空间（与侧栏同一套模型）', () => {
  // ⚠️ 侧栏栽过一次：名字列用 1fr 时，拖任何列都只有它在动。
  //    正确做法是全部固定 px + 尾部空白列。
  const seg = js.slice(js.indexOf('const colgroup'), js.indexOf('const colgroup') + 700)
  assert(/COLS\.map[\s\S]{0,200}<col>/.test(seg), '★ 尾部没有空列 —— 剩余空间会挤给某一列')
})

check('B4 ★ 列宽持久化 + 读取时校验 min（存了 0 会让列消失）', () => {
  assert(js.indexOf('loadCols') >= 0 && js.indexOf('saveCols') >= 0, '没有持久化')
  const fn = js.slice(js.indexOf('function loadCols'), js.indexOf('function saveCols'))
  assert(/Number\.isFinite\(v\) && v >= c\.min/.test(fn),
    '★ 没校验存量值 —— 存了个 0 会让列消失')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 拖动（pointer + 夹 min + 成对清理）
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★ 拖动用 pointer + setPointerCapture（触屏可用、拖出表格不丢）', () => {
  for (const fnName of ['startColDrag', 'startRowDrag']) {
    const i = js.indexOf('function ' + fnName)
    assert(i > 0, '没有 ' + fnName)
    const fn = js.slice(i, i + 2000)
    assert(fn.indexOf('setPointerCapture') >= 0, fnName + ' 没有 setPointerCapture')
    assert(fn.indexOf('pointermove') >= 0, fnName + ' 没有 pointermove')
    assert(fn.indexOf('pointercancel') >= 0, '★ ' + fnName + ' 没成对清理（会留野监听）')
    assert(fn.indexOf('mousedown') < 0, fnName + ' 还在用 mousedown（触屏用不了）')
  }
})

check('C2 ★★ 都夹到最小值（不夹能拖成负宽 = 列消失/行高为 0）', () => {
  const c = js.slice(js.indexOf('function startColDrag'), js.indexOf('function startColDrag') + 1400)
  assert(/Math\.max\(col\.min, Math\.round\(startW \+ dx\)\)/.test(c), '★ 列宽没夹 min')
  const r = js.slice(js.indexOf('function startRowDrag'), js.indexOf('function startRowDrag') + 1400)
  assert(/Math\.max\(ROW_H_MIN/.test(r) && /Math\.min\(ROW_H_MAX/.test(r),
    '★ 行高没夹 [MIN, MAX]')
})

check('C3 ★ 双击把手恢复默认列宽', () => {
  assert(js.indexOf('resetColWidth') >= 0, '没有 resetColWidth')
  assert(/ondblclick="resetColWidth/.test(js), '把手没绑双击')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 把手可见性（今晚已经因为"看不见"栽过两次）
// ══════════════════════════════════════════════════════════════════════════

check('D1 ★★ 行高把手在**表头里**（不是表格底部）', () => {
  // ⚠️ 第一版放在表格后面 ⇒ 447 行时要滚到最底才看得到 ⇒ 等于没有
  //    （"没看到分割线，就也没法拖动" —— 同一个错）
  const head = js.slice(js.indexOf("'<thead>"), js.indexOf("+ moreBtn"))
  assert(head.indexOf('rowgripth') >= 0, '★ 表头里没有行高把手 —— 长列表下看不到')
})

check('D2 ★★ 把手可点区 ≥ 8px（1px 的线鼠标抓不住）', () => {
  const seg = html.slice(html.indexOf('.colgrip{'), html.indexOf('.colgrip{') + 200)
  const m2 = /width:(\d+)px/.exec(seg)
  assert(m2 && Number(m2[1]) >= 8,
    '★ 列宽把手只有 ' + (m2 ? m2[1] : '?') + 'px 宽 —— 抓不住')
})

check('D3 ★ 把手常态可见（不许藏到 hover 才出现）', () => {
  // 依琪今天说过两次"看不见"
  const seg = html.slice(html.indexOf('.colgrip::after'), html.indexOf('.colgrip::after') + 220)
  assert(seg.indexOf('background:var(--line)') >= 0,
    '★ 把手常态不可见 —— 用户不知道能拖')
})

// ══════════════════════════════════════════════════════════════════════════
// [E] 缩略图跟行高联动
// ══════════════════════════════════════════════════════════════════════════

check('E1 ★★ 缩略图高度用 `calc(var(--row-h) …)`（行高拖大，图跟着变大）', () => {
  // 依琪：「可以调节高度展示出预览缩略图就够了」—— 图必须跟着变
  const seg = html.slice(html.indexOf('.pvtable .mini-thumb{'), html.indexOf('.pvtable .mini-thumb{') + 200)
  assert(/height:calc\(var\(--row-h/.test(seg),
    '★ 缩略图高度没跟行高联动：' + seg.split('}')[0])
})

check('E2 ★ 行高用 CSS 变量落到表格上（拖的时候只改变量，不重渲整个表）', () => {
  assert(/--row-h:' \+ rowH \+ 'px/.test(js) || js.indexOf('--row-h') >= 0, '没有 --row-h')
  const fn = js.slice(js.indexOf('function applyCols'), js.indexOf('function applyCols') + 800)
  assert(fn.indexOf('--row-h') >= 0, 'applyCols 没设 --row-h')
})

check('E3 ★ 缩略图 lazy 加载（447 行里有图的那批不该一次性全下载）', () => {
  assert(/class="mini-thumb"[^>]*loading="lazy"/.test(js) || /loading="lazy"[^>]*mini-thumb/.test(js),
    '★ 缩略图没 lazy —— 一次拉几十张大图')
})

check('E4 ★ 重画后必须重新应用列宽/行高（否则拖动后一重画就打回原型）', () => {
  const r = js.slice(js.indexOf('function render()'), js.indexOf('function render()') + 400)
  assert(r.indexOf('applyCols') >= 0,
    '★ render() 之后没同步列宽 —— 拖动结果会在下次重画时丢失')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
