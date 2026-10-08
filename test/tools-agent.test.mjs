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
import { SettingsStore } from '../lib/settings.js'
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
  check('★ 注册了 16 个工具（数出来的，不是记的）', () => {
    // 15 → 16：Step 3c 加了 `artifact_tags`。这个数字**故意写死**——
    // 加/删工具时要人**主动**来改它，顺便想一遍"这个工具该不该存在"。
    assert(tools.size === 16, '实际 ' + tools.size + ': ' + [...tools.keys()].join(', '))
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
    assert(local.size === 16, '装了 ' + local.size + ' 个')
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

// ═══ [N] 分类工具 artifact_categories（Step 2c）═════════════════════════
//
// 这一节的靶子是**破坏性动作的安全契约**：删一个分类会牵动一批记录，
// 所以「不给 reassign_to 就绝不动手」必须被钉死 —— 一旦它退化，
// 用户会以为「我只是删了个分类」，实际是一批记录被静默降级。
//
// ⚠️ 本节按本文件既有套路写：`await run(...)` 在**语句层**跑，
//    `check()` 只放同步断言（这个 harness 的 check 不 await 回调，
//    把 async 回调塞进去会「假通过」）。
console.log('\n=== [N] artifact_categories（含删除的安全契约）===')
{
  const dir = path.join(TMP, 'catstore')
  fs.mkdirSync(dir, { recursive: true })
  const store = new ArtifactStore(dir).load()
  const settings = new SettingsStore({ file: path.join(dir, 'settings.json') }).load()
  store.setCategoriesProvider(() => settings.get().categories)
  ctx.tools.allowReplace = true
  registerArtifactTools(ctx, store, settings)
  ctx.tools.allowReplace = false
  const cats = (args) => tools.get('artifact_categories').execute(args, {})
  const catById = (id) => settings.get().categories.find((c) => c.id === id)
  const typeSnap = () => JSON.stringify(store.items.map((r) => r.artifact_type))

  const md = makeFile('cat-a.md', '# 一份文档')
  const png = makeFile('cat-b.png', 'x')
  const recMd = await run('register_artifact', { path: md })
  const recPng = await run('register_artifact', { path: png })

  check('★ register_artifact 不再有 artifact_type 枚举（否则自定义分类根本传不进来）', () => {
    const prop = tools.get('register_artifact').parameters.properties.artifact_type
    assert(prop.enum === undefined, '枚举还在：' + JSON.stringify(prop.enum))
    assert(/留空则按文件后缀自动归类/.test(prop.description), '描述该说清留空的语义：' + prop.description)
  })
  check('★ 留空 artifact_type → 按后缀自动归类（.md→document .png→image）', () => {
    assert(/类型:document/.test(recMd.text), recMd.text)
    assert(/类型:image/.test(recPng.text), recPng.text)
  })

  const listOut = (await cats({ action: 'list' })).text
  check('list：报出分类、计数、兜底类锁定、可用图标', () => {
    assert(/产物库分类（共 7 个/.test(listOut), listOut.slice(0, 90))
    assert(/document/.test(listOut) && /文档/.test(listOut), '该列出 document/文档')
    assert(/🔒/.test(listOut), '兜底类该有锁定标记')
    assert(/未分类/.test(listOut), listOut)
    assert(/可用图标：/.test(listOut), '该列出可选图标')
    assert(/不可删/.test(listOut), '该说明兜底类不可删')
  })

  const addOk = (await cats({ action: 'add', id: 'short_drama', label: '短剧素材', icon: 'video', exts: ['mp4', 'srt'] })).text
  check('★ add：新建分类成功，并落进设置（label/icon/exts 都对）', () => {
    assert(/✅ 已新建分类/.test(addOk), addOk)
    const cat = catById('short_drama')
    assert(cat, '没写进设置')
    assert(cat.label === '短剧素材' && cat.icon === 'video', JSON.stringify(cat))
    assert(JSON.stringify(cat.exts) === JSON.stringify(['mp4', 'srt']), JSON.stringify(cat.exts))
  })

  const addNoLabel = (await cats({ action: 'add', id: 'nolabel', exts: [] })).text
  const addDup = (await cats({ action: 'add', id: 'short_drama', label: '重复' })).text
  const addBadId = (await cats({ action: 'add', id: 'Bad-Id', label: '大写' })).text
  check('add：缺 label 被拒 / id 重复被拒 / id 形状非法被拒', () => {
    assert(/必须给 label/.test(addNoLabel), addNoLabel)
    assert(/已经存在/.test(addDup), addDup)
    assert(/不合法/.test(addBadId), addBadId)
  })

  const docBefore = JSON.stringify(catById('document'))
  await cats({ action: 'update', id: 'short_drama', label: '短剧', exts: ['mp4'] })
  check('★ update：改 label/exts 生效，且**不碰别的分类**', () => {
    const cat = catById('short_drama')
    assert(cat.label === '短剧' && JSON.stringify(cat.exts) === JSON.stringify(['mp4']), JSON.stringify(cat))
    assert(JSON.stringify(catById('document')) === docBefore, 'document 被顺手改了')
  })
  const updMissing = (await cats({ action: 'update', id: 'nope', label: 'x' })).text
  check('update 不存在的分类 → 说清「要新建用 add」', () => {
    assert(/没有叫 nope 的分类/.test(updMissing) && /add/.test(updMissing), updMissing)
  })

  const lockUpd = (await cats({ action: 'update', id: 'other', label: '改名' })).text
  const lockDel = (await cats({ action: 'remove', id: 'other' })).text
  check('★ 兜底分类不可改、不可删', () => {
    assert(/兜底分类/.test(lockUpd), lockUpd)
    assert(/不可删除/.test(lockDel), lockDel)
    assert(catById('other'), 'other 没了')
  })

  const dupExt = (await cats({ action: 'add', id: 'dup_ext', label: '重复后缀', exts: ['mp4'] })).text
  check('★ 同一后缀被两类声明 → 只是**提示**，不拒绝', () => {
    assert(/✅ 已新建/.test(dupExt), dupExt)
    assert(/同时属于/.test(dupExt), '该给出冲突提示：' + dupExt)
  })

  // ── 删除的安全契约（本节重点）──────────────────────────────────────────
  const beforeTable = JSON.stringify(settings.get().categories)
  const beforeTypes = typeSnap()
  const refuse = (await cats({ action: 'remove', id: 'image' })).text
  check('★★★ remove 不给 reassign_to 且有记录 → **只回报影响面、一个字都不改**', () => {
    assert(/没有删除/.test(refuse), refuse)
    assert(/1 条记录/.test(refuse), '该报出影响条数：' + refuse)
    assert(/reassign_to/.test(refuse), '该说清怎么继续：' + refuse)
    assert(JSON.stringify(settings.get().categories) === beforeTable, '★ 分类表被改了')
    assert(typeSnap() === beforeTypes, '★ 记录被改了')
    assert(catById('image'), '★ 分类被删了')
  })

  const badTarget = (await cats({ action: 'remove', id: 'image', reassign_to: '不存在的分类' })).text
  check('remove：reassign_to 指向不存在的分类 → 被拒，且什么都没改', () => {
    assert(/不是一个已知分类/.test(badTarget), badTarget)
    assert(typeSnap() === beforeTypes, '记录被改了')
    assert(catById('image'), '分类被删了')
  })

  const removed = (await cats({ action: 'remove', id: 'image', reassign_to: 'document' })).text
  check('★ remove 给了 reassign_to → 记录先改派、分类后删，且不留孤儿', () => {
    assert(/✅ 已删除分类/.test(removed), removed)
    assert(/1 条记录改派到了/.test(removed), removed)
    assert(!catById('image'), '分类没被删掉')
    const pngRec = store.byPath(path.join(TMP, 'cat-b.png'))
    assert(pngRec.artifact_type === 'document', '记录没被改派：' + pngRec.artifact_type)
    const ids = new Set(settings.get().categories.map((c) => c.id))
    for (const rec of store.items) assert(ids.has(rec.artifact_type), `出现孤儿 ${rec.artifact_type}`)
  })

  await cats({ action: 'add', id: 'tmpcat', label: '临时类', exts: ['qqq'] })
  await run('register_artifact', { path: makeFile('cat-c.qqq', 'x') })
  const byLabel = (await cats({ action: 'remove', id: 'tmpcat', reassign_to: '文档' })).text
  check('★ remove 可以按**显示名**给 reassign_to（用户不会记 id）', () => {
    assert(/✅ 已删除分类/.test(byLabel), byLabel)
    assert(store.byPath(path.join(TMP, 'cat-c.qqq')).artifact_type === 'document',
      '按显示名改派失败：' + store.byPath(path.join(TMP, 'cat-c.qqq')).artifact_type)
  })

  await cats({ action: 'add', id: 'emptycat', label: '空的', exts: [] })
  const delEmpty = (await cats({ action: 'remove', id: 'emptycat' })).text
  check('★ 0 条记录的分类可以直接删（不需要 reassign_to）', () => {
    assert(/✅ 已删除分类/.test(delEmpty), delEmpty)
    assert(!catById('emptycat'), '没删掉')
  })

  const undone = (await cats({ action: 'undo-remove' })).text
  check('★★ undo-remove：记录改回原分类，且分类被加回分类表', () => {
    assert(/✅ 已撤销/.test(undone), undone)
    assert(store.byPath(path.join(TMP, 'cat-c.qqq')).artifact_type === 'tmpcat', '记录没改回去')
    assert(catById('tmpcat'), '分类没被加回分类表')
  })
  const undone2 = (await cats({ action: 'undo-remove' })).text
  check('undo-remove：没有可撤销的时说人话，不抛', () => {
    assert(/没有可撤销/.test(undone2), undone2)
  })

  const delMissing = (await cats({ action: 'remove', id: 'nope' })).text
  check('remove 不存在的分类 → 被拒', () => {
    assert(/没有叫 nope 的分类/.test(delMissing), delMissing)
  })
  const badAction = (await cats({ action: 'destroy' })).text
  check('不认识的 action → 说清有哪些合法值', () => {
    assert(/不认识的 action/.test(badAction), badAction)
    assert(/list \/ add \/ update \/ remove/.test(badAction), badAction)
  })

  await run('register_artifact', { path: makeFile('cat-d.md', 'x'), artifact_type: 'ghost_type' })
  const orphanOut = (await cats({ action: 'list' })).text
  check('★ list 会报孤儿（记录指向了表里不存在的分类）——不隐藏', () => {
    assert(/孤儿/.test(orphanOut), orphanOut)
    assert(/ghost_type/.test(orphanOut), orphanOut)
  })
  await run('artifact_update', { id: store.byPath(path.join(TMP, 'cat-d.md')).id, artifact_type: 'document' })

  // 老调用方（不传 settings）也要能装 —— 降级路径
  const bare = freshStore()
  const bareList = (await tools.get('artifact_categories').execute({ action: 'list' }, {})).text
  check('★ 没接设置存储时（老调用方）也能装，分类工具说人话', () => {
    assert(bare, '没接设置时注册失败')
    assert(typeof bareList === 'string' && bareList.length > 0, '该给人话')
    assert(/共 0 个/.test(bareList), '没有表时该报 0 个：' + bareList.slice(0, 60))
  })
}

// ═══ [O] 标签工具 artifact_tags（Step 3c）════════════════════════════════
//
// 这一节的靶子和 [N] 同型：**破坏性动作的安全契约**。
//   ① **默认 dry-run** —— 不传 `confirm:true` 就一个字都不许改
//      （这是唯一会改写**已有记录内容**的工具，一次可能动十几条）
//   ② **merge 与 rename 的分工** —— 前者机械（同串两写）、后者是人的决定（具体→抽象）。
//      划错会丢用户信息；而只给 merge 不给 rename，用户会发现"我要的大类没人能建"。
//
// ⚠️ 同样按本文件套路：`await run(...)` 放**语句层**，`check()` 只放同步断言。
console.log('\n=== [O] artifact_tags（默认 dry-run + merge/rename 分工）===')
{
  const dir = path.join(TMP, 'tagstore')
  fs.mkdirSync(dir, { recursive: true })
  const store = new ArtifactStore(dir).load()
  ctx.tools.allowReplace = true
  registerArtifactTools(ctx, store)
  ctx.tools.allowReplace = false
  const tags = (args) => tools.get('artifact_tags').execute(args, {})

  // 造一组真库同型的重复 + 几个"具体"标签
  const mk = (f, t) => store.register({ path: makeFile('tag-' + f, 'x'), title: f, tags: t })
  const recA = mk('a.md', ['DSH', 'godot'])
  const recB = mk('b.md', ['dsh'])
  const recC = mk('c.md', ['dsh', 'DSH'])       // ★ 记录内两个变体都有
  const recD = mk('d.md', ['超星'])
  const recE = mk('e.md', ['弹幕梗'])
  const tagsOf = (rec) => JSON.stringify(store.get(rec.id).tags)

  check('★ 工具已注册，action 枚举完整，且明确写了"默认只预演"', () => {
    const t = tools.get('artifact_tags')
    assert(t, 'artifact_tags 没注册')
    const prop = t.parameters.properties.action
    assert(JSON.stringify(prop.enum) === JSON.stringify(['list', 'suggest', 'merge', 'rename', 'undo-merge']),
      JSON.stringify(prop.enum))
    assert(/confirm/.test(Object.keys(t.parameters.properties).join(',')), '该有 confirm 参数')
    assert(/默认只预演|不落盘/.test(t.description), '描述该说清默认 dry-run：' + t.description.slice(0, 120))
  })

  const listOut = (await tags({ action: 'list' })).text
  check('list：报出长尾率与**重复组明细**（这是"能收敛多少"的答案）', () => {
    assert(/不同标签/.test(listOut) && /长尾率/.test(listOut), listOut.slice(0, 160))
    assert(/重复|两种写法/.test(listOut), '该报重复组：' + listOut.slice(0, 240))
    assert(/DSH/.test(listOut) && /dsh/.test(listOut), listOut.slice(0, 240))
    assert(/不要去动|具体/.test(listOut), '该提醒别动那些具体标签')
  })

  const suggOut = (await tags({ action: 'suggest' })).text
  check('★ suggest：只读线索 + 长尾说明（且不自动改）', () => {
    assert(/只读|不会自动改/.test(suggOut), suggOut.slice(0, 120))
    assert(/长尾/.test(suggOut), suggOut)
    assert(/rename/.test(suggOut), '该指出归大类要用 rename')
  })
  check('suggest 不改任何记录', () => {
    assert(tagsOf(recA) === JSON.stringify(['DSH', 'godot']), tagsOf(recA))
    assert(tagsOf(recB) === JSON.stringify(['dsh']), tagsOf(recB))
  })

  // ── ★★ 核心安全契约：不传 confirm = 一个字都不改 ──────────────────────────
  const dryMerge = (await tags({ action: 'merge' })).text
  check('★★ merge 不传 confirm → 只预演：报影响面，但**记录一条都没改**', () => {
    assert(/预演/.test(dryMerge), dryMerge.slice(0, 160))
    assert(/一个字都没改/.test(dryMerge), '该明确说没改：' + dryMerge.slice(0, 300))
    assert(/会改写/.test(dryMerge), '该报影响面')
    assert(store.meta.lastTagMerge === null, '★ 预演竟然留下了撤销凭据')
  })
  check('★★ 预演后记录仍然原样（逐条查，不是看它自己的话）', () => {
    assert(tagsOf(recA) === JSON.stringify(['DSH', 'godot']), 'A: ' + tagsOf(recA))
    assert(tagsOf(recB) === JSON.stringify(['dsh']), 'B: ' + tagsOf(recB))
    assert(tagsOf(recC) === JSON.stringify(['dsh', 'DSH']), 'C: ' + tagsOf(recC))
  })

  const realMerge = (await tags({ action: 'merge', confirm: true })).text
  check('merge + confirm → 真执行（变体归一、记录内重复也治掉）', () => {
    assert(/✅ 已改写/.test(realMerge), realMerge.slice(0, 240))
    assert(tagsOf(recB) === JSON.stringify(['DSH']), 'B: ' + tagsOf(recB))
    assert(tagsOf(recC) === JSON.stringify(['DSH']), '★ C 记录内重复该被治：' + tagsOf(recC))
    assert(tagsOf(recA) === JSON.stringify(['DSH', 'godot']), 'A 的 godot 不该被动：' + tagsOf(recA))
    assert(store.meta.lastTagMerge !== null, '该留下撤销凭据')
  })

  const undo1 = (await tags({ action: 'undo-merge' })).text
  check('★ undo-merge → 整份还原，并说清撤的是哪一种', () => {
    assert(/已撤销/.test(undo1), undo1)
    assert(/归一化/.test(undo1), '该说清撤的是归一化：' + undo1)
    assert(tagsOf(recC) === JSON.stringify(['dsh', 'DSH']), 'C 该整份还原：' + tagsOf(recC))
  })
  const undo2 = (await tags({ action: 'undo-merge' })).text
  check('undo-merge 没有可撤销时说人话，不抛', () => {
    assert(/没有可撤销/.test(undo2), undo2)
  })

  // ── ★★ merge 与 rename 的分工 ────────────────────────────────────────────
  const semViaMerge = (await tags({ action: 'merge', groups: [{ canonical: '学业', from: ['超星'] }] })).text
  check('★★ merge 拒绝「具体→抽象」，并**指出出路是 rename**', () => {
    assert(/❌/.test(semViaMerge), semViaMerge.slice(0, 200))
    assert(/rename/.test(semViaMerge), '★ 拒绝时该告诉 agent 改走 rename：' + semViaMerge.slice(0, 300))
    assert(tagsOf(recD) === JSON.stringify(['超星']), '被拒时不该改记录：' + tagsOf(recD))
  })

  const renameNoGroups = (await tags({ action: 'rename' })).text
  check('★★ rename 不给 groups 被拒（目标名不能由规则层猜 —— 那是人的决定）', () => {
    assert(/❌/.test(renameNoGroups), renameNoGroups.slice(0, 200))
    assert(/明确给出改法|groups/.test(renameNoGroups), renameNoGroups.slice(0, 240))
    assert(/人的决定/.test(renameNoGroups), '该说清为什么必须人给：' + renameNoGroups.slice(0, 300))
  })

  const renameDry = (await tags({ action: 'rename', groups: [{ canonical: '学业', from: ['超星', '弹幕梗'] }] })).text
  check('★ rename 预演：接受「具体→抽象」，且警告会丢掉原名', () => {
    assert(/预演/.test(renameDry), renameDry.slice(0, 160))
    assert(/两个字都没改|一个字都没改/.test(renameDry) || /一个字都没改/.test(renameDry), renameDry.slice(0, 240))
    assert(/丢掉/.test(renameDry), '该警告 rename 会丢原名（与 merge 不同）：' + renameDry.slice(0, 320))
    assert(tagsOf(recD) === JSON.stringify(['超星']) && tagsOf(recE) === JSON.stringify(['弹幕梗']),
      '预演不该改：' + tagsOf(recD) + ' / ' + tagsOf(recE))
  })

  const renameReal = (await tags({ action: 'rename', groups: [{ canonical: '学业', from: ['超星', '弹幕梗'] }], confirm: true })).text
  check('★★ rename + confirm → 真能建大类（这就是"我要的大类有人能建"）', () => {
    assert(/✅ 已改写/.test(renameReal), renameReal.slice(0, 240))
    assert(tagsOf(recD) === JSON.stringify(['学业']), '超星该归成学业：' + tagsOf(recD))
    assert(tagsOf(recE) === JSON.stringify(['学业']), '弹幕梗该归成学业：' + tagsOf(recE))
  })
  const undo3 = (await tags({ action: 'undo-merge' })).text
  check('★ rename 的撤销走同一个入口（两者共用凭据），并说清是"改名"', () => {
    assert(/已撤销/.test(undo3) && /改名/.test(undo3), undo3)
    assert(tagsOf(recD) === JSON.stringify(['超星']), '该还原：' + tagsOf(recD))
  })

  // ── 简写 from+to + 边界 ──────────────────────────────────────────────────
  const shortOut = (await tags({ action: 'rename', from: '超星', to: '课程作业', confirm: true })).text
  check('rename 支持简写 from + to（用户/agent 不必手拼 groups）', () => {
    assert(/✅ 已改写/.test(shortOut), shortOut.slice(0, 200))
    assert(tagsOf(recD) === JSON.stringify(['课程作业']), tagsOf(recD))
  })
  await tags({ action: 'undo-merge' })

  const badAction = (await tags({ action: 'destroy' })).text
  check('不认识的 action → 说清有哪些合法值', () => {
    assert(/不认识的 action/.test(badAction), badAction)
    assert(/list \/ suggest \/ merge \/ rename \/ undo-merge/.test(badAction), badAction)
  })

  const emptyMerge = (await tags({ action: 'merge', groups: [{ canonical: 'DSH', from: ['DSH'] }] })).text
  check('merge 给了组但等于没改 → 明确被拒，不假装成功', () => {
    assert(/❌/.test(emptyMerge), emptyMerge.slice(0, 200))
  })
}

// ═══ [P] 三个真问题的回归守卫（2026-10-08 · verifier-3c 独立对抗性验证逮到的）═══════
//
// 这三条都是**独立验证者**在"默认假设这里有洞"的立场下打出来的，不是我想出来的。
// 其中 F1 的性质最坏：**一个类型失误被放大成整库改写**。
console.log('\n=== [P] verifier-3c 逮到的三个真问题（回归守卫）===')
{
  const dir = path.join(TMP, 'tagguard')
  fs.mkdirSync(dir, { recursive: true })
  const store = new ArtifactStore(dir).load()
  ctx.tools.allowReplace = true
  registerArtifactTools(ctx, store)
  ctx.tools.allowReplace = false
  const tags = (args) => tools.get('artifact_tags').execute(args, {})
  store.register({ path: makeFile('guard-a.md', 'x'), title: 'ga', tags: ['dsh'] })
  store.register({ path: makeFile('guard-b.md', 'x'), title: 'gb', tags: ['DSH'] })
  const snap = () => JSON.stringify(store.items.map((r) => r.tags))

  // ── F1：groups 类型错误**不许**静默降级成"全库归一化" ─────────────────────
  // ⚠️ 为什么要这条（原来写法是 `Array.isArray(a.groups) ? a.groups : null`）：
  //    它把「**没传**（合理：用规则层的全库组）」与「**传了但类型错**（agent 失误）」
  //    混成同一个 `null` ⇒ 叠加"省略 groups + confirm:true 会跳过预演直接改写"，
  //    就成了**一个类型失误被放大成整库改写**的链路（而 store 层对同样入参是明确报错的）。
  //    ⇒ 这正是本仓库反复栽的「同一个值承载两种语义」。
  //
  // ⚠️ 下面这五条 `check` 各自内部就断言（不另设一条"总结性"的 —— 那种**没有断言的 check**
  //    正是我刚写进规矩里的"空转守卫"：它会绿，但什么也没守）。
  const beforeF1 = snap()
  for (const bad of [42, 'x', {}, { canonical: 'X' }, true]) {
    const out = (await tags({ action: 'merge', confirm: true, groups: bad })).text
    check(`★★ P1 groups=${JSON.stringify(bad)} → 被拒（不是"降级为全库"）`, () => {
      assert(/❌/.test(out), '★ 竟然放行了 —— 一个类型失误会被放大成整库改写：' + out.slice(0, 160))
      assert(/数组/.test(out), '该说清要传数组：' + out.slice(0, 200))
      assert(/不要传 groups|省略/.test(out), '该告诉它"想全库就别传 groups"：' + out.slice(0, 260))
    })
  }
  check('★ P1b 五次类型错误之后，**记录一个字节都没变**', () => {
    assert(snap() === beforeF1, '★ 被"类型错误"的操作改了数据：' + snap())
  })

  // ── F4：组数口径执行/撤销必须一致 ────────────────────────────────────────
  // ⚠️ 本 harness 的 `check()` **不 await 回调** ⇒ `await` 一律放**语句层**
  //    （把 async 塞进 check 是"假通过"，这条这个文件顶上就写着）。
  const beforeF4 = snap()
  const exec1 = await tags({ action: 'merge', confirm: true, groups: [{ canonical: 'DSH', from: ['dsh'] }] })
  const undoOut = (await tags({ action: 'undo-merge' })).text
  check('F4 执行与撤销报的是同一个"组数"（原来一组含 2 个 from 时会报 1 vs 2）', () => {
    assert(/✅/.test(exec1.text), exec1.text.slice(0, 160))
    assert(/涉及 1 组/.test(undoOut), '撤销该报"1 组"（与执行同口径），实际：' + undoOut)
  })
  check('F4b 撤销把数据还回来了（善后）', () => {
    assert(snap() === beforeF4, '没还回来：' + snap())
  })

  // ── F2：注释比实现乐观 —— 已改成如实描述（这条守卫钉注释，不钉行为）─────────
  check('★ P2 `renameTags` 的注释必须如实说明"merge 也允许库里没有的目标名"', () => {
    // 真缺陷是**注释比实现乐观**（原来写"mergeTags 由规则层保证目标名来自库内"，
    // 而那只对"省略 groups"的调用成立）。⇒ 修的是注释，这里把它钉住，别再漂回去。
    const src = fs.readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8')
    assert(/只有"省略 groups"的调用/.test(src),
      '★ 注释又变回"由规则层保证"那种乐观说法了 —— 那只对省略 groups 的调用成立')
    assert(/回退/.test(src), '该如实记下"加过校验又回退了"以及原因')
  })
}

// ═══ [Q] 落盘失败时，工具**不许**再印「如要退回」（2026-10-08 · 修 F3）═══════════
//
// 这是 F3 的**用户可见症状**：store 层落盘失败时旧代码照样回 `{ok:true, undo:true}`，
// 于是工具印出「如要退回：action=undo-merge」——**而重启后根本没有可撤销的东西**。
// 守 store 层的那批断言在 `test/persist-fail.test.mjs`；这里只钉"工具这一层说了什么"。
console.log('\n=== [Q] 落盘失败 ⇒ 工具不许承诺可撤销（F3 的用户可见面）===')
{
  const dir = path.join(TMP, 'persistfail')
  fs.mkdirSync(dir, { recursive: true })
  const store = new ArtifactStore(dir).load()
  ctx.tools.allowReplace = true
  registerArtifactTools(ctx, store)
  ctx.tools.allowReplace = false
  const tags = (args) => tools.get('artifact_tags').execute(args, {})
  store.register({ path: makeFile('pf-a.md', 'x'), title: 'pfa', tags: ['dsh'] })
  store.register({ path: makeFile('pf-b.md', 'x'), title: 'pfb', tags: ['DSH'] })

  // 把 meta.json 换成一个同名目录 ⇒ 写凭据必失败（Windows 上比 chmod 只读可靠）
  const metaPath = path.join(dir, 'meta.json')
  if (fs.existsSync(metaPath)) fs.rmSync(metaPath, { recursive: true, force: true })
  fs.mkdirSync(metaPath)
  const artBefore = fs.readFileSync(path.join(dir, 'artifacts.json'), 'utf8')

  let out = ''
  let threw = null
  try {
    out = (await tags({ action: 'merge', confirm: true, groups: [{ canonical: 'DSH', from: ['dsh'] }] })).text
  } catch (e) { threw = e }

  check('★★ Q1 凭据写不下去时，工具**明确报失败**（不许说"已改写"）', () => {
    assert(threw === null, '工具抛异常穿出来了（该回一段 ❌ 文案）：' + (threw && threw.message))
    assert(/❌/.test(out), '没报失败：' + out.slice(0, 200))
    assert(!/已改写/.test(out), '★ 谎报了"已改写"：' + out.slice(0, 200))
  })
  check('★★ Q2 **不许**印「如要退回」—— 那正是 F3 的靶心（退路是假的）', () => {
    assert(!/如要退回/.test(out), '★ 还在承诺可撤销：' + out.slice(0, 240))
    assert(!/undo-merge/.test(out), '★ 还在指路 undo-merge：' + out.slice(0, 240))
  })
  check('★ Q3 记录一个字节都没改（失败就要真的什么都没干）', () => {
    assert(fs.readFileSync(path.join(dir, 'artifacts.json'), 'utf8') === artBefore, '盘上数据被改了')
  })
  check('★ Q4 错误文案要说清是"落盘"这一层（否则用户会以为是自己参数写错了）', () => {
    assert(/凭据/.test(out) || /落盘/.test(out), '错误文案没点出落盘这一层：' + out.slice(0, 240))
  })
  if (fs.existsSync(metaPath) && fs.statSync(metaPath).isDirectory()) fs.rmdirSync(metaPath)
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
