/**
 * 「勾选 → 进资料库」的完整链路（2026-10-22）
 * ══════════════════════════════════════════════════════════════════════════
 * 【主人三连问，都是可发现性问题】
 *   ① 「没有看到勾选功能，我都找不到，说明根本不够直观」
 *   ② 「资料库只能添加新目录如何删除？」
 *   ③ 「选择了咋进资料库我也没看到」
 *
 * ══ 这三条的共同点 ══
 * **功能都有，但用户找不到。** 这不是缺功能，是可发现性失败。
 * ⇒ 测试要守的不是"代码里有这个函数"，而是"**用户能看见它**"。
 *
 * ══ 本轮实测踩到的三个真问题 ══
 *   ① 勾选后**行不高亮**（rowon=0）—— toggleSel 只改了 state，没改 DOM
 *   ② 全选勾了 **469 条**但只显示 60 行 —— 口径不一致（state.items vs visible）
 *   ③ 树「全部 486」vs 标题「共 469 件」—— 口径不一致（含回收站 vs 不含）
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

console.log('\n═══ 勾选 → 进资料库 ═══')

const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')
const httpJs = fs.readFileSync(path.join(REPO, 'lib', 'http.js'), 'utf8')

/**
 * 剥掉注释（只留代码）。
 *
 * ⚠️ 必须做：本项目的注释里经常写**反例说明**
 *    （例如 "但也不能整页 render()"、"用 state.items 会勾 469 条"），
 *    不剥的话断言会把自己的注释抓成违规 —— 这轮 A2/A3 就假红过。
 */
function deComment(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (x) => x.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
}

/** 抠出一个函数的**完整函数体**（按大括号配平，跳过字符串/注释/模板）。 */
function fnBody(src, head) {
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

// ══════════════════════════════════════════════════════════════════════════
// [A] 勾选要**看得见**（主人的第 ① 条）
// ══════════════════════════════════════════════════════════════════════════

check('A1 ★★★ 列表里有勾选框，且**常驻**（不许 hover 才出现）', () => {
  const at = html.indexOf('function listHtml(r)')
  assert(at > 0, '找不到 listHtml')
  const body = html.slice(at, at + 1400)
  assert(/class="alf-sel"/.test(body), '★ listHtml 里没有勾选框')
  const css = html.slice(html.indexOf('.pvsel{'), html.indexOf('.pvsel{') + 300)
  assert(!/display:\s*none/.test(css) && !/opacity:\s*0[;}]/.test(css),
    '★ 勾选列默认隐藏 —— 主人已经说"我都找不到"')
})

check('A2 ★★★ 勾选后**行必须高亮**（真机实测 rowon=0）', () => {
  // ⚠️ toggleSel 原来只改 state，不碰 DOM ⇒ 勾了看不出选中。
  const at = html.indexOf('function toggleSel(id, on)')
  assert(at > 0, '找不到 toggleSel')
  // ⚠️ 窗口要**截到函数结束**（不能固定 900 字符 —— 会把后面的函数算进来，假红）
  // ⚠️ 且要**剥注释**：注释里写着 "不能整页 render()" 是反例说明，不剥会假红。
  const body = deComment(fnBody(html, 'function toggleSel(id, on)'))
  assert(/classList\.toggle\('rowon'/.test(body),
    '★ toggleSel 没改行的 class —— 勾了行不高亮（真机就是这个）')
  // ⚠️ 也不能整页 render()（会丢焦点、闪）
  assert(!/\brender\(\)/.test(body),
    '★ toggleSel 调了整页 render —— 会丢焦点/闪一下')
})

check('A3 ★★★ 全选只勾**看得见的**（真机实测 469 vs 60）', () => {
  const body = deComment(fnBody(html, 'function toggleSelAll(on)'))
  assert(body, '找不到 toggleSelAll')
  assert(/visibleItems\(\)/.test(body),
    '★ 全选没用 visibleItems —— 会勾上屏幕上看不见的条目（真机 469 vs 60）')
  // 把 visibleItems() 替换掉再查 state.items（排除它内部那一次）
  const stripped = body.replace(/visibleItems\(\)/g, '')
  assert(!/state\.items\b/.test(stripped),
    '★ 全选还在用 state.items（全量）')
})

check('A4 ★★ 有 `visibleItems()` 这个唯一口径（渲染和全选共用）', () => {
  assert(/function visibleItems\(\)/.test(html), '没有 visibleItems')
  // render 里也要用它
  assert(/const visible = visibleItems\(\)/.test(html),
    '★ render 没用 visibleItems —— 与全选口径会漂移')
})

check('A5 ★★ render 之后要重设全选框状态（新 DOM 会丢 checked）', () => {
  // ⚠️ 真机实测：全选后 sel=60/rowon=60 都对，但 `checked=false` ——
  //    updateSelBar 设的是**旧节点**，render 新建了 DOM。
  const at = html.indexOf('function render()')
  assert(at > 0, '找不到 render')
  // render 函数体里要有 updateSelBar
  const body = html.slice(at, at + 12000)
  assert(/updateSelBar\(\)/.test(body),
    '★ render 末尾没调 updateSelBar —— 全选框会丢勾态')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 「勾选后怎么进资料库」（主人的第 ③ 条）
// ══════════════════════════════════════════════════════════════════════════

check('B1 ★★★ 勾选后点目录 = **移进去**（不是筛选）', () => {
  // 主人：「选择了咋进资料库我也没看到」
  const at = html.indexOf('function pickFolder(path)')
  assert(at > 0, '找不到 pickFolder')
  const body = html.slice(at, at + 1200)
  assert(/state\.selected\.size > 0/.test(body),
    '★ pickFolder 没判断"有没有勾选" —— 勾了也只会筛选')
  assert(/moveSelectedToFolder\(/.test(body),
    '★ 勾选后没走移动逻辑')
})

check('B2 ★★★ 树上必须有**投放提示条**（不能只藏在顶部按钮里）', () => {
  // ⚠️ 主人就是在顶部按钮那里找不到的。提示必须放在**他要操作的地方**（树上）。
  const at = html.indexOf('function renderTree(')
  assert(at > 0, '找不到 renderTree')
  const body = html.slice(at, at + 2400)
  assert(/treedrop/.test(body), '★ 树上没有投放提示条')
  assert(/点下面的目录移进去|treedrophint/.test(body),
    '★ 提示条没说"点目录移进去" —— 用户不知道下一步做什么')
  assert(/取消选择/.test(body), '★ 提示条没有退出入口')
})

check('B3 ★★ 可放置的目录要有视觉暗示（虚线框）', () => {
  assert(/dropok/.test(html), '没有 dropok 类')
  const at = html.indexOf('.treenode.dropok')
  assert(at > 0, '没有 dropok 的 CSS')
  const seg = html.slice(at, at + 300)
  assert(/dashed/.test(seg), '★ 没有虚线框 —— 用户不知道"这里能放"')
})

check('B4 ★★ 移动前要**一次**确认（说清 N 条 → 哪）', () => {
  const at = html.indexOf('async function moveSelectedToFolder(')
  assert(at > 0, '找不到 moveSelectedToFolder')
  const body = html.slice(at, at + 1800)
  assert(/confirm\(/.test(body), '★ 没有确认 —— 批量改归属不该无提示')
  assert(/ids\.length/.test(body) && /label/.test(body),
    '★ 确认文案没说清"几条 → 哪里"')
})

check('B5 ★★ 勾选状态变了，树要跟着刷新（否则提示条不出现）', () => {
  const at = html.indexOf('function toggleSel(id, on)')
  const body = html.slice(at, at + 900)
  assert(/loadTree\(\)/.test(body),
    '★ 勾选后没刷树 —— 投放提示条不会出现（那正是主人卡住的地方）')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 数字口径必须一致（真机截图暴露）
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★★ 树的总数必须与列表**同口径**（真机 486 vs 469）', () => {
  // ⚠️ 截图证据：标题「共 469 件」，树里「全部 486」—— 差 17 条（回收站）。
  //    两个数对不上，用户会以为树在骗人。
  const at = httpJs.indexOf("id === 'folders'")
  assert(at > 0, '找不到 folders 端点')
  const body = httpJs.slice(at, at + 700)
  assert(!/status:\s*'all'/.test(body),
    '★ /folders 用了 status:all（含回收站）—— 与列表口径不一致')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 删除目录（主人的第 ② 条）+ 两次确认
// ══════════════════════════════════════════════════════════════════════════

check('D1 ★★★ 删除按钮**常驻**（不是 hover 才出现）', () => {
  const at = html.indexOf('function treeNodeHtml(')
  assert(at > 0, '找不到 treeNodeHtml')
  const body = html.slice(at, at + 1400)
  assert(/class="treedel"/.test(body), '★ 目录上没有删除按钮')
  // ⚠️ 常驻但可以淡（opacity 不是 0）
  const css = html.slice(html.indexOf('.treedel{'), html.indexOf('.treedel{') + 400)
  assert(!/opacity:\s*0[;}]/.test(css),
    '★ 删除按钮默认透明 —— 等于不存在')
})

check('D2 ★★★ 删除要**两次确认**，且第二次换形式', () => {
  const at = html.indexOf('async function deleteFolder(')
  assert(at > 0, '找不到 deleteFolder')
  const body = html.slice(at, at + 3000)
  assert(/confirm\(/.test(body), '★ 第一次确认没有')
  assert(/prompt\(/.test(body), '★ 第二次确认（手打）没有 —— 连点两次 confirm 等于没有确认')
  assert(/第 2\/2 步/.test(body), '★ 没标"第 2/2 步"')
  assert(/!== leaf/.test(body), '★ 没做输入比对')
})

check('D3 ★★ 删除要说清"记录不删、移到哪"', () => {
  const at = html.indexOf('async function deleteFolder(')
  const body = html.slice(at, at + 3000)
  assert(/记录本身不会删|记录不删/.test(body), '★ 没说记录不会删')
  assert(/移到/.test(body), '★ 没说记录会移到哪')
})

// ══════════════════════════════════════════════════════════════════════════
// [E] 语法护栏
// ══════════════════════════════════════════════════════════════════════════

check('E1 ★★★ 内联 JS 语法合法（白屏护栏）', () => {
  const m = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(html)
  assert(m, '没有 script 块')
  try { new vm.Script(m[1], { filename: 'inline' }) }
  catch (e) { throw new Error('语法错：' + e.message) }
})

check('E2 ★★★ 不许有重复的函数定义（锚点重复的坑）', () => {
  // ⚠️ 我这轮**第二次**犯：插入模板结尾带了锚点，外面又保留 ⇒ `f() {f() {`
  const fns = ['function openNewFolder(', 'function deleteFolder(', 'function renderTree(',
    'function treeNodeHtml(', 'function toggleSel(', 'function updateSelBar(',
    'function clearSel(', 'function pickFolder(', 'function visibleItems(',
    'function moveSelectedToFolder(']
  for (const f of fns) {
    const c = html.split(f).length - 1
    assert(c <= 1, '★ ' + f + ' 出现 ' + c + ' 次')
  }
})

check('E3 ★★ 之前误删的三个函数还在', () => {
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
