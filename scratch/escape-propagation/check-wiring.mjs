/**
 * Lead 自查：`blockEscape` 真的从 PanelInner 传到 DetailDrawer 了吗？
 *
 * 为什么单独写：guard-author 在写正式守卫（test/overlay-escape.test.mjs），
 * 那是**独立**的验收；这里是我自己的**快速闭环**，用来在提交前先确认接线通了。
 * 两者刻意分开 —— 同一件事两个来源，才叫交叉验证。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\@dsh-external\\dsh-artifact-library'
const src = fs.readFileSync(path.join(REPO, 'lib', 'client.js'), 'utf8')
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); pass += 1 }
  catch (e) { console.log('  FAIL ' + name + ' -> ' + e.message); fail += 1 }
}
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败') }

console.log('── Lead 自查：blockEscape 接线 ──')

check('① PanelInner 把 `blockEscape: !!lightbox` 传给了 DetailDrawer', () => {
  // 切片：从 `detail ? h(DetailDrawer` 到 `}) : null,`
  const at = code.indexOf('detail ? h(DetailDrawer')
  assert(at >= 0, '找不到 DetailDrawer 渲染点')
  const end = code.indexOf('}) : null,', at)
  assert(end > at, '找不到 DetailDrawer 渲染点的结束')
  const seg = code.slice(at, end)
  assert(/blockEscape\s*:\s*!!lightbox/.test(seg),
    '★ 抽屉没收到 blockEscape（或没绑到 lightbox）—— 那 F2 就是空的，Esc 还是两下')
  console.log('       切片长度 ' + seg.length + '（含 blockEscape: ' + /blockEscape/.test(seg) + '）')
})

check('② DetailDrawer 的 Escape 处理器：blockEscape 为真时**先 return**', () => {
  const at = code.indexOf('function onKey(event) {\n          if (event.key !== "Escape") return;')
  // 用更稳的锚点
  const anchor = code.indexOf('if (props.blockEscape) return;')
  assert(anchor >= 0, '★ 抽屉的处理器里没有 `if (props.blockEscape) return;` —— 让路逻辑没写')
  // 它必须在 stopPropagation / onClose **之前**
  const seg = code.slice(anchor, anchor + 300)
  const stopAt = seg.indexOf('stopPropagation')
  const closeAt = seg.indexOf('props.onClose')
  assert(stopAt < 0 || seg.indexOf('if (props.blockEscape) return;') < stopAt,
    'blockEscape 的判断必须在 stopPropagation 之前（否则事件被截住，浮层收不到）')
  assert(closeAt < 0 || seg.indexOf('if (props.blockEscape) return;') < closeAt,
    'blockEscape 的判断必须在 onClose 之前（否则抽屉还是会被关掉）')
})

check('③ ★ 让路分支**不许** stopPropagation（截住了浮层就收不到）', () => {
  const anchor = code.indexOf('if (props.blockEscape) return;')
  const line = code.slice(anchor, anchor + 120)
  const firstLine = line.split('\n')[0]
  assert(!/stopPropagation/.test(firstLine),
    '★ 让路那一行里有 stopPropagation —— 那会让事件到不了浮层，等于没让路')
})

check('④ effect 依赖数组里有 `props.blockEscape`（否则闭包停在挂载那一刻）', () => {
  const anchor = code.indexOf('if (props.blockEscape) return;')
  assert(anchor >= 0, '前提失效')
  const after = code.slice(anchor, anchor + 1200)
  const dep = after.match(/\}, \[([^\]]*)\]\);/)
  assert(dep, '找不到该 effect 的依赖数组')
  assert(/props\.blockEscape/.test(dep[1]),
    '★ 依赖数组是 [' + dep[1].trim() + ']，缺 props.blockEscape —— '
    + '浮层开关时监听器不会重装，闭包里的值会过期')
})

check('⑤ 浮层自己的 Escape：capture + stopPropagation（挡住底下所有 bubble 处理器）', () => {
  const at = code.indexOf('var returnFocusTo = null;')
  assert(at >= 0, '找不到浮层的键盘 effect')
  const seg = code.slice(Math.max(0, at - 600), at + 4200)
  assert(/addEventListener\("keydown", onKey, true\)/.test(seg), '浮层没挂 capture')
  const escAt = seg.indexOf('key === "Escape"')
  const arrowAt = seg.indexOf('ArrowLeft', escAt)
  assert(escAt >= 0 && arrowAt > escAt, '找不到 Escape 分支的边界')
  assert(/stopPropagation/.test(seg.slice(escAt, arrowAt)), 'Escape 分支里没有 stopPropagation')
})

check('★ 反向对照：把 `blockEscape: !!lightbox` 删掉 ⇒ 判据①必须红', () => {
  const broken = code.replace('blockEscape: !!lightbox,', '')
  assert(broken !== code, '反向对照造不出来（替换没生效）⇒ 判据①可能是空转的')
  const at = broken.indexOf('detail ? h(DetailDrawer')
  const end = broken.indexOf('}) : null,', at)
  const seg = broken.slice(at, end)
  assert(!/blockEscape\s*:\s*!!lightbox/.test(seg), '坏版本竟然还有 blockEscape ⇒ 判据①空转')
})

console.log('')
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
