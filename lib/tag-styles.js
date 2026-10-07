/**
 * dsh-artifact-library — 标签「醒目样式」的规则层（图标 / 颜色 / 字重 / 字号）
 *
 * ── 要解决的问题（依琪 2026-10-06 原话）────────────────────────────────────
 *
 * 「标签同样可以多一些自定义内容……用合适的**图标**，**颜色**跟**字号**，
 *   **是否加粗**等等来更醒目分类」
 *
 * ── ⭐ 本模块第一件要说清的事：「受管标签 / 自由关键词」怎么分 ───────────────
 *
 * 曾经有人（包括我）把判据写成「**有样式的 = 受管**」。**那是循环定义，而且是鸡生蛋**：
 * 样式机制就是本模块要新建的东西 ⇒ 在它存在之前，「有没有样式」这个判据恒为假。
 * 更要命的是它**方向反了**：
 *
 *   ❌ `受管 := 有样式`   —— 于是「给它配个颜色」就等于「把它升格成受管」，
 *                            844 个自由词随便配个色就成了受管，上限形同虚设；
 *   ✅ `受管 := 进过受管表` —— 有 id、有定义、可被自动打、可被重命名/合并。
 *                            **样式是「进过受管表」的结果，不是它的判据。**
 *
 * ⇒ 本模块里**唯一**的分层判据是 `layerOf(tag, managed)`：**这个标签在不在受管表里**。
 *   它**一个样式字段都不看**。测试里有一条反向断言钉住这一点：
 *   给一个不在表里的自由词挂上 `color:'red'`，它**照样判 free**
 *   —— 样式不能把一个标签「升格」成受管（`[E] E3`）。
 *
 * ⇒ 结构上的推论（有意为之，不是巧合）：**样式存在受管表的每条条目里**，
 *   不另开一张 `tag → style` 的映射。这样「自由词带着样式」这种状态
 *   **在数据形状上就不可能出现**，不需要靠纪律维持。
 *   而「只写样式、没写 id」的条目会在校验期被**明确拒绝**并告诉他正确做法
 *   （`[E] E1`）—— 这条错误信息就是上面那段话的代码化。
 *
 * ── ⭐ 第二件事：为什么这个文件比 `tags.js` / `categories.js` 多一层 builder ──
 *
 * `tags.js` / `categories.js` 是「纯函数 + 直接 export」，因为它们只被 Node 侧消费。
 * **本模块不一样：它必须被客户端消费**（标签芯片渲染在面板里）。
 * 而客户端有那条硬约束 ——（`lib/icons.js:16-27` 实测）
 * 插件运行时**加载不到包内相对 ESM**，`lib/client.js` 只能**内联**。
 *
 * 所以本文件照 `icons.js` 的既有答案办：
 *   · `TAG_STYLE_TABLE`      —— **纯 JSON 可序列化**的数据表（无函数、无正则）
 *   · `buildTagStyleRule()`  —— **自包含**纯函数（不引用本文件任何私有名字）
 * 这两段可以**整段复制**进 `client.js`，不需要人工翻译任何一行逻辑。
 * `test/tag-styles.test.mjs` 的 `[I]` 节用 `new Function` 在「没有模块私有作用域」
 * 的环境里把它重建一遍并逐个比对 —— 那才是「可内联」的证明，不是一句声明。
 *
 * ⚠️ 内联需要指纹（照 `client.js:1635` 的 `INLINE-ICONS` 约定）：本文件的
 *   `sha256[:16]` 要写进内联区注释，两边不一致 = 漂移。
 *   本模块**不自己写生成器**（`scratch/inline-icons.cjs` 已不在仓库里，
 *   重新造一个是接线方的活）；这里只保证**源头的形状**是机械可复制的。
 *
 * ── ⭐ 第三件事：颜色为什么只能用「色板槽名」────────────────────────────────
 *
 * `lib/icons.js:7-8` 的原话是硬规矩：
 *   「**禁止 hex**：颜色只允许 `var(--dsw-static-*)`（media 是唯一例外，
 *     官方注明 violet 无对应 token，写 rgb()）」
 * 理由（`docs/UI-SPEC-v1.md` §一.2）：宿主在 `<body>` 挂 `data-ds-dark-theme`
 * 并重绑 alias 值，**走 token 才零感知跟随深色模式**；自己写 hex 就永远不跟随。
 *
 * ⇒ 本模块**不新增任何一个颜色**。色板 = 把 `FILE_TYPE_COLORS` 已有的 8 个色值
 *   **起个语义槽名**（`blue` / `green` / …）。这是可测的结构关系，不是口号：
 *   `[A]` 节断言「每个色板值都必须出现在 `FILE_TYPE_COLORS` 的取值里」——
 *   将来谁想偷偷加一个 `#ff0000`，这条立刻红。
 *
 * ⚠️ 顺带一个**诚实的代价**：色板是**借来的**，所以 `blue`（deepseek-500）与
 *   `sky`（deepseek-450）**色相接近**，8 个槽位里真正拉开距离的约 6 个。
 *   「要不要给标签另立一套真正的色板（需要新增官方 token）」是**设计取舍**，
 *   列在定稿的「待依琪确认」里，**我不替他定**。
 *
 * ── ⭐ 第四件事：优先级「颜色 > 图标 > 字重 > 字号」是什么意思 ────────────────
 *
 * 这条来自方案定稿，但**它没有第二个消费点**（只写在文档里）。本模块把它落成
 * **渲染通道的取舍顺序**：`channels` 数组的**次序即优先级**，
 * 于是「面（surface）能显示哪些通道」= 按优先级过滤出来的子序列。
 *
 * 唯一有实际后果的一条：**字号只在分组标题上成立**（`chip` 上直接砍）。
 *   依据（`client.js:441-442` + 方案复核）：标签芯片是
 *   `height:calc(26px + var(--dsh-content-font-delta,0px))` 的胶囊，字号只破坏行高。
 *   ⇒ `channelsFor('chip')` 不含 `size`，`applySurface` 会把它**摘掉并说明理由**
 *     （不是静默丢）。
 *
 * ⚠️ 优先级剩下的部分（颜色为什么排在图标前面）**目前只有文档理由、没有代码后果**。
 *   我不打算为了「让优先级有用」去发明一个假的消费点 —— 那正是本仓库最讨厌的
 *   那种「看起来在防、其实在空转」的代码。这条在定稿里标成待确认。
 *
 * 纯 ESM、零 `node:` 依赖、不碰 fs、不依赖 ctx —— 可直接单测，也可被内联。
 */

import { FILE_TYPE_COLORS, ICON_TABLE } from './icons.js'
import { normalizeTag } from './tags.js'

/* ════════════════════════════════════════════════════════════════════════════
 * 色板：槽名 → FILE_TYPE_COLORS 的键
 *
 * ⚠️ 右列**必须是 `FILE_TYPE_COLORS` 里真实存在的键** —— 本文件不写字面色值。
 *   这样「不新增颜色」变成了一条**结构性的**事实：改 `icons.js` 就会改到这里，
 *   没有第二处可以漂移。（`categories.js` 头部骂的「五张互不相干的扩展名表」
 *   就是这个毛病：同一件事各写一份，然后互相漂移。）
 *
 * 槽名的选法：用**颜色本身的词**（blue / green / …），不用 `code` / `pdf`
 * 这种文件类型名 —— 标签是「什么活」，借文件类型的语义会读出错误的暗示。
 * ════════════════════════════════════════════════════════════════════════════ */
const COLOR_SOURCES = {
  neutral: 'other',   // --dsw-static-neutral-bluish-300
  blue: 'code',       // --dsw-static-deepseek-500
  sky: 'word',        // --dsw-static-deepseek-450（与 blue 同族、浅一档）
  green: 'excel',     // --dsw-static-green-500
  amber: 'ppt',       // --dsw-static-amber-500
  orange: 'folder',   // --dsw-static-amber-400
  red: 'pdf',         // --dsw-static-red-600
  violet: 'media',    // rgb(139,118,246) —— icons.js 注明的**唯一**非 token 例外
}

/**
 * 字号档位。
 *
 * ⚠️ 三条约束把这三个值夹得很死，都是**从代码里核实过的**，不是审美：
 *
 *   ① **R-9 字号下限 12px**（`test/ui-spec.test.mjs:1568`：`font-size` 低于 12px 一律红）。
 *      ⇒ `small` 不能再往下走。
 *   ② **必须跟随内容缩放**（`UI-SPEC-v1.md` §一.3：宿主有 `--dsh-content-font-*`，
 *      硬编码字号的插件在用户调界面字号时会错位）。`client.js` 全篇的既有写法就是
 *      `var(--dsh-content-font-size-secondary, 13px)` —— 本文件照抄这个口径，
 *      连 fallback 一起抄。
 *   ③ ⇒ `small` 只能**从既有的最小档减 1px** 得出（13−1=12，正好压在 R-9 下限上）。
 *      记成 `calc(... - 1px)` 而不是写死 `12px`，**恰恰是为了 ②**：
 *      写死 12px 会在用户放大界面字号时缩成「比正文还小」。
 *
 * ⚠️ 代价要说清楚：三档实际只差 **12 / 13 / 14**，层级**很弱**。
 *   要更明显的层级就得引入一个更大的字号，那要么破 R-9 的刻度纪律、
 *   要么新立一个 token —— 两者都不是我一个规则层能定的。**列进待确认。**
 */
const SIZE_VALUES = {
  small: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
  normal: 'var(--dsh-content-font-size-secondary, 13px)',
  large: 'var(--dsh-content-font-size, 14px)',
}

/**
 * 字重档位。**600 而不是 700** —— 理由是核实过的：
 * `client.js` 里「加粗」的既有口径全是 `font-weight:600`
 * （`__title` / `__grouph` / `__cardtitle` / `__seth` / `__mergetitle`…）。
 * 用 700 会让标签比应用自己的标题还重 —— 那叫抢戏，不叫醒目。
 * 400 = 正文默认（浏览器默认值，也是本文件「不加粗」的语义）。
 */
const WEIGHT_VALUES = { normal: 400, bold: 600 }

/**
 * 受管标签的**硬上限**。
 *
 * ⚠️ 这个数字**两份既有文档对不上**，我如实记：
 *   · `任务板/产物库-下一阶段-真实方案.md:113` 写的是 **32**；
 *   · `任务板/产物库-下一阶段方案-讨论稿.md:305`（复核）建议 **12~16**，
 *     理由是「否则『受管』会长成第二个 844」。
 * ⇒ 我取 **16**（复核那一档的上沿，给「按维度分几组」留了余量），
 *   **并把它标成待依琪拍板**：这是个常量，改一个数即可，不需要动任何逻辑。
 *
 * ⚠️ 超限的行为：**明确拒绝并说出现在有几个**，绝不静默顶掉最旧的那个。
 *   照「孤儿不隐藏」（`categories.js:106-109`）和「没给 reassign_to 时一个字都不改」
 *   的既有口径 —— 静默降级会让人以为操作成功，那比报错糟得多。
 */
const MANAGED_LIMIT = 16

/* ════════════════════════════════════════════════════════════════════════════
 * TAG_STYLE_TABLE —— 样式规则的**单一真相源**（纯 JSON 可序列化）
 *
 * 与 `ICON_TABLE` 同一约定：只有字符串 / 数字 / 数组 / 对象，
 * **没有函数、没有正则**（`JSON.parse(JSON.stringify(TAG_STYLE_TABLE))` 往返无损，
 * 见 `[I] I1`）。内联进 `client.js` 时把本表的字面量 + `buildTagStyleRule` 的
 * 源码整段粘过去即可。
 *
 * ⚠️ 键名是**冻结契约**的一部分（改动要让内联副本跟），不要随手增删。
 * ════════════════════════════════════════════════════════════════════════════ */
export const TAG_STYLE_TABLE = {
  /** 色板：槽名 → 主题 token（或 icons.js 注明的那个 rgb 例外） */
  colors: Object.fromEntries(
    Object.keys(COLOR_SOURCES).map((slot) => [slot, FILE_TYPE_COLORS[COLOR_SOURCES[slot]]]),
  ),
  // ⚠️ 这里**刻意没有** `colorFallback`（「没配颜色时落到某一槽」）。
  //    第一版写了它，然后自己删掉了 —— 理由是它**根本没有消费点**：
  //    分层判据只看「在不在受管表里」，不看颜色；而「受管但没配颜色的芯片长什么样」
  //    是**渲染**的决定，属于接线方，不属于规则层。
  //    留一个没人用的配置项，就是本仓库已经吃过亏的那种东西
  //    （`--dsw-font-mono` 就是幽灵 token：名字看着官方，全量官方包里 0 个定义点）。
  //    ⇒ 「没配颜色」在本模块里的正确答案是 `null`，由调用方自己决定怎么显示。

  /**
   * 可选图标 = `ICON_TABLE.shapes` 的键（16 个语义图形）。
   * ⚠️ **从 icons.js 现取的键**，不是自己列的清单 —— 图标集是内联进客户端的，
   *   自造名字会得到「配置合法但渲染空白」。这 16 个同时也是
   *   `settings.js` 的 `CATEGORY_ICONS`（`[B]` 节断言三者同集合，防止漂移）。
   * 顺序 = `SHAPE_SVG` 的声明顺序，**直接当选择器的展示顺序用**。
   */
  icons: Object.keys(ICON_TABLE.shapes),

  /** 字重档位：档名 → 数值 */
  weights: { ...WEIGHT_VALUES },
  /** 字号档位：档名 → CSS 值（只在分组标题上有意义，见 `channelSurface`） */
  sizes: { ...SIZE_VALUES },

  /** 渲染通道，**次序即优先级**：颜色 > 图标 > 字重 > 字号 */
  channels: ['color', 'icon', 'weight', 'size'],

  /**
   * 每个通道在哪些「面」上有意义。
   *   `both`  = 芯片和分组标题都成立
   *   `group` = **只有分组标题成立**（芯片上会破坏行高，见文件头）
   */
  channelSurface: {
    color: 'both',
    icon: 'both',
    weight: 'both',
    size: 'group',
  },

  /** 有名字的两个面。`chip` 最受限 ⇒ 认不出的 surface 一律按它办（保守方向） */
  surfaces: {
    chip: '标签芯片',
    group: '分组标题',
  },

  /** 受管标签上限（见 MANAGED_LIMIT 的注释：16 vs 32 待依琪拍板） */
  limit: MANAGED_LIMIT,
}

/**
 * 由一张纯数据表造出**全部**规则函数 —— **自包含**（不引用本文件任何私有名字），
 * 因此可以整段复制进 `lib/client.js`。
 *
 * @param {object} [table] 形如 `TAG_STYLE_TABLE` 的纯数据表
 * @param {(s:unknown)=>string} [keyOf] 「同一个标签的两种写法」归一化函数。
 *   默认是逐字相等（`String(s)`）。模块级默认传 `normalizeTag`
 *   （`lib/tags.js`）—— 传进来而不是 import，是为了让本函数保持自包含。
 * @returns {object} 见下面各方法的注释
 */
export function buildTagStyleRule(table, keyOf) {
  const t = table && typeof table === 'object' ? table : {}
  const colors = t.colors && typeof t.colors === 'object' ? t.colors : {}
  const icons = (Array.isArray(t.icons) ? t.icons : []).filter((x) => typeof x === 'string')
  const weights = t.weights && typeof t.weights === 'object' ? t.weights : {}
  const sizes = t.sizes && typeof t.sizes === 'object' ? t.sizes : {}
  const channels = (Array.isArray(t.channels) && t.channels.length ? t.channels : ['color', 'icon', 'weight', 'size'])
    .filter((c) => typeof c === 'string')
  const channelSurface = t.channelSurface && typeof t.channelSurface === 'object' ? t.channelSurface : {}
  const surfaces = t.surfaces && typeof t.surfaces === 'object' ? t.surfaces : {}
  const limit = Number.isFinite(t.limit) && t.limit > 0 ? Math.trunc(t.limit) : 16
  const key = typeof keyOf === 'function' ? keyOf : function (s) { return s === null || s === undefined ? '' : String(s) }

  const COLOR_SLOTS = Object.keys(colors)
  const COLOR_VALUES = COLOR_SLOTS.map(function (slot) { return colors[slot] })
  const WEIGHT_NAMES = Object.keys(weights)
  const SIZE_NAMES = Object.keys(sizes)
  const SURFACE_NAMES = Object.keys(surfaces)
  /** 样式字段的白名单 —— **遍历这张表，不遍历输入的键**（`validateCategories` 的既有套路） */
  const STYLE_FIELDS = ['color', 'icon', 'weight', 'size']
  /**
   * id 的形状。与 `settings.js` 的 `CATEGORY_ID_RE` **同源但各写一份** ——
   * 理由照 `categories.js:177-179`：本模块要零 `node:` 依赖、要保持可内联，
   * 不能 import 一个自己写着 `import fs from 'node:fs'` 的模块。
   * **测试里有一条断言两份必须同值**（`[B] B3`），防止漂移。
   */
  const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

  function isPlain(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }
  function text(v) {
    return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v))
  }

  /* ── 色板 ─────────────────────────────────────────────────────────────── */

  /**
   * 校验一个颜色值，返回它对应的**槽名**。
   *
   * 接受两种写法（都必须在色板里）：
   *   ① 槽名本身：`'red'`（大小写不敏感、可带首尾空白）
   *   ② 色板里已有的**完整字面量**：`'var(--dsw-static-red-600)'` / `'rgb(139,118,246)'`
   *      —— 取值器从 `TAG_STYLE_TABLE.colors` 读到什么就该能原样填回来。
   *
   * ⚠️ **hex 一律拒绝，不做「就近映射」**。这条路我**刻意不走**，理由：
   *   · 「最近的 token」是我在猜他的意图 —— `#ff0000` 到底是 `red`(pdf) 还是
   *     状态色里的 error？没有唯一答案，而我一旦猜错，用户看到的是
   *     「设置成功了」（因为他填的颜色被吃掉了），这比报错坏得多；
   *   · 而且静默改写会把**深色模式翻车**这件事藏起来：他以为自己填了红，
   *     换到深色主题发现颜色没跟着变，却不知道是被改写过的。
   *   ⇒ `test/tag-styles.test.mjs` 的 `[C]` 节是**反向断言**：hex、rgb()/hsl()
   *     的非色板值、CSS 颜色名、`var()` 里的未知 token —— **全部必须被拒**。
   *
   * @returns {{ok:true, slot:string, value:string}|{ok:false, reason:string}}
   */
  function resolveColor(input) {
    if (typeof input !== 'string') {
      return { ok: false, reason: '颜色要写成色板槽名的字符串，收到 ' + JSON.stringify(input ?? null) }
    }
    const raw = input.trim()
    if (!raw) return { ok: false, reason: '颜色不能是空字符串（不想要颜色就别写这个字段）' }
    if (raw.indexOf('#') >= 0) {
      return {
        ok: false,
        reason: '颜色里不许出现 hex（' + JSON.stringify(raw) + '）。'
          + 'lib/icons.js 头部写着「禁止 hex：颜色只允许 var(--dsw-static-*)」——'
          + '自己写死颜色在深色模式下不会跟随主题（宿主靠重绑 token 换色）。'
          + '可选色板槽名：' + COLOR_SLOTS.join(' / '),
      }
    }
    // ① 槽名
    if (Object.prototype.hasOwnProperty.call(colors, raw)) return { ok: true, slot: raw, value: colors[raw] }
    const lower = raw.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(colors, lower)) return { ok: true, slot: lower, value: colors[lower] }
    // ② 色板里已有的完整字面量（取值器填回来的那条路）
    const hit = COLOR_VALUES.indexOf(raw)
    if (hit >= 0) return { ok: true, slot: COLOR_SLOTS[hit], value: raw }
    return {
      ok: false,
      reason: '颜色只接受色板槽名（' + COLOR_SLOTS.join(' / ') + '）'
        + '或色板里已有的完整 token 字面量；收到 ' + JSON.stringify(raw) + '。'
        + '⚠️ 色板不是可以自由发挥的 —— 它借的是 icons.js 的官方色表，本模块不新增颜色。',
    }
  }

  /* ── 样式对象 ─────────────────────────────────────────────────────────── */

  /**
   * 被否决过的写法 → 该写什么。
   * 只收录**已经见过/可预期**的误写，用来把 notes 写成「可执行的纠正」。
   * ⚠️ 这是**提示表，不是别名表** —— 命中它不会自动改写（见 `normalizeStyle` ①）。
   */
  const UNKNOWN_HINTS = {
    bold: 'weight',
    isBold: 'weight',
    fontWeight: 'weight',
    fontSize: 'size',
    colour: 'color',
    bg: 'color',
    background: 'color',
    iconName: 'icon',
  }

  /**
   * 校验并**规范化**一个样式对象。
   *
   * 形状照 `validateCategories`（`settings.js:460-475`）的既有套路：
   * **遍历自己写死的字段名、不遍历输入的键**；每个字段单独类型检查；
   * 返回**全新对象**（绝不把输入对象原样存进去）。
   *
   * 两条与 `validateCategories` 不同的地方，都是**理由充分的**：
   *
   * ① **未知字段不静默丢** —— 进 `notes`，并且**必须点名**「哪个键、该写什么」。
   *    理由：依琪原话是「**是否加粗**」—— 一个很自然的写法就是
   *    `{ bold: true }`。静默丢掉它 = 「agent 以为设了加粗，界面上是普通」
   *    = 本仓库反复要防的**静默空转**。`notes` 非空是调用方该看的东西
   *    （`settings.js` 的导入也是这个形状：`{ok, values, ignored, errors}`）。
   *    ⚠️ 但**不做别名自动改写**：`bold` 不会被当成 `weight:'bold'`。
   *    一个字段只准有一种写法，否则立刻长出第二套词汇表。
   * ② **越界是拒绝，不是夹紧** —— 与 `RANGES`（数值型，夹紧）**刻意不同**。
   *    这些是**枚举**，不是有序量：「字号填 99」夹成 `large` 是在替用户猜，
   *    而 `ENUMS` 的既有口径就是「只接受这些值，其它一律拒绝（不夹、不猜）」。
   *
   * @param {unknown} input
   * @returns {{ok:true, style:object, notes:string[]}|{ok:false, reason:string}}
   */
  function normalizeStyle(input) {
    if (input === null || input === undefined) return { ok: true, style: {}, notes: [] }
    if (!isPlain(input)) return { ok: false, reason: '样式要是一个对象，收到 ' + JSON.stringify(input ?? null) }
    const style = {}
    const notes = []
    for (const field of STYLE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(input, field)) continue
      const value = input[field]
      // 显式写 null / undefined = 「这条通道不设置」。与「字段不存在」等价，不算错。
      if (value === null || value === undefined) continue
      if (field === 'color') {
        const r = resolveColor(value)
        if (!r.ok) return { ok: false, reason: r.reason }
        style.color = r.slot
        continue
      }
      if (field === 'icon') {
        if (typeof value !== 'string' || icons.indexOf(value) < 0) {
          return {
            ok: false,
            reason: '图标只接受 icons.js 里已有的形状名：' + icons.join(' / ')
              + '；收到 ' + JSON.stringify(value ?? null)
              + '。⚠️ 别自造图标名 —— 图标集是内联进客户端的，自造会得到「配置合法但渲染空白」。',
          }
        }
        style.icon = value
        continue
      }
      if (field === 'weight') {
        if (typeof value !== 'string' || WEIGHT_NAMES.indexOf(value) < 0) {
          return {
            ok: false,
            reason: '字重只有两档：' + WEIGHT_NAMES.join(' / ') + '；收到 ' + JSON.stringify(value ?? null)
              + '。⚠️ 不收数值（如 ' + JSON.stringify(weights[WEIGHT_NAMES[0]]) + '）—— 「受限档位」的意思是'
              + '档名固定，数值由本模块给（见 WEIGHT_VALUES 的注释：600 才是本项目的「加粗」口径）。',
          }
        }
        style.weight = value
        continue
      }
      if (field === 'size') {
        if (typeof value !== 'string' || SIZE_NAMES.indexOf(value) < 0) {
          return {
            ok: false,
            reason: '字号只有三档：' + SIZE_NAMES.join(' / ') + '；收到 ' + JSON.stringify(value ?? null)
              + '。⚠️ 不接受任意值 —— 844 个标签里如果 10 个标签 10 种字号，'
              + '那不是更醒目，是更花。',
          }
        }
        style.size = value
        continue
      }
    }

    // 未知字段 → notes（**必须点名 + 给出该写的键**，否则这条提示等于没有）
    for (const k of Object.keys(input)) {
      if (STYLE_FIELDS.indexOf(k) >= 0) continue
      const suggest = UNKNOWN_HINTS[k]
      notes.push(
        suggest
          ? '样式里的 ' + JSON.stringify(k) + ' 不认识，已忽略 —— 要写的是 ' + JSON.stringify(suggest) + '。'
          : '样式里的 ' + JSON.stringify(k) + ' 不认识，已忽略（可用字段：' + STYLE_FIELDS.join(' / ') + '）。',
      )
    }
    return { ok: true, style, notes }
  }

  /* ── 受管表 ───────────────────────────────────────────────────────────── */

  /**
   * 校验并规范化**整张受管标签表**。
   *
   * 一条受管条目 = `{ id, tag, color?, icon?, weight?, size? }`
   *   · `id` —— **稳定的身份**（改名时靠它把样式跟住，照分类 id/label 的分工）
   *   · `tag` —— 记录里**逐字出现**的那个字符串（`rec.tags` 里存的原文）
   *   · 其余 4 个是样式，可缺 —— **缺样式的条目照样是受管**（这正是「样式不是判据」）
   *
   * ⚠️ `tag` **逐字保留、不 trim** —— 这是 3b 学到的教训（`tags.js:286-289`）：
   *   `[管理] 任何一次 trim 都会让键对不上记录里的值`，结果就是
   *   「报告说改了、实际一条没改」的静默空转。
   *   但**首尾带空白本身要拒绝**：那种条目**永远匹配不到任何记录**（记录里的标签
   *   要么是 trim 过的、要么是别的写法），它是**死配置**，静默接受等于骗人。
   *
   * @param {unknown} value
   * @returns {{ok:true, value:object[], notes:string[]}|{ok:false, reason:string}}
   */
  function validateManaged(value) {
    if (value === undefined || value === null) return { ok: true, value: [], notes: [] }
    if (!Array.isArray(value)) return { ok: false, reason: '受管标签表需要数组，收到 ' + JSON.stringify(value ?? null) }
    if (value.length > limit) {
      return {
        ok: false,
        reason: '受管标签最多 ' + limit + ' 个，收到 ' + value.length + ' 个。'
          + '⚠️ 「受管」的整个意义是「一小撮能被看见的」，超了它会长成第二个 844。'
          + '要加新的，先合并掉旧的 —— 本模块**不会**替你顶掉最后一个（静默降级比报错糟得多）。',
      }
    }
    const out = []
    const seenId = new Set()
    const seenTag = new Set()
    const seenKey = new Map()
    const notes = []
    for (let i = 0; i < value.length; i += 1) {
      const raw = value[i]
      const at = '受管标签[' + i + ']'
      if (!isPlain(raw)) return { ok: false, reason: at + ' 需要对象，收到 ' + JSON.stringify(raw ?? null) }
      const id = typeof raw.id === 'string' ? raw.id : ''
      const tag = typeof raw.tag === 'string' ? raw.tag : ''
      const hasStyle = STYLE_FIELDS.some(function (f) {
        return Object.prototype.hasOwnProperty.call(raw, f) && raw[f] !== null && raw[f] !== undefined
      })
      if (!id) {
        // ★★ 这条错误信息就是本模块文件头那段话的代码化。
        if (hasStyle) {
          return {
            ok: false,
            reason: at + ' 写了样式却没有 id。'
              + '⚠️ 判据不是「有没有样式」—— 那是循环定义（样式机制就是本模块要新建的东西，'
              + '在它存在之前「有没有样式」恒为假），方向也是反的（那样「随便配个色」就等于升格成受管）。'
              + '**受管的判据是「进过受管表」：有 id、有定义、可被自动打、可被重命名/合并。**'
              + '样式是「进过受管表」的**结果**，不是它的判据。请补上 id。',
          }
        }
        return { ok: false, reason: at + ' 缺少 id。每一受管标签都要有一个稳定身份（改名时靠它把样式跟住）。' }
      }
      if (!ID_RE.test(id)) {
        return {
          ok: false,
          reason: at + '.id 不合法（只接受 /^[a-z][a-z0-9_-]{0,31}$/）：' + JSON.stringify(raw.id)
            + '。⚠️ 小写字母开头是为了排除 __proto__ 这类键 —— 与分类 id 同一条规矩。',
        }
      }
      if (seenId.has(id)) return { ok: false, reason: at + '.id 重复：' + id }
      seenId.add(id)

      if (!tag) return { ok: false, reason: at + '.tag 不能为空（它是记录 rec.tags 里逐字出现的那个字符串）' }
      if (tag !== tag.trim()) {
        return {
          ok: false,
          reason: at + '.tag 首尾有空白：' + JSON.stringify(tag) + '。'
            + '⚠️ 本模块**逐字**匹配记录里的标签（不 trim、不改大小写）——'
            + '所以带空白的条目**永远匹配不到任何记录**，是死配置。'
            + '如果记录里真有带空白的标签，先按 3b 的名字收敛把它改掉，再来配样式。',
        }
      }
      if (seenTag.has(tag)) return { ok: false, reason: at + '.tag 重复：' + JSON.stringify(tag) }
      seenTag.add(tag)
      // 同一件事的两种写法（DSH / dsh）不该各占一个受管位 ——
      // 那等于在受管层重演 3b 要治的那个病（标签没有收敛）。
      const norm = key(tag)
      if (seenKey.has(norm)) {
        notes.push(
          '「' + tag + '」与「' + seenKey.get(norm) + '」是同一个标签的两种写法（归一化后都是 '
          + JSON.stringify(norm) + '）—— 它们不该各占一个受管位。先走 3b 的合并把它收敛成一个。',
        )
      } else {
        seenKey.set(norm, tag)
      }

      // 样式字段：**展平存**（与 DEFAULT_CATEGORIES 把 icon 展平进条目同一形状）。
      // 拆成 `{ tag, style:{...} }` 也能跑，但那样「自由词带样式」在数据形状上就
      // 重新变得可能了 —— 展平让那种状态根本表达不出来。
      const styleInput = {}
      for (const f of STYLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(raw, f)) styleInput[f] = raw[f]
      }
      const checked = normalizeStyle(styleInput)
      if (!checked.ok) return { ok: false, reason: at + '.' + checked.reason }
      const entry = { id, tag }
      for (const f of STYLE_FIELDS) if (checked.style[f] !== undefined) entry[f] = checked.style[f]
      for (const n of checked.notes) notes.push(at + ': ' + n)
      // 条目级未知字段也要报（否则 `{id,tag,size:'large',siz:'x'}` 里的错字静默消失）
      for (const k of Object.keys(raw)) {
        if (k === 'id' || k === 'tag' || STYLE_FIELDS.indexOf(k) >= 0) continue
        notes.push(at + ' 里的 ' + JSON.stringify(k) + ' 不认识，已忽略（可用字段：id / tag / ' + STYLE_FIELDS.join(' / ') + '）。')
      }
      out.push(entry)
    }
    return { ok: true, value: out, notes }
  }

  /**
   * 建索引：逐字 tag → 条目（**首选**），归一键 → 条目（**兜底**）。
   *
   * ── 为什么要两级，以及为什么兜底是安全的 ─────────────────────────────────
   *
   * ⚠️ 3b 的铁律是「**逐字**匹配，任何一次 trim 都会让键对不上记录里的值」
   *   （`tags.js:286-289`）。那条铁律约束的是**写**（swap 的键必须与记录里的值逐字相等），
   *   **不是读**。本函数只服务**渲染**：渲染不改数据，函数式取一个条目来上色上图标。
   *   所以这里可以在「逐字」之外再加一级比它**宽**的兜底，而不会造成静默改写。
   *
   * 兜底为什么**必须**有：真库里就有 9 组「同一件事的两种写法」并存
   *   （`DSH`/`dsh`、`godot`/`Godot`…，见 `lib/tags.js` 头部）。3b 的合并是
   *   **要人确认**的、可能一直没做。若这里只认逐字，用户给 `DSH` 配了颜色之后，
   *   挂在 `dsh` 上的记录会**渲染成素净的** —— 看上去像两个毫不相干的东西，
   *   而这恰恰是 `validateManaged` 会提示、本模块要避免的不一致。
   *
   * 次序是**逐字优先**：万一表里两种写法各有一条（合法，会带提示），
   *   各自认各自的那条，更具体的那条赢。
   */
  function indexManaged(managed) {
    const byTag = new Map()
    const byKey = new Map()
    for (const item of Array.isArray(managed) ? managed : []) {
      if (!isPlain(item) || typeof item.tag !== 'string') continue
      if (!byTag.has(item.tag)) byTag.set(item.tag, item)
      const k = key(item.tag)
      if (k && !byKey.has(k)) byKey.set(k, item)
    }
    return { byTag, byKey }
  }

  /**
   * ★★ **唯一**的分层判据：这个标签在不在受管表里。
   *
   * ⚠️ 本函数**一个样式字段都不看**。测试 `[E] E3` 钉住：给一个不在表里的
   *   自由词挂上 `color:'red'`，它照样判 `free` —— 样式不能把标签升格成受管。
   *
   * ⚠️ 首尾带空白的写法**明确判 free**（不进兜底）：兜底是为了容纳「装饰符 / 大小写
   *   差异」，**不是**为了容纳「多个空格」。`"alpha "` 与 `"alpha"` 在渲染上看起来一样、
   *   但在数据上是两个标签 —— 那是 3b 该治的，渲染层假装它们一样只会把问题盖住。
   *
   * @returns {'managed'|'free'}
   */
  function layerOf(tag, managed) {
    return entryOf(tag, managed) ? 'managed' : 'free'
  }

  /** 取受管条目（没有就返回 null）。`layerOf` 就是它的布尔版，两者绝不各写一套。 */
  function entryOf(tag, managed) {
    const name = typeof tag === 'string' ? tag : ''
    if (!name || name !== name.trim()) return null
    const idx = indexManaged(managed)
    if (idx.byTag.has(name)) return idx.byTag.get(name)
    const k = key(name)
    return k && idx.byKey.has(k) ? idx.byKey.get(k) : null
  }

  /* ── 面（surface）与展示 ───────────────────────────────────────────────── */

  /**
   * 某个面上成立哪些通道，**按优先级顺序**返回（次序 = `channels` 的次序）。
   * 认不出的面按**最受限**的那个办（保守方向：宁可少显示，不可破行高）。
   */
  function channelsFor(surface) {
    const name = typeof surface === 'string' && Object.prototype.hasOwnProperty.call(surfaces, surface) ? surface : 'chip'
    return channels.filter(function (c) {
      const scope = channelSurface[c]
      return scope === 'both' || scope === name
    })
  }

  /**
   * 把一个样式按「面」裁剪 —— 摘掉这个面上不成立的通道，**并说明理由**。
   *
   * ⚠️ 摘掉不是丢弃：返回的 `style` 是**新对象**，入参不动 ⇒ 存下来的样式永远是完整的，
   *   换一个面（分组标题）就能拿到 `size`。`dropped` 让调用方**必须有机会**告诉用户
   *   「字号在芯片上不生效」，而不是让他以为设了没反应。
   */
  function applySurface(style, surface) {
    const name = typeof surface === 'string' && Object.prototype.hasOwnProperty.call(surfaces, surface) ? surface : 'chip'
    const allowed = channelsFor(name)
    const src = isPlain(style) ? style : {}
    const out = {}
    const dropped = []
    for (const c of STYLE_FIELDS) {
      if (src[c] === undefined || src[c] === null) continue
      if (allowed.indexOf(c) >= 0) { out[c] = src[c]; continue }
      dropped.push({
        channel: c,
        reason: c === 'size'
          ? '字号只在「分组标题」上成立：标签芯片是 26px 的胶囊（client.js:441），字号只会破坏行高。'
          : '通道 ' + c + ' 在「' + name + '」这个面上不成立。',
      })
    }
    return { surface: name, style: out, dropped }
  }

  /**
   * 样式 → **给 UI 用的展示映射**（纯值，JSON 可序列化）。
   *
   * ⚠️ **不含 svg**。刻意如此：`ICON_TABLE.shapes` 已经内联在 `client.js:1888` 里了，
   *   这里再塞一份 SVG 就是「同一件事写两份」（`categories.js` 头部骂过的那个毛病）。
   *   调用方拿 `icon` 这个**形状名**去 `ICON_TABLE.shapes[icon]` 取图形即可。
   *
   * **未设置的通道一律回 `null`**（不是空串、不是 `undefined`、**也不是兜底色**）——
   * `null` 在 JSON 里活着，断言也好写；而「没配颜色该显示成什么」是**渲染**的决定，
   * 规则层不替它猜（`TAG_STYLE_TABLE` 里删掉 `colorFallback` 就是这个理由）。
   *
   * @returns {{color:(string|null), icon:(string|null), fontWeight:(number|null), fontSize:(string|null)}}
   */
  function present(style) {
    const src = isPlain(style) ? style : {}
    const slot = typeof src.color === 'string' && Object.prototype.hasOwnProperty.call(colors, src.color) ? src.color : ''
    return {
      color: slot ? colors[slot] : null,
      icon: typeof src.icon === 'string' && icons.indexOf(src.icon) >= 0 ? src.icon : null,
      fontWeight: Object.prototype.hasOwnProperty.call(weights, src.weight) ? weights[src.weight] : null,
      fontSize: Object.prototype.hasOwnProperty.call(sizes, src.size) ? sizes[src.size] : null,
    }
  }

  /* ── 给 UI 与 agent 工具的一次性入口 ───────────────────────────────────── */

  /**
   * **UI 的单次入口**：一个标签 → 它属于哪一层 + 该显示成什么样。
   *
   * `surface` 默认 `'chip'` —— 默认取**最受限**的那个面。这是刻意的：
   *   面板里绝大多数标签就是芯片，调用方不传 `surface` 时不该拿到一个会破行高的字号。
   *   （同 3b 的 `mergeTags` 默认 dry-run：默认值站在**不会造成后果**的那一边。）
   *
   * @returns {{layer:'managed'|'free', tag:string, style:object|null,
   *            preset:object|null, dropped:Array<{channel:string,reason:string}>}}
   *   · `layer==='free'` ⇒ `style` 一定是 `null`（自由关键词**不配样式**，
   *     这不是「碰巧没配」而是分层定义的结果 —— 见文件头）
   *   · `preset` = `styleToPresentation(style)`，方便直接渲染
   */
  function resolve(tag, managed, options) {
    const name = typeof tag === 'string' ? tag : ''
    const entry = entryOf(name, managed)
    if (!entry) return { layer: 'free', tag: name, style: null, preset: null, dropped: [] }
    const style = {}
    for (const f of STYLE_FIELDS) if (entry[f] !== undefined && entry[f] !== null) style[f] = entry[f]
    const applied = applySurface(style, options && options.surface)
    return { layer: 'managed', tag: name, style: applied.style, preset: present(applied.style), dropped: applied.dropped }
  }

  /**
   * 把一批标签（一条记录的 `rec.tags`）按层拆开 —— UI 要的就是这个：
   * 受管的渲染成带样式的芯片，自由的保持素净。
   *
   * ⚠️ **逐字去重、保序**：记录里确实存在同一条挂两个变体的历史数据
   *   （`DSH` + `dsh`）。这里只做**逐字**去重，**不做归一化合并** ——
   *   合并是 3b 的 `mergeTags` 的活，而且要人确认。渲染层顺手改数据是最坏的做法。
   */
  function splitByLayer(tags, managed, options) {
    const managedOut = []
    const freeOut = []
    const seen = new Set()
    for (const raw of Array.isArray(tags) ? tags : []) {
      const name = typeof raw === 'string' ? raw : (raw === null || raw === undefined ? '' : String(raw))
      if (!name || seen.has(name)) continue
      seen.add(name)
      const r = resolve(name, managed, options)
      if (r.layer === 'managed') managedOut.push({ tag: name, style: r.style, preset: r.preset, dropped: r.dropped })
      else freeOut.push(name)
    }
    return { managed: managedOut, free: freeOut }
  }

  /**
   * 受管位够不够 —— 加新的之前问一句。
   * ⚠️ 超限**只报告、不自动腾位**（理由见 MANAGED_LIMIT 的注释）。
   */
  function checkBudget(managed) {
    const count = Array.isArray(managed) ? managed.length : 0
    return {
      ok: count <= limit,
      count,
      limit,
      free: Math.max(0, limit - count),
      reason: count <= limit ? '' : '受管标签已有 ' + count + ' 个、上限 ' + limit + ' 个。要加新的必须先合并旧的。',
    }
  }

  /**
   * 「自动打标签只能打受管的」—— 把这条规矩收在一个函数里，免得每个调用点各写一遍。
   * @returns {{ok:true, entry:object}|{ok:false, reason:string}}
   */
  function checkAutoTag(tag, managed) {
    const entry = entryOf(tag, managed)
    if (entry) return { ok: true, entry }
    return {
      ok: false,
      reason: '「' + text(tag) + '」不在受管表里，是自由关键词 ⇒ 不能被自动打上。'
        + '自动打标签只能打受管的（受管的才有人复核过、才能被改名和合并）；'
        + '要把自动生成的词收进来，得先显式把它登记成受管（然后才轮得到配样式）。',
    }
  }

  return {
    colorSlots: function () { return COLOR_SLOTS.slice() },
    iconNames: function () { return icons.slice() },
    weightNames: function () { return WEIGHT_NAMES.slice() },
    sizeNames: function () { return SIZE_NAMES.slice() },
    surfaceNames: function () { return SURFACE_NAMES.slice() },
    limit: function () { return limit },
    resolveColor,
    normalizeStyle,
    validateManaged,
    layerOf,
    entryOf,
    channelsFor,
    applySurface,
    present,
    resolve,
    splitByLayer,
    checkBudget,
    checkAutoTag,
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 模块级实例 + 直出的薄包装
 *
 * 与 `icons.js:389-390`（`const resolveIcon = buildIconResolver(ICON_TABLE)`）同一形状：
 * **只有一份实现**（在 builder 里），模块级这些函数只是把它接上默认参数，
 * 所以「Node 侧跑的」和「内联进客户端的」不可能算出不同结果 —— `[I] I2` 逐样本比对。
 *
 * `keyOf` 传 `normalizeTag`（`lib/tags.js`）：受管表的重复检测要按
 * 「同一件事的两种写法」的口径来（`DSH` / `dsh` 不该各占一个受管位）。
 * ⚠️ 传进来而不是在 builder 里 import —— builder 要自包含才能被内联。
 * ════════════════════════════════════════════════════════════════════════════ */
const RULE = buildTagStyleRule(TAG_STYLE_TABLE, normalizeTag)

/** 色板槽名（稳定顺序，直接当选择器用） */
export const TAG_COLOR_SLOTS = RULE.colorSlots()
/** 可选图标名 = `ICON_TABLE.shapes` 的键 */
export const TAG_ICONS = RULE.iconNames()
/** 字重档名 */
export const TAG_WEIGHTS = RULE.weightNames()
/** 字号档名 */
export const TAG_SIZES = RULE.sizeNames()
/** 受管标签上限（16 vs 32 待依琪拍板，见 `MANAGED_LIMIT`） */
export const MANAGED_TAG_LIMIT = RULE.limit()
/** 样式的字段名（冻结契约的一部分） */
export const TAG_STYLE_FIELDS = ['color', 'icon', 'weight', 'size']

/** 见 `buildTagStyleRule().resolveColor` */
export function resolveTagColor(input) { return RULE.resolveColor(input) }
/** 见 `buildTagStyleRule().normalizeStyle` */
export function normalizeTagStyle(input) { return RULE.normalizeStyle(input) }
/** 见 `buildTagStyleRule().validateManaged` */
export function validateManagedTags(value) { return RULE.validateManaged(value) }
/** 见 `buildTagStyleRule().layerOf` —— ★★ 唯一的分层判据 */
export function tagLayer(tag, managed) { return RULE.layerOf(tag, managed) }
/** 见 `buildTagStyleRule().entryOf` */
export function managedTagEntry(tag, managed) { return RULE.entryOf(tag, managed) }
/** 见 `buildTagStyleRule().channelsFor` */
export function channelsForSurface(surface) { return RULE.channelsFor(surface) }
/** 见 `buildTagStyleRule().applySurface` */
export function applyTagStyleSurface(style, surface) { return RULE.applySurface(style, surface) }
/** 见 `buildTagStyleRule().present` —— 给 UI 用的展示映射 */
export function styleToPresentation(style) { return RULE.present(style) }
/** 见 `buildTagStyleRule().resolve` —— ★ UI 的单次入口 */
export function resolveTagStyle(tag, managed, options) { return RULE.resolve(tag, managed, options) }
/** 见 `buildTagStyleRule().splitByLayer` */
export function splitTagsByLayer(tags, managed, options) { return RULE.splitByLayer(tags, managed, options) }
/** 见 `buildTagStyleRule().checkBudget` */
export function checkManagedTagBudget(managed) { return RULE.checkBudget(managed) }
/** 见 `buildTagStyleRule().checkAutoTag` */
export function checkAutoTag(tag, managed) { return RULE.checkAutoTag(tag, managed) }
