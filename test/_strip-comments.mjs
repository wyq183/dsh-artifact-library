/**
 * 测试共用的**源码剥注释**工具（`stripComments`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这个文件存在（2026-10-08）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这个函数原本在**五个测试文件里各抄了一份**（`http-contract` / `perf-guards` /
 * `tag-chip` / `tag-styles` / `ui-spec`）。五份里**三份是旧的、带着同一个 bug**：
 *
 *   旧版不认识**正则字面量**，于是 `lib/client.js` 里这一行的
 *       if (/[\u0000-\u001f\u007f-\u009f"]/.test(p)) return "";
 *   **字符类里那个 `"`** 被当成「字符串开始」⇒ 词法从此错位 ⇒
 *   从那一行起**所有块注释都没被剥掉**（`client.js` 实测 328 处、`store.js` 12 处、
 *   `tools.js` 12 处）。
 *
 * 而 `stripComments` 是那些断言**唯一的输入预处理** ⇒ 它一坏，
 * 坏的不是一条断言，是**整份文件**（`ui-spec` 有 120 处引用），
 * 而且方向不定（可能假绿、可能误报），**并且不会自己喊**。
 *
 * ⇒ 所以：**只留一份**，并由 `test/strip-comments.test.mjs` 专职守它。
 *   本仓库的老规矩 —— 同一件事写两份**必然漂移**（这里已经漂了）。
 *   ⚠️ 这也是为什么它不叫 `*.test.mjs`：它是**被 import 的工具**，
 *      不该被 `node --test test/*.test.mjs` 当成一个测试文件跑。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 契约
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `stripComments(src)` 做**逐字符 1:1 替换**（注释字符 → 空格，换行保留）：
 *   · **长度必须完全不变** —— 否则行号会漂，所有「第 N 行」类断言跟着错；
 *   · **字符串内容必须原样保留** —— hex 颜色就住在字符串里，剥掉它 = 门禁永远抓不到东西；
 *   · **剥完不该再有块注释开头**（除了极少数「字符串里真的写了 `/*`」的情况，
 *     例如 `lib/client.js:30` 的 `` `/ext/artifacts/*` `` —— 那种是**内容**，不是注释）。
 *
 * ⚠️ 那个「字符串里的 `/*`」正是**不能**简单断言「残留 = 0」的原因：
 *    残留要**小于原文里的注释数**，且必须是**已知的字符串内出现**。
 *    详见 `test/strip-comments.test.mjs` 怎么处理这条。
 */

/**
 * 已知**有病**的旧实现（2026-10-08 之前那版）—— 只作**反向对照的标本**，别在生产里用。
 *
 * ⚠️ 刻意留着它、而不是删掉：本仓库的元规矩是
 *   「**每个守卫都要拿"已知有病的版本"跑一遍，确认它真的会红**」。
 *   没有这份标本，那个守卫就没法证明自己不是空转的。
 *   （它是**标本**，不是"备用实现" —— 别在任何地方拿它当备选。）
 *
 * 病灶：不认识正则字面量 ⇒ 正则字符类里的引号会把词法带偏。
 */
export function stripCommentsOld(src) {
  let out = ''
  let i = 0
  let quote = null
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += c2 === undefined ? '' : c2; i += 2; continue }
      if (c === quote) quote = null
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue }
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1 }
      continue
    }
    if (c === '/' && c2 === '*') {
      out += '  '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * 去掉 JS 注释（**逐字符 1:1 替换**，保证去掉后行号不变）。保留字符串内容。
 *
 * ⚠️ 原注释写着「JS 里 `//` 与 `/*` 永远是注释，所以不需要区分除号 / 正则字面量」——
 *    **前半句对，推论错**。`//` 与 `/*` 确实是注释，但把词法带偏的是**引号**：
 *    正则字符类里可以合法地出现 `"` 或 `'`，旧实现把它当成「字符串开始」。
 *    ⇒ 修法：多一条「这个 `/` 能不能起正则字面量」的判定，能则把整段正则**吞掉**。
 *
 * ⚠️ 判据是**启发式**，不是完整 JS 词法分析器：
 *   `/` 是正则开头 **当且仅当**它前面最近的有效 token 不是
 *   标识符 / 数字 / `)` / `]` / `}` / `"`。
 *   已知失效方向：某处 `/` 被**误判成正则开头** ⇒ 会吞掉后面的代码（**多剥**，
 *   把真代码当注释）。之所以敢用，是因为 `test/strip-comments.test.mjs` 会盯着
 *   「长度不变」与「残留不超过已知字符串内的出现」⇒ 误判会**红**、不会静默。
 */
export function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  let prev = ''
  const n = src.length
  // 前面最近的有效 token 决定 `/` 是除号还是正则开头
  const regexAllowed = () => !/[A-Za-z0-9_$)\]}"]/.test(prev)
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += c2 === undefined ? '' : c2; prev = 'x'; i += 2; continue }
      if (c === quote) { quote = null; prev = 'x' }
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue }
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1 }
      continue
    }
    if (c === '/' && c2 === '*') {
      out += '  '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    // ★ 正则字面量：整段吞掉（字符类里的引号不再被当成字符串开头）
    if (c === '/' && regexAllowed()) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n) {
        const d = src[j]
        if (d === '\\') { j += 2; continue }
        if (d === '\n') break
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) { closed = true; break }
        j += 1
      }
      if (closed) {
        let k = j + 1
        while (k < n && /[a-z]/i.test(src[k])) k += 1
        out += src.slice(i, k)
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
