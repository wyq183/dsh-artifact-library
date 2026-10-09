/**
 * 渲染几何验证回路（render-verify）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 为什么需要它（2026-10-09 · 依琪「开发流程出了问题」之后建的）：
 *   建它的时候（2026-10-09 上午）有 **29 个**测试文件、**全绿**，
 *   却连着上线三个 UI bug（**层级 / 位置 / 尺寸**）——
 *   因为测试床是**假 React**，而假 DOM 里**根本没有布局引擎**
 *   （没有 `getBoundingClientRect`）。⇒ "测试全绿"是**结构性必然**，不是质量信号。
 *   ⚠️ 现在已经是 30 个 —— **别引用这个数字**，`npm run doc:stale` 会核能自动核的部分。
 *
 *   逻辑测试看不见「控件被容器裁掉」，但**把真 CSS + 真结构渲染进真 Chrome、
 *   量一量盒子**就看得见。这就是本脚本干的事。
 *
 * ★ 本脚本**自己也被反向对照验过**（这是它可信的唯一理由）：
 *   A 当前实现 ⇒ OK ；B 改之前（两处都回退）⇒ CLIPPED。
 *   若哪天 A 和 B 都 OK ⇒ **回路失效**，脚本会自己报出来（见末尾判定）。
 *
 * ⚠️ 我第一版是**截图比像素**，结果同一份代码两次跑差一倍字节（视频帧没解码出来）
 *   ⇒ 回路自己会闪。**改成量几何**：确定性、给硬数字、可断言。
 *
 * 用法：
 *   node scratch/render-verify/render-verify.mjs
 *   node scratch/render-verify/render-verify.mjs --client <client.js 路径>
 *   node scratch/render-verify/render-verify.mjs --keep   （保留生成的 html/截图）
 *
 * 依赖：本机 Chrome/Edge（自动探测）。**不需要任何 npm 包。**
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const CLIENT = argOf('--client', path.join(REPO, 'lib', 'client.js'))
const KEEP = argv.includes('--keep')
const WORK = path.join(os.tmpdir(), 'alf-render-verify')
fs.mkdirSync(WORK, { recursive: true })

// ── 0. 找浏览器 ───────────────────────────────────────────────────────────
function findBrowser() {
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ]
  for (const c of cands) { if (c && fs.existsSync(c)) return c }
  return null
}
const BROWSER = findBrowser()
if (!BROWSER) {
  console.error('🔴 找不到 Chrome/Edge —— 本脚本需要一个真浏览器（这正是它的意义所在）。')
  process.exit(2)
}

// ── 1. 从 client.js **求值**出真 CSS（不手抄！）───────────────────────────
function extractCss(clientPath) {
  const src = fs.readFileSync(clientPath, 'utf8')
  const lines = src.split('\n')

  const nsLine = lines.find((l) => /^\s*var NS = /.test(l))
  const nsMatch = nsLine && /var NS = "([^"]*)"/.exec(nsLine)
  if (!nsMatch) throw new Error('解析不出 NS 的值')
  const NS = nsMatch[1]

  const start = lines.findIndex((l) => /^\s*var css = \[$/.test(l))
  if (start < 0) throw new Error('找不到 `var css = [`')
  let end = -1
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\]\.join\("\\n"\);\s*$/.test(lines[i])) { end = i; break }
  }
  if (end < 0) throw new Error('找不到 CSS 数组的收尾 `].join("\\n");`')

  // ⚠️ 先剔掉注释行 —— 数组里混着大量 `//` 说明，注释里会出现
  //    `VIEW_KINDS` / `DPI` 这类**看起来像变量**的词，直接求值会报 not defined。
  const body = lines.slice(start + 1, end).filter((l) => !/^\s*\/\//.test(l)).join('\n')

  // 数组元素里引用的**真实常量**：从源码取值，不自己编
  const constDefs = {}
  for (const name of ['ROW_H_SEARCH']) {
    const def = lines.find((l) => new RegExp('var\\s+' + name + '\\s*=').test(l))
    if (!def) continue
    const m = def.match(new RegExp('var\\s+' + name + '\\s*=\\s*([^;]+);'))
    if (m) constDefs[name] = Number(m[1])
  }

   
  const arr = new Function('NS', ...Object.keys(constDefs),
    'return [' + body + '];')(NS, ...Object.values(constDefs))
  if (!Array.isArray(arr)) throw new Error('求值结果不是数组')
  const css = arr.join('\n')

  // ★ 输入预处理自检（本仓库铁律：预处理坏了 = 全坏且不喊）
  for (const k of ['__drawer', '__preview', 'position:fixed']) {
    if (!css.includes(k)) throw new Error('抽到的 CSS 里没有 `' + k + '` —— 抽错了（预处理失效）')
  }
  return { css, NS, elementCount: arr.length }
}

// ── 2. DSH 设计 token 的最小替身（只影响颜色，不影响布局）─────────────────
const TOKENS = `
  :root{
    --dsw-alias-bg-layer-1:#1b1b1f; --dsw-alias-bg-layer-2:#232329; --dsw-alias-bg-layer-3:#2a2a31;
    --dsw-alias-bg-mask-1:rgba(0,0,0,.45); --dsw-alias-bg-mask:rgba(0,0,0,.62);
    --dsw-alias-border-l1:#3a3a42; --dsw-alias-border-l2:#4a4a55;
    --dsw-alias-label-primary:#e8e8ee; --dsw-alias-label-secondary:#b8b8c2; --dsw-alias-label-tertiary:#8a8a96;
    --dsw-alias-state-business-primary:#4a8cff; --dsw-alias-state-error-primary:#d94a4a;
    --dsw-alias-interactive-bg-hover:#33333c; --dsw-alias-toast-bg:#33333c; --dsw-alias-toast-label:#e8e8ee;
    --dsw-radius-sm:4px; --dsw-radius-md:6px; --dsw-radius-lg:10px;
    --dsw-elevation-prominent:0 8px 24px rgba(0,0,0,.5);
    --dsh-content-font-size-secondary:13px; --dsh-content-font-size-primary:14px;
    --dsh-content-font-delta:0px; --ds-font-family-code:Consolas,monospace;
  }
  body{margin:0;background:#0e0e11;font-family:"Microsoft YaHei",sans-serif;color:#e8e8ee}
`

// ── 3. 场景：详情抽屉（内容刻意够高 —— 那是"flex 压缩"发作的条件）─────────
const SCENARIOS = {
  'drawer-preview': {
    why: '详情抽屉的预览区：视频控件在最下缘，被容器裁掉就看不见（依琪 2026-10-09 报的那个）',
    targets: [
      { sel: '#theVideo', label: '视频（控件在它内部下缘）' },
      { sel: '#thePreview', label: '预览容器' },
    ],
    body: `
<div class="alf__panel" style="position:relative;overflow:hidden;width:430px;height:560px;background:#16161a">
  <div class="alf__drawer" role="dialog" aria-label="产物详情">
    <div class="alf__drawerh">
      <div class="alf__title">平射家族加强 —— PvZ2 Gardendless 助手</div>
      <span class="alf__grow"></span>
      <button class="alf__btn alf__btn--ghost">关闭</button>
    </div>
    <div class="alf__drawerb">
      <div class="alf__preview" id="thePreview">
        <video id="theVideo" controls preload="metadata"></video>
      </div>
      <div class="alf__badges">
        <span class="alf__badge">video</span><span class="alf__badge">手动登记</span>
        <span class="alf__badge">PvZ2 Gardendless 助手</span>
      </div>
      <div class="alf__field"><div class="alf__label">摘要</div>
        <div class="alf__value">把平射家族的植物加强了一遍，附 11 株 SP 植物说明。这是摘要文本，用来把抽屉撑高——真机上这一块也很长。</div></div>
      <div class="alf__field"><div class="alf__label">标签</div><div class="alf__value">PvZ2 · 平射家族 · 助手 · mod</div></div>
      <div class="alf__field"><div class="alf__label">项目</div><div class="alf__value">PvZ2 Gardendless</div></div>
      <div class="alf__field"><div class="alf__label">路径</div><div class="alf__value">C:\\Users\\Administrator\\.dsh\\alf-video\\probe.mp4</div></div>
      <div class="alf__field"><div class="alf__label">大小</div><div class="alf__value">7.1 MB</div></div>
      <div class="alf__field"><div class="alf__label">类型</div><div class="alf__value">video/mp4</div></div>
    </div>
  </div>
</div>`,
  },
}

// ── 4. 页面里的测量脚本 ───────────────────────────────────────────────────
// 判据：子元素矩形 vs 每个祖先矩形；祖先 overflow 非 visible 且子元素越界 ⇒ 被裁。
// ⚠️ 这条判据**不依赖任何魔数**（不用猜高度、不用猜宽度）。
function measureScript(targets) {
  return `
<pre id="RESULT"></pre>
<script>
(function () {
  var lines = [];
  function R(el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right }; }
  function ov(el) { var cs = getComputedStyle(el); return { x: cs.overflowX, y: cs.overflowY }; }
  function clipped(child, anc) {
    var c = R(child), a = R(anc), o = ov(anc);
    var cut = {
      top:    o.y !== 'visible' && c.y < a.y - 0.5,
      bottom: o.y !== 'visible' && c.b > a.b + 0.5,
      left:   o.x !== 'visible' && c.x < a.x - 0.5,
      right:  o.x !== 'visible' && c.r > a.r + 0.5,
    };
    if (!(cut.top || cut.bottom || cut.left || cut.right)) return null;
    return { by: String(anc.className || anc.tagName).split(' ')[0], cut: cut,
             overBottom: +(c.b - a.b).toFixed(1), overTop: +(a.y - c.y).toFixed(1) };
  }
  var targets = ${JSON.stringify(targets)};
  var anyClipped = false;
  targets.forEach(function (t) {
    var el = document.querySelector(t.sel);
    if (!el) { lines.push('MISSING|' + t.label); return; }
    var r = R(el);
    lines.push('BOX|' + t.label + '|' + r.w.toFixed(1) + '|' + r.h.toFixed(1));
    var node = el.parentElement, bad = [];
    while (node && node !== document.documentElement) {
      var c = clipped(el, node);
      if (c) bad.push(c);
      node = node.parentElement;
    }
    if (bad.length) { anyClipped = true; lines.push('CLIPPED|' + t.label + '|' + JSON.stringify(bad)); }
    else { lines.push('OK|' + t.label); }
  });
  lines.push('VERDICT|' + (anyClipped ? 'CLIPPED' : 'OK'));
  document.getElementById('RESULT').textContent =
    'RESULT_BEGIN\\n' + lines.join('\\n') + '\\nRESULT_END';
})();
</script>`
}

function html(scenario, css) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${TOKENS}</style><style>${css}</style></head>
<body>${scenario.body}${measureScript(scenario.targets)}</body></html>`
}

// ── 5. 跑一个变体，返回测量结果 ───────────────────────────────────────────
function runVariant(name, css, scenario) {
  const p = path.join(WORK, name + '.html')
  fs.writeFileSync(p, html(scenario, css), 'utf8')
  const dom = execFileSync(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=430,560', '--virtual-time-budget=5000',
    '--dump-dom', 'file:///' + p.replace(/\\/g, '/'),
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const m = dom.match(/RESULT_BEGIN([\s\S]*?)RESULT_END/)
  if (!m) throw new Error('变体 ' + name + ' 没抓到 RESULT（页面没跑起来？）')
  return m[1].trim()
}

// ── 6. 反向对照：把"已知有病"的改动喂进来 ─────────────────────────────────
// ⚠️ 每条对照都必须是**真实的历史状态**，不是随便改一个地方。
//    我第一版只回退了 `flex:none`，却**留着**新加的 `max-height` ⇒ 那不是历史状态，
//    而且它渲染出来控件仍然可见 ⇒ **那个反向对照是假的**。
const KNOWN_BROKEN = [
  {
    id: 'B-before-2026-10-09',
    why: '2026-10-09 修之前：__preview 可压缩（无 flex:none）+ video 没有 max-height',
    apply: (css) => css
      .replace(/max-height:320px;flex:none\}/, 'max-height:320px}')
      .replace('__preview video{max-width:100%;max-height:300px;display:block}',
        '__preview video{max-width:100%;display:block}'),
  },
]

// ── 7. 主流程 ─────────────────────────────────────────────────────────────
console.log('═══ 渲染几何验证回路 ═══')
console.log('  被测：' + CLIENT)
console.log('  浏览器：' + BROWSER)
console.log('  工作目录：' + WORK)
console.log('')

const { css, elementCount } = extractCss(CLIENT)
console.log('  CSS：' + css.length + ' 字符 / ' + elementCount + ' 个数组元素（预处理自检通过）')
console.log('')

const scenario = SCENARIOS['drawer-preview']
console.log('── 场景：drawer-preview ──')
console.log('   ' + scenario.why)
console.log('')

const current = runVariant('current', css, scenario)
console.log('【当前实现】')
console.log(current.split('\n').map((l) => '   ' + l).join('\n'))

// ⚠️ 原写法是 `(s.match(...) || [, '?'])[1]` —— 那个 `[, '?']` 是**稀疏数组**
//    （索引 0 是个空洞），ESLint 的 `no-sparse-arrays` 会报。
//    它**能跑**（取 [1] 拿到 '?'），但语义含糊 ⇒ 改成显式的。
const verdictOf = (s) => {
  const m = s.match(/VERDICT\|(\w+)/)
  return m ? m[1] : '?'
}
const currentVerdict = verdictOf(current)

let allControlsBehaved = true
for (const kb of KNOWN_BROKEN) {
  const brokenCss = kb.apply(css)
  if (brokenCss === css) {
    console.log('\n🔴 反向对照「' + kb.id + '」**造不出来**（锚点没匹配上）')
    console.log('   ⇒ 这条对照是空的，请同步锚点（产品代码改过？）')
    allControlsBehaved = false
    continue
  }
  const out = runVariant(kb.id, brokenCss, scenario)
  const v = verdictOf(out)
  console.log('\n【反向对照 ' + kb.id + '】' + kb.why)
  console.log(out.split('\n').map((l) => '   ' + l).join('\n'))
  console.log('   ⇒ ' + (v === 'CLIPPED' ? '✅ 被抓住（红）' : '🔴 **没抓住** —— 回路对它是瞎的'))
  if (v !== 'CLIPPED') allControlsBehaved = false
}

console.log('\n════ 判定 ════')
console.log('  当前实现      : ' + currentVerdict)
console.log('  反向对照      : ' + (allControlsBehaved ? '全部被抓（回路有效）' : '🔴 有问题'))
console.log('')
if (currentVerdict === 'OK' && allControlsBehaved) {
  console.log('  ★ **回路有效**：当前实现 OK，已知有病的版本 CLIPPED。')
} else if (currentVerdict === 'CLIPPED') {
  console.log('  🔴 **当前实现就有东西被裁** —— 看上面 CLIPPED 那行，它点名了是哪个祖先、哪条边。')
} else {
  console.log('  🔴 **回路无效**（有病的版本也没被抓）—— 它现在是"安全感的假象"，别信它。')
}

if (!KEEP) {
  try { fs.rmSync(WORK, { recursive: true, force: true }) } catch { /* Windows 占用是常事 */ }
} else {
  console.log('\n  （--keep：产物留在 ' + WORK + '）')
}
process.exit(currentVerdict === 'OK' && allControlsBehaved ? 0 : 1)
