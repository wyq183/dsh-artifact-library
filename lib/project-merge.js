/**
 * dsh-artifact-library — 项目名聚类（「项目合并」的规则层）
 *
 * ── 要解决的问题（依琪 2026-10-02 提的）────────────────────────────────────
 *
 * 同一个项目的不同产出，被记成了好多个「项目」。实测他的真实数据：
 * 242 条记录 / **58 个项目名**，其中：
 *
 *   卫龙榴莲辣条 · 卫龙榴莲辣条营销创意 · 卫龙榴莲辣条IP · 卫龙榴莲辣条短剧 ·
 *   卫龙榴莲辣条营销方案 · 卫龙榴莲辣条留恋计划 · 卫龙榴莲辣条·留恋计划 ·
 *   卫龙榴莲辣条-抽象梗campaign · 卫龙榴莲辣条臭味杯
 *   → 9 个名字、18 条记录，其实是**一个项目**
 *
 * 注意最后两个：`卫龙榴莲辣条·留恋计划` 与 `卫龙榴莲辣条留恋计划` **只差一个分隔符**
 * —— 那不是"相似"，那是**同一个字符串被记了两遍**。
 *
 * ── 为什么只做「建议」不做「自动合并」──────────────────────────────────────
 *
 * 放宽规则很容易**合错**。同一个数据集里就有反例：
 *
 *   dsh-artifact-library / dsh-lan-connect / dsh-browser / dsh-shield 插件安全护栏
 *   → 共享前缀 `dsh`，但是**四个不同的插件**。合了就是灾难。
 *
 * 所以本模块只输出**带置信度的候选分组**，由人（或下一期的 AI）拍板。
 * 四条规则从稳到松，每条都给出**能读懂的理由**：
 *
 *   exact    归一化后完全相同（只差分隔符/大小写/全角半角）—— 零风险
 *   contains 一个名字把另一个整个包含住（`卫龙榴莲辣条` ⊂ `卫龙榴莲辣条IP`）
 *   prefix   共同前缀占**较短那个名字**的 ≥60%（抓 `三角洲口琴工作台/工具链`）
 *   tokens   按分隔符/驼峰切出的词，Jaccard ≥ 0.5（抓 `SVG motion studies / Standalone SVG Motion`）
 *
 * ── contains 档的「弱根降级」（`minRootLength`）────────────────────────────
 *
 * `contains` 是默认勾选的档，所以短根名在这一档**比 prefix 更危险**：
 *
 *     [{AI:1}, {AI绘画:3}, {AI写作:2}]  →  合成一组，canonical `AI`，**默认勾选**
 *
 * 而 `AI绘画` 与 `AI写作` 明显是两个不同的项目 —— 只是恰好都碰了 `AI` 这个词。
 * 所以：**根名（被包含的那个）归一化后短于 `minRootLength`（默认 3）时，
 * 这一组降级为「不默认勾选」并标 `weakRoot: true`**，理由如实写进 `reason`。
 *
 * 为什么是「降级」而不是「直接不报」：藏起来等于这条永远没人处理，
 * 而用户（或下一期的 AI）看一眼就能判断 —— **候选人肉核对 > 静默丢弃**。
 * 也不做成硬性过滤：真有人的项目就叫两个字的（如 `学业`），不该被规则判死。
 *
 * ⚠️ `prefix` 档的三道闸门**都是被真实反例逼出来的**，别单独调松任何一道：
 *
 *   ① 共同前缀 **≥ 4 个字符**（绝对下限）
 *   ② 占**较短名** ≥ 60%
 *   ③ 占**较长名** ≥ 40%
 *
 *   反例现场（2026-10-02，用同一份名字集合实测，三种配置对照过）：
 *
 *     `DSH 自身`（归一化 `dsh自身`，**5** 字符）与 `DSH 扩展`（`dsh扩展`，也是 **5** 字符）
 *     的共同前缀 `dsh` = 3 字符，占 5 的 **60%** → 只用②时判定成立 →
 *     再靠并查集**链式传染**，把 `dsh-artifact-library`、`dsh-lan-connect`、
 *     `dsh-browser` …… **13 个不同项目连成一组**（误合）。
 *
 *     配置对照（同一组 15 个名字）：
 *       · 去掉①和③（只剩②）  → **1 组，最大 13 个名字**   ← 就是上面那个事故
 *       · 去掉①、保留③        → 1 组，4 个名字（`DSH 扩展/环境维护/自身/AE接入`）
 *       · 三道闸门都在（默认） → **0 组** ✅
 *
 *     `dsh` 只有 3 字符，①②一起就把短名链式传染掐断了；而真正该合的
 *     `三角洲口琴工`（共同前缀 **6** 字符，占 8 字符名的 75%）、`ComfyUI`（7 字符）
 *     都远在 4 之上，不受影响。
 *
 *   ⚠️ 注意 `prefix` 之外还有一道同族防线：`contains` 档的**弱根降级**（见 `minRootLength`）
 *      —— `contains` 默认勾选，所以短根名在那一档更危险。
 *
 * 本模块是**纯函数**：不碰文件系统、不依赖 ctx、可直接单测。
 */

/** 置信度档位，从稳到松（数字即排序权重，越大越"需要人看一眼"） */
export const MERGE_CONFIDENCE = {
  exact: 0,
  contains: 1,
  prefix: 2,
  tokens: 3,
}

/** 各档给人看的一句话理由 */
export const MERGE_REASON = {
  exact: '只差分隔符 / 大小写 / 全角半角',
  contains: '一个名字完整包含了另一个',
  prefix: '共同前缀占了大部分（照规则判断）',
  tokens: '切出的词大部分重合',
}

/** 档位 → 默认要不要勾选（只有最稳的两档默认勾上，其余留给用户/AI 确认） */
export const MERGE_DEFAULT_CHECKED = {
  exact: true,
  contains: true,
  prefix: false,
  tokens: false,
}

/** 归一化时**不参与**比较的哨兵名（这些不是真项目） */
export const NON_PROJECT_NAMES = new Set(['', '(未分类)', '(无项目)', '未分类', '无项目'])

/**
 * 项目名归一化：只保留**字母与数字**（含 CJK），其余（空白/分隔符/标点/emoji）全去掉，再转小写。
 *
 * 用 `\p{L}\p{N}` 白名单而不是一个个列分隔符：世界上奇怪的分隔符列不完，
 * 而"只留字母数字"这条规则天然把 `·`、`-`、`_`、`/`、空格、全角括号一次清干净。
 *
 * NFKC 负责全角→半角（`ＡＢＣ` → `abc`）与兼容字符折叠。
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeProjectName(name) {
  return String(name == null ? '' : name)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase()
}

/**
 * 切词：先按非字母数字切，再按驼峰切一次。
 *
 * 长度 < 2 的词丢掉（单个字母的偶然重合不算证据）。
 *
 * @param {string} name
 * @returns {Set<string>}
 */
export function projectTokens(name) {
  const text = String(name == null ? '' : name).normalize('NFKC')
  const out = new Set()
  for (const part of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue
    for (const word of part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)) {
      if (word.length >= 2) out.add(word.toLowerCase())
    }
  }
  return out
}

/** 两个字符串的共同前缀长度 */
export function commonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}

/** 两个集合的 Jaccard 相似度 */
export function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const x of a) if (b.has(x)) shared += 1
  if (shared === 0) return 0
  return shared / (a.size + b.size - shared)
}

/**
 * 找出可以合并的项目分组。
 *
 * @param {Array<{name:string, count:number}>|Map<string,number>|Object} entries
 *   项目名与记录数（`store.suggestCleanup` 里现成的 `projAll` 就能直接喂）
 * @param {{
 *   minNormalizedLength?: number,  // 归一化后短于这个长度不参与（默认 2）
 *   minSharedPrefix?: number,      // prefix 档的**绝对**前缀下限（默认 4，见文件头说明①）
 *   prefixRatio?: number,          // 前缀占较短名的比例下限（默认 0.6，说明②）
 *   prefixSpanRatio?: number,      // 前缀占较长名的比例下限（默认 0.4，说明③）
 *   minRootLength?: number,        // contains 档的根名长度下限（默认 3；短于此则弱根降级）
 *   tokenJaccard?: number,         // tokens 档阈值（默认 0.5）
 *   minRecords?: number,           // 组内记录数少于这个就不值得报（默认 2）
 * }} [options]
 * @returns {{groups: Array<object>, scanned: number, merged: number}}
 */
export function findMergeGroups(entries, options = {}) {
  const minLen = Number.isFinite(options.minNormalizedLength) ? options.minNormalizedLength : 2
  const minSharedPrefix = Number.isFinite(options.minSharedPrefix) ? options.minSharedPrefix : 4
  const prefixRatio = Number.isFinite(options.prefixRatio) ? options.prefixRatio : 0.6
  const prefixSpanRatio = Number.isFinite(options.prefixSpanRatio) ? options.prefixSpanRatio : 0.4
  const minRootLength = Number.isFinite(options.minRootLength) ? options.minRootLength : 3
  const tokenJaccard = Number.isFinite(options.tokenJaccard) ? options.tokenJaccard : 0.5
  const minRecords = Number.isFinite(options.minRecords) ? options.minRecords : 2

  // ── 输入归一：接受数组 / Map / 普通对象三种形态 ─────────────────────────
  let pairs = []
  if (Array.isArray(entries)) {
    pairs = entries.map((e) => [e && e.name, e && e.count])
  } else if (entries instanceof Map) {
    pairs = Array.from(entries.entries())
  } else if (entries && typeof entries === 'object') {
    pairs = Object.entries(entries)
  }

  const items = []
  for (const [rawName, rawCount] of pairs) {
    const name = String(rawName == null ? '' : rawName).trim()
    if (!name || NON_PROJECT_NAMES.has(name)) continue
    const key = normalizeProjectName(name)
    if (key.length < minLen) continue
    items.push({ name, count: Number(rawCount) || 0, key, tokens: projectTokens(name) })
  }

  // ── 并查集：把「像同一个」的名字连起来 ───────────────────────────────────
  const parent = items.map((_, i) => i)
  const find = (x) => {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) { const next = parent[x]; parent[x] = root; x = next }
    return root
  }
  const edges = [] // {a, b, rule} —— 用来给整组定"最弱的一环"
  const union = (a, b, rule) => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    parent[rb] = ra
    edges.push({ a, b, rule })
  }

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]
      const b = items[j]

      // ① 归一化后完全相同 —— 最硬的一条
      if (a.key === b.key) { union(i, j, 'exact'); continue }

      // ② 包含关系
      if (a.key.includes(b.key) || b.key.includes(a.key)) { union(i, j, 'contains'); continue }

      // ③ 共同前缀：三道闸门缺一不可（绝对长度 / 占短名 / 占长名），见文件头说明
      const shorter = a.key.length <= b.key.length ? a.key : b.key
      const longer = a.key.length <= b.key.length ? b.key : a.key
      const shared = commonPrefixLength(shorter, longer)
      if (shared >= minSharedPrefix
        && shared / shorter.length >= prefixRatio
        && shared / longer.length >= prefixSpanRatio) {
        union(i, j, 'prefix')
        continue
      }

      // ④ 词集合重合度（抓 `SVG motion studies` / `Standalone SVG Motion` 这种）
      if (jaccard(a.tokens, b.tokens) >= tokenJaccard) { union(i, j, 'tokens') }
    }
  }

  // ── 收集连通分量 ────────────────────────────────────────────────────────
  const buckets = new Map()
  items.forEach((item, index) => {
    const root = find(index)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(index)
  })

  const groups = []
  for (const indexes of buckets.values()) {
    if (indexes.length < 2) continue
    const members = indexes.map((i) => items[i])

    // 组内**最弱的一环**决定整组置信度 —— 保守标注，别拿最硬的那条去糊弄用户
    const inGroup = new Set(indexes)
    let weakest = 'exact'
    for (const edge of edges) {
      if (!inGroup.has(edge.a) || !inGroup.has(edge.b)) continue
      if (MERGE_CONFIDENCE[edge.rule] > MERGE_CONFIDENCE[weakest]) weakest = edge.rule
    }

    const total = members.reduce((n, m) => n + m.count, 0)
    if (total < minRecords) continue

    // 建议合并到哪个名字。优先级：
    //   ① **根名**：某个成员的名字（归一化后）是**其余每一个成员**的子串 ——
    //      那就是天然的规范名。`卫龙榴莲辣条` 族里 `卫龙榴莲辣条` 满足，
    //      而"记录数最多"会错选 `卫龙榴莲辣条营销创意`（营销创意是作品类型，不是项目名）。
    //   ② 退而求其次：记录数最多的（并列取最短，再并列取字典序 → 结果稳定可重现）。
    //      `三角洲口琴工作台` / `三角洲口琴工具链` 谁也不含谁，走这条。
    const roots = members.filter((m) => members.every((other) => other === m || other.key.includes(m.key)))
    const canonical = roots.length === 1
      ? roots[0].name
      : members.slice().sort((x, y) =>
        (y.count - x.count)
        || (x.name.length - y.name.length)
        || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))[0].name
    const canonicalIsRoot = roots.length === 1

    // ── contains 档的弱根降级（见文件头说明）──────────────────────────────
    // 根名 = 那个被所有其他成员包含的名字；只有 canonicalIsRoot 时才有明确根。
    // 没有明确根时退化为「组里最短的那个名字」——它就是这组能有如今的连接强度上限。
    const rootKey = canonicalIsRoot
      ? roots[0].key
      : members.reduce((a, b) => (a.key.length <= b.key.length ? a : b)).key
    const weakRoot = weakest === 'contains' && rootKey.length < minRootLength

    groups.push({
      canonical,
      // 规范名是不是组里那个「根」——面板可以据此说「这就是大家的共同名字」，
      // 或者提示「这组没有天然根名，建议你确认一下合并到哪个」（前缀/词重合两档常见）
      canonicalIsRoot,
      // 根名太短（< minRootLength）：这组只靠一个很短的名字连起来，**不要默认勾选**。
      // 例：`AI` / `AI绘画` / `AI写作` —— 名字像，但很可能不是同一个项目。
      weakRoot,
      confidence: weakest,
      reason: weakRoot
        ? `${MERGE_REASON[weakest]}，但根名「${canonicalIsRoot ? roots[0].name : canonical}」太短，容易撞名，请核对`
        : MERGE_REASON[weakest],
      defaultChecked: !!MERGE_DEFAULT_CHECKED[weakest] && !weakRoot,
      total,
      // 成员按记录数降序，方便面板直接渲染
      names: members
        .slice()
        .sort((x, y) => (y.count - x.count) || (x.name < y.name ? -1 : 1))
        .map((m) => ({ name: m.name, count: m.count })),
      // 除了规范名之外、会被并进来的那些名字（执行合并时用）
      from: members.filter((m) => m.name !== canonical).map((m) => m.name),
    })
  }

  // 输出顺序也稳定：先按置信度（稳的在前），再按影响面（条数多的在前）
  groups.sort((a, b) =>
    (MERGE_CONFIDENCE[a.confidence] - MERGE_CONFIDENCE[b.confidence])
    || (b.total - a.total)
    || (a.canonical < b.canonical ? -1 : 1))

  const merged = groups.reduce((n, g) => n + g.names.length - 1, 0)
  return { groups, scanned: items.length, merged }
}
