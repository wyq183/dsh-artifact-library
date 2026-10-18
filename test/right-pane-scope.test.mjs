/**
 * 右栏「快捷面板」的接线守卫（2026-10-18 · 档 B）
 * ══════════════════════════════════════════════════════════════════════════
 * 这一档给右栏加了四样东西，每样都有**一个会静默坏掉**的地方：
 *
 *   ① **「仅看此工作区」复选框** —— 若 `rpInWorkspace` 在拿不到 cwd 时返回
 *      `false`（而不是 `true`），整个列表会**突然空掉**，用户以为东西丢了。
 *      这是本条最要紧的一条。
 *   ② **`当前/总数` 徽章** —— 只有复选框没有计数，勾上发现只剩 3 条会以为 bug。
 *   ③ **搜索防抖** —— `typed` 若直接进依赖数组，每敲一个字发一次请求。
 *   ④ **截断明说** —— `slice(0, 200)` 若不配一句说明，就是静默截断。
 *
 * ⚠️ 判据纪律：每条都要能**咬住坏版本**（带反向对照或"前提自检"）。
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../', import.meta.url))
const CLIENT = path.join(REPO, 'lib', 'client.js')
const SRC = fs.readFileSync(CLIENT, 'utf8')

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

console.log('\n═══ 右栏快捷面板接线（档 B）═══')

// ══════════════════════════════════════════════════════════════════════════
// [A] 纯函数 `rpInWorkspace` / `rpNormPath` —— **真的跑**，不是扫文本
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── [A] 工作区判定（行为级）──')

/** 把 client.js 里那几个纯函数抠出来求值。 */
function loadPure() {
  const from = SRC.indexOf('function rpNormPath(')
  // ⚠️ 锚点必须跟着**实际排在 rpInWorkspace 之后**的那段走。
  //    2026-10-18 晚在中间插了 `RP_SCOPES` / `RP_FILTERS` / `RP_SORTS`，
  //    原来锚的「筛选芯片」注释已经不存在了 ⇒ 第一版报「抠不出结尾」。
  const to = SRC.indexOf('/** 单次最多渲染多少行')
  assert(from > 0, '抠不出 rpNormPath —— 函数改名了？')
  assert(to > from, '抠不出 rpInWorkspace 的结尾 —— 后面那段锚点变了？')
  const code = SRC.slice(from, to)
  const box = { String, RegExp, Object, Array }
  box.globalThis = box
  vm.createContext(box)
  vm.runInContext(code + '\n;this.rpNormPath=rpNormPath;this.rpInWorkspace=rpInWorkspace;', box)
  return box
}
const P = loadPure()

check('A1 路径归一化：斜杠 / 尾部斜杠 / 盘符大小写都归一', () => {
  assert(P.rpNormPath('C:\\a\\b\\') === 'c:/a/b', P.rpNormPath('C:\\a\\b\\'))
  assert(P.rpNormPath('c:/a/b') === 'c:/a/b', P.rpNormPath('c:/a/b'))
  assert(P.rpNormPath('D:/x') === 'd:/x', P.rpNormPath('D:/x'))
})

check('A2 会话命中：同一次会话登记的算"当前工作区"', () => {
  assert(P.rpInWorkspace({ session_id: 's-1', path: 'D:\\other\\a.md' }, { sessionId: 's-1' }) === true,
    '同会话没被判为命中')
})

check('A3 路径命中：cwd 之下算命中（含 cwd 本身）', () => {
  assert(P.rpInWorkspace({ path: 'C:\\proj\\src\\a.md' }, { cwd: 'C:\\proj' }) === true, '子路径没命中')
  assert(P.rpInWorkspace({ path: 'C:\\proj' }, { cwd: 'C:\\proj' }) === true, 'cwd 本身没命中')
})

check('A4 ★★ 拿不到 cwd / sessionId ⇒ **放行**（宁可多显示，不可误杀）', () => {
  // ⚠️ 这条是整个档 B 最要紧的一条判据。
  //    若返回 false，整个列表会**突然空掉** —— 用户以为产物丢了。
  assert(P.rpInWorkspace({ path: 'C:\\a\\x.md' }, {}) === true, '★ 上下文为空时没放行 —— 整个列表会空掉')
  assert(P.rpInWorkspace({ path: 'C:\\a\\x.md' }, { cwd: '' }) === true, 'cwd 空串时没放行')
  assert(P.rpInWorkspace({ path: 'C:\\a\\x.md' }, null) === true, 'ws 为 null 时没放行')
})

check('A5 ★ 不误杀兄弟目录（`proj` 不许命中 `proj2`）', () => {
  // 与 `store.js` 的 `inScopeDir` 同一个坑：裸 startsWith 会把 proj2 判进 proj
  assert(P.rpInWorkspace({ path: 'C:\\work\\proj2\\a.md' }, { cwd: 'C:\\work\\proj' }) === false,
    '★ 前缀匹配没加分隔符 ⇒ 兄弟目录被误判命中')
})

check('A6 反向对照：把「拿不到就返回 false」的错实现跑一遍，它必须**误杀**', () => {
  // 证明 A4 不是空转
  const WRONG = (rec, ws) => {
    if (!ws || (!ws.cwd && !ws.sessionId)) return false // ← 错在这里
    return true
  }
  assert(WRONG({ path: 'C:\\a\\x.md' }, {}) === false, '对照前提失效')
  assert(WRONG({ path: 'C:\\a\\x.md' }, {}) !== P.rpInWorkspace({ path: 'C:\\a\\x.md' }, {}),
    '★ 正确实现与错实现结果相同 ⇒ A4 没咬住')
})

check('A7 ★ 归一化等价类：正斜杠 / 盘符大小写 / 尾斜杠 ⇒ 同一结果', () => {
  // ⚠️ 这三条是**真库上量过的**（2026-10-18，445 条）：
  //    `C:\…\dsh学` 与 `C:/…/dsh学` 与 `c:\…\dsh学` 三种写法都是 **29 条**。
  //    不一致就说明归一化漏了一路 —— 而那一路正是 `store.js` 的 `inScopeDir` 踩过的坑。
  const rec = { path: 'C:\\Users\\A\\Documents\\proj\\a.md' }
  assert(P.rpInWorkspace(rec, { cwd: 'C:\\Users\\A\\Documents\\proj' }) === true, '基准用例没命中')
  assert(P.rpInWorkspace(rec, { cwd: 'C:/Users/A/Documents/proj' }) === true, '正斜杠没归一')
  assert(P.rpInWorkspace(rec, { cwd: 'c:\\Users\\A\\Documents\\proj' }) === true, '盘符大小写没归一')
  assert(P.rpInWorkspace(rec, { cwd: 'C:\\Users\\A\\Documents\\proj\\' }) === true, '尾斜杠没归一')
})

check('A8 ★ 多路匹配：会话命中**或**路径命中都算（不能只看一路）', () => {
  // ⚠️ 我们**没有** `workspaceId` 这种强标识，只有 `session_id` 与 `path` 两个弱标识
  //    ⇒ 单看哪一个都会漏：换了目录但同一会话的，只有 session 能救回来。
  const sessOnly = { session_id: 's-1', path: 'D:\\完全\\别处\\a.md' }
  assert(P.rpInWorkspace(sessOnly, { sessionId: 's-1', cwd: 'C:\\proj' }) === true,
    '★ 同会话但路径在别处 ⇒ 必须靠 session 命中，否则漏')
  const pathOnly = { path: 'C:\\proj\\a.md' }
  assert(P.rpInWorkspace(pathOnly, { sessionId: 's-other', cwd: 'C:\\proj' }) === true,
    '★ 路径命中但会话不同 ⇒ 必须靠 path 命中')
  // 两路都不命中 ⇒ false（这才是唯一该被筛掉的情况）
  assert(P.rpInWorkspace({ session_id: 'x', path: 'D:\\y\\a.md' }, { sessionId: 's-1', cwd: 'C:\\proj' }) === false,
    '两路都不命中时没筛掉')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 接线：四样东西必须真的接上
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── [B] 接线 ──')

check('B1 ★ 复选框与徽章都在 head 里，且徽章用的是 `shown/total`', () => {
  const fn = SRC.slice(SRC.indexOf('function rpHead('), SRC.indexOf('/** 搜索框（受控'))
  assert(fn.indexOf('type: "checkbox"') >= 0, 'head 里没有复选框')
  assert(fn.indexOf('仅看此工作区') >= 0, '复选框没有文案')
  assert(/String\(o\.shown\) \+ "\/" \+ String\(o\.total\)/.test(fn),
    '★ 徽章不是 `shown/total` 形状 —— 用户看不到"收窄掉了多少"')
})

check('B2 ★ 搜索防抖：`typed` 与 `applied` 必须是**两个** state', () => {
  assert(/var typedPair = React\.useState\(""\)/.test(SRC), '没有 typed state')
  assert(/var appliedPair = React\.useState\(""\)/.test(SRC), '没有 applied state')
  // 防抖 effect：依赖 [typed]，里面 setTimeout 写 applied
  const i = SRC.indexOf('var timer = setTimeout(function () { setApplied(typed); }, 300);')
  assert(i > 0, '★ 没有「300ms 后把 typed 写进 applied」的防抖')
  // ⚠️ 依赖数组在 setTimeout **之后**（`return cleanup` 后面那行），
  //    第一版只往前看 200 字符 ⇒ 假红。改成往后取整段。
  const seg = SRC.slice(i, i + 400)
  assert(/\[typed\]/.test(seg), '★ 防抖 effect 的依赖里没有 [typed] —— 打字不会触发防抖')
  assert(/return function \(\) \{ clearTimeout\(timer\); \}/.test(seg),
    '★ 防抖没有 cleanup —— 快速输入会堆一串定时器')
})

check('B3 ★★ 列表 effect 的依赖里**不许**有 `typed`（否则每敲一个字发一次请求）', () => {
  const at = SRC.indexOf('setSnap({ status: "loading", items: [], error: "" });')
  assert(at > 0, '找不到列表 effect')
  const tail = SRC.slice(at, at + 1400)
  // 取 dependency 数组那一行
  const m = /\}, \[([^\]]*)\]\);/.exec(tail)
  assert(m, '找不到列表 effect 的依赖数组')
  assert(m[1].indexOf('typed') < 0,
    '★ 依赖里出现了 `typed` —— 防抖白做了，每敲一个字都会重发请求。当前：' + m[1].trim())
  assert(m[1].indexOf('applied') >= 0, '依赖里没有 `applied` —— 搜索永远不生效')
})

check('B4 ★ 截断必须明说（不许静默 slice）', () => {
  assert(/var shown = items\.slice\(0, RP_ROW_LIMIT\)/.test(SRC), '没有用 RP_ROW_LIMIT 截断')
  assert(SRC.indexOf('只显示前 ') >= 0, '★ 截断了但**一句话都没说** —— 那正是原来 414 条只显示 200 的坑')
  // 反向：不许再出现裸的 slice(0, 200)
  assert(!/items\.slice\(0, 200\)/.test(SRC), '★ 还残留裸的 `items.slice(0, 200)`')
})

check('B5 ★ 空态分五种，且「被范围筛掉」那一支给一键切回全部', () => {
  const fn = SRC.slice(SRC.indexOf('function rpEmptyText('), SRC.indexOf('function RightPaneBody('))
  assert(fn.indexOf('isFiltering') >= 0, '缺「被搜索/筛选筛掉」那一支')
  assert(fn.indexOf('droppedByScope') >= 0, '★ 缺「被范围筛掉」那一支 —— 那正是看起来像"库空了"的场景')
  assert(fn.indexOf('拿不到当前工作目录') >= 0, '缺「拿不到 cwd」那一支')
  assert(fn.indexOf('库里还没有产物') >= 0, '缺「库真空」那一支')
  // 一键取消按钮
  assert(/看全部 " \+ String\(snap\.items\.length\)/.test(SRC),
    '★ 「被范围筛掉」的空态没有"看全部 N 条"按钮 —— 用户只能自己去切下拉')
})

check('B6 ★ 预览操作行四个动作都在，且定位/打开走**不同**端点', () => {
  const at = SRC.indexOf('function RightPanePreview(')
  const seg = SRC.slice(at, at + 9000)
  for (const label of ['📂 定位', '📋 路径', '↗ 打开', '✎ 编辑']) {
    assert(seg.indexOf(label) >= 0, '预览操作行缺 ' + label)
  }
  // 两个端点必须不同 —— 宿主侧一个是 revealPath，一个是 openPath
  const reveal = SRC.slice(SRC.indexOf('function revealRecord('), SRC.indexOf('function copyRecordPath('))
  const open = SRC.slice(SRC.indexOf('function openRecord('), SRC.indexOf('function openRecord(') + 700)
  assert(reveal.indexOf('/open') >= 0, 'revealRecord 没走 `/<id>/open`')
  assert(open.indexOf('/files/open?path=') >= 0,
    '★ openRecord 没走 `files/open?path=` —— 与定位用同一个端点会"点了打开结果只是选中"')
})

check('B7 ★ 写请求带 CSRF 头（不带会被宿主 403）', () => {
  const fn = SRC.slice(SRC.indexOf('function apiPost('), SRC.indexOf('function notify('))
  assert(/["']x-dsh-artifacts["']\s*:\s*["']1["']/.test(fn),
    '★ `apiPost` 没带 `x-dsh-artifacts` 头 —— 宿主会 403，且 toast 只会说"失败"')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 旧设计确实退场（防两套并存）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── [C] 旧设计退场 ──')

check('C1 ★ 三档走**一个下拉**，没有平行按钮 / 没有复选框', () => {
  // ⚠️ 2026-10-18 晚：`RP_SCOPES` **必须存在**（三档下拉要用它）。
  //    这里要守的不是「它不在」，而是「**只有一种控件**」——
  //    历史上出现过两种错法：三个平行按钮（层级混淆）、一个复选框（依琪否掉）。
  assert(SRC.indexOf('RP_SCOPES') >= 0, '没有 RP_SCOPES ⇒ 三档范围没定义')
  assert(/id: "session"/.test(SRC) && /id: "workspace"/.test(SRC) && /id: "all"/.test(SRC),
    '三档不齐（依琪要的顺序：当前会话 / 当前工作区 / 全部）')
  // 单选控件必须是 <select>，不是一组带 aria-pressed 的 button
  assert(/function rpSelect\(h, o\)/.test(SRC), '没有下拉组件 rpSelect')
  const codeOnly = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert(codeOnly.indexOf('__rpseg') < 0, '★ 代码里还有 `__rpseg`（已删的旧平行按钮样式）')
  assert(codeOnly.indexOf('__rpchip') < 0, '★ 代码里还有 `__rpchip`（已删的芯片样式）')
  assert(codeOnly.indexOf('__rpcheck') < 0, '★ 代码里还有 `__rpcheck`（已否掉的复选框样式）')
})

check('C2 ★ 「工作区」下推给宿主的旧写法已删除（改成**本地筛**）', () => {
  // 旧写法：query += "&scope_dir=" / "&session_id="
  const codeOnly = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert(codeOnly.indexOf('scope_dir=') < 0,
    '★ 还在把 scope_dir 下推给宿主 —— 那会每次切复选框都重发请求，有明显空窗')
  assert(codeOnly.indexOf('"&session_id="') < 0,
    '★ 还在把 session_id 下推给宿主 —— 应该本地筛（与生图插件一致）')
})

check('C3 ★★ 偏好持久化：读不到 / 脏值 ⇒ 默认「全部」（**实测依据**）', () => {
  assert(/var RP_SCOPE_KEY = /.test(SRC), '没有持久化键')
  const fn = SRC.slice(SRC.indexOf('function rpScopeInitial('), SRC.indexOf('function rpScopeInitial(') + 900)

  // ⚠️⚠️ 默认值是 `all`，**不是** `workspace` —— 这是 2026-10-19 根据实测改的：
  //    依琪在 `Documents\互通` 下工作，而产物大多在别处 ⇒ 默认「工作区」
  //    会让面板只显示 **27/446**（他自己的截图就是 27/446），
  //    看起来像"库空了 / 坏了"。默认全量，让「工作区」成为**主动选择**。
  //
  // ⚠️ 这条判据**必须写死依据**：否则下一个人会觉得"默认全部太吵"而改回去，
  //    然后那个 27/446 的困惑就会重现。
  assert(fn.indexOf('return "all"') >= 0,
    '★ 读不到时没默认到 "all" —— 默认「工作区」会在换目录时显示成"库空了"（实测 27/446）')

  // 脏值（比如旧版存的 "workspace"/"true"）也要落回默认 —— 否则下拉的 value 对不上任何 option
  assert(/RP_SCOPES\[i\]\.id === v/.test(fn) || fn.indexOf('for (') >= 0,
    '★ 没有校验存量值 —— 旧版存的 "true" 会让 <select> 的 value 对不上任何 option')

  assert(fn.indexOf('catch') >= 0, '没有 try/catch —— localStorage 在隐私模式会抛')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 精炼（2026-10-18 晚 · 依琪：「去掉待精炼，只留下一键精炼 + 标记未精炼的」）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── [D] 精炼 ──')

check('D1 ★★ 「待精化」**不再是类型筛选**（它是状态标记 + 动作，不是一类东西）', () => {
  // ⚠️ 这条守的是**维度纪律**：把"状态"塞进"类型下拉"就是维度混淆。
  const filters = SRC.slice(SRC.indexOf('var RP_FILTERS = ['), SRC.indexOf('var RP_SORTS = ['))
  assert(filters.indexOf('"refine"') < 0,
    '★ RP_FILTERS 里又有 refine 了 —— 「未精炼」是状态标记，不该混进类型下拉')
  assert(filters.indexOf('deliverable') >= 0 && filters.indexOf('reference') >= 0,
    '类型筛选缺产出/资料')
})

check('D2 ★★ 未精炼标记用 `needsRefine`（**内容判定**），不是 `refineRequested`（人工标记）', () => {
  // ⚠️ 两者语义完全不同（见 store.js）：
  //    · needsRefine      = 摘要 + 标签 + 项目**三者齐备**才算已精炼（v2 规则）
  //    · refineRequested  = 人工打的「⚡优先」
  //    面板上那个点必须跟**内容**走，否则 AI 精炼完了点还在。
  assert(SRC.indexOf('rec.needsRefine') >= 0, '行上没按 needsRefine 打标记')
  const dot = SRC.slice(Math.max(0, SRC.indexOf('__rpdot') - 400), SRC.indexOf('__rpdot') + 200)
  assert(dot.indexOf('refineRequested') < 0,
    '★ 标记用了 refineRequested —— 那是人工「⚡优先」，不是"AI 没精炼过"')
})

check('D3 ★ 一键精炼 = 打标记（refine-request），不在栏里直接跑 AI', () => {
  // ⚠️ 为什么不在右栏直接跑 `refine-session`：它会开一个**真会话**（耗时、要模型），
  //    620px 里既看不到进度也接不住失败。⇒ 只打标记 + 把人送到管理页。
  assert(SRC.indexOf('"/refine-request"') >= 0, '没有调 refine-request')
  // ⚠️ 只查**代码**不查注释 —— 上面那段注释里就写着 `refine-session`
  //    （第一版查全文，被自己的注释绊倒：和 tag-chip 那次同一个坑）
  const codeOnly = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert(codeOnly.indexOf('/refine-session') < 0,
    '★ 右栏直接跑了 refine-session —— 那个会开真会话，栏里接不住进度与失败')
  assert(SRC.indexOf('onRefineAll') >= 0, '没有 onRefineAll')
})

check('D4 ★ 登记时提示「顺手精炼」：缺哪一项要说清', () => {
  // 依琪：「ai可以在登记产物库的时候顺手精炼」
  // ⇒ 只写"待精化"三个字没用，agent 还得再查一次才知道缺什么。必须**点名**。
  const tools = fs.readFileSync(path.join(REPO, 'lib', 'tools.js'), 'utf8')
  assert(tools.indexOf('顺手精炼') >= 0, 'register_artifact 的描述里没有「顺手精炼」的约定')
  assert(tools.indexOf("missing.push('summary')") >= 0,
    '★ 返回值里没有指出**缺哪一项** —— agent 看到"待精化"还得再查一次')
  assert(tools.indexOf('refineHint') >= 0, '没有把缺失项拼进返回值')
})

// ══════════════════════════════════════════════════════════════════════════
// [E] 后缀徽章（2026-10-18 · 依琪：「文件要显示文件类型，后缀名」）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── [E] 后缀徽章 ──')

/** 把 rpExtOf 抠出来求值（**行为级**测，不扫文本）。 */
function loadExt() {
  const from = SRC.indexOf('function rpExtOf(')
  const to = SRC.indexOf('/**', from)
  assert(from > 0 && to > from, '抠不出 rpExtOf —— 函数改名了？')
  const box = { String }
  vm.createContext(box)
  vm.runInContext(SRC.slice(from, to) + '\n;this.rpExtOf=rpExtOf;', box)
  return box.rpExtOf
}
const extOf = loadExt()

check('E1 优先用宿主的 `extension`（带不带点都归一）', () => {
  assert(extOf({ extension: '.md' }) === '.md', '.md')
  assert(extOf({ extension: 'md' }) === '.md', '不带点要补上')
  assert(extOf({ extension: '.MD' }) === '.md', '大写要归一')
  assert(extOf({ extension: '.png', filename: 'x.md' }) === '.png', 'extension 优先于 filename')
})

check('E2 ★★ 三个坑：dotfile / 目录名里的点 / 点结尾', () => {
  // ⚠️ 这三条与 store.js 的 extOfName 同源的教训：
  assert(extOf({ filename: '.gitignore' }) === '?', '★ dotfile 被当成了后缀 gitignore')
  assert(extOf({ path: 'C:\\a.b\\file' }) === '?', '★ 目录名里的点被当后缀（会抠出 .b\\file）')
  assert(extOf({ path: 'C:\\a.b\\file.md' }) === '.md', '目录有点 + 文件有点')
  assert(extOf({ filename: 'a.' }) === '?', '点结尾')
})

check('E3 ★ 拿不到时返回 `"?"`，**不许空串**（空串会让徽章变成看不见的框）', () => {
  assert(extOf({}) === '?', '空对象')
  assert(extOf(null) === '?', 'null')
  assert(extOf({ filename: 'Makefile' }) === '?', '无后缀')
  // 反向：单测里如果实现返回了空串，这条会立刻红
  assert(extOf({}) !== '', '★ 返回了空串 —— 徽章会变成一个只有 padding 的看不见的框')
})

check('E4 ★ 反向对照：不剥目录的错实现必须**错**', () => {
  const WRONG = (rec) => {
    const n = String((rec && (rec.filename || rec.path)) || '')
    const d = n.lastIndexOf('.')
    return d <= 0 ? '?' : '.' + n.slice(d + 1).toLowerCase()
  }
  const bad = WRONG({ path: 'C:\\a.b\\file' })
  assert(bad !== extOf({ path: 'C:\\a.b\\file' }),
    '★ 正确实现与错实现结果相同 ⇒ E2 那条判据没咬住')
})

check('E5 ★★ 类型格：目录显示 `—`（**不是 null** —— null 会让后面的列左移一格）', () => {
  // ⚠️ 2026-10-19 改成 grid 布局后，`rec.is_dir ? null : …` **不行了**：
  //    返回 null 会让 grid 少一格，标签/大小格全部左移 ⟹ 与表头错位。
  const seg = SRC.slice(SRC.indexOf('__rpext" },') - 300, SRC.indexOf('__rpext" },') + 120)
  assert(seg.indexOf('rpExtOf(rec)') >= 0, '★ 行上没有接类型格')
  assert(/rec\.is_dir \? "—" :/.test(seg), '★ 目录没显示 — —— 会少一格导致整行错位')
})
check('E6 ★ 后缀徽章不是 `artifact_type`（分类 ≠ 格式）', () => {
  // 实测库里 README.md 被归成 `doc`、别的 .md 归成 `document` —— 分类表本身不齐，
  // 拿它当"文件类型"显示会给出互相矛盾的信息。
  const seg = SRC.slice(SRC.indexOf('__rpext'), SRC.indexOf('__rpext') + 400)
  assert(seg.indexOf('artifact_type') < 0, '★ 后缀徽章用了 artifact_type（那是分类，不是格式）')
})

// ══════════════════════════════════════════════════════════════════════════
// [G] 行内标签（2026-10-19 · 依琪：「我发现你的标签这边没有快速显示啊」）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── [G] 行内标签 ──')

check('G1 ★★ 行里真的调用了 rpTagCell（不是只在预览页有标签）', () => {
  // ⚠️ 2026-10-19 核对发现：回退后行里**只有** 名字 → 后缀 → 大小，
  //    `tagChips` 三处全在预览页 ⇒ 依琪的抱怨是对的。
  // ⚠️ 2026-10-19：调用点变成 `rpTagCell(h, rec, rpManagedTags(managed))` ——
  //    第三个参数必须过取值函数（否则 tagChips 判成"读不到"，每行吐红字）。
  //    ⇒ 判据只认函数名，**不锁死参数形状**（参数迟早还会变）。
  assert(/rpTagCell\(h, rec,/.test(SRC),
    '★ 行里没调用 rpTagCell —— 标签只在预览页能看到')
})

check('G2 ★★ 只显示前 2 个 + `+N`（不许把名字挤没）', () => {
  const fn = SRC.slice(SRC.indexOf('function rpTagCell('), SRC.indexOf('function rpTagCell(') + 900)
  assert(/tags\.slice\(0, RP_TAG_SHOW\)/.test(fn), '★ 没截断 —— 620px 的行里塞 6 个标签会把名字压没')
  assert(/var RP_TAG_SHOW = 2/.test(SRC), 'RP_TAG_SHOW 不是 2')
  assert(fn.indexOf('"+" + String(rest)') >= 0, '没有 +N 折叠')
})

check('G3 ★ 折叠后**信息不丢**：`+N` 的 title 里给全部标签', () => {
  const fn = SRC.slice(SRC.indexOf('function rpTagCell('), SRC.indexOf('function rpTagCell(') + 900)
  assert(/title: tags\.join/.test(fn), '★ 折叠后没给 title —— "还有几个标签是什么"的信息丢了')
})

check('G4 ★ 用既有 `tagChips`（受管表颜色），不自己拼', () => {
  const fn = SRC.slice(SRC.indexOf('function rpTagCell('), SRC.indexOf('function rpTagCell(') + 900)
  assert(fn.indexOf('tagChips(h,') >= 0,
    '★ 没用 tagChips —— 颜色/字重会与预览区不一致（那是规则层的事）')
})

check('G5 ★ 没标签时返回 `null`（行内空间宝贵，不占位）', () => {
  const fn = SRC.slice(SRC.indexOf('function rpTagCell('), SRC.indexOf('function rpTagCell(') + 900)
  assert(/if \(!tags\.length\) return null/.test(fn),
    '★ 没标签时没返回 null —— 会占掉一段宽度')
})

// ══════════════════════════════════════════════════════════════════════════
// [H] 受管标签的**取值**（2026-10-19 · 依琪截图里那串红字逼出来的 bug）
// ══════════════════════════════════════════════════════════════════════════
//
// 【bug 现场】行内每行都显示：
//     标签样式读不到（/ext/artifacts/managed-tags 没拿到）
//     下面按**无样式**显示；这不代表你没有配过受管标签。
//
// 【根因】`tagChips` 用 `Array.isArray(managed)` 判断"读没读到"。
//    行内传的是**整个响应对象** `{ok:true, limit:null, tags:[…]}`
//    ⇒ `Array.isArray` = false ⇒ 判成"读不到" ⇒ 每行都警告。
//    而预览页自己多剥了一层 `.tags` ⇒ **同一个数据两种行为**。
//    ⚠️ 端点一直是好的（实测 200，返回 8 个标签）——**不是网络问题**。
//
// 【修法】收出一个唯一取值函数 `rpManagedTags`，行内与预览都走它。
console.log('\n── [H] 受管标签取值 ──')

/** 抠出 rpManagedTags 求值。 */
function loadManaged() {
  const from = SRC.indexOf('function rpManagedTags(')
  const to = SRC.indexOf('/**', from)
  assert(from > 0 && to > from, '抠不出 rpManagedTags —— 函数改名了？')
  const box = {}
  vm.createContext(box)
  vm.runInContext(SRC.slice(from, to) + '\n;this.rpManagedTags=rpManagedTags;', box)
  return box.rpManagedTags
}
const managedOf = loadManaged()

check('H1 ★★ 标准响应对象 ⇒ 取出 tags 数组（这就是那个 bug 的修法）', () => {
  const body = { ok: true, limit: null, tags: [{ id: 'mt_a', tag: 'A', color: 'green' }] }
  const out = managedOf(body)
  assert(Array.isArray(out), '★ 没取出数组 —— tagChips 会判成"读不到"（依琪截图那串红字）')
  assert(out.length === 1 && out[0].tag === 'A', '取出的内容不对')
})

check('H2 ★★ 反向对照：直接传响应对象给「Array.isArray」必须判 false', () => {
  // 这条证明 H1 的 bug 是**真的会**发生，不是我想象的
  const body = { ok: true, tags: [{ tag: 'A' }] }
  assert(Array.isArray(body) === false, '前提变了：响应对象居然被当数组')
  assert(Array.isArray(managedOf(body)) === true, '★ 修完之后还是判 false')
})

check('H3 ★ 三态不许拍平：null / [] / [{…}] 各自可辨', () => {
  // ⚠️ 这三个的**下一步动作不同**：
  //    null  ⇒ 去查设置（读不到）
  //    []    ⇒ 什么都不用做（确实没配）
  //    [{…}] ⇒ 正常
  assert(managedOf(null) === null, 'null 该返回 null')
  assert(managedOf(undefined) === null, 'undefined 该返回 null')
  assert(managedOf({}) === null, '空对象该返回 null')
  assert(managedOf({ ok: false }) === null, '★ ok:false 该返回 null（"拉过且失败"≠"拉到空"）')

  const empty = managedOf({ ok: true, tags: [] })
  assert(Array.isArray(empty) && empty.length === 0, '★ 拉到了但空表该返回 []，不是 null')
})

check('H4 ★ 畸形输入不抛（响应可能是任意形状）', () => {
  for (const bad of [0, '', 'x', [], [1, 2], { tags: 'nope' }, { tags: null }]) {
    let out
    try { out = managedOf(bad) } catch (e) { throw new Error('畸形输入 ' + JSON.stringify(bad) + ' 抛了：' + e.message) }
    assert(out === null || Array.isArray(out), '畸形输入返回了非 null 非数组：' + JSON.stringify(out))
  }
})

check('H5 ★★ 行内与预览**走同一个出口**（防再次漂移）', () => {
  // ⚠️ 这个 bug 的本质就是"两处各写一份"。
  //    ⇒ 判据：两处都调 rpManagedTags。
  assert(/rpTagCell\(h, rec, rpManagedTags\(managed\)\)/.test(SRC),
    '★ 行内没走 rpManagedTags')
  assert(/var managedTags = rpManagedTags\(props\.managed\)/.test(SRC),
    '★ 预览没走 rpManagedTags')
  // 反向：不许再有"自己剥 .tags"的写法（那就是漂移的源头）
  assert(!/props\.managed\.ok === true && Array\.isArray\(props\.managed\.tags\)/.test(SRC),
    '★ 还残留着自己剥 .tags 的旧写法')
})

// ══════════════════════════════════════════════════════════════════════════
// [I] 表头 + 四列对齐 + 分割线（2026-10-19 第 2 步）
// ══════════════════════════════════════════════════════════════════════════
// 依琪：「你要标注好，文件名，标签，这样顶上分类连同分割线」
console.log('\n── [I] 表格式列布局 ──')

check('I1 ★ 四列按依琪给的顺序：文件名 / 标签 / 类型 / 大小', () => {
  const seg = SRC.slice(SRC.indexOf('var RP_COLUMNS = ['), SRC.indexOf('function rpColumnTemplate('))
  const order = [...seg.matchAll(/key: "(\w+)"/g)].map((m) => m[1])
  assert(JSON.stringify(order) === JSON.stringify(['name', 'tags', 'ext', 'size']),
    '★ 列顺序不对：' + order.join('/') + '（依琪要的是 文件名/标签/类型/大小）')
})

check('I2 ★★ 行与表头**共用同一份**模板（否则永远差几像素）', () => {
  // ⚠️ 这是表格布局的**唯一**正确做法。
  const header = SRC.slice(SRC.indexOf('function rpHeader('), SRC.indexOf('function rpTagCell('))
  assert(/rpColumnTemplate\(rpGetWidths\(\)\)/.test(header), '表头没用 rpColumnTemplate')

  // 行：取 `__rprow` 到 `key: rec.id` 之间（那里就有 style）
  const rowStart = SRC.indexOf('__rprow" + (selected')
  const rowSeg = SRC.slice(rowStart, SRC.indexOf('key: rec.id', rowStart))
  assert(/gridTemplateColumns: rpColumnTemplate\(rpGetWidths\(\)\)/.test(rowSeg),
    '★ 行没用 rpColumnTemplate —— 会与表头差几像素')
})
check('I3 ★★ 行必须是 **5 个格**（勾选 + 4 列），多一个少一个都会错位', () => {
  // ⚠️ 这条是白屏那版**没做完**的地方：元素当时是平铺的（8 个直接子项），
  //    套上 5 列的模板就变成 8 列，与表头完全对不上。
  const seg = SRC.slice(SRC.indexOf('__rprow" + (selected[rec.id]'), SRC.indexOf('__rprow" + (selected[rec.id]') + 5200)
  const cells = [
    ['① 勾选', '__rpck"'],
    ['② 名字', '__rpname"'],
    ['③ 标签', '__rptagcell"'],
    ['④ 类型', '__rpext"'],
    ['⑤ 大小', '__rpszcell"'],
  ]
  let prev = -1
  for (const [name, key] of cells) {
    const p = seg.indexOf(key)
    assert(p >= 0, '★ 缺 ' + name + ' 格')
    assert(p > prev, '★ ' + name + ' 格顺序错了')
    prev = p
  }
})

check('I4 ★ 标签格**再包一层**（rpTagCell 返回两个兄弟，不包会占两格）', () => {
  // `rpTagCell` 返回 [chips, +N] 两个兄弟节点 —— 直接放进行里就是**两格**。
  assert(/h\("span", \{ className: NS \+ "__rptagcell" \},\s*\n\s*rpTagCell\(h, rec,/.test(SRC),
    '★ 标签格没包 —— rpTagCell 的两个兄弟会各占一格，把后面挤歪')
})

check('I5 ★ 表头有**列间分隔线**（依琪：「连同分割线」）', () => {
  const header = SRC.slice(SRC.indexOf('function rpHeader('), SRC.indexOf('function rpTagCell('))
  // ⚠️ 2026-10-19 第 3 步：`__rpline`（纯装饰线）升级成 `__rpgrip`（线 + 拖动把手）。
  //    它是**同一根线**的两种角色：看着是分割线，抓着就是把手。
  assert(header.indexOf('__rpgrip') >= 0, '★ 表头没有分隔线')
  // ⚠️ 分隔线只在表头，**行内不放**（每行一根线太吵，且会与背景色打架）
  const rowSeg = SRC.slice(SRC.indexOf('__rprow" + (selected'), SRC.indexOf('__rprow" + (selected') + 5200)
  assert(rowSeg.indexOf('__rpgrip') < 0, '★ 行内也有把手 —— 每行一根太吵')
})
// ══════════════════════════════════════════════════════════════════════════
// [J] 拖动分隔线（2026-10-19 第 3 步）
// ══════════════════════════════════════════════════════════════════════════
// 依琪：「没看到分割线，就也没法拖动」—— 两件事是一个需求。
console.log('\n── [J] 拖动调宽 ──')

check('J1 ★★ overflow 不许在格子上（它会把把手裁掉 —— 就是"看不见线"的根因）', () => {
  // ⚠️ 这是**根因级**判据：把手是 `position:absolute; right:-5px`，
  //    在格子外面。格子上只要有 `overflow:hidden`，它就被裁得一干二净。
  // ⚠️ 只取**这一条规则**（到行尾的 `",` 为止）——
  //    第一版切 200 字符，把紧跟其后的 `__rpcoltext{…overflow:hidden}` 也圈进来了 ⇒ 假红。
  const start = SRC.indexOf('__rpcol{')
  assert(start > 0, '找不到 __rpcol 规则')
  const seg = SRC.slice(start, SRC.indexOf('",', start))
  assert(seg.indexOf('overflow:visible') >= 0,
    '★ 格子又设了 overflow —— 把手会被裁掉（依琪就是因为这个看不到线）')
  assert(seg.indexOf('overflow:hidden') < 0, '★ 格子上有 overflow:hidden（' + seg + '）')
  // 裁文字的责任交给内层
  assert(/__rpcoltext\{display:block;overflow:hidden/.test(SRC),
    '★ 没有内层文字裁切 —— 长列名会溢出')
})

check('J2 ★★ 拖动用 pointer 事件 + setPointerCapture（触屏可用、拖出侧栏不丢）', () => {
  const fn = SRC.slice(SRC.indexOf('function rpStartDrag('), SRC.indexOf('function rpStartDrag(') + 2400)
  assert(fn.indexOf('setPointerCapture') >= 0, '★ 没有 setPointerCapture —— 拖出侧栏会丢事件')
  assert(fn.indexOf('addEventListener("pointermove"') >= 0, '没有 pointermove')
  assert(fn.indexOf('pointerup') >= 0 && fn.indexOf('pointercancel') >= 0,
    '★ 没成对清理 —— 触屏取消时会留野监听')
  assert(fn.indexOf('mousedown') < 0, '还在用 mousedown —— 触屏用不了')
})

check('J3 ★ 拖动夹到 min（不许拖成负宽 = 列消失）', () => {
  const fn = SRC.slice(SRC.indexOf('function rpStartDrag('), SRC.indexOf('function rpStartDrag(') + 2400)
  assert(/Math\.max\(col\.min, Math\.round\(startW \+ dx\)\)/.test(fn),
    '★ 没夹 min —— 能把列拖成负宽，看起来像列丢了')
})

check('J4 ★ 拖动不许触发排序（把手 stopPropagation）', () => {
  const header = SRC.slice(SRC.indexOf('function rpHeader('), SRC.indexOf('function rpTagCell('))
  assert(/onClick: function \(event\) \{ if \(event && event\.stopPropagation\)/.test(header),
    '★ 把手没拦点击 —— 拖完松手会顺带触发排序')
})

check('J5 ★ 弹性列（名字）**不给拖**', () => {
  // 名字列是 `1fr`（吃剩余空间）。拖它等于跟浏览器抢 1fr 的解释权，拖完会弹回去。
  assert(/defaultPx: null/.test(SRC), '名字列没有 defaultPx:null')
  const fn = SRC.slice(SRC.indexOf('function rpStartDrag('), SRC.indexOf('function rpStartDrag(') + 400)
  assert(fn.indexOf('defaultPx === null') >= 0, '★ 没拦弹性列 —— 拖了会弹回去（像坏了）')
})

check('J6 ★ 列宽持久化：畸形/负数一律忽略（坏值不许把布局搞崩）', () => {
  const fn = SRC.slice(SRC.indexOf('function rpWidthsInitial('), SRC.indexOf('function rpStartDrag('))
  assert(fn.indexOf('JSON.parse') >= 0, '没有解析存量')
  assert(/isFinite\(v\) && v >= c\.min/.test(fn), '★ 没校验存量值 —— 存了个 0 会让列消失')
  assert(fn.indexOf('catch') >= 0, '没有 try/catch —— 畸形 JSON 会把整张表搞崩')
})

check('J7 ★ 双击把手恢复默认宽（Windows 同款手感）', () => {
  const header = SRC.slice(SRC.indexOf('function rpHeader('), SRC.indexOf('function rpTagCell('))
  assert(header.indexOf('onDoubleClick') >= 0, '把手没有双击恢复')
  assert(SRC.indexOf('function rpResetCol(') >= 0, '没有 rpResetCol')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
