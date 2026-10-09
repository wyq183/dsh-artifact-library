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
const num = (label) => {
  const m = out.match(new RegExp('^\\u2139 ' + label + ' (\\d+)\\s*$', 'm'))
  return m ? Number(m[1]) : null
}
const ranTests = num('tests')
const ranPass = num('pass')
const ranFail = num('fail')

// ── ④ 对账 ────────────────────────────────────────────────────────────────
const problems = []

if (ranTests === null) {
  problems.push(
    '从输出里**读不到 `ℹ tests N`** —— 说明 Node 的汇总格式变了，\n'
    + '     本工具的判据（正则 `^ℹ tests (\\d+)$`）**已失效**。\n'
    + '     ⚠️ **读不到不能当成通过** —— 读不到就是读不到，得修判据。',
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
