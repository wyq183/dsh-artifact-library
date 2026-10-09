#!/usr/bin/env node
/**
 * 检查「过期陈述」—— 治 `ARCHITECTURE.md` §8.3 第 20 条那类失效
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 【为什么需要它】
 * §8.3 第 20 条原话：
 *   > **任何「当前状态」类主张（测试条数、git 跟踪状态、端口、文件是否存在、
 *   > 进程是否在跑），必须在报告时刻重新取，不引用任何一次更早的观察。**
 *   而且 —— **这类错误跑测试永远绿，根本发现不了它。**
 *
 * 实证（本仓库）：四份文档写着四个不同的测试文件数（20 / 16 / 16 / 14），
 * 实测 **30**。三个都是过期的，但**没有任何东西会因此变红**。
 *
 * 【它做什么】
 * 扫文档里**带时间词的当前状态主张**，把能自动核的**当场核掉**：
 *   · 「N 个测试文件」 → 数 `test/*.test.mjs` 的真实个数
 *   · 「N 条断言」     → 只能提示（需要跑，见下）
 *   · 「当前 / 已 / 未 / 仍然 / 尚未」+ 数字 → 列出来给人看
 *
 * ⚠️ **它不能自动判断语义** —— 它只做两件事：
 *   ① **能数的一律当场数**（数字类主张，确定性）；
 *   ② **不能数的列成清单**，逼人看一眼。
 * ⇒ 这是**启发式**，不是证明。**"它绿了"不等于"文档都准"。**
 *
 * 用法：
 *   node tools/doc-stale.mjs            # 检查，有问题退出 1
 *   node tools/doc-stale.mjs --list     # 只列时间词句子，不判错
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIST_ONLY = process.argv.includes('--list')

// ── ① 能被"数一遍"的事实（**这是本工具最值钱的部分**）──────────────────
//
// ⚠️⚠️ **我第一版写宽了，当场自曝 —— 记在这里当反例**：
//   原来第二条 pattern 是 `/(\d+)\s*个\s*文件(?:全绿|全过)?/g` ——
//   那个 `?` 让"全绿/全过"变成**可选**，于是它匹配到了
//   `docs/RISK-ANALYSIS.md` 的「**已每 200 个文件让出**」（那是**遍历文件的批大小**，
//   跟测试文件毫无关系）⇒ **两条假警报**。
//
//   ⭐ 这**一字不差**就是本仓库 `03-assertions.md` §二 说的
//   「**关键词级判据的两个固有盲区**」：
//     · 它分不清**语境**（"文件"是不是"测试文件"）；
//     · 别处的残留能满足它。
//   ⇒ 修法也照规范来：**判据要跟着语义走，不跟着关键词走** ——
//     数字必须**紧贴"测试"语境**，或者同句里出现"全绿/全过"这种**只对测试成立**的词。
const FACTS = [
  {
    id: 'test-file-count',
    describe: '测试文件个数',
    actual: () => fs.readdirSync(path.join(REPO, 'test')).filter((f) => f.endsWith('.test.mjs')).length,
    patterns: [
      // ① 必须写明"测试文件"（最可靠）
      /(\d+)\s*个\s*测试文件/g,
      // ② "N 个文件" + 同句出现**只对测试成立**的词（全绿/全过/断言/条）
      //    ⚠️ 不能用可选组 —— 那会让裸"N 个文件"也命中（见上面的自曝）
      /(\d+)\s*个\s*文件(?=[^。\n]{0,20}(?:全绿|全过|断言))/g,
    ],
  },
]

// ── ② 历史叙述的标记（这些句子**不该报** —— 它在讲过去）────────────────
// ⚠️ 这也来自实证：`ARCHITECTURE.md:246` 写「2026-09-30 就踩过：口头说 189 条全绿，
//    实际 `test/` 下有 10 个文件」—— 那**是历史叙述**，10 是对的（当时确实 10 个）。
//    第一版报了它 ⇒ 假警报。
const HISTORICAL = /(当时|原本|曾经|一度|此前|过去|生成时|那天|当晚|就踩过|改造前|之前是)/

// ── ② 扫描范围（**只看已提交的文档**，scratch 不算）────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('_night-backup')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'scratch' && e.name !== 'vendor') walk(p, out) }
    else if (/\.(md|mjs|js|json)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = walk(REPO).filter((f) => {
  // ⚠️ **跳过本工具自己**（第三处自曝）：
  //   本文件里**引用了那句坏话当反例**（见上面 FACTS 的注释），
  //   于是它扫到自己、把自己引用的例子报成了问题 ——
  //   ⭐ 这**又是**「**注释里提到不算数**」那一族（§8.3 第 8 条），
  //     一天之内本仓库栽了**第三次**（前两次：`verify-hostctx` 的自检、
  //     `scope-guard` 的自检）。
  //   ⇒ 检查器**不该检查自己**（它会把自己的例子当事实）。
  //     真要查它自己，用 `--list` 人工看。
  return path.resolve(f) !== path.resolve(fileURLToPath(import.meta.url))
})
const TIME_WORDS = /(当前|目前|现在|已经|已|尚未|仍未|仍然|依旧是|不再|还没)/

let problems = []
let listed = 0

for (const f of files) {
  const rel = path.relative(REPO, f).replace(/\\/g, '/')
  let text
  try { text = fs.readFileSync(f, 'utf8') } catch { continue }
  const lines = text.split('\n')

  lines.forEach((line, i) => {
    // ⚠️ **按句切，不按行判**（第二处自曝）：
    //   第一版是**整行**做历史词白名单，于是
    //   `ACCEPTANCE-DIVISION.md:4` 那行 —— 它**前半句说「当前 16 个测试文件」**（**确实过期**，
    //   实测 30），后半句说「生成时是 12 文件」 —— **整行被"生成时"豁免掉了** ⇒ **假阴性**。
    //   ⇒ 改成按标点切成小段，**每段自己判**是不是历史叙述。
    const segments = line.split(/(?<=[；;。，,、)）])\s*/).filter(Boolean)

    for (const seg of segments) {
      // ① 数字类主张 —— 能核就核
      for (const fact of FACTS) {
        for (const re of fact.patterns) {
          re.lastIndex = 0
          let m
          while ((m = re.exec(seg)) !== null) {
            const claimed = Number(m[1])
            const actual = fact.actual()
            // ⚠️ 只报「明显是当前状态」的：数字旁边有时间词，或句子里有"全绿/全过/共"
            const looksCurrent = TIME_WORDS.test(seg) || /全绿|全过|共|合计/.test(seg)
            if (!looksCurrent) continue
            // 白名单：历史叙述（"当时 20 个"）不该报 —— **按段判，不按行判**
            if (HISTORICAL.test(seg)) continue
            if (claimed !== actual) {
              problems.push({
                file: rel, line: i + 1,
                msg: `说「${claimed} 个${fact.describe}」，实测 **${actual}**`,
                text: seg.trim().slice(0, 120),
              })
            }
          }
        }
      }
    }

    // ② 时间词句子 —— 列出来给人看
    if (TIME_WORDS.test(line) && /\d/.test(line) && line.trim().length > 12) {
      listed += 1
      if (LIST_ONLY) {
        console.log(`${rel}:${i + 1}  ${line.trim().slice(0, 130)}`)
      }
    }
  })
}

// ── ③ 报告 ────────────────────────────────────────────────────────────────
if (LIST_ONLY) {
  console.log(`\n共列出 ${listed} 句带时间词的当前状态主张（**需要人看，工具判断不了语义**）`)
  process.exit(0)
}

console.log('═══ 过期陈述检查（doc-stale）═══')
console.log(' 扫描：' + files.length + ' 个文件')
console.log('')

if (problems.length === 0) {
  console.log(' ✅ 能自动核的「当前状态」主张都对得上。')
  console.log('')
  console.log(' ⚠️ 这只说明**数字类**主张没错。**语义类的过期陈述它看不见** ——')
  console.log('    §8.3 第 20 条的四类失效里，本工具只覆盖「能数的那一类」。')
  console.log('    ⇒ 想全查，用 `node tools/doc-stale.mjs --list` 把带时间词的句子列出来自己看。')
  process.exit(0)
}

console.log(' 🔴 发现 ' + problems.length + ' 处「当前状态」主张与实测不符：\n')
for (const p of problems) {
  console.log('   ' + p.file + ':' + p.line)
  console.log('     ' + p.msg)
  console.log('     原文：' + p.text)
  console.log('')
}
console.log(' ⇒ 修掉，或者把句子改成历史叙述（"当时是 N 个"）。')
console.log(' ⚠️ 依据：`ARCHITECTURE.md` §8.3 第 20 条 —— 「任何当前状态类主张，')
console.log('    必须在报告时刻重新取」。**这类错误跑测试永远绿。**')
process.exit(1)
