/**
 * 网页版管理页（`ui/index.html`）的结构与语法守卫
 * ══════════════════════════════════════════════════════════════════════════
 * 【2026-10-14 建 · 起因是档 1d 把面板能力搬进网页版】
 *
 * 依琪拍板「主区面板不要了，全部转到右侧栏」+「**允许你做成网页版本展示全部内容**」
 * ⇒ 原来长在面板上的能力（文件浏览 / 文件搜索 / 会话改动 / 标签芯片）
 *   **搬进了 `ui/index.html`**。
 *
 * ⚠️ 这份文件存在的**直接原因**是一个真踩到的坑：
 *
 *    我在模板字符串里嵌套 `<code>` 时**漏了闭合的反引号** ⇒
 *    `SyntaxError: Invalid or unexpected token` ⇒ **整个 `<script>` 不执行**
 *    ⇒ 页面看起来只是"内容区空白"，很容易被当成"还在加载"。
 *
 *    **`eslint` 看不到它**（`.html` 里的 JS 不在 lint 范围），
 *    **`node --check` 也看不到**（那要先把 JS 抽出来）。
 *    ⇒ 所以这里做三件事：**抽出来做语法检查** + **结构断言** + **反向对照**。
 *
 * ⚠️ 判据纪律（本仓库反复栽的）：
 *   · 断言必须**能咬住**坏版本（每条带反向对照或前提自检）
 *   · 「有某段代码」不算数，要**具体到哪个符号/哪一行**
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../', import.meta.url))
const UI_PATH = path.join(REPO, 'ui', 'index.html')

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

console.log('\n═══ 网页版管理页（ui/index.html）═══')
console.log(' 被测：' + UI_PATH)

const html = fs.readFileSync(UI_PATH, 'utf8')

/** 抽出全部 `<script>` 块。 */
function scriptsOf(src) {
  return [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}
const SCRIPTS = scriptsOf(html)

// ══════════════════════════════════════════════════════════════════════════
// [A] 语法：每个 `<script>` 都必须能过 `vm.Script`（= 真的能被浏览器解析）
// ══════════════════════════════════════════════════════════════════════════
check('A1 页面至少有一个 `<script>` 块', () => {
  assert(SCRIPTS.length >= 1, '一个 script 都没有 —— 页面不会有任何交互')
})

check('★★ A2 每个 `<script>` 都**语法合法**（否则整块不执行、页面看起来只是空白）', () => {
  SCRIPTS.forEach((js, i) => {
    try {
      // 用 vm.Script 编译（不执行）—— 与浏览器同一个解析器行为
      new vm.Script(js) // eslint-disable-line no-new -- 只为解析，不求值
    } catch (error) {
      // ⚠️ `cause` 必须带上：原始 `SyntaxError` 里才有**行列号**，
      //    丢掉它就只能看到我们包装的这句话，等于把最有用的信息扔了。
      throw new Error('script #' + i + ' 语法错：' + (error && error.message ? error.message : error)
        + '\n     ⇒ 这个错误在浏览器里是 `SyntaxError`，**整块 script 不执行**，'
        + '页面只显示空白，很容易被误当成"还在加载"。', { cause: error });
    }
  })
})

check('★ A3 反向对照：故意造一个语法错 → A2 的判据必须红', () => {
  // 复刻我真实踩到的那个错：模板字符串里漏了闭合反引号
  const GOOD = 'const x = `<div>${a ? \'y\' : \'z\'}</div>`'
  const BAD = 'const x = `<div>${a ? \'y\' : \'z\'}</div>'
  assert(scriptsOf('<script>' + GOOD + '</script>').length === 1, '对照前提失效：抽不出 script')
  let threw = false
  try { new vm.Script(BAD) } catch { threw = true }
  assert(threw, '★ 漏闭合反引号的版本居然能过语法检查 ⇒ A2 是空转的')
  let goodOk = true
  try { new vm.Script(GOOD) } catch { goodOk = false }
  assert(goodOk, '★ 正确的版本反而过不了 ⇒ 对照不成立')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 结构：档 1d 搬过来的四块能力必须**真的在页面上**
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── [B] 档 1d 搬过来的能力 ──')

check('B1 两个新视图按钮在（文件 / 改动）', () => {
  assert(/data-v="files"/.test(html), '没有「文件」视图按钮')
  assert(/data-v="changes"/.test(html), '没有「改动」视图按钮')
  // 旧的三个也还在（没被误删）
  for (const v of ['list', 'card', 'project']) {
    assert(new RegExp('data-v="' + v + '"').test(html), '原有视图按钮 ' + v + ' 不见了')
  }
})

check('B2 `render()` 必须在「空库」兜底**之前**分流两个新视图', () => {
  // ⚠️ 这是**顺序**断言：文件/改动视图不吃 `state.items`，
  //    若排在空库兜底之后，空库时它们永远显示"库是空的"。
  const r = html.indexOf('function render()')
  assert(r > 0, '找不到 render()')
  const body = html.slice(r, r + 900)
  const filesAt = body.indexOf("state.view === 'files'")
  const emptyAt = body.indexOf('if (!state.items.length)')
  assert(filesAt > 0, 'render() 里没有 files 分支')
  assert(emptyAt > 0, 'render() 里没有空库兜底（判据前提失效）')
  assert(filesAt < emptyAt,
    '★ 文件视图的分流排在空库兜底**之后** —— 空库时它会显示"库是空的"（永远进不去）')
  const chAt = body.indexOf("state.view === 'changes'")
  assert(chAt > 0 && chAt < emptyAt, '★ 改动视图同样必须在空库兜底之前')
})

check('B3 文件视图的两个数据源都在（浏览 + 搜索）', () => {
  assert(/\/files\/list\?dir=/.test(html), '没有走 `/files/list`（目录浏览）')
  assert(/\/files\?q=/.test(html), '没有走 `/files`（Everything 语法搜索）')
  assert(/encodeURIComponent\(dir\)/.test(html), '★ 目录路径没编码 —— 中文/空格目录会拼出坏 URL')
})

check('B4 改动视图走 `?recent=1`，且**标明它是派生的**', () => {
  assert(/session-changes\?recent=1/.test(html), '没有走 `/session-changes?recent=1`')
  // ⚠️ 宿主没有「当前会话」这个概念 ⇒ 界面**不许**把它说成"当前会话"
  assert(/最近一次改动公告/.test(html),
    '★ 没有把 `?recent=1` 的结果标成「最近一次改动公告」—— 会被误读成"当前会话的改动"（宿主没这个概念）')
  assert(/不是"当前会话"/.test(html), '★ 没有明确否认"这是当前会话"')
})

check('B5 改动视图把「还没观察到」与「真失败」分开（不是同一句兜底）', () => {
  assert(/nothing-observed/.test(html),
    '★ 没有单独处理 404 nothing-observed —— 那会让「还没观察到公告」看起来像"出错"')
  assert(/这不是错误/.test(html), '★ 没有告诉用户「还没观察到」不是错误')
})

check('B6 标签芯片真的接在卡片上，且走受管表', () => {
  assert(/tagChipsHtml\(r\.tags\)/.test(html), '卡片上没有调用 tagChipsHtml —— 组件写了没接上')
  assert(/\/managed-tags/.test(html), '没有拉受管标签表 —— 所有标签都会是素文本')
  assert(/function normTag\(/.test(html), '没有归一化函数 —— 受管表里的大小写/分隔符差异会对不上')
})

check('B7 受管表加载完必须**重渲染**（否则首屏全是素文本）', () => {
  // ⚠️ 真机踩到过：`loadManagedTags()` 与 `reload()` 并行，
  //    加载完时首屏已经画完了 ⇒ TAGCHIPS=0 / TAGFREE=273（数据对，只是没重画）。
  const at = html.indexOf('async function loadManagedTags()')
  assert(at > 0, '找不到 loadManagedTags()')
  const body = html.slice(at, at + 700)
  assert(/\brender\(\)/.test(body),
    '★ `loadManagedTags()` 结束后没有调 `render()` —— 首屏标签会全是素文本（真机踩过）')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 安全：用户可控内容必须转义
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── [C] 转义 ──')

check('C1 路径 / 文件名进 innerHTML 时必须过 `esc()`', () => {
  // ⚠️ 探针要对着**真实写法**写：本轮两处都用局部变量 `p`（`const p = f.path || f.file || ''`）
  //    ⇒ 写成 `esc(f.path)` 会**假红**（我第一版就是这么错的）。
  //    所以钉「这几个局部变量的渲染点」，而不是"某个变量名"。
  for (const probe of [
    'title="${esc(p)}">${esc(p)}',        // 文件搜索 / 改动视图的路径列
    '${esc(e.name)}',                      // 目录浏览的名称列
    'esc(p).replace(/\'/g',                // onclick 里的路径（还要额外转义引号）
  ]) {
    assert(html.indexOf(probe) >= 0,
      '★ 新增视图里找不到转义写法：' + probe + ' —— 路径没转义就是 XSS')
  }
  // 反向：这两块里**不许**出现未转义的直接插值
  const risky = /<(?:td|span)[^>]*>\$\{(?:p|e\.name)\}/.test(html)
  assert(!risky, '★ 有地方直接把 `p` / `e.name` 插进 HTML 而没过 `esc()`')
})

check('★ C2 反向对照：`esc()` 真的会转义尖括号（不是空转的函数）', () => {
  // 把 esc 的实现抠出来单独跑一遍
  const m = /const esc = \(s\) =>([\s\S]*?)\n/.exec(html)
  assert(m, '找不到 esc 的实现')
  const esc = new Function('s', 'return (s) =>' + m[1])(null)
  assert(esc('<img onerror=x>').indexOf('<') < 0, '★ `esc()` 没转义 `<` —— 那是真的 XSS')
  assert(esc('a"b').indexOf('"') < 0 || esc('a"b').indexOf('&quot;') >= 0, '★ `esc()` 没转义双引号')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
