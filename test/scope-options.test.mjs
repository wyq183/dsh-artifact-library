/**
 * 范围必须影响后面三个维度的选项（2026-10-20 依琪报的 bug）
 * ══════════════════════════════════════════════════════════════════════════
 * 【依琪的原话】
 *   「我发现侧边栏现在，你选择了当前会话或者当前工作区，
 *     不会同步影响到后面的类型项目标签的分类」
 *
 * 【根因】
 *   四个下拉的可选项都基于 `snap.items`（**全量**），完全没看 `scope`：
 *       var kindOptions = rpPickOptions(snap.items, "kind")   // ← 全库
 *   ⇒ 选「当前会话」（全库 447 条里只有几条属于本会话）之后，
 *     类型/项目/标签里仍列着**全库**的值。
 *     选一个"本会话没有的项目" ⇒ 必然空列表 ⇒ 看起来像库坏了。
 *
 * 【三层结构（本文件守的就是这个）】
 *   snap.items   ──(范围)──>  scopeItems  ──(多选)──>  wsItems
 *                                ↑
 *                          选项基于这一层
 *
 * ⚠️ 为什么选项**不能**基于 wsItems（最终结果）：
 *    选了 A 之后，A 之外的选项会全部消失 ⇒ 用户取消不掉自己的选择。
 *    这是多选筛选的经典陷阱。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../', import.meta.url))
const CLIENT = path.join(REPO, 'lib', 'client.js')

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

console.log('\n═══ 范围 → 选项联动 ═══')

const raw = fs.readFileSync(CLIENT, 'utf8')

// ── 载入（注入测试钩子）────────────────────────────────────────────────
const ANCHOR = 'exports.apply = apply;'
const HOOK = 'exports.__t = { rpPickOptions: rpPickOptions, rpWithPhantoms: rpWithPhantoms, rpMatchPicks: rpMatchPicks,'
  + ' rpInWorkspace: rpInWorkspace, rpNormPath: rpNormPath };\n    ' + ANCHOR
const src = raw.replace(ANCHOR, HOOK)

let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (d) => { captured = d } } },
  document: {
    baseURI: 'http://x/', querySelector: () => null, getElementById: () => null,
    createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }),
    head: { appendChild() {} }, documentElement: { appendChild() {} }, body: { style: {} },
    addEventListener() {}, removeEventListener() {},
  },
  console: { log() {}, error() {}, info() {}, warn() {} },
  setTimeout, clearTimeout, URL, Promise, Intl, Date, isFinite, isNaN, parseFloat, parseInt,
  encodeURIComponent, decodeURIComponent, JSON, Math, Number, String, Array, Object, RegExp, Error,
  navigator: {}, fetch: () => Promise.resolve({ ok: false, json: async () => ({}) }),
  location: { search: '', origin: 'http://x', href: 'http://x/' },
  localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(src, sandbox)

const react = {
  createElement: (t, p, ...c) => ({ t, p, c }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect() {}, useCallback: (f) => f, useRef: (v) => ({ current: v }), useMemo: (f) => f(),
}
const T = captured.factory((n) => (n === 'react' ? react : {})).__t
assert(T, '没拿到函数')

// ══════════════════════════════════════════════════════════════════════════
// [A] 三层结构必须存在，且选项基于中间层
// ══════════════════════════════════════════════════════════════════════════

check('A1 ★★ 有 `scopeItems`（范围筛过、多选未筛）这一层', () => {
  assert(raw.indexOf('var scopeItems = React.useMemo') > 0,
    '★ 没有 scopeItems —— 选项只能基于全量或最终结果，两种都错')
})

check('A2 ★★ 四个维度的选项**都**基于 scopeItems（不是 snap.items）', () => {
  for (const dim of ['kind', 'artifact_type', 'project', 'tag']) {
    assert(raw.indexOf('rpPickOptions(scopeItems, "' + dim + '")') > 0,
      '★ ' + dim + ' 的选项没基于 scopeItems')
  }
  // 反向：不许再出现"基于全量"
  assert(!/rpPickOptions\(snap\.status === "ready" \? snap\.items/.test(raw),
    '★ 还有选项基于全量 snap.items —— 换范围时它不会变（依琪报的 bug）')
})

check('A3 ★★ 选项**不许**基于 wsItems（否则选了 A 其他选项全消失）', () => {
  // 这条守的是多选筛选的经典陷阱：用户取消不掉自己的选择
  assert(!/rpPickOptions\(wsItems/.test(raw),
    '★ 选项基于 wsItems —— 选了 A 之后 A 之外的选项会消失，用户取消不掉')
})

check('A4 ★★ `wsItems` 复用 `scopeItems`（不重复算范围）', () => {
  // ⚠️ 两份范围判断必然漂移（今晚已经栽过两次同类：受管标签、fTag 形状）
  const i = raw.indexOf('var wsItems = React.useMemo')
  assert(i > 0, '找不到 wsItems')
  const seg = raw.slice(i, i + 1200)
  assert(seg.indexOf('var list = scopeItems') >= 0,
    '★ wsItems 没复用 scopeItems —— 它又自己算了一遍范围')
  assert(seg.indexOf('rpInWorkspace') < 0,
    '★ wsItems 里还在调 rpInWorkspace —— 范围判断重复了')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 行为：同样的数据，范围不同 ⇒ 选项不同
// ══════════════════════════════════════════════════════════════════════════

const ITEMS = [
  { id: '1', project: '甲', tags: ['a', 'b'], kind: 'deliverable', artifact_type: 'document', path: 'C:\\proj\\x.md', session_id: 'S1' },
  { id: '2', project: '甲', tags: ['b'], kind: 'deliverable', artifact_type: 'image', path: 'C:\\proj\\y.png', session_id: 'S1' },
  { id: '3', project: '乙', tags: ['c'], kind: 'reference', artifact_type: 'document', path: 'D:\\other\\z.md', session_id: 'S2' },
  { id: '4', project: '丙', tags: ['d'], kind: 'reference', artifact_type: 'code', path: 'D:\\other\\w.py', session_id: 'S2' },
]

/** 模拟 scope 过滤（与 scopeItems 里同口径）。 */
function scopeFilter(items, scope, ctx) {
  if (scope === 'session') {
    return items.filter((r) => !r.session_id || String(r.session_id) === String(ctx.sessionId))
  }
  if (scope === 'workspace') {
    return items.filter((r) => T.rpInWorkspace(r, ctx))
  }
  return items
}

check('B1 ★★ 会话范围 ⇒ 选项只含本会话的值', () => {
  const scoped = scopeFilter(ITEMS, 'session', { sessionId: 'S1', cwd: '' })
  const projects = T.rpPickOptions(scoped, 'project').map((o) => o.value)
  assert(projects.join(',') === '甲', '★ 会话 S1 的项目选项应为 [甲]，实际 [' + projects.join(',') + ']')
})

check('B2 ★★ 工作区范围 ⇒ 选项只含该目录下的值', () => {
  const scoped = scopeFilter(ITEMS, 'workspace', { sessionId: '', cwd: 'C:\\proj' })
  const projects = T.rpPickOptions(scoped, 'project').map((o) => o.value)
  assert(projects.join(',') === '甲', '★ C:\\proj 下的项目应为 [甲]，实际 [' + projects.join(',') + ']')
  const tags = T.rpPickOptions(scoped, 'tag').map((o) => o.value).sort()
  assert(tags.join(',') === 'a,b', '★ C:\\proj 下的标签应为 [a,b]，实际 [' + tags.join(',') + ']')
})

check('B3 ★★ 全部范围 ⇒ 选项含所有值（对照组）', () => {
  const scoped = scopeFilter(ITEMS, 'all', {})
  const projects = T.rpPickOptions(scoped, 'project').map((o) => o.value).sort()
  assert(projects.join(',') === '丙,乙,甲' || projects.join(',') === '甲,丙,乙' || projects.length === 3,
    '★ 全部范围应有 3 个项目，实际 [' + projects.join(',') + ']')
})

check('B4 ★★ 反向对照：用**全量**算出的选项，在会话范围下会多出别的值', () => {
  // 这条证明"选项必须基于 scopeItems"是**真的会**影响结果，
  // 不是我在满足一条形式上的断言。
  const all = T.rpPickOptions(ITEMS, 'project').map((o) => o.value)
  const scoped = T.rpPickOptions(scopeFilter(ITEMS, 'session', { sessionId: 'S1', cwd: '' }), 'project').map((o) => o.value)
  assert(all.length > scoped.length,
    '★ 对照组不成立：全量(' + all.length + ') 应多于会话范围(' + scoped.length + ')')
  assert(all.join(',') !== scoped.join(','), '★ 两者一样 —— 那这个 bug 根本不会出现')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 幽灵选中（切范围后已选值可能不在新范围里）
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★ 已选但当前范围没有的值，**必须补进选项**（否则取消不掉）', () => {
  // 场景：全库选了项目「乙」→ 切到会话 S1（没有乙）⇒
  //       乙 不在选项里 ⇒ 用户看不到它，但筛选还生效 ⇒ 结果永远空 ⇒ **被卡死**
  const scoped = scopeFilter(ITEMS, 'session', { sessionId: 'S1', cwd: '' })
  const opts = T.rpPickOptions(scoped, 'project')          // 只有「甲」
  const withGhost = T.rpWithPhantoms(opts, ['乙'])
  const vals = withGhost.map((o) => o.value)
  assert(vals.indexOf('乙') >= 0, '★ 幽灵值「乙」没补进选项 —— 用户取消不掉它')
})

check('C2 ★★ 幽灵项计数为 0 且带标记（让"这个范围里没有"可见）', () => {
  const withGhost = T.rpWithPhantoms([{ value: '甲', count: 2 }], ['乙'])
  const ghost = withGhost.filter((o) => o.value === '乙')[0]
  assert(ghost, '没补进来')
  assert(ghost.count === 0, '★ 幽灵项计数不是 0：' + ghost.count)
  assert(ghost.phantom === true, '★ 幽灵项没标 phantom —— 界面上没法区分')
})

check('C3 ★ 幽灵项排在最前（扎眼，用户一眼看到并去取消）', () => {
  const withGhost = T.rpWithPhantoms([{ value: '甲', count: 5 }], ['乙'])
  assert(withGhost[0].value === '乙', '★ 幽灵项没排最前：' + withGhost.map((o) => o.value).join(','))
})

check('C4 ★ 没有幽灵值时**原样返回**（不改变正常路径）', () => {
  const opts = [{ value: '甲', count: 2 }]
  const out = T.rpWithPhantoms(opts, ['甲'])
  assert(out === opts, '★ 没有幽灵值时也造了新数组（会破坏 memo 引用比较）')
  assert(T.rpWithPhantoms(opts, []).length === 1, '空选中时也不该变')
  assert(T.rpWithPhantoms(opts, null).length === 1, 'null 时也不该变')
})

check('C5 ★ 畸形输入不抛', () => {
  assert(Array.isArray(T.rpWithPhantoms(null, ['x'])), 'null options')
  assert(Array.isArray(T.rpWithPhantoms([], ['x'])), '空 options')
  assert(Array.isArray(T.rpWithPhantoms([{ value: 'a', count: 1 }], 'not-an-array')), '字符串 picked')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
