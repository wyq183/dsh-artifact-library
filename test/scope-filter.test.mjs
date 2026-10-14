/**
 * 回归守卫：`store.list` 的 `scope_dir` / `session_id` 两个筛选
 * ══════════════════════════════════════════════════════════════════════════
 * 【2026-10-14 建 · 起因是右栏「文件管理」的三个粒度】
 *
 * 右栏 tab 打开时默认显示「**当前工作区**」，可切「全部」/「当前会话」。
 * 前两者靠 `store.list` 的两个新参数实现（`scope_dir` / `session_id`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【为什么需要**合成数据**而不是拿真库跑】
 *
 * 我先拿真库（422 条）跑过：三种算法（归一化 / 不归一化 / 只比 root）
 * **结果都是 27 条** —— 因为真库里**恰好没有**触发差异的路径。
 * ⇒ 那 27 条**证明不了**归一化有用，只证明"在这个库上碰巧一样"。
 *
 * ⇒ 按 `RULES.md` §7.2：反向对照必须用**固定合成件**，且要**故意造出差异**。
 *    本文件因此自带 8 条固定路径，覆盖三种真实存在的坑：
 *      ① 反斜杠 vs 正斜杠（Windows 上混用）
 *      ② 大小写（Windows 路径不区分大小写）
 *      ③ ⭐ **前缀误判**：`C:\a` 不该吃进 `C:\ab` / `C:\abc`
 *         —— 这是"只比 root 不比 `root + '/'`"的经典 bug，
 *            本文件末尾用**错的算法**跑同一份数据，证明它确实会误判 2 条。
 *
 * ⚠️ 断言纪律（§7）：判据是「**具体哪条进了、哪条没进**」，不是"条数对得上"。
 *    条数对得上可能是碰巧（比如错算法多算 2 条、少算 2 条，总数恰好一样）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url))
const STORE_URL = 'file:///' + path.join(ROOT_DIR, 'lib', 'store.js').replace(/\\/g, '/')

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) {
    failed += 1
    const msg = error && error.message ? error.message : String(error)
    failures.push({ name, msg })
    console.log('  FAIL ' + name + ' -> ' + msg)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

const { ArtifactStore } = await import(STORE_URL)

/** 造一条最小可用记录（只填 `list` 需要的字段）。 */
function rec(p, extra) {
  return Object.assign({
    id: 'fix_' + String(p).replace(/[^A-Za-z0-9]/g, '_'),
    path: p, filename: path.basename(p), extension: path.extname(p),
    size_bytes: 1, file_modified_at: 1, exists: true, is_dir: false,
    mime_type: 'text/plain', title: p, summary: '', project: '',
    deliverable: '', artifact_type: 'other', tags: [], status: 'final',
    stars: 0, notes: '', agent_id: '', session_id: '', created_at: 1,
    updated_at: 1, trashed_at: null, needsRefine: false, kind: 'deliverable',
    source: 'manual', refineRequested: false, references: [], contentIndex: '',
  }, extra || {})
}

/** 造一个 store（不碰磁盘 —— 只填 `items`）。 */
function makeStore(records) {
  const s = new ArtifactStore(path.join(ROOT_DIR, '__no_such_dir__'))
  s.items = records
  return s
}

// ══════════════════════════════════════════════════════════════════════════
// 固定合成件：8 条路径，每条标注"应不应该进"
// ══════════════════════════════════════════════════════════════════════════
const SCOPE_ROOT = 'C:\\work\\proj'
const SCOPE_FIXTURES = [
  ['精确等于 root', 'C:\\work\\proj', true],
  ['反斜杠子路径', 'C:\\work\\proj\\a.md', true],
  ['正斜杠子路径', 'C:/work/proj/b.md', true],
  ['大小写不同', 'c:\\WORK\\PROJ\\c.md', true],
  ['前缀陷阱 proj2', 'C:\\work\\proj2\\d.md', false],
  ['前缀陷阱 projects', 'C:\\work\\projects\\e.md', false],
  ['无关目录', 'C:\\other\\f.md', false],
  ['root 名在中间', 'C:\\x\\work\\proj\\g.md', false],
]

console.log('\n═══ scope_dir / session_id 回归守卫 ═══')
console.log(' 被测：' + STORE_URL)

// ── ① 预处理自检（§7.5：判据依赖的输入必须先证明它是对的）──────────────────
check('预处理自检：合成件本身是 8 条、且"应进"恰好 4 条', () => {
  assert(SCOPE_FIXTURES.length === 8, '合成件应为 8 条，实际 ' + SCOPE_FIXTURES.length)
  const yes = SCOPE_FIXTURES.filter((f) => f[2]).length
  assert(yes === 4, '"应进"应为 4 条，实际 ' + yes)
})

// ── ② 逐条断言（不是"条数对得上"）──────────────────────────────────────────
check('scope_dir：8 条路径**逐条**判定正确（进/不进各 4）', () => {
  const store = makeStore(SCOPE_FIXTURES.map(([label, p]) => rec(p, { title: label })))
  const got = new Set(store.list({ scope_dir: SCOPE_ROOT, limit: 100 }).map((r) => r.path))
  const wrong = []
  for (const [label, p, shouldIn] of SCOPE_FIXTURES) {
    const isIn = got.has(p)
    if (isIn !== shouldIn) wrong.push((shouldIn ? '应进未进' : '不该进却进了') + '：' + label)
  }
  assert(wrong.length === 0, wrong.join('；'))
  assert(got.size === 4, '命中数应为 4，实际 ' + got.size)
})

// ── ③ ⭐ 反向对照：证明"错的算法"真的会错（否则上面的通过没有意义）────────
check('★ 反向对照：故意用"只 startsWith(root)"的错算法 ⇒ 必须误判 2 条', () => {
  const store = makeStore(SCOPE_FIXTURES.map(([label, p]) => rec(p, { title: label })))
  const right = new Set(store.list({ scope_dir: SCOPE_ROOT, limit: 100 }).map((r) => r.path))
  const naive = store.items.filter((r) => String(r.path || '').startsWith(SCOPE_ROOT))
  const bogus = naive.filter((r) => !right.has(r.path))
  assert(bogus.length === 2,
    '错算法应误判 2 条（proj2 / projects），实际 ' + bogus.length + ' 条：' + bogus.map((r) => r.path).join(', '))
})

// ── ④ 反斜杠 / 正斜杠 / 大小写 三个坑各自单独咬一次 ────────────────────────
check('反斜杠 root 能匹配正斜杠路径', () => {
  const store = makeStore([rec('C:/work/proj/x.md')])
  assert(store.list({ scope_dir: 'C:\\work\\proj', limit: 10 }).length === 1, '应命中')
})
check('正斜杠 root 能匹配反斜杠路径', () => {
  const store = makeStore([rec('C:\\work\\proj\\x.md')])
  assert(store.list({ scope_dir: 'C:/work/proj', limit: 10 }).length === 1, '应命中')
})
check('大小写不敏感（root 与路径大小写都不同）', () => {
  const store = makeStore([rec('C:\\WoRk\\PrOj\\x.md')])
  assert(store.list({ scope_dir: 'c:/WORK/proj', limit: 10 }).length === 1, '应命中')
})
check('root 末尾带分隔符也能匹配（用户可能带 / 或 \\）', () => {
  const store = makeStore([rec('C:\\work\\proj\\x.md')])
  assert(store.list({ scope_dir: 'C:\\work\\proj\\', limit: 10 }).length === 1, '应命中')
  assert(store.list({ scope_dir: 'C:/work/proj/', limit: 10 }).length === 1, '应命中')
})

// ── ⑤ session_id ──────────────────────────────────────────────────────────
check('session_id：只留该会话的（且逐条正确）', () => {
  const store = makeStore([
    rec('C:\\a\\1.md', { session_id: 's1' }),
    rec('C:\\a\\2.md', { session_id: 's2' }),
    rec('C:\\a\\3.md', { session_id: 's1' }),
    rec('C:\\a\\4.md', { session_id: '' }),
  ])
  const got = store.list({ session_id: 's1', limit: 10 }).map((r) => r.path).sort()
  assert(got.length === 2, '应 2 条，实际 ' + got.length)
  assert(got[0] === 'C:\\a\\1.md' && got[1] === 'C:\\a\\3.md', '命中的应是 1.md 与 3.md：' + got.join(', '))
})

check('session_id 为空串时**不过滤**（不能把空串当成"匹配空 session"）', () => {
  const store = makeStore([
    rec('C:\\a\\1.md', { session_id: 's1' }),
    rec('C:\\a\\2.md', { session_id: '' }),
  ])
  assert(store.list({ session_id: '', limit: 10 }).length === 2, '空串应不过滤，得 2 条')
})

// ── ⑥ 两个筛选叠加 ────────────────────────────────────────────────────────
check('scope_dir + session_id 叠加是**交集**', () => {
  const store = makeStore([
    rec('C:\\work\\proj\\in.md', { session_id: 's1' }),
    rec('C:\\work\\proj\\out.md', { session_id: 's2' }),
    rec('C:\\other\\out.md', { session_id: 's1' }),
  ])
  const got = store.list({ scope_dir: 'C:\\work\\proj', session_id: 's1', limit: 10 })
  assert(got.length === 1 && got[0].path === 'C:\\work\\proj\\in.md',
    '应只剩 in.md，实际：' + got.map((r) => r.path).join(', '))
})

// ── ⑦ 回归：既有筛选没被弄坏 ─────────────────────────────────────────────
check('回归：project / artifact_type / status 仍按原语义工作', () => {
  const store = makeStore([
    rec('C:\\a\\1.md', { project: 'P1', artifact_type: 'document' }),
    rec('C:\\a\\2.md', { project: 'P2', artifact_type: 'image' }),
    rec('C:\\a\\3.md', { project: 'P1', artifact_type: 'image', trashed_at: 123 }),
  ])
  assert(store.list({ project: 'P1', limit: 10 }).length === 1, 'project=P1 应 1 条（回收站那条不算）')
  assert(store.list({ artifact_type: 'image', limit: 10 }).length === 1, 'image 应 1 条')
  assert(store.list({ status: 'trashed', limit: 10 }).length === 1, '回收站应 1 条')
  assert(store.list({ limit: 10 }).length === 2, '默认应 2 条（不含回收站）')
})

check('回归：不传 scope_dir/session_id 时行为与加参数前一致', () => {
  const store = makeStore(SCOPE_FIXTURES.map(([label, p]) => rec(p, { title: label })))
  const a = store.list({ limit: 100 }).length
  const b = store.list({ scope_dir: '', session_id: '', limit: 100 }).length
  assert(a === 8 && b === 8, '应都是 8 条，实际 ' + a + ' / ' + b)
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed > 0) process.exitCode = 1
