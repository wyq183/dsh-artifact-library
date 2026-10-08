/**
 * `test/_strip-comments.mjs` 的**专职守卫**（离线 harness）。
 *
 * ⚠️ 为什么单独开一个文件、而不是在用到它的那 5 个测试里各写一段：
 *   那个函数原本就是**五个文件各抄一份**，五份里三份带着同一个 bug（详见 helper 头部）。
 *   再在五处各写一段守卫 = **把同一个错误结构重来一遍**。
 *   ⇒ 一个 helper、一个守卫、五处 import。
 *
 * 本文件守三件事：
 *   [A] helper 自身的契约（长度 1:1 / 字符串保留 / 注释确实被剥掉）
 *   [B] **反向对照**：旧版在**真实文件**上必须真的错位（否则这个 helper 的修复无意义）
 *   [C] 5 个消费者都从 helper 取，**没人再抄一份**（防漂移复发）
 *
 * 用法：node test/strip-comments.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments, stripCommentsOld } from './_strip-comments.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

/** 某个文本里「块注释开头」出现在第几行（1 起）。 */
function leftoverLines(text) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) if (lines[i].indexOf('/*') >= 0) out.push(i + 1)
  return out
}

/* ═══ [A] helper 自身的契约 ═══════════════════════════════════════════════ */
console.log('\n=== [A] helper 自身的契约 ===')

check('★ 1:1 替换：长度**逐字符不变**（否则行号漂，所有「第 N 行」类断言跟着错）', () => {
  const src = 'const a = 1; // 尾注释\n/* 块\n   注释 */\nconst b = "x";\n'
  const out = stripComments(src)
  assert(out.length === src.length, '长度变了：' + src.length + ' → ' + out.length)
})

check('★ 字符串内容必须**原样保留**（hex 就住在字符串里）', () => {
  const src = 'const a = "#ff0000";\n/* 注释里的 #00ff00 */\nconst b = "\\u0000";\n'
  const out = stripComments(src)
  assert(out.indexOf('#ff0000') >= 0, '字符串里的 hex 被一起剥掉了 ⇒ 依赖它的门禁永远抓不到东西（假绿）')
  assert(out.indexOf('#00ff00') < 0, '注释里的 hex 没被剥掉 ⇒ 门禁会误报注释（这正是当初的症状）')
  assert(out.length === src.length, '1:1 被破坏')
})

check('★ 行注释与块注释都被剥掉（且换行保留）', () => {
  const src = 'a // x\nb /* y */ c\n'
  const out = stripComments(src)
  assert(out.indexOf('x') < 0 && out.indexOf('y') < 0, '注释没剥掉：' + JSON.stringify(out))
  assert(out.split('\n').length === src.split('\n').length, '换行数变了 ⇒ 行号会漂')
  assert(out.length === src.length, '1:1 被破坏')
})

check('★ 正则字面量被整段吞掉（字符类里的引号不再带偏词法）—— 这是本次修的核心', () => {
  // 正是 lib/client.js 里那一行的形状
  const src = 'const p = "x";\n'
    + 'if (/[\\u0000-\\u001f\\u007f-\\u009f"]/.test(p)) return "";\n'
    + '/* 这条注释必须被剥掉 */\n'
    + 'const after = 1;\n'
  const out = stripComments(src)
  assert(out.indexOf('这条注释必须被剥掉') < 0, '正则后面那条注释没被剥掉 ⇒ 修没生效')
  assert(out.indexOf('const after = 1;') >= 0, '把真代码也吞掉了 ⇒ 剥过头')
  assert(out.length === src.length, '1:1 被破坏')
})

check('★ 除号不能被当成正则开头（否则会吞掉后面一大段真代码）', () => {
  const src = 'const r = a / b;\n/* 注释 */\nconst s = 1;\n'
  const out = stripComments(src)
  assert(out.indexOf('const s = 1;') >= 0, '除号被误判成正则 ⇒ 吞掉了后面的代码')
  assert(out.indexOf('注释') < 0, '注释没剥掉')
  assert(out.length === src.length, '1:1 被破坏')
})

/* ═══ [B] ★★ 反向对照：旧版在真实文件上必须真的错位 ═════════════════════ */
console.log('\n=== [B] ★★ 反向对照：旧版（已知有病）在**真实文件**上必须真的错位 ===')

/** 这 5 个是消费者真正扫的文件（谁扫哪个见 [C]）。 */
const SCANNED = [
  'lib/client.js',
  'lib/store.js',
  'lib/tools.js',
  'lib/http.js',
  'lib/tag-styles.js',
  'lib/index/engine.js',
]

check('★★ 旧版在至少一个真实文件上**确实**错位（否则"这次修复"无从谈起）', () => {
  const desynced = []
  for (const rel of SCANNED) {
    const p = path.join(ROOT, rel)
    if (!fs.existsSync(p)) continue
    const raw = fs.readFileSync(p, 'utf8')
    const bad = leftoverLines(stripCommentsOld(raw)).length
    const good = leftoverLines(stripComments(raw)).length
    if (bad > good) desynced.push(rel + '（旧 ' + bad + ' → 新 ' + good + '）')
  }
  assert(desynced.length > 0,
    '旧版在**所有**被扫文件上都没错位 —— 那么 [A] 里那条"正则被吞掉"的断言就分辨不出好坏（空转）')
  console.log('       旧版确实错位的文件：' + desynced.join(' / '))
})

check('★★ 新版在**每个**被扫文件上都把残留压到「字符串内的已知出现」那么多', () => {
  const problems = []
  for (const rel of SCANNED) {
    const p = path.join(ROOT, rel)
    if (!fs.existsSync(p)) continue
    const raw = fs.readFileSync(p, 'utf8')
    const out = stripComments(raw)
    if (out.length !== raw.length) problems.push(rel + '：长度变了 ' + raw.length + ' → ' + out.length)
    const left = leftoverLines(out)
    // 「字符串里真的写了 /*」是**内容**不是注释 —— 允许，但要能解释：
    // 逐个残留点去原文里看，它必须落在**同一行**且原文那行里 `/*` 之前有引号（说明在字符串里）
    for (const ln of left) {
      const origLine = raw.split('\n')[ln - 1] || ''
      const outLine = out.split('\n')[ln - 1] || ''
      // 残留必须是**原样保留**的（位置与原文一致），而不是"没剥干净"
      const at = outLine.indexOf('/*')
      if (origLine.indexOf('/*') !== at) {
        problems.push(rel + ' 第 ' + ln + ' 行：残留位置与原文对不上（像是没剥干净）')
      }
    }
  }
  assert(problems.length === 0, problems.slice(0, 5).join('；'))
  console.log('       （残留 = 字符串里真的写了 `/*` 的情况，位置与原文一致 ⇒ 是内容不是注释）')
})

/* ═══ [C] 消费者不许再抄一份 ══════════════════════════════════════════════ */
console.log('\n=== [C] 消费者都从 helper 取，没人再抄一份（防漂移复发）===')

/**
 * 真正 import 这个 helper 的消费者。
 *
 * ⚠️ 清单要**如实**，不能想当然：我第一版把 `test/tag-styles.test.mjs` 也列了进来，
 *    因为它里面有个 `stripCommentsAndStrings` —— **那是另一个函数**
 *    （它**故意连字符串一起剥**，用途不同：「引用一个名字」和「在字符串里提到它」必须分得开）。
 *    ⇒ **名字前缀像 ≠ 同一个消费者**。清单错了，守卫就会报一笔不存在的债。
 */
const CONSUMERS = [
  'test/http-contract.test.mjs',
  'test/perf-guards.test.mjs',
  'test/tag-chip.test.mjs',
  'test/ui-spec.test.mjs',
]

/** 剥掉注释后的源码（**用 helper 自己**剥 —— 顺手也验了它在真文件上可用）。 */
function codeOf(text) {
  // 先剥，再把「注释里提到 stripComments」这类假信号去掉
  return stripComments(text).replace(/\r/g, '')
}

check('★ 消费者清单里的文件都在（改名/删文件要当场报，不许静默变空跑）', () => {
  const missing = CONSUMERS.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
  assert(missing.length === 0, '找不到：' + missing.join(', '))
})

check('★★ 每个消费者都 **import** 了 helper，且**没有**再定义一份 `function stripComments`', () => {
  const problems = []
  for (const rel of CONSUMERS) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const code = codeOf(src)
    if (!/from\s+['"]\.\/_strip-comments\.mjs['"]/.test(code)) {
      problems.push(rel + ' 没从 _strip-comments.mjs 导入')
    }
    if (/function\s+stripComments\s*\(/.test(code)) {
      problems.push(rel + ' **又抄了一份** `function stripComments`（漂移就是这么来的）')
    }
  }
  assert(problems.length === 0, problems.join('；'))
})

check('★★ 反向对照：拿一个「又抄了一份」的假消费者跑 [C] 的判据 → 必须红', () => {
  const fake = "import fs from 'node:fs'\nfunction stripComments(src) { return src }\n"
  const code = codeOf(fake)
  const hasImport = /from\s+['"]\.\/_strip-comments\.mjs['"]/.test(code)
  const hasOwn = /function\s+stripComments\s*\(/.test(code)
  assert(!hasImport && hasOwn, '假消费者没被判出来 ⇒ [C] 的判据是空转的')
})

check('★★ 反向对照之二：拿一个「导入了但参数名不同」的假消费者 → 也该通过（判据别过严）', () => {
  const fake = "import { stripComments } from './_strip-comments.mjs'\nconst x = stripComments('a')\n"
  const code = codeOf(fake)
  assert(/from\s+['"]\.\/_strip-comments\.mjs['"]/.test(code), '正常导入被判失败 ⇒ 判据过严会误报')
  assert(!/function\s+stripComments\s*\(/.test(code), '正常导入被判成"又抄了一份" ⇒ 过严')
})

/* ═══ [D] 注释不许喂给 [C] 的判据 ════════════════════════════════════════ */
console.log('\n=== [D] 判据的输入预处理也要被验（本仓库栽过三次）===')

check('★ [C] 的扫描用 helper 剥了注释 ⇒ 消费者**注释里**提到 `function stripComments` 不算数', () => {
  const withComment = "import { stripComments } from './_strip-comments.mjs'\n// 这里解释为什么不再 function stripComments(src) 了\nconst a = 1\n"
  const code = codeOf(withComment)
  assert(!/function\s+stripComments\s*\(/.test(code),
    '注释里的字样没被剥掉 ⇒ [C] 会被自己的注释喂假信号（本仓库栽过三次的那个形状）')
  assert(/from\s+['"]\.\/_strip-comments\.mjs['"]/.test(code), '真代码里的 import 被剥掉了 ⇒ 判据恒红')
})

/* ── 收尾 ───────────────────────────────────────────────────────────────── */
console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
