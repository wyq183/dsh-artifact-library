/**
 * 资料库目录树（2026-10-20 · 鲸鱼资料库方案 B · 内容管理）
 * ══════════════════════════════════════════════════════════════════════════
 * 依琪：「先做**内容管理**」，调研结论：460 条不需要虚拟化，插件零依赖
 * ⇒ 用 `<details>` + 三个补强（记住展开态 / 点目录筛列表 / 可折叠整栏）
 *
 * ══ 这条测试守的四个真错（都实际发生过）══
 *   ① **`buildFolderTree is not defined`**（HTTP 500）
 *      我在 http.js 里用了 buildFolderTree 但 import 是新加的，
 *      DSH 进程跑着旧模块 ⇒ 500。
 *      ⚠️ `node --check` 查不出、`node -e "import('./lib/http.js')"` 也查不出
 *         （新进程能加载）—— 只有真机请求会炸。
 *   ② **`normTag is not defined`**（上一轮）
 *   ③ 三角和名字混在一起 ⇒ 想看子目录一定会触发筛选
 *   ④ 「未归类」用空串表达 ⇒ 服务端当成"不筛"，永远筛不出东西
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

console.log('\n═══ 资料库目录树 ═══')

const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')
const httpJs = fs.readFileSync(path.join(REPO, 'lib', 'http.js'), 'utf8')
const storeJs = fs.readFileSync(path.join(REPO, 'lib', 'store.js'), 'utf8')

// ══════════════════════════════════════════════════════════════════════════
// [A] 服务端：符号必须 import 进来（守 500 那个错）
// ══════════════════════════════════════════════════════════════════════════

check('A1 ★★★ http.js 用到的 store 函数必须 import（否则真机 500）', () => {
  // ⚠️ 真机实测：`{"ok":false,"error":"buildFolderTree is not defined"}`
  //    `node --check` 通过、新进程 `import('./lib/http.js')` 也通过 ——
  //    但 DSH 进程跑着旧模块，新 import 没生效 ⇒ 只有真机请求会炸。
  const need = ['buildFolderTree']
  for (const fn of need) {
    assert(httpJs.indexOf(fn) >= 0, 'http.js 里没用到 ' + fn + '（测试过时了？）')
    // 必须在 import 语句里
    const importRe = new RegExp('import\\s*\\{[^}]*\\b' + fn + '\\b[^}]*\\}\\s*from\\s*[\'"]\\./store\\.js[\'"]')
    assert(importRe.test(httpJs),
      '★ http.js 用了 ' + fn + ' 但没从 ./store.js import —— 运行时会 ReferenceError（真机 500）')
  }
})

check('A2 ★★ store.js 必须 export 这些函数', () => {
  for (const fn of ['buildFolderTree', 'normalizeFolder', 'checkFolderMove', 'rewriteFolderPrefix']) {
    assert(new RegExp('export function ' + fn + '\\(').test(storeJs),
      '★ store.js 没 export ' + fn)
  }
})

check('A3 ★★ `/folders` 端点必须在 `GET :id` 之前（否则被当成产物 id）', () => {
  // ⚠️ 与 managed-tags / files 同一个坑：路由顺序错的话 id='folders' 会去查产物
  const iFolders = httpJs.indexOf("id === 'folders'")
  assert(iFolders > 0, '找不到 folders 端点')
  const iById = httpJs.indexOf("id === 'managed-tags'")
  assert(iById < 0 || iFolders > iById,
    '★ folders 端点放在了别的 GET 之前 —— 可能被 `GET :id` 抢先匹配')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 前端：树的结构
// ══════════════════════════════════════════════════════════════════════════

check('B1 ★★ 树必须真的接在页面上（不是只定义了函数）', () => {
  assert(/id="folderTree"/.test(html), '没有 #folderTree 容器')
  assert(/id="treebar"/.test(html), '没有 #treebar 侧栏')
  // ⚠️ 光有容器不算 —— 要证明 loadTree 被调用了
  assert(/loadTree\(\)/.test(html), 'loadTree 从没被调用')
  // 且要在 reload 之后刷（计数/选中态与列表一致）
  const iReload = html.indexOf('async function reload()')
  const seg = html.slice(iReload, iReload + 2000)
  assert(seg.indexOf('loadTree()') >= 0, '★ reload 之后没刷树 —— 计数会与列表不一致')
})

check('B2 ★★ 必须用 `<details>`（不引组件库 —— 460 条不需要虚拟化）', () => {
  assert(/<details class="' \+ cls/.test(html) || /'<details/.test(html), '没有用 <details>')
  assert(!/react-arborist|virtual.*tree|react-window/i.test(html),
    '★ 引了树组件库 —— 插件是零依赖的，460 条不需要虚拟化')
})

check('B3 ★★★ 三角和名字必须分开（点三角只展开，点名字才筛选）', () => {
  // ⚠️ 混在一起的话：想看子目录就一定会触发筛选（列表被换掉）
  const i = html.indexOf('const summary = t.closest')
  assert(i > 0, '找不到 summary 的点击处理')
  const seg = html.slice(i, i + 600)
  assert(/onTriangle/.test(seg), '★ 没判断"点的是不是三角"')
  assert(/if \(onTriangle\) return/.test(seg), '★ 三角区域没提前返回 —— 会同时触发筛选')
})

check('B4 ★★★ 「未归类」不能用空串表达（空串=不筛，永远筛不出东西）', () => {
  assert(/folderUnfiled/.test(html), '没有 folderUnfiled 这个开关')
  // 服务端语义：空 folder = 不筛
  assert(/if \(folder\) \{/.test(storeJs), 'store.list 的 folder 判据变了')
  // 前端：未归类必须走本地过滤
  assert(/if \(state\.folderUnfiled\)/.test(html),
    '★ 未归类没有本地过滤 —— 传空串会被当成"不筛"')
})

check('B5 ★★ 只传真目录（空串不许拼进 URL）', () => {
  assert(/if \(state\.folder\) p\.set\('folder', state\.folder\)/.test(html),
    '★ 无条件拼 folder —— 空串会被当成"筛空目录"')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 三个补强
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★ 展开态要持久化（刷新后保持）', () => {
  assert(/alf-tree-expanded/.test(html), '没有展开态的 storage key')
  assert(/function saveExpanded/.test(html), '没有 saveExpanded')
  // ⚠️ toggle 事件不冒泡 ⇒ 必须用捕获
  const i = html.indexOf("addEventListener('toggle'")
  assert(i > 0, '没有监听 toggle 事件')
  const seg = html.slice(i, i + 400)
  assert(/true\)/.test(seg), '★ toggle 监听没用捕获 —— <details> 的 toggle 不冒泡，收不到')
})

check('C2 ★★ 整栏可折叠（窄屏 / 专注列表）', () => {
  assert(/function toggleTree/.test(html), '没有 toggleTree')
  assert(/alf-tree-collapsed/.test(html), '没有收起态的 storage key')
  // ⚠️ 收起不能把**整栏** display:none —— 那样就没地方点回来了（死路）。
  //    ⚠️ 但 `.treebar.collapsed .treebody{display:none}` 是**对的**（内容收起），
  //       所以判据只看 `.treebar.collapsed{...}` 这一条规则本身。
  const i = html.indexOf('.treebar.collapsed{')
  assert(i > 0, '没有收起态 CSS')
  const rule = html.slice(i, html.indexOf('}', i) + 1)
  assert(!/display:\s*none/.test(rule),
    '★ 整栏 display:none —— 没有地方点回来了（死路）')
  // 收起后必须有**展开按钮**还看得见
  assert(/treeToggle/.test(html), '没有展开/收起按钮')
})

check('C3 ★ 布局：max-width 从 body 挪到 .layout（否则树被挤）', () => {
  const i = html.indexOf('body{background:var(--bg)')
  assert(i > 0, '找不到 body CSS')
  const seg = html.slice(i, i + 300)
  assert(!/max-width:1200px/.test(seg), '★ body 还有 max-width —— 树 + 列表挤在 1200px 里')
  assert(/\.layout\{[^}]*max-width/.test(html), '没有 .layout 的 max-width')
})

check('C4 ★ `#content` 的 id 不许改（render() 往它里面写）', () => {
  assert(/<main id="content">/.test(html), '★ #content 的 id 变了 —— render() 会全线崩')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 行为：树的数据结构与筛选语义
// ══════════════════════════════════════════════════════════════════════════

check('D1 ★★ 树的 count 必须含子孙（父节点显示"工作 (12)"要算上子目录）', () => {
  // ⚠️ 2026-10-20：签名加了第二个参数 `declared`（空目录名单），
  //    判据要跟上 —— 但守的不变量没变：**count 含子孙**。
  const m = /export function buildFolderTree\(items, declared\) \{[\s\S]*?\n\}/.exec(storeJs)
  assert(m, '抠不出 buildFolderTree（签名是否变了？）')
  const box = { String, Array, Object, Math, RegExp }
  vm.createContext(box)
  // 需要 normalizeFolder
  const nf = /export function normalizeFolder\(raw\) \{[\s\S]*?\n\}/.exec(storeJs)
  assert(nf, '抠不出 normalizeFolder')
  vm.runInContext(
    nf[0].replace('export ', '') + '\n' + m[0].replace('export ', '')
    + '\n;this.f=buildFolderTree;', box)
  const r = box.f([
    { folder: '工作' },
    { folder: '工作/蜜雪' },
    { folder: '工作/蜜雪' },
  ], [])
  const gz = r.tree.filter((n) => n.name === '工作')[0]
  assert(gz, '找不到「工作」节点')
  assert(gz.count === 3, '★ count=' + gz.count + '（应为 3：自己 1 + 子 2）')
})

check('D2 ★★ folder 筛选必须**含子目录**（点父目录要看到里面的东西）', () => {
  // ⚠️ 只用 `===` 的话点「工作」看不到「工作/蜜雪」里的记录
  const i = storeJs.indexOf('if (folder) {')
  assert(i > 0, '找不到 folder 筛选')
  const seg = storeJs.slice(i, i + 600)
  assert(/f === dir/.test(seg), '没有精确匹配')
  assert(/indexOf\(dir \+ '\/'\) === 0/.test(seg),
    '★ 没做前缀匹配 —— 点父目录看不到子目录里的记录')
})

check('D3 ★★ 前缀匹配不许误伤「工作2」（startsWith 陷阱）', () => {
  const i = storeJs.indexOf('if (folder) {')
  const seg = storeJs.slice(i, i + 600)
  // 必须是 `dir + '/'` 而不是裸 dir
  assert(/dir \+ '\/'/.test(seg),
    '★ 用了裸 startsWith(dir) —— 「工作2」会被算进「工作」')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
