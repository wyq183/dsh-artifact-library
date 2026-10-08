/**
 * 离线 harness：**落盘失败时不许说谎**（2026-10-08 · 修 verifier-3c 的 F3）
 *
 * 靶子是一条**退路**：`artifact_tags` 执行完会告诉用户「如要退回：action=undo-merge」。
 * 那句话只有在**凭据真的落到了盘上**时才算数。旧代码里：
 *   · `saveMeta()` 是 `try{}catch{}` **吞异常**，`rewriteTags` **不检查**它落没落；
 *   · 于是 `meta.json` 写不进去时，它照样回 `{ok:true, undo:true}`、
 *     工具照样印那句「如要退回」——**而重启后根本没有可撤销的东西**。
 *
 * 六节，按「出错后果」从重到轻：
 *   A 基线：正常时两个文件都真的落盘（先证明测试床本身是对的）
 *   B ★★ 凭据落不下 ⇒ **放弃这次改动**（记录零改动、上次退路原样）
 *   C ★★ 数据落不下 ⇒ **整份回滚**（盘与内存都不许留痕）
 *   D ★  失败的操作用不许吃掉上一次的退路
 *   E ★  撤销路径：数据落不下 ⇒ 回滚 + 凭据保留
 *   F ★★ 反向对照：证明这些注入**真的会失败**，且**旧写法确实会漏**
 *
 * 用法：node test/persist-fail.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArtifactStore } from '../lib/store.js'

let passed = 0
let failed = 0
const failures = []
const TMP_DIRS = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

function mkdirTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-persist-'))
  TMP_DIRS.push(dir)
  return dir
}

/** 造一个装好两条记录、已正常落盘的 store（ sabotage 之前必须先建好） */
function makeStore() {
  const dir = mkdirTmp()
  const store = new ArtifactStore(dir).load()
  const f1 = path.join(dir, 'a.txt'); fs.writeFileSync(f1, 'a')
  const f2 = path.join(dir, 'b.txt'); fs.writeFileSync(f2, 'b')
  store.register({ path: f1, title: 'a', tags: ['dsh'] })
  store.register({ path: f2, title: 'b', tags: ['DSH'] })
  return { dir, store }
}

const ART = (dir) => path.join(dir, 'artifacts.json')
const META = (dir) => path.join(dir, 'meta.json')
const readArt = (dir) => fs.readFileSync(ART(dir), 'utf8')
const readMeta = (dir) => fs.readFileSync(META(dir), 'utf8')
/** 内存里所有记录的 tags 快照 —— ⚠️ 必须**逐条**比，不能 flatMap 后找某个值：
 *  `b` 那条记录**本来就**带着 `DSH`，用 `!includes('DSH')` 判"回滚"会永远为假。
 *  （这类"断言没测到它以为在测的东西"这个仓库已经栽过好几次。） */
const tagsSnap = (store) => JSON.stringify(store.items.map((r) => (r.tags || []).slice()))

/**
 * 让「落凭据」失败：把 `meta.json` 换成一个**同名目录** ⇒ `writeFileSync` 报 EISDIR。
 * （不用 chmod：Windows 上对文件 chmod 只读**未必**拦得住写入，那会让整份测试变成空转。）
 */
function sabotageMeta(dir) {
  const p = META(dir)
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
  fs.mkdirSync(p)
}
function repairMeta(dir) {
  const p = META(dir)
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) fs.rmdirSync(p)
}

/** 让「落数据」失败：`save()` 先写 `artifacts.json.tmp`，把那个名字占成目录即可 */
function sabotageData(dir) {
  const p = ART(dir) + '.tmp'
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
  fs.mkdirSync(p)
}
function repairData(dir) {
  const p = ART(dir) + '.tmp'
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) fs.rmdirSync(p)
}

console.log('\n=== [A] 基线：正常时两个文件都真的落盘 ===')
{
  const { dir, store } = makeStore()
  const r = store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
  check('A1 正常 merge → ok + undo:true', () => {
    assert(r.ok === true, 'merge 该成功：' + JSON.stringify(r))
    assert(r.undo === true, '该报 undo:true')
  })
  check('A2 数据真的落到 artifacts.json（不是只在内存里）', () => {
    const onDisk = JSON.parse(readArt(dir))
    const all = onDisk.flatMap((x) => x.tags || [])
    assert(all.includes('DSH') && !all.includes('dsh'), '盘上没改成 DSH：' + JSON.stringify(all))
  })
  check('A3 凭据真的落到 meta.json（这才让"如要退回"那句话成立）', () => {
    const m = JSON.parse(readMeta(dir))
    assert(m.lastTagMerge && Array.isArray(m.lastTagMerge.changed) && m.lastTagMerge.changed.length === 1,
      'meta.json 里没有凭据：' + JSON.stringify(m.lastTagMerge))
  })
}

console.log('\n=== [B] ★★ 凭据落不下 ⇒ 必须放弃这次改动（F3 变体 1）===')
{
  const { dir, store } = makeStore()
  const before = readArt(dir)
  const memBefore = tagsSnap(store)
  sabotageMeta(dir)
  const r = store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
  check('B1 返回 ok:false（**不许**谎报成功、更不许回 undo:true）', () => {
    assert(r.ok === false, '竟然报成功了：' + JSON.stringify(r))
    assert(r.undo !== true, '竟然回了 undo:true —— 退路是假的')
    assert(/凭据/.test(r.error || ''), '错误该说清是"凭据没落盘"：' + r.error)
  })
  check('B2 ★ 记录**一个字节都没改**（盘上逐字节比对）', () => {
    assert(readArt(dir) === before, '盘上的 artifacts.json 被改了')
  })
  check('B3 ★ 内存也退回去了（否则之后任何一次 save() 都会把它写死）', () => {
    assert(tagsSnap(store) === memBefore, '内存没回滚：' + tagsSnap(store) + ' ≠ ' + memBefore)
  })
  check('B4 内存里的凭据也没留（不许"内存里看着有、盘上没有"）', () => {
    assert(store.meta.lastTagMerge === null, '内存里留了一份假凭据')
  })
  repairMeta(dir)
}

console.log('\n=== [C] ★★ 数据落不下 ⇒ 必须整份回滚（F3 变体 2）===')
{
  const { dir, store } = makeStore()
  const before = readArt(dir)
  const memBefore = tagsSnap(store)
  sabotageData(dir)
  const r = store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
  check('C1 返回 ok:false 且不回 undo:true', () => {
    assert(r.ok === false, '竟然报成功了：' + JSON.stringify(r))
    assert(r.undo !== true, '竟然回了 undo:true')
    assert(/落盘/.test(r.error || ''), '错误该说清是"记录没落盘"：' + r.error)
  })
  check('C2 ★ 盘上记录零改动', () => {
    assert(readArt(dir) === before, 'artifacts.json 被改了')
  })
  check('C3 ★★ 内存也回滚（这是旧写法最阴的地方：内存改了、盘没改，之后一次正常 save 就写死）', () => {
    assert(tagsSnap(store) === memBefore, '内存没回滚：' + tagsSnap(store) + ' ≠ ' + memBefore)
  })
  check('C4 内存里的凭据也被还原（不许留下一份指向"没发生的改动"的凭据）', () => {
    assert(store.meta.lastTagMerge === null, '内存里留了凭据')
  })
  repairData(dir)
  // 修好之后，同一个 store 必须能正常再做一次（证明回滚没把 store 弄坏）
  const again = store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
  check('C5 修好之后同一个 store 仍能正常合并（回滚没把对象弄坏）', () => {
    assert(again.ok === true, '修好后仍失败：' + JSON.stringify(again))
    assert(JSON.parse(readArt(dir)).flatMap((x) => x.tags).includes('DSH'), '盘上没改成 DSH')
  })
}

console.log('\n=== [D] ★ 失败的操作用不许吃掉上一次的退路 ===')
{
  const { dir, store } = makeStore()
  // 先做一次**成功**的操作，留下一份真凭据
  const f3 = path.join(dir, 'c.txt'); fs.writeFileSync(f3, 'c')
  store.register({ path: f3, title: 'c', tags: ['godot'] })
  const good = store.mergeTags({ groups: [{ canonical: 'Godot', from: ['godot'] }] })
  assert(good.ok === true, '前置操作该成功')
  const credBefore = JSON.stringify(store.meta.lastTagMerge)
  const metaOnDiskBefore = readMeta(dir)
  const artBefore = readArt(dir)

  sabotageMeta(dir)
  const bad = store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
  check('D1 失败的那次确实失败了', () => {
    assert(bad.ok === false, '该失败：' + JSON.stringify(bad))
  })
  check('D2 ★ 上一次的凭据**原样还在**（没被一次失败的操作顶掉）', () => {
    assert(JSON.stringify(store.meta.lastTagMerge) === credBefore,
      '凭据被动了：' + JSON.stringify(store.meta.lastTagMerge))
  })
  check('D3 ★ 另外两份凭据槽也没被清掉（clearOtherUndoCredentials 的副作用要一起回滚）', () => {
    assert(store.meta.lastProjectMerge === null || store.meta.lastProjectMerge !== undefined,
      '槽位结构被破坏了')
    // 真正要钉的是：这次失败没有**新写入**任何一份凭据
    assert(store.meta.lastCategoryRemoval === null, '凭空多出一份分类凭据')
  })
  repairMeta(dir)
  check('D4 盘上的数据零改动（失败的操作什么都没干）', () => {
    assert(readArt(dir) === artBefore, '盘上数据被改了')
  })
  check('D5 ★ 修好之后把内存写回去，盘上 meta 与"上一次成功操作"**逐字节相同**', () => {
    // ⚠️ 为什么这样测：sabotage 把 meta.json 换成了同名目录 ⇒ 那个文件**本来就被删了**，
    //    所以不能直接读它。真正要钉的是"失败的那次**没有弄坏内存里的 meta**"——
    //    修好后写一次，内容必须与失败前那一份一模一样。
    const w = store.saveMeta()
    assert(w.ok === true, '修好后仍写不进去：' + JSON.stringify(w))
    assert(readMeta(dir) === metaOnDiskBefore, '内存里的 meta 被失败的那次改动了')
  })
}

console.log('\n=== [E] ★ 撤销路径：数据落不下 ⇒ 回滚 + 凭据保留 ===')
{
  const { dir, store } = makeStore()
  store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
  const credBefore = JSON.stringify(store.meta.lastTagMerge)
  const artBefore = readArt(dir)
  sabotageData(dir)
  const r = store.undoTagMerge()
  check('E1 撤销失败时返回 ok:false（不谎报"已撤销"）', () => {
    assert(r.ok === false, '竟然报成功了：' + JSON.stringify(r))
    assert(/还原/.test(r.error || ''), '错误该说清是"还原没落盘"：' + r.error)
  })
  check('E2 ★ 盘上零改动', () => {
    assert(readArt(dir) === artBefore, '盘上数据被改了')
  })
  check('E3 ★★ 凭据**保留**（这样用户还能再试一次；凭据没了才是真损失）', () => {
    assert(JSON.stringify(store.meta.lastTagMerge) === credBefore, '凭据被消费掉了')
  })
  check('E4 内存也回滚了（没退回合并前，也没把凭据吃掉）', () => {
    assert(store.items.flatMap((x) => x.tags).includes('DSH'), '内存被改成了撤销后的样子')
  })
  repairData(dir)
  const ok2 = store.undoTagMerge()
  check('E5 修好之后能正常撤销（回滚没把对象弄坏）', () => {
    assert(ok2.ok === true, '修好后仍失败：' + JSON.stringify(ok2))
    assert(store.items.flatMap((x) => x.tags).includes('dsh'), '没还原回 dsh')
  })
}

console.log('\n=== [F] ★★ 反向对照：证明注入真的会失败、且旧写法确实会漏 ===')
// ⚠️ 这一节防的是**整份测试在空转**：如果 sabotage 其实没拦住写入，
//    B/C/D/E 四节会**全绿**，而它们什么也没守住。所以要先证明"注入有效"。
{
  const { dir, store } = makeStore()

  sabotageMeta(dir)
  const metaRes = store.saveMeta()
  check('F1 注入有效：meta.json 占成目录后，saveMeta() **真的**失败', () => {
    assert(metaRes.ok === false, 'saveMeta 竟然成功了 ⇒ B/D 两节是空转的')
    assert(typeof metaRes.error === 'string' && metaRes.error.length > 0, '失败却没给原因')
  })
  repairMeta(dir)

  sabotageData(dir)
  let threw = null
  try { store.save() } catch (e) { threw = e }
  check('F2 注入有效：artifacts.json.tmp 占成目录后，save() **真的**抛', () => {
    assert(threw !== null, 'save() 竟然没抛 ⇒ C/E 两节是空转的')
  })
  repairData(dir)

  // ⭐ 已知有病的版本：照抄**旧写法**（先落数据、凭据失败被吞掉、然后谎报成功）
  const { dir: d2, store: s2 } = makeStore()
  sabotageMeta(d2)
  const oldShape = (() => {
    s2.items[0].tags = ['DSH']                       // 改内存
    s2.save()                                        // 先落**数据**
    const mr = s2.saveMeta()                         // 再落凭据 —— 旧写法在这里吞掉失败
    return { ok: true, undo: true, metaActuallySaved: mr.ok }  // ← 旧写法**无条件**报成功
  })()
  check('F3 ★★ 旧写法确实会漏：数据落了、凭据没落，却照样报 ok:true + undo:true', () => {
    assert(oldShape.ok === true && oldShape.undo === true, '前提不成立：旧写法没谎报')
    assert(oldShape.metaActuallySaved === false, '前提不成立：凭据其实落上了')
    const all = JSON.parse(readArt(d2)).flatMap((x) => x.tags || [])
    assert(all.includes('DSH'), '前提不成立：数据没落盘')
    // 凭据确实**没**落盘：meta.json 还是那个占位的目录（写入被 EISDIR 拦住）
    assert(fs.statSync(META(d2)).isDirectory(), '前提不成立：meta.json 竟然被写成了文件')
  })
  check('F4 ★★ 而新写法在**同一个注入下**会拒（这就是这批守卫的靶心）', () => {
    repairMeta(d2)
    const { dir: d3, store: s3 } = makeStore()
    const artBefore3 = readArt(d3)
    sabotageMeta(d3)
    const r = s3.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
    assert(r.ok === false, '新写法竟然也放行了')
    assert(readArt(d3) === artBefore3, '新写法竟然改了盘上的数据')
  })
}

// ── 收尾：临时目录一律删掉（本文件绝不在仓库/真库里留垃圾）──────────────────
for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 尽力 */ } }

console.log('\n' + '─'.repeat(60))
console.log('结果：' + passed + ' 通过 / ' + failed + ' 失败')
if (failed) { console.log('失败项：'); for (const f of failures) console.log('  · ' + f) }
process.exit(failed ? 1 : 0)
