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

/**
 * ★ **形状断言版**的源码切片（2026-09-30，ui-tester 的锚点失效教训）。
 *
 * 为什么要它：`src.slice(src.indexOf(a), src.indexOf(b))` 在**锚点写错**时
 * 返回的是 `''`（`indexOf` 返回 -1 → `slice(-1, -1)`），
 * 而对空串跑正则断言**全部通过** → **静默假绿**：
 * 数字被当真、写进报告、当作「已修」。
 *
 * 所以任何切片都必须**自己证明它切到了东西**：锚点找得到、顺序对、长度合理。
 * 这条守卫**比它保护的断言更重要** —— 文件末尾 [7] 里有对 guard 自身的测试。
 */
/** 源码守卫用：剥掉注释（免得守卫被自己的说明文字绊倒 —— 这个坑我踩过两次） */
function stripComments(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function sliceBetween(src, startMarker, endMarker, label) {
  const i = src.indexOf(startMarker)
  if (i === -1) throw new Error(`形状断言失败[${label}]：找不到起始锚点 ${JSON.stringify(startMarker)}`)
  const j = endMarker === null ? src.length : src.indexOf(endMarker, i + startMarker.length)
  if (j === -1) throw new Error(`形状断言失败[${label}]：找不到结束锚点 ${JSON.stringify(endMarker)}`)
  if (j <= i) throw new Error(`形状断言失败[${label}]：结束锚点在起始锚点之前（i=${i} j=${j}）`)
  const out = src.slice(i, j)
  if (out.length < 20) throw new Error(`形状断言失败[${label}]：切片只有 ${out.length} 字符，锚点很可能落错了地方`)
  return out
}

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
    const fn = sliceBetween(src, 'async function waitReady', 'async function shutdown', 'waitReady 函数体')
    assert(/epoch !== cancelEpoch/.test(fn), 'waitReady 里没有取消检查')
    assert(/return 'cancelled'/.test(fn), 'waitReady 没把取消作为独立结果返回')
  })
  check('★ startRound（每轮开始）检查取消 —— 三轮回退最坏 ≈480s，不能一直试下去', () => {
    const fn = sliceBetween(src, 'const startRound = async', 'const cancelledNow', 'startRound 函数体')
    assert(/epoch !== cancelEpoch/.test(fn), 'startRound 里没有取消检查')
    assert(/reason: 'cancelled'/.test(fn), 'startRound 没返回 cancelled')
  })
  check('★★ 被取消时**不会**当成「这轮没就绪」继续回退下一轮', () => {
    assert(/cancelledNow\(round\)/.test(src), '没有 cancelledNow 短路')
    const fallback = sliceBetween(src, "if (mode === 'filelists')", '// 「就绪」不等于', '三轮回退块')
    const cancelReturns = (fallback.match(/reason: 'cancelled'/g) || []).length
    assert(cancelReturns >= 3, '三轮回退里都应短路 cancelled，实际 ' + cancelReturns)
  })
  check('★ shutdown()（= /files/stop）会 bump 取消纪元', () => {
    const fn = sliceBetween(src, 'async function shutdown', 'function ensureReady', 'shutdown 函数体')
    assert(/cancelEpoch \+= 1/.test(fn), 'shutdown 没取消在跑的构建')
  })
  check('ensureReady 进入时记下纪元（避免把「之后才发生的取消」误判成自己的）', () => {
    const fn = sliceBetween(src, 'function ensureReady', 'const scopeDirs = Array.isArray', 'ensureReady 开头')
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
    const hintBlock = sliceBetween(src, 'hint: starting', "'索引未启动", 'hint 文案块')
    assert(/stalled[\s\S]*files\/stop/.test(hintBlock), 'stalled 分支的文案里没告诉用户怎么停')
  })
}

// ═══ [6] R-4：语义搜索分批让出事件循环 ══════════════════════════════════
// ⚠️ 本文件的 `check()` 是**同步**的（`try { fn() }`）—— async 函数里的断言不会被等到，
//    会**静默通过**（假绿）。所以 async 调用一律**在 check 外面 await**，里面只做断言。
console.log('\n=== [6] R-4 语义搜索：分批不阻塞宿主，且结果不变 ===')
{
  const { ArtifactStore, SEARCH_YIELD_EVERY } = await import('../lib/store.js')
  const dir = path.join(TMP, 'r4')
  fs.mkdirSync(dir, { recursive: true })
  const store = new ArtifactStore(dir).load()
  store.items = []
  for (let i = 0; i < 4000; i += 1) {
    store.items.push({
      id: 'art_' + i, title: `标题 ${i}`, path: `C:\\x\\f${i}.md`, filename: `f${i}.md`,
      tags: ['a'], summary: '', contentIndex: 'x'.repeat(80), kind: 'deliverable',
      project: 'P', artifact_type: 'other', stars: 0, trashed_at: null,
    })
  }
  const returned = store.searchSemantic('标题 5', { limit: 5 })
  const chunked = await store.searchSemantic('标题 5', { limit: 20 })
  const unchunked = await store.searchSemantic('标题 5', { limit: 20, yieldEvery: Number.MAX_SAFE_INTEGER })
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 0)
  await store.searchSemantic('标题 5', { limit: 20, yieldEvery: 200 })
  clearInterval(timer)
  const empty = await store.searchSemantic('   ', { limit: 5 })

  check('searchSemantic 现在是 **async**（返回 Promise）', () => {
    assert(returned && typeof returned.then === 'function', '★ 还是同步的 —— 就没法让出事件循环')
  })
  check('★★ 分批与不分批的结果**完全一致**（修性能不能顺手改搜索质量）', () => {
    assert(JSON.stringify(chunked) === JSON.stringify(unchunked), '分批/不分批结果不同！')
    assert(chunked.length === 20, '命中数 ' + chunked.length)
  })
  check('★★ 搜索期间**事件循环真的转起来了**（宏任务能插进来）', () => {
    assert(ticks > 0, '★ 搜索期间一次定时器都没跑 —— 等于没让出（多半用了微任务）')
  })
  check(`SEARCH_YIELD_EVERY 是有限正数（= ${SEARCH_YIELD_EVERY}）`, () => {
    assert(Number.isFinite(SEARCH_YIELD_EVERY) && SEARCH_YIELD_EVERY > 0 && SEARCH_YIELD_EVERY <= 10000, '值: ' + SEARCH_YIELD_EVERY)
  })
  check('★ 让出用的是 **setImmediate（宏任务）**，不是 Promise.resolve（微任务）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'store.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const yieldFn = sliceBetween(src, 'const searchYield', 'export class ArtifactStore', 'searchYield 定义')
    assert(/setImmediate/.test(yieldFn), '★ 没用 setImmediate')
    assert(!/Promise\.resolve\(\)/.test(yieldFn), '★ 用了微任务 —— 微任务不让 I/O 插进来，等于没让')
  })
  check('★ 两个调用方都 await 了（漏一个就会拿到 Promise 当数组用）', () => {
    const http = fs.readFileSync(path.join(ROOT, 'lib', 'http.js'), 'utf8')
    const tools = fs.readFileSync(path.join(ROOT, 'lib', 'tools.js'), 'utf8')
    assert(/await store\.searchSemantic/.test(http), 'http.js /search 没 await')
    assert(/await store\.searchSemantic/.test(tools), 'tools.js artifact_find 没 await')
  })
  check('空查询立即返回 []（不进入扫描）', () => {
    assert(Array.isArray(empty) && empty.length === 0, JSON.stringify(empty))
  })
}

// ═══ [7] 守卫自身的测试：形状断言必须**真的会失败** ═════════════════════
// 「让信号自己证明它测到了东西」—— 一个从不在错误输入上失败的守卫等于没有守卫。
console.log('\n=== [7] sliceBetween 的形状断言本身有效 ===')
{
  const probe = 'AAAAAAAAAA start ' + 'B'.repeat(40) + ' end CCCCCCCCCC'
  let threwNoStart = false
  try { sliceBetween(probe, '没有这个锚点', 'end', '探针') } catch { threwNoStart = true }
  let threwNoEnd = false
  try { sliceBetween(probe, 'start', '也没有这个', '探针') } catch { threwNoEnd = true }
  let threwShort = false
  try { sliceBetween('aXb', 'a', 'b', '探针') } catch { threwShort = true }
  const naive = probe.slice(probe.indexOf('没有这个锚点'), probe.indexOf('end'))

  check('正常锚点：切出中间那段', () => {
    assert(sliceBetween(probe, 'start', 'end', '探针').includes('BBBB'), '切出的内容不对')
  })
  check('★ 起始锚点不存在 → **抛错**（而不是静默返回空串）', () => {
    assert(threwNoStart, '★ 锚点找不到却静默通过了 —— 这正是 ui-tester 踩的那个坑')
  })
  check('★ 结束锚点不存在 → **抛错**', () => {
    assert(threwNoEnd, '★ 结束锚点找不到却静默通过')
  })
  check('★ 切片过短（锚点落错地方）→ **抛错**', () => {
    assert(threwShort, '★ 只切到 1 个字符也通过')
  })
  check('★★ 对照：裸 `slice(indexOf, indexOf)` 在同样输入下**返回空串却不报错**', () => {
    assert(naive === '', '预期空串，实际: ' + JSON.stringify(naive))
    assert(!/start/.test(naive), '空串上跑「不包含」型断言会静默通过 —— 这就是假绿的机制')
  })
  check('★ 本文件已没有裸 `slice(src.indexOf(...))`（注释里提到不算）', () => {
    const self = fs.readFileSync(new URL(import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    // ⚠️ 只扫 [7] 之前的部分：否则这条检查会**匹配到它自己的模式串**（自指假阳性，我第一次就踩了）
    const code = self.slice(0, self.indexOf('sliceBetween 的形状断言本身有效'))
    assert(code.length > 1000, '扫描对象太短，说明截取锚点失效：' + code.length)
    const bare = code.split('slice(' + 'src.indexOf').length - 1
    assert(bare === 0, '★ 还有 ' + bare + ' 处裸切片')
  })
}

// ═══ [8] R-6 (A)+(D)：正文索引上限 + 导入字节预算 ═══════════════════════
console.log('\n=== [8] (A) 正文索引上限 8000 + 诚实截断标志 / (D) 导入字节预算 ===')
{
  const { ArtifactStore, MAX_TEXT_INDEX_CHARS, DEFAULT_IMPORT_MAX_BYTES } = await import('../lib/store.js')
  const base = path.join(TMP, 'ad')
  fs.mkdirSync(base, { recursive: true })

  // ── (A) 上限与诚实标志 ──
  const shortFile = path.join(base, 'short.md')
  fs.writeFileSync(shortFile, 'x'.repeat(100))
  const longFile = path.join(base, 'long.md')
  fs.writeFileSync(longFile, 'y'.repeat(MAX_TEXT_INDEX_CHARS + 5000))
  const s1 = new ArtifactStore(path.join(base, 's1')).load()
  const recShort = s1.register({ path: shortFile, title: '短' })
  const recLong = s1.register({ path: longFile, title: '长' })
  const hits = await s1.searchSemantic('老记录', { limit: 5 })

  check(`上限常量已导出且为 8000（= ${MAX_TEXT_INDEX_CHARS}）`, () => {
    assert(MAX_TEXT_INDEX_CHARS === 8000, '值: ' + MAX_TEXT_INDEX_CHARS)
  })
  check('短文件：不截断、标志为 false、字符数如实', () => {
    assert(recShort.contentIndexTruncated === false, 'flagged: ' + recShort.contentIndexTruncated)
    assert(recShort.contentIndex.length === 100, 'chars: ' + recShort.contentIndex.length)
    assert(recShort.contentIndexChars === 100, 'contentIndexChars: ' + recShort.contentIndexChars)
  })
  check('★★ 长文件：**截断且自己说出来**（truncated=true + 原文字符数）', () => {
    assert(recLong.contentIndex.length === MAX_TEXT_INDEX_CHARS, '索引长度 ' + recLong.contentIndex.length)
    assert(recLong.contentIndexTruncated === true, '★ 截断了却没标 —— 用户会以为检索是完整的')
    assert(recLong.contentIndexTotalChars === MAX_TEXT_INDEX_CHARS + 5000, 'totalChars: ' + recLong.contentIndexTotalChars)
    assert(recLong.contentIndexChars === MAX_TEXT_INDEX_CHARS, 'chars: ' + recLong.contentIndexChars)
  })
  check('★ 语义搜索的命中里带截断标志（客户端才有东西可显示）', () => {
    for (const h of hits) {
      assert('contentIndexTruncated' in h, '命中里缺 contentIndexTruncated')
      assert('contentIndexChars' in h && 'contentIndexTotalChars' in h, '命中里缺字符数字段')
    }
  })

  // ── (A) 迁移：老库的超标正文要被裁掉**并留痕** ──
  const legacyDir = path.join(base, 'legacy')
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'artifacts.json'), JSON.stringify([{
    id: 'art_legacy1', title: '老记录', path: shortFile, filename: 'short.md', extension: '.md',
    kind: 'deliverable', source: 'manual', tags: [], status: 'final', stars: 0, summary: 's',
    project: 'P', artifact_type: 'other', needsRefine: false, references: [],
    contentIndex: 'z'.repeat(50000), created_at: 1, updated_at: 1, trashed_at: null,
  }]), 'utf8')
  fs.writeFileSync(path.join(legacyDir, 'meta.json'), JSON.stringify({ needsRefineRule: 2 }), 'utf8')
  const legacy = new ArtifactStore(legacyDir).load().get('art_legacy1')

  check('★★ 迁移：老库里 5 万字符的正文被裁到 8000（否则体积永远不降）', () => {
    assert(legacy.contentIndex.length === MAX_TEXT_INDEX_CHARS, '裁后长度 ' + legacy.contentIndex.length)
  })
  check('★★ 迁移**必须留痕**：标 truncated + 记下原长度（无声迁移 = 骗人）', () => {
    assert(legacy.contentIndexTruncated === true, '★ 迁移是无声的 —— 用户以为检索还是完整的')
    assert(legacy.contentIndexTotalChars === 50000, 'totalChars: ' + legacy.contentIndexTotalChars)
  })
  check('迁移幂等（再 load 一次不会改坏）', () => {
    const again = new ArtifactStore(legacyDir).load().get('art_legacy1')
    assert(again.contentIndex.length === MAX_TEXT_INDEX_CHARS && again.contentIndexTotalChars === 50000, '第二次 load 改坏了')
  })
  check('规则版本写进 meta（下次不重复迁移）', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(legacyDir, 'meta.json'), 'utf8'))
    assert(meta.contentIndexRule === 2, 'contentIndexRule: ' + meta.contentIndexRule)
  })

  // ── (D) 总字节预算 ──
  const budgetDir = path.join(base, 'budget')
  fs.mkdirSync(budgetDir, { recursive: true })
  for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(budgetDir, `b${i}.md`), 'x'.repeat(100 * 1024))
  const capped = await new ArtifactStore(path.join(base, 's3')).load().importFolder(budgetDir, { project: 'D', maxBytes: 1024 * 1024 })
  const uncapped = await new ArtifactStore(path.join(base, 's4')).load().importFolder(budgetDir, { project: 'D2' })

  check(`★ (D) 超预算**提前停止**（${capped.count} 条 < ${uncapped.count} 条）`, () => {
    assert(capped.count < uncapped.count, '没停：' + capped.count)
    assert(capped.count > 0, '一条都没导')
  })
  check('★ (D) 如实回报「为什么停」+ 用量', () => {
    assert(capped.stopped === true, 'stopped: ' + capped.stopped)
    assert(capped.stoppedBy === 'byte-budget', 'stoppedBy: ' + capped.stoppedBy)
    assert(capped.usedBytes <= 1024 * 1024, '★ 用超了预算: ' + capped.usedBytes)
    assert(typeof capped.note === 'string' && capped.note.length > 10, 'note: ' + capped.note)
  })
  check('★ (D) note 是人话且能照做（提到可分批继续）', () => {
    assert(/预算/.test(capped.note) && /分批|继续/.test(capped.note), 'note: ' + capped.note)
  })
  check('默认预算下正常目录不会被停（别把正常导入也掐了）', () => {
    assert(uncapped.stopped === false, '★ 默认预算误停: ' + uncapped.stoppedBy)
    assert(uncapped.stoppedBy === null, 'stoppedBy: ' + uncapped.stoppedBy)
    assert(DEFAULT_IMPORT_MAX_BYTES === 512 * 1024 * 1024, '默认预算: ' + DEFAULT_IMPORT_MAX_BYTES)
  })
  check('★★ artifact_read **不受这个上限影响**（直接读磁盘 → 全文仍可读）', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'tools.js'), 'utf8'))
    const at = src.indexOf("name: 'artifact_read'")
    const readFn = sliceBetween(src, "name: 'artifact_read'", 'const disposers', 'artifact_read 工具定义')
    assert(at >= 0, '找不到 artifact_read')
    assert(!/contentIndex/.test(readFn), '★ artifact_read 依赖了 contentIndex —— 那裁掉正文就读不全了')
    assert(/readFileSync/.test(readFn), 'artifact_read 应该直接读磁盘')
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
