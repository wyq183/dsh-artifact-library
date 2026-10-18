/**
 * 右栏的**错误兜底**（error boundary）—— 2026-10-18 白屏事故的护栏。
 * ══════════════════════════════════════════════════════════════════════════
 * 【为什么有这个文件】
 *
 * 2026-10-18 晚，我推了「表格式列布局」之后依琪报「**纯白屏了**」。
 * 我用尽静态手段查不到根因：
 *   `node --check` ✅ / vm 模块层求值 ✅ / `factory()` ✅ / `apply(ctx)` ✅ /
 *   14 个右栏组件逐个渲染 ✅ / CSS 数组求值 + 花括号配对 ✅
 *
 * **真正的问题是架构性的**：`RightPaneBody` 是**裸注册**的 ——
 * 它在渲染期抛异常时，React 会卸载整棵子树 ⇒ **整个 DSH 白屏**，
 * 而用户只看到一个白页面，既无报错也无线索。
 *
 * ⇒ 无论那次白屏的根因是什么，**这一层保护本来就该有**。
 *    任何插件在渲染期抛异常都不该拖白整个应用；宿主没给，我们自己给。
 *
 * ⚠️ 本文件的判据必须能**咬住不装 boundary 的版本**（见 B2 反向对照）。
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

console.log('\n═══ 右栏错误兜底 ═══')

// ── 载入（注入 __test 钩子）─────────────────────────────────────────────
const raw = fs.readFileSync(CLIENT, 'utf8')
const HOOK = 'exports.__test = { rpBoundaryClass: rpBoundaryClass, rpWithBoundary: rpWithBoundary };\n    exports.apply = apply;'
const ANCHOR = 'exports.apply = apply;'
assert(raw.indexOf(ANCHOR) >= 0, '找不到注入锚点 `exports.apply = apply;`')
const src = raw.replace(ANCHOR, HOOK)

let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (d) => { captured = d } } },
  document: {
    baseURI: 'http://127.0.0.1/', querySelector: () => null, getElementById: () => null,
    createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
    head: { appendChild() {} }, documentElement: { appendChild() {} },
    body: { appendChild() {}, style: {} },
    addEventListener() {}, removeEventListener() {},
  },
  console: { log() {}, info() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, Promise, Intl, Date, isFinite, isNaN, parseFloat, parseInt,
  encodeURIComponent, decodeURIComponent, JSON, Math, Number, String, Array, Object, RegExp, Error,
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => '' }),
  location: { search: '', origin: 'http://127.0.0.1', href: 'http://127.0.0.1/' },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null }, setItem(k, v) { this._d[k] = String(v) }, removeItem(k) { delete this._d[k] } },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(src, sandbox)

/**
 * 迷你 React —— **必须两阶段**（建树 / 渲染）。
 *
 * ⚠️ 第一版我建完 element 就直接 `Wrapped({})`，那时子组件**还没执行**，
 *    boundary 根本没机会介入 ⇒ 测出来"兜不住"是**模拟的错**，不是实现的错。
 *    真实 React 里子组件是在**渲染阶段**被调用的。
 */
function makeMiniReact() {
  const EL = Symbol('el')
  function Component(props) { this.props = props || {}; this.state = {} }
  Component.prototype.setState = function (patch) { this.state = Object.assign({}, this.state, patch) }
  function createElement(type, props, ...children) {
    const p = Object.assign({}, props || {})
    if (children.length) p.children = children.length === 1 ? children[0] : children
    return { [EL]: true, type, props: p }
  }
  function render(el) {
    if (el === null || el === undefined || typeof el !== 'object' || !el[EL]) return el
    const { type, props } = el
    if (typeof type === 'function' && type.prototype && type.prototype.render) {
      const inst = new type(props)
      inst.props = props
      if (!inst.state) inst.state = {}
      try {
        return render(inst.render())
      } catch (e) {
        if (typeof type.getDerivedStateFromError === 'function') {
          inst.state = Object.assign(inst.state, type.getDerivedStateFromError(e))
          if (inst.componentDidCatch) inst.componentDidCatch(e, { componentStack: '' })
          return render(inst.render())
        }
        throw e
      }
    }
    if (typeof type === 'function') return render(type(props))
    return { host: type, props, children: props.children }
  }
  return { Component, createElement, render }
}

const react = makeMiniReact()
const mod = captured.factory((name) => (name === 'react' ? react : {}))
mod.apply({ get: () => undefined })
const T = mod.__test || {}
const h = react.createElement

// ══════════════════════════════════════════════════════════════════════════
// [B] boundary 行为
// ══════════════════════════════════════════════════════════════════════════

check('B1 ★★ 子组件渲染期抛 ⇒ 被兜住，且兜底 UI **带原始错误**', () => {
  // ⚠️ 兜底不是把错误藏起来，是让它**可见且不致命**。
  //    不带原始错误的话，"白屏"只是变成"友好提示但没人知道为什么"。
  const Boom = () => { throw new Error('boom-123') }
  const tree = h(T.rpWithBoundary(Boom), null)
  let out
  try { out = react.render(tree) } catch (e) { throw new Error('boundary 没兜住，异常还是冒出来了：' + e.message) }
  assert(JSON.stringify(out).indexOf('boom-123') >= 0,
    '★ 兜底 UI 没带原始错误信息：' + JSON.stringify(out).slice(0, 200))
})

check('B2 ★★ 反向对照：**没有** boundary 的同一个组件必须抛出来', () => {
  // 没有这条，B1 可能是空转（万一 Boom 根本不抛呢）
  const Boom = () => { throw new Error('boom-456') }
  let threw = false
  try { react.render(h(Boom, null)) } catch (e) { threw = true }
  assert(threw, '★ 对照组没抛 ⇒ B1 的判据是空转的')
})

check('B3 ★ 正常组件穿过 boundary 原样渲染（不能被改坏）', () => {
  const Ok = () => h('div', { id: 'ok' }, 'fine')
  const out = JSON.stringify(react.render(h(T.rpWithBoundary(Ok), null)))
  assert(out.indexOf('ok') >= 0, '正常组件被 boundary 改坏了：' + out.slice(0, 200))
})

check('B4 ★ 兜底 UI 里有「重试」（不是死路）', () => {
  const Boom = () => { throw new Error('x') }
  const out = JSON.stringify(react.render(h(T.rpWithBoundary(Boom), null)))
  assert(out.indexOf('重试') >= 0, '兜底没有重试按钮 —— 用户只能刷新整页')
})

check('B5 ★ 没有 Component 的假 React 降级成透传（不崩）', () => {
  // 极端环境（假 React / 老宿主）不许因为 boundary 自己而崩
  const bare = { createElement: (t2, p) => ({ t: t2, p }) }
  const mod2 = captured.factory((name) => (name === 'react' ? bare : {}))
  const T2 = mod2.__test || {}
  let cls
  try { cls = T2.rpBoundaryClass() } catch (e) { throw new Error('没 Component 时直接抛了：' + e.message) }
  assert(typeof cls === 'function', '降级后不是组件')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 接线：右栏那两处注册**必须**包 boundary
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★ `sidebar.right.pane.tab` 注册时包了 boundary', () => {
  // ⚠️ 有了 boundary 组件但**没包上去**，等于没做。
  assert(/rpWithBoundary\(RightPaneBody\)/.test(raw),
    '★ 右栏正文注册时没包 boundary —— 渲染期抛异常会拖白整个应用')
})

check('C2 ★ `sidebar.right.pane.tab.title` 也包了（标题芯片同样会渲染）', () => {
  assert(/rpWithBoundary\(RightPaneTitle\)/.test(raw),
    '★ 标题芯片没包 boundary')
})

check('C3 ★ 兜底组件把异常打到 console（否则 DevTools 里看不到真因）', () => {
  assert(/componentDidCatch/.test(raw), '没有 componentDidCatch —— 异常不会出现在控制台')
  // ⚠️ 正则里 `[artifact-library]` 是**字符类**，不是字面量 —— 必须转义成 \[ \]。
  //    第一版没转义，导致一条**实现正确**的断言报红（假红）。
  assert(/console\.error\("\[artifact-library\]/.test(raw),
    '没有带插件前缀的 console.error —— 日志里认不出是谁抛的')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
// ⚠️ 必须显式 exit：client.js 里有 setTimeout 重试链（@ 来源 / 探针），
//    它会吊住事件循环 ⇒ node --test 永远不结束（实测卡死 3 分钟）。
//    ⚠️ 这**不是**掩盖问题：本文件测的是纯渲染逻辑，定时器与它无关。
process.exit(failed ? 1 : 0)
