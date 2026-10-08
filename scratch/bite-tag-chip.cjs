#!/usr/bin/env node
/**
 * 外部 bite-test（**仓库规矩**：抓不到已知 bug 的守卫 = 安全感的假象）
 *
 * 做法：把 `lib/client.js` 复制到临时目录、**只改一处**（造一个已知坏版本），
 * 再拿那份副本跑 `node test/tag-chip.test.mjs <副本>`，看**对应的断言是否真的红**。
 *
 * ⚠️ 两件事必须一起成立，缺一不可：
 *   ① 变异**真的落到了文件上**（改不动 = 这个 bite 什么也没证明）；
 *   ② **目标断言**出现在失败列表里（不是"有失败就算过" —— 那可能红的是别的断言）。
 * 本仓库栽过「变异本身写错 ⇒ 得到假绿」，所以这两条都写成断言。
 *
 * 用法：node scratch/bite-tag-chip.cjs
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TEST = path.join(ROOT, 'test', 'tag-chip.test.mjs')
const CLIENT = path.join(ROOT, 'lib', 'client.js')
const original = fs.readFileSync(CLIENT, 'utf8')

/**
 * 只在**标签样式内联区**里做替换。
 * ⚠️ 栽过一次：M8 直接对全文替换第一处 `sha256[:16]`，而那处在 **INLINE-ICONS** 区
 * （95302）—— 内联区（110659）根本没被动，于是「全绿」被误读成「守卫没抓到」。
 * ⇒ 变异必须**落在它声称的那个范围里**，否则它证明不了任何事。
 */
function replaceInRegion(text, re, rep) {
  const a = text.indexOf('// >>> INLINE-TAG-STYLES-BEGIN')
  const b = text.indexOf('// <<< INLINE-TAG-STYLES-END')
  if (a < 0 || b < 0) throw new Error('找不到内联区标记')
  const head = text.slice(0, a)
  const region = text.slice(a, b)
  const tail = text.slice(b)
  const next = region.replace(re, rep)
  if (next === region) return text          // 没变 ⇒ 交给调用方报 BAD-MUTATION
  return head + next + tail
}

/** 每一条 = 一个已知坏版本 + 它**必须**打红的那条断言（按断言名里的片段匹配）。 */
const MUTATIONS = [
  {
    name: 'M1 tagChips 把 dropped 整个丢掉（第 4 个消费者丢 warning）',
    find: /\bdropped\b/g,
    replace: 'zzz',
    expect: 'C3',
  },
  {
    name: 'M2 只数 dropped 长度、不转达理由（假转达）',
    find: /\.reason\b/g,
    replace: '.zzz',
    expect: 'C3',
  },
  {
    name: 'M3 调用点不传 surface: "chip"',
    find: 'surface: "chip"',
    replace: 'surface: ""',
    expect: 'F1',
  },
  {
    name: 'M4 抽屉退回旧的纯文本渲染（组件写了但没接上）',
    find: 'field("标签", tagChips(h, record.tags, { managed: managedTags, surface: "chip" }))',
    replace: 'field("标签", (record.tags || []).join(" · "))',
    expect: 'F1',
  },
  {
    name: 'M5 拉失败时把 managed 写成空数组（读不到 = 空）',
    find: 'managed: { ok: false, error: error && error.message ? error.message : String(error) }',
    replace: 'managed: []',
    expect: 'F4',
  },
  {
    // ⚠️ 仓库是 CRLF —— find 里必须写 \r\n（第一版写 \n，变异没落地）
    name: 'M6 reload 里不带 managed（列表一刷新样式就没了）',
    find: 'managed: previous.managed,\r\n                loading: false,',
    replace: 'loading: false,',
    expect: 'F5',
  },
  {
    name: 'M7 reload 失败分支退回直接 setData（静默丢 managed）',
    find: 'patchData({\r\n              items: [],',
    replace: 'setData({\r\n              items: [],',
    expect: 'F5',
  },
  {
    // ⚠️ 只在**内联区**里改指纹（第一版改到了 ICONS 区那处，于是"全绿"是假象）
    name: 'M8 内联区指纹被改坏一个字符',
    find: /sha256\[:16\] = ([0-9a-f]{16})/,
    replace: (m, hex) => 'sha256[:16] = ' + hex.slice(0, 15) + (hex[15] === '0' ? '1' : '0'),
    expect: 'A2',
    region: true,
  },
  {
    name: 'M9 内联副本去掉 .toLowerCase()（归一化不完整）',
    find: '    .toLowerCase()',
    replace: '',
    expect: 'B2',
  },
  {
    name: 'M10 内联的 TAG_DECOR 换成空转正则',
    find: /const TAG_DECOR = (\/.*\/[a-z]*)/,
    replace: () => 'const TAG_DECOR = /\\u0000zzz-never-matches/gu',
    expect: 'B2',
  },
  {
    name: 'M11 芯片 CSS 定义被删（真机上是裸文字）',
    find: '." + NS + "__tagchips{display:flex',
    replace: '." + NS + "__tagchipsX{display:flex',
    expect: 'E1',
  },
  {
    name: 'M12 读不到受管表时一声不吭（静默降级）',
    find: '      if (!readable) {',
    replace: '      if (false) {',
    expect: 'D4',
  },
  {
    // ⚠️ 第一版的变异在 chip 面上**是空转的**（hit.style 里本来就没有 size）——
    //    造一个真的「组件自己决定面」的坏版本：内部写死 surface='group'。
    name: 'M13 组件内部写死 surface="group"（绕过调用点，chip 上也给字号）',
    find: 'var surface = typeof opts.surface === "string" && opts.surface ? opts.surface : "chip";',
    replace: 'var surface = "group";',
    expect: 'D6',
  },
  {
    // ⚠️ 第一版塞了个 `if (false) continue;`，那**不改任何行为**（空转变异）。
    //    真的「重排」坏版本：倒着遍历。
    name: 'M14 倒着遍历 tags（把标签重排）',
    find: 'for (var i = 0; i < list.length; i += 1) {',
    replace: 'for (var i = list.length - 1; i >= 0; i -= 1) {',
    expect: 'D8',
  },
  {
    name: 'M15 受管表加载通道整个删掉（组件永远拿不到数据）',
    find: 'apiGet("/managed-tags")',
    replace: 'apiGet("/managed-tags-DISABLED")',
    expect: 'F3',
  },
  {
    name: 'M16 「受管但没配样式」被渲染成素文本（把受管 = 有样式，回到循环定义）',
    find: '        var hit = byTag[name];',
    replace: '        var hit = byTag[name];\r\n        if (hit && !(hit.preset && (hit.preset.color || hit.preset.icon || hit.preset.fontWeight))) hit = null;',
    expect: 'D3',
  },
]

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bite-tagchip-'))
const results = []
let biteFailures = 0

for (const mut of MUTATIONS) {
  const target = path.join(TMP, 'client-' + Math.random().toString(36).slice(2) + '.js')
  const mutated = mut.region
    ? replaceInRegion(original, mut.find, mut.replace)
    : original.replace(mut.find, mut.replace)
  if (mutated === original) {
    results.push({ name: mut.name, verdict: 'BAD-MUTATION', detail: '变异没落到文件上（find 没匹配）—— 这个 bite 什么也没证明' })
    biteFailures += 1
    continue
  }
  fs.writeFileSync(target, mutated, 'utf8')

  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [TEST, target], { encoding: 'utf8', cwd: ROOT })
    code = 0
  } catch (error) {
    out = String((error && error.stdout) || '') + String((error && error.stderr) || '')
    code = error && typeof error.status === 'number' ? error.status : 1
  }

  const failedNames = [...out.matchAll(/^ {2}FAIL (.+?) -> /gm)].map((m) => m[1])
  const hit = failedNames.some((n) => n.indexOf(mut.expect) >= 0)
  if (code === 0) {
    results.push({ name: mut.name, verdict: 'FALSE-GREEN', detail: '整份测试全绿 —— 这个坏版本没被抓到' })
    biteFailures += 1
  } else if (!hit) {
    results.push({ name: mut.name, verdict: 'WRONG-GUARD', detail: '有失败，但**目标断言 ' + mut.expect + ' 不在里面**：' + failedNames.join(' | ') })
    biteFailures += 1
  } else {
    results.push({ name: mut.name, verdict: 'ok', detail: '红的是 ' + failedNames.filter((n) => n.indexOf(mut.expect) >= 0).join(' / ') })
  }
  fs.unlinkSync(target)
}

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }

console.log('═══ 外部 bite-test：每个已知坏版本必须打红它对应的那条守卫 ═══\n')
for (const r of results) {
  const tag = r.verdict === 'ok' ? 'ok        ' : (r.verdict === 'BAD-MUTATION' ? 'BAD-MUT   ' : (r.verdict === 'FALSE-GREEN' ? 'FALSE-GRN ' : 'WRONG-GRD '))
  console.log('  ' + tag + r.name)
  console.log('             ' + r.detail)
}
console.log('\n' + (biteFailures ? '✗ ' + biteFailures + ' / ' + MUTATIONS.length + ' 条 bite 没通过'
  : '✓ 全部 ' + MUTATIONS.length + ' 条 bite 通过：每个已知坏版本都打红了它该打红的那条守卫'))
process.exit(biteFailures ? 1 : 0)
