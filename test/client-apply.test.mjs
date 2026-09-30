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

const src = fs.readFileSync(target, 'utf8');

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
check('注册了必需席位（前三个固定，允许白名单内追加）', () => {
  // 2026-09-30 放宽：官方 UX 规范要求「瞬时结果用应用级 Toast，且必须挂在比上报界面
  // 活得久的地方」，所以追加了 shell.overlay。改为「必需的三个必须存在且顺序固定，
  // 追加的必须在白名单内」—— 仍然能挡住乱注册，但不再禁止合规的追加。
  const REQUIRED = ['main', 'sidebar.panellist', 'sidebar.footer.action'];
  const ALLOWED_EXTRA = new Set(['shell.overlay']);
  assert(calls.inject.length >= REQUIRED.length, 'inject 调用次数 = ' + calls.inject.length);
  const head = calls.inject.slice(0, REQUIRED.length);
  assert(head.join(',') === REQUIRED.join(','), '前三个席位顺序/名字：' + head.join(','));
  calls.inject.slice(REQUIRED.length).forEach((name) => {
    assert(ALLOWED_EXTRA.has(name), '未预期的额外席位：' + name);
  });
});
check('main.key === sidebar.panellist.id（不一致会让布局抛错）', () => {
  const main = calls.register.find((r) => r.options.name === 'main');
  const list = calls.register.find((r) => r.options.name === 'sidebar.panellist');
  assert(main, '没有注册 main');
  assert(list, '没有注册 sidebar.panellist');
  assert(main.options.key === list.options.id, 'main.key=' + main.options.key + ' vs panellist.id=' + list.options.id);
  assert(main.options.key === 'artifact-library', 'key 意外：' + main.options.key);
});
check('panellist 有 label 且是函数', () => {
  const list = calls.register.find((r) => r.options.name === 'sidebar.panellist');
  assert(typeof list.options.label === 'function', 'label 不是函数');
  assert(typeof list.options.label() === 'string' && list.options.label().length > 0, 'label 为空');
});
check('每个 register 都带组件函数', () => {
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
const sampleData = {
  items: [sampleRecord, Object.assign({}, sampleRecord, { id: 'art_test_2', title: '资料条目', kind: 'reference', artifact_type: 'document', exists: false, mime_type: 'text/plain' })],
  stats: { total: 12, pendingRefine: 3, archived: 1, trashed: 2, missingFiles: 1 },
  cats: { projects: ['测试项目'], types: ['image'], tags: ['测试'] },
  loading: false,
  error: '',
};
/**
 * 用**同一个 factory 实例**建组件并渲染。
 * 组件内部 `require('react')` 绑定的是该 factory 的 require，所以要控制
 * useState 的返回值，必须走这条路径（换个 factory 就换了一份 mock React）。
 */
function build(view, detail) {
  const filters = { q: '', kind: '', refine: '', project: '', sort: 'created_desc', view, trash: false };
  const react = makeReact([sampleData, filters, detail, '']);
  const mod = definition.factory((name) => (name === 'react' ? react : {}));
  const components = {};
  const slots = {
    inject: (name, factory) => factory(),
    register: (options, component) => { components[options.name] = component; return () => {}; },
  };
  mod.apply({ get: () => slots });
  return components;
}

for (const view of ['card', 'list', 'project', 'files', 'dir']) {
  check('渲染主面板 view=' + view, () => {
    const components = build(view, null);
    assert(typeof components['main'] === 'function', 'main 组件缺失');
    components['main']({});
  });
}

check('渲染详情抽屉（detail 非空 → 递归进 DetailDrawer）', () => {
  const components = build('card', sampleRecord);
  components['main']({});
});

check('渲染侧栏图标组件不抛', () => {
  const components = build('card', null);
  components['sidebar.panellist']();
});
check('渲染脚部入口不抛', () => {
  const components = build('card', null);
  components['sidebar.footer.action']();
});

check('React 缺 hooks 时降级而非抛出', () => {
  const bare = { createElement: (t, p) => ({ t, p }), useState: undefined };
  const mod = definition.factory((name) => (name === 'react' ? bare : {}));
  assert(typeof mod.apply === 'function', 'exports.apply 丢失');
});

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
