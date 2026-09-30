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
}

/**
 * 宿主自己消费（= 不依赖客户端也算生效）的键。
 * 其余外观项的生效点在 ui-core 的渲染层 —— 别把这两类混为一谈。
 */
export const HOST_EFFECTIVE_KEYS = ['listLimit', 'thumbMaxBytes', 'showHidden', 'indexExtraDirs']

/**
 * 5 个内置预设。**只放差异项**（`values`），缺的键在应用时从 DEFAULT_SETTINGS 继承 ——
 * 这样将来加设置项，预设自动获得新默认，不会漏项。
 */
export const PRESETS = {
  general: {
    label: '通用',
    hint: '全默认：列表视图、名称升序、标准行高',
    values: {},
  },
  developer: {
    label: '开发者',
    hint: '紧凑行高 + 按修改时间倒序 + 显示类型列',
    values: {
      density: 'compact',
      sortBy: 'time',
      sortDir: 'desc',
      columns: { size: true, time: true, type: true },
    },
  },
  research: {
    label: '研究者 / 学生',
    hint: '标准行高 + 名称升序，便于按论文/实验编号定位',
    values: {
      density: 'standard',
      sortBy: 'name',
      sortDir: 'asc',
      columns: { size: true, time: true, type: false },
    },
  },
  creator: {
    label: '内容创作',
    hint: '宽松行高 + 画廊视图，素材一眼看得见',
    values: {
      density: 'loose',
      defaultView: 'gallery',
      galleryThumbSize: 96,
    },
  },
  office: {
    label: '办公 / 职场',
    hint: '标准行高 + 按修改时间倒序 + 显示类型列',
    values: {
      density: 'standard',
      sortBy: 'time',
      sortDir: 'desc',
      columns: { size: true, time: true, type: true },
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
   * @returns {{applied:string[], ignored:string[], errors:Array<{key:string,reason:string}>, changed:string[]}}
   */
  update(patch, options = {}) {
    const applied = []
    const ignored = []
    const errors = []
    const changed = []
    if (!isPlainObject(patch)) {
      return { applied, ignored, errors: [{ key: '$', reason: 'patch 需要对象' }], changed }
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
    return { applied: [...new Set(applied)], ignored, errors, changed, saved }
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
    hostEffectiveKeys: HOST_EFFECTIVE_KEYS,
    legacyKeys: LEGACY_SETTINGS_KEYS,
    presets: Object.entries(PRESETS).map(([id, preset]) => ({ id, label: preset.label, hint: preset.hint, values: preset.values })),
  }
}
