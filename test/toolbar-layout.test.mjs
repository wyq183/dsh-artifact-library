/**
 * 顶部菜单栏三层架构（2026-10-22 · 主人批评后重构）
 * ══════════════════════════════════════════════════════════════════════════
 * 【主人原话】
 *   「整个顶部菜单栏就设计不合理，大中小3个按钮明明常驻却只能改变卡片大小，
 *     而且卡片大小的改变，意义根本不大，win的文件管理是小中超大，一层一层
 *     方便你快速找到图片，你这个改变不仅小，而且并没有放大多少图片...
 *     顶部菜单栏等级分布过于零散，就是杂七杂八的堆砌，
 *     根本没有做好分类引导该有的清晰明了」
 *
 *   「精化直接做一个按钮就够了，把没精化的精化掉，
 *     当你勾选了单一文件或者多个文件再出现精炼所勾选文件的按钮」
 *
 *   「「项目」和「文件」「改动」其实是不同的数据源，不是同一种"视图"这个理解是对的」
 *
 * ══ 核心概念（本文件守的就是这个）══
 *   **分类（数据源）** ≠ **视图（呈现方式）**
 *     · 分类 = 产物/资料/项目/文件/改动  ← 看的是**不同的东西**
 *     · 视图 = 列表/卡片                  ← **同一个东西**的两种呈现
 *   原来混在一个 `state.view` 里，是概念错误。
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

console.log('\n═══ 顶部三层架构 ═══')

const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')

/** 剥注释（本项目注释里常写反例说明，不剥会假红）。 */
function deComment(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (x) => x.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
}

// ══════════════════════════════════════════════════════════════════════════
// [A] 第 1 层 header：不许再堆砌
// ══════════════════════════════════════════════════════════════════════════

check('A1 ★★★ header 直接子按钮 ≤ 2（原来 10 个平铺）', () => {
  // ⚠️ 主人：「就是杂七杂八的堆砌」
  const a = html.indexOf('<header>')
  const b = html.indexOf('</header>')
  assert(a > 0 && b > a, '找不到 header')
  const head = html.slice(a, b)
  // 只数 header 的**直接子级** button（moreMenu 里的不算）
  const beforeMenu = head.slice(0, head.indexOf('<div class="moremenu"'))
  const btns = (beforeMenu.match(/<button\b/g) || []).length
  assert(btns <= 2,
    '★ header 直接子按钮 ' + btns + ' 个（应 ≤ 2：登记 + ⋯）—— 又在堆砌')
})

check('A2 ★★★ 精化只保留**一个**入口（原来三个）', () => {
  // 主人：「精化直接做一个按钮就够了，把没精化的精化掉」
  // ⚠️ 三个入口：精化项目 / 精化文件夹 / 立即精炼
  const i = html.indexOf('<div class="moremenu"')
  const j = html.indexOf('</div>', html.indexOf('回收站', i))
  const menu = html.slice(i, j)
  // ⚠️ 要数**按钮**不是数文字：按钮文案"⚡ 精化未处理" + title"把还没精化的…"
  //    一个按钮里就出现两次"精化" —— 数文字会误判（这轮就假红过）。
  const refineBtns = (menu.match(/<button[^>]*>[^<]*精化[^<]*<\/button>/g) || []).length
  assert(refineBtns === 1,
    '★ 菜单里有 ' + refineBtns + ' 个"精化"按钮（应为 1）')
  // 三个旧函数不许再被按钮调用
  for (const fn of ['refineProject()', 'refineFolder()']) {
    assert(html.indexOf('onclick="' + fn) < 0,
      '★ ' + fn + ' 还有按钮入口 —— 应该合成一个')
  }
})

check('A3 ★★ 勾选后才出现「精化所选」（不是常驻）', () => {
  // 主人：「当你勾选了单一文件或者多个文件再出现精炼所勾选文件的按钮」
  // ⚠️ selBar 是 display:none，有勾选才 flex ⇒ 天然满足
  const i = html.indexOf('id="selBar"')
  assert(i > 0, '没有 selBar')
  const seg = html.slice(i, html.indexOf('</div>', i))
  assert(/refineSelected\(\)/.test(seg), '★ 勾选栏里没有「精化所选」')
  // 且它在 header 里**不**常驻
  const a = html.indexOf('<header>')
  const b = html.indexOf('</header>')
  assert(html.slice(a, b).indexOf('refineSelected') < 0,
    '★ 「精化所选」出现在 header 里 —— 应该只在勾选后出现')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 第 2 层：分类（数据源）—— 与视图分开
// ══════════════════════════════════════════════════════════════════════════

check('B1 ★★★ 分类条独立存在，且是 4 个（主人定稿）', () => {
  // 主人：「「项目」和「文件」「改动」其实是不同的数据源，不是同一种"视图"」
  assert(/class="catbar"/.test(html), '没有分类条')
  assert(/id="catBar"/.test(html), '分类条没有 id')
  // 主人：「全部产物、项目、最近改动、全盘搜索」
  for (const c of ['all', 'project', 'changes', 'files']) {
    assert(new RegExp('data-cat="' + c + '"').test(html),
      '★ 分类 ' + c + ' 不在分类条里')
  }
  // 主人：「资料已经在左侧不需要单独给一个了」
  assert(!/data-cat="ref"/.test(html),
    '★ 「资料」分类又回来了 —— 左侧目录树已经能筛，重复了')
})

check('B2 ★★★ 项目/文件/改动**不许**再作为视图出现', () => {
  // ⚠️ 这是概念错误的核心：它们是数据源，不是呈现方式
  for (const v of ['project', 'files', 'changes']) {
    assert(!new RegExp('data-v="' + v + '"').test(html),
      '★ ' + v + ' 又变回视图了 —— 它是分类')
  }
  // 视图只剩列表/卡片
  for (const v of ['list', 'card']) {
    assert(new RegExp('data-v="' + v + '"').test(html), '★ 视图 ' + v + ' 不见了')
  }
})

check('B3 ★★ state 必须拆成 cat + view（不是共用 view）', () => {
  const i = html.indexOf('state = {')
  const line = html.slice(i, html.indexOf('\n', i))
  assert(/cat:/.test(line), '★ state 里没有 cat')
  assert(/view:/.test(line), '★ state 里没有 view')
})

check('B4 ★★★ `setCat` 与 `setView` 必须是两个函数（语义不同）', () => {
  assert(/function setCat\(/.test(html), '没有 setCat')
  assert(/function setView\(/.test(html), '没有 setView')
  // ⚠️ setView 收到旧值（project/files/changes）要转成分类，不许静默失效
  const at = html.indexOf('function setView(')
  let j = at
  let d = 0
  let st = false
  while (j < html.length) {
    if (html[j] === '{') { d += 1; st = true }
    else if (html[j] === '}') { d -= 1; if (st && d === 0) break }
    j += 1
  }
  const body = deComment(html.slice(at, j + 1))
  assert(/setCat\(/.test(body),
    '★ setView 收到旧值（project/files/changes）没转成 setCat —— 会静默失效')
})

check('B6 ★★★ setCat 必须**真的 reload**（主人：「我点了资料右侧毫无变化」）', () => {
  // ⚠️ 真机 bug：ref 过滤写在 reload() 里，但 setCat 切分类时**只调了 render()**，
  //    没调 reload() ⇒ state.items 没被重新筛 ⇒ 列表纹丝不动。
  //    典型的"逻辑实现了但入口没接上"。
  const at = html.indexOf('function setCat(')
  assert(at > 0, '找不到 setCat')
  let j = at
  let d = 0
  let st = false
  while (j < html.length) {
    if (html[j] === '{') { d += 1; st = true }
    else if (html[j] === '}') { d -= 1; if (st && d === 0) break }
    j += 1
  }
  const body = deComment(html.slice(at, j + 1))
  assert(/reload\(\)/.test(body),
    '★ setCat 没调 reload() —— 切分类时列表不会变（真机就是这个）')
})

check('B5 ★★ render() 必须按 cat 分流数据源（不是 view）', () => {
  const r = html.indexOf('function render()')
  const nextFn = html.indexOf('\nfunction ', r + 20)
  const body = deComment(html.slice(r, nextFn > r ? nextFn : r + 4000))
  assert(/state\.cat === 'files'/.test(body), '★ render 没按 cat 分流 files')
  assert(/state\.cat === 'changes'/.test(body), '★ render 没按 cat 分流 changes')
  assert(!/state\.view === '(files|changes)'/.test(body),
    '★ render 还在按 view 分流数据源 —— 概念错误')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 第 3 层：卡片尺寸必须**真的**放大
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★★ 卡片尺寸四级（小/中/大/超大），照 Windows', () => {
  // 主人：「win的文件管理是小中超大，一层一层方便你快速找到图片」
  for (const v of ['s', 'm', 'l', 'xl']) {
    assert(new RegExp('data-card="' + v + '"').test(html), '★ 缺尺寸级别 ' + v)
  }
  assert(/id="cardXL"/.test(html), '★ 没有「超大」按钮')
})

check('C2 ★★★ 高度 + 列宽必须**一起**变（只改高度 = 没放大）', () => {
  // ⚠️ 我第一版只改 height，卡片宽度不变 ⇒ 列数不变 ⇒ "大"看起来还是那么大
  //    主人：「并没有放大多少图片」
  for (const v of ['s', 'm', 'l', 'xl']) {
    const re = new RegExp('body\\[data-card="' + v + '"\\] \\.cards\\{grid-template-columns')
    assert(re.test(html), '★ ' + v + ' 没改列宽（grid-template-columns）')
  }
})

check('C3 ★★★ 图标字号必须跟着尺寸变（否则大卡片里图标还是一小点）', () => {
  // ⚠️ 真机截图：超大卡片（400px 高）里那个视频图标只有中间一小点 ——
  //    因为 `.thumb .ico{font-size:34px}` 是**固定字号**，容器变大了它不变。
  //    这是"改了容器没改内容"的典型。
  for (const v of ['s', 'm', 'l', 'xl']) {
    const re = new RegExp('body\\[data-card="' + v + '"\\] \\.thumb \\.ico\\{font-size')
    assert(re.test(html), '★ ' + v + ' 没改图标字号')
  }
  // 且不许再有**不带 data-card 前缀**的固定字号。
  // ⚠️ 不能直接匹配 `.thumb .ico{font-size:Npx` —— 那会误伤
  //    `body[data-card="s"] .thumb .ico{font-size:28px}` 里的同名片段（这轮假红过）。
  //    正确判据：找出所有 .thumb .ico 规则，**排除**带 data-card 的，看还有没有固定 px。
  const icoRules = html.match(/\.thumb \.ico\{[^}]*\}/g) || []
  const fixedPx = icoRules.filter((r) => /font-size:\s*\d+px/.test(r))
  // 这些规则的**前 60 字符**里如果有 data-card 前缀，就是合法的分级规则
  const illegal = fixedPx.filter((r) => {
    const at = html.indexOf(r)
    const before = html.slice(Math.max(0, at - 60), at)
    return !/body\[data-card="(s|m|l|xl)"\]\s*$/.test(before)
  })
  assert(illegal.length === 0,
    '★ 还有**不带尺寸前缀**的固定字号：' + illegal.join(' / '))
})

check('C4 ★★ 尺寸只在卡片视图有意义（列表视图要灰掉/说明）', () => {
  // ⚠️ 主人批评：「大中小3个按钮明明常驻却只能改变卡片大小」
  //    原来在列表视图点了完全没反应。
  assert(/id="sizeGroup"/.test(html), '尺寸组没有 id（没法按视图灰掉）')
  const at = html.indexOf('function toggleDisp(')
  let j = at
  let d = 0
  let st = false
  while (j < html.length) {
    if (html[j] === '{') { d += 1; st = true }
    else if (html[j] === '}') { d -= 1; if (st && d === 0) break }
    j += 1
  }
  const body = deComment(html.slice(at, j + 1))
  assert(/state\.view === 'card'/.test(body),
    '★ 没判断视图 —— 列表视图下尺寸组还亮着，点了没反应')
  assert(/disabled/.test(body), '★ 没把尺寸组灰掉')
})

check('C5 ★★ 尺寸 + 密度收进「⚙ 显示」菜单（不常驻占位）', () => {
  assert(/id="dispMenu"/.test(html), '没有显示设置菜单')
  // 原来 5 个按钮（舒适/紧凑/小/中/大）常驻在 toolbar 里
  const tb = html.slice(html.indexOf('<div class="toolbar">'), html.indexOf('id="dispMenu"'))
  // ⚠️ 在 toolbar 里（dispMenu 之前）不该再有 denCozy/cardS 这些按钮
  assert(tb.indexOf('id="denCozy"') < 0,
    '★ 「舒适」还在 toolbar 里常驻 —— 应该收进显示菜单')
  assert(tb.indexOf('id="cardS"') < 0,
    '★ 「小」还在 toolbar 里常驻 —— 应该收进显示菜单')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 护栏
// ══════════════════════════════════════════════════════════════════════════

check('D1 ★★★ 内联 JS 语法合法（白屏护栏）', () => {
  const m = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(html)
  assert(m, '没有 script 块')
  try { new vm.Script(m[1], { filename: 'inline' }) }
  catch (e) { throw new Error('语法错：' + e.message) }
})

check('D2 ★★★ 不许有重复的函数定义（锚点重复的坑，我犯了 4 次）', () => {
  const fns = ['function toggleTrash(', 'function toggleMore(', 'function closeMenus(',
    'function setCat(', 'function setView(', 'function toggleDisp(', 'function setCardSize(',
    'function openNewFolder(', 'function deleteFolder(', 'function startPick(',
    'function cancelPick(', 'function confirmPick(', 'function pickFolder(',
    'function renderTree(', 'function treeNodeHtml(', 'function toggleSel(',
    'function toggleSelAll(', 'function updateSelBar(', 'function clearSel(',
    'function visibleItems(', 'function syncCatButtons(']
  for (const f of fns) {
    const c = html.split(f).length - 1
    assert(c === 1, '★ ' + f + ' 出现 ' + c + ' 次（重复定义）')
  }
})

check('D3 ★★ 弹出菜单必须能点外关闭（否则挡住下面还关不掉）', () => {
  const at = html.indexOf('function closeMenus(')
  assert(at > 0, '没有 closeMenus')
  // 必须有全局 click 监听调它
  assert(/document\.addEventListener\('click',[\s\S]{0,600}closeMenus\(\)/.test(html),
    '★ 没有点外关闭 —— 菜单会一直挡着')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
