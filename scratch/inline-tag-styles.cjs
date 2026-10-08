#!/usr/bin/env node
/**
 * dsh-artifact-library · 把标签「醒目样式」的规则层内联进 lib/client.js
 *
 * 用法：
 *   node scratch/inline-tag-styles.cjs            # 生成（就地改写 lib/client.js 的内联区）
 *   node scratch/inline-tag-styles.cjs --check    # 只校验，不写文件（漂移就非零退出）
 *
 * ── 为什么要有这个文件（缺口 1）──────────────────────────────────────────────
 *
 * `lib/client.js` 是**独立浏览器包，零 import** —— 插件运行时加载不到包内相对 ESM
 * （`lib/icons.js:16-27` 实测），所以 `lib/tag-styles.js` 的规则层必须**内联**。
 * 照 `INLINE-ICONS` 区的既有约定：内联区带**源文件指纹**（`sha256[:16]`），
 * 两边不一致 = 漂移。旧生成器 `scratch/inline-icons.cjs` 已不在仓库里，本文件是新写的。
 *
 * ── ⚠️ 本生成器最容易做错的一件事（所以它必须**求值**）──────────────────────
 *
 * `TAG_STYLE_TABLE` 在源文件里**不是字面量**：它的 `colors` 是
 * `Object.fromEntries(Object.keys(COLOR_SOURCES).map(...))` 现算出来的。
 * 直接抄源码文本会抄到一段**依赖模块私有名字**的表达式 —— 粘进 client.js 就是
 * ReferenceError（而 client.js 抛异常会拖垮整次 web boot）。
 * ⇒ 一律**真 import 一次、求值、再吐 JSON 字面量**。
 *
 * ── 内联三段（都是**机械复制**，没有一行人工翻译）────────────────────────────
 *
 *   ① `TAG_STYLE_TABLE`  —— 求值后的纯 JSON 字面量
 *   ② `buildTagStyleRule` —— 函数源码（自包含；`[I]` 节用 new Function 在无私有作用域
 *                            的环境里重建过，证明它不引用任何模块私有名字）
 *   ③ `normalizeTag` + `TAG_DECOR` —— 源 `lib/tags.js`。
 *      ⚠️ 为什么非要有第三段：规则层的**读路径**兜底（`dsh` 能匹配受管的 `DSH`，
 *      见定稿 §2.3）靠的就是 `buildTagStyleRule(table, normalizeTag)` 的第二参。
 *      client.js 零 import ⇒ 拿不到它。**不内联 = 客户端退化成逐字匹配**，
 *      同一张表在 Node 侧（工具/agent）与客户端（渲染）会算出**不同结果** ——
 *      正是 §2.3 要避免的「给 `DSH` 配了色，挂在 `dsh` 上的记录却渲染成素净的」。
 *      另起一段内联（而不是在 client.js 里手写一份 keyOf）是为了**只有一份实现**：
 *      手写 = 第二套词汇表，本仓库最恨的东西。
 *      ⚠️ `TAG_DECOR` 是 `normalizeTag` **唯一的**外部依赖（模块私有、没导出）。
 *      漏掉它 = 「看着像内联了、其实归一化不完整」的**假内联** ——
 *      所以本生成器把两者**成对**内联，并在自检里钉住。
 *
 * ── 自检（本文件跑完会自己验一遍，失败就**不写文件**）────────────────────────
 *
 * 生成的文本会被真的求值，并与 `lib/tag-styles.js` / `lib/tags.js` 的模块级函数
 * **逐样本比对**。**还带一条反向对照**：故意把内联副本改坏一处（去掉
 * `.toLowerCase()`），比对**必须**报红 —— 否则「比对通过」本身不可信。
 * 「生成了但内容是错的」不该靠人去看。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const TAG_STYLES_PATH = path.join(ROOT, 'lib', 'tag-styles.js')
const TAGS_PATH = path.join(ROOT, 'lib', 'tags.js')
const CLIENT_PATH = path.join(ROOT, 'lib', 'client.js')

const BEGIN = '// >>> INLINE-TAG-STYLES-BEGIN'
const END = '// <<< INLINE-TAG-STYLES-END'
/**
 * 内联区插在图标区**之后** —— 图标区那行 sha256 必须是全文件第一处
 * （`test/ui-spec.test.mjs:631` 用 `indexOf` 取**第一处**指纹）。
 * ⚠️ 这里只按标记文本找、再自己走到行尾：**不能写死 `\n`** ——
 *    本仓库的 lib/*.js 是 **CRLF**（8248 行全 CRLF），写死 `\n` 会永远找不到锚点。
 */
const ICONS_END_MARK = '// <<< INLINE-ICONS-END'

/** 从 idx 起这一行的行尾（含 EOL）；找不到 EOL 就回文件末尾。 */
function endOfLine(src, idx) {
  const at = src.indexOf('\n', idx)
  return at < 0 ? src.length : at + 1
}

/**
 * 统一成目标行尾。
 * ⚠️ 必须**先归 LF 再换 EOL**：`Function.prototype.toString()` 与 `JSON.stringify` 吐的都是 LF，
 *    直接 `\r\n → EOL` 会在已有 CRLF 上叠出 `\r\r\n`。
 */
function toEol(text, EOL) {
  return text.split('\r\n').join('\n').split('\n').join(EOL)
}

const sha16 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)

/**
 * 把 JS 注释**逐字符 1:1 抹成空白**（行号与偏移不变）。字符串内容**保留**。
 *
 * ⚠️ 与 `test/ui-spec.test.mjs` 的 `stripComments` 同一手法，这里**各写一份是有意的**：
 * 生成器必须能在**没有仓库测试环境**时独立跑（它要在 CI 之外、改完源文件就地执行）。
 * 口径漂移的风险由自检里的**反向对照**兜住（见 `assertTemplateGuardWorks`）。
 */
function stripComments(src) {
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

/** 找出**跨行**的模板字符串（缩进会改掉它的内容 —— 那种源码必须拒绝缩进）。 */
function multilineTemplates(code) {
  const hits = []
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]
    if (c === '"' || c === "'") {          // 普通字符串：跳过
      i += 1
      while (i < n && code[i] !== c) { if (code[i] === '\\') i += 1; i += 1 }
      i += 1
      continue
    }
    if (c === '`') {
      const start = i
      i += 1
      while (i < n && code[i] !== '`') { if (code[i] === '\\') i += 1; i += 1 }
      i += 1
      const text = code.slice(start, i)
      if (text.indexOf('\n') >= 0) hits.push(text.slice(0, 40))
      continue
    }
    i += 1
  }
  return hits
}

/**
 * 缩进前的安全闸门 —— 机械缩进**只对「没有跨行模板字符串」的代码安全**。
 *
 * ⚠️ 这里栽过一次，教训值得留：第一版闸门写成「源码里有没有反引号」，
 * 于是被 `buildTagStyleRule` 体内**注释里**的 `\`null\`` 之类绊倒 ——
 * **注释里的话喂给了守卫**（正是本仓库栽过三次的那类错）。
 * ⇒ 现在**先剥注释**再判，并且这条预处理本身带反向对照。
 */
function assertTemplateGuardWorks() {
  const problems = []
  // ① 跨行模板：必须被抓到
  const bad = 'function f() {\n  return `a\nb`\n}'
  if (multilineTemplates(stripComments(bad)).length === 0) {
    problems.push('模板闸门抓不到一个**确凿的**跨行模板字符串 ⇒ 它的「安全」结论不可信')
  }
  // ② 单行模板：必须放行（别把正常代码也拒了）
  const ok = 'function f() {\n  return `a` + `b`\n}'
  if (multilineTemplates(stripComments(ok)).length !== 0) {
    problems.push('模板闸门把**单行**模板字符串也判成危险 ⇒ 它会无谓地拒绝正常源码')
  }
  // ③ ★ 注释里的反引号必须被剥掉（第一版就是死在这里）
  const commented = 'function f() {\n  /* `多行\n  注释` */\n  return 1\n}'
  if (stripComments(commented).indexOf('`') >= 0) {
    problems.push('剥注释没剥干净：注释里的反引号还在 ⇒ 闸门又会被注释喂假信号')
  }
  if (multilineTemplates(stripComments(commented)).length !== 0) {
    problems.push('★ 注释里的「跨行反引号」被当成了真模板字符串 —— 这正是第一版栽的那个坑')
  }
  // ④ 剥离器本身不能空转
  if (stripComments(commented).length !== commented.length) {
    problems.push('剥注释改变了文本长度（不是 1:1 替换）—— 偏移/行号会漂')
  }
  return problems
}

/** 每行加缩进；跨行模板字符串会拒绝（见 `assertTemplateGuardWorks`）。 */
function indent(text, pad, label) {
  const hits = multilineTemplates(stripComments(text))
  if (hits.length) {
    throw new Error('待缩进的 ' + label + ' 里有**跨行模板字符串**（' + JSON.stringify(hits[0])
      + '…）—— 机械缩进会改掉字符串内容，本生成器拒绝继续。请先把源里那段模板改掉，或改本生成器的缩进策略。')
  }
  return text
    .split('\n')
    .map((line) => (line === '' ? line : pad + line))
    .join('\n')
}

/** 归一化用的样本集：**真会踩的**（大小写 / 全角 / NFKC / 装饰符 / 空白 / 非字符串）。 */
const NORMALIZE_CORPUS = [
  // 大小写混写（真库里 DSH/dsh、godot/Godot 并存）
  'DSH', 'dsh', 'Dsh', 'godot', 'Godot', 'GODOT', 'GP-Next', 'gpNext',
  // 全角（NFKC 会折成半角）
  'ＤＳＨ', 'ＡＢＣ', 'ｇｏｄｏｔ',
  // NFKC 会变形的其它形状
  'ﬁle', '①', 'Ⅻ', 'ⅰⅱ',
  // 装饰符：中点 / 片假名中点 / 各种连字符 / 下划线 / 空格
  '卫龙榴莲辣条·留恋计划', '卫龙榴莲辣条留恋计划',
  'a・b', 'a·b', 'a‐b', 'a‑b', 'a‒b', 'a–b', 'a—b', 'a―b', 'a-b', 'a_b', 'a b', 'ab',
  // 首尾 / 纯空白
  '  DSH  ', '\tDSH\n', '   ', '\u00a0',
  // 语义符号**必须保留**（C / C++ / C# 不能撞键）
  'C', 'C++', 'C#', 'F', 'F#', '.NET', 'NET', 'v0.3.0', 'v030',
  // 归一化后为空
  '···', '---', '',
  // 非字符串
  null, undefined, 42, 0, false, ['x'], { a: 1 },
]

async function main() {
  const checkOnly = process.argv.includes('--check')

  // ⚠️ 守卫的**输入预处理**先自验（本仓库栽过三次：注释里的话喂给了守卫）
  const guardProblems = assertTemplateGuardWorks()
  if (guardProblems.length) {
    console.error('✗ 缩进闸门的预处理自检失败（**没有写文件**）：')
    for (const p of guardProblems) console.error('   · ' + p)
    process.exit(1)
  }

  const tagStylesSrc = fs.readFileSync(TAG_STYLES_PATH, 'utf8')
  const tagsSrc = fs.readFileSync(TAGS_PATH, 'utf8')
  const clientSrc = fs.readFileSync(CLIENT_PATH, 'utf8')

  const stylesMod = await import(pathToFileURL(TAG_STYLES_PATH).href)
  const tagsMod = await import(pathToFileURL(TAGS_PATH).href)

  const table = stylesMod.TAG_STYLE_TABLE
  const build = stylesMod.buildTagStyleRule
  const normalize = tagsMod.normalizeTag
  if (!table || typeof table !== 'object') throw new Error('lib/tag-styles.js 没导出 TAG_STYLE_TABLE')
  if (typeof build !== 'function') throw new Error('lib/tag-styles.js 没导出 buildTagStyleRule')
  if (typeof normalize !== 'function') throw new Error('lib/tags.js 没导出 normalizeTag')

  // ① 表：求值 → JSON 字面量（**不能抄源码文本**，理由见文件头）
  const tableJson = JSON.stringify(table, null, 2)
  if (tableJson.indexOf('function') >= 0 || tableJson.indexOf('=>') >= 0) {
    throw new Error('求值后的表里混进了函数/箭头函数 —— 它就不是纯 JSON，内联不出去')
  }
  // ⚠️ 往返要跟**紧凑序列化**比，不能跟带缩进的 `tableJson` 比 ——
  //    第一版就是拿它比的，于是**恒假**、把生成器自己卡死在第一行（一个假红）。
  if (JSON.stringify(JSON.parse(tableJson)) !== JSON.stringify(table)) {
    throw new Error('表的 JSON 往返不稳定（可能有 undefined / NaN）—— 内联后语义会漂')
  }

  // ② builder：函数源码（自包含）
  const buildSrc = String(build)
  if (!/^function\s+buildTagStyleRule\s*\(/.test(buildSrc)) {
    throw new Error('buildTagStyleRule 的源码形状变了（不再是具名函数声明）：' + buildSrc.slice(0, 60))
  }

  // ③ normalizeTag + 它唯一的私有依赖 TAG_DECOR（**成对**，缺一就是假内联）
  const normalizeSrc = String(normalize)
  if (!/^function\s+normalizeTag\s*\(/.test(normalizeSrc)) {
    throw new Error('normalizeTag 的源码形状变了：' + normalizeSrc.slice(0, 60))
  }
  if (!/TAG_DECOR/.test(normalizeSrc)) {
    throw new Error('normalizeTag 的源码里不再引用 TAG_DECOR —— 依赖关系变了，请同步本生成器')
  }
  const decorLine = /^const TAG_DECOR = (.+)$/m.exec(tagsSrc)
  if (!decorLine) throw new Error('在 lib/tags.js 里找不到 `const TAG_DECOR = …` 这一行')
  const decorLiteral = decorLine[1].trim()
  if (!/^\/.*\/[a-z]*$/.test(decorLiteral)) {
    throw new Error('TAG_DECOR 取到的不是正则字面量：' + decorLiteral)
  }

  const tagStylesFp = sha16(TAG_STYLES_PATH)
  const tagsFp = sha16(TAGS_PATH)
  /** 跟随 client.js 自己的行尾（本仓库是 CRLF）—— 别让生成器把整份文件改成 LF */
  const EOL = clientSrc.indexOf('\r\n') >= 0 ? '\r\n' : '\n'

  const body = [
    '    const TAG_STYLE_TABLE = ' + indent(tableJson.split('\n').join(EOL), '    ', 'TAG_STYLE_TABLE').trimStart(),
    '',
    '    /** 装饰符正则（源 lib/tags.js 的 TAG_DECOR；normalizeTag 只依赖它一个外部名字） */',
    '    const TAG_DECOR = ' + decorLiteral,
    '',
    indent(normalizeSrc, '    ', 'normalizeTag'),
    '',
    indent(buildSrc, '    ', 'buildTagStyleRule'),
    '',
    '    /** 模块级实例：与 Node 侧的 RULE 是**同一份实现**（builder 只有一份，绝不各写一套） */',
    '    const tagStyleRule = buildTagStyleRule(TAG_STYLE_TABLE, normalizeTag)',
  ].join(EOL)

  const header = [
    BEGIN + '（由 scratch/inline-tag-styles.cjs 生成，请勿手改）',
    '    // 标签「醒目样式」规则层内联自 lib/tag-styles.js + lib/tags.js（原因同 INLINE-ICONS：',
    '    // 插件运行时加载不到包内相对 ESM，客户端只能内联）。改规则请改**源文件**再跑',
    '    //   node scratch/inline-tag-styles.cjs',
    '    // 重新生成 —— 下面这段一个字都别手改。',
    '    //',
    '    // 三段都是机械复制（求值 → JSON 字面量 → 源码），没有一行人工翻译：',
    '    //   ① TAG_STYLE_TABLE   求值后的纯 JSON（源里是 Object.fromEntries(...) 现算的，',
    '    //                        所以必须先求值；照抄源码文本会抄到一段引用模块私有名字的表达式）',
    '    //   ② buildTagStyleRule 函数源码（自包含）',
    '    //   ③ normalizeTag      读路径的归一化兜底（源 lib/tags.js）+ 它的私有依赖 TAG_DECOR。',
    '    //                        **不内联它 = 客户端退化成逐字匹配**，与 Node 侧算出不同结果',
    '    //                        （定稿 §2.3 要避免的那种：给 DSH 配了色，挂在 dsh 上的记录素净）',
    '    //',
    '    // 源文件指纹 lib/tag-styles.js sha256[:16] = ' + tagStylesFp + '（两边不一致 = 漂移，需要重新生成）',
    '    // 源文件指纹 lib/tags.js sha256[:16] = ' + tagsFp + '（同上；它只为 normalizeTag + TAG_DECOR 而来）',
  ].join(EOL)

  const block = toEol(header + EOL + body + EOL + '    ' + END + EOL, EOL)

  // ── 自检：求值 + 逐样本比对 + **反向对照** ────────────────────────────────
  const problems = compareBlock(block, { table, stylesMod, tagsMod, normalize })
  // 反向对照：故意改坏内联副本的归一化（去掉 .toLowerCase()）——比对**必须**报红
  const tampered = block.replace('    .toLowerCase()', '')
  if (tampered === block) {
    problems.push('反向对照造不出来（内联副本里找不到 `.toLowerCase()`）—— 「比对通过」这件事无法证明')
  } else {
    const bad = compareBlock(tampered, { table, stylesMod, tagsMod, normalize })
    if (bad.length === 0) {
      problems.push('★ 反向对照失败：把内联副本的 `.toLowerCase()` 去掉后，比对**居然还是全绿** ⇒ 上面那些「一致」不可信')
    }
  }
  if (problems.length) {
    console.error('✗ 生成结果自检失败（**没有写文件**）：')
    for (const p of problems) console.error('   · ' + p)
    process.exit(1)
  }
  const sampleCount = NORMALIZE_CORPUS.length + 16

  if (checkOnly) {
    const at = clientSrc.indexOf(BEGIN)
    const want = at >= 0
      ? clientSrc.slice(at, endOfLine(clientSrc, clientSrc.indexOf(END, at)))
      : ''
    if (want !== block) {
      console.error('✗ 内联区与源不一致（--check）：跑 `node scratch/inline-tag-styles.cjs` 重新生成')
      process.exit(1)
    }
    console.log('✓ 内联区与源一致（' + block.length + ' 字符 / ' + sampleCount + ' 个样本）')
    return
  }

  // ── 写回（幂等：已有内联区就整块替换）───────────────────────────────────
  let next
  const at = clientSrc.indexOf(BEGIN)
  if (at >= 0) {
    const endAt = clientSrc.indexOf(END, at)
    if (endAt < 0) throw new Error('找到 BEGIN 却没有 END —— 内联区被截断了，请手工修好再跑')
    const after = endOfLine(clientSrc, endAt)
    next = clientSrc.slice(0, at) + block + clientSrc.slice(after)
  } else {
    const anchorAt = clientSrc.indexOf(ICONS_END_MARK)
    if (anchorAt < 0) {
      throw new Error('在 lib/client.js 里找不到插入锚点 `' + ICONS_END_MARK + '` —— 图标区被改形了？')
    }
    const insertAt = endOfLine(clientSrc, anchorAt)
    next = clientSrc.slice(0, insertAt) + EOL + block + clientSrc.slice(insertAt)
  }

  if (next === clientSrc) {
    console.log('✓ 内联区已是最新（' + block.length + ' 字符），文件未改动')
    return
  }
  fs.writeFileSync(CLIENT_PATH, next, 'utf8')
  console.log('✓ 已写入 lib/client.js')
  console.log('  TAG_STYLE_TABLE 求值后 JSON ' + tableJson.length + ' 字符')
  console.log('  内联区 ' + block.length + ' 字符')
  console.log('  指纹 lib/tag-styles.js = ' + tagStylesFp + ' / lib/tags.js = ' + tagsFp)
  console.log('  自检 ' + sampleCount + ' 个样本与源模块逐项一致（含反向对照）')
}

/**
 * 把内联块放进「没有模块私有作用域」的 vm 里求值，再与源模块比对，返回问题列表。
 *
 * ⚠️ 这是**生成器自己的**自检（跑生成时当场发现生成错了）。仓库里另有一条**常驻**守卫
 * 做同一件事（`test/tag-chip.test.mjs`）—— 两者都要有：前者抓「这次生成错了」，
 * 后者抓「生成之后源文件被改了、但没重跑生成器」。
 */
function compareBlock(block, { table, stylesMod, tagsMod, normalize }) {
  const problems = []
  const sandbox = { console: { log() {}, warn() {}, error() {} } }
  vm.createContext(sandbox)
  let got
  try {
    got = vm.runInContext(
      '(function(){\n' + block + '\nreturn { table: TAG_STYLE_TABLE, rule: tagStyleRule, normalizeTag: normalizeTag };\n})()',
      sandbox,
      { filename: 'client.js#inline-tag-styles' }
    )
  } catch (error) {
    return ['内联块求值失败（粘进 client.js 会当场炸）：' + (error && error.message ? error.message : String(error))]
  }

  if (JSON.stringify(got.table) !== JSON.stringify(table)) {
    problems.push('内联表的 JSON 与源 TAG_STYLE_TABLE 不逐字节相等')
  }

  // 归一化：拿真 normalizeTag 与内联那份逐样本比
  for (const s of NORMALIZE_CORPUS) {
    let a, b
    try { a = normalize(s) } catch (e) { a = 'THREW:' + e.message }
    try { b = got.normalizeTag(s) } catch (e) { b = 'THREW:' + e.message }
    if (a !== b) {
      problems.push('normalizeTag(' + JSON.stringify(s === undefined ? '__undefined__' : s)
        + ') 内联=' + JSON.stringify(b) + ' 源=' + JSON.stringify(a))
    }
  }

  const managed = [
    { id: 'a', tag: 'DSH', color: 'red', icon: 'video', weight: 'bold', size: 'large' },
    { id: 'b', tag: '调研' },
    { id: 'c', tag: 'gpNext', color: 'violet' },
  ]
  const tags = ['DSH', 'dsh', '调研', '弹幕梗', 'gp-next', '1080p']
  const cmp = (label, fn) => {
    let x, y
    try { x = JSON.stringify(fn(stylesMod)) } catch (e) { x = 'THREW:' + e.message }
    try { y = JSON.stringify(fn({ RULE: got.rule })) } catch (e) { y = 'THREW:' + e.message }
    if (x !== y) problems.push(label + ' 内联与源不同：内联=' + y + ' 源=' + x)
  }
  for (const t of tags) {
    cmp('resolve(' + t + ')', (m) => (m.RULE ? m.RULE.resolve(t, managed) : m.resolveTagStyle(t, managed)))
    cmp('layerOf(' + t + ')', (m) => (m.RULE ? m.RULE.layerOf(t, managed) : m.tagLayer(t, managed)))
    cmp('resolve(' + t + ')#group', (m) => (m.RULE ? m.RULE.resolve(t, managed, { surface: 'group' }) : m.resolveTagStyle(t, managed, { surface: 'group' })))
  }
  cmp('splitByLayer', (m) => (m.RULE ? m.RULE.splitByLayer(tags, managed) : m.splitTagsByLayer(tags, managed)))
  cmp('applySurface(chip)', (m) => (m.RULE ? m.RULE.applySurface({ color: 'red', size: 'large' }, 'chip') : m.applyTagStyleSurface({ color: 'red', size: 'large' }, 'chip')))
  cmp('applySurface(group)', (m) => (m.RULE ? m.RULE.applySurface({ color: 'red', size: 'large' }, 'group') : m.applyTagStyleSurface({ color: 'red', size: 'large' }, 'group')))
  cmp('checkBudget', (m) => (m.RULE ? m.RULE.checkBudget(managed) : m.checkManagedTagBudget(managed)))
  cmp('validateManaged', (m) => (m.RULE ? m.RULE.validateManaged(managed) : m.validateManagedTags(managed)))
  cmp('colorSlots', (m) => (m.RULE ? m.RULE.colorSlots() : m.TAG_COLOR_SLOTS))
  cmp('present', (m) => (m.RULE ? m.RULE.present({ color: 'red', icon: 'video', weight: 'bold', size: 'large' }) : m.styleToPresentation({ color: 'red', icon: 'video', weight: 'bold', size: 'large' })))
  cmp('channelsFor(chip)', (m) => (m.RULE ? m.RULE.channelsFor('chip') : m.channelsForSurface('chip')))
  // tagsMod 只用来确认源侧确实有 normalizeTag（防「两边都没有」的假一致）
  if (typeof tagsMod.normalizeTag !== 'function') problems.push('lib/tags.js 的 normalizeTag 不是函数')
  return problems
}

main().catch((error) => {
  console.error('✗ 生成失败：' + (error && error.stack ? error.stack : String(error)))
  process.exit(1)
})
