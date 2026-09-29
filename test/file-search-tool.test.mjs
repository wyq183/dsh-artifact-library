/**
 * 离线测试：search_files 工具（给模型用的文件搜索）
 *
 * 不启动 DSH、不启动 Everything —— mock 引擎与 ctx.tools，验证：
 *   · 工具定义合法性（name / parameters 是标准 JSON Schema / 有 output）
 *   · 正常路径：命中后输出含路径、条数、耗时、范围说明
 *   · 引擎不可用 → 友好错误（不抛）
 *   · 空结果 → 说明范围边界（而不是干巴巴"无结果"）
 *   · limit 上限钳制（500）
 *   · execute 内部异常 → 返回错误文本而不是抛（工具抛错会污染会话）
 *
 * 用法：node test/file-search-tool.test.mjs
 */

import { registerFileSearchTool } from '../lib/index/tool.js'

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

/** 造一个 mock 引擎；overrides 可覆盖任意方法 */
function makeEngine(overrides = {}) {
  const calls = []
  const engine = {
    calls,
    ensureReady: async (args) => { calls.push(['ensureReady', args]); return { ok: true, scope: args.scopeDirs } },
    search: async (args) => {
      calls.push(['search', args])
      return {
        ok: true,
        query: args.query,
        rows: [
          { path: 'C:\\ws\\报告.txt', name: '报告.txt', dir: 'C:\\ws', ext: 'txt', size: 2048, modified: 1790000000 },
          { path: 'C:\\ws\\sub\\图.png', name: '图.png', dir: 'C:\\ws\\sub', ext: 'png', size: 1048576, modified: 1790000001 },
        ],
        total: 2,
        truncated: false,
        elapsedMs: 5,
      }
    },
  }
  return Object.assign(engine, overrides)
}

/** 注册工具并取回它 */
function grab(engine, scope = ['C:\\ws']) {
  let tool = null
  const ctx = { tools: { register: (t) => { tool = t; return () => {} } } }
  const disposer = registerFileSearchTool(ctx, engine, async () => scope)
  assert(typeof disposer === 'function', 'disposer 不是函数')
  assert(tool, '未注册工具')
  return tool
}

console.log('\n=== [1] 工具定义 ===')
const baseTool = grab(makeEngine())
check('name = search_files', () => assert(baseTool.name === 'search_files', '得到 ' + baseTool.name))
check('parameters 是标准 JSON Schema', () => {
  const p = baseTool.parameters
  assert(p && p.type === 'object', 'type 不是 object')
  assert(p.properties && p.properties.query, '缺 query 属性')
  assert(Array.isArray(p.required) && p.required.includes('query'), 'required 缺 query')
})
check('有 output（text 形态）', () => {
  assert(baseTool.output && baseTool.output.schema, '缺 output.schema')
  const rendered = baseTool.output.render({}, { text: 'hi' })
  assert(Array.isArray(rendered) && rendered[0].text === 'hi', 'render 结果不对')
})
check('timeoutMs 给足（首次要等建索引）', () => {
  assert(baseTool.timeoutMs >= 60000, 'timeoutMs = ' + baseTool.timeoutMs)
})
check('描述里写明了范围边界与 grep 分工', () => {
  const d = baseTool.description
  assert(d.includes('仅限'), '没写范围限制')
  assert(d.includes('grep'), '没写与 grep 的分工')
  assert(d.includes('不索引文件内容') || d.includes('只索引'), '没写不索引内容')
})

console.log('\n=== [2] 正常路径 ===')
await (async () => {
  const engine = makeEngine()
  const tool = grab(engine)
  const out = await tool.execute({ query: 'ext:txt', limit: 10 })
  check('命中结果含路径 / 条数 / 耗时 / 范围', () => {
    assert(out.text.includes('C:\\ws\\报告.txt'), '缺路径: ' + out.text.slice(0, 200))
    assert(out.text.includes('命中 2 条'), '缺条数统计')
    assert(out.text.includes('5 ms'), '缺耗时')
    assert(out.text.includes('索引范围 1 个目录'), '缺范围说明')
  })
  check('参数透传到引擎', () => {
    const searchCall = engine.calls.filter((c) => c[0] === 'search').pop()
    assert(searchCall[1].query === 'ext:txt', 'query 未透传')
    assert(searchCall[1].limit === 10, 'limit 未透传')
  })
  check('大小/时间格式化进输出', () => {
    assert(out.text.includes('2 KB'), '缺大小格式化: ' + out.text.slice(0, 300))
    assert(out.text.includes('1.0 MB'), '缺 MB 格式化')
  })

  // limit 钳制
  const engine2 = makeEngine()
  const tool2 = grab(engine2)
  await tool2.execute({ query: '*', limit: 99999 })
  check('limit 上限钳制到 500', () => {
    const call = engine2.calls.filter((c) => c[0] === 'search').pop()
    assert(call[1].limit === 500, 'limit = ' + call[1].limit)
  })

  // 空结果
  const emptyEngine = makeEngine({
    search: async () => ({ ok: true, rows: [], total: 0, elapsedMs: 1 }),
  })
  const emptyTool = grab(emptyEngine)
  const emptyOut = await emptyTool.execute({ query: 'zzz' })
  check('空结果说明范围边界（不是干巴巴无结果）', () => {
    assert(emptyOut.text.includes('没有匹配'), '缺提示')
    assert(emptyOut.text.includes('范围'), '缺范围说明')
  })

  // 引擎不可用
  const downEngine = makeEngine({ ensureReady: async () => ({ ok: false, error: '实例未就绪' }) })
  const downTool = grab(downEngine)
  const downOut = await downTool.execute({ query: '*' })
  check('引擎不可用 → 友好错误 + 自救指引', () => {
    assert(downOut.text.includes('❌'), '缺错误标记')
    assert(downOut.text.includes('实例未就绪'), '缺原因')
    assert(downOut.text.includes('启动文件索引'), '缺指引')
  })

  // 搜索失败
  const failEngine = makeEngine({ search: async () => ({ ok: false, error: 'IPC 断了' }) })
  const failTool = grab(failEngine)
  const failOut = await failTool.execute({ query: '*' })
  check('搜索失败 → 返回错误文本（不抛）', () => {
    assert(failOut.text.includes('❌') && failOut.text.includes('IPC 断了'), '输出: ' + failOut.text)
  })

  // execute 内部异常
  const boomEngine = makeEngine({
    ensureReady: async () => { throw new Error('炸了') },
  })
  const boomTool = grab(boomEngine)
  const boomOut = await boomTool.execute({ query: '*' })
  check('execute 异常被兜住（工具抛错会污染会话）', () => {
    assert(boomOut.text.includes('❌') && boomOut.text.includes('炸了'), '输出: ' + boomOut.text)
  })

  // 缺 query 参数（模型可能漏）
  const noArgEngine = makeEngine()
  const noArgTool = grab(noArgEngine)
  const noArgOut = await noArgTool.execute({})
  check('缺 query 参数不崩（当空查询处理）', () => {
    const call = noArgEngine.calls.filter((c) => c[0] === 'search').pop()
    assert(call[1].query === '', 'query 应为空串，得到 ' + JSON.stringify(call[1].query))
    assert(typeof noArgOut.text === 'string', '应有文本输出')
  })
})()

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
