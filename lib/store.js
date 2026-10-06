/**
 * dsh-artifact-library — 产物存储（JSON 文件，原子写入）
 * 数据模型为通用产物 schema（产出/资料），从零开始。
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// 「项目合并」的规则层（纯函数聚类）—— 见 lib/project-merge.js 顶部说明
import { findMergeGroups, NON_PROJECT_NAMES } from './project-merge.js'
// 分类（后缀 ↔ 分类）的规则层 —— 见 lib/categories.js 顶部说明（为什么单独一个文件）
import { inferCategoryFromPath, groupByCategory, FALLBACK_CATEGORY_ID } from './categories.js'

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', html: 'text/html',
  htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  py: 'text/x-python', yml: 'text/yaml', yaml: 'text/yaml', csv: 'text/csv',
  pdf: 'application/pdf', zip: 'application/zip', exe: 'application/x-msdownload',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase().replace('.', '')
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

export function newId() {
  return 'art_' + randomBytes(6).toString('hex')
}

/**
 * 有效记录判定：未回收、且未被整理归档。
 * 「归档」（status='archived'）是整理时对重复副本的处理——记录保留可查，
 * 但不再参与整理建议、统计与精化目标；否则建议单会反复报同一批、永不收敛。
 * @param {object} r 产物记录
 * @returns {boolean}
 */
export function isActiveRecord(r) {
  return r.trashed_at === null && r.status !== 'archived'
}

/** 可抽取正文的文本类扩展名（本地正文索引用，绝不上传；每篇只索引前 MAX_TEXT_INDEX_CHARS 字符） */
const TEXTISH_EXT = new Set(['txt', 'md', 'markdown', 'json', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'yml', 'yaml', 'csv', 'xml', 'toml', 'ini', 'conf', 'log', 'sh', 'bat', 'ps1', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'rb', 'php', 'sql', 'vue', 'svelte'])

// ── 敏感路径防护（v0.3.1 安全加固）──────────────────────────────
// 凭据/密钥/证书/env 等文件绝不允许进库（防止 API key 泄露进正文索引与 /file 读取）；
// 凭据存放目录（.ssh/.gnupg/.aws 等）下的任何文件同样拒绝。
// 注意：~/.dsh 本身不整体拒绝——自动采集会合法登记 .dsh 下的产物（如技能文档），
// 但 .dsh 下的凭据文件名（credentials.json 等）仍会被文件名正则拦截。
const SENSITIVE_FILE_RE = /(^|[._-])(credentials?|creds|secret|token|apikey|api[_-]?key|passwd|password|auth|\.env|\.pem|\.key|\.p12|\.pfx|id_rsa|id_ed25519|\.npmrc|\.netrc|\.git-credentials)([._-]|$)/i
// 任意路径段出现即拒绝：凭据/令牌存放目录（Windows AppData 是用户配置大区，合法产物也存在，
// 不整体拒绝——其中的敏感文件由上面的文件名正则兜底）
const PROTECTED_DIR_NAMES = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.npmrc'])
/**
 * ⚠️ 这两份名单的分工是**刻意**的（2026-09-30 统一判据）：
 *
 * - **凭据/配置目录**（`PROTECTED_DIR_NAMES`）：**任意层级**都算敏感。
 *   理由：正经项目里不会出现叫 `.ssh` 的目录 —— 它在哪一层，那一层就是凭据目录。
 * - **系统目录**：**只算「根之下第一段」**。
 *   理由：`C:\Windows` 是系统目录，而 `D:\作品\windows` 只是**恰好重名**的普通文件夹。
 *
 * 为什么要写清这段：原来**同一件事有两套判据** —— 文件级用**路径段**（正确），
 * 导入根目录级用 **basename 名字**（弱），于是 `D:\作品\windows` 这种正常作品夹
 * 会被**误拒**（用户只会以为功能坏了）。判据不一致，行为必然不一致。
 *
 * ── 2026-10-01：判据补上 POSIX（原来是纯 Windows，换个平台护栏就空转）────────
 *
 * 实测（改造前）：`checkImportRoot('/etc')`、`'/usr'`、`'/'`、`'/System'` **全部返回 ok:true**
 * —— 因为整段逻辑的前提是 `const isDrive = /^[a-z]:$/i.test(parts[0])`，
 * POSIX 路径永远不是盘符，于是**护栏一条都不触发**，`/etc` 能整批导进库。
 * 现在按「路径形态」分流而不是按「当前操作系统」分流，这样同一份代码在两边都对，
 * 也顺带保住了跨平台迁移过来的老数据（Windows 形态路径在任何平台上都按 Windows 判）。
 */
/** Windows：盘符根下第一段 */
const PROTECTED_TOPLEVEL_NAMES_WINDOWS = new Set([
  'windows', 'system32', 'programdata', 'program files', 'program files (x86)',
  '$recycle.bin', 'system volume information', 'appdata', '.dsh',
])
/**
 * POSIX：`/` 下第一段。
 *
 * 刻意**不含** `opt` / `srv` / `tmp` / `home` / `mnt` / `media` ——
 * 那些位置经常真有用户的工程（`/opt/app`、`/srv/www`、`/mnt/d/作品`），
 * 拦下来只会把护栏做成「什么都不让导」。**该拦的是系统状态与凭据所在。**
 */
const PROTECTED_TOPLEVEL_NAMES_POSIX = new Set([
  'etc', 'usr', 'bin', 'sbin', 'boot', 'proc', 'sys', 'dev', 'root',
  'lib', 'lib32', 'lib64', 'libx32', 'var', 'run', 'lost+found',
  'system', 'library', 'applications', 'private', 'volumes', 'cores',
])

/** 敏感路径判定：文件名是凭据/密钥类，或路径中任意目录段是凭据存放目录 → 拒绝进库 */
export function isSensitivePath(p) {
  if (typeof p !== 'string' || !p) return false
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  if (!parts.length) return false
  if (SENSITIVE_FILE_RE.test(parts[parts.length - 1])) return true
  return parts.some((seg) => PROTECTED_DIR_NAMES.has(seg.toLowerCase()))
}

/** 展示用：去掉尾部分隔符（消息里不出现 `/etc/` 这种尾巴） */
function shownPath(raw) {
  return String(raw || '').trim().replace(/[\\/]+$/, '') || String(raw || '').trim()
}

/**
 * 导入**根目录**的敏感判定（与 `isSensitivePath` 共用「凭据任意层级」那套语义）。
 *
 * 按**路径形态**分流（盘符 / POSIX 绝对 / 其他），不按当前操作系统分流 ——
 * 这样在 Linux 上也能正确拒绝 `C:\Windows`（跨平台迁移的老数据/用户手输都会遇到）。
 *
 * @returns {{ok:true} | {ok:false, kind:'credential'|'system'|'profile', hit:string, message:string}}
 */
export function checkImportRoot(rootPath) {
  const raw = String(rootPath || '').trim()
  if (!raw) return { ok: true }

  const parts = raw.split(/[\\/]+/).filter(Boolean)
  const isDrive = parts.length > 0 && /^[a-z]:$/i.test(parts[0])
  const isPosixAbs = raw.startsWith('/') || raw.startsWith('\\')

  // ① 整个磁盘根（`/`、`//`、`C:\`）—— 整份导入必然是误操作。
  //    ⚠️ 改造前这里有个洞：`'/'` 被 split 成 []，直接命中 `!parts.length → ok:true`。
  if (!parts.length || (isDrive && parts.length === 1)) {
    return {
      ok: false, kind: 'system', hit: raw,
      message: `「${shownPath(raw) || raw}」是整个磁盘根目录，不能整份导入。请选择具体的作品/资料文件夹。`,
    }
  }

  // ② 凭据目录：任意层级（与 isSensitivePath 一致）
  const cred = parts.find((seg) => PROTECTED_DIR_NAMES.has(seg.toLowerCase()))
  if (cred) {
    return {
      ok: false, kind: 'credential', hit: cred,
      message: `路径里包含凭据/配置目录「${cred}」，为避免凭据泄露已拒绝导入。请选择存放作品/资料的普通文件夹。`,
    }
  }

  if (isDrive) {
    // ③ Windows 形态：系统目录只看盘符根下的第一段 → `D:\作品\windows` 不再被误拒
    const toplevel = parts.length >= 2 ? String(parts[1]).toLowerCase() : ''
    if (PROTECTED_TOPLEVEL_NAMES_WINDOWS.has(toplevel)) {
      return {
        ok: false, kind: 'system', hit: parts[1],
        message: `「${parts[0]}\\${parts[1]}」是系统目录，已拒绝导入。请选择存放作品/资料的普通文件夹。`,
      }
    }
    // ④ 整个用户配置目录本身（`C:\Users\<你>`）：整份导入几乎必然是误操作
    //    —— 会连带 AppData（凭据缓存）且体量巨大。**它下面的具体作品目录仍可导入。**
    if (/^users$/i.test(parts[1] || '') && parts.length === 3) {
      return {
        ok: false, kind: 'profile', hit: parts[2],
        message: '这是整个用户配置目录（含 AppData、凭据缓存，体量很大），已拒绝整份导入。请选择它下面的具体文件夹（如 Desktop / Documents / 某个作品夹）。',
      }
    }
    return { ok: true }
  }

  if (isPosixAbs) {
    const toplevel = String(parts[0]).toLowerCase()
    // ⑤ POSIX 形态：系统目录只看根下第一段（`/home/yiqi/proj` 的 toplevel 是 home，放行）
    if (PROTECTED_TOPLEVEL_NAMES_POSIX.has(toplevel)) {
      return {
        ok: false, kind: 'system', hit: parts[0],
        message: `「/${parts[0]}」是系统目录，已拒绝导入。请选择存放作品/资料的普通文件夹。`,
      }
    }
    // ⑥ 用户主目录本身（`/home/<你>`、`/Users/<你>`）：整份导入几乎必然是误操作。
    //    下面更具体的作品目录（`/home/you/proj`）仍然放行。
    if (parts.length === 2 && (toplevel === 'home' || parts[0] === 'Users')) {
      return {
        ok: false, kind: 'profile', hit: parts[1],
        message: `「${shownPath(raw)}」是整个用户主目录（含 .ssh/.gnupg 等凭据目录与缓存，体量很大），已拒绝整份导入。请选择它下面的具体文件夹（如 Documents / 某个作品夹）。`,
      }
    }
    return { ok: true }
  }

  // 相对路径：不由这里判定，交给调用方的存在性检查
  return { ok: true }
}
const MAX_TEXT_INDEX_BYTES = 2_000_000 // 只索引 ≤2MB 的文本

/**
 * ★ 每文件**持久化**的正文上限（2026-09-30，R-6 方案 (A)）。
 *
 * 为什么从 50000 降到 8000：实测真实库 `artifacts.json` 3.24MB 里 **89% 是 `contentIndex`**
 * （2.77MB vs 元数据 0.35MB），而 `save()` 是**同步**序列化+写盘，
 * 阻塞时长随体积走（实测 0.5MB→16ms / 3.4MB→19ms / **29.1MB→73ms**）。
 * 按默认 `maxFiles=10000` 外推，全是长文本时会得到 **≈477MB 的 JSON** —— 那不是"卡一下"。
 *
 * 为什么 8000 够用：`contentIndex` 的用途是**全文检索的命中判定 + 摘要片段**，
 * 不是「读正文」——读正文走 `artifact_read`（**直接读磁盘，完全不受这个上限影响**）。
 * 8000 字符对绝大多数文档足以覆盖检索需要，且 8000/50000 = 体积降到 1/6。
 *
 * ⚠️ **诚实要求（lead 明确点名）**：被截断的记录必须**自己说出来**。
 *    所以每个记录带 `contentIndexChars` + `contentIndexTruncated`，
 *    详情/搜索结果要显示「正文已截断，仅索引前 N 字符」——
 *    **否则用户会以为检索是完整的**。
 */
export const MAX_TEXT_INDEX_CHARS = 8_000
/** 规则版本：变了就在 load() 里对全库重算一次（同 needsRefineRule 的做法） */
const CONTENT_INDEX_RULE = 2

/**
 * (D) 单次导入的**总字节预算**默认值（R-6，2026-09-30）。
 *
 * 为什么是 512MB：它远大于正常「作品/资料」文件夹，但能挡住两种极端 ——
 * 误选了一个巨大的目录树、或目录里有大量大二进制文件。
 * 配合 `MAX_TEXT_INDEX_CHARS`，512MB 的库最多产出 ≈ (512MB 里可索引的文本量) 的正文缓存，
 * 而不是无上限地长。
 */
export const DEFAULT_IMPORT_MAX_BYTES = 512 * 1024 * 1024

/**
 * 抽取本地文件正文建索引（本地读取，失败/二进制/过大则返回空串；只索引前 `MAX_TEXT_INDEX_CHARS` 字符）。
 * @returns {{text:string, truncated:boolean, totalChars:number}}
 *   `truncated` = 原文比 `MAX_TEXT_INDEX_CHARS` 长，**只索引了前一段** ——
 *   这个标志要一路带到记录上，让界面能如实说明「检索只覆盖了正文的一部分」。
 */
function extractLocalText(p, sizeBytes) {
  const none = { text: '', truncated: false, totalChars: 0 }
  const ext = path.extname(p).toLowerCase().replace('.', '')
  if (!TEXTISH_EXT.has(ext)) return none
  if (sizeBytes > MAX_TEXT_INDEX_BYTES) return none
  try {
    const buf = fs.readFileSync(p)
    if (buf.includes(0)) return none // 含空字节视为二进制，不索引
    const s = buf.toString('utf8').replace(/\r\n/g, '\n')
    return {
      text: s.slice(0, MAX_TEXT_INDEX_CHARS),
      truncated: s.length > MAX_TEXT_INDEX_CHARS,
      totalChars: s.length,
    }
  } catch {
    return none
  }
}

/**
 * ★ 精化状态的**唯一结算点**（2026-09-30 抽出来）。
 *
 * 抽它的原因和 `fileMention` 那次是同一类：这段判定原来在**三处**各写了一份
 * （`update()` / `load()` 的规则迁移回填 / 现在新增的 `unrefine()`），
 * 而且**已经漂了** —— `load()` 那份写的是 `String(r.project).length`，
 * `update()` 那份写的是 `r.project.length`。两处只在「project 不是字符串」时有差别，
 * 所以一直没被发现 —— 这正是「同一判定写多份」的典型下场：**不炸，只是慢慢不一致**。
 *
 * 现在统一取**更稳的那一版**（`String()` 兜住脏数据）。
 *
 *   · `needsRefine` = 摘要 + 标签 + 项目 **三者齐备**才算已精化（与精化 prompt 的目标一致）
 *   · 已精化 → 顺手清掉「⚡优先」标记，避免处理过的条目下次仍霸占待精化列表头部
 */
function settleRefine(rec) {
  rec.needsRefine = !(rec.summary && rec.summary.length > 0 && rec.tags && rec.tags.length > 0 && rec.project && String(rec.project).length > 0)
  if (!rec.needsRefine) rec.refineRequested = false
  return rec
}

/**
 * 语义搜索的分批参数（R-4，2026-09-30）。
 *
 * - `SEARCH_YIELD_EVERY`：每扫多少条让出一次事件循环。
 *   2000 条大约几毫秒（实测 10 万条全表 381ms → 单次阻塞 ≈ 8ms），
 *   既不会把宿主卡住，也不至于让出太频繁把总时长拖长。
 * - 让出用 `setImmediate`（**宏任务**）：微任务（`await Promise.resolve()`）**不会**让
 *   I/O 与 HTTP 插进来，用了等于没让 —— 这是很容易写错的一点。
 */
export const SEARCH_YIELD_EVERY = 2000
const searchYield = () => new Promise((resolve) => setImmediate(resolve))

export class ArtifactStore {
  /** @param {string} dataDir 数据目录（默认 ~/.dsh/artifact-library） */
  constructor(dataDir) {
    this.dir = dataDir
    this.file = path.join(dataDir, 'artifacts.json')
    this.metaFile = path.join(dataDir, 'meta.json')
    this.items = []
    this.meta = {
      autoCollect: true,
      cleanupEnabled: true,
      cleanupIntervalDays: 7,
      lastCleanupAt: 0,
      // ── 可配置项（v0.4.0）──
      refineBatchSize: 20,   // 单次精化 prompt 的批量上限
      maxPerTurn: 20,        // 每轮自动采集上限
      backupKeep: 10,        // 备份保留份数
      backupOnCleanup: true, // 整理前自动备份
      importMaxSizeMB: 50,   // 文件夹导入的单文件上限（MB）
      searchLimit: 20,       // 语义搜索默认返回条数
      refineModelLast: '',   // 上次精炼临时选用的模型（仅作弹窗预选，绝不自动应用）
      // 最近一次「项目合并」的完整撤销凭据（null = 没有可撤销的）。
      // 为什么落盘：合并是**批量**改数据，用户点完可能立刻就想退；
      // 只放内存的话重启一下退路就没了 —— 那叫假撤销。
      lastProjectMerge: null,
    }
    this.loaded = false
    /**
     * 分类表的**运行时**来源（2026-10-06，Step 2b）。
     *
     * ⭐ 为什么是注入的函数而不是 import 常量：分类是**用户在设置里改的东西**，
     *   而 `store` 是长生命周期的对象 —— 如果构造时把分类表拷进来，
     *   用户改完设置后这台 store 仍按旧表归类，就是又一处「存进去了但不生效」。
     *   用 `() => settings.get().categories` 每次现取，改动立刻生效、不用重建 store。
     * ⚠️ 没注入时（离线测试 / 老调用方）返回 `[]` ⇒ 归类退化成「一律 other」，
     *   也就是本次改动之前的行为 —— 保证不注入也不会崩、不会猜。
     */
    this.categoriesProvider = null
  }

  /**
   * 注入分类表来源。见 `this.categoriesProvider` 上面那段。
   * @param {null|(() => Array<object>)} fn
   */
  setCategoriesProvider(fn) {
    this.categoriesProvider = typeof fn === 'function' ? fn : null
    return this
  }

  /** 现取分类表；取不到或形状不对一律当空表（退化成全部 other，不猜）。 */
  getCategories() {
    if (!this.categoriesProvider) return []
    try {
      const list = this.categoriesProvider()
      return Array.isArray(list) ? list : []
    } catch { return [] }
  }

  loadMeta() {
    try {
      if (fs.existsSync(this.metaFile)) {
        const m = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'))
        this.meta = { ...this.meta, ...m }
      }
    } catch { /* 用默认值 */ }
    return this.meta
  }

  saveMeta() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 2), 'utf8')
    } catch { /* 忽略写失败 */ }
  }

  /** 设置面板读写（白名单；数值项统一夹取范围） */
  getSettings() {
    return {
      autoCollect: this.meta.autoCollect !== false,
      cleanupEnabled: this.meta.cleanupEnabled !== false,
      cleanupIntervalDays: this.meta.cleanupIntervalDays || 7,
      lastCleanupAt: this.meta.lastCleanupAt || 0,
      refineBatchSize: this.meta.refineBatchSize || 20,
      maxPerTurn: this.meta.maxPerTurn || 20,
      backupKeep: this.meta.backupKeep || 10,
      backupOnCleanup: this.meta.backupOnCleanup !== false,
      importMaxSizeMB: this.meta.importMaxSizeMB || 50,
      searchLimit: this.meta.searchLimit || 20,
      refineModelLast: this.meta.refineModelLast || '',
    }
  }

  /** 把数值设置夹到 [min,max]，非法值回落 fallback */
  static clampInt(value, min, max, fallback) {
    const n = Math.floor(Number(value))
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
  }

  updateSettings(patch) {
    if (patch.autoCollect !== undefined) this.meta.autoCollect = !!patch.autoCollect
    if (patch.cleanupEnabled !== undefined) this.meta.cleanupEnabled = !!patch.cleanupEnabled
    if (patch.cleanupIntervalDays !== undefined) {
      this.meta.cleanupIntervalDays = ArtifactStore.clampInt(patch.cleanupIntervalDays, 1, 365, 7)
    }
    if (patch.refineBatchSize !== undefined) {
      this.meta.refineBatchSize = ArtifactStore.clampInt(patch.refineBatchSize, 1, 200, 20)
    }
    if (patch.maxPerTurn !== undefined) {
      this.meta.maxPerTurn = ArtifactStore.clampInt(patch.maxPerTurn, 1, 500, 20)
    }
    if (patch.backupKeep !== undefined) {
      this.meta.backupKeep = ArtifactStore.clampInt(patch.backupKeep, 1, 100, 10)
    }
    if (patch.backupOnCleanup !== undefined) this.meta.backupOnCleanup = !!patch.backupOnCleanup
    if (patch.importMaxSizeMB !== undefined) {
      this.meta.importMaxSizeMB = ArtifactStore.clampInt(patch.importMaxSizeMB, 1, 2048, 50)
    }
    if (patch.searchLimit !== undefined) {
      this.meta.searchLimit = ArtifactStore.clampInt(patch.searchLimit, 1, 200, 20)
    }
    if (patch.refineModelLast !== undefined) this.meta.refineModelLast = String(patch.refineModelLast || '')
    this.saveMeta()
    return this.getSettings()
  }

  markCleanupDone(ts = Math.floor(Date.now() / 1000)) {
    this.meta.lastCleanupAt = ts
    this.saveMeta()
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true })
    if (fs.existsSync(this.file)) {
      try {
        const raw = fs.readFileSync(this.file, 'utf8')
        this.items = JSON.parse(raw)
        if (!Array.isArray(this.items)) this.items = []
      } catch {
        this.items = []
      }
    }
    this.loadMeta()
    // 回填 + 判定规则迁移：needsRefine 规则升级到 v2（纳入 project）时对全库重算一次，
    // 让历史数据也走新口径（否则 project 为空的旧记录永远被判为「已精化」）
    let backfilled = false
    const ruleV2 = this.meta.needsRefineRule === 2
    for (const r of this.items) {
      if (typeof r.needsRefine !== 'boolean' || !ruleV2) {
        settleRefine(r)   // ★ 与 update()/unrefine() 共用同一份判定（原来这里是第三份拷贝）
        backfilled = true
      }
      if (typeof r.kind !== 'string') r.kind = 'deliverable'
      if (typeof r.source !== 'string') r.source = 'manual'
      if (typeof r.is_dir !== 'boolean') { r.is_dir = false; backfilled = true }
      if (typeof r.refineRequested !== 'boolean') { r.refineRequested = false; backfilled = true }
      // ── 2026-10-02 补：`trashed_at` 与 `tags` ──────────────────────────────
      // ⚠️ 这不是洁癖，是「记录整批隐身」级别的问题：
      //    全库到处用 `r.trashed_at === null` 判「是不是活的」（isActiveRecord / list /
      //    findDuplicateGroups / suggestCleanup / mergeProjects…）。而**缺字段得到的是
      //    `undefined`，`undefined !== null` 为真** —— 于是缺这个字段的历史记录会被
      //    当成「在回收站里」，`list()` 一条都不显示、整理建议看不见、连项目合并也跳过。
      //    手搓一份不含该字段的 artifacts.json 实测：`list()` 可见 0 条。
      //    `tags` 同理：`stats()` 里 `for (const t of r.tags)`，缺字段直接 TypeError。
      //
      // 这条其实本文件早就预警过（见下面 `settleRefine` 那段注释：
      // 「今天是 refineRequested，明天就会有人顺手加 needsRefine、trashed_at」）——
      // 只是当时没人补上。现在补。
      if (r.trashed_at === undefined) { r.trashed_at = null; backfilled = true }
      if (!Array.isArray(r.tags)) { r.tags = []; backfilled = true }
      if (!Array.isArray(r.references)) { r.references = []; backfilled = true }
    }
    if (!ruleV2) {
      this.meta.needsRefineRule = 2
      // 空库不做迁移写盘：否则会在「导入根目录」内凭空造出 meta.json/artifacts.json，被自己扫进库
      if (this.items.length > 0) { this.saveMeta(); backfilled = true }
    }

    // ── 正文索引规则迁移（R-6 (A)，2026-09-30）──────────────────────────────
    // 上限从 5 万降到 8 千 → 对**历史记录**也裁一次，否则体积永远不降
    // （实测真实库 89% 的体积就是这些历史 contentIndex）。
    //
    // 为什么裁它是**安全的**：`contentIndex` 是**派生缓存**（从原文件可再抽取），
    // 不是用户数据；而且**读正文走 artifact_read（直接读磁盘），完全不受影响** ——
    // 裁掉的只是「全文检索能覆盖到多深」。
    // ⚠️ 但**必须留痕**：被裁的记录要标 `contentIndexTruncated`，
    //    界面才能如实说「检索只覆盖了正文前 N 字符」（不能让人以为检索是完整的）。
    let trimmed = 0
    if (this.meta.contentIndexRule !== CONTENT_INDEX_RULE) {
      for (const r of this.items) {
        const ci = typeof r.contentIndex === 'string' ? r.contentIndex : ''
        if (ci.length > MAX_TEXT_INDEX_CHARS) {
          r.contentIndex = ci.slice(0, MAX_TEXT_INDEX_CHARS)
          r.contentIndexChars = MAX_TEXT_INDEX_CHARS
          r.contentIndexTruncated = true
          if (!(r.contentIndexTotalChars > MAX_TEXT_INDEX_CHARS)) r.contentIndexTotalChars = ci.length
          trimmed += 1
        } else if (ci.length > 0) {
          r.contentIndexChars = ci.length
          if (typeof r.contentIndexTruncated !== 'boolean') r.contentIndexTruncated = false
        }
        if (ci.length > 0 && typeof r.contentIndexTruncated !== 'boolean') r.contentIndexTruncated = false
      }
      this.meta.contentIndexRule = CONTENT_INDEX_RULE
      if (this.items.length > 0) { this.saveMeta(); backfilled = true }
    }

    if (backfilled) this.save()
    this.loaded = true
    this.lastTrimmedCount = trimmed
    return this
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  probePath(p) {
    try {
      const st = fs.statSync(p)
      const isDir = st.isDirectory()
      return {
        // 路径存在即算存在（目录也算）——必须与 runCleanup 的判定一致，
        // 否则目录型记录会被整理误报成「文件缺失」，且点多少次整理都消不掉
        exists: true,
        size_bytes: isDir ? 0 : st.size,
        file_modified_at: Math.floor(st.mtimeMs / 1000),
        is_dir: isDir,
      }
    } catch {
      return { exists: false, size_bytes: 0, file_modified_at: null, is_dir: false }
    }
  }

  /**
   * 登记产物。
   * @param {object} data 产物字段
   * @param {{deferSave?:boolean}} [opts] deferSave=true 时先不落盘（批量导入时用，
   *   调用方负责最终 save() 一次，避免逐条全量重写 JSON 的 O(n²) 写盘）
   * @returns {object} 新产物记录
   */
  register({ path: p, title, summary = '', project = '', deliverable = '', artifact_type = '', tags = [], notes = '', status = 'final', stars = 0, kind = 'deliverable', source = 'manual', references = [], session_id = '', agent_id = '' }, { deferSave = false, allowDuplicate = false } = {}) {
    if (typeof p !== 'string' || !p.trim()) throw new Error('path 必填')
    p = path.normalize(p) // 统一分隔符，去重才可靠（C:/ 与 C:\ 视为同一文件）
    // 敏感防护：凭据/密钥/系统目录路径一律拒绝进库（HTTP /file 读取、正文索引的泄露面）
    if (isSensitivePath(p)) {
      throw new Error('「' + path.basename(p) + '」是敏感文件或位于凭据/系统目录，为避免泄露已拒绝登记。')
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 防重复登记（2026-09-30 实测后加的）
    //
    // 实测口径（**只统计用户看得见的有效记录**，别用全量口径吓自己）：
    //   · 全量 233 条 = 有效 191 + 归档 26 + 回收站 16
    //   · 有效记录里**重复组 = 0** —— 那 32 条历史冗余**已经被整理归档**了
    //   · 所以「用户看到一堆重复」这件事**当前不成立**（我第一版用全量口径得出
    //     「13.7% 冗余」，那是把归档也算进去了，口径错了）
    //
    // 那为什么还要防？因为整理是**事后且每周一次**的：
    //   · 新产生的重复会在库里**最长 7 天用户可见**，之后才被 `dedupExactDuplicates()` 归档
    //   · 归档只是 `status='archived'`，记录仍然堆在 artifacts.json 里（233 条里有 42 条是这类历史）
    // 入口防住，既不给用户看冗余，也不再积历史。
    //
    // 语义：命中已有有效记录 → **返回已有记录**（带 `duplicate: true, created: false`），
    //       顺手刷新体积/时间/存在性，但**绝不覆盖用户填过的元数据**（标题/摘要/标签/项目…）。
    //       要强制新建（例如同一文件登记成两种用途）就传 `{ allowDuplicate: true }`。
    //
    // ⚠️ **给调用方的警告（ui-core 踩过一次，已修）**：
    //   `duplicate: true` 时返回的 `id` 是**早就存在的那条记录**的 id，**不是新建的**。
    //   所以**绝不能**把它当成「本次创建的记录」收进「撤销 / 批量回滚」名单 ——
    //   那样用户点一次撤销，就会把自己**早就有的**产物扔进回收站。
    //   判断依据只有一个：`created === false`（或 `duplicate === true`）。
    // ═══════════════════════════════════════════════════════════════════════
    const now = Math.floor(Date.now() / 1000)
    if (!allowDuplicate) {
      const existing = this.byPath(p)
      if (existing) {
        const again = this.probePath(p)
        const changed = existing.size_bytes !== again.size_bytes
          || existing.file_modified_at !== again.file_modified_at
          || existing.exists !== again.exists
        if (changed) {
          existing.size_bytes = again.size_bytes
          existing.file_modified_at = again.file_modified_at
          existing.exists = again.exists
          existing.updated_at = now
          if (!deferSave) this.save()
        }
        return { ...existing, duplicate: true, created: false }
      }
    }

    const filename = path.basename(p)
    const probe = this.probePath(p)
    // ★ 正文抽取：一次调用，正文与「是否截断」一起拿到（R-6 (A)）
    const text = probe.exists && !probe.is_dir
      ? extractLocalText(p, probe.size_bytes)
      : { text: '', truncated: false, totalChars: 0 }
    const rec = {
      id: newId(),
      kind: kind === 'reference' ? 'reference' : 'deliverable',
      // `present` = 模型用官方 present 工具**明确声明**的交付物（最高置信来源，见 lib/autocollect.js）
      source: ['session', 'folder-import', 'manual', 'present'].includes(source) ? source : 'manual',
      needsRefine: !(summary && summary.length > 0 && tags && tags.length > 0 && project && String(project).length > 0),
      refineRequested: false,
      path: p,
      filename,
      extension: path.extname(filename).toLowerCase(),
      size_bytes: probe.size_bytes,
      file_modified_at: probe.file_modified_at,
      exists: probe.exists,
      is_dir: probe.is_dir === true,
      mime_type: mimeFor(filename),
      title: title || filename,
      summary: String(summary || ''),
      project: String(project || ''),
      deliverable: String(deliverable || ''),
      // 分类（Step 2b）：**显式传的优先**，没传才按后缀给默认归类。
      //
      // ⭐ 为什么把「默认归类」放在 store 而不是调用方：三条内部路径
      //   （autocollect 的两处 + 文件夹导入）**从来不传 artifact_type**，
      //   所以它们全都落在兜底值上 —— 实测库里 `other` 那 12 条、以及
      //   「明明有后缀却进 other」的记录基本都是这么来的。
      //   放在 store 里，这三条无人值守的路径自动受益，不用各改一遍。
      //
      // ⚠️ 三条边界（与 `categories.js: inferCategoryFromPath` 的注释同源）：
      //   ① **只影响新登记**，绝不回头改写已有记录 —— 现有 249 条里后缀与 type
      //      的一致率约 89%，按后缀重算会抹掉当初判的**语义**分类
      //      （`md` 133 条里那 3 条 `code` 就是真实语义）。
      //   ② **目录不猜**：`v1.2` 这种目录名会被读成后缀 `2`，所以把 probe 的 is_dir 传进去。
      //   ③ 后缀认不出来 → 回落 `other`，也就是**改动前的行为**。
      artifact_type: (typeof artifact_type === 'string' && artifact_type.trim())
        ? artifact_type.trim()
        : inferCategoryFromPath(p, this.getCategories(), { isDir: probe.is_dir === true, fallback: FALLBACK_CATEGORY_ID }),
      tags: Array.isArray(tags) ? tags.map(String) : [],
      status: status === 'archived' ? 'archived' : 'final',
      stars: Number.isFinite(Number(stars)) ? Math.max(0, Math.min(5, Number(stars))) : 0,
      notes: String(notes || ''),
      references: Array.isArray(references) ? references.filter((x) => typeof x === 'string') : [],
      // ★ 正文索引 + **诚实的截断标志**（R-6 (A)）：界面据此显示「已截断，仅索引前 N 字符」
      contentIndex: text.text,
      contentIndexChars: text.text.length,
      contentIndexTruncated: text.truncated,
      contentIndexTotalChars: text.totalChars,
      agent_id: String(agent_id || ''),
      session_id: String(session_id || ''),
      created_at: now,
      updated_at: now,
      trashed_at: null,
    }
    this.items.push(rec)
    if (!deferSave) this.save()
    return rec
  }

  get(id) {
    return this.items.find((r) => r.id === id) || null
  }

  /** 列出产物（不含回收站，除非 status 参数传 trashed/all） */
  list({ q = '', project = '', artifact_type = '', tag = '', status = '', kind = '', refine = '', sort = 'created_desc', limit = 500 } = {}) {
    let items = this.items
    if (status === 'trashed') items = items.filter((r) => r.trashed_at !== null)
    else if (status === 'all') items = items.filter(() => true)
    else items = items.filter((r) => r.trashed_at === null)

    if (kind === 'deliverable') items = items.filter((r) => r.kind !== 'reference')
    else if (kind === 'reference') items = items.filter((r) => r.kind === 'reference')
    if (refine === '1') items = items.filter((r) => r.needsRefine)
    else if (refine === '0') items = items.filter((r) => !r.needsRefine)

    if (q) {
      const s = q.toLowerCase()
      items = items.filter((r) =>
        (r.title || '').toLowerCase().includes(s) ||
        (r.summary || '').toLowerCase().includes(s) ||
        r.filename.toLowerCase().includes(s) ||
        r.path.toLowerCase().includes(s) ||
        (r.contentIndex || '').toLowerCase().includes(s))
    }
    if (project) items = items.filter((r) => r.project === project)
    if (artifact_type) items = items.filter((r) => r.artifact_type === artifact_type)
    if (tag) items = items.filter((r) => r.tags.includes(tag))

    const order = {
      created_desc: (a, b) => b.created_at - a.created_at,
      created_asc: (a, b) => a.created_at - b.created_at,
      updated_desc: (a, b) => b.updated_at - a.updated_at,
      stars_desc: (a, b) => b.stars - a.stars,
      stars_asc: (a, b) => a.stars - b.stars,
      size_desc: (a, b) => b.size_bytes - a.size_bytes,
      size_asc: (a, b) => a.size_bytes - b.size_bytes,
      name_asc: (a, b) => (a.filename || '').localeCompare(b.filename || ''),
      name_desc: (a, b) => (b.filename || '').localeCompare(a.filename || ''),
    }
    items = [...items].sort(order[sort] || order.created_desc)
    // 待精化视图下：优先精化的排前面（稳定排序）
    if (refine === '1') {
      const requested = items.filter((r) => r.refineRequested)
      const rest = items.filter((r) => !r.refineRequested)
      items = [...requested, ...rest]
    }
    // 性能：列表不带 contentIndex 全文（单条 get() 才有），否则几百条时响应体几十 MB 卡死页面
    return items.slice(0, limit).map((r) => {
      const { contentIndex, ...rest } = r
      return rest
    })
  }

  /** 更新字段（白名单）；tags/notes/stars/status/title 等 */
  update(id, patch) {
    const rec = this.get(id)
    if (!rec) return null
    const allow = ['title', 'summary', 'project', 'deliverable', 'artifact_type', 'notes', 'status']
    for (const k of allow) {
      if (patch[k] !== undefined) rec[k] = patch[k]
    }
    if (patch.tags !== undefined) rec.tags = (Array.isArray(patch.tags) ? patch.tags : String(patch.tags || '').split(',').map((s) => s.trim())).filter(Boolean).map(String)
    if (patch.references !== undefined) {
      // 只保留库内存在且未回收的引用 id（自引用剔除）；不存在的脏引用在此清理
      const raw = (Array.isArray(patch.references) ? patch.references : String(patch.references || '').split(',').map((s) => s.trim())).filter(Boolean).map(String)
      rec.references = raw.filter((x) => {
        if (x === id) return false
        const t = this.get(x)
        return t !== null && t.trashed_at === null
      })
    }
    if (patch.stars !== undefined) rec.stars = Math.max(0, Math.min(5, Number(patch.stars) || 0))
    settleRefine(rec)
    rec.updated_at = Math.floor(Date.now() / 1000)
    this.save()
    return rec
  }

  /**
   * ★ 撤销「⚡优先精化」标记 —— 与 `requestRefine()` 对称（同样接受 ids / project / folder）。
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * 为什么是**具名方法 + 独立端点**，而不是往 `update()` 白名单里塞 `refineRequested`
   * ═══════════════════════════════════════════════════════════════════════════
   * `update()` 的职责是「**用户可编辑的元数据**」（标题/摘要/项目/标签/备注/状态）——
   * 它的白名单是一条**安全边界**（挡住 id/path/contentIndex 被改写）。
   * `refineRequested` / `needsRefine` 是**机器状态**（工作流标记），不是用户的元数据。
   *
   * 把机器状态混进元数据白名单，等于让 `PATCH /:id` 变成**绕过工作流不变量的后门**：
   * 今天是 `refineRequested`，明天就会有人顺手加 `needsRefine`、`trashed_at` ——
   * 而 `trashed_at` 正是 `trash()/restore()` 要维护的东西（回收站语义会被绕过）。
   * 所以状态变更一律走**具名操作**：`trash / restore / requestRefine / unrefine` 同一族。
   *
   * 语义：撤掉的是**「强制标记」**，并让 `needsRefine` 回到**按记录自身内容算出来**的真实值。
   * 所以本来就缺摘要/标签/项目的条目**仍然 `needsRefine = true`**（这是对的），
   * 只是不再霸占待精化列表头部（⚡ 没了）。返回值把这两者分开报，别让调用方猜。
   */
  unrefine({ ids = [], project = '', folder = false } = {}) {
    const active = this.items.filter((r) => r.trashed_at === null)
    let targets = []
    if (Array.isArray(ids) && ids.length) targets = active.filter((r) => ids.includes(r.id))
    else if (project) targets = active.filter((r) => r.project === project)
    else if (folder) targets = active.filter((r) => r.source === 'folder-import')
    const now = Math.floor(Date.now() / 1000)
    let unmarked = 0
    for (const r of targets) {
      if (r.refineRequested) unmarked += 1
      r.refineRequested = false
      settleRefine(r)   // 同一份结算逻辑，别在这里再写一遍
      r.updated_at = now
    }
    if (targets.length) this.save()
    // `unmarked` = 真的摘掉了 ⚡ 的有几条；`stillNeedsRefine` = 撤了标记但仍该精化的有几条
    // （两者都为 0 且 targeted>0 = 这些条目本来就已精化、也没被标记，撤销是空操作）
    return { targeted: targets.length, unmarked, stillNeedsRefine: targets.filter((r) => r.needsRefine).length }
  }

  /** 从其他记录的 references 中移除某 id（保持引用一致性：被删/被回收的不再被引用） */
  removeRefsFromOthers(id) {
    let changed = false
    for (const r of this.items) {
      if (r.id === id) continue
      if (Array.isArray(r.references) && r.references.includes(id)) {
        r.references = r.references.filter((x) => x !== id)
        changed = true
      }
    }
    if (changed) this.save()
    return changed
  }

  trash(id) {
    const rec = this.get(id)
    if (!rec) return null
    rec.trashed_at = Math.floor(Date.now() / 1000)
    rec.updated_at = rec.trashed_at
    this.removeRefsFromOthers(id) // 回收后其他记录不再引用它
    this.save()
    return rec
  }

  restore(id) {
    const rec = this.get(id)
    if (!rec) return null
    rec.trashed_at = null
    rec.updated_at = Math.floor(Date.now() / 1000)
    this.save()
    return rec
  }

  /** 永久删除（仅回收站内允许） */
  hardDelete(id) {
    const idx = this.items.findIndex((r) => r.id === id)
    if (idx < 0) return false
    if (this.items[idx].trashed_at === null) throw new Error('仅回收站内的产物可永久删除')
    this.items.splice(idx, 1)
    this.removeRefsFromOthers(id)
    this.save()
    return true
  }

  /** 按路径查找未删除的记录（去重用；分隔符统一后匹配） */
  byPath(p) {
    const norm = path.normalize(p)
    return this.items.find((r) => r.path === norm && r.trashed_at === null) || null
  }

  /**
   * 递归扫描文件夹，把文件作为资料导入（kind=reference，source=folder-import）。
   * 全部本地完成，绝不上传；project 缺省用目录名。
   *
   * v0.3.1 防卡死加固：
   * - **异步遍历**（fs.promises + 分批）：不阻塞 Node 事件循环，大目录不再卡住 dsh web
   * - **智能跳过**：node_modules/.git/缓存目录/浏览器 profile/组件缓存 等噪音目录不进库
   * - **超大文件跳过**：默认 >50MB 不登记（避免把录屏缓存/安装包等二进制垃圾扫进来）
   * - **敏感文件跳过**（v0.3.2）：凭据/密钥/证书/env 等绝不进库，防止 API key 泄露进正文索引
   * - **敏感目录保护**（v0.3.2）：导入目标本身是凭据/配置目录（如 .ssh/.dsh/AppData）时直接拒绝
   * @returns {Promise<{count:number, project:string, skipped:number}>}
   */
  async importFolder(dirPath, { project = '', maxFiles = 10000, maxSizeBytes, maxBytes } = {}) {
    if (typeof dirPath !== 'string' || !dirPath.trim()) throw new Error('目录路径必填')
    // 敏感目录保护**必须先于存在性检查**：否则敏感根一旦"路径不存在"，
    // 就会被当成普通错误放过去（2026-10-01 在 Linux 上正是这么暴露的）。
    //
    // ⚠️ 要对**原始输入**和**解析后的路径**各判一次：POSIX 上
    //    `path.resolve('C:\\Windows')` 会把它变成 `<cwd>/C:\Windows`，
    //    盘符形态当场丢失 → 只判解析结果的话，Windows 形态的敏感根会漏掉。
    const rawVerdict = checkImportRoot(dirPath)
    if (!rawVerdict.ok) throw new Error(rawVerdict.message)
    const root = path.resolve(dirPath)
    const resolvedVerdict = checkImportRoot(root)
    if (!resolvedVerdict.ok) throw new Error(resolvedVerdict.message)
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('目录不存在或不是文件夹')
    const proj = project || path.basename(root)
    // 库自身的数据目录：仅当它位于导入根内部时才排除
    // （否则会把自己的 artifacts.json/meta.json 当成资料扫进库；而导入根若本就在数据目录内，则不能排）
    const selfDir = path.resolve(this.dir)
    const selfInsideRoot = selfDir === root || selfDir.startsWith(root + path.sep)
    // 单文件大小上限：设置面板可调（importMaxSizeMB），默认 50MB
    const sizeLimit = maxSizeBytes ?? (this.meta.importMaxSizeMB || 50) * 1024 * 1024

    // 噪音目录：递归时不进入（浏览器缓存/依赖/版本库/临时目录）
    const SKIP_DIRS = new Set([
      'node_modules', '.git', '.hg', '.svn', '__pycache__', '.cache', 'cache',
      'backups', 'temp', 'tmp', '.tmp', 'logs', '.logs', 'dist', 'build', '.next',
      'Default', 'component_crx_cache', 'GrShaderCache', 'ShaderCache', 'GPUCache',
      'Code Cache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache',
      'Local Storage', 'Session Storage', 'IndexedDB', 'Service Worker',
      'Sync Data', 'File System', 'Blob Storage', 'databases', 'Crashpad', 'Dictionaries',
    ])
    // 噪音文件名：直接跳过（常见临时/锁文件）
    const SKIP_FILES = new Set(['desktop.ini', 'Thumbs.db', '.DS_Store', 'favicon.ico'])

    let count = 0
    let skipped = 0
    let scanned = 0
    // ── (D) 总字节预算（R-6，2026-09-30）──────────────────────────────────
    // 为什么不能只限「文件数」：体积才是 `save()` 同步阻塞的驱动量
    // （实测同一 600 个文件：正文 10 字节 → 0.5MB/16ms；正文 50KB → 29MB/73ms）。
    // 10 万个**小**文件和大文件一样能各占 5 万字符索引，所以按文件数限不住体积。
    let usedBytes = 0
    let stoppedBy = ''   // 'max-files' | 'byte-budget' | ''
    const budget = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_IMPORT_MAX_BYTES
    const walk = async (dir) => {
      let entries = []
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (count >= maxFiles) { stoppedBy = stoppedBy || 'max-files'; return }
        if (usedBytes >= budget) { stoppedBy = stoppedBy || 'byte-budget'; return }
        const full = path.join(dir, e.name)
        try {
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) { skipped++; continue }
            if (selfInsideRoot) {
              const resolved = path.resolve(full)
              if (resolved === selfDir || resolved.startsWith(selfDir + path.sep)) { skipped++; continue } // 库自身数据目录
            }
            await walk(full)
          } else if (e.isFile()) {
            if (SKIP_FILES.has(e.name)) { skipped++; continue }
            if (isSensitivePath(full)) { skipped++; continue } // 凭据/密钥绝不进库
            if (this.byPath(full)) { skipped++; continue }
            // 超大文件跳过（避免二进制垃圾）
            let st
            try { st = await fs.promises.stat(full) } catch { skipped++; continue }
            if (st.size > sizeLimit) { skipped++; continue }
            // ★ 字节预算：**在登记之前**判断，避免"最后一条超了却已经写进去"
            if (usedBytes + st.size > budget) { stoppedBy = stoppedBy || 'byte-budget'; return }
            scanned++
            usedBytes += st.size
            // 目录名当项目：直接父目录名作为子项目线索，追加为标签
            const parentDir = path.basename(path.dirname(full))
            const tags = parentDir && parentDir !== proj ? [parentDir] : []
            // deferSave：整批导入最后一次性落盘，避免逐条全量重写 JSON
            this.register({ path: full, project: proj, kind: 'reference', source: 'folder-import', tags }, { deferSave: true })
            count++
            // 每 200 条让出一次事件循环（防长目录阻塞）
            if (count % 200 === 0) await new Promise((r) => setImmediate(r))
          }
        } catch { skipped++ }
      }
    }
    await walk(root)
    if (count > 0) this.save() // 批量一次性落盘
    // ★ 如实回报「为什么停」——调用方（面板/agent）要能说清"还有没导完的东西"
    return {
      count, project: proj, skipped, scanned,
      usedBytes,
      budgetBytes: budget,
      stopped: stoppedBy !== '',
      stoppedBy: stoppedBy || null,
      // 人话，直接可显示
      note: stoppedBy === 'byte-budget'
        ? `已达体积预算（${Math.round(budget / 1024 / 1024)}MB），提前停止。还有文件未导入 —— 可以分批选更小的子文件夹继续。`
        : (stoppedBy === 'max-files'
          ? `已达单次导入的文件数上限（${maxFiles}），提前停止。还有文件未导入。`
          : ''),
    }
  }

  /** 导出整库为 JSON 快照（本地，供备份） */
  exportData() {
    return { exported_at: Math.floor(Date.now() / 1000), count: this.items.length, items: JSON.parse(JSON.stringify(this.items)) }
  }

  /** 项目概览：某项目（或全部）的产出与资料摘要 */
  overview(project = '') {
    const active = this.items.filter((r) => r.trashed_at === null && (!project || r.project === project))
    const deliverables = active.filter((r) => r.kind !== 'reference')
    const references = active.filter((r) => r.kind === 'reference')
    const summarize = (list) => list.map((r) => ({
      id: r.id, title: r.title, type: r.artifact_type, stars: r.stars,
      summary: r.summary || '(无摘要)', path: r.path,
    }))
    return {
      project: project || '(全部)',
      deliverableCount: deliverables.length,
      referenceCount: references.length,
      deliverables: summarize(deliverables).slice(0, 200),
      references: summarize(references).slice(0, 200),
    }
  }

  /**
   * 统一判重（整理与建议单共用，保证两边口径一致）：
   * 按规范化路径分组，只统计有效记录（未回收、未归档），组内按 created_at 降序。
   * 归档记录不再参与，所以去重结果会真正收敛——归档过的重复不会下次再被报出来。
   * @returns {Array<{path:string, keep:object, dups:object[]}>}
   */
  findDuplicateGroups() {
    const byPath = new Map()
    // created_at 是秒级精度：同一秒内登记的多条会并列，故用登记顺序（后进者更新）作次级排序，
    // 保证「保留最新」在并列时也确定，去重结果可复现
    const sorted = this.items
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => isActiveRecord(r))
      .sort((a, b) => b.r.created_at - a.r.created_at || b.i - a.i)
      .map(({ r }) => r)
    for (const r of sorted) {
      if (!byPath.has(r.path)) byPath.set(r.path, [])
      byPath.get(r.path).push(r)
    }
    const groups = []
    for (const [p, list] of byPath) {
      if (list.length > 1) groups.push({ path: p, keep: list[0], dups: list.slice(1) })
    }
    return groups
  }

  /** 去重：同路径的多条有效记录，仅保留最新（final），其余归档 */
  dedupExactDuplicates() {
    const now = Math.floor(Date.now() / 1000)
    let deduped = 0
    for (const g of this.findDuplicateGroups()) {
      for (const r of g.dups) {
        r.status = 'archived'
        r.updated_at = now
        deduped++
      }
    }
    if (deduped > 0) this.save()
    return { deduped }
  }

  /** 用户主动请求精化：ids（单个/多个）/ project（整个项目）/ folder（文件夹导入的全部） */
  requestRefine({ ids = [], project = '', folder = false } = {}) {
    const active = this.items.filter((r) => r.trashed_at === null)
    let targets = []
    if (Array.isArray(ids) && ids.length) targets = active.filter((r) => ids.includes(r.id))
    else if (project) targets = active.filter((r) => r.project === project)
    else if (folder) targets = active.filter((r) => r.source === 'folder-import')
    const now = Math.floor(Date.now() / 1000)
    for (const r of targets) {
      r.refineRequested = true
      r.needsRefine = true
      r.updated_at = now
    }
    if (targets.length) this.save()
    return { marked: targets.length }
  }

  /**
   * 语义搜索：把自然语言描述拆成词元，按字段权重打分召回。
   * 权重：标题 > 标签 > 摘要 > 文件名 > 路径 > 正文。
   * @param {string} query 自然语言描述（如「上次那个视频素材」）
   * @param {{kind?:string, project?:string, limit?:number}} opts
   * @returns {Array<{id:string, title:string, kind:string, project:string, score:number, matched:string[]}>}
   */
  async searchSemantic(query, { kind = '', project = '', limit = 20, yieldEvery = SEARCH_YIELD_EVERY } = {}) {
    const s = String(query || '').trim().toLowerCase()
    if (!s) return []
    const tokens = [...new Set(s.split(/[\s,，。、;；:：!！?？'"“”‘’()[\]{}<>/\\|_\-+=*#@$%^&~`]+/).filter((t) => t.length > 0))]
    // 中文按 2-gram 补充（无空格中文短语也能命中）
    //
    // ⚠️ 2026-09-30 修：原来这里的正则是 `[^\u4e00-\u9fa5a-z0-9]` —— 它**保留 a-z0-9**，
    //    于是**每个长英文单词也会被切成 2-gram**（`token` → `to/ok/ke/en`），
    //    而 `to` 这种碎片会命中**几乎每条记录路径里都有的** "Administra**to**r"：
    //      实测 `q=q7z9x5-no-such-token` → 命中 1 条、`matched:["to"]`、score=2
    //    → 表现就是「**随便搜什么都有一堆 score=2 的噪声命中**」。
    //    上面那句注释写的是「**中文**按 2-gram」—— 意图是对的，实现把它扩大了。
    //    现在按意图收窄成**只对中文**做 2-gram（英文词仍由 tokens 走完整词匹配）。
    const grams = []
    const cjk = s.replace(/[^\u4e00-\u9fa5]/g, '')
    for (let i = 0; i < cjk.length - 1; i++) grams.push(cjk.slice(i, i + 2))
    const allTerms = [...tokens, ...grams]
    if (!allTerms.length) return []

    const WEIGHTS = { title: 10, tags: 8, summary: 5, filename: 4, path: 2, content: 1 }
    const active = this.items.filter((r) => r.trashed_at === null)
    const results = []
    let scanned = 0
    for (const r of active) {
      // ★ R-4：**分批让出事件循环**。
      //   为什么必须做：这是**全表扫描**（每条都要过全部词元 × 6 个字段的 indexOf），
      //   实测 10 万条一次要 **381ms** —— 那是**同步**跑完的，期间宿主什么都干不了：
      //   其它 HTTP 请求排队、缩略图不出、索引探测超时。用户那边（客户端已有 12 秒超时）
      //   看到的就是「加载超时」。
      //   每 2000 条让一次，单次阻塞从"几百毫秒"降到"几毫秒"，而**结果与同步版逐字节一致**
      //   （评分口径、排序、切片一行没动 —— 这点很重要，不能让"修性能"顺手改了搜索质量）。
      if (scanned > 0 && scanned % yieldEvery === 0) await searchYield()
      scanned += 1
      if (kind && (kind === 'reference') !== (r.kind === 'reference')) continue
      if (project && r.project !== project) continue
      const hay = {
        title: (r.title || '').toLowerCase(),
        tags: (r.tags || []).join(' ').toLowerCase(),
        summary: (r.summary || '').toLowerCase(),
        filename: (r.filename || '').toLowerCase(),
        path: (r.path || '').toLowerCase(),
        content: (r.contentIndex || '').toLowerCase(),
      }
      let score = 0
      const matched = []
      for (const term of allTerms) {
        if (term.length < 2 && !/[a-z0-9]/.test(term)) continue // 单字中文词元噪音大，跳过
        for (const [field, text] of Object.entries(hay)) {
          let idx = text.indexOf(term)
          while (idx !== -1) {
            score += WEIGHTS[field]
            if (!matched.includes(term)) matched.push(term)
            idx = text.indexOf(term, idx + 1)
          }
        }
      }
      if (score > 0) {
        results.push({
          id: r.id, title: r.title, kind: r.kind, project: r.project || '(未分类)',
          artifact_type: r.artifact_type, stars: r.stars, summary: r.summary || '',
          filename: r.filename, path: r.path, needsRefine: r.needsRefine,
          score, matched: matched.slice(0, 8),
          // ★ 诚实：这条的正文只索引了一部分 → 调用方要能告诉用户
          //   「这条命中的是前 N 字符里的内容，正文更长」（否则用户以为检索是完整的）
          contentIndexTruncated: r.contentIndexTruncated === true,
          contentIndexChars: r.contentIndexChars || 0,
          contentIndexTotalChars: r.contentIndexTotalChars || 0,
        })
      }
    }
    results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    return results.slice(0, limit)
  }

  /**
   * 连线建议：给定产物，找出可能相关的产出/资料（C1）。
   * 依据：同项目 +20，共享标签 +12/个，同目录 +8，类型相同 +5，标题相似 +10，摘要相似 +6。
   * @param {string} id 产物 ID
   * @param {{limit?:number}} opts
   * @returns {Array<{id:string, title:string, kind:string, project:string, reason:string, score:number}>}
   */
  suggestLinks(id, { limit = 8 } = {}) {
    const rec = this.get(id)
    if (!rec) return []
    const active = this.items.filter((r) => r.trashed_at === null && r.id !== id)
    const recTags = new Set(rec.tags || [])
    const recDir = path.dirname(rec.path || '')
    const recTitle = (rec.title || '').toLowerCase()
    const recSummary = (rec.summary || '').toLowerCase()
    const results = []
    for (const r of active) {
      let score = 0
      const reasons = []
      if (r.project && r.project === rec.project) { score += 20; reasons.push('同项目') }
      const sharedTags = (r.tags || []).filter((t) => recTags.has(t))
      if (sharedTags.length) { score += 12 * sharedTags.length; reasons.push(`同标签:${sharedTags.slice(0, 3).join(',')}`) }
      if (r.path && recDir && path.dirname(r.path) === recDir) { score += 8; reasons.push('同目录') }
      if (r.artifact_type && r.artifact_type === rec.artifact_type) { score += 5; reasons.push('同类型') }
      const t = (r.title || '').toLowerCase()
      if (t && recTitle && (t.includes(recTitle) || recTitle.includes(t))) { score += 10; reasons.push('标题相似') }
      const s = (r.summary || '').toLowerCase()
      if (s && recSummary) {
        const common = [...new Set(recSummary.split(/\s+/).filter((w) => w.length > 1 && s.includes(w)))]
        if (common.length >= 2) { score += 6; reasons.push('摘要相关') }
      }
      if (score > 0) {
        results.push({
          id: r.id, title: r.title, kind: r.kind, project: r.project || '(未分类)',
          artifact_type: r.artifact_type, score, reason: reasons.join('，'),
        })
      }
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  /**
   * 整理建议单（C2）：基于当前库状态，给出可执行建议。
   * @returns {{duplicates:Array, missing:Array, unrefinedCount:number, staleProjects:Array,
   *   suggestRefine:Array, projectMerges:Array, projectsScanned:number, projectMergeUndo:object|null}}
   */
  suggestCleanup() {
    // 同路径重复（统一判重：只统计有效记录，保留最新）
    const duplicates = this.findDuplicateGroups().map((g) => ({
      path: g.path, keepId: g.keep.id, keepTitle: g.keep.title,
      dupIds: g.dups.map((r) => r.id),
      dupTitles: g.dups.map((r) => r.title),
    }))
    const active = this.items.filter(isActiveRecord)
    // 文件丢失
    const missing = active.filter((r) => r.exists === false).map((r) => ({
      id: r.id, title: r.title, path: r.path, kind: r.kind,
    }))
    // 僵尸项目：库里有 ≥3 条记录、但已无任何有效记录（全被归档/回收）的项目（仅提示，不自动动）
    const projActive = {}
    const projAll = {}
    for (const r of this.items) {
      if (r.trashed_at !== null) continue
      const p = r.project || '(未分类)'
      projAll[p] = (projAll[p] || 0) + 1
      if (isActiveRecord(r)) projActive[p] = (projActive[p] || 0) + 1
    }
    const staleProjects = Object.entries(projAll)
      .filter(([p, total]) => total >= 3 && (projActive[p] || 0) === 0)
      .map(([project, count]) => ({ project, count }))
    // 建议精化：缺摘要/标签/项目归属的
    const unrefined = active.filter((r) => r.needsRefine)
    // ── 项目合并建议（2026-10-02）───────────────────────────────────────────
    // 同一个项目的不同产出被记成好多个项目名（实测真实数据：242 条 / 58 个项目名，
    // 其中「卫龙榴莲辣条」一族就占了 9 个名字）。
    //
    // ⚠️ 这里**只出候选、绝不自动合并**：规则放宽一档就会把
    //    `dsh-artifact-library` / `dsh-lan-connect` / `dsh-browser` 这种
    //    「共享前缀但是不同项目」合掉（这条反例在 lib/project-merge.js 里记着，
    //    也是那三道前缀闸门的由来）。拍板权留给人和面板。
    const mergeScan = findMergeGroups(projAll)
    const lastMerge = this.meta.lastProjectMerge
    return {
      duplicates,
      missing,
      unrefinedCount: unrefined.length,
      suggestRefine: unrefined.slice(0, 20).map((r) => ({ id: r.id, title: r.title, kind: r.kind })),
      staleProjects,
      // 合并候选（按置信度从稳到松排序，见 findMergeGroups）
      projectMerges: mergeScan.groups,
      // 扫了多少个项目名 —— 面板可以说「58 个项目名里发现 4 组可合并」
      projectsScanned: mergeScan.scanned,
      // 最近一次合并的撤销入口（null = 没有可撤销的）
      projectMergeUndo: lastMerge && Array.isArray(lastMerge.changed)
        ? { to: lastMerge.to, at: lastMerge.at, count: lastMerge.changed.length, from: (lastMerge.from || []).slice() }
        : null,
    }
  }

  /**
   * 执行一次「项目合并」：把 `names` 里那些项目名下的记录，统一改挂到 `to`。
   *
   * ── 为什么原名要转成 tag（依琪 2026-10-02 拍的）──────────────────────────
   * `卫龙榴莲辣条营销创意` 合进 `卫龙榴莲辣条` 之后，「营销创意」这层信息不能丢 ——
   * 它是**作品类型**，本来就该是一个可筛选的维度。所以把它写进 `tags`：
   * 项目列表干净了，而「只看营销创意那几条」依然做得到。
   *
   * ── 为什么一定要留撤销凭据 ──────────────────────────────────────────────
   * 这是一次**批量改写**（可能一次动 18 条）。不能撤销的批量操作没人敢点。
   * 撤销快照写进 meta 落盘（重启也在），只保留最近一次 —— 与「撤销上一步」的直觉一致。
   *
   * @param {{names: string[], to: string, keepVariantAsTag?: boolean}} opts
   * @returns {{ok:boolean, error?:string, to?:string, from?:string[], changed?:number, tagsAdded?:number}}
   */
  mergeProjects({ names, to, keepVariantAsTag = true } = {}) {
    const list = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean)
    const target = String(to || '').trim()
    if (!target) return { ok: false, error: '缺少要合并到的项目名（to）' }
    if (!list.length) return { ok: false, error: '缺少要合并掉的项目名（names）' }
    const from = list.filter((n) => n !== target)
    if (!from.length) return { ok: false, error: '待合并的名字和目标名相同，没有可改的记录' }

    const fromSet = new Set(from)
    const changed = []
    let tagsAdded = 0
    for (const rec of this.items) {
      if (rec.trashed_at !== null) continue
      if (!fromSet.has(rec.project)) continue
      const beforeProject = rec.project
      const beforeTags = Array.isArray(rec.tags) ? rec.tags.slice() : []
      rec.project = target
      if (keepVariantAsTag && beforeProject && beforeProject !== target && !beforeTags.includes(beforeProject)) {
        rec.tags = beforeTags.concat([beforeProject])
        tagsAdded += 1
      }
      changed.push({ id: rec.id, project: beforeProject, tags: beforeTags })
    }
    if (!changed.length) {
      return { ok: false, error: '没有任何记录的 project 命中这次合并（名字是不是打错了？）' }
    }

    this.meta.lastProjectMerge = {
      at: Date.now(),
      to: target,
      from,
      keepVariantAsTag,
      changed,
    }
    this.save()
    this.saveMeta()
    return { ok: true, to: target, from, changed: changed.length, tagsAdded }
  }

  /**
   * 撤销**最近一次**项目合并。
   *
   * ⚠️ 语义如实说明：它把每条记录的 `project` 与 `tags` **整份还原**到合并前的样子。
   * 如果合并之后你又手动改了这些记录的标签，那些改动会被一起回退 ——
   * 这是「撤销」应有的语义（回到那个时刻），不是 bug。所以撤销入口只在
   * 「刚合完」这个窗口里有意义，面板上也会写明合并了哪几个名字。
   *
   * @returns {{ok:boolean, error?:string, restored?:number, to?:string}}
   */
  undoProjectMerge() {
    const last = this.meta.lastProjectMerge
    if (!last || !Array.isArray(last.changed) || !last.changed.length) {
      return { ok: false, error: '没有可撤销的项目合并' }
    }
    const byId = new Map(this.items.map((r) => [r.id, r]))
    let restored = 0
    for (const snapshot of last.changed) {
      const rec = byId.get(snapshot.id)
      if (!rec) continue // 记录已被删除（回收站/硬删）→ 跳过，不影响其余
      rec.project = snapshot.project
      rec.tags = Array.isArray(snapshot.tags) ? snapshot.tags.slice() : []
      restored += 1
    }
    const to = last.to
    this.meta.lastProjectMerge = null
    this.save()
    this.saveMeta()
    return { ok: true, restored, to }
  }

  stats() {
    const live = this.items.filter((r) => r.trashed_at === null)
    const active = live.filter((r) => r.status !== 'archived')
    const archived = live.length - active.length
    const trashed = this.items.filter((r) => r.trashed_at !== null).length
    const byProject = {}
    const byType = {}
    const byTag = {}
    for (const r of active) {
      byProject[r.project || '(未分类)'] = (byProject[r.project || '(未分类)'] || 0) + 1
      byType[r.artifact_type || 'other'] = (byType[r.artifact_type || 'other'] || 0) + 1
      for (const t of r.tags) byTag[t] = (byTag[t] || 0) + 1
    }
    return {
      total: live.length,         // 未回收总数（含归档，保持既有语义）
      activeCount: active.length, // 有效数（不含归档）——整理后这个数字才会下降
      archived,
      trashed,
      pendingRefine: active.filter((r) => r.needsRefine).length,
      missingFiles: active.filter((r) => r.exists === false).length,
      byProject,
      byType,
      byTag,
    }
  }

  categories() {
    const live = this.items.filter((r) => r.trashed_at === null)
    const projects = [...new Set(live.map((r) => r.project).filter(Boolean))].sort()
    const types = [...new Set(live.map((r) => r.artifact_type).filter(Boolean))].sort()
    const tags = [...new Set(this.items.flatMap((r) => (r.trashed_at === null ? r.tags : [])))].sort()
    // ── 分类（Step 2b）────────────────────────────────────────────────────
    // `types` 是**库里实际出现过的** artifact_type 值（自由字符串，可能含孤儿），
    // `categories` 才是**用户在设置里定义的**分类表 —— 两者不是一回事：
    //   · types  = 事实（记录指向了什么）
    //   · categories = 定义（用户想要哪些分类、叫什么、什么图标、认哪些后缀）
    // 面板的筛选要按 `buckets` 渲染（顺序 = 用户排的顺序、含 0 条的空分类），
    // 而 `orphans` 是「记录指向了表里不存在的分类」——**必须报出来**，
    // 否则用户删掉一个分类后就再也看不出自己弄丢了什么。
    const table = this.getCategories()
    const grouped = groupByCategory(live, table)
    return { projects, types, tags, categories: table, buckets: grouped.buckets, orphans: grouped.orphans }
  }
}
