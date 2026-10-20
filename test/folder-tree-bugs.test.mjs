import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../', import.meta.url))
const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')
const storeJs = fs.readFileSync(path.join(REPO, 'lib', 'store.js'), 'utf8')

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

console.log('\n═══ 目录树真机 bug 回归 ═══')

// ══════════════════════════════════════════════════════════════════════════
// bug ① 点「全部/未归类」没反应
// ══════════════════════════════════════════════════════════════════════════
//
// 【现场】依琪：「点「全部 / 未归类没有反应」
// 【实测】`pickFolder('__none__')` 确实生效（477 → 460），但高亮没变。
// 【根因】筛选用 `folder='' + folderUnfiled=true` 表达，
//        渲染却判 `folder === '__none__'` —— **两边各说各话**。

check('E1 ★★★ 「未归类」的判据必须与 pickFolder 一致（不许各写一套）', () => {
  // 找出 pickFolder 里怎么表达"未归类"
  const iP = html.indexOf('function pickFolder(')
  assert(iP > 0, '找不到 pickFolder')
  const bodyP = html.slice(iP, iP + 700)
  const setsUnfiled = /state\.folderUnfiled = true/.test(bodyP)
  assert(setsUnfiled, 'pickFolder 没设 folderUnfiled')

  // 渲染必须用**同一个判据**
  const iT = html.indexOf('const unrefOn =')
  assert(iT > 0, '找不到 unrefOn')
  const line = html.slice(iT, html.indexOf('\n', iT))
  assert(/state\.folderUnfiled/.test(line),
    '★ unrefOn 没看 folderUnfiled —— 会与 pickFolder 对不上（点了不亮）')
  assert(!/__none__/.test(line),
    '★ unrefOn 还在判 __none__ —— pickFolder 从不设这个值，永远不亮')
})

check('E2 ★★ 「全部」的判据要排除"未归类"（否则两个都亮）', () => {
  const iT = html.indexOf('const allOn =')
  assert(iT > 0, '找不到 allOn')
  const line = html.slice(iT, html.indexOf('\n', iT))
  assert(/folderUnfiled/.test(line),
    '★ allOn 没排除 folderUnfiled —— 选「未归类」时「全部」也会亮')
})

check('E3 ★★ state 必须真的有 folder / folderUnfiled 字段', () => {
  // ⚠️ 真机踩过：脚本提前退出导致这次修改丢了，字段不存在
  //    ⇒ `state.folder = ''` 只是加了个属性，但 `'folder' in state` 为 false 时
  //      依赖它的 memo/初始化逻辑会走错分支。
  const i = html.indexOf('state = {')
  const line = html.slice(i, html.indexOf('\n', i))
  assert(/folder:/.test(line), '★ state 里没有 folder 字段')
  assert(/folderUnfiled:/.test(line), '★ state 里没有 folderUnfiled 字段')
})

// ══════════════════════════════════════════════════════════════════════════
// bug ② 新建目录「输入后就没了」
// ══════════════════════════════════════════════════════════════════════════
//
// 【现场】依琪：「点「＋」新建目录 输入后就没了」
// 【根因】树是从记录**现算**的，空目录没有记录 ⇒ 算不出来。
//        我原来只往 localStorage 的"展开态"里塞了一下，**根本没落盘**。

check('F1 ★★★ 新建目录必须**真的落盘**（调 /folders/add）', () => {
  const i = html.indexOf('function openNewFolder(')
  assert(i > 0, '找不到 openNewFolder')
  const body = html.slice(i, i + 1600)
  assert(/folders\/add/.test(body),
    '★ 没调 /folders/add —— 只改 localStorage 的话刷新就没了（真机就是这个）')
  assert(/\.then\(/.test(body) || /await/.test(body),
    '★ 没等结果 —— 失败时用户不知道')
})

check('F2 ★★★ 服务端必须能把「空目录」补进树（否则建了也看不见）', () => {
  // ⚠️ 树从记录算，空目录 0 条 ⇒ 不补就永远不出现
  const i = storeJs.indexOf('export function buildFolderTree(')
  assert(i > 0, '找不到 buildFolderTree')
  const sig = storeJs.slice(i, storeJs.indexOf('\n', i))
  assert(/declared/.test(sig),
    '★ buildFolderTree 没有第二个参数 —— 空目录补不进来')

  const body = storeJs.slice(i, i + 2400)
  assert(/extra/.test(body), '没处理 declared')
  // ⚠️ 补进来的节点 count 必须是 0（那不是记录数）
  assert(/children: \{\}, count: 0/.test(body),
    '★ 空目录节点的 count 不是 0 —— 会显示成"有记录"')
})

check('F3 ★★ 空目录的行为级验证：declared 里的目录要出现在树里', () => {
  const mF = /export function buildFolderTree\(items, declared\) \{[\s\S]*?\n\}/.exec(storeJs)
  assert(mF, '抠不出 buildFolderTree')
  const mN = /export function normalizeFolder\(raw\) \{[\s\S]*?\n\}/.exec(storeJs)
  assert(mN, '抠不出 normalizeFolder')

  const box = { String, Array, Object, Math, RegExp }
  vm.createContext(box)
  vm.runInContext(
    mN[0].replace('export ', '') + '\n' + mF[0].replace('export ', '')
    + '\n;this.f=buildFolderTree;', box)

  // 只有 1 条记录在「工作」下，但声明了「工作/空目录」
  const r = box.f([{ folder: '工作' }], ['工作/空目录', '独立空目录'])
  const names = []
  ;(function walk(nodes, prefix) {
    for (const n of nodes) { names.push(prefix + n.name + ':' + n.count); walk(n.children || [], prefix + n.name + '/') }
  })(r.tree, '')

  assert(names.indexOf('工作:1') >= 0, '「工作」应在且 count=1，实际：' + names.join(' | '))
  assert(names.indexOf('工作/空目录:0') >= 0,
    '★ 声明的空目录没进树，实际：' + names.join(' | '))
  assert(names.indexOf('独立空目录:0') >= 0,
    '★ 顶层空目录没进树，实际：' + names.join(' | '))
})

check('F4 ★★ 新建目录后父级要自动展开（否则新目录藏在折叠的父目录里）', () => {
  const i = html.indexOf('function openNewFolder(')
  const body = html.slice(i, i + 1800)
  // 应该把 full 的每一级前缀都加进展开集合
  assert(/parts\.slice\(0, i\)\.join/.test(body) || /split\('\/'\)/.test(body),
    '★ 没展开父级 —— 建在深层目录下的新目录会看不见')
})

// ══════════════════════════════════════════════════════════════════════════
// bug ③ CSRF（这一轮第一次真的调 POST 才暴露）
// ══════════════════════════════════════════════════════════════════════════

check('G1 ★★★ 写请求必须带 `x-dsh-artifacts: 1`（否则 403）', () => {
  // ⚠️ 宿主实测：`{"reason":"csrf-header-missing","hint":"写请求请带 x-dsh-artifacts: 1"}`
  //    ⇒ 所有写接口（登记/编辑/移动/精炼）都会 403。
  const i = html.indexOf('async function api(')
  assert(i > 0, '找不到 api()')
  const body = html.slice(i, i + 900)
  assert(/x-dsh-artifacts/.test(body),
    '★ api() 没带 x-dsh-artifacts 头 —— 所有写操作会 403')
})

check('G2 ★ 「移到目录」入口存在（建了目录得能放东西进去）', () => {
  assert(/function batchFolder/.test(html), '没有 batchFolder')
  assert(/batchFolder\(\)/.test(html), '没有调用入口（按钮）')
  const i = html.indexOf('function batchFolder(')
  const body = html.slice(i, i + 1600)
  assert(/folders\/set/.test(body), '★ batchFolder 没调 /folders/set')
  // ⚠️ 逐条失败要报出来，不能只报总数
  assert(/failed\.push/.test(body), '★ 没逐条记失败 —— 用户不知道哪几条没成功')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
