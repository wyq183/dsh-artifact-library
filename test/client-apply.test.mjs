/**
 * dsh-artifact-library 客户端半侧测试
 *
 * 为什么要它：客户端插件 entry 一抛异常，web boot 判定 entry failed →
 * **整个应用起不来**（2026-09-28 真发生过）。所以这里的核心断言是
 * 「apply 在任何 ctx 形态下都不抛」，其次是注册形态正确（main.key 必须
 * 等于 sidebar.panellist.id）与渲染路径不炸。
 *
 * 运行：node test-alf-client.mjs [client.js 路径]
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const target = process.argv[2] || fileURLToPath(new URL('../lib/client.js', import.meta.url));

const srcRaw = fs.readFileSync(target, 'utf8');

/**
 * ⭐ 2026-10-14 加：注入测试钩子，把**右栏的两个组件**暴露出来。
 *
 * 为什么需要：原 [3] 段渲染的是**主面板**（走 `slots.register`，能从
 * `components['main']` 拿到）。面板删了 ⇒ 右栏组件走**另一条注册路**
 * （`sidebarRightTabs`，不经 `slots`）⇒ 只能靠钩子取。
 *
 * ⚠️ 与 `tag-chip.test.mjs` / `client-pure.test.mjs` 同一个手法：
 *    锚点 `exports.apply = apply;`，注入 `exports.__test = {…}`。
 */
const HOOK = 'exports.__test = { RightPaneBody: RightPaneBody, RightPanePreview: RightPanePreview };\n    exports.apply = apply;';
const ANCHOR = 'exports.apply = apply;';
if (srcRaw.indexOf(ANCHOR) < 0) {
  console.error('🔴 找不到锚点 `' + ANCHOR + '` —— client.js 入口形态变了，请同步本文件的 HOOK/ANCHOR');
  process.exit(2);
}
const src = srcRaw.replace(ANCHOR, HOOK);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    failed += 1;
    console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error)));
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

// ── 加载 bundle，取出 factory ─────────────────────────────────────────────
function loadBundle() {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
    document: {
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({
        setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {},
        style: {}, classList: { add() {}, remove() {}, toggle() {} },
      }),
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
      body: { appendChild() {} },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Promise,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => '' }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert(captured && typeof captured.factory === 'function', 'factory 未被注册');
  return captured;
}

const definition = loadBundle();

/** 造一个 mock React。stateQueue 用于喂给最前面的若干次 useState。 */
function makeReact(stateQueue = []) {
  const queue = stateQueue.slice();
  function createElement(type, props, ...children) {
    if (typeof type === 'function') {
      // 真的调用函数组件：这样递归渲染路径也会被覆盖到
      return type(Object.assign({}, props || {}, { children }));
    }
    return { type, props: props || {}, children };
  }
  return {
    createElement,
    useState(init) {
      if (queue.length) return [queue.shift(), () => {}];
      return [typeof init === 'function' ? init() : init, () => {}];
    },
    useEffect() {},
    useCallback(fn) { return fn; },
    useRef(init) { return { current: init }; },
  };
}

function factoryWith(react) {
  const module = definition.factory((name) => {
    if (name === 'react') return react;
    return {};
  });
  return module;
}

// ── 1. apply 永不抛出（各种 ctx 形态）────────────────────────────────────
console.log('\n[1] apply 永不抛出');
const ctxCases = [
  ['undefined', undefined],
  ['null', null],
  ['空对象', {}],
  ['get 不存在', { slots: {} }],
  ['get 返回 undefined', { get: () => undefined }],
  ['get 返回空对象', { get: () => ({}) }],
  ['slots 缺 register', { get: () => ({ inject() {} }) }],
  ['slots 缺 inject', { get: () => ({ register() {} }) }],
  ['get 直接抛', { get: () => { throw new Error('boom'); } }],
  ['inject 抛', { get: () => ({ inject() { throw new Error('boom'); }, register() {} }) }],
  ['register 抛', { get: () => ({ inject: (n, f) => f(), register() { throw new Error('boom'); } }) }],
];
for (const [label, ctx] of ctxCases) {
  check('apply(' + label + ') 不抛且返回函数', () => {
    const mod = factoryWith(makeReact());
    const disposer = mod.apply(ctx);
    assert(typeof disposer === 'function', '返回值不是 disposer');
  });
}

// ── 2. 注册形态 ───────────────────────────────────────────────────────────
console.log('\n[2] 注册形态');
function collectRegistrations() {
  const calls = { inject: [], register: [] };
  const slots = {
    inject(name, factory) { calls.inject.push(name); return factory(); },
    register(options, component) { calls.register.push({ options, component }); return () => {}; },
  };
  const mod = factoryWith(makeReact());
  mod.apply({ get: () => slots });
  return calls;
}
const calls = collectRegistrations();

/* ── [2] 席位注册（2026-10-14 档 1d 移植）───────────────────────────────────
 * 依琪拍板「主区面板不要了，全部转到右侧栏」「左边的都不要了」⇒
 * `main` / `sidebar.panellist` / `sidebar.footer.action` **三个席位全删了**。
 *
 * ⇒ 原判据（「前三个席位固定」+ `main.key === panellist.id` + panellist 的 label）
 *   **物理上不成立了**。换成守**现在真实存在的席位**：
 *     · `slots` 那条路只剩 `shell.overlay`（应用级 Toast）
 *     · 右栏 tab 走 **`ctx.inject(["sidebarRightTabs","slots"], …)`**（另一个 API）
 *
 * ⚠️ 原判据的历史 → `docs/DEPRECATED-TESTS.md` §2.3
 * ────────────────────────────────────────────────────────────────────────── */
check('★ 席位注册只剩 `shell.overlay`（Toast）—— 旧三席位已按拍板删除', () => {
  // ⚠️ 这条是**反向断言**：它守「删干净了」，不是「注册了」。
  //    若哪天有人把 `main` 加回来，这里会红 —— 那时应当**同步**改这条与
  //    `docs/DEPRECATED-TESTS.md`，而不是把断言删掉了事。
  const NAMES = calls.inject;
  assert(NAMES.indexOf('main') < 0,
    '★ `main` 席位又注册回来了 —— 依琪 2026-10-14 拍板「主区面板不要了」，'
    + '如果这是有意恢复，请同步改本条与 docs/DEPRECATED-TESTS.md');
  assert(NAMES.indexOf('sidebar.panellist') < 0, '★ `sidebar.panellist` 又注册回来了（左侧栏图标已按拍板删除）');
  assert(NAMES.indexOf('sidebar.footer.action') < 0, '★ `sidebar.footer.action` 又注册回来了（左下入口已按拍板删除）');
  assert(NAMES.indexOf('shell.overlay') >= 0,
    '★ `shell.overlay`（应用级 Toast）没注册 —— 瞬时结果就没有"比上报界面活得久"的地方了');
});

check('每个 register 都带组件函数', () => {
  assert(calls.register.length > 0, '一个席位都没注册');
  calls.register.forEach((r) => assert(typeof r.component === 'function', r.options.name + ' 组件不是函数'));
});

// ── 3. 渲染路径 ───────────────────────────────────────────────────────────
console.log('\n[3] 渲染路径');
const sampleRecord = {
  id: 'art_test_1',
  title: '测试产物',
  summary: '一个用于测试的产物',
  path: 'C:\\tmp\\a.png',
  project: '测试项目',
  kind: 'deliverable',
  artifact_type: 'image',
  tags: ['测试'],
  notes: 'note',
  stars: 3,
  references: ['art_other'],
  status: 'final',
  needsRefine: false,
  refineRequested: false,
  exists: true,
  size_bytes: 2048,
  mime_type: 'image/png',
  created_at: 1790000000,
  session_id: 'session-abcdef123456',
};

/* ⭐ 2026-10-14 移植：原来这里渲染**主面板的 5 个视图**（card/list/project/files/dir）
 *    与详情抽屉。面板删了 ⇒ 换成渲染**右栏的两个组件**。
 *
 * ⚠️ 右栏组件的真实主体是 `RightPaneBody` / `RightPanePreview`，它们**不在 slots 上**
 *    （走 `sidebarRightTabs` 那条路注册，不是 `slots.register`）。
 *    所以这里**直接调组件函数**，与 `tag-chip.test.mjs` 的 [G] 组同一手法。
 */
function buildComponents() {
  const react = makeReact();
  const mod = definition.factory((name) => (name === 'react' ? react : {}));
  const components = {};
  const slots = {
    inject: (name, factory) => factory(),
    register: (options, component) => { components[options.name] = component; return () => {}; },
  };
  mod.apply({ get: () => slots });
  return { components, mod };
}

check('渲染右栏正文 `RightPaneBody` 不抛（空 props 也不许抛）', () => {
  const { mod } = buildComponents();
  const T = mod.__test || {};
  assert(typeof T.RightPaneBody === 'function',
    '★ 拿不到 `RightPaneBody` —— 测试钩子没注入？（见本文件 HOOK）或它被改名了');
  T.RightPaneBody({});
});

check('渲染右栏预览 `RightPanePreview` 不抛（每种 kind 各来一遍）', () => {
  const { mod } = buildComponents();
  const T = mod.__test || {};
  assert(typeof T.RightPanePreview === 'function', '★ 拿不到 `RightPanePreview`');
  const kinds = [
    { ext: '.md', mime: 'text/markdown' },
    { ext: '.png', mime: 'image/png' },
    { ext: '.mp4', mime: 'video/mp4' },
    { ext: '.mp3', mime: 'audio/mpeg' },
    { ext: '.py', mime: 'text/x-python' },
    { ext: '.exe', mime: 'application/octet-stream' },
  ];
  for (const k of kinds) {
    const rec = Object.assign({}, sampleRecord, {
      extension: k.ext, mime_type: k.mime, tags: ['测试'],
    });
    try {
      T.RightPanePreview({ record: rec, managed: { ok: true, tags: [], limit: null }, onBack() {} });
    } catch (error) {
      // ⚠️ `cause` 必须带上：否则排查时看不到**原始**异常（只看到我们包装的那句）
      throw new Error('kind=' + k.ext + ' 渲染抛了：' + (error && error.message ? error.message : error), { cause: error });
    }
  }
});

check('React 缺 hooks 时降级而非抛出', () => {
  const bare = { createElement: (t, p) => ({ t, p }), useState: undefined };
  const mod = definition.factory((name) => (name === 'react' ? bare : {}));
  assert(typeof mod.apply === 'function', 'exports.apply 丢失');
});

// ── 4. @ 引用来源（inputTriggers 是非契约访问器）──────────────────────────
console.log('\n[4] @ 引用来源（旧宿主降级路径）');
/**
 * 为什么**成对**钉：
 *   · 只钉「没有服务时不抛」—— 一个**从不注册**的实现也能过；
 *   · 只钉「有服务时注册」—— 一个**不判空**的实现也能过（在新宿主上绿、旧宿主上抛）。
 * 两半一起，才逼出正确实现：有服务就注册，没服务就优雅跳过。
 * （日志那句「@ 来源未注册」我没钉文本 —— 太脆；行为两半才是要害。）
 */
function applyWithTriggers(hasService) {
  const registered = [];
  const service = hasService
    ? { registerSource: (spec) => { registered.push(spec); return () => {}; } }
    : undefined;
  const slots = { inject: (name, factory) => factory(), register: () => () => {} };
  const mod = factoryWith(makeReact());
  const disposer = mod.apply({ get: (name) => (name === 'inputTriggers' ? service : slots) });
  return { disposer, registered };
}

check('inputTriggers 存在 → 注册 @ 来源（trigger="@"）', () => {
  const { registered } = applyWithTriggers(true);
  assert(registered.length === 1, 'registerSource 调用次数 = ' + registered.length + '（有服务却没注册，或重复注册）');
  assert(registered[0] && registered[0].trigger === '@', 'trigger 不是 "@"：' + JSON.stringify(registered[0]));
  assert(typeof registered[0].name === 'string' && registered[0].name.length > 0, 'name 为空');
});

check('inputTriggers 不存在 → 不抛、返回 disposer、且不假注册', () => {
  const { disposer, registered } = applyWithTriggers(false);
  assert(typeof disposer === 'function', '返回值不是 disposer');
  assert(registered.length === 0, '没有服务却报告注册了 ' + registered.length + ' 次');
});

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
