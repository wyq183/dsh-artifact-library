/**
 * 离线 harness：标签治理规则层（lib/tags.js，Step 3a）
 *
 * 六节，按「出错后果」从重到轻：
 *   A normalizeTag：与项目名归一化**同源**（复用它，不另写一份）
 *   B ★★ 范围边界：只做「同串两写」的归一，**不做「具体→抽象」**
 *   C pickCanonicalTag：五条规则的**确定性**与优先级
 *   D findTagDuplicates：真库那 9 组能全数找出 + 空归一化标签不误并
 *   E suggestTagFamilies：只读线索 + **必须带反例警示** + 不重复出组
 *   F tagStats：长尾率口径
 *
 * 用法：node test/tags.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  normalizeTag, pickCanonicalTag, findTagDuplicates, planTagMerge,
  suggestTagFamilies, tagStats,
} from '../lib/tags.js'
import { normalizeProjectName } from '../lib/project-merge.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

// ═══ [A] normalizeTag ═════════════════════════════════════════════════════
console.log('\n=== [A] normalizeTag：与项目名归一化同源 ===')
{
  check('★ 与 normalizeProjectName 完全同源（同样的输入给同样的输出）', () => {
    const samples = ['DSH', 'dsh', '卫龙榴莲辣条·留恋计划', '卫龙榴莲辣条留恋计划', 'ＡＢＣ', '  gpNext  ', 'GP-Next', '日本語タグ', '···', '', null, undefined]
    for (const s of samples) {
      assert(normalizeTag(s) === normalizeProjectName(s),
        `${JSON.stringify(s)}: tags→${JSON.stringify(normalizeTag(s))} vs project→${JSON.stringify(normalizeProjectName(s))}`)
    }
  })
  check('大小写 / 分隔符 / 空白 / 全角 归一后相同', () => {
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

// ── [G] 真库只读体检（有数据才跑，没有就跳过）────────────────────────────
const REAL_DIR = process.argv[2] || path.join(os.homedir(), '.dsh', 'artifact-library')
const REAL_FILE = path.join(REAL_DIR, 'artifacts.json')
if (fs.existsSync(REAL_FILE)) {
  console.log('\n=== [G] 真库只读体检（只读，不写）===')
  try {
    const items = JSON.parse(fs.readFileSync(REAL_FILE, 'utf8'))
    const live = items.filter((r) => !r.trashed_at)
    const cnt = new Map()
    for (const r of live) for (const t of (r.tags || [])) cnt.set(t, (cnt.get(t) || 0) + 1)
    const input = [...cnt.entries()].map(([tag, count]) => ({ tag, count }))
    const st = tagStats(input)
    const dup = findTagDuplicates(input)
    check(`真库（${live.length} 条有效）里重复标签组数为 9、涉及 18 个（实测口径）`, () => {
      assert(dup.groups.length === 9, `实际 ${dup.groups.length} 组：` + dup.groups.map((g) => g.key).join(','))
      assert(dup.duplicateTags === 18, `实际 ${dup.duplicateTags} 个标签`)
    })
    check('真库长尾率在 60%~80% 之间（这是个「标签没收敛」的量化信号）', () => {
      const pct = st.longTailRate * 100
      assert(pct >= 60 && pct <= 80, `长尾率 ${pct.toFixed(1)}% —— 超出预期区间，重新审视第 3 步的前提`)
    })
    console.log(`    真库：不同标签 ${st.distinct} / 单次 ${st.oneOff} / 长尾率 ${(st.longTailRate * 100).toFixed(1)}%`)
  } catch (e) {
    console.log('  （真库读取失败，跳过该节：' + e.message + '）')
  }
} else {
  console.log('\n=== [G] 真库只读体检：跳过（本机没有 ' + REAL_FILE + '）===')
}

console.log('\n' + '─'.repeat(64))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) { console.log('\n失败列表：'); for (const f of failures) console.log('  · ' + f) }
process.exit(failed ? 1 : 0)
