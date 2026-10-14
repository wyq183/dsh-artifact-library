/**
 * dsh-artifact-library · UI 规范回归测试
 * 把 `docs/UI-SPEC-v1.md` 里**可静态断言**的条款钉成 37 条，每条指向规范原文。
 *
 * 为什么要有它：
 *   UI 重构（行高 110→32px、去冗余路径、token 化、按类型图标、自然序…）全靠人眼核对，
 *   改着改着就会悄悄偏离规范。这个文件是「规范守门人」——让偏离当场可见。
 *
 * 它**不是**「文件存在就算过」的烟雾测试：
 *   · 每条断言都带 [§x.y] 条款号，失败信息写清违反了哪一条
 *   · 允许先红后绿 —— 队友改造期间失败是**预期结果**，不要为它放宽断言
 *
 * 37 条 ↔ 规范条款对照：
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
import { stripComments } from './_strip-comments.mjs'

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

/* ⭐ 2026-10-14 档 1d：`retired()` —— **显式废弃**机制
 * ══════════════════════════════════════════════════════════════════════
 * 依琪拍板「主区面板不要了，全部转到右侧栏」⇒ 面板删了，一批条款的
 * **主体不存在了**。
 *
 * ⚠️ 为什么**不直接删掉**那些 check：
 *   ① 删掉就没人知道「这条曾经守过什么」—— 下一个人可能重新踩；
 *   ② 条款还在 `docs/UI-SPEC-v1.md` 里，测试里凭空少一条会让人以为漏了；
 *   ③ 有些条款**只是换了主体**（该移植），与"真没了"必须分开记。
 *
 * ⇒ 用 `retired(spec, title, reason)`：**打印出来**（不是静默跳过），
 *    计入 `retiredList`，**不计入通过也不计入失败**。
 *    收尾时会汇总，并指向 `docs/DEPRECATED-TESTS.md`。
 *
 * ⚠️ 纪律：**只许废弃「主体物理上不存在」的**。
 *    「换了主体但性质还在」的必须**改写**（本文件里那几条已改成守右栏/网页版），
 *    不许拿 `retired()` 当逃生舱。
 * ══════════════════════════════════════════════════════════════════════ */
const retiredList = [];
function retired(spec, title, reason) {
  retiredList.push({ spec, title, reason });
  console.log('  --   ' + spec + ' ' + title + '  【已废弃】' + reason);
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

// ── 源码工具 ──────────────────────────────────────────────────────────────



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

/* ══════════════════════════════════════════════════════════════════════════
 * [0/46] ★★ 输入预处理自检：`stripComments` 真的在剥注释吗
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 为什么这一节必须存在（2026-10-08 立，起因是一个**真实发生过的** bug）：
 *
 *   本文件**其余每一条**断言扫的都是 `CLIENT_SRC = stripComments(CLIENT_RAW)`。
 *   所以 `stripComments` 一旦坏掉，坏的不是**一条**断言，是**全部 120 处引用** ——
 *   而且它坏的方式是「注释没被剥掉」⇒ 那些断言在**扫着带注释的原文**做判断。
 *   方向不定（可能假绿、可能误报），**并且不会自己喊**。
 *
 *   这个 bug 真的发生过：`client.js` 里
 *       if (/[\u0000-\u001f\u007f-\u009f"]/.test(p)) return "";
 *   正则字符类里那个 `"` 被原版当成「字符串开始」⇒ 词法错位 ⇒
 *   **从那一行起 328 处 `/* … *​/` 注释根本没被剥掉**。
 *   它一直没暴露，只因为原文里没有 hex 落在那些「没被剥掉的注释」里 ——
 *   直到 3d 内联的 JSDoc 里出现一个反例 `#ff0000`（那是**合法文档**，
 *   见 `tag-styles.test.mjs` 的 `[I]` 节），hex 门禁才误报出来。
 *
 *   ⇒ 规矩（§八「**守卫的输入预处理也必须被验**」）：**先验预处理，再验断言**。
 *     否则整份文件是**安全感的假象** —— 全绿，但绿得没有意义。
 */

console.log('\n[0/46] ★★ 输入预处理自检：stripComments 真的在剥注释（它坏了 = 全部 120 处一起空转）');

check('[§0]', '★★ 剥注释是 1:1 替换：长度必须**逐字符不变**（否则行号会漂，所有行号类断言跟着错）', OWNER_CLIENT, () => {
  assert(CLIENT_SRC.length === CLIENT_RAW.length,
    '剥完长度变了（' + CLIENT_RAW.length + ' → ' + CLIENT_SRC.length + '）—— 行号会漂，本文件的行号类断言全部不可信');
});

check('[§0]', '★★ 剥完**不该再有块注释开头**（残留 = 有注释没被剥掉 = 断言扫的是原文）', OWNER_CLIENT, () => {
  const leftover = [];
  const lines = CLIENT_SRC.split('\n');
  for (let i = 0; i < lines.length; i++) if (lines[i].indexOf('/*') >= 0) leftover.push(i + 1);
  assert(leftover.length === 0,
    '还有 ' + leftover.length + ' 行含 `/*`（前几个行号：' + leftover.slice(0, 8).join(', ') + '）'
    + ' ⇒ 那些注释没被剥掉，本文件的断言在扫**带注释的原文**');
});

check('[§0]', '★★ 反向对照：把**已知有病**的旧实现跑一遍，它必须**抓不住**（否则上面那条自检是空转的）', OWNER_CLIENT, () => {
  // 旧实现（2026-10-08 之前那版）：不认识正则字面量 ⇒ 正则字符类里的引号把词法带偏。
  // ⚠️ 这一段**刻意照抄**旧代码 —— 它不是"备用实现"，是**已知有病的标本**。
  function stripCommentsBroken(src) {
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
  // ① 病态构造（正是 client.js 里那一行的形状）：正则字符类里带引号，后面跟块注释
  const sick = 'const p = "x";\n'
    + 'if (/[\\u0000-\\u001f"]/.test(p)) return "";\n'
    + '/* 这条注释必须被剥掉 */\n'
    + 'const after = 1;\n';
  const good = stripComments(sick);
  const bad = stripCommentsBroken(sick);
  assert(good.indexOf('这条注释必须被剥掉') < 0,
    '修好版竟然没剥掉病态构造后面的注释 —— 那么上面那条「残留 = 0」是空转的');
  assert(bad.indexOf('这条注释必须被剥掉') >= 0,
    '旧实现竟然也剥掉了 —— 说明这段构造挑得不对，反向对照失去意义'
    + '（那上面那条自检就分辨不出好坏）');
  // ② 长度也必须都不变（两个版本都该是 1:1）
  assert(good.length === sick.length && bad.length === sick.length,
    '1:1 替换被破坏：good ' + good.length + ' / bad ' + bad.length + ' / 原文 ' + sick.length);
  // ③ ★ 在**真文件**上：旧实现的残留必须远大于 0（证明这个 bug 真的存在于真文件，不是构造出来的）
  const badOnReal = stripCommentsBroken(CLIENT_RAW).split('\n').filter((l) => l.indexOf('/*') >= 0).length;
  assert(badOnReal > 0,
    '旧实现跑真文件竟然也没残留 —— 那说明真文件里已经没有病态构造了，'
    + '这条自检的「真文件」那半边可以退休（**别默默删掉，要留下这条提示**）');
});

check('[§0]', '★ 字符串内容必须被保留（hex 就住在字符串里，剥掉字符串 = 把要抓的东西一起删了）', OWNER_CLIENT, () => {
  const probe = 'const a = "#ff0000";\n/* 注释里的 #00ff00 */\nconst b = "\\u0000";\n';
  const out = stripComments(probe);
  assert(out.indexOf('#ff0000') >= 0, '字符串里的 hex 被一起剥掉了 ⇒ hex 门禁永远抓不到东西（假绿）');
  assert(out.indexOf('#00ff00') < 0, '注释里的 hex 没被剥掉 ⇒ hex 门禁会误报注释（正是这次的症状）');
  assert(out.length === probe.length, '1:1 被破坏');
});

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
console.log('\n[1/37] 禁止第二套配色');
check('[§一.1]', 'lib/client.js 不出现 hex 颜色字面量', OWNER_CLIENT, () => {
  const hits = findHexColors(CLIENT_SRC);
  assert(
    hits.length === 0,
    '发现 ' + hits.length + ' 处 hex —— 违反 §一.1「只用 --dsw-* 宿主 token，禁止任何 hex」：' + fmtHits(hits, CLIENT_SRC, CLIENT_PATH)
  );
});

// ── [2] 禁止自造 --alf-* token ────────────────────────────────────────────
console.log('\n[2/37] 禁止自造 token');
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
console.log('\n[3/37] 客户端 React 来源');
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
console.log('\n[4/37] 官方 token 消费');
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
console.log('\n[5/37] 目录行高');
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
console.log('\n[6/37] 图标模块契约');
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
console.log('\n[7/37] 图标颜色来源');
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
console.log('\n[8/37] 排序');
retired('[§3.6]', '使用 Intl.Collator 自然序', '右栏列表没做自然序排序（面板的排序随面板删了）');

// ── [9] 无障碍 ────────────────────────────────────────────────────────────
console.log('\n[9/37] 无障碍');
retired('[§三.3/§七]', 'aria-label / role=tree|grid', '面板的目录树/列表删了，右栏没有 tree/grid 语义');

// ── [10] 省略号 + min-width:0 ─────────────────────────────────────────────
console.log('\n[10/37] 长文件名省略');
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
console.log('\n[11/37] 图标映射完整性');
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
console.log('\n[12/37] 宿主边界');
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
console.log('\n[13/37] 宿主 token 真实性');
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
console.log('\n[14/37] 虚拟滚动无障碍');
retired('[§3.7/§七]', 'aria-rowcount 取全量', '右栏**没有虚拟滚动**（最多 200 条直接渲染）⇒ 这套语义无处可守');

// ── [15] §11.1 浮层可关闭 ─────────────────────────────────────────────────
console.log('\n[15/37] 浮层可关闭');
retired('[§11.1]', '右键菜单与 Ctrl+P 浮层都有 Escape', '面板的右键菜单与 Ctrl+P 浮层删了；右栏**没有浮层**');

// ── [16] §11.2 对话框语义 ─────────────────────────────────────────────────
console.log('\n[16/37] 对话框语义');
retired('[§11.2]', 'role=dialog 有可访问名', '面板的对话框删了；右栏是单栏主从，不弹层');

// ── [17] §11.4 错误态不清空数据（窄版）────────────────────────────────────
console.log('\n[17/37] 错误态保留数据');
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
console.log('\n[18/37] 加载态');
retired('[§11.5]', '列表用骨架屏', '面板的列表删了（⚠️ 该**移植**到右栏，见 docs/DEPRECATED-TESTS.md §三）');

// ── [19] §11.6 快捷键宿主边界 ─────────────────────────────────────────────
console.log('\n[19/37] 快捷键宿主边界');
retired('[§11.6]', '面板快捷键有可见性闸门', '面板删了，那套快捷键一并删了');

// ── [20] §11.1② 浮层定位必须经过视口夹取/翻转 ─────────────────────────────
console.log('\n[20/37] 浮层视口适配');
retired('[§11.1②]', '浮层坐标经过视口夹取', '面板的浮层删了；右栏无浮层');

// ── [21] §11.1③ 浮层根节点必须 fixed（或 portal）────────────────────────
console.log('\n[21/37] 浮层不被裁切');
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
console.log('\n[22/37] 瞬时结果挂在活得久的地方');
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
console.log('\n[23/37] 设置面板 schema 驱动');
retired('[实现约定]', '键集来自 schema.defaults', '`SettingsPanel` 删了（管理页的设置不走 schema）');

// ── [24] 空态两分支 ──────────────────────────────────────────────────────
console.log('\n[24/37] 空态两分支');
retired('[§六]', '「真的空」与「被隐藏项过滤成空」', '面板的目录浏览删了（⚠️ 该**移植**：右栏有三类空态，见 §三）');

// ── [25] 导入结果如实展示三类清单 ─────────────────────────────────────────
console.log('\n[25/37] 导入结果如实展示');
retired('[§11.4]', 'applied / ignored / errors', '`ImportPanel` 删了；管理页的导入不受 ui-spec 管');

// ── [26] 客户端生效的设置键必须真的被读（防「只存不读」）──────────────────
console.log('\n[26/37] 设置项真的生效');
retired('[实现约定]', 'APPEARANCE_KEYS 与 virtualThreshold', '面板删了 ⇒ `density` 在客户端没有消费点了');

// ── [27] 多选的无障碍语义 ────────────────────────────────────────────────
console.log('\n[27/37] 多选的无障碍语义');
retired('[§三.3/§七]', '可选中行必须有 aria-selected', '面板的可选中行删了（⚠️ 该**移植**到右栏列表，见 §三）');

// ── [28] 拖拽语义唯一（三个方向不许打架）──────────────────────────────────
console.log('\n[28/37] 拖拽语义唯一');
retired('[实现约定]', '拖进来=登记、拖出去', '面板的拖拽删了；右栏没有拖拽');

// ── [29] hover 操作区不得改变行高（虚拟滚动靠它吃饭）─────────────────────
console.log('\n[29/37] hover 操作区不改变行高');
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

  // ⚠️ 判据要覆盖**每一处** hover 操作区，而不是只认一个类名。
  //    task-13 新增了第二处（卡片 `__cardact`），它用的是 **`opacity:0`** 而不是 `visibility:hidden`
  //    —— 我第一版只认 `visibility:hidden`，对它会**误报**（今晚第 3 次同型：把「一种实现」当「唯一实现」）。
  //    所以「默认不可见」必须是**属性级的**：`visibility:hidden` **或** `opacity:0`。
  for (const name of ['__dact', '__cardact']) {
    const base = new RegExp(name + '\\{([^}]*)\\}').exec(CLIENT_SRC);
    if (!base) {
      problems.push('找不到 `' + name + '` 的样式规则 —— hover 操作区不见了（判据前提失效，请同步更新本断言）');
      continue;
    }
    const css = base[1];
    const invisible = /visibility\s*:\s*hidden/.test(css) || /opacity\s*:\s*0(?![.\d])/.test(css);
    if (!invisible) {
      problems.push(name + ' 默认不是隐藏的（既没有 `visibility:hidden` 也没有 `opacity:0`）—— 它会在不该出现的时候占位或闪烁');
    }
    const outOfFlow = /position\s*:\s*(absolute|fixed)/.test(css);
    const reserved = /flex\s*:\s*none/.test(css) && /width\s*:\s*\d+px/.test(css);
    if (!outOfFlow && !reserved) {
      problems.push(
        name + ' 既没有脱离文档流（position:absolute/fixed），也没有预留固定占位（flex:none + 固定宽度）' +
          ' —— 悬停时行高/卡片尺寸会变，虚拟滚动必然算错'
      );
    }
    // 默认隐藏之后必须有显示路径，否则操作区永远不出现（把功能钉成隐形）
    const revealVisibility = new RegExp(name + '[^{]*\\{[^}]*visibility\\s*:\\s*visible').test(CLIENT_SRC);
    const revealOpacity = new RegExp(name + '[^{]*\\{[^}]*opacity\\s*:\\s*1(?![.\\d])').test(CLIENT_SRC);
    if (!revealVisibility && !revealOpacity) {
      problems.push('找不到「' + name + ' 在 hover / focus-within / 展开时变可见」的规则 —— 默认隐藏后没有显示路径');
    }
  }

  assert(problems.length === 0, problems.join('；'));
});

// ── [30] 产物右键菜单（task-13 新建）──────────────────────────────────────
console.log('\n[30/37] 产物右键菜单');
retired('[§11.1/§11.2]', '产物侧有右键菜单', '面板的产物右键菜单删了');

// ── [31-33] 语义搜索（不复用关键词 / 不静默降级 / 两个分支不合并）──────────
/**
 * 锚点用法：只看 `SemanticView` **函数体切片**，不做全文件 grep ——
 * 因为「语义搜索不可用」这类文案在**注释里也可能出现**，全文件匹配会命中注释
 * （我 #30 刚栽过这个坑，见那里的注释）。切片用花括号配平，不靠固定字符窗。
 */
function bodyOf(src, name, max) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  for (let j = start; j < src.length && j - start < (max || 20000); j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(start, j + 1); }
  }
  return src.slice(start, start + (max || 20000));
}

console.log('\n[31/37] 语义搜索不复用关键词查询');
retired('[实现约定]', '语义模式必须打自己的端点', '`SemanticView` 删了（⚠️ 语义搜索**本身还在**，在管理页里）');

console.log('\n[32/37] 语义不可用时不得静默降级');
retired('[§11.4]', '语义服务不可用时必须明说', '`SemanticView` 删了（管理页的语义搜索不受 ui-spec 管）');

console.log('\n[33/37] 「没有结果」与「服务不可用」必须是两个分支');
retired('[§六/§11.4]', '真没有结果 ≠ 服务不可用', '`SemanticView` 删了');

// ── [34] 不许用状态码文本判失败（必须用结构化 reason）────────────────────
console.log('\n[34/37] 失败判定必须用结构化 reason');
check('[实现约定]', '不得用状态码文本匹配判失败（indexOf("404") 之类），必须用结构化 reason', OWNER_CLIENT, () => {
  /**
   * 时序说明（这条是**升级**来的，不是一开始就该写）：
   *   我早先**故意没写**它 —— 因为当时实现只能 `msg.indexOf("404")` 判失败，
   *   钉「必须含 reason」会把一个**已知的脆做法固化成规范**，等于给它发免死牌。
   *   ⇒ 现在条件成熟：host-dev 统一了 `{ok:false, reason, error, message}`，
   *     ui-core 已把全部失败分支改用 `err.reason`。
   *   **所以这条钉的是「别再走回头路」，不是「逼你现在就改好」。**
   *   （教训：判据的「该不该写」是**有时序的判断**，不是是非判断。）
   */
  const problems = [];

  // ① 禁止「状态码文本匹配」：把状态码当字符串去找
  const bad = [...CLIENT_SRC.matchAll(/(?:indexOf|includes|search|match)\s*\(\s*["'](?:HTTP\s*)?(?:400|401|403|404|409|410|413|500|503)["']/g)];
  if (bad.length) {
    const at = bad[0].index;
    problems.push(
      'client.js:' + lineOf(CLIENT_SRC, at) + ' 仍在用状态码文本匹配判失败（`' + bad[0][0].trim() + '`）—— ' +
        '宿主已提供结构化 `reason`，请改用它（状态码文本会随文案/代理变化而失效）'
    );
  }
  // ② 配对正向要求：必须**真的**在用 reason，否则「禁用字符串」可以被「干脆不处理失败」蒙过
  if (!/\.reason\b/.test(CLIENT_SRC) && !/reason\s*===/.test(CLIENT_SRC)) {
    problems.push('全文件找不到对 `reason` 的使用（`.reason` / `reason ===`）—— 失败判定不能靠字符串，也不能干脆不判');
  }

  assert(problems.length === 0, problems.join('；'));
});

// ── [35-37] 导入文件夹（取消不弹错 / 拒绝理由不被吞 / 上限与跳过原因）──────
/**
 * 锚点：`ImportPanel` 的函数体切片（ui-core 给的 L5950→L6064，无 early-return，单个 return）。
 * ⚠️ 该面板**只在 `filters["import"] === true` 时才渲染** —— 这三条是**源码级**所以不受影响，
 *    但若将来改成渲染级，必须喂那个 filter，否则「切出来的函数体一行都不执行」。
 */
const importBody = bodyOf(CLIENT_SRC, 'ImportPanel');

console.log('\n[35/37] 取消不得被渲染成错误');
retired('[§11.4]', '中性取消文案只走提示通道', '`ImportPanel` 删了');

console.log('\n[36/37] 宿主拒绝理由不得被吞');
retired('[§11.4]', '必须把宿主的拒绝理由渲染出来', '`ImportPanel` 删了');

console.log('\n[37/37] 上限与跳过原因必须说');
retired('[§11.4]', '写明单次上限（10000）', '`ImportPanel` 删了');


// ── [38/45] R-9：节奏刻度护栏（从 ui-core 的 scratch 搬进**项目门禁**）──────────
//
// 为什么搬：这四条刻度断言原本只活在 ui-core 的 `~/.dsh/scratch/ui-check.cjs`。
//   那是**个人自查工具**，别人不会跑它 → 有人改 client.js 时 `npm test` **不会红**。
//   「我这边做了」≠「项目有了」，区别在于**谁会跑它**。
//
// 口径（避免「指定实现」）：
//   ✗ 不断言「必须是 2/4/6/8」——那是指定实现
//   ✓ 断言「取值来自一个**小的、显式列出的刻度集**」——这才是「节奏刻度」这个**不变量**
//
// 锚点形态（**先读源码确认过**，不是凭记忆）：
//   start = `"." + NS + "{"`（拼接形态，L80 —— **不是**字面量 `.alf{`）
//   end   = `].join("\n")`（那个 css 字符串数组的结束，L415）
//   ⚠️ 曾有版本用 `var features` 当结束边界 —— **源码里根本没有这个标识符**，
//      于是 CSS 区域为空 / 或静默回退成全文扫描。教训：**口头传锚点也必须以源码为准**。
function cssRegionOf(src) {
  const start = src.indexOf('"." + NS + "{');
  const end = src.indexOf('].join("\\n")', start > 0 ? start : 0);
  if (start < 0 || end < start) return null;
  return src.slice(start, end);
}
// 取不到 CSS 区域就**明说前提失效** —— 绝不静默回退到全文件
// （回退会让断言「看起来在防、其实扫全文」：**比红更糟，因为没人会去查**）
//
// ⚠️ 「长度量级」这条是有来历的：ui-core 的审计脚本曾因锚点失配
//    （`indexOf` 返回 -1、`slice(-1,-1)` 不抛）**静默回退成整份文件**（310155 字符），
//    于是它报出的刻度统计全是在全文上算的 —— **断言照样绿，绿得毫无意义**。
//    ⇒ 通用规矩：**任何 slice/substring/indexOf 取出的切片，都要配一条「形状断言」**
//      （非空 + 量级合理），否则它迟早悄悄变成「整份文件」或「空」。
function requireCssRegion(src) {
  const region = cssRegionOf(src);
  assert(region !== null,
    '取不到 CSS 区域（start=`"." + NS + "{"` / end=`].join("\\n")` 有一个失配）'
    + ' —— 判据前提失效，请同步更新本断言（**不要放宽成全文扫描**）');
  // ① 相对界：直接挡「静默回退成整份文件」——比绝对值可靠（UI 会长大，绝对值会失效）
  assert(region.length < src.length * 0.5,
    'CSS 区域占了全文 ' + Math.round(region.length / src.length * 100) + '%（>50%）——'
    + ' 锚点失配后回退了。**别放宽这条，去修锚点。**');
  // ② 非空量级
  assert(region.length > 5000,
    'CSS 区域过短：' + region.length + ' 字符（期望 >5000）—— 只切到一小段');
  // ③ ★ 内容形状（**这条才真正咬得住**）：结束锚点落错时，
  //    必然把后面的 JS 数组/函数包进来 —— 长度带区分不了这一点，形态可以。
  const jsLeak = /\bfunction\s|\bvar\s|=>/.exec(region);
  assert(jsLeak === null,
    'CSS 区域里出现了 JS 语法「' + String(jsLeak && jsLeak[0]).trim() + '」——'
    + ' 说明结束锚点落到了另一个数组/函数之后（比长度带更能咬住）');
  return region;
}
// 只认「看起来像 CSS 长度」的捕获 —— 否则会捞到 JS 里的 `gap: "` 之类
const cssLen = (v) => /^[0-9.]+(px)?(\s+[0-9.]+(px)?)*$/.test(v);
function allCss(src, region, re) {
  const out = [];
  let m;
  const r = new RegExp(re.source, re.flags);
  while ((m = r.exec(region))) out.push(String(m[1]).trim());
  return out;
}

console.log('\n[38/45] R-9 节奏刻度：gap（间距必须来自一个小刻度集）');
check('[§12]', '★ gap 只用节奏刻度 {0,2,4,6,8,10,12,16}（含「行 列」两值写法）', OWNER_CLIENT, () => {
  const region = requireCssRegion(CLIENT_SRC);
  const scale = ['0', '2px', '4px', '6px', '8px', '10px', '12px', '16px'];
  const bad = allCss(CLIENT_SRC, region, /gap:([^;"}]+)/g)
    .filter(cssLen)
    .filter((v) => v.split(/\s+/).some((one) => scale.indexOf(one) < 0));
  assert(bad.length === 0, '不在刻度上: ' + Array.from(new Set(bad)).join(' | ') + '（新增间距值必须是有意识的决定）');
});

console.log('\n[39/45] R-9 节奏刻度：字号下限');
check('[§12]', '★ 字号下限 12px（11px 及以下一律不许 —— 面板在侧栏里，本来就窄）', OWNER_CLIENT, () => {
  const region = requireCssRegion(CLIENT_SRC);
  const small = allCss(CLIENT_SRC, region, /font-size:([0-9.]+px)/g)
    .filter(cssLen)
    .filter((v) => parseFloat(v) < 12);
  assert(small.length === 0, '过小字号: ' + Array.from(new Set(small)).join(' | '));
});

console.log('\n[40/45] R-9 节奏刻度：圆角来源');
check('[§12]', '★ 圆角只用 token（或 999px 胶囊）—— 不许随手写 px', OWNER_CLIENT, () => {
  const region = requireCssRegion(CLIENT_SRC);
  const raw = allCss(CLIENT_SRC, region, /border-radius:([0-9.]+px)/g)
    .filter(cssLen)
    .filter((v) => v !== '999px');
  assert(raw.length === 0, '裸 px 圆角: ' + raw.join(' | ') + '（圆角走 token，别随手写 px）');
});

console.log('\n[41/45] R-9 对齐：按钮与输入框同一套尺寸');
check('[§12]', '★ 对齐 = 按钮与输入框**同一套尺寸**（同高不同内边距会左右错位）', OWNER_CLIENT, () => {
  const region = requireCssRegion(CLIENT_SRC);
  const btn = (region.match(/__btn\{[^}]*padding:([^;]+);/) || [])[1];
  const inp = (region.match(/__input,\._*[^}]*padding:([^;]+);/) || [])[1]
    || (region.match(/__select\{[^}]*padding:([^;]+);/) || [])[1];
  assert(btn, '取不到按钮 padding（判据前提失效，请同步更新本断言）');
  assert(btn.indexOf('5px 10px') >= 0, '按钮 padding = ' + btn + '（期望 5px 10px）');
  assert(!inp || inp.indexOf('5px 10px') >= 0, '输入/下拉 padding = ' + inp + '（与按钮不一致会左右错位）');
});

console.log('\n[42/45] R-9 节奏刻度：padding 的每个分量都在允许集内');
check('[§12]', '★ padding 分量都在允许集内（结构类豁免 44/52，但**有界**）', OWNER_CLIENT, () => {
  const region = requireCssRegion(CLIENT_SRC);
  // 节奏刻度 —— 间距类 padding 只允许这些
  const scale = ['0', '2px', '4px', '5px', '6px', '8px', '10px', '12px', '14px', '16px', '18px', '20px', '24px'];
  // 结构类豁免：44px / 52px（覆盖层留白、状态块高度）—— 它们**不是间距**。
  //   ⚠️ 豁免必须**有界**，不是「有理由」：
  //     · 有理由的豁免会扩散（哪天小按钮写 padding:44px 也绿）；有界的才可维护。
  //     · 今天实测正好 2 处：__empty（空态）/ __state（状态块）。
  const structural = ['44px', '52px'];
  const allow = scale.concat(structural);
  const combos = allCss(CLIENT_SRC, region, /padding:([0-9][^;"}]*)/g);
  const bad = [];
  const structuralUse = [];
  combos.forEach((v) => {
    v.split(/\s+/).forEach((one) => {
      if (!one) return;
      if (allow.indexOf(one) < 0) bad.push(v);
      else if (structural.indexOf(one) >= 0) structuralUse.push(one);
    });
  });
  assert(bad.length === 0, '不在允许集: ' + Array.from(new Set(bad)).join(' | '));
  // 有界性之一：总次数 ≤ 2（豁免不许扩散）
  assert(structuralUse.length <= 2,
    '结构性豁免 44px/52px 出现 ' + structuralUse.length + ' 次（>2）——'
    + ' **豁免扩散了**：它们只该用于覆盖层留白 / 状态块，别让它变成万能挡箭牌');
  // 有界性之二：这两处必须落在**已声明的结构类规则**里（而不是任意控件）
  // 实测形态（先读过源码，别猜）：`"." + NS + "__empty{…;padding:52px 20px;…}"`
  //   → __empty 用 52px、__state 用 44px（各 1 次）
  const inDeclared = ['__empty', '__state'].every((cls) => {
    const idx = region.indexOf('"' + cls);
    if (idx < 0) return false;
    return /padding:[^;]*(?:44|52)px/.test(region.slice(idx, idx + 400));
  });
  assert(inDeclared,
    '44px/52px 没有落在已声明的结构类（__empty / __state）里 ——'
    + ' 豁免只对这些规则有效；别处写同样的值应当走刻度');
});

console.log('\n[43/45] R-9 零散间距值不再出现');
check('[§12]', '零散「5px/7px/11px」不再出现在间距声明里', OWNER_CLIENT, () => {
  const region = requireCssRegion(CLIENT_SRC);
  const odd = [];
  ['gap:5px', 'gap:7px', 'padding:5px 11px', 'padding:7px 10px'].forEach((k) => {
    if (region.indexOf(k) >= 0) odd.push(k);
  });
  assert(odd.length === 0, '仍有: ' + odd.join(' | '));
});

console.log('\n[44/45] R-1：请求层两条通道都走超时通道');
check('[§12]', '★ apiGet 与 apiSend **各自**都调用 fetchWithTimeout（漏一条等于没做）', OWNER_CLIENT, () => {
  // 为什么用 bodyOf 分别切片，而不是「全文件出现 ≥2 次」：
  //   后者是「太松」—— 把两处都塞进 apiGet 也能凑够 2 次。
  const problems = [];
  const g = bodyOf(CLIENT_SRC, 'apiGet');
  const s = bodyOf(CLIENT_SRC, 'apiSend');
  if (!g) problems.push('找不到 `apiGet` —— 判据前提失效，请同步更新本断言');
  else if (!/fetchWithTimeout\s*\(/.test(g)) problems.push('apiGet 没走超时通道（慢请求会停在骨架屏）');
  if (!s) problems.push('找不到 `apiSend` —— 判据前提失效，请同步更新本断言');
  else if (!/fetchWithTimeout\s*\(/.test(s)) problems.push('apiSend 没走超时通道（漏一条 = 没做）');
  assert(problems.length === 0, problems.join('；'));
});

console.log('\n[45/45] R-1：超时与「插件没装」必须是两条不同的失败');
retired('[§12]', '超时 / 普通失败 文案不同', '面板的加载失败分流删了；右栏的失败文案在 `RightPaneBody`');

// ── 汇总 ──────────────────────────────────────────────────────────────────
if (retiredList.length) {
  console.log('\n── 已废弃的条款（' + retiredList.length + ' 条 · 主体随主面板一起删了）──');
  console.log('   ⚠️ 它们**不是**"不用管了"：其中几条该**移植**到右栏，见');
  console.log('      `docs/DEPRECATED-TESTS.md` §三「待补」。');
  for (const r of retiredList) console.log('      · ' + r.spec + ' ' + r.title + ' —— ' + r.reason);
}
if (failureList.length) {
  console.log('\n── 失败清单（按负责人）──');
  for (const owner of [OWNER_CLIENT, OWNER_ICONS, OWNER_TABLES]) {
    const mine = failureList.filter((f) => f.owner === owner);
    if (!mine.length) continue;
    console.log('  ▸ ' + owner);
    for (const f of mine) console.log('      · ' + f.spec + ' ' + f.title + ' → ' + f.message);
  }
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败'
  + (retiredList.length ? ' / ' + retiredList.length + ' 已废弃' : ''));
process.exit(failed ? 1 : 0);
