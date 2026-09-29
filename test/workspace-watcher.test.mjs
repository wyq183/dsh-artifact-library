/**
 * 离线测试：主动纳管（会话工作区监视器）
 *
 * 不启动 DSH —— mock ctx.on，验证：
 *   · extractCwd 的各种会话形态（header.cwd / cwd / 嵌套 workspace.path / 空 / null）
 *   · 订阅成功后，会话事件能触发 onChange
 *   · 同一个 cwd 只通知一次（去重，Windows 大小写不敏感）
 *   · 观察者异常绝不上抛（会污染平台事件总线）
 *   · disposer 能解绑
 *   · ctx.on 本身就抛时，优雅降级而不是崩
 *
 * 用法：node test/workspace-watcher.test.mjs
 */

import { attachWorkspaceWatcher, extractCwd, extractSessionId } from '../lib/index/watch.js'

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

/** mock ctx：记录订阅，提供手动触发 */
function makeCtx(options = {}) {
  const subs = []
  return {
    subs,
    on(event, handler) {
      if (options.throwOnSubscribe) throw new Error('订阅被禁止')
      const entry = { event, handler, off: false }
      subs.push(entry)
      return () => { entry.off = true }
    },
    /** 手动触发一次 session/event */
    emit(session, event = { type: 'turn/end' }) {
      for (const sub of subs) if (!sub.off) sub.handler(session, event)
    },
  }
}

console.log('\n=== [1] extractCwd 形态兼容 ===')
check('header.cwd（官方形态）', () => {
  assert(extractCwd({ header: { cwd: 'C:\\proj' } }) === 'C:\\proj', '取不到 header.cwd')
})
check('顶层 cwd（退回形态）', () => {
  assert(extractCwd({ cwd: 'D:\\other' }) === 'D:\\other', '取不到顶层 cwd')
})
check('header.workspace.path（另一种嵌套）', () => {
  assert(extractCwd({ header: { workspace: { path: 'E:\\ws' } } }) === 'E:\\ws', '取不到嵌套路径')
})
check('header.cwd 优先于顶层 cwd', () => {
  assert(extractCwd({ header: { cwd: 'C:\\win' }, cwd: 'D:\\lose' }) === 'C:\\win', '优先级不对')
})
check('空值/空白/null/undefined 都返回空串', () => {
  assert(extractCwd(null) === '', 'null')
  assert(extractCwd(undefined) === '', 'undefined')
  assert(extractCwd({}) === '', '空对象')
  assert(extractCwd({ header: { cwd: '   ' } }) === '', '空白串')
  assert(extractCwd({ header: { cwd: 123 } }) === '', '非字符串')
})
check('extractSessionId 两种形态', () => {
  assert(extractSessionId({ header: { id: 's1' } }) === 's1', 'header.id')
  assert(extractSessionId({ id: 's2' }) === 's2', '顶层 id')
  assert(extractSessionId(null) === '', 'null')
})

console.log('\n=== [2] 监视器行为 ===')
check('订阅成功并绑到 session/event', () => {
  const ctx = makeCtx()
  attachWorkspaceWatcher(ctx, { onChange: () => {} })
  assert(ctx.subs.length === 1, '订阅数 ' + ctx.subs.length)
  assert(ctx.subs[0].event === 'session/event', '事件名 ' + ctx.subs[0].event)
})

check('★ 会话事件触发 onChange，并带上 cwd', () => {
  const got = []
  const ctx = makeCtx()
  attachWorkspaceWatcher(ctx, { onChange: (cwd) => got.push(cwd) })
  ctx.emit({ header: { cwd: 'C:\\p1' } })
  ctx.emit({ header: { cwd: 'C:\\p2' } })
  assert(got.length === 2, '通知次数 ' + got.length + ': ' + JSON.stringify(got))
  assert(got[0] === 'C:\\p1' && got[1] === 'C:\\p2', '内容: ' + JSON.stringify(got))
})

check('★ 同一个 cwd 只通知一次（去重）', () => {
  const got = []
  const ctx = makeCtx()
  attachWorkspaceWatcher(ctx, { onChange: (cwd) => got.push(cwd) })
  ctx.emit({ header: { cwd: 'C:\\same' } })
  ctx.emit({ header: { cwd: 'C:\\same' } })
  ctx.emit({ header: { cwd: 'C:\\same' } })
  assert(got.length === 1, '通知次数 ' + got.length)
})

check('★ 去重大小写不敏感（Windows 语义）', () => {
  const got = []
  const ctx = makeCtx()
  attachWorkspaceWatcher(ctx, { onChange: (cwd) => got.push(cwd) })
  ctx.emit({ header: { cwd: 'C:\\Proj' } })
  ctx.emit({ header: { cwd: 'c:\\proj' } })
  assert(got.length === 1, '通知次数 ' + got.length)
})

check('没有 cwd 的事件不通知', () => {
  const got = []
  const ctx = makeCtx()
  attachWorkspaceWatcher(ctx, { onChange: (cwd) => got.push(cwd) })
  ctx.emit({ header: {} })
  ctx.emit({})
  ctx.emit(null)
  assert(got.length === 0, '不该有通知，得到 ' + JSON.stringify(got))
})

check('★ onChange 抛异常不外抛（不污染事件总线）', () => {
  const ctx = makeCtx()
  attachWorkspaceWatcher(ctx, { onChange: () => { throw new Error('上层炸了') } })
  // 不该抛出去
  ctx.emit({ header: { cwd: 'C:\\boom' } })
  assert(true, '未抛出')
})

check('★ 会话对象异常不外抛', () => {
  const ctx = makeCtx()
  attachWorkspaceWatcher(ctx, { onChange: () => {} })
  // 造一个 getter 抛异常的对象
  const evil = {}
  Object.defineProperty(evil, 'header', { get() { throw new Error('恶意 getter') } })
  ctx.emit(evil)
  assert(true, '未抛出')
})

check('disposer 解绑后不再通知', () => {
  const got = []
  const ctx = makeCtx()
  const dispose = attachWorkspaceWatcher(ctx, { onChange: (cwd) => got.push(cwd) })
  ctx.emit({ header: { cwd: 'C:\\a' } })
  dispose()
  ctx.emit({ header: { cwd: 'C:\\b' } })
  assert(got.length === 1, '解绑后仍通知: ' + JSON.stringify(got))
})

check('★ ctx.on 抛异常时优雅降级（返回空 disposer）', () => {
  const ctx = makeCtx({ throwOnSubscribe: true })
  const dispose = attachWorkspaceWatcher(ctx, { onChange: () => {} })
  assert(typeof dispose === 'function', '未返回 disposer')
  dispose() // 不该抛
})

check('缺 onChange 也不崩（默认空函数）', () => {
  const ctx = makeCtx()
  attachWorkspaceWatcher(ctx, {})
  ctx.emit({ header: { cwd: 'C:\\x' } })
  assert(true, '未抛出')
})

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
