/**
 * 离线 harness：CSRF 栅栏（R-5.3）+ 导入根目录判据统一（R-5.1）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 安全铁律：**测试自己不能成为攻击路径**
 * ═══════════════════════════════════════════════════════════════════════════
 *   · 本文件**不调用** `/import`、`/cleanup-now`、`/:id/trash` —— 那些会改数据。
 *   · 打栅栏用**纯判定函数** + 一个**假的 handler**（只记「有没有被调用」），
 *     **根本不经过真路由** → 不存在副作用。
 *   · 这正是 2026-09-30 验证 R-5.3 时的做法（当时用无副作用的 `/refine-request`）。
 *
 * 用法：node test/csrf-guard.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  checkWriteRequest, guardWrites, handlePreflight,
  CSRF_HEADER, SAFE_METHODS, DEFAULT_ALLOWED_ORIGINS,
} from '../lib/csrf-guard.js'
import { checkImportRoot, isSensitivePath, ArtifactStore } from '../lib/store.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-csrf-'))
const LIB = fileURLToPath(new URL('../lib', import.meta.url))
const OK_HEADERS = { [CSRF_HEADER]: '1' }

function makeRes() {
  const chunks = []
  const res = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
  res.statusCode = 0
  res.headers = {}
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}); return res }
  res.bodyText = () => Buffer.concat(chunks).toString('utf8')
  res.json = () => JSON.parse(res.bodyText())
  return res
}
function reqOf(method, headers = {}) {
  return { method, url: '/ext/artifacts/x', headers, socket: { remoteAddress: '127.0.0.1' } }
}
/** 假 handler：只记「被调用了没」—— 用它测栅栏，**不碰真路由** */
function makeSpyHandler() {
  const spy = { calls: 0 }
  spy.handler = async (req, res) => { spy.calls += 1; res.writeHead(200, {}); res.end('{"ok":true}') }
  return spy
}

// ═══ [1] 两道栅栏的存在性（对已验证的攻击形状）═════════════════════════
console.log('\n=== [1] 已实测的攻击形状必须被挡住 ===')
{
  const attack = reqOf('POST', {
    'content-type': 'text/plain',
    origin: 'http://evil.example',
    referer: 'http://evil.example/attack.html',
    host: '127.0.0.1:19387',
    // ⚠️ 恶意页面**发不出**自定义头（会触发预检），所以这里故意不带
  })
  const v = checkWriteRequest(attack)
  check('★★ 2026-09-30 实测可打通的形状（text/plain + 跨源 Origin）现在被拒', () => {
    assert(v.ok === false, '★ 仍然放行！（这正是那条已验证的漏洞）')
    assert(v.reason === 'cross-origin-blocked', 'reason: ' + v.reason)
    assert(v.status === 403, 'status: ' + v.status)
  })
  check('★ 被拒时给出 reason + 可照做的 hint（调用方不用解析文本）', () => {
    assert(typeof v.message === 'string' && v.message.length > 0, '缺 message')
    assert(typeof v.hint === 'string' && v.hint.length > 0, '缺 hint')
  })
  check('★ 即使 Origin 被抹掉（代理/工具），**第二道**仍然拦住（缺自定义头）', () => {
    const noOrigin = checkWriteRequest(reqOf('POST', { host: '127.0.0.1:19387', 'content-type': 'text/plain' }))
    assert(noOrigin.ok === false, '★ 抹掉 Origin 就放行了 = 纵深防御没做到')
    assert(noOrigin.reason === 'csrf-header-missing', 'reason: ' + noOrigin.reason)
  })
  check('★ `Origin: null`（沙箱 iframe / data: / file:）一律拒绝', () => {
    const v2 = checkWriteRequest(reqOf('POST', { origin: 'null', host: '127.0.0.1:19387', ...OK_HEADERS }))
    assert(v2.ok === false, '★ Origin: null 被放行了')
    assert(v2.reason === 'cross-origin-blocked', 'reason: ' + v2.reason)
  })
  check('★ 跨源 Referer（没有 Origin 时）也拒', () => {
    const v3 = checkWriteRequest(reqOf('POST', { referer: 'http://evil.example/x.html', host: '127.0.0.1:19387', ...OK_HEADERS }))
    assert(v3.ok === false && v3.reason === 'cross-origin-blocked', 'reason: ' + v3.reason)
  })
  check('★ 跨源 + 自定义头齐全 —— 仍然拒（两道都要过）', () => {
    const v4 = checkWriteRequest(reqOf('POST', { origin: 'http://evil.example', host: '127.0.0.1:19387', ...OK_HEADERS }))
    assert(v4.ok === false, '★ 带上头就放行了 —— 第一道形同虚设')
  })
}

// ═══ [2] ★ 不能误伤真实调用方（这一节比「拦住攻击」更容易出事）════════
console.log('\n=== [2] 真实调用方一个都不能打死（误伤 = 改完就坏）===')
{
  check('★★ 桌面端面板（源 dsh-app://app）的写请求必须放行 —— 否则所有写操作全死', () => {
    const v = checkWriteRequest(reqOf('POST', {
      origin: 'dsh-app://app', host: '127.0.0.1:19387', 'content-type': 'application/json', ...OK_HEADERS,
    }))
    assert(v.ok === true, '★ 面板的写请求被拒了！reason=' + v.reason)
  })
  check(`默认白名单里有 dsh-app://app（写死在这里，防止有人"顺手清空"）`, () => {
    assert(DEFAULT_ALLOWED_ORIGINS.includes('dsh-app://app'), '默认白名单: ' + JSON.stringify(DEFAULT_ALLOWED_ORIGINS))
  })
  check('★ 同源（面板在 web GUI 里以 http 打开）放行：Origin 与 Host 一致', () => {
    const v = checkWriteRequest(reqOf('PUT', {
      origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387', ...OK_HEADERS,
    }))
    assert(v.ok === true, '同源被误拒: reason=' + v.reason)
  })
  check('★ 同源 + localhost 写法（页面与请求同一个 host）放行', () => {
    const v = checkWriteRequest(reqOf('POST', { origin: 'http://localhost:19387', host: 'localhost:19387', ...OK_HEADERS }))
    assert(v.ok === true, '被误拒: ' + v.reason)
  })
  check('★★ GET 完全不受影响（缩略图 <img> 发不了自定义头，栅栏管 GET 会把图全打死）', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      assert(SAFE_METHODS.has(m), m + ' 应视为安全方法')
      const v = checkWriteRequest(reqOf(m, { origin: 'http://evil.example' }))
      assert(v.ok === true, m + ' 被拦了 —— 缩略图/列表会挂')
    }
  })
  check('★ 命令行/脚本调用方（无 Origin、无 Referer）只要带头就放行', () => {
    const v = checkWriteRequest(reqOf('POST', { host: '127.0.0.1:19387', ...OK_HEADERS }))
    assert(v.ok === true, '脚本被误拒: ' + v.reason)
  })
  check('★ 没有 Host 头（HTTP/1.0 之类）不阻断 —— 只在能**证明**跨源时才拒', () => {
    const v = checkWriteRequest(reqOf('POST', { origin: 'http://127.0.0.1:19387', ...OK_HEADERS }))
    assert(v.ok === true, '缺 Host 被误拒: ' + v.reason)
  })
  check('自定义头的名字大小写不敏感（HTTP 头本来就不敏感）', () => {
    const v = checkWriteRequest(reqOf('POST', { host: 'h', 'X-DSH-Artifacts': '1' }))
    assert(v.ok === true, '大写形式被误拒')
  })
  check('自定义头为空串 = 没带（不能靠一个空头蒙过去）', () => {
    const v = checkWriteRequest(reqOf('POST', { host: 'h', [CSRF_HEADER]: '' }))
    assert(v.ok === false && v.reason === 'csrf-header-missing', '空头被放行')
  })
}

// ═══ [3] 预检：只对白名单来源回，且**绝不回 `*`** ══════════════════════
console.log('\n=== [3] CORS 预检（第二道起作用的地方）===')
{
  const okRes = makeRes()
  handlePreflight(reqOf('OPTIONS', { origin: 'dsh-app://app' }), okRes)
  check('★ 白名单来源的预检：204 + 允许自定义头（面板跨源时靠它）', () => {
    assert(okRes.statusCode === 204, '状态码 ' + okRes.statusCode)
    assert(String(okRes.headers['access-control-allow-origin']) === 'dsh-app://app', 'ACAO: ' + okRes.headers['access-control-allow-origin'])
    assert(String(okRes.headers['access-control-allow-headers']).toLowerCase().includes(CSRF_HEADER), '没允许自定义头')
  })
  const evilRes = makeRes()
  handlePreflight(reqOf('OPTIONS', { origin: 'http://evil.example' }), evilRes)
  check('★★ 非白名单来源的预检：403，且**不回任何 CORS 头**', () => {
    assert(evilRes.statusCode === 403, '状态码 ' + evilRes.statusCode)
    assert(evilRes.headers['access-control-allow-origin'] === undefined, '★ 给恶意来源回了 ACAO —— 第二道当场作废')
  })
  check('★★ 任何响应里都不允许出现 `Access-Control-Allow-Origin: *`', () => {
    const src = fs.readFileSync(path.join(LIB, 'csrf-guard.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    assert(!/'access-control-allow-origin':\s*'\*'/.test(src), '★ 出现了通配 ACAO')
    assert(!/allow-origin.*\*/.test(src), '★ 出现了通配 ACAO')
  })
}

// ═══ [4] 栅栏包装器：拦住的请求**绝不能到达** handler ═════════════════
console.log('\n=== [4] 拦住了就不能进 handler（最关键的一条）===')
{
  const spy1 = makeSpyHandler()
  const guarded = guardWrites(spy1.handler)
  const res1 = makeRes()
  await guarded(reqOf('POST', { origin: 'http://evil.example', host: '127.0.0.1:19387', 'content-type': 'text/plain' }), res1)
  check('★★★ 攻击请求：403 且 **handler 一次都没被调用**', () => {
    assert(res1.statusCode === 403, '状态码 ' + res1.statusCode)
    assert(spy1.calls === 0, '★ handler 被调用了 ' + spy1.calls + ' 次 —— 栅栏只挡了响应没挡执行！')
  })
  check('★ 被拒的响应体是结构化失败形状（ok/reason/error/message/hint）', () => {
    const b = res1.json()
    assert(b.ok === false && typeof b.reason === 'string' && typeof b.error === 'string', 'body: ' + res1.bodyText())
    assert(typeof b.hint === 'string', '缺 hint')
  })
  const spy2 = makeSpyHandler()
  const guarded2 = guardWrites(spy2.handler)
  const res2 = makeRes()
  await guarded2(reqOf('POST', { origin: 'dsh-app://app', host: '127.0.0.1:19387', ...OK_HEADERS }), res2)
  check('★ 合法请求：正常进 handler 并回 200', () => {
    assert(spy2.calls === 1, 'handler 调用次数 ' + spy2.calls)
    assert(res2.statusCode === 200, '状态码 ' + res2.statusCode)
  })
  const spy3 = makeSpyHandler()
  const res3 = makeRes()
  await guardWrites(spy3.handler)(reqOf('GET', { origin: 'http://evil.example' }), res3)
  check('★ GET 直接进 handler（读操作不设栅栏）', () => {
    assert(spy3.calls === 1, 'GET 被拦了')
  })
  const spy4 = makeSpyHandler()
  const res4 = makeRes()
  await guardWrites(spy4.handler)(reqOf('OPTIONS', { origin: 'http://evil.example' }), res4)
  check('★ OPTIONS → 预检应答，不落到 handler（否则真路由会回 405 让预检失败）', () => {
    assert(spy4.calls === 0, 'OPTIONS 落到了 handler')
    assert(res4.statusCode === 403, '状态码 ' + res4.statusCode + '（非白名单来源应 403）')
  })
}

// ═══ [5] R-5.1 导入根目录判据统一（误拒修掉 + 判据一致）═════════════════
console.log('\n=== [5] R-5.1 导入根判据：路径段级，不再按名字误拒 ===')
{
  check('★★ 误拒修掉：`D:\\作品\\windows` 这种正常作品夹**放行**', () => {
    const v = checkImportRoot('D:\\作品\\windows')
    assert(v.ok === true, '仍被误拒: ' + v.message)
  })
  check('★★ 系统目录仍然拦住（`C:\\Windows`），因为它是盘符根下第一段', () => {
    const v = checkImportRoot('C:\\Windows')
    assert(v.ok === false && v.kind === 'system', 'body: ' + JSON.stringify(v))
  })
  check('★ 补上原来漏的：`C:\\ProgramData` / `C:\\Program Files`', () => {
    assert(checkImportRoot('C:\\ProgramData').ok === false, 'ProgramData 放行了')
    assert(checkImportRoot('C:\\Program Files').ok === false, 'Program Files 放行了')
    assert(checkImportRoot('C:\\Program Files (x86)').ok === false, 'Program Files (x86) 放行了')
  })
  check('★ 整个用户配置目录本身拒绝（含 AppData/凭据缓存），但其下具体目录放行', () => {
    assert(checkImportRoot('C:\\Users\\Administrator').ok === false, '整个用户目录被放行')
    assert(checkImportRoot('C:\\Users\\Administrator\\Documents').ok === true, 'Documents 被误拒')
    assert(checkImportRoot('C:\\Users\\Administrator\\Desktop').ok === true, 'Desktop 被误拒')
  })
  check('★ 凭据目录**任意层级**都拒（与 isSensitivePath 同一套判据）', () => {
    assert(checkImportRoot('D:\\proj\\.ssh').ok === false, 'D:\\proj\\.ssh 放行')
    assert(checkImportRoot('D:\\proj\\.aws').ok === false, 'D:\\proj\\.aws 放行')
    assert(isSensitivePath('D:\\proj\\.ssh\\id_rsa') === true, 'isSensitivePath 不一致')
  })
  check('★★ 两个函数**判据一致**：checkImportRoot 拒的，isSensitivePath 对同类路径也拒', () => {
    for (const [root, child] of [['D:\\proj\\.ssh', 'D:\\proj\\.ssh\\x'], ['C:\\Windows', 'C:\\Windows\\a.txt']]) {
      const rootRejected = checkImportRoot(root).ok === false
      assert(rootRejected, root + ' 应被拒')
      // 凭据目录是任意层级 → 子路径也该被 isSensitivePath 拒（系统目录不做这个断言）
      if (root.includes('.ssh')) assert(isSensitivePath(child) === true, child + ' 应被 isSensitivePath 拒')
    }
  })
  check('★ 普通路径放行（别把护栏做成"什么都不让导"）', () => {
    for (const p of ['C:\\proj\\作品', 'D:\\art\\2026', 'C:\\Users\\Administrator\\Documents\\项目']) {
      assert(checkImportRoot(p).ok === true, p + ' 被误拒')
    }
  })
  check('★ 拒绝理由是人话且**分类型**（用户能据此改选目录）', () => {
    for (const [p, kind] of [['C:\\Windows', 'system'], ['D:\\x\\.ssh', 'credential'], ['C:\\Users\\Administrator', 'profile']]) {
      const v = checkImportRoot(p)
      assert(v.kind === kind, p + ' kind=' + v.kind)
      assert(typeof v.message === 'string' && v.message.length > 12, p + ' message 太短')
    }
  })
  check('★★ 导入根判据**不再用 basename 名字**（源码守卫：PROTECTED_ROOT_NAMES 已消失）', () => {
    const src = fs.readFileSync(path.join(LIB, 'store.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    assert(!/PROTECTED_ROOT_NAMES/.test(src), '★ 旧的「按 basename 名字」判据还在')
    assert(/checkImportRoot\(root\)/.test(src), 'importFolder 没走统一的 checkImportRoot')
  })
}

// ═══ [6] 与真 store 的联通（只读，不做破坏性导入）══════════════════════
console.log('\n=== [6] importFolder 拒绝时不留副作用 ===')
{
  const dir = path.join(TMP, 's1')
  fs.mkdirSync(dir, { recursive: true })
  const store = new ArtifactStore(dir).load()
  const before = store.items.length
  let threw = null
  try { await store.importFolder('C:\\Windows') } catch (e) { threw = e }
  check('★ 导入敏感根 → 抛人话错误，且**库里一条都没加**', () => {
    assert(threw, '没有抛错 —— 敏感根被放行了')
    assert(/系统目录/.test(threw.message), '错误信息: ' + threw.message)
    assert(store.items.length === before, '★ 竟然写进了 ' + (store.items.length - before) + ' 条')
  })
  let threw2 = null
  try { await store.importFolder('D:\\不存在\\.ssh') } catch (e) { threw2 = e }
  check('★ 目录不存在也拒绝（校验顺序：先拒敏感根再查存在性）', () => {
    assert(threw2, '没抛错')
    assert(/凭据/.test(threw2.message) || /不存在/.test(threw2.message), 'message: ' + threw2.message)
  })
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
