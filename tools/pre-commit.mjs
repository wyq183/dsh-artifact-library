#!/usr/bin/env node
/**
 * pre-commit 钩子（原生 git hook，零依赖）
 * ══════════════════════════════════════════════════════════════════════════
 * 【装法】仓库根跑一次：
 *     node tools/install-hooks.mjs
 *   （或手工：把本文件复制到 `.git/hooks/pre-commit` 并 `chmod +x`）
 *
 * 【为什么有它】
 * `ARCHITECTURE.md` §8.3 第 19 条 + `docs/SUBMIT-CHECKLIST.md` B3 明令：
 *   > **共享工作区禁用 `git add -A` / `commit -a`** ——
 *   > 当晚用 `git add -A` 提交文档时，**把队友尚未提交的 `lib/client.js` 改动一起带走了**，
 *   > 结果 `git log -S <符号>` **只会命中一笔讲文档的提交**，
 *   > **没有任何一笔说明"为什么会有那段代码"**（第五类失效：**归因丢失**）。
 *
 * ⚠️ **但这条规矩立了之后零守卫** —— 全靠自觉。
 *   本文件把它变成**物理条件**（§8.3-19 原话："把纪律变成物理条件"）。
 *
 * ⚠️⚠️ **诚实的边界**：
 *   · `git commit --no-verify` **能绕过它** —— 本地钩子**不是安全边界**；
 *   · 真正的强制点是 **CI + 分支保护**（尚未建）。
 *   ⇒ 它的价值是**在你要犯错的当下提醒你**，不是"不可能违反"。
 *     这是**有意的取舍**：本地钩子便宜、即时；CI 强但慢。
 *
 * 【它查什么】
 *   ① **暂存区里有没有"不是你正在做的那些文件"** ——
 *      即：暂存的文件里，有没有**别的 agent 可能正在写**的共享大文件
 *      （`lib/client.js` / `lib/store.js` / `test/` 下的文件…），
 *      而你这次提交的主题看起来跟它无关。
 *   ② **暂存文件数是不是异常多**（一次提交几十个文件 = 可疑）。
 *   ③ **有没有把 `.env` / 凭据 / 大文件**带进去。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
process.chdir(REPO)

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

let problems = []
let warnings = []

// ── 取暂存区 ──────────────────────────────────────────────────────────────
let staged = []
try {
  staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
} catch {
  console.log('pre-commit: 取暂存区失败，跳过检查')
  process.exit(0)
}
if (staged.length === 0) process.exit(0)

// ── ① 共享工作区：暂存了"别人可能正在写"的文件吗 ────────────────────────
// ⚠️ 这些文件是**多个 agent 共用的热点**（本仓库是共享工作区）。
//    不是"不许提交它们"，而是"提交它们时**要意识到**可能在带走别人的改动"。
const HOT_FILES = [
  'lib/client.js', 'lib/store.js', 'lib/tools.js', 'lib/settings.js',
  'lib/http.js', 'lib/platform.js',
]

const hotStaged = staged.filter((f) => HOT_FILES.includes(f))

// ⚠️⚠️ **判据改了两次，两次都是我自己造的错**（记下来当反例）：
//
//   第一版：`nonHot.every(f => f.endsWith('.md'))` —— 要求"其余全是 md"。
//     ⇒ 反向对照时（`git add docs/README.md lib/client.js` + 另外两个残留文件）
//       **它不响** ⇒ **空转的守卫**（这正是 `03-assertions.md` §零 说的最坏形态）。
//
//   第二版（当前）：**看暂存区跨越了几个"区域"**。
//     理由：`git add -A` 的**特征**就是**把互不相关的区域一起扫进来**
//     （docs/ + lib/ + test/ + tools/ 同时出现）。
//     ⇒ 单区域的提交（哪怕含热点文件）是**正常开发**；
//       跨 ≥3 个区域 + 含热点文件 = **像 `-A` 干的**，值得拦一下确认。
//
//   ⭐ **这才是"追语义"而不是"查关键词"**（`03-assertions.md` §一）：
//     我不再问"它是不是 md"，而是问"**这次提交像不像一次有意的、单主题的改动**"。
const areaOf = (f) => (f.includes('/') ? f.split('/')[0] : '(根)')
const areas = new Set(staged.map(areaOf))

if (hotStaged.length > 0 && areas.size >= 3) {
  problems.push(
    '这次暂存**跨越了 ' + areas.size + ' 个区域**（' + [...areas].join(' / ') + '），\n'
    + '      而且里面含**共享热点文件**：\n'
    + hotStaged.map((f) => '        · ' + f).join('\n') + '\n'
    + '      ⇒ 这个形态很像 **`git add -A` 把互不相关的改动一起扫了进来** ——\n'
    + '        正是 §8.3 第 19 条那次事故：`git add -A` 带走队友**尚未提交**的改动，\n'
    + '        结果 `git log -S <符号>` 只会命中一笔讲文档的提交，**"为什么有那段代码"查不到**。\n'
    + '      ⇒ 确认这些改动**都是你刚写的**吗？\n'
    + '        · 是 → `git commit --no-verify`（并知道你在绕过什么）\n'
    + '        · 不是 → 把它们从暂存区拿出来：`git restore --staged <路径>`',
  )
}

// ── ② 暂存文件数异常多 ────────────────────────────────────────────────────
if (staged.length >= 25) {
  warnings.push(
    '这次暂存了 **' + staged.length + ' 个文件** —— 一笔提交带这么多，多半夹带了无关改动。\n'
    + '      ⇒ 想拆就 `git restore --staged <路径>`；确实是一件事就忽略这条。',
  )
}

// ── ③ 凭据 / 大文件 ──────────────────────────────────────────────────────
const SECRET_RE = /(^|\/)(\.env($|\.)|[^/]*\.pem$|[^/]*\.key$|id_rsa|credentials\.json|\.npmrc)$/i
const secrets = staged.filter((f) => SECRET_RE.test(f))
if (secrets.length) {
  problems.push('暂存区里有**看起来像凭据**的文件：\n' + secrets.map((f) => '        · ' + f).join('\n')
    + '\n      ⇒ 凭据绝不进仓库。')
}

const BIG = 5 * 1024 * 1024
const big = []
for (const f of staged) {
  try {
    const st = fs.statSync(path.join(REPO, f))
    if (st.size > BIG) big.push(f + '（' + Math.round(st.size / 1024 / 1024) + ' MB）')
  } catch { /* 删除的文件跳过 */ }
}
if (big.length) {
  warnings.push('暂存区里有**大文件**（>5 MB）：\n' + big.map((f) => '        · ' + f).join('\n')
    + '\n      ⇒ 确认这是有意的（二进制产物/素材），否则别提交。')
}

// ── 报告 ──────────────────────────────────────────────────────────────────
if (problems.length === 0 && warnings.length === 0) process.exit(0)

if (warnings.length) {
  console.log('\n⚠️  pre-commit 提醒（不阻断）：\n')
  for (const w of warnings) console.log('   ' + w + '\n')
}
if (problems.length) {
  console.log('\n🔴 pre-commit 拦下这次提交：\n')
  for (const p of problems) console.log('   ' + p + '\n')
  console.log('   ────────────────────────────────────────────────')
  console.log('   确实要提交就加 `--no-verify`（**并知道你在绕过什么**）。')
  console.log('   ⚠️ 本地钩子不是安全边界 —— 真正的强制点是 CI + 分支保护（尚未建）。')
  console.log('   依据：RULES.md §1.3「不许用 git add -A」\n')
  process.exit(1)
}
process.exit(0)
