/**
 * dsh-artifact-library — 文件类型图标
 *
 * 目录视图每行左侧的 16×16 类型图标 + 官方色表配色。
 * 依据：`docs/UI-SPEC-v1.md` §2.4（官方 `FileTypeIcon.module.css` 实测）
 *
 * 设计约束（硬规矩，见 spec §一）：
 *   - **禁止 hex**：颜色只允许 `var(--dsw-static-*)`（media 是唯一例外，
 *     官方注明 violet 无对应 token，写 rgb()）
 *   - **禁止 emoji**：全部线性 SVG，stroke/fill 一律 `currentColor`，
 *     由调用方用 `style={{ color }}` 决定实际颜色（深色模式零感知跟随）
 *   - 纯 ESM、零依赖、**不引用任何 Node/浏览器 API**
 *
 * ── 两种消费方式（重要）────────────────────────────────────────────────
 * A. **Node 侧测试 / 校验**：`import { iconForName, FILE_TYPE_COLORS }` 即可。
 * B. **浏览器侧（内联进 lib/client.js）**：DSH 客户端 require 只解析
 *    宿主 seed / boot graph 行 / 已注册工厂；包内相对文件只有
 *    `/plugins/<id>/client.<name>.js` 一条路，且必须走 `require.async`
 *    —— 所以本文件在浏览器里**加载不到**。ui-core 采用「内联」方案，
 *    为此本文件导出两段**可机械复制**的东西：
 *      · `ICON_TABLE` —— 纯 JSON 可序列化映射数据（无函数、无正则）
 *      · `buildIconResolver(table)` —— **自包含**纯函数（不依赖本文件任何
 *        私有 helper），返回 `(name, isDirectory) => { svg, color }`
 *    把这两段源码原样粘进 client.js 即可，不需要人工翻译逻辑：
 *        const ICONS = { ...ICON_TABLE 的字面量... }
 *        const resolveIcon = buildIconResolver(ICONS)   // 函数整段复制
 *        resolveIcon('a.tar.gz', false)  // → { svg, color }，与 iconForName 等价
 *
 * 匹配语义（照抄 dsh-better-sidebar-icons 的思路）：
 *   1. 目录 → folder
 *   2. **文件名优先**：package.json / .gitignore / README.md / AGENTS.md / LICENSE / Dockerfile …
 *   3. **最长扩展名优先**：archive.tar.gz 先试 `tar.gz`，再试 `gz`
 *   4. 认不出来 → other 通用文件图标
 */

/* ────────────────────────────────────────────────────────────────────────
 * 官方文件类型色表（docs/UI-SPEC-v1.md §2.4）
 * 键名是冻结契约的一部分，不要增删。
 * ──────────────────────────────────────────────────────────────────────── */
export const FILE_TYPE_COLORS = {
  code: 'var(--dsw-static-deepseek-500)',
  markdown: 'var(--dsw-static-deepseek-500)',
  html: 'var(--dsw-static-deepseek-500)',
  excel: 'var(--dsw-static-green-500)',
  word: 'var(--dsw-static-deepseek-450)',
  ppt: 'var(--dsw-static-amber-500)',
  pdf: 'var(--dsw-static-red-600)',
  media: 'rgb(139,118,246)', // violet：官方注明无 token，唯一例外
  folder: 'var(--dsw-static-amber-400)',
  other: 'var(--dsw-static-neutral-bluish-300)',
}

/* ────────────────────────────────────────────────────────────────────────
 * 图形素材：16×16 线性图标（16 种语义图形，靠「形状 + 颜色」区分）
 * 页框统一 x 4→12 / y 1.6→14.4，右上角折角。
 * 下面存的是「图形本体」，外壳由 SVG_OPEN/SVG_CLOSE 统一套（见 ICON_TABLE.shapes）
 * ──────────────────────────────────────────────────────────────────────── */
const PAGE = 'M4 1.6h4.8L12 4.8v9.6H4z' // 带折角的文档
const PAGE_FOLD = 'M8.8 1.6v3.2h3.2' // 折角折线
const PLAIN_PAGE = 'M4 1.6h8v12.8H4z' // 无折角（纯文本）

const SHAPE_SVG = {
  // 1. 目录
  folder:
    '<path d="M2.2 4.4a1 1 0 0 1 1-1h3.1l1.3 1.7h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z"/>',

  // 2. 源码：文档 + 终端提示符 >_（比 < > 在 16px 下更像"代码"）
  code:
    `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
    '<path d="M5.6 7.2 7.3 9 5.6 10.8"/><path d="M8.4 10.8h3.1"/>',

  // 3. JSON：文档 + { }（中点是尖的，别画成圆括号）
  json:
    `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
    '<path d="M7 6.7H6.2a.8.8 0 0 0-.8.8v1.1a.8.8 0 0 0-.8.8a.8.8 0 0 0 .8.8v1.1a.8.8 0 0 0 .8.8H7"/>' +
    '<path d="M9 6.7h.8a.8.8 0 0 1 .8.8v1.1a.8.8 0 0 1 .8.8a.8.8 0 0 1-.8.8v1.1a.8.8 0 0 1-.8.8H9"/>',

  // 4. Markdown：文档 + M
  markdown: `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/><path d="M5.7 11.6V7.8l2 2.4 2-2.4v3.8"/>`,

  // 5. HTML：文档 + </ >（左右尖括号各让开，中间的斜杠不压线）
  html:
    `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
    '<path d="M6.4 7.6 5.3 9.4l1.1 1.8"/><path d="M8.5 6.7 7.5 12.1"/><path d="M9.6 7.6 10.7 9.4 9.6 11.2"/>',

  // 6. Word / 富文本文档：文档 + 折角 + 三条正文线
  doc:
    `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
    '<path d="M5.9 7.4h4.2"/><path d="M5.9 9.6h4.2"/><path d="M5.9 11.8h2.6"/>',

  // 7. 纯文本：无折角文档 + 四行
  text:
    `<path d="${PLAIN_PAGE}"/>` +
    '<path d="M5.9 5.4h4.2"/><path d="M5.9 7.6h4.2"/><path d="M5.9 9.8h4.2"/><path d="M5.9 12h2.2"/>',

  // 8. 表格：文档 + 网格
  sheet:
    `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
    '<rect x="5.4" y="6.6" width="5.2" height="6" rx="0.5"/>' +
    '<path d="M5.4 8.6h5.2"/><path d="M8 6.6v6"/>',

  // 9. 演示文稿：投影板 + 支架（无页框，形状自成一类）
  slides:
    '<path d="M2.4 4.4a.8.8 0 0 1 .8-.8h9.6a.8.8 0 0 1 .8.8v5.6a.8.8 0 0 1-.8.8H3.2a.8.8 0 0 1-.8-.8z"/>' +
    '<path d="M8 10.8v2.4"/><path d="M5.6 13.6h4.8"/>',

  // 10. PDF：文档 + 一行 + 实心印章（实心块是它和 word 的区分点）
  pdf:
    `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
    '<path d="M5.9 7.4h4.2"/>' +
    '<rect x="5.6" y="9.4" width="4.8" height="2.8" rx="0.7" fill="currentColor"/>',

  // 11. 图片：相框 + 太阳 + 山
  image:
    '<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.2"/>' +
    '<circle cx="5.9" cy="6.6" r="1.05"/>' +
    '<path d="M3.2 12.3 6.6 8.8l1.9 2.1 2-2.3 2.5 3.7"/>',

  // 12. 视频：画面 + 播放三角
  video:
    '<rect x="2.4" y="3.6" width="11.2" height="8.8" rx="1.2"/>' +
    '<path d="M6.5 6.2 10.2 8l-3.7 1.8z" fill="currentColor"/>',

  // 13. 音频：双音符（符头 + 符干 + 符梁）
  audio:
    '<circle cx="5.5" cy="11.4" r="1.15"/><circle cx="10.3" cy="10.2" r="1.15"/>' +
    '<path d="M6.65 11.4V5.8"/><path d="M11.45 10.2V4.6"/><path d="M6.65 5.8 11.45 4.6"/>',

  // 14. 压缩包：盒身 + 盒盖 + 拉链
  archive:
    '<path d="M2.6 3.2h10.8v2.4H2.6z"/><path d="M3.4 5.6h9.2v8.4H3.4z"/>' +
    '<path d="M8 5.6v3.4"/><rect x="7.3" y="9" width="1.4" height="1.8" rx="0.4"/>',

  // 15. 二进制 / 可执行 / 字体：芯片（方形本体 + 八只引脚）
  binary:
    '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.3"/>' +
    '<path d="M6.6 2.4v2"/><path d="M9.4 2.4v2"/>' +
    '<path d="M6.6 11.6v2"/><path d="M9.4 11.6v2"/>' +
    '<path d="M2.4 6.6h2"/><path d="M2.4 9.4h2"/>' +
    '<path d="M11.6 6.6h2"/><path d="M11.6 9.4h2"/>',

  // 16. 未知类型：光板文档
  other: `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>`,
}

/** 图形 → 官方色表键（16 种图形收敛到 8 个颜色 + folder） */
const SHAPE_COLOR = {
  folder: 'folder',
  code: 'code',
  json: 'code',
  markdown: 'markdown',
  html: 'html',
  doc: 'word',
  text: 'other',
  sheet: 'excel',
  slides: 'ppt',
  pdf: 'pdf',
  image: 'media',
  video: 'media',
  audio: 'media',
  archive: 'other',
  binary: 'other',
  other: 'other',
}

/* ────────────────────────────────────────────────────────────────────────
 * 扩展名 → 图形（键一律小写、不含前导点；多段扩展名整段写，如 tar.gz）
 * ──────────────────────────────────────────────────────────────────────── */
const EXT_TYPE = {
  // 源码
  js: 'code', mjs: 'code', cjs: 'code', jsx: 'code', ts: 'code', tsx: 'code',
  py: 'code', pyw: 'code', rb: 'code', go: 'code', rs: 'code', java: 'code',
  kt: 'code', kts: 'code', swift: 'code', c: 'code', h: 'code', cc: 'code',
  cpp: 'code', cxx: 'code', hpp: 'code', cs: 'code', php: 'code', lua: 'code',
  pl: 'code', r: 'code', dart: 'code', scala: 'code', groovy: 'code',
  vue: 'code', svelte: 'code',
  // 样式 / 脚本 / 配置 —— 一并归 code（形状靠内容区分成本高，颜色一致）
  css: 'code', scss: 'code', sass: 'code', less: 'code', styl: 'code',
  sh: 'code', bash: 'code', zsh: 'code', fish: 'code', ps1: 'code', psm1: 'code',
  bat: 'code', cmd: 'code', sql: 'code',
  yml: 'code', yaml: 'code', toml: 'code', ini: 'code', cfg: 'code',
  conf: 'code', env: 'code', properties: 'code', xml: 'code', plist: 'code',
  // 数据
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', geojson: 'json',
  // 文本 / 文档
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', rst: 'markdown',
  txt: 'text', text: 'text', log: 'text', nfo: 'text', srt: 'text', vtt: 'text',
  html: 'html', htm: 'html', xhtml: 'html',
  doc: 'doc', docx: 'doc', rtf: 'doc', odt: 'doc', pages: 'doc',
  xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', csv: 'sheet', tsv: 'sheet',
  ods: 'sheet', numbers: 'sheet',
  ppt: 'slides', pptx: 'slides', pps: 'slides', ppsx: 'slides', odp: 'slides', key: 'slides',
  pdf: 'pdf',
  // 图片 / 音视频
  png: 'image', jpg: 'image', jpeg: 'image', jpe: 'image', gif: 'image',
  webp: 'image', avif: 'image', svg: 'image', bmp: 'image', ico: 'image',
  tif: 'image', tiff: 'image', heic: 'image', heif: 'image', raw: 'image',
  psd: 'image', psb: 'image', ai: 'image', xd: 'image', fig: 'image', blend: 'image',
  mp4: 'video', m4v: 'video', mov: 'video', avi: 'video', mkv: 'video',
  webm: 'video', wmv: 'video', flv: 'video', mpg: 'video', mpeg: 'video', m2ts: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio',
  ogg: 'audio', oga: 'audio', opus: 'audio', wma: 'audio', mid: 'audio', midi: 'audio',
  // 压缩包
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  tgz: 'archive', bz2: 'archive', xz: 'archive', zst: 'archive', lz: 'archive',
  lzma: 'archive', cab: 'archive', iso: 'archive', jar: 'archive', war: 'archive',
  'tar.gz': 'archive', 'tar.bz2': 'archive', 'tar.xz': 'archive', 'tar.zst': 'archive',
  // 二进制 / 可执行 / 字体
  exe: 'binary', msi: 'binary', dll: 'binary', so: 'binary', dylib: 'binary',
  bin: 'binary', lnk: 'binary', app: 'binary', apk: 'binary', deb: 'binary',
  rpm: 'binary', dmg: 'binary', class: 'binary', pyc: 'binary', wasm: 'binary',
  ttf: 'binary', otf: 'binary', woff: 'binary', woff2: 'binary', eot: 'binary',
}

/* ────────────────────────────────────────────────────────────────────────
 * 文件名 → 图形（优先于扩展名）
 * ──────────────────────────────────────────────────────────────────────── */
const FILENAME_TYPE = {
  // 包/工程清单：JSON
  'package.json': 'json',
  'package-lock.json': 'json',
  'composer.json': 'json',
  'tsconfig.json': 'json',
  'jsconfig.json': 'json',
  'manifest.json': 'json',
  // 忽略文件 / 编辑器配置：纯文本
  '.gitignore': 'text',
  '.gitattributes': 'text',
  '.gitmodules': 'text',
  '.npmignore': 'text',
  '.dockerignore': 'text',
  '.eslintignore': 'text',
  '.prettierignore': 'text',
  '.editorconfig': 'text',
  // 说明文档（无扩展名的按 Markdown 惯例）
  'readme': 'markdown',
  'readme.md': 'markdown',
  'agents.md': 'markdown',
  'claude.md': 'markdown',
  'contributing.md': 'markdown',
  'changelog.md': 'markdown',
  'code_of_conduct.md': 'markdown',
  'security.md': 'markdown',
  // 许可证 / 法务文本
  license: 'text',
  licence: 'text',
  copying: 'text',
  notice: 'text',
  authors: 'text',
  'license.md': 'markdown',
  'license.txt': 'text',
  // 构建脚本
  dockerfile: 'code',
  makefile: 'code',
  rakefile: 'code',
  gemfile: 'code',
  vagrantfile: 'code',
  procfile: 'code',
  'cmakelists.txt': 'code',
  '.env': 'code',
}

/** 前缀规则：Dockerfile.prod / .env.local 这类 */
const FILENAME_PREFIX_TYPE = [
  ['dockerfile', 'code'],
  ['.env', 'code'],
  ['makefile', 'code'],
]

/** SVG 外壳：16×16、currentColor、aria-hidden（图形本体之外的一切） */
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" ' +
  'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" focusable="false">'
const SVG_CLOSE = '</svg>'

/** 预拼成完整 inline SVG（图形本体 + 外壳）：ICON_TABLE.shapes 与门禁扫描都用它 */
const SHAPE_MARKUP = Object.keys(SHAPE_SVG).reduce((acc, name) => {
  acc[name] = SVG_OPEN + SHAPE_SVG[name] + SVG_CLOSE
  return acc
}, {})

/* ════════════════════════════════════════════════════════════════════════
 * ICON_TABLE —— 图标表的**单一真相源**
 *
 * 纯 JSON 可序列化：只有字符串 / 对象 / 数组，**没有函数、没有正则**
 * （`JSON.parse(JSON.stringify(ICON_TABLE))` 往返后行为逐字节一致，见自测）。
 *
 * 内联进 lib/client.js 时把 `ICON_TABLE` 与 `buildIconResolver` 两段源码
 * 原样粘贴即可 —— 数据与逻辑都在，不需要人工翻译任何一步。
 * ════════════════════════════════════════════════════════════════════════ */
export const ICON_TABLE = {
  /** 色键 → CSS 值（官方 token，无 hex） */
  colors: { ...FILE_TYPE_COLORS },
  /** 图形键 → 色键 */
  shapeColor: { ...SHAPE_COLOR },
  /** 图形键 → 完整 inline SVG 字符串（已含外壳，开箱即用） */
  shapes: { ...SHAPE_MARKUP },
  /** 扩展名（小写、无点、可多段）→ 图形键 */
  extensions: { ...EXT_TYPE },
  /** 完整文件名（小写）→ 图形键，优先于扩展名 */
  filenames: { ...FILENAME_TYPE },
  /** 文件名前缀 → 图形键（Dockerfile.prod / .env.local） */
  filenamePrefixes: FILENAME_PREFIX_TYPE.map((pair) => [pair[0], pair[1]]),
  /** 目录用的图形键 */
  dirType: 'folder',
  /** 认不出来时回落的图形键 */
  fallback: 'other',
}

/**
 * 由一张表造出解析函数 —— **自包含**（不引用本文件任何私有 helper），
 * 因此可以整段复制进 `lib/client.js`。
 *
 * @param {object} [table] 形如 `ICON_TABLE` 的纯数据表
 * @returns {(name: string, isDirectory?: boolean) => { svg: string, color: string }}
 *   返回值恰好 `{ svg, color }`；另挂了 `.typeOf(name, isDirectory)` 便于排查
 */
export function buildIconResolver(table) {
  const t = table || {}
  const shapes = t.shapes || {}
  const colors = t.colors || {}
  const shapeColor = t.shapeColor || {}
  const extMap = t.extensions || {}
  const nameMap = t.filenames || {}
  const prefixes = Array.isArray(t.filenamePrefixes) ? t.filenamePrefixes : []
  const fallback = shapes[t.fallback] ? t.fallback : 'other'
  const dirType = shapes[t.dirType] ? t.dirType : fallback

  /** 取路径最后一段（客户端里不能 import node:path） */
  function baseName(name) {
    const s = String(name == null ? '' : name).replace(/[\\/]+$/, '')
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
    return i === -1 ? s : s.slice(i + 1)
  }

  /** 扩展名候选，最长优先：a.tar.gz → ['tar.gz', 'gz'] */
  function candidates(base) {
    const out = []
    const parts = base.split('.')
    for (let i = 1; i < parts.length; i++) {
      const cand = parts.slice(i).join('.')
      if (cand) out.push(cand)
    }
    return out.sort((a, b) => b.length - a.length)
  }

  /** 判定图形键 */
  function typeOf(name, isDirectory) {
    const raw = String(name == null ? '' : name)
    if (isDirectory || /[\\/]$/.test(raw)) return dirType

    const base = baseName(raw).toLowerCase()
    if (!base) return fallback

    const exact = nameMap[base]
    if (exact) return exact

    for (let i = 0; i < prefixes.length; i++) {
      const pair = prefixes[i]
      if (pair && typeof pair[0] === 'string' && base.indexOf(pair[0]) === 0) return pair[1]
    }

    // 无扩展名的裸文件：只有文件名规则认得出（LICENSE / Dockerfile …），
    // 其余一律当未知类型 —— 不去猜内容
    const list = candidates(base)
    for (let i = 0; i < list.length; i++) {
      const hit = extMap[list[i]]
      if (hit) return hit
    }
    return fallback
  }

  function resolve(name, isDirectory) {
    const type = typeOf(name, isDirectory)
    const colorKey = shapeColor[type] || fallback
    return {
      svg: shapes[type] || shapes[fallback] || '',
      color: colors[colorKey] || colors[fallback] || '',
    }
  }
  resolve.typeOf = typeOf
  resolve.extensionCandidates = function (name) {
    return candidates(baseName(String(name == null ? '' : name)).toLowerCase())
  }
  return resolve
}

/** 模块级解析器：与内联版 `buildIconResolver(ICON_TABLE)` 完全等价 */
const resolveIcon = buildIconResolver(ICON_TABLE)

/**
 * 按文件名取图标与颜色。
 *
 * @param {string} name 文件名或路径（路径只取最后一段）
 * @param {boolean} [isDirectory] 是否目录
 * @returns {{ svg: string, color: string }}
 *   svg   —— 16×16 inline SVG 字符串，stroke/fill 用 currentColor
 *   color —— `var(--dsw-static-*)` 或 `rgb(139,118,246)`，**不含 hex**
 */
export function iconForName(name, isDirectory) {
  const hit = resolveIcon(name, isDirectory)
  // 冻结契约：只回 { svg, color }，多一个字段都不要
  return { svg: hit.svg, color: hit.color }
}

/**
 * 判定图形键（folder / code / json / …）—— 调试与自测用，不在冻结契约内。
 */
export function fileTypeOf(name, isDirectory) {
  return resolveIcon.typeOf(name, isDirectory)
}

/**
 * 扩展名候选，最长优先：`extensionCandidates('a.tar.gz')` → `['tar.gz','gz']`
 */
export function extensionCandidates(name) {
  return resolveIcon.extensionCandidates(name)
}
