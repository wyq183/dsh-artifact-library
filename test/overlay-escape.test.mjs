/**
 * dsh-artifact-library · 「Esc 只关最上层浮层」守卫（task-10）
 *
 * ── 守的是什么（**契约**，不是照抄实现）─────────────────────────────────────
 *   C1 媒体预览浮层 + 详情抽屉**都开着** ⇒ **一次** Esc **只关浮层**，抽屉保持打开。
 *   C2 只有浮层 ⇒ 一次 Esc 关浮层。
 *   C3 浮层的 ArrowLeft / ArrowRight **不外泄**给下层处理器。
 *   C4 浮层有一个带 `aria-label` 的 `×` 按钮能关闭；文字「关闭」按钮**保留**。
 *
 * ── 为什么这几条值得单独一个文件 ───────────────────────────────────────────
 * 依琪报的原话是「**要按两下 Esc 才退**」—— 这是**行为**缺陷，不是样式问题。
 * 它只在「两层同时开着」时才出现，而 `client-render.test.mjs` 那些断言全是
 * **单层、静态**的（源码里有没有 `stopPropagation` 字样），**抓不住**这个组合：
 * 两个监听器都挂在 `document` 的 capture 阶段，**同节点同阶段按注册顺序跑**，
 * `stopPropagation()` 拦不住同一节点上的兄弟监听器（MDN：那要 `stopImmediatePropagation`）。
 * ⇒ 光数源码里有几个 `stopPropagation` 是**看不出来的**，必须**真的派发一次事件**，
 *   看谁被调用、谁没被调用。
 *
 * ── 手法 ───────────────────────────────────────────────────────────────────
 * ① **假 DOM + 假 React**（形态照 `client-render.test.mjs`）：把 `lib/client.js`
 *    在 vm 里跑起来拿到 module factory，渲染 `main` 得到渲染树；`document.addEventListener`
 *    被我们记账，于是可以**自己派发 keydown**（capture 从头到尾 → bubble 从尾到头），
 *    并如实实现 `stopPropagation()` 的语义。
 * ② `useEffect` 是**真的会跑**的（假 React 在每次渲染后跑「新出现的 effect」）——
 *    浮层与抽屉的键盘监听器都注册在 effect 里，不跑 effect 就一个监听器都没有，
 *    「派发事件」会变成一场空转（这本身就是本仓库栽过的「判据建在空输入上」）。
 * ③ 每条守卫都配**变异测试**（§6）：把「已知有病的版本」喂进来，断言**这条守卫必须红**。
 *    没红的守卫 = 空转的守卫。**改哪一处 ⇒ 哪条红**的对照表在文件末尾。
 *
 * 运行：node test/overlay-escape.test.mjs [client.js 路径]
 * 退出码：有失败 → 1
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('../lib/client.js', import.meta.url));

let passed = 0;
let failed = 0;
const failureList = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    failed += 1;
    const message = error && error.message ? error.message : String(error);
    failureList.push({ name, message });
    console.log('  FAIL ' + name + ' -> ' + message);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

console.log('\n═══ 「Esc 只关最上层浮层」守卫（task-10）═══');
console.log(' 被测：' + CLIENT_PATH);

const src = fs.readFileSync(CLIENT_PATH, 'utf8');
/** 剥过注释的源码（静态断言用）。注释里提到某个词**不算数**。 */
const CODE = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

// ══════════════════════════════════════════════════════════════════════════
// §0 假 DOM —— 事件分发要**真的**按 capture/bubble 两阶段走
// ══════════════════════════════════════════════════════════════════════════
/**
 * 为什么不用 `new EventTarget()`：本文件必须能**观察**「谁被调用、谁没被调用」，
 * 而且要对 `stopPropagation()` 的语义负责（Node 的 EventTarget 对 `{key:'Escape'}`
 * 这种普通对象不友好，报错也难读）。自己写一个小模型，语义与浏览器一致：
 *   · capture：从头到尾，`stopPropagation` 之后剩下的 capture 兄弟**仍然会跑**（同节点不拦兄弟）
 *   · 到达 target：不拦截
 *   · bubble：从尾到头，`stopPropagation` 之后一个都不跑
 * 这里 target 就是 `document` 自己（监听器都挂在 document 上）。
 */
function createFakeDocument() {
  const listeners = [];
  return {
    baseURI: 'http://127.0.0.1:19387/',
    activeElement: null,
    __listeners: listeners,
    addEventListener(type, fn, opts) {
      const capture = opts === true || (opts && opts.capture === true);
      listeners.push({ type, fn, capture, target: 'document' });
    },
    removeEventListener(type, fn, opts) {
      const capture = opts === true || (opts && opts.capture === true);
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({
      setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {},
      style: {}, classList: { add() {}, remove() {}, toggle() {} },
    }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    body: { appendChild() {} },
  };
}

/** 派发一次 keydown；返回「被调用过的监听器」清单（诊断用）。 */
function dispatchKeydown(doc, key) {
  const event = { type: 'keydown', key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  let stopped = false;
  event.stopPropagation = () => { stopped = true; };
  event.stopImmediatePropagation = () => { stopped = true; };
  const called = [];
  const snapshot = doc.__listeners.filter((l) => l.type === 'keydown').slice();
  const run = (l) => { called.push(l); l.fn(event); };
  // ① capture：从头到尾。⚠️ 同一节点上的兄弟监听器**不受** stopPropagation 影响
  for (const l of snapshot) if (l.capture) run(l);
  // ② target 阶段（document 自己就是 target，capture 监听器已在上面跑过）
  // ③ bubble：从尾到头；stopPropagation 之后一个都不跑
  if (!stopped) for (let i = snapshot.length - 1; i >= 0; i -= 1) if (!snapshot[i].capture) run(snapshot[i]);
  return called;
}

// ══════════════════════════════════════════════════════════════════════════
// §0.1 载入 bundle（假 window + module factory）
// ══════════════════════════════════════════════════════════════════════════
function loadFactory(source) {
  const doc = createFakeDocument();
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
    document: doc,
    console: { info: () => {}, warn: () => {}, log: () => {}, error: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Promise, Intl, Date, isFinite, parseFloat, JSON, Math, String, Number,
    Object, Array, Boolean, RegExp, Error, Map, Set, WeakMap,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => '' }),
    location: { search: '' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert(captured && typeof captured.factory === 'function',
    'client.js 没注册 module factory（入口形态变了？本文件的整个前提失效）');
  return { factory: captured.factory, doc };
}

// ══════════════════════════════════════════════════════════════════════════
// §0.2 假 React —— useState 按位置喂；useEffect **真的跑**（含 cleanup）
// ══════════════════════════════════════════════════════════════════════════
/**
 * 与 `client-render.test.mjs` 的假 React 有两处**有意**的差别：
 *   ① `useEffect` 会执行（依赖变化时先 cleanup 再重跑）——
 *      不跑 effect 就没有任何键盘监听器，本文件的一切都成了空转；
 *   ② `useState` 的 setter 是**真的**会改状态并触发重渲染 ——
 *      因为 C1 的第二半（第二次 Esc 关抽屉）需要「浮层关掉后它自己摘监听器」真的发生。
 * 状态**按位置**喂：`slots[i]` 是第 i+1 次 `useState` 的初值（见 §1 校准）。
 */
function makeReact(slots) {
  const stats = { useStateCalls: 0, slotInits: [], setCalls: [], effectRuns: 0, cleanups: 0 };
  const values = slots.slice();   // ★ 复制：不改调用方的数组
  const setters = new Map();
  const effectSlots = {};
  let pending = false;
  function createElement(type, props, ...children) {
    if (typeof type === 'function') return type(Object.assign({}, props || {}, { children }));
    return { type, props: props || {}, children };
  }
  const react = {
    createElement,
    useState(init) {
      const slot = stats.useStateCalls;
      stats.useStateCalls += 1;
      const initial = typeof init === 'function' ? init() : init;
      stats.slotInits.push(initial);
      if (!(slot in values)) values[slot] = initial;
      if (!setters.has(slot)) {
        setters.set(slot, (next) => {
          stats.setCalls.push({ slot, value: next });
          const resolved = typeof next === 'function' ? next(values[slot]) : next;
          if (resolved !== values[slot]) { values[slot] = resolved; pending = true; }
        });
      }
      return [values[slot], setters.get(slot)];
    },
    // ⚠️ 真实的 useEffect 在 renderOnce 里被**临时**替换掉（要按「渲染内顺序」编号）。
    //    这里留一个兜底：万一有人在替换窗口之外调用它，也只是不注册 effect（不会崩）。
    useEffect() { return undefined; },
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); },
    useRef(init) { return { current: init }; },
    useLayoutEffect() {},
    __stats: stats,
    __values: values,
    __effectSlots: effectSlots,
    __elements: [],
    __markPending: () => { pending = true; },
    __takePending: () => { const p = pending; pending = false; return p; },
  };
  return react;
}

const walk = (n, out) => {
  if (n === null || n === undefined || n === false) return;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, out)); return; }
  if (typeof n !== 'object') return;
  out.push(n);
  (n.children || []).forEach((c) => walk(c, out));
};
const cls = (n) => String((n.props && n.props.className) || '');
const txt = (n) => (Array.isArray(n.children)
  ? n.children.filter((c) => typeof c === 'string').join('')
  : String(n.children == null ? '' : n.children));

/**
 * 渲染 + 跑 effect 直到稳定（最多 6 轮）。
 * 每轮：渲染树 → 跑「新出现 / 依赖变了」的 effect（它们会往 document 上注册监听器）。
 * `reuse` 传入上一次的 handle ⇒ 复用同一份状态与同一批监听器（模拟「setState 之后的重渲染」）。
 *
 * ⚠️ **cleanup 必须真的跑**：本文件靠「浮层关掉后它自己的 effect cleanup 摘掉监听器」
 *    才能验 C1c（第二下 Esc 关抽屉）。如果 cleanup 不跑，监听器会一轮一轮堆积，
 *    派发一次 Esc 会命中好几个陈旧监听器 —— 断言就会变成在测一个假的世界。
 */
function mount(source, slots, reuse, patchProps) {
  let react;
  if (reuse) {
    react = reuse.react;
  } else {
    const loaded = loadFactory(source);
    react = makeReact(slots || []);
    const mod = loaded.factory((n) => (n === 'react' ? react : {}));
    const comps = {};
    mod.apply({ get: () => ({ inject: (n, f) => f(), register: (o, c) => { comps[o.name] = c; return () => {}; } }) });
    assert(typeof comps.main === 'function', '没注册到 main 组件 —— client.js 的注册形态变了');
    react.__main = comps.main;
    react.__doc = loaded.doc;
  }
  if (patchProps) react.__patchProps = patchProps;

  let tree = null;
  let elements = [];
  for (let round = 0; round < 6; round += 1) {
    react.__takePending();
    react.__stats.useStateCalls = 0;
    const rendered = renderOnce(react, react.__main);
    tree = rendered.tree;
    elements = rendered.elements;
    const ran = runEffects(react);
    if (!react.__takePending() && ran === 0) break;
  }
  const nodes = [];
  walk(tree, nodes);
  return { tree, doc: react.__doc, react, nodes, elements };
}
/** 渲染一次：临时接管 `createElement`（收集组件元素）与 `useEffect`（按渲染内顺序编号）。 */
function renderOnce(react, main) {
  let cursor = 0;
  let elementCursor = 0;
  react.__elements = [];
  const originalEffect = react.useEffect;
  const originalCreate = react.createElement;
  react.useEffect = function (fn, deps) {
    const key = cursor;
    cursor += 1;
    const slots = react.__effectSlots;
    const previous = slots[key];
    if (previous && sameDeps(previous.deps, deps)) { previous.visited = true; return undefined; }
    if (previous) previous.stale = true;
    slots[key] = { key, fn, deps: deps ? deps.slice() : null, cleanup: null, ran: false, visited: true };
    react.__markPending();
    return undefined;
  };
  react.createElement = function (type, props, ...children) {
    const patched = (typeof type === 'function' && react.__patchProps)
      ? react.__patchProps(type, props)
      : props;
    const element = originalCreate(type, patched, ...children);
    if (typeof type === 'function') {
      element.__el = elementCursor;
      element.__name = type.name || '';
      elementCursor += 1;
      react.__elements.push(element);
    }
    return element;
  };
  try {
    return { tree: main({}), elements: react.__elements };
  } finally {
    react.useEffect = originalEffect;
    react.createElement = originalCreate;
  }
}
/** 跑「本轮新出现 / 依赖变了」的 effect；先把上一轮消失的 effect 清理掉。 */
function runEffects(react) {
  const slots = react.__effectSlots;
  for (const k of Object.keys(slots)) {
    const r = slots[k];
    if (r && !r.visited && !r.stale) { r.stale = true; }
  }
  const toRun = Object.keys(slots).map(Number).filter((k) => slots[k] && slots[k].stale).sort((a, b) => a - b);
  for (const k of toRun) {
    const r = slots[k];
    if (typeof r.cleanup === 'function') { r.cleanup(); react.__stats.cleanups += 1; }
    delete slots[k];
  }
  const fresh = Object.keys(slots).map(Number).filter((k) => slots[k] && !slots[k].ran).sort((a, b) => a - b);
  for (const k of fresh) {
    const r = slots[k];
    r.ran = true;
    const c = r.fn();
    r.cleanup = typeof c === 'function' ? c : null;
    react.__stats.effectRuns += 1;
  }
  return fresh.length + toRun.length;
}
/**
 * 依赖比较：**函数按「都是函数」算相等**。
 * 为什么不能用 `===`：`props.onClose: function () { setDetail(null); }` 这类**内联闭包**
 * 每次渲染都是新对象，真 React 也会因此重跑 effect。但那是**真实**行为，
 * 不是我们要测的东西 —— 照 `===` 比，本 harness 会一轮接一轮地重跑、永远不收敛。
 * 这里只关心「**语义上**有没有变」（`blockEscape` 从 false 变 true 必须被看见）。
 */
function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === 'function' && typeof y === 'function') continue;
    return false;
  }
  return true;
}

/** 模拟「状态变了 → React 重渲染」：复用同一份状态与同一批监听器。 */
const remount = (handle, source) => mount(source, null, handle);

/** 从收集到的**组件元素**里找某个组件（DOM 节点上看不到 `onClose` 这类回调，只能在这儿找）。 */
const findEl = (handle, name) => handle.elements.find((e) => e.__name === name);
/** 元素树里的纯文本（`children` 里可能是嵌套元素）。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return (node.children || []).map(textOf).join('');
  return '';
}
/** 在**元素树**里找按钮（文案在 `children` 里；与 `client-render.test.mjs` 同一口径）。 */
function buttonsIn(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => buttonsIn(n, out)); return out; }
  if (node.type === 'button') out.push(node);
  (node.children || []).forEach((n) => buttonsIn(n, out));
  return out;
}
const btnByText = (root, label) => buttonsIn(root, []).find((b) => textOf(b) === label);

// ══════════════════════════════════════════════════════════════════════════
// §0.3 测试数据与状态槽位
// ══════════════════════════════════════════════════════════════════════════
const IMG = { id: 'art_i', title: '图.png', path: 'C:\\p\\图.png', mime_type: 'image/png', exists: true, tags: [], stars: 0, artifact_type: 'image' };
const VID = { id: 'art_v', title: '片.mp4', path: 'C:\\p\\片.mp4', mime_type: 'video/mp4', exists: true, tags: [], stars: 0, artifact_type: 'video' };
const sampleData = { items: [], stats: {}, cats: { projects: [], types: [], tags: [] }, loading: false, error: '' };
const filters = { q: '', kind: '', refine: '', project: '', sort: 'created_desc', view: 'card', trash: false };
const LB = { items: [IMG, VID], index: 0, zoom: 0, nat: null };

/**
 * ⚠️ **槽位是「按位置」喂的** —— 顺序必须与 `PanelInner` 里 `useState` 的调用顺序一致。
 * 与 `client-render.test.mjs` 同一套口径（那边也有同样的队列；改组件 hook 结构两边都要动）：
 *   0  sData · 1 sFilters · 2 sDetail · 3 sToast · 4 sSessionOnly · 5 sChanges
 *   6  sSettings · 7 sProject · 8 sPanelSel · 9 sRefineUndo · 10 sArtMenu · **11 sLightbox**
 * 本文件**只喂前 12 个**（其余让假 React 用组件自己的初值），因为 C1/C2/C3 只关心
 * 浮层与抽屉，多喂反而会被后续 hook 结构变化牵连。
 * ⚠️ 千万别去改那个文件的 states 数组（那是 Lead 的文件），这里自成一套。
 */
function slotsFor(extra) {
  const e = extra || {};
  return [
    sampleData,                                    // 0 sData
    filters,                                       // 1 sFilters
    e.detail !== undefined ? e.detail : null,      // 2 sDetail ← 抽屉
    '',                                            // 3 sToast
    false,                                         // 4 sSessionOnly
    null,                                          // 5 sChanges
    null,                                          // 6 sSettings
    null,                                          // 7 sProject
    { ids: {}, anchor: -1 },                       // 8 sPanelSel
    null,                                          // 9 sRefineUndo
    null,                                          // 10 sArtMenu
    e.lightbox !== undefined ? e.lightbox : null,  // 11 sLightbox ← 浮层
  ];
}

const lbNode = (m) => m.nodes.find((n) => cls(n) === 'alf__lb');
const drawerNode = (m) => m.nodes.find((n) => cls(n).split(/\s+/).indexOf('alf__drawer') >= 0);
/**
 * 「点了之后把浮层关掉」的唯一凭据：**第 12 个槽位**（`sLightbox`）的 setter 收到了 `null`。
 * ⚠️ 判据**必须限定槽位**，不能写成「有任何一个 setter 收到 null 就算关」——
 *    那样别的状态恰好被置 null 时这条会假绿（本仓库栽过这种「判据过宽」）。
 *    槽位号由 §1 校准①钉住（喂到第 12 位才渲染出浮层）。
 */
const LIGHTBOX_SLOT = 11;
const closesLightbox = (react) => react.__stats.setCalls.some((c) => c.slot === LIGHTBOX_SLOT && c.value === null);

// ══════════════════════════════════════════════════════════════════════════
// §1 校准：槽位对不对（**先证明输入切对了**，否则下面全建在错的输入上）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 校准：状态槽位（喂错位置 ⇒ 下面全错，所以先验）──');

const calibLb = mount(src, slotsFor({ lightbox: LB }));
console.log('  喂 lightbox 到第 12 位 → 浮层:', lbNode(calibLb) ? '渲染出来了' : '没渲染',
  '| 抽屉:', drawerNode(calibLb) ? '有' : '无');

check('★ 校准①：浮层状态在第 12 个槽位（喂对了才渲染出 `alf__lb`）', () => {
  assert(calibLb.react.__stats.slotInits.length >= 12,
    'PanelInner 只调用了 ' + calibLb.react.__stats.slotInits.length + ' 次 useState（< 12），槽位模型不成立');
  assert(calibLb.react.__stats.slotInits[11] === null,
    '第 12 个 useState 的初值不是 null（是 ' + JSON.stringify(calibLb.react.__stats.slotInits[11]) + '）—— '
    + 'sLightbox 的初值该是 null（"关着"），槽位可能已经位移');
  assert(lbNode(calibLb),
    '★ 把浮层状态喂到第 12 个 useState 槽位却没渲染出 `alf__lb` —— '
    + '说明 `PanelInner` 的 hook 顺序变了（或浮层的 class 名变了）。'
    + '本文件所有断言都建立在「槽位 11 = sLightbox」上，槽位错了下面全是假结果，请先重新校准 slotsFor()。');
});

check('★ 校准②（反向）：把浮层状态喂到**第 3 位**（抽屉）⇒ 不该渲染出浮层', () => {
  // 反向对照：证明「浮层渲染出来」**确实**来自第 12 位，而不是随便哪个槽位都能喂出来。
  const wrong = mount(src, slotsFor({ detail: LB, lightbox: null }));
  assert(!lbNode(wrong),
    '★ 把浮层状态喂到抽屉的槽位也渲染出了浮层 —— 上一条"校准"是空转的（喂哪都能过）');
  assert(drawerNode(wrong),
    '★ 把记录喂到第 3 位（sDetail）却没渲染出抽屉 —— 抽屉的槽位也变了，请同步校准 slotsFor()');
});

check('★ 校准③：两个监听器真的注册上了（capture 阶段 / document）', () => {
  // ⚠️ 这条防的是「effect 没跑 ⇒ 派发事件时一个监听器都没有 ⇒ 断言全空转」。
  const both = mount(src, slotsFor({ detail: IMG, lightbox: LB }));
  const caps = both.doc.__listeners.filter((l) => l.type === 'keydown');
  assert(caps.length >= 2,
    '浮层 + 抽屉都开着，document 上却只有 ' + caps.length + ' 个 keydown 监听器（应 ≥2：抽屉一个、浮层一个）'
    + ' —— effect 没跑起来的话，后面所有"派发 Esc"的断言都是空转的');
  assert(caps.every((l) => l.capture === true),
    '有 keydown 监听器没挂 capture 阶段（第三参不是 true）：' + JSON.stringify(caps.map((l) => l.capture))
    + ' —— 抽屉与浮层都该用 capture，否则会被更早的 bubble 处理器抢走');
});

check('★ 校准④：监听器没有一轮一轮堆积（假 React 的 cleanup 真的在跑）', () => {
  // ⚠️ 这条是**防假绿**的：mount 会渲染好几轮，若 effect cleanup 不跑，
  //    document 上会挂着一堆陈旧监听器 —— 派发一次 Esc 会命中好几个，
  //    「抽屉被关了几次」这类断言就全成了在测一个假的世界。
  //    两层都开、结构稳定时，正确的清理结果是**恰好 2 个**（抽屉 + 浮层各一）。
  const both = mount(src, slotsFor({ detail: IMG, lightbox: LB }));
  const caps = both.doc.__listeners.filter((l) => l.type === 'keydown');
  console.log('  两层都开时 document 上的 keydown 监听器:', caps.length, '| effect 重跑次数:', both.react.__stats.effectRuns);
  assert(caps.length === 2,
    '两层都开时 document 上应有**恰好 2 个** keydown 监听器，实际 ' + caps.length
    + ' —— 多了说明 effect cleanup 没跑（监听器堆积，事件会被处理多次）；'
    + '少了说明某个 effect 根本没注册（比如浮层的键盘 effect 没跑）。');
});

// ══════════════════════════════════════════════════════════════════════════
// §1.5 ★★ 漂移守卫：capture 阶段的 Escape 处理器**只有已知那几个**
// ══════════════════════════════════════════════════════════════════════════
// 【为什么必须有这条 —— 由 Linux 侧小琪琪在独立复核里提出，我认了】
//
// F2（`blockEscape` 让路）的确定性，**依赖一个会随新代码漂移的前提**：
//   「在浮层之前，没有别的 capture 阶段 Escape 处理器把事件截掉」。
//
// 机制：同节点（`document`）、同阶段（capture）的监听器**按注册顺序跑**，
//   而 `stopPropagation()` **拦不住同一节点上的兄弟**（见 §0 的分发模型注释）。
//   ⇒ 只要有人新增一个 capture 阶段的 Escape 处理器、且它**先注册**、
//     且它调 `stopPropagation()` —— 浮层就收不到 Esc，「按两下」当场复发。
//
// ⇒ 这条守卫**钉住那张清单**：新增一个 capture 处理器就必须来这里显式登记，
//   并当场回答「它会不会截胡浮层」。**漏登记 = 红**，不会静默漂移。
//
// ⚠️ 这也是本仓库既有的先例：`client-render.test.mjs` 的 `EXPECTED_HOOK_CALLS`
//    就是同一种「总数校准」——**会漂移的结构，用一个会响的数钉住**。
const KNOWN_CAPTURE_HANDLERS = [
  { owner: 'PanelInner', why: '媒体预览浮层自己（最上层，**必须**跑）' },
  { owner: 'SettingsPanel', why: '设置页：面板**整块替换**（early return）⇒ 与浮层不可能同时挂载' },
  { owner: 'ImportPanel', why: '导入页：见下面「已知理论洞」' },
  { owner: 'DetailDrawer', why: '详情抽屉：靠 `blockEscape` 让路' },
];

// ── ⚠️ 已知理论洞：`ImportPanel` 与浮层**理论上能共存**（我审计时发现的，**没修**）──
//
// 与 `SettingsPanel` 不同，`ImportPanel` 是 push 进 `bodyKids` 的（**不是** early return），
// 所以它和面板末尾渲染的浮层**在状态上可以同时为真**。
// 而它的 `onEscKey` 会 `stopPropagation()` 并关掉自己（`lib/client.js:8360`）——
// **若它先注册**（即先挂载），一次 Esc 就只关导入页、浮层收不到 ⇒「按两下」复发。
//
// **为什么现在没修**（如实记，别假装不存在）：
//   ① 实测**UI 上不可达**：`filters["import"] = true` 只有两个来源
//      （工具栏那两个按钮，`lib/client.js:4238` / `:4481`），
//      而浮层是 `position:fixed;inset:0;z-index:60` **全屏覆盖** ——
//      浮层开着时点不到工具栏；反过来导入页显示时**没有卡片可点**（浮层打不开）。
//   ② 修它要么给 `ImportPanel` 也接一根 `blockEscape`（多一层手工接线，
//      正是 F2 的已知代价），要么让浮层在切换视图时自动关闭（改的是别的行为）。
//      两个都不是"顺手改一下"，属于**该单独决策**的事。
//   ⇒ 所以这里**只钉住清单**：真有人加/改了 capture 处理器，这条会红，
//     并强迫当场回答「它会不会先截胡」。**这是把未知风险变成可见风险，不是消除它。**
//
// 📌 给将来的人：如果你正要新增一个 capture 阶段的 Escape 处理器，
//    先读上面这段，再决定是「让它让路」还是「换个阶段」。

/**
 * 扫出源码里所有 **capture 阶段** 的 `keydown` 注册，并判断各自属于哪个组件。
 * @returns {{owner:string, handler:string, line:number}[]}
 */
function scanCaptureKeydown(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  const lines = text.split('\n');
  const re = /addEventListener\(\s*["']keydown["']\s*,\s*([A-Za-z_$][\w$]*)\s*,\s*true\s*\)/;
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(re);
    if (!m) continue;
    // 往回找**最近的** 4 空格缩进 `function X(` —— 那是它所属的组件。
    // ⚠️ 窗口给足 700 行：浮层那个 effect 离 `function PanelInner` 有 ~495 行，
    //    我第一版只给 400 行 ⇒ 归属算成 '?'（**判据自己写错了**，不是代码错）。
    let owner = '?';
    for (let j = i - 1; j >= 0 && j > i - 700; j -= 1) {
      const om = lines[j].match(/^ {4}function ([A-Za-z_$][\w$]*)\(/);
      if (om) { owner = om[1]; break; }
    }
    out.push({ owner, handler: m[1], line: i + 1 });
  }
  return out;
}

check('★★ 漂移守卫：capture 阶段的 Escape 处理器**恰好**是已知那 4 个', () => {
  const found = scanCaptureKeydown(src);
  const got = found.map((f) => f.owner);
  const want = KNOWN_CAPTURE_HANDLERS.map((k) => k.owner);

  // ① 归属必须都认得出来（认不出来就是判据失效，不能当"通过"）
  assert(!got.includes('?'),
    '★ 有 capture 阶段的 keydown 注册**认不出所属组件**（归属算成 "?"）—— '
    + '说明函数声明形态变了（例如改成了 `var X = function` / 箭头函数 / 缩进变了）。'
    + '**这是判据失效，不是通过**：请同步 scanCaptureKeydown() 的归属算法。'
    + '实测位置：' + JSON.stringify(found.filter((f) => f.owner === '?')));

  // ② 数量与归属逐一比对
  assert(got.length === want.length,
    '★★ capture 阶段的 Escape 处理器从 ' + want.length + ' 个变成了 ' + got.length + ' 个。\n'
    + '     现在：' + JSON.stringify(got) + '\n'
    + '     期望：' + JSON.stringify(want) + '\n'
    + '     ⚠️ **新增的那个必须来这里显式登记**（加进 KNOWN_CAPTURE_HANDLERS），'
    + '并当场回答一句：**它会不会在浮层之前把 Esc 截掉？**\n'
    + '     因为 F2（`blockEscape` 让路）的确定性依赖「没有别人先截胡」，'
    + '     而同节点同阶段按注册顺序跑、`stopPropagation()` 拦不住兄弟 ——'
    + '     一个先注册又 stopPropagation 的新处理器，会让「按两下 Esc」当场复发。');
  assert(got.join('|') === want.join('|'),
    '★★ capture 阶段的 Escape 处理器**变了**（数量一样但归属不同）。\n'
    + '     现在：' + JSON.stringify(got) + '\n'
    + '     期望：' + JSON.stringify(want) + '\n'
    + '     ⚠️ 顺序也有意义（同节点同阶段**按注册顺序**跑）：排在前面的会先跑。'
    + '请确认新顺序不会让某个处理器抢在浮层之前把 Esc 截掉。');
});

check('★ 漂移守卫（反向对照）：扫描器**能**数出新增的 capture 处理器（用固定最小源码，与 src 现状无关）', () => {
  // ⚠️ 反向对照必须**独立造**，不能从当前源码 replace 出坏版本 ——
  //    那样一旦源码先坏，替换就找不到锚点，报错会变成「造不出来」（误导）。
  // ⚠️ 也**不能**基于 `src` 拼 —— 我第一版那么写，结果源码里真的多了一个处理器时，
  //    这条会跟着一起红、并报「上面那条守卫是空转的」——**那句话是错的**
  //    （守卫明明抓到了，是这条自己数错了）。**报错信息误导比不报更坏。**
  //    ⇒ 改成喂一个**固定的小源码**，专测扫描器本身。
  const MINI = [
    '    function Alpha(props) {',
    '      React.useEffect(function () {',
    '        function onKey(e) { if (e.key === "Escape") props.onClose(); }',
    '        document.addEventListener("keydown", onKey, true);',
    '        return function () { document.removeEventListener("keydown", onKey, true); };',
    '      }, []);',
    '      return null;',
    '    }',
    '    function Beta(props) {',
    '      React.useEffect(function () {',
    '        function onEsc(e) { if (e.key === "Escape") props.onClose(); }',
    '        document.addEventListener("keydown", onEsc, true);',
    '        return function () { document.removeEventListener("keydown", onEsc, true); };',
    '      }, []);',
    '      return null;',
    '    }',
  ].join('\n');

  const two = scanCaptureKeydown(MINI);
  assert(two.length === 2, '扫描器在固定最小源码上应数出 2 个，实际 ' + two.length
    + ' ⇒ 扫描器本身坏了（那主守卫的"4 个"也不可信）');
  assert(two.map((f) => f.owner).join('|') === 'Alpha|Beta',
    '★ 归属识别错了：' + JSON.stringify(two.map((f) => f.owner)) + '（期望 Alpha|Beta）');

  // 加第三个 ⇒ 必须数出 3
  const three = scanCaptureKeydown(MINI + '\n' + [
    '    function Gamma(props) {',
    '      React.useEffect(function () {',
    '        function onKey(e) { if (e.key === "Escape") props.onClose(); }',
    '        document.addEventListener("keydown", onKey, true);',
    '        return function () { document.removeEventListener("keydown", onKey, true); };',
    '      }, []);',
    '      return null;',
    '    }',
  ].join('\n'));
  assert(three.length === 3,
    '★ 加了一个 capture 处理器后扫描器只数出 ' + three.length + ' 个（期望 3）'
    + ' ⇒ 主守卫抓不到新增 ⇒ **F2 的漂移风险没人看着**');

  // 反向的另一半：**bubble** 阶段的不该被数进来（否则判据过宽、天天误报）
  const withBubble = scanCaptureKeydown(MINI + '\n' + [
    '    function Delta(props) {',
    '      React.useEffect(function () {',
    '        function onKey(e) { if (e.key === "Escape") props.onClose(); }',
    '        document.addEventListener("keydown", onKey);',
    '        return function () { document.removeEventListener("keydown", onKey); };',
    '      }, []);',
    '      return null;',
    '    }',
  ].join('\n'));
  assert(withBubble.length === 2,
    '★ 把 **bubble** 阶段的注册也算进来了（数出 ' + withBubble.length + '，期望 2）'
    + ' ⇒ 判据过宽，会把无害的处理器也判红');
});

check('★ 漂移守卫：输入预处理自检（剥注释真的剥了、且锚点还在）', () => {
  // 本仓库有过「120 条断言全建在没剥干净的源码上」的事故 ⇒ 预处理必须自证。
  assert(CODE.includes('addEventListener'), '★ 剥注释后的源码里没有 addEventListener —— 剥过头了');
  // ⚠️ 反向对照必须挑一个**确实存在于 client.js 注释里**的句子。
  //    我第一版写的是 `'已知理论洞'` —— 那个词只在**本测试文件**里，
  //    client.js 里根本没有 ⇒ `CODE.includes(...)` **永远为 false** ⇒ 断言恒真（空转）。
  //    **这正是本仓库反复栽的「守卫空转」**：它看起来在验预处理，其实什么都没验。
  //    ⇒ 现在这个句子实测：原文有 = true、剥注释后 = false（两个方向都被钉住）。
  const COMMENT_ONLY = '浮层开着时的键盘';
  assert(src.includes(COMMENT_ONLY),
    '★ 拿来做反向对照的句子 `' + COMMENT_ONLY + '` 在 client.js 原文里都找不到 —— '
    + '那下面那句 `CODE.includes` 必然为 false，**断言恒真、什么都没验**（换一句真实存在的注释原文）');
  assert(!CODE.includes(COMMENT_ONLY),
    '★ 剥注释后仍能搜到注释原文 `' + COMMENT_ONLY + '` ⇒ 注释没剥干净，本文件所有静态判据都可能建在错的输入上');
  // 锚点：本文件依赖的那些符号必须还在
  for (const anchor of ['blockEscape', 'MediaLightbox', 'DetailDrawer']) {
    assert(src.includes(anchor), '★ 源码里找不到锚点 `' + anchor + '` —— 组件改名了，请同步本文件');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// §2 C1：浮层 + 抽屉都开着 ⇒ 一次 Esc 只关浮层
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── C1：两层同时开着，一次 Esc 只关最上面那层 ──');

/**
 * 造一个「两层都开」的场景。
 * `drawerClosed` 取的是 **`DetailDrawer` 组件元素**上的 `props.onClose` —— 它就是组件里那个
 * 「抽屉被关掉」的唯一凭据（调用方传的是 `function(){ setDetail(null) }`）。
 * ⚠️ **不能**从 DOM 节点上找：`onClose` 是 React 回调，不是 HTML 属性，
 *    渲染出来的 `alf__drawer` 节点上根本没有它（我第一版就是这么写错的）。
 * ⚠️ 而且**必须包在 mount 之前**：抽屉的 Escape 监听器在 effect 里注册时**闭包捕获**了
 *    当时那个 `props.onClose`。渲染之后再换元素上的 prop，监听器用的还是旧函数 —— 白包。
 */
function twoLayer(source) {
  // ⚠️ 计数必须包在**渲染之前**：抽屉的 Escape 监听器在 effect 里注册时**闭包捕获**了
  //    当时那个 `props.onClose`。渲染之后再换元素上的 prop，监听器用的还是旧函数 —— 白包。
  // ⚠️ 计数器挂在 `react` 上（不是 handle 上）：C1c 会 remount，handle 是新的，
  //    而计数器必须活过重渲染 —— 它记的是「抽屉被关了几次」这件事本身。
  //    `patchProps` 里不能直接引用下面那个 `m`（TDZ），所以在回调里自己抓 react。
  const box = { react: null };
  const m = mount(source, slotsFor({ detail: IMG, lightbox: LB }), null, (type, props) => {
    if (type.name !== 'DetailDrawer') return props;
    const patched = Object.assign({}, props || {});
    const original = patched.onClose;
    patched.onClose = function () {
      // 调用发生在 mount 之后（effect 注册的监听器触发时），`box.react` 那时已经填好了
      if (box.react) box.react.__drawerClosed = (box.react.__drawerClosed || 0) + 1;
      return typeof original === 'function' ? original.apply(this, arguments) : undefined;
    };
    return patched;
  });
  box.react = m.react;
  const d = drawerNode(m);
  const lb = lbNode(m);
  assert(d && lb, '两层没同时渲染出来（抽屉:' + !!d + ' 浮层:' + !!lb + '）—— 本用例的前提不成立');
  assert(findEl(m, 'DetailDrawer'),
    '找不到 DetailDrawer 组件元素（抽屉的组件名变了？判据前提失效，请同步本文件）');
  return { m, drawerClosed: () => box.react.__drawerClosed || 0 };
}

const c1 = twoLayer(src);
const c1called = dispatchKeydown(c1.m.doc, 'Escape');
console.log('  Esc 后被调用的监听器:', c1called.length,
  '| 抽屉 onClose 次数:', c1.drawerClosed(),
  '| 浮层 setter 收到 null:', closesLightbox(c1.m.react));

check('C1a 一次 Esc ⇒ 浮层收到关闭（setLightbox(null)）', () => {
  assert(closesLightbox(c1.m.react),
    '★ 按了一次 Esc，浮层**没有**收到关闭（渲染树上没有任何 `setLightbox(null)`）—— '
    + '两层都开着时 Esc 到不了浮层。依琪报的「要按两下才退」就是这个症状：'
    + '第一下被下层的 capture 监听器吃掉并 stopPropagation 了。');
});

check('C1b 同一次 Esc ⇒ 抽屉**保持打开**（onClose 一次都没被调）', () => {
  assert(c1.drawerClosed() === 0,
    '★ 一次 Esc 把**抽屉也**关掉了（onClose 被调 ' + c1.drawerClosed() + ' 次）—— '
    + '契约是「只关最上层」：浮层叠在抽屉上面，第一下只该关浮层，抽屉要留着。'
    + '（这正是"按一次关一层"的反面症状，用户在浮层里按 Esc 会连抽屉一起丢掉。）');
});

/**
 * C1 的第二半：**第二下** Esc 才关抽屉。
 * 为什么必须验它：如果实现是「浮层干脆不管 Esc、让抽屉先关」，那 C1b 也能过，
 * 但用户会看到「第一下关抽屉、浮层还在上面」—— 依然是坏的。
 * 这里先把浮层关掉（模拟第一次派发产生的状态变更 + 它自己的 effect cleanup 摘监听器），
 * 再派发第二次。
 */
check('C1c 第一次 Esc 之后，**第二次** Esc 才轮到抽屉（且它真的被关）', () => {
  const t = twoLayer(src);
  dispatchKeydown(t.m.doc, 'Escape');           // 第一下：应只关浮层
  assert(t.drawerClosed() === 0, '前提不成立：第一下就把抽屉关了（见 C1b）');
  assert(closesLightbox(t.m.react), '第一下没有产生 setLightbox(null)，无法推进到第二下');

  // 模拟 React 因 setLightbox(null) 重渲染：把浮层槽位置 null，重渲染 + 重跑 effect
  const slot = t.m.react.__stats.setCalls.filter((c) => c.value === null).pop().slot;
  t.m.react.__values[slot] = null;
  const reopened = remount(t.m, src);
  assert(!lbNode(reopened), '把浮层状态置 null 后浮层仍渲染着 —— 重渲染没生效，第二下无从验起');
  const second = dispatchKeydown(reopened.doc, 'Escape');
  console.log('  第二下 Esc 后被调用的监听器:', second.length, '| 抽屉 onClose 累计:', t.drawerClosed());
  assert(t.drawerClosed() >= 1,
    '★ 浮层关掉之后再按 Esc，抽屉**没有**关闭（onClose 累计 ' + t.drawerClosed() + ' 次）—— '
    + '要么抽屉的 Escape 监听器在浮层关闭时被一起摘掉了，要么它的让路判断（blockEscape 之类）'
    + '没有随浮层关闭而恢复。用户按第二下会「没反应」。');
});

// ══════════════════════════════════════════════════════════════════════════
// §3 C2：只有浮层 ⇒ 一次 Esc 关浮层
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── C2：只有浮层 ──');
const c2 = mount(src, slotsFor({ lightbox: LB }));
const c2called = dispatchKeydown(c2.doc, 'Escape');
console.log('  Esc 后被调用的监听器:', c2called.length, '| 浮层关闭:', closesLightbox(c2.react));

check('C2 只有浮层时，一次 Esc 关浮层', () => {
  assert(lbNode(c2), '前提不成立：浮层没渲染出来');
  assert(closesLightbox(c2.react),
    '★ 只有浮层（没有抽屉）时按 Esc，浮层没关 —— 最简单的场景都失效了');
});

// ══════════════════════════════════════════════════════════════════════════
// §4 C3：ArrowLeft / ArrowRight 不外泄给下层
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── C3：左右键不外泄 ──');

/**
 * 「下层处理器」用**真**监听器扮演：往同一个 `document` 上挂一个 bubble 阶段的 spy。
 * 为什么用 bubble 而不是 capture：浮层挂在 capture，而 capture 阶段的兄弟监听器
 * **不受 stopPropagation 影响**（同节点不拦兄弟），所以只有 bubble 阶段才能
 * 如实反映「事件有没有被放行到下面去」—— 这正是契约里「不外泄」的意思。
 */
function arrowLeak(source) {
  const m = mount(source, slotsFor({ detail: IMG, lightbox: LB }));
  const spyCalls = [];
  const spy = (event) => spyCalls.push(event.key);
  m.doc.addEventListener('keydown', spy);
  const before = m.react.__stats.setCalls.length;
  dispatchKeydown(m.doc, 'ArrowLeft');
  dispatchKeydown(m.doc, 'ArrowRight');
  const setterCalls = m.react.__stats.setCalls.slice(before).filter((c) => c.slot === LIGHTBOX_SLOT);
  return { m, spyCalls, setterCalls };
}
/**
 * 把浮层 setter 收到的更新**真的应用一遍**（喂当前状态，取出结果）。
 * 为什么要这样算：`setLightbox(function (cur) { … })` 传进来的是**更新函数**，
 * 只看「setter 被调过」是**看不出有没有真的切条**的 —— 一个 `return current;`
 * 的空更新同样会让 setter 被调。契约要的是「← → 真的切上一条/下一条」。
 */
const applyUpdates = (setterCalls, from) => setterCalls.map((c) => (typeof c.value === 'function' ? c.value(from) : c.value));
const leak = arrowLeak(src);
console.log('  ArrowLeft/Right → 下层 bubble spy 收到:', JSON.stringify(leak.spyCalls),
  '| 浮层 setter 被调:', leak.setterCalls.length,
  '| 应用后的 index:', JSON.stringify(applyUpdates(leak.setterCalls, LB).map((s) => (s ? s.index : null))));

check('C3a 浮层的 ArrowLeft/ArrowRight **没有**漏给下层（bubble spy 一次都没响）', () => {
  assert(leak.spyCalls.length === 0,
    '★ 浮层里的左右键漏到了下层处理器（bubble spy 收到 ' + JSON.stringify(leak.spyCalls) + '）—— '
    + '用户在浮层里按 ← → 切图时，底下的目录/列表**也会跟着动**（浮层与底层同时响应，状态错乱）。');
});

check('C3b（正向）左右键**真的切了条**（不是"谁都没理它"，也不是空更新）', () => {
  // ⚠️ 正向对照有两层意思，缺一不可：
  //   ① 浮层确实处理了这两个键（否则 C3a 会因为"没人管"而假绿）；
  //   ② 处理的结果是**真的换了 index**（只验"setter 被调过"挡不住 `return current;` 那种空更新）。
  const results = applyUpdates(leak.setterCalls, LB);
  assert(results.length >= 2,
    '★ 按了两次左右键，浮层（第 ' + (LIGHTBOX_SLOT + 1) + ' 个槽位）的 setter 只被调了 ' + results.length + ' 次 —— '
    + '浮层自己没处理左右键（那 C3a 的"没外泄"是假绿：不是拦住了，是根本没人管）。');
  const indexes = results.map((s) => (s ? s.index : null));
  assert(indexes[0] === 0, '★ 第 0 条时按 ← 应**停在 0**（到头不循环），实际切到了 index=' + indexes[0]);
  assert(indexes[1] === 1, '★ 第 0 条时按 → 应切到 index=1（真的换了一条），实际 ' + indexes[1]
    + ' —— 左右键被"处理"了但没换条（比如空更新），用户按了没反应。');
});

// ── C1 的第三条：Esc 本身也不许漏到下层 ────────────────────────────────────
/**
 * 为什么把它算在 C1 里：契约是「**一次** Esc **只**关浮层」——「只」有两个方向：
 *   ① 不许把抽屉也关掉（C1b 管这个）；
 *   ② 不许再惊动**别的**处理器（底下列表的「Esc 清空多选」、右键菜单、finder 等）。
 * 少了 ②，「只关浮层」就只是"抽屉恰好没关"，下层照样会被同一次按键打扰。
 * ⚠️ 这条**不能**靠读源码里有没有 `stopPropagation` 来判（本仓库栽过），
 *    必须真的派发一次，看 bubble 阶段的下层 spy 有没有响。
 */
function escLeak(source) {
  const m = mount(source, slotsFor({ detail: IMG, lightbox: LB }));
  const spyCalls = [];
  m.doc.addEventListener('keydown', (event) => spyCalls.push(event.key));
  dispatchKeydown(m.doc, 'Escape');
  return { m, spyCalls };
}
const escLeaked = escLeak(src);
console.log('  Escape → 下层 bubble spy 收到:', JSON.stringify(escLeaked.spyCalls));

check('C1d 一次 Esc **没有**漏给下层处理器（bubble spy 一次都没响）', () => {
  assert(escLeaked.spyCalls.length === 0,
    '★ 浮层里的 Esc 漏到了下层处理器（bubble spy 收到 ' + JSON.stringify(escLeaked.spyCalls) + '）—— '
    + '用户只想关掉浮层，底下的列表/菜单却跟着响应了（比如多选被清空、右键菜单被关）。'
    + '「只关浮层」的"只"要求这一次按键到此为止。');
});

// ══════════════════════════════════════════════════════════════════════════
// §5 C4：× 按钮（aria-label + 能关）与文字「关闭」按钮
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── C4：鼠标关闭入口 ──');
const c4 = mount(src, slotsFor({ lightbox: LB }));
const c4el = findEl(c4, 'MediaLightbox');
const c4lb = lbNode(c4);
const xBtn = c4el ? btnByText(c4el, '×') : null;
const txtBtn = c4el ? btnByText(c4el, '关闭') : null;

check('C4a 浮层里有 × 按钮，且带 aria-label（读屏听得到它是什么）', () => {
  assert(c4lb, '前提不成立：浮层没渲染出来');
  assert(c4el, '找不到 MediaLightbox 组件元素（组件名变了？请同步本文件）');
  assert(xBtn, '★ 浮层里找不到 × 按钮 —— 依琪要的「有个 xx 给鼠标点，而不是光按 esc」没兑现');
  assert(xBtn.props['aria-label'],
    '★ × 按钮没有 aria-label —— 读屏用户听到的只有「×」这个符号，不知道它是关闭。'
    + '（× 是**形状**，不是可访问名。）');
});

check('C4b 点 × 真的能关浮层', () => {
  assert(xBtn, '前提不成立：没有 × 按钮');
  assert(typeof xBtn.props.onClick === 'function', '★ × 按钮没有 onClick —— 点了没反应');
  const before = c4.react.__stats.setCalls.length;
  xBtn.props.onClick({ target: xBtn, currentTarget: xBtn });
  const calls = c4.react.__stats.setCalls.slice(before);
  assert(calls.some((c) => c.value === null),
    '★ 点了 × 之后浮层没有收到关闭（setCalls=' + JSON.stringify(calls) + '）—— 鼠标用户被卡在浮层里');
});

check('C4c 文字「关闭」按钮**仍然保留**（× 不能取而代之）', () => {
  assert(txtBtn,
    '★ 文字「关闭」按钮被删了 —— × 对读屏用户没有意义（不是可访问名），'
    + '两者不是二选一：× 给鼠标习惯，文字给显式标签。');
  assert(typeof txtBtn.props.onClick === 'function', '★ 文字「关闭」按钮没有 onClick —— 点了没反应');
});

// ══════════════════════════════════════════════════════════════════════════
// §6 变异测试：每条守卫都必须**能红**
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 变异测试（把已知有病的版本喂进来，确认对应守卫会红）──');

/** 按字面量替换造变异体；替换没生效就**当场报错**（否则「变异测试」本身是空转）。 */
function mutate(source, edits, label) {
  let out = source;
  for (const [from, to] of edits) {
    assert(out.includes(from), '变异「' + label + '」的锚点找不到：' + JSON.stringify(from.slice(0, 90))
      + ' —— 源码变了，请同步更新变异定义（找不到锚点 = 变异没生效 = 这条变异测试是空转的）');
    out = out.replace(from, to);
  }
  assert(out !== source, '变异「' + label + '」没有改变源码');
  return out;
}

/** 在给定源码上跑一遍四条守卫，返回「哪几条红了」。 */
function runGuards(source) {
  const red = new Set();
  const guard = (name, fn) => { try { fn(); } catch (error) { red.add(name); } };

  const c1m = twoLayer(source);
  dispatchKeydown(c1m.m.doc, 'Escape');
  guard('C1a', () => assert(closesLightbox(c1m.m.react), '浮层没关'));
  guard('C1b', () => assert(c1m.drawerClosed() === 0, '抽屉被一起关了'));
  guard('C1c', () => {
    const t = twoLayer(source);
    dispatchKeydown(t.m.doc, 'Escape');
    if (t.drawerClosed() !== 0) throw new Error('第一下就关了抽屉');
    if (!closesLightbox(t.m.react)) throw new Error('第一下没关浮层');
    const slot = t.m.react.__stats.setCalls.filter((c) => c.value === null).pop().slot;
    t.m.react.__values[slot] = null;
    const reopened = remount(t.m, source);
    if (lbNode(reopened)) throw new Error('浮层没被置空');
    dispatchKeydown(reopened.doc, 'Escape');
    if (t.drawerClosed() < 1) throw new Error('第二下没关抽屉');
  });

  const c2m = mount(source, slotsFor({ lightbox: LB }));
  guard('C2', () => {
    dispatchKeydown(c2m.doc, 'Escape');
    assert(closesLightbox(c2m.react), '浮层没关');
  });

  const lk = arrowLeak(source);
  guard('C3a', () => assert(lk.spyCalls.length === 0, '左右键外泄了'));
  guard('C3b', () => {
    const results = applyUpdates(lk.setterCalls, LB);
    assert(results.length >= 2, '浮层没处理左右键');
    const indexes = results.map((s) => (s ? s.index : null));
    assert(indexes[0] === 0 && indexes[1] === 1, '左右键没真的切条: ' + JSON.stringify(indexes));
  });

  const el = escLeak(source);
  guard('C1d', () => assert(el.spyCalls.length === 0, 'Esc 外泄了'));

  const c4m = mount(source, slotsFor({ lightbox: LB }));
  const c4el = findEl(c4m, 'MediaLightbox');
  const x = c4el ? btnByText(c4el, '×') : null;
  const t = c4el ? btnByText(c4el, '关闭') : null;
  guard('C4a', () => {
    assert(x, '没有 × 按钮');
    assert(x.props['aria-label'], '× 没有 aria-label');
  });
  guard('C4b', () => {
    assert(x && typeof x.props.onClick === 'function', '× 点不动');
    const before = c4m.react.__stats.setCalls.length;
    x.props.onClick({});
    assert(c4m.react.__stats.setCalls.slice(before).some((c) => c.value === null), '× 关不掉浮层');
  });
  guard('C4c', () => {
    assert(t, '文字「关闭」按钮没了');
    assert(typeof t.props.onClick === 'function', '文字按钮点不动');
  });

  return red;
}

// ── 变异定义 ──────────────────────────────────────────────────────────────
/**
 * ⚠️ 需要**按上下文锚定**的变异单独写函数（不能全文替换）：
 *    本仓库栽过「切太宽」—— 紧跟 Escape 分支的 Arrow 分支里也有 `stopPropagation`，
 *    全文替换会把两处一起删掉，于是"删了 Escape 那句也不红"的假绿就出现了。
 */
function mutationDrawerNoYield(source) {
  const from = 'if (props.blockEscape) return;';
  assert(source.includes(from), 'M1 锚点 `if (props.blockEscape) return;` 找不到'
    + '（抽屉的"让路"实现换写法了？那这条变异要跟着改，别静默跳过）');
  return source.replace(from, 'void 0;');
}
function mutationEscNoStop(source) {
  const at = source.indexOf('setLightbox(null);');
  assert(at >= 0, 'M2 锚点 `setLightbox(null)` 找不到');
  const head = source.slice(0, at);
  const stopAt = head.lastIndexOf('event.stopPropagation()');
  assert(stopAt >= 0, 'M2：`setLightbox(null)` 之前找不到 stopPropagation（浮层 Escape 分支形态变了？）');
  assert(at - stopAt < 300, 'M2：最近那个 stopPropagation 离 `setLightbox(null)` 有 ' + (at - stopAt) + ' 字符，锚点可疑');
  return source.slice(0, stopAt) + 'void 0' + source.slice(stopAt + 'event.stopPropagation()'.length);
}
function mutationArrowNoStop(source) {
  const at = source.indexOf('key === "ArrowRight" ? 1 : -1');
  assert(at >= 0, 'M3 锚点 `key === "ArrowRight" ? 1 : -1` 找不到');
  const stopAt = source.lastIndexOf('event.stopPropagation()', at);
  assert(stopAt >= 0 && at - stopAt < 300, 'M3：Arrow 分支前的 stopPropagation 锚点可疑');
  return source.slice(0, stopAt) + 'void 0' + source.slice(stopAt + 'event.stopPropagation()'.length);
}
function mutationEscBranchGone(source) {
  const at = source.indexOf('if (key === "Escape") {');
  assert(at >= 0, 'M5 锚点 `if (key === "Escape") {` 找不到');
  const end = source.indexOf('if (key !== "ArrowLeft"', at);
  assert(end > at, 'M5：找不到 Escape 分支的结束位置（下一个分支 `if (key !== "ArrowLeft"`）');
  return source.slice(0, at) + 'if (false) { } ' + source.slice(end);
}
function mutationXNoLabel(source) {
  const from = '"aria-label": "关闭预览",';
  assert(source.includes(from), 'M6 锚点 `"aria-label": "关闭预览"` 找不到');
  return source.replace(from, '');
}
function mutationXNoClick(source) {
  const at = source.indexOf('NS + "__lbx"');
  assert(at >= 0, 'M7 锚点 `NS + "__lbx"` 找不到');
  const handler = 'onClick: function () { if (typeof props.onClose === "function") props.onClose(); }';
  const clickAt = source.indexOf(handler, at);
  assert(clickAt > at, 'M7：× 按钮之后找不到它的 onClick');
  // ⚠️ 替换成 `onClick: null,` 而**不是** `void 0` —— 后者会把对象字面量写成
  //    `{ type: "button", void 0, }`，那是**语法错误**，变异体会直接抛 SyntaxError，
  //    于是「变异测试」测的是解析失败而不是守卫（我第一版就这么踩了）。
  return source.slice(0, clickAt) + 'onClick: null' + source.slice(clickAt + handler.length);
}
function mutationTextBtnGone(source) {
  // 锚点 `}, "关闭")),` 里的 **两个** `)` 分别是：关掉文字按钮自己、关掉外层 `__lbhead`。
  // ⇒ 替换成 `null),`（而不是 `null`）：**保留**外层那个右括号与逗号，
  //    否则会漏掉 `h("div", __lbhead, …)` 的收尾 ⇒ 变异体是**语法错误**，
  //    变异测试就变成了在测「解析失败」而不是测守卫（我第一版就是这么踩的）。
  const tail = '}, "关闭")),';
  const at = source.indexOf(tail);
  assert(at >= 0, 'M8 锚点 `' + tail + '` 找不到');
  const start = source.lastIndexOf('h("button", {', at);
  assert(start >= 0, 'M8：找不到文字按钮的 h("button" 起点');
  return source.slice(0, start) + 'null),' + source.slice(at + tail.length);
}
function mutationLightboxOnCloseDead(source) {
  const from = 'onClose: function () { setLightbox(null); }';
  assert(source.includes(from), 'M9 锚点 `' + from + '` 找不到');
  return source.replace(from, 'onClose: function () { void 0; }');
}

const VARIANTS = [
  { id: 'M1', expectRed: 'C1b', why: '抽屉不再为上层让路 ⇒ 第一下 Esc 把抽屉也关了',
    build: mutationDrawerNoYield },
  { id: 'M2', expectRed: 'C1d', why: '浮层 Escape 分支不再 stopPropagation ⇒ 事件放行到 bubble 阶段的下层处理器',
    build: mutationEscNoStop },
  { id: 'M3', expectRed: 'C3a', why: '浮层左右键分支不再 stopPropagation ⇒ 底下列表跟着翻',
    build: mutationArrowNoStop },
  { id: 'M4', expectRed: 'C3b', why: '浮层只认 ArrowRight（左键没人管）⇒ C3a 会假绿，靠 C3b 抓',
    build: (s) => mutate(s, [['if (key !== "ArrowLeft" && key !== "ArrowRight") return;', 'if (key !== "ArrowRight") return;']], 'M4') },
  { id: 'M5', expectRed: 'C2', why: '浮层干脆不响应 Escape ⇒ 浮层关不掉',
    build: mutationEscBranchGone },
  { id: 'M6', expectRed: 'C4a', why: '× 按钮的 aria-label 被删 ⇒ 读屏用户听到的只有「×」',
    build: mutationXNoLabel },
  { id: 'M7', expectRed: 'C4b', why: '× 按钮的 onClick 被删 ⇒ 鼠标用户点不动',
    build: mutationXNoClick },
  { id: 'M8', expectRed: 'C4c', why: '文字「关闭」按钮被删 ⇒ 只剩读屏无意义的 ×',
    build: mutationTextBtnGone },
  { id: 'M9', expectRed: 'C4b', why: '浮层 onClose 变空函数 ⇒ 按钮在、却关不掉',
    build: mutationLightboxOnCloseDead },
  { id: 'M10', expectRed: 'C3b', why: '左右键"处理了但没换条"（更新算出来还是原来那条）⇒ 按了没反应',
    build: (s) => mutate(s, [['var next = current.index + (key === "ArrowRight" ? 1 : -1);', 'var next = current.index;']], 'M10') },
];

// 基准：正确实现上所有守卫必须绿（否则"变异红"说明不了任何事）
const baseRed = runGuards(src);
console.log('  基准（当前 lib/client.js）红掉的守卫:', baseRed.size ? [...baseRed].join(',') : '（无）');
check('★ 基准：四条守卫在当前源码上全绿（否则下面的"变异红"没有意义）', () => {
  assert(baseRed.size === 0,
    '当前 lib/client.js 在 ' + [...baseRed].join('/') + ' 上已经红了 —— 契约没被满足（或本文件的 harness 坏了）。'
    + '先修产品 / 修 harness，再看变异结果。');
});

const mutationResults = [];
for (const v of VARIANTS) {
  const broken = v.build(src);
  assert(broken !== src, '变异 ' + v.id + ' 没改变源码（变异测试本身空转）');
  // ⚠️ **先证明变异体是能跑的 JS**：如果替换把对象字面量写坏了，
  //    `runGuards` 会抛 SyntaxError —— 那测的是「解析失败」而不是守卫，
  //    而且会让整个文件崩掉（我第一版就踩了两次）。这里显式拦一道。
  let parseError = null;
  try { new vm.Script(broken); } catch (error) { parseError = error; }
  if (parseError) {
    mutationResults.push({ id: v.id, expectRed: v.expectRed, red: new Set(), hit: false, parseError });
    console.log('  FAIL ' + v.id + ' → 变异体是**语法错误**（' + parseError.message + '）—— 这条变异没在测守卫');
    continue;
  }
  const red = runGuards(broken);
  const hit = red.has(v.expectRed);
  mutationResults.push({ id: v.id, expectRed: v.expectRed, red, hit });
  console.log('  ' + (hit ? 'ok  ' : 'FAIL') + ' ' + v.id + ' → 期望红: ' + v.expectRed
    + ' / 实测红: ' + (red.size ? [...red].join(',') : '（无！）'));
}
for (const r of mutationResults) {
  check('变异 ' + r.id + ' ⇒ 守卫 ' + r.expectRed + ' 必须红（' + (VARIANTS.find((v) => v.id === r.id).why) + '）', () => {
    assert(!r.parseError,
      '★ 变异 ' + r.id + ' 造出来的不是合法 JS（' + (r.parseError && r.parseError.message) + '）—— '
      + '这条变异根本没跑到守卫上，等于没验。请修变异定义（多半是替换时吃掉了不该吃的括号/逗号）。');
    assert(r.hit,
      '★ 把源码改成已知有病的版本之后，守卫 ' + r.expectRed + ' **没有红** —— '
      + '这条守卫是空转的（它测不出它声称要测的缺陷）。实测红的是：'
      + (r.red.size ? [...r.red].join(',') : '（一条都没有）'));
  });
}

// ══════════════════════════════════════════════════════════════════════════
// §7 输入预处理自检（本仓库栽过「120 条断言全建在没剥干净的源码上」）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n── 输入预处理自检 ──');
check('★ 剥注释后的源码仍含本文件依赖的锚点（切片没切错）', () => {
  const anchors = ['setLightbox', 'returnFocusTo', 'addEventListener("keydown", onKey, true)', 'NS + "__lbx"', '}, "关闭")),'];
  const missing = anchors.filter((a) => !CODE.includes(a));
  assert(missing.length === 0,
    '剥注释后这些锚点不见了：' + missing.join(' | ')
    + ' —— 本文件的静态/变异判据可能建在错的输入上（注释里提到不算数）');
});
check('★ 反向对照：剥注释确实剥掉了注释（拿一句注释原文去搜必须搜不到）', () => {
  const commentOnly = '纯展示组件，一个 hook 都不用';
  assert(src.includes(commentOnly), '反向对照的前提不成立：源码里找不到那句注释原文（注释被改过了？）');
  assert(!CODE.includes(commentOnly), '★ 剥注释没生效（注释原文还在 CODE 里）—— 静态判据会把注释当实现');
});

if (failureList.length) {
  console.log('\n── 失败清单 ──');
  for (const f of failureList) console.log('      · ' + f.name + ' -> ' + f.message);
}
console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);

// ══════════════════════════════════════════════════════════════════════════
// 变异对照表（「改哪一处 ⇒ 哪条守卫必须红」）—— 实测结果见运行输出
// ══════════════════════════════════════════════════════════════════════════
// 守卫 ↔ 契约的对应：
//   C1a 浮层收到关闭 · C1b 抽屉没被一起关 · C1c 第二下才轮到抽屉 · C1d Esc 不外泄
//   C2 只有浮层时一次 Esc 关掉 · C3a 左右键不外泄 · C3b 左右键真的切了条
//   C4a × 有 aria-label · C4b 点 × 能关 · C4c 文字「关闭」按钮还在
//
// M1 抽屉的 `if (props.blockEscape) return;` → `void 0;`
//      ⇒ 期望红 **C1b**（第一下 Esc 把抽屉也关了），实测连带 C1c。
//        若哪天抽屉的"让路"换了写法，M1 的 build() 会**当场报错**（锚点找不到）——
//        那是**有意的**：宁可红，也别静默跳过（静默跳过 = 这条变异变成空转）。
// M2 浮层 Escape 分支里的 `event.stopPropagation()`（锚点 `setLightbox(null)` 往前最近一处）→ `void 0`
//      ⇒ 期望红 **C1d**（Esc 被放行到 bubble 阶段的下层处理器）。
//        ⚠️ 它**不该**让 C1b 红：抽屉若有显式让路，浮层放行也关不掉抽屉 —— 这正是
//        「两条独立防线」的意思，本文件不把 C1b 押在 stopPropagation 上。
//        ⚠️ 只删 Escape 那一处（锚点往前最近），Arrow 那处留着 —— 反向验「切太宽」。
// M3 浮层 Arrow 分支里的 `event.stopPropagation()`（锚点 `key === "ArrowRight" ? 1 : -1`）→ `void 0`
//      ⇒ 期望红 **C3a**（左右键外泄），实测**只红 C3a**（Escape 那处没被误伤）。
// M4 `if (key !== "ArrowLeft" && key !== "ArrowRight") return;` → 只认 ArrowRight
//      ⇒ 期望红 **C3b**（浮层没处理 ArrowLeft，index 序列不是 [0,1]）。
//        ⚠️ 实测 **C3a 也红**（ArrowLeft 没人拦，放行到下层）—— 所以 M4 **不能**单独
//        证明 C3b 的必要性；C3b 真正防的是「处理了但没换条」那种（见 M10）。
// M10 `var next = current.index + (key === "ArrowRight" ? 1 : -1);` → `var next = current.index;`
//      ⇒ 期望红 **C3b**，实测**只红 C3b** —— 这条才是 C3b 的**隔离**变异：
//        左右键仍然被拦（C3a 绿）、setter 仍然被调，但算出来的还是原来那条
//        （用户按了没反应）。只验「setter 被调过」的判据在这里会假绿，所以 C3b
//        必须**把更新函数真的应用一遍**看 index 变没变。
// M5 浮层 Escape 分支整段 `if (key === "Escape") { … }` → `if (false) { }`
//      ⇒ 期望红 **C2**（浮层关不掉），实测连带 C1a/C1c/C1d。
// M6 × 按钮的 `"aria-label": "关闭预览",` 删掉
//      ⇒ 期望红 **C4a**，实测**只红 C4a**（导航按钮的 aria-label 没被误伤）。
// M7 × 按钮的 onClick（锚点 `NS + "__lbx"` 之后第一个）→ `onClick: null`
//      ⇒ 期望红 **C4b**（点了没反应），实测**只红 C4b**（文字按钮不受影响）。
// M8 文字「关闭」按钮整块（锚点 `}, "关闭")),`）→ `null),`
//      ⇒ 期望红 **C4c**，实测**只红 C4c**（× 按钮不受影响）。
// M9 浮层 `onClose: function () { setLightbox(null); }` → `void 0;`
//      ⇒ 期望红 **C4b**（按钮在、有 onClick，但关闭没接上），实测**只红 C4b**。
// M10 `var next = current.index + (key === "ArrowRight" ? 1 : -1);` → `var next = current.index;`
//      ⇒ 期望红 **C3b**（左右键"处理了但没换条"），实测**只红 C3b**。
//
// 实测汇总（2026-10-09，对当时的 `lib/client.js`）：
//   基准全绿；M1→C1b,C1c · M2→C1d · M3→C3a · M4→C3a,C3b · M5→C1a,C1c,C2,C1d
//   M6→C4a · M7→C4b · M8→C4c · M9→C4b · M10→C3b
//   （每条都红了它「期望的那条」；M1/M4/M5 连带红别的，是**预期的连带**，不是问题。）
//
// ⚠️ 每条变异只验「**期望的那条**必须红」；上面注释里写「不该红」的，是**诊断线索**，
//    不写成断言 —— 否则守卫会因为实现换写法（比如哪天不用 blockEscape 了）而误红。
//
// ⚠️⚠️ 两条**造变异时踩过的坑**（别重犯）：
//   ① 替换必须**保留不该吃的括号/逗号**：M7 写成 `void 0` 会让对象字面量变成
//      `{ type: "button", void 0, }`（语法错误）；M8 写成 `null` 会漏掉外层
//      `h("div", __lbhead, …)` 的收尾。语法错误的变异体测的是「解析失败」，不是守卫。
//      ⇒ 现在每造一个变异体都先 `new vm.Script(broken)` 验它能解析，不能解析就**明确报红**。
//   ② 计数/探针要**包在渲染之前**：抽屉的 Escape 监听器在 effect 里注册时**闭包捕获**
//      当时的 `props.onClose`；渲染之后再换元素上的 prop，监听器用的还是旧函数。
//      计数器还要能活过 remount（C1c 会重渲染）—— 所以它挂在 `react` 上，不在 handle 上。
//
// ⚠️ 假 React 的两条**harness 语义**（不是产品行为，改本文件时别当成 bug）：
//   ① effect 依赖比较里，**函数按「都是函数」算相等** —— 内联闭包每次渲染都是新对象，
//      照 `===` 比会让 effect 无限重跑、永不收敛（真 React 也会重跑，但那不是我们要测的）；
//   ② `mount()` 会渲染到稳定，且**真的跑 cleanup**；校准④ 用「两层都开时
//      document 上恰好 2 个 keydown 监听器」把这件事钉住 —— 监听器堆积会让
//      「抽屉被关了几次」这类断言在测一个假的世界。
