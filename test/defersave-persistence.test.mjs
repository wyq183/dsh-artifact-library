/**
 * R-15：`deferSave` 部分持久化 —— **已知行为的机器记录**
 *
 * 为什么有这个文件：09-30 收尾时这是**唯一"连有没有都不知道"**的风险项，
 * 影响上架材料措辞，一直挂着。2026-10-02 夜用 `~/.dsh/scratch/r15-defersave-verify.mjs`
 * 实测出了结论，这里把它**钉住**，防止将来悄悄变化。
 *
 * 机制（`lib/store.js`）：
 *   · `importFolder()` 逐条 `register(..., {deferSave:true})`（:844）→ 只进内存，不落盘
 *   · 整批结束才 `if (count > 0) this.save()`（:853）
 *   · `save()` = 把**整个 `this.items`** 全量 `writeFileSync`（:460-463）
 *   · `walk()` 内部 `catch { skipped++ }`（:849）→ 单条失败**不中断**整批
 *
 * 实测结论（4 条断言 + 1 条"如实记录已知风险"）：
 *   ① 只 deferSave 不 save          → 磁盘**没有**这些记录（契约）
 *   ② 导入到一半被打断（无中途 save）→ 磁盘**干净**（整批丢，不半截）
 *   ③ ⚠️ **半截落盘确实会**：导入未完成 + 期间别处 `save()` + 进程级中断
 *        → 不是数据损坏（记录完整、JSON 合法），重导一次即可（byPath 去重）
 *   ④ 正常导完                      → 全量落盘
 *   ⑤ 单条失败                      → skipped++，其余照常导入（不中断）
 *
 * 用法：node test/defersave-persistence.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArtifactStore } from '../lib/store.js'

let passed = 0
let failed = 0
const failures = []
// ⚠️ 必须是 async：下面 ④⑤ 的用例体是 async，同步 check 会**静默跳过断言**（假绿）。
async function check(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-r15-'))
let seq = 0
function freshStore() {
  const dir = path.join(TMP, 'store' + (seq += 1))
  fs.mkdirSync(dir, { recursive: true })
  return { store: new ArtifactStore(dir).load(), dir }
}
/** 从磁盘真实读回（不信任内存对象） */
function diskItems(dir) {
  const f = path.join(dir, 'artifacts.json')
  if (!fs.existsSync(f)) return []
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
  return Array.isArray(raw) ? raw : (raw.items || [])
}
function makeSrcDir(n, prefix = 'f') {
  const d = fs.mkdtempSync(path.join(TMP, 'src-'))
  for (let i = 0; i < n; i += 1) fs.writeFileSync(path.join(d, `${prefix}${i}.md`), 'x'.repeat(20))
  return d
}
/** 模拟"导入跑到第 k 条时被打断"：手工 deferSave 到 k 条，然后不调最终 save */
function importUntil(store, k, tag) {
  for (let i = 0; i < k; i += 1) {
    store.register({ path: path.join(TMP, `${tag}-${i}.md`), title: `${tag}-${i}` }, { deferSave: true })
  }
}

console.log('R-15 · deferSave 持久化行为\n')

// ① 契约：只 deferSave、不 save → 不落盘
await check('① deferSave 只进内存，不落盘（契约）', () => {
  const { store, dir } = freshStore()
  importUntil(store, 3, 's1')
  assert(diskItems(dir).length === 0, '磁盘不该有记录，实际 ' + diskItems(dir).length + ' 条')
  assert(store.list().length === 3, '内存应有 3 条')
})

// ② 导入到一半被打断（中途无别的 save）→ 磁盘干净
await check('② 导入到一半被打断（中途无 save）→ 磁盘干净，不半截', () => {
  const { store, dir } = freshStore()
  importUntil(store, 4, 's2')
  assert(diskItems(dir).length === 0, '磁盘应为空，实际 ' + diskItems(dir).length + ' 条')
})

// ③ ⚠️ 如实记录：半截落盘确实会发生（三条件齐备时）
//    这不是"断言它正确"，而是**把已知风险钉在测试里** ——
//    哪天行为改了（比如 importFolder 改成写临时文件+原子替换），这条会红，提醒更新结论。
await check('③ ⚠️ 已知风险：导入未完成 + 期间别处 save() + 中断 → 半截落盘', () => {
  const { store, dir } = freshStore()
  importUntil(store, 2, 's3a')     // 导到第 2 条
  store.save()                     // ← 期间别处触发落盘（如用户点了标记/回收）
  importUntil(store, 2, 's3b')     // 继续导到第 4 条（仍未完成）
  // 此刻"进程中断" → 盘上内容 == 最后一次 save() 的状态
  const onDisk = diskItems(dir)
  assert(onDisk.length === 2, '预期盘上停在 2 条（半截），实际 ' + onDisk.length + ' 条')
  // 但**不是损坏**：能重新 load、记录字段完整
  const reloaded = new ArtifactStore(dir).load()
  assert(reloaded.list().length === 2, '重新 load 应能读到 2 条')
  const one = reloaded.list()[0]
  assert(typeof one.id === 'string' && typeof one.path === 'string', '记录字段应完整（不是坏 JSON）')
})

// ④ 正常导完 → 全量
await check('④ importFolder 正常导完 → 全量落盘', async () => {
  const { store, dir } = freshStore()
  const src = makeSrcDir(5, 's4')
  const r = await store.importFolder(src, { project: 'R15' })
  assert(r.count === 5, 'count 应为 5，实际 ' + r.count)
  assert(diskItems(dir).length === 5, '磁盘应有 5 条，实际 ' + diskItems(dir).length + ' 条')
})

// ⑤ 单条失败 → skipped++，不中断整批
await check('⑤ 单条失败不中断整批（skipped++）', async () => {
  const { store, dir } = freshStore()
  const src = makeSrcDir(6, 's5')
  const orig = store.register.bind(store)
  let n = 0
  store.register = function (...args) {
    n += 1
    if (n === 3) throw new Error('模拟第 3 条失败')
    return orig(...args)
  }
  const r = await store.importFolder(src, { project: 'R15' })
  assert(r.count === 5, '应成功 5 条，实际 ' + r.count)
  assert(r.skipped >= 1, 'skipped 应 ≥1，实际 ' + r.skipped)
  assert(diskItems(dir).length === 5, '磁盘应有 5 条')
})

// ⑥ 重新 load 后与内存一致（无隐藏丢失）
await check('⑥ 落盘后重新 load 与落盘时的内存一致', () => {
  const { store, dir } = freshStore()
  importUntil(store, 3, 's6')
  store.save()
  const again = new ArtifactStore(dir).load().list()
  assert(again.length === 3, '重新 load 应 3 条，实际 ' + again.length)
})

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败')
if (failed) { console.log('失败清单：'); for (const f of failures) console.log('  - ' + f) }
console.log('临时目录：' + TMP)
process.exit(failed ? 1 : 0)
