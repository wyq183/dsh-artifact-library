/**
 * dsh-artifact-library · 客户端**纯函数适配层**测试
 *
 * 覆盖三类「静默易坏」的契约（都不是渲染层，所以不受 DOM/状态队列影响）：
 *   1. `sessionChangesUrl` —— 端点 URL 只在这一处拼（编码、空参、多参）
 *   2. `normalizeChanges` —— 吃宿主「官方原样字段」（added/deleted/binary/oversized + cwd）
 *   3. `thumbUrlsFor` —— 缩略图两级 URL（自建优先 / 官方后备）+ 四类门槛
 *   4. `atMention` / `parseAtValue` / `registerAtSource` —— @ 引用来源（mention 形状、
 *      坏路径拒收、onPick 产出真引用 insert、旧宿主优雅降级）
 *
 * 来源：由 ui-core 的临时冒烟 `scratch/render-check4.cjs` 收编而来（2026-09-30），
 * 检查项与判据保持原样，只做了三件事：① CommonJS → ESM；② 硬编码绝对路径 → 相对本文件
 * （支持 `argv[2]` 覆盖，便于 bite-test）；③ 输出统一成 `结果：N 通过 / M 失败` + 非零退出码。
 *
 * 手法说明：这些函数是模块私有的，脚本用一次**源码字符串注入**
 * （把 `exports.apply = apply;` 前面插一段 `exports.__test = {…}`）把它们暴露出来 ——
 * 不改仓库源文件。注入失败会**显式报错**（见下方「测试钩子」那条），不会静默变成空跑。
 * 因为是纯函数，本文件**不需要** client-render 那种「校准护栏」（没有按位置喂的队列）。
 *
 * 运行：node test/client-pure.test.mjs [client.js 路径]
 * 退出码：有失败 → 1
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_PATH = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../lib/client.js', import.meta.url));
const ROOT = path.dirname(path.dirname(CLIENT_PATH));

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

console.log('\n═══ 客户端纯函数适配层 ═══');
console.log(' 被测：' + CLIENT_PATH);

// ── 载入并注入测试钩子（不改源文件）────────────────────────────────────────
// ⚠️ 2026-10-14：`sessionChangesUrl` / `normalizeChanges` / `thumbUrlsFor` /
//    `officialFileUrl` 随主面板删了（能力搬进 `ui/index.html`）。
//    那几节改成**抠网页版实现来测**（见本文件后半的 [W] 节）。
const HOOK = 'exports.__test = { atMention: atMention, parseAtValue: parseAtValue, registerAtSource: registerAtSource, AT_SOURCE_NAME: AT_SOURCE_NAME };\n    exports.apply = apply;';
const ANCHOR = 'exports.apply = apply;';
const raw = fs.readFileSync(CLIENT_PATH, 'utf8');
const src = raw.replace(ANCHOR, HOOK);

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
  setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise, Intl, Date, isFinite, parseFloat, encodeURIComponent,
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => '' }),
  location: { search: '' },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
assert(captured && typeof captured.factory === 'function', 'factory 未被注册（client.js 入口形态变了？）');

const mod = captured.factory((name) =>
  name === 'react'
    ? { createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useCallback: (f) => f, useRef: (v) => ({ current: v }) }
    : {}
);
mod.apply({ get: () => undefined }); // 跑完 factory，让 exports.__test 挂上

check('测试钩子注入成功（依赖 client.js 里 `exports.apply = apply;` 这一行）', () => {
  assert(mod.__test, '注入失败：找不到锚点 `' + ANCHOR + '` —— 该行被改名/改形了，请同步更新本文件的 HOOK/ANCHOR');
});
const T = mod.__test || {};

console.log('\n── [W] 网页版（ui/index.html）的纯函数：抠出来**行为级**测 ──');
// ⚠️ 这几条原来是测 `lib/client.js` 的同名函数的（注入 HOOK 后调）。
//    那些函数 2026-10-14 随主面板删了，**能力搬进了网页版** ⇒ 测试跟着搬。
//    做法：把网页版 <script> 里那几个函数抠出来，用 vm 求值 —— 测的就是**真机跑的那份**。
{
  const UI = path.join(ROOT, 'ui', 'index.html');
  const html = fs.readFileSync(UI, 'utf8');
  const js = (/<script>([\s\S]*?)<\/script>/.exec(html) || [])[1] || '';
  assert(js.length > 10000, '抠不出网页版的 script（<script> 锚点变了？）');

  // ⚠️ 抠取区间要**覆盖全部要测的函数**。第一版从 `isWindowsPath` 开始 ⇒
  //    漏掉了排在它**前面**的 `THUMB_EXTS` / `thumbUrlsFor` ⇒ `ReferenceError`。
  //    现在从 `const THUMB_EXTS` 到 `skeletonHtml`（那一段正好是这一批搬过来的）。
  const from = js.indexOf('const THUMB_EXTS =');
  const to = js.indexOf('function skeletonHtml(');
  assert(from >= 0 && to > from, '抠不出缩略图/路径那一段（函数改名或调序了？）');
  const code = js.slice(from, to);

  // ⚠️ `officialFileUrl` 用 `location.origin` ⇒ sandbox 必须给 location，否则报未定义
  const box = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    URL, isFinite, Number, String, Math, Array, Object, JSON, RegExp,
    location: { origin: 'http://127.0.0.1:19387' },
  };
  box.globalThis = box;
  vm.createContext(box);
  // ⚠️ 这几个是网页版的**模块级常量**（被抠出来的函数引用着）——
  //    不补进 sandbox 就会 `ReferenceError: API is not defined`。
  box.API = '/ext/artifacts'
  box.location = { origin: 'http://127.0.0.1:19387' }

  vm.runInContext(code + '\n;this.absoluteUnder=absoluteUnder;this.isWindowsPath=isWindowsPath;'
    + 'this.normalizeChanges=normalizeChanges;this.splitPathParts=splitPathParts;'
    + 'this.thumbUrlsFor=thumbUrlsFor;this.officialFileUrl=officialFileUrl;this.extOfName=extOfName;'
    + 'this.chipOfName=chipOfName;this.chipMatches=chipMatches;this.CHIP_EXTS=CHIP_EXTS;', box);

  // ── 缩略图两级 URL ──
  check('[W] 缩略图：自建端点为首选（根相对，过 assertInScope）', () => {
    const u = box.thumbUrlsFor({ name: 'a.png', path: 'C:\\p\\a.png', size: 100, isDirectory: false });
    assert(u && u.primary.indexOf('/ext/artifacts/files/thumb?path=') === 0, JSON.stringify(u));
  });
  check('[W] 缩略图：官方 api/file 作为后备保留', () => {
    const u = box.thumbUrlsFor({ name: 'a.png', path: 'C:\\p\\a.png', size: 100, isDirectory: false });
    assert(u.fallback.indexOf('/api/file?path=') >= 0, 'fallback=' + u.fallback);
  });
  check('[W] 缩略图：非图片 / 目录 / 符号链接 / >5MB 都不出', () => {
    assert(box.thumbUrlsFor({ name: 'a.md', path: 'C:\\p\\a.md', size: 1 }) === null, 'md');
    assert(box.thumbUrlsFor({ name: 'd', path: 'C:\\p\\d', size: 0, isDirectory: true }) === null, '目录');
    assert(box.thumbUrlsFor({ name: 'l.png', path: 'C:\\p\\l.png', size: 1, isSymbolicLink: true }) === null, '链接');
    assert(box.thumbUrlsFor({ name: 'big.png', path: 'C:\\p\\big.png', size: 6 * 1024 * 1024 }) === null, '>5MB');
  });
  check('[W] 缩略图：中文与空格都编码', () => {
    const u = box.thumbUrlsFor({ name: '中 文.png', path: 'C:\\p\\中 文.png', size: 1 });
    assert(u.primary.indexOf('%20') >= 0 && u.primary.indexOf('%E4%B8%AD') >= 0, u.primary);
  });
  check('[W] 官方后备 URL：拒绝相对路径 / UNC / 控制字符（三道闸门）', () => {
    assert(box.officialFileUrl('rel/a.png') === '', '相对路径该拒');
    assert(box.officialFileUrl('\\\\srv\\share\\a.png') === '', 'UNC 该拒');
    assert(box.officialFileUrl('C:\\p\\a\u0001b.png') === '', '控制字符该拒');
    assert(box.officialFileUrl('C:\\p\\a.png').indexOf('/api/file?path=') >= 0, '正常路径该给');
  });

  // ── 路径拼接 ──
  check('[W] ★ 分隔符跟着 base 形态走（POSIX 上不许出现反斜杠）', () => {
    assert(box.absoluteUnder('C:\\proj', 'src/a.md') === 'C:\\proj\\src\\a.md', box.absoluteUnder('C:\\proj', 'src/a.md'));
    assert(box.absoluteUnder('/home/x/proj', 'src/a.md') === '/home/x/proj/src/a.md',
      '★ POSIX base 拼出了反斜杠：' + box.absoluteUnder('/home/x/proj', 'src/a.md'));
  });

  // ── 会话改动规范化 ──
  check('[W] normalizeChanges：cwd 拼绝对 + name/dir/index', () => {
    const rows = box.normalizeChanges({ cwd: 'C:\\proj', files: [{ path: 'src/a.md', display: 'src/a.md', added: 12, deleted: 3 }] });
    assert(rows.length === 1, 'rows=' + rows.length);
    assert(rows[0].path === 'C:\\proj\\src\\a.md', 'cwd 没拼上: ' + rows[0].path);
    assert(rows[0].name === 'a.md', 'name=' + rows[0].name);
    assert(rows[0].added === 12 && rows[0].deleted === 3, JSON.stringify(rows[0]));
    assert(rows[0].index === 0, 'index 应是数组下标');
  });
  check('[W] normalizeChanges：cwd 外的绝对路径原样保留', () => {
    const rows = box.normalizeChanges({ cwd: 'C:\\proj', files: [{ path: 'D:\\outside\\bin.dat', added: 1 }] });
    assert(rows[0].path === 'D:\\outside\\bin.dat', rows[0].path);
  });
  check('[W] normalizeChanges：旧字段名 removed 也认（过渡期兼容）', () => {
    const rows = box.normalizeChanges({ changes: [{ path: '/tmp/x.ts', added: 1, removed: 2 }] });
    assert(rows.length === 1 && rows[0].name === 'x.ts', JSON.stringify(rows));
    assert(rows[0].deleted === 2, 'removed 应映射到 deleted: ' + rows[0].deleted);
  });
  check('[W] normalizeChanges：binary / oversized 是真布尔', () => {
    const rows = box.normalizeChanges({ files: [{ path: 'a.bin', binary: true }, { path: 'big.txt', oversized: true }] });
    assert(rows[0].binary === true && rows[0].oversized === false, JSON.stringify(rows[0]));
    assert(rows[1].oversized === true && rows[1].binary === false, JSON.stringify(rows[1]));
  });
  check('[W] normalizeChanges：负数/非数字行数被夹成 0', () => {
    const rows = box.normalizeChanges({ files: [{ path: 'C:\\p\\c', added: -5, deleted: 'x' }] });
    assert(rows[0].added === 0 && rows[0].deleted === 0, JSON.stringify(rows[0]));
  });
  check('[W] normalizeChanges：空/畸形返回不抛', () => {
    assert(box.normalizeChanges(undefined).length === 0, 'undefined');
    assert(box.normalizeChanges({}).length === 0, '空对象');
    assert(box.normalizeChanges({ files: null }).length === 0, 'files=null');
  });
  check('[W] ★ 反向对照：把"无条件用反斜杠"的写法跑一遍，它必须**错**', () => {
    // 证明上面那条 POSIX 判据不是空转
    const WRONG = (cwd, p) => String(cwd).replace(/[\\/]+$/, '') + '\\' + String(p).replace(/^[\\/]+/, '');
    const bad = WRONG('/home/x/proj', 'src/a.md');
    assert(bad !== box.absoluteUnder('/home/x/proj', 'src/a.md'),
      '★ 正确实现与错写法结果相同 ⇒ 那条判据没咬住');
    assert(bad.indexOf('\\') >= 0 && bad.indexOf('/home') === 0, '对照前提失效: ' + bad);
  });
}

console.log('\n── @ 引用来源（照抄 ui-reference 结构）──');
check('mention 形状：无空格 @path / 含空格 @"path" / 目录带尾斜杠', () => {
  assert(T.atMention('C:\\a\\b.md', false) === '@C:/a/b.md', T.atMention('C:\\a\\b.md', false));
  assert(T.atMention('C:\\a b\\c.md', false) === '@"C:/a b/c.md"', T.atMention('C:\\a b\\c.md', false));
  assert(T.atMention('C:\\a\\b', true) === '@C:/a/b/', T.atMention('C:\\a\\b', true));
  assert(T.atMention('C:\\a b', true) === '@"C:/a b/', T.atMention('C:\\a b', true));
});
check('含引号/控制字符的路径判为不可用（不给坏引用）', () => {
  assert(T.atMention('C:\\a"b.md', false) === '', 'should reject quote');
  assert(T.atMention('C:\\a\u0001b.md', false) === '', 'should reject control char');
});
check('候选 value ↔ parseAtValue 往返', () => {
  const v = JSON.stringify({ path: 'C:\\p\\a.md', label: 'a.md', dir: false });
  const parsed = T.parseAtValue(v);
  assert(parsed && parsed.path === 'C:\\p\\a.md' && parsed.isDirectory === false, JSON.stringify(parsed));
  assert(T.parseAtValue('not json') === null, 'malformed should be null');
  assert(T.parseAtValue(undefined) === null, 'undefined should be null');
});
check('inputTriggers 可用时注册成功，onPick 产出真引用 insert', () => {
  let registered = null;
  let unregistered = 0;
  const ctx = { get: (name) => (name === 'inputTriggers' ? { registerSource: (s) => { registered = s; return () => { unregistered += 1; }; } } : undefined) };
  const dispose = T.registerAtSource(ctx);
  assert(registered, '没有注册 source');
  assert(registered.trigger === '@', 'trigger 不是 @');
  assert(registered.name === T.AT_SOURCE_NAME, 'name 不对: ' + registered.name);
  assert(typeof registered.codec.serialize === 'function', '缺 codec.serialize（insert.source 靠它序列化）');
  const out = registered.onPick({ candidate: { value: JSON.stringify({ path: 'C:\\p\\x.png', label: 'x.png', dir: false }) } });
  assert(out && out.insert, 'onPick 没返回 insert');
  assert(out.insert.source === T.AT_SOURCE_NAME, 'insert.source 必须是本来源名，否则宿主找不到 codec: ' + out.insert.source);
  assert(out.insert.ref === '@C:/p/x.png', 'ref 不对: ' + out.insert.ref);
  assert(out.insert.appearance === 'file', 'appearance 不对');
  assert(out.insert.clipboardText === '@C:/p/x.png', 'clipboardText 不对');
  assert(typeof dispose === 'function', '没返回 disposer');
  dispose();
  assert(unregistered === 1, 'disposer 没注销: ' + unregistered);
});
// ⚠️ **这里是三态契约，不是「都返回 null」**（2026-10-06 改，小琪琪复核逮到的洞）。
//    旧断言把「服务没到」和「注册真抛了」写成同一个 null —— 而调用方（apply 里的重试包装）
//    正是靠这个返回值决定要不要再试：两者混在一起 ⇒ **永久失败被重试 20 次刷屏**。
//    现在：undefined = 服务还没到（可重试）；null = 注册真抛了（永久，调用方必须立刻停）。
check('inputTriggers 不可用时返回 undefined（服务还没到 → 可重试，不抛）', () => {
  assert(T.registerAtSource({ get: () => undefined }) === undefined, '服务缺席应 undefined');
  assert(T.registerAtSource(undefined) === undefined, 'undefined ctx 应 undefined');
  assert(T.registerAtSource(null) === undefined, 'null ctx 应 undefined');
  assert(T.registerAtSource({ get: () => { throw new Error('boom'); } }) === undefined, 'get 抛错应 undefined（当服务没到）');
  assert(T.registerAtSource({ get: () => ({}) }) === undefined, 'registerSource 不是函数应 undefined');
});
check('注册真抛了返回 null（永久失败 → 调用方必须停止重试）', () => {
  const r = T.registerAtSource({ get: () => ({ registerSource: () => { throw new Error('dup'); } }) });
  assert(r === null, 'register throw → null（不能是 undefined，否则会被重试 20 次）');
});
// 源码级钉死：apply 侧必须把 null 当永久失败。这条如果被改坏，
// 「永久失败重试 20 次」会静默回来，而上面那两条断言照样通过。
check('apply 源码：null → atFatal，且三种结局都写进 probe', () => {
  const src = fs.readFileSync(CLIENT_PATH, 'utf8');
  const at = src.indexOf('var atFatal = false');
  assert(at > 0, '找不到 apply 里的 atFatal 块');
  const block = src.slice(at, at + 4000);
  assert(/if \(disposer === null\) atFatal = true;/.test(block), 'null 必须置 atFatal');
  assert(/else if \(atFatal\)/.test(block), '首次即永久失败时不能再排重试');
  assert(/at-reg@/.test(block) && /at-fatal@/.test(block) && /at-giveup@/.test(block), '三种结局都要进 probe');
});
check('onPick 遇到坏候选返回 undefined（不插坏引用）', () => {
  let registered = null;
  const ctx = { get: () => ({ registerSource: (s) => { registered = s; return () => {}; } }) };
  T.registerAtSource(ctx);
  assert(registered.onPick({ candidate: { value: 'garbage' } }) === undefined, '坏 value 应 undefined');
  assert(registered.onPick({}) === undefined, '空 pick 应 undefined');
});
check('apply 在没有 inputTriggers 的 ctx 下不抛且返回 disposer', () => {
  const disposer = mod.apply({ get: () => ({ inject: (n, f) => f(), register: () => () => {} }) });
  assert(typeof disposer === 'function', 'apply 应返回 disposer');
  disposer();
});

if (failureList.length) {
  console.log('\n── 失败清单 ──');
  for (const f of failureList) console.log('      · ' + f.name + ' -> ' + f.message);
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
