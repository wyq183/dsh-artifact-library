/**
 * 知识条目数据层（2026-10-22）
 *
 * ══ 主人原话 ══
 * 「我说的是正儿八经的资料，只放资料，把每个项目的经验遇到的坑存放在这的资料」
 *
 * ══ 为什么独立一个文件，不混进 artifacts.json ══
 *   ① `artifacts.json` 的记录**必然对应磁盘文件**（有 path/size/mtime/缩略图）。
 *      知识条目**没有文件** —— 混进去会让所有按文件统计的地方（大小/类型/缩略图/
 *      文件缺失检测）全部出错。
 *   ② `artifacts.json` 已经 3.8MB，且 `save()` 是同步序列化 + 写盘。
 *      知识条目会一直长，塞进去会让每次保存都变慢。
 *   ③ 两者的**生命周期不同**：文件会消失（exists=false），知识条目不会。
 *
 * ══ 数据模型 ══
 *   {
 *     id: 'kn_xxx',
 *     project: '项目名',        // 归属项目（复用 artifacts 的项目名）
 *     type: 'pitfall',          // pitfall 坑 / experience 经验 / decision 决策
 *     title: '一句话说清是什么',
 *     body: '正文，可含代码块',
 *     tags: [],
 *     refs: [],                 // 关联的产物 id
 *     createdAt, updatedAt
 *   }
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 三种类型（主人选的"按项目 + 类型分"） */
export const KNOWLEDGE_TYPES = [
  { key: 'pitfall', label: '坑', icon: '⚠️', desc: '踩过的问题 + 怎么解决的' },
  { key: 'experience', label: '经验', icon: '💡', desc: '做对的做法、可复用的套路' },
  { key: 'decision', label: '决策', icon: '📌', desc: '为什么这么选、放弃了什么' },
]

export const TYPE_KEYS = KNOWLEDGE_TYPES.map((t) => t.key)

/** 标题/正文上限（防止一条塞进来 10 万字） */
const MAX_TITLE = 200
const MAX_BODY = 50000
const MAX_TAGS = 12

/** 归一化一个标签（与产物库同一套规则） */
function normTag(t) {
  return String(t || '').trim().replace(/\s+/g, ' ').slice(0, 40)
}

/**
 * 标签去重的键。
 *
 * ⚠️ 不能直接用原串去重 —— `css` 和 `CSS` 是同一个标签的两种写法，
 *    直接 Set 会留下两个（实测就漏了）。
 *    与产物库的 `rpNormTag` 同一口径：小写 + `_`/`-` 转空格 + 折叠空白。
 */
function tagKey(t) {
  return String(t || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 校验并清洗一条知识条目。返回 { ok, value?, error? } */
export function normalizeKnowledge(raw, opts = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const title = String(src.title || '').trim()
  if (!title) return { ok: false, error: '标题不能为空' }
  if (title.length > MAX_TITLE) return { ok: false, error: `标题超过 ${MAX_TITLE} 字` }

  const type = String(src.type || '').trim()
  if (TYPE_KEYS.indexOf(type) < 0) {
    return { ok: false, error: `类型必须是 ${TYPE_KEYS.join(' / ')} 之一` }
  }

  const body = String(src.body || '')
  if (body.length > MAX_BODY) return { ok: false, error: `正文超过 ${MAX_BODY} 字` }

  // ⚠️ 按 tagKey 去重（`css` 与 `CSS` 是同一个），保留**第一次出现**的写法。
  const tags = []
  if (Array.isArray(src.tags)) {
    const seen = new Set()
    for (const raw of src.tags) {
      const t = normTag(raw)
      if (!t) continue
      const k = tagKey(t)
      if (seen.has(k)) continue
      seen.add(k)
      tags.push(t)
      if (tags.length >= MAX_TAGS) break
    }
  }

  const refs = Array.isArray(src.refs)
    ? [...new Set(src.refs.map((x) => String(x || '').trim()).filter(Boolean))]
    : []

  const now = Math.floor(Date.now() / 1000)
  return {
    ok: true,
    value: {
      id: opts.id || String(src.id || '').trim() || 'kn_' + randomUUID().slice(0, 12),
      project: String(src.project || '').trim(),
      type,
      title,
      body,
      tags,
      refs,
      createdAt: Number(src.createdAt) || now,
      updatedAt: now,
    },
  }
}

/**
 * 知识库存储。与 ArtifactStore 平级，独立文件 `knowledge.json`。
 *
 * ⚠️ 与 ArtifactStore **不共享 save()** —— 各自的写盘互不影响，
 *    一个写失败不会连累另一个。
 */
export class KnowledgeStore {
  constructor(dataDir) {
    this.dir = dataDir
    this.file = path.join(dataDir, 'knowledge.json')
    this.items = []
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true })
    if (!fs.existsSync(this.file)) { this.items = []; return }
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : [])
    } catch {
      // ⚠️ 解析失败**不清空**（那是丢数据）。保留原文件，内存置空，
      //    下次 save 前会先备份坏文件（见 save 的 .corrupt 处理）。
      this.items = []
      this._corrupt = true
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true })
    // 坏文件先留一份（不覆盖掉证据）
    if (this._corrupt && fs.existsSync(this.file)) {
      try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()) } catch { /* 留不下来也不阻塞 */ }
      this._corrupt = false
    }
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  /** 新增一条 */
  add(raw) {
    const r = normalizeKnowledge(raw)
    if (!r.ok) return r
    this.items.push(r.value)
    try { this.save() } catch (e) {
      this.items.pop()
      return { ok: false, error: '落盘失败：' + (e && e.message ? e.message : String(e)) }
    }
    return { ok: true, value: r.value }
  }

  /** 改一条（只允许改白名单字段） */
  update(id, patch) {
    const rec = this.items.find((x) => x.id === id)
    if (!rec) return { ok: false, error: '没有这条知识' }
    const merged = { ...rec, ...(patch && typeof patch === 'object' ? patch : {}), id: rec.id, createdAt: rec.createdAt }
    const r = normalizeKnowledge(merged, { id: rec.id })
    if (!r.ok) return r
    const prev = { ...rec }
    Object.assign(rec, r.value)
    try { this.save() } catch (e) {
      Object.assign(rec, prev)
      return { ok: false, error: '落盘失败：' + (e && e.message ? e.message : String(e)) }
    }
    return { ok: true, value: rec }
  }

  /** 删一条（真删 —— 知识条目没有"回收站"概念，但要求二次确认在前端） */
  remove(id) {
    const i = this.items.findIndex((x) => x.id === id)
    if (i < 0) return { ok: false, error: '没有这条知识' }
    const [removed] = this.items.splice(i, 1)
    try { this.save() } catch (e) {
      this.items.splice(i, 0, removed)
      return { ok: false, error: '落盘失败：' + (e && e.message ? e.message : String(e)) }
    }
    return { ok: true, value: removed }
  }

  get(id) {
    return this.items.find((x) => x.id === id) || null
  }

  /**
   * 查询。
   * @param {{project?:string, type?:string, q?:string, limit?:number}} opts
   */
  list(opts = {}) {
    const project = String(opts.project || '')
    const type = String(opts.type || '')
    const q = String(opts.q || '').trim().toLowerCase()
    let out = this.items.slice()
    if (project) out = out.filter((x) => (x.project || '') === project)
    if (type) out = out.filter((x) => x.type === type)
    if (q) {
      out = out.filter((x) =>
        (x.title || '').toLowerCase().includes(q)
        || (x.body || '').toLowerCase().includes(q)
        || (x.tags || []).some((t) => String(t).toLowerCase().includes(q)))
    }
    // 最近更新在前
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    const limit = Math.max(1, Math.min(Number(opts.limit) || 500, 2000))
    return out.slice(0, limit)
  }

  /** 按「项目 → 类型」出树（给左侧栏用） */
  tree() {
    const byProject = {}
    for (const x of this.items) {
      const p = x.project || ''
      if (!byProject[p]) byProject[p] = { project: p, count: 0, types: {}, last: 0 }
      const g = byProject[p]
      g.count += 1
      g.types[x.type] = (g.types[x.type] || 0) + 1
      const t = Number(x.updatedAt) || 0
      if (t > g.last) g.last = t
    }
    return Object.values(byProject).sort((a, b) => {
      if (!a.project) return 1
      if (!b.project) return -1
      return b.last - a.last
    })
  }

  /** 统计 */
  stats() {
    const byType = {}
    const byProject = {}
    const tagCount = {}
    for (const x of this.items) {
      byType[x.type] = (byType[x.type] || 0) + 1
      const p = x.project || ''
      byProject[p] = (byProject[p] || 0) + 1
      for (const t of (x.tags || [])) tagCount[t] = (tagCount[t] || 0) + 1
    }
    return { total: this.items.length, byType, byProject, tags: tagCount }
  }
}
