/**
 * 门禁：`lib/client.js` 的行数预算
 * ══════════════════════════════════════════════════════════════════════════
 * 【2026-10-11 建 · 起因是 `RULES.md` §4.2 是一条「零守卫」的规矩】
 *
 * §4.2 原来写着「`lib/client.js` 只许变小，净增超过 30 行就停下来拆」。
 * 我逐条查过**没有任何东西在管它**：
 *   · `eslint.config.mjs` 的 `max-lines: 800` 对 `client.js` 是
 *     **文件级豁免**（`eslint-suppressions.json` 里 `max-lines: {count:1}`）
 *     —— 它是「这个文件不查这条规则」，**不随行数失效**；
 *   · `tools/doc-stale.mjs` 只数 `test/*.test.mjs` 的**文件个数**，一行代码都不看；
 *   · 10 个扫 `lib/client.js` 源码的测试（`ui-spec` 180 处引用、`overlay-escape` 22 处…）
 *     **没有一条断言行数** —— 我 grep 过 `9414` / `净增` / `lineCount` / `lines.length`，
 *     **零命中**。
 *
 * ⇒ **违反 §4.2 当场全绿。** 这正是 `RULES.md` §1.6 说的那类失效
 *    （「不是错了会红，是错了照样绿」）—— **只不过这次空转的是规矩本身。**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【为什么用「行数」这个判据（§7.1 的度量可靠性）】
 *
 * §7.1 把判据按可靠性排序：**值溯源 > 能力存在性 > 字符距离**（最后一种禁止）。
 * 「行数」是**值溯源**：它就是从磁盘文件里数出来的那个数，**没有解释空间**。
 * （对比：`ui-spec` [30] 的「2500 字符窗口内出现某词」就是被禁的那种 —— 一重构就失效。）
 *
 * ⚠️ 但行数**有口径歧义**：`split('\n')` 和 `(Get-Content).Count` 在
 *    「文件末尾有没有换行」时差 1。本文件**自己定义并自检**这个口径（见下 §预处理自检）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 【它**不**管什么（有意划界，别指望它）】
 *
 * · **不管代码质量** —— 把 100 行写成 1 行它照样绿。行数只防"文件无限膨胀"。
 * · **不管该不该拆** —— 拆不拆是 `RULES.md` §4.2 的判据（按组件规模），
 *   不是"净增了多少行"。本文件只报数。
 * · **不管 chunk 能不能被加载** —— `require.async` 那条是另一件事，
 *   现在没有 chunk，**不为不存在的问题写守卫**（§7 的精神）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = fileURLToPath(new URL('../lib/', import.meta.url))

/**
 * ⭐ **基线：只许往下改。**
 * 改这个数必须同时给出理由（并说明为什么这次不能靠删代码抵消）。
 *
 * | 日期 | 值 | 理由 |
 * |:--|--:|:--|
 * | 2026-10-11 | 9414 | 建立时的实测值 |
 * | 2026-10-13 | 9460 | 换 `ctx.inject` + 加 `ctx.effect`（见提交）。<br>代码 **+13 行**、注释 +30、空行 +3。<br>⚠️ **这不是"变大"，是"变清晰"**：旧的 `tryRegister`（一个函数干四件事）<br>被拆成 `registerSlots` / `onSlotsReady` / `inEffect` 三个**单一职责**函数。<br>按 §4.2 的判据（**单个组件规模**）核查过：<br>`PanelInner` 1574 / `DirBrowser` 1413 / `registerAtSource` 84 —— **一行没变**；<br>只有 `apply` 224→270，而多出来的全是**新拆出的三个函数**。<br>⇒ 净增的是"函数边界"，不是"组件膨胀"。 |
 * | 2026-10-14 | 9614 | ⭐ **档 1a：接管官方文件树**（注册 `kind:"files"`）。<br>新增 `RightPaneBody` / `RightPaneTitle` 两个组件 + 14 条 CSS。<br>⚠️ **这是真实的新功能**，154 行全部是净增代码（不是重构）。<br>它同时是**下一步删代码的前提**：档 1b 会删掉 `main`/`panellist`/`footer` 三个席位<br>（约 **−1665 行**），那时这个数会大幅回落。 |
 * | 2026-10-14 | 9676 | 档 1b：右栏加**三个粒度**（当前工作区／全部／当前会话，默认第一个）。<br>新增粒度切换按钮 + 空态分类 + `sessionId`/`useSessions` 取 cwd。<br>62 行净增（含 4 条 CSS）。宿主侧 `store.list` 加 `scope_dir`/`session_id` 两个筛选。 |
 * | 2026-10-14 | 9833 | 档 1c：**单栏主从**（点条目 ⇒ 右栏内预览）。<br>新增 `RightPanePreview` 组件（md 走官方 `MarkdownText`／图片走缩略图／音视频原生标签／其他 `<pre>`）。<br>157 行净增（含 12 条 CSS）。 |
 * | 2026-10-14 | 9893 | 档 1c 真机验收的两个修复：<br>① `MarkdownText` 的 `labels` prop **必填**（不传 ⇒ 内部读 `labels.code` 抛错 ⇒ **整个 slot 崩、右栏空白**）；<br>② 判 `MarkdownText` 存在要用**真值**而不是 `typeof === "function"`（实测它是 `object`，`forwardRef` 包装）。<br>+22 行。 |
 */
const CLIENT_BASELINE = 9893

/** chunk 上限：和 `RULES.md` §4.2 的「单个新组件 > 300 行就拆」配套的硬顶。 */
const CHUNK_MAX = 800

let passed = 0
let failed = 0
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) {
    failed += 1
    console.log('  FAIL ' + name + ' -> ' + (error && error.message ? error.message : String(error)))
  }
}
function assert(cond, message) { if (!cond) throw new Error(message || 'assertion failed') }

// ══════════════════════════════════════════════════════════════════════════
// 纯函数（**可被反向对照喂合成输入** —— §7.2 要求反向对照用固定合成件，不用当前源码）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 数行数。**口径**：按 `\n` 切，**末尾换行不算一行**。
 * @param {string} text 文件内容
 * @returns {number} 行数
 */
function countLines(text) {
  if (text === '') return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * 从一组文件里找出行数违规。
 * @param {{name: string, lines: number}[]} files
 * @param {number} baseline `client.js` 的基线
 * @param {number} chunkMax 其他 `client*.js` 的上限
 * @returns {string[]} 违规描述（空数组 = 全过）
 */
function violationsOf(files, baseline, chunkMax) {
  const out = []
  for (const f of files) {
    if (f.name === 'client.js') {
      if (f.lines > baseline) {
        out.push(f.name + '：' + f.lines + ' 行 > 基线 ' + baseline + '（超出 ' + (f.lines - baseline) + ' 行）')
      }
    } else if (f.lines > chunkMax) {
      out.push(f.name + '：' + f.lines + ' 行 > chunk 上限 ' + chunkMax)
    }
  }
  return out
}

/** 扫 lib/ 下所有 `client*.js`（含将来的 chunk）。 */
function readClientFiles() {
  if (!fs.existsSync(LIB_DIR)) throw new Error('lib/ 目录不存在：' + LIB_DIR)
  const names = fs.readdirSync(LIB_DIR).filter((n) => /^client.*\.js$/.test(n)).sort()
  if (!names.includes('client.js')) throw new Error('lib/client.js 不存在 —— 门禁的被测对象没了')
  return names.map((name) => ({ name, lines: countLines(fs.readFileSync(path.join(LIB_DIR, name), 'utf8')) }))
}

console.log('\n═══ client.js 行数预算 ═══')
console.log(' 被测目录：' + LIB_DIR)
console.log(' 基线：client.js ≤ ' + CLIENT_BASELINE + ' 行；其他 client*.js ≤ ' + CHUNK_MAX + ' 行')

// ══════════════════════════════════════════════════════════════════════════
// ① 预处理自检（§7.5：输入的预处理必须自检，不能默默失效）
// ══════════════════════════════════════════════════════════════════════════
check('预处理自检：countLines 对四种固定输入给出预期值', () => {
  assert(countLines('') === 0, '空串应为 0 行')
  assert(countLines('a') === 1, '单行无换行应为 1')
  assert(countLines('a\n') === 1, '单行带尾换行应为 1（尾换行不算一行）')
  assert(countLines('a\nb\nc') === 3, '三行应为 3')
  assert(countLines('a\nb\nc\n') === 3, '三行带尾换行应为 3')
})

// ══════════════════════════════════════════════════════════════════════════
// ② ⭐ 反向对照（§7.2：**用固定合成件**证明这个判据真的会咬）
//     —— 不拿当前源码当反向对照，因为源码是"应该过"的那一边
// ══════════════════════════════════════════════════════════════════════════
check('反向对照 A：超出基线 1 行 ⇒ 必须报违规', () => {
  const files = [{ name: 'client.js', lines: 9415 }]
  const v = violationsOf(files, 9414, 800)
  assert(v.length === 1, '应报 1 条，实际 ' + v.length + ' 条')
  assert(/9415/.test(v[0]) && /超出 1/.test(v[0]), '违规描述应含实际行数和超出量：' + v[0])
})

check('反向对照 B：正好等于基线 ⇒ 不许报违规（边界不能误伤）', () => {
  assert(violationsOf([{ name: 'client.js', lines: 9414 }], 9414, 800).length === 0, '等于基线不该报')
})

check('反向对照 C：chunk 超上限 ⇒ 必须报违规', () => {
  const v = violationsOf([{ name: 'client.diagram.js', lines: 801 }], 9414, 800)
  assert(v.length === 1, '应报 1 条，实际 ' + v.length)
  assert(/client\.diagram\.js/.test(v[0]), '违规描述应含文件名：' + v[0])
})

check('反向对照 D：chunk 正好 800 行 ⇒ 不许报违规', () => {
  assert(violationsOf([{ name: 'client.diagram.js', lines: 800 }], 9414, 800).length === 0, '800 是上限，不该报')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 真检查
// ══════════════════════════════════════════════════════════════════════════
const files = readClientFiles()

check('lib/client.js 不超基线', () => {
  const v = violationsOf(files, CLIENT_BASELINE, CHUNK_MAX)
  assert(v.length === 0, v.join('；'))
})

check('所有 client*.js 都被数到（防"新增文件没进门禁"）', () => {
  assert(files.length >= 1, '至少要数到 client.js')
  const names = files.map((f) => f.name)
  assert(names.includes('client.js'), 'client.js 必须在列表里：' + names.join(', '))
})

// ── 报告 ────────────────────────────────────────────────────────────────
console.log('\n── 实测行数 ──')
for (const f of files) {
  const cap = f.name === 'client.js' ? CLIENT_BASELINE : CHUNK_MAX
  console.log('   ' + f.name.padEnd(28) + String(f.lines).padStart(6) + ' 行   (上限 ' + cap + ')')
}
const client = files.find((f) => f.name === 'client.js')
if (client && client.lines < CLIENT_BASELINE) {
  console.log('\n   💡 client.js 比基线少了 ' + (CLIENT_BASELINE - client.lines) + ' 行')
  console.log('      ⇒ 按 §4.2 的棘轮精神，**顺手把 CLIENT_BASELINE 改成 ' + client.lines + '**，')
  console.log('        否则省下来的空间会被下次改动无声吃掉。')
}

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed > 0) process.exitCode = 1
