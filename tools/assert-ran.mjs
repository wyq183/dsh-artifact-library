#!/usr/bin/env node
/**
 * 测试真跑了吗（assert-ran）—— **测试的唯一入口**
 * ══════════════════════════════════════════════════════════════════════════
 * 【为什么有它 —— 一个**静默假绿**，2026-10-09 实测确认】
 *
 *     $ node --test test/*.nonexistent.mjs
 *     ℹ tests 0
 *     ℹ pass 0
 *     ℹ fail 0
 *     $ echo $?
 *     0                       ← 🔴 **退出码 0**
 *
 * ⇒ **`node --test` 在 glob 匹配到 0 个文件时，报 0 个测试、然后"成功"退出。**
 *   也就是说：**如果有人重命名了测试文件、或者 glob 写错了，
 *   `npm test` 会绿 —— 而一个测试都没跑。**
 *
 * ⭐ 这正是本仓库整套规范要治的那一类失效（见 `docs/standards/08-dod.md` §五）：
 *   **不是"错了会红"，而是"错了照样绿"。**
 *   而且它**比空转守卫更坏** —— 空转守卫至少还有守卫文件在，这个连文件都没跑。
 *
 * 【为什么它是"唯一入口"而不是"额外一步"】
 *   如果写成 `node --test … && node tools/assert-ran.mjs`，测试会**跑两遍**（各 ~5 秒），
 *   而且测试失败时 assert-ran 根本轮不到跑。
 *   ⇒ 本文件**自己跑测试、自己转发输出、自己做对账**，只跑一遍。
 *
 * ⚠️ **它必须真的跑测试**（不是静态数文件）——
 *   静态数文件只能证明"文件在"，证明不了"runner 真的加载了它们"。
 *   这就是 `testing-tiers` 说的「**verify the world, not the self-report**」。
 *
 * 用法：
 *   node tools/assert-ran.mjs            # 跑测试 + 对账（这是 `npm run test:unit`）
 *   node tools/assert-ran.mjs --quiet    # 只转发测试输出，不打印对账信息
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QUIET = process.argv.includes('--quiet')
const GLOB = 'test/*.test.mjs'

// ── ① 磁盘上真实有几个测试文件（**"世界"那一侧**）──────────────────────
const onDisk = fs.readdirSync(path.join(REPO, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()

if (onDisk.length === 0) {
  console.log('🔴 `test/` 下**一个测试文件都没有** —— 这不是"通过"，这是"没东西可跑"。')
  process.exit(1)
}

// ── ② 真的跑一遍（**"自述"那一侧**）─────────────────────────────────────
// ⚠️ 捕获输出，**然后原样转发**（让人看到正常的测试输出）。
const r = spawnSync(process.execPath, ['--test', GLOB], {
  cwd: REPO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
})
const out = (r.stdout || '') + (r.stderr || '')
const testCode = r.status == null ? 1 : r.status

// 原样转发（**别吞掉** —— 测试输出是给人看的）
if (out) process.stdout.write(out)

// ── ③ 从输出里数（**这一侧才是判据的输入**）────────────────────────────
//
// ⚠️⚠️ **汇总行的前缀随 Node 版本变**（2026-10-09 由 CI 实测抓到）：
//
//   Node 24/25:  `ℹ tests 30`      ← 用 U+2139 (ℹ) 前缀，**不缩进**
//   Node 22:     `# tests 1`       ← 用 `#` 前缀，**缩进两格**
//
// 我第一版只认 `^ℹ tests N` ⇒ **在 Node 22 上读不到 ⇒ 报红**
// （CI 的 `compat (node 22 / ubuntu-latest)` 就是这么红的）。
//
// ⭐ 值得说清**这不是判据"太严"，是"太窄"**：
//   它把"格式不认识"报成了"测试没跑"。**宁可红不可假绿**这个方向是对的，
//   但**报错信息误导了** —— 它让我以为测试真出问题了，其实是格式差异。
//   ⇒ 修法：**两种格式都认**，且**认不出时把实际输出打出来**（别让人去猜）。
//
// ⚠️ 将来 Node 再换格式怎么办：**这条判据会红**（这是有意的）——
//   红的时候按提示看一眼实际输出，把新格式加进来即可。
const num = (label) => {
  // 两种已知格式：`ℹ tests 30`（Node ≥24）与 `# tests 1`（Node 22）
  const m = out.match(new RegExp('(?:^|\\n)\\s*(?:\\u2139|#)\\s*' + label + ' (\\d+)\\s*$', 'm'))
  return m ? Number(m[1]) : null
}
const ranTests = num('tests')
const ranPass = num('pass')
const ranFail = num('fail')

// ── ④ 对账 ────────────────────────────────────────────────────────────────
const problems = []

if (ranTests === null) {
  // ⚠️ 把**实际输出尾部**打出来 —— 别让下一个人去猜"到底是格式变了还是真没跑"。
  //    （2026-10-09：CI 的 node22 那一格就是这么红的，
  //     而我当时只能靠"下载一个 Node 22 本地复现"才查清。**这个诊断信息本该在这里。**）
  const tail = out.split('\n').slice(-25).map((l) => '       ' + l).join('\n')
  problems.push(
    '从输出里**读不到测试汇总行**（`ℹ tests N` 或 `# tests N`）——\n'
    + '     本工具的判据认这两种前缀。读不到有两种可能：\n'
    + '       (a) **Node 换了汇总格式** ⇒ 把新格式加进 `num()` 的正则；\n'
    + '       (b) **测试根本没跑起来** ⇒ 那本来就该红。\n'
    + '     ⚠️ **读不到不能当成通过** —— 读不到就是读不到。\n'
    + '     ⚠️ 也别直接改成正则更宽（比如匹配任意 `tests N`）—— 那会误吃别的行。\n'
    + '     实际输出尾部（**看这里判断是 (a) 还是 (b)**）：\n' + tail,
  )
} else if (ranTests === 0) {
  problems.push(
    '`node --test ' + GLOB + '` **跑了 0 个测试，却退出成功** ——\n'
    + '     🔴 **这是静默假绿**：glob 没匹配到文件时 Node 报 0/0/0 然后 exit 0。\n'
    + '     ⇒ 磁盘上明明有 **' + onDisk.length + ' 个** `*.test.mjs`，一个都没跑。\n'
    + '     ⇒ 检查：glob 是不是写错了？测试文件是不是被改名/移动了？',
  )
}

// ⚠️ 文件数对账：Node 的汇总只给"测试条数"，不给"文件数" ——
//    所以用一个**保守的代理判据**：每个测试文件至少产出 1 条测试，
//    所以 `ranTests >= onDisk.length` 必须成立。
//    （本仓库每个文件都是几十条，这个下界很松，但**足够抓住"整片文件没跑"**。）
if (ranTests !== null && ranTests > 0 && ranTests < onDisk.length) {
  problems.push(
    '跑到的测试数（**' + ranTests + '**）**少于磁盘上的测试文件数**（**' + onDisk.length + '**）——\n'
    + '     每个测试文件至少该产出 1 条测试，所以这**不可能**是正常的。\n'
    + '     ⇒ 多半有文件被 glob 漏掉了，或者某个文件加载就崩了。',
  )
}

// ── ⑤ 报告与退出码 ───────────────────────────────────────────────────────
// ⚠️ **退出码的语义**（两件事都要报）：
//   · 测试**真的失败**了（testCode ≠ 0）⇒ 退出码非 0（正常失败）
//   · 测试"没跑起来"（problems）      ⇒ 退出码非 0（**这是本工具的职责**）
if (problems.length) {
  console.log('\n🔴 assert-ran：**测试没有真的跑起来**\n')
  for (const p of problems) console.log('   ' + p + '\n')
  console.log('   依据：docs/standards/08-dod.md §五「三个看起来做完但其实没有的形态」')
  console.log('        · **假绿** —— 测试绿，但它根本没跑到你改的东西\n')
  process.exit(1)
}

if (!QUIET && ranTests !== null) {
  console.log('\n✅ 测试真的跑了：磁盘上 ' + onDisk.length + ' 个文件 / 实际跑到 '
    + ranTests + ' 条（pass ' + ranPass + ' / fail ' + ranFail + '）')
  console.log('   ⚠️ 本工具只证明「**runner 真的加载并执行了测试**」。')
  console.log('      它**不证明**测试覆盖了你改的东西 —— 那要看 docs/standards/02-evidence.md。')
}

process.exit(testCode)
