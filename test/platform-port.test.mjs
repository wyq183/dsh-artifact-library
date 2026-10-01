/**
 * 离线 harness：跨平台适配（Windows + Linux）
 *
 * 这个文件钉的是**「换个操作系统就坏」这一类问题**，尤其是那些
 * 「手动点一遍看着正常、换台机器直接出事」的：
 *
 *   [3] ★★★ 最重要的一条：非 Windows 上启动外部程序失败，**绝不能打崩宿主**。
 *       改造前 `spawn('explorer.exe', …)` 在 Linux 上抛未处理的 `'error'` 事件，
 *       Node **直接 abort（EXIT=1）** —— `try/catch` 抓不到，整个 dsh web 退出。
 *       这里用**子进程**对照实验证明：同样的写法「不挂监听 = 进程死 / 挂监听 = 活着」。
 *       （写在同一个进程里测不出来：真出事的话测试进程自己就没了，只剩一个空输出。）
 *
 *   [1][2] 路径语义按**路径形态**分流，而不是按当前操作系统 —— 跨平台迁移过来的
 *          `C:\…` 记录在 Linux 上仍按 Windows 语义解析，`/…` 则严格区分大小写。
 *
 *   [4] 「在文件管理器里定位」的三平台写法与其**回退链**（Linux 用 PATH 桩验证，
 *       不真的弹窗、不启动任何桌面程序）。
 *
 *   [6][7] 纯 Node 便携后端：Everything 缺失时 Linux 上照样能搜，且**不是另一套语义**。
 *
 * 用法：node test/platform-port.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  IS_LINUX, IS_WINDOWS, CASE_INSENSITIVE_PATHS, looksLikeWindowsPath, pathApiFor,
  canonicalPathKey, compareForm, dirnameAuto, isAbsoluteAuto, whichSync, spawnSoft,
  runOnce, revealPath, openPath, userCacheRoot, platformCapabilities, fileManagerName,
} from '../lib/platform.js'
import {
  canonical, isInside, normalizeScope, dirsFromArtifacts,
} from '../lib/index/scope.js'
import { compileQuery, sortRows, parseSize, compileSizeSpec, compileTimeSpec } from '../lib/index/query.js'
import { createFileIndex } from '../lib/index/engine.js'
import { artifactsHandler } from '../lib/http.js'
import { checkImportRoot, isSensitivePath } from '../lib/store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-platform-'))

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
async function checkAsync(name, fn) {
  try {
    await fn()
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

// ═══ [1] 路径形态判定（不依赖当前操作系统）═══════════════════════════════
console.log('\n=== [1] 路径形态判定：按形态分流，不按当前操作系统 ===')
{
  check('盘符路径 / UNC 被认成 Windows 形态', () => {
    for (const p of ['C:\\a', 'c:/a', 'D:\\', '\\\\server\\share\\x', 'C:']) {
      assert(looksLikeWindowsPath(p), p + ' 没被认成 Windows 形态')
    }
  })
  check('POSIX 路径不被认成 Windows 形态', () => {
    for (const p of ['/home/a', '/mnt/c/a', 'relative/x', './x', '']) {
      assert(!looksLikeWindowsPath(p), p + ' 被误判成 Windows 形态')
    }
  })
  check('★ 大小写折叠只发生在 Windows 形态上（Linux 形态被误折叠会合并真实目录）', () => {
    assert(canonicalPathKey('C:\\Proj\\') === canonicalPathKey('c:\\proj'), 'Windows 形态没折叠')
    assert(canonicalPathKey('/home/A') !== canonicalPathKey('/home/a'), 'POSIX 形态被折叠了 —— 会合并两个真实目录')
  })
  check('形态感知的 dirname：Windows 形态路径在 Linux 上也能解析对', () => {
    // 这条是关键：path.dirname('C:\\a\\b.txt') 在 Linux 上返回 '.'，会把索引范围退化成 cwd
    assert(dirnameAuto('C:\\a\\b.txt') === 'C:\\a', 'actual: ' + dirnameAuto('C:\\a\\b.txt'))
    assert(dirnameAuto('/a/b.txt') === '/a', 'actual: ' + dirnameAuto('/a/b.txt'))
  })
  check('形态感知的 isAbsolute', () => {
    assert(isAbsoluteAuto('C:\\a') === true, 'Windows 形态被判成非绝对路径')
    assert(isAbsoluteAuto('/a') === true, 'POSIX 绝对路径没认出来')
    assert(isAbsoluteAuto('a') === false, '相对路径被认成绝对')
  })
  check('platformCapabilities 自洽（后端选择与平台一致）', () => {
    const caps = platformCapabilities()
    assert(caps.fileSearchBackend === (IS_WINDOWS ? 'everything' : 'node'), 'backend: ' + caps.fileSearchBackend)
    assert(caps.caseInsensitivePaths === CASE_INSENSITIVE_PATHS, '大小写标志不一致')
    assert(typeof fileManagerName() === 'string' && fileManagerName().length > 0, '文件管理器名字为空')
  })
  check('userCacheRoot 落在用户缓存目录（不是 dataDir，避免索引自引用）', () => {
    const root = userCacheRoot()
    assert(root && path.isAbsolute(root), '得到 ' + root)
    assert(!root.includes('.dsh'), '缓存目录落在 .dsh 里了 —— 会变成索引自引用: ' + root)
  })
}

// ═══ [2] 范围与安全判据的形态语义 ════════════════════════════════════════
console.log('\n=== [2] 范围/安全判据：形态语义 ===')
{
  check('★★ normalizeScope 不再丢掉 Windows 形态路径（原来返回空数组）', () => {
    const out = normalizeScope(['C:\\a', 'C:\\a\\b'])
    assert(out.length === 1 && out[0].toLowerCase() === 'c:\\a', '得到 ' + JSON.stringify(out))
  })
  check('★★ normalizeScope 不再合并大小写不同的真实目录', () => {
    // ⚠️ 这条断言**按平台分开写**，因为「大小写不同的两个目录」在两个平台上的
    //    正确答案本来就不一样：POSIX 是两个不同目录，Windows 是同一个。
    //    第一版只写了 POSIX 版，于是它在 Windows 上必然假红 —— 而假红比没有更坏
    //    （会让人以为 Windows 支持坏了）。
    if (IS_WINDOWS) {
      const out = normalizeScope(['C:\\Home\\A', 'c:\\home\\a'])
      assert(out.length === 1, 'Windows 形态本应折叠成一个，得到 ' + JSON.stringify(out))
      return
    }
    const out = normalizeScope(['/home/A', '/home/a'])
    assert(out.length === 2, '被合并成 ' + JSON.stringify(out))
  })
  check('★ isInside 不再放宽安全闸门', () => {
    if (IS_WINDOWS) {
      // Windows 语义不变（大小写不敏感）
      assert(isInside('C:\\Home\\A\\x', 'c:\\home\\a') === true, 'Windows 大小写语义被改坏了')
      return
    }
    assert(isInside('/home/A/x', '/home/a') === false, '★ 越界闸门被放宽了')
    assert(isInside('/home/a/x', '/home/a') === true, '/home/a/x 应属于 /home/a')
    assert(isInside('/home/a', '/home/a') === true, '自身应算包含')
  })
  check('Windows 语义不变：C:\\A\\x 仍属于 c:\\a', () => {
    assert(isInside('C:\\A\\x', 'c:\\a') === true, 'Windows 大小写语义被改坏了')
  })
  check('★ dirsFromArtifacts 不会把 Windows 路径退化成 "."', () => {
    const out = dirsFromArtifacts([{ path: 'C:\\a\\b.txt' }])
    assert(out.length === 1 && out[0] === 'C:\\a', '得到 ' + JSON.stringify(out))
  })
  check('★ canonical 与安全判据共用同一套（凭据目录任意层级）', () => {
    assert(canonical('/x/.SSH/') === '/x/.SSH', 'canonical: ' + canonical('/x/.SSH/'))
    assert(isSensitivePath('/home/u/.ssh/id_rsa') === true, '凭据路径没拦住')
  })
}

// ═══ [3] ★★★ 回归守卫：启动外部程序失败不能打崩宿主 ════════════════════
console.log('\n=== [3] ★★★ 启动失败不打崩宿主（回归守卫）===')
{
  const MISSING = 'alf-definitely-missing-binary-' + Date.now()
  const child = (body) => spawnSync(process.execPath, ['-e', body], { encoding: 'utf8', timeout: 15000 })

  check('★★★ 对照：不挂 error 监听 → 子进程**直接 abort（非 0 退出）**', () => {
    const r = child(`
      const { spawn } = require('node:child_process')
      const c = spawn(${JSON.stringify(MISSING)}, [], { detached: true, stdio: 'ignore' })
      c.unref()
      setTimeout(() => { console.log('still alive') }, 500)
    `)
    assert(r.status !== 0, '竟然正常退出了 —— 说明这个缺陷已经不复现，守卫失去意义，需要重写')
    assert(/Unhandled 'error' event/.test(r.stderr || ''), 'stderr 里没有未处理 error 事件: ' + (r.stderr || '').slice(0, 200))
  })

  check('★★★ 挂上 error 监听 → 子进程正常活着（这就是解药）', () => {
    const r = child(`
      const { spawn } = require('node:child_process')
      const c = spawn(${JSON.stringify(MISSING)}, [], { detached: true, stdio: 'ignore' })
      c.on('error', () => {})
      c.unref()
      setTimeout(() => { console.log('still alive') }, 500)
    `)
    assert(r.status === 0, '仍然退出了，status=' + r.status + ' stderr=' + (r.stderr || '').slice(0, 200))
    assert(/still alive/.test(r.stdout || ''), '没等到存活输出')
  })

  await checkAsync('★ spawnSoft 对不存在的程序返回结构化失败，且**不抛不打崩**', async () => {
    const r = await spawnSoft(MISSING, [])
    assert(r.ok === false, '竟然报成功了')
    assert(r.code === 'ENOENT' || r.code === 'spawn-error', 'code=' + r.code + ' error=' + r.error)
    assert(typeof r.error === 'string' && r.error.length > 0, '没有错误说明')
  })

  await checkAsync('★ runOnce 对不存在的程序同样安全', async () => {
    const r = await runOnce(MISSING, [], 2000)
    assert(r.ok === false, '竟然报成功了')
    assert(typeof r.error === 'string' && r.error.length > 0, '没有错误说明')
  })

  check('http.js 里不再有裸 spawn（否则缺陷会从别处回来）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'http.js'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    assert(!/\bspawn\s*\(/.test(code), '★ http.js 又出现了直接 spawn —— 非 Windows 上会打崩宿主')
    assert(/from '\.\/platform\.js'/.test(code), 'http.js 没走平台接缝层')
  })

  check('★ 全 lib/ 里除 platform.js 外无人直接 spawn（接缝没有旁路）', () => {
    const offenders = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!entry.name.endsWith('.js')) continue
        const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\\/g, '/')
        if (rel === 'platform.js') continue
        const code = fs.readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
        if (/\b(?:spawn|exec|execFile|fork)\s*\(/.test(code) && /from 'node:child_process'/.test(code)) {
          // ⚠️ 这三个是 **Everything 专用路径，只在 Windows 上运行**，允许它们直接起子进程：
          //    es.js       —— 调 es.exe 查询
          //    engine.js   —— 拉 Everything 实例 / 探测 IPC（且整个 Everything 实现刻意留在
          //                   engine.js 里，因为有一组按函数名切片的源码守卫盯着它）
          //    selftest.js —— Everything 的离线自验脚本，非 Windows 上已在文件头显式早退
          if (rel === 'index/es.js' || rel === 'index/engine.js' || rel === 'index/selftest.js') continue
          offenders.push(rel)
        }
      }
    }
    walk(path.join(ROOT, 'lib'))
    assert(offenders.length === 0, '这些文件绕过了平台接缝层直接起子进程: ' + offenders.join(', '))
  })
}

// ═══ [4] 定位 / 打开：三平台写法与回退链 ══════════════════════════════════
console.log('\n=== [4] 定位/打开：命令构造与回退 ===')
if (!IS_LINUX) {
  check('（非 Linux：Linux 专用回退链跳过的断言）', () => {
    assert(true)
  })
} else {
  const originalPath = process.env.PATH
  const stubRoot = path.join(TMP, 'stubs')

  /** 造一个记录调用参数、按指定退出码结束的桩程序 */
  function makeStub(dirName, toolName, exitCode = 0) {
    const dir = path.join(stubRoot, dirName)
    fs.mkdirSync(dir, { recursive: true })
    const logFile = path.join(dir, 'calls.log')
    const file = path.join(dir, toolName)
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\nexit ${exitCode}\n`, 'utf8')
    fs.chmodSync(file, 0o755)
    return { dir, logFile }
  }
  const readLog = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
  /**
   * 等桩程序把调用写进日志。
   *
   * ⚠️ 必须等：`spawnSoft` 是**分离进程**（`detached` + 只在 `'spawn'` 事件就返回），
   * 断言时子进程可能还没跑到写日志那一行 —— 第一版就是直接读，结果偶发空日志。
   * 这里轮询到出现为止（拿到就立刻返回，不白等）。
   */
  async function waitForLog(file, needle, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const text = readLog(file)
      if (!needle || text.includes(needle)) return text
      if (Date.now() > deadline) return text
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  const target = path.join(TMP, '作品 带空格', '图 1.png')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'x')

  await checkAsync('Linux：优先用 D-Bus FileManager1.ShowItems（能真的「选中」）', async () => {
    const gdbus = makeStub('a', 'gdbus', 0)
    makeStub('a', 'xdg-open', 0)
    process.env.PATH = gdbus.dir
    try {
      const r = await revealPath(target)
      assert(r.ok === true, JSON.stringify(r))
      assert(r.method === 'gdbus', 'method=' + r.method)
      const log = await waitForLog(gdbus.logFile, 'ShowItems')
      assert(/org\.freedesktop\.FileManager1\.ShowItems/.test(log), '没调 ShowItems: ' + log)
      assert(/file:\/\/\//.test(log), '没传 file URI: ' + log)
    } finally { process.env.PATH = originalPath }
  })

  await checkAsync('Linux：D-Bus 失败 → 回退「打开所在目录」并如实标记 degraded', async () => {
    const gdbus = makeStub('b', 'gdbus', 1) // D-Bus 调用失败
    const xdg = makeStub('b', 'xdg-open', 0)
    process.env.PATH = gdbus.dir
    try {
      const r = await revealPath(target)
      assert(r.ok === true, JSON.stringify(r))
      assert(r.method === 'xdg-open(目录)', 'method=' + r.method)
      assert(r.degraded === true, '没标记降级')
      const log = await waitForLog(xdg.logFile, path.dirname(target))
      assert(log.includes(path.dirname(target)), '回退时没打开所在目录: ' + log)
    } finally { process.env.PATH = originalPath }
  })

  await checkAsync('Linux：完全没有启动器 → 结构化失败，不抛', async () => {
    const empty = path.join(stubRoot, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    process.env.PATH = empty
    try {
      const r = await revealPath(target)
      assert(r.ok === false && r.code === 'no-launcher', JSON.stringify(r))
      const r2 = await openPath(target)
      assert(r2.ok === false && r2.code === 'no-launcher', JSON.stringify(r2))
    } finally { process.env.PATH = originalPath }
  })

  await checkAsync('Linux：openPath 走 xdg-open，路径原样传入（含空格）', async () => {
    const xdg = makeStub('c', 'xdg-open', 0)
    process.env.PATH = xdg.dir
    try {
      const r = await openPath(target)
      assert(r.ok === true, JSON.stringify(r))
      const log = await waitForLog(xdg.logFile, target)
      assert(log.includes(target), '路径没原样传入: ' + log)
    } finally { process.env.PATH = originalPath }
  })

  check('whichSync 只认真实存在的可执行文件', () => {
    const probe = makeStub('d', 'my-probe-tool', 0)
    process.env.PATH = probe.dir
    try {
      assert(whichSync('my-probe-tool') !== '', '存在的工具没找到')
      assert(whichSync('my-probe-tool-不存在') === '', '不存在的工具被找到了')
    } finally { process.env.PATH = originalPath }
  })
}

// ═══ [5] 查询编译器（Everything 语法语义不变）════════════════════════════
console.log('\n=== [5] 查询编译器：Everything 语法 ===')
{
  const ROW = (over = {}) => ({
    path: '/p/a.md', name: 'a.md', dir: '/p', ext: 'md', isDirectory: false,
    size: 100, modified: Math.floor(Date.now() / 1000), created: Math.floor(Date.now() / 1000),
    ...over,
  })
  const test = (query, row) => compileQuery(query).predicate(row)

  check('空查询 = 全部', () => {
    assert(compileQuery('').predicate(ROW()) === true, '空查询没放行')
    assert(compileQuery('   ').groups === 0, '空查询应无子句')
  })
  check('★★ OR：`ext:md|ext:pdf` 是「或」不是「且」（第一版写错过）', () => {
    assert(test('ext:md|ext:pdf', ROW({ ext: 'md' })) === true, 'md 没命中')
    assert(test('ext:md|ext:pdf', ROW({ ext: 'pdf' })) === true, 'pdf 没命中')
    assert(test('ext:md|ext:pdf', ROW({ ext: 'jpg' })) === false, 'jpg 不该命中')
  })
  check('AND：空格连接的条件都要满足', () => {
    assert(test('ext:md 项目', ROW({ dir: '/p/项目' })) === true, '两个条件都满足却没命中')
    assert(test('ext:md 项目', ROW({ dir: '/p/other' })) === false, '只满足一个却命中了')
  })
  check('NOT：`!ext:js`', () => {
    assert(test('!ext:js', ROW({ ext: 'md' })) === true, '非 js 应命中')
    assert(test('!ext:js', ROW({ ext: 'js' })) === false, 'js 不该命中')
  })
  check('name: / path: 分别只匹配文件名与所在目录', () => {
    const row = ROW({ name: 'index.js', dir: '/p/项目A' })
    assert(test('name:index', row) === true, 'name 没命中')
    assert(test('name:项目A', row) === false, 'name 匹配到了目录（越界）')
    assert(test('path:项目A', row) === true, 'path 没命中')
    assert(test('path:index', row) === false, 'path 匹配到了文件名（越界）')
  })
  check('裸词匹配文件名**或**目录（用户的「第一直觉」）', () => {
    assert(test('index', ROW({ name: 'index.js' })) === true, '文件名没命中')
    assert(test('项目A', ROW({ dir: '/p/项目A' })) === true, '目录没命中')
  })
  check('大小写不敏感（搜索场景的常识）', () => {
    assert(test('name:README', ROW({ name: 'readme.md' })) === true, '大小写导致没命中')
  })
  check('通配符 * 与 ?', () => {
    assert(test('name:*.md', ROW({ name: 'a.md' })) === true, '*.md 没命中')
    assert(test('name:a?.md', ROW({ name: 'ab.md' })) === true, 'a?.md 没命中')
    assert(test('name:*.md', ROW({ name: 'a.txt' })) === false, '*.md 误命中 txt')
  })
  check('带引号的词不被空格切开', () => {
    assert(test('"说明 文档"', ROW({ name: '说明 文档.md' })) === true, '引号词没命中')
  })
  check('folder: / type:file 按类型', () => {
    assert(test('folder:', ROW({ isDirectory: true })) === true, 'folder: 没命中目录')
    assert(test('folder:', ROW({ isDirectory: false })) === false, 'folder: 误命中文件')
    assert(test('type:file', ROW({ isDirectory: false })) === true, 'type:file 没命中')
  })
  check('size: 比较与区间（1kb = 1024）', () => {
    assert(test('size:>10kb', ROW({ size: 20000 })) === true, '>10kb 没命中')
    assert(test('size:>10kb', ROW({ size: 100 })) === false, '>10kb 误命中')
    assert(test('size:1kb..10kb', ROW({ size: 5000 })) === true, '区间没命中')
    assert(test('size:1kb..10kb', ROW({ size: 1024 * 1024 })) === false, '区间误命中')
    assert(parseSize('1.5kb') === 1536, 'parseSize: ' + parseSize('1.5kb'))
    assert(parseSize('瞎写') === null, '非法体积应返回 null')
  })
  check('dm: 具名日期与比较', () => {
    const now = Date.now()
    assert(test('dm:today', ROW({ modified: Math.floor(now / 1000) })) === true, 'today 没命中')
    assert(test('dm:today', ROW({ modified: Math.floor((now - 5 * 86400000) / 1000) })) === false, 'today 误命中 5 天前')
    assert(test('dm:last7days', ROW({ modified: Math.floor((now - 3 * 86400000) / 1000) })) === true, 'last7days 没命中')
    assert(test('dm:>2020-01-01', ROW({ modified: Math.floor(now / 1000) })) === true, '日期比较没命中')
  })
  check('非法条件给出**能照做**的错误，而不是静默返回空', () => {
    const bad = compileQuery('size:>瞎写')
    assert(bad.ok === false, '非法 size 竟然通过了')
    assert(/例：/.test(bad.error), '错误信息没有例子: ' + bad.error)
    assert(compileQuery('type:未知').ok === false, '非法 type 竟然通过了')
  })
  check('排序：name/大小/时间，且**稳定**（并列按路径兜底）', () => {
    const rows = [
      { path: '/b', name: 'b', size: 2, modified: 2 },
      { path: '/a', name: 'a', size: 1, modified: 1 },
    ]
    assert(sortRows(rows, 'size')[0].name === 'a', 'size 排序错')
    assert(sortRows(rows, 'date-modified')[1].name === 'b', '时间排序错')
    assert(sortRows(rows, 'name')[0].name === 'a', 'name 排序错')
    assert(rows[0].name === 'b', '排序改动了入参（应该返回新数组）')
  })
}

// ═══ [6] 便携后端端到端（真实目录）═══════════════════════════════════════
console.log('\n=== [6] 纯 Node 便携后端：端到端 ===')
{
  const scope = path.join(TMP, 'scope')
  const dataDir = path.join(TMP, 'data')
  fs.mkdirSync(path.join(scope, '项目A', 'src'), { recursive: true })
  fs.mkdirSync(path.join(scope, '项目A', 'node_modules', '垃圾'), { recursive: true })
  fs.mkdirSync(path.join(scope, '项目B'), { recursive: true })
  fs.writeFileSync(path.join(scope, '项目A', '说明.md'), 'hello')
  fs.writeFileSync(path.join(scope, '项目A', '大图.png'), Buffer.alloc(20000))
  fs.writeFileSync(path.join(scope, '项目A', 'src', 'index.js'), 'x')
  fs.writeFileSync(path.join(scope, '项目A', 'node_modules', '垃圾', 'a.js'), 'x')
  fs.writeFileSync(path.join(scope, '项目B', '报告.pdf'), 'x')

  const logger = { info() {}, warn() {} }
  const index = createFileIndex({ dataDir, logger, backend: 'node' })
  const ready = await index.ensureReady({ scopeDirs: [scope] })

  check('构建成功，且**不依赖 Everything**', () => {
    assert(ready.ok === true, 'ensureReady: ' + JSON.stringify(ready.lastError))
    assert(index.backendName === 'node', 'backendName: ' + index.backendName)
  })
  check('★ 噪音目录被剪枝（node_modules 里的文件不进索引）', () => {
    const snap = index.snapshot()
    assert(snap.itemCount === 7, 'itemCount = ' + snap.itemCount + '（期望 7）')
    assert(snap.backend === 'node', 'status.backend = ' + snap.backend)
  })
  check('★ status 保持客户端契约字段（换后端不该让前端失明）', () => {
    const snap = index.snapshot()
    for (const k of ['phase', 'ready', 'now', 'elapsedMs', 'stalled', 'stallHintMs', 'cancellable', 'hint']) {
      assert(k in snap, '缺契约字段 ' + k)
    }
    assert(['stopped', 'starting', 'ready', 'error', 'idle'].includes(snap.phase), 'phase: ' + snap.phase)
  })

  await checkAsync('搜索：扩展名 / 或 / 非 / 目录 / 体积 / 时间', async () => {
    const cases = [
      ['ext:png', 1], ['ext:md|ext:pdf', 2], ['!ext:js', 6], ['name:index', 1],
      ['path:项目A', 4], ['size:>10kb', 1], ['dm:today', 7], ['folder:', 3], ['查无此物', 0],
    ]
    for (const [q, want] of cases) {
      const r = await index.search({ query: q, limit: 50 })
      assert(r.ok === true, `${q} 搜索失败: ${r.error}`)
      assert(r.total === want, `${q} 期望 ${want} 条，得到 ${r.total}`)
    }
  })

  await checkAsync('搜索：limit 生效且 truncated 如实', async () => {
    const r = await index.search({ query: '', limit: 3 })
    assert(r.rows.length === 3, '返回 ' + r.rows.length + ' 条')
    assert(r.total === 7, 'total = ' + r.total)
    assert(r.truncated === true, '没标记截断')
  })

  await checkAsync('搜索：非法条件 → 结构化失败（不是静默空结果）', async () => {
    const r = await index.search({ query: 'size:>瞎写' })
    assert(r.ok === false, '竟然报成功')
    assert(typeof r.error === 'string' && r.error.length > 0, '没有错误说明')
  })

  await checkAsync('目录浏览走**实时读盘**（刚建的文件立刻可见）', async () => {
    const dir = path.join(scope, '项目A')
    const before = await index.listDir(dir)
    assert(before.ok === true, JSON.stringify(before.error))
    fs.writeFileSync(path.join(dir, '刚建的.txt'), 'x')
    const after = await index.listDir(dir)
    assert(after.entries.some((e) => e.name === '刚建的.txt'), '刚建的文件没出现（又走回快照了？）')
    assert(after.source === 'fs', 'source=' + after.source)
    fs.rmSync(path.join(dir, '刚建的.txt'))
  })

  await checkAsync('范围变化 → 重建，新目录立即可搜', async () => {
    const extra = path.join(TMP, 'extra')
    fs.mkdirSync(extra, { recursive: true })
    fs.writeFileSync(path.join(extra, '独有文件.xyz'), 'x')
    const up = await index.ensureReady({ scopeDirs: [scope, extra], forceRestart: true })
    assert(up.ok === true, JSON.stringify(up.lastError))
    const r = await index.search({ query: 'name:独有文件' })
    assert(r.total === 1, '新范围没生效，total=' + r.total)
  })

  check('cancel() 不崩，且不把可用索引说成坏的', () => {
    const snap = index.cancel()
    assert(snap.cancellable === false, '取消后仍可取消')
    assert(['ready', 'stopped', 'idle'].includes(snap.phase), 'phase: ' + snap.phase)
  })

  // 快照复用：另起一个实例，范围相同 → 应复用而不是重扫
  await checkAsync('重启后复用索引快照（不必重扫）', async () => {
    const fresh = createFileIndex({ dataDir, logger, backend: 'node' })
    const up = await fresh.ensureReady({ scopeDirs: [scope, path.join(TMP, 'extra')] })
    assert(up.ok === true, 'ensureReady: ' + up.lastError)
    assert(fresh.snapshot().indexedAt != null, '没有 indexedAt')
    const r = await fresh.search({ query: 'name:独有文件' })
    assert(r.total === 1, '复用快照后搜不到: ' + r.total)
    await fresh.shutdown()
  })
}

// ═══ [7] 后端分流 ═══════════════════════════════════════════════════════
console.log('\n=== [7] 后端分流：Windows → Everything，其余 → Node ===')
{
  const dir = path.join(TMP, 'dispatch')
  fs.mkdirSync(dir, { recursive: true })
  const logger = { info() {}, warn() {} }

  check('显式指定 backend 时按指定来（测试/排查用）', () => {
    assert(createFileIndex({ dataDir: dir, logger, backend: 'node' }).backendName === 'node', 'node 分流错')
    assert(createFileIndex({ dataDir: dir, logger, backend: 'everything' }).backendName === 'everything', 'everything 分流错')
  })
  check('★ 缺省分流与平台一致（Linux 上不能去拉 Everything）', () => {
    const auto = createFileIndex({ dataDir: dir, logger }).backendName
    assert(auto === (IS_WINDOWS ? 'everything' : 'node'), '缺省后端: ' + auto)
  })
  check('★ 两个后端接口**同名同形**（上层不用改代码）', () => {
    const methods = ['status', 'ensureReady', 'cancel', 'search', 'listDir', 'updateScope', 'shutdown', 'snapshot']
    for (const backend of ['node', 'everything']) {
      const idx = createFileIndex({ dataDir: dir, logger, backend })
      for (const m of methods) assert(typeof idx[m] === 'function', `${backend} 缺方法 ${m}`)
    }
  })
}

// ═══ [8] http 层：定位/打开的成功分支（原来**零覆盖**）═══════════════════
console.log('\n=== [8] http 定位/打开：成功与失败分支 ===')
{
  const realFile = path.join(TMP, 'scope', '项目B', '报告.pdf')

  function makeReq(method, url, remoteAddress = '127.0.0.1') {
    return { method, url, headers: {}, socket: { remoteAddress } }
  }
  function makeRes() {
    const res = { statusCode: 0, headers: {}, body: '' }
    res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}) }
    res.end = (chunk) => { res.body = chunk === undefined ? '' : String(chunk) }
    res.json = () => { try { return JSON.parse(res.body) } catch { return null } }
    return res
  }
  const store = {
    items: [],
    get: (id) => (id === 'art1' ? { id, path: realFile } : null),
    list: () => [],
    stats: () => ({ total: 0 }),
    categories: () => ({ projects: [], types: [], tags: [] }),
    getSettings: () => ({}),
    file: path.join(TMP, 'x.json'),
  }
  const engine = { status: async () => ({ phase: 'ready', ready: true }), search: async () => ({ ok: true, rows: [], total: 0 }) }

  async function call(deps, method, url) {
    const handler = artifactsHandler(store, { fileIndex: engine, resolveIndexScope: async () => [path.dirname(realFile)], assertInScope: async (p) => ({ ok: true, path: p }), ...deps })
    const res = makeRes()
    await handler(makeReq(method, url), res)
    return res
  }

  await checkAsync('★ /files/reveal 成功 → 200 + 如实回报用了哪个方法', async () => {
    const seen = []
    const res = await call({ revealPath: async (p) => { seen.push(p); return { ok: true, method: 'gdbus' } } }, 'POST', '/files/reveal?path=' + encodeURIComponent(realFile))
    assert(res.statusCode === 200, 'status=' + res.statusCode + ' body=' + res.body)
    assert(seen[0] === realFile, '传下去的路径不对: ' + seen[0])
    assert(res.json().method === 'gdbus', 'body: ' + res.body)
  })

  await checkAsync('★ /files/open 走的是 openPath（不是 reveal）', async () => {
    let called = ''
    const res = await call({
      revealPath: async () => { called = 'reveal'; return { ok: true } },
      openPath: async () => { called = 'open'; return { ok: true, method: 'xdg-open' } },
    }, 'POST', '/files/open?path=' + encodeURIComponent(realFile))
    assert(res.statusCode === 200, 'status=' + res.statusCode)
    assert(called === 'open', '调错成 ' + called)
  })

  await checkAsync('★ 启动器失败 → 500 + 结构化 reason（不许静默成功）', async () => {
    const res = await call({ revealPath: async () => ({ ok: false, error: '找不到文件管理器' }) }, 'POST', '/files/reveal?path=' + encodeURIComponent(realFile))
    assert(res.statusCode === 500, 'status=' + res.statusCode)
    const body = res.json()
    assert(body.ok === false && body.reason === 'launch-failed', 'body: ' + res.body)
    assert(/找不到文件管理器/.test(body.error || ''), '错误信息丢了: ' + res.body)
  })

  await checkAsync('★ 产物 /open 端点也走平台接缝（原来硬编码 explorer.exe）', async () => {
    let got = ''
    const res = await call({ revealPath: async (p) => { got = p; return { ok: true, method: 'explorer /select' } } }, 'POST', '/art1/open')
    assert(res.statusCode === 200, 'status=' + res.statusCode + ' body=' + res.body)
    assert(got === realFile, '路径不对: ' + got)
    assert(res.json().method === 'explorer /select', 'body: ' + res.body)
  })

  await checkAsync('越界路径仍然 403（换启动器 ≠ 放宽边界）', async () => {
    const res = await call({ assertInScope: async () => ({ ok: false, error: '路径不在索引范围内' }), revealPath: async () => ({ ok: true }) }, 'POST', '/files/reveal?path=' + encodeURIComponent(realFile))
    assert(res.statusCode === 403, 'status=' + res.statusCode)
  })
}

// ═══ 收尾 ═══════════════════════════════════════════════════════════════
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
