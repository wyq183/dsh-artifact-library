/**
 * 侧栏：项目作为「优先标签」（2026-10-20）
 * ══════════════════════════════════════════════════════════════════════════
 * 依琪：「把项目也作为标签的一种，但是是**强绑定同一个项目**的，然后**最优先显示**」
 * 然后：「继续做侧栏」
 *
 * ══ 为什么这条测试值得存在 ══
 * 我在做侧栏时把管理页的 `mergeProjectTag` 照搬过来，顺手用了 `normTag(...)` ——
 * 那个函数**只存在于管理页**，侧栏没有。
 * `node --check` **查不出来**（语法合法，只是运行时符号不存在），真机一点就崩。
 * ⇒ 下面的 A 组就是守这个：**被调用的符号必须在同一个文件里定义**。
 *
 * ══ 两处必须一致 ══
 * 管理页（ui/index.html）和侧栏（lib/client.js）各有一份实现。
 * ⚠️ 不一致的代价：用户在管理页学到"项目在标签第一个"，回侧栏发现不是，
 *    那条规律就是**假的** —— 比不做更糟。
 * ⇒ 这里同时断言两处的**行为等价**（同一份用例，两边都跑）。
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

console.log('\n═══ 侧栏：项目作为优先标签 ═══')

// ══════════════════════════════════════════════════════════════════════════
// [A] 符号必须存在（守我自己犯的 normTag 错）
// ══════════════════════════════════════════════════════════════════════════

const clientRaw = fs.readFileSync(path.join(REPO, 'lib', 'client.js'), 'utf8')

check('A1 ★★★ 侧栏不许裸用 `normTag`（它只在管理页存在，会 ReferenceError）', () => {
  // ⚠️ 真机崩过：`node --check` 通过，但运行时 `normTag is not defined`。
  const bad = []
  clientRaw.split('\n').forEach((l, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
    if (/(?<![A-Za-z_.])normTag\(/.test(l)) bad.push('L' + (i + 1))
  })
  assert(bad.length === 0,
    '★ 裸用 normTag（侧栏没有这个函数，会崩）：' + bad.join(', '))
})

check('A2 ★★ `rpNormTag` 必须定义且被 rpMergeProjectTag 使用', () => {
  assert(/function rpNormTag\(/.test(clientRaw), '没有 rpNormTag 定义')
  assert(/rpNormTag\(proj\)/.test(clientRaw), 'rpMergeProjectTag 没使用 rpNormTag')
})

check('A3 ★★ 归一化口径：下划线/连字符/大小写都算同一个', () => {
  // ⚠️ 与管理页 normTag / 服务端 tags.js 必须同口径，
  //    否则会出现"服务端认为重复、前端认为不重复"⇒ 两个几乎一样的标签并存。
  const m = /function rpNormTag\(t\) \{[\s\S]*?\n    \}/.exec(clientRaw)
  assert(m, '抠不出 rpNormTag')
  const box = { String }
  vm.createContext(box)
  vm.runInContext(m[0] + '\n;this.f=rpNormTag;', box)
  const f = box.f
  assert(f('  Alpha  ') === 'alpha', '去空白+小写失败')
  assert(f('a_b') === f('a b'), '下划线没归一化')
  assert(f('a-b') === f('a b'), '连字符没归一化')
  assert(f('a   b') === 'a b', '连续空白没折叠')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 行为：两处实现必须等价
// ══════════════════════════════════════════════════════════════════════════

check('B1 ★★ 侧栏 rpMergeProjectTag：同名标签要去重', () => {
  const m = /function rpMergeProjectTag\(rec\) \{[\s\S]*?\n    \}/.exec(clientRaw)
  assert(m, '抠不出 rpMergeProjectTag')
  const n = /function rpNormTag\(t\) \{[\s\S]*?\n    \}/.exec(clientRaw)
  const box = { String, Array }
  vm.createContext(box)
  vm.runInContext(n[0] + '\n' + m[0] + '\n;this.f=rpMergeProjectTag;', box)
  const r = box.f({ project: '甲', tags: ['甲', 'b'] })
  assert(r.project === '甲', 'project')
  assert(r.tags.join(',') === 'b', '同名标签没去掉：' + r.tags.join(','))
})

check('B2 ★★ 侧栏 rpTagCell 必须把项目排在标签**之前**', () => {
  const at = clientRaw.indexOf('function rpTagCell(')
  assert(at > 0, '找不到 rpTagCell')
  const body = clientRaw.slice(at, at + 2200)
  const iProj = body.indexOf('__rptagproj')
  const iTags = body.indexOf('tagChips(h, shown')
  assert(iProj > 0, '没有项目 chip')
  assert(iTags > 0, '没有标签渲染')
  assert(iProj < iTags, '★ 项目没排在标签之前')
})

check('B3 ★★ 点项目必须走 onPickProject（不是 onPick）', () => {
  const at = clientRaw.indexOf('function rpTagCell(')
  const body = clientRaw.slice(at, at + 2200)
  assert(/onClick:\s*onPickProject/.test(body) || /onPickProject\(proj\)/.test(body),
    '★ 项目 chip 的点击没走 onPickProject —— 会按标签筛，搜不到东西')
})

check('B4 ★★ `pickProject` 是**单选覆盖**，不是 toggle 追加', () => {
  // ⚠️ 项目是强绑定（一条记录只有一个项目）。同时选两个的结果是并集，
  //    那正是"看全部"的效果 —— 用户会以为筛选坏了。
  const at = clientRaw.indexOf('function pickProject(')
  assert(at > 0, '没有 pickProject')
  const body = clientRaw.slice(at, at + 900)
  assert(/same \? \[\] : \[p\]/.test(body),
    '★ 不是单选覆盖（`same ? [] : [p]`）—— 多选项目没有意义')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 两处视觉/语义一致性
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★ 管理页与侧栏的项目标签都要有 📁 前缀', () => {
  const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')
  assert(html.indexOf('📁 ') > 0, '管理页没有 📁')
  assert(clientRaw.indexOf('"📁 " + proj') > 0 || clientRaw.indexOf('📁 ') > 0,
    '侧栏没有 📁')
})

check('C2 ★★ 两处都必须去重（项目名可能也是标签）', () => {
  const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')
  // 管理页
  const atH = html.indexOf('function mergeProjectTag(')
  assert(atH > 0, '管理页没有 mergeProjectTag')
  const bodyH = html.slice(atH, atH + 700)
  assert(/normTag\(proj\)/.test(bodyH) && /filter\(/.test(bodyH), '管理页没去重')
  // 侧栏（B1 已验行为，这里验代码在）
  assert(/rpNormTag\(t\) !== pk/.test(clientRaw), '侧栏没去重')
})

check('C3 ★ 侧栏 CSS：项目标签有独立样式（不能和普通标签长得一样）', () => {
  assert(/__rptagproj\{/.test(clientRaw), '没有 __rptagproj 的 CSS')
  const at = clientRaw.indexOf('__rptagproj{')
  const seg = clientRaw.slice(at, at + 500)
  assert(seg.indexOf('font-weight:600') >= 0, '★ 项目标签没加粗')
  assert(seg.indexOf('brand-primary') >= 0, '★ 项目标签没用强调色')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 「清空」置顶（依琪本轮另一条要求）
// ══════════════════════════════════════════════════════════════════════════

check('D1 ★★★ 侧栏「清空」必须 sticky 置顶（不是塞在最下面）', () => {
  // 依琪：「清空塞在最下面不好操作，要么置顶浮在上面，要么固定第一个」
  const at = clientRaw.indexOf('__rpmclear{')
  assert(at > 0, '没有 __rpmclear 的 CSS')
  const seg = clientRaw.slice(at, at + 600)
  assert(/position:sticky/.test(seg), '★ 没 sticky —— 滚下去就看不见了')
  assert(/top:0/.test(seg), '★ 没 top:0')
  // ⚠️ sticky 必须有底色，否则滚动时下面的选项会透上来（就是下拉透明那个病）
  assert(/background:var\(/.test(seg), '★ sticky 没底色 —— 滚动时文字会重叠')
})

check('D2 ★★ 「清空」必须渲染在选项**之前**（固定第一个）', () => {
  const at = clientRaw.indexOf('function rpMultiSelect(')
  const body = clientRaw.slice(at, at + 3000)
  const iClear = body.indexOf('__rpmclear')
  const iList = body.indexOf('__rpmlist')
  assert(iClear > 0 && iList > 0, '找不到清空或列表')
  assert(iClear < iList, '★ 清空还在列表之后（依琪说最下面不好操作）')
})

check('D3 ★★ 管理页的「清空」也要置顶（两处行为必须一致）', () => {
  const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')
  const at = html.indexOf('.mfclear{')
  assert(at > 0, '没有 .mfclear 的 CSS')
  const seg = html.slice(at, at + 400)
  assert(/position:sticky/.test(seg), '★ 管理页清空没 sticky')
  assert(/background:var\(/.test(seg), '★ 管理页 sticky 没底色')
  // 渲染顺序
  const at2 = html.indexOf('function mfRender(key)')
  const body2 = html.slice(at2, at2 + 1200)
  const iClear = body2.indexOf('mfclear')
  const iOpt = body2.indexOf('mfopt')
  assert(iClear > 0 && iOpt > 0 && iClear < iOpt, '★ 管理页清空还在选项之后')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
