/**
 * 命名一致性（2026-10-22 · 主人提醒）
 * ══════════════════════════════════════════════════════════════════════════
 * 【主人原话】
 *   「记得项目名字变了？那ui上的名字也该一起改了」
 *
 * ══ 背景 ══
 *   插件名换过两次：
 *     产物库 → 资料库 → **知识库**
 *   但每次只改了一部分：
 *     · 改「资料库→知识库」时只改了 `ui/index.html` 的 title 和 h1，
 *       **侧栏 `lib/client.js` 还写着「产物库」**
 *     · 结果：同一个插件，管理页叫「知识库」、侧栏叫「产物库」
 *
 * ══ 这条测试守什么 ══
 *   **用户/模型能看到的地方，名字必须统一。**
 *
 * ⚠️ 但有个例外必须保护：
 *   `lib/settings.js` 里的 `{ id: 'mt_library', tag: '产物库' }` 是**数据** ——
 *   31 条记录打了这个标签，改字符串会让标签对不上（数据关联断裂）。
 *   ⇒ 测试**专门断言它还在**，防止后人"顺手统一"把数据改坏。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../', import.meta.url))

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) {
    failed += 1
    const msg = error && error.message ? error.message : String(error)
    failures.push({ name, msg })
    console.log('  FAIL ' + name + ' -> ' + msg)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

console.log('\n═══ 命名一致性 ═══')

/** 判断一行是不是注释（注释里写旧名字不影响用户） */
function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')
}

/** 找出一个文件里**可见字符串**中的旧名字 */
function visibleHits(file, word) {
  const p = path.join(REPO, file)
  if (!fs.existsSync(p)) return []
  const out = []
  fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
    if (l.indexOf(word) < 0) return
    if (isCommentLine(l)) return
    out.push({ line: i + 1, text: l.trim() })
  })
  return out
}

check('A1 ★★★ 用户可见文案里不该再有「产物库」（已改名知识库）', () => {
  // ⚠️ 排除 settings.js（那是数据，见 A3）
  const files = [
    'lib/client.js', 'lib/tools.js', 'lib/http.js', 'lib/index.js',
    'lib/index/tool.js', 'lib/refine-session.js', 'ui/index.html', 'README.md',
  ]
  const bad = []
  for (const f of files) {
    for (const h of visibleHits(f, '产物库')) bad.push(f + ':' + h.line + '  ' + h.text.slice(0, 70))
  }
  assert(bad.length === 0, '★ 还有 ' + bad.length + ' 处可见的「产物库」：\n     ' + bad.join('\n     '))
})

check('A2 ★★★ 用户可见文案里不该再有「资料库」（更早的名字）', () => {
  const files = ['lib/client.js', 'ui/index.html', 'README.md', 'lib/index.js']
  const bad = []
  for (const f of files) {
    for (const h of visibleHits(f, '资料库')) bad.push(f + ':' + h.line)
  }
  assert(bad.length === 0, '★ 还有「资料库」：' + bad.join(', '))
})

check('A3 ★★★ 受管标签「产物库」必须保留（那是数据，不是名字）', () => {
  // ⚠️ 31 条记录打了这个标签。改字符串 = 标签对不上 = 数据关联断裂。
  //    这条是**反向护栏**：防止后人"顺手统一命名"把数据改坏。
  const st = fs.readFileSync(path.join(REPO, 'lib', 'settings.js'), 'utf8')
  assert(/tag: '产物库'/.test(st),
    '★ 受管标签「产物库」被改了 —— 那是数据（31 条记录在用），不是插件名')
})

check('A4 ★★★ 插件 id 不许动（改要动注册/数据目录/GitHub 仓库）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  assert(pkg.name === '@dsh-external/dsh-artifact-library',
    '★ 插件 id 变了（' + pkg.name + '）—— 会让已安装的数据目录对不上')
})

check('A5 ★★ 侧栏与管理页的名字必须一致', () => {
  // ⚠️ 这就是主人发现的问题：管理页叫「知识库」、侧栏叫「产物库」
  const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')
  const client = fs.readFileSync(path.join(REPO, 'lib', 'client.js'), 'utf8')

  // 管理页标题
  const titleM = /<h1>[^<]*知识库/.exec(html)
  assert(titleM, '★ 管理页 h1 不是「知识库」')

  // 侧栏里出现「知识库」字样
  const clientHasKb = client.indexOf('知识库') >= 0
  assert(clientHasKb, '★ 侧栏（lib/client.js）里完全没有「知识库」—— 名字没同步')
})

check('A6 ★★ package.json 描述要与实际功能相符', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  const desc = pkg.description || ''
  assert(desc.indexOf('知识库') >= 0, '★ 描述里没有「知识库」')
  assert(desc.indexOf('产物库') < 0, '★ 描述里还有「产物库」')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
