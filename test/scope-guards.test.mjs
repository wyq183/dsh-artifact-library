/**
 * 范围守卫测试（2026-09-30 真机僵死事故后补）
 *
 * 覆盖三件事：
 *   ① collectNoiseExcludes —— 能不能找出 node_modules 这类目录，且**不深入内部**（剪枝）
 *   ② measureDir —— 规模估算与「超限提前返回」
 *   ③ buildIni —— 排除列表有没有写进官方支持的 exclude_folders
 *
 * 背景（为什么这些断言重要）：
 *   实测对照 —— 501 项以下的目录正常；41 万项的 .dsh\profiles 会让
 *   Everything **启动即僵死**（CPU≈0%、库不生成、IPC 不响应）；
 *   加上 exclude_folders 排掉 node_modules 后**立刻恢复正常**。
 *   换句话说：这些函数一旦失效，用户一装插件就会遇到实例僵死。
 *
 * 用法：node test/scope-guards.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectNoiseExcludes, measureDir, NOISE_DIR_NAMES, SCOPE_ITEM_LIMIT } from '../lib/index/scope.js'
import { buildIni } from '../lib/index/ini.js'

let passed = 0
let failed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    failures.push(name + ' → ' + (error && error.message ? error.message : String(error)))
    console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error)))
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

// ── 造测试目录树 ─────────────────────────────────────────────────────────
const root = path.join(os.tmpdir(), 'alf-guard-test')
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true })
fs.mkdirSync(path.join(root, 'node_modules', 'pkg-a', 'deep', '.git'), { recursive: true }) // 内部那个 .git 不该被发现（剪枝）
fs.mkdirSync(path.join(root, 'sub', 'node_modules'), { recursive: true })
fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true })
fs.mkdirSync(path.join(root, '__pycache__'), { recursive: true })
fs.writeFileSync(path.join(root, 'a.txt'), 'x')
fs.writeFileSync(path.join(root, 'src', 'b.txt'), 'y')

console.log('\n=== [1] collectNoiseExcludes ===')
const excludes = collectNoiseExcludes([root], { maxDepth: 3 })
const lower = excludes.map((d) => d.toLowerCase())

check('找出根下的 node_modules', () => {
  assert(lower.includes(path.join(root, 'node_modules').toLowerCase()), '未找到: ' + JSON.stringify(excludes))
})
check('找出 .git 与 __pycache__', () => {
  assert(lower.includes(path.join(root, '.git').toLowerCase()), '未找到 .git')
  assert(lower.includes(path.join(root, '__pycache__').toLowerCase()), '未找到 __pycache__')
})
check('★ 找出深一层的 sub\\node_modules（递归有效）', () => {
  assert(lower.includes(path.join(root, 'sub', 'node_modules').toLowerCase()), '未找到深层 node_modules: ' + JSON.stringify(excludes))
})
check('★ 命中即剪枝：node_modules 内部的 .git 不该被列出', () => {
  const inner = lower.find((d) => d.includes('pkg-a'))
  assert(!inner, '不该深入 node_modules 内部，却列出了: ' + inner)
})
check('正常目录（src）不被误排除', () => {
  assert(!lower.includes(path.join(root, 'src').toLowerCase()), 'src 被误排除')
})
check('多个范围目录都会扫（含去重）', () => {
  const twice = collectNoiseExcludes([root, root], { maxDepth: 3 })
  assert(twice.length === excludes.length, '重复范围应去重，得到 ' + twice.length + ' vs ' + excludes.length)
})
check('不存在的目录不会抛异常', () => {
  const r = collectNoiseExcludes(['C:\\__definitely_not_here__'], { maxDepth: 2 })
  assert(Array.isArray(r) && r.length === 0, '应返回空数组')
})
check('空输入安全', () => {
  assert(collectNoiseExcludes(null).length === 0, 'null')
  assert(collectNoiseExcludes([]).length === 0, '空数组')
})
check('NOISE_DIR_NAMES 覆盖关键项', () => {
  const set = new Set(NOISE_DIR_NAMES.map((n) => n.toLowerCase()))
  for (const n of ['node_modules', '.git', '.pnpm', '__pycache__', 'dist', 'build']) {
    assert(set.has(n), '缺少: ' + n)
  }
})

console.log('\n=== [2] measureDir ===')
check('小目录：不截断，计数正确', () => {
  const r = measureDir(root)
  assert(r.truncated === false, '不该截断: ' + JSON.stringify(r))
  assert(r.count >= 8, '计数偏小: ' + JSON.stringify(r))
  assert(r.elapsedMs >= 0, 'elapsedMs 异常')
})
check('★ 超过 limit → 提前返回 truncated（不会为超大目录遍历到底）', () => {
  const r = measureDir(root, { limit: 2 })
  assert(r.truncated === true, '应截断: ' + JSON.stringify(r))
  assert(r.count > 2, '应在超限后仍报告已数到的量: ' + JSON.stringify(r))
})
check('★ deadline 到点也会提前返回（防卡死）', () => {
  const r = measureDir(root, { limit: 10 ** 9, deadlineMs: 0 })
  assert(r.truncated === true, 'deadlineMs=0 应立即截断: ' + JSON.stringify(r))
})
check('不存在的目录安全返回', () => {
  const r = measureDir('C:\\__definitely_not_here__')
  assert(typeof r.count === 'number' && r.count === 0, '应返回 count=0: ' + JSON.stringify(r))
})
check('SCOPE_ITEM_LIMIT 是个合理量级', () => {
  assert(SCOPE_ITEM_LIMIT >= 10000 && SCOPE_ITEM_LIMIT <= 500000, 'limit = ' + SCOPE_ITEM_LIMIT)
})

console.log('\n=== [3] buildIni 写入 exclude_folders ===')
check('有排除时写进 exclude_folders', () => {
  const ini = buildIni({ scopeDirs: ['C:\\a'], excludeDirs: ['C:\\a\\node_modules', 'C:\\a\\.git'], dbDir: 'D:\\db' })
  const line = ini.split('\r\n').find((l) => l.startsWith('exclude_folders='))
  assert(line === 'exclude_folders=C:\\a\\node_modules,C:\\a\\.git', '得到: ' + line)
})
check('没有排除时写空值（而不是省略该行）', () => {
  const ini = buildIni({ scopeDirs: ['C:\\a'], dbDir: '' })
  assert(ini.includes('exclude_folders=\r\n'), '应写空的 exclude_folders 行')
})
check('原有的范围限定键没被破坏（回归）', () => {
  const ini = buildIni({ scopeDirs: ['C:\\a'], excludeDirs: [], dbDir: '' })
  for (const key of ['auto_include_fixed_volumes=0', 'ntfs_volume_paths=\r\n', 'folders=C:\\a']) {
    assert(ini.includes(key), '缺少: ' + key)
  }
})
check('排除路径含逗号时正确加引号', () => {
  const ini = buildIni({ scopeDirs: ['C:\\a'], excludeDirs: ['C:\\a,b'], dbDir: '' })
  const line = ini.split('\r\n').find((l) => l.startsWith('exclude_folders='))
  assert(line.includes('"'), '含逗号的排除路径应加引号: ' + line)
})

console.log('\n=== [4] 真实场景抽样（本机 .dsh，若存在）===')
const realDsh = 'C:\\Users\\Administrator\\.dsh'
if (fs.existsSync(realDsh)) {
  check('★ 在本机 .dsh 上能找出大量噪音目录', () => {
    const found = collectNoiseExcludes([realDsh], { maxDepth: 3 })
    assert(found.length >= 3, '只找到 ' + found.length + ' 个，可疑')
    const nm = found.filter((d) => d.toLowerCase().endsWith('node_modules'))
    assert(nm.length >= 1, '没找到任何 node_modules')
    console.log('        找到 ' + found.length + ' 个噪音目录，其中 node_modules ' + nm.length + ' 个')
  })
} else {
  console.log('  (跳过：本机没有 ' + realDsh + ')')
}

fs.rmSync(root, { recursive: true, force: true })

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
