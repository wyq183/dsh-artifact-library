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

// ══════════════════════════════════════════════════════════════════════════
// [B] 「添加资料」流程（主人纠正后的正确设计）
// ══════════════════════════════════════════════════════════════════════════
//
// 【主人原话】
//   「你的逻辑有大问题，一点都不合理，你怎么把列表默认进入多选模式，
//     正常逻辑应该是在资料库那边加一个增加资料按钮，
//     点击后可以选择右边主文件区域选择吗？」
//
// 【我原来错在哪】
//   ① 同一个点击有两种结果（点目录：有时筛选、有时移动）—— 用户无法预判
//   ② 勾选就自动进"投放模式"—— 隐式把列表变成多选状态
//   ③ 真正的入口（＋添加资料）根本不存在
//
// 【正确设计】
//   点「＋ 添加」→ 定目标 → 显式进入选择模式 → 右边勾 → [确认加入]

check('B0 ★★★ pickFolder 必须是**单一语义**（只筛选，不许因勾选而移动）', () => {
  // ⚠️ 这是主人否掉的错误设计，必须守死不许回潮。
  const body = deComment(fnBody(html, 'function pickFolder(path)'))
  assert(body, '找不到 pickFolder')
  assert(!/moveSelectedToFolder\(/.test(body),
    '★ pickFolder 又在"勾选就移动"了 —— 主人明确否掉了这个双语义')
  assert(!/state\.selected\.size\s*>\s*0/.test(body),
    '★ pickFolder 又按"有没有勾选"分支 —— 同一个点击不许有两种结果')
})

check('B1 ★★★ 树上必须有「＋ 添加」入口（显式，不是靠副作用）', () => {
  // ⚠️ 主人：入口要在**资料库那边**（树上），不是藏在顶部工具栏。
  const head = html.slice(html.indexOf('<div class="treehead">'), html.indexOf('<div class="treehead">') + 900)
  assert(/class="treebtn treeadd"/.test(head),
    '★ 树头部没有「＋ 添加」按钮')
  assert(/onclick="startPick\(\)"/.test(head),
    '★ 按钮没绑 startPick')
  assert(/添加/.test(head), '★ 按钮文案里没有"添加"')
})

check('B2 ★★★ 选择模式必须**显式进入**，且目标目录常驻可见', () => {
  assert(/function startPick\(/.test(html), '没有 startPick')
  assert(/id="pickBar"/.test(html), '没有选择模式状态条')
  const bar = html.slice(html.indexOf('id="pickBar"'), html.indexOf('id="pickBar"') + 700)
  assert(/id="pickTarget"/.test(bar),
    '★ 状态条没显示目标目录 —— 用户不知道在往哪加')
  assert(/id="pickCount"/.test(bar), '★ 没显示已选条数')
  assert(/cancelPick\(\)/.test(bar), '★ 没有取消入口')
})

check('B3 ★★★ 选择模式下树要锁住（避免误切目录把目标搞丢）', () => {
  // ⚠️ 目标是在进模式时定好的，中途点目录会让人以为"换目标了"
  const body = deComment(fnBody(html, "document.addEventListener('click', (e) =>"))
  assert(body, '找不到树的点击委托')
  assert(/isPicking\(\)/.test(body),
    '★ 事件委托没判断选择模式 —— 点目录会真的切走')
  assert(/return/.test(body), '★ 拦住之后没 return')
})

check('B4 ★★ 确认加入是**唯一出口**，且失败逐条报', () => {
  const body = deComment(fnBody(html, 'async function confirmPick('))
  assert(body, '找不到 confirmPick')
  assert(/folders\/set/.test(body), '★ 没调 /folders/set')
  assert(/failed\.push/.test(body), '★ 没逐条记失败')
  // ⚠️ 目标目录可能还不存在（用户手打的新名字）⇒ 要声明一下
  assert(/folders\/add/.test(body),
    '★ 没声明目标目录 —— 手打新目录名时它会因为"没有记录"而不出现在树里')
})

check('B5 ★★ 选择模式下普通批量操作栏要隐藏（语义冲突）', () => {
  const body = deComment(fnBody(html, 'function updateSelBar()'))
  assert(/isPicking\(\)/.test(body), '★ updateSelBar 没判断选择模式')
  assert(/n && !picking/.test(body),
    '★ 选择模式下还在显示普通批量操作栏 —— 勾选此刻只表示"要加入"')
})

check('B6 ★★ 旧的「投放模式」提示条必须删干净（那是错误设计的残留）', () => {
  assert(!/treedrop/.test(html),
    '★ 还有 treedrop（投放提示条）—— 那是被否掉的设计')
  assert(!/dropok/.test(html),
    '★ 还有 dropok（目录可放置虚线框）')
})

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
