/**
 * 回归守卫：**模块层函数不许引用不在作用域里的 `ctx`**
 * ══════════════════════════════════════════════════════════════════════════
 * 【2026-10-09 建 · 起因是一个真 bug】【2026-10-14 移植到一般形式】
 *
 * `lib/client.js` 里曾经写着：
 *
 *     getCtx: function () { return ctx; },        // ← PanelInner 里
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
 * ⭐ 2026-10-14 移植：从「守一个具体写法」改成「守这个 bug 的一般形式」
 * ══════════════════════════════════════════════════════════════════════════
 * 依琪拍板「主区面板不要了，全部转到右侧栏」⇒ `PanelInner` / `getCtx` / `hostCtx`
 * **全删了**。原判据的**主体没了**，但它守的性质还在：
 *
 *   一般形式 = 「**模块层函数引用了它没有的 `ctx`**」
 *              ⇒ 现在按「**形参里没有 `ctx` 的模块层函数，函数体不许出现裸 `ctx`**」判。
 *
 * ⚠️ **为什么必须带上「形参里没有 `ctx`」这个限定**（这是本次移植的关键）：
 *    `bootProbe(ctx)` / `registerAtSource(ctx)` / `apply(ctx)` **都拿 `ctx` 当形参**，
 *    它们引用 `ctx` 完全合法。我第一版漏了这个限定 ⇒ 三条**误报**。
 *    —— 这正是下面「手写通用检测器失败」那段教训的**同型重演**：
 *       判据写宽一点就会开始冤枉好人。
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
 *    本文件只守**一个具体的、可精确判定的**不变量，**不假装是通用分析器**。
 *    （ESLint 现在已经装上了 —— 见本文件最后那条「通用面归 ESLint」的断言。）
 *
 * ⚠️ 这也是一条更大的教训：**"我写个脚本查一下"经常是在重造一个成熟工具，
 *    而且造出来的东西会静默地不准。** 先问「有没有现成的」。
 *    （本仓库 AGENTS.md 早就写着这条：「有开源实现时，第一动作是找到同类实现并照抄结构」——
 *      我这次又没照做。）
 *
 * 📌 被废弃的具体写法与历史 → `docs/DEPRECATED-TESTS.md`
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

console.log('\n═══ 模块层 `ctx` 越界引用守卫 ═══')
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
  // ⚠️ 2026-10-14：原来那三条探针里有一条（`为什么要有这个模块级变量`）随 `hostCtx`
  //    一起删了 ⇒ 换掉。**探针必须跟着源码走**，否则自检会自己先红。
  for (const probe of ['别留着一个没人读的变量', '宿主的目录选择服务不可达', '那正是"不导出 inject"要防的事']) {
    if (!src.includes(probe)) problems.push('自检前提失效：client.js 里找不到注释原文 `' + probe + '`')
    else if (CODE.includes(probe)) problems.push('剥离器**没剥掉**注释：`' + probe + '` 还在 CODE 里')
  }
  // 不能剥过头（这些必须**留在** CODE 里）
  for (const keep of ['function apply', 'function RightPaneBody', 'function RightPanePreview', 'var NS']) {
    if (!CODE.includes(keep)) problems.push('剥离器**剥过头**了（`' + keep + '` 不见了）')
  }
  assert(problems.length === 0,
    '剥离器坏了 ⇒ 本文件判据会建在错的输入上：\n     ' + problems.join('\n     '))
});

// ── 核心判据（移植后）────────────────────────────────────────────────────
/**
 * 取一个模块层函数的**函数体**（花括号配平）。
 * @param {string} text 去注释后的源码
 * @param {number} from 函数定义处下标
 * @returns {string}
 */
function moduleFnBody(text, from) {
  const open = text.indexOf('{', from)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(open, i + 1) }
  }
  return ''
}

/**
 * 扫出所有「**形参里没有 `ctx`、函数体里却引用了裸 `ctx`**」的模块层函数。
 *
 * ⚠️ 「形参里没有 `ctx`」这个限定**不能省**：`apply(ctx)` / `bootProbe(ctx)` /
 *    `registerAtSource(ctx)` 都拿它当形参，引用它完全合法。我第一版漏了 ⇒ 三条误报。
 *
 * @param {string} text 去注释后的源码
 * @returns {Array<{name: string, params: string, hits: number}>}
 */
function ctxLeaks(text) {
  const out = []
  const re = /^ {4}function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/gm
  let m
  while ((m = re.exec(text))) {
    const name = m[1]
    const params = m[2]
    if (/\bctx\b/.test(params)) continue          // 形参就有 ⇒ 合法
    const body = moduleFnBody(text, m.index)
    const hits = (body.match(/\bctx\b/g) || []).length
    if (hits > 0) out.push({ name, params, hits })
  }
  return out
}

check('★★ 模块层函数引用的 `ctx` 必须在它的形参里（否则就是当年那个 ReferenceError）', () => {
  const leaks = ctxLeaks(CODE)
  assert(leaks.length === 0,
    '★★ 这些模块层函数引用了**不在作用域里**的 `ctx`：\n     '
    + leaks.map((l) => l.name + '(' + l.params + ') 里 ' + l.hits + ' 次').join('\n     ')
    + '\n     ⇒ 一调用就 `ReferenceError`，而且常被 catch 吞掉、**静默**退化成一句假话。'
    + '\n     真需要宿主上下文就**从 `apply` 一路传进去**（或加个模块级变量并在 apply 里赋值）。');
});

check('★ 判据的扫描面确实覆盖了模块层（不是空转）', () => {
  // ⚠️ 若正则失配（比如缩进变了），`ctxLeaks` 会返回空数组 ⇒ 上面那条**恒绿**。
  //    所以先证明「扫描真的看到了东西」：至少扫到几十个模块层函数，
  //    并且**确实看见了**那几个拿 ctx 当形参的（它们是被跳过的，不是没被看见）。
  const re = /^ {4}function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/gm
  const all = [...CODE.matchAll(re)]
  assert(all.length >= 40, '只扫到 ' + all.length + ' 个模块层函数 —— 扫描前提失效（缩进/正则变了？）')
  const withCtxParam = all.filter((m) => /\bctx\b/.test(m[2])).map((m) => m[1])
  assert(withCtxParam.indexOf('apply') >= 0,
    '★ 扫描没看到 `apply(ctx)` ⇒ 扫描器坏了（那上面那条的"零泄漏"什么也证明不了）')
  assert(withCtxParam.indexOf('bootProbe') >= 0,
    '★ 扫描没看到 `bootProbe(ctx)` ⇒ 扫描器坏了')
});

check('★ 反向对照：往一个模块层函数里塞裸 `ctx` → 上面那条必须红', () => {
  // ⚠️ 反向对照**独立造**（不能基于当前源码 —— 本仓库栽过两次）
  //    挑一个**形参里没有 ctx** 的真函数（右栏正文），把 `ctx` 塞进它的函数体。
  const GOOD = 'function RightPaneBody(props) {'
  assert(CODE.indexOf(GOOD) >= 0, '反向对照造不出来：找不到 `' + GOOD + '`')
  const broken = CODE.replace(GOOD, GOOD + ' var leak = ctx;')
  assert(broken !== CODE, '★ 反向对照造不出来（替换没生效）')
  const leaks = ctxLeaks(broken)
  assert(leaks.some((l) => l.name === 'RightPaneBody'),
    '★ 塞了裸 `ctx` 却判成没有泄漏 ⇒ 上面那条是空转的')
  // 反向之二：把 `ctx` 挪进**形参**里 ⇒ 必须**不再**算泄漏（证明限定条件真的在起作用）
  const asParam = CODE.replace(GOOD, 'function RightPaneBody(props, ctx) { var leak = ctx;')
  assert(asParam !== CODE, '反向对照之二造不出来')
  assert(!ctxLeaks(asParam).some((l) => l.name === 'RightPaneBody'),
    '★ 把 `ctx` 放进形参后仍被判成泄漏 ⇒ 「形参里有就不算」这条限定没生效（会开始冤枉好人）')
});

check('★ 通用面归 ESLint（`no-undef`）—— 断言它真的开着，不是"注释里说开了"', () => {
  // ⚠️ 这条原来写的是 `assert(true, '（这条永远通过，它只是文档）')` —— **纯文档、零信息**。
  //    2026-10-14 改成**真断言**：ESLint 现在确实装上了，那就该验它真的开着。
  //    依据：`no-undef` 属于 `js.configs.recommended`，而本仓库的 eslint 配置启用了它。
  const cfgPath = fileURLToPath(new URL('../eslint.config.mjs', import.meta.url))
  const cfg = fs.readFileSync(cfgPath, 'utf8')
  assert(/js\.configs\.recommended/.test(cfg),
    '★ eslint 配置里没有 `js.configs.recommended` —— 那 `no-undef` 可能没开，'
    + '而「手写通用检测器」已经证明是错的路（几百条误报）⇒ 通用面就**没人守**了');
  // 反面对照：确认这条断言咬得住（把 recommended 拿掉必须红）
  const broken = cfg.replace('js.configs.recommended', '/* removed */')
  assert(broken !== cfg, '反向对照造不出来（替换没生效）')
  assert(!/js\.configs\.recommended/.test(broken), '★ 拿掉后仍能匹配 ⇒ 这条断言是空转的');
});

if (failureList.length) {
  console.log('\n── 失败清单 ──')
  for (const f of failureList) console.log('      · ' + f.name + ' -> ' + f.message)
}
console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败')
process.exit(failed ? 1 : 0)
