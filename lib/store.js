/**
 * dsh-artifact-library — 产物存储（JSON 文件，原子写入）
 * 数据模型沿用 QwenPaw 产物库 v0.5 的 schema，从零开始（不迁移旧数据）。
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

/** 可抽取正文的文本类扩展名（本地全文索引用，绝不上传） */
const TEXTISH_EXT = new Set(['txt', 'md', 'markdown', 'json', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'yml', 'yaml', 'csv', 'xml', 'toml', 'ini', 'conf', 'log', 'sh', 'bat', 'ps1', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'rb', 'php', 'sql', 'vue', 'svelte'])
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
    // 回填：老记录没有 needsRefine 时按「有无摘要+标签」补算
    let backfilled = false
    for (const r of this.items) {
      if (typeof r.needsRefine !== 'boolean') {
        r.needsRefine = !(r.summary && r.summary.length > 0 && r.tags && r.tags.length > 0)
        backfilled = true
      }
      if (typeof r.kind !== 'string') r.kind = 'deliverable'
      if (typeof r.source !== 'string') r.source = 'manual'
      if (typeof r.refineRequested !== 'boolean') { r.refineRequested = false; backfilled = true }
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
   * @returns {object} 新产物记录
   */
  register({ path: p, title, summary = '', project = '', deliverable = '', artifact_type = 'other', tags = [], notes = '', status = 'final', stars = 0, kind = 'deliverable', source = 'manual', references = [] }) {
    if (typeof p !== 'string' || !p.trim()) throw new Error('path 必填')
    p = path.normalize(p) // 统一分隔符，去重才可靠（C:/ 与 C:\ 视为同一文件）
    const filename = path.basename(p)
    const probe = this.probePath(p)
    const now = Math.floor(Date.now() / 1000)
    const rec = {
      id: newId(),
      kind: kind === 'reference' ? 'reference' : 'deliverable',
      source: ['session', 'folder-import', 'manual'].includes(source) ? source : 'manual',
      needsRefine: !(summary && summary.length > 0 && tags && tags.length > 0),
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
      agent_id: '',
      session_id: '',
      created_at: now,
      updated_at: now,
      trashed_at: null,
    }
    this.items.push(rec)
    this.save()
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
    return items.slice(0, limit)
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
    if (patch.references !== undefined) rec.references = (Array.isArray(patch.references) ? patch.references : String(patch.references || '').split(',').map((s) => s.trim())).filter(Boolean).map(String)
    if (patch.stars !== undefined) rec.stars = Math.max(0, Math.min(5, Number(patch.stars) || 0))
    // 有摘要且有标签 → 视为已精化
    rec.needsRefine = !(rec.summary && rec.summary.length > 0 && rec.tags && rec.tags.length > 0)
    rec.updated_at = Math.floor(Date.now() / 1000)
    this.save()
    return rec
  }

  trash(id) {
    const rec = this.get(id)
    if (!rec) return null
    rec.trashed_at = Math.floor(Date.now() / 1000)
    rec.updated_at = rec.trashed_at
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
   * @returns {{count:number, project:string, skipped:number}}
   */
  importFolder(dirPath, { project = '', maxFiles = 10000 } = {}) {
    if (typeof dirPath !== 'string' || !dirPath.trim()) throw new Error('目录路径必填')
    const root = path.resolve(dirPath)
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('目录不存在或不是文件夹')
    const proj = project || path.basename(root)
    let count = 0
    let skipped = 0
    const walk = (dir) => {
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (count >= maxFiles) return
        const full = path.join(dir, e.name)
        try {
          if (e.isDirectory()) walk(full)
          else if (e.isFile()) {
            if (this.byPath(full)) { skipped++; continue }
            // 目录名当项目：直接父目录名作为子项目线索，追加为标签
            const parentDir = path.basename(path.dirname(full))
            const tags = parentDir && parentDir !== proj ? [parentDir] : []
            this.register({ path: full, project: proj, kind: 'reference', source: 'folder-import', tags })
            count++
          }
        } catch { skipped++ }
      }
    }
    walk(root)
    return { count, project: proj, skipped }
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

  /** 去重：同路径的多条记录，仅保留最新，其余归档 */
  dedupExactDuplicates() {
    const seen = new Map()
    let deduped = 0
    const sorted = [...this.items].sort((a, b) => b.created_at - a.created_at)
    for (const r of sorted) {
      if (r.trashed_at !== null) continue
      if (seen.has(r.path)) { r.status = 'archived'; r.updated_at = Math.floor(Date.now() / 1000); deduped++ }
      else seen.set(r.path, true)
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

  stats() {
    const active = this.items.filter((r) => r.trashed_at === null)
    const archived = active.filter((r) => r.status === 'archived').length
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
      total: active.length,
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
