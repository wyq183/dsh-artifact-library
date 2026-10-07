/**
 * 离线 harness：CSS 热载（宿主样式归属契约）
 *
 * ⚠️ **这个测试治的是一条被误判成"环境硬约束"的东西。**
 *
 * 长期以来的结论是：「**改了 CSS 必须重启应用才生效**（热载不重插样式）」，
 * 它还导致好几处 CSS 工作被砍掉/推迟（2d 刻意零新 CSS、3d 一直卡着等重启窗口）。
 *
 * 2026-10-07 查明**它不是环境脾气，是插件的 bug**：
 *   宿主 `dsh-client-modules` 清理插件样式时**只认 `data-plugin` 属性**
 *   （`removeOwnedStyles`：`querySelectorAll("style[data-plugin]")` 且值 === id），
 *   而这个属性由宿主 `claimStyles` 在 **`factory()`（模块顶层）执行之后**统一认领。
 *   官方插件都在**模块顶层**注入 CSS ⇒ 落在认领窗口里；
 *   **我们在 `apply()` 里注入**（apply 在 materialize 之后）⇒ 窗口早关了。
 *
 *   链条：没打标 → 热载删不掉旧 `<style>` → `injectCss` 的守卫命中旧标签直接 return
 *        → **新 CSS 永远进不来**。
 *   副作用：未打标的标签还会被**后来 materialize 的别的插件认领走**，
 *        于是那个插件一热载，产物库的样式被一起删掉。
 *
 * 本文件用**假 DOM 复现宿主的两个函数语义**，把 `client.js` 里**真的 `injectCss`**
 * 按内容切出来跑（行号漂了会自己报错，不会偷偷跑旧代码）。
 *
 * 用法：node test/css-hotload.test.mjs
 */

import fs from 'node:fs'

const SRC = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

/** 按内容切出一个函数（不用行号 —— 行会漂，内容不会无声地漂） */
function sliceFn(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert(start >= 0, `切不出来：${name}（被改名/搬走了？这条测试要跟着改）`)
  let i = SRC.indexOf('{', start)
  let depth = 0
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) return SRC.slice(start, i + 1) }
  }
  throw new Error('括号没配平：' + name)
}

const styleIdMatch = /"(\@dsh-external\/dsh-artifact-library\/ui\.css)"/.exec(SRC)
const pluginIdMatch = /var PLUGIN_ID = "([^"]+)";/.exec(SRC)
assert(styleIdMatch, '切不出 STYLE_ID')
assert(pluginIdMatch, '切不出 PLUGIN_ID')
const STYLE_ID = styleIdMatch[1]
const PLUGIN_ID = pluginIdMatch[1]

// ⚠️ 测试床把 injectCss 自带的 try/catch **打开成 throw**。
//    它"永不抛出"是**生产该有的**行为（绝不让样式问题崩掉界面），
//    但在这里会把**测试床自己的 bug** 一起吞掉 —— 第一版就是这么出的
//    6 条假红（全是测试床错，不是代码错）。所以这条断言必须留着帮后人避坑。
const CATCH = 'catch (error) { /* 样式注入失败不影响功能 */ }'
assert(SRC.includes(CATCH), '找不到那句 catch —— 本测试床的"打开 catch"手法要跟着改（否则错误会被静默吞掉）')
const patched = sliceFn('injectCss').replace(CATCH, 'catch (error) { throw error }')
const makeInject = () => new Function('document', 'STYLE_ID', 'PLUGIN_ID', 'css', `${patched}\nreturn injectCss`)

/** 极简 DOM —— 只实现本测试用到的选择器 */
function makeDom() {
  const head = { children: [] }
  head.appendChild = (el) => { head.children.push(el) }
  const doc = {
    head,
    documentElement: {},
    createElement(t) {
      return {
        tagName: t, attrs: {}, textContent: '',
        setAttribute(k, v) { this.attrs[k] = String(v) },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
        remove() { const i = head.children.indexOf(this); if (i >= 0) head.children.splice(i, 1) },
      }
    },
    querySelectorAll(sel) {
      const styles = head.children.filter((e) => e.tagName === 'style')
      let m = /^style\[data-plugin-css=([\s\S]*)\]$/.exec(sel)
      if (m) { const want = JSON.parse(m[1]); return styles.filter((e) => e.getAttribute('data-plugin-css') === want) }
      m = /^style\[data-plugin=([\s\S]*)\]$/.exec(sel)
      if (m) { const want = JSON.parse(m[1]); return styles.filter((e) => e.getAttribute('data-plugin') === want) }
      if (sel === 'style[data-plugin]') return styles.filter((e) => e.getAttribute('data-plugin') !== null)
      if (sel === 'style:not([data-plugin])') return styles.filter((e) => e.getAttribute('data-plugin') === null)
      return []
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null },
  }
  return { doc, head }
}

// ── 宿主的两个函数：照 asar 里 dsh-client-modules 的原样语义 ────────────────
const claimStyles = (doc, id) => {
  for (const el of doc.querySelectorAll('style:not([data-plugin])')) el.setAttribute('data-plugin', id)
}
const removeOwnedStyles = (doc, id) => {
  for (const el of doc.querySelectorAll('style[data-plugin]')) if (el.getAttribute('data-plugin') === id) el.remove()
}

const OTHER_PLUGIN = '@deepseek-ai/dsh-client-ui-layout'

try {
  // ═══ [A] 归属契约 ═══════════════════════════════════════════════════════
  console.log('\n=== [A] 注入时必须打上归属（data-plugin）===')

  check('A1 ★★ PLUGIN_ID 必须是 package.json 的包名（宿主 ownerId 就是它）', () => {
    const pkgName = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
    assert(PLUGIN_ID === pkgName,
      `★ PLUGIN_ID「${PLUGIN_ID}」与包名「${pkgName}」不一致 ——`
      + '宿主 `removeOwnedStyles(id)` 拿的是 client 模块清单的 row.id（按包扫出来的），'
      + '填错就等于没打标、热载照样失效')
    assert(PLUGIN_ID === '@dsh-external/dsh-artifact-library', '包名变了？这条断言要跟着更新')
  })

  check('A2 首次注入：标签同时带 data-plugin-css 与 data-plugin', () => {
    const { doc, head } = makeDom()
    makeInject()(doc, STYLE_ID, PLUGIN_ID, 'v1')()
    assert(head.children.length === 1, '该有 1 个 style，实际 ' + head.children.length)
    const t = head.children[0]
    assert(t.getAttribute('data-plugin-css') === STYLE_ID, 'data-plugin-css: ' + t.getAttribute('data-plugin-css'))
    assert(t.getAttribute('data-plugin') === PLUGIN_ID, 'data-plugin 该是包名，实际 ' + t.getAttribute('data-plugin'))
    assert(t.textContent === 'v1', '内容: ' + t.textContent)
  })

  check('A3 ★★ 宿主删得掉它（这就是原来删不掉的那一个）', () => {
    const { doc, head } = makeDom()
    makeInject()(doc, STYLE_ID, PLUGIN_ID, 'v1')()
    removeOwnedStyles(doc, PLUGIN_ID)
    assert(head.children.length === 0, '★ 没删掉 —— 旧样式残留，新样式就进不来（= 原 bug）')
  })

  check('A4 ★★ 热载后重新 apply：新 CSS 真的进来了（= 这条测试的存在理由）', () => {
    const { doc, head } = makeDom()
    makeInject()(doc, STYLE_ID, PLUGIN_ID, 'v1-old')()
    removeOwnedStyles(doc, PLUGIN_ID)                  // 宿主清理
    makeInject()(doc, STYLE_ID, PLUGIN_ID, 'v2-new')() // 新版本 apply
    assert(head.children.length === 1, '该重新注入，实际 ' + head.children.length)
    assert(head.children[0].textContent === 'v2-new', '★ CSS 没更新：' + head.children[0].textContent)
  })

  check('A5 重复 apply 不产生第二份（幂等）', () => {
    const { doc, head } = makeDom()
    const injectCss = makeInject()(doc, STYLE_ID, PLUGIN_ID, 'v2')
    injectCss(); injectCss(); injectCss()
    assert(head.children.length === 1, '注入了 ' + head.children.length + ' 份')
  })

  // ═══ [B] 过渡期：旧版本留下的未打标标签 ═════════════════════════════════
  console.log('\n=== [B] 过渡期：旧版本注入的未打标标签（决定"要不要先刷新一次"）===')

  check('B1 ★★ 旧标签会被**就地认领** + 内容同步（不必先刷新页面）', () => {
    // 伪造"本次修改之前"的现场：只有 data-plugin-css、没有 data-plugin。
    // ⚠️ 这正是修好那一刻**正在跑的那个页面**的状态 —— 所以这条决定修完能否立刻验。
    const { doc, head } = makeDom()
    const legacy = doc.createElement('style')
    legacy.setAttribute('data-plugin-css', STYLE_ID)
    legacy.textContent = 'v1-old'
    head.children.push(legacy)
    removeOwnedStyles(doc, PLUGIN_ID)
    assert(head.children.length === 1, '前提：宿主按 id 删不掉未打标的旧标签')
    makeInject()(doc, STYLE_ID, PLUGIN_ID, 'v2-new')()
    assert(head.children.length === 1, '★ 又插了一份（该就地认领，而不是两份并存）')
    assert(legacy.getAttribute('data-plugin') === PLUGIN_ID, '★ 没认领旧标签 —— 下次热载还是删不掉')
    assert(legacy.textContent === 'v2-new', '★ 内容没同步，新 CSS 没生效：' + legacy.textContent)
  })

  check('B2 认领之后就归我们所有（下一次热载能正常删）', () => {
    const { doc, head } = makeDom()
    const legacy = doc.createElement('style')
    legacy.setAttribute('data-plugin-css', STYLE_ID)
    head.children.push(legacy)
    makeInject()(doc, STYLE_ID, PLUGIN_ID, 'v2')()
    removeOwnedStyles(doc, PLUGIN_ID)
    assert(head.children.length === 0, '认领后该能删掉')
  })

  check('B3 未打标的旧标签**确实**会被别的插件认领走（证明 A/B 守的是真问题）', () => {
    const { doc, head } = makeDom()
    const legacy = doc.createElement('style')
    legacy.setAttribute('data-plugin-css', STYLE_ID)
    head.children.push(legacy)
    claimStyles(doc, OTHER_PLUGIN)
    assert(head.children[0].getAttribute('data-plugin') === OTHER_PLUGIN,
      '前提不成立：未打标的标签竟然没被认领')
  })

  // ═══ [C] 不误伤别人 ═════════════════════════════════════════════════════
  console.log('\n=== [C] 不误伤：只按我们自己的 id 删 ===')

  check('C1 别人的样式不受影响', () => {
    const { doc, head } = makeDom()
    const other = doc.createElement('style')
    other.setAttribute('data-plugin', OTHER_PLUGIN)
    other.textContent = 'other'
    head.children.push(other)
    makeInject()(doc, STYLE_ID, PLUGIN_ID, 'v4')()
    removeOwnedStyles(doc, PLUGIN_ID)
    assert(head.children.length === 1, '★ 把别的插件的样式删掉了')
    assert(head.children[0].getAttribute('data-plugin') === OTHER_PLUGIN, '留下的不该是我们')
  })

  check('C2 ★ 宿主 claimStyles 不会再"认领走"我们的标签（消除"样式被别的插件带走"）', () => {
    const { doc, head } = makeDom()
    makeInject()(doc, STYLE_ID, PLUGIN_ID, 'v5')()
    claimStyles(doc, OTHER_PLUGIN)   // 另一个插件 materialize 时，宿主认领所有未打标的 style
    assert(head.children[0].getAttribute('data-plugin') === PLUGIN_ID,
      '★ 我们的样式被别的插件认领走了（它一热载就会把产物库样式删掉）：'
      + head.children[0].getAttribute('data-plugin'))
  })

  // ═══ [D] 永不抛出（生产契约）════════════════════════════════════════════
  console.log('\n=== [D] 注入失败绝不抛出（不许崩界面）===')

  check('D1 真源码里带着 catch（我们只是测试时把它打开）', () => {
    assert(sliceFn('injectCss').includes(CATCH),
      '★ catch 被删了 —— injectCss 一旦抛出会顺着 apply 往上传，'
      + '而"第三方插件崩掉整个应用"是这个项目吃过的大亏')
  })

  check('D2 document 不存在时直接返回（不抛）—— 用**真正的** injectCss（带 catch）', () => {
    const realInject = new Function('document', 'STYLE_ID', 'PLUGIN_ID', 'css',
      `${sliceFn('injectCss')}\nreturn injectCss`)(undefined, STYLE_ID, PLUGIN_ID, 'v1')
    realInject() // 不崩即通过
  })

  check('D3 DOM 抛异常时也不外抛（用带 catch 的真版本）', () => {
    const boom = {
      querySelector() { throw new Error('DOM 炸了') },
      createElement() { throw new Error('DOM 炸了') },
      head: { appendChild() { throw new Error('DOM 炸了') } },
    }
    const realInject = new Function('document', 'STYLE_ID', 'PLUGIN_ID', 'css',
      `${sliceFn('injectCss')}\nreturn injectCss`)(boom, STYLE_ID, PLUGIN_ID, 'v1')
    realInject() // 不崩即通过
  })
} catch (e) {
  console.log('  （harness 准备阶段出错：' + e.message + '）')
  failed += 1
  failures.push('harness: ' + e.message)
}

console.log('\n' + '─'.repeat(64))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) { console.log('\n失败列表：'); for (const f of failures) console.log('  · ' + f) }
process.exit(failed ? 1 : 0)
