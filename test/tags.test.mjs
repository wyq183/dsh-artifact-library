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
import { Readable, Writable } from 'node:stream'
import {
  normalizeTag, pickCanonicalTag, findTagDuplicates, planTagMerge,
  suggestTagFamilies, tagStats,
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

  check('H14 边界：from 里带 canonical 自己 / 纯标点 → 跳过，不算错也不改东西', () => {
    const onlySelf = S2.mergeTags({ groups: [{ canonical: 'DSH', from: ['DSH'] }] })
    assert(onlySelf.ok === false, '「没有可改写的写法」应 ok=false，实际 ' + JSON.stringify(onlySelf))
    const withJunk = S2.mergeTags({ groups: [{ canonical: 'DSH', from: ['···', 'dsh'] }] })
    assert(withJunk.ok === true, '纯标点该被跳过、不该让整组失败：' + JSON.stringify(withJunk))
    const u = S2.undoTagMerge()
    assert(u.ok === true, '善后撤销应成功：' + JSON.stringify(u))
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

    // ── ★★ 对真库跑一遍**只读**的 dry-run：这是「3b 真能治真库那 9 组」的唯一实证 ──
    // 做法：把 artifacts.json **复制**到临时目录，在副本上建 store。真库只读。
    check('★★ 对真库跑 dry-run：报出 9 组 / 涉及 18 个标签，且**磁盘字节不变**', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-tags-real-'))
      TMP_DIRS.push(dir)
      fs.copyFileSync(REAL_FILE, path.join(dir, 'artifacts.json'))
      const store = new ArtifactStore(dir).load()
      const plan = store.suggestCleanup().tagMerges
      assert(plan.length === 9, `真库该报 9 组，实际 ${plan.length}：` + plan.map((g) => g.key).join(','))
      const variants = plan.reduce((n, g) => n + 1 + g.from.length, 0)
      assert(variants === 18, `涉及标签该 18 个，实际 ${variants}`)
      // ⚠️ 快照必须在 `load()` **之后**取：load 会回填老记录缺失字段并写一次盘
      //    （那是既有行为，不是 dry-run 造成的）。要证明的是**dry-run 本身**不写盘。
      const artifactsBefore = fs.readFileSync(path.join(dir, 'artifacts.json'))
      const metaExisted = fs.existsSync(path.join(dir, 'meta.json'))
      const metaBefore = metaExisted ? fs.readFileSync(path.join(dir, 'meta.json')) : null
      const dry = store.mergeTags({ groups: plan, dryRun: true })
      assert(dry.ok === true, '真库 dry-run 应成功：' + JSON.stringify(dry).slice(0, 300))
      assert(dry.changed > 0, '真库 dry-run 该有命中记录，实际 ' + dry.changed)
      // 关键：dry-run 前后 artifacts.json 与 meta.json **逐字节相同**
      assert(artifactsBefore.equals(fs.readFileSync(path.join(dir, 'artifacts.json'))),
        'dry-run 竟然改动了 artifacts.json 的字节！')
      const metaNow = fs.existsSync(path.join(dir, 'meta.json')) ? fs.readFileSync(path.join(dir, 'meta.json')) : null
      if (metaBefore === null) assert(metaNow === null, 'dry-run 不该凭空写出 meta.json')
      else assert(metaBefore.equals(metaNow), 'dry-run 竟然改动了 meta.json 的字节！')
      const fresh = new ArtifactStore(dir).load()
      assert(fresh.meta.lastTagMerge == null, 'dry-run 不该留下撤销凭据')
      console.log(`    真库 dry-run：${dry.groups} 组 → 会改 ${dry.changed} 条记录、去掉 ${dry.tagsRemoved} 个重复标签`)
      for (const p of plan.slice(0, 3)) {
        console.log(`      ${p.canonical}  ←  ${p.from.join('、')}  （${p.total} 次引用）`)
      }
    })
  } catch (e) {
    console.log('  （真库读取失败，跳过该节：' + e.message + '）')
  }
} else {
  console.log('\n=== [G] 真库只读体检：跳过（本机没有 ' + REAL_FILE + '）===')
}

// ── 收尾：临时目录一律删掉（P1 那条「绝不在仓库里留垃圾」）────────────────
for (const dir of TMP_DIRS) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

console.log('\n' + '─'.repeat(64))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) { console.log('\n失败列表：'); for (const f of failures) console.log('  · ' + f) }
process.exit(failed ? 1 : 0)
