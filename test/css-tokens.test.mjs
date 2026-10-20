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

console.log('\n═══ CSS token 真实性 ═══')

// ── 从 DSH 的 theme 包里读出**真实存在**的 token 清单 ──────────────────
const ASAR = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'

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
  assert(real, '读不到 DSH theme 包 —— 判据前提失效（换机器/换版本时请同步）')
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
  assert(real && real.has(m[1]), '★ 打头的 token 不存在：' + m[1])
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

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
