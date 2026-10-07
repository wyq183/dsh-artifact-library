/**
 * 离线 harness：标签治理规则层（lib/tags.js，Step 3a）
 *
 * 六节，按「出错后果」从重到轻：
 *   A normalizeTag：**装饰符折叠、语义符号保留**（与项目名归一化**刻意分家**）
 *   B ★★ 范围边界：只做「同串两写」的归一，**不做「具体→抽象」**
 *   C pickCanonicalTag：五条规则的**确定性**与优先级
 *   D findTagDuplicates：真重复能全数找出 + 空归一化标签不误并
 *   E suggestTagFamilies：只读线索 + **必须带反例警示** + 不重复出组
 *   F tagStats：长尾率口径
 *
 * 用法：node test/tags.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  normalizeTag, pickCanonicalTag, findTagDuplicates, planTagMerge,
  suggestTagFamilies, tagStats, buildTagSwap,
} from '../lib/tags.js'
import { normalizeProjectName } from '../lib/project-merge.js'
import { ArtifactStore } from '../lib/store.js'
import { artifactsHandler } from '../lib/http.js'

let passed = 0
let failed = 0
const failures = []
// 临时目录统一登记，收尾一律删掉 —— 本文件绝不在仓库/真库里留垃圾
const TMP_DIRS = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

// ═══ [A] normalizeTag ═════════════════════════════════════════════════════
// ⚠️ 2026-10-07 改：**归一化不再复用 `normalizeProjectName`**（旧断言「完全同源」现在是假的）。
//    原因见 `lib/tags.js` 的 `normalizeTag` 注释：项目名要**宽松**的 key（四档匹配还有人核对），
//    标签的 key 就是**最终判据**、必须**保守**。这里要把这条差异**钉住**，
//    否则它会悄悄漂回去 —— 「同源」这个说法当时看着合理，代价是 `C++` 被并成 `C`。
console.log('\n=== [A] normalizeTag：装饰符折叠，但语义符号必须保留 ===')
{
  check('★★ 与项目名归一化**刻意分家**：装饰符上一致，语义符号上必须分歧', () => {
    // ① 装饰符（空白 / · / - / _）两者一致 —— 这是「同串两写」要折叠的部分
    const decorOnly = ['DSH', 'dsh', '卫龙榴莲辣条·留恋计划', '卫龙榴莲辣条留恋计划', 'ＡＢＣ', '  gpNext  ', 'GP-Next', '日本語タグ']
    for (const s of decorOnly) {
      assert(normalizeTag(s) === normalizeProjectName(s),
        `装饰符类样本该一致：${JSON.stringify(s)}: tags→${JSON.stringify(normalizeTag(s))} vs project→${JSON.stringify(normalizeProjectName(s))}`)
    }
    // ② ⭐ 语义符号（+ # .）上**必须**分歧 —— 项目名抹掉它们，标签保留
    for (const s of ['C++', 'C#', 'F#', '.NET', 'v0.3.0', 'AGENTS.md']) {
      assert(normalizeTag(s) !== normalizeProjectName(s),
        `★ ${JSON.stringify(s)} 两者归一化结果竟然相同（${JSON.stringify(normalizeTag(s))}）——`
        + '说明 normalizeTag 又变回"抹掉所有符号"了，那会把 C++/C#/C 并成一个')
    }
  })
  check('★★ 语义符号不同的标签**永不归成一键**（这是本版修的那个真洞）', () => {
    const keys = ['C', 'C++', 'C#'].map(normalizeTag)
    assert(new Set(keys).size === 3, 'C/C++/C# 撞键了：' + JSON.stringify(keys))
    assert(new Set(['F', 'F#'].map(normalizeTag)).size === 2, 'F/F# 撞键')
    assert(new Set(['NET', '.NET'].map(normalizeTag)).size === 2, 'NET/.NET 撞键')
    assert(findTagDuplicates(['C', 'C++', 'C#']).groups.length === 0,
      '★ findTagDuplicates 还是把它们当一组了 —— 建议层会主动提议合并它们')
  })
  check('装饰符折叠：大小写 / 连字符 / 空白 / 全角 / `·`', () => {
    assert(normalizeTag('DSH') === normalizeTag('dsh'))
    assert(normalizeTag('GP-Next') === normalizeTag('gpNext'))
    assert(normalizeTag('卫龙榴莲辣条·留恋计划') === normalizeTag('卫龙榴莲辣条留恋计划'))
    assert(normalizeTag('ＡＢＣ') === 'abc', '全角该折成半角：' + normalizeTag('ＡＢＣ'))
    assert(normalizeTag('  DSH 插件  ') === normalizeTag('dsh插件'))
  })
  check('没有可用身份的标签 → 空串（不参与分组）', () => {
    assert(normalizeTag('') === '')
    assert(normalizeTag('···') === '', '全标点该归空：' + JSON.stringify(normalizeTag('···')))
    assert(normalizeTag('---') === '')
    assert(normalizeTag(null) === '' && normalizeTag(undefined) === '')
  })

  // ── ★★ 差分测试：不枚举样本，直接比对「一条独立写的参考实现」 ──────────────
  // ⚠️ 为什么要有这条（2026-10-07 · 小琪琪独立复核提出，我复现后采纳）：
  //    上面那几条是**枚举样本**（"这几对必须不同"）—— 可读，但只覆盖我想到的组合。
  //    她先试了一条"更省"的写法：一个性质 ——「同 tag 键 ⇒ 同 project 键」
  //    （即 normalizeTag 必须比 normalizeProjectName **更细**）。**那条对洞① 是瞎的**：
  //      当前实现 violated 0 / 旧口径(抹掉所有符号) violated 也 0
  //    因为洞① 的病灶恰恰是"tag 键**塌成了** project 键"——
  //    两者相等时，"不更粗"这条性质照样成立。**那条性质把 bug 状态当成了合法状态。**
  //    ⇒ 改用差分：把「意图」直接写成一份参考实现，逐串比对。
  //      **它会在有人把口径改回旧样子时立刻红，并打印是哪些输入** —— 不用先想到那个样本。
  //    ⚠️ 但**不替换**上面那三条：枚举的**可读性**是文档价值（一眼看懂为什么必须不同），
  //      差分的**覆盖面**是护栏价值。**两个一起留。**
  check('★★ 差分：与「只折叠装饰符」这条意图的参考实现**逐串一致**（覆盖面守卫）', () => {
    // 参考实现 = 把「意图」直写一遍（刻意不 import normalizeTag 的任何内部件）
    const DECOR = /[\s\u00b7\u30fb\u2027\u2219\u22c5\u2010\u2011\u2012\u2013\u2014\u2015\-_]+/gu
    const reference = (s) => String(s == null ? '' : s).normalize('NFKC').replace(DECOR, '').toLowerCase()

    // 生成式语料：短串 × 语义符号的笛卡尔积（专挑洞① 那一类）
    const alpha = ['C', 'c', 'F', 'A', 'GP', 'net', 'v0', '3', '0', 'x', '日']
    const sem = ['', '+', '#', '.', '++', '##', '.0', '-', '_', ' ', '·', '+\u200b']
    const corpus = new Set()
    for (const a of alpha) for (const b of sem) for (const c of sem) corpus.add(a + b + c)

    const mismatch = []
    for (const s of corpus) {
      if (normalizeTag(s) !== reference(s)) mismatch.push(`${JSON.stringify(s)}: ${JSON.stringify(normalizeTag(s))} != ${JSON.stringify(reference(s))}`)
    }
    assert(mismatch.length === 0,
      `有 ${mismatch.length} 处与意图不符（前 8 条）：\n    ` + mismatch.slice(0, 8).join('\n    '))
    assert(corpus.size >= 100, '生成语料太小（' + corpus.size + '），这条守卫会名存实亡')

    // 反向对照：**必须**能抓到"抹掉所有符号"的旧口径 —— 否则这条守卫是空转的
    const oldCaliber = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
    let oldBad = 0
    for (const s of corpus) if (oldCaliber(s) !== reference(s)) oldBad += 1
    assert(oldBad > 0,
      '★ 反向对照失败：旧口径（抹掉所有符号）竟然与参考实现一致 ——'
      + '说明这份语料挑不出洞①，那这条守卫是空转的，等于没写')
  })
}

// ═══ [B] ★★ 范围边界（本步最重要的一条）═════════════════════════════════
console.log('\n=== [B] 范围边界：只做「同串两写」，不做「具体→抽象」===')
{
  check('★★ 具体而正确的单次标签**不许**被并到一起（它们是不同的事）', () => {
    // 这些标签语义上互不相干，绝不能被合成一组
    const input = ['超星', '弹幕梗', '第213章', '1080p', '城市夜景', '宝箱系统']
    const r = findTagDuplicates(input)
    assert(r.groups.length === 0, `把互不相干的标签合成 ${r.groups.length} 组了：${JSON.stringify(r.groups.map((g) => g.key))}`)
  })
  check('★★ 真重复必须被找出（同串两写）', () => {
    const r = findTagDuplicates(['DSH', 'dsh'])
    assert(r.groups.length === 1, 'DSH/dsh 该是一组')
    assert(r.groups[0].key === 'dsh', r.groups[0].key)
  })
  check('★ 前缀关系**不算**重复（`DSH` / `DSH插件` 是两族）', () => {
    const r = findTagDuplicates(['DSH', 'DSH插件'])
    assert(r.groups.length === 0,
      '把前缀关系当成重复了 —— 那会开始猜用户意图。' + JSON.stringify(r.groups))
  })
  check('★ 不做编辑距离/词干的模糊匹配', () => {
    const r = findTagDuplicates(['Godot', 'Godots', 'Gotdot'])
    assert(r.groups.length === 0, '开始模糊匹配了：' + JSON.stringify(r.groups.map((g) => g.key)))
  })
}

// ═══ [C] pickCanonicalTag：五条规则与确定性 ═══════════════════════════════
console.log('\n=== [C] pickCanonicalTag：规则优先级 + 确定性 ===')
{
  check('① 出现次数多的胜出（`Godot`×21 胜 `godot`×5）', () => {
    assert(pickCanonicalTag([{ tag: 'godot', count: 5 }, { tag: 'Godot', count: 21 }]) === 'Godot')
    // 反过来的输入顺序也要给同样结果（规则不依赖入参顺序）
    assert(pickCanonicalTag([{ tag: 'Godot', count: 21 }, { tag: 'godot', count: 5 }]) === 'Godot')
  })
  check('★ 次数决定一切：`DSH`×8 胜 `dsh`×6 **不是因为偏好大写**', () => {
    assert(pickCanonicalTag([{ tag: 'dsh', count: 6 }, { tag: 'DSH', count: 8 }]) === 'DSH')
    // 次数反转 → 结果也跟着反转，证明没有大小写倾向
    assert(pickCanonicalTag([{ tag: 'dsh', count: 9 }, { tag: 'DSH', count: 8 }]) === 'dsh',
      '次数多的小写竟然输了 —— 说明这里有隐藏的大小写偏好')
  })
  check('② 次数相同 → 保留大小写**混写**的那个', () => {
    // `browser-skill`（全小写、且有 `-`）vs `BrowserSkill`（混写、无特殊字符）：
    // ② 和 ③ 都指向后者，所以这条干净地验到了 ②。
    assert(pickCanonicalTag([{ tag: 'browser-skill', count: 1 }, { tag: 'BrowserSkill', count: 1 }]) === 'BrowserSkill')
  })
  check('★ 更早的规则优先：③（特殊字符少）会压过 ②（混写）', () => {
    // `gpNext`（混写，0 个特殊字符）vs `GP-Next`（混写，1 个 `-`）：
    // **两个都是混写** ⇒ ② 打平 ⇒ 轮到 ③，于是没有连字符的 `gpNext` 胜。
    // ⚠️ 我第一版把这条写成「期望 GP-Next」，是**测试写错了**，不是代码错。
    //    它值得单独留一条，因为「为什么留下的是这个写法」必须看数据、不能从名字猜。
    assert(pickCanonicalTag([{ tag: 'GP-Next', count: 3 }, { tag: 'gpNext', count: 3 }]) === 'gpNext',
      '平局时该由 ③（特殊字符少）决定，得到 ' + pickCanonicalTag([{ tag: 'GP-Next', count: 3 }, { tag: 'gpNext', count: 3 }]))
  })
  check('★ 但真库里 `GP-Next` 是靠**次数**胜出的（×3 vs ×2）', () => {
    // 这条钉住「真库结果来自数据而不是规则偏好」——与 DSH/dsh 那条同一个道理
    assert(pickCanonicalTag([{ tag: 'gpNext', count: 2 }, { tag: 'GP-Next', count: 3 }]) === 'GP-Next',
      '真实次数下该由 ① 决定')
  })
  check('② 补充：纯全大写**不算**混写（`DSH` 与 `dsh` 在②上打平，交给③④⑤）', () => {
    // 次数相同且都非混写 → 看特殊字符（都没有）→ 看长度（一样）→ 字典序
    const got = pickCanonicalTag([{ tag: 'DSH', count: 3 }, { tag: 'dsh', count: 3 }])
    assert(got === 'DSH', '字典序大写在前，得到 ' + got)
  })
  check('③ 特殊字符少的胜出（`·` 版本输掉）', () => {
    assert(pickCanonicalTag([
      { tag: '卫龙榴莲辣条·留恋计划', count: 1 },
      { tag: '卫龙榴莲辣条留恋计划', count: 1 },
    ]) === '卫龙榴莲辣条留恋计划')
  })
  check('④⑤ 长度短、字典序小 —— 保证**确定性**（同样输入永远同样输出）', () => {
    const a = pickCanonicalTag([{ tag: 'aaa', count: 1 }, { tag: 'bb', count: 1 }])
    assert(a === 'bb', '长度短的该胜：' + a)
    const b1 = pickCanonicalTag([{ tag: 'xy', count: 1 }, { tag: 'ab', count: 1 }])
    const b2 = pickCanonicalTag([{ tag: 'ab', count: 1 }, { tag: 'xy', count: 1 }])
    assert(b1 === 'ab' && b1 === b2, `字典序不稳定：${b1} / ${b2}`)
  })
  check('空输入 → 空串，不抛', () => {
    assert(pickCanonicalTag([]) === '')
    assert(pickCanonicalTag(null) === '')
    assert(pickCanonicalTag([null, {}, { tag: 5 }]) === '')
  })
}

// ═══ [D] findTagDuplicates ════════════════════════════════════════════════
console.log('\n=== [D] findTagDuplicates：真库 9 组能全数找出 ===')
{
  // ⚠️ 这张表是**真实数据实测出来的**（2026-10-07，251 条有效记录）。
  //    故意写死：哪天库里的重复变了，这条测试会红 —— 那正是我要的提醒。
  const REAL_DUPES = [
    ['godot', 'Godot'],
    ['dsh', 'DSH'],
    ['pvz2', 'PvZ2'],
    ['svg', 'SVG'],
    ['gpNext', 'GP-Next'],
    ['html', 'HTML'],
    ['ui', 'UI'],
    ['browser-skill', 'BrowserSkill'],
    ['卫龙榴莲辣条留恋计划', '卫龙榴莲辣条·留恋计划'],
  ]
  check('★★ 真库那 9 组 / 18 个标签能全数找出（一组不多、一组不少）', () => {
    const input = REAL_DUPES.flat()
    const r = findTagDuplicates(input)
    assert(r.groups.length === 9, `找出 ${r.groups.length} 组，应为 9：` + r.groups.map((g) => g.key).join(','))
    assert(r.duplicateTags === 18, `涉及标签 ${r.duplicateTags} 个，应为 18`)
    assert(r.mergeable === 9, `可合并 ${r.mergeable} 个，应为 9（每组并剩 1 个）`)
    // 每组都恰好 2 个变体
    for (const g of r.groups) assert(g.variants.length === 2, `${g.key} 有 ${g.variants.length} 个变体`)
  })
  check('★★ `·` 那组也在（它不带大小写差异，只看大小写会漏掉）', () => {
    const r = findTagDuplicates(['卫龙榴莲辣条留恋计划', '卫龙榴莲辣条·留恋计划'])
    assert(r.groups.length === 1, '漏掉了 `·` 那组 —— 这就是当初只数出 8 组的原因')
    assert(r.groups[0].canonical === '卫龙榴莲辣条留恋计划', '规范名该是无 `·` 的：' + r.groups[0].canonical)
  })
  check('★ 组内 `from` 只含**会被改写掉**的写法（不含 canonical）', () => {
    const r = findTagDuplicates([{ tag: 'dsh', count: 6 }, { tag: 'DSH', count: 8 }])
    const g = r.groups[0]
    assert(g.canonical === 'DSH', g.canonical)
    assert(JSON.stringify(g.from) === JSON.stringify(['dsh']), JSON.stringify(g.from))
    assert(!g.from.includes('DSH'), 'from 里不该有 canonical')
  })
  check('★ 归一化后为空的标签**不参与分组**（不能因「都无意义」而并起来）', () => {
    const r = findTagDuplicates(['···', '---', '', 'DSH'])
    assert(r.groups.length === 0, '把无意义标签并成一组了：' + JSON.stringify(r.groups.map((g) => g.key)))
  })
  check('接受字符串数组与 {tag,count} 两种输入，次数正确累加', () => {
    const r1 = findTagDuplicates(['DSH', 'DSH', 'dsh'])
    assert(r1.groups[0].variants.find((v) => v.tag === 'DSH').count === 2, JSON.stringify(r1.groups[0].variants))
    assert(r1.groups[0].canonical === 'DSH', '次数多的该胜：' + r1.groups[0].canonical)
    const r2 = findTagDuplicates([{ tag: 'DSH', count: 2 }, { tag: 'dsh', count: 1 }])
    assert(r2.groups[0].total === 3, 'total: ' + r2.groups[0].total)
  })
  check('输出顺序稳定：先按影响面（total 降序），再按归一键', () => {
    const a = findTagDuplicates([{ tag: 'aa', count: 1 }, { tag: 'AA', count: 1 }, { tag: 'b', count: 9 }, { tag: 'B', count: 9 }])
    assert(a.groups[0].key === 'b', 'total 大的该在前：' + a.groups.map((g) => g.key).join(','))
  })
  check('planTagMerge 只输出可执行项（无 from 的组被丢掉）', () => {
    const plan = planTagMerge(findTagDuplicates(['DSH', 'dsh']).groups)
    assert(plan.length === 1 && plan[0].canonical === 'DSH', JSON.stringify(plan))
    assert(planTagMerge([{ canonical: 'x', from: [] }]).length === 0, '空 from 不该进计划')
    assert(planTagMerge(null).length === 0)
  })
}

// ═══ [E] suggestTagFamilies：只读线索 ═════════════════════════════════════
console.log('\n=== [E] suggestTagFamilies：只给线索，不给结论 ===')
{
  check('★ 必须带**反例警示**（同前缀不等于同一件事）', () => {
    const r = suggestTagFamilies([{ tag: 'DSH', count: 8 }, { tag: 'DSH插件', count: 7 }])
    assert(r.length === 1, '该给出一组线索')
    assert(/dsh-artifact-library/.test(r[0].warning),
      'warning 里必须写出真实反例（dsh-* 那四个不同插件），否则用户会以为同前缀就该合：' + r[0].warning)
  })
  check('★ 同归一化键的变体**不重复出组**（`DSH` 与 `dsh` 只报一次）', () => {
    const r = suggestTagFamilies([{ tag: 'DSH', count: 8 }, { tag: 'dsh', count: 6 }, { tag: 'DSH插件', count: 7 }])
    const prefixes = r.map((f) => f.prefix)
    assert(new Set(prefixes).size === prefixes.length, '前缀重复了：' + prefixes.join(','))
    // 且同一组里不会同时出现 DSH 和 dsh
    for (const f of r) {
      const keys = f.tags.map((t) => normalizeTag(t.tag))
      assert(new Set(keys).size === keys.length, `组内出现同键标签：${f.tags.map((t) => t.tag).join(',')}`)
    }
  })
  check('短于 minPrefix 的根名不出组（默认 2）', () => {
    assert(suggestTagFamilies([{ tag: 'a', count: 1 }, { tag: 'ab', count: 1 }]).length === 0)
    assert(suggestTagFamilies([{ tag: 'a', count: 1 }, { tag: 'ab', count: 1 }], { minPrefix: 1 }).length === 1)
  })
  check('没有同族 → 空数组（不硬凑）', () => {
    assert(suggestTagFamilies([{ tag: '超星', count: 1 }, { tag: '弹幕梗', count: 1 }]).length === 0)
  })
  check('★ 纯只读：不改动入参', () => {
    const input = [{ tag: 'DSH', count: 8 }, { tag: 'DSH插件', count: 7 }]
    const snap = JSON.stringify(input)
    suggestTagFamilies(input)
    assert(JSON.stringify(input) === snap, '入参被改了')
  })
}

// ═══ [F] tagStats ═════════════════════════════════════════════════════════
console.log('\n=== [F] tagStats：长尾率口径 ===')
{
  check('长尾率 = 只出现 1 次的标签数 / 不同标签数', () => {
    const st = tagStats(['a', 'b', 'c', 'c', 'd'])
    assert(st.distinct === 4, 'distinct: ' + st.distinct)
    assert(st.oneOff === 3, 'oneOff: ' + st.oneOff)
    assert(Math.abs(st.longTailRate - 0.75) < 1e-9, 'longTailRate: ' + st.longTailRate)
  })
  check('接受 Map 与 {tag,count} 数组', () => {
    const m = tagStats(new Map([['x', 1], ['y', 5]]))
    assert(m.distinct === 2 && m.oneOff === 1, JSON.stringify(m))
    const arr = tagStats([{ tag: 'x', count: 2 }, { tag: 'y', count: 2 }])
    assert(arr.oneOff === 0, JSON.stringify(arr))
  })
  check('top 按次数降序、最多 20 个、同次数按字典序（稳定）', () => {
    const many = []
    for (let i = 0; i < 30; i += 1) many.push({ tag: 't' + String(i).padStart(2, '0'), count: 30 - i })
    const st = tagStats(many)
    assert(st.top.length === 20, 'top 长度 ' + st.top.length)
    assert(st.top[0].tag === 't00' && st.top[0].count === 30, JSON.stringify(st.top[0]))
    const tie = tagStats([{ tag: 'bb', count: 1 }, { tag: 'aa', count: 1 }])
    assert(tie.top[0].tag === 'aa', '同次数该按字典序：' + JSON.stringify(tie.top))
  })
  check('空输入 → distinct 0、长尾率 0（不是 NaN）', () => {
    const st = tagStats([])
    assert(st.distinct === 0 && st.longTailRate === 0, JSON.stringify(st))
    assert(tagStats(null).distinct === 0)
  })
  check('★ 对**真库实测值**的口径锚定（829 / 573 / 69.1%）', () => {
    // why 写死：这个数字是「标签有没有收敛」的唯一量化指标，
    // 而第 3 步的全部论证都建立在它上面。它若无声漂移，论证就失效了。
    // ⚠️ 库里数据会变（新登记会加标签），所以这里**只验口径的算法**，
    //    用一个构造出来的、与真库同形状的样本。
    const input = []
    for (let i = 0; i < 573; i += 1) input.push({ tag: 'unique' + i, count: 1 })
    for (let i = 0; i < 256; i += 1) input.push({ tag: 'common' + i, count: 2 })
    const st = tagStats(input)
    assert(st.distinct === 829, 'distinct: ' + st.distinct)
    assert(st.oneOff === 573, 'oneOff: ' + st.oneOff)
    assert(Math.abs(st.longTailRate - 573 / 829) < 1e-9, 'rate: ' + st.longTailRate)
  })
}

// ═══ [H] store.mergeTags / undoTagMerge（Step 3b）═════════════════════════
// 这一节测的是**会改数据**的那一层，所以每条都验「改了没有 / 能不能退 / 不该动的地方
// 有没有被顺手动掉」。前六节是纯函数，这一节必须碰盘（用临时目录，绝不动真库）。
console.log('\n=== [H] store.mergeTags / undoTagMerge（临时目录，不碰真库）===')

{
  const mkStore = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-tags-store-'))
    TMP_DIRS.push(dir)
    return { dir, store: new ArtifactStore(dir).load() }
  }
  const mkRec = (store, dir, file, tags) =>
    store.register({ path: path.join(dir, file), title: file, tags })

  // ── 一组真库实测的重复（`DSH`×8 / `dsh`×6）───────────────────────────
  const { dir: D1, store: S1 } = mkStore()
  const A = mkRec(S1, D1, 'a.txt', ['DSH', 'godot'])
  const B = mkRec(S1, D1, 'b.txt', ['dsh'])
  const C2 = mkRec(S1, D1, 'c.txt', ['dsh', 'DSH'])   // ★ 记录内两个变体都有
  const N = mkRec(S1, D1, 'n.txt', ['超星'])           // 不含任何 from → 一个字都不该动

  check('H1 suggestCleanup 报出标签重复组与标签现状（三个新字段都在形状上）', () => {
    const s = S1.suggestCleanup()
    assert(Array.isArray(s.tagMerges), 'tagMerges 应为数组：' + JSON.stringify(s.tagMerges))
    assert(s.tagMerges.length === 1, '期望 1 组（dsh/DSH），实际 ' + JSON.stringify(s.tagMerges))
    assert(s.tagMerges[0].canonical === 'DSH', '规范名该是 DSH（次数多）：' + s.tagMerges[0].canonical)
    assert(JSON.stringify(s.tagMerges[0].from) === JSON.stringify(['dsh']), JSON.stringify(s.tagMerges[0].from))
    assert(s.tagStats && s.tagStats.distinct === 4, 'distinct 应为 4（DSH/dsh/godot/超星），实际 ' + JSON.stringify(s.tagStats))
    assert(s.tagMergeUndo === null, '尚未合并时 tagMergeUndo 应为 null')
  })

  check('H2 ★ dry-run：报了影响面，但**记录、meta 一个字节都没改**', () => {
    const metaBefore = JSON.stringify(S1.meta)
    const r = S1.mergeTags({ groups: S1.suggestCleanup().tagMerges, dryRun: true })
    assert(r.ok === true, 'dry-run 应成功：' + JSON.stringify(r))
    assert(r.dryRun === true, 'dryRun 标记应为 true')
    // ⚠️ 命中 = 2 条，不是 3：`A` 的 tags 是 ['DSH','godot'] —— 它**只含规范名、不含要改写的
    //    `dsh`**，所以本来就不该被动。（这一条我第一版写成 3，是**测试算错了**，不是代码错。）
    assert(r.changed === 2, '期望命中 2 条（b/c 两条含 dsh），实际 ' + r.changed)
    assert(JSON.stringify(A.tags) === JSON.stringify(['DSH', 'godot']), 'A 不该被改：' + JSON.stringify(A.tags))
    assert(JSON.stringify(B.tags) === JSON.stringify(['dsh']), 'B 不该被改：' + JSON.stringify(B.tags))
    assert(JSON.stringify(C2.tags) === JSON.stringify(['dsh', 'DSH']), 'C 不该被改：' + JSON.stringify(C2.tags))
    assert(JSON.stringify(S1.meta) === metaBefore, 'dry-run 不该碰 meta')
    assert(S1.meta.lastTagMerge === null, 'dry-run 不该留下撤销凭据')
  })

  check('H3 ★ plans 的两个计数口径：会被改几条 vs 全库引用多少条', () => {
    const r = S1.mergeTags({ groups: S1.suggestCleanup().tagMerges, dryRun: true })
    const p = r.plans[0]
    assert(p.canonical === 'DSH', p.canonical)
    // 会被改写的记录数：只有 b、c 两条含 `dsh`
    assert(p.records === 2, '会被改写的记录数该是 2，实际 ' + p.records)
    // ⭐ 全库引用数：`DSH` 在 A 与 C 里各一次 → 2；若只数命中记录会得到 1（漏掉不必改的 A）
    const byTag = Object.fromEntries(p.variants.map((v) => [v.tag, v.records]))
    assert(byTag.DSH === 2, '★ `DSH` 该报**全库** 2 条引用（A 也要算上），实际 ' + byTag.DSH)
    assert(byTag.dsh === 2, '`dsh` 全库引用该是 2（B/C），实际 ' + byTag.dsh)
  })

  check('H4 ★ 执行：变体改成规范名；**记录内两个变体只留一个**（顺手治）', () => {
    const r = S1.mergeTags({ groups: S1.suggestCleanup().tagMerges })
    assert(r.ok === true && r.dryRun === false, '执行应成功：' + JSON.stringify(r))
    assert(r.changed === 2, '期望改 2 条，实际 ' + r.changed)
    assert(r.tagsRemoved === 1, '期望去掉 1 个重复标签（C 里那两个），实际 ' + r.tagsRemoved)
    assert(JSON.stringify(B.tags) === JSON.stringify(['DSH']), 'B 应只剩 DSH：' + JSON.stringify(B.tags))
    assert(JSON.stringify(C2.tags) === JSON.stringify(['DSH']),
      '★ C 记录内的 dsh/DSH 应并成一个，实际 ' + JSON.stringify(C2.tags))
    assert(JSON.stringify(A.tags) === JSON.stringify(['DSH', 'godot']), 'A 的 godot 不该被动：' + JSON.stringify(A.tags))
  })

  check('H5 ★ 不含 from 的记录**一个字都不动**（克制：不做全库重写）', () => {
    assert(JSON.stringify(N.tags) === JSON.stringify(['超星']), 'N 的标签被动了：' + JSON.stringify(N.tags))
  })

  check('H6 执行后 tagMergeUndo 非 null，count/groups/at 都对得上', () => {
    const u = S1.suggestCleanup().tagMergeUndo
    assert(u !== null, '合并后 undo 不该为 null')
    assert(u.count === 2, 'undo.count 期望 2，实际 ' + u.count)
    assert(u.groups === 1, 'undo.groups 期望 1（一组一条 swap），实际 ' + u.groups)
    assert(typeof u.at === 'number' && u.at > 0, 'undo.at 应是时间戳：' + JSON.stringify(u.at))
  })

  check('H7 ★ 撤销：tags 整份还原，restored 正确', () => {
    const u = S1.undoTagMerge()
    assert(u.ok === true, '撤销应成功：' + JSON.stringify(u))
    assert(u.restored === 2, '期望还原 2 条，实际 ' + u.restored)
    assert(JSON.stringify(B.tags) === JSON.stringify(['dsh']), 'B 应还原：' + JSON.stringify(B.tags))
    assert(JSON.stringify(C2.tags) === JSON.stringify(['dsh', 'DSH']),
      '★ C 应整份还原成 ["dsh","DSH"]（含那个"记录内重复"也复原），实际 ' + JSON.stringify(C2.tags))
  })

  check('H8 撤销后 undo 回 null；再撤一次必须 ok=false 且有可读 error', () => {
    assert(S1.suggestCleanup().tagMergeUndo === null, '撤销后 tagMergeUndo 应回 null')
    const again = S1.undoTagMerge()
    assert(again.ok === false, '连撤两次，第二次应 ok=false：' + JSON.stringify(again))
    assert(typeof again.error === 'string' && again.error.length > 0, '被拒时应给可读 error')
  })

  check('H9 ★ 撤销凭据落盘：重启 store 后最近一次标签合并仍可撤销', () => {
    const r = S1.mergeTags({ groups: S1.suggestCleanup().tagMerges })
    assert(r.ok === true, '合并应成功：' + JSON.stringify(r))
    const S1b = new ArtifactStore(D1).load()
    assert(S1b.meta.lastTagMerge && S1b.meta.lastTagMerge.changed.length === 2,
      '重启后 meta.lastTagMerge 应仍在且含 2 条快照，实际 ' + JSON.stringify(S1b.meta.lastTagMerge && S1b.meta.lastTagMerge.changed.length))
    const u = S1b.undoTagMerge()
    assert(u.ok === true && u.restored === 2, '重启后撤销应成功且还原 2 条：' + JSON.stringify(u))
    assert(JSON.stringify(S1b.get(C2.id).tags) === JSON.stringify(['dsh', 'DSH']),
      '重启撤销后 C 应完全还原：' + JSON.stringify(S1b.get(C2.id).tags))
  })

  // ── 边界与被拒的情形 ────────────────────────────────────────────────
  const { dir: D2, store: S2 } = mkStore()
  const P = mkRec(S2, D2, 'p.txt', ['DSH'])
  mkRec(S2, D2, 'q.txt', ['dsh'])

  check('H10 ★★ 范围边界闸门：借 mergeTags 做「具体→抽象」的重分类**被拒**', () => {
    const r = S2.mergeTags({ groups: [{ canonical: '学业', from: ['超星'] }] })
    assert(r.ok === false, '把「超星」并进「学业」竟然成功了 —— 那会丢用户信息：' + JSON.stringify(r))
    assert(/具体→抽象/.test(r.error), '拒绝理由该说清是范围边界：' + r.error)
    assert(JSON.stringify(P.tags) === JSON.stringify(['DSH']), '被拒时不该改任何记录')
  })

  check('H11 ★ 不跨族 / 不串链：同一归一键下互相指向 → 整体被拒', () => {
    // 注意用例设计：两组都必须**先通过范围闸门**（同一归一键），才轮得到链式检查。
    // 我第一版拿 `DSH` / `DSH插件` 当例子 —— 那两个归一化后**不同**，会被范围闸门先拦下，
    // 于是链式检查根本没被走到，测的是别的东西（这条我记在下面，免得后人重犯）。
    const r = S2.mergeTags({
      groups: [
        { canonical: 'dsH', from: ['DSH'] },  // DSH → dsH
        { canonical: 'DSH', from: ['dsh'] },  // dsh → DSH  ⇒ 串成 dsh→DSH→dsH
      ],
    })
    assert(r.ok === false, '串链竟然成功了：' + JSON.stringify(r))
    assert(/串起来/.test(r.error), '拒绝理由该点明「会把两族/两链串起来」：' + r.error)
    assert(JSON.stringify(P.tags) === JSON.stringify(['DSH']), '被拒时不该改任何记录')
  })

  check('H12 ★ 校验先于动手：一组不合法 → 合法的那些也一条都不改', () => {
    const r = S2.mergeTags({
      groups: [
        { canonical: 'DSH', from: ['dsh'] },      // 这组合法
        { canonical: '学业', from: ['超星'] },     // 这组不合法
      ],
    })
    assert(r.ok === false, '该整体被拒：' + JSON.stringify(r))
    assert(JSON.stringify(P.tags) === JSON.stringify(['DSH']), 'a：不该改')
    assert(JSON.stringify(S2.get(S2.items.find((x) => x.title === 'q.txt').id).tags) === JSON.stringify(['dsh']),
      'b：合法组也不该被改（半改状态最难收拾）')
  })

  check('H13 边界：缺 groups / 空 groups / 无 from → ok=false + 可读 error', () => {
    for (const bad of [undefined, {}, { groups: [] }, { groups: [{ canonical: 'DSH', from: [] }] }]) {
      const r = S2.mergeTags(bad)
      assert(r.ok === false, `应当被拒：${JSON.stringify(bad)} → ${JSON.stringify(r)}`)
      assert(typeof r.error === 'string' && r.error.length > 0, '被拒时要有可读 error')
    }
  })

  check('H14 边界：from 里带 canonical 自己 → 跳过（无东西可改）', () => {
    const onlySelf = S2.mergeTags({ groups: [{ canonical: 'DSH', from: ['DSH'] }] })
    assert(onlySelf.ok === false, '「没有可改写的写法」应 ok=false，实际 ' + JSON.stringify(onlySelf))
  })

  check('★ H14b 【3c 改行为】纯标点标签在 merge 下**被拒**（旧行为是静默跳过）', () => {
    // ⚠️ 这条**改了 3b 的行为**，理由要说清楚（2026-10-07，做 3c 抽公共校验层时发现）：
    //   旧写法是「归一化后为空 → continue 跳过」。我当时写的理由是"它匹配不到任何记录" ——
    //   **那个理由是错的**：`tagCounts` 只滤掉**空串**，像 `···` 这种"归一化为空但字面存在"
    //   的标签**是真在库里的**，所以"跳过它"等于**报告说改了、实际一条没改** ——
    //   正是这个文件反复要防的空转。
    //   ⇒ 现在只跳过**真正的空串**；`···` 走 merge 会被闸门拒（判据 `'' !== key`），
    //     并**明确指向 `rename`** —— 清理垃圾标签是"人的决定"，正是 rename 的职责。
    const withJunk = S2.mergeTags({ groups: [{ canonical: 'DSH', from: ['···', 'dsh'] }] })
    assert(withJunk.ok === false,
      '★ 纯标点该被闸门拒（而不是静默跳过）—— 静默跳过 = 报告说改了实际没改：' + JSON.stringify(withJunk))
    assert(/rename/.test(withJunk.error), '拒绝时该指出出路是 rename：' + withJunk.error)
    assert(JSON.stringify(P.tags) === JSON.stringify(['DSH']), '被拒时不该改任何记录')
  })

  check('★ H14c 而 `rename` **能**清理垃圾标签（这就是那两个动作的分工）', () => {
    const { dir, store } = mkStore()
    const rec = store.register({ path: path.join(dir, 'j.txt'), title: 'j', tags: ['···', '正常'] })
    const dry = store.renameTags({ groups: [{ canonical: '正常', from: ['···'] }], dryRun: true })
    assert(dry.ok === true, 'rename 该接受清理垃圾标签：' + JSON.stringify(dry))
    assert(dry.changed === 1, '该命中 1 条，实际 ' + dry.changed)
    const real = store.renameTags({ groups: [{ canonical: '正常', from: ['···'] }] })
    assert(real.ok === true && real.mode === 'rename', JSON.stringify(real))
    assert(JSON.stringify(rec.tags) === JSON.stringify(['正常']),
      '★ 垃圾标签该被真的清掉（并被记录内去重掉）：' + JSON.stringify(rec.tags))
    const u = store.undoTagMerge()
    assert(u.ok === true && u.mode === 'rename', '撤销该能识别出这是 rename：' + JSON.stringify(u))
    assert(JSON.stringify(rec.tags) === JSON.stringify(['···', '正常']), '该整份还原：' + JSON.stringify(rec.tags))
  })

  check('H15 ★ 回收站记录不参与标签合并（与 mergeProjects 同一口径）', () => {
    const { dir: D3, store: S3 } = mkStore()
    mkRec(S3, D3, 'live.txt', ['DSH'])
    const trashed = mkRec(S3, D3, 'gone.txt', ['dsh'])
    S3.trash(trashed.id)
    const r = S3.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
    assert(r.ok === false, '只有回收站记录命中 → 应报「没有命中」，实际 ' + JSON.stringify(r))
    assert(JSON.stringify(trashed.tags) === JSON.stringify(['dsh']), '回收站记录的 tags 不该被改')
  })

  check('H16 归一化后为空的标签不产生草稿垃圾堆（纯标点不进计数）', () => {
    const { dir: D4, store: S4 } = mkStore()
    mkRec(S4, D4, 'e.txt', ['···', '---'])
    const s = S4.suggestCleanup()
    assert(s.tagMerges.length === 0, '无意义标签不该成组：' + JSON.stringify(s.tagMerges))
    assert(s.tagStats.distinct === 2, '计数口径：库里确实存着两个无意义标签，实际 ' + s.tagStats.distinct)
  })

  check('H17 ★ tagCounts() 口径：回收站不算、归档要算、重复标签按次计', () => {
    // 这是**三处共用的口径源**（suggestCleanup / mergeTags / 3c 的工具），值得单独钉住。
    const { dir: D5, store: S5 } = mkStore()
    const live = mkRec(S5, D5, 'l.txt', ['DSH', 'DSH', 'godot'])  // 同一条挂两次 DSH
    mkRec(S5, D5, 'a.txt', ['DSH'])
    const gone = mkRec(S5, D5, 'g.txt', ['DSH', 'dsh'])
    S5.trash(gone.id)
    S5.update(live.id, { status: 'archived' })  // 归档记录**仍计入**
    const counts = Object.fromEntries(S5.tagCounts().map((e) => [e.tag, e.count]))
    assert(counts.DSH === 3, '期望 DSH=3（live 两次 + 归档一次），实际 ' + counts.DSH)
    assert(counts.godot === 1, '期望 godot=1，实际 ' + counts.godot)
    assert(counts.dsh === undefined, '回收站里的 dsh 不该进计数，实际 ' + counts.dsh)
    // 与规则层喂进去的结果一致：口径一处，两边不会漂
    const viaRule = S5.suggestCleanup()
    assert(viaRule.tagStats.distinct === 2, 'distinct 该是 2（DSH/godot），实际 ' + viaRule.tagStats.distinct)
  })
}

// ═══ [I] HTTP 端点透传（Step 3b）═══════════════════════════════════════════
// 为什么单独测这一层：本仓库反复栽的坑是「存进去了但不生效」——
// store 里加了字段、但端点/工具忘了透传，于是 agent 永远看不到（2e 就是这么栽的）。
// 这一节用真 handler + 假 req/res，证明新字段**真的能从 HTTP 出来**。
console.log('\n=== [I] HTTP /suggest-cleanup 透传标签字段 ===')

{
  const I_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-tags-http-'))
  TMP_DIRS.push(I_DIR)
  const istore = new ArtifactStore(I_DIR).load()
  istore.register({ path: path.join(I_DIR, 'a.txt'), title: 'A', tags: ['DSH'] })
  istore.register({ path: path.join(I_DIR, 'b.txt'), title: 'B', tags: ['dsh'] })

  function makeRes() {
    const chunks = []
    const res = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
    res.statusCode = 0
    res.headers = {}
    res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}); return res }
    res.bodyText = () => Buffer.concat(chunks).toString('utf8')
    res.json = () => JSON.parse(res.bodyText())
    return res
  }
  function reqOf(method, url) {
    const req = Readable.from([])
    req.method = method
    req.url = url
    req.headers = {}
    req.socket = { remoteAddress: '127.0.0.1' }
    return req
  }
  async function checkAsync(name, fn) {
    try { await fn(); passed += 1; console.log('  ok   ' + name) }
    catch (e) { failed += 1; failures.push(name + ' → ' + (e && e.message ? e.message : String(e))); console.log('  FAIL ' + name + ' → ' + e.message) }
  }

  await checkAsync('I1 ★ GET /suggest-cleanup 真的带出 tagMerges / tagStats / tagMergeUndo', async () => {
    const res = makeRes()
    await artifactsHandler(istore, { fileIndex: {} })(reqOf('GET', '/ext/artifacts/suggest-cleanup'), res)
    assert(res.statusCode === 200, '状态码期望 200，实际 ' + res.statusCode + ' ' + res.bodyText())
    const b = res.json()
    // ⭐ 这三条就是「新字段有没有真的透传出去」的判据 —— 少一条都说明 agent 看不到
    assert(Array.isArray(b.tagMerges), 'tagMerges 没透传出来：' + JSON.stringify(b.tagMerges))
    assert(b.tagMerges.length === 1, '期望 1 组，实际 ' + JSON.stringify(b.tagMerges))
    assert(b.tagStats && typeof b.tagStats.distinct === 'number',
      'tagStats 没透传出来：' + JSON.stringify(b.tagStats))
    assert(b.tagMergeUndo === null, '尚未合并时 tagMergeUndo 应为 null，实际 ' + JSON.stringify(b.tagMergeUndo))
  })
}

// ═══ [J] 两个真洞的回归守卫（2026-10-07 小琪琪独立复核逮到的）══════════════
//
// ⚠️ 这一节的意义**不是覆盖率**，是**钉住两条被实测复现过的数据丢失路径**。
//    两条都是"从正常路径就能踩到"的 —— 不是谁手构造攻击，是**建议层自己会提议**。
console.log('\n=== [J] 两个真洞的回归守卫（都是实测复现过的丢数据路径）===')

{
  const mkStore = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-tags-hole-'))
    TMP_DIRS.push(dir)
    return { dir, store: new ArtifactStore(dir).load() }
  }

  // ── 洞① 符号被抹平：`C++` / `C#` 会被并成 `C` ────────────────────────────
  check('★★ J1 洞①：`C` / `C++` / `C#` 是三个不同的键（曾被抹成同一个 `c`）', () => {
    const keys = ['C', 'C++', 'C#'].map(normalizeTag)
    assert(new Set(keys).size === 3, '又撞键了：' + JSON.stringify(keys))
    assert(findTagDuplicates(['C', 'C++', 'C#']).groups.length === 0,
      'findTagDuplicates 又把它们归成一组了')
  })
  check('★★ J2 洞①的**正常路径**：suggestCleanup 不会主动建议合并它们', () => {
    const { dir, store } = mkStore()
    let i = 0
    for (const tag of ['C', 'C++', 'C#', 'F', 'F#', '.NET 8', 'NET 8']) {
      store.register({ path: path.join(dir, 'r' + (i += 1) + '.txt'), title: 'r' + i, tags: [tag] })
    }
    const plan = store.suggestCleanup().tagMerges
    assert(plan.length === 0,
      '★ 建议层还在提议合并符号标签 —— 用户/agent 照着点一下就丢数据：' + JSON.stringify(plan))
  })
  check('★★ J3 洞①的**执行层**：硬把 `C++` 并成 `C` 也会被闸门拦住', () => {
    const { store } = mkStore()
    const r = store.mergeTags({ groups: [{ canonical: 'C', from: ['C++', 'C#'] }] })
    assert(r.ok === false, '★ 闸门放行了具体→抽象的符号合并：' + JSON.stringify(r))
  })
  check('★ J4 反向守卫：`.` 也有语义（`v0.3.0` 与 `v030` 不同）', () => {
    assert(normalizeTag('v0.3.0') !== normalizeTag('v030'),
      '版本号被抹平了：' + normalizeTag('v0.3.0') + ' vs ' + normalizeTag('v030'))
    assert(findTagDuplicates(['.NET 8', 'NET 8']).groups.length === 0, '.NET/NET 被并了')
  })

  // ── 洞② 撤销跨批次：标签合并的撤销会冲掉项目合并加的 tag ────────────────
  check('★★ J5 洞②：撤销标签合并**不会**冲掉项目合并刚加的 tag', () => {
    const { dir, store } = mkStore()
    const rec = store.register({ path: path.join(dir, 'a.txt'), title: 'a', project: '旧项目', tags: ['dsh'] })
    assert(store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] }).ok === true, '标签合并该成功')
    assert(store.mergeProjects({ names: ['旧项目'], to: '新项目' }).ok === true, '项目合并该成功')
    assert(rec.tags.includes('旧项目'), '项目合并该把原名写进 tags（这是设计）')
    // 互斥：项目合并已经清掉了标签合并的凭据 ⇒ 这次撤销**应当被拒**
    const u = store.undoTagMerge()
    assert(u.ok === false, '★ 跨批次撤销竟然成功了 —— 那会静默丢数据：' + JSON.stringify(u))
    assert(rec.tags.includes('旧项目'), '★「旧项目」tag 被冲掉了：' + JSON.stringify(rec.tags))
  })
  check('★★ J6 互斥是双向的（三份凭据只留最近一次）', () => {
    const { dir, store } = mkStore()
    store.register({ path: path.join(dir, 'a.txt'), title: 'a', project: '旧项目', tags: ['dsh'] })
    store.mergeProjects({ names: ['旧项目'], to: '新项目' })
    assert(store.meta.lastProjectMerge !== null, '项目合并后该有凭据')
    store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
    assert(store.meta.lastProjectMerge === null, '★ 标签合并后，项目合并凭据该被清掉')
    assert(store.meta.lastTagMerge !== null, '标签合并凭据该在')
    assert(store.undoProjectMerge().ok === false, '被清掉的凭据不该还能撤')
  })
  check('★ J7 互斥没有把「撤销最近一次」弄坏（自身仍然可撤、可还原）', () => {
    const { dir, store } = mkStore()
    const rec = store.register({ path: path.join(dir, 'a.txt'), title: 'a', tags: ['dsh'] })
    store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
    const u = store.undoTagMerge()
    assert(u.ok === true && u.restored === 1, JSON.stringify(u))
    assert(JSON.stringify(rec.tags) === JSON.stringify(['dsh']), JSON.stringify(rec.tags))
  })
  check('★ J8 空操作不许顶掉别人的凭据（`reassignArtifactType` 0 条那条路）', () => {
    const { dir, store } = mkStore()
    store.register({ path: path.join(dir, 'a.txt'), title: 'a', tags: ['dsh'] })
    store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
    assert(store.meta.lastTagMerge !== null, '先有一份标签凭据')
    const moved = store.reassignArtifactType('不存在的分类', {})
    assert(moved.ok === true && moved.changed === 0, '空分类该直接成功：' + JSON.stringify(moved))
    assert(store.meta.lastTagMerge !== null,
      '★ 一个"什么都没改"的操作把标签合并的撤销凭据顶掉了 —— 用户白丢唯一退路')
  })

  // ── CSS：data-plugin（热载不重插的真根因，行号会漂所以按内容切）─────────
  check('★★ J9 CSS：`injectCss` 必须打上 `data-plugin`（否则热载后新 CSS 永远进不来）', () => {
    const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const i = src.indexOf('function injectCss()')
    assert(i > 0, '找不到 injectCss（它被改名/搬走了？这条守卫要跟着改）')
    const body = src.slice(i, i + 2200)
    assert(body.includes('setAttribute("data-plugin-css"'), '原有的 data-plugin-css 丢了')
    assert(body.includes('setAttribute("data-plugin"'),
      '★ data-plugin 没打上 —— 宿主 removeOwnedStyles 删不掉旧 style，'
      + '热载后新 CSS 进不来（这就是"CSS 不重插"的真根因）')
    // ⚠️ id 必须是**包名**（宿主 ownerId 来自 client 模块清单的 row.id，那是按包扫出来的）。
    //    它现在住在 `PLUGIN_ID` 常量里，所以两边都要查 —— 光查 injectCss 会漏掉常量被改坏。
    assert(body.includes('PLUGIN_ID'), 'injectCss 该用 PLUGIN_ID 常量（不要写字面量）')
    const decl = /var PLUGIN_ID = "([^"]+)"/.exec(src)
    assert(decl, '找不到 PLUGIN_ID 的声明')
    assert(decl[1] === '@dsh-external/dsh-artifact-library',
      '★ PLUGIN_ID 该是 package.json 里的包名，实际 ' + JSON.stringify(decl[1]))
    const pkgName = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
    assert(decl[1] === pkgName, `★ PLUGIN_ID 与 package.json 的 name 不一致：${decl[1]} vs ${pkgName}`)
  })
  check('★ J10 CSS：旧标签会被**就地认领**（否则过渡期非刷新不可）', () => {
    const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const i = src.indexOf('function injectCss()')
    const body = src.slice(i, i + 2200)
    assert(/if \(existing\)/.test(body),
      '★ injectCss 没有"已有标签就认领"的分支：那本次改动之前注入的那个未打标标签'
      + '会让新 CSS 一直进不来，**非得刷新页面**才行')
    assert(body.includes('existing.setAttribute("data-plugin"'), '认领动作不见了')
    assert(body.includes('existing.textContent = css'), '内容同步不见了（热载后 CSS 值不会更新）')
  })

  // ── 跨方法一致性：三条「撤销」对回收站的口径 ─────────────────────────────
  check('★ J11 三条「撤销」路径对回收站的口径**必须一致**（要改就得三条一起改）', () => {
    // ⚠️ 这条钉的是**跨方法的一致性**，不是单个方法的对错。
    //    2026-10-07 小琪琪复核时问：「`undoTagMerge` 不排除回收站，而 `mergeTags`/`tagCounts` 都排除，
    //    口径不一致」。我复现确认了现象，但**查完三条撤销路径后决定不照"排除"改**：
    //      ① 三条撤销路径**本来就是一致的**（`undoProjectMerge` / `undoCategoryRemoval`
    //         也还原回收站记录）⇒ 只改 `undoTagMerge` 会**制造**一处新的不一致 ——
    //         正是她想避免的那类问题；
    //      ② 快照记的是"这次操作改过哪些记录"，而三条批量写**在改写时**都跳过回收站
    //         ⇒ 能进快照 = 当时有效、确实被改过；之后被回收不改变这个事实，
    //           撤销就该把它退回去（跳过反而留下"内容带着一次已被撤销的操作"的记录，
    //           用户恢复那条记录时会看到合并后的写法）。
    //    ⇒ 这里把"三者行为一致"钉住：**要么三条一起还原，要么三条一起跳过**。
    //      将来谁想改，这条会立刻红，逼他三个一起想。
    const mk = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-undo-sym-'))
      TMP_DIRS.push(dir)
      return { dir, store: new ArtifactStore(dir).load() }
    }

    const a = mk() // ① 标签合并 → 撤销
    const ra = a.store.register({ path: path.join(a.dir, 'a.txt'), title: 'a', tags: ['dsh'] })
    a.store.mergeTags({ groups: [{ canonical: 'DSH', from: ['dsh'] }] })
    a.store.trash(ra.id)
    a.store.undoTagMerge()

    const b = mk() // ② 项目合并 → 撤销
    const rb = b.store.register({ path: path.join(b.dir, 'b.txt'), title: 'b', project: '旧项目' })
    b.store.mergeProjects({ names: ['旧项目'], to: '新项目' })
    b.store.trash(rb.id)
    b.store.undoProjectMerge()

    const c = mk() // ③ 分类改派 → 撤销
    const rc = c.store.register({ path: path.join(c.dir, 'c.txt'), title: 'c', artifact_type: 'code' })
    c.store.reassignArtifactType('code', { reassignTo: 'document' })
    c.store.trash(rc.id)
    c.store.undoCategoryRemoval()

    const restoredTrashed = {
      undoTagMerge: ra.tags[0] === 'dsh',
      undoProjectMerge: rb.project === '旧项目',
      undoCategoryRemoval: rc.artifact_type === 'code',
    }
    const values = Object.values(restoredTrashed)
    assert(values.every((v) => v === values[0]),
      '★ 三条撤销路径对回收站的口径不一致了 —— 只改一条就会制造新的不一致：'
      + JSON.stringify(restoredTrashed))
    // 现在的共同口径是「照样还原」（理由见 lib/store.js 里 UNDO_CREDENTIAL_KEYS 上方那段）。
    // ⚠️ 若哪天决定改成"跳过回收站"，**三条一起改**，再把这里翻成 === false。
    assert(values[0] === true,
      '★ 三条应当都还原回收站记录（若要改口径，三条一起改并同步翻转这条断言）：'
      + JSON.stringify(restoredTrashed))
  })
}

// ═══ [K] buildTagSwap + renameTags（Step 3c：两个入口共用一个引擎）══════════
//
// 这一节的靶子是**「merge 与 rename 只差一道闸门」这条设计**：
// 如果哪天有人图省事各写一份校验，「不许串链」「逐字保留」这些必然漂移 ——
// 而这仓库已经吃过「同一件事各写一份」的亏（categories.js 头部那五张扩展名表）。
console.log('\n=== [K] buildTagSwap / renameTags（两个入口共用一个引擎）===')

{
  const mkStore = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-tags-3c-'))
    TMP_DIRS.push(dir)
    return { dir, store: new ArtifactStore(dir).load() }
  }

  // ── 规则层：buildTagSwap ────────────────────────────────────────────────
  check('★ K1 机械档（默认）：同串两写放行，跨语义被拒', () => {
    const okOne = buildTagSwap([{ canonical: 'DSH', from: ['dsh'] }])
    assert(okOne.ok === true, '同串两写该放行：' + JSON.stringify(okOne))
    assert(okOne.swap.get('dsh') === 'DSH', 'swap 不对：' + JSON.stringify([...okOne.swap]))
    const bad = buildTagSwap([{ canonical: '学业', from: ['超星'] }])
    assert(bad.ok === false, '跨语义该被拒：' + JSON.stringify(bad))
    assert(/rename/.test(bad.error), '★ 被拒时该指出出路 rename：' + bad.error)
  })

  check('★★ K2 显式档（allowSemantic）：跨语义**允许** —— 这就是 rename 的存在理由', () => {
    const r = buildTagSwap([{ canonical: '学业', from: ['超星', '弹幕梗'] }], { allowSemantic: true })
    assert(r.ok === true, 'rename 档该允许跨语义：' + JSON.stringify(r))
    assert(r.swap.get('超星') === '学业' && r.swap.get('弹幕梗') === '学业', JSON.stringify([...r.swap]))
  })

  check('★ K3 目标名可以是**库里还不存在的**新标签（"建一个大类"的动作）', () => {
    const r = buildTagSwap([{ canonical: '全新的名字', from: ['超星'] }], { allowSemantic: true })
    assert(r.ok === true, '新目标名该允许：' + JSON.stringify(r))
  })

  check('★ K4 两档**共用**的守卫：逐字保留（不 trim、不改大小写）', () => {
    for (const allowSemantic of [false, true]) {
      const r = buildTagSwap([{ canonical: ' DSH ', from: ['dsh'] }], { allowSemantic })
      assert(r.ok === true, `allowSemantic=${allowSemantic} 该放行：` + JSON.stringify(r))
      // ⚠️ 键必须是**记录里那个原字符串**，不能被 trim —— 否则 swap 对不上记录里的值，
      //    结果就是「报告说改了、实际一条没改」的静默空转。
      assert(r.swap.has('dsh'), 'from 的键该逐字保留')
      assert(r.accepted[0].canonical === ' DSH ', '★ canonical 被 trim 了：' + JSON.stringify(r.accepted[0].canonical))
    }
  })

  check('★ K5 两档共用的守卫：同一写法不许并到两个不同目标', () => {
    // ⚠️ 用例设计：两组都必须**先通过范围闸门**（同一归一键），才轮得到这条检查。
    //    我第一版拿 `dsh2` 当第二个目标 —— 它与 `dsh` 归一化后**不同**，
    //    会被范围闸门先拦下，于是测的是别的东西（跟 H11 当初那个坑同型，又踩了一次）。
    for (const allowSemantic of [false, true]) {
      const r = buildTagSwap([
        { canonical: 'DSH', from: ['dsh'] },
        { canonical: 'Dsh', from: ['dsh'] },   // 同归一键（dsh），但目标不同
      ], { allowSemantic })
      assert(r.ok === false, `allowSemantic=${allowSemantic} 该被拒：` + JSON.stringify(r))
      assert(/两个不同的标签/.test(r.error), '该报"并到两个不同目标"：' + r.error)
    }
  })

  check('★★ K6 两档共用的守卫：不许串链（某组的目标名同时是别组要改掉的写法）', () => {
    for (const allowSemantic of [false, true]) {
      const r = buildTagSwap([
        { canonical: 'dsH', from: ['DSH'] },
        { canonical: 'DSH', from: ['dsh'] },
      ], { allowSemantic })
      assert(r.ok === false, `allowSemantic=${allowSemantic} 该被拒：` + JSON.stringify(r))
      assert(/串起来/.test(r.error), r.error)
    }
  })

  check('★★ K7 「空串」跳过，但「归一化后为空的真实标签」**必须进闸门**', () => {
    // ⚠️ 这条改了 3b 的行为，理由是本条最重要的：
    //   旧写法「归一化后为空 → 跳过」会让 `···` 这种**真在库里**的垃圾标签被**静默丢弃** ——
    //   也就是"报告说改了、实际一条没改"。现在只跳过**真空串**（不可能是真实标签）。
    const r = buildTagSwap([{ canonical: 'DSH', from: ['', 'dsh'] }])
    assert(r.ok === true, '真空串该被跳过：' + JSON.stringify(r))
    assert(r.swap.size === 1 && r.swap.has('dsh'), '空串不该进 swap：' + JSON.stringify([...r.swap]))
    // `···` 归一化为空 → 机械档下 `'' !== 'dsh'` ⇒ **被拒**（而不是静默跳过）
    const junk = buildTagSwap([{ canonical: 'DSH', from: ['···'] }])
    assert(junk.ok === false, '★ 纯标点该被拒，不该静默跳过：' + JSON.stringify(junk))
    // 但 rename 档允许 —— 这样垃圾标签才有地方被清理
    const junkRename = buildTagSwap([{ canonical: '正常', from: ['···'] }], { allowSemantic: true })
    assert(junkRename.ok === true, 'rename 档该允许清理垃圾标签：' + JSON.stringify(junkRename))
  })

  check('K8 边界：空输入 / 无有效组 / canonical 归一化后为空 → 都说清原因', () => {
    assert(buildTagSwap([]).ok === false, '空数组该被拒')
    assert(buildTagSwap(null).ok === false, 'null 该被拒')
    assert(buildTagSwap([{ canonical: 'DSH', from: [] }]).ok === false, '没有 from 该被拒')
    assert(buildTagSwap([{ canonical: '', from: ['dsh'] }]).ok === false, '空规范名该被拒')
    const junkTarget = buildTagSwap([{ canonical: '···', from: ['dsh'] }])
    assert(junkTarget.ok === false && /目标名/.test(junkTarget.error), JSON.stringify(junkTarget))
  })

  // ── store 层：renameTags ────────────────────────────────────────────────
  const { dir: D, store: S } = mkStore()
  const mk = (f, tags) => S.register({ path: path.join(D, f), title: f, tags })
  const A = mk('a.txt', ['超星'])
  const B = mk('b.txt', ['弹幕梗'])
  const C = mk('c.txt', ['第213章'])

  check('★ K9 rename 的 dry-run：报影响面，记录/meta 一个字节都不动', () => {
    const metaBefore = JSON.stringify(S.meta)
    const r = S.renameTags({ groups: [{ canonical: '学业', from: ['超星', '弹幕梗'] }], dryRun: true })
    assert(r.ok === true && r.dryRun === true && r.mode === 'rename', JSON.stringify(r).slice(0, 200))
    assert(r.changed === 2, '该命中 2 条，实际 ' + r.changed)
    assert(JSON.stringify(A.tags) === JSON.stringify(['超星']), 'A 不该被改：' + JSON.stringify(A.tags))
    assert(JSON.stringify(S.meta) === metaBefore, '★ dry-run 不该碰 meta')
  })

  check('★ K10 rename 真执行 → 归成大类（含"目标名库里本来没有"的情况）', () => {
    const r = S.renameTags({ groups: [{ canonical: '学业', from: ['超星', '弹幕梗'] }] })
    assert(r.ok === true && r.undo === true && r.mode === 'rename', JSON.stringify(r).slice(0, 200))
    assert(JSON.stringify(A.tags) === JSON.stringify(['学业']), JSON.stringify(A.tags))
    assert(JSON.stringify(B.tags) === JSON.stringify(['学业']), JSON.stringify(B.tags))
    assert(JSON.stringify(C.tags) === JSON.stringify(['第213章']), 'C 没被命中，不该动：' + JSON.stringify(C.tags))
  })

  check('★ K11 rename 的撤销走同一个入口，并如实报出 mode=rename', () => {
    const u = S.undoTagMerge()
    assert(u.ok === true && u.mode === 'rename', '该报 mode=rename：' + JSON.stringify(u))
    assert(JSON.stringify(A.tags) === JSON.stringify(['超星']), JSON.stringify(A.tags))
    assert(JSON.stringify(B.tags) === JSON.stringify(['弹幕梗']), JSON.stringify(B.tags))
  })

  check('★★ K12 两个入口**共用同一份凭据** ⇒ 互相顶掉（只允许撤销最近一次）', () => {
    const { dir: d2, store: s2 } = mkStore()
    const r1 = s2.register({ path: path.join(d2, 'x.txt'), title: 'x', tags: ['dsh'] })
    // ⚠️ 第二步必须用**合法**的操作，否则测的是"被拒之后凭据还在不在"，不是"互斥"。
    //    我第一版写成 `mergeTags({canonical:'DSH', from:['超星']})` —— 那是跨语义、**会被闸门拒**，
    //    于是凭据自然还是 rename 的，测试红得对，但红的原因跟我以为的不是一回事。
    //    （同型错误这一轮我犯了三次：K5 / K12 / 以及更早的 H11。**用例必须真的走到被测那段代码。**）
    const renameRes = s2.renameTags({ groups: [{ canonical: '超星', from: ['dsh'] }] })
    assert(renameRes.ok === true && renameRes.mode === 'rename', '第一步 rename 该成功：' + JSON.stringify(renameRes).slice(0, 160))
    assert(s2.meta.lastTagMerge !== null && s2.meta.lastTagMerge.mode === 'rename', '该落 rename 凭据')
    // 第二步：合法的同串两写（`超星` → `超星2` 不行，得是同一归一键）
    const s3 = s2.register({ path: path.join(d2, 'y.txt'), title: 'y', tags: ['dsh'] })
    s2.update(s3.id, { tags: ['Dsh'] })          // 造一个与 `dsh` 同键的写法
    const mergeRes = s2.mergeTags({ groups: [{ canonical: 'dsh', from: ['Dsh'] }] })
    assert(mergeRes.ok === true, '第二步 merge 该成功：' + JSON.stringify(mergeRes).slice(0, 200))
    const u = s2.undoTagMerge()
    assert(u.ok === true && u.mode === 'merge', '★ 只该能撤最近一次（merge）：' + JSON.stringify(u))
    assert(JSON.stringify(s2.get(s3.id).tags) === JSON.stringify(['Dsh']),
      '该还原到 merge 前：' + JSON.stringify(s2.get(s3.id).tags))
    // ⚠️ 而第一条记录（被 rename 改过）**不该**被动 —— 它的那次凭据已经被顶掉了
    assert(JSON.stringify(s2.get(r1.id).tags) === JSON.stringify(['超星']),
      '★ 更早的那次 rename 已被顶掉，不该被这次撤销波及：' + JSON.stringify(s2.get(r1.id).tags))
  })

  check('★ K13 merge 与 rename 的报错**措辞不同**（agent 才分得清该改用哪个）', () => {
    const viaMerge = S.mergeTags({ groups: [{ canonical: '学业', from: ['第213章'] }] })
    assert(viaMerge.ok === false, 'merge 该拒：' + JSON.stringify(viaMerge))
    assert(/改用 `rename`|改用 rename/.test(viaMerge.error), '该指向 rename：' + viaMerge.error)
    // rename 的空入参文案说的是「改名」，与 merge 的「合并组」区分开
    assert(/改名/.test(S.renameTags({ groups: [] }).error), 'rename 该说"改名"')
    assert(/合并组/.test(S.mergeTags({ groups: [] }).error), 'merge 该说"合并组"')
    // 0 命中时两边也该各说各的
    const missRename = S.renameTags({ groups: [{ canonical: '学业', from: ['根本没有这个标签'] }] })
    assert(/改名/.test(missRename.error), '★ 0 命中时该说"改名"而不是"归一化"：' + missRename.error)
  })
}

// ── [G] 真库只读体检（有数据才跑，没有就跳过）────────────────────────────
//
// ⚠️ 2026-10-07 两处修正（都是小琪琪独立复核提的，都成立）：
//
// ① **不再用 `os.homedir()` 猜真库路径**。原来缺省值 = `~/.dsh/artifact-library`，
//    于是在**任何非 Windows 机器**上都会拿到那边碰巧存在的目录当"真库"，
//    断言 9 组 → 实际 0 组 → **平白红两条**（她机器上就有一个 3 条的测试床残留）。
//    ⇒ 改成显式环境变量 `ALF_REAL_DIR`；找不到就**打印跳过原因**，
//      **绝不拿一个"碰巧存在的目录"当断言目标**。
//
// ② **那两条断言不许再硬编码 9 / 18**。它们是**当时的观察**，不是规律：
//    她真跑过一次合并，证明「合并前 9 组 → 合并后 0 组」——
//    也就是说**等依琪哪天真点了合并，这两条必然变红，而代码完全正确**。
//    "做成了反而红"的测试会训练出"红了就 --force"的习惯，那是最贵的一种坏。
//    ⇒ 改成钉**不变量**（自洽 + 每个 from 与 canonical 同键），
//      真库数字**降级成日志**。（`longTailRate` 那条区间断言本来就是这个形状，保持。）
const REAL_DIR = process.argv[2] || process.env.ALF_REAL_DIR || ''
const REAL_FILE = REAL_DIR ? path.join(REAL_DIR, 'artifacts.json') : ''
if (REAL_FILE && fs.existsSync(REAL_FILE)) {
  console.log('\n=== [G] 真库只读体检（只读，不写）===')
  console.log('    （真库路径来自 ' + (process.argv[2] ? 'argv[2]' : '环境变量 ALF_REAL_DIR') + '：' + REAL_DIR + '）')
  try {
    const items = JSON.parse(fs.readFileSync(REAL_FILE, 'utf8'))
    const live = items.filter((r) => !r.trashed_at)
    const cnt = new Map()
    for (const r of live) for (const t of (r.tags || [])) cnt.set(t, (cnt.get(t) || 0) + 1)
    const input = [...cnt.entries()].map(([tag, count]) => ({ tag, count }))
    const st = tagStats(input)
    const dup = findTagDuplicates(input)

    // ⭐ 不变量（合并前/合并后都必须成立，所以可以永远钉住）
    check('★ 重复组自洽：duplicateTags === Σ(每组 1 + from 数)、mergeable === Σ from 数', () => {
      const expectTags = dup.groups.reduce((n, g) => n + 1 + g.from.length, 0)
      const expectMergeable = dup.groups.reduce((n, g) => n + g.from.length, 0)
      assert(dup.duplicateTags === expectTags, `duplicateTags ${dup.duplicateTags} != 自洽值 ${expectTags}`)
      assert(dup.mergeable === expectMergeable, `mergeable ${dup.mergeable} != 自洽值 ${expectMergeable}`)
    })
    check('★★ 每个 from 都与 canonical **同归一键**（这才是「不跨族」的不变量）', () => {
      for (const g of dup.groups) {
        assert(g.variants.length >= 2, `${g.key} 只有 ${g.variants.length} 个变体`)
        for (const v of g.variants) {
          assert(normalizeTag(v.tag) === g.key,
            `「${v.tag}」归一到 ${JSON.stringify(normalizeTag(v.tag))}，却不属于键 ${JSON.stringify(g.key)}`)
        }
        for (const f of g.from) {
          assert(normalizeTag(f) !== '', `from「${f}」归一化后为空 —— 不该进组`)
          assert(f !== g.canonical, 'from 里混进了 canonical')
        }
      }
    })
    check('真库长尾率在 60%~80% 之间（这是个「标签没收敛」的量化信号）', () => {
      const pct = st.longTailRate * 100
      assert(pct >= 60 && pct <= 80, `长尾率 ${pct.toFixed(1)}% —— 超出预期区间，重新审视第 3 步的前提`)
    })
    // ⚠️ 以下是**日志不是断言** —— 它们是"2026-10-07 当时的观察"，会随库里数据变。
    //    （原来这两行是 assert，会因"合并成功"而变红。见本节头注释 ②。）
    console.log(`    真库：${live.length} 条有效 / 不同标签 ${st.distinct} / 单次 ${st.oneOff} / 长尾率 ${(st.longTailRate * 100).toFixed(1)}%`)
    console.log(`    真库重复标签：${dup.groups.length} 组 / 涉及 ${dup.duplicateTags} 个（2026-10-07 观察值 9 / 18；被合并过就会变小，这是正常的）`)

    // ── ★★ 对真库跑一遍**只读**的 dry-run：这是「3b 真能治真库」的实证 ──
    // 做法：把 artifacts.json **复制**到临时目录，在副本上建 store。真库只读。
    check('★★ 对真库跑 dry-run：dry-run 本身**一个字节都不写**，且报告自洽', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-tags-real-'))
      TMP_DIRS.push(dir)
      fs.copyFileSync(REAL_FILE, path.join(dir, 'artifacts.json'))
      const store = new ArtifactStore(dir).load()
      const plan = store.suggestCleanup().tagMerges
      // ⚠️ 不钉死组数（见本节头注释②）；钉的是**plan 与库现状自洽**
      const expectedVariants = plan.reduce((n, g) => n + 1 + g.from.length, 0)
      assert(expectedVariants === plan.reduce((n, g) => n + g.from.length + 1, 0), 'plan 自洽性')
      for (const g of plan) {
        assert(Array.isArray(g.from) && g.from.length > 0, `${g.canonical} 的 from 为空 —— 不该进计划`)
      }
      // ⚠️ 快照必须在 `load()` **之后**取：load 会回填老记录缺失字段并写一次盘
      //    （那是既有行为，不是 dry-run 造成的）。要证明的是**dry-run 本身**不写盘。
      const artifactsBefore = fs.readFileSync(path.join(dir, 'artifacts.json'))
      const metaExisted = fs.existsSync(path.join(dir, 'meta.json'))
      const metaBefore = metaExisted ? fs.readFileSync(path.join(dir, 'meta.json')) : null
      if (plan.length) {
        const dry = store.mergeTags({ groups: plan, dryRun: true })
        assert(dry.ok === true, '真库 dry-run 应成功：' + JSON.stringify(dry).slice(0, 300))
        assert(dry.changed > 0, '真库 dry-run 该有命中记录，实际 ' + dry.changed)
        console.log(`    真库 dry-run：${dry.groups} 组 → 会改 ${dry.changed} 条记录、去掉 ${dry.tagsRemoved} 个重复标签`)
        for (const p of plan.slice(0, 3)) {
          console.log(`      ${p.canonical}  ←  ${p.from.join('、')}  （${p.total} 次引用）`)
        }
      } else {
        console.log('    真库已无重复标签（被合并过）—— 跳过 dry-run 的命中检查')
      }
      // 关键：dry-run 前后 artifacts.json 与 meta.json **逐字节相同**
      assert(artifactsBefore.equals(fs.readFileSync(path.join(dir, 'artifacts.json'))),
        'dry-run 竟然改动了 artifacts.json 的字节！')
      const metaNow = fs.existsSync(path.join(dir, 'meta.json')) ? fs.readFileSync(path.join(dir, 'meta.json')) : null
      if (metaBefore === null) assert(metaNow === null, 'dry-run 不该凭空写出 meta.json')
      else assert(metaBefore.equals(metaNow), 'dry-run 竟然改动了 meta.json 的字节！')
      const fresh = new ArtifactStore(dir).load()
      assert(fresh.meta.lastTagMerge == null, 'dry-run 不该留下撤销凭据')
    })
  } catch (e) {
    console.log('  （真库读取失败，跳过该节：' + e.message + '）')
  }
} else {
  console.log('\n=== [G] 真库只读体检：跳过（没给真库路径）===')
  console.log('    要给就跑：node test/tags.test.mjs "C:\\Users\\<你>\\.dsh\\artifact-library"')
  console.log('    或设环境变量 ALF_REAL_DIR。⚠️ 故意**不**用 os.homedir() 猜 ——')
  console.log('    那会在别的机器上拿一个碰巧存在的目录当"真库"，平白报红（2026-10-07 修）。')
}

// ── 收尾：临时目录一律删掉（P1 那条「绝不在仓库里留垃圾」）────────────────
for (const dir of TMP_DIRS) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log('\n' + '─'.repeat(64))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) { console.log('\n失败列表：'); for (const f of failures) console.log('  · ' + f) }
process.exit(failed ? 1 : 0)
