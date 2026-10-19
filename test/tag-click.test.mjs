/**
 * 标签可点击（2026-10-19 · 依琪：「标签也应该可以点击，点击后就进入
 * 标签分类页里面全是有同标签的文件」）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【为什么这些判据值得存在】
 * 这轮**每一步都是真机截图逼出来的**，静态检查一条都没抓住：
 *   ① 标签是 `<span>`，根本没有点击处理      → 用户点不动
 *   ② `filterByTag` 的切视图条件写反了        → 筛选生效了但停在卡片视图，看不出变少
 *   ③ 列表视图**没有标签列**                  → 标签只在卡片视图有，列表里看不到
 *   ④ 标签列只给了 `max-width`                → 表格自动布局压到 158px，一行撑成 7 行
 * ⇒ 下面每一条都对应上面一个真机问题。
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

console.log('\n═══ 标签可点击 ═══')

const html = fs.readFileSync(PAGE, 'utf8')
const js = html

// 抠出内联 <script>（这是唯一能"真的执行"页面的方式）
const blocks = []
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
let m
while ((m = re.exec(html)) !== null) {
  if (/\bsrc\s*=/.test(m[1] || '')) continue
  blocks.push(m[2])
}
const JS = blocks.join('\n')

// ── A. 内联 JS 语法（白屏护栏）─────────────────────────────────────────
check('A1 ★★ 内联 JS 能通过语法解析（少一个反引号就白屏）', () => {
  // ⚠️ 2026-10-18 栽过：模板字符串少一个反引号 ⇒ 整页白屏，
  //    而 eslint 看不了 .html、`node --check` 也不管它。
  for (let i = 0; i < blocks.length; i += 1) {
    try { new vm.Script(blocks[i], { filename: 'inline' + i }) }
    catch (e) { throw new Error('第 ' + i + ' 块语法错：' + e.message) }
  }
})

// ── B. 标签真的可点 ────────────────────────────────────────────────────
check('B1 ★★ 标签用 `<button>`（不是 `<span onclick>`）——键盘可达', () => {
  // ⚠️ 用 span+onclick 的话：Tab 键到不了、读屏不认这是可操作元素。
  const seg = JS.slice(JS.indexOf('function tagChipsHtml'), JS.indexOf('function filterByTag'))
  assert(seg.indexOf('<button') >= 0, '★ 标签还是 span，键盘不可达')
  assert(/class="tagfree tagclick"/.test(seg), '★ 自由词标签没变成可点按钮')
})

check('B2 ★★ 受管标签与自由词**都要能点**（不许只有一个能点）', () => {
  const seg = JS.slice(JS.indexOf('function tagChipsHtml'), JS.indexOf('function filterByTag'))
  // ⚠️ 判据：**两个分支**（`if (!m)` 自由词 / 受管）都要输出带 tagclick 的按钮。
  //    第一版我用 `split('return `')` 数分支 —— 受管那条不是 return 而是模板拼接，
  //    所以数错了（假红）。改成分别断言两处的 class 串。
  assert(/class="tagfree tagclick"/.test(seg),
    '★ 自由词分支没带 tagclick')
  assert(/'tagchip tagclick'/.test(seg),
    '★ 受管分支没带 tagclick —— 用户会看到"有的标签能用有的不能用"（假规律）')
})
check('B3 ★★ 点标签必须 `stopPropagation`（否则会顺带打开详情）', () => {
  // 标签在卡片/行内部，而整张卡片可点（点它打开预览）
  const seg = JS.slice(JS.indexOf('function tagChipsHtml'), JS.indexOf('function filterByTag'))
  assert(seg.indexOf('stopPropagation') >= 0, '★ 没拦冒泡 —— 点标签会变成打开详情')
})

// ── C. filterByTag 的正确性 ────────────────────────────────────────────
check('C1 ★★ 点标签后**必须切到列表视图**（第一版条件写反了）', () => {
  // ⚠️ 第一版：`if (state.view !== 'list' && state.view !== 'card') state.view = 'list'`
  //    —— 等于把 card 排除，而**默认视图就是 card** ⇒ 这个"切列表"从来没生效。
  const fn = JS.slice(JS.indexOf('function filterByTag'), JS.indexOf('function filterByTag') + 1400)
  assert(fn.indexOf("state.view = 'list'") >= 0, '没有切列表视图')
  assert(!/!== 'card' &&/.test(fn), '★ 又把 card 排除在外了 —— 默认视图下永远不生效')
})

check('C2 ★ 标签不在下拉里时**临时补一个 option**（否则静默筛成"全部"）', () => {
  // `fTag.value = tag` 对不存在的 option 会静默失败（value 变空 ⇒ 筛成全部）
  const fn = JS.slice(JS.indexOf('function filterByTag'), JS.indexOf('function filterByTag') + 1400)
  assert(fn.indexOf('createElement(\'option\')') >= 0, '★ 没补 option —— 新标签点了会静默失效')
})

check('C3 ★ 复用 `fTag`，不另存一份"当前筛选"', () => {
  // 两份"当前筛选"迟早不一致（受管标签那次就是栽在这）
  const fn = JS.slice(JS.indexOf('function filterByTag'), JS.indexOf('function filterByTag') + 1400)
  assert(fn.indexOf("$('fTag')") >= 0, '★ 没复用 fTag')
})

// ── D. 列表视图要有标签列 ──────────────────────────────────────────────
check('D1 ★★ 列表视图**有标签列**（第一版只在卡片里有）', () => {
  // ⚠️ 2026-10-19 真机：列表视图的列是 产物/项目/星级/大小/时间/会话/操作
  //    ——**没有标签**，所以"标签可点"在列表里根本看不到。
  // ⚠️ 2026-10-19 第 3 步：表头从写死改成由 `COLS` 动态生成（为了可拖列宽）⇒
  //    不能再找 `<th>标签</th>` 字面量。判据改成：COLS 里有 tags 列 + 表头确实由它生成。
  assert(/key: 'tags', label: '标签'/.test(js), '★ COLS 里没有「标签」列')
  assert(/COLS\.map\(\(c, i\) =>\s*\n?\s*'<th class="pvth">'/.test(js),
    '★ 表头不是由 COLS 生成的')
  assert(/class="listtags"/.test(JS), '★ 行里没有标签格')
})

check('D2 ★★ 标签列给**明确 width**（`max-width` 不够 —— 表格会压窄它）', () => {
  // ⚠️ 真机：只写 `max-width:220px` 时表格自动布局把它压到 158px，
  //    于是每个标签被迫换行，一行撑成 7 行高。
  const css = html.slice(html.indexOf('.listtags{'), html.indexOf('.listtags{') + 120)
  assert(/\.listtags\{width:\d+px\}/.test(css),
    '★ 不是 width 而是 max-width（' + css.split('}')[0] + '）—— 表格会把它压窄')
})

check('D3 ★ 标签多时**换行**而不是溢出/撑爆', () => {
  const css = html.slice(html.indexOf('.listtags .tagchips{'), html.indexOf('.listtags .tagchips{') + 150)
  assert(css.indexOf('flex-wrap:wrap') >= 0, '★ 标签不换行 —— 会溢出格子')
})

// ── E. 筛选痕迹条（能看见"我筛了什么" + 能退出）────────────────────────
check('E1 ★★ 有筛选痕迹条（否则用户看不出自己在筛、也不知道怎么退出）', () => {
  assert(JS.indexOf('function renderFilterChips') >= 0, '★ 没有筛选痕迹条')
  assert(html.indexOf('id="filterBar"') >= 0, '没有 filterBar 容器')
})

check('E2 ★ 每一项能**单独取消**，且有多项时给「全部清除」', () => {
  assert(JS.indexOf('function clearOneFilter') >= 0, '没有单项取消')
  assert(JS.indexOf('function clearAllFilters') >= 0, '没有全部清除')
  // ⚠️ 单项取消只许清它自己 —— 切片要到**下一个函数**为止，
  //    第一版切到 `clearAllFilters` 的**函数名**处（不含函数体），
  //    结果把 clearAllFilters 的内容漏在窗口外了（假红）。
  const a = JS.indexOf('function clearOneFilter')
  const b = JS.indexOf('function clearAllFilters', a)
  const fn = JS.slice(a, b > a ? b : a + 600)
  assert(fn.indexOf("'q'") >= 0, 'clearOneFilter 没处理搜索框（q）')
  assert(fn.indexOf('sel.value') >= 0, 'clearOneFilter 没清 select')
})
check('E3 ★ 痕迹条的数据**只从 DOM 读**，不另存 state', () => {
  // 两份"当前筛选"必然漂移（受管标签那次的根因）
  const fn = JS.slice(JS.indexOf('function renderFilterChips'), JS.indexOf('function clearOneFilter'))
  assert(fn.indexOf("$('fTag')") >= 0 || fn.indexOf("'fTag'") >= 0, '没从 DOM 读筛选值')
  assert(!/state\.filter/.test(fn), '★ 又存了一份 state.filter —— 会与 DOM 不一致')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
