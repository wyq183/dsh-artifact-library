#!/usr/bin/env node
/**
 * 装 git hooks（零依赖，不用 husky）
 * ══════════════════════════════════════════════════════════════════════════
 * 【为什么不用 husky】
 * 调研结论（`调研-开发规范/通用/开发规范结论.md`）：
 *   > `husky` / `lint-staged` 挂本地 git hook，`--no-verify` 一按就绕过；
 *   > **AI agent 提交时更容易顺手加这个 flag**。
 *   > 唯一不可绕过的点是 **CI + 分支保护**。
 * ⇒ 既然本地钩子**本来就不是安全边界**，就没必要为它引入一个依赖
 *   （husky 要 `prepare` 脚本 + 一个 npm 包 + 可能的 Windows 路径问题）。
 *   原生 `.git/hooks/` + 一个薄 wrapper 足够。
 *
 * ⚠️ **但要知道本地钩子的定位**：
 *   它是**在你要犯错的当下提醒你**，不是"不可能违反"。
 *   真正的强制点仍是 CI + 分支保护（**尚未建**）。
 *
 * 【用法】仓库根跑一次：
 *     node tools/install-hooks.mjs
 *   它会写 `.git/hooks/pre-commit`（一个薄 wrapper，调 `tools/pre-commit.mjs`）。
 *   ⚠️ `.git/hooks/` **不进版本控制** ⇒ 换机器/重新 clone 后要**再跑一次**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const HOOKS = path.join(REPO, '.git', 'hooks')
if (!fs.existsSync(HOOKS)) {
  console.error('🔴 找不到 .git/hooks —— 这里不是 git 仓库根？')
  process.exit(1)
}

const HOOK_PATH = path.join(HOOKS, 'pre-commit')
const WRAPPER = `#!/bin/sh
# 本文件由 tools/install-hooks.mjs 生成 —— 别手改（改了会被覆盖）。
# 真正的逻辑在 tools/pre-commit.mjs（那才是进版本控制、可评审的）。
#
# ⚠️ 绕过方式：git commit --no-verify
#    —— 能绕过是**有意的**（本地钩子不是安全边界，见 tools/install-hooks.mjs 的注释）。
exec node "$(git rev-parse --show-toplevel)/tools/pre-commit.mjs"
`

if (fs.existsSync(HOOK_PATH)) {
  const cur = fs.readFileSync(HOOK_PATH, 'utf8')
  if (!cur.includes('tools/pre-commit.mjs')) {
    console.log('⚠️  .git/hooks/pre-commit 已存在，且**不是本工具生成的**。')
    console.log('    内容前 5 行：')
    console.log(cur.split('\n').slice(0, 5).map((l) => '      ' + l).join('\n'))
    console.log('')
    console.log('    ⇒ **没有覆盖它。** 要装就手工把下面这行加进去：')
    console.log('      exec node "$(git rev-parse --show-toplevel)/tools/pre-commit.mjs"')
    process.exit(1)
  }
}

fs.writeFileSync(HOOK_PATH, WRAPPER.replace(/\n/g, '\n'), { mode: 0o755 })
try { fs.chmodSync(HOOK_PATH, 0o755) } catch { /* Windows 上 chmod 是 no-op */ }

console.log('✅ 已装 pre-commit 钩子：' + HOOK_PATH)
console.log('')
console.log('   它拦什么：')
console.log('     · 文档提交里混进共享热点文件（lib/client.js 等）—— §8.3 第 19 条那次事故的形态')
console.log('     · 暂存了 ≥25 个文件（可疑）')
console.log('     · 凭据文件 / >5 MB 的大文件')
console.log('')
console.log('   ⚠️ 绕过：git commit --no-verify（**能绕过是有意的** —— 本地钩子不是安全边界）')
console.log('   ⚠️ .git/hooks/ 不进版本控制 ⇒ 换机器后要**再跑一次本脚本**')
