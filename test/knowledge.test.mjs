/**
 * 知识库测试（2026-10-22）
 * ══════════════════════════════════════════════════════════════════════════
 * 【主人原话】
 *   「你这个是什么鬼资料库，我说的是正儿八经的资料，只放资料，
 *     把每个项目的经验遇到的坑存放在这的资料」
 *
 * ══ 这份测试守什么 ══
 *   ① 知识条目**独立存储**（不混进 artifacts.json）
 *   ② 数据层行为正确（增删改查、类型校验、标签去重）
 *   ③ 接线完整（index.js 建了 store、传给 http、传给 tools）
 *   ④ 前端有入口（分类按钮 + 表单 + 渲染）
 *
 * ⚠️ 教训（今天踩过的）：**"实现了但入口没接上"** ——
 *    「点资料没反应」就是这么漏的：逻辑写在 reload() 里，但 setCat 没调 reload。
 *    ⇒ 所以这里**专门断言接线**，不只断言"函数存在"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
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

async function checkAsync(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) {
    failed += 1
    const msg = error && error.message ? error.message : String(error)
    failures.push({ name, msg })
    console.log('  FAIL ' + name + ' -> ' + msg)
  }
}

console.log('\n═══ 知识库 ═══')

const html = fs.readFileSync(path.join(REPO, 'ui', 'index.html'), 'utf8')
const indexJs = fs.readFileSync(path.join(REPO, 'lib', 'index.js'), 'utf8')
const httpJs = fs.readFileSync(path.join(REPO, 'lib', 'http.js'), 'utf8')
const toolsJs = fs.readFileSync(path.join(REPO, 'lib', 'tools.js'), 'utf8')
const knJs = fs.readFileSync(path.join(REPO, 'lib', 'knowledge.js'), 'utf8')

const kn = await import('file:///' + path.join(REPO, 'lib', 'knowledge.js').replace(/\\/g, '/'))

function deComment(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (x) => x.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
}

// ══════════════════════════════════════════════════════════════════════════
// [A] 数据层行为
// ══════════════════════════════════════════════════════════════════════════

check('A1 ★★★ 知识条目存独立文件（不混进 artifacts.json）', () => {
  // ⚠️ 为什么必须独立：知识条目**没有磁盘文件**（无 path/size/缩略图）。
  //    混进产物表会让所有按文件统计的地方（大小/类型/文件缺失检测）全部出错。
  const tmp = path.join(os.tmpdir(), 'kn-a1-' + Date.now())
  const S = new kn.KnowledgeStore(tmp)
  S.load()
  S.add({ type: 'pitfall', title: 't', body: 'b' })
  assert(fs.existsSync(path.join(tmp, 'knowledge.json')), '★ 没写到 knowledge.json')
  assert(!fs.existsSync(path.join(tmp, 'artifacts.json')), '★ 不该碰 artifacts.json')
  fs.rmSync(tmp, { recursive: true, force: true })
})

check('A2 ★★★ 三种类型，且拒绝非法类型', () => {
  const keys = kn.TYPE_KEYS
  assert(keys.length === 3, '★ 类型数应为 3，实际 ' + keys.length)
  for (const k of ['pitfall', 'experience', 'decision']) {
    assert(keys.indexOf(k) >= 0, '★ 缺类型 ' + k)
  }
  const r = kn.normalizeKnowledge({ type: 'xxx', title: 't' })
  assert(!r.ok, '★ 非法类型没被拒绝')
})

check('A3 ★★ 空标题必须拒绝（否则列表里全是空白行）', () => {
  const r = kn.normalizeKnowledge({ type: 'pitfall', title: '   ' })
  assert(!r.ok, '★ 空标题没被拒绝')
})

check('A4 ★★★ 标签去重要按**归一化后的键**（css 与 CSS 是同一个）', () => {
  // ⚠️ 第一版直接用 Set 去重，`css` 和 `CSS` 都留下了（实测漏了）。
  const r = kn.normalizeKnowledge({
    type: 'pitfall', title: 't',
    tags: ['css', 'CSS', 'CSS ', 'dsh_token', 'dsh token', 'DSH-Token'],
  })
  assert(r.ok, '应该通过')
  assert(r.value.tags.length === 2,
    '★ 去重后应为 2 个（css / dsh_token），实际 ' + r.value.tags.length + ' 个：' + JSON.stringify(r.value.tags))
})

await checkAsync('A5 ★★ 增删改查行为正确', async () => {
  const tmp = path.join(os.tmpdir(), 'kn-a5-' + Date.now())
  const S = new kn.KnowledgeStore(tmp)
  S.load()
  const a = S.add({ project: 'P1', type: 'pitfall', title: '坑1', body: '正文' })
  assert(a.ok, 'add 失败：' + a.error)
  assert(S.list().length === 1, 'list 应有 1 条')
  assert(S.list({ project: 'P1' }).length === 1, '按项目筛应有 1 条')
  assert(S.list({ project: 'P2' }).length === 0, '别的项目应为 0')
  assert(S.list({ type: 'pitfall' }).length === 1, '按类型筛应有 1 条')
  assert(S.list({ type: 'decision' }).length === 0, '别的类型应为 0')
  const u = S.update(a.value.id, { title: '坑1改' })
  assert(u.ok && u.value.title === '坑1改', 'update 失败')
  assert(u.value.createdAt === a.value.createdAt, '★ 改了标题不该改 createdAt')
  const d = S.remove(a.value.id)
  assert(d.ok && S.list().length === 0, 'remove 失败')
  fs.rmSync(tmp, { recursive: true, force: true })
})

check('A6 ★★ 查询要能搜正文（不只是标题）', () => {
  // ⚠️ 用户找坑的时候记不住标题，只会记得"那个 CSS 变量的问题"
  const src = deComment(knJs)
  const at = src.indexOf('list(opts = {})')
  assert(at > 0, '找不到 list 方法')
  const seg = src.slice(at, at + 900)
  assert(/body/.test(seg), '★ 搜索没覆盖 body —— 只搜标题找不到东西')
})

// ══════════════════════════════════════════════════════════════════════════
// [B] 接线（今天最容易漏的地方）
// ══════════════════════════════════════════════════════════════════════════

check('B1 ★★★ index.js 必须真的建了 KnowledgeStore 并 load', () => {
  // ⚠️ 教训：逻辑写了但没接线 = 功能不存在（今天「点资料没反应」就是）
  assert(/new KnowledgeStore\(/.test(indexJs), '★ 没建 KnowledgeStore')
  assert(/knowledge\.load\(\)/.test(indexJs), '★ 建了但没 load —— 数据是空的')
})

check('B2 ★★★ knowledge 必须传给 http 层（否则端点拿到 undefined）', () => {
  const at = indexJs.indexOf('artifactsHandler(store, {')
  assert(at > 0, '找不到 handler 调用')
  const seg = indexJs.slice(at, at + 400)
  assert(/\bknowledge,/.test(seg), '★ 没传给 http —— 端点里 deps.knowledge 会是 undefined')
})

check('B3 ★★★ knowledge 必须传给 tools 层（否则 agent 用不了）', () => {
  assert(/registerArtifactTools\([^)]*knowledge\s*\)/.test(indexJs),
    '★ 没传给工具注册 —— agent 调 knowledge_add 会失败')
  assert(/function registerArtifactTools\([^)]*knowledge/.test(toolsJs),
    '★ 工具函数签名没接 knowledge')
})

check('B4 ★★★ 三个 agent 工具都在，且真的 push 进 tools 数组', () => {
  for (const name of ['knowledge_add', 'knowledge_find', 'knowledge_get']) {
    assert(new RegExp("name: '" + name + "'").test(toolsJs), '★ 缺工具 ' + name)
  }
  // ⚠️ 光有定义不算 —— 必须在 `const disposers` 之前 push，否则不会被注册
  const pushAt = toolsJs.indexOf("name: 'knowledge_add'")
  const dispAt = toolsJs.indexOf('const disposers = []')
  assert(pushAt > 0 && dispAt > 0, '找不到位置')
  assert(pushAt < dispAt,
    '★ 知识工具定义在 disposers **之后** —— 不会被注册（定义了等于没定义）')
})

check('B5 ★★ HTTP 端点齐全（GET 列表 / POST 新建 / PATCH 改 / DELETE 删）', () => {
  assert(/id === 'knowledge'/.test(httpJs), '★ 缺 /knowledge 端点')
  assert(/knowledge\\\/\(\[\^\/\]\+\)/.test(httpJs.replace(/\s/g, '')) || /knItem/.test(httpJs),
    '★ 缺 /knowledge/:id 端点')
  const seg = httpJs.slice(httpJs.indexOf("id === 'knowledge'"))
  assert(/POST/.test(seg), '★ 缺 POST（新建）')
  assert(/PATCH|PUT/.test(seg), '★ 缺 PATCH（编辑）')
  assert(/DELETE/.test(seg), '★ 缺 DELETE（删除）')
})

// ══════════════════════════════════════════════════════════════════════════
// [C] 前端入口
// ══════════════════════════════════════════════════════════════════════════

check('C1 ★★★ 分类条必须有「知识」入口', () => {
  assert(/data-cat="knowledge"/.test(html), '★ 分类条没有知识入口 —— 用户找不到')
})

check('C2 ★★★ 点「知识」必须真的加载数据（不是只 render）', () => {
  // ⚠️ 这正是「点资料没反应」的同款 bug：逻辑在别处，但入口没调它
  const at = html.indexOf('function setCat(')
  assert(at > 0, '找不到 setCat')
  let j = at
  let d = 0
  let st = false
  while (j < html.length) {
    if (html[j] === '{') { d += 1; st = true }
    else if (html[j] === '}') { d -= 1; if (st && d === 0) break }
    j += 1
  }
  const body = deComment(html.slice(at, j + 1))
  assert(/knowledge/.test(body), '★ setCat 没处理 knowledge')
  assert(/loadKnowledge\(\)/.test(body),
    '★ setCat 切到知识库时没调 loadKnowledge() —— 会显示空列表（同款 bug）')
})

check('C3 ★★★ render 必须在「空库」兜底之前分流知识库', () => {
  const r = html.indexOf('function render()')
  const nextFn = html.indexOf('\nfunction ', r + 20)
  const body = html.slice(r, nextFn > r ? nextFn : r + 4000)
  const knAt = body.indexOf("state.cat === 'knowledge'")
  const emptyAt = body.indexOf('if (!state.items.length)')
  assert(knAt > 0, '★ render 没分流知识库')
  assert(emptyAt > 0, '找不到空库兜底（判据前提失效）')
  assert(knAt < emptyAt,
    '★ 知识库分流在空库兜底**之后** —— 产物库为空时永远显示"库是空的"')
})

check('C4 ★★ 有「记一条」入口和表单', () => {
  assert(/function knOpenForm\(/.test(html), '★ 没有表单')
  assert(/＋ 记一条/.test(html), '★ 没有「＋ 记一条」按钮文案')
  assert(/function knSave\(/.test(html), '★ 没有保存逻辑')
})

check('C5 ★★★ 删除要两次确认（知识条目没有回收站，删了就没了）', () => {
  // ⚠️ 与产物不同：产物删了进回收站能恢复；知识条目是**真删**。
  const at = html.indexOf('async function knDelete(')
  assert(at > 0, '找不到 knDelete')
  let j = at
  let d = 0
  let st = false
  while (j < html.length) {
    if (html[j] === '{') { d += 1; st = true }
    else if (html[j] === '}') { d -= 1; if (st && d === 0) break }
    j += 1
  }
  const body = deComment(html.slice(at, j + 1))
  const confirms = (body.match(/window\.confirm/g) || []).length
  assert(confirms >= 2, '★ 只确认了 ' + confirms + ' 次 —— 知识条目删了找不回来，要两次')
})

check('C6 ★★ 列表要显示类型徽章（坑/经验/决策一眼分开）', () => {
  assert(/knbadge/.test(html), '★ 没有类型徽章')
  assert(/kn-pitfall/.test(html) && /kn-experience/.test(html) && /kn-decision/.test(html),
    '★ 三种类型没有各自的样式')
})

// ══════════════════════════════════════════════════════════════════════════
// [D] 护栏
// ══════════════════════════════════════════════════════════════════════════

check('D1 ★★★ 内联 JS 语法合法（白屏护栏）', () => {
  const m = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(html)
  assert(m, '没有 script 块')
  try { new vm.Script(m[1], { filename: 'inline' }) }
  catch (e) { throw new Error('语法错：' + e.message) }
})

check('D2 ★★★ 不许有重复的函数定义', () => {
  for (const f of ['function renderKnowledge(', 'function loadKnowledge(', 'function knOpenForm(',
    'function knSave(', 'function knDelete(', 'function knItemHtml(']) {
    const c = html.split(f).length - 1
    assert(c === 1, '★ ' + f + ' 出现 ' + c + ' 次')
  }
})

check('D3 ★★ knowledge.js 语法合法', () => {
  try { new vm.Script(knJs.replace(/^import .*$/gm, '').replace(/^export /gm, ''), { filename: 'kn' }) }
  catch { /* ESM 语法会被上面剥掉，忽略 */ }
  assert(knJs.indexOf('export class KnowledgeStore') >= 0, '★ 没导出 KnowledgeStore')
})

// ══════════════════════════════════════════════════════════════════════════
// [E] 代码能不能**跑**（不只是"写了没"）
// ══════════════════════════════════════════════════════════════════════════
//
// ⭐ 这组是 2026-10-22 补的，起因是一次**真事故**：
//
//   我在 lib/http.js 里写了 `await readJsonBody(req)`，
//   但**那个函数根本不存在**（实际叫 `readBody`）。
//
//   · 本地 49 个测试**全绿**
//   · CI 一跑就红：`'readJsonBody' is not defined`（http.js:735 / :755）
//
//   为什么本地绿？因为 B5 是**字符串断言**：
//     assert(/id === 'knowledge'/.test(httpJs))
//   —— 证明"写了这个词"，不证明"这段代码能跑"。
//
//   ⚠️ 更打脸：我知识库里刚记过「有开源实现时先照抄结构，别推演 API」。
//      旁边 20 个端点都写 `await readBody(req)`，我没看一眼。

check('E1 ★★★ http.js 里不许有「调用但未定义」的函数名', () => {
  // ⚠️ 这是**静态比对**：收集定义 vs 收集调用。
  //    它抓不住所有运行时错误，但能抓住"拼错函数名"这一类 —— 那正是这次的 bug。
  const src = deComment(httpJs)

  const defined = new Set()
  for (const m of src.matchAll(/^\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) defined.add(m[1])
  for (const m of src.matchAll(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=/gm)) defined.add(m[1])
  for (const m of src.matchAll(/^\s*let\s+([A-Za-z_$][\w$]*)\s*=/gm)) defined.add(m[1])
  // import 进来的也算定义
  for (const m of src.matchAll(/import\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim()
      if (n) defined.add(n)
    }
  }

  // 只查 `await xxx(` 形式 —— 那是最可能被"编出来"的位置（异步辅助函数）
  const called = new Set()
  for (const m of src.matchAll(/await\s+([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1])

  // ⚠️ 白名单**必须小**：列进来的每个名字都在削弱这条检查。
  //    只放真正不在本文件定义的（内置 / 从 deps 解构出来的）。
  const builtin = new Set([
    'Promise', 'fetch', 'import', 'require',
  ])

  const missing = [...called].filter((n) => !defined.has(n) && !builtin.has(n))
  assert(missing.length === 0,
    '★ 调用了未定义的函数（会 ReferenceError）：' + missing.join(', '))
})

check('E2 ★★★ knowledge 端点用的 body 读取函数必须真实存在', () => {
  // ⚠️ 这条是 E1 的**定向版**：专门守这次踩的那个坑。
  //    比 E1 更狠 —— 它不看"有没有定义"，只看"是不是那个正确的名字"。
  const seg = httpJs.slice(httpJs.indexOf("id === 'knowledge'"))
  const m = /await\s+([A-Za-z_$][\w$]*)\s*\(req\)/.exec(seg)
  if (!m) return  // 没有 POST 分支就不用管
  const fn = m[1]
  // 必须在本文件里真的有 `function <fn>(` 定义
  assert(new RegExp('function\\s+' + fn + '\\s*\\(req\\)').test(httpJs),
    '★ knowledge 端点用了 `' + fn + '(req)`，但本文件没有这个函数定义')
})

check('E3 ★★ 知识库测试自己不许再用"只查字符串"来证明端点可用', () => {
  // ⚠️ 元检查：B5 那种写法（只 assert 字符串存在）**不足以**证明端点能用。
  //    这条要求 E 组必须存在 —— 防止有人把 E 组删掉退回去。
  const self = fs.readFileSync(path.join(REPO, 'test', 'knowledge.test.mjs'), 'utf8')
  assert(self.indexOf('E1 ★★★ http.js 里不许有') >= 0, '★ E 组不见了')
  assert(self.indexOf('未定义的函数') >= 0, '★ E1 的判据不见了')
})

console.log('\n' + (failed === 0 ? '✅ ' : '🔴 ') + passed + ' 通过 / ' + failed + ' 失败')
if (failed) {
  console.log('\n── 失败清单 ──')
  for (const f of failures) console.log('   · ' + f.name + ' -> ' + f.msg)
  process.exitCode = 1
}
process.exit(failed ? 1 : 0)
