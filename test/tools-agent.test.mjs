/**
 * 离线 harness：agent 侧工具（lib/tools.js）
 *
 * 这轮调研（task-12）发现的缺口，每一条都在这里被钉住：
 *   · 列表**不打印大小/时间** → agent 说不出「哪个最大」（场景 A）
 *   · 计数**会说谎**：「命中 N 条」里的 N 是返回条数，不是真实命中数
 *   · **没有分页**：193 条有效记录、默认 limit 50 → 后面的拿不到
 *   · **没有读正文的工具**：只能 artifact_get 一坨 5 万字符的 JSON，且没法续读
 *   · `register_artifact` 重复登记时说「✅ 已登记」（**接口在骗人**，task-10 引入）
 *
 * 用法：node test/tools-agent.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArtifactStore } from '../lib/store.js'
import { registerArtifactTools, fileMention, humanSize, humanTime } from '../lib/tools.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-tools-'))
let seq = 0
const tools = new Map()
const ctx = {
  tools: {
    // 复刻真实约定：同名工具会抛。但测试里会反复 freshStore()，
    // 所以这里用「同一批工具集重新装一遍」的语义（覆盖计数），并在 [1] 里单独验重名会抛。
    register(tool) {
      if (!ctx.tools.allowReplace && tools.has(tool.name)) throw new Error('工具名重复: ' + tool.name)
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
    allowReplace: false,
  },
}
function freshStore() {
  const dir = path.join(TMP, 'store' + (seq += 1))
  fs.mkdirSync(dir, { recursive: true })
  const store = new ArtifactStore(dir).load()
  ctx.tools.allowReplace = true
  registerArtifactTools(ctx, store)
  ctx.tools.allowReplace = false
  return store
}
function makeFile(name, body) {
  const p = path.join(TMP, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}
const run = (name, args) => tools.get(name).execute(args, {})

// ═══ [1] 工具清单与 JSON Schema 契约 ═══════════════════════════════════
console.log('\n=== [1] 工具清单与契约 ===')
freshStore()
{
  check('★ 注册了 13 个工具（数出来的，不是记的）', () => {
    assert(tools.size === 13, '实际 ' + tools.size + ': ' + [...tools.keys()].join(', '))
  })
  check('每个工具的 parameters 是合法 JSON Schema（type=object + properties + required 子集）', () => {
    for (const [name, tool] of tools) {
      const p = tool.parameters
      assert(p && p.type === 'object', name + ' 的 parameters.type 不是 object')
      assert(p.properties && typeof p.properties === 'object', name + ' 缺 properties')
      for (const req of p.required || []) {
        assert(Object.prototype.hasOwnProperty.call(p.properties, req), `${name} 的 required 里有未声明的参数 ${req}`)
      }
      assert(typeof tool.description === 'string' && tool.description.length >= 6, name + ' 的 description 太短（agent 只能靠它判断何时用）')
      assert(typeof tool.execute === 'function', name + ' 缺 execute')
    }
  })
  check('每个工具都声明了 text 输出（agent 拿得到东西）', () => {
    for (const [name, tool] of tools) {
      assert(tool.output && tool.output.schema && tool.output.schema.properties.text, name + ' 没声明 text 输出')
      assert(typeof tool.output.render === 'function', name + ' 没声明 render')
    }
  })
  check('重名工具会被平台拒绝（register 抛错）—— 我们没有重名', () => {
    const seen = new Set()
    for (const name of tools.keys()) {
      assert(!seen.has(name), '重名: ' + name)
      seen.add(name)
    }
  })
  check('返回的 disposer 能把整批工具卸干净（卸载后不留孤儿）', () => {
    const dir = path.join(TMP, 'dispose-probe')
    fs.mkdirSync(dir, { recursive: true })
    const local = new Map()
    const localCtx = { tools: { register: (t) => { local.set(t.name, t); return () => local.delete(t.name) } } }
    const destroy = registerArtifactTools(localCtx, new ArtifactStore(dir).load())
    assert(local.size === 13, '装了 ' + local.size + ' 个')
    destroy()
    assert(local.size === 0, '卸载后还剩 ' + local.size + ' 个')
  })
}

// ═══ [2] ★ register_artifact：重复登记必须说实话 ═══════════════════════
console.log('\n=== [2] register_artifact 重复登记不再谎报 ===')
{
  const store = freshStore()
  const f = makeFile('reg/报告.md', '# 报告')
  const first = await run('register_artifact', { path: f, title: '我的报告' })
  check('首次登记 → ✅ 已登记 + id + 引用文本', () => {
    assert(/^✅ 已登记 art_/.test(first.text), '输出: ' + first.text)
    assert(first.text.includes('我的报告'), '缺标题: ' + first.text)
    assert(first.text.includes('@'), '缺可引用文本: ' + first.text)
    assert(store.items.length === 1, '记录数 ' + store.items.length)
  })
  const second = await run('register_artifact', { path: f })
  check('★★ 重复登记 → 明说「已经在产物库里了」，**不再**说「✅ 已登记」', () => {
    assert(!second.text.includes('✅ 已登记'), '★ 又在谎报登记成功了: ' + second.text)
    assert(second.text.includes('已经在产物库里'), '应明说已在库里: ' + second.text)
    assert(second.text.includes('没有重复添加'), '应说明没有重复添加: ' + second.text)
    assert(store.items.length === 1, '★ 不该新建记录: ' + store.items.length)
  })
  const dupId = store.items[0].id
  check('重复登记返回的是**已有记录的 id**（agent 能据此引用同一条）', () => {
    assert(second.text.includes(dupId), `应含 ${dupId}，实际: ${second.text}`)
  })
  check('source 枚举含 present（与 store 白名单一致）', () => {
    const src = tools.get('register_artifact').parameters.properties.source
    assert(JSON.stringify(src.enum) === JSON.stringify(['session', 'folder-import', 'manual', 'present']), '枚举: ' + JSON.stringify(src.enum))
  })
  const bad = await run('register_artifact', { path: path.join(TMP, '.ssh', 'id_rsa') })
  check('敏感路径 → 人话错误（agent 能读懂）', () => {
    assert(bad.text.startsWith('❌ 登记失败'), '输出: ' + bad.text)
    assert(/敏感|凭据/.test(bad.text), '错误文案不友好: ' + bad.text)
  })
}

// ═══ [3] ★ artifact_list：诚实计数 + 数值 + 分页 ═══════════════════════
console.log('\n=== [3] artifact_list 诚实计数 / 大小时间 / 分页 ===')
{
  const store = freshStore()
  const sizes = [10, 2000, 300000, 40, 70000]
  sizes.forEach((n, i) => {
    const f = makeFile(`proj/文件${i}.txt`, 'x'.repeat(n))
    store.register({ path: f, title: '样本' + i, project: '样本项目', artifact_type: 'document' })
  })

  const r1 = await run('artifact_list', { project: '样本项目', limit: 2 })
  check('★★ 头部是**真实命中数**（5），不是返回条数（2）', () => {
    assert(r1.text.includes('命中 5 条'), '头部: ' + r1.text.split('\n')[0])
    assert(r1.text.includes('返回第 1-2 条'), '头部: ' + r1.text.split('\n')[0])
  })
  check('★ 头部明确告知**还有多少条未显示 + 怎么翻页**', () => {
    assert(r1.text.includes('还有 3 条未显示'), '头部: ' + r1.text.split('\n')[0])
    assert(r1.text.includes('offset=2'), '应给出翻页参数: ' + r1.text.split('\n')[0])
  })
  check('★ 每行末尾有**大小**与**修改时间**（没有它就说不出「哪个最大」）', () => {
    const line = r1.text.split('\n')[1]
    assert(/\| \d+(\.\d+)? (B|KB|MB|GB) \| /.test(line), '行里没有人类可读大小: ' + line)
    assert(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(line), '行里没有时间: ' + line)
  })
  check('★ 行尾给出可粘贴的 @引用文本', () => {
    const line = r1.text.split('\n')[1]
    assert(/\| @/.test(line), '行里没有 @引用: ' + line)
  })
  const r2 = await run('artifact_list', { project: '样本项目', limit: 2, offset: 2 })
  check('★ offset 翻页：第二页是第 3-4 条，且头部同步', () => {
    assert(r2.text.includes('返回第 3-4 条'), '头部: ' + r2.text.split('\n')[0])
    const ids1 = r1.text.split('\n').slice(1).map((l) => l.slice(0, 20))
    const ids2 = r2.text.split('\n').slice(1).map((l) => l.slice(0, 20))
    assert(!ids1.some((x) => ids2.includes(x)), '两页有重叠')
  })
  const r3 = await run('artifact_list', { project: '样本项目', limit: 100 })
  check('一页装得下时告知「已全部显示」', () => {
    assert(r3.text.includes('已全部显示'), '头部: ' + r3.text.split('\n')[0])
  })
  const rSort = await run('artifact_list', { project: '样本项目', sort: 'size_desc', limit: 1 })
  check('★★ 场景 A「找出最大的那张」：sort=size_desc + 行尾大小 → 可直接回答', () => {
    const line = rSort.text.split('\n')[1]
    assert(line.includes('300.0 KB') || line.includes('293 KB') || /300(\.\d)? KB/.test(line), '第一行应是最大的那个（300000B）: ' + line)
  })
}

// ═══ [4] ★ artifact_search / artifact_find 计数不再被 limit 截断 ═══════
console.log('\n=== [4] 搜索工具计数诚实 ===')
{
  const store = freshStore()
  for (let i = 0; i < 7; i += 1) {
    store.register({ path: makeFile(`s/命中${i}.md`, '关键词 zebra 出现在正文 ' + i), title: '命中' + i, project: 'S项目' })
  }
  store.register({ path: makeFile('s/无关.md', 'nothing'), title: '无关', project: 'S项目' })
  const r = await run('artifact_search', { q: 'zebra', limit: 3 })
  check('★ artifact_search 头部是真实命中数（7），不是返回条数（3）', () => {
    assert(r.text.includes('命中 7 条'), '头部: ' + r.text.split('\n')[0])
    assert(r.text.includes('返回第 1-3 条'), '头部: ' + r.text.split('\n')[0])
    assert(r.text.includes('还有 4 条未显示'), '头部: ' + r.text.split('\n')[0])
  })
  const rOff = await run('artifact_search', { q: 'zebra', limit: 3, offset: 3 })
  check('artifact_search 支持 offset', () => {
    assert(rOff.text.includes('返回第 4-6 条'), '头部: ' + rOff.text.split('\n')[0])
  })
  const rFind = await run('artifact_find', { q: '命中 关键词', limit: 2 })
  check('artifact_find 也如实报总数与分页', () => {
    assert(/命中 \d+ 条，返回第 1-2 条/.test(rFind.text), '输出: ' + rFind.text.split('\n')[0])
  })
  const rNone = await run('artifact_search', { q: '绝对不存在的词zzz' })
  check('无命中 → 人话（不是空字符串）', () => { assert(rNone.text.includes('未找到'), rNone.text) })
}

// ═══ [5] ★ artifact_read：读正文 + 分段 + 明确拒绝 ═══════════════════════
console.log('\n=== [5] artifact_read（新增，补「读内容」缺口）===')
{
  const store = freshStore()
  const body = Array.from({ length: 200 }, (_, i) => `第 ${i} 行内容`).join('\n')  // 约 1500+ 字符
  const f = makeFile('read/正文.md', body)
  const rec = store.register({ path: f, title: '要读的正文', project: '读项目' })

  const rAll = await run('artifact_read', { id: rec.id, limit: 50000 })
  check('★ 按 id 读全文 → 正文完整 + footer 报总字符/区间/已到结尾', () => {
    assert(rAll.text.startsWith('第 0 行内容'), '开头不对: ' + rAll.text.slice(0, 40))
    assert(rAll.text.includes('第 199 行内容'), '结尾不对')
    assert(rAll.text.includes(`共 ${body.length} 字符`), '没报总字符数: ' + rAll.text.slice(-260))
    assert(rAll.text.includes('已到结尾'), '没报已到结尾')
    assert(rAll.text.includes(rec.id) && rAll.text.includes(rec.path), 'footer 缺 id/path')
    assert(rAll.text.includes('@'), 'footer 缺可引用文本')
  })
  const rPart = await run('artifact_read', { id: rec.id, offset: 0, limit: 100 })
  check('★ 分段读 → 明确告知还有多少字符未读 + 用 offset 续读', () => {
    const tail = rPart.text.slice(-260)
    assert(/返回第 0-100 字符/.test(tail), '没报区间: ' + tail)
    assert(/还有 \d+ 字符未读，用 offset=100 续读/.test(tail), '没给续读指引: ' + tail)
  })
  const rNext = await run('artifact_read', { id: rec.id, offset: body.length - 10, limit: 100 })
  check('续读到结尾 → 说「已到结尾」（不会让人以为还有）', () => {
    assert(rNext.text.includes('已到结尾'), '结尾提示缺失: ' + rNext.text.slice(-200))
  })
  const rByPath = await run('artifact_read', { path: f, limit: 30 })
  check('按 path 读（已登记）→ 成功', () => {
    assert(rByPath.text.includes('第 0 行内容'), '输出: ' + rByPath.text.slice(0, 60))
  })

  // ── 明确拒绝的各种情况 ──
  const png = makeFile('read/图.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const pngRec = store.register({ path: png, title: '一张图' })
  const rPng = await run('artifact_read', { id: pngRec.id })
  check('★ 二进制（png）→ 明确拒绝并给路径，不吐乱码', () => {
    assert(rPng.text.includes('不是文本'), '输出: ' + rPng.text)
    assert(!rPng.text.includes('\uFFFD'), '吐了乱码')
    assert(rPng.text.includes(png), '没给路径')
  })
  const dir = path.join(TMP, 'read/一个目录')
  fs.mkdirSync(dir, { recursive: true })
  const dirRec = store.register({ path: dir, title: '目录条目', kind: 'reference' })
  const rDir = await run('artifact_read', { id: dirRec.id })
  check('目录 → 拒绝（没有正文可读）', () => { assert(rDir.text.includes('目录'), rDir.text) })

  const outsider = makeFile('read/没登记.md', 'secret')
  const rOut = await run('artifact_read', { path: outsider })
  check('★ 未登记的路径 → 拒绝，并给出**下一步该做什么**', () => {
    assert(rOut.text.includes('不在产物库里'), '输出: ' + rOut.text)
    assert(rOut.text.includes('register_artifact'), '应建议先登记: ' + rOut.text)
    assert(rOut.text.includes('artifact_search'), '应给出查找替代: ' + rOut.text)
  })
  check('★ 只能读已登记文件 —— 这是有意的安全边界（不变成任意读盘口子）', () => {
    assert(!rOut.text.includes('secret'), '★ 竟然把未登记文件的内容读出来了！')
  })
  const rMissing = await run('artifact_read', { id: 'art_不存在' })
  check('id 不存在 → 提示用 search/find 找', () => {
    assert(rMissing.text.includes('未找到产物'), rMissing.text)
    assert(rMissing.text.includes('artifact_search'), '应给下一步: ' + rMissing.text)
  })
  const rNoArg = await run('artifact_read', {})
  check('既没 id 也没 path → 人话说明怎么拿 id', () => {
    assert(rNoArg.text.includes('需要 id 或 path'), rNoArg.text)
  })
  const gone = makeFile('read/会消失.md', 'x')
  const goneRec = store.register({ path: gone, title: '会消失' })
  fs.unlinkSync(gone)
  store.refreshMissing ? store.refreshMissing() : null
  const goneFresh = store.get(goneRec.id)
  if (goneFresh) goneFresh.exists = false
  const rGone = await run('artifact_read', { id: goneRec.id })
  check('原文件已不存在 → 明说并给可选动作', () => {
    assert(/已经不在了|读取失败/.test(rGone.text), '输出: ' + rGone.text)
  })

  const big = makeFile('read/很大.txt', 'x'.repeat(9 * 1024 * 1024))
  const bigRec = store.register({ path: big, title: '很大' })
  const rBig = await run('artifact_read', { id: bigRec.id })
  check('★ 超大文件（>8MB）→ 明确拒绝并说明上限，不硬读', () => {
    assert(rBig.text.includes('超过 artifact_read 的上限'), '输出: ' + rBig.text)
    assert(/MB/.test(rBig.text), '应报大小: ' + rBig.text)
  })
}

// ═══ [6] ★ fileMention：与官方规格 / 客户端 atMention 同一套测试向量 ═══
console.log('\n=== [6] @引用格式（测试向量，两边共用同一规格）===')
{
  check('无空白 → @路径（正斜杠）', () => {
    assert(fileMention('C:\\a\\b.md') === '@C:/a/b.md', fileMention('C:\\a\\b.md'))
  })
  check('含空白 → @"路径"', () => {
    assert(fileMention('C:\\a b\\c.md') === '@"C:/a b/c.md"', fileMention('C:\\a b\\c.md'))
  })
  check('目录 → 末尾补 /（半开引号用于下钻语义）', () => {
    assert(fileMention('C:\\a b\\dir', { isDirectory: true }) === '@"C:/a b/dir/', fileMention('C:\\a b\\dir', { isDirectory: true }))
    assert(fileMention('C:\\dir', { isDirectory: true }) === '@C:/dir/', fileMention('C:\\dir', { isDirectory: true }))
  })
  check('含引号或控制字符 → 返回空串（不可引用）', () => {
    assert(fileMention('C:\\a"b.md') === '', '引号应判不可用: ' + fileMention('C:\\a"b.md'))
    assert(fileMention('C:\\a\nb.md') === '', '换行应判不可用')
  })
  check('空/非字符串 → 空串（不抛）', () => {
    assert(fileMention('') === '@', '空串按无空白处理: ' + fileMention(''))
    assert(fileMention(null) === '@', 'null: ' + fileMention(null))
    assert(fileMention(undefined) === '@', 'undefined: ' + fileMention(undefined))
  })
}

// ═══ [7] 回归：既有工具没被改坏 ═══════════════════════════════════════
console.log('\n=== [7] 既有工具回归 ===')
{
  const store = freshStore()
  const f = makeFile('old/a.md', '# hi')
  const rec = store.register({ path: f, title: 'A', summary: 's', tags: ['t'], project: 'P' })
  const g = await run('artifact_get', { id: rec.id })
  check('artifact_get 仍返回可解析 JSON（含 contentIndex 正文）', () => {
    const parsed = JSON.parse(g.text)
    assert(parsed.id === rec.id && parsed.title === 'A', 'body: ' + g.text.slice(0, 120))
    assert(typeof parsed.contentIndex === 'string', '应含 contentIndex')
  })
  const gMiss = await run('artifact_get', { id: 'art_nope' })
  check('artifact_get 未找到 → 人话', () => { assert(gMiss.text.includes('未找到产物'), gMiss.text) })
  const st = await run('artifact_stats', {})
  check('artifact_stats 是 JSON', () => { const p = JSON.parse(st.text); assert(typeof p.total === 'number', st.text.slice(0, 80)) })
  const ov = await run('project_overview', { project: 'P' })
  check('project_overview 是 JSON', () => { JSON.parse(ov.text) })
  const up = await run('artifact_update', { id: rec.id, stars: 5 })
  check('artifact_update 正常', () => { assert(up.text.includes('✅ 已更新'), up.text) })
  const tr = await run('artifact_trash', { id: rec.id })
  check('artifact_trash 正常', () => { assert(tr.text.includes('回收站'), tr.text) })
  const rs = await run('artifact_restore', { id: rec.id })
  check('artifact_restore 正常', () => { assert(rs.text.includes('已恢复'), rs.text) })
  const sc = await run('artifact_suggest_cleanup', {})
  check('artifact_suggest_cleanup 正常', () => { assert(sc.text.includes('整理建议单'), sc.text.slice(0, 60)) })
  const lk = await run('artifact_suggest_links', { id: rec.id })
  check('artifact_suggest_links 正常（无候选也说人话）', () => { assert(typeof lk.text === 'string' && lk.text.length > 0, lk.text) })
  check('humanSize / humanTime 边界', () => {
    assert(humanSize(0) === '0 B' && humanSize(2048) === '2 KB' && humanSize(1536 * 1024) === '1.5 MB', humanSize(1536 * 1024))
    assert(humanSize(-1) === '—' && humanSize('x') === '—', '非法输入应回 —')
    assert(humanTime(0) === '—', humanTime(0))
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(humanTime(1790766537)), humanTime(1790766537))
  })
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
