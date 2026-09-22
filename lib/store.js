/**
 * dsh-artifact-library — 产物存储（JSON 文件，原子写入）
 * 数据模型为通用产物 schema（产出/资料），从零开始。
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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

/** 可抽取正文的文本类扩展名（本地全文索引用，绝不上传） */
const TEXTISH_EXT = new Set(['txt', 'md', 'markdown', 'json', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'yml', 'yaml', 'csv', 'xml', 'toml', 'ini', 'conf', 'log', 'sh', 'bat', 'ps1', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'rb', 'php', 'sql', 'vue', 'svelte'])

// ── 敏感路径防护（v0.3.1 安全加固）──────────────────────────────
// 凭据/密钥/证书/env 等文件绝不允许进库（防止 API key 泄露进全文索引与 /file 读取）；
// 凭据存放目录（.ssh/.gnupg/.aws 等）下的任何文件同样拒绝。
// 注意：~/.dsh 本身不整体拒绝——自动采集会合法登记 .dsh 下的产物（如技能文档），
// 但 .dsh 下的凭据文件名（credentials.json 等）仍会被文件名正则拦截。
const SENSITIVE_FILE_RE = /(^|[._-])(credentials?|creds|secret|token|apikey|api[_-]?key|passwd|password|auth|\.env|\.pem|\.key|\.p12|\.pfx|id_rsa|id_ed25519|\.npmrc|\.netrc|\.git-credentials)([._-]|$)/i
// 任意路径段出现即拒绝：凭据/令牌存放目录（Windows AppData 是用户配置大区，合法产物也存在，
// 不整体拒绝——其中的敏感文件由上面的文件名正则兜底）
const PROTECTED_DIR_NAMES = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.npmrc'])
// 导入根目录直接拒绝：凭据目录 + 系统/用户配置大区 + .dsh 主目录
const PROTECTED_ROOT_NAMES = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.npmrc', 'appdata', 'windows', 'system32', '.dsh'])

/** 敏感路径判定：文件名是凭据/密钥类，或路径中任意目录段是凭据存放目录 → 拒绝进库 */
export function isSensitivePath(p) {
  if (typeof p !== 'string' || !p) return false
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  if (!parts.length) return false
  if (SENSITIVE_FILE_RE.test(parts[parts.length - 1])) return true
  return parts.some((seg) => PROTECTED_DIR_NAMES.has(seg.toLowerCase()))
}
const MAX_TEXT_INDEX_BYTES = 2_000_000 // 只索引 ≤2MB 的文本
const MAX_TEXT_INDEX_CHARS = 50_000   // 每文件最多存 5 万字符正文

/** 抽取本地文件正文用于全文索引（本地读取，失败/二进制/过大则返回空串） */
function extractLocalText(p, sizeBytes) {
  const ext = path.extname(p).toLowerCase().replace('.', '')
  if (!TEXTISH_EXT.has(ext)) return ''
  if (sizeBytes > MAX_TEXT_INDEX_BYTES) return ''
  try {
    const buf = fs.readFileSync(p)
    if (buf.includes(0)) return '' // 含空字节视为二进制，不索引
    const s = buf.toString('utf8').replace(/\r\n/g, '\n')
    return s.slice(0, MAX_TEXT_INDEX_CHARS)
  } catch {
    return ''
  }
}

export class ArtifactStore {
  /** @param {string} dataDir 数据目录（默认 ~/.dsh/artifact-library） */
  constructor(dataDir) {
    this.dir = dataDir
    this.file = path.join(dataDir, 'artifacts.json')
    this.metaFile = path.join(dataDir, 'meta.json')
    this.items = []
    this.meta = { autoCollect: true, cleanupEnabled: true, cleanupIntervalDays: 7, lastCleanupAt: 0 }
    this.loaded = false
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

  /** 设置面板读写（白名单） */
  getSettings() {
    return {
      autoCollect: this.meta.autoCollect !== false,
      cleanupEnabled: this.meta.cleanupEnabled !== false,
      cleanupIntervalDays: this.meta.cleanupIntervalDays || 7,
      lastCleanupAt: this.meta.lastCleanupAt || 0,
    }
  }

  updateSettings(patch) {
    if (patch.autoCollect !== undefined) this.meta.autoCollect = !!patch.autoCollect
    if (patch.cleanupEnabled !== undefined) this.meta.cleanupEnabled = !!patch.cleanupEnabled
    if (patch.cleanupIntervalDays !== undefined) {
      const d = Math.max(1, Math.min(365, Number(patch.cleanupIntervalDays) || 7))
      this.meta.cleanupIntervalDays = d
    }
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
        r.needsRefine = !(r.summary && r.summary.length > 0 && r.tags && r.tags.length > 0 && r.project && String(r.project).length > 0)
        if (!r.needsRefine) r.refineRequested = false
        backfilled = true
      }
      if (typeof r.kind !== 'string') r.kind = 'deliverable'
      if (typeof r.source !== 'string') r.source = 'manual'
      if (typeof r.refineRequested !== 'boolean') { r.refineRequested = false; backfilled = true }
    }
    if (!ruleV2) {
      this.meta.needsRefineRule = 2
      // 空库不做迁移写盘：否则会在「导入根目录」内凭空造出 meta.json/artifacts.json，被自己扫进库
      if (this.items.length > 0) { this.saveMeta(); backfilled = true }
    }
    if (backfilled) this.save()
    this.loaded = true
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
      return { exists: true, size_bytes: st.size, file_modified_at: Math.floor(st.mtimeMs / 1000) }
    } catch {
      return { exists: false, size_bytes: 0, file_modified_at: null }
    }
  }

  /**
   * 登记产物。
   * @param {object} data 产物字段
   * @param {{deferSave?:boolean}} [opts] deferSave=true 时先不落盘（批量导入时用，
   *   调用方负责最终 save() 一次，避免逐条全量重写 JSON 的 O(n²) 写盘）
   * @returns {object} 新产物记录
   */
  register({ path: p, title, summary = '', project = '', deliverable = '', artifact_type = 'other', tags = [], notes = '', status = 'final', stars = 0, kind = 'deliverable', source = 'manual', references = [], session_id = '', agent_id = '' }, { deferSave = false } = {}) {
    if (typeof p !== 'string' || !p.trim()) throw new Error('path 必填')
    p = path.normalize(p) // 统一分隔符，去重才可靠（C:/ 与 C:\ 视为同一文件）
    // 敏感防护：凭据/密钥/系统目录路径一律拒绝进库（HTTP /file 读取、全文索引的泄露面）
    if (isSensitivePath(p)) {
      throw new Error('「' + path.basename(p) + '」是敏感文件或位于凭据/系统目录，为避免泄露已拒绝登记。')
    }
    const filename = path.basename(p)
    const probe = this.probePath(p)
    const now = Math.floor(Date.now() / 1000)
    const rec = {
      id: newId(),
      kind: kind === 'reference' ? 'reference' : 'deliverable',
      source: ['session', 'folder-import', 'manual'].includes(source) ? source : 'manual',
      needsRefine: !(summary && summary.length > 0 && tags && tags.length > 0 && project && String(project).length > 0),
      refineRequested: false,
      path: p,
      filename,
      extension: path.extname(filename).toLowerCase(),
      size_bytes: probe.size_bytes,
      file_modified_at: probe.file_modified_at,
      exists: probe.exists,
      mime_type: mimeFor(filename),
      title: title || filename,
      summary: String(summary || ''),
      project: String(project || ''),
      deliverable: String(deliverable || ''),
      artifact_type: artifact_type || 'other',
      tags: Array.isArray(tags) ? tags.map(String) : [],
      status: status === 'archived' ? 'archived' : 'final',
      stars: Number.isFinite(Number(stars)) ? Math.max(0, Math.min(5, Number(stars))) : 0,
      notes: String(notes || ''),
      references: Array.isArray(references) ? references.filter((x) => typeof x === 'string') : [],
      contentIndex: probe.exists ? extractLocalText(p, probe.size_bytes) : '',
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
    // 精化完成判定：摘要 + 标签 + 项目归属三者齐备才算已精化（与精化 prompt 的目标一致）
    rec.needsRefine = !(rec.summary && rec.summary.length > 0 && rec.tags && rec.tags.length > 0 && rec.project && rec.project.length > 0)
    // 精化完成即清除「⚡优先」标记，避免已处理条目下次仍霸占待精化列表头部
    if (!rec.needsRefine) rec.refineRequested = false
    rec.updated_at = Math.floor(Date.now() / 1000)
    this.save()
    return rec
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
   * - **敏感文件跳过**（v0.3.2）：凭据/密钥/证书/env 等绝不进库，防止 API key 泄露进全文索引
   * - **敏感目录保护**（v0.3.2）：导入目标本身是凭据/配置目录（如 .ssh/.dsh/AppData）时直接拒绝
   * @returns {Promise<{count:number, project:string, skipped:number}>}
   */
  async importFolder(dirPath, { project = '', maxFiles = 10000, maxSizeBytes = 50 * 1024 * 1024 } = {}) {
    if (typeof dirPath !== 'string' || !dirPath.trim()) throw new Error('目录路径必填')
    const root = path.resolve(dirPath)
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('目录不存在或不是文件夹')
    // 敏感目录保护：凭据/配置/密码管理类目录直接拒绝导入
    const baseName = path.basename(root).toLowerCase()
    if (PROTECTED_ROOT_NAMES.has(baseName)) {
      throw new Error(`「${baseName}」是敏感/系统目录，为避免凭据泄露已拒绝导入。请选择存放作品/资料的普通文件夹。`)
    }
    const proj = project || path.basename(root)
    // 库自身的数据目录：仅当它位于导入根内部时才排除
    // （否则会把自己的 artifacts.json/meta.json 当成资料扫进库；而导入根若本就在数据目录内，则不能排）
    const selfDir = path.resolve(this.dir)
    const selfInsideRoot = selfDir === root || selfDir.startsWith(root + path.sep)

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
    const walk = async (dir) => {
      let entries = []
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (count >= maxFiles) return
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
            if (st.size > maxSizeBytes) { skipped++; continue }
            scanned++
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
    return { count, project: proj, skipped, scanned }
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
  searchSemantic(query, { kind = '', project = '', limit = 20 } = {}) {
    const s = String(query || '').trim().toLowerCase()
    if (!s) return []
    const tokens = [...new Set(s.split(/[\s,，。、;；:：!！?？'"“”‘’()[\]{}<>/\\|_\-+=*#@$%^&~`]+/).filter((t) => t.length > 0))]
    // 中文按 2-gram 补充（无空格中文短语也能命中）
    const grams = []
    const cjk = s.replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    for (let i = 0; i < cjk.length - 1; i++) grams.push(cjk.slice(i, i + 2))
    const allTerms = [...tokens, ...grams]
    if (!allTerms.length) return []

    const WEIGHTS = { title: 10, tags: 8, summary: 5, filename: 4, path: 2, content: 1 }
    const active = this.items.filter((r) => r.trashed_at === null)
    const results = []
    for (const r of active) {
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
   * @returns {{duplicates:Array, missing:Array, unrefinedCount:number, staleProjects:Array, suggestRefine:Array}}
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
    return {
      duplicates,
      missing,
      unrefinedCount: unrefined.length,
      suggestRefine: unrefined.slice(0, 20).map((r) => ({ id: r.id, title: r.title, kind: r.kind })),
      staleProjects,
    }
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
    const projects = [...new Set(this.items.filter((r) => r.trashed_at === null).map((r) => r.project).filter(Boolean))].sort()
    const types = [...new Set(this.items.filter((r) => r.trashed_at === null).map((r) => r.artifact_type).filter(Boolean))].sort()
    const tags = [...new Set(this.items.flatMap((r) => (r.trashed_at === null ? r.tags : [])))].sort()
    return { projects, types, tags }
  }
}
