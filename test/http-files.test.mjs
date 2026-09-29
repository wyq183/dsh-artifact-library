/**
 * 离线 harness：/ext/artifacts/files* 路由
 *
 * 不启动 DSH、不启动 Everything —— 全部用 mock（req / res / store / engine），
 * 专测「分发正确性」与「安全边界」：
 *   · files 分支必须排在 `GET :id`（store.get）之前，否则 id='files' 会被当成产物 id
 *   · 子路由 status / start / stop / 未知 → 各自的状态码
 *   · 非本机来源（局域网）必须 403 —— 文件系统信息只给本机
 *   · 引擎未挂载时返回 503 而不是崩
 *
 * 用法：node test/http-files.test.mjs
 */

import { artifactsHandler } from '../lib/http.js'

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

// ── mock 设施 ─────────────────────────────────────────────────────────────
function makeReq(method, url, remoteAddress = '127.0.0.1') {
  return { method, url, headers: {}, socket: { remoteAddress } }
}

function makeRes() {
  const res = { statusCode: 0, headers: {}, body: '', finished: false }
  res.writeHead = (code, headers) => {
    res.statusCode = code
    Object.assign(res.headers, headers || {})
  }
  res.end = (chunk) => {
    res.body = chunk === undefined ? '' : String(chunk)
    res.finished = true
  }
  res.json = () => {
    try { return JSON.parse(res.body) } catch { return null }
  }
  return res
}

/** 一个"贪婪"的 store：任何 id 都返回记录 —— 用来证明 files 分支抢在它前面 */
function makeGreedyStore() {
  return {
    items: [],
    stats: () => ({ total: 42 }),
    categories: () => ({ projects: [], types: [], tags: [] }),
    getSettings: () => ({ searchLimit: 20 }),
    get: (id) => ({ id, title: 'STORE-GOT-IT' }),
    list: () => [],
    file: '/tmp/fake.json',
  }
}

/** mock 引擎：记录被调用情况，返回可断言的结果 */
function makeEngine() {
  const calls = []
  return {
    calls,
    status: async () => { calls.push(['status']); return { phase: 'ready', ready: true, scope: ['C:\\ws'] } },
    ensureReady: async (args) => { calls.push(['ensureReady', args]); return { ok: true, scope: args && args.scopeDirs } },
    search: async (args) => {
      calls.push(['search', args])
      return { ok: true, query: args.query, rows: [{ path: 'C:\\ws\\a.txt', name: 'a.txt', size: 1 }], total: 1, elapsedMs: 3 }
    },
    shutdown: async () => { calls.push(['shutdown']) },
  }
}

async function call(deps, method, url, remoteAddress) {
  const handler = artifactsHandler(makeGreedyStore(), deps)
  const req = makeReq(method, url, remoteAddress)
  const res = makeRes()
  await handler(req, res)
  return res
}

// ── [1] 引擎挂载时的各条子路由 ─────────────────────────────────────────────
console.log('\n=== [1] 路由分发 ===')
const engine = makeEngine()
const deps = {
  fileIndex: engine,
  resolveIndexScope: async () => ['C:\\ws'],
}

await (async () => {
  const r1 = await call(deps, 'GET', '/ext/artifacts/files/status')
  check('GET files/status → 200 且是引擎状态（不是 store 记录）', () => {
    assert(r1.statusCode === 200, '状态码 ' + r1.statusCode)
    const body = r1.json()
    assert(body && body.phase === 'ready', '响应体: ' + r1.body)
    assert(!r1.body.includes('STORE-GOT-IT'), '被 store.get 抢走了！')
  })

  const r2 = await call(deps, 'GET', '/ext/artifacts/files?q=ext%3Atxt&limit=7&sort=size')
  check('GET files?q=… → 200，参数透传到引擎', () => {
    assert(r2.statusCode === 200, '状态码 ' + r2.statusCode)
    const body = r2.json()
    assert(body.rows.length === 1 && body.total === 1, '响应体: ' + r2.body)
    const searchCall = engine.calls.filter((c) => c[0] === 'search').pop()
    assert(searchCall[1].query === 'ext:txt', 'query 未透传: ' + JSON.stringify(searchCall[1]))
    assert(searchCall[1].limit === 7, 'limit 未透传: ' + JSON.stringify(searchCall[1]))
    assert(searchCall[1].sort === 'size', 'sort 未透传: ' + JSON.stringify(searchCall[1]))
  })

  const r3 = await call(deps, 'POST', '/ext/artifacts/files/start')
  check('POST files/start → 200，并把范围交给引擎', () => {
    assert(r3.statusCode === 200, '状态码 ' + r3.statusCode)
    const startCall = engine.calls.filter((c) => c[0] === 'ensureReady').pop()
    assert(startCall && JSON.stringify(startCall[1].scopeDirs) === JSON.stringify(['C:\\ws']), 'scope 未传入: ' + JSON.stringify(startCall))
  })

  const r4 = await call(deps, 'POST', '/ext/artifacts/files/stop')
  check('POST files/stop → 200 且调用了 shutdown', () => {
    assert(r4.statusCode === 200, '状态码 ' + r4.statusCode)
    assert(engine.calls.some((c) => c[0] === 'shutdown'), '未调用 shutdown')
  })

  const r5 = await call(deps, 'GET', '/ext/artifacts/files/nope')
  check('未知子路由 → 404', () => {
    assert(r5.statusCode === 404, '状态码 ' + r5.statusCode)
  })

  const r6 = await call(deps, 'GET', '/ext/artifacts/files/status', '192.168.1.50')
  check('★ 非本机来源 → 403（文件系统信息不外给局域网）', () => {
    assert(r6.statusCode === 403, '状态码 ' + r6.statusCode + ' body=' + r6.body)
  })

  const r7 = await call({}, 'GET', '/ext/artifacts/files/status')
  check('引擎未挂载 → 503（而不是崩）', () => {
    assert(r7.statusCode === 503, '状态码 ' + r7.statusCode)
    assert(r7.json().error.includes('未启用'), '错误文案: ' + r7.body)
  })

  const r8 = await call(deps, 'GET', '/ext/artifacts/stats')
  check('回归：原有 stats 路由不受影响', () => {
    assert(r8.statusCode === 200, '状态码 ' + r8.statusCode)
    assert(r8.json().total === 42, '响应体: ' + r8.body)
  })

  const r9 = await call(deps, 'GET', '/ext/artifacts/art_123')
  check('回归：普通记录路由仍走 store.get', () => {
    assert(r9.statusCode === 200, '状态码 ' + r9.statusCode)
    assert(r9.body.includes('STORE-GOT-IT'), '应走 store.get: ' + r9.body)
  })

  const r10 = await call(deps, 'GET', '/ext/artifacts/files')
  check('GET files（无参数）→ 空查询透传', () => {
    assert(r10.statusCode === 200, '状态码 ' + r10.statusCode)
    const searchCall = engine.calls.filter((c) => c[0] === 'search').pop()
    assert(searchCall[1].query === '', '空查询应为 ""，得到: ' + JSON.stringify(searchCall[1].query))
  })
})()

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
