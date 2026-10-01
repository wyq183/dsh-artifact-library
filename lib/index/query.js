/**
 * dsh-artifact-library — 文件索引：查询编译器（Everything 语法 → 谓词）
 *
 * ── 为什么要有它 ───────────────────────────────────────────────────────────
 *
 * Windows 上的搜索走后端是 Everything，它自带一套查询语法
 * （`ext:png dm:today size:>10mb path:项目`、`空格=AND`、`|`=OR、`!`=NOT）。
 * 这套语法已经**泄漏到三个公开面**上：`search_files` 工具的 description、
 * README、以及用户肌肉记忆。
 *
 * Linux 上没有 Everything。要让「换平台」不变成「换一套用法」，就得让
 * **查询语义与平台解耦**：把 Everything 语法在插件内部编译成谓词，
 * 由纯 JS 对内存行集求值。
 *
 * 于是：
 *   · Windows 仍交给 es.exe（原生最快，行为不变）
 *   · Linux 走本编译器 + 内存索引（**语法/语义一致**，用户无感）
 *   · 将来想给 Windows 加节点索引兜底，同一个编译器直接复用
 *
 * ── 支持的语法（子集，够用且可解释）────────────────────────────────────────
 *
 *   空格            AND（全部子句都要命中）
 *   a|b             OR（同一子句内的备选，任一命中即可）
 *   !x              取反
 *   "多 词"          带空格的词（引号内不切分）
 *   ext:png          扩展名；`ext:png;jpg` 多选
 *   name:abc         （别名 filename: / file:）只匹配**文件名**
 *   path:abc         只匹配**所在目录**
 *   folder:          （别名 dir:）只看目录
 *   type:file        （别名 type:folder）按类型
 *   size:>10mb       大小；支持 > < >= <= 与区间 1mb..10mb；单位 b/kb/mb/gb（1kb=1024）
 *   dm:today         修改时间；支持 today/yesterday/thisweek/lastweek/thismonth/
 *                    lastmonth/thisyear/lastyear/last7days/last30days，以及
 *                    YYYY-MM-DD 与 > < >= <= 和区间 a..b
 *   dc:...           创建时间（同 dm:）
 *   *  ?             词内通配（转成正则）
 *   裸词             文件名**或**所在目录的**子串**匹配（不区分大小写）
 *
 * 设计取舍：**裸词匹配整条路径**（而不是只匹配文件名），因为用户的
 * 「第一直觉」是「我打关键字，你就把相关的找出来」；Everything 的默认行为
 * 也覆盖路径。要精确匹配文件名用 `name:`。
 *
 * 本模块是**纯函数**：不碰文件系统、不依赖 ctx、可直接单测。
 */

/** 大小单位（1kb = 1024，与 Everything 一致） */
const SIZE_UNITS = {
  b: 1, byte: 1, bytes: 1,
  k: 1024, kb: 1024, kib: 1024,
  m: 1048576, mb: 1048576, mib: 1048576,
  g: 1073741824, gb: 1073741824, gib: 1073741824,
  t: 1099511627776, tb: 1099511627776, tib: 1099511627776,
}

/**
 * 把一个带单位的体积串解析成字节数。
 * @param {string} text 例如 `10mb` / `1.5kb` / `512`
 * @returns {number|null}
 */
export function parseSize(text) {
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*([a-z]*)$/i.exec(String(text || '').trim())
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value)) return null
  const unit = (m[2] || 'b').toLowerCase()
  const scale = SIZE_UNITS[unit]
  if (!scale) return null
  return Math.round(value * scale)
}

/** 一天/一周的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 当天 00:00:00（本地时区）的毫秒时间戳 */
function startOfDay(base = Date.now()) {
  const d = new Date(base)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本周一 00:00（本地时区；ISO 周，周一为始） */
function startOfWeek(base = Date.now()) {
  const d = new Date(startOfDay(base))
  const dow = (d.getDay() + 6) % 7 // 周一=0
  return d.getTime() - dow * DAY_MS
}

/** 本月 1 日 00:00 */
function startOfMonth(base = Date.now()) {
  const d = new Date(base)
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  return d.getTime()
}

/** 今年 1 月 1 日 00:00 */
function startOfYear(base = Date.now()) {
  const d = new Date(base)
  d.setHours(0, 0, 0, 0)
  d.setMonth(0, 1)
  return d.getTime()
}

/** 解析 `YYYY-MM-DD`（本地时区当天 00:00） */
function parseIsoDay(text) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(text || '').trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  d.setHours(0, 0, 0, 0)
  const t = d.getTime()
  return Number.isFinite(t) ? t : null
}

/** 具名时间点 → `[起, 止)` 毫秒区间（止为 null = 无上界） */
const NAMED_RANGES = {
  today: () => [startOfDay(), null],
  yesterday: () => [startOfDay() - DAY_MS, startOfDay()],
  thisweek: () => [startOfWeek(), null],
  lastweek: () => [startOfWeek() - 7 * DAY_MS, startOfWeek()],
  thismonth: () => [startOfMonth(), null],
  lastmonth: () => {
    const first = new Date(startOfMonth())
    const prev = new Date(first)
    prev.setMonth(prev.getMonth() - 1)
    return [prev.getTime(), first.getTime()]
  },
  thisyear: () => [startOfYear(), null],
  lastyear: () => {
    const first = new Date(startOfYear())
    const prev = new Date(first)
    prev.setFullYear(prev.getFullYear() - 1)
    return [prev.getTime(), first.getTime()]
  },
  last7days: () => [startOfDay() - 6 * DAY_MS, null],
  last30days: () => [startOfDay() - 29 * DAY_MS, null],
}

/**
 * 把一个时间条件串编译成谓词。
 * @param {string} spec 例如 `today` / `>2026-01-01` / `2026-01-01..2026-02-01`
 * @returns {((ms:number)=>boolean)|null} 无法解析返回 null（调用方据此报错）
 */
export function compileTimeSpec(spec) {
  const raw = String(spec || '').trim()
  if (!raw) return null

  // 区间：a..b（两端都可省略）
  const range = /^([^.]*?)\.\.(.*)$/.exec(raw)
  if (range) {
    const lo = resolveTimePoint(range[1])
    const hi = resolveTimePoint(range[2])
    if (lo === null && hi === null) return null
    return (ms) => (lo === null || ms >= lo) && (hi === null || ms < hi)
  }

  // 具名区间
  const named = NAMED_RANGES[raw.toLowerCase()]
  if (named) {
    const [lo, hi] = named()
    return (ms) => ms >= lo && (hi === null || ms < hi)
  }

  // 比较：> < >= <=
  const cmp = /^(>=|<=|>|<)\s*(.+)$/.exec(raw)
  if (cmp) {
    const bound = resolveTimePoint(cmp[2])
    if (bound === null) return null
    switch (cmp[1]) {
      case '>': return (ms) => ms > bound
      case '>=': return (ms) => ms >= bound
      case '<': return (ms) => ms < bound
      default: return (ms) => ms <= bound
    }
  }

  // 裸日期 = 当天
  const day = resolveTimePoint(raw)
  if (day === null) return null
  return (ms) => ms >= day && ms < day + DAY_MS
}

/** 单个时间点 → 毫秒；`YYYY-MM-DD` 或具名区间的起点 */
function resolveTimePoint(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const iso = parseIsoDay(raw)
  if (iso !== null) return iso
  const named = NAMED_RANGES[raw.toLowerCase()]
  if (named) return named()[0]
  // 相对：7d / 2w / 3m / 1y（从今天 00:00 往前推）
  const rel = /^(\d+)\s*([dwmy])$/i.exec(raw)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2].toLowerCase()
    const base = startOfDay()
    if (unit === 'd') return base - (n - 1) * DAY_MS
    if (unit === 'w') return startOfWeek() - (n - 1) * 7 * DAY_MS
    if (unit === 'm') {
      const d = new Date(base)
      d.setMonth(d.getMonth() - n)
      return d.getTime()
    }
    const d = new Date(base)
    d.setFullYear(d.getFullYear() - n)
    return d.getTime()
  }
  return null
}

/** 把体积条件编译成谓词 */
export function compileSizeSpec(spec) {
  const raw = String(spec || '').trim()
  if (!raw) return null

  const range = /^(.*?)\.\.(.*)$/.exec(raw)
  if (range) {
    const lo = range[1].trim() ? parseSize(range[1]) : null
    const hi = range[2].trim() ? parseSize(range[2]) : null
    if (lo === null && hi === null) return null
    return (bytes) => (lo === null || bytes >= lo) && (hi === null || bytes <= hi)
  }

  const cmp = /^(>=|<=|>|<)\s*(.+)$/.exec(raw)
  if (cmp) {
    const bound = parseSize(cmp[2])
    if (bound === null) return null
    switch (cmp[1]) {
      case '>': return (n) => n > bound
      case '>=': return (n) => n >= bound
      case '<': return (n) => n < bound
      default: return (n) => n <= bound
    }
  }

  const exact = parseSize(raw)
  if (exact === null) return null
  return (n) => n === exact
}

/** 转义正则元字符 */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 词 → 匹配器。含 `*` / `?` 时按通配（整个字段匹配），否则子串匹配。
 * @param {string} word
 * @returns {(haystack:string)=>boolean}
 */
function makeTextMatcher(word) {
  const text = String(word)
  if (!text) return () => true
  if (text.includes('*') || text.includes('?')) {
    const pattern = '^' + text.split('').map((ch) => {
      if (ch === '*') return '.*'
      if (ch === '?') return '.'
      return escapeRe(ch)
    }).join('') + '$'
    let re
    try { re = new RegExp(pattern, 'i') } catch { return () => false }
    return (haystack) => re.test(String(haystack || ''))
  }
  const needle = text.toLowerCase()
  return (haystack) => String(haystack || '').toLowerCase().includes(needle)
}

/** 支持 `a;b` 多选的字段匹配器 */
function makeMultiMatcher(spec) {
  const parts = String(spec).split(';').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return () => true
  const matchers = parts.map(makeTextMatcher)
  return (haystack) => matchers.some((m) => m(haystack))
}

/** 把一小段查询串切成词（尊重双引号、`!` 前缀） */
function tokenize(text) {
  const tokens = []
  const re = /(!?)"([^"]*)"|(!?)([^\s"|]+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (m[2] !== undefined) tokens.push({ negate: m[1] === '!', text: m[2] })
    else if (m[4]) tokens.push({ negate: m[3] === '!', text: m[4] })
  }
  return tokens
}

/** 把单个词编译成 `(row)=>boolean` */
function compileWord(word) {
  const colon = word.indexOf(':')
  let field = ''
  let value = word
  if (colon > 0) {
    field = word.slice(0, colon).toLowerCase()
    value = word.slice(colon + 1)
  }

  switch (field) {
    case 'ext': {
      const matcher = makeMultiMatcher(value.replace(/^\./, ''))
      return { ok: true, test: (row) => matcher(row.ext || ''), label: `ext:${value}` }
    }
    case 'name':
    case 'filename':
    case 'file':
      return { ok: true, test: (row) => makeTextMatcher(value)(row.name), label: `name:${value}` }
    case 'path':
    case 'dir':
      return { ok: true, test: (row) => makeTextMatcher(value)(row.dir), label: `path:${value}` }
    case 'folder':
      return { ok: true, test: (row) => row.isDirectory === true, label: 'folder' }
    case 'type': {
      const v = value.toLowerCase()
      if (v === 'file' || v === 'files') return { ok: true, test: (row) => row.isDirectory !== true, label: 'type:file' }
      if (v === 'folder' || v === 'dir' || v === 'directory') return { ok: true, test: (row) => row.isDirectory === true, label: 'type:folder' }
      return { ok: false, error: `type: 只认 file / folder，得到「${value}」` }
    }
    case 'size': {
      const fn = compileSizeSpec(value)
      if (!fn) return { ok: false, error: `看不懂的体积条件「size:${value}」（例：size:>10mb、size:1kb..1mb）` }
      return { ok: true, test: (row) => fn(Number(row.size) || 0), label: `size:${value}` }
    }
    case 'dm':
    case 'date':
    case 'modified': {
      const fn = compileTimeSpec(value)
      if (!fn) return { ok: false, error: `看不懂的时间条件「dm:${value}」（例：dm:today、dm:>2026-01-01、dm:2026-01-01..2026-02-01）` }
      return { ok: true, test: (row) => row.modified != null && fn(row.modified * 1000), label: `dm:${value}` }
    }
    case 'dc':
    case 'created': {
      const fn = compileTimeSpec(value)
      if (!fn) return { ok: false, error: `看不懂的时间条件「dc:${value}」` }
      return { ok: true, test: (row) => row.created != null && fn(row.created * 1000), label: `dc:${value}` }
    }
    default:
      break
  }

  // 没写字段名（或字段名不认识）→ 裸词，匹配文件名或所在目录
  const matcher = makeTextMatcher(word)
  return { ok: true, test: (row) => matcher(row.name) || matcher(row.dir), label: word }
}

/**
 * 编译整条查询。
 *
 * @param {string} query Everything 风格查询；空串 = 全部
 * @returns {{ok:true, predicate:(row)=>boolean, groups:number, describe:string}
 *          | {ok:false, error:string}}
 */
export function compileQuery(query) {
  const text = String(query == null ? '' : query).trim()
  if (!text) {
    return { ok: true, predicate: () => true, groups: 0, describe: '（空查询 = 全部）' }
  }

  // 先按空格切成「子句」（子句之间是 AND），每个子句内部再按 `|` 切备选（备选之间是 OR）。
  //
  // ⚠️ 结构必须是「组的组」而不是一层扁平数组：`ext:md|ext:pdf` 里
  //    `ext:md` 与 `ext:pdf` 是 **OR** 关系。第一版把它们和同组其他词一样按 AND 拼，
  //    于是 `ext:md|ext:pdf` 要求「既是 md 又是 pdf」→ 恒为 0 条（自测当场抓到）。
  const groups = []
  for (const chunk of text.split(/\s+/).filter(Boolean)) {
    const alternatives = chunk.split('|').filter((s) => s !== '')
    const compiledAlternatives = []
    for (const alt of alternatives) {
      const tokens = tokenize(alt)
      const clauses = []
      for (const token of tokens) {
        const word = compileWord(token.text)
        if (!word.ok) return { ok: false, error: word.error }
        clauses.push({ negate: token.negate, test: word.test, label: word.label })
      }
      if (clauses.length) compiledAlternatives.push(clauses)
    }
    if (compiledAlternatives.length) groups.push(compiledAlternatives)
  }

  if (!groups.length) {
    return { ok: true, predicate: () => true, groups: 0, describe: '（空查询 = 全部）' }
  }

  // 子句之间 AND；子句内备选之间 OR；备选内词之间 AND
  const predicate = (row) => groups.every((alternatives) => alternatives.some((clauses) =>
    clauses.every((clause) => {
      const hit = clause.test(row)
      return clause.negate ? !hit : hit
    })))

  const describeGroup = (alternatives) => alternatives
    .map((clauses) => clauses.map((c) => (c.negate ? '!' : '') + c.label).join('&'))
    .join('|')

  return {
    ok: true,
    predicate,
    groups: groups.length,
    describe: groups.map(describeGroup).join(' '),
  }
}

/** 自然序比较（中文/数字友好），退化时按码位 */
const collator = (() => {
  try { return new Intl.Collator('zh-CN', { numeric: true }) } catch { return null }
})()

function compareText(a, b) {
  const left = String(a || '')
  const right = String(b || '')
  if (collator) {
    const r = collator.compare(left, right)
    if (r !== 0) return r
  }
  return left < right ? -1 : left > right ? 1 : 0
}

/** 排序字段的别名（与 Everything 的 `-sort` 词表对齐） */
const SORT_ALIASES = {
  name: 'name', filename: 'name',
  path: 'path',
  size: 'size',
  'date-modified': 'modified', modified: 'modified', dm: 'modified',
  'date-created': 'created', created: 'created', dc: 'created',
  ext: 'ext', type: 'type',
}

/**
 * 排序（不修改入参）。
 * @param {object[]} rows
 * @param {string} [sort] name/path/size/date-modified/date-created；未知值按 name
 * @param {'asc'|'desc'} [direction]
 */
export function sortRows(rows, sort, direction = 'asc') {
  const key = SORT_ALIASES[String(sort || '').toLowerCase()] || 'name'
  const dir = direction === 'desc' ? -1 : 1
  const sorted = rows.slice()
  sorted.sort((a, b) => {
    let r = 0
    if (key === 'size') r = (Number(a.size) || 0) - (Number(b.size) || 0)
    else if (key === 'modified') r = (Number(a.modified) || 0) - (Number(b.modified) || 0)
    else if (key === 'created') r = (Number(a.created) || 0) - (Number(b.created) || 0)
    else if (key === 'type') r = Number(!!a.isDirectory) - Number(!!b.isDirectory)
    else r = compareText(a[key] || '', b[key] || '')
    if (r !== 0) return r * dir
    // 并列时用路径兜底，保证顺序稳定（同样的输入永远同样的输出）
    return compareText(a.path, b.path)
  })
  return sorted
}

/** 未知排序名 → 归一化（给上层做参数校验用） */
export function normalizeSortName(sort) {
  return SORT_ALIASES[String(sort || '').toLowerCase()] || ''
}
