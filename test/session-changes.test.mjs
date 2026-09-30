/**
 * 离线 harness：/ext/artifacts/session-changes 路由 + 公告观察器
 *
 * 不启动 DSH、不启动 Everything —— 全 mock：
 *   · 观察器（lib/session-changes.js）：口径、过滤、容量
 *   · 路由（lib/http.js）：400 / 404 / 503 / 命中 / derived 四个分支
 *   · 有意断言「**不过 assertInScope**」与「**不回落到凑数数据**」两条设计约束
 *
 * 用法：node test/session-changes.test.mjs
 */

import { artifactsHandler } from '../lib/http.js'
import { createSessionChangesObserver, MAX_TRACKED_SESSIONS } from '../lib/session-changes.js'

let passed = 0
let failed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    failures.push(name + ' → ' + (error && error.message ? error.message : String(error)))
    console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error)))
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

// ── mock 设施 ─────────────────────────────────────────────────────────────
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
function makeStore() {
  return {
    items: [], file: '/tmp/fake.json',
    stats: () => ({ total: 0 }), categories: () => ({}), getSettings: () => ({}),
    get: () => ({ id: 'STORE-GOT-IT' }), list: () => [],
  }
}
async function call(deps, method, url, remoteAddress) {
  const handler = artifactsHandler(makeStore(), deps)
  const req = makeReq(method, url, remoteAddress)
  const res = makeRes()
  await handler(req, res)
  return res
}
/** 用假的 `session/event` 事件喂观察器（形状照抄 dsh-session 的 append 产物） */
function event(type, seq, data = {}, time) {
  return { type, seq, time: time === undefined ? Date.now() : time, data }
}
function session(id, header = {}) {
  return { id, header }
}

/** 一个「恒定返回同一条摘要」的 workspaceChanges 服务替身 */
function makeService(summary) {
  return { summary: () => summary }
}
const OFFICIAL_SUMMARY = {
  turn: 3,
  cwd: 'C:\\Users\\Administrator\\.dsh',
  files: [
    { path: 'a.txt', display: 'a.txt', added: 4, deleted: 1 },
    { path: 'C:\\outside\\bin.dat', display: 'C:\\outside\\bin.dat', added: 0, deleted: 0, binary: true },
    { path: 'huge.txt', display: 'huge.txt', added: 0, deleted: 0, oversized: true },
  ],
  total: 3,
  added: 4,
  deleted: 1,
}

// ═══ [1] 观察器：口径 ═════════════════════════════════════════════════════
console.log('\n=== [1] 观察器口径 ===')
{
  const o = createSessionChangesObserver()
  check('非 workspace/changes 事件被忽略', () => {
    assert(o.observe(session('s1'), event('turn/end', 5)) === false, '不该记')
    assert(o.recent() === undefined, '不该有记录')
  })
  check('缺 session.id 被忽略', () => {
    assert(o.observe({}, event('workspace/changes', 5)) === false, '不该记')
    assert(o.observe({ id: '   ' }, event('workspace/changes', 5)) === false, '空白 id 不该记')
  })
  check('seq 非法（负数/非整数/非数字）被忽略', () => {
    assert(o.observe(session('s1'), event('workspace/changes', -1)) === false, '负数不该记')
    assert(o.observe(session('s1'), event('workspace/changes', 1.5)) === false, '小数不该记')
    assert(o.observe(session('s1'), event('workspace/changes', 'x')) === false, '非数字不该记')
  })
  check('subagent 会话的公告被忽略（与官方 eligible() 同口径）', () => {
    assert(o.observe(session('sub', { origin: 'subagent' }), event('workspace/changes', 9)) === false, 'origin=subagent 不该记')
    assert(o.observe(session('sub2', { delegationDepth: 1 }), event('workspace/changes', 9)) === false, 'delegationDepth>0 不该记')
  })

  const o2 = createSessionChangesObserver()
  check('★ 同一会话公告多次 → 只留**最后一次**', () => {
    o2.observe(session('s1'), event('workspace/changes', 10, { turn: 1 }, 1000))
    o2.observe(session('s1'), event('workspace/changes', 20, { turn: 2 }, 2000))
    o2.observe(session('s1'), event('workspace/changes', 30, { turn: 3 }, 3000))
    const r = o2.recent()
    assert(r.seq === 30 && r.turn === 3 && r.announcedAt === 3000, '取到的不是最后一次: ' + JSON.stringify(r))
    assert(o2.tracked() === 1, '同一会话不该占多条: ' + o2.tracked())
  })
  check('★ 多会话 → 取 announcedAt **最大**的那个', () => {
    o2.observe(session('s2'), event('workspace/changes', 99, { turn: 9 }, 5000))
    assert(o2.recent().sessionId === 's2', '应取 s2: ' + JSON.stringify(o2.recent()))
    o2.observe(session('s3'), event('workspace/changes', 12, { turn: 1 }, 9000))
    assert(o2.recent().sessionId === 's3', '应取 s3: ' + JSON.stringify(o2.recent()))
    // s3 又来一次但时间更早（乱序到达）→ 仍取 s3 的最新记录，但全局仍然是 s3 的记录
    o2.observe(session('s3'), event('workspace/changes', 13, { turn: 2 }, 8000))
    assert(o2.recent().sessionId === 's3' && o2.recent().seq === 13, 's3 的记录应被覆盖: ' + JSON.stringify(o2.recent()))
  })
  check('★ 同毫秒（announcedAt 相同）→ 后观察到的胜', () => {
    const o3 = createSessionChangesObserver()
    o3.observe(session('a'), event('workspace/changes', 1, {}, 7777))
    o3.observe(session('b'), event('workspace/changes', 2, {}, 7777))
    assert(o3.recent().sessionId === 'b', '应取后到的 b: ' + JSON.stringify(o3.recent()))
  })
  check('event.time 缺失时退回本地时钟（仍可排序）', () => {
    const o4 = createSessionChangesObserver({ now: () => 424242 })
    o4.observe(session('a'), { type: 'workspace/changes', seq: 7, data: {} })
    assert(o4.recent().announcedAt === 424242, 'announcedAt: ' + o4.recent().announcedAt)
  })
  check('forget 后不再被 recent 选中', () => {
    const o5 = createSessionChangesObserver()
    o5.observe(session('a'), event('workspace/changes', 1, {}, 100))
    o5.observe(session('b'), event('workspace/changes', 2, {}, 200))
    o5.forget(session('b'))
    assert(o5.recent().sessionId === 'a', '应回落到 a: ' + JSON.stringify(o5.recent()))
    o5.forget(session('a'))
    assert(o5.recent() === undefined, '全忘了应返回 undefined')
  })
  check('容量上限：跟踪数不超过 MAX_TRACKED_SESSIONS，且淘汰最旧的', () => {
    const o6 = createSessionChangesObserver()
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 10; i += 1) {
      o6.observe(session('s' + i), event('workspace/changes', i, {}, 1000 + i))
    }
    assert(o6.tracked() === MAX_TRACKED_SESSIONS, 'tracked=' + o6.tracked())
    assert(o6.recent().sessionId === 's' + (MAX_TRACKED_SESSIONS + 9), '最新的应保留: ' + o6.recent().sessionId)
  })
  check('recent() 返回的是副本（外部改不动内部状态）', () => {
    const o7 = createSessionChangesObserver()
    o7.observe(session('a'), event('workspace/changes', 1, {}, 100))
    const r = o7.recent()
    r.seq = 999
    assert(o7.recent().seq === 1, '内部状态被外部改掉了')
  })
}

// ═══ [2] 观察器接线：ctx.on('session/event') ══════════════════════════════
console.log('\n=== [2] 订阅接线（复刻 lib/index.js 的接法）===')
{
  const listeners = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(name, cb) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(cb)
      return () => {
        const list = listeners.get(name) || []
        const at = list.indexOf(cb)
        if (at >= 0) list.splice(at, 1)
      }
    },
    emit(name, ...args) { for (const cb of [...(listeners.get(name) || [])]) cb(...args) },
  }
  const observer = createSessionChangesObserver({ logger: ctx.logger })
  const offEvent = ctx.on('session/event', (s, e) => observer.observe(s, e))
  const offDisposed = ctx.on('session/disposed', (s) => observer.forget(s))

  check('session/event 触发后 recent() 有值', () => {
    assert(observer.recent() === undefined, '起点应为空')
    ctx.emit('session/event', session('real-1'), event('workspace/changes', 42, { turn: 5 }, 1234))
    const r = observer.recent()
    assert(r && r.sessionId === 'real-1' && r.seq === 42 && r.turn === 5, '观察失败: ' + JSON.stringify(r))
  })
  check('session/disposed 触发后记录被清掉', () => {
    ctx.emit('session/disposed', session('real-1'))
    assert(observer.recent() === undefined, '应已清掉')
  })
  check('disposer 生效（卸载后不再收事件）', () => {
    offEvent(); offDisposed()
    ctx.emit('session/event', session('real-2'), event('workspace/changes', 7, {}, 1))
    assert(observer.recent() === undefined, 'disposer 没断开')
  })
}

// ═══ [3] 路由：参数校验（400 分支）════════════════════════════════════════
console.log('\n=== [3] 路由 400 ===')
{
  const deps = {
    sessionChanges: {
      recent: () => ({ sessionId: 's1', seq: 42, announcedAt: 111 }),
      lookup: () => ({ ok: true, summary: OFFICIAL_SUMMARY }),
    },
  }
  const r1 = await call(deps, 'GET', '/ext/artifacts/session-changes')
  check('★ 无坐标且无 recent → 400 coordinates-required', () => {
    assert(r1.statusCode === 400, '状态码 ' + r1.statusCode)
    assert(r1.json().reason === 'coordinates-required', '响应: ' + r1.body)
  })
  const r2 = await call(deps, 'GET', '/ext/artifacts/session-changes?sessionId=s1')
  check('只给 sessionId、缺 seq → 400（默认模式要求坐标给全）', () => {
    assert(r2.statusCode === 400 && r2.json().reason === 'coordinates-required', '状态码 ' + r2.statusCode + ' ' + r2.body)
  })
  const r3 = await call(deps, 'GET', '/ext/artifacts/session-changes?seq=42')
  check('只给 seq、缺 sessionId → 400', () => {
    assert(r3.statusCode === 400, '状态码 ' + r3.statusCode)
  })
  for (const bad of ['1.5', '-1', '0x10', '1e3', 'abc', '', ' 5']) {
    const r = await call(deps, 'GET', '/ext/artifacts/session-changes?sessionId=s1&seq=' + encodeURIComponent(bad))
    check('非法 seq ' + JSON.stringify(bad) + ' → 400', () => {
      assert(r.statusCode === 400, '状态码 ' + r.statusCode + ' body=' + r.body)
    })
  }
  const rOk = await call(deps, 'GET', '/ext/artifacts/session-changes?sessionId=s1&seq=0')
  check('seq=0 是合法坐标（不被当成 falsy 丢掉）', () => {
    assert(rOk.statusCode === 200, '状态码 ' + rOk.statusCode + ' body=' + rOk.body)
  })
}

// ═══ [4] 路由：命中（200 分支，官方原形状）════════════════════════════════
console.log('\n=== [4] 路由 200（形状与官方对齐）===')
{
  const deps = {
    sessionChanges: {
      recent: () => ({ sessionId: 's1', seq: 42, announcedAt: 1759000000000 }),
      lookup: (id, seq) => (id === 's1' && seq === 42 ? { ok: true, summary: OFFICIAL_SUMMARY } : { ok: false, reason: 'not-found' }),
    },
  }
  const r = await call(deps, 'GET', '/ext/artifacts/session-changes?sessionId=s1&seq=42')
  check('★ 显式坐标命中 → 200 derived:false，官方五字段齐全', () => {
    assert(r.statusCode === 200, '状态码 ' + r.statusCode + ' body=' + r.body)
    const b = r.json()
    assert(b.ok === true && b.derived === false, 'body: ' + r.body)
    assert(b.sessionId === 's1' && b.seq === 42, '坐标回显: ' + r.body)
    for (const k of ['turn', 'files', 'total', 'added', 'deleted']) {
      assert(Object.prototype.hasOwnProperty.call(b, k), '缺官方字段 ' + k)
    }
    assert(b.turn === 3 && b.total === 3 && b.added === 4 && b.deleted === 1, '值不对: ' + r.body)
  })
  check('★ files[i] 是官方原样（path/display/added/deleted + binary?/oversized?）', () => {
    const files = r.json().files
    assert(files.length === 3, 'files 长度 ' + files.length)
    assert(files[0].path === 'a.txt' && files[0].display === 'a.txt', 'file0: ' + JSON.stringify(files[0]))
    assert(files[0].added === 4 && files[0].deleted === 1, '增删行数: ' + JSON.stringify(files[0]))
    assert(files[1].binary === true, 'binary 标记丢了: ' + JSON.stringify(files[1]))
    assert(files[2].oversized === true, 'oversized 标记丢了: ' + JSON.stringify(files[2]))
  })
  check('★ 不掺非官方字段：既没有 index，也没有 before/after', () => {
    const files = r.json().files
    for (const f of files) {
      assert(!('index' in f), '不该有 index（index 用数组下标）: ' + JSON.stringify(f))
      assert(!('before' in f) && !('after' in f), '不该有 before/after（那是 /api/changes.diff 的活）: ' + JSON.stringify(f))
      assert(!('kind' in f), '不该有归一化的 kind: ' + JSON.stringify(f))
      assert(!('removed' in f), '官方叫 deleted，不该有 removed: ' + JSON.stringify(f))
    }
  })
  check('★ 补 cwd（官方刻意不给，我们 root 面板没有 session store）', () => {
    assert(r.json().cwd === OFFICIAL_SUMMARY.cwd, 'cwd: ' + r.body)
  })
  check('显式模式的响应里没有 announcedAt（那是 derived 专用的）', () => {
    assert(!('announcedAt' in r.json()), '不该有 announcedAt: ' + r.body)
  })
  check('★ 不过 assertInScope：cwd 外的绝对路径照样出现在 files 里（少报也是骗人）', () => {
    const files = r.json().files
    assert(files.some((f) => f.path === 'C:\\outside\\bin.dat'), 'cwd 外的改动被过滤掉了: ' + r.body)
  })
}

// ═══ [5] 路由：derived（recent=1）分支 ═══════════════════════════════════
console.log('\n=== [5] 路由 derived（recent=1）===')
{
  const empty = { sessionChanges: { recent: () => undefined, lookup: () => ({ ok: false, reason: 'not-found' }) } }
  const rNone = await call(empty, 'GET', '/ext/artifacts/session-changes?recent=1')
  check('★ 从没观察到 → 404 nothing-observed（**不回落凑数**）', () => {
    assert(rNone.statusCode === 404, '状态码 ' + rNone.statusCode + ' body=' + rNone.body)
    const b = rNone.json()
    assert(b.ok === false && b.reason === 'nothing-observed', 'body: ' + rNone.body)
    assert(!('files' in b), '不该编出 files: ' + rNone.body)
  })
  const rTrue = await call(empty, 'GET', '/ext/artifacts/session-changes?recent=true')
  check('recent=true → 同样走 derived 分支（404 而不是 400）', () => {
    assert(rTrue.statusCode === 404 && rTrue.json().reason === 'nothing-observed', '状态码 ' + rTrue.statusCode + ' ' + rTrue.body)
  })

  const some = {
    sessionChanges: {
      recent: () => ({ sessionId: 'picked-1', seq: 77, announcedAt: 1759111222333, turn: 4 }),
      lookup: (id, seq) => (id === 'picked-1' && seq === 77 ? { ok: true, summary: OFFICIAL_SUMMARY } : { ok: false, reason: 'not-found' }),
    },
  }
  const rSome = await call(some, 'GET', '/ext/artifacts/session-changes?recent=1')
  check('★ 有观察 → 200 derived:true + announcedAt + sessionId（UI 只能标「最近改动」）', () => {
    assert(rSome.statusCode === 200, '状态码 ' + rSome.statusCode + ' body=' + rSome.body)
    const b = rSome.json()
    assert(b.ok === true && b.derived === true, 'derived 必须是 true: ' + rSome.body)
    assert(b.sessionId === 'picked-1' && b.seq === 77, '坐标: ' + rSome.body)
    assert(b.announcedAt === 1759111222333, 'announcedAt: ' + rSome.body)
    assert(b.turn === 3 && b.files.length === 3, '摘要透传: ' + rSome.body)
  })
  const rRace = await call(
    { sessionChanges: { recent: () => ({ sessionId: 'gone', seq: 1, announcedAt: 5 }), lookup: () => ({ ok: false, reason: 'not-found' }) } },
    'GET', '/ext/artifacts/session-changes?recent=1',
  )
  check('观察到了但服务侧已失效（会话销毁）→ 404 not-found', () => {
    assert(rRace.statusCode === 404 && rRace.json().reason === 'not-found', '状态码 ' + rRace.statusCode + ' ' + rRace.body)
  })
}

// ═══ [6] 路由：404 / 503 / 权限 ══════════════════════════════════════════
console.log('\n=== [6] 路由 404 / 503 / 403 ===')
{
  const notFound = { sessionChanges: { recent: () => undefined, lookup: () => ({ ok: false, reason: 'not-found' }) } }
  const r404 = await call(notFound, 'GET', '/ext/artifacts/session-changes?sessionId=s1&seq=99')
  check('坐标查不到 → 404 not-found', () => {
    assert(r404.statusCode === 404 && r404.json().reason === 'not-found', '状态码 ' + r404.statusCode + ' ' + r404.body)
  })
  const noService = { sessionChanges: { recent: () => undefined, lookup: () => ({ ok: false, reason: 'service-unavailable' }) } }
  const r503 = await call(noService, 'GET', '/ext/artifacts/session-changes?sessionId=s1&seq=1')
  check('宿主未挂 workspaceChanges → 503 service-unavailable', () => {
    assert(r503.statusCode === 503 && r503.json().reason === 'service-unavailable', '状态码 ' + r503.statusCode + ' ' + r503.body)
  })
  const rDisabled = await call({}, 'GET', '/ext/artifacts/session-changes?recent=1')
  check('端点依赖没注入 → 503 unavailable（而不是崩）', () => {
    assert(rDisabled.statusCode === 503 && rDisabled.json().reason === 'unavailable', '状态码 ' + rDisabled.statusCode + ' ' + rDisabled.body)
  })
  const rLan = await call(
    { sessionChanges: { recent: () => ({ sessionId: 's1', seq: 1, announcedAt: 1 }), lookup: () => ({ ok: true, summary: OFFICIAL_SUMMARY }) } },
    'GET', '/ext/artifacts/session-changes?recent=1', '192.168.1.50',
  )
  check('★ 局域网来源 → 403（会话改动不给局域网）', () => {
    assert(rLan.statusCode === 403, '状态码 ' + rLan.statusCode)
  })
  const rPost = await call(
    { sessionChanges: { recent: () => undefined, lookup: () => ({ ok: true, summary: OFFICIAL_SUMMARY }) } },
    'POST', '/ext/artifacts/session-changes',
  )
  check('POST → 不落进 GET 分支（走 405/其他，不返回摘要）', () => {
    assert(rPost.statusCode !== 200, '不该 200: ' + rPost.statusCode)
  })
}

// ═══ [7] 回归：别把既有路由挤掉 ══════════════════════════════════════════
console.log('\n=== [7] 回归 ===')
{
  const deps = {
    sessionChanges: { recent: () => undefined, lookup: () => ({ ok: false, reason: 'not-found' }) },
    fileIndex: { listDir: async () => ({ ok: true, entries: [], dirCount: 0, fileCount: 0 }) },
    assertInScope: async (p) => ({ ok: true, path: p }),
  }
  const rStats = await call(deps, 'GET', '/ext/artifacts/stats')
  check('stats 路由不受影响', () => { assert(rStats.statusCode === 200, '状态码 ' + rStats.statusCode) })
  const rGet = await call(deps, 'GET', '/ext/artifacts/art_123')
  check('普通记录路由仍走 store.get', () => { assert(rGet.body.includes('STORE-GOT-IT'), 'body: ' + rGet.body) })
  const rFiles = await call(deps, 'GET', '/ext/artifacts/files/list?dir=' + encodeURIComponent('C:\\ws'))
  check('files/list 路由不受影响', () => { assert(rFiles.statusCode === 200, '状态码 ' + rFiles.statusCode) })
}

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
