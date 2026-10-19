/**
 * 「状态」快捷化 + 「已精炼」标签（2026-10-19）
 * ══════════════════════════════════════════════════════════════════════════
 * 依琪：「待精化/已精化也一样快捷化，**只有未处理筛选**，
 *        已处理打上**已经精炼标签**就可以」
 *
 * 【理解】
 *   · 不要三值下拉（全部/待精化/已精化）⇒ 换成一个**开关**：只看未精炼
 *   · 「已精炼」用**标签**表达（行上挂），不是靠筛选项
 *
 * ⚠️ 这轮真机踩到 2 个崩溃/错位，都是"改了一种元素但别处还在按老形状用它"：
 *   ① `loadMeta()` 给已删的 `<select>` 写 innerHTML → 空指针
 *   ② `renderFilterChips()` 对 hidden input 取 `.options[...]` → 崩
 *   ⇒ 下面的 A 组就是守这个模式。
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

console.log('\n═══ 状态快捷化 + 已精炼标签 ═══')

const html = fs.readFileSync(PAGE, 'utf8')
const m = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(html)
const scriptRaw = m ? m[1] : ''

/**
 * 剥掉注释（只留代码）。
 * ⚠️ 必须有：我的注释里会写"不许用 `rfSel.options[...]`"这种**反例说明**，
 *    不剥的话断言会把自己的注释抓成违规（假红 —— 这轮就踩了）。
 * ⚠️ 块注释要换成**等量换行**，否则后面按行数的断言会错位。
 */
function deComment(src) {
  return src
    // 块注释 → 换成等量换行（保持行号不错位）
    .replace(/\/\*[\s\S]*?\*\//g, (x) => x.replace(/[^\n]/g, ''))
    // ⚠️ 只剥**行首的** //（缩进后紧跟 //）——
    //    宽松版会把代码里的 `a / b` 或正则字面量当成注释开头，
    //    剥完源码就不是合法 JS 了（这轮踩过：D1 报 "Invalid regular expression"）。
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
}
const js = deComment(scriptRaw)

// ══════════════════════════════════════════════════════════════════════════
// [A] 元素形状变了之后的连锁引用（真机崩过两次）
// ══════════════════════════════════════════════════════════════════════════

check('A1 ★★ `fRefine` 是 hidden input ⇒ 不许再取 `.options[...]`', () => {
  // ⚠️ 真机报 `Cannot read properties of undefined (reading 'undefined')`：
  //    hidden input 没有 `.options` ⇒ `rfSel.options[...]` 是 undefined ⇒ 崩。
  assert(/<input type="hidden" id="fRefine"/.test(html), 'fRefine 不是 hidden input 了')
  assert(!/rfSel\.options\[/.test(js), '★ 还在对 hidden input 取 .options —— 会崩')
  assert(js.indexOf("$('fRefine').value === '1'") >= 0,
    '★ 没改成读 .value === 1')
})

check('A2 ★★ 不许再给已删的 `<select>` 写 innerHTML / 读 `.value`', () => {
  for (const id of ['fKind', 'fProject', 'fType', 'fTag']) {
    assert(!new RegExp("\\$\\('" + id + "'\\)\\.innerHTML").test(js),
      '★ 还在给 ' + id + ' 写 innerHTML')
    assert(!new RegExp("\\$\\('" + id + "'\\)\\.value").test(js),
      '★ 还在读 ' + id + '.value（已改成多选，没有 .value）')
  }
})

check('A3 ★ `hasFilter` 用 `mfCount()` 而不是读不存在的 select', () => {
  const seg = js.slice(js.indexOf('const hasFilter'), js.indexOf('const hasFilter') + 300)
  assert(seg.indexOf('mfCount()') >= 0, '★ hasFilter 没读多选状态')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 开关本身
// ══════════════════════════════════════════════════════════════════════════

check('B1 ★★ 三值下拉已删，改成单个开关', () => {
  assert(!/<option value="1">待精化<\/option>/.test(html), '★ 还是三值下拉')
  assert(/id="btnUnrefined"/.test(html), '没有开关按钮')
})

check('B2 ★★ 开关映射到服务端 `refine=1`（不改契约）', () => {
  const fn = js.slice(js.indexOf('function toggleUnrefined'), js.indexOf('function syncUnrefinedBtn'))
  assert(fn.indexOf("el.value = on ? '1' : ''") >= 0, '★ 没映射到 refine=1')
  const rl = js.slice(js.indexOf('async function reload()'), js.indexOf('async function reload()') + 1600)
  assert(/p\.set\('refine', rf\)/.test(rl), '★ reload 没把 refine 拼进请求')
})

check('B3 ★★ 开关必须同步 `aria-pressed`（读屏靠它知道状态）', () => {
  const fn = js.slice(js.indexOf('function toggleUnrefined'), js.indexOf('function syncUnrefinedBtn') + 600)
  assert(fn.indexOf('aria-pressed') >= 0, '★ 没同步 aria-pressed')
})

check('B4 ★ 清筛选后按钮态要跟上（否则看着还开着）', () => {
  assert(js.indexOf('syncUnrefinedBtn') >= 0, '没有 syncUnrefinedBtn')
  // 至少有一处"清完之后调用它"
  const clearSeg = js.slice(js.indexOf('function clearAllFilters'), js.indexOf('function clearAllFilters') + 600)
  assert(clearSeg.indexOf('syncUnrefinedBtn') >= 0,
    '★ clearAllFilters 后没同步按钮态')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 「已精炼」标签
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★ 已精炼的挂标签，未精炼的**留白**（依琪的原话）', () => {
  const fn = js.slice(js.indexOf('function refineBadge'), js.indexOf('function refineBadge') + 400)
  assert(/if \(r\.needsRefine\) return ''/.test(fn), '★ 未精炼的也打标签了')
  assert(/已精炼/.test(fn), '★ 没有「已精炼」文案')
})

check('C2 ★★ 标签**必须挂在行上**（不是只定义了函数没调用）', () => {
  // ⚠️ 光有 refineBadge 不算 —— 要证明 listHtml 里真的调了它
  const seg = js.slice(js.indexOf('function listHtml'), js.indexOf('function listHtml') + 900)
  assert(seg.indexOf('refineBadge(r)') >= 0, '★ listHtml 没调用 refineBadge')
})

check('C3 ★★ 标签要**退到背景**（实测 424/448 是已精炼，满屏都是）', () => {
  // ⚠️ 这是我这轮自己的错：注释写着"只标少数"，代码却给多数标了。
  //    依琪的要求（已处理打标签）是对的 ⇒ 不能不做，只能**让它不抢眼**：
  //    无边框、muted 色、11px。
  const seg = html.slice(html.indexOf('.refined{'), html.indexOf('.refined{') + 300)
  assert(seg.indexOf('color:var(--dim)') >= 0, '★ 标签用了正文色 —— 会抢标题')
  assert(seg.indexOf('border') < 0, '★ 标签有边框 —— 一排小盒子，抢注意力')
  assert(/font-size:11px/.test(seg), '★ 标签字号不是 11px')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 语法护栏
// ══════════════════════════════════════════════════════════════════════════

check('D1 ★★ 内联 JS 能过语法解析（白屏护栏）', () => {
  try { new vm.Script(js, { filename: 'inline' }) }
  catch (e) { throw new Error('语法错：' + e.message) }
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
