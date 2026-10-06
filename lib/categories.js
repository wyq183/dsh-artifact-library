/**
 * 分类（category）的**纯函数**工具 —— 后缀 ↔ 分类的映射、归类、分组计数。
 *
 * ⭐ **为什么单独一个文件**（而不是塞进 store.js 或 client.js）：
 *   同一套「这个后缀属于哪个分类」的规则有三处消费方 ——
 *     · 宿主侧（`store.js`）：新登记时按后缀给**默认归类**
 *     · 客户端（`client.js`）：面板筛选分组、图标
 *     · agent 工具（`tools.js`）：改分类时校验后缀
 *   三处各写一遍必然漂移（这个仓库现存 **五张** 互不相干的扩展名表就是证据：
 *   `client.js` 的 `CHIP_EXTS`、`icons.js` 的 `EXT_TYPE`、`store.js` 的 `MIME_BY_EXT`、
 *   `TEXTISH_EXT`、`tools.js` 的 `TEXT_EXT` —— 没有一张是从另一张推出来的）。
 *   ⇒ 这张表以 `settings.js` 的 `DEFAULT_CATEGORIES[].exts` 为唯一真相源，
 *     本模块只负责**用它**，不自己存一份。
 *
 * 本文件**不 import 任何东西**（除 Node 内置的 path），这样 store / 客户端 / 测试
 * 都能直接用，也不会引入循环依赖。
 */

import path from 'node:path'

/** 兜底分类 id。与 `settings.js` 的 `LOCKED_CATEGORY_ID` 同值 —— 这里不 import 是为了保持零依赖。 */
export const FALLBACK_CATEGORY_ID = 'other'

/**
 * 从文件名/路径取出规范化后缀（不带点、小写）。
 *
 * 只取**最后一个点之后**的部分：`a.tar.gz` → `gz`（不是 `tar.gz`）。
 * 这是刻意的 —— 与 `CHIP_EXTS` / `icons.js` 的既有口径一致，且 `tar.gz` 归到 `gz`
 * 和归到压缩包是同一个答案。
 *
 * @param {unknown} name 文件名或完整路径
 * @returns {string} 规范后缀；取不到或有可疑内容时返回 `''`
 */
export function normalizeExt(name) {
  const base = path.basename(String(name === undefined || name === null ? '' : name))
  const dot = base.lastIndexOf('.')
  // 没有点、点在开头（`.gitignore` 这种 dotfile 不算后缀）、或点是最后一个字符 → 没有后缀
  if (dot <= 0 || dot === base.length - 1) return ''
  const ext = base.slice(dot + 1).toLowerCase()
  // 只接受纯字母数字：挡住 `file.` `file. tar` `file.a/b` 这类残缺/异常输入
  if (!/^[a-z0-9]+$/.test(ext)) return ''
  // 超长的一律不认（真实后缀没有超过 16 字符的；`validateCategories` 也卡 16）
  if (ext.length > 16) return ''
  return ext
}

/**
 * 把分类表编译成「后缀 → 分类 id」的索引。
 *
 * ⚠️ **同一后缀出现在多个分类里时取先出现的那个** —— 与 `validateCategories`
 * 的注释 ② 一致（它也只记 `notes` 不报错）。真实数据里 `exe` 天然跨类
 * （code 9 / archive 2 / other 1），硬性禁止会让用户根本配不出一张能用的表。
 *
 * @param {Array<{id:string, exts?:string[]}>} categories
 * @returns {{owner: Map<string,string>, conflicts: Array<{ext:string, kept:string, shadowed:string}>}}
 */
export function buildExtIndex(categories) {
  const owner = new Map()
  const conflicts = []
  for (const cat of Array.isArray(categories) ? categories : []) {
    if (!cat || typeof cat.id !== 'string') continue
    const exts = Array.isArray(cat.exts) ? cat.exts : []
    for (const raw of exts) {
      // ⚠️ 只认字符串 —— **不做隐式 toString**。理由：`42` 经 `String()` 会变成合法后缀 `"42"`，
      //    于是「配置里混进一个数字」会被**静默**当成一个真后缀，谁也查不出来。
      //    `validateCategories` 也拒非字符串，这里保持同一个口径（测试里两条断言钉住）。
      if (typeof raw !== 'string') continue
      const ext = normalizeExt('x.' + raw.replace(/^\.+/, ''))
      if (!ext) continue
      const existing = owner.get(ext)
      if (existing === undefined) owner.set(ext, cat.id)
      else if (existing !== cat.id) conflicts.push({ ext, kept: existing, shadowed: cat.id })
    }
  }
  return { owner, conflicts }
}

/**
 * 按路径后缀**猜**一个分类 id —— 这是「建议」，不是「事实」。
 *
 * ⚠️ 两条必须遵守的边界（写在这里免得每个调用方各错一次）：
 *   ① **只用于新登记时的默认归类**，绝不回头改写已有记录。实测：现有 249 条有效记录里
 *      后缀与 `artifact_type` 的一致率约 89% —— 说明它**大体**跟着后缀走，但仍有 11% 不是。
 *      按后缀重算会抹掉当初 agent 判的**语义**分类（`md` 133 条里 document 124 / other 6 / code 3，
 *      那 3 条 code 是真实语义，重算就没了）。
 *   ② **目录不猜**：一个叫 `v1.2` 的目录会被 `normalizeExt` 读成后缀 `2`，
 *      所以调用方必须把 `isDir` 传进来（store 的 register 里 probe 已经知道是不是目录）。
 *
 * @param {string} filePath
 * @param {Array<object>} categories
 * @param {{isDir?:boolean, fallback?:string}} [options]
 * @returns {string} 分类 id（找不到就用 fallback，默认 `other`）
 */
export function inferCategoryFromPath(filePath, categories, options = {}) {
  const fallback = typeof options.fallback === 'string' && options.fallback ? options.fallback : FALLBACK_CATEGORY_ID
  if (options.isDir === true) return fallback
  const ext = normalizeExt(filePath)
  if (!ext) return fallback
  const { owner } = buildExtIndex(categories)
  return owner.get(ext) || fallback
}

/**
 * 取分类的显示名。
 *
 * ⭐ **孤儿不隐藏**：`id` 在表里找不到时**返回 id 本身**，而不是「未知」或空串。
 *   理由：分类是**用户可改**的，用户删掉一个分类后，指向它的记录仍然存在。
 *   如果这里把不认识的 id 折成「未分类」，用户就**再也看不到**自己把什么弄丢了 ——
 *   那不叫容错，那叫假装没发生。（真正的删除走 2c/2d 的强制改派，那条路会把记录改掉。）
 *
 * @param {Array<{id:string,label:string}>} categories
 * @param {string} id
 * @returns {string}
 */
export function categoryLabel(categories, id) {
  const key = String(id === undefined || id === null ? '' : id)
  for (const cat of Array.isArray(categories) ? categories : []) {
    if (cat && cat.id === key) return String(cat.label || key)
  }
  return key || FALLBACK_CATEGORY_ID
}

/**
 * 按分类归拢一批记录并计数 —— 面板筛选用。
 *
 * 返回的 `buckets` **按分类表的顺序**（用户排的序就是界面上的序），
 * 后面追加 `orphans`（记录指向了表里不存在的分类）。
 * `count === 0` 的分类**照样返回** —— 面板要能显示空分类，否则用户没法往里拖东西。
 *
 * @param {Array<{artifact_type?:string}>} records
 * @param {Array<{id:string,label:string,icon?:string}>} categories
 * @returns {{buckets:Array<{id:string,label:string,icon:string,count:number}>,
 *            orphans:Array<{id:string,count:number}>, total:number}}
 */
export function groupByCategory(records, categories) {
  const list = Array.isArray(records) ? records : []
  const counts = new Map()
  for (const rec of list) {
    const id = String((rec && rec.artifact_type) || FALLBACK_CATEGORY_ID)
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  const buckets = []
  const known = new Set()
  for (const cat of Array.isArray(categories) ? categories : []) {
    if (!cat || typeof cat.id !== 'string') continue
    known.add(cat.id)
    buckets.push({
      id: cat.id,
      label: String(cat.label || cat.id),
      icon: String(cat.icon || FALLBACK_CATEGORY_ID),
      locked: cat.locked === true,
      count: counts.get(cat.id) || 0,
    })
  }
  const orphans = []
  for (const [id, count] of counts) {
    if (!known.has(id)) orphans.push({ id, count })
  }
  orphans.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  return { buckets, orphans, total: list.length }
}

/**
 * 给定分类表和一个候选 id，判断它是否**可用作** `artifact_type`。
 *
 * 用途：agent 工具（2c）拿用户输入的分类名去校验。
 * ⭐ 宽容点：**孤儿 id 也算合法**（`orphanOk`）—— 因为改分类这个动作本身
 * 不该因为「用户刚删了这个分类」而被拒；真正的删除流程会强制改派。
 *
 * @param {Array<object>} categories
 * @param {string} id
 * @returns {{ok:true, id:string}|{ok:false, reason:string}}
 */
export function checkCategoryId(categories, id) {
  const key = typeof id === 'string' ? id.trim() : ''
  if (!key) return { ok: false, reason: '分类 id 不能为空' }
  // 形状校验与 settings.js 的 CATEGORY_ID_RE 同源（这里重写一份是为了零依赖；
  // 测试里有一条断言两份必须一致，防止漂移）
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(key)) {
    return { ok: false, reason: `分类 id 不合法（只接受 /^[a-z][a-z0-9_-]{0,31}$/）：${key}` }
  }
  return { ok: true, id: key }
}

/**
 * 按显示名或 id 找一个分类（给 agent 工具用：用户说「归到代码类」时能对上）。
 * @param {Array<{id:string,label:string}>} categories
 * @param {string} needle
 * @returns {object|null}
 */
export function findCategory(categories, needle) {
  const key = String(needle === undefined || needle === null ? '' : needle).trim()
  if (!key) return null
  const list = Array.isArray(categories) ? categories : []
  const lower = key.toLowerCase()
  for (const cat of list) if (cat && cat.id === key) return cat
  for (const cat of list) if (cat && String(cat.label) === key) return cat
  for (const cat of list) if (cat && String(cat.label).toLowerCase() === lower) return cat
  for (const cat of list) if (cat && String(cat.id).toLowerCase() === lower) return cat
  return null
}
