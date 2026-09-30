/**
 * dsh-artifact-library — lib/icons.js 自测
 *
 * 钉住三件事：
 *   1. 冻结契约：`iconForName(name, isDirectory) → { svg, color }`，色值无 hex
 *   2. 分支正确：gz / json / folder / 未知回落 other —— **分支**，不是仅"非空"
 *   3. 可内联：`ICON_TABLE` 是纯 JSON 数据，`buildIconResolver(table)` 自包含，
 *      把表 JSON 往返一遍后结果与 `iconForName` 逐字节一致（ui-core 内联的依据）
 *
 * 运行：node test/icons.test.mjs
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  iconForName,
  fileTypeOf,
  extensionCandidates,
  buildIconResolver,
  ICON_TABLE,
  FILE_TYPE_COLORS,
} from '../lib/icons.js'

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error)))
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed')
}

const SRC = fileURLToPath(new URL('../lib/icons.js', import.meta.url))
const COLOR_RE = /^(var\(--dsw-static-[a-z0-9-]+\)|rgb\(139,\s*118,\s*246\))$/

// 回流用的样本：ICON_TABLE 里的每个扩展名 / 文件名 + 目录 + 未知
const ALL_EXTS = Object.keys(ICON_TABLE.extensions)
const ALL_NAMES = Object.keys(ICON_TABLE.filenames)
const SAMPLES = [
  ...ALL_EXTS.map((e) => ['sample.' + e, false]),
  ...ALL_NAMES.map((n) => [n, false]),
  ...ALL_NAMES.map((n) => [n.toUpperCase(), false]),
  ['a.tar.gz', false], ['C:\\dir\\a.tar.bz2', false], ['/x/y/README.md', false],
  ['', false], ['noext', false], ['unknown.qqq', false], ['weird.', false],
  ['somedir', true], ['folder/', false], ['src/components/', false],
]

/* ── 1. 冻结契约 ───────────────────────────────────────────────────────── */
check('[契约] iconForName 返回且仅返回 { svg, color }', () => {
  const r = iconForName('a.tar.gz', false)
  assert(r && typeof r === 'object', '不是对象')
  assert(JSON.stringify(Object.keys(r).sort()) === '["color","svg"]', '字段多了或少了：' + Object.keys(r))
  assert(typeof r.svg === 'string' && typeof r.color === 'string', '字段类型不对')
})

check('[契约] FILE_TYPE_COLORS 十个键齐全且值只用官方 token（无 hex）', () => {
  const want = ['code', 'markdown', 'html', 'excel', 'word', 'ppt', 'pdf', 'media', 'folder', 'other']
  assert(Object.keys(FILE_TYPE_COLORS).join() === want.join(), '键不符：' + Object.keys(FILE_TYPE_COLORS))
  for (const [k, v] of Object.entries(FILE_TYPE_COLORS)) {
    assert(!v.includes('#'), k + ' 含 hex：' + v)
    assert(COLOR_RE.test(v), k + ' 不是官方 token：' + v)
  }
})

check('[一.1] 所有样本的 color 都不含 # 且是官方 token', () => {
  const bad = []
  for (const [name, isDir] of SAMPLES) {
    const { color } = iconForName(name, isDir)
    if (color.includes('#')) bad.push(name + '→' + color)
    if (!COLOR_RE.test(color)) bad.push(name + '→' + color)
  }
  assert(bad.length === 0, bad.slice(0, 3).join(' , ') + (bad.length > 3 ? ' …+' + (bad.length - 3) : ''))
})

check('[规格] svg 是 16×16 inline SVG、currentColor、纯 ASCII（无 emoji）', () => {
  const bad = []
  for (const [name, isDir] of SAMPLES) {
    const { svg } = iconForName(name, isDir)
    if (!svg.startsWith('<svg ') || !svg.endsWith('</svg>')) bad.push(name + ':外壳')
    if (!svg.includes('width="16" height="16"') || !svg.includes('viewBox="0 0 16 16"')) bad.push(name + ':尺寸')
    if (!svg.includes('stroke="currentColor"')) bad.push(name + ':颜色')
    if (/[^\x20-\x7E]/.test(svg)) bad.push(name + ':非 ASCII/emoji')
  }
  assert(bad.length === 0, bad.slice(0, 3).join(' , '))
})

/* ── 2. 分支正确性（lead 指定的四条） ──────────────────────────────────── */
check("[gz 分支] iconForName('a.tar.gz') 走压缩包（= .gz/.zip 的形状，不是 other）", () => {
  const got = iconForName('a.tar.gz', false)
  const gz = iconForName('plain.gz', false)
  const zip = iconForName('plain.zip', false)
  const other = iconForName('unknown.qqq', false)
  assert(fileTypeOf('a.tar.gz', false) === 'archive', '图形键不是 archive：' + fileTypeOf('a.tar.gz', false))
  assert(got.svg === gz.svg && got.svg === zip.svg, 'svg 与压缩包类不一致')
  assert(got.svg !== other.svg, '落到了通用 other 图标')
  assert(extensionCandidates('a.tar.gz').join() === 'tar.gz,gz', '未按最长扩展名优先：' + extensionCandidates('a.tar.gz'))
})

check("[json 分支] iconForName('package.json') 走 JSON（= .json 的形状，不是 other）", () => {
  const got = iconForName('package.json', false)
  const json = iconForName('tsconfig.json', false)
  const other = iconForName('unknown.qqq', false)
  assert(fileTypeOf('package.json', false) === 'json', '图形键不是 json：' + fileTypeOf('package.json', false))
  assert(got.svg === json.svg, 'svg 与 .json 不一致')
  assert(got.svg !== other.svg, '落到了通用 other 图标')
  assert(got.color === FILE_TYPE_COLORS.code, 'json 应为 code 色：' + got.color)
})

check('[folder 分支] iconForName(任意, isDirectory=true) 走目录', () => {
  const got = iconForName('x', true)
  assert(fileTypeOf('x', true) === 'folder', '图形键不是 folder：' + fileTypeOf('x', true))
  assert(got.color === FILE_TYPE_COLORS.folder, '目录色不对：' + got.color)
  assert(got.svg === iconForName('any-directory-name', true).svg, '目录形状不稳定')
  assert(got.svg === iconForName('trailing/', false).svg, '末尾斜杠未按目录处理')
})

check("[other 回落] iconForName('unknown.qqq') 走通用文件图标", () => {
  const got = iconForName('unknown.qqq', false)
  const other = iconForName('totally.unknown', false)
  assert(fileTypeOf('unknown.qqq', false) === 'other', '图形键不是 other：' + fileTypeOf('unknown.qqq', false))
  assert(got.svg === other.svg, '未知类型之间形状不一致')
  assert(got.color === FILE_TYPE_COLORS.other, '未知类型色不对：' + got.color)
})

check('[文件名优先] package.json / .gitignore / README.md / AGENTS.md / LICENSE / Dockerfile / Makefile', () => {
  const want = {
    'package.json': 'json', '.gitignore': 'text', 'README.md': 'markdown', 'AGENTS.md': 'markdown',
    LICENSE: 'text', Dockerfile: 'code', Makefile: 'code', 'README': 'markdown',
  }
  const bad = Object.entries(want).filter(([n, t]) => fileTypeOf(n, false) !== t).map(([n, t]) => n + '≠' + t)
  assert(bad.length === 0, bad.join(' , '))
})

/* ── 2b. task-2 交付清单：57 个扩展名逐个核对期望图形 ──────────────────── */
const SPEC_SHAPE = {
  '.md': 'markdown', '.txt': 'text', '.json': 'json',
  '.js': 'code', '.mjs': 'code', '.cjs': 'code', '.ts': 'code', '.tsx': 'code', '.jsx': 'code',
  '.py': 'code', '.css': 'code', '.scss': 'code', '.sh': 'code', '.ps1': 'code', '.bat': 'code',
  '.yml': 'code', '.yaml': 'code', '.toml': 'code', '.xml': 'code', '.sql': 'code', '.html': 'html',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.svg': 'image', '.bmp': 'image', '.ico': 'image',
  '.mp4': 'video', '.mov': 'video', '.avi': 'video', '.mkv': 'video', '.webm': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.flac': 'audio',
  '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc',
  '.xls': 'sheet', '.xlsx': 'sheet', '.ppt': 'slides', '.pptx': 'slides',
  '.zip': 'archive', '.rar': 'archive', '.7z': 'archive', '.tar': 'archive', '.gz': 'archive',
  '.exe': 'binary', '.dll': 'binary', '.lnk': 'binary',
  '.psd': 'image', '.ai': 'image', '.blend': 'image',
  '.ttf': 'binary', '.otf': 'binary',
}

check('[覆盖] task-2 清单 57 个扩展名，逐个核对期望图形', () => {
  assert(Object.keys(SPEC_SHAPE).length === 57, '清单条数不是 57：' + Object.keys(SPEC_SHAPE).length)
  const bad = Object.entries(SPEC_SHAPE)
    .filter(([ext, shape]) => fileTypeOf('file' + ext, false) !== shape)
    .map(([ext, shape]) => ext + ' 得 ' + fileTypeOf('file' + ext, false) + ' 期望 ' + shape)
  assert(bad.length === 0, bad.join(' , '))
})

check('[§2.4] 官方色表逐项对齐（excel/word/ppt/pdf/media/folder/other）', () => {
  const want = {
    '.xlsx': 'excel', '.xls': 'excel', '.docx': 'word', '.pptx': 'ppt', '.pdf': 'pdf',
    '.png': 'media', '.mp4': 'media', '.mp3': 'media',
    '.zip': 'other', '.exe': 'other', '.txt': 'other',
    '.md': 'markdown', '.html': 'html', '.json': 'code', '.js': 'code',
  }
  const bad = Object.entries(want)
    .filter(([ext, key]) => iconForName('f' + ext, false).color !== FILE_TYPE_COLORS[key])
    .map(([ext, key]) => ext + ' 得 ' + iconForName('f' + ext, false).color + ' 期望 ' + FILE_TYPE_COLORS[key])
  assert(bad.length === 0, bad.join(' , '))
})

/* ── 3. 可内联性（ui-core 内联方案的依据） ─────────────────────────────── */
check('[内联] ICON_TABLE 是纯 JSON 数据（无函数/正则），往返后逐字节相等', () => {
  const json = JSON.stringify(ICON_TABLE)
  assert(typeof json === 'string' && json.length > 1000, 'JSON 序列化异常')
  const back = JSON.parse(json)
  assert(JSON.stringify(back) === json, '往返后有损失（可能有函数/正则/undefined）')
  assert(JSON.stringify(back).indexOf('function') === -1, '表里混进了函数')
  for (const [shape, svg] of Object.entries(back.shapes)) {
    assert(typeof svg === 'string' && svg.startsWith('<svg '), shape + ' 的 svg 不是完整字符串')
  }
})

check('[内联] buildIconResolver(JSON 往返表) 与 iconForName 逐字节一致', () => {
  const resolve = buildIconResolver(JSON.parse(JSON.stringify(ICON_TABLE)))
  const bad = []
  for (const [name, isDir] of SAMPLES) {
    const a = iconForName(name, isDir)
    const b = resolve(name, isDir)
    if (a.svg !== b.svg || a.color !== b.color) bad.push(String(name))
    if (JSON.stringify(Object.keys(b).sort()) !== '["color","svg"]') bad.push(String(name) + ':字段')
  }
  assert(bad.length === 0, bad.slice(0, 3).join(' , '))
})

check('[内联] buildIconResolver 自包含：在「没有模块私有作用域」的环境里照样能跑', () => {
  // 只把函数的**源码**取出来，用 new Function 在全局作用域里重建 —— 模块私有的
  // SHAPE_INNER / EXT_TYPE / FILE_TYPE_COLORS / baseName… 在这里都不存在。
  // 能跑且结果与 iconForName 一致，才证明这段能整段粘进 client.js。
  const rebuild = new Function('table', 'return (' + String(buildIconResolver) + ')(table)')
  const isolated = rebuild(JSON.parse(JSON.stringify(ICON_TABLE)))
  const bad = []
  for (const [name, isDir] of SAMPLES) {
    const a = iconForName(name, isDir)
    const b = isolated(name, isDir)
    if (a.svg !== b.svg || a.color !== b.color) bad.push(String(name))
  }
  assert(bad.length === 0, '隔离环境结果不一致：' + bad.slice(0, 3).join(' , '))
  // 再静态确认没有直接引用模块级私有常量名
  const body = String(buildIconResolver)
  for (const leaked of ['SHAPE_INNER', 'SHAPE_COLOR', 'EXT_TYPE', 'FILENAME_TYPE', 'FILENAME_PREFIX_TYPE', 'SVG_OPEN', 'FILE_TYPE_COLORS', 'resolveIcon']) {
    assert(!body.includes(leaked), '函数体引用了模块私有名字：' + leaked)
  }
})

check('[映射] 每个扩展名/文件名都指向真实存在的图形（不是通用 other）', () => {
  const fallbackSvg = iconForName('zzz.unknown', false).svg
  const dangling = []
  for (const ext of ALL_EXTS) {
    if (ICON_TABLE.extensions[ext] === 'other') continue
    if (iconForName('f.' + ext, false).svg === fallbackSvg) dangling.push('.' + ext)
  }
  for (const n of ALL_NAMES) {
    if (ICON_TABLE.filenames[n] === 'other') continue
    if (iconForName(n, false).svg === fallbackSvg) dangling.push(n)
  }
  assert(dangling.length === 0, dangling.slice(0, 5).join(' ') + '（映射值写错，落到通用图标）')
})

check('[映射] 恰好 16 种语义图形，且每种都有配色', () => {
  const shapes = Object.keys(ICON_TABLE.shapes)
  assert(shapes.length === 16, '图形数不是 16：' + shapes.length + ' → ' + shapes.join(','))
  for (const s of shapes) {
    assert(ICON_TABLE.shapeColor[s], s + ' 没有配色键')
    assert(FILE_TYPE_COLORS[ICON_TABLE.shapeColor[s]], s + ' 的配色键不在 FILE_TYPE_COLORS 里')
  }
  assert(shapes.includes(ICON_TABLE.fallback), 'fallback 图形不存在')
  assert(shapes.includes(ICON_TABLE.dirType), 'dirType 图形不存在')
})

check('[一.1] lib/icons.js 源码本身不含 hex 颜色字面量', () => {
  // 由前面的用例已覆盖取值层面；这里再确认源码里没有 #rrggbb / #rgb
  const src = fs.readFileSync(SRC, 'utf8')
  const hits = src.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  assert(hits.length === 0, '源码出现 hex：' + hits.join(' '))
})

check('[健壮性] 非法输入不抛异常', () => {
  for (const bad of [undefined, null, '', 0, 123, {}, [], 'a'.repeat(500)]) {
    const r = iconForName(bad, false)
    assert(r && typeof r.svg === 'string' && typeof r.color === 'string', '返回异常：' + String(bad))
  }
})

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败')
process.exit(failed ? 1 : 0)
