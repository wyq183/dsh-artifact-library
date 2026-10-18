/**
 * 统一筛选层（多选）—— 侧栏与管理页共用这一份。
 * ══════════════════════════════════════════════════════════════════════════
 * 【背景】依琪 2026-10-19 定：多选走 **A 方案**（前端本地过滤，不改宿主契约）。
 *
 * 宿主 `store.list()` 是**单值相等**签名，没有 `kind[]`：
 *     list({ kind, artifact_type, project, tag, … })
 * ⇒ 多选只能在前端做：拉全量一次，之后零请求。
 *
 * 【为什么必须有这个文件】
 * 重做前两侧各写一套（侧栏 `RP_FILTERS` 3 个类型、管理页 `fKind`+`fType`
 * 2 个 + 57 个），同一个概念两种叫法、选项还不一致。
 * 今晚已经栽过一次同类问题：受管标签行内传对象、预览传数组 → 两套逻辑两种行为。
 * ⇒ 维度定义与判定**只能有一处**。
 *
 * ⚠️ 本文件的判据全部**行为级**（喂真形状的数据看返回），不扫源码文本。
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

console.log('\n═══ 统一筛选层（多选）═══')

// ── 载入（注入测试钩子）────────────────────────────────────────────────
const raw = fs.readFileSync(CLIENT, 'utf8')
const ANCHOR = 'exports.apply = apply;'
assert(raw.indexOf(ANCHOR) >= 0, '找不到注入锚点')
const HOOK = 'exports.__t = { rpMatchPicks: rpMatchPicks, rpPickOptions: rpPickOptions, rpNoPick: rpNoPick,'
  + ' rpPickCount: rpPickCount, rpTogglePick: rpTogglePick, RP_EMPTY_SELECT: RP_EMPTY_SELECT };\n    ' + ANCHOR
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
assert(T, '没拿到筛选层函数')

// ── 真形状测试数据（与 store.js 的记录形状一致）────────────────────────
const ITEMS = [
  { id: '1', kind: 'deliverable', artifact_type: 'document', project: '甲', tags: ['a', 'b'] },
  { id: '2', kind: 'deliverable', artifact_type: 'image', project: '甲', tags: ['b'] },
  { id: '3', kind: 'reference', artifact_type: 'document', project: '乙', tags: ['c'] },
  { id: '4', kind: 'reference', artifact_type: 'code', project: '', tags: [] },
]
const byIds = (sel) => ITEMS.filter((r) => T.rpMatchPicks(r, sel)).map((r) => r.id).join(',')

// ══════════════════════════════════════════════════════════════════════════
// [A] 空 = 不筛（最容易写反的地方）
// ══════════════════════════════════════════════════════════════════════════

check('A1 ★★ 空选择 ⇒ **全部通过**（不是"什么都不匹配"）', () => {
  // ⚠️ 把"没选"当成"选了空"是最常见的多选 bug：
  //    用户一进页面看到空白列表，还以为库坏了。
  assert(byIds(T.RP_EMPTY_SELECT) === '1,2,3,4', '空选择筛掉了东西：' + byIds(T.RP_EMPTY_SELECT))
})

check('A2 ★ null / undefined / 缺键 都按"不筛"办', () => {
  assert(byIds(null) === '1,2,3,4', 'null')
  assert(byIds(undefined) === '1,2,3,4', 'undefined')
  assert(byIds({}) === '1,2,3,4', '空对象')
  assert(byIds({ kind: [], tag: [], project: [], artifact_type: [] }) === '1,2,3,4', '全空数组')
})

check('A3 rpNoPick 判据', () => {
  assert(T.rpNoPick({ kind: [] }, 'kind') === true, '空数组应为 true')
  assert(T.rpNoPick({}, 'kind') === true, '缺键应为 true')
  assert(T.rpNoPick({ kind: ['x'] }, 'kind') === false, '有值应为 false')
  assert(T.rpNoPick(null, 'kind') === true, 'null 应为 true')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 维度内 OR
// ══════════════════════════════════════════════════════════════════════════

check('B1 ★★ 同一维度多值 = **OR**（产出 + 资料 = 全部）', () => {
  // 这是"多选"的核心语义。写成 AND 的话选两个类型会得到空列表。
  assert(byIds({ kind: ['deliverable', 'reference'] }) === '1,2,3,4', 'OR 不对：' + byIds({ kind: ['deliverable', 'reference'] }))
})

check('B2 单值筛选正确', () => {
  assert(byIds({ kind: ['deliverable'] }) === '1,2', 'deliverable：' + byIds({ kind: ['deliverable'] }))
  assert(byIds({ artifact_type: ['document'] }) === '1,3', 'document：' + byIds({ artifact_type: ['document'] }))
  assert(byIds({ project: ['甲'] }) === '1,2', '甲：' + byIds({ project: ['甲'] }))
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 维度间 AND
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★ 不同维度 = **AND**（kind=产出 且 tag=b）', () => {
  assert(byIds({ kind: ['deliverable'], tag: ['b'] }) === '1,2', 'AND 不对：' + byIds({ kind: ['deliverable'], tag: ['b'] }))
})

check('C2 ★★ 标签是**多值字段**：选 a+b = 带 a **或** 带 b', () => {
  // ⚠️ 与 kind/project（单值字段）不同：一条记录可以有多个标签，
  //    所以"选了 a 和 b"的意思通常是"我关心 a 或 b 的东西"，不是"同时有 a 和 b"。
  assert(byIds({ tag: ['a', 'b'] }) === '1,2', '标签 OR 不对：' + byIds({ tag: ['a', 'b'] }))
  // 反向对照：如果错写成"必须同时有"（数组包含全部），结果会是 1 而不是 1,2
  const both = ITEMS.filter((r) => ['a', 'b'].every((x) => r.tags.includes(x))).map((r) => r.id).join(',')
  assert(both === '1', '★ 对照数据不成立')
  assert(byIds({ tag: ['a', 'b'] }) !== both, '★ 标签当成了"必须同时有"—— 那是 AND，不是多选语义')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 选项生成
// ══════════════════════════════════════════════════════════════════════════

check('D1 ★ 选项带**计数**，且按计数降序', () => {
  const opts = T.rpPickOptions(ITEMS, 'tag')
  const map = {}
  opts.forEach((o) => { map[o.value] = o.count })
  assert(map.b === 2, 'b 应有 2 条，实际 ' + map.b)
  assert(map.a === 1 && map.c === 1, 'a/c 各 1 条')
  for (let i = 1; i < opts.length; i += 1) {
    assert(opts[i - 1].count >= opts[i].count, '没按计数降序')
  }
})

check('D2 ★ 空值不进选项（"未分类"不许混在真值里）', () => {
  const opts = T.rpPickOptions(ITEMS, 'project')
  const vals = opts.map((o) => o.value)
  assert(vals.indexOf('') < 0, '★ 空项目名进了选项')
  assert(vals.join(',') === '甲,乙', '项目选项：' + vals.join(','))
})

check('D3 ★ 标签展开成多条（不是一条"a,b"）', () => {
  const opts = T.rpPickOptions(ITEMS, 'tag')
  const vals = opts.map((o) => o.value).sort()
  assert(vals.join(',') === 'a,b,c', '标签选项：' + vals.join(','))
})

check('D4 畸形输入不抛', () => {
  assert(Array.isArray(T.rpPickOptions(null, 'tag')), 'null 应返回空数组')
  assert(Array.isArray(T.rpPickOptions([{ id: 'x' }], 'tag')), '缺 tags 应返回空数组')
  assert(T.rpPickOptions([null, undefined, {}], 'project').length === 0, '全空应返回 []')
})

// ══════════════════════════════════════════════════════════════════════════
// [E] 状态操作（不许原地改 —— React 靠引用比较）
// ══════════════════════════════════════════════════════════════════════════

check('E1 ★★ rpTogglePick 返回**新对象**，不改原来的', () => {
  // ⚠️ 原地 mutate 会让 React 认为"没变化"，界面不更新（多选点了没反应）。
  const a = { kind: [], tag: [], project: [], artifact_type: [] }
  const b = T.rpTogglePick(a, 'kind', 'deliverable')
  assert(a.kind.length === 0, '★ 原对象被改了')
  assert(b.kind.length === 1, '新对象没加上')
  assert(b !== a, '返回了同一个引用')
})

check('E2 再点一次 = 取消选中', () => {
  const a = T.rpTogglePick(T.RP_EMPTY_SELECT, 'tag', 'x')
  const b = T.rpTogglePick(a, 'tag', 'x')
  assert(b.tag.length === 0, '没取消：' + JSON.stringify(b.tag))
})

check('E3 ★ 只改指定维度，别的维度原样保留', () => {
  const a = { kind: ['deliverable'], tag: ['t1'], project: ['p'], artifact_type: ['document'] }
  const b = T.rpTogglePick(a, 'tag', 't2')
  assert(b.kind.join() === 'deliverable', 'kind 被改了')
  assert(b.project.join() === 'p', 'project 被改了')
  assert(b.artifact_type.join() === 'document', 'artifact_type 被改了')
  assert(b.tag.length === 2, 'tag 没加上')
})

check('E4 rpPickCount 全维度求和', () => {
  assert(T.rpPickCount(T.RP_EMPTY_SELECT) === 0, '空应为 0')
  assert(T.rpPickCount({ kind: ['a'], tag: ['x', 'y'], project: [], artifact_type: [] }) === 3, '应为 3')
  assert(T.rpPickCount(null) === 0, 'null 应为 0')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
