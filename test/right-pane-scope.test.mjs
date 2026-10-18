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
  const to = SRC.indexOf('/**\n     * 筛选芯片')
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

check('B5 ★ 空态分四种，且「被工作区筛掉」那一支给一键取消', () => {
  const fn = SRC.slice(SRC.indexOf('function rpEmptyText('), SRC.indexOf('function RightPaneBody('))
  assert(fn.indexOf('isFiltering') >= 0, '缺「被搜索/筛选筛掉」那一支')
  assert(fn.indexOf('droppedByWs') >= 0, '★ 缺「被工作区筛掉」那一支 —— 那正是看起来像"库空了"的场景')
  assert(fn.indexOf('拿不到当前工作目录') >= 0, '缺「拿不到 cwd」那一支')
  assert(fn.indexOf('库里还没有产物') >= 0, '缺「库真空」那一支')
  // 一键取消按钮
  assert(/看全部 " \+ String\(snap\.items\.length\)/.test(SRC),
    '★ 「被工作区筛掉」的空态没有"看全部 N 条"按钮 —— 用户只能自己去点复选框')
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

check('C1 ★ 三个平行粒度按钮已删除（`RP_SCOPES` / `__rpseg`）', () => {
  assert(SRC.indexOf('RP_SCOPES') < 0, '★ `RP_SCOPES` 还在 —— 两套范围控件并存')
  // `__rpseg` 只允许出现在注释里（解释为什么不用它）
  const codeOnly = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert(codeOnly.indexOf('__rpseg') < 0, '★ 代码里还有 `__rpseg`（已删的旧粒度按钮样式）')
})

check('C2 ★ 「工作区」下推给宿主的旧写法已删除（改成**本地筛**）', () => {
  // 旧写法：query += "&scope_dir=" / "&session_id="
  const codeOnly = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert(codeOnly.indexOf('scope_dir=') < 0,
    '★ 还在把 scope_dir 下推给宿主 —— 那会每次切复选框都重发请求，有明显空窗')
  assert(codeOnly.indexOf('"&session_id="') < 0,
    '★ 还在把 session_id 下推给宿主 —— 应该本地筛（与生图插件一致）')
})

check('C3 ★ 偏好持久化用的是 localStorage 且**读失败默认勾上**', () => {
  assert(/var RP_SCOPE_KEY = "alf-only-current-workspace"/.test(SRC), '没有持久化键')
  const fn = SRC.slice(SRC.indexOf('function rpScopeInitial('), SRC.indexOf('function rpScopeInitial(') + 500)
  assert(/return v === null \? true : v === "true"/.test(fn),
    '★ 读不到时不是默认 `true` —— 默认不勾会让"我刚做的东西"这个第一诉求失效')
  assert(fn.indexOf('catch') >= 0, '没有 try/catch —— localStorage 在隐私模式会抛')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
