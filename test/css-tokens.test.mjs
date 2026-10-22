/**
 * CSS token 必须是**真实存在**的（2026-10-20 依琪报「下拉栏透明」）
 * ══════════════════════════════════════════════════════════════════════════
 * 【bug】侧栏下拉弹层透明，下面的文件列表文字透上来。
 *
 * 【根因】`--dsw-alias-bg-primary` **这个 token 不存在**。
 *   theme 包里只有 `state-business-primary` / `label-primary` / `brand-primary`
 *   这些**非背景**的 primary ⇒ `background: var(--dsw-alias-bg-primary)` 解析成**空值**
 *   ⇒ 弹层完全透明。
 *
 * 【为什么这条测试值得存在】
 *   `var(--不存在的名字)` **不会报错**，它静默解析成空值。
 *   eslint 看不见、`node --check` 看不见、真机只表现为"看起来怪"。
 *   ⇒ 只能靠"拿真实 token 清单对照"来拦。
 *
 * ⚠️ 我在这上面猜了两版（先猜 bg-primary 是"主背景"，又猜它"可能透明"），
 *    都没去读权威定义。正确做法：打开 `dsh-client-ui-theme` 看实际值。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../', import.meta.url))

let passed = 0
let failed = 0
let skipped = 0
const failures = []
const skips = []

/** 判据前提不成立时用它 —— **不算失败，但也不算通过**。 */
class SkipError extends Error {}
function skip(reason) { throw new SkipError(reason) }

function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) {
    if (error instanceof SkipError) {
      skipped += 1
      skips.push({ name, reason: error.message })
      console.log('  SKIP ' + name + ' -> ' + error.message)
      return
    }
    failed += 1
    const msg = error && error.message ? error.message : String(error)
    failures.push({ name, msg })
    console.log('  FAIL ' + name + ' -> ' + msg)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

console.log('\n═══ CSS token 真实性 ═══')

// ── 从 DSH 的 theme 包里读出**真实存在**的 token 清单 ──────────────────
//
// ⚠️ 2026-10-22 修：原来这里是**硬编码的 Windows 绝对路径** ——
//    CI 的 runner 上没装 DSH ⇒ 读不到 ⇒ A1/B1 判红 ⇒ 三个 job 全挂。
//    （本地绿、CI 红，就是因为本地恰好有这个文件。）
//    ⇒ 改成**自动探测**，并支持环境变量覆盖。
//
// ⚠️ 探测不到时**不判红**（那不是代码错），而是 SKIP —— 但会大声报出来。
const ASAR_CANDIDATES = [
  // 环境变量优先（CI / 换机器时最稳）
  process.env.DSH_ASAR_PATH || '',
  process.env.DSH_APP_ASAR || '',
  // Windows（默认安装位置）
  'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  path.join(process.env.PROGRAMFILES || '', 'DeepSeek Harness', 'resources', 'app.asar'),
  // macOS
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  // Linux（deb / AppImage 常见位置）
  '/opt/DeepSeek Harness/resources/app.asar',
  '/usr/lib/deepseek-harness/resources/app.asar',
  '/usr/share/deepseek-harness/resources/app.asar',
].filter(Boolean)

function findAsar() {
  for (const c of ASAR_CANDIDATES) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c } catch { /* 忽略 */ }
  }
  return null
}
const ASAR = findAsar()

function readRealTokens() {
  let fd
  try {
    fd = fs.openSync(ASAR, 'r')
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const jsonLen = head.readUInt32LE(12)
    const buf = Buffer.alloc(jsonLen)
    fs.readSync(fd, buf, 0, jsonLen, 16)
    const json = JSON.parse(buf.toString('utf8'))
    const DATA = 16 + jsonLen
    const ds = json.files.dsh.files.node_modules.files['@deepseek-ai'].files
    const theme = ds['dsh-client-ui-theme']
    let all = ''
    function walk(node, prefix) {
      for (const [n, v] of Object.entries(node)) {
        if (v && v.files) { walk(v.files, prefix ? prefix + '/' + n : n); continue }
        const off = Number(v.offset)
        const sz = v.size
        if (!Number.isFinite(off) || !Number.isFinite(sz) || sz > 4000000) continue
        const b = Buffer.alloc(sz)
        try { fs.readSync(fd, b, 0, sz, DATA + off) } catch { continue }
        all += b.toString('utf8') + '\n'
      }
    }
    walk(theme.files, '')
    const set = new Set()
    for (const m of all.matchAll(/(--dsw-alias-[a-z0-9-]+):/g)) set.add(m[1])
    return set
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch { /* 忽略 */ }
  }
}

const real = readRealTokens()

// ── 扫本仓库用到的 token（只扫代码行，跳过注释里的说明文字）──────────────
function usedTokens(rel) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  return [...new Set((code.match(/--dsw-alias-[a-z0-9-]+/g) || []))]
}

check('A1 ★★★ 侧栏用到的 `--dsw-alias-*` 必须**全部真实存在**', () => {
  // ⚠️ 这是根因级判据：`var(--不存在的名字)` 静默变空值，不报错。
  // ⚠️ 读不到 theme 包 = **判据前提不成立**，不是代码错 ⇒ SKIP（但会大声报）。
  if (!real) skip('读不到 DSH 的 app.asar（本机没装 DSH，或路径不对）—— 本次未验证')
  const used = usedTokens('lib/client.js')
  const missing = used.filter((t) => !real.has(t))
  assert(missing.length === 0,
    '★ 用了不存在的 token（会静默解析成空值 ⇒ 透明）：' + missing.join(', '))
})

check('A2 ★★★ 明确禁止 `--dsw-alias-bg-primary`（它不存在）', () => {
  // ⚠️ 这条单独写，因为它就是这次 bug 的直接原因，而且名字很有迷惑性
  //    （"primary" 听起来像"主背景"，其实是 `label-primary`/`brand-primary` 那种非背景的）。
  const used = usedTokens('lib/client.js')
  assert(used.indexOf('--dsw-alias-bg-primary') < 0,
    '★ 又用上 bg-primary 了 —— 这个 token 不存在，会解析成空值')
})

check('B1 ★★ 下拉弹层必须有**不透明的**背景（不能是 transparent / 缺省）', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'client.js'), 'utf8')
  const i = src.indexOf('__rpmwrap{')
  assert(i > 0, '找不到 __rpmwrap')
  const seg = src.slice(i, src.indexOf('",', i))
  assert(/background:var\(/.test(seg), '★ 弹层没有 background —— 会透出下面的文字')
  assert(seg.indexOf('transparent') < 0, '★ 弹层背景是 transparent')
  // 必须是真实存在的 token 打头
  const m = /background:var\((--dsw-alias-[a-z0-9-]+)/.exec(seg)
  assert(m, '★ background 不是 var(--dsw-alias-*) 形式')
  // ⚠️ 同上：读不到 theme 包时无法判定 token 真伪 ⇒ SKIP
  if (!real) skip('读不到 DSH 的 app.asar —— 无法验证 ' + m[1] + ' 是否真实存在')
  assert(real.has(m[1]), '★ 打头的 token 不存在：' + m[1])
})

check('B2 ★★ 弹层 z-index 必须高于列表内容（否则会被盖住）', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'client.js'), 'utf8')
  const i = src.indexOf('__rpmwrap{')
  const seg = src.slice(i, src.indexOf('",', i))
  const m = /z-index:(\d+)/.exec(seg)
  assert(m, '弹层没有 z-index')
  assert(Number(m[1]) >= 20, '★ z-index ' + m[1] + ' 太小 —— 会被 sticky 表头/hover 层盖住')
})

check('B3 ★ 输入类控件（搜索框 / 下拉按钮）也要有不透明底色', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'client.js'), 'utf8')
  for (const cls of ['__rpinput{', '__rpmsum{']) {
    const i = src.indexOf(cls)
    assert(i > 0, '找不到 ' + cls)
    const seg = src.slice(i, src.indexOf('",', i))
    assert(seg.indexOf('background:var(') >= 0, '★ ' + cls + ' 没有 background')
  }
})

check('C1 ★ 管理页用自己的 `--panel`（不透明），不该出现 dsw token', () => {
  // 管理页是独立 HTML，自己定义了 :root { --panel: #161b22 }（不透明）——
  // 它**不该**用 dsw 的 token（那是宿主界面的）。
  const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')
  const used = [...new Set((html.match(/--dsw-alias-[a-z0-9-]+/g) || []))]
  assert(used.length === 0,
    '★ 管理页用了宿主 token（那边没有这些变量，会全部解析成空值）：' + used.join(', '))
})

// ══ 报告 ══════════════════════════════════════════════════════════════════
// ⚠️ 三个数都要报 —— 只报"通过/失败"会把"跳过"藏起来（那就是**假绿**）。
const skipNote = skipped ? ' / ' + skipped + ' 跳过' : ''
console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过' + skipNote + ' / ' + failed + ' 失败')

if (skips.length) {
  console.log('\n── 跳过的（判据前提不成立，**不是通过**）──')
  for (const x of skips) console.log('   · ' + x.name + ' -> ' + x.reason)
  console.log('   ⚠️ 这些条目**本次没有被验证**。在有 DSH 的机器上跑才会真验。')
}

if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}

// ⚠️ **全跳过也算红**：一条都没验证 ⇒ 这个测试完全失效了，必须让人知道。
//    （CI 上会全跳过，但那时 passed 至少还有 4 条 —— 见 B2/B3/C1 不依赖 asar。）
if (passed === 0 && skipped > 0) {
  console.log('\n🔴 **一条都没验证到** —— 这个测试在本环境完全失效。')
  console.log('   ⇒ 设置 DSH_ASAR_PATH 指向 DSH 的 app.asar，或换一台装了 DSH 的机器。')
  process.exitCode = 1
}

process.exit(process.exitCode || 0)
