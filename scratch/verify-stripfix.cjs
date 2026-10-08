/**
 * 排查 6（只读证据，给 lead 的）：证明 `test/ui-spec.test.mjs` 的 `stripComments`
 * 有一个**改动前就存在**的 bug —— 它不认识**正则字面量里的引号**。
 *
 * 症状：`client.js:1297` 的 `/[..." ]/` 里那个 `"` 被当成「字符串开始」，
 * 于是从 1303 行起，**后面 304 处 `/* … *​/` 注释全都没被剥掉**（剥注释等于空转）。
 * 之前没暴露是因为原文里没有 hex 出现在那些「没被剥掉的注释」里；
 * 3d 内联进来的 JSDoc 里有一个反例 `#ff0000`，于是被 hex 门禁抓了个正着 ——
 * **门禁抓的是注释里的文档，不是配置**（而 tag-styles.test.mjs 的 [I] 节明说注释里的反例是允许的）。
 *
 * 用法：node scratch/verify-stripfix.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const CLIENT = path.join(__dirname, '..', 'lib', 'client.js')
const raw = fs.readFileSync(CLIENT, 'utf8')
const lineOf = (k) => raw.slice(0, k).split('\n').length

// ── 现状版（照抄 ui-spec.test.mjs:92-126 的算法）────────────────────────────
function stripCommentsCurrent(s) {
  let out = ''
  let i = 0
  let quote = null
  const n = s.length
  while (i < n) {
    const c = s[i]
    const c2 = s[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += c2 === undefined ? '' : c2; i += 2; continue }
      if (c === quote) quote = null
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue }
    if (c === '/' && c2 === '/') { while (i < n && s[i] !== '\n') { out += ' '; i += 1 } continue }
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i += 1 }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * 修好的版本：**多加一条**「这里能不能起一个正则字面量」的判定。
 *
 * 判据（照 JS 词法的既有惯例，`ui-spec` 自己那段注释其实已经点了「空正则字面量非法」）：
 *   一个 `/` 是**正则开头**，当且仅当它前面最近的一个**有效 token** 不是
 *   标识符 / 数字 / `)` / `]` / `}` / 字符串或模板结尾。
 * 只在**代码位置**（不在注释、不在字符串里）判，所以它不会误伤 `a / b`。
 *
 * ⚠️ 这是**词法近似**，不是完整 parser —— 但它要解决的是一类很窄的问题
 *    （正则字面量里含引号 / 含 `/*`），而且带**反向对照**：见文件末尾。
 */
function stripCommentsFixed(s) {
  let out = ''
  let i = 0
  let quote = null
  const n = s.length
  /** 上一个有效 token 的「末字符」，用来判 `/` 是不是正则开头 */
  let prev = ''
  const regexAllowed = () => !/[A-Za-z0-9_$)\]}]/.test(prev)

  while (i < n) {
    const c = s[i]
    const c2 = s[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += c2 === undefined ? '' : c2; prev = 'x'; i += 2; continue }
      if (c === quote) { quote = null; prev = 'x' }   // 字符串结尾 ⇒ 后面不许起正则
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue }
    if (c === '/' && c2 === '/') { while (i < n && s[i] !== '\n') { out += ' '; i += 1 } continue }
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i += 1 }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    // ★ 正则字面量：整段吞掉（字符类里的引号不再被当成字符串开头）
    if (c === '/' && regexAllowed()) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n) {
        const d = s[j]
        if (d === '\\') { j += 2; continue }
        if (d === '\n') break                    // 正则不许跨行 ⇒ 这不是正则
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) { closed = true; break }
        j += 1
      }
      if (closed) {
        let k = j + 1
        while (k < n && /[a-z]/i.test(s[k])) k += 1   // flags
        out += s.slice(i, k)
        prev = 'x'
        i = k
        continue
      }
    }
    out += c
    if (!/\s/.test(c)) prev = c
    i += 1
  }
  return out
}

function hexes(text) {
  const out = []
  const re = /#([0-9a-fA-F]{3,8})\b/g
  let m
  while ((m = re.exec(text))) {
    if (![3, 4, 6, 8].includes(m[1].length)) continue
    const before = text[m.index - 1]
    if (before && /[A-Za-z0-9_$]/.test(before)) continue
    out.push({ text: m[0], line: lineOf(m.index) })
  }
  return out
}

/** 数一数有多少 `/*` 是在「引号开着」的状态下被吞掉的（= 剥注释空转的量） */
function swallowedComments(stripFn) {
  let i = 0, q = null, n = raw.length, cnt = 0, first = -1
  // 复用同一个状态机：把「剥注释」的输出与原文逐字符对齐不方便，
  // 这里直接再走一遍**同一套词法**，只统计。
  let prev = ''
  const regexAllowed = () => !/[A-Za-z0-9_$)\]}]/.test(prev)
  while (i < n) {
    const c = raw[i], c2 = raw[i + 1]
    if (q) {
      if (c === '/' && c2 === '*') { cnt += 1; if (first < 0) first = i }
      if (c === '\\') { i += 2; continue }
      if (c === q) { q = null; prev = 'x' }
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { q = c; i += 1; continue }
    if (c === '/' && c2 === '/') { while (i < n && raw[i] !== '\n') i += 1; continue }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1; i += 2; continue }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, inClass = false, closed = false
      while (j < n) {
        const d = raw[j]
        if (d === '\\') { j += 2; continue }
        if (d === '\n') break
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) { closed = true; break }
        j += 1
      }
      if (closed) { let k = j + 1; while (k < n && /[a-z]/i.test(raw[k])) k += 1; prev = 'x'; i = k; continue }
    }
    if (!/\s/.test(c)) prev = c
    i += 1
  }
  return { cnt, firstLine: first < 0 ? -1 : lineOf(first) }
}

/**
 * 剥注释有没有**空转**：直接看剥完之后的文本里还剩几个 `/*`。
 * 剥干净的注释在输出里只剩空格 ⇒ 还剩 `/*` 就说明那段注释根本没被识别。
 * （比"自己再走一遍状态机"诚实：它测的就是 stripFn 的实际输出。）
 */
function survivingBlockComments(stripped) {
  const out = []
  const re = /\/\*/g
  let m
  while ((m = re.exec(stripped))) out.push(lineOf(m.index))
  return out
}

console.log('═══ 证据：ui-spec 的 stripComments 被正则字面量带偏 ═══')
const cur = stripCommentsCurrent(raw)
const fix = stripCommentsFixed(raw)
console.log('现状版：hex 存活 =', JSON.stringify(hexes(cur)))
console.log('        剥完还剩 /* 的行号（前 8 个）=', JSON.stringify(survivingBlockComments(cur).slice(0, 8)),
  ' 共', survivingBlockComments(cur).length, '处 —— 这些注释**根本没被剥掉**')
console.log('修好版：hex 存活 =', JSON.stringify(hexes(fix)))
console.log('        剥完还剩 /* 的行号 =', JSON.stringify(survivingBlockComments(fix)), '共', survivingBlockComments(fix).length, '处')
console.log('两版长度一致（1:1 替换）:', cur.length === fix.length, ' 且 === 原文长度:', fix.length === raw.length)

console.log('\n═══ 反向对照：修好版**仍然**必须抓到「字符串字面量里的 hex」 ═══')
const samples = [
  ['字符串里的 hex（必须被抓）', 'const a = "#ff0000";\n'],
  ['注释里的 hex（必须放过）', '// 反例 #ff0000\nconst a = 1;\n'],
  ['块注释里的 hex（必须放过）', '/* 反例 #ff0000 */\nconst a = 1;\n'],
  ['正则含引号 + 后面的注释里的 hex（必须放过）', 'if (/[a"]/.test(p)) return 1;\n// 反例 #ff0000\nconst a = 1;\n'],
  ['正则含 /* + 后面的注释（必须放过）', 'const re = /\\/\\*/;\n/* 反例 #ff0000 */\nconst a = 1;\n'],
  ['除号不能当正则（必须不误伤）', 'const x = a / b; // #ff0000\nconst y = 1;\n'],
]
let bad = 0
for (const [label, src] of samples) {
  const got = hexes(stripCommentsFixed(src))
  const wantCatch = label.indexOf('必须被抓') >= 0
  const ok = wantCatch ? got.length === 1 : got.length === 0
  if (!ok) bad += 1
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + ' → ' + JSON.stringify(got.map((h) => h.text)))
}
console.log(bad ? '\n✗ 反向对照失败 ' + bad + ' 条 —— 修好版不可信' : '\n✓ 反向对照全过：修好版既堵住了漏，也没误伤')
process.exit(bad ? 1 : 0)
