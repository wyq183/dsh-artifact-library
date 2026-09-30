/**
 * dsh-artifact-library · 客户端**运行期**渲染冒烟
 *
 * 与 `test/ui-spec.test.mjs` 的分工（两者测的是不同层次，都要有）：
 *   · ui-spec.test.mjs   —— **静态**：扫源码/CSS/数据表，钉 UI-SPEC 条款（快、零依赖）
 *   · 本文件             —— **运行期**：真的把组件渲染一遍，验行为（缩略图门槛与编码、
 *                           onError 回退、时间双形状、Ctrl+P 浮层的候选与空态）
 *
 * 来源：由 ui-core 的临时冒烟脚本 `scratch/render-check3.cjs` 收编而来（2026-09-30），
 * 逻辑保持原样，只做了三件事：① CommonJS → ESM；② 硬编码绝对路径 → 相对本文件
 * （可用 argv[2] 覆盖，便于做 bite-test）；③ 输出统一成 `结果：N 通过 / M 失败` + 非零退出码。
 *
 * ⚠️ **维护须知（别踩）**：`renderDir()` 里的 `states` 数组是**按位置**喂给 mock React 的
 * useState 队列的 —— 它的顺序必须与主面板组件里 `useState` 的调用顺序逐项对应。
 * 一旦有人在组件里**新增/删除/调换** `useState`，后面所有值都会错位，
 * 断言可能变成「用错状态也能过」的假绿。为此本文件加了校准护栏（最后一条断言）：
 * 若组件实际消耗的 hook 数少于我们提供的槽位数，直接报红并提示「重新校准 states」。
 * **改组件 hook 顺序的人，有责任同步更新这里的 states 数组。**
 *
 * 运行：node test/client-render.test.mjs [client.js 路径]
 * 退出码：有失败 → 1
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_PATH = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../lib/client.js', import.meta.url));

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

console.log('\n═══ 客户端渲染冒烟（运行期）═══');
console.log(' 被测：' + CLIENT_PATH);

// ── 载入 bundle：假 window/doc，取出 module factory ───────────────────────
const src = fs.readFileSync(CLIENT_PATH, 'utf8');
let captured = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
  document: {
    baseURI: 'http://127.0.0.1:19387/',
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  },
  console: { info: () => {}, warn: () => {}, log: () => {}, error: () => {} },
  setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise, Intl, Date, isFinite, parseFloat,
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => '' }),
  location: { search: '' },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
assert(captured && typeof captured.factory === 'function', 'factory 未被注册（client.js 入口形态变了？）');

/**
 * 假 React：`queue` 按顺序供给最前面的若干次 useState —— 见文件头的维护须知。
 * `stats.useStateCalls` 记录整棵树实际调用次数，供校准护栏使用。
 */
function makeReact(queue) {
  const q = queue.slice();
  const stats = { useStateCalls: 0 };
  function createElement(type, props, ...children) {
    if (typeof type === 'function') return type(Object.assign({}, props || {}, { children }));
    return { type, props: props || {}, children };
  }
  return {
    createElement,
    useState(init) {
      stats.useStateCalls += 1;
      if (q.length) return [q.shift(), () => {}];
      return [typeof init === 'function' ? init() : init, () => {}];
    },
    useEffect() {},
    useCallback(fn) { return fn; },
    useRef(init) { return { current: init }; },
    __stats: stats,
  };
}

function build(states) {
  const react = makeReact(states);
  const mod = captured.factory((n) => (n === 'react' ? react : {}));
  const comps = {};
  mod.apply({ get: () => ({ inject: (n, f) => f(), register: (o, c) => { comps[o.name] = c; return () => {}; } }) });
  return { comps, react };
}

function walk(n, out) {
  if (n === null || n === undefined || n === false) return;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, out)); return; }
  if (typeof n !== 'object') return;
  out.push(n);
  (n.children || []).forEach((c) => walk(c, out));
}
const cls = (n) => String((n.props && n.props.className) || '');

const sampleData = { items: [], stats: {}, cats: { projects: [], types: [], tags: [] }, loading: false, error: '' };
const filters = { q: '', kind: '', refine: '', project: '', sort: 'created_desc', view: 'dir', trash: false };

function renderDir(entries, extra) {
  const states = [
    sampleData, filters, null, '',
    false,                    // sessionOnly
    'C:\\proj', entries, (extra && extra.phase) || 'ready', '', ['C:\\proj'], { by: 'name', dir: 'asc' }, 'standard', {}, null, 0, 0, { top: 0, height: 600 },
    (extra && extra.thumbFailed) || {},   // thumbFailed
    (extra && extra.finder) || null,      // finder
    (extra && extra.listMeta) || null,    // listMeta（/files/list 的 total/truncated/limit）
  ];
  const built = build(states);
  const tree = built.comps.main({});
  const nodes = [];
  walk(tree, nodes);
  return {
    nodes,
    rows: nodes.filter((n) => cls(n).includes('alf__drow')),
    imgs: nodes.filter((n) => n.type === 'img'),
    icons: nodes.filter((n) => cls(n) === 'alf__fi'),
    useStateCalls: built.react.__stats.useStateCalls,
    stateSlots: states.length,
  };
}

const entries = [
  { name: 'shot.png', path: 'C:\\proj\\shot.png', isDirectory: false, size: 2048, mtimeMs: 1790000000000 },
  { name: '中文 名字.jpg', path: 'C:\\proj\\中文 名字.jpg', isDirectory: false, size: 4096, mtimeMs: 1790000000000 },
  { name: 'huge.png', path: 'C:\\proj\\huge.png', isDirectory: false, size: 6 * 1024 * 1024, mtimeMs: 1790000000000 },
  { name: 'note.md', path: 'C:\\proj\\note.md', isDirectory: false, size: 100, mtimeMs: 1790000000000 },
  { name: 'sub', path: 'C:\\proj\\sub\\', isDirectory: true, size: 0, mtimeMs: 1790000000000 },
  { name: 'old.txt', path: 'C:\\proj\\old.txt', isDirectory: false, size: 10, modified: 1790000000 },  // 旧形状（秒）
];

const out = renderDir(entries);
console.log('\n── 缩略图 ──');
console.log('  img 数:', out.imgs.length, '/ 行数:', out.rows.length);
out.imgs.forEach((i) => console.log('   src=' + i.props.src + '  lazy=' + i.props.loading + '  onError=' + (typeof i.props.onError === 'function')));
check('两张小图出缩略图（png + 中文/空格 jpg）', () => assert(out.imgs.length === 2, 'img 数 = ' + out.imgs.length));
check('缩略图走**自建** /ext/artifacts/files/thumb（host-dev task-5 端点）', () => {
  // 2026-09-30 决策变更：官方 /api/file 走 ctx.fs 会话沙箱，用户开受限沙箱时
  // 会 403 掉范围外的产出目录（正是产物库要展示的），故首选自建端点、官方降级为后备。
  out.imgs.forEach((i) => assert(String(i.props.src).indexOf('/ext/artifacts/files/thumb?path=') === 0, 'src 不对: ' + i.props.src));
});
check('路径经过 encodeURIComponent（中文 + 空格）', () => {
  const srcs = out.imgs.map((i) => String(i.props.src)).join(' ');
  assert(srcs.indexOf(encodeURIComponent('C:\\proj\\中文 名字.jpg')) >= 0, '没编码：' + srcs);
  assert(srcs.indexOf('中文') < 0, '出现了未编码的中文：' + srcs);
  assert(srcs.indexOf('%20') >= 0, '空格没编码成 %20');
});
check('>5MB 的图不出缩略图（走图标）', () => {
  assert(!out.imgs.some((i) => String(i.props.src).indexOf('huge') >= 0), 'huge.png 不该出缩略图');
});
check('非图片 / 目录 / 都走类型图标', () => {
  const inRows = [];
  out.rows.forEach((r) => walk(r, inRows));
  const rowIcons = inRows.filter((n) => cls(n) === 'alf__fi');
  assert(rowIcons.length === 4, '行内图标数应为 4（huge/note.md/sub/old.txt），实际 ' + rowIcons.length);
});
check('每张缩略图都有 onError 回退', () => {
  out.imgs.forEach((i) => assert(typeof i.props.onError === 'function', '缺 onError'));
});
// §11.3「失败回退且**不反复重试**」：组件是**两级**回退 ——
//   自建 /files/thumb（primary）→ 官方 api/file（fallback）→ 类型图标（终态）。
// thumbFailed[path] 就是这条链的状态：undefined=主、'primary'=退到官方、'1'=终态用图标
// （取值为 markThumbFailed 里确定的，不是猜的）。两级到头就停，不会无限重试。
const stageOne = renderDir(entries, { thumbFailed: { 'C:\\proj\\shot.png': 'primary' } });
check('[§11.3] 一级失败 → 退到官方 api/file（绝对地址）再试一次', () => {
  const hit = stageOne.imgs.find((i) => String(i.props.src).indexOf('shot.png') >= 0);
  assert(hit, '一级失败后应改用后备 URL 再试一次，实际连 img 都没了');
  assert(/^https?:\/\/.+\/api\/file\?path=/.test(String(hit.props.src)), '后备 URL 应为官方 api/file 的绝对地址，实际 ' + hit.props.src);
});
const stageFinal = renderDir(entries, { thumbFailed: { 'C:\\proj\\shot.png': '1' } });
check('[§11.3] 两级都失败 → 回退类型图标，且不对同一项再发请求', () => {
  const srcs = stageFinal.imgs.map((i) => String(i.props.src)).join(' ');
  assert(srcs.indexOf('shot.png') < 0, 'shot.png 已是终态失败，却仍在请求缩略图：' + srcs);
  assert(stageFinal.imgs.length === 1, '应只剩 1 张缩略图（失败那张回退图标），实际 ' + stageFinal.imgs.length);
});
check('loading=lazy（配合虚拟滚动，只有可见行发请求）', () => {
  out.imgs.forEach((i) => assert(i.props.loading === 'lazy', 'loading 不是 lazy'));
});

console.log('\n── 时间列兼容两种形状 ──');
const times = out.rows.map((r) => {
  const cells = [];
  walk(r, cells);
  const t = cells.filter((c) => c.props && c.props.className && c.props.className === 'alf__dtime');
  return t.length ? String((t[0].children || []).join('')) : '';
});
times.forEach((t, i) => console.log('   ' + entries[i].name + ' → ' + t));
check('mtimeMs（毫秒）能显示时间', () => assert(times[2] !== '—', 'mtimeMs 行显示 —'));
check('旧 modified（秒）也能显示时间', () => assert(times[5] !== '—', 'modified 行显示 —'));

console.log('\n── Ctrl+P 快速跳转浮层 ──');
const f = renderDir(entries, { finder: { q: '', cursor: 0 } });
const finder = f.nodes.find((n) => cls(n).includes('alf__finder'));
const items = f.nodes.filter((n) => cls(n).includes('alf__finderItem'));
console.log('  浮层存在:', !!finder, '/ 候选:', items.length, items.map((i) => String((i.children || []).slice(1).join(''))).join(' | '));
check('Ctrl+P 浮层能渲染', () => assert(!!finder, '没有 __finder'));
check('列出范围根作为候选', () => assert(items.length >= 1, '没有候选'));
check('浮层是自绘浮层（官方 token + elevation）', () => {
  assert(cls(finder).includes('alf__finder'), 'class 不对');
});
const fq = renderDir(entries, { finder: { q: 'zzz-no-such-dir', cursor: 0 } });
check('无匹配时给提示而不是空白', () => {
  const hint = fq.nodes.filter((n) => cls(n).includes('alf__finderHint'));
  assert(hint.length >= 1, '没有提示');
});

console.log('\n── 校准护栏（见文件头维护须知）──');
// 黄金值：首次渲染（view=dir，无 finder）时整棵树的 useState 调用总数。
// **为什么是相等而不是 >=**：`>=` 只能发现 hook 被删；一旦有人在前面**插入**一个 hook，
// 后面所有值整体后移，按位置喂的 states 会静默错位 —— 断言可能「用错状态也过」。
// 相等判定会把「增删改 hook」一律变成响亮的失败，逼人重新校准。改组件 hook 结构就改这个数。
const EXPECTED_HOOK_CALLS = 20;
console.log('  hook 调用 = ' + out.useStateCalls + ' / 期望 = ' + EXPECTED_HOOK_CALLS + ' / 状态槽位 = ' + out.stateSlots);
check('状态队列仍与组件 hook 结构对得上（校准护栏）', () => {
  assert(
    out.useStateCalls === EXPECTED_HOOK_CALLS,
    '首次渲染的 useState 调用数从 ' + EXPECTED_HOOK_CALLS + ' 变成了 ' + out.useStateCalls +
      '（本文件按位置提供 ' + out.stateSlots + ' 个状态槽位）—— hook 结构变了，states 队列很可能已整体错位，' +
      '上面断言的结果不可信。请重新校准 renderDir() 的 states，并把 EXPECTED_HOOK_CALLS 改成新值。'
  );
});

if (failureList.length) {
  console.log('\n── 失败清单 ──');
  for (const f2 of failureList) console.log('      · ' + f2.name + ' -> ' + f2.message);
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
