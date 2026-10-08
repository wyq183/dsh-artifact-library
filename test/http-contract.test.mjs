/**
 * 离线 harness：HTTP 接口契约（2026-09-30）
 *
 * 这个文件钉两件**同一主题**的事 —— 「调用方不该靠解析人类可读文本来判断发生了什么」：
 *
 *   ① **失败有结构化的 `reason`**：客户端此前判「语义搜索失败」只能 `msg.indexOf('404')`，
 *      脆弱（`"404"` 可能出现在别的文本里）。查出真实失败面后发现**不是某个端点的问题**，
 *      而是**所有错误回应都没有 reason**。
 *   ② **状态变更有具名端点**：`refine-request`（标记）此前**没有对应的撤销路径** ——
 *      `update()` 白名单不含 `refineRequested`，`PATCH` 会被**静默忽略**，
 *      于是「打错了要能退」兑现不了（只能不做撤销按钮 = 假功能）。
 *
 * ⚠️ 这个文件刻意**不写任何「基于耗时」的断言**：机器一忙就闪红 = 假信号，
 *    比没有护栏更坏。
 *
 * 用法：node test/http-contract.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ArtifactStore } from '../lib/store.js'
import { artifactsHandler } from '../lib/http.js'
import { stripComments } from './_strip-comments.mjs'



/** 源码守卫用的真实路径（不手搓 pathname，跨平台稳） */
const LIB = fileURLToPath(new URL('../lib', import.meta.url))

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-contract-'))
let seq = 0

function makeResBuf() {
  const chunks = []
  const res = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
  res.statusCode = 0
  res.headers = {}
  // Writable 没有 writeHead —— 自己给一个（http.js 靠它设状态码与响应头）
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}); return res }
  res.bodyText = () => Buffer.concat(chunks).toString('utf8')
  res.json = () => JSON.parse(res.bodyText())
  return res
}
// 用真实 Readable（http.js 用 for await 读 body），所以这里手搓一个最小 readable
function reqOf(method, url, body, remoteAddress = '127.0.0.1') {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = {}
  req.socket = { remoteAddress }
  return req
}
async function call(handler, method, url, body, remoteAddress) {
  const res = makeResBuf()
  await handler(reqOf(method, url, body, remoteAddress), res)
  return res
}
function freshStore() {
  const dir = path.join(TMP, 'store' + (seq += 1))
  fs.mkdirSync(dir, { recursive: true })
  return new ArtifactStore(dir).load()
}
function depsFor(store, extra = {}) {
  return {
    store,
    // ⚠️ 键名是 deps.fileIndex（不是 engine）：http.js 在**路由之前**先查它，
    //    没挂就直接 503 —— 不带就永远测不到被测的那条分支。
    fileIndex: {},
    listDir: async () => ({ ok: true, entries: [], total: 0, truncated: false }),
    sessionChanges: null,
    ...extra,
  }
}
function makeFile(name, body = 'x') {
  const p = path.join(TMP, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}

// ═══ [1] ① 失败一律带结构化 reason ═══════════════════════════════════════
console.log('\n=== [1] 失败回应必须带 reason（调用方不必解析文本）===')
{
  const store = freshStore()
  const handler = artifactsHandler(store, depsFor(store))

  const rUnknownFileRoute = await call(handler, 'GET', '/ext/artifacts/files/no-such-subroute?dir=C%3A%5C')
  check('★ 未知的 files/* 子路由 → 404 + reason:"route-not-found" + 可照做的 hint', () => {
    assert(rUnknownFileRoute.statusCode === 404, '状态码 ' + rUnknownFileRoute.statusCode)
    const b = rUnknownFileRoute.json()
    assert(b.reason === 'route-not-found', 'reason: ' + b.reason + ' body=' + rUnknownFileRoute.bodyText())
    assert(b.ok === false, 'ok 应为 false')
    assert(typeof b.hint === 'string' && /重启/.test(b.hint), 'hint 应能照做（提到重启）: ' + b.hint)
  })
  const rNoRoute = await call(handler, 'PUT', '/ext/artifacts/there-is-no-such-endpoint')
  check('★ 完全没有匹配的路由 → 405 + reason:"route-not-found"（而不是裸文本）', () => {
    assert(rNoRoute.statusCode === 405, '状态码 ' + rNoRoute.statusCode)
    const b = rNoRoute.json()
    assert(b.reason === 'route-not-found', 'reason: ' + b.reason)
    assert(b.error === 'method not allowed', '兼容字段 error 应保持原样: ' + b.error)
  })
  const rMissingArtifact = await call(handler, 'GET', '/ext/artifacts/art_不存在')
  check('★ 记录不存在 → 404 + reason:"artifact-not-found"', () => {
    assert(rMissingArtifact.statusCode === 404, '状态码 ' + rMissingArtifact.statusCode)
    assert(rMissingArtifact.json().reason === 'artifact-not-found', 'body: ' + rMissingArtifact.bodyText())
  })
  const rRelated = await call(handler, 'GET', '/ext/artifacts/art_没有这个/related')
  check('记录不存在的 /related → 也有 reason', () => {
    assert(rRelated.statusCode === 404 && rRelated.json().reason === 'artifact-not-found', 'body: ' + rRelated.bodyText())
  })
  const rDelete = await call(handler, 'DELETE', '/ext/artifacts/art_没有这个')
  check('DELETE 不存在的 id → 也有 reason', () => {
    assert(rDelete.statusCode === 404 && rDelete.json().reason === 'artifact-not-found', 'body: ' + rDelete.bodyText())
  })
  check('★★ 失败体统一形状：ok:false + reason + error + message 四件套', () => {
    for (const r of [rUnknownFileRoute, rNoRoute, rMissingArtifact]) {
      const b = r.json()
      assert(b.ok === false, '缺 ok:false')
      assert(typeof b.reason === 'string' && b.reason.length > 0, '缺 reason')
      assert(typeof b.error === 'string', '缺 error（老调用方在看它）')
      assert(typeof b.message === 'string', '缺 message（新调用方可按 {ok,reason,message} 取）')
      assert(b.message === b.error, 'message 应是 error 的别名（同一句话，不要两份文案）')
    }
  })
  check('★ reason 词表里不出现「想当然的原因」（本项目没有模型化语义搜索）', () => {
    // ⚠️ 先剥注释再扫 —— 我自己就在注释里写了「不存在 semantic-unavailable」这句话，
    //    不剥的话守卫会被自己的说明文字绊倒（和上次「不 readdir」同一个坑）。
    const src = stripComments(fs.readFileSync(path.join(LIB, 'http.js'), 'utf8'))
    assert(!/semantic-unavailable/.test(src), '出现了不存在的失败态 semantic-unavailable')
    assert(!/model-unavailable|llm-unavailable/.test(src), '出现了不存在的失败态（本项目语义搜索是纯内存打分）')
  })
}

// ═══ [2] ① 内部异常不再被报成 400（客户端错）═══════════════════════════
console.log('\n=== [2] 内部异常 vs 客户端错，别混为一谈 ===')
{
  const store = freshStore()
  // ⚠️ 让 handler 内部抛异常**不能靠 listDir** —— 它前面还有范围校验，
  //    mock 缺范围依赖时会先被 403 拦住（实测如此），根本到不了外层 catch。
  //    改用「stats() 会炸」的 store：该路由不经过范围校验，直达外层 catch。
  const boomStore = Object.create(store)
  boomStore.stats = () => { throw new Error('统计炸了') }
  const handler = artifactsHandler(boomStore, depsFor(store))
  const r = await call(handler, 'GET', '/ext/artifacts/stats')
  check('★ handler 内抛异常 → 500 + reason:"internal"（原来一律 400，把宿主错报成客户端的错）', () => {
    assert(r.statusCode === 500, '状态码 ' + r.statusCode + ' body=' + r.bodyText())
    const b = r.json()
    assert(b.reason === 'internal', 'reason: ' + b.reason)
    assert(/统计炸了/.test(b.error), '应保留原始信息便于排查: ' + b.error)
  })
  const badJson = await call(handler, 'POST', '/ext/artifacts/unrefine', '{ not json')
  check('★ 请求体坏了 → 400 + reason:"bad-request"（客户端错，仍归 400）', () => {
    assert(badJson.statusCode === 400, '状态码 ' + badJson.statusCode + ' body=' + badJson.bodyText())
    assert(badJson.json().reason === 'bad-request', 'reason: ' + badJson.json().reason)
  })
}

// ═══ [3] ① 语义搜索：0 命中不是失败 ═════════════════════════════════════
console.log('\n=== [3] /search：空结果 ≠ 失败（客户端按 ok 分支即可）===')
{
  const store = freshStore()
  store.register({ path: makeFile('s/有内容.md', 'zebra 独一无二的词'), title: '有内容', project: 'P' })
  const handler = artifactsHandler(store, depsFor(store))

  const hit = await call(handler, 'GET', '/ext/artifacts/search?q=zebra')
  check('★ 命中 → 200 + ok:true + hits，**带 ok 字段**（不必看状态码）', () => {
    assert(hit.statusCode === 200, '状态码 ' + hit.statusCode)
    const b = hit.json()
    assert(b.ok === true, 'ok: ' + b.ok)
    assert(Array.isArray(b.hits) && b.hits.length >= 1, 'hits: ' + hit.bodyText().slice(0, 120))
  })
  const miss = await call(handler, 'GET', '/ext/artifacts/search?q=q7z9w3x5qq-no-such-token')
  check('★★ 0 命中 → 200 + ok:true + hits:[] —— **不是错误**（旧代码容易把它当失败）', () => {
    assert(miss.statusCode === 200, '状态码 ' + miss.statusCode)
    const b = miss.json()
    assert(b.ok === true, 'ok: ' + b.ok)
    assert(Array.isArray(b.hits) && b.hits.length === 0, 'body: ' + miss.bodyText())
    assert(b.reason === undefined, '空结果不该带失败 reason: ' + b.reason)
  })
}

// ═══ [4] ② 撤销「⚡优先精化」标记 ══════════════════════════════════════
console.log('\n=== [4] unrefine：撤销标记（lead 的「打错了要能退」）===')
{
  const store = freshStore()
  const a = store.register({ path: makeFile('r/a.md', 'a'), title: 'A' })            // 缺 摘要/标签/项目 → 真该精化
  const b = store.register({ path: makeFile('r/b.md', 'b'), title: 'B', summary: 's', tags: ['t'], project: 'P' }) // 已精化
  const c = store.register({ path: makeFile('r/c.md', 'c'), title: 'C' })
  const handler = artifactsHandler(store, depsFor(store))

  const mark = await call(handler, 'POST', '/ext/artifacts/refine-request', { ids: [a.id, b.id, c.id] })
  check('打标记：refine-request 接受 ids 数组（一次往返标记 N 条）', () => {
    assert(mark.statusCode === 200, '状态码 ' + mark.statusCode)
    assert(mark.json().marked === 3, 'body: ' + mark.bodyText())
    assert(store.get(a.id).refineRequested === true, 'A 未被标记')
  })

  const un = await call(handler, 'POST', '/ext/artifacts/unrefine', { ids: [a.id, c.id] })
  check('★★ 撤销：unrefine 也接受 ids 数组（与 refine-request **对称**，一次往返退 N 条）', () => {
    assert(un.statusCode === 200, '状态码 ' + un.statusCode)
    const b2 = un.json()
    assert(b2.ok === true, 'ok: ' + b2.ok)
    assert(b2.targeted === 2, 'targeted: ' + b2.targeted)
    assert(b2.unmarked === 2, 'unmarked: ' + b2.unmarked)
  })
  check('★ ⚡ 标记真的没了；且 needsRefine 回到**按内容算出来**的真实值', () => {
    assert(store.get(a.id).refineRequested === false, '★ A 的 ⚡ 标记还在（= 撤销无效）')
    assert(store.get(c.id).refineRequested === false, '★ C 的 ⚡ 标记还在')
    // A/C 本来就缺 摘要/标签/项目 → 撤掉强制标记后**仍然**该精化（这是对的）
    assert(store.get(a.id).needsRefine === true, 'A 缺摘要/标签/项目，应仍然 needsRefine')
    assert(store.get(c.id).needsRefine === true, 'C 同理')
  })
  check('★ 返回值把「真的摘掉了 ⚡」和「仍需精化」分开报，不让调用方猜', () => {
    const b2 = (un).json()
    assert(typeof b2.stillNeedsRefine === 'number', '缺 stillNeedsRefine: ' + JSON.stringify(b2))
    assert(b2.stillNeedsRefine === 2, 'stillNeedsRefine: ' + b2.stillNeedsRefine)
  })
  check('未被撤销的 B 不受影响（标记仍在）', () => {
    assert(store.get(b.id).refineRequested === true, 'B 的标记被误清了')
  })
  const un2 = await call(handler, 'POST', '/ext/artifacts/unrefine', { ids: [b.id] })
  check('★ 撤销「已精化」的条目：解掉强制标记，needsRefine 回到 false', () => {
    const b3 = un2.json()
    assert(b3.unmarked === 1, 'unmarked: ' + b3.unmarked)
    assert(store.get(b.id).refineRequested === false, '⚡ 还在')
    assert(store.get(b.id).needsRefine === false, 'B 摘要/标签/项目齐备，应回到已精化')
  })
  const un3 = await call(handler, 'POST', '/ext/artifacts/unrefine', { ids: [a.id] })
  check('幂等：再撤一次不报错（unmarked 为 0，因为标记已经没了）', () => {
    assert(un3.statusCode === 200, '状态码 ' + un3.statusCode)
    assert(un3.json().unmarked === 0, 'unmarked: ' + un3.json().unmarked)
  })
  check('不存在的 id 不炸（targeted 只算真实命中的）', () => {
    assert(un3.json().targeted === 1, 'targeted: ' + un3.json().targeted)
  })
}

// ═══ [5] ② 为什么不做成 PATCH（判据，不是偏好）══════════════════════════
console.log('\n=== [5] update() 白名单是「用户元数据」边界，机器状态不进去 ===')
{
  const store = freshStore()
  const rec = store.register({ path: makeFile('w/a.md', 'ORIGINAL-BODY'), title: 'A' })
  store.requestRefine({ ids: [rec.id] })
  store.update(rec.id, { refineRequested: false })
  check('★★ PATCH 白名单**仍然不含** refineRequested（`update()` 不是绕过工作流的后门）', () => {
    assert(store.get(rec.id).refineRequested === true, '★ 白名单被放宽了 —— 机器状态不该能从元数据通道改')
  })
  check('★ 同样的边界护住 trashed_at / needsRefine / stars 之外的内部字段', () => {
    const before = store.get(rec.id)
    const trashBefore = before.trashed_at
    store.update(rec.id, { trashed_at: 123, path: 'C:\\evil', id: 'art_hacked', contentIndex: 'HACKED', references: ['art_x'] })
    const after = store.get(rec.id)
    assert(after.id === rec.id, 'id 被改了')
    assert(after.path === rec.path, 'path 被改了')
    assert(after.trashed_at === trashBefore, 'trashed_at 被改了（回收站语义会被绕过）')
    assert(after.contentIndex !== 'HACKED', 'contentIndex 被改了')
  })
  check('★ settleRefine 是**唯一**的判定点（不许别处再内联一份）', () => {
    const src = stripComments(fs.readFileSync(path.join(LIB, 'store.js'), 'utf8'))
    // 判定式只能出现 **1** 次 —— 就是 settleRefine 的定义本身。
    // 0 次 = 有人把它删了却没留调用（不可能，下面的 settleRefine( 计数会兜住）
    // >1 次 = 别处又内联了一份 → 迟早在脏数据上漂（今天就漂过一次，见下一条）
    const inline = (src.match(/needsRefine = !\(/g) || []).length
    assert(inline === 1, '★ needsRefine 判定式应只出现 1 次（定义处），实际 ' + inline + ' 次 —— 又有人内联了一份')
    assert((src.match(/settleRefine\(/g) || []).length >= 3, 'settleRefine 应被定义 1 次 + 至少调用 2 次（update/unrefine/load 回填）')
  })
  check('★★ 三处调用点都在（update / unrefine / load 回填），没有哪条路径绕过判定', () => {
    const src = stripComments(fs.readFileSync(path.join(LIB, 'store.js'), 'utf8'))
    // load() 里那次回填尤其重要：它管的是**历史数据**，漏了就会让旧记录永远停在错的口径上
    assert(/typeof r\.needsRefine !== 'boolean'[\s\S]{0,200}settleRefine\(r\)/.test(src), 'load() 的规则迁移回填没走 settleRefine（历史数据会停在旧口径）')
    assert(/if \(patch\.stars !== undefined\)[\s\S]{0,200}settleRefine\(rec\)/.test(src), 'update() 没走 settleRefine')
    assert(/r\.refineRequested = false[\s\S]{0,120}settleRefine\(r\)/.test(src), 'unrefine() 没走 settleRefine')
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
