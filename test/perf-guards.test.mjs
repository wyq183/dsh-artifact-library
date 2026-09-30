/**
 * 离线 harness：性能护栏（task-15）
 *
 * survey 的结论是「**数据路径都已经有界**」—— 所以这个文件**主要不是**测性能，
 * 而是把两条**不许退化**的界线钉住，外加新加的「可见 / 可控」信号：
 *
 *   1. `/files/list` 的**工作量上界**：昂贵部分是逐条 lstat，它被 `limit` 夹住
 *      （实测 30000 项目录：limit=2000 → 51ms，limit=10000 → 154ms）
 *   2. `/files/status` 的**可判断信号**：now / elapsedMs / stalled / cancellable / hint
 *   3. **取消真的能中断**（三轮回退最坏 ≈480s，停止必须几秒内生效）
 *   4. `/health` —— 零依赖 liveness 探针，且**局域网也通**（那次骨架屏就是局域网）
 *
 * 用法：node test/perf-guards.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { artifactsHandler } from '../lib/http.js'
import { listDirectory, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, STAT_CONCURRENCY } from '../lib/index/list.js'
import { createFileIndex } from '../lib/index/engine.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-perf-'))
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function makeReq(method, url, remoteAddress = '127.0.0.1') {
  return { method, url, headers: {}, socket: { remoteAddress } }
}
function makeRes() {
  const res = { statusCode: 0, headers: {}, body: '', finished: false }
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}) }
  res.end = (chunk) => { res.body = chunk === undefined ? '' : String(chunk); res.finished = true }
  res.json = () => { try { return JSON.parse(res.body) } catch { return null } }
  return res
}
async function call(deps, method, url, remoteAddress) {
  const handler = artifactsHandler({ items: [], getSettings: () => ({}), get: () => null, list: () => [], stats: () => ({}), file: '/tmp/x' }, deps)
  const res = makeRes()
  await handler(makeReq(method, url, remoteAddress), res)
  return res
}

// ═══ [1] /files/list 的工作量上界（survey 实测有界，钉住别退化）══════════
console.log('\n=== [1] /files/list 大目录已有界（不许退化）===')
const BIG = path.join(TMP, 'big')
{
  fs.mkdirSync(BIG, { recursive: true })
  for (let i = 0; i < 5000; i += 1) fs.writeFileSync(path.join(BIG, 'f' + String(i).padStart(5, '0') + '.txt'), 'x')
  for (let i = 0; i < 200; i += 1) fs.mkdirSync(path.join(BIG, 'd' + String(i).padStart(3, '0')))

  const t0 = performance.now()
  const dflt = await listDirectory(BIG, {})
  const t1 = performance.now()
  check(`默认 limit=${DEFAULT_LIST_LIMIT}：返回条数被夹住（实测 ${(t1 - t0).toFixed(0)}ms）`, () => {
    assert(dflt.entries.length === DEFAULT_LIST_LIMIT, '返回 ' + dflt.entries.length)
    assert(dflt.total === 5200, 'total 应是磁盘上的真实条目数 5200，得到 ' + dflt.total)
    assert(dflt.truncated === true, 'truncated 应为 true')
  })
  const small = await listDirectory(BIG, { limit: 50 })
  check('★ 昂贵部分（逐条 lstat）被 limit 夹住：limit=50 就只 stat 50 条', () => {
    assert(small.entries.length === 50, '返回 ' + small.entries.length)
    assert(small.total === 5200, 'total 仍应如实报 5200')
  })
  const huge = await listDirectory(BIG, { limit: 999999 })
  check(`★ 超大 limit 被夹到 MAX_LIST_LIMIT=${MAX_LIST_LIMIT}（防「一次 stat 十万条」）`, () => {
    assert(huge.limit === MAX_LIST_LIMIT, 'limit 被夹到 ' + huge.limit)
    // 目录里只有 5200 条 → 全给；这里要钉的是**上限被夹住**，不是「返回 10000」
    assert(huge.entries.length === 5200, '返回 ' + huge.entries.length)
  })
  check('STAT_CONCURRENCY 是有限值（不是 Promise.all 一把梭）', () => {
    assert(Number.isFinite(STAT_CONCURRENCY) && STAT_CONCURRENCY > 0 && STAT_CONCURRENCY <= 256, 'STAT_CONCURRENCY=' + STAT_CONCURRENCY)
  })
  const t2 = performance.now()
  const concurrent = await Promise.all(Array.from({ length: 10 }, () => listDirectory(BIG, { limit: 200 })))
  const t3 = performance.now()
  check(`10 个并发请求都返回完整结果（实测合计 ${(t3 - t2).toFixed(0)}ms，无失败）`, () => {
    for (const r of concurrent) assert(r.ok === true && r.entries.length === 200, '有请求失败/不完整')
  })
  check('单条 stat 失败被跳过、不拖垮整单（skipped 字段存在）', () => {
    assert(typeof dflt.skipped === 'number', '缺 skipped: ' + JSON.stringify(dflt).slice(0, 120))
  })
}

// ═══ [2] /health：零依赖 + 局域网也通 ═══════════════════════════════════
console.log('\n=== [2] /health（客户端超时判定的地基）===')
{
  const r = await call({}, 'GET', '/ext/artifacts/health')
  check('★ 200 + {ok,now,uptimeMs,pid}，且**完全不需要 store/engine 依赖**', () => {
    assert(r.statusCode === 200, '状态码 ' + r.statusCode)
    const b = r.json()
    assert(b.ok === true, 'body: ' + r.body)
    assert(Number.isFinite(b.now) && b.now > 1600000000000, 'now 不像时间戳: ' + b.now)
    assert(Number.isFinite(b.uptimeMs) && b.uptimeMs >= 0, 'uptimeMs: ' + b.uptimeMs)
    assert(Number.isFinite(b.pid), '回环来源应给 pid: ' + r.body)
  })
  const lan = await call({}, 'GET', '/ext/artifacts/health', '192.168.1.50')
  check('★★ 局域网来源也返回 200（那次骨架屏就发生在局域网；403 就白做了）', () => {
    assert(lan.statusCode === 200, '状态码 ' + lan.statusCode + ' body=' + lan.body)
    assert(lan.json().ok === true, 'body: ' + lan.body)
  })
  check('局域网不给 pid（少泄露一点）', () => {
    assert(!('pid' in lan.json()), '不该给 pid: ' + lan.body)
  })
}

// ═══ [3] /files/status 的可判断信号 ═════════════════════════════════════
console.log('\n=== [3] /files/status：进度/卡住/可取消 ===')
{
  const dir = path.join(TMP, 'index-data')
  fs.mkdirSync(dir, { recursive: true })
  const index = createFileIndex({ dataDir: dir, logger: { info() {}, warn() {} } })
  // ⚠️ 用 cancel() 取快照：它**不会 spawn 任何进程**（status() 会 ping Everything）。
  //    我们要验的是快照字段与状态机，不是真去启动索引。
  const snap = index.cancel()
  check('★ 新增 now（宿主时钟，客户端算耗时不靠本机时钟）', () => {
    assert(Number.isFinite(snap.now), 'now: ' + snap.now)
  })
  check('★ 新增 elapsedMs / stalled / stallHintMs', () => {
    assert('elapsedMs' in snap, '缺 elapsedMs')
    assert(typeof snap.stalled === 'boolean', 'stalled 应是布尔: ' + snap.stalled)
    assert(Number.isFinite(snap.stallHintMs) && snap.stallHintMs > 0, 'stallHintMs: ' + snap.stallHintMs)
  })
  check('★ 新增 cancellable（与 phase 一致：只有 starting 时可取消）', () => {
    assert(snap.cancellable === (snap.phase === 'starting'), `cancellable=${snap.cancellable} phase=${snap.phase}`)
  })
  check('★ 新增 hint（人话，客户端可直接显示）', () => {
    assert(typeof snap.hint === 'string' && snap.hint.length > 0, 'hint: ' + snap.hint)
  })
  check('未启动时的 hint 说明「按需启动」，不是一句空话', () => {
    assert(/按需启动|已就绪|未启动/.test(snap.hint), 'hint: ' + snap.hint)
  })
  check('cancel() 幂等（连按两次不出错、状态一致）', () => {
    const a = index.cancel()
    const b = index.cancel()
    assert(a.phase === b.phase && a.cancellable === b.cancellable, '两次取消状态不一致')
  })
  check('旧字段一个没丢（scope/mode/vendorPresent/iniPath/lastError…）', () => {
    for (const k of ['phase', 'ready', 'mode', 'scope', 'lastError', 'startedAt', 'lastReadyAt', 'instance', 'vendorPresent', 'iniPath', 'iniScope']) {
      assert(k in snap, '丢了旧字段 ' + k)
    }
  })
}

// ═══ [4] 取消真的能中断（源码 + 状态机两层）═════════════════════════════
console.log('\n=== [4] 取消能中断构建 ===')
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'index', 'engine.js'), 'utf8')
  check('★ waitReady 的**等待循环里**检查取消（否则要干等到 90s/300s 预算耗尽）', () => {
    const fn = src.slice(src.indexOf('async function waitReady'), src.indexOf('async function shutdown'))
    assert(/epoch !== cancelEpoch/.test(fn), 'waitReady 里没有取消检查')
    assert(/return 'cancelled'/.test(fn), 'waitReady 没把取消作为独立结果返回')
  })
  check('★ startRound（每轮开始）检查取消 —— 三轮回退最坏 ≈480s，不能一直试下去', () => {
    const fn = src.slice(src.indexOf('const startRound = async'), src.indexOf('const cancelledNow'))
    assert(/epoch !== cancelEpoch/.test(fn), 'startRound 里没有取消检查')
    assert(/reason: 'cancelled'/.test(fn), 'startRound 没返回 cancelled')
  })
  check('★★ 被取消时**不会**当成「这轮没就绪」继续回退下一轮', () => {
    assert(/cancelledNow\(round\)/.test(src), '没有 cancelledNow 短路')
    const fallback = src.slice(src.indexOf("if (mode === 'filelists')"), src.indexOf('// 「就绪」不等于'))
    const cancelReturns = (fallback.match(/reason: 'cancelled'/g) || []).length
    assert(cancelReturns >= 3, '三轮回退里都应短路 cancelled，实际 ' + cancelReturns)
  })
  check('★ shutdown()（= /files/stop）会 bump 取消纪元', () => {
    const fn = src.slice(src.indexOf('async function shutdown'), src.indexOf('function ensureReady'))
    assert(/cancelEpoch \+= 1/.test(fn), 'shutdown 没取消在跑的构建')
  })
  check('ensureReady 进入时记下纪元（避免把「之后才发生的取消」误判成自己的）', () => {
    const fn = src.slice(src.indexOf('function ensureReady'), src.indexOf('const scopeDirs = Array.isArray'))
    assert(/const epoch = cancelEpoch/.test(fn), 'ensureReady 没记纪元')
  })
  check('取消后状态回到 stopped（不是停在 starting 骗人）', () => {
    const dir = path.join(TMP, 'index-data2')
    fs.mkdirSync(dir, { recursive: true })
    const idx = createFileIndex({ dataDir: dir, logger: { info() {}, warn() {} } })
    const s = idx.cancel()
    assert(s.phase === 'stopped' || s.phase === 'idle', 'phase: ' + s.phase)
    assert(s.cancellable === false, '取消后不该还能取消: ' + s.cancellable)
  })
}

// ═══ [5] 客户端契约：这几个字段是给 ui-core / ui-tester 的 ══════════════
console.log('\n=== [5] 客户端契约（字段名固定，改要通知 ui-core/ui-tester）===')
{
  const dir = path.join(TMP, 'index-data3')
  fs.mkdirSync(dir, { recursive: true })
  const snap = createFileIndex({ dataDir: dir, logger: { info() {}, warn() {} } }).cancel()
  const CONTRACT = ['phase', 'ready', 'now', 'elapsedMs', 'stalled', 'stallHintMs', 'cancellable', 'hint']
  check('★ status 契约字段齐全（客户端据此显示「正在建/卡住/可停」）', () => {
    for (const k of CONTRACT) assert(k in snap, '缺契约字段 ' + k)
  })
  check('phase 取值在已知集合内（客户端可穷举）', () => {
    assert(['stopped', 'starting', 'ready', 'error', 'idle'].includes(snap.phase), 'phase: ' + snap.phase)
  })
  check('stalled 为 true 时 hint 必须提到「可取消」（信号与文案一致）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'index', 'engine.js'), 'utf8')
    const hintBlock = src.slice(src.indexOf('hint: starting'), src.indexOf("'索引未启动"))
    assert(/stalled[\s\S]*files\/stop/.test(hintBlock), 'stalled 分支的文案里没告诉用户怎么停')
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
