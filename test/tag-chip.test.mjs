/**
 * dsh-artifact-library · Step 3d **客户端接线**回归（缺口 1 / 3 / 4 / 6）
 *
 * 这个文件守的是「规则层做完了、用户一个字变化都看不到」那一类**静默断线**。
 * 它分成五节，每节都在防一件**具体见过**的坏法：
 *
 *   [A] 内联指纹      —— 改了 `lib/tag-styles.js` / `lib/tags.js` 却没重跑生成器（漂移）
 *   [B] 内联等价      —— 内联副本与源**算出了不同结果**（那是最阴的一种：同一张表两个答案）
 *   [C] 消费者绊线    —— `dropped`（被摘掉的字号 + 理由）在面板这一层被吃掉
 *   [D] 渲染行为      —— 真的把组件跑一遍：受管出芯片、自由出素文本、「读不到」≠「读到了但是空」
 *   [E] CSS / 接线    —— 用了不存在的 class（真机上就是裸文字）、组件写了但没接上
 *
 * ── 仓库规矩：每个守卫都要先对「已知坏版本」跑一遍，确认它**会红** ──────────────
 * 本文件的做法是把「判据」写成**纯函数**，然后**在同一个文件里**喂它一份已知坏版本，
 * 断言它确实报错（反向对照）。这样「守卫在空转」会当场暴露，而不是等下次真出事。
 * 另外 `[A]`/`[B]` 还额外支持**外部 bite-test**：本文件接受 `argv[2]` 当 client.js 路径，
 * 可以拿一份改坏的副本跑（见文件末尾的注释）。
 *
 * ── ⚠️ 守卫的输入预处理也要被验（本仓库栽过三次）──────────────────────────────
 * 好几条守卫是**扫源码文本**的。注释里必然会出现被扫的名字（比如「不许丢掉 dropped」
 * 这句话本身），所以扫描前**必须先剥注释**；而剥注释这个预处理**自己**也有反向对照
 * （`[C] C2`：注释里的名字不许命中、代码里的必须命中）。
 *
 * 运行：node test/tag-chip.test.mjs [client.js 路径]
 * 退出码：有失败 → 1
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripComments } from './_strip-comments.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_PATH = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'lib', 'client.js')
const TAG_STYLES_PATH = path.join(ROOT, 'lib', 'tag-styles.js')
const TAGS_PATH = path.join(ROOT, 'lib', 'tags.js')

let passed = 0
let failed = 0
const failureList = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    const message = error && error.message ? error.message : String(error)
    failureList.push({ name, message })
    console.log('  FAIL ' + name + ' -> ' + message)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed')
}

console.log('\n═══ 标签芯片 · 客户端接线（Step 3d）═══')
console.log(' 被测：' + CLIENT_PATH)

const CLIENT_RAW = fs.readFileSync(CLIENT_PATH, 'utf8')
const TAG_STYLES_RAW = fs.readFileSync(TAG_STYLES_PATH, 'utf8')

/* ══════════════════════════════════════════════════════════════════════════
 * 源码工具（**注释预处理**，带自己的反向对照）
 * ══════════════════════════════════════════════════════════════════════════ */



const CLIENT_SRC = stripComments(CLIENT_RAW)

/** 取内联区（含两端标记那一行）。找不到就回 ''（调用方负责报红，不许静默）。 */
function inlineRegion(src) {
  const a = src.indexOf('// >>> INLINE-TAG-STYLES-BEGIN')
  const b = src.indexOf('// <<< INLINE-TAG-STYLES-END')
  if (a < 0 || b < 0 || b < a) return ''
  const eol = src.indexOf('\n', b)
  return src.slice(a, eol < 0 ? src.length : eol + 1)
}
const REGION = inlineRegion(CLIENT_RAW)

/** 区里声明的指纹：`sha256[:16] = xxxx` 前面跟着哪个源文件。 */
function declaredFingerprints(region) {
  const out = {}
  const re = /源文件指纹\s+(\S+)\s+sha256\[:16\]\s*=\s*([0-9a-f]{16})/g
  let m
  while ((m = re.exec(region))) out[m[1]] = m[2]
  return out
}

/**
 * 指纹判据（**纯函数**，便于喂已知坏版本做反向对照）。
 * @returns {string[]} 问题清单（空 = 通过）
 */
function fingerprintProblems(region, actual) {
  const problems = []
  const declared = declaredFingerprints(region)
  for (const [file, want] of Object.entries(actual)) {
    if (!declared[file]) {
      problems.push('内联区没有声明 ' + file + ' 的 sha256[:16] 指纹 —— 漂移就无从发现')
      continue
    }
    if (declared[file] !== want) {
      problems.push('内联副本已过期：区里声明 ' + file + ' = ' + declared[file] + '，实际 = ' + want + '（改了源必须重跑生成器）')
    }
  }
  return problems
}

const sha16 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)
const ACTUAL_FP = { 'lib/tag-styles.js': sha16(TAG_STYLES_PATH), 'lib/tags.js': sha16(TAGS_PATH) }

/* ══════════════════════════════════════════════════════════════════════════
 * [A] 内联指纹（缺口 1）
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── [A] 内联指纹（改了源却没重跑生成器 → 必须红）──')

check('A1 内联区存在，且**排在 INLINE-ICONS 区之后**（不许抢走全文件第一处 sha256）', () => {
  assert(REGION.length > 5000, '找不到 INLINE-TAG-STYLES 区（或过短 ' + REGION.length + ' 字符）—— 生成器没跑过？')
  const iconsEnd = CLIENT_RAW.indexOf('// <<< INLINE-ICONS-END')
  assert(iconsEnd >= 0, '找不到 INLINE-ICONS-END —— 图标区被改形了')
  assert(CLIENT_RAW.indexOf('// >>> INLINE-TAG-STYLES-BEGIN') > iconsEnd,
    '标签样式内联区排在图标区**之前** —— ui-spec 用 indexOf 取全文件第一处 sha256，会被抢走')
  // 图标区的指纹仍必须是第一处（真正的后果，不是风格问题）
  const firstFp = CLIENT_RAW.search(/sha256\[:16\]/)
  assert(firstFp > 0 && firstFp < CLIENT_RAW.indexOf('// >>> INLINE-TAG-STYLES-BEGIN'),
    '全文件第一处 sha256 落进了标签样式区 —— 图标区的指纹门禁会读到错的声明')
})

check('A2 两个源文件的 sha256[:16] 都与内联区声明一致', () => {
  const problems = fingerprintProblems(REGION, ACTUAL_FP)
  assert(problems.length === 0, problems.join('；'))
  const declared = declaredFingerprints(REGION)
  assert(Object.keys(declared).length === 2,
    '内联区应声明**两个**指纹（lib/tag-styles.js + lib/tags.js），实际 ' + JSON.stringify(declared))
})

check('★ A3 反向对照：把声明改坏一个字符，A2 的判据必须报错（否则它在空转）', () => {
  const declared = declaredFingerprints(REGION)
  const key = 'lib/tag-styles.js'
  const flipped = declared[key].slice(0, 15) + (declared[key][15] === '0' ? '1' : '0')
  const tampered = REGION.replace(declared[key], flipped)
  assert(tampered !== REGION, '反向对照造不出来（替换没生效）')
  const problems = fingerprintProblems(tampered, ACTUAL_FP)
  assert(problems.length > 0, '★ 指纹被改坏了，判据却还是绿的 ⇒ A2 的「一致」不可信')
  // 反向对照之二：整个指纹行删掉 → 也必须红（「漏声明」不能等于「没问题」）
  const removed = REGION.replace(/^\s*\/\/ 源文件指纹.*$/gm, '')
  assert(removed !== REGION, '反向对照造不出来（指纹行没删掉）')
  assert(fingerprintProblems(removed, ACTUAL_FP).length > 0,
    '★ 指纹声明被整行删掉，判据却还是绿的 ⇒ 「没声明」被当成了「没问题」')
})

check('A4 生成器本体在仓库里（否则「怎么重新生成」无从谈起）', () => {
  const gen = path.join(ROOT, 'scratch', 'inline-tag-styles.cjs')
  assert(fs.existsSync(gen), '找不到 scratch/inline-tag-styles.cjs —— 内联区成了无法再生成的手抄件')
  const src = fs.readFileSync(gen, 'utf8')
  assert(/INLINE-TAG-STYLES-BEGIN/.test(src) && /INLINE-TAG-STYLES-END/.test(src),
    '生成器里的区标记与 client.js 对不上')
  // 生成器必须**求值**再吐字面量（TAG_STYLE_TABLE 在源里是 Object.fromEntries 现算的）
  assert(/await import\(/.test(src), '生成器没有 import 源模块 —— 那它多半是在抄源码文本（表会抄错）')
})

/* ══════════════════════════════════════════════════════════════════════════
 * 载入内联区 + 注入测试钩子
 * ══════════════════════════════════════════════════════════════════════════ */

/** 把内联区放进**没有模块私有作用域**的 vm 里求值。 */
function evalRegion(region) {
  const code = region.replace(/^[ \t]*\/\/[^\n]*$/gm, '')
  const sandbox = { console: { log() {}, warn() {}, error() {} } }
  vm.createContext(sandbox)
  return vm.runInContext(
    '(function(){\n' + code + '\nreturn { table: TAG_STYLE_TABLE, rule: tagStyleRule, normalizeTag: normalizeTag, decor: TAG_DECOR };\n})()',
    sandbox,
    { filename: 'client.js#inline-tag-styles' }
  )
}

const HOOK = 'exports.__test = { tagChips: tagChips, tagStyleRule: tagStyleRule, TAG_STYLE_TABLE: TAG_STYLE_TABLE, normalizeTag: normalizeTag, TAG_DECOR: TAG_DECOR, NS: NS, ICON_TABLE: ICON_TABLE, RightPanePreview: RightPanePreview };\n    exports.apply = apply;'
const ANCHOR = 'exports.apply = apply;'

/**
 * 把一份 client.js **源码文本**整份加载起来，取出 `exports.__test`。
 *
 * ⚠️ 做成「吃源码文本」而不是「一次性加载全局那一份」，是为了让反向对照
 *    （[G5]）能**真的把坏版本跑一遍** —— 「用一个等价的假输入模拟一下」证明不了
 *    被测代码在坏版本下的行为，那正是本仓库栽过的「假对照」。
 */
function loadClient(source) {
  let capturedLocal = null
  const box = {
    window: { __ModuleLoader__: { load: (def) => { capturedLocal = def } } },
    document: {
      baseURI: 'http://127.0.0.1:19387/',
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
      body: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    console: { info: () => {}, warn: () => {}, log: () => {}, error: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise, Intl, Date, isFinite, parseFloat, encodeURIComponent,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => '' }),
    location: { search: '' },
  }
  box.globalThis = box
  vm.createContext(box)
  vm.runInContext(source, box)
  if (!capturedLocal || typeof capturedLocal.factory !== 'function') return null
  const m = capturedLocal.factory((name) =>
    name === 'react'
      ? { createElement: fakeH, useState: (v) => [v, () => {}], useEffect() {}, useCallback: (f) => f, useRef: (v) => ({ current: v }) }
      : {}
  )
  m.apply({ get: () => undefined })
  return m
}

assert(CLIENT_RAW.includes(ANCHOR), '注入锚点 `' + ANCHOR + '` 不见了 —— 本文件的 HOOK/ANCHOR 要跟着改（不许静默变成空跑）')
const mod = loadClient(CLIENT_RAW.replace(ANCHOR, HOOK))
assert(mod, 'client.js 加载失败（factory 未被注册？）')

check('B0 测试钩子注入成功（依赖 client.js 里 `exports.apply = apply;` 这一行）', () => {
  assert(mod.__test, '注入失败：找不到锚点 —— 该行被改名/改形了，请同步更新本文件的 HOOK/ANCHOR')
})
const T = mod.__test || {}

/* ══════════════════════════════════════════════════════════════════════════
 * [B] 内联副本与源**逐样本等价**
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── [B] 内联副本 ≡ 源（同一张表不许算出两个答案）──')

const srcStyles = await import(pathToFileURL(TAG_STYLES_PATH).href)
const srcTags = await import(pathToFileURL(TAGS_PATH).href)

/**
 * 等价性判据（**纯函数**：喂 region 文本，回问题清单）。
 * 之所以做成纯函数：反向对照要能喂它一份**故意改坏**的 region。
 */
function equivalenceProblems(region) {
  const problems = []
  let got
  try {
    got = evalRegion(region)
  } catch (error) {
    return ['内联区求值失败（粘进 client.js 会当场炸）：' + (error && error.message ? error.message : String(error))]
  }
  if (JSON.stringify(got.table) !== JSON.stringify(srcStyles.TAG_STYLE_TABLE)) {
    problems.push('内联表与源 TAG_STYLE_TABLE 不逐字节相等')
  }
  for (const s of NORMALIZE_CORPUS) {
    let a, b
    try { a = srcTags.normalizeTag(s) } catch (e) { a = 'THREW:' + e.message }
    try { b = got.normalizeTag(s) } catch (e) { b = 'THREW:' + e.message }
    if (a !== b) problems.push('normalizeTag(' + JSON.stringify(s === undefined ? '__undefined__' : s) + ') 内联=' + JSON.stringify(b) + ' 源=' + JSON.stringify(a))
  }
  const managed = [
    { id: 'a', tag: 'DSH', color: 'red', icon: 'video', weight: 'bold', size: 'large' },
    { id: 'b', tag: '调研' },
    { id: 'c', tag: 'gpNext', color: 'violet' },
  ]
  const tags = ['DSH', 'dsh', '调研', '弹幕梗', 'gp-next', '1080p']
  const cmp = (label, fn) => {
    let x, y
    try { x = JSON.stringify(fn(srcStyles)) } catch (e) { x = 'THREW:' + e.message }
    try { y = JSON.stringify(fn({ RULE: got.rule })) } catch (e) { y = 'THREW:' + e.message }
    if (x !== y) problems.push(label + ' 内联=' + y + ' 源=' + x)
  }
  for (const t of tags) {
    cmp('resolve(' + t + ')', (m) => (m.RULE ? m.RULE.resolve(t, managed) : m.resolveTagStyle(t, managed)))
    cmp('resolve(' + t + ')#group', (m) => (m.RULE ? m.RULE.resolve(t, managed, { surface: 'group' }) : m.resolveTagStyle(t, managed, { surface: 'group' })))
    cmp('layerOf(' + t + ')', (m) => (m.RULE ? m.RULE.layerOf(t, managed) : m.tagLayer(t, managed)))
  }
  cmp('splitByLayer', (m) => (m.RULE ? m.RULE.splitByLayer(tags, managed) : m.splitTagsByLayer(tags, managed)))
  cmp('applySurface(chip)', (m) => (m.RULE ? m.RULE.applySurface({ color: 'red', size: 'large' }, 'chip') : m.applyTagStyleSurface({ color: 'red', size: 'large' }, 'chip')))
  cmp('applySurface(group)', (m) => (m.RULE ? m.RULE.applySurface({ color: 'red', size: 'large' }, 'group') : m.applyTagStyleSurface({ color: 'red', size: 'large' }, 'group')))
  cmp('checkBudget', (m) => (m.RULE ? m.RULE.checkBudget(managed) : m.checkManagedTagBudget(managed)))
  cmp('validateManaged', (m) => (m.RULE ? m.RULE.validateManaged(managed) : m.validateManagedTags(managed)))
  cmp('present', (m) => (m.RULE ? m.RULE.present({ color: 'red', icon: 'video', weight: 'bold', size: 'large' }) : m.styleToPresentation({ color: 'red', icon: 'video', weight: 'bold', size: 'large' })))
  return problems
}

/** 归一化语料：**真会踩的**（大小写 / 全角 / NFKC / 装饰符 / 空白 / 非字符串）。 */
const NORMALIZE_CORPUS = [
  'DSH', 'dsh', 'Dsh', 'godot', 'Godot', 'GODOT', 'GP-Next', 'gpNext',
  'ＤＳＨ', 'ＡＢＣ', 'ｇｏｄｏｔ',            // 全角（NFKC 折半角）
  'ﬁle', '①', 'Ⅻ', 'ⅰⅱ',                     // NFKC 会变形的其它形状
  '卫龙榴莲辣条·留恋计划', '卫龙榴莲辣条留恋计划',
  'a・b', 'a·b', 'a‐b', 'a‑b', 'a‒b', 'a–b', 'a—b', 'a―b', 'a-b', 'a_b', 'a b', 'ab',
  '  DSH  ', '\tDSH\n', '   ', '\u00a0',
  'C', 'C++', 'C#', 'F', 'F#', '.NET', 'NET', 'v0.3.0', 'v030',
  '···', '---', '',
  null, undefined, 42, 0, false, ['x'], { a: 1 },
]

check('B1 内联区在「没有模块私有作用域」的环境里能求值（含 TAG_STYLE_TABLE / tagStyleRule / normalizeTag）', () => {
  const got = evalRegion(REGION)
  assert(got.table && typeof got.table === 'object', 'TAG_STYLE_TABLE 没求出来')
  assert(got.rule && typeof got.rule.resolve === 'function', 'tagStyleRule 没建出来')
  assert(typeof got.normalizeTag === 'function', 'normalizeTag 没内联进来 —— 客户端会退化成逐字匹配')
})

check('B2 内联表 / normalizeTag / 规则函数与源**逐样本一致**（' + (NORMALIZE_CORPUS.length + 20) + ' 个样本）', () => {
  const problems = equivalenceProblems(REGION)
  assert(problems.length === 0, problems.slice(0, 6).join('；'))
})

check('★ B3 反向对照之一：内联副本去掉 `.toLowerCase()` → 等价性判据必须红', () => {
  const bad = REGION.replace('    .toLowerCase()', '')
  assert(bad !== REGION, '反向对照造不出来（region 里找不到 `.toLowerCase()`）')
  const problems = equivalenceProblems(bad)
  assert(problems.length > 0,
    '★ 归一化被改坏了（去掉 toLowerCase），判据却还是绿的 ⇒ B2 的「一致」不可信')
})

check('★ B4 反向对照之二：内联的 `TAG_DECOR` 被换成不匹配任何东西的正则 → 必须红', () => {
  // 这正是「看着像内联了、其实归一化不完整」的假内联：函数在、依赖也在，但依赖是错的。
  const m = /const TAG_DECOR = (\/.*\/[a-z]*)/.exec(REGION)
  assert(m, '内联区里找不到 TAG_DECOR 的字面量 —— 依赖没被一起内联？')
  const bad = REGION.replace(m[1], '/\\u0000zzz-never-matches/gu')
  assert(bad !== REGION, '反向对照造不出来（替换没生效）')
  const problems = equivalenceProblems(bad)
  assert(problems.length > 0,
    '★ TAG_DECOR 被换成了空转的正则，判据却还是绿的 ⇒ 它没在真的验「装饰符折叠」')
})

check('★ B5 反向对照之三：内联表改一个值（limit） → 必须红', () => {
  const bad = REGION.replace('"limit": null', '"limit": 3')
  assert(bad !== REGION, '反向对照造不出来（表里找不到 "limit": null）')
  assert(equivalenceProblems(bad).length > 0, '★ 内联表被改了值，判据却还是绿的')
})

check('B6 归一化兜底在**行为上**真的生效（受管 `DSH` → 记录里的 `dsh` 也是受管）', () => {
  // 这条是「为什么非要内联第三段」的行为级证明：不内联 normalizeTag 的话这里会判 free。
  const r = T.tagStyleRule.resolve('dsh', [{ id: 'a', tag: 'DSH', color: 'red' }])
  assert(r.layer === 'managed', '`dsh` 没匹配到受管的 `DSH` —— 归一化没生效（客户端退化成了逐字匹配）')
  assert(r.preset && r.preset.color, '匹配上了却没拿到颜色')
  // 反向：首尾空白**明确不兜底**（那是盖住问题，不是渲染该干的事）
  assert(T.tagStyleRule.layerOf(' dsh ', [{ id: 'a', tag: 'DSH' }]) === 'free',
    '带首尾空白的标签被判成受管了 —— 规则层明确不兜底这一种')
})

/* ══════════════════════════════════════════════════════════════════════════
 * [C] 消费者绊线：`dropped` 不许被吃掉
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── [C] `dropped` 消费者绊线（面板是用户唯一看得见的那一层）──')

/** 取一个具名函数的源码（剥注释后按花括号配平切片；切不出来就**报错**，不许静默回空串）。 */
function bodyOf(src, name) {
  const head = 'function ' + name + '('
  const at = src.indexOf(head)
  if (at < 0) return ''
  let i = src.indexOf('{', at)
  if (i < 0) return ''
  let depth = 0
  let quote = null
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) quote = null
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i += 1; continue }
    if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) return src.slice(at, i + 1) }
    i += 1
  }
  return ''
}

/** 「转达 dropped」的判据（**纯函数**，可喂坏版本）。 */function droppedRelayProblems(componentBody) {
  const problems = []
  if (!componentBody) return ['取不到 tagChips 的函数体（改名/改形了？请同步本测试）']
  if (!/\bdropped\b/.test(componentBody)) {
    problems.push('tagChips 里**完全没有** dropped —— 规则层特地连着理由一起返回它，就是为了「让调用方必须有机会告诉用户」')
  }
  // 光出现还不够：得真的把它**用在能被用户看到的地方**（title / 文案 / 任何输出）
  if (!/\.reason\b/.test(componentBody)) {
    problems.push('tagChips 提到了 dropped 却没读 `.reason` —— 那说明它只判了个长度，理由没转达给用户')
  }
  return problems
}

const CHIP_BODY = bodyOf(CLIENT_SRC, 'tagChips')

/**
 * 切出 `var NAME = React.useCallback(function () {…})` 的函数体（按花括号配平）。
 *
 * ⚠️ 为什么需要它（F5 的教训）：**宽切片（`slice(at, at + N)`)会越界框进后面的函数**，
 * 于是「在 A 里删掉某行」这种坏版本**照样绿**。凡是「这个函数里必须有什么」的断言，
 * 都得先**精确切出这个函数**，别拿一个长度窗口凑合。
 */
function callbackBodyOf(src, name) {
  const head = 'var ' + name + ' = React.useCallback('
  const at = src.indexOf(head)
  if (at < 0) return ''
  let i = src.indexOf('{', at)
  if (i < 0) return ''
  let depth = 0
  let quote = null
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) quote = null
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i += 1; continue }
    if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) return src.slice(at, i + 1) }
    i += 1
  }
  return ''
}

check('C1 `tagChips` 的函数体取到了（切不出来要当场报，不许静默变空跑）', () => {
  assert(CHIP_BODY, '取不到 tagChips 的函数体 —— 本节的判据前提失效')
  assert(CHIP_BODY.length > 500, 'tagChips 函数体只有 ' + CHIP_BODY.length + ' 字符，切错了')
})

check('★ C2 剥注释预处理自验：注释里的 `dropped` 不许命中、代码里的必须命中', () => {
  const onlyInComment = 'function f() {\n  // 这里提到了 dropped 和 .reason\n  /* dropped .reason */\n  return 1\n}'
  const stripped = stripComments(onlyInComment)
  assert(!/\bdropped\b/.test(stripped),
    '★ 注释里的 dropped 没被剥掉 —— 本节的扫描会被**自己注释里的话**喂假信号（本仓库栽过三次）')
  assert(!/\.reason\b/.test(stripped), '★ 注释里的 .reason 没被剥掉')
  const inCode = 'function f() {\n  var dropped = []\n  return dropped[0].reason\n}'
  const s2 = stripComments(inCode)
  assert(/\bdropped\b/.test(s2) && /\.reason\b/.test(s2), '剥注释把**代码里**的 dropped 也剥掉了 ⇒ 判据恒红')
})

check('C3 真源码里 `tagChips` 把 dropped 串给了用户', () => {
  const problems = droppedRelayProblems(CHIP_BODY)
  assert(problems.length === 0, problems.join('；'))
})

check('★ C4 反向对照：把 tagChips 里所有 dropped 用法删掉 → C3 必须红', () => {
  const bad = CHIP_BODY.replace(/\bdropped\b/g, 'zzz').replace(/\.reason\b/g, '.zzz')
  assert(bad !== CHIP_BODY, '反向对照造不出来（替换没生效）')
  assert(droppedRelayProblems(bad).length > 0,
    '★ 一个**确实丢掉了 dropped** 的版本被判成通过 ⇒ C3 是假绿')
  // 反向对照之二：只提到名字、不读 reason（"只判长度"的假转达）
  const nameOnly = CHIP_BODY.replace(/\.reason\b/g, '.zzz')
  assert(droppedRelayProblems(nameOnly).length > 0,
    '★ 一个只数了 dropped 长度、没转达理由的版本被判成通过 ⇒ 判据太松')
})

/* ══════════════════════════════════════════════════════════════════════════
 * [D] 渲染行为（真的跑一遍）
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── [D] 渲染行为（受管出芯片 / 自由出素文本 / 读不到≠空）──')

/** 极简 `h`：把元素树拍成普通对象，便于断言。 */
function fakeH(type, props, ...children) {
  const flat = []
  const push = (x) => {
    if (x === null || x === undefined || x === false || x === true) return
    if (Array.isArray(x)) { x.forEach(push); return }
    flat.push(x)
  }
  children.forEach(push)
  return { type, props: props || {}, children: flat }
}
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  ;(node.children || []).forEach((c) => walk(c, out))
  return out
}
const cls = (n) => String((n && n.props && n.props.className) || '')
function render(tags, options) {
  const tree = T.tagChips(fakeH, tags, options)
  const nodes = tree ? walk(tree) : []
  return {
    tree,
    nodes,
    chips: nodes.filter((n) => cls(n) === T.NS + '__tagchip'),
    free: nodes.filter((n) => cls(n) === T.NS + '__tagfree'),
    icons: nodes.filter((n) => cls(n) === T.NS + '__tagchipi'),
    warns: nodes.filter((n) => cls(n) === T.NS + '__tagwarn'),
    text: nodes.map((n) => (typeof n === 'string' ? n : '')).join('|'),
  }
}
const textOf = (node) => walk(node).map((n) => (typeof n === 'string' ? n : (n.children || []).filter((c) => typeof c === 'string').join(''))).join('')

const MANAGED = [
  { id: 'v', tag: '视频项目', color: 'red', icon: 'video', weight: 'bold', size: 'large' },
  { id: 'r', tag: '调研' },
  { id: 'd', tag: 'DSH', color: 'blue' },
]

check('D1 受管标签渲染成芯片；自由词渲染成素文本', () => {
  const out = render(['视频项目', '弹幕梗', '调研'], { managed: MANAGED, surface: 'chip' })
  assert(out.chips.length === 2, '受管芯片数应为 2，实际 ' + out.chips.length)
  assert(out.free.length === 1, '自由词数应为 1，实际 ' + out.free.length)
  assert(textOf(out.free[0]) === '弹幕梗', '自由词内容不对：' + textOf(out.free[0]))
})

check('D2 芯片带**图标 + 颜色 + 字重**（三样都是规则层给的，不是组件自己猜的）', () => {
  const out = render(['视频项目'], { managed: MANAGED, surface: 'chip' })
  const chip = out.chips[0]
  assert(chip, '没渲染出芯片')
  assert(out.icons.length === 1, '芯片里没有图标（__tagchipi）')
  const html = String(out.icons[0].props.dangerouslySetInnerHTML && out.icons[0].props.dangerouslySetInnerHTML.__html || '')
  assert(html.indexOf('<svg') >= 0, '图标不是内联 SVG：' + html.slice(0, 40))
  assert(String(chip.props.style.color).indexOf('var(--dsw-static-red-600)') >= 0,
    '颜色不是色板 token：' + chip.props.style.color)
  assert(chip.props.style.fontWeight === 600, '字重不是 600（本项目的「加粗」口径）：' + chip.props.style.fontWeight)
})

check('D3 **受管但没配样式**的条目照样是芯片（证明「受管 ≠ 有样式」）', () => {
  const out = render(['调研'], { managed: MANAGED, surface: 'chip' })
  assert(out.chips.length === 1, '没配样式的受管条目被渲染成了素文本')
  const chip = out.chips[0]
  assert(!chip.props.style.color && !chip.props.style.fontWeight, '没配样式却带了样式：' + JSON.stringify(chip.props.style))
  assert(out.icons.length === 0, '没配图标却渲染了图标')
})

check('D4 ★★ 「读不到受管表」与「读到了但是空」**必须分得开**', () => {
  // 读不到：null（还没拉到 / 端点失败）→ 素文本 + **一条警告**
  const unknown = render(['视频项目', '弹幕梗'], { managed: null, surface: 'chip' })
  assert(unknown.chips.length === 0, '读不到受管表却渲染出了芯片')
  assert(unknown.free.length === 2, '读不到时应全部降级成素文本')
  assert(unknown.warns.length === 1, '★ 读不到受管表却**一声不吭** —— 用户会以为自己的样式配置丢了')
  // 读到了、确实是空表：素文本，但**没有**警告（这不是故障）
  const empty = render(['视频项目', '弹幕梗'], { managed: [], surface: 'chip' })
  assert(empty.chips.length === 0, '空表却渲染出了芯片')
  assert(empty.warns.length === 0, '★ 空表被当成了故障 —— 「没有受管标签」被显示成「读不到」')
})

check('D5 规则层抛异常时降级但**说出来**（不静默）', () => {
  // 喂一个 splitByLayer 会炸的 managed（getter 抛）
  const bomb = {}
  Object.defineProperty(bomb, 'length', { get() { throw new Error('boom') } })
  const out = render(['a'], { managed: bomb, surface: 'chip' })
  assert(out.warns.length === 1, '规则层炸了却没有任何提示 —— 静默降级')
  assert(out.free.length === 1, '炸了之后没有降级成素文本')
})

check('D6 ★ 被摘掉的 `size` 的理由**出现在芯片的 title 里**（消费者真的转达了）', () => {
  const out = render(['视频项目'], { managed: MANAGED, surface: 'chip' })
  const chip = out.chips[0]
  const title = String(chip.props.title || '')
  assert(title.indexOf('字号') >= 0, '芯片 title 里没有字号被摘掉的理由：' + JSON.stringify(title))
  // 容器上也该有一条小字（悬停看不到的地方也要能看见）
  assert(out.warns.length === 1, '有 dropped 却没有容器级提示')
  assert(textOf(out.warns[0]).indexOf('字号') >= 0, '容器级提示里没说清是哪个通道：' + textOf(out.warns[0]))
  assert(chip.props.style.fontSize === undefined, 'chip 面上不该有 fontSize（规则层明确摘掉了）')
})

check('D7 `surface: "group"` 时 `size` 生效（组件照规则层的决定渲染，不自己判一遍）', () => {
  const out = render(['视频项目'], { managed: MANAGED, surface: 'group' })
  const chip = out.chips[0]
  assert(String(chip.props.style.fontSize || '').indexOf('var(--dsh-content-font-size') >= 0,
    'group 面上 fontSize 没生效 —— 组件把规则层允许的通道**静默吃掉**了：' + JSON.stringify(chip.props.style))
  assert(out.warns.length === 0, 'group 面上没有 dropped，却报了警告')
})

check('D8 渲染顺序 = **记录里的原始顺序**（不许把标签重排）', () => {
  const out = render(['弹幕梗', '视频项目', 'zzz', '调研'], { managed: MANAGED, surface: 'chip' })
  const seq = []
  walk(out.tree).forEach((n) => {
    if (cls(n) === T.NS + '__tagchip' || cls(n) === T.NS + '__tagfree') seq.push(textOf(n))
  })
  assert(seq.join('>') === '弹幕梗>视频项目>zzz>调研', '顺序被重排了：' + seq.join('>'))
})

check('D9 **逐字**去重（不做归一化合并 —— 那是 3b 的活，而且要人确认）', () => {
  const out = render(['调研', '调研', 'DSH', 'dsh'], { managed: MANAGED, surface: 'chip' })
  const names = out.chips.map((c) => textOf(c))
  assert(names.filter((x) => x === '调研').length === 1, '逐字重复没去重：' + names.join(','))
  assert(names.filter((x) => x === 'DSH' || x === 'dsh').length === 2,
    'DSH / dsh 被**归一化合并**了 —— 渲染层顺手改数据是最坏的做法：' + names.join(','))
  // 但两者都该是**芯片**（读路径的归一化兜底生效）
  assert(names.length === 3, '应有 3 个芯片（调研 / DSH / dsh），实际 ' + names.length)
})

check('D10 没有标签 / 全是空串 → 回 null（调用方照旧判空）', () => {
  assert(T.tagChips(fakeH, [], { managed: MANAGED }) === null, '空数组该回 null')
  assert(T.tagChips(fakeH, ['', null, undefined], { managed: MANAGED }) === null, '全是空值该回 null')
  assert(T.tagChips(fakeH, null, { managed: MANAGED }) === null, 'null 该回 null')
})

check('D11 颜色/字重**只来自规则层**：受管表里出现非法样式也不崩、不显示', () => {
  // 存储被手改过的场景（http.js 的注释明说 settings.json 可能被手改）
  const dirty = [{ id: 'x', tag: '脏', color: '#ff0000', weight: '700' }]
  const out = render(['脏'], { managed: dirty, surface: 'chip' })
  assert(out.chips.length === 1, '非法样式导致连芯片都不渲染了')
  assert(!out.chips[0].props.style.color, '非法色值被渲染出去了：' + out.chips[0].props.style.color)
})

/* ══════════════════════════════════════════════════════════════════════════
 * [E] CSS 与接线（缺口 4 / 6）
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── [E] CSS 与接线（新 class 在真机上没样式 = 裸文字）──')

/** 取出 CSS 数组拼成的整段文本（与 ui-spec 同一手法）。 */
function cssText(src) {
  const start = src.indexOf('var css = [')
  if (start < 0) return ''
  const end = src.indexOf('].join(', start)
  if (end < 0) return ''
  const region = src.slice(start, end).replace(/\bNS\b/g, 'alf')
  const parts = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(region))) parts.push(m[1].replace(/\\(.)/g, '$1'))
  return parts.join('')
}
const CSS_TEXT = cssText(CLIENT_SRC)

/** `tagChips` 里用到的 class 是否都在 CSS 里有定义。 */
function cssCoverageProblems(componentBody, css) {
  const used = new Set()
  const re = /NS\s*\+\s*"(__[a-z0-9]+)"/g
  let m
  while ((m = re.exec(componentBody))) used.add(m[1])
  const missing = []
  for (const name of used) if (css.indexOf('.' + name + '{') < 0 && css.indexOf('.' + name + ',') < 0 && css.indexOf('.' + name + ':') < 0) missing.push(name)
  return { used: [...used], missing }
}

check('E1 `tagChips` 用到的每个 class 都在 CSS 里有定义', () => {
  assert(CSS_TEXT.length > 5000, '取不到 CSS 文本（锚点失配？）长度 ' + CSS_TEXT.length)
  const { used, missing } = cssCoverageProblems(CHIP_BODY, CSS_TEXT)
  assert(used.length >= 3, '从 tagChips 里只扫到 ' + used.length + ' 个 class —— 扫描前提失效')
  assert(missing.length === 0, '这些 class 没有 CSS 定义（真机上是裸文字）：' + missing.join(', '))
})

check('★ E2 反向对照：用一个不存在的 class → E1 的判据必须红', () => {
  // ⚠️ 这里栽过一次（值得留）：第一版把 `__tagchip"` 改成 `__tagchipNOPE"`，
  //    结果**没红** —— 不是判据太松，是**变异本身无效**：E1 的扫描正则只认
  //    `[a-z0-9]`，大写名字它**根本没看见**，于是「missing」当然为空。
  //    ⇒ 教训与 Lead 那次 M2 同型：**变异测试本身写错会得到「假绿」**。
  //    所以下面多一条：先确认**扫描真的看到了**这个坏名字，再判它该红。
  const FAKE = '__tagchipzzz'
  const bad = CHIP_BODY.replace('__tagchip"', FAKE + '"')
  assert(bad !== CHIP_BODY, '反向对照造不出来（替换没生效）')
  const { used, missing } = cssCoverageProblems(bad, CSS_TEXT)
  assert(used.indexOf(FAKE) >= 0,
    '★ 反向对照无效：扫描**根本没看到**坏名字 ' + FAKE + '（那「没红」什么也证明不了）—— 变异要重造')
  assert(missing.length > 0, '★ 用了不存在的 class 却判成通过 ⇒ E1 是假绿')
})

check('★ E2b 反向对照之二：把 CSS 里的定义删掉（而不是改组件）→ E1 也必须红', () => {
  // 换一个方向造坏版本：组件不动，**CSS 少一条定义**（真机上就是裸文字）。
  const m = /\.__tagchips\{/.exec(CSS_TEXT)
  assert(m, 'CSS 里找不到 .__tagchips{ —— E1 的判据前提失效')
  const badCss = CSS_TEXT.replace('.__tagchips{', '.__tagchipsX{')
  assert(badCss !== CSS_TEXT, '反向对照造不出来（替换没生效）')
  const { missing } = cssCoverageProblems(CHIP_BODY, badCss)
  assert(missing.indexOf('__tagchips') >= 0,
    '★ CSS 定义被删了却判成通过 ⇒ E1 只看组件那半边，没真的查 CSS')
})

check('E3 芯片的样式里**没有 hex**（颜色只走 token）', () => {
  const seg = CLIENT_SRC.slice(CLIENT_SRC.indexOf('__tagchips{'), CLIENT_SRC.indexOf('__tagwarn{') + 200)
  const hex = seg.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  assert(hex.length === 0, '标签芯片的 CSS 里出现了 hex：' + hex.join(','))
})

/**
 * 按**花括号配平**切出「`marker` 所在的那个 `React.useEffect`」的函数体。
 *
 * ⚠️ 为什么要这么切（而不是固定长度窗口）：见 F5b —— 宽窗口会把**后面那个**
 *    effect 里的合法代码也框进来，于是判据要么假绿、要么假红。
 *
 * @param {string} src
 * @param {string} marker 该 effect 体内**唯一**的一句（用来定位）
 * @returns {string} 函数体（含首尾花括号），定位失败返回 `''`
 */
function effectBodyBy(src, marker) {
  const at = src.indexOf(marker)
  if (at < 0) return ''
  const start = src.lastIndexOf('React.useEffect(function () {', at)
  if (start < 0) return ''
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

/* ── [F] 接线：受管表 → tagChips ──────────────────────────────────────────
 * ⭐ **2026-10-14 移植**：原来这组守的是主面板里的 `DetailDrawer` / `reloadManaged`
 *    / `reload`。面板删了 ⇒ 主体换成**右栏预览 + 它自己的受管表加载 effect**。
 *    守的**性质没变**：「调用点必须显式传 surface」「拉失败不许拍平成空表」
 *    「列表重拉不许把 managed 弄丢」—— 只是换了个地方守。
 * ────────────────────────────────────────────────────────────────────────── */

check('F1 ★ 右栏预览真的调了 `tagChips`，且**显式传了 surface: "chip" + 受管表**', () => {
  const hits = [...CLIENT_SRC.matchAll(/tagChips\(h,\s*\w+\.tags,\s*\{([^}]*)\}/g)]
  assert(hits.length >= 1, '没有任何地方调用 tagChips —— 组件写了但没接上（定稿 §四·3 那个缺口）')
  assert(/surface:\s*"chip"/.test(hits[0][1]), '调用点没显式传 surface: "chip"：' + hits[0][1])
  assert(/managed:\s*managedTags/.test(hits[0][1]),
    '调用点没把受管表传进去 —— 那样所有标签都会退化成素文本：' + hits[0][1])
})

check('★ F1b 反向对照：把 `surface: "chip"` 改掉 → F1 的判据必须红', () => {
  const GOOD = 'surface: "chip"'
  assert(CLIENT_SRC.indexOf(GOOD) >= 0, 'F1b 前提失效：源码里找不到 ' + GOOD)
  const bad = CLIENT_SRC.replace(GOOD, 'surface: "group"')
  assert(bad !== CLIENT_SRC, '反向对照造不出来（替换没生效）')
  const hits = [...bad.matchAll(/tagChips\(h,\s*\w+\.tags,\s*\{([^}]*)\}/g)]
  assert(hits.length >= 1, '★ 变异后连调用点都找不到了 ⇒ F1 的扫描器本身有问题')
  assert(!/surface:\s*"chip"/.test(hits[0][1]),
    '★ surface 被改掉了 F1 却还判绿 ⇒ F1 是假绿')
})

check('F2 ★ 旧的纯文本标签渲染**已经不在了**（防「两套并存」）', () => {
  assert(CLIENT_SRC.indexOf('(record.tags || []).join(" · ")') < 0,
    '还留着 `(record.tags || []).join(" · ")` 这条旧路径 —— 芯片组件等于没接上')
})

check('F3 ★ 受管表真的从 `GET /ext/artifacts/managed-tags` 拉', () => {
  assert(/apiGet\("\/managed-tags"\)/.test(CLIENT_SRC), '没有任何地方拉 /managed-tags —— 受管表永远是空的')
})

check('F4 ★ 拉失败**不写成空数组**（否则「读不到」被拍平成「空」）', () => {
  const body = effectBodyBy(CLIENT_SRC, 'apiGet("/managed-tags")')
  assert(body, '切不出受管表的加载 effect —— F4 的判据前提失效（加载通道被改名/删掉了？）')
  assert(/ok:\s*false/.test(body), '失败路径里没有 ok:false —— 失败被静默吞掉了')
  assert(!/\[\]/.test(body.replace(/managed-tags/g, '')),
    '★ 失败/形状不对时写成了 `[]` —— 那就和「确实没有受管标签」长得一样了')
})

check('F5 ★ 列表重拉**不许碰** `managed`（它是独立状态，不随筛选重建）', () => {
  // ⚠️ 这条与旧版的**性质相同、形状不同**：
  //    旧面板把 `managed` 塞在同一个 `data` 对象里，靠 `reload` 带
  //    `managed: previous.managed` 保住它；右栏是**独立 state**，天生不会被列表重拉碰。
  //    ⇒ 判据改成「列表 effect 里不许出现 setManaged」——
  //      这才是这个架构下「弄丢 managed」唯一可能的路径。
  const listBody = effectBodyBy(CLIENT_SRC, 'setSnap({ status: "loading", items: [], error: "" });')
  assert(listBody, '切不出列表加载 effect —— F5 的判据前提失效')
  assert(listBody.indexOf('setManaged') < 0,
    '★ 列表 effect 里出现了 setManaged —— 每次筛选都会把受管表重置（样式会闪没）')
})

check('★ F5b 反向对照：宽窗口会**假红** ⇒ 证明 F5 的花括号配平不是装饰', () => {
  // 同一份**好源码**：
  //   · 花括号配平切出的「列表 effect」里**没有** setManaged ⇒ 绿（正确）
  //   · 而一个够宽的固定窗口会**越过 effect 的边界**，把前面那个受管表 effect
  //     里的合法 `setManaged` 框进来 ⇒ 假红
  // 两半都成立，才说明「配平切法」在这里有实际后果。
  //
  // ⚠️ 相对位置（2026-10-14 实测）：受管 effect 在列表 effect **之前** 413 字符，
  //    三个 `setManaged` 分别在列表 effect 起点前 626 / 344 / 281 字符。
  //    ⇒ 往前取 900 字符就会框进后两个。**这个前提写进断言**（位置一变就当场红，
  //      不会退化成空转 —— 我第一版就是取「往后 1800」，方向反了，被这条当场抓住）。
  const at = CLIENT_SRC.indexOf('setSnap({ status: "loading", items: [], error: "" });')
  assert(at > 0, '找不到列表 effect 锚点 `setSnap({ status: "loading" … })`')
  const narrow = effectBodyBy(CLIENT_SRC, 'setSnap({ status: "loading", items: [], error: "" });')
  assert(narrow, '切不出列表 effect')
  const wide = CLIENT_SRC.slice(at - 900, at + 1200)
  assert(wide.length > narrow.length, '宽切片没比配平切片长 —— 对照不成立')
  assert(narrow.indexOf('setManaged') < 0, '前提失效：配平切片里本来就有 setManaged')
  assert(wide.indexOf('setManaged') >= 0,
    '★ 宽切片里也没有 setManaged ⇒ 这条对照想证明的前提不成立（两个 effect 的相对位置变了，请重新量）')
  // 反向：往列表 effect 里塞一句 setManaged ⇒ F5 的判据必须能看见
  const badNarrow = narrow.replace('setSnap({ status: "loading"', 'setManaged(null); setSnap({ status: "loading"')
  assert(badNarrow !== narrow, '反向对照造不出来（替换没生效）')
  assert(badNarrow.indexOf('setManaged') >= 0, '★ 塞进去后仍找不到 ⇒ F5 的判据没落在列表 effect 上')
})

/* ══════════════════════════════════════════════════════════════════════════
 * [G] 端到端：真的渲染 `RightPanePreview`（不只是单测组件）
 * ══════════════════════════════════════════════════════════════════════════
 * ⭐ **2026-10-14 移植**：原来这段渲染的是 `DetailDrawer`（主面板的详情抽屉）。
 *    依琪拍板「主区面板不要了，全部转到右侧栏」⇒ 面板连同 `DetailDrawer` 一起删了。
 *
 *    ⚠️ 但**标签芯片这个功能是活的** —— 所以按「废弃 + 移植」把它接到了
 *       **右栏预览**（`RightPanePreview`）上：`RightPaneBody` 拉 `/managed-tags`，
 *       一路传到 `tagChips`。这段守卫因此**换了个主体继续存在**，不是被删掉。
 *
 *    原来的主体 `DetailDrawer` 已不存在 ⇒ 若哪天有人想把这段改回去，请先看
 *    `docs/DEPRECATED-TESTS.md`。
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n── [G] 端到端：RightPanePreview 真的把 props.managed 送到了芯片 ──')

/**
 * 用真 `RightPanePreview` 渲染一条记录。
 * ⚠️ 这里要的是**接线**（props.managed → managedTags → tagChips），
 *    不是组件内部逻辑（那个 [D] 已经单独测过）。所以断言只看「芯片出没出来」。
 *
 * ⚠️ 直接**调用**函数组件（不是 `h(Component, props)`）——
 *    `fakeH` 只记 `{type, props, children}`、**不执行**组件，
 *    所以必须像旧版那样把组件当普通函数调，才能 `walk` 到它返回的树。
 */
function renderPreview(record, managed) {
  const el = T.RightPanePreview({ record, managed, onBack() {} })
  return el
}

// `RightPanePreview` 里 `var React = require("react")` —— 假 module loader 在 factory 时
// 已经把 `react` 换成了最小替身（见 `loadClient`），所以这里不用再传第二个参数。
const RECORD = {
  id: 'art_x', title: '测试产物', path: 'C:\\proj\\a.md', exists: true,
  mime_type: 'text/markdown', artifact_type: 'document', source: 'manual',
  tags: ['视频项目', '弹幕梗', '调研'], stars: 0, created_at: 1790000000000, size_bytes: 100,
}

check('G1 端到端：`props.managed.ok === true` → 右栏预览里真的渲染出芯片', () => {
  const el = renderPreview(RECORD, { ok: true, tags: MANAGED, limit: null })
  const nodes = walk(el)
  const chips = nodes.filter((n) => cls(n) === T.NS + '__tagchip')
  const free = nodes.filter((n) => cls(n) === T.NS + '__tagfree')
  assert(chips.length === 2, '预览里受管芯片数应为 2（视频项目 / 调研），实际 ' + chips.length)
  assert(free.length === 1, '预览里自由词应为 1（弹幕梗），实际 ' + free.length)
  assert(nodes.some((n) => cls(n) === T.NS + '__tagchipi'), '芯片里没有图标')
})

check('G2 端到端：`props.managed = {ok:false}` → 素文本 + 警告（不是「空」）', () => {
  const el = renderPreview(RECORD, { ok: false, error: 'HTTP 500' })
  const nodes = walk(el)
  assert(nodes.filter((n) => cls(n) === T.NS + '__tagchip').length === 0, '读失败却渲染出了芯片')
  assert(nodes.filter((n) => cls(n) === T.NS + '__tagwarn').length === 1,
    '★ 预览里「受管表读不到」一声不吭 —— 用户会以为自己的样式配置丢了')
})

check('G3 端到端：`props.managed = {ok:true, tags:[]}` → 素文本、**无警告**（确实没有受管标签）', () => {
  const el = renderPreview(RECORD, { ok: true, tags: [], limit: null })
  const nodes = walk(el)
  assert(nodes.filter((n) => cls(n) === T.NS + '__tagchip').length === 0, '空表却渲染出了芯片')
  assert(nodes.filter((n) => cls(n) === T.NS + '__tagwarn').length === 0,
    '★ 「确实没有受管标签」被显示成了故障 —— 两种状态又被拍平了')
})

check('G4 端到端：没传 `props.managed`（还没拉到）→ 不崩、降级 + 警告', () => {
  const el = renderPreview(RECORD, undefined)
  const nodes = walk(el)
  assert(nodes.filter((n) => cls(n) === T.NS + '__tagfree').length === 3, '没降级成素文本')
  assert(nodes.filter((n) => cls(n) === T.NS + '__tagwarn').length === 1, '还没拉到却一声不吭')
})

check('★ G5 反向对照：把 `rpManagedTags` 改成「失败也当空表」→ G2 必须红', () => {
  // ⚠️ 2026-10-19：取值统一走 `rpManagedTags()` 之后，**不变量搬到了那个函数里**。
  //    所以反向对照要**改坏它**，而不是改坏预览页那行（那行现在只有一句调用）。
  //
  // 守的不变量（原样保留）：
  //    `{ok:false}`（拉过且失败）**不许**被当成 `[]`（拉到了但空表）——
  //    两者的下一步动作不同：一个去查设置，一个什么都不用做。
  const FIND = /function rpManagedTags\(body\) \{[\s\S]*?\n {4}\}/
  const m = FIND.exec(CLIENT_RAW)
  assert(m, '反向对照造不出来（找不到 rpManagedTags 函数 —— 它被改形了，请同步本测试）')

  // 坏版本：失败也返回空数组（把三态拍平成两态）
  const BAD = 'function rpManagedTags(body) {\n'
    + '      if (!body || typeof body !== "object") return [];\n'
    + '      if (Array.isArray(body)) return body;\n'
    + '      if (Array.isArray(body.tags)) return body.tags;\n'
    + '      return [];\n'
    + '    }'
  const mutated = CLIENT_RAW.replace(FIND, BAD)
  assert(mutated !== CLIENT_RAW && mutated.indexOf(BAD) >= 0, '反向对照没落到源码上')

  // ⚠️ 坏版本也要先注入 HOOK，否则拿不到 __test
  const badMod = loadClient(mutated.replace(ANCHOR, HOOK))
  assert(badMod && badMod.__test, '坏版本加载失败 —— 反向对照不成立（HOOK 注入了吗？）')
  // 坏版本下 `{ok:false}` 会变成 `[]` ⇒ 预览页不再警告 ⇒ G2 会红
  const el = badMod.__test.RightPanePreview({
    record: RECORD,
    managed: { ok: false, error: 'HTTP 500' },
    onBack() {},
  })
  const nodes = walk(el)
  const warns = nodes.filter((n) => cls(n) === T.NS + '__tagwarn')
  assert(warns.length === 0,
    '★ 坏版本居然还在警告 —— 说明反向对照没真的改到逻辑（改了 ' + mutated.length + ' 字符）')
})

check('G6 ★ 反向对照（指纹）：改 `lib/tags.js` 内容而不重跑生成器 → A2 必须红', () => {
  // 这条正面回答 Lead 的要求：「改 lib/tags.js 而不重跑生成器 → 变红」。
  // 手法：拿真文件内容算一个新指纹（模拟"源被改了"），喂给 A2 的判据。
  const bumped = { ...ACTUAL_FP, 'lib/tags.js': 'ffffffffffffffff' }
  const problems = fingerprintProblems(REGION, bumped)
  assert(problems.length > 0,
    '★ 源文件变了（指纹对不上）却判成通过 ⇒ 改了 lib/tags.js 不重跑生成器**不会被发现**')
  assert(problems.join(' ').indexOf('lib/tags.js') >= 0, '报的问题里没点名是哪个源文件：' + problems.join(' '))
  // 反向：只有 tag-styles.js 变了也必须红（两个指纹各自独立生效，别只查一个）
  const onlyStyles = { ...ACTUAL_FP, 'lib/tag-styles.js': 'eeeeeeeeeeeeeeee' }
  assert(fingerprintProblems(REGION, onlyStyles).length > 0,
    '★ lib/tag-styles.js 变了却判成通过 ⇒ 那个指纹没在生效')
})

console.log('结果：' + passed + ' 通过 / ' + failed + ' 失败')
if (failureList.length) {
  console.log('\n失败列表：')
  for (const f of failureList) console.log('  · ' + f.name + ' → ' + f.message)
}
console.log('\n（外部 bite-test：把 lib/client.js 复制到临时目录改坏一处，再')
console.log('  `node test/tag-chip.test.mjs <坏副本>` —— 对应的断言必须红。）')
process.exit(failed ? 1 : 0)
