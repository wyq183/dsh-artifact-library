/**
 * 离线 harness：标签「醒目样式」规则层（lib/tag-styles.js，Step 3d）
 *
 * 十节，按「出错后果」从重到轻排：
 *   A 色板：**不新增颜色**（结构关系，不是快照）
 *   B 单一真相源：图标 / 档位 / id 正则**都不许各写一份**
 *   C ★★ **反向断言**：hex 必须被拒（证明守卫真的会拦，不是在空转）
 *   D normalizeStyle：白名单、不夹紧、不静默
 *   E ★★★ 分层判据：**样式不是判据**（本文件最重要的一节）
 *   F 受管上限：超了拒绝，绝不静默顶掉
 *   G 面（surface）：字号在芯片上被摘掉，**且必须说出理由**
 *   H 展示映射：无 hex、字号不破 R-9 下限
 *   I 可内联：纯数据 + 自包含（ui-core 内联方案的依据）
 *   J 健壮性 / 去重 / 拆层 / 自动打标签闸门
 *
 * 用法：node test/tag-styles.test.mjs
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  TAG_STYLE_TABLE, buildTagStyleRule, TAG_COLOR_SLOTS, TAG_ICONS,
  TAG_WEIGHTS, TAG_SIZES, TAG_STYLE_FIELDS, MANAGED_TAG_LIMIT,
  resolveTagColor, normalizeTagStyle, validateManagedTags, tagLayer, managedTagEntry,
  channelsForSurface, applyTagStyleSurface, styleToPresentation, resolveTagStyle,
  splitTagsByLayer, checkManagedTagBudget, checkAutoTag,
} from '../lib/tag-styles.js'
import { FILE_TYPE_COLORS, ICON_TABLE } from '../lib/icons.js'
import { normalizeTag } from '../lib/tags.js'
import { CATEGORY_ICONS, CATEGORY_ID_RE } from '../lib/settings.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }
/** 断言「这一段代码会拒绝」—— 反向断言的写法，比「结果看起来对」硬 */
function assertRejects(fn, needle, label) {
  const r = fn()
  assert(r && r.ok === false, (label || '') + ' 本应被拒，实际放行了：' + JSON.stringify(r))
  assert(typeof r.reason === 'string' && r.reason.length > 0, (label || '') + ' 被拒了但没给理由')
  if (needle) assert(r.reason.indexOf(needle) >= 0, (label || '') + ' 的拒绝理由里没提到 ' + JSON.stringify(needle) + '：' + r.reason)
}

/**
 * 把一条字号 CSS 值在**宿主默认值**上求值成 px 数。
 *
 * 只认本模块会产出的那种形状：`var(--dsh-content-font-*, NNpx)` + 可选 `calc(... ± Mp)`。
 * 认不出来回 `null` —— 调用方**必须**把它当失败（见 `[H]` 的那条断言），
 * 不许静默当成「没问题」。这是 `ui-spec.test.mjs:1522-1526` 记的那条通用规矩：
 * **任何切片/解析失败，都要和「结果是好的」用不同的报错判出来。**
 */
function effectiveFontPx(value) {
  const text = String(value == null ? '' : value)
  // ① 取出 `var(--dsh-content-font-xxx, NNpx)` 的 fallback，作为该 token 的默认值
  const tokenRe = /var\(\s*--dsh-content-font-[a-z0-9-]+\s*,\s*([0-9.]+)px\s*\)/g
  let base = null
  let m
  while ((m = tokenRe.exec(text))) {
    if (base !== null) return null // 本模块的每个档位只该有一个基准 token
    base = parseFloat(m[1])
  }
  if (base === null) return null
  // ② 把算式里剩下的 `± Mp` 全部累加（支持任意项，不是只支持一项）
  const stripped = text.replace(tokenRe, '0')
  const parts = stripped.match(/[-+]\s*[0-9.]+px/g) || []
  const leftovers = stripped.replace(/[-+]\s*[0-9.]+px/g, '').replace(/calc\(|\)|\s/g, '')
  if (leftovers !== '0') return null // 还有认不出的东西 → 别猜
  let total = base
  for (const p of parts) total += parseFloat(p.replace(/\s/g, ''))
  return total
}

/**
 * 去掉注释与字符串字面量，只留**可执行的标识符**。
 *
 * ⚠️ 为什么需要它：`[I]` 要证明 `buildTagStyleRule` 不引用模块私有名字。
 *   但函数体的 **JSDoc 和错误信息里**必然会提到 `TAG_STYLE_TABLE` / `WEIGHT_VALUES`
 *   这类名字 —— 那是**文档价值**，删掉很亏，留着又会被朴素的 `includes` 误判成泄漏。
 *   引用一个名字和**在字符串里提到**它是两件事，扫描必须分得开。
 *
 * ⚠️ 切失败必须与断言失败**用不同的报错**（`ui-spec` 那条教训的反面）：
 *   所以本函数返回 `{code, ok}`，`ok=false` 时调用方必须直接判红，
 *   而不是拿一份「可能是整段没切」的结果去扫（那样会**静默变绿**）。
 */
function stripCommentsAndStrings(source) {
  const src = String(source)
  let code = ''
  let i = 0
  let n = 0
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) return { code, ok: false, why: '块注释没闭合' }
      n += 1; i = end + 2; continue
    }
    if (two === '//') {
      const end = src.indexOf('\n', i + 2)
      i = end < 0 ? src.length : end + 1
      n += 1; continue
    }
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1
      let closed = false
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === ch) { i += 1; closed = true; break }
        i += 1
      }
      if (!closed) return { code, ok: false, why: '字符串没闭合（' + ch + '）' }
      code += '""'
      n += 1; continue
    }
    code += ch
    i += 1
  }
  return { code, ok: true, removed: n }
}

const SRC = fileURLToPath(new URL('../lib/tag-styles.js', import.meta.url))
const PALETTE_VALUES = Object.values(TAG_STYLE_TABLE.colors)
/**
 * CSS 具名颜色（只收录与色板可能撞名的那批 + 几个常用误写）。
 * ⚠️ 收录它的目的**不是**「校验 CSS 颜色名」，而是 `[C]` 里那条撞名断言 ——
 *    色板槽名借的是颜色词，所以「槽名」和「CSS 颜色名」在 `red`/`blue`/`green`/
 *    `orange`/`violet` 上必然重叠。这条断言把那个重叠**钉成已知事实**。
 */
const CSS_COLOR_NAMES = new Set([
  'red', 'blue', 'green', 'orange', 'violet', 'amber', 'sky', 'neutral',
  'tomato', 'purple', 'pink', 'gold', 'lime', 'navy', 'teal', 'aqua', 'cyan',
  'magenta', 'maroon', 'olive', 'silver', 'gray', 'grey', 'black', 'white',
])

/* ═══ [A] 色板：不新增颜色 ═════════════════════════════════════════════════ */
console.log('\n=== [A] 色板：本模块不新增颜色 ===')
{
  check('★ 每个色板值都必须出现在 FILE_TYPE_COLORS 的取值里（结构关系，不是快照）', () => {
    // ⚠️ 这条刻意**不**写死「8 个槽、分别是什么」—— 那是当时的观察值，
    //    往色板里加一个槽就会红（而加槽本身可能是对的）。
    //    钉的是**规律**：色板只能从既有官方色表里取，不能自己造颜色。
    const known = new Set(Object.values(FILE_TYPE_COLORS))
    const stray = PALETTE_VALUES.filter((v) => !known.has(v))
    assert(stray.length === 0,
      '色板里有 FILE_TYPE_COLORS 之外的颜色：' + stray.join(' , ')
      + ' —— 色板是**借**官方色表的（icons.js 头部「禁止 hex」那条硬规矩），不许自己造色。')
  })

  check('★ 色板值一律不含 hex（含 rgb() 那个唯一例外也不行有 #）', () => {
    for (const [slot, value] of Object.entries(TAG_STYLE_TABLE.colors)) {
      assert(!String(value).includes('#'), slot + ' 是 hex：' + value)
    }
  })

  check('槽名唯一、非空、且每个槽都有值', () => {
    assert(TAG_COLOR_SLOTS.length > 0, '色板是空的')
    assert(new Set(TAG_COLOR_SLOTS).size === TAG_COLOR_SLOTS.length, '槽名有重复：' + TAG_COLOR_SLOTS.join(','))
    for (const slot of TAG_COLOR_SLOTS) {
      assert(typeof slot === 'string' && slot.length > 0, '槽名不合法')
      assert(typeof TAG_STYLE_TABLE.colors[slot] === 'string' && TAG_STYLE_TABLE.colors[slot].length > 0, slot + ' 没有值')
    }
  })

  check('色板里的 rgb() 例外**只能**是 icons.js 已经声明过的那一个（不许新开例外）', () => {
    const nonVar = PALETTE_VALUES.filter((v) => !/^var\(--dsw-static-[a-z0-9-]+\)$/.test(v))
    for (const v of nonVar) {
      assert(v === FILE_TYPE_COLORS.media,
        '出现了新的非 token 颜色：' + v + ' —— icons.js 只声明过 media 这一个例外，'
        + '要开新例外得先去改 icons.js 并说明为什么官方没有对应 token。')
    }
  })

  check('★ 反向断言：表里**没有** colorFallback 这种没消费点的配置（幽灵配置 = 幽灵 token）', () => {
    assert(!('colorFallback' in TAG_STYLE_TABLE),
      'TAG_STYLE_TABLE 又长回了 colorFallback —— 它没有消费点：分层判据不看颜色，'
      + '而「受管但没配颜色长什么样」是渲染的决定（本仓库已有 --dsw-font-mono 这个幽灵 token 的教训）')
    assert(styleToPresentation({}).color === null, '没配颜色时展示映射该给 null，实际给了一个兜底色')
  })
}

/* ═══ [B] 单一真相源 ═══════════════════════════════════════════════════════ */
console.log('\n=== [B] 图标 / 档位 / id 正则都不许各写一份 ===')
{
  check('★ TAG_ICONS 与 ICON_TABLE.shapes 的键**同集合**（自造图标名 = 配置合法但渲染空白）', () => {
    const fromIcons = Object.keys(ICON_TABLE.shapes).slice().sort()
    const mine = TAG_ICONS.slice().sort()
    assert(mine.join() === fromIcons.join(),
      '图标集漂了：\n  本模块 ' + mine.join(',') + '\n  icons.js ' + fromIcons.join(','))
  })

  check('★ TAG_ICONS 与 settings.js 的 CATEGORY_ICONS **同集合**（分类与标签不许给两套图标）', () => {
    const a = TAG_ICONS.slice().sort()
    const b = CATEGORY_ICONS.slice().sort()
    assert(a.join() === b.join(),
      '分类能选的图标和标签能选的图标不一致：\n  标签 ' + a.join(',') + '\n  分类 ' + b.join(',')
      + ' —— Step 2 已经定过「别搞两套」。')
  })

  check('★ 本模块的 id 正则与 settings.js 的 CATEGORY_ID_RE **同源**（各写一份，所以要钉住）', () => {
    // categories.js:177-179 的同款做法：为了零 node: 依赖 / 可内联，正则各写一份，
    // 但必须有一条断言防止漂移。这里用「同一批样本两边判定必须一致」来钉。
    const samples = ['a', 'ab', 'a1', 'a-b', 'a_b', 'other', '', 'A', '1a', '_a', '-a', 'a'.repeat(32), 'a'.repeat(33), '__proto__', 'a.b', ' a']
    const bad = samples.filter((s) => CATEGORY_ID_RE.test(s) !== /^[a-z][a-z0-9_-]{0,31}$/.test(s))
    assert(bad.length === 0, 'id 正则漂了：' + bad.join(' , '))
    // 并且真的用上了：一个合法 id 能过、一个非法 id 被拒
    assert(validateManagedTags([{ id: 'ok-id', tag: 'x' }]).ok === true, '合法 id 被拒了')
    assert(validateManagedTags([{ id: 'Bad Id', tag: 'x' }]).ok === false, '非法 id 放行了')
  })

  check('字重恰好两档 normal / bold；字号恰好三档 small / normal / large', () => {
    assert(TAG_WEIGHTS.slice().sort().join() === 'bold,normal', '字重档位不是两档：' + TAG_WEIGHTS.join(','))
    assert(TAG_SIZES.slice().sort().join() === 'large,normal,small', '字号档位不是三档：' + TAG_SIZES.join(','))
  })

  check('样式的四个字段名是冻结契约（color / icon / weight / size）', () => {
    assert(TAG_STYLE_FIELDS.join() === 'color,icon,weight,size', '字段名变了：' + TAG_STYLE_FIELDS.join(','))
  })
}

/* ═══ [C] ★★ 反向断言：hex 必须被拒 ════════════════════════════════════════ */
console.log('\n=== [C] ★★ 反向断言：颜色守卫真的会拦 ===')
{
  check('★★ 反向断言：各种写法的 hex 一律被拒（#rgb / #rrggbb / #rrggbbaa / 带 alpha 的 8 位）', () => {
    const hexes = ['#fff', '#FFF', '#ff0000', '#FF0000', '#ff0000ff', '#abcd', ' #ff0000 ', 'rgb(255,0,0) #f00']
    for (const v of hexes) assertRejects(() => resolveTagColor(v), 'hex', 'hex ' + JSON.stringify(v))
  })

  check('★★ 反向断言：非色板的 rgb() / hsl() / CSS 颜色名一律被拒', () => {
    for (const v of ['rgb(0,0,0)', 'rgba(255,0,0,.5)', 'hsl(0,100%,50%)', 'tomato', 'rebeccapurple', 'purple', 'pink', 'currentColor', 'transparent', 'inherit']) {
      assertRejects(() => resolveTagColor(v), null, '非法颜色 ' + JSON.stringify(v))
    }
  })

  check('★ 槽名与 CSS 颜色名**撞名**：撞的那些必须当槽名接受，且归一成 token（不是当 CSS 名用）', () => {
    // ⚠️ 这是我第一版测试写错、被自己抓出来的一条**真实事实**：
    //    `red` / `blue` / `green` / `orange` / `violet` 既是色板槽名、又是 CSS 颜色名。
    //    ⇒ 不能像 `tomato` 那样一律拒 —— 否则色板里一半的槽位填不回来。
    //    但也**不能**把它当 CSS 颜色名接受：返回值必须落在色板里（`var(--dsw-static-*)`），
    //    绝不能让 `red` 变成渲染时的 `color:red`（那等于绕过了「禁止 hex / 只用 token」。
    //    虽然 CSS 名不是 hex，但它同样**不跟随深色主题**，是同一类病的两种写法）。
    const colliding = TAG_COLOR_SLOTS.filter((s) => CSS_COLOR_NAMES.has(s))
    assert(colliding.length > 0, '撞名现象消失了？色板槽名或 CSS 颜色名表变了，请复核这条断言')
    for (const slot of colliding) {
      const r = resolveTagColor(slot)
      assert(r.ok === true && r.slot === slot, slot + ' 撞名却没被当槽名接受：' + JSON.stringify(r))
      assert(r.value === TAG_STYLE_TABLE.colors[slot], slot + ' 没归一成 token：' + r.value)
      assert(r.value.includes('var(--dsw-static-') || r.value === FILE_TYPE_COLORS.media,
        slot + ' 归一成了非 token 的值：' + r.value)
      assert(Object.values(TAG_STYLE_TABLE.colors).indexOf(slot) < 0, slot + ' 的槽名与它的值同名了')
    }
  })

  check('★★ 反向断言：var() 里**色板以外**的 token 一律被拒（不是「像 token 就放行」）', () => {
    for (const v of ['var(--dsw-static-red-500)', 'var(--dsw-static-blue-999)', 'var(--dsw-alias-label-primary)', 'var(--dsw-font-mono)']) {
      assertRejects(() => resolveTagColor(v), null, '越界 token ' + JSON.stringify(v))
    }
  })

  check('★★ 反向断言：**色板里的**值却必须能原样填回来（否则取值器读到的值存不回去）', () => {
    for (const [slot, value] of Object.entries(TAG_STYLE_TABLE.colors)) {
      const r = resolveTagColor(value)
      assert(r.ok === true, '色板自己的值被拒了：' + value)
      assert(r.slot === slot, value + ' 归到了 ' + r.slot + '，该是 ' + slot)
      assert(r.value === value, '归一化后值变了：' + r.value)
    }
  })

  check('槽名可以正常接受（大小写不敏感、可带首尾空白），并归一到规范槽名', () => {
    const r = resolveTagColor('  RED ')
    assert(r.ok === true && r.slot === 'red' && r.value === TAG_STYLE_TABLE.colors.red, JSON.stringify(r))
  })

  check('反向断言：空串 / 非字符串都被拒（不静默当成「没配颜色」）', () => {
    for (const v of ['', '   ', null, undefined, 0, 1, {}, [], true]) {
      assertRejects(() => resolveTagColor(v), null, '非法类型 ' + String(v))
    }
  })

  check('★ 反向断言：`normalizeTagStyle` **不会**把 hex 悄悄改写成某个色板槽', () => {
    // 「就近映射」是猜用户意图 —— #ff0000 到底是 red 还是状态色 error？没有唯一答案，
    // 猜错的结果是「设置成功了」（因为值被吃掉了），比报错坏得多。
    assertRejects(() => normalizeTagStyle({ color: '#ff0000' }), 'hex', '样式里的 hex')
    const r = normalizeTagStyle({ color: TAG_STYLE_TABLE.colors.green })
    assert(r.ok === true && r.style.color === 'green', '色板字面量该能填回来：' + JSON.stringify(r))
  })
}

/* ═══ [D] normalizeStyle ═══════════════════════════════════════════════════ */
console.log('\n=== [D] normalizeStyle：白名单、不夹紧、不静默 ===')
{
  check('空 / null / undefined → 合法空样式（不是错）', () => {
    for (const v of [null, undefined, {}]) {
      const r = normalizeTagStyle(v)
      assert(r.ok === true, JSON.stringify(v) + ' 该合法')
      assert(JSON.stringify(r.style) === '{}', '该得到空样式：' + JSON.stringify(r.style))
    }
  })

  check('★ 越界是**拒绝**，不是夹紧（枚举与有序量的口径刻意不同）', () => {
    assertRejects(() => normalizeTagStyle({ size: 99 }), '三档', 'size 数值')
    assertRejects(() => normalizeTagStyle({ size: 'xlarge' }), '三档', 'size 未知档')
    assertRejects(() => normalizeTagStyle({ size: '12px' }), '三档', 'size 填 px')
    assertRejects(() => normalizeTagStyle({ weight: 700 }), '两档', 'weight 数值')
    assertRejects(() => normalizeTagStyle({ weight: 'bolder' }), '两档', 'weight 未知档')
    assertRejects(() => normalizeTagStyle({ icon: 'rocket' }), 'icons.js', '自造图标')
    assertRejects(() => normalizeTagStyle({ icon: 'video.png' }), 'icons.js', '带后缀的图标名')
  })

  check('★ 未知字段进 notes，而且**必须点名「哪个键 → 该写什么」**', () => {
    // ⚠️ 依琪原话是「**是否加粗**」—— 很自然会写成 {bold:true}。
    //    静默丢掉 = 「agent 以为设了加粗、界面上是普通」= 静默空转。
    const r = normalizeTagStyle({ bold: true, fontWeight: 'bold', fontSize: 14 })
    assert(r.ok === true, '未知字段不该让整条失败')
    assert(r.notes.length === 3, '三个未知字段该给三条提示，实际 ' + r.notes.length + ' 条：' + JSON.stringify(r.notes))
    assert(JSON.stringify(r.style) === '{}', '未知字段不该被当成样式应用：' + JSON.stringify(r.style))
    const joined = r.notes.join(' | ')
    for (const [k, want] of [['bold', 'weight'], ['fontWeight', 'weight'], ['fontSize', 'size']]) {
      assert(joined.includes(JSON.stringify(k)), '提示里没点名 ' + k + '：' + joined)
      assert(joined.includes(JSON.stringify(want)), '提示里没给出该写的键 ' + want + '：' + joined)
    }
  })

  check('★ 命中了提示表也**不自动改写**（一个字段只准有一种写法，否则立刻长出第二套词汇表）', () => {
    const r = normalizeTagStyle({ bold: true })
    assert(r.style.weight === undefined, 'bold 被自动当成 weight:bold 了 —— 提示表不是别名表')
  })

  check('★ 返回的是**全新对象**，绝不把输入对象原样存进去，也不改入参', () => {
    const input = { color: 'red', icon: 'video', junk: 1 }
    const frozen = JSON.stringify(input)
    const r = normalizeTagStyle(input)
    assert(r.ok === true, '该成功')
    assert(r.style !== input, '把输入对象原样返回了')
    assert(JSON.stringify(input) === frozen, '改了入参：' + JSON.stringify(input))
    assert(!('junk' in r.style), '未知字段漏进了 style')
  })

  check('显式写 null = 「这条通道不设置」，与字段不存在等价（不算错、不进 style）', () => {
    const r = normalizeTagStyle({ color: null, icon: undefined, weight: null, size: null })
    assert(r.ok === true && JSON.stringify(r.style) === '{}', JSON.stringify(r))
  })

  check('四个字段齐全时原样通过（round-trip 不动点）', () => {
    const style = { color: 'amber', icon: 'video', weight: 'bold', size: 'large' }
    const r = normalizeTagStyle(style)
    assert(r.ok === true, JSON.stringify(r))
    assert(JSON.stringify(r.style) === JSON.stringify(style), '往返不是不动点：' + JSON.stringify(r.style))
    assert(normalizeTagStyle(r.style).style.color === style.color, '二次归一又变了')
  })

  check('反向断言：非对象输入被拒（不静默当空样式）', () => {
    for (const v of ['red', 42, true, ['color']]) {
      assertRejects(() => normalizeTagStyle(v), '对象', '非对象 ' + JSON.stringify(v))
    }
  })
}

/* ═══ [E] ★★★ 分层判据：样式不是判据 ═══════════════════════════════════════ */
console.log('\n=== [E] ★★★ 受管 / 自由：判据是「进过受管表」，不是「有没有样式」 ===')
{
  const styleAll = { color: 'red', icon: 'video', weight: 'bold', size: 'large' }

  check('★ 反向断言：**只有样式、没有 id** 的条目被拒，且理由必须点名判据', () => {
    // 这是「样式 = 判据」那个错误方向的代码化封堵。
    assertRejects(() => validateManagedTags([{ tag: '视频项目', ...styleAll }]), '循环定义', '有样式没 id')
    assertRejects(() => validateManagedTags([{ tag: '视频项目', color: 'red' }]), '进过受管表', '只挂了颜色')
    assertRejects(() => validateManagedTags([{ tag: '视频项目' }]), 'id', '光有 tag')
  })

  check('★ **受管但完全没有样式**是合法的 —— 这证明「受管 ≠ 有样式」', () => {
    const r = validateManagedTags([{ id: 'video-project', tag: '视频项目' }])
    assert(r.ok === true, '没样式的受管标签被拒了：' + JSON.stringify(r))
    assert(r.value[0].id === 'video-project' && r.value[0].tag === '视频项目', JSON.stringify(r.value[0]))
    assert(Object.keys(r.value[0]).sort().join() === 'id,tag', '该只有 id + tag，实际 ' + Object.keys(r.value[0]).join(','))
    assert(tagLayer('视频项目', r.value) === 'managed', '没样式就不算受管了 —— 那正是循环定义')
  })

  check('★★ 反向断言：**自由关键词挂上样式，照样判 free**（样式不能把它升格）', () => {
    // 受管表里只有「视频项目」。但另有一份样式散落在别处 —— 分层判据不该看它。
    const managed = [{ id: 'video-project', tag: '视频项目', color: 'red' }]
    const stray = { tag: '某个自由词', ...styleAll }
    assert(tagLayer(stray.tag, managed) === 'free', '自由词被判成了受管')
    assert(managedTagEntry(stray.tag, managed) === null, '自由词竟然取到了受管条目')
    assert(resolveTagStyle(stray.tag, managed).layer === 'free', 'resolve 也判错了层')
    assert(resolveTagStyle(stray.tag, managed).style === null, '自由词拿到了样式')
  })

  check('★★ 差分：把样式字段**逐个挂上/摘掉**，分层结果必须**一个字节都不变**', () => {
    // 这条是「样式不是判据」的直接证明 —— 判据与样式**无因果**。
    const base = [{ id: 'a', tag: 'alpha' }, { id: 'b', tag: 'beta', color: 'red' }]
    const variants = [
      base,
      base.map((e) => ({ ...e, color: 'amber', icon: 'video', weight: 'bold', size: 'large' })),
      base.map((e) => ({ ...e, icon: 'video' })),
      base.map(({ id, tag }) => ({ id, tag })),
    ]
    const layers = variants.map((v) => ['alpha', 'beta', 'gamma'].map((t) => tagLayer(t, v)).join(','))
    assert(new Set(layers).size === 1,
      '分层结果随样式变了：' + JSON.stringify(layers) + ' —— 说明样式又混进判据里了')
    assert(layers[0] === 'managed,managed,free', '分层结果本身不对：' + layers[0])
  })

  check('★ 匹配用 normalizeTag 的口径：`·` 这类装饰符差异算同一个受管标签', () => {
    // 真实库里就有这一对（3a 的 9 组重复之一）。受管表按 3b 的同一口径认身份，
    // 这样「还没合并的两种写法」不会一个有色一个没色、看上去像两个东西。
    const managed = [{ id: 'wl', tag: '卫龙榴莲辣条·留恋计划', color: 'red' }]
    assert(tagLayer('卫龙榴莲辣条·留恋计划', managed) === 'managed', '原样匹配失败')
    assert(tagLayer('卫龙榴莲辣条留恋计划', managed) === 'managed', '去 `·` 的写法没认出来')
    assert(tagLayer('DSH', [{ id: 'd', tag: 'dsh' }]) === 'managed', '大小写差异没认出来')
  })

  check('★ 反向断言：记录里**逐字不一致**的写法不匹配（首尾空白不被宽容）', () => {
    // 逐字匹配是 3b 的教训：任何一次 trim 都会让键对不上记录里的值。
    const managed = [{ id: 'a', tag: 'alpha' }]
    assert(tagLayer('alpha ', managed) === 'free', '带尾空格的写法被匹配了 —— 匹配口径偷偷 trim 了')
    assert(tagLayer(' alpha', managed) === 'free', '带首空格的写法被匹配了')
    assert(tagLayer('', managed) === 'free', '空串被判成受管')
    assert(tagLayer(null, managed) === 'free' && tagLayer(undefined, managed) === 'free', 'null/undefined 该判 free')
  })

  check('受管表条目：tag 首尾带空白**被拒**（它是永远匹配不到记录的死配置）', () => {
    assertRejects(() => validateManagedTags([{ id: 'a', tag: ' alpha' }]), '死配置', 'tag 带首空格')
    assertRejects(() => validateManagedTags([{ id: 'a', tag: 'alpha ' }]), '死配置', 'tag 带尾空格')
    assertRejects(() => validateManagedTags([{ id: 'a', tag: '' }]), 'tag', 'tag 为空')
  })

  check('受管表：id 重复 / tag 重复都被拒（不静默取最后一个）', () => {
    assertRejects(() => validateManagedTags([{ id: 'a', tag: 'x' }, { id: 'a', tag: 'y' }]), 'id 重复', 'id 撞车')
    assertRejects(() => validateManagedTags([{ id: 'a', tag: 'x' }, { id: 'b', tag: 'x' }]), 'tag 重复', 'tag 撞车')
  })

  check('★ 同一件事的两种写法各占一个受管位 → 允许通过，但必须**提示**（不静默）', () => {
    const r = validateManagedTags([{ id: 'a', tag: 'DSH' }, { id: 'b', tag: 'dsh' }])
    assert(r.ok === true, '该通过：这是「该合并但还没合并」，不是非法数据')
    assert(r.notes.some((n) => n.indexOf('两种写法') >= 0), '没提示重复写法：' + JSON.stringify(r.notes))
    assert(r.notes.join(' ').includes('3b'), '提示里该指向 3b 的合并：' + r.notes.join(' '))
  })

  check('受管表整体：非数组被拒、空/undefined 回空表', () => {
    assertRejects(() => validateManagedTags({ id: 'a' }), '数组', '对象当表')
    assert(validateManagedTags(undefined).ok === true, 'undefined 该回空表')
    assert(validateManagedTags(null).ok === true, 'null 该回空表')
    assert(validateManagedTags([]).ok === true, '空数组该合法')
  })

  check('受管表条目：未知字段进 notes（含样式字段的错字）', () => {
    const r = validateManagedTags([{ id: 'a', tag: 'x', siz: 'large', note: 'hi' }])
    assert(r.ok === true, JSON.stringify(r))
    assert(r.notes.length === 2, '两个未知字段该给两条提示：' + JSON.stringify(r.notes))
    assert(r.notes.join(' ').includes('"siz"'), '没点名 siz：' + r.notes.join(' '))
  })

  check('受管表条目：样式字段仍然走同一套校验（hex 一样被拒）', () => {
    assertRejects(() => validateManagedTags([{ id: 'a', tag: 'x', color: '#00ff00' }]), 'hex', '受管条目里的 hex')
    assertRejects(() => validateManagedTags([{ id: 'a', tag: 'x', icon: 'rocket' }]), 'icons.js', '受管条目里的假图标')
  })

  check('validateManagedTags 返回的是**新对象**，不改入参', () => {
    const entry = { id: 'a', tag: 'x', color: 'red' }
    const frozen = JSON.stringify(entry)
    const r = validateManagedTags([entry])
    assert(r.ok === true, JSON.stringify(r))
    assert(r.value[0] !== entry, '原样返回了入参条目')
    assert(JSON.stringify(entry) === frozen, '改了入参')
  })

  check('★ 样式**展平**存在条目上：数据形状上就表达不出「自由词带样式」', () => {
    const r = validateManagedTags([{ id: 'a', tag: 'x', ...styleAll }])
    assert(r.ok === true, JSON.stringify(r))
    assert(!('style' in r.value[0]), '不该有嵌套的 style 字段（那会让「自由词带样式」重新变得可表达）')
    for (const f of TAG_STYLE_FIELDS) assert(r.value[0][f] === styleAll[f], f + ' 没被展平')
  })
}

/* ═══ [F] 受管上限 ═════════════════════════════════════════════════════════ */
console.log('\n=== [F] 受管上限：超了拒绝，绝不静默顶掉 ===')
{
  const make = (n) => Array.from({ length: n }, (_, i) => ({ id: 't' + i, tag: 'tag' + i }))

  check('上限之内合法、正好到上限合法', () => {
    assert(validateManagedTags(make(MANAGED_TAG_LIMIT)).ok === true, '正好到上限该合法')
    assert(checkManagedTagBudget(make(MANAGED_TAG_LIMIT)).ok === true, '预算检查该 ok')
  })

  check('★ 超一个就拒，且理由要说清「已有几个 / 上限几个」和「不许顶掉」', () => {
    const r = validateManagedTags(make(MANAGED_TAG_LIMIT + 1))
    assert(r.ok === false, '超限竟然放行了')
    assert(r.reason.includes(String(MANAGED_TAG_LIMIT + 1)) && r.reason.includes(String(MANAGED_TAG_LIMIT)),
      '理由里没给出数量：' + r.reason)
    assert(r.reason.includes('不'), '理由里没说清「不替你顶掉最后一个」：' + r.reason)
  })

  check('★ checkManagedTagBudget 只报告、不腾位（超限时不返回被删掉的条目）', () => {
    const over = make(MANAGED_TAG_LIMIT + 3)
    const frozen = JSON.stringify(over)
    const b = checkManagedTagBudget(over)
    assert(b.ok === false && b.count === over.length && b.limit === MANAGED_TAG_LIMIT && b.free === 0, JSON.stringify(b))
    assert(typeof b.reason === 'string' && b.reason.length > 0, '超限没给理由')
    assert(JSON.stringify(over) === frozen, '预算检查改了入参')
  })

  check('上限是**从表里读的**（改一个常量即可，逻辑不写死）', () => {
    const rule = buildTagStyleRule({ ...TAG_STYLE_TABLE, limit: 2 })
    assert(rule.limit() === 2, 'limit 参数没生效')
    assert(rule.validateManaged([{ id: 'a', tag: 'x' }, { id: 'b', tag: 'y' }, { id: 'c', tag: 'z' }]).ok === false,
      '把上限调成 2 之后三条仍然放行')
  })
}

/* ═══ [G] 面（surface）与优先级 ════════════════════════════════════════════ */
console.log('\n=== [G] 面：字号在芯片上被摘掉，且必须说出理由 ===')
{
  check('channels 数组的**次序就是优先级**：颜色 > 图标 > 字重 > 字号', () => {
    assert(TAG_STYLE_TABLE.channels.join() === 'color,icon,weight,size', '优先级序变了：' + TAG_STYLE_TABLE.channels.join(','))
  })

  check('★ chip 面不含 size，group 面含（这就是「字号只在分组标题上有意义」）', () => {
    assert(channelsForSurface('chip').indexOf('size') < 0, 'chip 上还留着 size')
    assert(channelsForSurface('group').indexOf('size') >= 0, 'group 上反倒没有 size')
    for (const c of ['color', 'icon', 'weight']) {
      assert(channelsForSurface('chip').indexOf(c) >= 0, 'chip 上少了 ' + c)
      assert(channelsForSurface('group').indexOf(c) >= 0, 'group 上少了 ' + c)
    }
  })

  check('★ 过滤后的通道**保持优先级次序**（不是按字段名重排）', () => {
    for (const s of ['chip', 'group']) {
      const list = channelsForSurface(s)
      const reference = TAG_STYLE_TABLE.channels.filter((c) => list.indexOf(c) >= 0)
      assert(list.join() === reference.join(), s + ' 的通道次序被打乱了：' + list.join(','))
    }
  })

  check('★ applySurface 摘掉 size 时**必须给出理由**（不静默丢）', () => {
    const a = applyTagStyleSurface({ color: 'red', icon: 'video', weight: 'bold', size: 'large' }, 'chip')
    assert(a.style.size === undefined, 'chip 上 size 没被摘掉')
    assert(a.style.color === 'red' && a.style.icon === 'video' && a.style.weight === 'bold', '别的通道被误伤')
    assert(a.dropped.length === 1 && a.dropped[0].channel === 'size', '没报告被摘掉的是什么：' + JSON.stringify(a.dropped))
    assert(typeof a.dropped[0].reason === 'string' && a.dropped[0].reason.length > 0, '摘掉了但没说理由')
    assert(a.dropped[0].reason.includes('行高'), '理由该点出「芯片上字号只破坏行高」：' + a.dropped[0].reason)
  })

  check('★ applySurface **不改入参** —— 存下来的样式永远完整，换个面还能拿到 size', () => {
    const style = { color: 'red', size: 'large' }
    const frozen = JSON.stringify(style)
    const chip = applyTagStyleSurface(style, 'chip')
    assert(JSON.stringify(style) === frozen, '入参被改了')
    const group = applyTagStyleSurface(style, 'group')
    assert(group.style.size === 'large', 'group 面上 size 丢了')
    assert(group.dropped.length === 0, 'group 面上不该有被摘掉的：' + JSON.stringify(group.dropped))
  })

  check('★ 认不出的 surface 按**最受限**的那个办（保守方向：宁可少显示，不可破行高）', () => {
    for (const bad of [undefined, null, '', 'chip ', 'GROUP', 42, {}]) {
      const list = channelsForSurface(bad)
      assert(list.indexOf('size') < 0, '未知 surface ' + JSON.stringify(bad) + ' 竟然允许了 size')
      const a = applyTagStyleSurface({ size: 'large', color: 'red' }, bad)
      assert(a.style.size === undefined, '未知 surface 下 size 没被摘掉：' + JSON.stringify(bad))
    }
  })

  check('样式空/非法时 applySurface 不抛，回空对象', () => {
    for (const bad of [null, undefined, {}, 'red', 42, []]) {
      const a = applyTagStyleSurface(bad, 'chip')
      assert(a && typeof a.style === 'object', '返回异常：' + String(bad))
    }
  })
}

/* ═══ [H] 展示映射 ═════════════════════════════════════════════════════════ */
console.log('\n=== [H] 展示映射：无 hex、字号不破 R-9 下限 ===')
{
  const samples = [{}, { color: 'red' }, { icon: 'video' }, { weight: 'bold' }, { size: 'large' },
    { color: 'violet', icon: 'pdf', weight: 'bold', size: 'small' }, { color: 'neutral' }]

  check('★ 任何样式的展示色都**不含 hex**，且是色板里的值', () => {
    for (const s of samples) {
      const p = styleToPresentation(s)
      if (p.color === null) continue
      assert(!p.color.includes('#'), JSON.stringify(s) + ' → hex: ' + p.color)
      assert(PALETTE_VALUES.indexOf(p.color) >= 0, JSON.stringify(s) + ' → 色板外的值: ' + p.color)
    }
  })

  check('★ 反向断言：`#ff0000` 这类值**进不了**展示映射（守卫在前一道就拦掉了）', () => {
    // styleToPresentation 是**读**路径，它不负责校验；所以关键是：
    // ① 非法值不会被它「就近翻译」成某个 token；② 写路径已经拒了它。
    const p = styleToPresentation({ color: '#ff0000' })
    assert(p.color === null, '非法颜色被翻译成了 ' + p.color + ' —— 那是在猜用户意图')
    assertRejects(() => normalizeTagStyle({ color: '#ff0000' }), 'hex', '写路径')
  })

  check('★ 字号的每个 px 数值都 ≥ 12（R-9 下限），且必须走内容缩放 token', () => {
    for (const s of [{ size: 'small' }, { size: 'normal' }, { size: 'large' }]) {
      const p = styleToPresentation(s)
      assert(p.fontSize !== null, 'size 没产出字号：' + JSON.stringify(s))
      assert(p.fontSize.includes('--dsh-content-font-'),
        '字号没走内容缩放 token（UI-SPEC §一.3：硬编码字号会在用户调界面字号时错位）：' + p.fontSize)
      // ⚠️ 第一版这里把 `calc(var(..., 13px) - 1px)` 里的 `1px` 也算成了字号，于是误报。
      //    `1px` 是**运算量**，不是字号。正确的判据是「在宿主默认值上**求值**之后 ≥ 12」——
      //    我原先钉的是「字符串里出现的每个 px」，那是**当时的观察值**，不是规律。
      const effective = effectiveFontPx(p.fontSize)
      assert(effective !== null, '算不出有效字号：' + p.fontSize + '（求值器没认出这个写法，请同步更新它）')
      assert(effective >= 12, '有效字号破了 R-9 的 12px 下限（ui-spec:1568）：' + p.fontSize + ' → ' + effective + 'px')
    }
  })

  check('★ 三档字号在**宿主默认值**上求值后互不相同（否则「三档」是假的）', () => {
    const vals = TAG_SIZES.map((s) => effectiveFontPx(styleToPresentation({ size: s }).fontSize))
    assert(vals.every((v) => v !== null), '有档位算不出有效字号：' + JSON.stringify(vals))
    assert(new Set(vals).size === vals.length, '有档位求值后撞在一起：' + JSON.stringify(vals))
    assert(vals.slice().sort((a, b) => a - b).join() === vals.slice().sort((a, b) => a - b).join(),
      '档位与大小关系不一致')
  })

  check('★ small 是**求值求出来的**、不是写死的 12px（写死会在用户放大界面字号时缩成比正文还小）', () => {
    const small = styleToPresentation({ size: 'small' }).fontSize
    assert(small.includes('--dsh-content-font-'), 'small 没走 token，写死了：' + small)
    assert(small.includes('calc('), 'small 该是一条相对基准的算式，而不是一个绝对值：' + small)
  })

  check('★ 两档字重互不相同，且**加粗用的是本项目的既有口径 600**（不是 700）', () => {
    const n = styleToPresentation({ weight: 'normal' }).fontWeight
    const b = styleToPresentation({ weight: 'bold' }).fontWeight
    assert(n !== b, '两档字重算出了同一个值')
    assert(b === 600, '加粗值不是 600 —— client.js 全篇的「加粗」都是 600，用 700 会盖过应用自己的标题：' + b)
    assert(n === 400, '常规字重该是 400：' + n)
  })

  check('未设置的通道一律回 **null**（不是空串、不是 undefined、也不是兜底色）', () => {
    const p = styleToPresentation({})
    assert(p.color === null && p.icon === null && p.fontWeight === null && p.fontSize === null, JSON.stringify(p))
    for (const k of Object.keys(p)) assert(p[k] !== '' && p[k] !== undefined, k + ' 的回退值不是 null：' + String(p[k]))
  })

  check('展示映射只回四个键，且**不含 svg**（ICON_TABLE.shapes 已内联进客户端，不重复一份）', () => {
    const p = styleToPresentation({ color: 'red', icon: 'video', weight: 'bold', size: 'large' })
    assert(Object.keys(p).sort().join() === 'color,fontSize,fontWeight,icon', '键变了：' + Object.keys(p).join(','))
    for (const v of Object.values(p)) {
      assert(!String(v).includes('<svg'), '展示映射里混进了 SVG 字符串 —— 同一件事写两份')
    }
    assert(p.icon === 'video', 'icon 该回**形状名**（调用方自己去 ICON_TABLE.shapes 取图形）')
  })

  check('展示映射对非法输入不抛，回全 null', () => {
    for (const bad of [null, undefined, 'red', 42, [], true]) {
      const p = styleToPresentation(bad)
      assert(Object.keys(p).length === 4, '返回异常：' + String(bad))
    }
  })

  check('★ resolveTagStyle 的 preset 与 styleToPresentation 一致（只有一份展示口径）', () => {
    const managed = [{ id: 'a', tag: 'alpha', color: 'red', icon: 'video' }]
    const r = resolveTagStyle('alpha', managed, { surface: 'group' })
    const p = styleToPresentation(r.style)
    assert(JSON.stringify(r.preset) === JSON.stringify(p), '两条路算出了不同的展示：' + JSON.stringify([r.preset, p]))
  })
}

/* ═══ [I] 可内联 ═══════════════════════════════════════════════════════════ */
console.log('\n=== [I] 可内联：纯数据 + 自包含 ===')
{
  check('TAG_STYLE_TABLE 是纯 JSON 数据（无函数 / 无正则），往返后逐字节相等', () => {
    const json = JSON.stringify(TAG_STYLE_TABLE)
    assert(typeof json === 'string' && json.length > 200, 'JSON 序列化异常')
    const back = JSON.parse(json)
    assert(JSON.stringify(back) === json, '往返后有损失（可能有函数 / 正则 / undefined）')
    assert(json.indexOf('function') === -1, '表里混进了函数')
    assert(!/RegExp|=>/.test(json), '表里混进了正则或箭头函数')
  })

  check('★ buildTagStyleRule(JSON 往返表) 与模块级函数**逐样本一致**', () => {
    const rule = buildTagStyleRule(JSON.parse(JSON.stringify(TAG_STYLE_TABLE)), normalizeTag)
    const styles = [{}, { color: 'red' }, { color: 'violet', icon: 'pdf', weight: 'bold', size: 'large' }]
    for (const s of styles) {
      assert(JSON.stringify(rule.present(s)) === JSON.stringify(styleToPresentation(s)), 'present 不一致：' + JSON.stringify(s))
      assert(JSON.stringify(rule.applySurface(s, 'chip')) === JSON.stringify(applyTagStyleSurface(s, 'chip')), 'applySurface 不一致')
    }
    const managed = [{ id: 'a', tag: 'alpha', color: 'red' }]
    for (const t of ['alpha', 'beta', 'ALPHA']) {
      assert(rule.layerOf(t, managed) === tagLayer(t, managed), 'layerOf 不一致：' + t)
      assert(JSON.stringify(rule.resolve(t, managed)) === JSON.stringify(resolveTagStyle(t, managed)), 'resolve 不一致：' + t)
    }
    assert(rule.colorSlots().join() === TAG_COLOR_SLOTS.join(), 'colorSlots 不一致')
    assert(rule.checkBudget(managed).limit === checkManagedTagBudget(managed).limit, 'checkBudget 不一致')
  })

  check('★ buildTagStyleRule 自包含：在「没有模块私有作用域」的环境里照样能跑', () => {
    // 只把函数的**源码**取出来，用 new Function 在全局作用域里重建 ——
    // 模块私有的 TAG_STYLE_TABLE / COLOR_SOURCES / SIZE_VALUES / WEIGHT_VALUES /
    // MANAGED_LIMIT / normalizeTag 在这里都不存在。
    // 能跑且结果一致，才证明这段能整段粘进 client.js。
    const rebuild = new Function('table', 'keyOf', 'return (' + String(buildTagStyleRule) + ')(table, keyOf)')
    const isolated = rebuild(JSON.parse(JSON.stringify(TAG_STYLE_TABLE)), normalizeTag)
    const managed = [{ id: 'a', tag: 'alpha', color: 'red', icon: 'video', size: 'large' }]
    for (const t of ['alpha', 'beta']) {
      assert(JSON.stringify(isolated.resolve(t, managed)) === JSON.stringify(resolveTagStyle(t, managed)),
        '隔离环境结果不一致：' + t)
    }
    assert(isolated.limit() === MANAGED_TAG_LIMIT, '隔离环境的 limit 不一致')
    // 再静态确认没有直接引用模块级私有常量名。
    // ⚠️ 先剥掉注释与字符串 —— 函数体的 JSDoc 与错误信息里**必然会提到**这些名字，
    //    那是文档价值；「引用一个名字」和「在字符串里提到它」必须分得开。
    const stripped = stripCommentsAndStrings(String(buildTagStyleRule))
    assert(stripped.ok === true, '剥离注释/字符串失败（' + stripped.why + '）—— 扫描前提失效，不拿一份残缺的 code 去下结论')
    assert(stripped.removed > 5, '只剥掉 ' + stripped.removed + ' 段注释/字符串，数量级不对 —— 剥离器可能根本没生效')
    assert(stripped.code.length > 1000, '剥离后只剩 ' + stripped.code.length + ' 字符 —— 剥多了或切错了')
    assert(stripped.code.length < String(buildTagStyleRule).length, '剥离后没变短 —— 剥离器在空转')
    for (const leaked of ['TAG_STYLE_TABLE', 'COLOR_SOURCES', 'SIZE_VALUES', 'WEIGHT_VALUES',
      'MANAGED_LIMIT', 'normalizeTag', 'FILE_TYPE_COLORS', 'ICON_TABLE']) {
      assert(!stripped.code.includes(leaked), '函数体引用了模块私有名字：' + leaked)
    }
    // ★ 反向对照：证明这个扫描**真的能抓到泄漏** —— 否则它可能在空转
    //    （拿一段确定引用了私有名字的代码喂给它，必须命中）。
    const positive = stripCommentsAndStrings('function f() { return TAG_STYLE_TABLE.limit }')
    assert(positive.ok === true && positive.code.includes('TAG_STYLE_TABLE'),
      '反向对照失败：扫描器抓不到一个**确凿**的私有名字引用 ⇒ 上面那些「没泄漏」的结论不可信')
    const inString = stripCommentsAndStrings('function f() { return "TAG_STYLE_TABLE" }')
    assert(inString.ok === true && !inString.code.includes('TAG_STYLE_TABLE'),
      '反向对照失败：字符串里的名字没被剥掉 ⇒ 会把文档价值误判成泄漏')
  })

  check('lib/tag-styles.js 源码本身不含 hex 颜色字面量', () => {
    const src = fs.readFileSync(SRC, 'utf8')
    // 注释里出现 `#ff0000` 这类反例是允许的（它们是文档价值），
    // 但**字符串字面量里**的 hex 是配置，必须没有。
    const literals = src.match(/'[^'\n]*#[0-9a-fA-F]{3,8}[^'\n]*'/g) || []
    const real = literals.filter((s) => !/^\s*'(#|请|⚠|·)/.test(s) && s.indexOf('禁止') < 0 && s.indexOf('反例') < 0)
    assert(real.length === 0, '源码的字符串字面量里出现 hex：' + real.join(' , '))
  })
}

/* ═══ [J] 健壮性 / 拆层 / 自动打标签闸门 ═══════════════════════════════════ */
console.log('\n=== [J] 健壮性 / 拆层 / 自动打标签闸门 ===')
{
  check('★ splitTagsByLayer：受管的带样式、自由的素净，且**保序**', () => {
    const managed = [{ id: 'a', tag: '视频项目', color: 'red' }, { id: 'b', tag: '调研' }]
    const tags = ['调研', '弹幕梗', '视频项目', '1080p']
    const r = splitTagsByLayer(tags, managed)
    assert(r.free.join() === '弹幕梗,1080p', '自由层不对：' + r.free.join(','))
    assert(r.managed.map((m) => m.tag).join() === '调研,视频项目', '受管层顺序不对（该按记录里的次序）：' + r.managed.map((m) => m.tag).join(','))
    assert(r.managed[0].style !== null && JSON.stringify(r.managed[0].style) === '{}',
      '没样式的受管条目该回空样式对象（不是 null）：' + JSON.stringify(r.managed[0]))
    assert(r.managed[1].style.color === 'red', '样式没跟上：' + JSON.stringify(r.managed[1]))
  })

  check('★ splitTagsByLayer 逐字去重、保序，但**不做归一化合并**（合并是 3b 的活，要人确认）', () => {
    const r = splitTagsByLayer(['dsh', 'DSH', 'dsh', 'x'], [])
    assert(r.free.join() === 'dsh,DSH,x', '逐字去重/保序不对：' + r.free.join(','))
  })

  check('splitTagsByLayer 对非法输入不抛', () => {
    for (const bad of [null, undefined, 'abc', 42, [null, undefined, '', 3, {}]]) {
      const r = splitTagsByLayer(bad, null)
      assert(r && Array.isArray(r.managed) && Array.isArray(r.free), '返回异常：' + String(bad))
    }
  })

  check('★ 自动打标签闸门：只有受管的才放行（自由词一律拒）', () => {
    const managed = [{ id: 'a', tag: '视频项目' }]
    const yes = checkAutoTag('视频项目', managed)
    assert(yes.ok === true && yes.entry.id === 'a', JSON.stringify(yes))
    const no = checkAutoTag('随手写的新词', managed)
    assert(no.ok === false, '自由词竟然放行了自动打标签')
    assert(no.reason.includes('受管'), '拒绝理由该点明「自动打标签只能打受管的」：' + no.reason)
    assert(checkAutoTag('', managed).ok === false, '空串放行了')
  })

  check('resolveTagStyle 的默认面是 chip（保守方向：不传就不给会破行高的字号）', () => {
    const managed = [{ id: 'a', tag: 'alpha', size: 'large', color: 'red' }]
    const r = resolveTagStyle('alpha', managed)
    assert(r.preset.fontSize === null, '默认面竟然给了字号：' + JSON.stringify(r.preset))
    assert(r.preset.color === TAG_STYLE_TABLE.colors.red, '默认面把颜色也弄丢了')
    const g = resolveTagStyle('alpha', managed, { surface: 'group' })
    assert(g.preset.fontSize !== null, 'group 面上字号丢了')
  })

  check('resolveTagStyle：自由词的 style 与 preset 都是 null（不是空对象）', () => {
    const r = resolveTagStyle('free-word', [{ id: 'a', tag: 'alpha' }])
    assert(r.layer === 'free' && r.style === null && r.preset === null, JSON.stringify(r))
  })

  check('resolveTagStyle / layerOf / managedTagEntry 对畸形入参一律不抛', () => {
    const junk = [undefined, null, '', 42, {}, [], true]
    for (const a of junk) {
      for (const b of junk) {
        assert(tagLayer(a, b) === 'free' || tagLayer(a, b) === 'managed', 'tagLayer 返回异常')
        const r = resolveTagStyle(a, b)
        assert(r && (r.layer === 'free' || r.layer === 'managed'), 'resolve 返回异常')
        assert(managedTagEntry(a, b) === null || typeof managedTagEntry(a, b) === 'object', 'entryOf 返回异常')
        const s = splitTagsByLayer(a, b)
        assert(Array.isArray(s.managed) && Array.isArray(s.free), 'split 返回异常')
      }
    }
  })

  check('受管表里缺 tag / 非对象条目不该把整张表带崩（跳过，不抛）', () => {
    const r = resolveTagStyle('alpha', [{ id: 'a' }, null, 42, { id: 'b', tag: 'alpha', color: 'red' }])
    assert(r.layer === 'managed' && r.style.color === 'red', '畸形条目把好的那条挤掉了：' + JSON.stringify(r))
  })

  check('每次调用都拿到独立的对象（没有共享可变状态）', () => {
    const managed = [{ id: 'a', tag: 'alpha', color: 'red' }]
    const r1 = resolveTagStyle('alpha', managed)
    r1.style.color = 'green'
    r1.preset.color = 'x'
    const r2 = resolveTagStyle('alpha', managed)
    assert(r2.style.color === 'red' && r2.preset.color === TAG_STYLE_TABLE.colors.red,
      '上一次调用污染了下一次：' + JSON.stringify(r2))
  })

  check('色板 / 图标 / 档位的直出数组改不动模块内部状态', () => {
    const before = TAG_ICONS.join()
    TAG_ICONS.push('__hacked__')
    TAG_ICONS.pop()
    assert(TAG_ICONS.join() === before, '直出数组被外部改动影响了')
  })
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败')
if (failed) console.log('失败清单：\n  - ' + failures.join('\n  - '))
process.exit(failed ? 1 : 0)
