/**
 * dsh-artifact-library · UI 规范回归测试
 * 把 `docs/UI-SPEC-v1.md` 里**可静态断言**的条款钉成 14 条，每条指向规范原文。
 *
 * 为什么要有它：
 *   UI 重构（行高 110→32px、去冗余路径、token 化、按类型图标、自然序…）全靠人眼核对，
 *   改着改着就会悄悄偏离规范。这个文件是「规范守门人」——让偏离当场可见。
 *
 * 它**不是**「文件存在就算过」的烟雾测试：
 *   · 每条断言都带 [§x.y] 条款号，失败信息写清违反了哪一条
 *   · 允许先红后绿 —— 队友改造期间失败是**预期结果**，不要为它放宽断言
 *
 * 14 条 ↔ 规范条款对照：
 *   [§一.1]  禁止 hex 颜色（client.js）
 *   [§一.1]  禁止自造 --alf-* token
 *   [§一.5]  禁止 `from "react"` 字面量（必须走 module-loader 借宿主 React）
 *   [§2.1-2.3] 必须出现官方 --dsw-* token
 *   [§3.1/3.7] 目录行高常量落在 24~44px
 *   [§2.4/一.4] lib/icons.js 冻结接口 + 返回值形状 + 无 emoji + 声明扩展名全覆盖
 *   [§2.4/一.1] lib/icons.js 颜色只用官方 token（无 hex）
 *   [§3.6]   Intl.Collator(...{numeric:true}) 自然序
 *   [§三.3/§七] 无障碍：aria-label / role=tree|grid / aria-current
 *   [§3.1/3.2] 省略号 + min-width:0（flex 省略号生效的必要条件）
 *   [§2.4]   图标映射的值必须指向已定义的图形；内联副本与 lib/icons.js 同源（防静默 fallback）
 *   [宿主边界] 禁止把 data-density 写到宿主 <body>/<html> 上
 *   [§一.1]  不得**无兜底**消费「宿主未定义的幽灵 token」（实证名单：--dsw-font-mono）
 *   [§3.7/§七] 虚拟滚动：aria-rowcount 取全量、aria-rowindex 取绝对 1-based 下标
 *
 * 运行：node test/ui-spec.test.mjs [client.js 路径]
 * 退出码：有失败 → 1
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_PATH = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'lib', 'client.js');
const ICONS_PATH = path.join(ROOT, 'lib', 'icons.js');

const OWNER_CLIENT = 'ui-core（lib/client.js）';
const OWNER_ICONS = 'icon-smith（lib/icons.js）';
const OWNER_TABLES = 'icon-smith（源 lib/icons.js）/ ui-core（内联副本 lib/client.js）';

// ── 断言框架（输出格式对齐 test/client-apply.test.mjs）────────────────────
let passed = 0;
let failed = 0;
const failureList = [];

function check(spec, title, owner, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + spec + ' ' + title);
  } catch (error) {
    failed += 1;
    const message = error && error.message ? error.message : String(error);
    failureList.push({ spec, title, owner, message });
    console.log('  FAIL ' + spec + ' ' + title + ' → ' + message + '  [应修：' + owner + ']');
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

// ── 源码工具 ──────────────────────────────────────────────────────────────

/**
 * 去掉 JS 注释（**逐字符 1:1 替换**，保证去掉后行号不变）。
 * 保留字符串内容 —— hex 颜色就住在字符串里，不能连它一起删。
 * 注：JS 里 `//` 与 `/*` 永远是注释（空正则字面量在 JS 里非法），
 * 所以不需要区分「除号 / 正则字面量」。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += c2 === undefined ? '' : c2; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** 找 hex 颜色字面量；排除路径锚点（`foo#abc`）等非颜色用法。 */
const HEX_RE = /#([0-9a-fA-F]{3,8})\b/g;
function findHexColors(src) {
  const hits = [];
  const re = new RegExp(HEX_RE.source, 'g');
  let m;
  while ((m = re.exec(src))) {
    if (![3, 4, 6, 8].includes(m[1].length)) continue; // 合法 CSS hex 长度
    const before = src[m.index - 1];
    if (before && /[A-Za-z0-9_$]/.test(before)) continue; // 排除 foo#abc / 文档锚点
    hits.push({ text: m[0], index: m.index });
  }
  return hits;
}

function fmtHits(hits, src, file) {
  const head = hits
    .slice(0, 8)
    .map((h) => path.basename(file) + ':' + lineOf(src, h.index) + ' `' + h.text + '`')
    .join('、');
  return head + (hits.length > 8 ? '…（共 ' + hits.length + ' 处）' : '');
}

/**
 * 把 client.js 里 `var css = [ ".x{" , "  color:red;" , "}" ].join()` 的
 * 字符串拼回一整段 CSS（NS 变量还原成 "alf"），这样才谈得上「作用域」。
 */
function extractCssText(src) {
  const start = src.indexOf('var css = [');
  if (start < 0) return '';
  const end = src.indexOf('].join(', start);
  if (end < 0) return '';
  const region = src.slice(start, end).replace(/\bNS\b/g, 'alf');
  const parts = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(region))) parts.push(m[1].replace(/\\(.)/g, '$1'));
  return parts.join('');
}

/** 极简 CSS 规则切分：`选择器{声明}`（含 @media 时会把内层当声明，够用） */
function cssRules(cssText) {
  const rules = [];
  const re = /([^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cssText))) rules.push({ selector: m[1].trim(), body: m[2] });
  return rules;
}

// ── 载入被测源码 ──────────────────────────────────────────────────────────
if (!fs.existsSync(CLIENT_PATH)) {
  console.error('找不到被测文件：' + CLIENT_PATH);
  process.exit(2);
}

const CLIENT_RAW = fs.readFileSync(CLIENT_PATH, 'utf8');
const CLIENT_SRC = stripComments(CLIENT_RAW);
const CSS_TEXT = extractCssText(CLIENT_SRC);
const CSS_RULES = cssRules(CSS_TEXT);

/** lib/icons.js 是 ESM 独立模块，先真 import 一次，供第 6/7 条复用。 */
const icons = { exists: fs.existsSync(ICONS_PATH), ok: false, mod: null, error: null, src: '' };
if (icons.exists) {
  icons.src = fs.readFileSync(ICONS_PATH, 'utf8');
  try {
    icons.mod = await import(pathToFileURL(ICONS_PATH).href);
    icons.ok = true;
  } catch (error) {
    icons.error = error;
  }
}
function iconExports() {
  const mod = icons.mod || {};
  const dflt = mod.default || {};
  return {
    iconForName: typeof mod.iconForName === 'function' ? mod.iconForName : dflt.iconForName,
    colors: mod.FILE_TYPE_COLORS || dflt.FILE_TYPE_COLORS,
  };
}

/**
 * 取出图标数据表。
 *
 * 为什么要在 vm 里真跑一遍：第 11 条要查的是「映射表的值是否都指向已定义的图形」，
 * 这正是 `.ppt → 'ppt'`（图形键叫 `slides`）掉灰色通用图标那类**静默 bug** ——
 * 旧断言只查「不是 other」，全绿也发现不了。正则解析对象字面量太脆，直接求值最可靠。
 * 被求值的两处都是纯数据 + 纯函数、零 import 零副作用。
 *
 * 兼容两种表形态：导出的单一真相源 `ICON_TABLE`（新），或散落的
 * SHAPE_SVG/SHAPE_INNER + EXT_TYPE + FILENAME_TYPE（旧）。改结构不该让断言失明。
 */
function evalIconTables(source, label) {
  const code = source
    .replace(/^[ \t]*export[ \t]+const[ \t]+/gm, 'const ')
    .replace(/^[ \t]*export[ \t]+function[ \t]+/gm, 'function ')
    .replace(/^[ \t]*import[^\n]*$/gm, '');
  const names = [
    'ICON_TABLE', 'FILE_TYPE_COLORS', 'SHAPE_SVG', 'SHAPE_INNER', 'SHAPE_COLOR', 'SHAPE_MARKUP',
    'EXT_TYPE', 'FILENAME_TYPE', 'FILENAME_PREFIX_TYPE',
  ];
  const ret = 'return {' + names.map((n) => n + ': typeof ' + n + ' === "undefined" ? null : ' + n).join(', ') + '}';
  const sandbox = { console: { log() {}, warn() {}, error() {} } };
  vm.createContext(sandbox);
  return vm.runInContext('(function(){' + code + '\n' + ret + ';})()', sandbox, { filename: label });
}

/** 归一成 { shapes, shapeColor, extensions, filenames, filenamePrefixes, colors }。 */
function normalizeIconTable(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw.ICON_TABLE && typeof raw.ICON_TABLE === 'object' ? raw.ICON_TABLE : raw;
  return {
    shapes: t.shapes || raw.SHAPE_SVG || raw.SHAPE_INNER || null,
    shapeColor: t.shapeColor || raw.SHAPE_COLOR || null,
    extensions: t.extensions || raw.EXT_TYPE || null,
    filenames: t.filenames || raw.FILENAME_TYPE || null,
    filenamePrefixes: t.filenamePrefixes || raw.FILENAME_PREFIX_TYPE || null,
    colors: t.colors || raw.FILE_TYPE_COLORS || null,
  };
}

/** client.js 里内联的图标块（夹在 INLINE-ICONS-BEGIN / END 之间，由生成器写出）。 */
function inlineIconBlock(src) {
  const begin = src.indexOf('INLINE-ICONS-BEGIN');
  const end = src.indexOf('INLINE-ICONS-END');
  if (begin < 0 || end < 0 || end < begin) return '';
  return src.slice(src.indexOf('\n', begin) + 1, src.lastIndexOf('\n', end));
}

const INLINE_ICON_SRC = inlineIconBlock(CLIENT_RAW);

/** 两侧的图标表：源（lib/icons.js）与内联副本（lib/client.js）。 */
function loadIconTables() {
  const out = { icons: { table: null, error: null, via: '' }, inline: { table: null, error: null, via: '' } };

  if (!icons.exists) {
    out.icons.error = new Error('lib/icons.js 不存在');
  } else {
    const mod = icons.mod || {};
    const dflt = mod.default || {};
    const exported = mod.ICON_TABLE || dflt.ICON_TABLE;
    if (exported && typeof exported === 'object') {
      out.icons.table = normalizeIconTable({ ICON_TABLE: exported, FILE_TYPE_COLORS: mod.FILE_TYPE_COLORS || dflt.FILE_TYPE_COLORS });
      out.icons.via = 'export ICON_TABLE';
    } else {
      try {
        out.icons.table = normalizeIconTable(evalIconTables(icons.src, 'lib/icons.js'));
        out.icons.via = 'vm 求值源码';
      } catch (error) {
        out.icons.error = error;
      }
    }
  }

  if (!INLINE_ICON_SRC) {
    out.inline.error = new Error('未找到 INLINE-ICONS-BEGIN / INLINE-ICONS-END 标记');
  } else {
    try {
      out.inline.table = normalizeIconTable(evalIconTables(INLINE_ICON_SRC, 'lib/client.js#inline-icons'));
      out.inline.via = 'vm 求值内联块';
    } catch (error) {
      out.inline.error = error;
    }
  }
  return out;
}

const TABLES = loadIconTables();

function errText(error) {
  return error && error.message ? error.message : String(error);
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

console.log('\n═══ UI-SPEC-v1 静态规范回归 ═══');
console.log(' 规范：docs/UI-SPEC-v1.md');
console.log(' 被测：' + CLIENT_PATH);
console.log('       ' + (icons.exists ? ICONS_PATH : ICONS_PATH + '（尚不存在）'));

// ── [1] 禁止 hex 颜色 ─────────────────────────────────────────────────────
console.log('\n[1/14] 禁止第二套配色');
check('[§一.1]', 'lib/client.js 不出现 hex 颜色字面量', OWNER_CLIENT, () => {
  const hits = findHexColors(CLIENT_SRC);
  assert(
    hits.length === 0,
    '发现 ' + hits.length + ' 处 hex —— 违反 §一.1「只用 --dsw-* 宿主 token，禁止任何 hex」：' + fmtHits(hits, CLIENT_SRC, CLIENT_PATH)
  );
});

// ── [2] 禁止自造 --alf-* token ────────────────────────────────────────────
console.log('\n[2/14] 禁止自造 token');
check('[§一.1]', '不出现自造 CSS 变量 --alf-*', OWNER_CLIENT, () => {
  const hits = [];
  const re = /--alf-[\w-]*/g;
  let m;
  while ((m = re.exec(CLIENT_SRC))) hits.push({ text: m[0], index: m.index });
  assert(
    hits.length === 0,
    '发现 ' + hits.length + ' 处自造 token —— 违反 §一.1「清掉自造的 --alf-*，只用 --dsw-*」：' + fmtHits(hits, CLIENT_SRC, CLIENT_PATH)
  );
});

// ── [3] 禁止 react 字面量 import ──────────────────────────────────────────
console.log('\n[3/14] 客户端 React 来源');
check('[§一.5]', '不出现 `from "react"` 字面量（必须走 module-loader）', OWNER_CLIENT, () => {
  const patterns = [
    { re: /from\s*['"]react['"]/g, label: 'from "react"' },
    { re: /import\s*\(\s*['"]react['"]\s*\)/g, label: 'import("react")' },
    { re: /import\s+['"]react['"]/g, label: 'import "react"' },
  ];
  const hits = [];
  for (const { re, label } of patterns) {
    let m;
    while ((m = re.exec(CLIENT_SRC))) hits.push({ text: label, index: m.index });
  }
  assert(
    hits.length === 0,
    '发现 ' + hits.length + ' 处 react 字面量导入 —— 违反 §一.5「会打进第二份 React，每个 hook 都 Invalid hook call；必须走 module-loader」（合法写法只有 require(<拼接 specifier>)）：' +
      fmtHits(hits, CLIENT_SRC, CLIENT_PATH)
  );
});

// ── [4] 必须用官方 token ──────────────────────────────────────────────────
console.log('\n[4/14] 官方 token 消费');
check('[§2.1-2.3]', '圆角/文字/交互/描边四类 --dsw-* token 均已消费', OWNER_CLIENT, () => {
  const required = [
    ['--dsw-radius-', '§2.1 圆角（sm8/md12/lg16）'],
    ['--dsw-alias-label-', '§2.3 文字层级（label-primary/secondary/tertiary）'],
    ['--dsw-alias-interactive-bg-hover', '§2.3 hover 唯一正解'],
    ['--dsw-alias-border-', '§2.3 描边 l1~l4'],
  ];
  const missing = required.filter(([token]) => !CLIENT_SRC.includes(token));
  assert(
    missing.length === 0,
    '缺少官方 token：' + missing.map(([t, why]) => t + '（' + why + '）').join('；') + ' —— 违反 §一.1/§2.x「只消费宿主 token」'
  );
});

// ── [5] 目录行高 24~44px ──────────────────────────────────────────────────
console.log('\n[5/14] 目录行高');
check('[§3.1/3.7]', '目录行高常量存在且落在 24~44px 区间', OWNER_CLIENT, () => {
  assert(
    CSS_TEXT.length > 0,
    '在 lib/client.js 里找不到样式表数组（`var css = [...]`）—— 无法校验 §3.1 的行规格'
  );

  const candidates = [];
  const push = (value, where) => {
    const num = Number(value);
    if (Number.isFinite(num)) candidates.push({ value: num, where });
  };

  // a) 行相关选择器里的 height:NNpx（排除 min-/max-height；已排除 line-height 无 px）
  const rowish = CSS_RULES.filter((r) => /(row|item|dir)/i.test(r.selector));
  for (const rule of rowish) {
    const re = /(?<![-\w])height\s*:\s*([\d.]+)px/g;
    let m;
    while ((m = re.exec(rule.body))) push(m[1], rule.selector + ' { height:' + m[1] + 'px }');
    const reVar = /(?<![-\w])height\s*:\s*var\([^)]*?([\d.]+)px\s*\)/g;
    while ((m = reVar.exec(rule.body))) push(m[1], rule.selector + ' { height:var(…, ' + m[1] + 'px) }');
  }

  // b) 行高类自定义属性：--alf-row-h:32px / --dsw-list-item-height:32px
  const reProp = /--[\w-]*(?:row|item)[\w-]*\s*:\s*([\d.]+)px/g;
  let m;
  while ((m = reProp.exec(CLIENT_SRC))) push(m[1], '自定义属性 ' + m[0]);

  // c) JS 常量：ROW_H / ROW_HEIGHT / ITEM_SIZE / rowHeight / { itemSize: 32 }
  const nameRow = /(row|item|cell)/i;
  const nameHeight = /(?:^|[_$])h(?:[_$]|$)|height|size/i;
  const reConst = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(\d+(?:\.\d+)?)\b/g;
  while ((m = reConst.exec(CLIENT_SRC))) {
    if (nameRow.test(m[1]) && nameHeight.test(m[1])) push(m[2], '常量 ' + m[1] + ' = ' + m[2]);
  }
  const reObj = /\b(row|item)[_$]?(?:h|height|size)\s*:\s*(\d+(?:\.\d+)?)/gi;
  while ((m = reObj.exec(CLIENT_SRC))) push(m[2], '属性 ' + m[0]);

  assert(
    candidates.length > 0,
    '找不到任何目录行高常量 —— 违反 §3.1「行必须显式定高（.row{height:32px}）」，也是 §3.7 定高虚拟滚动的前提（现约 110px）'
  );

  const bad = candidates.filter((c) => c.value < 24 || c.value > 44);
  assert(
    bad.length === 0,
    '行高越界（§3.1：紧凑 28 / 标准 32 / 宽松 44，区间 24~44px）：' +
      bad.map((c) => c.value + 'px @ ' + c.where).join('；')
  );
});

// ── [6] lib/icons.js 契约 ─────────────────────────────────────────────────
console.log('\n[6/14] 图标模块契约');
check('[§2.4/一.4]', 'lib/icons.js 导出 iconForName / FILE_TYPE_COLORS 且形状正确', OWNER_ICONS, () => {
  assert(
    icons.exists,
    'lib/icons.js 不存在 —— 违反 §2.4 文件类型图标色表要求（应由该模块导出 iconForName(name,isDirectory)→{svg,color} 与 FILE_TYPE_COLORS）'
  );
  assert(
    icons.ok,
    'lib/icons.js 无法 import：' + (icons.error && icons.error.message ? icons.error.message : String(icons.error))
  );

  const { iconForName, colors } = iconExports();
  assert(typeof iconForName === 'function', '未导出函数 iconForName（§2.4 类型映射的唯一入口）');
  assert(colors && typeof colors === 'object', '未导出对象 FILE_TYPE_COLORS（§2.4 官方色表）');

  for (const key of ['code', 'markdown', 'html', 'excel', 'word', 'ppt', 'pdf', 'media', 'folder', 'other']) {
    assert(key in colors, 'FILE_TYPE_COLORS 缺键 "' + key + '" —— §2.4 色表共 10 类（code/markdown/html/excel/word/ppt/pdf/media/folder/other）');
  }

  const cases = [['a.tar.gz', false], ['package.json', false], ['README.md', false], ['任意文件', true]];
  for (const [name, isDir] of cases) {
    const got = iconForName(name, isDir);
    assert(got && typeof got === 'object', 'iconForName(' + JSON.stringify(name) + ', ' + isDir + ') 未返回对象（契约：→ {svg, color}）');
    assert(
      typeof got.svg === 'string' && got.svg.includes('<svg'),
      'iconForName(' + JSON.stringify(name) + ').svg 不是 inline SVG 字符串（实得 ' + typeof got.svg + '）—— §2.4 要求 16×16 线性 SVG'
    );
    assert(
      typeof got.color === 'string' && got.color.trim().length > 0,
      'iconForName(' + JSON.stringify(name) + ').color 不是非空字符串'
    );
    assert(!EMOJI_RE.test(got.svg), 'iconForName(' + JSON.stringify(name) + ').svg 含 emoji —— 违反 §一.4「禁止 emoji 当图标」');
  }

  const dirResult = iconForName('任意文件', true);
  assert(
    dirResult.color === colors.folder,
    '目录图标颜色应等于 FILE_TYPE_COLORS.folder（' + colors.folder + '），实得 ' + dirResult.color + ' —— §2.4 folder → --dsw-static-amber-400'
  );

  // ── 覆盖度（黑盒，只走冻结接口）────────────────────────────────────────
  // 契约说「覆盖这些扩展名，认不出来才回 other」。所以声明的扩展名/文件名，
  // 回复必须与「未知文件」兜底**不同**（形状或颜色任一不同即算已覆盖）——
  // 这是第 11 条（白盒查表）之外的独立视角：值虽在图形表里，但指错了图形也照样漏。
  const EXT_LIST = (
    '.md .txt .json .js .mjs .cjs .ts .tsx .jsx .py .html .css .scss .sh .ps1 .bat ' +
    '.yml .yaml .toml .xml .sql .png .jpg .jpeg .gif .webp .svg .bmp .ico ' +
    '.mp4 .mov .avi .mkv .webm .mp3 .wav .flac .pdf .doc .docx .xls .xlsx .ppt .pptx ' +
    '.zip .rar .7z .tar .gz .exe .dll .lnk .psd .ai .blend .ttf .otf'
  ).split(' ').filter(Boolean);
  const NAME_LIST = ['package.json', '.gitignore', 'README.md', 'AGENTS.md', 'LICENSE', 'Dockerfile', 'Makefile'];

  const fallback = iconForName('__dsh_unknown_ext_zzz__', false);
  const isFallback = (r) => r.svg === fallback.svg && r.color === fallback.color;

  const uncovered = [];
  for (const ext of EXT_LIST) if (isFallback(iconForName('f' + ext, false))) uncovered.push(ext);
  for (const fileName of NAME_LIST) if (isFallback(iconForName(fileName, false))) uncovered.push(fileName);
  assert(
    uncovered.length === 0,
    '有 ' + uncovered.length + ' 个已声明扩展名/文件名落到了「未知文件」兜底图标（' + uncovered.join(' ') + '）—— 违反 §2.4 类型映射契约：认出来就该用类型图标，认不出来才回 other'
  );

  const reached = new Set();
  for (const ext of EXT_LIST) reached.add(iconForName('f' + ext, false).color);
  for (const fileName of NAME_LIST) reached.add(iconForName(fileName, false).color);
  reached.add(dirResult.color);
  reached.add(fallback.color);
  const dead = Object.keys(colors).filter((k) => !reached.has(colors[k]));
  assert(dead.length === 0, 'FILE_TYPE_COLORS 里 ' + dead.join('/') + ' 这些键没有任何输入能命中（死映射）—— §2.4 色表 10 类都应可达');
});

// ── [7] icons.js 颜色无 hex ───────────────────────────────────────────────
console.log('\n[7/14] 图标颜色来源');
check('[§2.4/一.1]', 'lib/icons.js 的 color 只来自官方 token（无 hex）', OWNER_ICONS, () => {
  assert(icons.exists, 'lib/icons.js 不存在 —— 无法校验 §2.4 色表');
  const hits = findHexColors(stripComments(icons.src));
  assert(hits.length === 0, 'icons.js 出现 hex 颜色 —— 违反 §一.1「禁止任何 hex」：' + fmtHits(hits, stripComments(icons.src), ICONS_PATH));

  assert(icons.ok, 'lib/icons.js 无法 import（无法校验运行期颜色值）');
  const { colors } = iconExports();
  assert(colors && typeof colors === 'object', '未导出 FILE_TYPE_COLORS，无法校验颜色值');

  const TOKEN = /^var\(\s*--dsw-static-[a-z0-9-]+\s*\)$/;
  const OFFICIAL_VIOLET = /^rgb\(\s*139\s*,\s*118\s*,\s*246\s*\)$/; // §2.4 官方注明 violet 无 token
  for (const [key, value] of Object.entries(colors)) {
    const ok = typeof value === 'string' && (TOKEN.test(value) || OFFICIAL_VIOLET.test(value));
    assert(
      ok,
      'FILE_TYPE_COLORS.' + key + ' = ' + JSON.stringify(value) + ' 不是官方 token —— §2.4 只允许 var(--dsw-static-*)，image/video 例外用官方 rgb(139,118,246)'
    );
  }
});

// ── [8] 自然序排序 ────────────────────────────────────────────────────────
console.log('\n[8/14] 排序');
check('[§3.6]', '使用 Intl.Collator 自然序（numeric:true，file2 在 file10 前）', OWNER_CLIENT, () => {
  const m = /Intl\.Collator\s*\(([\s\S]{0,240}?)\)/.exec(CLIENT_SRC);
  assert(
    m,
    '未找到 Intl.Collator —— 违反 §3.6「自然序：new Intl.Collator(undefined, {numeric:true, sensitivity:\'base\'})」，localeCompare 字符串序会把 file10 排在 file2 前'
  );
  const args = m[1].replace(/\s+/g, ' ').trim();
  const problems = [];
  if (!/numeric\s*:\s*true/.test(m[1])) problems.push("缺 numeric:true（file2 必须排在 file10 前）");
  if (!/sensitivity\s*:\s*['"]base['"]/.test(m[1])) problems.push("缺 sensitivity:'base'（§3.6 明确给出的实参）");
  if (!/\.compare\s*\(/.test(CLIENT_SRC)) problems.push('没有 .compare( 调用 —— 自然序没真正用于排序');
  assert(problems.length === 0, 'Intl.Collator 不完整（实参 ' + args + '）：' + problems.join('；') + ' —— 违反 §3.6');
});

// ── [9] 无障碍 ────────────────────────────────────────────────────────────
console.log('\n[9/14] 无障碍');
check('[§三.3/§七]', 'aria-label / role=tree|grid / aria-current 齐备', OWNER_CLIENT, () => {
  const missing = [];
  if (!/aria-label|ariaLabel/.test(CLIENT_SRC)) {
    missing.push('aria-label（§3.4 每个图标按钮都要带；§三.3 面包屑 <nav aria-label="路径">）');
  }
  if (!/role\s*[:=]\s*['"](?:tree|grid)['"]/.test(CLIENT_SRC)) {
    missing.push('role="tree"（目录树，W3C treeview 键盘模式）或 role="grid"（列表）—— §七');
  }
  if (!/aria-current|ariaCurrent/.test(CLIENT_SRC)) {
    missing.push('aria-current（§三.3 面包屑末项 aria-current="page"）');
  }
  assert(missing.length === 0, '缺 ' + missing.length + ' 项无障碍属性：' + missing.join('；'));
});

// ── [10] 省略号 + min-width:0 ─────────────────────────────────────────────
console.log('\n[10/14] 长文件名省略');
check('[§3.1/3.2]', 'text-overflow 且目录行内含 min-width:0', OWNER_CLIENT, () => {
  assert(/text-overflow/.test(CLIENT_SRC), '完全没有 text-overflow —— 违反 §3.2「长文件名必须省略（保扩展名可见）」');
  assert(CSS_TEXT.length > 0, '在 lib/client.js 里找不到样式表数组，无法把 min-width:0 定位到目录视图行（§3.1）');

  const dirRules = CSS_RULES.filter((r) => /(row|item|dir|tree|entry|name)/i.test(r.selector));
  assert(
    dirRules.length > 0,
    '找不到目录视图行的样式规则（§3.1 `.row` / `.name`）—— 无法证明省略号作用在目录行上'
  );

  const withEllipsis = dirRules.filter((r) => /text-overflow\s*:\s*(?:ellipsis|clip)/.test(r.body));
  assert(
    withEllipsis.length > 0,
    '目录视图行内没有 text-overflow:ellipsis —— 违反 §3.2 / §3.1 `.name{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}`'
  );

  const withMinWidth = dirRules.filter((r) => /(?:^|[;\s])min-width\s*:\s*0(?:px)?\s*(?:;|$)/.test(r.body));
  assert(
    withMinWidth.length > 0,
    '目录视图行内没有 min-width:0 —— 违反 §3.1（`.row{min-width:0}` / `.name{min-width:0}`）：flex 子项默认 min-width:auto，缺了它省略号不生效'
  );
});

// ── [11] 图标映射完整性（防静默 fallback）──────────────────────────────────
console.log('\n[11/14] 图标映射完整性');
check('[§2.4]', '映射表的值都指向已定义的图形；内联副本与 lib/icons.js 同源', OWNER_TABLES, () => {
  assert(
    TABLES.icons.table,
    '无法从 lib/icons.js 取出图标表（应导出 ICON_TABLE，或保持纯数据 + 纯函数可求值）：' + errText(TABLES.icons.error || '归一化失败')
  );
  assert(
    TABLES.inline.table,
    '无法从 lib/client.js 取出内联图标块（INLINE-ICONS-BEGIN/END 之间应是可求值的纯数据 + 纯函数）：' + errText(TABLES.inline.error || '归一化失败')
  );

  const problems = [];

  // ① 每一侧：映射的值必须指向已定义的图形（.ppt→'ppt' 那类静默 fallback 死在这条）
  for (const [label, side] of [['lib/icons.js', TABLES.icons], ['client.js#inline', TABLES.inline]]) {
    const t = side.table;
    const shapeKeys = new Set(Object.keys(t.shapes || {}));
    const colorKeys = new Set(Object.keys(t.colors || {}));
    if (!shapeKeys.size) problems.push(label + ' 取不到图形定义表（shapes）');
    if (!colorKeys.size) problems.push(label + ' 取不到官方色表（colors）');
    if (!Object.keys(t.extensions || {}).length) problems.push(label + ' 取不到扩展名映射表（extensions）');
    if (!Object.keys(t.filenames || {}).length) problems.push(label + ' 取不到文件名映射表（filenames）');

    const maps = [
      ['extensions', Object.entries(t.extensions || {})],
      ['filenames', Object.entries(t.filenames || {})],
      ['filenamePrefixes', (Array.isArray(t.filenamePrefixes) ? t.filenamePrefixes : []).map((pair) => [pair[0], pair[1]])],
    ];
    for (const [tableName, entries] of maps) {
      for (const [key, value] of entries) {
        if (!shapeKeys.has(value)) problems.push(label + ' ' + tableName + '.' + key + ' → "' + value + '"（图形表里没有这个键）');
      }
    }
    for (const [shape, colorKey] of Object.entries(t.shapeColor || {})) {
      if (!shapeKeys.has(shape)) problems.push(label + ' shapeColor.' + shape + '（图形表里没有这个键）');
      if (!colorKeys.has(colorKey)) problems.push(label + ' shapeColor.' + shape + ' → "' + colorKey + '"（色表里没有这个键）');
    }
  }

  // ② 内联副本必须是源的忠实拷贝：键集合逐项一致 + 生成器指纹一致
  const srcTable = TABLES.icons.table;
  const inlineTable = TABLES.inline.table;
  const shortList = (list, max = 8) => (list.length > max ? list.slice(0, max).join(',') + '…（共 ' + list.length + ' 个）' : list.join(','));
  for (const field of ['shapes', 'extensions', 'filenames', 'shapeColor', 'colors']) {
    const from = Object.keys(srcTable[field] || {}).sort();
    const to = Object.keys(inlineTable[field] || {}).sort();
    if (from.join(',') === to.join(',')) continue;
    const toSet = new Set(to);
    const fromSet = new Set(from);
    problems.push(
      '内联副本与源漂移：' + field + ' 键集合不一致 —— 源独有 [' + shortList(from.filter((k) => !toSet.has(k))) +
        '] / 内联独有 [' + shortList(to.filter((k) => !fromSet.has(k))) + ']（源 ' + from.length + ' 个 vs 内联 ' + to.length + ' 个）'
    );
  }
  const fingerprint = /sha256\[:16\]\s*=\s*([0-9a-f]{16})/.exec(CLIENT_RAW);
  if (fingerprint && icons.exists) {
    const actual = createHash('sha256').update(fs.readFileSync(ICONS_PATH)).digest('hex').slice(0, 16);
    if (fingerprint[1] !== actual) {
      problems.push(
        '内联副本已过期：内联块声明的源指纹 ' + fingerprint[1] + ' ≠ lib/icons.js 实际 sha256[:16] ' + actual + '（改了源必须重新生成内联块）'
      );
    }
  }

  assert(
    problems.length === 0,
    '发现 ' + problems.length + ' 处图标表问题（运行时会静默掉到通用 other 图标，或显示过期图标）—— 违反 §2.4 类型映射契约：' +
      problems.slice(0, 10).join('；') +
      (problems.length > 10 ? '…' : '')
  );
});

// ── [12] data-density 不得挂到宿主 <body>/<html> ──────────────────────────
console.log('\n[12/14] 宿主边界');
check('[宿主边界]', 'data-density 只挂自己的容器，不碰宿主 body/html', OWNER_CLIENT, () => {
  const hits = [];
  const re = /data-density/g;
  let m;
  while ((m = re.exec(CLIENT_SRC))) hits.push(m.index);

  assert(
    hits.length > 0,
    '找不到 data-density —— §3.1 的三档密度（紧凑 28 / 标准 32 / 宽松 44）应由自己容器上的 data-density 驱动；若已改用别的机制，请同步更新本条'
  );

  const direct = [];
  const reDirect = /document\.(?:body|documentElement)\s*\.\s*(?:dataset\s*\.\s*density|setAttribute\s*\(\s*['"]data-density['"])/g;
  while ((m = reDirect.exec(CLIENT_SRC))) direct.push({ text: 'data-density', index: m.index });
  assert(
    direct.length === 0,
    '直接把 data-density 写到宿主 body/documentElement 上 —— 违反「宿主边界」：body/html 的属性归宿主管，插件只能挂自己的根容器（' +
      fmtHits(direct, CLIENT_SRC, CLIENT_PATH) +
      '）'
  );

  const near = [];
  for (const index of hits) {
    const window = CLIENT_SRC.slice(Math.max(0, index - 240), index + 240);
    if (/\bdocument\.(?:body|documentElement)\b|\bbody\.(?:dataset|setAttribute|classList)\b/.test(window)) {
      near.push({ text: 'data-density', index });
    }
  }
  assert(
    near.length === 0,
    'data-density 出现在宿主 body/documentElement 操作附近 —— 违反「宿主边界」：密度只挂自己的容器（' + fmtHits(near, CLIENT_SRC, CLIENT_PATH) + '）'
  );
});

// ── [13] 不得无兜底消费「幽灵 token」 ─────────────────────────────────────
console.log('\n[13/14] 宿主 token 真实性');
check('[§一.1]', '不以无 fallback 形式消费宿主未定义的 token', OWNER_CLIENT, () => {
  /**
   * 名单必须是**实证**的，不是猜的 —— 判据：在官方 bundle 全量 dump 里
   * `--token:` 定义点数为 0，却有包在消费（它就是幽灵）。
   * 实测（2026-09-30，dump 424 个文件）：
   *   --dsw-font-mono       定义点 0，消费方 4 个官方包；其中 ui-jobs:11 还是裸用
   *                         var(--dsw-font-mono) → 连官方那处也解析不出字体。
   *   等宽的正解是 --ds-font-family-code（ui-theme :root{} 有定义，官方
   *   ui-primitives 的 CodeCard.module.css 也用它）。
   * 只禁「无 fallback」形式：带兜底的 var(--dsw-font-mono, ui-monospace, …)
   * 在浏览器里能正常退化，不算缺陷（官方 3 个包就是这么写的）。
   */
  const PHANTOM = [
    { token: '--dsw-font-mono', why: '全量官方包里 0 个定义点；等宽应用 --ds-font-family-code（ui-theme :root 定义）' },
  ];

  const problems = [];
  for (const { token, why } of PHANTOM) {
    const re = new RegExp('var\\(\\s*' + token + '\\s*\\)', 'g');
    let m;
    while ((m = re.exec(CLIENT_SRC))) {
      problems.push('client.js:' + lineOf(CLIENT_SRC, m.index) + ' 裸用 var(' + token + ') —— ' + why);
    }
  }
  assert(
    problems.length === 0,
    '发现 ' + problems.length + ' 处幽灵 token 的无兜底消费（浏览器里该声明会解析失败/退化成继承值，静态看却是「用了官方 token」）—— 违反 §一.1「只用宿主 :root 实际导出的 token」：' +
      problems.join('；')
  );
});

// ── [14] 虚拟滚动下的 grid 行数语义 ───────────────────────────────────────
console.log('\n[14/14] 虚拟滚动无障碍');
check('[§3.7/§七]', 'aria-rowcount 取全量、aria-rowindex 取绝对 1-based 下标', OWNER_CLIENT, () => {
  /**
   * 虚拟化后 DOM 里只有可见行，「一共多少行」「当前是第几行」只能靠 ARIA 说清楚 ——
   * 取可视窗口的条数/序号，读屏就会以为整个列表只有一屏。
   *
   * 静态能力的边界（务必知道）：
   *   · 能查：属性在不在、行数是不是**内联**取自可视切片、下标是不是 1-based、
   *     下标基数是不是由「窗口起点 + 相对序号」合成（或干脆就是 map 的相对序号）。
   *   · 查不了：`aria-rowcount: total` 这种**裸标识符**赋值的数据流（total 从哪来）。
   *     所以「rowcount ≠ DOM 行数」这一条只能靠运行期实测（ui-core 的 render 冒烟
   *     或真机 GUI），静态门禁到此为止，不硬凑。
   */
  const problems = [];
  const rowcount = /["']aria-rowcount["']\s*:\s*([^,}\n]+)/.exec(CLIENT_SRC);
  const rowindex = /["']aria-rowindex["']\s*:\s*([^,}\n]+)/.exec(CLIENT_SRC);

  // ① 两个属性必须在
  if (!rowcount) problems.push('缺 aria-rowcount（§3.7：DOM 里只有可见行，全量行数必须显式声明）');
  if (!rowindex) problems.push('缺 aria-rowindex（§七 grid：每行要给绝对下标，否则读屏不知道读的是第几行）');

  // ② rowcount 必须是全量，不能是可视窗口的条数（最典型的写错法）
  if (rowcount) {
    const expr = rowcount[1].trim();
    if (/\b(slice|visible|overscan|winEnd|winStart|viewport|viewH)\b/i.test(expr)) {
      problems.push('aria-rowcount 取自可视窗口（"' + expr + '"）—— 必须是全量总数');
    }
    // 写成 `<ident>.length` 时再追一步：若该 ident 由**带窗口参数**的 .slice(a, b) 赋值，
    // 它就是可视切片。（只认两参形式：`.slice()` / `.slice(0)` 是整份拷贝，不算窗口 —— 
    // 否则 `sorted = entries.slice().sort()` 这种正解会被误伤。）
    const lenMatch = /^(?:String\(\s*)?([A-Za-z_$][\w$]*)\s*\.length/.exec(expr);
    if (lenMatch) {
      const safeId = lenMatch[1].replace(/\$/g, '\\$');
      if (new RegExp('(?:var|let|const)\\s+' + safeId + '\\s*=\\s*[^;\\n]*\\.slice\\(\\s*[^)]*,').test(CLIENT_SRC)) {
        problems.push(
          'aria-rowcount 取自切片数组 ' + lenMatch[1] + '.length，而 ' + lenMatch[1] + ' 由 .slice(a, b)（可视窗口）赋值 —— 必须是全量总数'
        );
      }
    }
  }

  // ③ rowindex 必须 1-based，且基数得是绝对下标（窗口起点 + 窗口内相对序号）
  if (rowindex) {
    const expr = rowindex[1].trim();
    if (!/\+\s*1/.test(expr)) {
      problems.push('aria-rowindex 不是 1-based（"' + expr + '"）—— ARIA grid 的 rowindex 从 1 起');
    }
    const ids = expr.match(/[A-Za-z_$][\w$]*/g) || [];
    const base = ids.find((id) => !['String', 'Number', 'parseInt', 'parseFloat'].includes(id));
    if (base) {
      const safe = base.replace(/\$/g, '\\$');
      const before = CLIENT_SRC.slice(0, rowindex.index);
      const declRe = new RegExp('(?:var|let|const)\\s+' + safe + '\\s*=\\s*([^;\\n]+)', 'g');
      let decl = null;
      let m;
      while ((m = declRe.exec(before))) decl = m[1].trim(); // 取最近一次声明
      if (decl) {
        if (!/[A-Za-z_$][\w$]*\s*\+\s*[A-Za-z_$][\w$]*/.test(decl)) {
          problems.push(
            'aria-rowindex 的基数 ' + base + ' = "' + decl + '" 不是绝对下标 —— 必须是「窗口起点 + 窗口内相对序号」，否则虚拟滚动下每屏都从 1 重新数'
          );
        }
      } else if (new RegExp('\\(\\s*[A-Za-z_$][\\w$]*\\s*,\\s*' + safe + '\\s*[,)]').test(before.slice(-4000))) {
        problems.push('aria-rowindex 用的是 map 回调里的相对序号 ' + base + ' —— 必须换算成绝对下标');
      }
    }
  }

  assert(
    problems.length === 0,
    '虚拟滚动的 grid 行数语义不完整（读屏会读到残缺的行数/序号）—— 违反 §3.7 + §七：' + problems.join('；')
  );
});

// ── 汇总 ──────────────────────────────────────────────────────────────────
if (failureList.length) {
  console.log('\n── 失败清单（按负责人）──');
  for (const owner of [OWNER_CLIENT, OWNER_ICONS, OWNER_TABLES]) {
    const mine = failureList.filter((f) => f.owner === owner);
    if (!mine.length) continue;
    console.log('  ▸ ' + owner);
    for (const f of mine) console.log('      · ' + f.spec + ' ' + f.title + ' → ' + f.message);
  }
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
