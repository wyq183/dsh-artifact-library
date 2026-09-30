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
const HOOK = 'exports.__test = { sessionChangesUrl: sessionChangesUrl, normalizeChanges: normalizeChanges, thumbUrlsFor: thumbUrlsFor, officialFileUrl: officialFileUrl, CHANGES_ROUTE: CHANGES_ROUTE, atMention: atMention, parseAtValue: parseAtValue, registerAtSource: registerAtSource, AT_SOURCE_NAME: AT_SOURCE_NAME };\n    exports.apply = apply;';
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

console.log('\n── 端点适配（URL 只在这一处拼）──');
check('不带参数 = 宿主自行取最近一轮', () => assert(T.sessionChangesUrl() === T.CHANGES_ROUTE, T.sessionChangesUrl()));
check('带 sessionId 时正确拼接并编码', () => {
  assert(T.sessionChangesUrl('s-1') === T.CHANGES_ROUTE + '?sessionId=s-1', T.sessionChangesUrl('s-1'));
  assert(T.sessionChangesUrl('s 1&x') === T.CHANGES_ROUTE + '?sessionId=s%201%26x', T.sessionChangesUrl('s 1&x'));
});
check('带 seq 时两个参数都在', () => {
  const u = T.sessionChangesUrl('s-1', 7);
  assert(u.indexOf('sessionId=s-1') >= 0 && u.indexOf('seq=7') >= 0, u);
});
check('空 seq 不产生空参数', () => {
  const u = T.sessionChangesUrl('s-1', '');
  assert(u.indexOf('seq=') < 0, u);
});

console.log('\n── 返回规范化（官方原样字段：added/deleted/binary/oversized + cwd）──');
check('files[] → 行模型（cwd 拼绝对 + name/dir/index）', () => {
  const rows = T.normalizeChanges({ cwd: 'C:\\proj', files: [{ path: 'src/a.md', display: 'src/a.md', added: 12, deleted: 3 }] });
  assert(rows.length === 1, 'rows=' + rows.length);
  assert(rows[0].path === 'C:\\proj\\src\\a.md', 'cwd 没拼上: ' + rows[0].path);
  assert(rows[0].name === 'a.md', 'name=' + rows[0].name);
  assert(rows[0].dir === 'C:\\proj\\src\\', 'dir=' + rows[0].dir);
  assert(rows[0].added === 12 && rows[0].deleted === 3, '行数不对: ' + JSON.stringify(rows[0]));
  assert(rows[0].index === 0, 'index 应是数组下标');
});
check('cwd 外的绝对路径原样保留', () => {
  const rows = T.normalizeChanges({ cwd: 'C:\\proj', files: [{ path: 'D:\\outside\\bin.dat', added: 1, deleted: 0 }] });
  assert(rows[0].path === 'D:\\outside\\bin.dat', rows[0].path);
});
check('容忍 changes[] 与旧字段名 removed（过渡期兼容）', () => {
  const rows = T.normalizeChanges({ changes: [{ path: '/tmp/x.ts', added: 1, removed: 2 }] });
  assert(rows.length === 1 && rows[0].name === 'x.ts', JSON.stringify(rows));
  assert(rows[0].deleted === 2, 'removed 应映射到 deleted: ' + rows[0].deleted);
});
check('binary / oversized 是真布尔，且行数为 0', () => {
  const rows = T.normalizeChanges({ files: [{ path: 'a.bin', binary: true }, { path: 'big.txt', oversized: true }] });
  assert(rows[0].binary === true && rows[0].oversized === false, JSON.stringify(rows[0]));
  assert(rows[1].oversized === true && rows[1].binary === false, JSON.stringify(rows[1]));
  assert(rows[0].added === 0 && rows[0].deleted === 0, '没有行数时应为 0');
});
check('负数/非数字行数被夹成 0', () => {
  const rows = T.normalizeChanges({ files: [{ path: 'C:\\p\\c', added: -5, deleted: 'x' }] });
  assert(rows[0].added === 0 && rows[0].deleted === 0, JSON.stringify(rows[0]));
});
check('空/畸形返回不抛', () => {
  assert(T.normalizeChanges(undefined).length === 0, 'undefined');
  assert(T.normalizeChanges({}).length === 0, '空对象');
  assert(T.normalizeChanges({ files: null }).length === 0, 'files=null');
});
check('index 缺失时用数组下标兜底', () => {
  const rows = T.normalizeChanges({ files: [{ path: 'C:\\p\\d' }, { path: 'C:\\p\\e' }] });
  assert(rows[0].index === 0 && rows[1].index === 1, JSON.stringify(rows.map((r) => r.index)));
});

console.log('\n── 缩略图两级 URL（自建优先 / 官方后备）──');
check('自建端点为首选（根相对，过 assertInScope）', () => {
  const u = T.thumbUrlsFor({ name: 'a.png', path: 'C:\\p\\a.png', size: 100, isDirectory: false });
  assert(u && u.primary.indexOf('/ext/artifacts/files/thumb?path=') === 0, JSON.stringify(u));
});
check('官方 api/file 作为后备保留', () => {
  const u = T.thumbUrlsFor({ name: 'a.png', path: 'C:\\p\\a.png', size: 100, isDirectory: false });
  assert(u.fallback.indexOf('/api/file?path=') >= 0, 'fallback=' + u.fallback);
});
check('非图片 / 目录 / 符号链接 / >5MB 都不出缩略图', () => {
  assert(T.thumbUrlsFor({ name: 'a.md', path: 'C:\\p\\a.md', size: 1, isDirectory: false }) === null, 'md');
  assert(T.thumbUrlsFor({ name: 'd', path: 'C:\\p\\d\\', size: 0, isDirectory: true }) === null, '目录');
  assert(T.thumbUrlsFor({ name: 'l.png', path: 'C:\\p\\l.png', size: 1, isDirectory: false, isSymbolicLink: true }) === null, '链接');
  assert(T.thumbUrlsFor({ name: 'big.png', path: 'C:\\p\\big.png', size: 6 * 1024 * 1024, isDirectory: false }) === null, '>5MB');
});
check('自建 URL 对中文与空格都编码', () => {
  const u = T.thumbUrlsFor({ name: '中 文.png', path: 'C:\\p\\中 文.png', size: 1, isDirectory: false });
  assert(u.primary.indexOf('%20') >= 0 && u.primary.indexOf('%E4%B8%AD') >= 0, u.primary);
});

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
check('inputTriggers 不可用时优雅跳过（返回 null、不抛）', () => {
  assert(T.registerAtSource({ get: () => undefined }) === null, 'should return null');
  assert(T.registerAtSource(undefined) === null, 'undefined ctx should return null');
  assert(T.registerAtSource({ get: () => { throw new Error('boom'); } }) === null, 'throwing get should return null');
  assert(T.registerAtSource({ get: () => ({ registerSource: () => { throw new Error('dup'); } }) }) === null, 'register throw → null');
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
