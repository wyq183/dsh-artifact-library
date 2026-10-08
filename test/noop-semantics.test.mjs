/**
 * 「没事可做」≠「失败」——`ok:false` 双语义的**专职守卫**（离线 harness）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个文件守的是什么（2026-10-08）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `store.rewriteTags`（`mergeTags` / `renameTags` 的共用引擎）原先有**四种**结局
 * 挤在同一个 `ok:false` 里：
 *
 *   ① 没给 groups            → **调用方**的错（该补参数）
 *   ② 给了但不合法           → **参数**的错（拼错 / 跨语义 / 串链）
 *   ③ **没有任何记录命中**   → 🔴 **根本不是错**（请求合法，终态已成立）
 *   ④ 落盘失败               → **磁盘**的错（F3 那个）
 *
 * ③ 被塞进失败通道的后果是**一句假话**：工具层照 `!ok` 一判，把
 * 「你要的终态已经成立了」印成 **`❌ 不能这样归一化`** —— agent 会去改一个没坏的东西。
 *
 * 修法 = 三态（本仓库认可过的解法，同 `@` 来源注册那次 `null` → 三态）：
 *   · 改了            `{ok:true, noop:false, changed>0}`
 *   · **合法但无事可做** `{ok:true, noop:true, changed:0, reason}`
 *   · 失败            `{ok:false, kind:'bad-request'|'invalid-plan'|'persist-failed', error}`
 *
 * ⚠️ 判据：**`ok` 说的是「这次调用有没有出问题」，不是「有没有改动」。**
 *
 * ⚠️ 顺带一提：这次修的时候**两条既有守卫是把错行为当期望钉住的**
 *   （`tags.test.mjs` 的 `H15` / `K13` 断言 `ok === false`）—— 已改。
 *   **教训**：修语义类 bug 时，要预期「有守卫在替 bug 站岗」；
 *   正解是**保留它的意图、换掉它的形状**，不是删掉它。
 *
 * 用法：node test/noop-semantics.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArtifactStore } from '../lib/store.js'
import { registerArtifactTools } from '../lib/tools.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

const TMP_DIRS = []
function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-noop-'))
  TMP_DIRS.push(dir)
  return { dir, store: new ArtifactStore(dir).load() }
}
const mkRec = (store, dir, file, tags) =>
  store.register({ path: path.join(dir, file), title: file, tags })

const GROUP = (canonical, from) => [{ canonical, from }]

/* ═══ [A] store 层：三态契约 ══════════════════════════════════════════════ */
console.log('\n=== [A] store 层：`ok` 说的是「有没有出问题」，不是「有没有改动」===')

check('★ A1 **0 命中不是失败**：`ok:true` + `noop:true`（这是整个修法的地基）', () => {
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH'])
  const r = store.mergeTags({ groups: GROUP('DSH', ['dsh']) })
  assert(r.ok === true, '★ 0 命中被当成了失败 —— 那工具层就会印 ❌（一句假话）：' + JSON.stringify(r))
  assert(r.noop === true, '★ 0 命中必须是 noop 态：' + JSON.stringify(r))
  assert(r.changed === 0, 'changed 该是 0：' + JSON.stringify(r))
})

check('★ A2 noop 带 `reason` 而**不带 `error`**（字段名本身就是语义，叫 error 会诱使下一个调用方按失败处理）', () => {
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH'])
  const r = store.mergeTags({ groups: GROUP('DSH', ['dsh']) })
  assert(typeof r.reason === 'string' && r.reason.length > 0, 'noop 该给 reason：' + JSON.stringify(r))
  assert(r.error === undefined, '★ noop 不该有 error 字段：' + JSON.stringify(r))
})

check('★ A3 noop 仍要**给出 plans**（agent 得看得见「你指的那些写法现在长什么样」）', () => {
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH'])
  const r = store.renameTags({ groups: GROUP('学业', ['根本没有这个标签']) })
  assert(r.noop === true, '前置：该是 noop：' + JSON.stringify(r))
  assert(Array.isArray(r.plans) && r.plans.length === 1, 'noop 也要给 plans（否则 agent 两眼一抹黑）：' + JSON.stringify(r))
  const p = r.plans[0]
  assert(p.canonical === '学业' && Array.isArray(p.from) && Array.isArray(p.variants),
    'plans 的形状该和成功时**一样**（调用方不该按 noop 分叉去解析）：' + JSON.stringify(p))
})

check('★ A4 三种失败各带 `kind`，且**互不相同**（调用方的下一步动作完全不同）', () => {
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH'])
  const bad = store.mergeTags({ groups: [] })                       // 没给
  const invalid = store.mergeTags({ groups: GROUP('学业', ['DSH']) }) // 跨语义，闸门拒
  assert(bad.ok === false && bad.kind === 'bad-request', '① 没给 groups → bad-request：' + JSON.stringify(bad))
  assert(invalid.ok === false && invalid.kind === 'invalid-plan', '② 不合法 → invalid-plan：' + JSON.stringify(invalid))
  assert(bad.kind !== invalid.kind, '★ 两种失败的 kind 撞了 ⇒ 调用方又只能靠文案猜（回到修之前）')
  // 落盘失败那一支的 kind 由 [E] 用真注入验（这里只钉字符串，防有人改掉）
  const src = fs.readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8')
  assert(/'persist-failed'/.test(src), '③ 落盘失败该带 kind=persist-failed（见 store.js 的 persistBulkOp 调用点）')
})

check('★ A5 真的改了的时候 `noop:false`（别让 noop 变成"永远为真"的字段）', () => {
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH'])
  mkRec(store, dir, 'b.txt', ['dsh'])
  const r = store.mergeTags({ groups: GROUP('DSH', ['dsh']) })
  assert(r.ok === true && r.noop === false, '真改了却报 noop：' + JSON.stringify(r))
  assert(r.changed === 1, '该改 1 条：' + JSON.stringify(r))
})

check('★★ A6 反向对照：把「0 命中」按旧写法当失败，[A1] 的判据**必须**能分辨', () => {
  // 旧实现（照抄 2026-10-08 之前那一行）—— 它是**标本**，不是备用实现
  const oldRewriteResult = { ok: false, error: '没有任何记录的 tags 命中这次归一化（这些写法是不是已经改过了？）' }
  const isNoop = (r) => r && r.ok === true && r.noop === true
  assert(isNoop(oldRewriteResult) === false,
    '★ 旧写法竟然被判成 noop ⇒ [A1] 分辨不出好坏（那条断言是空转的）')
  // 而新版必须判成 noop —— 两头都钉住，判据才不是"永远为假"
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH'])
  assert(isNoop(store.mergeTags({ groups: GROUP('DSH', ['dsh']) })) === true,
    '★ 新版没被判成 noop ⇒ 判据恒假')
})

/* ═══ [B] ★★ noop 绝不写撤销凭据（这是**数据完整性**，不是文案问题）══════ */
console.log('\n=== [B] ★★ noop 绝不占撤销凭据的位（否则一次"什么都没做"会偷走用户的退路）===')

check('★★ B1 noop **不碰** `meta.lastTagMerge`（凭据互斥：被顶掉就再也退不回去了）', () => {
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH'])
  mkRec(store, dir, 'b.txt', ['dsh'])
  // ① 先做一次**真**的合并 ⇒ 留下一份真凭据
  const real = store.mergeTags({ groups: GROUP('DSH', ['dsh']) })
  assert(real.ok === true && real.noop === false, '前置：第一次该真改：' + JSON.stringify(real))
  const credBefore = JSON.stringify(store.meta.lastTagMerge)
  assert(credBefore && credBefore !== 'null', '前置：该留下凭据')
  // ② 再做一次 **noop**
  const noop = store.mergeTags({ groups: GROUP('DSH', ['dsh']) })
  assert(noop.noop === true, '前置：第二次该是 noop：' + JSON.stringify(noop))
  // ③ 凭据必须**一字未动**
  assert(JSON.stringify(store.meta.lastTagMerge) === credBefore,
    '★ noop 动了撤销凭据 ⇒ 用户上一次**真**改过的操作已经退不回去了\n'
    + '   之前：' + credBefore + '\n   之后：' + JSON.stringify(store.meta.lastTagMerge))
})

check('★★ B2 灵敏度对照：**真的再改一次**时凭据**必须**变（证明 B1 的观察点是活的）', () => {
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH', 'godot'])
  mkRec(store, dir, 'b.txt', ['dsh'])
  store.mergeTags({ groups: GROUP('DSH', ['dsh']) })
  const credBefore = JSON.stringify(store.meta.lastTagMerge)
  const again = store.mergeTags({ groups: GROUP('Godot', ['godot']) })
  assert(again.ok === true && again.noop === false, '前置：第二次该真改：' + JSON.stringify(again))
  assert(JSON.stringify(store.meta.lastTagMerge) !== credBefore,
    '★ 真的改了凭据却没变 ⇒ B1 那条「凭据没变」可能是恒真（观察点死了），它就不是守卫')
})

check('★ B3 noop 也**不落盘**（磁盘上的 artifacts.json 逐字节不变）', () => {
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH'])
  const file = path.join(dir, 'artifacts.json')
  const before = fs.readFileSync(file, 'utf8')
  const r = store.mergeTags({ groups: GROUP('DSH', ['dsh']) })
  assert(r.noop === true, '前置：该是 noop')
  assert(fs.readFileSync(file, 'utf8') === before,
    '★ noop 竟然改了盘上的 artifacts.json')
})

/* ═══ [C] 工具层：0 命中不许印 ❌、也不许印「已改写 N 条」══════════════════ */
console.log('\n=== [C] 工具层：0 命中既不是 ❌ 也不是 ✅「已改写 0 条」（两种都是假话）===')

/** 起一个最小工具床（照 tools-agent.test.mjs 的套路）。 */
function toolBed() {
  const { dir, store } = mkStore()
  const registry = new Map()
  const ctx = { tools: { register(t) { registry.set(t.name, t); return () => registry.delete(t.name) } } }
  registerArtifactTools(ctx, store)
  const tool = registry.get('artifact_tags')
  assert(tool, 'artifact_tags 没注册')
  return { dir, store, tags: (args) => tool.execute(args, {}) }
}
/** 一句话里有没有「把它当成失败」的痕迹 */
const looksLikeFailure = (s) => /❌/.test(s)
/** 一句话里有没有「声称改了数据」的痕迹 */
const claimsChanged = (s) => /已改写\s*\d+\s*条/.test(s)

// ⚠️ **`await` 必须在语句层**：本仓库的 `check()` **不 await 返回值** ——
//    把 `async () => { … }` 塞进 `check` 会让断言**静默消失**（假通过）。
//    这是交接文件 §八 明写过的坑（`test/settings.test.mjs` 栽过），所以这里先把
//    四个用例的输出**全部算出来**，再由 `check` 做同步断言。
const c1bed = toolBed()
mkRec(c1bed.store, c1bed.dir, 'a.txt', ['DSH'])
const C1_OUT = (await c1bed.tags({ action: 'merge', groups: GROUP('DSH', ['dsh']) })).text

const c2bed = toolBed()
mkRec(c2bed.store, c2bed.dir, 'a.txt', ['DSH'])
const C2_OUT = (await c2bed.tags({ action: 'rename', groups: GROUP('学业', ['库里没有这个标签']) })).text

const c3bed = toolBed()
mkRec(c3bed.store, c3bed.dir, 'a.txt', ['DSH'])
mkRec(c3bed.store, c3bed.dir, 'b.txt', ['dsh'])
const C3_OUT = (await c3bed.tags({ action: 'merge', groups: GROUP('DSH', ['dsh']), confirm: true })).text

const c4bed = toolBed()
mkRec(c4bed.store, c4bed.dir, 'a.txt', ['DSH'])
const C4_OUT = (await c4bed.tags({ action: 'merge', groups: GROUP('学业', ['DSH']) })).text

// 防"用例根本没走到被测那段"（本仓库栽过三次）：空库也会得到「一个字都没改」，
// 但那不是我们想测的那条路 —— 所以显式确认库里**真的有**一个受管记录。
assert(c1bed.store.tagCounts().length > 0, '装配失败：C1 的库里没有记录，那条用例测的是别的东西')

check('★★ C1 merge 0 命中：**不许 ❌**、**不许**「已改写 N 条」，要明说「一个字都没改」', () => {
  assert(!looksLikeFailure(C1_OUT), '★ 印了 ❌ —— 请求完全合法，用户的诉求已经满足，这是假话：\n' + C1_OUT)
  assert(!claimsChanged(C1_OUT), '★ 声称「已改写 N 条」—— 但一条都没改，这是另一种假话：\n' + C1_OUT)
  assert(/一个字都没改/.test(C1_OUT), '该明说「一个字都没改」：\n' + C1_OUT)
})

check('★★ C2 rename 0 命中：同上（两个入口都要）', () => {
  assert(!looksLikeFailure(C2_OUT), '★ 印了 ❌：\n' + C2_OUT)
  assert(!claimsChanged(C2_OUT), '★ 声称已改写：\n' + C2_OUT)
  assert(/一个字都没改/.test(C2_OUT), '该明说「一个字都没改」：\n' + C2_OUT)
})

check('★ C3 真的改了：照旧是 ✅ + 「已改写 N 条」（别把 C1 的判据做成"永远没有 ✅"）', () => {
  assert(/已改写\s*1\s*条/.test(C3_OUT), '真改了该报「已改写 1 条」：\n' + C3_OUT)
  assert(!/一个字都没改/.test(C3_OUT), '真改了不该说"一个字都没改"：\n' + C3_OUT)
})

check('★ C4 参数不合法：照旧 ❌（别把 C1 做成"工具再也不会报错"）', () => {
  assert(looksLikeFailure(C4_OUT), '跨语义该被拒且印 ❌：\n' + C4_OUT)
})

check('★★ C5 反向对照：拿**旧渲染**（把 noop 当失败）跑 C1 的判据 → 必须红', () => {
  // 旧行为：`if (!dry.ok) return { text: '❌ 不能这样归一化：' + dry.error }`
  // 而旧 store 在 0 命中时回 ok:false ⇒ 走到那一支。这里**原样复现**那个组合。
  const oldStoreResult = { ok: false, error: '没有任何记录的 tags 命中这次归一化（这些写法是不是已经改过了？）' }
  const oldRender = (r) => (!r.ok ? `❌ 不能这样归一化：${r.error}` : '')
  const out = oldRender(oldStoreResult)
  assert(looksLikeFailure(out) === true, '★ 旧组合竟然没被判成失败 ⇒ C1 的判据分辨不出好坏（空转）')
  assert(/一个字都没改/.test(out) === false, '★ 旧组合竟然满足了 C1 ⇒ 判据太松')
})

const c6bed = toolBed()
mkRec(c6bed.store, c6bed.dir, 'a.txt', ['DSH'])
const C6_OUT = (await c6bed.tags({ action: 'merge', groups: [] })).text

check('★ C6 失败按 `kind` 分三类渲染（`persist-failed` 必须说清「一个字都没改」）', () => {
  assert(/参数不完整/.test(C6_OUT), 'bad-request 该说"参数不完整"（并提示别重试同样的调用）：\n' + C6_OUT)
  // persist-failed 的文案由 store 的注入在 [E] 验；这里钉它**不会**被归到别的类
  const src = fs.readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
  assert(/kind === 'persist-failed'/.test(src), '工具层该单独处理 persist-failed')
  assert(/一个字都没改/.test(src), 'persist-failed 的文案该说清「一个字都没改」（否则 agent 会去撤一个不存在的操作）')
})

/* ═══ [D] 两段式窗口：预演有命中、真跑 noop ⇒ 必须明说是库变了 ═══════════ */
console.log('\n=== [D] 两段式窗口：预演说会改、真跑 0 命中 ⇒ 必须说「库在这两次之间变了」===')

// D1：把 store.mergeTags 包一层 —— **dry-run 返回之后**把库改掉（模拟"两次调用之间库变了"）
const d1bed = toolBed()
const d1rec = mkRec(d1bed.store, d1bed.dir, 'b.txt', ['dsh'])
{
  const realFn = d1bed.store.mergeTags.bind(d1bed.store)
  let seenDry = false
  d1bed.store.mergeTags = (opts) => {
    const r = realFn(opts)
    if (opts && opts.dryRun && r.ok && r.noop === false && !seenDry) {
      seenDry = true
      d1bed.store.get(d1rec.id).tags = ['DSH']   // 别的会话把 `dsh` 改掉了
    }
    return r
  }
  var D1_SEEN_DRY = () => seenDry
}
const D1_OUT = (await d1bed.tags({ action: 'merge', groups: GROUP('DSH', ['dsh']), confirm: true })).text

// D2：窗口**没发生**的正常路径
const d2bed = toolBed()
mkRec(d2bed.store, d2bed.dir, 'a.txt', ['DSH'])
mkRec(d2bed.store, d2bed.dir, 'b.txt', ['dsh'])
const D2_OUT = (await d2bed.tags({ action: 'merge', groups: GROUP('DSH', ['dsh']), confirm: true })).text

check('★★ D1 预演 → 库变 → 真跑：不许照「已改写 0 条」渲染，要明说是窗口', () => {
  assert(D1_SEEN_DRY(), '装配失败：dry-run 那一支没被走到（这个用例没测到窗口）')
  assert(!looksLikeFailure(D1_OUT), '★ 印了 ❌：\n' + D1_OUT)
  assert(!claimsChanged(D1_OUT), '★ 声称「已改写 N 条」：\n' + D1_OUT)
  assert(/库变了|之间变了/.test(D1_OUT), '★ 必须明说「库在这两次调用之间变了」——否则 agent 会以为是自己搞错了：\n' + D1_OUT)
})

check('★ D2 反向对照：窗口**没发生**时不许说「库变了」（否则那句话是空转的）', () => {
  assert(/已改写\s*1\s*条/.test(D2_OUT), '前置：正常路径该报「已改写 1 条」：\n' + D2_OUT)
  assert(!/库变了|之间变了/.test(D2_OUT), '★ 正常路径竟然也说「库变了」⇒ D1 那句分辨不出好坏：\n' + D2_OUT)
})

/* ═══ [E] 落盘失败仍必须是失败（别把三态修成"再也不会失败"）══════════════ */
console.log('\n=== [E] 落盘失败**仍然**是失败（三态不是把失败也吞掉）===')

check('★★ E1 落盘炸了 ⇒ `ok:false` + `kind:persist-failed`，且**数据整份回滚**', () => {
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH'])
  const rec = mkRec(store, dir, 'b.txt', ['dsh'])
  // 注入：让 saveMeta 失败（persistBulkOp 靠它落凭据）
  store.saveMeta = () => ({ ok: false, error: '注入的落盘失败' })
  const r = store.mergeTags({ groups: GROUP('DSH', ['dsh']) })
  assert(r.ok === false, '落盘失败必须仍是 ok:false：' + JSON.stringify(r))
  assert(r.kind === 'persist-failed', '★ 该带 kind=persist-failed：' + JSON.stringify(r))
  assert(store.get(rec.id).tags.join(',') === 'dsh',
    '★ 落盘失败后记录被改了却没退回（内存污染）：' + JSON.stringify(store.get(rec.id).tags))
})

check('★ E2 反向对照：正常落盘时**不许**报 persist-failed（否则 E1 的判据恒真）', () => {
  const { dir, store } = mkStore()
  mkRec(store, dir, 'a.txt', ['DSH'])
  mkRec(store, dir, 'b.txt', ['dsh'])
  const r = store.mergeTags({ groups: GROUP('DSH', ['dsh']) })
  assert(r.ok === true && r.kind === undefined, '正常路径不该有 kind：' + JSON.stringify(r))
})

/* ── 收尾 ───────────────────────────────────────────────────────────────── */
for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ } }

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
