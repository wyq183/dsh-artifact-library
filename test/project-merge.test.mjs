/**
 * 离线 harness：项目合并（规则层聚类 + store 执行/撤销 + HTTP 端点）
 *
 * 覆盖四块，按「出错后果」从重到轻：
 *   A 归一化 normalizeProjectName（真实数据里 `·` 导致的假同名）
 *   B 切词 / 共同前缀 / Jaccard 三个基础函数
 *   C findMergeGroups 的四档规则、阈值、规范名选择、输出稳定性
 *   D ⚠️ 回归守卫：15 个共享 `dsh` 前缀但**不同**的项目，一组都不许成
 *   E store.mergeProjects / undoProjectMerge / suggestCleanup 的三个新字段
 *   F HTTP 两个端点（成功 200 / 被拒 400 + 结构化 reason）
 *
 * 用法：node test/project-merge.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  normalizeProjectName, projectTokens, jaccard, commonPrefixLength,
  findMergeGroups, MERGE_REASON, MERGE_DEFAULT_CHECKED,
} from '../lib/project-merge.js'
import { ArtifactStore } from '../lib/store.js'
import { artifactsHandler } from '../lib/http.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
/** HTTP 那节要 await handler，单开一个异步版（同样的成功/失败记账） */
async function checkAsync(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

// 临时目录统一登记，结束一律删掉 —— 本文件绝不在仓库里留垃圾
const TMP_DIRS = []
function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  TMP_DIRS.push(dir)
  return dir
}

try {
  // ═══ [A] 归一化 ═══════════════════════════════════════════════════════════
  console.log('\n=== [A] normalizeProjectName 归一化 ===')

  check('A1 ★ 只差一个分隔符的两个真实名字归一化后必须相等（卫龙榴莲辣条·留恋计划 vs 卫龙榴莲辣条留恋计划）', () => {
    const a = normalizeProjectName('卫龙榴莲辣条·留恋计划')
    const b = normalizeProjectName('卫龙榴莲辣条留恋计划')
    assert(a === b, '期望两者相等，实际 ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b))
    assert(a === '卫龙榴莲辣条留恋计划', '期望 卫龙榴莲辣条留恋计划（·被去掉、中文原样保留），实际 ' + JSON.stringify(a))
  })

  check('A2 全角 → 半角：ＡＢＣ → abc', () => {
    const got = normalizeProjectName('ＡＢＣ')
    assert(got === 'abc', '期望 abc，实际 ' + JSON.stringify(got))
  })

  check('A3 大小写与空格：DSH 扩展 → dsh扩展', () => {
    const got = normalizeProjectName('DSH 扩展')
    assert(got === 'dsh扩展', '期望 dsh扩展，实际 ' + JSON.stringify(got))
  })

  check('A4 标点 / 空格 / emoji 全部去掉：卫龙·辣条 -- 计划 🎉 → 卫龙辣条计划', () => {
    const got = normalizeProjectName('卫龙·辣条 -- 计划 🎉')
    assert(got === '卫龙辣条计划', '期望 卫龙辣条计划，实际 ' + JSON.stringify(got))
  })

  check('A5 ★ CJK 必须保留（别把中文也当标点删掉）', () => {
    assert(normalizeProjectName('中文项目') === '中文项目', '纯中文被改动了：' + JSON.stringify(normalizeProjectName('中文项目')))
    assert(normalizeProjectName('项目A-1') === '项目a1', '期望 项目a1（中文留、A→a、-去掉），实际 ' + JSON.stringify(normalizeProjectName('项目A-1')))
  })

  check('A6 空值 / null 不炸，归一化为空串', () => {
    assert(normalizeProjectName('') === '', '空串 → ' + JSON.stringify(normalizeProjectName('')))
    assert(normalizeProjectName(null) === '', 'null → ' + JSON.stringify(normalizeProjectName(null)))
    assert(normalizeProjectName(undefined) === '', 'undefined → ' + JSON.stringify(normalizeProjectName(undefined)))
  })

  // ═══ [B] 基础函数 ════════════════════════════════════════════════════════
  console.log('\n=== [B] projectTokens / commonPrefixLength / jaccard ===')

  check('B1 projectTokens：按非字母数字切词、转小写；长度 < 2 的词丢掉', () => {
    const got = [...projectTokens('SVG motion studies')].sort()
    assert(JSON.stringify(got) === JSON.stringify(['motion', 'studies', 'svg']),
      '期望 [motion,studies,svg]，实际 ' + JSON.stringify(got))
    const short = [...projectTokens('a b_c')]
    assert(short.length === 0, '单字符词应被丢弃，实际 ' + JSON.stringify(short))
  })

  check('B2 projectTokens：驼峰再切一刀（artifactLibrary → artifact + library）', () => {
    const got = [...projectTokens('artifactLibrary')].sort()
    assert(JSON.stringify(got) === JSON.stringify(['artifact', 'library']),
      '期望 [artifact,library]，实际 ' + JSON.stringify(got))
  })

  check('B3 commonPrefixLength：三角洲口琴工作台/工具链 的共同前缀是 6（三角洲口琴工）', () => {
    const got = commonPrefixLength('三角洲口琴工作台', '三角洲口琴工具链')
    assert(got === 6, '期望 6，实际 ' + got)
    assert(commonPrefixLength('abc', 'abc') === 3, '全等应返回全长 3，实际 ' + commonPrefixLength('abc', 'abc'))
    assert(commonPrefixLength('abc', 'xyz') === 0, '无共同前缀应返回 0，实际 ' + commonPrefixLength('abc', 'xyz'))
  })

  check('B4 jaccard：相同=1、空集=0、不相交=0、部分重合按 |交|/|并|', () => {
    assert(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])) === 1, '相同集合应为 1')
    assert(jaccard(new Set(), new Set(['a'])) === 0, '空集应为 0')
    assert(jaccard(new Set(['a', 'b']), new Set(['c', 'd'])) === 0, '不相交应为 0')
    const got = jaccard(new Set(['a', 'b']), new Set(['a', 'c', 'd']))
    assert(got === 0.25, '期望 1/4=0.25，实际 ' + got)
  })

  // ═══ [C] findMergeGroups 四档规则 ════════════════════════════════════════
  console.log('\n=== [C] findMergeGroups 四档规则与阈值 ===')

  check('C1 exact：只差分隔符的两个名字 → 一组、confidence=exact、defaultChecked=true', () => {
    const r = findMergeGroups([
      { name: '卫龙榴莲辣条·留恋计划', count: 2 },
      { name: '卫龙榴莲辣条留恋计划', count: 1 },
    ])
    assert(r.groups.length === 1, '期望 1 组，实际 ' + r.groups.length + ' 组：' + JSON.stringify(r.groups))
    const g = r.groups[0]
    assert(g.confidence === 'exact', '期望 confidence=exact，实际 ' + g.confidence)
    assert(g.defaultChecked === true, 'exact 档应默认勾选，实际 ' + g.defaultChecked)
    assert(g.reason === MERGE_REASON.exact, '理由应为 ' + MERGE_REASON.exact + '，实际 ' + g.reason)
  })

  check('C2 contains：卫龙榴莲辣条/营销创意/IP 合成一组，规范名=根名 卫龙榴莲辣条，canonicalIsRoot=true', () => {
    const r = findMergeGroups([
      { name: '卫龙榴莲辣条', count: 2 },
      { name: '卫龙榴莲辣条营销创意', count: 5 },
      { name: '卫龙榴莲辣条IP', count: 3 },
    ])
    assert(r.groups.length === 1, '期望 1 组，实际 ' + r.groups.length + ' 组：' + JSON.stringify(r.groups))
    const g = r.groups[0]
    assert(g.confidence === 'contains', '期望 confidence=contains，实际 ' + g.confidence)
    assert(g.canonical === '卫龙榴莲辣条', '期望规范名 卫龙榴莲辣条，实际 ' + JSON.stringify(g.canonical))
    assert(g.canonicalIsRoot === true, '期望 canonicalIsRoot=true，实际 ' + g.canonicalIsRoot)
    assert(g.defaultChecked === true, 'contains 档应默认勾选，实际 ' + g.defaultChecked)
    assert(g.names.length === 3, '期望 3 个成员，实际 ' + g.names.length)
    assert(g.from.length === 2 && g.from.includes('卫龙榴莲辣条营销创意') && g.from.includes('卫龙榴莲辣条IP'),
      'from 应为另两个名字，实际 ' + JSON.stringify(g.from))
  })

  check('C3 ★ 规范名优先选根名：营销创意记录更多（5>2）也不能当选', () => {
    const r = findMergeGroups([
      { name: '卫龙榴莲辣条', count: 2 },
      { name: '卫龙榴莲辣条营销创意', count: 5 },
      { name: '卫龙榴莲辣条IP', count: 3 },
    ])
    const g = r.groups[0]
    const maxCount = g.names.reduce((m, n) => (n.count > m.count ? n : m), g.names[0])
    assert(maxCount.name === '卫龙榴莲辣条营销创意', '前置：记录数最多的应是营销创意，实际 ' + maxCount.name)
    assert(g.canonical === '卫龙榴莲辣条', '规范名必须选根名 卫龙榴莲辣条，实际 ' + JSON.stringify(g.canonical))
  })

  check('C4 prefix：三角洲口琴工作台/工具链 一组、defaultChecked=false、谁也没包含谁 → canonicalIsRoot=false', () => {
    const r = findMergeGroups([
      { name: '三角洲口琴工作台', count: 2 },
      { name: '三角洲口琴工具链', count: 3 },
    ])
    assert(r.groups.length === 1, '期望 1 组，实际 ' + r.groups.length + ' 组：' + JSON.stringify(r.groups))
    const g = r.groups[0]
    assert(g.confidence === 'prefix', '期望 confidence=prefix，实际 ' + g.confidence)
    assert(g.defaultChecked === false, 'prefix 档必须留给人工确认（defaultChecked=false），实际 ' + g.defaultChecked)
    assert(g.canonicalIsRoot === false, '两者互不包含，canonicalIsRoot 应为 false，实际 ' + g.canonicalIsRoot)
    assert(g.total === 5, '组内总记录数应为 2+3=5，实际 ' + g.total)
  })

  check('C5 tokens：SVG motion studies / Standalone SVG Motion 一组', () => {
    const r = findMergeGroups([
      { name: 'SVG motion studies', count: 2 },
      { name: 'Standalone SVG Motion', count: 1 },
    ])
    assert(r.groups.length === 1, '期望 1 组，实际 ' + r.groups.length + ' 组：' + JSON.stringify(r.groups))
    const g = r.groups[0]
    assert(g.confidence === 'tokens', '期望 confidence=tokens，实际 ' + g.confidence)
    assert(g.defaultChecked === false, 'tokens 档必须留给人工确认，实际 ' + g.defaultChecked)
  })

  check('C6 输出顺序稳定：同输入跑两次 JSON.stringify 完全一致，且按 exact→contains→prefix→tokens 排序', () => {
    const entries = [
      { name: '苹果派', count: 1 },
      { name: '苹果·派', count: 1 },
      { name: '卫龙榴莲辣条', count: 2 },
      { name: '卫龙榴莲辣条营销创意', count: 5 },
      { name: '三角洲口琴工作台', count: 2 },
      { name: '三角洲口琴工具链', count: 1 },
      { name: 'SVG motion studies', count: 2 },
      { name: 'Standalone SVG Motion', count: 1 },
    ]
    const first = JSON.stringify(findMergeGroups(entries))
    const second = JSON.stringify(findMergeGroups(entries))
    assert(first === second, '同样输入两次结果不一致：\n  第一次 ' + first + '\n  第二次 ' + second)
    const conf = findMergeGroups(entries).groups.map((g) => g.confidence)
    assert(JSON.stringify(conf) === JSON.stringify(['exact', 'contains', 'prefix', 'tokens']),
      '期望按 exact,contains,prefix,tokens 排序，实际 ' + JSON.stringify(conf))
  })

  check('C7 scanned/merged 统计正确，四档 defaultChecked 与 MERGE_DEFAULT_CHECKED 一致', () => {
    const entries = [
      { name: '苹果派', count: 1 },
      { name: '苹果·派', count: 1 },
      { name: '卫龙榴莲辣条', count: 2 },
      { name: '卫龙榴莲辣条营销创意', count: 5 },
      { name: '三角洲口琴工作台', count: 2 },
      { name: '三角洲口琴工具链', count: 1 },
      { name: 'SVG motion studies', count: 2 },
      { name: 'Standalone SVG Motion', count: 1 },
    ]
    const r = findMergeGroups(entries)
    assert(r.scanned === 8, '期望扫描 8 个项目名，实际 ' + r.scanned)
    assert(r.merged === 4, '期望可并掉 4 个名字（每组各 1 个），实际 ' + r.merged)
    assert(MERGE_DEFAULT_CHECKED.exact === true && MERGE_DEFAULT_CHECKED.contains === true
      && MERGE_DEFAULT_CHECKED.prefix === false && MERGE_DEFAULT_CHECKED.tokens === false,
      'MERGE_DEFAULT_CHECKED 期望 {exact:true,contains:true,prefix:false,tokens:false}，实际 ' + JSON.stringify(MERGE_DEFAULT_CHECKED))
  })

  check('C8 三种入参形态（数组 / Map / 普通对象）结果一致', () => {
    const arr = findMergeGroups([{ name: '卫龙榴莲辣条', count: 2 }, { name: '卫龙榴莲辣条IP', count: 3 }])
    const map = findMergeGroups(new Map([['卫龙榴莲辣条', 2], ['卫龙榴莲辣条IP', 3]]))
    const obj = findMergeGroups({ 卫龙榴莲辣条: 2, 卫龙榴莲辣条IP: 3 })
    assert(JSON.stringify(arr) === JSON.stringify(map), '数组与 Map 结果不一致：' + JSON.stringify(arr) + ' vs ' + JSON.stringify(map))
    assert(JSON.stringify(arr) === JSON.stringify(obj), '数组与普通对象结果不一致：' + JSON.stringify(arr) + ' vs ' + JSON.stringify(obj))
  })

  // ── C9/C10（Lead 2026-10-02 补）：contains 档的「弱根降级」─────────────────
  // 这两条是 `merge-tests` 的独立验证挑出来的缺口：`contains` 是**默认勾选**的档，
  // 而它当时没有绝对长度下限 —— 于是 `AI` 这种两字根名会把 `AI绘画` / `AI写作`
  // **默认勾选地**合掉。修法是「降级」而不是「隐藏」（藏起来这条就永远没人处理）。
  check('★★ C9 短根名（`AI`）不得默认勾选：weakRoot=true + defaultChecked=false', () => {
    const r = findMergeGroups([
      { name: 'AI', count: 1 },
      { name: 'AI绘画', count: 3 },
      { name: 'AI写作', count: 2 },
    ])
    assert(r.groups.length === 1, '期望成 1 组（要报出来给人看），实际 ' + r.groups.length)
    const g = r.groups[0]
    assert(g.canonical === 'AI', 'canonical 期望 AI，实际 ' + g.canonical)
    assert(g.confidence === 'contains', 'confidence 期望 contains，实际 ' + g.confidence)
    assert(g.weakRoot === true, '★ 两字根名必须标 weakRoot，实际 ' + g.weakRoot)
    assert(g.defaultChecked === false, '★ 短根名绝不能默认勾选，实际 ' + g.defaultChecked)
    assert(/太短/.test(g.reason), 'reason 要如实说明根名太短，实际：' + g.reason)
  })

  check('★ C10 正常长度的根名不受影响（卫龙那组仍然默认勾选）', () => {
    const g = findMergeGroups([
      { name: '卫龙榴莲辣条', count: 4 },
      { name: '卫龙榴莲辣条IP', count: 2 },
    ]).groups[0]
    assert(g.weakRoot === false, '卫龙组不该被标 weakRoot')
    assert(g.defaultChecked === true, '卫龙组应默认勾选')
    assert(g.canonical === '卫龙榴莲辣条', 'canonical 期望根名，实际 ' + g.canonical)
  })

  check('★ C11 minRootLength 可调（调成 2 时两字根名不再降级）', () => {
    const g = findMergeGroups(
      [{ name: 'AI', count: 1 }, { name: 'AI绘画', count: 3 }],
      { minRootLength: 2 },
    ).groups[0]
    assert(g.weakRoot === false, 'minRootLength=2 时不该降级，实际 weakRoot=' + g.weakRoot)
    assert(g.defaultChecked === true, 'minRootLength=2 时应恢复默认勾选')
  })

  // ═══ [D] 回归守卫 ════════════════════════════════════════════════════════
  console.log('\n=== [D] ⚠️ 回归守卫：共享 dsh 前缀但不同的项目不得误合 ===')

  const DSH_NAMES = [
    'dsh-artifact-library', 'dsh-lan-connect', 'dsh-browser', 'dsh-compaction-tuner',
    'dsh-yiqi-memory', 'dsh-shield 插件安全护栏', 'DSH 扩展', 'DSH本地模型接入',
    'DSH-AE接入', 'DSH 内建机制调研', 'DSH 记忆系统调研', 'DSH 自身',
    'DSH 环境维护', '依琪的 DSH 探索', '依琪的工作环境维护',
  ]
  const DSH_COUNTS = [27, 3, 1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 1, 2]
  const dshEntries = DSH_NAMES.map((name, i) => ({ name, count: DSH_COUNTS[i] }))

  check('★★ D1 [独立断言] 15 个共享 dsh 前缀的项目必须一组都不成（groups.length === 0）', () => {
    const r = findMergeGroups(dshEntries)
    assert(r.groups.length === 0,
      '期望 0 组（绝对前缀下限 minSharedPrefix=4 挡住 dsh），实际 ' + r.groups.length + ' 组：'
      + JSON.stringify(r.groups.map((g) => ({ confidence: g.confidence, canonical: g.canonical, names: g.names.map((n) => n.name) }))))
    assert(r.scanned === 15, '期望扫描到 15 个名字，实际 ' + r.scanned)
  })

  check('★ D2 这道绝对下限是承重的：只把 minSharedPrefix 从 4 调到 3，误合立刻出现', () => {
    const r = findMergeGroups(dshEntries, { minSharedPrefix: 3 })
    assert(r.groups.length > 0,
      '期望调小 minSharedPrefix 后出现误合（证明 D1 守的是那道下限），实际仍然 0 组')
  })

  check('D3 佐证阈值来历：只剩「占短名 ≥60%」一道闸门时，15 个名字里 13 个被链成一坨', () => {
    const r = findMergeGroups(dshEntries, { minSharedPrefix: 0, prefixSpanRatio: 0 })
    assert(r.groups.length === 1, '期望恰好 1 个连通分量，实际 ' + r.groups.length)
    const names = r.groups[0].names.map((n) => n.name)
    assert(names.length === 13,
      '期望 13 个不同项目被误连成一坨，实际 ' + names.length + ' 个：' + JSON.stringify(names))
    assert(r.merged === 12, '期望 merged=12（13 个名字并成 1 个），实际 ' + r.merged)
  })

  // ═══ [E] store 执行 / 撤销 ═══════════════════════════════════════════════
  console.log('\n=== [E] store.mergeProjects / undoProjectMerge ===')

  const E_DIR = mkTmp('alf-pm-store-')
  const store = new ArtifactStore(E_DIR).load()
  const mkRec = (file, project, tags = []) =>
    store.register({ path: path.join(E_DIR, file), title: file, project, tags })
  const recA = mkRec('a.txt', '卫龙榴莲辣条营销创意', ['x'])
  const recB = mkRec('b.txt', '卫龙榴莲辣条')
  const recC = mkRec('c.txt', '卫龙榴莲辣条营销创意')
  const recT = mkRec('t.txt', '卫龙榴莲辣条IP')
  store.trash(recT.id)

  check('E1 合并前：projectMergeUndo 为 null；projectsScanned 只数**非回收**项目名', () => {
    const s = store.suggestCleanup()
    assert(s.projectMergeUndo === null, '期望合并前 undo=null，实际 ' + JSON.stringify(s.projectMergeUndo))
    assert(s.projectsScanned === 2, '期望 2 个（回收站记录的 卫龙榴莲辣条IP 不算），实际 ' + s.projectsScanned)
    assert(Array.isArray(s.projectMerges) && s.projectMerges.length === 1,
      '期望 1 组候选，实际 ' + JSON.stringify(s.projectMerges))
  })

  check('E2 合并：命中记录的 project 改成规范名，且原名追加进 tags', () => {
    const r = store.mergeProjects({ names: ['卫龙榴莲辣条营销创意'], to: '卫龙榴莲辣条' })
    assert(r.ok === true, '期望 ok=true，实际 ' + JSON.stringify(r))
    assert(r.changed === 2, '期望改 2 条，实际 ' + r.changed)
    assert(r.tagsAdded === 2, '期望加 2 个 tag，实际 ' + r.tagsAdded)
    assert(recA.project === '卫龙榴莲辣条', 'A.project 期望 卫龙榴莲辣条，实际 ' + recA.project)
    assert(recA.tags.includes('卫龙榴莲辣条营销创意'), 'A.tags 期望含原名，实际 ' + JSON.stringify(recA.tags))
    assert(recC.project === '卫龙榴莲辣条', 'C.project 期望 卫龙榴莲辣条，实际 ' + recC.project)
    assert(recC.tags.includes('卫龙榴莲辣条营销创意'), 'C.tags 期望含原名，实际 ' + JSON.stringify(recC.tags))
  })

  check('E3 未命中记录不动；回收站里的记录不参与合并', () => {
    assert(recB.project === '卫龙榴莲辣条' && recB.tags.length === 0,
      'B 未命中不应被改，实际 project=' + recB.project + ' tags=' + JSON.stringify(recB.tags))
    assert(recT.project === '卫龙榴莲辣条IP', '回收站记录 project 不应被改，实际 ' + recT.project)
    assert(recT.tags.length === 0, '回收站记录 tags 不应被改，实际 ' + JSON.stringify(recT.tags))
  })

  check('E4 合并后：projectMergeUndo 非 null，to/count/from/at 都对得上', () => {
    const s = store.suggestCleanup()
    const u = s.projectMergeUndo
    assert(u !== null, '合并后 undo 不应为 null')
    assert(u.to === '卫龙榴莲辣条', 'undo.to 期望 卫龙榴莲辣条，实际 ' + u.to)
    assert(u.count === 2, 'undo.count 期望 2，实际 ' + u.count)
    assert(Array.isArray(u.from) && u.from.includes('卫龙榴莲辣条营销创意'),
      'undo.from 期望含 卫龙榴莲辣条营销创意，实际 ' + JSON.stringify(u.from))
    assert(typeof u.at === 'number' && u.at > 0, 'undo.at 应是时间戳，实际 ' + JSON.stringify(u.at))
    assert(s.projectsScanned === 1, '合并后只剩 1 个非回收项目名，实际 ' + s.projectsScanned)
  })

  check('E5 ★ 撤销：project 与 tags 整份还原，restored 数量正确', () => {
    const u = store.undoProjectMerge()
    assert(u.ok === true, '期望 ok=true，实际 ' + JSON.stringify(u))
    assert(u.restored === 2, '期望还原 2 条，实际 ' + u.restored)
    assert(recA.project === '卫龙榴莲辣条营销创意', 'A.project 应还原，实际 ' + recA.project)
    assert(JSON.stringify(recA.tags) === JSON.stringify(['x']),
      'A.tags 应整份还原为 ["x"]，实际 ' + JSON.stringify(recA.tags))
    assert(recC.project === '卫龙榴莲辣条营销创意', 'C.project 应还原，实际 ' + recC.project)
    assert(JSON.stringify(recC.tags) === JSON.stringify([]),
      'C.tags 应整份还原为 []，实际 ' + JSON.stringify(recC.tags))
  })

  check('E6 撤销后 undo 字段回到 null；再撤一次必须 ok=false', () => {
    const s = store.suggestCleanup()
    assert(s.projectMergeUndo === null, '撤销后 undo 应回到 null，实际 ' + JSON.stringify(s.projectMergeUndo))
    const again = store.undoProjectMerge()
    assert(again.ok === false, '连撤两次，第二次应 ok=false，实际 ' + JSON.stringify(again))
    assert(typeof again.error === 'string' && again.error.length > 0, '被拒时应给出可读 error，实际 ' + JSON.stringify(again.error))
  })

  check('E7 keepVariantAsTag:false → 改 project 但不加 tag', () => {
    const r = store.mergeProjects({ names: ['卫龙榴莲辣条营销创意'], to: '卫龙榴莲辣条', keepVariantAsTag: false })
    assert(r.ok === true, '期望 ok=true，实际 ' + JSON.stringify(r))
    assert(r.tagsAdded === 0, '期望 tagsAdded=0，实际 ' + r.tagsAdded)
    assert(recA.project === '卫龙榴莲辣条', 'project 仍应被改，实际 ' + recA.project)
    assert(JSON.stringify(recA.tags) === JSON.stringify(['x']),
      'tags 不应变，实际 ' + JSON.stringify(recA.tags))
    const back = store.undoProjectMerge()
    assert(back.ok === true, '善后撤销应成功，实际 ' + JSON.stringify(back))
  })

  check('E8 边界：names 一个都没命中 → ok=false + 可读 error', () => {
    const r = store.mergeProjects({ names: ['这个项目名不存在'], to: '卫龙榴莲辣条' })
    assert(r.ok === false, '期望 ok=false，实际 ' + JSON.stringify(r))
    assert(typeof r.error === 'string' && r.error.length > 0, '期望可读 error，实际 ' + JSON.stringify(r.error))
  })

  check('E9 边界：to 与 names 相同（没有可改的记录）→ ok=false', () => {
    const r = store.mergeProjects({ names: ['卫龙榴莲辣条'], to: '卫龙榴莲辣条' })
    assert(r.ok === false, '期望 ok=false，实际 ' + JSON.stringify(r))
    assert(typeof r.error === 'string' && r.error.length > 0, '期望可读 error，实际 ' + JSON.stringify(r.error))
  })

  check('E10 边界：缺 to / 缺 names → ok=false', () => {
    const noTo = store.mergeProjects({ names: ['卫龙榴莲辣条'] })
    assert(noTo.ok === false, '缺 to 应 ok=false，实际 ' + JSON.stringify(noTo))
    const noNames = store.mergeProjects({ names: [], to: '卫龙榴莲辣条' })
    assert(noNames.ok === false, '缺 names 应 ok=false，实际 ' + JSON.stringify(noNames))
  })

  check('E11 ★ 撤销凭据落盘：重启 store 后最近一次合并仍可撤销', () => {
    const r = store.mergeProjects({ names: ['卫龙榴莲辣条营销创意'], to: '卫龙榴莲辣条' })
    assert(r.ok === true, '合并应成功，实际 ' + JSON.stringify(r))
    const store2 = new ArtifactStore(E_DIR).load()
    assert(store2.meta.lastProjectMerge && store2.meta.lastProjectMerge.to === '卫龙榴莲辣条',
      '重启后 meta.lastProjectMerge 应仍在，实际 ' + JSON.stringify(store2.meta.lastProjectMerge))
    const u = store2.undoProjectMerge()
    assert(u.ok === true && u.restored === 2, '重启后撤销应成功且还原 2 条，实际 ' + JSON.stringify(u))
    const rec = store2.get(recA.id)
    assert(rec.project === '卫龙榴莲辣条营销创意' && JSON.stringify(rec.tags) === JSON.stringify(['x']),
      '重启撤销后 A 应完全还原，实际 project=' + rec.project + ' tags=' + JSON.stringify(rec.tags))
  })

  check('E12 原名已经在 tags 里时不重复追加（tagsAdded 也不虚报）', () => {
    const dir2 = mkTmp('alf-pm-store2-')
    const s2 = new ArtifactStore(dir2).load()
    const rec = s2.register({ path: path.join(dir2, 'd.txt'), title: 'd', project: '旧项目名', tags: ['旧项目名'] })
    const r = s2.mergeProjects({ names: ['旧项目名'], to: '新项目名' })
    assert(r.ok === true, '合并应成功，实际 ' + JSON.stringify(r))
    assert(JSON.stringify(rec.tags) === JSON.stringify(['旧项目名']),
      'tags 不应出现重复项，实际 ' + JSON.stringify(rec.tags))
    assert(r.tagsAdded === 0, '期望 tagsAdded=0（没新增 tag），实际 ' + r.tagsAdded)
  })

  // ═══ [F] HTTP 端点 ══════════════════════════════════════════════════════
  console.log('\n=== [F] HTTP 端点（假 req/res + 真 handler）===')

  const F_DIR = mkTmp('alf-pm-http-')
  const fstore = new ArtifactStore(F_DIR).load()
  fstore.register({ path: path.join(F_DIR, 'a.txt'), title: 'A', project: '卫龙榴莲辣条营销创意' })
  fstore.register({ path: path.join(F_DIR, 'b.txt'), title: 'B', project: '卫龙榴莲辣条' })

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
  function reqOf(method, url, body) {
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const req = Readable.from(chunks)
    req.method = method
    req.url = url
    req.headers = {}
    req.socket = { remoteAddress: '127.0.0.1' }
    return req
  }
  async function callHandler(method, url, body) {
    const handler = artifactsHandler(fstore, { fileIndex: {} })
    const res = makeRes()
    await handler(reqOf(method, url, body), res)
    return res
  }

  await checkAsync('F1 GET /suggest-cleanup → 200，且带 projectMerges / projectsScanned / projectMergeUndo', async () => {
    const r = await callHandler('GET', '/ext/artifacts/suggest-cleanup')
    assert(r.statusCode === 200, '状态码期望 200，实际 ' + r.statusCode + ' body=' + r.bodyText())
    const b = r.json()
    assert(Array.isArray(b.projectMerges), 'projectMerges 应为数组，实际 ' + JSON.stringify(b.projectMerges))
    assert(typeof b.projectsScanned === 'number', 'projectsScanned 应为数字，实际 ' + JSON.stringify(b.projectsScanned))
    assert(b.projectMergeUndo === null, '尚未合并时 projectMergeUndo 应为 null，实际 ' + JSON.stringify(b.projectMergeUndo))
  })

  await checkAsync('F2 POST /projects/merge 成功 → 200 + ok:true + 命中数', async () => {
    const r = await callHandler('POST', '/ext/artifacts/projects/merge', { names: ['卫龙榴莲辣条营销创意'], to: '卫龙榴莲辣条' })
    assert(r.statusCode === 200, '状态码期望 200，实际 ' + r.statusCode + ' body=' + r.bodyText())
    const b = r.json()
    assert(b.ok === true, '期望 ok=true，实际 ' + r.bodyText())
    assert(b.changed === 1, '期望 changed=1，实际 ' + JSON.stringify(b.changed))
    assert(Array.isArray(b.from) && b.from.includes('卫龙榴莲辣条营销创意'), 'from 应含原名，实际 ' + JSON.stringify(b.from))
  })

  await checkAsync('F3 POST /projects/merge 被拒（没命中）→ 400 + ok:false + reason:"merge-rejected"', async () => {
    const r = await callHandler('POST', '/ext/artifacts/projects/merge', { names: ['没有这个项目'], to: '卫龙榴莲辣条' })
    assert(r.statusCode === 400, '状态码期望 400，实际 ' + r.statusCode + ' body=' + r.bodyText())
    const b = r.json()
    assert(b.ok === false, '期望 ok=false，实际 ' + r.bodyText())
    assert(b.reason === 'merge-rejected', '期望 reason=merge-rejected，实际 ' + JSON.stringify(b.reason))
    assert(typeof b.error === 'string' && b.error.length > 0, '期望可读 error，实际 ' + JSON.stringify(b.error))
  })

  await checkAsync('F4 POST /projects/merge-undo 成功 → 200 + restored', async () => {
    const r = await callHandler('POST', '/ext/artifacts/projects/merge-undo')
    assert(r.statusCode === 200, '状态码期望 200，实际 ' + r.statusCode + ' body=' + r.bodyText())
    const b = r.json()
    assert(b.ok === true, '期望 ok=true，实际 ' + r.bodyText())
    assert(b.restored === 1, '期望 restored=1，实际 ' + JSON.stringify(b.restored))
  })

  await checkAsync('F5 无可撤销时 POST /projects/merge-undo → 400 + reason:"nothing-to-undo"', async () => {
    const r = await callHandler('POST', '/ext/artifacts/projects/merge-undo')
    assert(r.statusCode === 400, '状态码期望 400，实际 ' + r.statusCode + ' body=' + r.bodyText())
    const b = r.json()
    assert(b.ok === false, '期望 ok=false，实际 ' + r.bodyText())
    assert(b.reason === 'nothing-to-undo', '期望 reason=nothing-to-undo，实际 ' + JSON.stringify(b.reason))
  })

  // ═══ [G] 历史记录缺字段的回填（Lead 2026-10-02 补）══════════════════════
  // 这条也是 `merge-tests` 的独立验证挑出来的：`load()` 回填了 kind/source/is_dir/
  // refineRequested，**唯独漏了 `trashed_at`**。而全库到处用 `r.trashed_at === null`
  // 判「是不是活的」—— 缺字段得到 `undefined`，`undefined !== null` 为真，
  // 于是那批记录被当成「在回收站里」：list() 一条不显示、整理建议看不见、
  // **连项目合并都够不着它们**（mergeProjects 里判 `trashed_at !== null` 直接跳过）。
  //
  // 修复前实测：手搓一份不含该字段的 artifacts.json → `list()` 可见 0 条。
  console.log('\n=== [G] 历史记录缺 trashed_at / tags 的回填 ===')
  {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-pm-legacy-'))
    TMP_DIRS.push(legacyDir)

    check('★★ G1 缺 trashed_at 的记录不再「隐身」（修复前 list() 可见 0 条）', () => {
      // 手搓一份**老格式**数据：没有 trashed_at、没有 tags、没有 references
      fs.writeFileSync(path.join(legacyDir, 'artifacts.json'), JSON.stringify([
        { id: 'old_1', title: '老记录一', path: path.join(legacyDir, 'a.txt'), project: '卫龙榴莲辣条', summary: 's', created_at: 1 },
        { id: 'old_2', title: '老记录二', path: path.join(legacyDir, 'b.txt'), project: '卫龙榴莲辣条IP', summary: 's', created_at: 2 },
      ]), 'utf8')

      const store = new ArtifactStore(legacyDir).load()
      const listed = store.list({})
      const count = Array.isArray(listed) ? listed.length : (listed && listed.items ? listed.items.length : 0)
      assert(count === 2, '★ list() 应看见 2 条，实际 ' + count + '（说明 trashed_at 缺字段被当成「已回收」）')
      for (const r of store.items) {
        assert(r.trashed_at === null, r.id + ' 的 trashed_at 应回填为 null，实际 ' + JSON.stringify(r.trashed_at))
        assert(Array.isArray(r.tags), r.id + ' 的 tags 应回填为 []，实际 ' + JSON.stringify(r.tags))
      }
    })

    check('★ G2 回填后 stats() 不炸、整理建议与合并都够得着老记录', () => {
      const store = new ArtifactStore(legacyDir).load()
      const st = store.stats()
      assert(st.activeCount === 2, 'activeCount 期望 2，实际 ' + st.activeCount)
      const s = store.suggestCleanup()
      assert(s.projectsScanned === 2, '★ projectsScanned 期望 2（修复前是 0 —— 合并完全够不着），实际 ' + s.projectsScanned)
      assert(s.projectMerges.length === 1, '期望 1 组合并候选，实际 ' + s.projectMerges.length)
      const r = store.mergeProjects({ names: ['卫龙榴莲辣条IP'], to: '卫龙榴莲辣条' })
      assert(r.ok === true && r.changed === 1, '★ 老记录应能被合并，实际 ' + JSON.stringify(r))
    })

    check('★ G3 回填是持久的（再 load 一次字段仍在，不会反复回填）', () => {
      const store = new ArtifactStore(legacyDir).load()
      for (const r of store.items) {
        assert(r.trashed_at === null || typeof r.trashed_at === 'number', 'trashed_at 又丢了：' + JSON.stringify(r.trashed_at))
      }
    })
  }
} finally {
  // ── 清理：本文件不许污染任何共享状态 ──────────────────────────────────
  for (const dir of TMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
