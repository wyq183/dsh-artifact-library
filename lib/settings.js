/**
 * dsh-artifact-library — 设置体系（schema / 预设 / 导出导入）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个模块（2026-09-30 的教训）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 上一版的 `indexExtraDirs` 是**死设置**：`lib/index.js` 老老实实读了它，
 * 但 `store.updateSettings()` 的白名单里**没有这个键** → 恒为 `[]`。
 * 也就是说「用户额外目录」这个能力**从来不存在**，而代码看起来是支持的。
 * 这类「读了不生效」的键比缺功能更糟 —— 它让维护者以为有。
 *
 * 所以本模块的每条设置都必须在下面这张表里登记，并且**必须**指出谁在消费它：
 *
 *   ┌ 键 ───────────────┬ 生效方 ──┬ 生效点 ────────────────────────────────┐
 *   │ listLimit          │ 宿主     │ lib/http.js `/files/list` 默认页大小     │
 *   │ thumbMaxBytes      │ 宿主     │ lib/http.js `/files/thumb` 单图上限      │
 *   │ showHidden         │ 宿主     │ lib/http.js `/files/list` 结果过滤       │
 *   │ indexExtraDirs     │ 宿主     │ lib/index.js `resolveIndexScope()`       │
 *   │ 其余外观项          │ 客户端   │ ui-core 的面板/列表（宿主只负责存取）      │
 *   └────────────────────┴──────────┴─────────────────────────────────────────┘
 *
 * 「客户端生效」的项**不是死设置**：宿主把它们**存下来并原样吐回**，
 * 这是它们的全部职责；真正的效果在 ui-core 的渲染层。分区在下面 `HOST_EFFECTIVE_KEYS`
 * 里有明确标注，README/答复里也会说清楚 —— 不许含糊。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 导入是安全边界，不是形式
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 「用户可导入一个 JSON」= 让外部数据进入我们的对象。经典洞是原型污染：
 * 只要有任何一处写成 `target[key] = value` 而 key 来自输入，`__proto__` 就会改原型。
 * 这里的对策是**三重**的：
 *   1. `scanForbiddenKeys()` 在**任意层级**找 `__proto__ / constructor / prototype`，
 *      找到就**整个导入失败**（fail closed），不做部分应用。
 *   2. 校验通过后**逐键显式赋值**（白名单驱动），**从不**做通用深合并 ——
 *      没有 `Object.assign(settings, input)`、没有 `{...input}` 展开输入。
 *   3. 读取键一律走自己的白名单常量，不遍历输入的键去写目标对象。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 导入口径（明确写死，不许将来含糊）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 「**按出现键覆盖**」（present-only overwrite）：
 *   · 载荷里**出现**的键 → 用载荷的值覆盖当前值（数值越界会被夹紧，非法枚举会被拒绝并在 errors 里说明）
 *   · 载荷里**没出现**的键 → **保持不动**
 * 为什么不是「整体重置」：老版本导出的文件里不会有将来新增的键，
 * 整体重置会把那些键悄悄打回默认值。按出现键覆盖能让老文件安全落地，
 * 同时 `applied` 会如实告诉用户实际改了哪些键。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 导出文件的格式标识（不匹配就明确报错，不做猜测式迁移） */
export const SETTINGS_FORMAT = 'dsh-artifact-library/settings'
/** 导出文件的结构版本 */
export const SETTINGS_VERSION = 1

/** 自定义预设名允许的形状（顺带排除 `__proto__` 这类键） */
const CUSTOM_PRESET_NAME = /^[A-Za-z0-9_-]{1,32}$/

/**
 * 枚举型设置：只接受这些值，其它一律拒绝（不夹、不猜）。
 * @type {Record<string, (string|number)[]>}
 */
export const ENUMS = {
  density: ['compact', 'standard', 'loose'],
  defaultView: ['list', 'gallery'],
  sortBy: ['name', 'size', 'time'],
  sortDir: ['asc', 'desc'],
  thumbSize: [16, 24, 32],
}

/**
 * 数值型设置：[min, max]。越界**夹紧**（不是拒绝）—— 这些是有序量，
 * 夹到边界比丢掉整个请求更符合用户预期。
 */
export const RANGES = {
  galleryThumbSize: [32, 256],
  thumbMaxBytes: [0, 104857600],   // 0 = 不跳过（见下面 thumbByteLimit）
  listLimit: [500, 10000],         // 与 lib/index/list.js 的 MAX_LIST_LIMIT 一致
  virtualThreshold: [0, 5000],
  panelWidth: [200, 2000],         // 另有 null = 自动
}

/** 布尔型设置 */
export const BOOLEANS = ['thumbnails', 'showHidden']

/** 外观类设置 —— **只有这些**参与「选了预设 / 微调后变 custom」的判定 */
export const APPEARANCE_KEYS = [
  'density', 'defaultView', 'columns', 'sortBy', 'sortDir',
  'thumbnails', 'thumbSize', 'galleryThumbSize',
]

// ═══════════════════════════════════════════════════════════════════════════
// 分类（category）—— 2026-10-06 新增（依琪：「允许用户自定义分类项目跟其分类确定的文件后缀
// 还支持自定义分类图标」）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⭐ **为什么分类是「设置」而不是「数据」**（这条决定了整步的代价）：
//   记录的 `artifact_type` 是**自由字符串**（`store.js:567` 只做 `|| 'other'`，不校验），
//   所以分类的**定义**可以整个放进 `settings.json`，而**记录一个字节都不用动** ——
//   老数据不会变孤儿，也不需要任何迁移。
//
// ⚠️ **为什么不能塞进 `values`（我上一轮就是这么说错的）**：
//   `APPEARANCE_KEYS` 的注释写着「**只有这些**参与『选了预设 / 微调后变 custom』的判定」。
//   把分类加进去 ⇒「用户改了分类」会被判成「外观被微调过 → preset 变 custom」，语义错了。
//   而且 `settings.js:206-213` 那条自检会让**模块加载即 throw**，插件整个起不来。
//   ⇒ 所以预设分两层：`values`（外观，受 APPEARANCE_KEYS 自检）+ `content`（内容，受 CONTENT_KEYS 自检）。

/**
 * 兜底分类的 id。**永不可删**，记录指向它总是合法。
 *
 * ⚠️ id 保留 `other`（只把显示名改成「未分类」）—— 库里 12 条记录的 `artifact_type`
 * 就是 `other`，改 id 等于要迁移；改 label 零成本。
 */
export const LOCKED_CATEGORY_ID = 'other'

/** 分类 id 的形状：小写字母开头，避免 `__proto__` 这类键，也保证 URL/查询串里安全。 */
export const CATEGORY_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * 自定义分类可选的图标名。
 *
 * ⚠️ **这是 `icons.js` 里已有的形状名**（见 `EXT_TYPE` 的取值域），不是新图标资源：
 *   ① 图标集是**内联进客户端**的（`ICON_TABLE`），加新图标要同时改两处，容易不同步；
 *   ② `icons.js` 头部写着「**禁止 hex**」—— 颜色必须走主题 token，
 *      所以这里**不让用户填颜色**，只让选形状，颜色由主题和 `FILE_TYPE_COLORS` 决定。
 */
export const CATEGORY_ICONS = [
  'doc', 'sheet', 'slides', 'pdf', 'markdown', 'html', 'code', 'json',
  'text', 'image', 'video', 'audio', 'archive', 'binary', 'folder', 'other',
]

/**
 * 默认分类 —— **就是现有数据的 7 个值**（`artifact_type` 实测分布：
 * document 151 / code 53 / image 26 / other 12 / video 11 / archive 11 / audio 2）。
 *
 * ⭐ 为什么默认**不多不少**正好这 7 个：任何一条现有记录的 `artifact_type`
 *   都能在默认分类里找到自己 ⇒ **开箱即用、零孤儿**。
 *   想加分类是用户/预设的事，不是默认值的事。
 *
 * `exts` 的取值**刻意与客户端既有的 `CHIP_EXTS`（`client.js:1411-1417`）对齐** ——
 * 那张表是文件浏览器一直在用的分组，对齐它意味着「分类」和「文件类型筛选」
 * 对同一个后缀给出同一个答案，不会出现「面板说文档、文件浏览器说代码」。
 *
 * ⚠️ 注意 `exts` **只用于「新登记时的默认归类建议」和「筛选归类」**，
 *   **绝不回头改写已有记录**：实测数据显示现有 `artifact_type` 并不服从后缀
 *   （`exe` 同时出现在 code/archive/other 三处），那批值是当初由 agent 判的**语义**分类。
 *
 * ⚠️ 每条都**显式写出 `locked`**（普通类是 `false`，兜底类是 `true`），虽然啰嗦也不省。
 *   原因：`validateCategories` 归一化后**每条都带 `locked`**。如果这里省掉普通类的
 *   `locked`，那么「内存里的默认表」和「存盘再读回来的表」**形状就不一样**
 *   （前者 `undefined`、后者 `false`）—— 于是导出/导入不是不动点，
 *   客户端写 `cat.locked === false` 也会时而真时而假。
 *   `test/categories.test.mjs` §E 有一条断言钉死「默认表已经是归一化形态」。
 */
export const DEFAULT_CATEGORIES = [
  {
    id: 'document',
    label: '文档',
    icon: 'doc',
    exts: ['md', 'markdown', 'txt', 'text', 'log', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'tsv'],
    locked: false,
  },
  {
    id: 'image',
    label: '图片',
    icon: 'image',
    exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'psd', 'ai', 'fig'],
    locked: false,
  },
  { id: 'video', label: '视频', icon: 'video', exts: ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv'], locked: false },
  { id: 'audio', label: '音频', icon: 'audio', exts: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'], locked: false },
  {
    id: 'code',
    label: '代码',
    icon: 'code',
    exts: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'php', 'lua', 'html', 'htm', 'css', 'scss', 'less', 'sh', 'ps1', 'bat', 'cmd', 'sql', 'vue', 'svelte', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini'],
    locked: false,
  },
  { id: 'archive', label: '压缩包', icon: 'archive', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab', 'iso', 'jar'], locked: false },
  // ⚠️ 必须**最后**且 `locked: true`：兜底项，任何删它的请求都会被拒。
  { id: LOCKED_CATEGORY_ID, label: '未分类', icon: 'other', exts: [], locked: true },
]

/**
 * **内容类**设置的键 —— 与 `APPEARANCE_KEYS` 对称的另一张表。
 *
 * 为什么另开一张而不是复用：这两类键的**语义**不同 ——
 * 外观项参与「微调后变 custom」的判定，内容项不参与。
 * 混在一张表里，那条判定就会把「改了分类」误读成「外观被微调」。
 */
export const CONTENT_KEYS = ['categories']

/**
 * 默认值。**这是唯一真相源**：预设只写差异项，缺的自动落到这里。
 * ⚠️ 加新设置时只改这一处 + 上面的校验表，预设不用动。
 */
export const DEFAULT_SETTINGS = {
  // 外观
  preset: 'general',
  density: 'standard',
  defaultView: 'list',
  columns: { size: true, time: true, type: false },
  sortBy: 'name',
  sortDir: 'asc',
  // 缩略图
  thumbnails: true,
  thumbSize: 16,
  galleryThumbSize: 96,
  thumbMaxBytes: 5242880,
  // 行为
  listLimit: 2000,
  virtualThreshold: 200,
  showHidden: false,
  panelWidth: null,
  // 索引范围（★ 本次接线的死设置）
  indexExtraDirs: [],
  // 分类（内容类，**不参与**「微调变 custom」判定；见 CONTENT_KEYS）
  categories: DEFAULT_CATEGORIES,
}

/**
 * 宿主自己消费（= 不依赖客户端也算生效）的键。
 * 其余外观项的生效点在 ui-core 的渲染层 —— 别把这两类混为一谈。
 */
export const HOST_EFFECTIVE_KEYS = ['listLimit', 'thumbMaxBytes', 'showHidden', 'indexExtraDirs']

/**
 * 5 个内置预设。**只放差异项**（`values`），缺的键在应用时从 DEFAULT_SETTINGS 继承 ——
 * 这样将来加设置项，预设自动获得新默认，不会漏项。
 *
 * ⭐ **两层结构**（2026-10-06）：
 *   · `values`  = **外观**，受 `APPEARANCE_KEYS` 自检（模块加载即查，不合规就 throw）
 *   · `content` = **内容**（目前只有 `categories`），受 `CONTENT_KEYS` 自检
 * 分开的理由见 `CONTENT_KEYS` 上面那段：内容项**不参与**「微调后变 custom」的判定。
 *
 * ⚠️ `content.categories` 的应用方式是**合并（按 id 增改），不是替换** ——
 *   替换会把用户已有分类里被记录引用的那些抹掉，直接制造孤儿。
 *   见 `SettingsStore.update()` 里那段 merge。
 */
export const PRESETS = {
  general: {
    label: '通用',
    hint: '全默认：列表视图、名称升序、标准行高',
    values: {},
    content: {},
  },
  developer: {
    label: '开发者',
    hint: '紧凑行高 + 按修改时间倒序 + 显示类型列；分类补上脚本与配置',
    values: {
      density: 'compact',
      sortBy: 'time',
      sortDir: 'desc',
      columns: { size: true, time: true, type: true },
    },
    // 依琪原话：「预设分类里还可以加入比如**代码方面的预设分类**，不止是图片视频之类」
    content: {
      categories: [
        {
          id: 'code',
          label: '代码',
          icon: 'code',
          // 比默认的 code 更长：把配置类后缀让给下面的 `config`，这里只留真正的源码
          exts: ['js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'hpp', 'cpp', 'cc', 'cs', 'php', 'lua', 'dart', 'scala', 'vue', 'svelte', 'html', 'htm', 'css', 'scss', 'less', 'sql'],
        },
        { id: 'script', label: '脚本', icon: 'code', exts: ['sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'mjs', 'cjs'] },
        { id: 'config', label: '配置', icon: 'json', exts: ['json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'env', 'conf', 'cfg', 'editorconfig'] },
      ],
    },
  },
  research: {
    label: '研究者 / 学生',
    hint: '标准行高 + 名称升序，便于按论文/实验编号定位；分类补上文献与数据',
    values: {
      density: 'standard',
      sortBy: 'name',
      sortDir: 'asc',
      columns: { size: true, time: true, type: false },
    },
    content: {
      categories: [
        { id: 'paper', label: '文献', icon: 'pdf', exts: ['pdf', 'caj', 'nh', 'kdh'] },
        { id: 'data', label: '数据', icon: 'sheet', exts: ['csv', 'tsv', 'xlsx', 'xls', 'sav', 'dta', 'parquet'] },
      ],
    },
  },
  creator: {
    label: '内容创作',
    hint: '宽松行高 + 画廊视图，素材一眼看得见；分类补上设计稿',
    values: {
      density: 'loose',
      defaultView: 'gallery',
      galleryThumbSize: 96,
    },
    content: {
      categories: [
        { id: 'design', label: '设计稿', icon: 'image', exts: ['psd', 'ai', 'fig', 'xd', 'sketch', 'afdesign', 'aep', 'prproj', 'blend', 'c4d'] },
      ],
    },
  },
  office: {
    label: '办公 / 职场',
    hint: '标准行高 + 按修改时间倒序 + 显示类型列；分类补上表格与演示',
    values: {
      density: 'standard',
      sortBy: 'time',
      sortDir: 'desc',
      columns: { size: true, time: true, type: true },
    },
    content: {
      categories: [
        { id: 'sheet', label: '表格', icon: 'sheet', exts: ['xlsx', 'xls', 'csv', 'tsv', 'ods'] },
        { id: 'slides', label: '演示', icon: 'slides', exts: ['pptx', 'ppt', 'odp', 'key'] },
      ],
    },
  },
}

/** 内置预设 id（`custom` 表示「用户自己微调过」；自定义预设名另算） */
export const BUILTIN_PRESET_IDS = Object.keys(PRESETS)

/**
 * 「隐藏项」的判定 —— `showHidden: false` 时被过滤掉的东西。
 *
 * ⚠️ **这是一个近似，名字说明白**：Node 的 `fs.Stats` **不暴露 Windows 的
 * FILE_ATTRIBUTE_HIDDEN**（mode 位只在 POSIX 上有意义），要精确读那个属性
 * 只能 shell 出去调 `attrib`（每个条目一次进程，太贵）。
 * 所以这里的规则是「点开头 + 一份已知的系统/噪音文件名」，
 * 覆盖的是文件管理器里真正碍眼的那批东西。
 */
export const HIDDEN_NOISE_NAMES = [
  'desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information',
  'hiberfil.sys', 'pagefile.sys', 'swapfile.sys',
]

/**
 * 这一项在 `showHidden: false` 时该不该被藏起来。
 * @param {string} name 目录项的名字（不是路径）
 */
export function isHiddenEntryName(name) {
  const value = String(name === undefined || name === null ? '' : name)
  if (value.startsWith('.')) return true
  return HIDDEN_NOISE_NAMES.includes(value.toLowerCase())
}

/** 自检：预设只能用 APPEARANCE_KEYS 里的键（防止将来偷偷加一个不参与 custom 判定的键） */
for (const [id, preset] of Object.entries(PRESETS)) {
  for (const key of Object.keys(preset.values)) {
    if (!APPEARANCE_KEYS.includes(key)) {
      throw new Error(`settings: 预设 ${id} 用了非外观键 ${key}（要么加进 APPEARANCE_KEYS，要么别放预设里）`)
    }
  }
}

/**
 * 自检（与上面那条对称）：预设的 `content` 只能用 CONTENT_KEYS 里的键。
 *
 * ⚠️ 这条是**新加的第二道闸**，理由：上面那条只管 `values`，而 `content` 是这次新开的层 ——
 *   如果没有对称的自检，将来有人往 `content` 里塞一个外观键（比如 `density`），
 *   它**既不会**被 `expandPreset` 应用、**也不会**被任何校验拦住，
 *   结果就是「预设里写了但永远不生效」的静默失效。这类坑本仓已经踩过好几次。
 *
 * ⚠️ 注意：`content.categories` 这里**不做完整校验**（那是 `validateCategories` 的事，
 *   在应用预设时跑）。这里只查「键名合法」+「categories 是个数组」，
 *   因为模块加载期**不该**因为一条预设写错一个后缀就让整个插件起不来。
 */
for (const [id, preset] of Object.entries(PRESETS)) {
  const content = preset.content
  if (content === undefined) continue
  if (!isPlainObject(content)) {
    throw new Error(`settings: 预设 ${id} 的 content 需要对象`)
  }
  for (const key of Object.keys(content)) {
    if (!CONTENT_KEYS.includes(key)) {
      throw new Error(`settings: 预设 ${id} 的 content 用了非内容键 ${key}（要么加进 CONTENT_KEYS，要么别放 content 里）`)
    }
  }
  if (content.categories !== undefined && !Array.isArray(content.categories)) {
    throw new Error(`settings: 预设 ${id} 的 content.categories 需要数组`)
  }
}

/**
 * 旧 store（lib/store.js）里可以导出/导入的设置键。
 * `lastCleanupAt` **不在**其中 —— 它是「上次整理时间」这个**状态**，不是偏好；
 * 把它搬到另一台机器上只会让定时器算错下次整理时间。
 */
export const LEGACY_SETTINGS_KEYS = [
  'autoCollect', 'cleanupEnabled', 'cleanupIntervalDays', 'refineBatchSize',
  'maxPerTurn', 'backupKeep', 'backupOnCleanup', 'importMaxSizeMB',
  'searchLimit', 'refineModelLast',
]

// ═══════════════════════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════════════════════

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return undefined
  return Math.max(min, Math.min(max, n))
}

function ownKeys(obj) {
  return Object.keys(obj) // 只取自有可枚举键；不碰原型链
}

/**
 * 在**任意层级**找出原型污染键。
 *
 * 用 `Object.keys()` 而不是 `for…in`（后者会带上原型链上的键）；
 * 用 `hasOwnProperty` 判断存在性，绝不用 `in`（同样会走原型链）。
 *
 * @param {unknown} value 待扫描的值（通常是 JSON.parse 的产物）
 * @param {{maxDepth?:number, maxNodes?:number}} [options]
 * @returns {{found:string[], truncated:boolean}} found 是路径列表，如 `settings.columns.__proto__`
 */
export function scanForbiddenKeys(value, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 16
  const maxNodes = Number.isFinite(options.maxNodes) ? options.maxNodes : 20000
  const FORBIDDEN = ['__proto__', 'constructor', 'prototype']
  const found = []
  let nodes = 0
  let truncated = false
  const stack = [{ value, path: '', depth: 0 }]

  while (stack.length) {
    const { value: current, path: at, depth } = stack.pop()
    if (typeof current !== 'object' || current === null) continue
    nodes += 1
    if (nodes > maxNodes || depth > maxDepth) {
      truncated = true
      continue
    }
    for (const key of ownKeys(current)) {
      const next = at ? `${at}.${key}` : key
      if (FORBIDDEN.includes(key)) {
        found.push(next)
        continue // 不再往里走：这个子树的键本身已经不可信
      }
      const child = current[key]
      if (typeof child === 'object' && child !== null) stack.push({ value: child, path: next, depth: depth + 1 })
    }
  }
  return { found, truncated }
}

// ═══════════════════════════════════════════════════════════════════════════
// 单键校验（白名单驱动）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 校验并规范化「分类表」。
 *
 * 形状与 `columns`（`:323-334`）同一套路：**遍历自己写死的字段名、不遍历输入的键**，
 * 未知字段直接丢掉；每个字段单独类型检查；返回**全新对象**（绝不把输入对象原样存进去）。
 *
 * 两条**宽容**设计（都是有意的，不是漏判）：
 *  ① **缺 `other` 就自动补上**，而不是报错。理由：兜底类一旦不存在，
 *    任何指向它的记录都会变成孤儿 —— 这是「老数据不能变孤儿」这条硬约束的**结构性保证**，
 *    不该指望每个调用方都记得带上它。
 *  ② **同一个后缀出现在多个分类里不报错**，只记进 `notes` 让 UI 提示。
 *    理由：真实数据里 `exe` 天然跨类（code/archive/other 三处都有），
 *    硬性禁止会让用户根本没法配出一张能用的表。匹配时**取先出现的那个**。
 *
 * @param {unknown} value
 * @returns {{ok:true, value:object[], notes:string[]}|{ok:false, reason:string}}
 */
export function validateCategories(value) {
  if (!Array.isArray(value)) return { ok: false, reason: 'categories 需要数组' }
  if (value.length > 64) return { ok: false, reason: 'categories 最多 64 个分类' }
  const out = []
  const seen = new Set()
  const extOwner = new Map()
  const notes = []
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i]
    const at = `categories[${i}]`
    if (!isPlainObject(raw)) return { ok: false, reason: `${at} 需要对象` }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!CATEGORY_ID_RE.test(id)) {
      return { ok: false, reason: `${at}.id 不合法（只接受 /^[a-z][a-z0-9_-]{0,31}$/）：${JSON.stringify(raw.id)}` }
    }
    if (seen.has(id)) return { ok: false, reason: `${at}.id 重复：${id}` }
    seen.add(id)
    const label = typeof raw.label === 'string' ? raw.label.trim() : ''
    if (!label) return { ok: false, reason: `${at}.label 不能为空` }
    if (label.length > 24) return { ok: false, reason: `${at}.label 最长 24 字` }
    const icon = typeof raw.icon === 'string' ? raw.icon : 'other'
    if (!CATEGORY_ICONS.includes(icon)) {
      return { ok: false, reason: `${at}.icon 只接受 ${CATEGORY_ICONS.join(' / ')}` }
    }
    const rawExts = raw.exts === undefined ? [] : raw.exts
    if (!Array.isArray(rawExts)) return { ok: false, reason: `${at}.exts 需要字符串数组` }
    if (rawExts.length > 64) return { ok: false, reason: `${at}.exts 最多 64 个后缀` }
    const exts = []
    for (const item of rawExts) {
      if (typeof item !== 'string') return { ok: false, reason: `${at}.exts 的每一项都要是字符串` }
      // 容忍用户写 `.md` 或 `MD`，统一成不带点的小写 —— 但**不猜内容**，空串直接跳过
      const ext = item.trim().toLowerCase().replace(/^\.+/, '')
      if (!ext) continue
      if (ext.length > 16) return { ok: false, reason: `${at}.exts 里有过长的后缀：${ext}` }
      if (exts.includes(ext)) continue
      exts.push(ext)
      // 只**记录**冲突，不拒绝：真实数据里 exe 天然跨类（见函数头 ②）
      if (extOwner.has(ext)) notes.push(`后缀 ${ext} 同时属于「${extOwner.get(ext)}」和「${label}」，匹配时取先出现的那个`)
      else extOwner.set(ext, label)
    }
    // locked 只对兜底类有意义：**强制** other 为 locked，且其他类一律不允许自封 locked
    const locked = id === LOCKED_CATEGORY_ID
    out.push({ id, label, icon, exts, locked })
  }
  if (!seen.has(LOCKED_CATEGORY_ID)) {
    // 见函数头 ①：兜底类缺失时**补上**，不是报错
    out.push({ id: LOCKED_CATEGORY_ID, label: '未分类', icon: 'other', exts: [], locked: true })
    notes.push('配置里没有兜底分类，已自动补上「未分类」（它必须存在，否则记录会变孤儿）')
  }
  return { ok: true, value: out, notes }
}

/**
 * 把一批分类**合并**进现有分类表（按 id 增 / 改，**绝不删**）。
 *
 * ⭐ **为什么是「合并」而不是「替换」** —— 这是本步最重要的一条安全决定：
 *   分类是**记录通过 `artifact_type` 指向的东西**。一旦替换，
 *   被删掉的那些分类立刻让指向它们的记录变成孤儿（`artifact_type` 指向一个不存在的 id）。
 *   而「老数据不能变孤儿」是本方案的硬约束之一。
 *   ⇒ 所以预设**只会加/改**分类，**永远不会**因为「换了个预设」而删掉任何分类。
 *     真要删，走**显式的删除动作**（Step 2c 的 agent 工具 / 2d 的设置页），
 *     那条路会强制「改派」——「这些记录改到哪个分类去」。
 *
 * 同名 id 的行为：预设**覆盖** label / icon / exts（这才是「套预设」的意义），
 * 但 `locked` 由 `validateCategories` 说了算，预设改不动它。
 *
 * @param {object[]} base 现有分类表
 * @param {object[]} incoming 预设带的分类
 * @returns {object[]} 新数组（不改动入参）
 */
export function mergeCategories(base, incoming) {
  const out = []
  const byId = new Map()
  for (const item of Array.isArray(base) ? base : []) {
    const copy = isPlainObject(item) ? { ...item } : item
    out.push(copy)
    if (isPlainObject(copy) && typeof copy.id === 'string') byId.set(copy.id, copy)
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (!isPlainObject(item) || typeof item.id !== 'string') continue
    const existing = byId.get(item.id)
    if (!existing) {
      out.push({ ...item })
      continue
    }
    if (item.label !== undefined) existing.label = item.label
    if (item.icon !== undefined) existing.icon = item.icon
    if (Array.isArray(item.exts)) existing.exts = item.exts.slice()
  }
  return out
}

/**
 * 校验并规范化一个设置键。
 * @param {string} key
 * @param {unknown} value
 * @returns {{ok:true, value:unknown}|{ok:false, reason:string}}
 */
export function validateSetting(key, value) {
  if (key === 'preset') {
    const name = typeof value === 'string' ? value : ''
    if (name === 'custom' || BUILTIN_PRESET_IDS.includes(name) || CUSTOM_PRESET_NAME.test(name)) {
      return { ok: true, value: name }
    }
    return { ok: false, reason: 'preset 名不合法（只接受内置预设名、custom，或 /^[A-Za-z0-9_-]{1,32}$/）' }
  }
  if (key === 'panelWidth') {
    if (value === null) return { ok: true, value: null }
    const n = clampInt(value, RANGES.panelWidth[0], RANGES.panelWidth[1])
    if (n === undefined) return { ok: false, reason: 'panelWidth 需要 null 或数字' }
    return { ok: true, value: n }
  }
  if (Object.prototype.hasOwnProperty.call(ENUMS, key)) {
    if (ENUMS[key].includes(value)) return { ok: true, value }
    return { ok: false, reason: `${key} 只接受 ${ENUMS[key].join(' / ')}` }
  }
  if (Object.prototype.hasOwnProperty.call(RANGES, key)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: `${key} 需要数字` }
    const [min, max] = RANGES[key]
    const n = clampInt(value, min, max)
    if (n === undefined) return { ok: false, reason: `${key} 需要数字` }
    return { ok: true, value: n, clamped: n !== Math.floor(value) }
  }
  if (BOOLEANS.includes(key)) {
    if (typeof value !== 'boolean') return { ok: false, reason: `${key} 需要布尔值` }
    return { ok: true, value }
  }
  if (key === 'columns') {
    if (!isPlainObject(value)) return { ok: false, reason: 'columns 需要对象' }
    const out = { ...DEFAULT_SETTINGS.columns }
    for (const column of ['size', 'time', 'type']) {
      // ⚠️ 只认这三个已知列名；输入里多余的列被忽略（不遍历输入键去写目标对象）
      if (!Object.prototype.hasOwnProperty.call(value, column)) continue
      const flag = value[column]
      if (typeof flag !== 'boolean') return { ok: false, reason: `columns.${column} 需要布尔值` }
      out[column] = flag
    }
    return { ok: true, value: out }
  }
  // 内容类：分类表（见上面 CONTENT_KEYS 的说明）。`notes` 是**附加**字段，
  // 老的消费方只读 `ok` / `value` / `reason`，所以多带一个字段不会破坏任何调用点。
  if (key === 'categories') return validateCategories(value)
  if (key === 'indexExtraDirs') {
    if (!Array.isArray(value)) return { ok: false, reason: 'indexExtraDirs 需要字符串数组' }
    if (value.length > 64) return { ok: false, reason: 'indexExtraDirs 最多 64 个目录' }
    const out = []
    for (const item of value) {
      if (typeof item !== 'string') return { ok: false, reason: 'indexExtraDirs 的每一项都要是字符串' }
      const trimmed = item.trim()
      if (!trimmed) continue
      if (trimmed.length > 1024) return { ok: false, reason: 'indexExtraDirs 的路径过长' }
      if (!path.isAbsolute(trimmed)) return { ok: false, reason: `indexExtraDirs 只接受绝对路径：${trimmed}` }
      if (!out.includes(trimmed)) out.push(trimmed)
    }
    return { ok: true, value: out }
  }
  return { ok: false, reason: `未知键 ${key}` }
}

/** 有效键集合（= 默认值的键 + customPresets） */
export const SETTING_KEYS = [...Object.keys(DEFAULT_SETTINGS), 'customPresets']

// ═══════════════════════════════════════════════════════════════════════════
// customPresets 校验
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 校验一坨自定义预设。
 * @returns {{ok:boolean, values?:object, ignored:string[], errors:Array<{key:string,reason:string}>}}
 */
export function validateCustomPresets(input) {
  const ignored = []
  const errors = []
  if (!isPlainObject(input)) return { ok: false, values: {}, ignored, errors: [{ key: 'customPresets', reason: '需要对象' }] }
  const out = {}
  for (const name of ownKeys(input)) {
    const at = `customPresets.${name}`
    if (!CUSTOM_PRESET_NAME.test(name) || BUILTIN_PRESET_IDS.includes(name)) {
      errors.push({ key: at, reason: '预设名不合法或与内置预设重名' })
      continue
    }
    const raw = input[name]
    if (!isPlainObject(raw)) {
      errors.push({ key: at, reason: '预设值需要对象' })
      continue
    }
    const values = {}
    for (const key of ownKeys(raw)) {
      if (!APPEARANCE_KEYS.includes(key)) {
        ignored.push(`${at}.${key}`)
        continue
      }
      const checked = validateSetting(key, raw[key])
      if (!checked.ok) {
        errors.push({ key: `${at}.${key}`, reason: checked.reason })
        continue
      }
      values[key] = checked.value
    }
    out[name] = values
  }
  return { ok: true, values: out, ignored, errors }
}

// ═══════════════════════════════════════════════════════════════════════════
// SettingsStore
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 设置存储。与 `ArtifactStore`（meta.json）**分文件**保存，方便单独导出/回滚。
 * 磁盘上只存「被显式设置过的键」（稀疏），读取时叠加在 DEFAULT_SETTINGS 之上 ——
 * 这样将来加设置项，老文件自动获得新默认值。
 */
export class SettingsStore {
  /**
   * @param {{file:string}} options file = settings.json 的绝对路径
   */
  constructor(options = {}) {
    this.file = options.file
    /** @type {Record<string, unknown>} 只含被显式设置过的键 */
    this.values = {}
    this.loaded = false
  }

  load() {
    try {
      if (this.file && fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        const candidate = isPlainObject(raw) && isPlainObject(raw.values) ? raw.values : raw
        if (isPlainObject(candidate)) {
          // 磁盘上的内容也过一遍闸门：文件可能是被手改/同步工具塞进 `__proto__` 的
          const { found } = scanForbiddenKeys(candidate)
          if (found.length === 0) {
            const clean = {}
            for (const key of SETTING_KEYS) {
              if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue
              if (key === 'customPresets') {
                const checked = validateCustomPresets(candidate[key])
                if (checked.ok) clean[key] = checked.values
                continue
              }
              const checked = validateSetting(key, candidate[key])
              if (checked.ok) clean[key] = checked.value
            }
            this.values = clean
          }
        }
      }
    } catch { /* 用默认值 */ }
    this.loaded = true
    return this
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ version: SETTINGS_VERSION, values: this.values }, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** 当前**有效**设置（默认值 + 已设置项） */
  get() {
    const out = {}
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const value = Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : DEFAULT_SETTINGS[key]
      out[key] = isPlainObject(value) || Array.isArray(value) ? structuredClone(value) : value
    }
    out.customPresets = isPlainObject(this.values.customPresets) ? structuredClone(this.values.customPresets) : {}
    return out
  }

  /** 某个键的预设「起点值」（展开：默认 → 预设差异 → 已有值） */
  expandPreset(name) {
    const custom = isPlainObject(this.values.customPresets) ? this.values.customPresets : {}
    const preset = Object.prototype.hasOwnProperty.call(PRESETS, name) ? PRESETS[name] : undefined
    const customValues = Object.prototype.hasOwnProperty.call(custom, name) ? custom[name] : undefined
    const values = preset ? preset.values : customValues
    if (!values) return undefined
    // ★ 关键：从 DEFAULT_SETTINGS 起步，而不是从当前值起步 ——
    //   否则从 developer 切到 general（values={}）会保留 developer 的紧凑行高。
    const next = {}
    for (const key of APPEARANCE_KEYS) {
      next[key] = Object.prototype.hasOwnProperty.call(values, key)
        ? (isPlainObject(values[key]) ? { ...values[key] } : values[key])
        : (isPlainObject(DEFAULT_SETTINGS[key]) ? { ...DEFAULT_SETTINGS[key] } : DEFAULT_SETTINGS[key])
    }
    return next
  }

  /**
   * 应用一批设置（PUT /settings 与导入共用）。
   *
   * @param {object} patch 待应用的键值
   * @param {{applyPreset?:boolean}} [options] applyPreset=false 时不展开预设（导入用：载荷里带的已是展开值）
   * @returns {{applied:string[], ignored:string[], errors:Array<{key:string,reason:string}>, changed:string[], notes:string[]}}
   */
  update(patch, options = {}) {
    const applied = []
    const ignored = []
    const errors = []
    const changed = []
    /** 非致命的提示（例如「这个后缀被两个分类同时声明」）—— 调用方可以忽略，但别丢 */
    const notes = []
    if (!isPlainObject(patch)) {
      return { applied, ignored, errors: [{ key: '$', reason: 'patch 需要对象' }], changed, notes }
    }
    const before = this.get()
    const presetRequested = Object.prototype.hasOwnProperty.call(patch, 'preset')
    const appearanceKeysPresent = ownKeys(patch).filter((k) => APPEARANCE_KEYS.includes(k))

    // ── 预设展开（PUT 语义）─────────────────────────────────────────────
    // 选预设 = 「把一组起点值灌进去」，之后每一项仍可单独改。
    if (presetRequested && options.applyPreset !== false) {
      const name = typeof patch.preset === 'string' ? patch.preset : ''
      const expanded = this.expandPreset(name)
      if (expanded === undefined) {
        errors.push({ key: 'preset', reason: `未知预设 ${JSON.stringify(name)}` })
      } else {
        for (const key of APPEARANCE_KEYS) this.values[key] = expanded[key]
        this.values.preset = name
        applied.push('preset')
        for (const key of APPEARANCE_KEYS) if (!applied.includes(key)) applied.push(key)

        // ── 内容层：预设带的分类 ──────────────────────────────────────
        // ⚠️ 与外观**刻意不同**：外观是「从 DEFAULT_SETTINGS 重新展开」（所以 developer → general
        //    会把行高还原），而分类是**合并**（只增改、不删）。
        //    理由见 `mergeCategories` 上面那段：分类被记录引用着，删了就是孤儿。
        //    ⇒ 所以「换预设」**永远不会**让任何一条记录失去它的分类。
        // 注意：这里要**自己查一次** PRESETS，不能用 expandPreset 的局部变量
        // （那个 `preset` 是 expandPreset 内部的，出了函数就没了 —— 我第一版就写错了，
        //   写成了 `preset && ...`，运行时会 ReferenceError；靠下面那条「套预设」测试才逮到）。
        const presetDef = Object.prototype.hasOwnProperty.call(PRESETS, name) ? PRESETS[name] : undefined
        const presetContent = presetDef && isPlainObject(presetDef.content) ? presetDef.content : undefined
        const incoming = presetContent && Array.isArray(presetContent.categories) ? presetContent.categories : null
        if (incoming && incoming.length) {
          const base = Array.isArray(this.values.categories) ? this.values.categories : DEFAULT_CATEGORIES
          const checked = validateCategories(mergeCategories(base, incoming))
          if (!checked.ok) {
            // 预设自带的内容不合法 = 插件的 bug，不是用户的错 —— 但要如实报出来，不能静默跳过
            errors.push({ key: 'categories', reason: `预设 ${name} 带的分类不合法：${checked.reason}` })
          } else {
            this.values.categories = checked.value
            if (!applied.includes('categories')) applied.push('categories')
            if (Array.isArray(checked.notes)) notes.push(...checked.notes)
          }
        }
      }
    } else if (presetRequested) {
      const checked = validateSetting('preset', patch.preset)
      if (checked.ok) {
        this.values.preset = checked.value
        applied.push('preset')
      } else {
        errors.push({ key: 'preset', reason: checked.reason })
      }
    }

    // ── 逐键处理 ────────────────────────────────────────────────────────
    for (const key of ownKeys(patch)) {
      if (key === 'preset') continue // 上面处理过了
      if (!SETTING_KEYS.includes(key)) {
        ignored.push(key)
        continue
      }
      if (key === 'customPresets') {
        const checked = validateCustomPresets(patch[key])
        ignored.push(...checked.ignored)
        errors.push(...checked.errors)
        if (checked.ok) {
          this.values.customPresets = checked.values
          applied.push('customPresets')
        }
        continue
      }
      const checked = validateSetting(key, patch[key])
      if (!checked.ok) {
        errors.push({ key, reason: checked.reason })
        continue
      }
      this.values[key] = checked.value
      applied.push(key)
      // ⚠️ 别漏 `notes`：分类校验会产出「已自动补上兜底分类」「这个后缀被两类同时声明」这类
      //    非致命提示。漏掉它们的后果是**用户永远看不到**（设置页/agent 工具都靠这个字段提示），
      //    而被自动补上兜底分类这件事恰恰是会静默改变用户配置的 —— 必须说出来。
      //    这条是 test/settings.test.mjs §7「缺兜底类的配置存进去后兜底类会被补上」抓出来的。
      if (Array.isArray(checked.notes) && checked.notes.length) notes.push(...checked.notes)
    }

    // ── 「微调后变 custom」──────────────────────────────────────────────
    // 只有**外观类**键被单独改动时才算「微调」；listLimit / indexExtraDirs 这些
    // 不属于任何预设，改它们不该把预设名打成 custom。
    if (!presetRequested && appearanceKeysPresent.length > 0) {
      const currentPreset = this.values.preset || DEFAULT_SETTINGS.preset
      const expanded = this.expandPreset(currentPreset)
      const matchesPreset = expanded !== undefined && APPEARANCE_KEYS.every((key) => {
        const a = this.values[key] === undefined ? DEFAULT_SETTINGS[key] : this.values[key]
        const b = expanded[key]
        return JSON.stringify(a) === JSON.stringify(b)
      })
      if (!matchesPreset) this.values.preset = 'custom'
      else this.values.preset = currentPreset
      if (!applied.includes('preset')) applied.push('preset')
    }

    const after = this.get()
    for (const key of SETTING_KEYS) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key)
    }
    // ⚠️ 必须落盘 —— 这一段最初漏了，被 test/settings.test.mjs 的
    //    「落盘 → 重新 load 后仍然一致」抓住（设置能读能写但重启就没了）。
    const saved = changed.length > 0 ? this.save() : true
    return { applied: [...new Set(applied)], ignored, errors, changed, saved, notes }
  }

  /** 导出载荷（含旧 store 的设置键，用户拿到的是一个完整可搬走的配置） */
  exportPayload(legacy = {}, options = {}) {
    const settings = { ...this.get() }
    for (const key of LEGACY_SETTINGS_KEYS) {
      if (legacy && Object.prototype.hasOwnProperty.call(legacy, key)) settings[key] = legacy[key]
    }
    const customPresets = isPlainObject(this.values.customPresets) && Object.keys(this.values.customPresets).length > 0
      ? structuredClone(this.values.customPresets)
      : undefined
    return {
      format: SETTINGS_FORMAT,
      version: SETTINGS_VERSION,
      exportedAt: options.now ? new Date(options.now).toISOString() : new Date().toISOString(),
      settings,
      ...(customPresets === undefined ? {} : { customPresets }),
    }
  }

  /**
   * 导入。**先全量校验，再一次性应用**（fail closed）：
   * 载荷里有原型污染键 / 格式版本不匹配 / 顶层不是对象 → 直接失败，**一个键都不应用**。
   *
   * @param {unknown} payload
   * @returns {{ok:boolean, applied?:string[], ignored?:string[], errors:Array<{key:string,reason:string}>,
   *   settings?:object, legacyPatch?:object, fatal?:string}}
   */
  importPayload(payload) {
    const errors = []
    if (!isPlainObject(payload)) {
      return { ok: false, fatal: 'payload-not-object', errors: [{ key: '$', reason: '导入内容需要是一个 JSON 对象' }] }
    }
    const { found, truncated } = scanForbiddenKeys(payload)
    if (found.length > 0) {
      // fail closed：发现污染键就整体拒绝，不做部分应用
      return {
        ok: false,
        fatal: 'prototype-pollution',
        errors: found.map((key) => ({ key, reason: '禁止的键（原型污染风险），已拒绝整份导入' })),
      }
    }
    if (truncated) {
      return { ok: false, fatal: 'too-large', errors: [{ key: '$', reason: '导入内容层级过深或过大，已拒绝' }] }
    }
    if (payload.format !== SETTINGS_FORMAT) {
      return {
        ok: false,
        fatal: 'format-mismatch',
        errors: [{ key: 'format', reason: `格式不匹配：期望 ${SETTINGS_FORMAT}，得到 ${JSON.stringify(payload.format)}` }],
      }
    }
    if (payload.version !== SETTINGS_VERSION) {
      // 明确报错，**不做猜测式迁移**
      return {
        ok: false,
        fatal: 'version-mismatch',
        errors: [{ key: 'version', reason: `版本不匹配：本插件支持 ${SETTINGS_VERSION}，文件是 ${JSON.stringify(payload.version)}（不做自动迁移，请手工调整）` }],
      }
    }
    if (payload.settings !== undefined && !isPlainObject(payload.settings)) {
      return { ok: false, fatal: 'settings-not-object', errors: [{ key: 'settings', reason: 'settings 需要对象' }] }
    }
    if (payload.customPresets !== undefined && !isPlainObject(payload.customPresets)) {
      return { ok: false, fatal: 'customPresets-not-object', errors: [{ key: 'customPresets', reason: 'customPresets 需要对象' }] }
    }

    const ignored = []
    const applied = []
    const legacyPatch = {}
    const incoming = payload.settings || {}

    // 未识别的**信封**键也如实回报（前向兼容：不报错，但让用户看见）
    for (const key of ownKeys(payload)) {
      if (!['format', 'version', 'exportedAt', 'settings', 'customPresets'].includes(key)) ignored.push(key)
    }

    // ── 先把整份内容校验完，全部通过才落盘 ──────────────────────────────
    const staged = {}
    for (const key of ownKeys(incoming)) {
      if (LEGACY_SETTINGS_KEYS.includes(key)) {
        legacyPatch[key] = incoming[key] // 交给 store.updateSettings 自己做范围夹取
        applied.push(key)
        continue
      }
      if (key === 'customPresets') {
        const checked = validateCustomPresets(incoming[key])
        if (!checked.ok) { errors.push(...checked.errors); continue }
        ignored.push(...checked.ignored)
        errors.push(...checked.errors)
        staged.customPresets = checked.values
        applied.push('customPresets')
        continue
      }
      if (!Object.keys(DEFAULT_SETTINGS).includes(key)) {
        ignored.push(key)
        continue
      }
      const checked = validateSetting(key, incoming[key])
      if (!checked.ok) {
        errors.push({ key, reason: checked.reason })
        continue
      }
      staged[key] = checked.value
      applied.push(key)
    }
    // 信封里的 customPresets 优先于 settings 里的（两者都给时以后者为准更符合直觉？——
    // 取「settings.customPresets 优先，其次信封」，并把这个口径写在这里免得将来含糊）
    if (payload.customPresets !== undefined && staged.customPresets === undefined) {
      const checked = validateCustomPresets(payload.customPresets)
      if (checked.ok) {
        ignored.push(...checked.ignored)
        errors.push(...checked.errors)
        staged.customPresets = checked.values
        applied.push('customPresets')
      } else {
        errors.push(...checked.errors)
      }
    }

    // 预设展开：导入**不**展开 `preset`（载荷里的外观值已经是展开后的结果，
    // 再展开会覆盖用户文件里的微调值）。只把 preset 名字本身记下来。
    for (const key of ownKeys(staged)) this.values[key] = staged[key]
    const saved = ownKeys(staged).length > 0 ? this.save() : true

    return { ok: true, applied: [...new Set(applied)], ignored: [...new Set(ignored)], errors, settings: this.get(), legacyPatch, saved }
  }

  /** 打回默认（危险操作，仅供测试/重置用） */
  reset() {
    this.values = {}
    this.save()
    return this.get()
  }
}

/** 供 HTTP 层报告给客户端的 schema（单一真相源，免得 ui-core 硬编码 5 个预设和选项表） */
export function settingsSchema() {
  return {
    version: SETTINGS_VERSION,
    format: SETTINGS_FORMAT,
    defaults: DEFAULT_SETTINGS,
    enums: ENUMS,
    ranges: RANGES,
    booleans: BOOLEANS,
    appearanceKeys: APPEARANCE_KEYS,
    contentKeys: CONTENT_KEYS,
    hostEffectiveKeys: HOST_EFFECTIVE_KEYS,
    legacyKeys: LEGACY_SETTINGS_KEYS,
    presets: Object.entries(PRESETS).map(([id, preset]) => ({
      id, label: preset.label, hint: preset.hint, values: preset.values,
      // 内容层（Step 2e）：预设除了「外观起点值」还带**分类**，
      // 而外观是**重置**、分类是**合并（只增不删）** —— 两者行为不同，
      // 所以必须分别报出来，让设置页能如实告诉用户「套这个预设会多出哪些分类」。
      // 只报 id/label：设置页要的是「会多出什么」，不需要完整定义（那是宿主的事）。
      contentCategories: contentCategorySummary(preset),
    })),
  }
}

/**
 * 把一个预设的 `content.categories` 摘成 `[{id, label}]`（给设置页展示用）。
 * @param {object} preset
 * @returns {Array<{id:string,label:string}>}
 */
function contentCategorySummary(preset) {
  const list = preset && preset.content && Array.isArray(preset.content.categories) ? preset.content.categories : []
  return list.map((c) => ({ id: String(c.id), label: String(c.label === undefined ? c.id : c.label) }))
}
