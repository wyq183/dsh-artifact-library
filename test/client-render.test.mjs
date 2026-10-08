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
 * ⚠️⚠️ **这条槽位模型是「harness 行为」，不是「产品行为」—— 别照着它改产品代码**（2026-09-30 夜，
 * 由 ui-core 合并 harness 时实测发现）：
 * 本文件用的假 React 在 **`h(Component, …)` 创建元素时就调用组件**，而真实 React 只在
 * **返回的树里**渲染。所以「**元素被创建了、但没被返回**」（early-return、条件渲染建了不用）
 * 的组件，**仍会消耗槽位**。
 * ⇒ 后果两条：
 *   ① 若哪天护栏报「hook N ≠ 槽位 M」，**先别断定产品坏了** —— 也可能是这种「创建了但没渲染」的
 *      结构差异（护栏会报出来，**是可识别的失败，不是静默出错**）；
 *   ② 槽位顺序要照 **harness 的真实调用顺序** 喂，并在注释里写明它是 harness 语义。
 * 同理：**别为了迁就本文件去改产品的 hook 结构** —— 该改的是这里的 `states`。
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

// ⚠️ **剥过注释的**源码（静态断言用）。注释里提到某个词**不算数** ——
//    本仓库栽过三次（`stripComments` 那回最惨：判据本身读错了源码，
//    120 条断言全建在错的输入上）。
// ⚠️ 定义在这里（而不是用到它的那一节旁边）：本文件是**顺序执行**的，
//    常量必须定义在**所有**用它的 check 之前，否则 TDZ 报
//    「Cannot access 'CODE' before initialization」。
const CODE = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
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
  const stats = { useStateCalls: 0, setCalls: [] };
  function createElement(type, props, ...children) {
    if (typeof type === 'function') return type(Object.assign({}, props || {}, { children }));
    return { type, props: props || {}, children };
  }
  return {
    createElement,
    useState(init) {
      stats.useStateCalls += 1;
      const state = q.length ? q.shift() : (typeof init === 'function' ? init() : init);
      return [state, (value) => stats.setCalls.push({ slot: stats.useStateCalls, value })];
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
    (extra && extra.data) || sampleData, (extra && extra.filters) || filters, null, '',
    false,                    // sessionOnly
    (extra && extra.changesAvailable !== undefined) ? extra.changesAvailable : null,   // changesAvailable（null|true|false，改动入口门控）
    (extra && extra.prefs !== undefined) ? extra.prefs : null,   // sSettings（当前设置；喂它才能验「设置真的生效」）
    (extra && extra.project !== undefined) ? extra.project : null, // sProject
    (extra && extra.panelSel) || { ids: {}, anchor: -1 },  // sPanelSel
    null,                     // sRefineUndo（取消优先标记的凭据；第 10 位 —— 在 sArtMenu **之前**）
    null,                     // sArtMenu（产物右键菜单；task-13 新增，第 11 位）
    // ⚠️ **2026-10-08 新增第 12 位**：`sLightbox`（媒体预览浮层的状态；依琪要的
    //    「卡片跟列表只要可以快速预览放大图片跟快捷播放视频音频」）。
    //    刻意声明在 `sArtMenu` **之后** ⇒ 前 11 个槽位的位置**一个都没动**，
    //    老断言的语义不受影响。`EXPECTED_HOOK_CALLS` 同步 33 → 34。
    (extra && extra.lightbox !== undefined) ? extra.lightbox : null,   // sLightbox
    'C:\\proj', entries, (extra && extra.phase) || 'ready', '', ['C:\\proj'], { by: 'name', dir: 'asc' },
    // ⚠️ sDensity 是**手动覆盖**（null = 未覆盖 → 取设置里的值）。
    //    验「设置真的生效」必须喂 null；喂 'standard' 等于「用户行内改过」，设置会被（正确地）忽略 ——
    //    我第一版喂了字符串，于是误报了「密度没反映到渲染上」（第 8 次自曝，是测试的错不是产品的错）。
    (extra && extra.density !== undefined) ? extra.density : 'standard',
    // ↓ 多选/批量那批新增的 4 个（在 sDensity 之后、sCounts 之前）
    (extra && extra.sel) || { paths: {}, anchor: -1 },    // sSel（选中集合 + 锚点）
    null,                         // sCrumbEdit（面包屑编辑中的文本）
    (extra && extra.dirView !== undefined) ? extra.dirView : null,   // sDirView（目录里的呈现档：list|card|gallery；task-11 新增）
    null,                         // sBatchUndo（可撤销的批量登记凭据）
    0,                            // sDragOver（拖入计数）
    {}, null, 0, 0, { top: 0, height: 600 },
    (extra && extra.thumbFailed) || {},   // thumbFailed
    (extra && extra.finder) || null,      // finder
    (extra && extra.listMeta) || null,    // listMeta（/files/list 的 total/truncated/limit）
    false,                                // ViewControl: sColsOpen（列浮层开合；task-11 新增，在目录路径末尾）
    // ⚠️ 这个槽位在 React 的 hook 顺序里**紧跟在 sColsOpen 之后**
    //    （`ViewControl` 里先 `useState(colsOpen)` 再 `useState(viewOpen)`）。
    //    位置不能随手挪 —— 队列是按位置喂的，插错地方会让**下面所有 ViewControl 的断言**都错位。
    (extra && extra.viewOpen) || false,    // ViewControl: sViewOpen（显示形式浮层开合；2026-10-06 新增）
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
    setCalls: built.react.__stats.setCalls,
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

console.log('\n── 「改动」入口门控（就是它给 PanelInner 加了那个 hook）──');
/**
 * 为什么钉这三条：`changesAvailable`（null|true|false）是**新增 hook** 所服务的行为，
 * 也正是它让本文件的按位置队列整体位移（校准护栏第一次真实触发）。
 * 用**同一个已校准的队列**喂三种取值即可覆盖，不必为它再开一份状态队列。
 * 语义（来自 client.js:1671 注释）：只有真探到有数据才把「改动」放进切换器；
 * false / null 都不显示 —— 不留「永远 404 的入口」。
 */
const segTexts = (nodes) => nodes.filter((n) => cls(n).includes('alf__segi')).map((n) => String((n.children || []).join('')));
const segTrue = segTexts(renderDir(entries, { changesAvailable: true }).nodes);
const segFalse = segTexts(renderDir(entries, { changesAvailable: false }).nodes);
const segNull = segTexts(renderDir(entries, { changesAvailable: null }).nodes);
console.log('  切换器（true）:', segTrue.join(' | '));
console.log('  切换器（false）:', segFalse.join(' | '));
check('changesAvailable=true → 出现「改动」页签', () => {
  assert(segTrue.indexOf('改动') >= 0, '探到有数据却没出现「改动」：' + segTrue.join('|'));
});
check('changesAvailable=false → 「改动」整块摘掉', () => {
  assert(segFalse.indexOf('改动') < 0, '没有数据却仍显示「改动」：' + segFalse.join('|'));
  assert(segFalse.length >= 4, '摘掉时不该把别的视图也带走：' + segFalse.join('|'));
});
check('changesAvailable=null（未探明）→ 也不显示（不留空面板）', () => {
  assert(segNull.indexOf('改动') < 0, '未探明却已显示「改动」：' + segNull.join('|'));
});

console.log('\n── 批量操作条的位置（不被虚拟滚动藏走）──');
const selMap = {};
selMap[entries[0].path] = 1;
const batched = renderDir(entries, { sel: { paths: selMap, anchor: 0 } });
const selBar = batched.nodes.find((n) => cls(n).includes('alf__selbar'));
const firstRow = batched.nodes.find((n) => /alf__(?:d)?rows?\b/.test(cls(n)));
const idxBar = batched.nodes.indexOf(selBar);
const idxRow = batched.nodes.indexOf(firstRow);
console.log('  批量条:', selBar ? '有' : '无', '/ 首行:', firstRow ? '有' : '无', '/ 文档序 bar@' + idxBar + ' row@' + idxRow);
check('选中后批量条渲染，且排在列表之前', () => {
  assert(selBar, '选中了 1 项却没有 __selbar —— 批量操作条没渲染');
  assert(firstRow, '找不到行节点（判据前提失效：行 class 变了？）');
  assert(idxBar < idxRow, '批量条排在第 1 行之后（文档序 ' + idxBar + ' vs ' + idxRow + '）—— 虚拟滚动时会被藏走');
});

console.log('\n── 产物行与卡片键盘行为 ──');
const artifacts = [
  { id: 'a', title: 'First', path: 'C:\\proj\\first.md', project: 'P', size_bytes: 100 },
  { id: 'b', title: 'Second', path: 'C:\\proj\\second.md', project: 'P', size_bytes: 200 },
];
function renderArtifacts(view, panelSel) {
  const rendered = renderDir([], {
    data: { ...sampleData, items: artifacts },
    filters: { ...filters, view },
    project: '__all__',
    panelSel,
  });
  return rendered;
}
function keyEvent(key, currentTarget, target = currentTarget) {
  let prevented = false;
  return { key, currentTarget, target, preventDefault() { prevented = true; }, get prevented() { return prevented; } };
}
for (const [view, rowClass] of [['list', 'alf__table'], ['card', 'alf__card']]) {
  const rendered = renderArtifacts(view, { ids: { b: 1 }, anchor: 1 });
  const rows = rendered.nodes.filter((n) => view === 'list' ? n.type === 'tr' && n.props['data-sel'] : cls(n) === rowClass);
  check(view + ': only first item enters Tab order, including when another item is selected', () => {
    assert(rows.length === 2, 'expected two items, got ' + rows.length);
    assert(rows[0].props.tabIndex === 0 && rows[1].props.tabIndex === -1, 'selected item added another Tab stop');
  });
  check(view + ': item Enter/Space work, descendant buttons keep native behavior', () => {
    for (const key of ['Enter', ' ']) {
      const own = keyEvent(key, rows[0]);
      rows[0].props.onKeyDown(own);
      assert(own.prevented, key + ' did not activate item');
      const child = keyEvent(key, rows[0], {});
      rows[0].props.onKeyDown(child);
      assert(!child.prevented, key + ' was intercepted on a child button');
    }
  });
  check(view + ': ArrowDown moves focus to next item', () => {
    let focused = false;
    const next = { focus() { focused = true; } };
    const row = { parentNode: { children: [null, next] } };
    const event = keyEvent('ArrowDown', row);
    rows[0].props.onKeyDown(event);
    assert(event.prevented && focused, 'ArrowDown did not move focus');
  });
  check(view + ': Enter opens the same detail view as a plain click', () => {
    rows[0].props.onClick({ ctrlKey: false, metaKey: false, shiftKey: false });
    const click = rendered.setCalls.pop();
    rows[0].props.onKeyDown(keyEvent('Enter', rows[0]));
    const enter = rendered.setCalls.pop();
    assert(click && enter && click.slot === enter.slot && click.value === enter.value,
      'Enter and click have different primary actions');
  });
}
check('card actions are hidden from Tab order until hover or focus-within', () => {
  assert(src.includes('opacity:0;visibility:hidden;pointer-events:none'), 'hidden card actions can still receive Tab');
  assert(src.includes('__card:focus-within .'), 'focused card does not reveal its actions');
});

console.log('\n── 首用引导在空库首屏可达（T2 §3.1 那条 P1）──');
/**
 * 背景：T2 静态走查发现 `isFirstRun` 那套最好的首用引导
 * （「这里会自动收着你让 AI 做出来的东西」+ 两个真路径按钮）**在真实空库首屏不可达** ——
 * 因为项目层分支排在它前面，而 `currentProject` 初值是 `null`，空库时同样命中 ⇒
 * 用户得先点一次「全部产物」才看得到。评审原话：「那句写得最好的引导，新人根本见不到」。
 *
 * 2026-10-03 批次 3 给项目层分支补了 `&& visibleItems.length` —— 空库时它就是 0，
 * 条件为假 ⇒ 让位给后面的空态 ⇒ **引导可达**。
 *
 * ⚠️ 为什么用断言而不是真机：**没法在依琪的真实库里造一个空库**（那要改
 * `DSH_ARTIFACT_LIBRARY_DIR` 并重启 DSH，会打断他正在用的界面）。
 * 所以改用「空库渲染」把它钉死 —— 纯逻辑判据，比"等一次真机"更快也更可靠。
 */
const emptyLib = renderDir([], {
  data: { ...sampleData, items: [] },
  filters: { ...filters, view: 'card' },
});
const emptyTexts = [];
walk(emptyLib.nodes, emptyTexts);
const emptyFlat = emptyTexts.map((n) => String((n.children || []).join(''))).join(' ');
check('空库首屏出现首用引导原句', () => {
  assert(emptyFlat.indexOf('这里会自动收着你让 AI 做出来的东西') >= 0,
    '空库时首用引导没出现 —— T2 §3.1 那条 P1 回来了（项目层又挡在空态前面）。实际渲染：' + emptyFlat.slice(0, 200));
});
check('空库首屏不渲染项目卡（让位给空态）', () => {
  const cards = emptyLib.nodes.filter((n) => cls(n).includes('alf__pcard'));
  assert(cards.length === 0, '空库却渲染了 ' + cards.length + ' 张项目卡');
});

console.log('\n── ViewControl 真的生效（task-11：目录里能切呈现 + 密度/尺寸真反映）──');
/**
 * 为什么钉**渲染级**：`ui-spec` #26 只保证「源码里读了这些设置键」，**不保证「改了真的反映在渲染上」**。
 * 手法：喂不同设置 → 比较**整棵渲染树的结构签名**（类名 + props），而不是只比较 state。
 * 用签名而不是具体标记名，是为了将来换标记写法也不误报。
 */
const sig = (ns) => ns.map((n) => cls(n) + '|' + JSON.stringify(n.props, (k, v) => (k === 'children' || typeof v === 'function' ? undefined : v))).join(';');
const hasCls = (ns, c) => ns.some((n) => cls(n).includes(c));
const densOf = (ns) => { const n = ns.find((x) => x.props && x.props['data-density']); return n ? n.props['data-density'] : null; };
const baseColumns = { size: true, time: false, type: false };
const prefsCompact = { density: 'compact', defaultView: 'list', thumbnails: true, columns: baseColumns };
const prefsLoose = { density: 'loose', defaultView: 'list', thumbnails: true, columns: baseColumns };
const rCompact = renderDir(entries, { prefs: prefsCompact, dirView: 'list', density: null });
const rLoose = renderDir(entries, { prefs: prefsLoose, dirView: 'list', density: null });
const rCard = renderDir(entries, { prefs: prefsCompact, dirView: 'card', density: null });
console.log('  ViewControl:', hasCls(rCompact.nodes, 'alf__viewctl') ? '在' : '不在',
  '| density:', densOf(rCompact.nodes), '→', densOf(rLoose.nodes),
  '| list 有 __dlist:', hasCls(rCompact.nodes, 'alf__dlist'), '| card 有 __dlist:', hasCls(rCard.nodes, 'alf__dlist'));

check('目录工具栏里有 ViewControl', () => {
  assert(hasCls(rCompact.nodes, 'alf__viewctl'), '目录树里找不到 alf__viewctl —— 呈现/密度/尺寸控件没渲染出来');
});
check('密度设置真的反映在渲染上（data-density）', () => {
  const a = densOf(rCompact.nodes);
  const b = densOf(rLoose.nodes);
  assert(a && b, '找不到 data-density 容器（__dlist）—— 判据前提失效，请同步更新本断言');
  assert(a === 'compact' && b === 'loose', 'prefs.density 没反映到 data-density：compact→' + a + ' / loose→' + b + '（「只存不读」的渲染版）');
});
check('目录里切「列表 ↔ 卡片」真的改变渲染（不是只变 state）', () => {
  assert(hasCls(rCompact.nodes, 'alf__dlist'), 'list 档没有 __dlist 容器');
  assert(!hasCls(rCard.nodes, 'alf__dlist'), 'card 档仍然渲染 __dlist —— 切换没改变渲染');
  assert(sig(rCompact.nodes) !== sig(rCard.nodes), '两种呈现的渲染树签名相同 —— 切换只改了 state，没改输出');
});
check('卡片尺寸改了，渲染树跟着变（galleryThumbSize 48 ↔ 160）', () => {
  const mk = (px) => renderDir(entries, { prefs: { density: 'standard', defaultView: 'card', thumbnails: true, galleryThumbSize: px, columns: baseColumns }, dirView: 'card' });
  const r48 = mk(48);
  const r160 = mk(160);
  assert(sig(r48.nodes) !== sig(r160.nodes), 'galleryThumbSize 从 48 改到 160，渲染树完全没变 —— 尺寸设置没接到渲染上');
});

// ── 显示形式必须**收成一个**按钮（2026-10-06 · 依琪反馈 + 真机复验）──────────────
// 背景：第一版把 卡片/列表/画廊 从顶部导航搬出来，却只是塞进 ViewControl 的**又一个分段控件**
// ⇒ 真机截图里还是 7 个按钮并排、总数一个没少（依琪原话要治的正是「按钮太多……不简洁不直观」）。
// 这几条钉住「N 个按钮 → 1 个」以及「选项在浮层里、当前项有勾」，防止哪天又并排长回去。
//
// ⚠️ **2026-10-08：档位从 3 收到 2**（画廊退役，见 `lib/client.js` 的 `VIEW_KINDS`）。
//    依琪原话「不需要画廊啊，卡片跟列表只要可以快速预览放大图片跟快捷播放视频音频啥的不就好了」——
//    他要的是**能快速看见内容**，而画廊是想用"换一种视图"去解决同一件事（实测真库媒体只占 13%）。
//    ⇒ 本节判据从**写死 3** 改成**跟随档位表**：这样下次增删档位时，它验的仍是
//      「浮层里恰好列出全部档位、且有且只有一个带 ✓」，而不会又变成一条
//      **钉住当时档位数**的守卫（那种守卫在需求变时必然红，而代码是对的 —— 本仓库栽过好几次）。
// ⚠️ 本文件的元素形状是 `{type, props, children}` —— **文案在 `children` 里，不在 `props.children`**。
//    （第一版断言我写成 `props.children`，于是「找不到按钮」误报了一次；`cls`/`data-*` 那些判据没这个问题。）
const txt = (n) => (Array.isArray(n.children) ? n.children.filter((c) => typeof c === 'string').join('') : String(n.children == null ? '' : n.children));
/** 当前档位表（与 `lib/client.js` 的 `VIEW_KINDS` 同步；改档位要一起改这里）。 */
const VIEW_LABELS = ['卡片', '列表'];
check('显示形式收成一个紧凑按钮，而不是又一条并排的分段控件', () => {
  const btn = rCompact.nodes.find((n) => n.type === 'button' && /^显示：/.test(txt(n)));
  assert(btn, '找不到「显示：xx ▾」按钮 —— 显示形式控件没有收成单个按钮');
  assert(/▾$/.test(txt(btn)), '按钮文本应带 ▾ 提示可展开：' + txt(btn));
  const inlineOpts = rCompact.nodes.filter((n) => n.type === 'button' && VIEW_LABELS.includes(txt(n)));
  assert(inlineOpts.length === 0, '关着浮层时仍渲染了 ' + inlineOpts.length + ' 个并排的视图选项按钮（退回了「一排按钮」）：' + inlineOpts.map(txt).join('/'));
});
check('显示形式浮层：恰好列出全部档位、有且只有 1 个带 ✓ 的当前项，且跟随 dirView', () => {
  const rOpen = renderDir(entries, { prefs: prefsCompact, dirView: 'list', density: null, viewOpen: true });
  const items = rOpen.nodes.filter((n) => n.props && n.props.role === 'menuitemradio');
  // ★ 判据跟随档位表，不写死数字
  assert(items.length === VIEW_LABELS.length, '浮层里应有 ' + VIEW_LABELS.length + ' 个选项，实际 ' + items.length);
  const labels = items.map(txt).join(' ');
  for (const want of VIEW_LABELS) assert(labels.includes(want), '浮层里少了档位「' + want + '」：' + labels);
  assert(!labels.includes('画廊'), '★ 画廊已退役，浮层里不该再出现它：' + labels);
  const checked = items.filter((n) => n.props['aria-checked'] === 'true');
  assert(checked.length === 1, '应恰好 1 个当前项，实际 ' + checked.length);
  assert(txt(checked[0]).includes('列表'), 'dirView=list 时当前项应是「列表」，实际：' + txt(checked[0]));
  assert(txt(checked[0]).includes('✓'), '当前项要带 ✓ 标记：' + txt(checked[0]));
  // 另外几项必须**不带**勾 —— 否则「当前在哪一档」就看不出来了
  const others = items.filter((n) => n.props['aria-checked'] !== 'true');
  assert(others.every((n) => !txt(n).includes('✓')), '非当前项不该出现 ✓');
});

console.log('\n── 校准护栏（见文件头维护须知）──');
// 黄金值：首次渲染（view=dir，无 finder）时整棵树的 useState 调用总数。
// **为什么是相等而不是 >=**：`>=` 只能发现 hook 被删；一旦有人在前面**插入**一个 hook，
// 后面所有值整体后移，按位置喂的 states 会静默错位 —— 断言可能「用错状态也过」。
// 相等判定会把「增删改 hook」一律变成响亮的失败，逼人重新校准。改组件 hook 结构就改这个数。
// 32 → 33（2026-10-06）：`ViewControl` 新增 `sViewOpen`（显示形式浮层开合）。
// 33 → 34（2026-10-08）：`PanelInner` 新增 `sLightbox`（媒体预览浮层；画廊退役后接棒的能力）。
const EXPECTED_HOOK_CALLS = 34;
console.log('  hook 调用 = ' + out.useStateCalls + ' / 期望 = ' + EXPECTED_HOOK_CALLS + ' / 状态槽位 = ' + out.stateSlots);
check('状态队列仍与组件 hook 结构对得上（校准护栏）', () => {
  assert(
    out.useStateCalls === EXPECTED_HOOK_CALLS,
    '首次渲染的 useState 调用数从 ' + EXPECTED_HOOK_CALLS + ' 变成了 ' + out.useStateCalls +
      '（本文件按位置提供 ' + out.stateSlots + ' 个状态槽位）—— hook 结构变了，states 队列很可能已整体错位，' +
      '上面断言的结果不可信。请重新校准 renderDir() 的 states，并把 EXPECTED_HOOK_CALLS 改成新值。'
  );
});


// ══════════════════════════════════════════════════════════════════════════
// 媒体预览浮层（`MediaLightbox`；2026-10-08）
// ══════════════════════════════════════════════════════════════════════════
// 背景：依琪原话「不需要画廊啊，卡片跟列表只要可以快速预览放大图片跟快捷播放视频音频
// 啥的不就好了」⇒ 画廊退役（见 `VIEW_KINDS`），预览浮层接棒。
//
// ⚠️ 本节**只测浮层自己**（纯展示组件，喂 props 就能断言），接线另有两节：
//    · [接线] 卡片缩略图真的调 `openLightbox`（不是"写了个组件没人用"）
//    · [接线] 点缩略图**必须** stopPropagation（否则浮层与详情抽屉会**同时**打开）
console.log('\n── 媒体预览浮层（纯展示 + 接线）──');

const IMG = { id: 'art_i', title: '图.png', path: 'C:\\p\\图.png', mime_type: 'image/png', exists: true, tags: [], stars: 0, artifact_type: 'image' };
const VID = { id: 'art_v', title: '片.mp4', path: 'C:\\p\\片.mp4', mime_type: 'video/mp4', exists: true, tags: [], stars: 0, artifact_type: 'video' };
const AUD = { id: 'art_a', title: '音.mp3', path: 'C:\\p\\音.mp3', mime_type: 'audio/mpeg', exists: true, tags: [], stars: 0, artifact_type: 'audio' };
const DOC = { id: 'art_d', title: '文.md', path: 'C:\\p\\文.md', mime_type: 'text/markdown', exists: true, tags: [], stars: 0, artifact_type: 'document' };
const cardFilters = { q: '', kind: '', refine: '', project: '', sort: 'created_desc', view: 'card', trash: false };
const dataWith = (items) => ({ items, stats: {}, cats: { projects: [], types: [], tags: [] }, loading: false, error: '' });
/** 渲染「卡片视图 + 浮层开着」的树。 */
const renderLb = (items, lb, extra) => renderDir([], Object.assign({ filters: cardFilters, data: dataWith(items), lightbox: lb }, extra || {}));
const lbNode = (r) => r.nodes.find((n) => cls(n) === 'alf__lb');

check('浮层：role=dialog + 可访问名 + 有焦点移入（§11.2，键盘用户不会卡住）', () => {
  const r = renderLb([IMG], { items: [IMG], index: 0, zoom: 0, nat: null });
  const lb = lbNode(r);
  assert(lb, '找不到浮层根节点（class alf__lb）—— 浮层没渲染');
  assert(lb.props.role === 'dialog', 'role 该是 dialog：' + lb.props.role);
  assert(lb.props['aria-modal'] === 'true', 'aria-modal 该是 true');
  assert(lb.props['aria-label'], 'dialog 必须有可访问名（aria-label）');
  assert(lb.props.tabIndex === -1, 'tabIndex 该是 -1（可编程聚焦、不占 Tab 位）');
  assert(lb.props.autoFocus === true, '★ 该有 autoFocus（打开移入焦点）');
});

check('图片：渲染 <img>，且**适应窗口时不定宽高**（交给 CSS，别自己猜尺寸）', () => {
  const r = renderLb([IMG], { items: [IMG], index: 0, zoom: 0, nat: null });
  const img = r.nodes.find((n) => n.type === 'img' && cls(n) === 'alf__lbimg');
  assert(img, '找不到浮层里的 img');
  assert(img.props.src && img.props.src.includes('/art_i/file'), 'src 该指向该记录的 /file 端点：' + img.props.src);
  assert(img.props.style === null, '★ zoom=0（适应窗口）时**不该**写死宽高 —— 否则小图会被拉大：' + JSON.stringify(img.props.style));
});

check('★★ 图片：**zoom=0 但已知原图尺寸**时也必须不写宽高（放大后缩回适应窗口的真实场景）', () => {
  // ⚠️ 这条是**补的**：我第一版只用 `{zoom:0, nat:null}` 验「适应窗口」，
  //    而那个用例里 `nat` 也是空的 ⇒ 把判据从 `zoom>0 && nat` 错写成 `nat`，
  //    它照样绿（变异测试当场证明了这一点）。**真实场景**是：用户放大看了之后
  //    再点一下缩回适应窗口 —— 此时 `nat` **是有值的**，判据必须只看 `zoom`。
  const r = renderLb([IMG], { items: [IMG], index: 0, zoom: 0, nat: { w: 800, h: 600 } });
  const img = r.nodes.find((n) => n.type === 'img' && cls(n) === 'alf__lbimg');
  assert(img, '找不到浮层里的 img');
  assert(img.props.style === null,
    '★ zoom=0 时**无论知不知道原图尺寸**都必须适应窗口；'
    + '否则用户放大后再点一下缩不回去（尺寸被写死了）：' + JSON.stringify(img.props.style));
  assert(img.props['data-zoom'] === null, 'zoom=0 时不该打 data-zoom 标记（CSS 靠它切 cursor）');
});

check('★ 图片：zoom>0 且已知原图尺寸 ⇒ 按**原图像素 × 比例**定宽（放大真的放大）', () => {
  const r = renderLb([IMG], { items: [IMG], index: 0, zoom: 2, nat: { w: 800, h: 600 } });
  const img = r.nodes.find((n) => n.type === 'img' && cls(n) === 'alf__lbimg');
  assert(img, '找不到浮层里的 img');
  assert(img.props.style && img.props.style.width === '1600px',
    '★ 2 倍该是 800×2=1600px，实际 ' + JSON.stringify(img.props.style));
  assert(img.props.style.maxWidth === 'none' && img.props.style.maxHeight === 'none',
    '放大时必须解除 max-width/height，否则被 CSS 卡回原尺寸（点了没反应）');
  assert(img.props['data-zoom'] === '1', '该打上 data-zoom 标记（CSS 靠它切 cursor）');
});

check('★ 图片：zoom>0 但**原图尺寸未知** ⇒ 退化成适应窗口（不许拿 0 去乘）', () => {
  const r = renderLb([IMG], { items: [IMG], index: 0, zoom: 2, nat: null });
  const img = r.nodes.find((n) => n.type === 'img' && cls(n) === 'alf__lbimg');
  assert(img.props.style === null,
    '★ 不知道原图多大时**不能**写死宽高（会得到 0px 或 NaN）—— 该退化成适应窗口：' + JSON.stringify(img.props.style));
});

check('视频：渲染 <video controls autoPlay>，且 key 带 id（切条时元素必须重建）', () => {
  const r = renderLb([VID], { items: [VID], index: 0, zoom: 0, nat: null });
  const v = r.nodes.find((n) => n.type === 'video');
  assert(v, '找不到浮层里的 video');
  assert(v.props.controls === true, '该有播放控件');
  assert(v.props.autoPlay === true, '★ 依琪要「快捷播放」⇒ 打开就该播，不该再点一次');
  assert(String(v.props.key || '').includes(VID.id),
    '★ key 必须带记录 id：否则切上一条时 React 复用同一个 <video>，出现「切了但还在放上一条」');
});

check('音频：渲染 <audio controls autoPlay>（同一个口径）', () => {
  const r = renderLb([AUD], { items: [AUD], index: 0, zoom: 0, nat: null });
  const a = r.nodes.find((n) => n.type === 'audio');
  assert(a, '找不到浮层里的 audio');
  assert(a.props.controls === true && a.props.autoPlay === true, '该有控件且自动播放');
  assert(String(a.props.key || '').includes(AUD.id), 'key 要带 id（同 video）');
});

check('★ 左右切换：单条时**不渲染**导航按钮；多条时到头那侧 disabled（不循环）', () => {
  const one = renderLb([IMG], { items: [IMG], index: 0, zoom: 0, nat: null });
  assert(!one.nodes.some((n) => cls(n).includes('__lbnav')), '★ 只有一条时不该出现左右按钮（没有可切的东西）');
  const three = renderLb([IMG, VID, AUD], { items: [IMG, VID, AUD], index: 0, zoom: 0, nat: null });
  const navs = three.nodes.filter((n) => cls(n).includes('__lbnav'));
  assert(navs.length === 2, '多条时该有 2 个导航按钮，实际 ' + navs.length);
  const prev = navs.find((n) => cls(n).includes('--prev'));
  const next = navs.find((n) => cls(n).includes('--next'));
  assert(prev.props.disabled === true, '★ 第 0 条时「上一条」该 disabled（到头停住，不循环）');
  assert(next.props.disabled !== true, '第 0 条时「下一条」该可用');
  const last = renderLb([IMG, VID, AUD], { items: [IMG, VID, AUD], index: 2, zoom: 0, nat: null });
  const navs2 = last.nodes.filter((n) => cls(n).includes('__lbnav'));
  assert(navs2.find((n) => cls(n).includes('--next')).props.disabled === true, '最后一条时「下一条」该 disabled');
});

check('计数与提示：显示「第几条 / 共几条」，并提示键盘用法', () => {
  const r = renderLb([IMG, VID], { items: [IMG, VID], index: 1, zoom: 0, nat: null });
  const all = r.nodes.map(txt).join(' ');
  assert(all.includes('2 / 2'), '该显示「2 / 2」：' + all.slice(0, 200));
  assert(all.includes('Esc'), '该提示 Esc 关闭（键盘用户要看得见怎么退）');
  assert(all.includes('← →'), '该提示左右键切换');
});

// ══════════════════════════════════════════════════════════════════════════
// ★★ 关闭路径（2026-10-08 · 依琪「最好有个 xx 给鼠标点，而不是光按两下 esc」）
// ══════════════════════════════════════════════════════════════════════════
// 这句反馈里其实有**两个**问题，都得钉住：
//   ① **缺明显的鼠标关闭入口** —— 原来只有一个文字「关闭」按钮，
//      而预览器的习惯位置是右上角的 ×；
//   ② ⚠️⚠️ **要按两下 Esc 才退** —— 这是**真 bug**，不是样式问题：
//      详情抽屉（`DetailDrawer`）的 Escape 监听挂在 **capture 阶段**，
//      而浮层原来挂在 **bubble 阶段** ⇒ 从抽屉里打开浮层时，
//      capture 阶段的抽屉处理器**先**跑并 `stopPropagation()`，
//      事件**永远到不了**浮层的处理器 ⇒ 按一次只关掉底下那层。
//      ⇒ 修法：浮层也挂 capture **且自己 `stopPropagation()`**（它叠在抽屉上面，语义上先归它）。

check('★ 鼠标关闭入口：有一个带 aria-label 的 × 按钮（不只有文字按钮）', () => {
  const r = renderLb([IMG], { items: [IMG], index: 0, zoom: 0, nat: null });
  const btns = r.nodes.filter((n) => n.type === 'button');
  const x = btns.find((n) => txt(n) === '×');
  assert(x, '★ 找不到 × 按钮 —— 依琪要的「有个 xx 给鼠标点」没兑现');
  assert(typeof x.props.onClick === 'function', '× 按钮没有 onClick（点了没反应）');
  // ⚠️ × 是**形状**，读屏听不到 ⇒ 必须有可访问名
  assert(x.props['aria-label'], '★ × 按钮缺 aria-label —— 读屏用户听到的会是「×」这个符号');
  assert(x.props.autoFocus === true, '× 该拿到 autoFocus（它是鼠标/键盘的第一落点）');
});

check('★ 文字「关闭」按钮**仍然保留**（× 是无障碍上的形状，文字是显式标签，不是二选一）', () => {
  const r = renderLb([IMG], { items: [IMG], index: 0, zoom: 0, nat: null });
  const btns = r.nodes.filter((n) => n.type === 'button');
  const textBtn = btns.find((n) => txt(n) === '关闭');
  assert(textBtn, '★ 文字「关闭」按钮被删了 —— × 对读屏用户没有意义，不能只留它');
  assert(typeof textBtn.props.onClick === 'function', '文字按钮没有 onClick');
});

check('★★ Esc 必须挂 **capture 阶段** + `stopPropagation`（否则要按两下才退）', () => {
  // 静态检查：浮层与抽屉的注册阶段无法从渲染树看出，只能在源码上判。
  // ⚠️ 用**剥过注释的** CODE（注释里提到 stopPropagation 不算数 —— 本仓库栽过三次）。
  // ⚠️ 锚点别用 `function MediaLightbox(` —— 那段键盘 effect 在 **`PanelInner`** 里
  //    （浮层是纯展示组件，状态与 effect 都在外层），用它会切到错的区域
  //    （我第一版就这么错的，报「没挂 capture」——**假红**）。
  //    正解：锚在 effect 自己身上 —— 它里面有 `returnFocusTo`（焦点归还用的捕获）。
  const at = CODE.indexOf('var returnFocusTo = null;');
  assert(at >= 0, '找不到浮层的键盘 effect（锚点 `returnFocusTo` 没了？请同步本断言）');
  // 往前一点（含 effect 头），往后取足量
  const body = CODE.slice(Math.max(0, at - 600), at + 4200);
  assert(body.includes('setLightbox'), '切片里没有 setLightbox —— 锚点落错了');
  // ① capture 阶段：`addEventListener("keydown", onKey, true)`
  assert(/addEventListener\(\s*["']keydown["']\s*,\s*onKey\s*,\s*true\s*\)/.test(body),
    '★★ 浮层的 keydown 没挂 capture 阶段（第三参 true）—— 详情抽屉挂的是 capture，'
    + '两者不同阶段时，抽屉会先把 Escape 吃掉并 stopPropagation ⇒ **要按两下才退**');
  // ② Escape 分支里必须 stopPropagation
  // ⚠️ 切片**只到下一个分支为止**：我第一版切 `escAt + 500` 字符，
  //    而**紧跟着的 ArrowLeft 分支也有一个 `stopPropagation`** ⇒ 把 Escape 自己那个
  //    删掉后，切片里仍然能搜到（来自 ArrowLeft）⇒ **变异测试证明了这条是假绿**。
  //    ⇒ 切到 `ArrowLeft` 出现处为止，只看 Escape 分支**自己**那一段。
  const escAt = body.indexOf('key === "Escape"');
  assert(escAt >= 0, '切片里找不到 Escape 分支');
  const arrowAt = body.indexOf('ArrowLeft', escAt);
  assert(arrowAt > escAt, '找不到 Escape 分支的结束位置（下一个分支 ArrowLeft）');
  const escSeg = body.slice(escAt, arrowAt);
  assert(escSeg.length > 20, 'Escape 分支切片太短（' + escSeg.length + '）');
  assert(/stopPropagation/.test(escSeg),
    '★★ Escape 分支里没有 stopPropagation ⇒ 底下的抽屉/列表会**同时**收到 Escape，'
    + '表现就是「按一次只关掉一层」');
  // ③ 清理时也要带同一阶段（否则监听器摘不掉）
  assert(/removeEventListener\(\s*["']keydown["']\s*,\s*onKey\s*,\s*true\s*\)/.test(body),
    '★ 摘监听器时没带 capture 参数 ⇒ 摘不掉（关掉浮层后按键还在改一个看不见的状态）');
});

check('★★ 反向对照：把浮层的 Escape 改回 bubble 阶段 ⇒ 上面那条必须红', () => {
  const at = CODE.indexOf('var returnFocusTo = null;');
  const body = CODE.slice(Math.max(0, at - 600), at + 4200);
  const broken = body
    .replace(/addEventListener\(\s*["']keydown["']\s*,\s*onKey\s*,\s*true\s*\)/, 'addEventListener("keydown", onKey)')
    .replace(/stopPropagation\(\);/g, 'void 0;');
  assert(broken !== body, '反向对照造不出来（替换没生效）⇒ 上面那条可能是空转的');
  const violates = (b) => {
    const e = b.indexOf('key === "Escape"');
    if (e < 0) return true;
    const a = b.indexOf('ArrowLeft', e);
    if (a <= e) return true;
    return !/addEventListener\(\s*["']keydown["']\s*,\s*onKey\s*,\s*true\s*\)/.test(b)
      || !/stopPropagation/.test(b.slice(e, a));
  };
  assert(violates(broken) === true, '★ 坏版本没被抓住 ⇒ 上面那条是空转的');
  // 反向的另一半：**正确**的实现不许被判据抓（判据不能过严）
  assert(violates(body) === false, '★ 正确实现被判据抓了 ⇒ 判据过严');
});

check('★ 反向对照：喂一个**空 items** ⇒ 浮层渲染成 null（不许崩，也不许渲染半个空壳）', () => {
  const r = renderLb([], { items: [], index: 0, zoom: 0, nat: null });
  assert(!lbNode(r), '★ 空 items 时该返回 null；渲染出空壳会让用户看到一块黑屏又关不掉');
});

// ── 接线（**静态检查**，不是渲染树）────────────────────────────────────────
// ⚠️ 为什么这里改用静态检查：卡片渲染要经过「数据 → 筛选 → 视图分支」好几层，
//    在测试里把那一整条路都喂对，成本高、而且**测的是测试床而不是接线本身**。
//    接线的三条要害都能在源码上判死：
//      ① 卡片缩略图挂了 `onPreview`
//      ② 点它**必须** `stopPropagation`（否则浮层与详情抽屉同时开）
//      ③ 只有**媒体**才挂（非媒体给了点击 = "点了没反应"的假暗示）
//    ⚠️ 判据用**剥过注释的**源码：注释里提到这些词不算数（本仓库栽过三次的坑）。
//    ⚠️ `CODE` 的**定义在文件上方**（紧跟 `src`）—— 这里只解释为什么需要它。
//       原来它定义在这一行，但后面新增的用例在它**之前**执行 ⇒ TDZ 报错
//       「Cannot access 'CODE' before initialization」。**常量要定义在所有用它的地方之前。**

check('★ 接线：卡片缩略图挂了 onPreview，且只有**媒体**才挂', () => {
  assert(/onPreview\s*:/.test(CODE), '★ 全文件没有任何 `onPreview:` —— 组件写了却没人接（"写了个组件没人用"）');
  // 卡片里那处：`isMediaRecord(record) && act.onPreview ? function (event) {…} : undefined`
  assert(/isMediaRecord\(record\)\s*&&\s*act\.onPreview/.test(CODE),
    '★ 卡片缩略图的 onClick 没有「是媒体 && 有 onPreview」这道判断 —— '
    + '非媒体也会挂上点击入口（点了没反应，比没有这个功能更让人困惑）');
  // 详情抽屉那处
  assert(/onPreview:\s*function\s*\(record\)/.test(CODE), '★ 详情抽屉没接 onPreview（依琪要求「详情里面点缩略图也可」）');
});

check('★★ 接线：点缩略图**必须** stopPropagation（否则浮层与详情抽屉会同时打开）', () => {
  const at = CODE.indexOf('isMediaRecord(record) && act.onPreview');
  assert(at >= 0, '找不到卡片缩略图的点击分支（前提失效，请同步本断言）');
  const window = CODE.slice(at, at + 400);
  assert(/stopPropagation/.test(window),
    '★★ 那段 onClick 里没有 stopPropagation ⇒ 卡片自己的 onClick 会跟着触发，'
    + '于是「浮层开了、详情抽屉也开了」两层叠在一起');
});

check('★ 接线：详情抽屉里只有**图片**包了点击（视频不包，否则拖进度条会弹浮层）', () => {
  const at = CODE.indexOf('function preview()');
  assert(at >= 0, '找不到 preview()（前提失效）');
  const body = CODE.slice(at, at + 1400);
  const imgAt = body.indexOf('isImage(record)');
  assert(imgAt >= 0, 'preview() 里找不到 isImage 分支');
  // 图片分支里该有 onClick
  assert(/onClick:\s*openIt/.test(body.slice(imgAt, imgAt + 400)), '图片预览没有包点击（详情里点不开浮层）');
  // 视频分支里**不该**有 onClick（它有自己的播放器控件）
  const vidAt = body.indexOf('video/');
  assert(vidAt >= 0, 'preview() 里找不到视频分支');
  const vidSeg = body.slice(vidAt, vidAt + 400);
  assert(!/onClick/.test(vidSeg),
    '★ 视频预览被包了点击 ⇒ 用户想拖进度条却弹了浮层（这条是**反着**验的：不许有）');
});

check('浮层用到的每个 class 都在 CSS 里有定义（真机上没样式 = 裸文字）', () => {
  const used = ['__lb', '__lbhead', '__lbtitle', '__lbcount', '__lbbody', '__lbimg', '__lbmedia',
    '__lbnav', '__lbnav--prev', '__lbnav--next', '__lbfoot', '__lbhint'];
  // 判据：CSS 里得有以这个后缀开头的选择器（`__lb{` / `__lb[...` / `__lb ` / `__lb.`）。
  // ⚠️ 组件里的 class 是**拼出来的**（`NS + "__lb"`），所以不能只搜字面量。
  // ⚠️ 本文件读源码用的是 `src`（不是 `CLIENT_SRC` —— 那是 ui-spec 的叫法）。
  const hasDef = (c) => new RegExp('\\' + c.replace(/-/g, '\\-') + '(?:\\{|\\[|\\s|\\.)').test(src);
  const cssMissing = used.filter((c) => !hasDef(c));
  assert(cssMissing.length === 0, '这些 class 只有使用、没有 CSS 定义（真机上是裸文字）：' + cssMissing.join(', '));
});

check('★ 反向对照：一个**不存在**的 class 会被上面那条判据抓出来', () => {
  const hasDef = (c) => new RegExp('\\' + c.replace(/-/g, '\\-') + '(?:\\{|\\[|\\s|\\.)').test(src);
  assert(!hasDef('__lbdoesnotexist'), '★ 判据对不存在的 class 也返回"有定义" ⇒ 它是恒真的（空转）');
});


if (failureList.length) {
  console.log('\n── 失败清单 ──');
  for (const f2 of failureList) console.log('      · ' + f2.name + ' -> ' + f2.message);
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
