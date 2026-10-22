/**
 * 勾选可发现性 + 删除目录（2026-10-22）
 * ══════════════════════════════════════════════════════════════════════════
 * 【主人原话】
 *   ① 「可以添加，但是没有看到勾选功能，我都找不到，说明根本不够直观」
 *   ② 「资料库只能添加新目录如何删除？」
 *   ③ 「资料库删除目录需要2次确认」
 *
 * ══ 这轮守的三个真错 ══
 *   ① 勾选框**只在卡片视图**有，列表视图根本没有 ⇒ 用列表的人永远找不到
 *   ② `removeFolder` 只删"声明"，记录还在 ⇒ 目录照样出现在树里 ⇒ "删不掉"
 *   ③ 我插入代码时**锚点重复**（第二次犯了，第一次是 store.js 的 moveFolder）
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../', import.meta.url))

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

/**
 * 抠出一个函数的完整函数体（按大括号配平，跳过字符串/注释）。
 * ⚠️ 固定窗口 slice(at, at+N) 会在函数变长后**静默截断**，造成假红。
 */
function fnBodyOf(src, head) {
  const at = src.indexOf(head)
  if (at < 0) return ''
  let i = at
  let depth = 0
  let started = false
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i += 1
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i += 1; break }
        i += 1
      }
      continue
    }
    if (c === '{') { depth += 1; started = true }
    else if (c === '}') { depth -= 1; if (started && depth === 0) return src.slice(at, i + 1) }
    i += 1
  }
  return src.slice(at)
}

console.log('\n═══ 勾选可发现性 + 删除目录 ═══')

const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')
const storeJs = fs.readFileSync(path.join(REPO, 'lib', 'store.js'), 'utf8')

// ══════════════════════════════════════════════════════════════════════════
// [A] 勾选功能必须**在列表里也看得见**
// ══════════════════════════════════════════════════════════════════════════
//
// 【现场】主人用列表视图，完全找不到勾选 —— 因为勾选框只写在卡片视图的
//        `card-title` 里，`listHtml` 一行都没有。

check('A1 ★★★ 列表视图必须有勾选框（不能只在卡片视图有）', () => {
  const at = html.indexOf('function listHtml(r)')
  assert(at > 0, '找不到 listHtml')
  const body = html.slice(at, at + 1200)
  assert(/class="alf-sel"/.test(body),
    '★ listHtml 里没有勾选框 —— 用列表的人永远找不到（主人的原话）')
  assert(/toggleSel\(/.test(body),
    '★ 勾选框没绑 toggleSel —— 点了没反应')
})

check('A2 ★★★ 勾选框必须**常驻**，不许 hover 才出现', () => {
  // ⚠️ 主人已经明说"我都找不到" ⇒ hover 才出现 = 不知道它存在 = 永远找不到
  // 判据：CSS 里 `.pvsel` / `.selwrap` 的规则**不许**含 display:none 或 opacity:0
  const at = html.indexOf('.pvsel{')
  assert(at > 0, '没有 .pvsel 的 CSS')
  const seg = html.slice(at, at + 400)
  assert(!/display:\s*none/.test(seg), '★ .pvsel 默认 display:none —— 等于没有')
  assert(!/opacity:\s*0[;}]/.test(seg), '★ .pvsel 默认透明 —— 等于没有')
})

check('A3 ★★ 勾选格要**整格可点**（40px 列里小方块只有 16px）', () => {
  const at = html.indexOf('function listHtml(r)')
  const body = html.slice(at, at + 1200)
  assert(/class="selwrap"/.test(body),
    '★ 勾选框没包 label —— 点中率极低（"够不够直观"的关键细节）')
})

check('A4 ★★ 表头要有全选（否则勾 60 条要点 60 次）', () => {
  assert(/id="selAll"/.test(html), '没有全选框')
  assert(/function toggleSelAll\(/.test(html), '没有 toggleSelAll')
  const at = html.indexOf('function toggleSelAll(')
  const body = html.slice(at, at + 700)
  // ⚠️ 范围必须是 state.items（当前列表），不是 allItems（全库）
  assert(/state\.items/.test(body), '★ 全选没限定在当前列表 —— 会勾上没看见的条目')
  assert(!/state\.allItems/.test(body),
    '★ 全选用了 allItems（全库）—— 用户点全选只想勾眼前这些')
})

check('A5 ★★ 半选态必须用 JS 设（`indeterminate` 没有 HTML 属性）', () => {
  // ⚠️ 不能用固定窗口 `slice(at, at+800)` —— updateSelBar 变长后会被截断，
  //    误报"没设 indeterminate"（这轮就假红过）。改用按大括号配平的完整提取。
  const body = fnBodyOf(html, 'function updateSelBar(')
  assert(body, '找不到 updateSelBar')
  assert(/\.indeterminate\s*=/.test(body),
    '★ 没设 indeterminate —— 选了部分时全选框看着像"没选"')
})

check('A6 ★★ 选中行要整行高亮（勾了哪几条必须一眼看见）', () => {
  assert(/rowon/.test(html), '没有 rowon 类')
  const at = html.indexOf('function listHtml(r)')
  const body = html.slice(at, at + 1200)
  assert(/on \? 'rowon'/.test(body), '★ 行没有按选中态加 class')
  assert(/tr\.rowon\{/.test(html), '★ 没有 rowon 的 CSS')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 删除目录
// ══════════════════════════════════════════════════════════════════════════

check('B1 ★★★ 删目录必须**连记录一起处理**（只删声明 = 删不掉）', () => {
  // 【现场】主人：「资料库只能添加新目录如何删除？」
  // 【根因】目录 = 记录的 folder ∪ 声明。只删声明的话，目录里有记录 ⇒ 照样出现。
  const at = storeJs.indexOf('removeFolder(path) {')
  assert(at > 0, '找不到 removeFolder')
  const body = storeJs.slice(at, at + 2200)
  assert(/rewriteFolderPrefix/.test(body),
    '★ 没处理记录 —— 只删声明的话目录里有记录就删不掉（真机就是这个）')
  assert(/this\.items/.test(body), '★ 没遍历记录')
})

check('B2 ★★★ 记录要移到**父目录**，不是根（否则丢归类）', () => {
  const at = storeJs.indexOf('removeFolder(path) {')
  const body = storeJs.slice(at, at + 2200)
  // 必须算出 parent 并用它做目标
  assert(/const parent = segs\.join\('\/'\)/.test(body),
    '★ 没算父目录 —— 直接扔根会让用户一次误操作丢掉全部归类')
  assert(/rewriteFolderPrefix\(rec\.folder, p, parent\)/.test(body),
    '★ 移动目标不是 parent')
})

check('B3 ★★ 删父目录要连**子目录声明**一起删（否则留孤儿）', () => {
  const at = storeJs.indexOf('removeFolder(path) {')
  const body = storeJs.slice(at, at + 2200)
  assert(/indexOf\(p \+ '\/'\) === 0/.test(body),
    '★ 没匹配子目录 —— 删父目录后会留下孤儿声明')
})

check('B4 ★★ 记录**不许删**（删目录是整理结构，不是删东西）', () => {
  const at = storeJs.indexOf('removeFolder(path) {')
  const body = storeJs.slice(at, at + 2200)
  // 不许出现删除记录的调用
  assert(!/\.splice\(.*items|trash|delete this\.items|filter\(.*!==.*rec\)/.test(body),
    '★ removeFolder 里动了记录数组 —— 删目录不该删记录')
})

check('B5 ★★ 落盘失败要回滚（不留半改状态）', () => {
  const at = storeJs.indexOf('removeFolder(path) {')
  const body = storeJs.slice(at, at + 2200)
  assert(/catch \(error\)/.test(body), '没有 catch')
  assert(/t\.rec\.folder = t\.prev/.test(body) || /\.folder = t\.prev/.test(body),
    '★ 落盘失败没回滚记录 —— 会留下半改状态')
})

check('B6 ★★ 要能撤销（记录移回 + 声明恢复）', () => {
  assert(/undoFolderRemove\(/.test(storeJs), '没有 undoFolderRemove')
  assert(/folders\/remove-undo/.test(fs.readFileSync(path.join(REPO, 'lib', 'http.js'), 'utf8')),
    '没有 /folders/remove-undo 端点')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 两次确认（主人明确要求）
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★★ 删除必须**两次确认**', () => {
  // 主人：「资料库删除目录需要2次确认」
  const at = html.indexOf('async function deleteFolder(')
  assert(at > 0, '找不到 deleteFolder')
  const body = html.slice(at, at + 2600)
  const confirms = (body.match(/confirm\(/g) || []).length
  const prompts = (body.match(/prompt\(/g) || []).length
  assert(confirms >= 1, '★ 第一次确认（confirm）没有')
  assert(prompts >= 1, '★ 第二次确认（prompt 手打）没有')
})

check('C2 ★★★ 第二次确认必须是**另一种形式**（不能连点两次 confirm）', () => {
  // ⚠️ 同一个 confirm 连点两次 = 用户条件反射点确定 = 等于没有确认。
  //    必须换成"手打目录名"（GitHub 删仓库同套路）。
  const at = html.indexOf('async function deleteFolder(')
  const body = html.slice(at, at + 2600)
  assert(/第 2\/2 步/.test(body), '★ 第二次确认没标"第 2/2 步" —— 用户不知道还有一步')
  assert(/typed/.test(body) && /!== leaf/.test(body),
    '★ 第二次确认没做"输入比对" —— 那不是真确认')
})

check('C3 ★★ 第一次确认要说清后果（记录去哪了）', () => {
  const at = html.indexOf('async function deleteFolder(')
  const body = html.slice(at, at + 2600)
  assert(/记录本身不会删|记录不删/.test(body),
    '★ 没说"记录不会删" —— 用户以为会丢东西，不敢点')
  assert(/移到/.test(body), '★ 没说记录会移到哪')
})

check('C4 ★ 输入不匹配要明确取消（不是静默返回）', () => {
  const at = html.indexOf('async function deleteFolder(')
  const body = html.slice(at, at + 2600)
  assert(/toast\('取消删除/.test(body),
    '★ 输错时静默返回 —— 用户不知道发生了什么')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 我自己犯的错：插入代码时锚点重复
// ══════════════════════════════════════════════════════════════════════════

check('D1 ★★★ 不许有重复的函数定义（锚点重复会造出 `f() {f() {`）', () => {
  // ⚠️ 我**第二次**犯这个错（第一次是 store.js 的 moveFolder）：
  //    插入模板结尾带了锚点，外面又 slice 保留锚点 ⇒ 重复。
  //    `node --check` 只报 "Unexpected end of input"，定位极难。
  // ⚠️ 必须用 `函数名(` 精确匹配 —— `toggleSel` 是 `toggleSelAll` 的**前缀**，
  //    只按子串数会把后者误算成重复（第一次跑就假红了）。
  const fns = ['function openNewFolder(', 'function deleteFolder(', 'function renderTree(',
    'function treeNodeHtml(', 'function toggleSel(', 'function updateSelBar(',
    'function clearSel(', 'function pickFolder(']
  for (const f of fns) {
    const c = html.split(f).length - 1
    assert(c <= 1, '★ ' + f + ' 出现 ' + c + ' 次（重复定义）')
  }
})

check('D2 ★★ 内联 JS 必须语法合法（白屏护栏）', () => {
  const m = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(html)
  assert(m, '没有 script 块')
  try { new vm.Script(m[1], { filename: 'inline' }) }
  catch (e) { throw new Error('语法错：' + e.message) }
})

check('D3 ★★ 上一轮被我误删的三个函数必须还在', () => {
  // ⚠️ 我用 `indexOf('\\n}')` 找 updateSelBar 的结尾，但它是**单行**函数
  //    ⇒ 跳到很远 ⇒ 顺手删掉了三个函数。
  for (const f of ['function clearSel', 'function selectAllPending', 'async function refineSelected']) {
    assert(html.indexOf(f) >= 0, '★ 又丢了 ' + f)
  }
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
