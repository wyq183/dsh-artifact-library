/**
 * dsh-artifact-library · UI 规范回归测试
 * 把 `docs/UI-SPEC-v1.md` 里**可静态断言**的条款钉成 29 条，每条指向规范原文。
 *
 * 为什么要有它：
 *   UI 重构（行高 110→32px、去冗余路径、token 化、按类型图标、自然序…）全靠人眼核对，
 *   改着改着就会悄悄偏离规范。这个文件是「规范守门人」——让偏离当场可见。
 *
 * 它**不是**「文件存在就算过」的烟雾测试：
 *   · 每条断言都带 [§x.y] 条款号，失败信息写清违反了哪一条
 *   · 允许先红后绿 —— 队友改造期间失败是**预期结果**，不要为它放宽断言
 *
 * 29 条 ↔ 规范条款对照：
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
 *   [§11.1]  浮层可关闭：右键菜单与 Ctrl+P 浮层都要有 Escape 关闭路径
 *   [§11.2]  对话框语义：role=dialog 必须有可访问名 + 焦点管理（打开移入 / 关闭归还）
 *   [§11.4]  错误态不清空数据（窄版：挡最直白的「catch 里清空列表」写法）
 *   [§11.5]  加载态：列表骨架屏；toast 自动隐藏必须是一次性 setTimeout（不得用 setInterval 空转）
 *   [§11.6]  快捷键宿主边界：可见性闸门 + document keydown 监听必须成对增删
 *   [§11.1②] 浮层坐标必须经过视口夹取/翻转（结构选择，不测布局质量）
 *   [§11.1③] 浮层根节点必须 position:fixed（或 portal），不被 overflow 祖先裁切
 *   [§11.4]  瞬时结果走应用级 shell.overlay，且有 hasOverlay 回退判据
 *   [实现约定] 设置面板必须由 schema 驱动（键集来自 schema.defaults、分组来自 hostEffectiveKeys）
 *   [§六]    空态两分支：真的空 vs 被隐藏项过滤成空（两句不同的话，不是同一句兜底）
 *   [§11.4]  导入结果如实展示 applied / ignored / errors 三类清单（不是一句「成功」）
 *   [实现约定] 客户端生效的设置键必须真的被读（防「只存不读」：面板能改、实际不生效）
 *             键名清单从 `lib/settings.js` 的 `APPEARANCE_KEYS` 读 → 加新键会自动要求接线
 *   [§三.3/§七] 可选中行必须有 aria-selected，且随选中态变化（不能写死）—— 否则「选中」只对眼睛成立
 *   [实现约定] 拖拽语义唯一：不得出现拖拽选中（防它与「投放=登记」抢同一手势）
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
const SETTINGS_PATH = path.join(ROOT, 'lib', 'settings.js');

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
console.log('\n[1/29] 禁止第二套配色');
check('[§一.1]', 'lib/client.js 不出现 hex 颜色字面量', OWNER_CLIENT, () => {
  const hits = findHexColors(CLIENT_SRC);
  assert(
    hits.length === 0,
    '发现 ' + hits.length + ' 处 hex —— 违反 §一.1「只用 --dsw-* 宿主 token，禁止任何 hex」：' + fmtHits(hits, CLIENT_SRC, CLIENT_PATH)
  );
});

// ── [2] 禁止自造 --alf-* token ────────────────────────────────────────────
console.log('\n[2/29] 禁止自造 token');
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
console.log('\n[3/29] 客户端 React 来源');
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
console.log('\n[4/29] 官方 token 消费');
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
console.log('\n[5/29] 目录行高');
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
console.log('\n[6/29] 图标模块契约');
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
console.log('\n[7/29] 图标颜色来源');
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
console.log('\n[8/29] 排序');
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
console.log('\n[9/29] 无障碍');
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
console.log('\n[10/29] 长文件名省略');
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
console.log('\n[11/29] 图标映射完整性');
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
console.log('\n[12/29] 宿主边界');
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
console.log('\n[13/29] 宿主 token 真实性');
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
console.log('\n[14/29] 虚拟滚动无障碍');
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

// ── [15] §11.1 浮层可关闭 ─────────────────────────────────────────────────
console.log('\n[15/29] 浮层可关闭');
check('[§11.1]', '右键菜单与 Ctrl+P 浮层都有 Escape 关闭路径', OWNER_CLIENT, () => {
  const problems = [];
  // §11.1①：任何浮层必须可关闭，键盘用户必须支持 Escape。
  // 逐个浮层查「有没有一条 Escape 分支能关掉它」。
  // 注意：closer 可能被重构成具名函数（`closeFinder()`），所以两种形态都认 ——
  // 第一版只认字面的 `setFinder(null)`，ui-core 一重命名就误报了（假警报）。
  const overlays = [
    { name: '右键菜单', closers: ['setMenu', 'closeMenu'] },
    { name: 'Ctrl+P 快速跳转', closers: ['setFinder', 'closeFinder'] },
  ];
  const escapes = [...CLIENT_SRC.matchAll(/Escape/g)];
  if (!escapes.length) problems.push('全文件没有 Escape 分支 —— §11.1① 要求键盘用户也能关闭浮层');
  for (const { name, closers } of overlays) {
    const closerRe = new RegExp('(?:' + closers.join('|') + ')\\s*\\(');
    const ok = escapes.some((m) => closerRe.test(CLIENT_SRC.slice(Math.max(0, m.index - 240), m.index + 240)));
    if (!ok) {
      problems.push(
        name + ' 找不到「Escape → 关闭」的路径（认这些写法：' + closers.map((c) => c + '(...)').join(' / ') + '）—— §11.1① 要求键盘用户也能关'
      );
    }
  }
  assert(problems.length === 0, problems.join('；'));
});

// ── [16] §11.2 对话框语义 ─────────────────────────────────────────────────
console.log('\n[16/29] 对话框语义');
check('[§11.2]', 'role=dialog 有可访问名，且有焦点管理（打开移入 / 关闭归还）', OWNER_CLIENT, () => {
  const problems = [];

  // ① 可访问名：每个 role="dialog" 附近必须有 aria-label / aria-labelledby
  const dialogs = [...CLIENT_SRC.matchAll(/role\s*:\s*["']dialog["']/g)];
  if (!dialogs.length) problems.push('全文件没有 role="dialog"（浮层都没有对话框语义）');
  for (const d of dialogs) {
    const line = lineOf(CLIENT_SRC, d.index);
    const window = CLIENT_SRC.slice(d.index, d.index + 260);
    if (!/aria-label|aria-labelledby/.test(window)) problems.push('client.js:' + line + ' 的 role="dialog" 没有可访问名（aria-label / aria-labelledby）');
  }

  // ② 打开时焦点移入：每个对话框附近要有 autoFocus 或一次 .focus()
  for (const d of dialogs) {
    const line = lineOf(CLIENT_SRC, d.index);
    const window = CLIENT_SRC.slice(Math.max(0, d.index - 200), d.index + 1200);
    if (!/autoFocus/.test(window) && !/\.focus\s*\(/.test(window)) {
      problems.push('client.js:' + line + ' 的对话框没有「打开移入焦点」的痕迹（既无 autoFocus 也无 .focus( )）');
    }
  }

  // ③ 关闭归还：必须能知道「打开前焦点在哪」，并在关闭时还回去。
  //    正解只有两种可静态识别的形态：`document.activeElement` 捕获，或**声明出来的**
  //    trigger/opener/lastFocus 之类 ref + 关闭时对它 `.focus()`。
  //    ⚠️ 别用裸 `opener` 这种词做判据：`window.open(..., "noopener")` 的字面量会误命中
  //    （我第一版就栽在这，报了假警报）。
  const captures = /document\s*\.\s*activeElement/.test(CLIENT_SRC);
  const refMatch = /\b((?:trig|trigger|opener|lastFocus|prevFocus|restoreFocus|returnFocus)[A-Za-z_$]*Ref)\s*=/.exec(CLIENT_SRC);
  const refName = refMatch ? refMatch[1] : null;
  const focusBack = refName
    ? new RegExp(refName.replace(/\$/g, '\\$') + '\\s*\\.\\s*current[^;\\n]{0,60}\\.focus\\s*\\(').test(CLIENT_SRC)
    : false;
  if (!captures && !(refName && focusBack)) {
    problems.push(
      '找不到「关闭时把焦点归还给触发元素」的机制（既没有 document.activeElement 捕获，也没有声明出来的 trigger/opener ref + 关闭时 .focus()）—— ' +
        '§11.2 要求打开移入 + **关闭归还**；焦点落在被移除的节点上会掉回 body，键盘用户会丢失位置'
    );
  }

  assert(problems.length === 0, '对话框语义不完整 —— 违反 §11.2：' + problems.join('；'));
});

// ── [17] §11.4 错误态不清空数据（窄版）────────────────────────────────────
console.log('\n[17/29] 错误态保留数据');
check('[§11.4]', '错误路径不得清空已有列表数据', OWNER_CLIENT, () => {
  // §11.4 官方原文：「操作失败保留数据可见，绝不清空内容来显示错误」。
  // 诚实说明本条的**能力边界**：静态只能挡最直白的写法 —— catch 块里直接把行/条目
  // 集合清空（`setRows([])` / `setEntries([])`）。真正的数据流（先清空再在别处恢复等）
  // 查不了，那要靠运行期；不硬凑一条会乱咬的断言。
  const blunt = /catch[^{]*\{[^}]*\bset(?:Rows|Entries|Items)\s*\(\s*\[\s*\]\s*\)/g;
  const hits = [...CLIENT_SRC.matchAll(blunt)];
  assert(
    hits.length === 0,
    '错误路径里出现「清空列表数据来显示错误」—— 违反 §11.4「绝不清空内容来显示错误」：' +
      hits.map((m) => 'client.js:' + lineOf(CLIENT_SRC, m.index)).join('、')
  );
});

// ── [18] §11.5 加载态 ─────────────────────────────────────────────────────
console.log('\n[18/29] 加载态');
check('[§11.5]', '列表用骨架屏，且 toast 自动隐藏是一次性定时器（不空转）', OWNER_CLIENT, () => {
  const problems = [];

  // ① 列表加载必须用骨架屏（§11.5：列表用骨架屏；不用 spinner）
  const skeletonUses = [...CLIENT_SRC.matchAll(/SkeletonRows\s*\(\s*h\s*,/g)].length;
  if (!/function\s+SkeletonRows/.test(CLIENT_SRC)) problems.push('没有 SkeletonRows 组件（§11.5 要求列表用骨架屏）');
  if (skeletonUses < 3) problems.push('骨架屏只在 ' + skeletonUses + ' 处被使用（列表/搜索/面板加载都该用）—— §11.5「列表用骨架屏」');

  // ② 不要空转的定时器：toast 自动隐藏必须是一次性 setTimeout。
  //    §11.5 点名的 bug 就是「每次 2.2 秒空转一次」——那是 setInterval 的形态。
  //    判据看的是**定时器回调体**里有没有驱动 toast，而不是「附近出现过 toast 这个词」
  //    （第一版用 ±320 字符邻近判定，把注册重试的 retryTimer 误报了）。
  const intervals = [...CLIENT_SRC.matchAll(/setInterval\s*\(/g)];
  const toastIntervals = intervals.filter((m) =>
    /setToast\s*\(|toastBus\s*\.\s*emit|toastRef\s*\.\s*current/.test(CLIENT_SRC.slice(m.index, m.index + 600))
  );
  if (toastIntervals.length) {
    problems.push('toast 用了 setInterval 驱动（client.js:' + toastIntervals.map((m) => lineOf(CLIENT_SRC, m.index)).join('、') + '）—— §11.5「不要空转的定时器」');
  }
  if (!/toast[A-Za-z]*\s*\.\s*timer\s*=\s*setTimeout|toastRef\.current\s*=\s*setTimeout|setTimeout\([^)]{0,80}(?:setToast|emit)\(/i.test(CLIENT_SRC)) {
    problems.push('找不到 toast 的一次性自动隐藏（期望 setTimeout 形态）—— §11.5 要求无内容时不续期');
  }

  assert(problems.length === 0, problems.join('；'));
});

// ── [19] §11.6 快捷键宿主边界 ─────────────────────────────────────────────
console.log('\n[19/29] 快捷键宿主边界');
check('[§11.6]', '面板快捷键有可见性闸门，且 document keydown 监听成对增删', OWNER_CLIENT, () => {
  const problems = [];

  // ① 可见性闸门（§11.6：面板未显示时不得响应/吞键）
  if (!/getClientRects\s*\(\s*\)\s*\.\s*length\s*>\s*0/.test(CLIENT_SRC)) {
    problems.push('找不到「面板可见性」判断（getClientRects().length > 0）—— §11.6 要求面板未显示时不响应快捷键、不吞键');
  }

  // ② document 级 keydown 必须成对增删（否则面板卸载后还在吞宿主的键）
  const adds = [...CLIENT_SRC.matchAll(/document\.addEventListener\s*\(\s*["']keydown["']/g)];
  const removes = [...CLIENT_SRC.matchAll(/document\.removeEventListener\s*\(\s*["']keydown["']/g)];
  if (adds.length === 0) problems.push('没有 document 级 keydown 监听（快捷键未实现？）');
  if (adds.length !== removes.length) {
    problems.push(
      'document keydown 监听不配对：add × ' + adds.length + ' / remove × ' + removes.length +
        '（§11.6：面板卸载后不得继续吞宿主的键）'
    );
  }

  assert(problems.length === 0, problems.join('；'));
});

// ── [20] §11.1② 浮层定位必须经过视口夹取/翻转 ─────────────────────────────
console.log('\n[20/29] 浮层视口适配');
check('[§11.1②]', '浮层坐标经过视口夹取/翻转（函数或就地），不是拿到 rect 直接就用', OWNER_CLIENT, () => {
  // 原则（lead 定的）：「运行期质量」不钉，「**结构选择**」钉。钉两条：
  //   ① 全文件**存在**夹取/翻转运算（视口尺寸 + Math.min + Math.max）；
  //   ② 每个菜单坐标点的**取值来源**可追到夹取/放置计算。
  //
  // ⚠️ 判据演进史（两次都栽在「空间距离」上，记下来免得再犯）：
  //    v1 只查「坐标点 ±700 字符内同时有视口尺寸与夹取」→ 夹取被提到 `placeMenu()`
  //       函数里、调用点只写 `placed.x`，**误杀正确实现**；
  //    v2 改成「就地有信号 或 用放置结果」，但仍留了 ±700 的**窗口**判据 →
  //       这次实现改成 `var x = vw ? Math.min(…) : placed.x` 后再 `setMenu({x,y})`，
  //       `vw` 那两行**落在窗口外**，又误杀一次。
  //    ⇒ 结论：**语义关系不能用空间距离当判据**。v3 改为「追这个值的来源」：
  //       裸标识符就去它最近一次赋值里找夹取/放置信号（同 aria-rowindex 那条的做法）。
  const problems = [];
  // ⚠️ 名单里**不能有 `anchor`**：anchor 是**输入几何**（触发元素的 rect），不是放置结果。
  //    带上它会让 `var x = anchor.left`（原始几何、没夹取）被判为合规 —— 我 bite-test 时才发现。
  const PLACED = /(place|placed|pos|position|coord|fit|flip|clamp)/i;
  const escapeId = (s) => s.replace(/\$/g, '\\$');
  const clampedText = (text) => PLACED.test(text) || (/Math\.min/.test(text) && /Math\.max/.test(text));

  /** 这个坐标表达式（或它最近一次赋值）看起来经过夹取/放置计算吗？ */
  function looksClamped(expr, index) {
    if (clampedText(expr)) return true;
    const id = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr); // 裸标识符才有必要追来源
    if (!id) return false;
    const declRe = new RegExp('(?:var|let|const)\\s+' + escapeId(id[1]) + '\\s*=\\s*([^;\\n]+)', 'g');
    let decl = null;
    let mm;
    while ((mm = declRe.exec(CLIENT_SRC.slice(0, index)))) decl = mm[1];
    return decl ? clampedText(decl) : false;
  }

  // ① 夹取/翻转运算必须存在（写在帮助函数里也算）
  const anchors = [...CLIENT_SRC.matchAll(/getBoundingClientRect\s*\(\s*\)|clientX|clientY|innerWidth|innerHeight/g)];
  const clampExists = anchors.some((m) => {
    const w = CLIENT_SRC.slice(Math.max(0, m.index - 700), m.index + 900);
    return /Math\.min/.test(w) && /Math\.max/.test(w);
  });
  if (!clampExists) {
    problems.push('全文件找不到「视口尺寸 + Math.min + Math.max」的夹取/翻转运算 —— §11.1② 要求翻转或滑动并留边距');
  }

  // ② 每个坐标点：x、y 的取值来源都要能追到夹取/放置计算。
  //    只跳过「两个坐标都是**纯数字字面量**」的兜底（如 `{x:120,y:120}`）——
  //    裸标识符不能放过：它可能来自未夹取的计算。
  const opens = [...CLIENT_SRC.matchAll(/setMenu\s*\(\s*\{\s*x\s*:\s*([^,}]+),\s*y\s*:\s*([^,}]+)/g)];
  const isLiteral = (s) => /^\s*\d+(?:\.\d+)?\s*$/.test(s);
  let checked = 0;
  for (const m of opens) {
    if (isLiteral(m[1]) && isLiteral(m[2])) continue;
    checked += 1;
    const bad = [m[1], m[2]].filter((one) => !looksClamped(one, m.index));
    if (bad.length) {
      problems.push(
        'client.js:' + lineOf(CLIENT_SRC, m.index) + ' 菜单坐标 ' + bad.map((b) => b.trim()).join(' / ') +
          ' 的取值追不到夹取或放置计算 —— §11.1②：应统一经 `placeMenu()` 这类函数（内部做夹取 + 只在真能放下那侧翻转）'
      );
    }
  }
  if (checked === 0) {
    problems.push('找不到任何「由 rect / 鼠标坐标算出」的菜单坐标点 —— 无法确认 §11.1②（若定位方式改了，请同步更新本断言）');
  }
  assert(problems.length === 0, problems.join('；'));
});

// ── [21] §11.1③ 浮层根节点必须 fixed（或 portal）────────────────────────
console.log('\n[21/29] 浮层不被裁切');
check('[§11.1③]', '浮层根节点 position:fixed（或 portal 到 body），不被 overflow 祖先裁切', OWNER_CLIENT, () => {
  // 同样是「结构选择」而非运行期质量：根容器 `.alf` 是 overflow:hidden，
  // 所以浮层要么自己 fixed（脱离文档流，不被祖先裁），要么 portal 到 body。
  const OVERLAYS = [
    { name: '右键菜单', cls: '__menu' },
    { name: 'Ctrl+P 快速跳转', cls: '__finder' },
  ];
  const problems = [];
  for (const { name, cls } of OVERLAYS) {
    const rules = CSS_RULES.filter((r) => r.selector.includes(cls));
    if (!rules.length) {
      problems.push(name + ' 找不到 CSS 规则（.' + cls + '）—— 无法确认它是 fixed');
      continue;
    }
    if (!rules.some((r) => /position\s*:\s*fixed/.test(r.body))) {
      problems.push(
        name + '（.' + cls + '）不是 `position:fixed`，也没有 portal 到 body —— §11.1③：会被 .alf{overflow:hidden} 这类祖先裁掉' +
          '（若你改用 portal，告诉我，我把这条改成认 portal）'
      );
    }
  }
  assert(problems.length === 0, problems.join('；'));
});

// ── [22] §11.4 瞬时结果走应用级 shell.overlay ────────────────────────────
console.log('\n[22/29] 瞬时结果挂在活得久的地方');
check('[§11.4]', 'toast 走 shell.overlay，且有 hasOverlay 回退判据', OWNER_CLIENT, () => {
  const problems = [];
  if (!/shell\.overlay/.test(CLIENT_SRC)) {
    problems.push('没有 shell.overlay 席位 —— §11.4：瞬时操作结果必须挂在比上报界面活得久的地方（面板卸载不能带走）');
  } else if (!/inject\s*\(\s*(?:SLOT_OVERLAY\s*,\s*|["']shell\.overlay["'])/.test(CLIENT_SRC)) {
    problems.push('找不到向 shell.overlay 的 inject/register 调用 —— 席位声明了但没注册');
  }
  if (!/hasOverlay/.test(CLIENT_SRC)) {
    problems.push('没有 hasOverlay 之类的「浮层是否真的挂上」判据 —— §11.4 要求旧宿主（无 shell.overlay）能退回到面板内提示');
  }
  assert(problems.length === 0, problems.join('；'));
});

// ── [23] 设置面板由 schema 驱动 ──────────────────────────────────────────
console.log('\n[23/29] 设置面板 schema 驱动');
check('[实现约定]', '键集来自 schema.defaults、分组来自 schema.hostEffectiveKeys', OWNER_CLIENT, () => {
  // 来源说明：这不是 UI-SPEC 条款，是 **lead 指定的实现约定**（补设置面板的覆盖缺口）。
  // 只钉**正向**的「schema 驱动」，不做「禁止出现键名」的负判据 ——
  // 因为中文文案表**合法地**以设置键为索引（`thumbMaxBytes: {label,…}`），
  // 负判据会把它误伤成「硬编码键表」。正向钉住「键与分组都从 schema 来」才是要害。
  const problems = [];

  // ① **两跳追踪**：分组用的键集 ← 必须由 schema 迭代产生。
  //    为什么要两跳：只查「有没有对 schema 变量做迭代」太松 —— 我 bite-test 时发现，
  //    把真正喂给分组的 `keys` 换成字面量数组后，别处**残留的**迭代仍能让它通过。
  //    所以要顺着 `list: KEYS.filter(...)` 找到 KEYS，再看 KEYS 是不是 schema 迭代出来的。
  const schemaIds = [...CLIENT_SRC.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*schema\.defaults[^;\n]*/g)].map((m) => m[1]);
  const groupKeyIds = [...new Set([...CLIENT_SRC.matchAll(/list\s*:\s*([A-Za-z_$][\w$]*)\s*\.\s*filter\s*\(/g)].map((m) => m[1]))];

  if (!schemaIds.length) problems.push('找不到从 `schema.defaults` 取值的赋值 —— 设置面板似乎没有读 schema');
  if (!groupKeyIds.length) problems.push('找不到分组键集的用法（`list: xxx.filter(...)`）—— 无法确认键集来源');

  const esc = (s) => s.replace(/\$/g, '\\$');
  let keysFromSchema = false;
  for (const kid of groupKeyIds) {
    for (const sid of schemaIds) {
      // 形态 A：KEYS = Object.keys(schemaVar)
      if (new RegExp('(?:var|let|const)\\s+' + esc(kid) + '\\s*=\\s*Object\\.keys\\s*\\(\\s*' + esc(sid) + '\\s*\\)').test(CLIENT_SRC)) keysFromSchema = true;
      // 形态 B：for (k in schemaVar) { … KEYS.push(k) … }
      const loopRe = new RegExp('for\\s*\\([^)]*\\bin\\s+' + esc(sid) + '\\b[^)]*\\)', 'g');
      let lm;
      while ((lm = loopRe.exec(CLIENT_SRC))) {
        const body = CLIENT_SRC.slice(lm.index, lm.index + 260);
        if (new RegExp(esc(kid) + '\\s*\\.\\s*push\\s*\\(').test(body)) keysFromSchema = true;
      }
    }
  }
  if (schemaIds.length && groupKeyIds.length && !keysFromSchema) {
    problems.push(
      '分组用的键集（' + groupKeyIds.join('/') + '）不是从 `schema.defaults` 迭代出来的 —— 键集被写死了（新增设置项会不显示）'
    );
  }

  // ② 分组必须由 `schema.hostEffectiveKeys` 分区（而不是写死两组键名）
  const hostKeysDecl = /schema\.hostEffectiveKeys/.test(CLIENT_SRC);
  const partitioned = /hostKeys?\s*\.\s*(?:indexOf|includes)\s*\(/.test(CLIENT_SRC) || /\bSet\s*\(\s*hostKeys?\b/.test(CLIENT_SRC);
  if (!hostKeysDecl) problems.push('没有引用 `schema.hostEffectiveKeys` —— 分组看起来是写死的');
  else if (!partitioned) problems.push('引用了 hostEffectiveKeys 但没有用它做成员判定 —— 分组未必按 schema 划分');

  assert(problems.length === 0, '设置面板疑似脱离 schema：' + problems.join('；'));
});

// ── [24] 空态两分支 ──────────────────────────────────────────────────────
console.log('\n[24/29] 空态两分支');
check('[§六]', '「真的空」与「被隐藏项过滤成空」是两个分支，不是同一句兜底', OWNER_CLIENT, () => {
  const problems = [];
  const emptyMsg = /这个文件夹是空的/;
  const filteredMsg = /个隐藏项被过滤/;
  if (!emptyMsg.test(CLIENT_SRC)) problems.push('找不到「这个文件夹是空的」（§六 空目录态）');
  if (!filteredMsg.test(CLIENT_SRC)) {
    problems.push('找不到「N 个隐藏项被过滤」那一支 —— 被 showHidden 过滤成空时会误报「空的」，用户看不出为什么');
  }
  if (!/hiddenFiltered/.test(CLIENT_SRC)) problems.push('没有用到宿主回报的 `hiddenFiltered`（无法区分两种空）');

  // 必须是**两个分支**：两句文案不在同一处（否则就是同一句兜底文案）
  const m1 = emptyMsg.exec(CLIENT_SRC);
  const m2 = filteredMsg.exec(CLIENT_SRC);
  if (m1 && m2) {
    const dist = Math.abs(m1.index - m2.index);
    if (dist < 60) problems.push('两句空态文案挨在一起（相隔 ' + dist + ' 字符）—— 看起来是同一句兜底，不是两个分支');
  }
  // 被过滤那一支必须给出**可操作**的出口（「显示隐藏项」），否则用户只能去猜
  if (m2 && !/显示隐藏项/.test(CLIENT_SRC)) problems.push('「被过滤成空」这一支没有「显示隐藏项」的出口');
  assert(problems.length === 0, problems.join('；'));
});

// ── [25] 导入结果如实展示三类清单 ─────────────────────────────────────────
console.log('\n[25/29] 导入结果如实展示');
check('[§11.4]', 'applied / ignored / errors 三类清单一并展示', OWNER_CLIENT, () => {
  // §11.4 的「如实」：失败/被忽略的部分不能被一句「成功」吞掉。
  const hits = {};
  for (const k of ['applied', 'ignored', 'errors']) {
    hits[k] = [...CLIENT_SRC.matchAll(new RegExp('\\b' + k + '\\b', 'g'))].map((m) => m.index);
  }
  const missing = Object.keys(hits).filter((k) => !hits[k].length);
  assert(
    missing.length === 0,
    '导入结果里没有 ' + missing.join(' / ') + ' —— §11.4 要求如实展示（只报「成功」会吞掉被忽略与出错的部分）'
  );
  // 三类必须在**同一处渲染**（同一段窗口内全都出现），否则可能只是散落的变量名
  const together = hits.applied.some((a) => hits.ignored.some((b) => Math.abs(a - b) < 1200) && hits.errors.some((c) => Math.abs(a - c) < 1200));
  assert(together, 'applied / ignored / errors 没有在同一段渲染逻辑里同时出现 —— 可能只展示了其中一类');
});

// ── [26] 客户端生效的设置键必须真的被读（防「只存不读」）──────────────────
console.log('\n[26/29] 设置项真的生效');
check('[实现约定]', 'APPEARANCE_KEYS 与 virtualThreshold 每个键在渲染侧都有消费点', OWNER_CLIENT, () => {
  /**
   * 为什么有这条：ui-core 自查发现 **9 个客户端生效键「只存不读」** ——
   * 面板照 schema 渲染、控件齐、保存成功，但改了行高/缩略图大小**什么都不发生**。
   * 这正是 lead 反复点的 `indexExtraDirs` 式坑（「读了不生效」的镜像：存了没人读）。
   *
   * 判据是**结构性事实**（源码里有没有读它），不是渲染行为 → 不受 hook 布局影响。
   * **键名清单从 `lib/settings.js` 的 `APPEARANCE_KEYS` 读**，所以将来加键会自动被要求接线，
   * 不需要有人记得回来改这份测试。
   */
  const problems = [];

  let appearance = [];
  try {
    const settingsSrc = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const block = /APPEARANCE_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(settingsSrc);
    appearance = block ? [...block[1].matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)].map((m) => m[1]) : [];
  } catch (error) {
    problems.push('读不到 lib/settings.js（' + errText(error) + '）—— 无法核对键名清单');
  }
  if (!appearance.length) {
    problems.push('从 lib/settings.js 解析不出 `APPEARANCE_KEYS`（清单为空）—— 这条判据需要它，不能静默失效');
  }

  // virtualThreshold 不在 APPEARANCE_KEYS 里，但它属于那批「只存不读」的键，单独补上。
  //
  // ⚠️ 判据演进（两次，方向相反，都记下来）：
  //   v1 只认 `prefs.<key>` → 把 `next.defaultView` 判红。我当时**当成自己写窄了**（值确实被读了），
  //      于是放宽成「任意成员访问」。
  //   v2（放宽后）→ ui-core 指出：那不是误杀，是**它自己的命名不一致**，并已统一成 `prefs.<key>`，
  //      理由是「换个人读源码，`next.defaultView` 不如 `prefs.defaultView` 一眼可查」。
  //   v3（现在）→ 既然命名统一是**实现方有意为之的约定**，就把约定一起钉住：
  //      要求消费点写成 `prefs.<key>`（或 `prefs["<key>"]`）。这样这条同时保证
  //      「真的被读」**和**「可 grep 得到」——后者是维护性，不是洁癖。
  //      将来若有人合法改名，这条会红；**消息里写明了「要么用 prefs.，要么连同本断言一起更新」**，
  //      所以那次红是自解释的，不会变成谜题。
  const keys = appearance.concat(['virtualThreshold']);
  for (const key of keys) {
    const k = key.replace(/\$/g, '\\$');
    const readRe = new RegExp('prefs\\s*(\\.\\s*' + k + '\\b|\\[\\s*["\']' + k + '["\']\\s*\\])');
    if (!readRe.test(CLIENT_SRC)) {
      problems.push(
        '客户端生效键 `' + key + '` 找不到消费点 `prefs.' + key + '` —— ' +
          '「只存不读」：设置面板能改它，但实际不生效；也可能是消费点换了对象名（约定：统一用 `prefs.<键>`，' +
          '便于 grep；若确实要改名，请连同本条断言一起更新）'
      );
    }
  }

  assert(problems.length === 0, problems.join('；'));
});

// ── [27] 多选的无障碍语义 ────────────────────────────────────────────────
console.log('\n[27/29] 多选的无障碍语义');
check('[§三.3/§七]', '可选中行必须有 aria-selected，且随选中状态变化（不能写死）', OWNER_CLIENT, () => {
  // lead 判定这条**属于规范内**（不是实现约定）：`aria-selected` 是 ARIA 对 grid 行
  // 选中状态的标准属性。不钉它 = 「选中了」只对眼睛成立、对读屏不成立。
  const problems = [];
  if (!/aria-selected/.test(CLIENT_SRC)) {
    problems.push('找不到 `aria-selected` —— 行可选却没有选中语义，读屏读不出「这一行被选中了」');
  }
  // ⚠️ 判据要**逐个选中点**查，不能只看「有没有一处是动态的」：
  //    我 v1 写成「所有 aria-selected 都是常量才算错」，结果 bite-test 把**行**那一处
  //    改成写死 `"false"` 后**它照样绿**（另一处仍是动态的）——典型的过宽。
  //    现在按「视觉与无障碍同源」钉：**每一个标了 `data-sel` 的 props，其配套 `aria-selected`
  //    必须随状态变化**。表头那种没有 data-sel 的恒 false 不受影响（不会误伤）。
  const selSites = [...CLIENT_SRC.matchAll(/["']data-sel["']\s*:/g)];
  if (!selSites.length) problems.push('找不到 `data-sel`（选中态的视觉标记）—— 视觉与无障碍应当同源');
  const CONST = /^\s*(?:true|false|["']true["']|["']false["'])\s*$/;
  for (const site of selSites) {
    const w = CLIENT_SRC.slice(site.index, site.index + 400);
    const am = /["']aria-selected["']\s*:\s*([^,}]+)/.exec(w);
    if (!am) {
      problems.push('client.js:' + lineOf(CLIENT_SRC, site.index) + ' 标了 `data-sel` 却没有配套的 `aria-selected`（视觉标了、读屏没标）');
    } else if (CONST.test(am[1])) {
      problems.push('client.js:' + lineOf(CLIENT_SRC, site.index) + ' 的 `aria-selected` 写死成 ' + am[1].trim() + ' —— 它必须跟着选中集合走');
    }
  }
  assert(problems.length === 0, problems.join('；'));
});

// ── [28] 拖拽语义唯一（三个方向不许打架）──────────────────────────────────
console.log('\n[28/29] 拖拽语义唯一');
check('[实现约定]', '拖进来=登记、拖出去=带载荷的引用、禁止拖拽选中', OWNER_CLIENT, () => {
  // 这条**不是禁止拖拽**：它给三种拖拽各自定死语义，并禁止第三种（框选）出现。
  //   ① 拖进来 = 登记  → `onDrop` 必须存在（配对正向要求）
  //   ② 拖出去 = 引用  → 允许 `onDragStart`，但**必须带载荷**（`.setData(`）
  //   ③ 拖拽选中（框选/刷选）→ 禁止：它和上面两个抢同一个手势，§4.3 也要求拖拽不与虚拟滚动打架
  // ⚠️ 2026-09-30 夜里提前改过一次：原判据**一律禁 `onDragStart`**，而 task-13 的
  //    「拖出去=引用」正需要它 —— 不改，那条合法功能会被本门禁误杀。
  //    教训一句话：**判据要跟着「语义」走，不是跟着关键词走**（同一关键词在不同语义下对错相反）。
  const problems = [];

  // ③ 禁止拖拽选中
  for (const bad of ['dragSelect', 'dragRect', 'marqueeSelect', 'selectionRect']) {
    if (new RegExp('\\b' + bad + '\\b').test(CLIENT_SRC)) {
      problems.push('出现了 `' + bad + '` —— 拖拽选中会与「拖进=登记」「拖出=引用」抢同一手势（§4.3）');
    }
  }
  // ① 拖进来 = 登记（配对正向要求：防止本条退化成永远为真的空话）
  if (!/onDrop/.test(CLIENT_SRC)) {
    problems.push('找不到 `onDrop` —— 拖拽投放（登记）路径不见了；本条判据前提已失效，请同步更新');
  }
  // ② 拖出去 = 引用：允许 onDragStart，但必须带载荷
  const dragOut = /\bonDragStart\b/.test(CLIENT_SRC);
  if (dragOut && !/\.setData\s*\(/.test(CLIENT_SRC)) {
    problems.push('有 `onDragStart` 却找不到 `.setData(` —— 拖出去必须带引用载荷，否则用户拖出去得不到任何东西');
  }

  assert(problems.length === 0, problems.join('；'));
});

// ── [29] hover 操作区不得改变行高（虚拟滚动靠它吃饭）─────────────────────
console.log('\n[29/29] hover 操作区不改变行高');
check('[§3.1/§3.7]', 'hover 操作区必须「默认隐藏 + 空间已预留」（或脱离文档流），悬停不得改变行高', OWNER_CLIENT, () => {
  /**
   * 为什么重要：行高一变，虚拟滚动的 `aria-rowindex` 与实际就会错位（§3.7/§七）。
   *
   * ⚠️ 判据形状的**更正**（2026-09-30 夜，ui-core 提前告知，我还没写就改了）：
   *    我本来打算钉 `position:absolute` —— 那是**一种**实现，不是**唯一**正确实现。
   *    ui-core 用的是「固定 72px 占位 + visibility:hidden → hover/:focus-within 才 visible」，
   *    它**同样**保证行高不变，**而且额外保证「文件名不会被按钮压住」**。
   *    若按 absolute 钉，就会把一个**更好的**做法判成违规。
   *    ⇒ 改成钉**不变量**：默认不可见 + （脱离文档流 **或** 预留固定占位）。
   *    教训：**判据要钉「不许发生什么」，而不是「必须怎么写」**。
   */
  const problems = [];

  const base = /__dact\{([^}]*)\}/.exec(CLIENT_SRC);
  if (!base) {
    problems.push('找不到 `__dact` 的样式规则 —— hover 操作区不见了（判据前提失效，请同步更新本断言）');
  } else {
    const css = base[1];
    if (!/visibility\s*:\s*hidden/.test(css)) {
      problems.push('hover 操作区默认不是隐藏的（缺 `visibility:hidden`）—— 它会在不该出现的时候占位或闪烁');
    }
    const outOfFlow = /position\s*:\s*(absolute|fixed)/.test(css);
    const reserved = /flex\s*:\s*none/.test(css) && /width\s*:\s*\d+px/.test(css);
    if (!outOfFlow && !reserved) {
      problems.push(
        'hover 操作区既没有脱离文档流（position:absolute/fixed），也没有预留固定占位（flex:none + 固定宽度）' +
          ' —— 悬停时行高会变，虚拟滚动必然算错'
      );
    }
  }
  // 默认隐藏之后必须有显示路径，否则操作区永远不出现（把功能钉成隐形）
  if (!/__dact[^{]*\{[^}]*visibility\s*:\s*visible/.test(CLIENT_SRC)) {
    problems.push('找不到「操作区在 hover / focus-within / 展开时变 visible」的规则 —— 默认隐藏后没有显示路径');
  }

  assert(problems.length === 0, problems.join('；'));
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
