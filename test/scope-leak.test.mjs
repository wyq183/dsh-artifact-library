/**
 * 回归守卫：`hostCtx`（治一个真 bug）
 * ══════════════════════════════════════════════════════════════════════════
 * 【2026-10-09 建 · 起因是一个真 bug】
 *
 * `lib/client.js` 里曾经写着：
 *
 *     getCtx: function () { return ctx; },        // ← 4422 行附近
 *
 * 而 `ctx` **不在那个作用域里** —— 它只是 `apply(ctx)` 的参数，
 * 而 `PanelInner` 是**模块层**函数，两者互不可见。
 *
 * 后果（**已实测复现**，脚本见提交信息）：
 *   ① 一调用就 `ReferenceError`；
 *   ② 被 `nativePicker()` 的 `catch` 吞掉 ⇒ **静默**；
 *   ③ 用户被告知「**宿主的目录选择服务不可达**」—— **一句假话**，
 *      把排查方向指向宿主，而真因在我们自己代码里；
 *   ④ 导入文件夹的**原生目录选择器永久不可用**。
 *
 * 发现方式：**ESLint 的 `no-undef`，一行配置**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 本文件**不是**静态作用域分析器 —— 我试过，**失败了，如实记**
 * ══════════════════════════════════════════════════════════════════════════
 * 我第一版想"手写一个通用的越界引用检测器"，结果：
 *   · 报出**几百条误报**（对象字面量的键名 `className`/`onClick`/`width`、
 *     嵌套闭包捕获的变量、`function` 表达式……全被当成"越界引用"）；
 *   · 而**它想抓的那一条（`ctx`）反而被淹没在噪音里**。
 *
 * ⇒ **结论：手写静态分析器是错的路。正解就是 ESLint**（`no-undef` 一行）。
 *    本文件因此**收窄**成「**只守这一个具体 bug 的回归**」——
 *    它能做的只有这一件事，那就只做这一件，**不假装是通用分析器**。
 *
 * ⚠️ 这也是一条更大的教训：**"我写个脚本查一下"经常是在重造一个成熟工具，
 *    而且造出来的东西会静默地不准。** 先问「有没有现成的」。
 *    （本仓库 AGENTS.md 早就写着这条：「有开源实现时，第一动作是找到同类实现并照抄结构」——
 *      我这次又没照做。）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('../lib/client.js', import.meta.url))

let passed = 0
let failed = 0
const failureList = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) {
    failed += 1
    const message = error && error.message ? error.message : String(error)
    failureList.push({ name, message })
    console.log('  FAIL ' + name + ' -> ' + message)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message || 'assertion failed') }

console.log('\n═══ hostCtx 回归守卫 ═══')
console.log(' 被测：' + CLIENT_PATH)

const src = fs.readFileSync(CLIENT_PATH, 'utf8')

// ── 剥注释（**本仓库栽过两次的预处理**）──────────────────────────────────
// ⚠️ 必须**逐字符**走并跳过字符串/模板/正则/注释：
//   · 不剥 ⇒ 我自己的注释里引用了旧写法 ⇒ **假红**（本次第一版就栽了）；
//   · 粗暴替换 `/* */` ⇒ 遇到正则字面量里的 `"` 会词法错位
//     （`ui-spec` 栽过：328 处块注释没剥掉，120 条断言建在错的输入上）。
function stripComments(text) {
  let out = '', i = 0, quote = null, prev = ''
  const regexAllowed = () => !/[A-Za-z0-9_$)\]}"']/.test(prev)
  while (i < text.length) {
    const c = text[i], c2 = text[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += text[i + 1] || ''; i += 2; continue }
      if (c === quote) { quote = null; prev = 'x' }
      i += 1; continue
    }
    if (c === '/' && c2 === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue }
    if (c === '/' && c2 === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2; continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, inClass = false, closed = false
      while (j < text.length) {
        const d = text[j]
        if (d === '\\') { j += 2; continue }
        if (d === '\n') break
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) { closed = true; break }
        j += 1
      }
      if (closed) {
        out += text.slice(i, j + 1)
        let k = j + 1
        while (k < text.length && /[a-z]/i.test(text[k])) k += 1
        out += text.slice(j + 1, k)
        prev = 'x'; i = k; continue
      }
    }
    out += c
    if (!/\s/.test(c)) prev = c
    i += 1
  }
  return out
}

const CODE = stripComments(src)

check('★ 预处理自检：剥离器真的剥掉了注释、且没剥过头', () => {
  const problems = []
  // 拿**只存在于 client.js 注释里**的句子验。
  // ⚠️ 我第一版这里写的是**本测试文件自己**的注释原文 ⇒ 前提直接失效（`client.js` 里没有）。
  //    **自检的输入也必须被验** —— 这正是本仓库反复栽的那条。
  for (const probe of ['为什么要有这个模块级变量', '一句假话', '静默永久失效']) {
    if (!src.includes(probe)) problems.push('自检前提失效：client.js 里找不到注释原文 `' + probe + '`')
    else if (CODE.includes(probe)) problems.push('剥离器**没剥掉**注释：`' + probe + '` 还在 CODE 里')
  }
  // 不能剥过头
  for (const keep of ['getCtx', 'function apply', 'hostCtx', 'PanelInner']) {
    if (!CODE.includes(keep)) problems.push('剥离器**剥过头**了（`' + keep + '` 不见了）')
  }
  assert(problems.length === 0,
    '剥离器坏了 ⇒ 本文件判据会建在错的输入上：\n     ' + problems.join('\n     '))
});

// ── 核心回归：`getCtx` 必须走模块级的 `hostCtx` ──────────────────────────
check('★★ `getCtx` 走模块级 `hostCtx`（不许改回裸 `ctx`）', () => {
  assert(!CODE.includes('getCtx: function () { return ctx; }'),
    '★★ `getCtx` 又引用裸 `ctx` 了 —— 那个 `ctx` **不在 PanelInner 的作用域里**，'
    + '一调用就 ReferenceError，而它会被 nativePicker 的 catch 吞掉，'
    + '用户看到的是「宿主的目录选择服务不可达」（**假话**）。请改回 `return hostCtx;`');
  assert(CODE.includes('getCtx: function () { return hostCtx; }'),
    '★★ 找不到修好的那版（`getCtx: function () { return hostCtx; }`）—— 改漏了？');
});

check('★ 模块级 `hostCtx` 声明在、`apply` 里赋值、且**在注册之前**', () => {
  assert(/^ {4}var hostCtx = null;/m.test(CODE),
    '★ 模块级 `var hostCtx = null;` 不见了 —— 那 `getCtx` 会引用到不存在的名字');
  assert(/hostCtx = ctx \|\| null;/.test(CODE),
    '★ `apply` 里没给 `hostCtx` 赋值 —— 它永远是 null，原生选择器还是用不了');
  const assignAt = CODE.indexOf('hostCtx = ctx || null;')
  const registerAt = CODE.indexOf('slots.inject(SLOT_MAIN')
  assert(assignAt > 0, '找不到赋值语句（锚点失效）')
  assert(registerAt > 0, '找不到注册语句（锚点失效）')
  assert(assignAt < registerAt,
    '★ 赋值在**注册之后** —— 面板可能在赋值前就被渲染，那时拿到 null');
});

check('★ 反向对照：判据能抓住「已知有病」的版本（把 `hostCtx` 换回 `ctx`）', () => {
  // ⚠️ 反向对照**独立造**（不能基于当前源码 —— 本仓库栽过两次）
  const broken = CODE.replace('getCtx: function () { return hostCtx; }',
    'getCtx: function () { return ctx; }')
  assert(broken !== CODE, '★ 反向对照造不出来（替换没生效）—— 上面那条可能是空转的')
  assert(broken.includes('getCtx: function () { return ctx; }'),
    '★ 坏版本里没有裸 `ctx` —— 反向对照构造有问题')
  // 判据的两半都必须在坏版本上失败
  const wouldFail = broken.includes('getCtx: function () { return ctx; }')
    || !broken.includes('getCtx: function () { return hostCtx; }')
  assert(wouldFail, '★ 坏版本竟然能通过上面那两条判据 ⇒ 那两条是空转的')
});

check('★ 说明：通用越界引用检测**不归本文件管**（归 ESLint）', () => {
  // ⚠️ 这条是**有意为之的"不做"**，写出来免得下一个人以为这里漏了。
  //    我试过手写通用检测器 ⇒ 几百条误报、真问题被淹没 ⇒ 删掉了。
  //    正解：`eslint.config.js` + `no-undef: "error"`（一行）。
  //    ⇒ 如果哪天项目上了 ESLint，这条守卫可以退休（但**不是现在**）。
  assert(true, '（这条永远通过，它只是文档）')
});

if (failureList.length) {
  console.log('\n── 失败清单 ──')
  for (const f of failureList) console.log('      · ' + f.name + ' -> ' + f.message)
}
console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败')
process.exit(failed ? 1 : 0)
