/**
 * 离线 harness：采集（现状守卫 + A 类 present + 防重复登记）
 *
 * 这个文件锁住三件事：
 *   1. **没有「全盘扫描」这条采集路径** —— 源码守卫，防止将来有人加回来（噪声会淹没信号）
 *   2. **A 类 `deliverables/presented` 真的接上了**（官方 present 工具声明的交付物）
 *   3. **防重复登记** —— 实测 233 条里只有 201 个唯一路径（13.7% 冗余，最严重一个路径 10 条）
 *
 * 用法：node test/collect-convergence.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArtifactStore } from '../lib/store.js'
import { attachAutoCollect } from '../lib/autocollect.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-collect-'))
let seq = 0
function freshStore() {
  const dir = path.join(TMP, 'store' + (seq += 1))
  fs.mkdirSync(dir, { recursive: true })
  return new ArtifactStore(dir).load()
}
function makeFile(name, body = 'x') {
  const p = path.join(TMP, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}
/** 假 ctx：只提供 on/logger（attachAutoCollect 用到的全部） */
function makeCtx() {
  const listeners = new Map()
  const logs = []
  return {
    logs,
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
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  }
}
function wire(store, options = {}) {
  const ctx = makeCtx()
  const off = attachAutoCollect(ctx, store, options)
  return { ctx, off }
}
const session = (id, cwd) => ({ id, header: cwd ? { cwd } : {} })
const presented = (files, turn = 1) => ({ type: 'deliverables/presented', seq: 1, data: { turn, callId: 'c1', files } })

// ═══ [1] 源码守卫：没有「全盘扫描」这条路径 ═══════════════════════════════
console.log('\n=== [1] 源码守卫（防「全盘扫描」复活）===')
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const raw = fs.readFileSync(path.join(root, 'lib', 'autocollect.js'), 'utf8')
  // ⚠️ 必须先去注释再查 —— 否则**解释「我们不扫盘」的那段注释**会把守卫自己绊倒
  //    （第一版就是这么失败的，正好说明这条守卫确实在扫「代码」而不是「文档」的边界上）
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释（含 JSDoc）
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1') // 行注释（避开 http:// 这类）
  check('★ autocollect.js 的**代码**里没有任何目录遍历（readdir / opendir / glob / walk）', () => {
    const hit = /readdir|opendir|globSync|fastGlob|walkDir|scanDir/i.exec(code)
    assert(!hit, '出现了目录遍历 ' + JSON.stringify(hit && hit[0]) + ' —— 采集不该去扫盘')
  })
  check('注释里明确写了「不扫盘」（这是给后人看的，别删）', () => {
    assert(/不\s*readdir|不遍历目录/.test(raw), '注释里的「不扫盘」说明不见了')
  })
  check('★ 采集只认三类事件：deliverables/presented 与 tool/call、turn/end', () => {
    const types = [...code.matchAll(/event\.type === '([^']+)'/g)].map((m) => m[1]).sort()
    assert(JSON.stringify(types) === JSON.stringify(['deliverables/presented', 'tool/call', 'turn/end']), '事件类型: ' + JSON.stringify(types))
  })
  check('★ source 白名单含 present（否则会被静默降级成 manual）', () => {
    const storeSrc = fs.readFileSync(path.join(root, 'lib', 'store.js'), 'utf8')
    assert(/'session', 'folder-import', 'manual', 'present'/.test(storeSrc), '白名单里没有 present')
  })
}

// ═══ [2] 防重复登记 ═══════════════════════════════════════════════════════
console.log('\n=== [2] 防重复登记 ===')
{
  const store = freshStore()
  const f = makeFile('dup/a.txt', 'hello')
  const first = store.register({ path: f, title: '我的标题', summary: '摘要', tags: ['t1'] })
  const second = store.register({ path: f, title: '被覆盖的标题' })
  check('★ 同一路径登记两次 → 只有 1 条记录', () => {
    assert(store.items.length === 1, '记录数 ' + store.items.length)
    assert(second.id === first.id, '应返回同一条记录')
    assert(second.duplicate === true && second.created === false, '应标 duplicate: ' + JSON.stringify({ d: second.duplicate, c: second.created }))
  })
  check('★ 命中已有记录时**不覆盖**用户填过的元数据', () => {
    const rec = store.items[0]
    assert(rec.title === '我的标题', '标题被覆盖了: ' + rec.title)
    assert(rec.summary === '摘要' && rec.tags.length === 1, '摘要/标签被覆盖')
    assert(first.duplicate === undefined, '首次登记不该带 duplicate 标记')
  })
  check('命中已有记录时会刷新体积/时间/存在性', () => {
    const before = store.items[0].size_bytes
    fs.writeFileSync(f, 'hello world!!')  // 变长
    const again = store.register({ path: f })
    assert(store.items.length === 1, '不该新建')
    assert(again.size_bytes === fs.statSync(f).size, 'size 没刷新: ' + again.size_bytes)
    assert(again.size_bytes !== before, 'size 应变化')
  })
  check('要「故意登记两条」可以走 allowDuplicate（口子留着）', () => {
    const n = store.items.length
    store.register({ path: f, title: '第二用途' }, { allowDuplicate: true })
    assert(store.items.length === n + 1, 'allowDuplicate 应能新建: ' + store.items.length)
  })
  check('回收站里的记录不算重复（重新登记 → 新建）', () => {
    const store2 = freshStore()
    const g = makeFile('dup/b.txt')
    const r1 = store2.register({ path: g })
    store2.trash(r1.id)
    const r2 = store2.register({ path: g })
    assert(r2.id !== r1.id, '应新建一条')
    assert(store2.items.length === 2, '记录数 ' + store2.items.length)
  })
  check('路径写法不同（C:/ vs C:\\）仍算重复', () => {
    const store3 = freshStore()
    const h = makeFile('dup/c.txt')
    const a = store3.register({ path: h })
    const b = store3.register({ path: h.replace(/\\/g, '/') })
    assert(a.id === b.id && store3.items.length === 1, '分隔符归一化后应命中同一条')
  })
  check('敏感路径照样被拒（dedupe 没有绕过安全闸门）', () => {
    const store4 = freshStore()
    let threw = false
    try { store4.register({ path: path.join(TMP, '.ssh', 'id_rsa') }) } catch { threw = true }
    assert(threw, '敏感路径应抛错')
    assert(store4.items.length === 0, '不该入库')
  })
  check('★ 不碰已有记录：登记新路径时旧记录一模一样', () => {
    const store5 = freshStore()
    const a = makeFile('keep/a.txt')
    const b = makeFile('keep/b.txt')
    const ra = store5.register({ path: a, title: 'A' })
    const snapshot = JSON.stringify(store5.items[0])
    store5.register({ path: b, title: 'B' })
    assert(store5.items.length === 2, '应新增一条')
    assert(JSON.stringify(store5.items.find((r) => r.id === ra.id)) === snapshot, '旧记录被改动了')
  })
}

// ═══ [3] A 类：deliverables/presented ════════════════════════════════════
console.log('\n=== [3] A 类 present 声明 ===')
{
  const store = freshStore()
  const { ctx } = wire(store)
  const cwd = path.join(TMP, 'ws')
  fs.mkdirSync(cwd, { recursive: true })
  const abs = makeFile('ws/交付物.md', '# hi')

  ctx.emit('session/event', session('s-present', cwd), presented([{ path: abs, description: '这是最终交付物' }]))
  check('★ 绝对路径的 present 声明 → 登记为 source=present', () => {
    assert(store.items.length === 1, '记录数 ' + store.items.length)
    const rec = store.items[0]
    assert(rec.source === 'present', 'source: ' + rec.source)
    assert(rec.kind === 'deliverable', 'kind: ' + rec.kind)
    assert(rec.path === path.normalize(abs), 'path: ' + rec.path)
    assert(rec.session_id === 's-present', 'session_id: ' + rec.session_id)
  })
  check('description 落在 notes（不污染 tags）', () => {
    assert(store.items[0].notes === '这是最终交付物', 'notes: ' + store.items[0].notes)
    assert(store.items[0].tags.length === 0, 'tags: ' + JSON.stringify(store.items[0].tags))
  })

  const rel = makeFile('ws/相对路径.png')
  ctx.emit('session/event', session('s-present', cwd), presented([{ path: '相对路径.png' }]))
  check('★ 相对路径按会话工作目录解析成绝对路径', () => {
    const hit = store.items.find((r) => r.path === path.normalize(rel))
    assert(!!hit, '没登记: ' + JSON.stringify(store.items.map((r) => r.path)))
    assert(hit.source === 'present', 'source: ' + hit.source)
  })

  const n = store.items.length
  ctx.emit('session/event', session('s-present', ''), presented([{ path: '没有cwd的相对路径.md' }]))
  check('没有 cwd 的相对路径 → 跳过（绝不猜工作目录）', () => {
    assert(store.items.length === n, '不该登记: ' + store.items.length)
  })

  ctx.emit('session/event', session('s-present', cwd), presented([{ path: path.join(cwd, '不存在.md') }]))
  check('文件不存在 → 跳过', () => { assert(store.items.length === n, '记录数 ' + store.items.length) })

  const dir = path.join(cwd, '一个目录')
  fs.mkdirSync(dir, { recursive: true })
  ctx.emit('session/event', session('s-present', cwd), presented([{ path: dir }]))
  check('目录 → 跳过', () => { assert(store.items.length === n, '记录数 ' + store.items.length) })

  ctx.emit('session/event', session('s-present', cwd), presented([{ path: abs }]))
  check('同一文件再次 present → 不重复登记', () => { assert(store.items.length === n, '记录数 ' + store.items.length) })

  ctx.emit('session/event', session('s-present', cwd), presented([{ path: '' }, { path: '   ' }]))
  check('空路径 → 跳过（不抛）', () => { assert(store.items.length === n, '记录数 ' + store.items.length) })

  ctx.emit('session/event', session('s-present', cwd), { type: 'deliverables/presented', seq: 2, data: {} })
  check('data.files 缺失 → 跳过（不抛）', () => { assert(store.items.length === n, '记录数 ' + store.items.length) })

  const store2 = freshStore()
  store2.meta.autoCollect = false
  const w2 = wire(store2)
  w2.ctx.emit('session/event', session('s-off', cwd), presented([{ path: abs }]))
  check('★ autoCollect=false → present 也不采（尊重用户开关）', () => {
    assert(store2.items.length === 0, '记录数 ' + store2.items.length)
  })

  const store3 = freshStore()
  const w3 = wire(store3, { maxPerTurn: 2 })
  const many = [1, 2, 3, 4, 5].map((i) => ({ path: makeFile(`ws/many${i}.md`) }))
  w3.ctx.emit('session/event', session('s-many', cwd), presented(many))
  check('maxPerTurn 上限生效（5 条只收 2 条）', () => {
    assert(store3.items.length === 2, '记录数 ' + store3.items.length)
  })
}

// ═══ [4] B 类没被破坏 + 时序（present 优先）═══════════════════════════════
console.log('\n=== [4] B 类回归与时序 ===')
{
  const store = freshStore()
  const { ctx } = wire(store)
  const cwd = path.join(TMP, 'ws2')
  fs.mkdirSync(cwd, { recursive: true })
  const p = makeFile('ws2/写出来的.txt', 'v1')

  ctx.emit('session/event', session('s-b', cwd), { type: 'tool/call', seq: 1, data: { name: 'write', arguments: JSON.stringify({ path: p, content: 'v1' }) } })
  ctx.emit('session/event', session('s-b', cwd), { type: 'turn/end', seq: 2, data: { turn: 1 } })
  check('★ B 类（变更工具）仍照常登记，source=session', () => {
    assert(store.items.length === 1, '记录数 ' + store.items.length)
    assert(store.items[0].source === 'session', 'source: ' + store.items[0].source)
    assert(store.items[0].session_id === 's-b', 'session_id: ' + store.items[0].session_id)
  })
  check('只读类工具不会被采集', () => {
    const before = store.items.length
    ctx.emit('session/event', session('s-b', cwd), { type: 'tool/call', seq: 3, data: { name: 'read', arguments: JSON.stringify({ path: p }) } })
    ctx.emit('session/event', session('s-b', cwd), { type: 'turn/end', seq: 4, data: { turn: 2 } })
    assert(store.items.length === before, '记录数 ' + store.items.length)
  })

  // 时序：同一回合里 present 先到（tools/result 时追加），turn/end 后到
  const store4 = freshStore()
  const w4 = wire(store4)
  const q = makeFile('ws2/既写又声明.md', 'v1')
  w4.ctx.emit('session/event', session('s-order', cwd), { type: 'tool/call', seq: 1, data: { name: 'write', arguments: JSON.stringify({ path: q, content: 'v1' }) } })
  w4.ctx.emit('session/event', session('s-order', cwd), presented([{ path: q }], 1))
  w4.ctx.emit('session/event', session('s-order', cwd), { type: 'turn/end', seq: 3, data: { turn: 1 } })
  check('★ 时序：present 先落库 → turn/end 只刷新，不降级成 session', () => {
    const hits = store4.items.filter((r) => r.path === path.normalize(q))
    assert(hits.length === 1, '记录数 ' + hits.length)
    assert(hits[0].source === 'present', 'source 应为 present，得到 ' + hits[0].source)
  })
}

// ═══ [5] 端到端：新建文件不出现在产物库（除非 agent 动过或用户登记）══════
console.log('\n=== [5] 「新建文件不会凭空变成产物」===')
{
  const store = freshStore()
  const { ctx } = wire(store)
  const cwd = path.join(TMP, 'ws3')
  fs.mkdirSync(cwd, { recursive: true })

  // 模拟：别的进程（不是 agent 工具）在范围内写了一个文件
  const outsider = makeFile('ws3/别的程序写的.log', 'noise')
  ctx.emit('session/event', session('s-x', cwd), { type: 'turn/end', seq: 1, data: { turn: 1 } })
  check('★ 没有工具调用、没有 present、没有用户登记 → 不进产物库', () => {
    assert(store.items.length === 0, '不该有任何记录: ' + JSON.stringify(store.items.map((r) => r.path)))
  })

  // 用户主动登记同一个文件 → 应该成功
  const rec = store.register({ path: outsider, title: '用户自己登记的' })
  check('★ 用户主动登记同一个文件 → 成功（替代路径在）', () => {
    assert(store.items.length === 1, '记录数 ' + store.items.length)
    assert(rec.source === 'manual' && rec.title === '用户自己登记的', JSON.stringify({ s: rec.source, t: rec.title }))
  })
  check('登记之后它的 source 仍是 manual（不会被采集器改写）', () => {
    ctx.emit('session/event', session('s-x', cwd), { type: 'turn/end', seq: 2, data: { turn: 2 } })
    assert(store.items[0].source === 'manual', 'source: ' + store.items[0].source)
    assert(store.items.length === 1, '记录数 ' + store.items.length)
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
