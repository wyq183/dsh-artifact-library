/**
 * dsh-artifact-library — 标签治理（「标签收敛」的规则层）
 *
 * ── 要解决的问题（依琪 2026-10-06 提的）────────────────────────────────────
 *
 * 依琪原话：「**标签系统**（视频/视频项目/图片项目/学业作业/调研研究/代码bug/备份等）」
 * 「**精炼不只合并相似项目还可细分标签**」。
 *
 * 实测真实数据（2026-10-07，251 条有效记录）：
 *
 *   有标签的记录   246 / 251（98%）
 *   标签引用总数   1559
 *   不同标签数     **829**
 *   只出现 1 次的  **573（69%）**
 *
 * ⇒ **关键判断：标签不是「不够用」，是「没有收敛」。**
 *   829 个不同标签、69% 只出现一次，这不是标签系统，是每篇文档随手起个名。
 *   而依琪说的那几个大类**其实早就在库里**（`调研`×4、`作业`×8、`bug修复`×4、`备份`×1），
 *   只是淹没在长尾里。
 *
 * ── 本模块的**范围边界**（这条划错会丢用户数据，所以写在最前面）────────────
 *
 * ⭐ **归一化只做「同一件事的两种写法」，不做「具体 → 抽象」。**
 *
 *   ✅ 做：`DSH` / `dsh`、`Godot` / `godot`、`卫龙榴莲辣条·留恋计划` / `卫龙榴莲辣条留恋计划`
 *      —— 这是**同一个字符串被记了两遍**，合并是纯粹的去重。
 *   ❌ 不做：把 `超星`、`弹幕梗`、`第213章`、`1080p` 归成「学业」「视频」
 *      —— 那是**重新分类**，是人的决定。而且它们是**具体而正确**的，
 *      归成大类＝丢掉用户当时记下的信息。
 *
 *   所以本模块**只用 `exact` 一档**（归一化后完全相同），
 *   与 `project-merge.js` 那四档（exact/contains/prefix/tokens）**刻意不同**：
 *   项目名是「少数几个名字反复用」，放宽规则能在人的核对下受益；
 *   标签是「829 个自由字符串」，一放宽就会开始**猜**，猜错一次污染一批记录。
 *
 * ── 为什么不做模糊匹配 ─────────────────────────────────────────────────────
 *
 * 不做编辑距离、不做词干还原、不做「看起来像」。理由同上：
 * 那是在猜用户的语义意图。需要「疑似同族」的线索时走 `suggestTagFamilies`，
 * 它**只读、只建议**，不参与任何自动改写。
 *
 * ── 实测：真库里这样的重复有 **9 组 / 18 个标签** ─────────────────────────
 *
 *   dsh×6 / DSH×8          godot×5 / Godot×21      ui×1 / UI×3
 *   pvz2×4 / PvZ2×9        gpNext×2 / GP-Next×3    svg×4 / SVG×4
 *   html×1 / HTML×3        browser-skill×1 / BrowserSkill×1
 *   卫龙榴莲辣条留恋计划×1 / 卫龙榴莲辣条·留恋计划×1
 *
 * ⚠️ 最后一组只有放宽到「去所有符号」才现形 —— 它**不带大小写差异**，
 *    所以只看大小写会漏掉它。它和 `project-merge.js` 里记的
 *    「项目名 `·` 导致假同名」是**同一个 bug 类**。
 */

// ⚠️ 本模块**刻意不 import `project-merge.js`** —— 标签的归一化口径与项目名**不同**，
//    理由见下面 `normalizeTag` 的注释（那是这一版最值钱的一段说明，别删）。

/**
 * 标签里**可折叠的装饰符**：空白（含全角空格与不换行空格）、各种中点、
 * 连字符/下划线/各种破折号。
 *
 * ⚠️ **刻意不含** `+` `#` `.` `&` 等**有语义**的符号 —— 见下面「为什么不再复用」。
 */
const TAG_DECOR = /[\s\u00b7\u30fb\u2027\u2219\u22c5\u2010\u2011\u2012\u2013\u2014\u2015\-_]+/gu

/**
 * 标签归一化键 —— 「同一个标签被记了两遍」的判据。
 *
 * ── ⚠️ 2026-10-07 修正：**不再复用 `normalizeProjectName`** ──────────────────
 *
 * 原来这里直接 `return normalizeProjectName(tag)`，理由是「函数体一样，各写一份必然漂移」。
 * **那个理由当时看着成立，但它漏掉了一件最贵的事：**
 *
 * `normalizeProjectName` 的规则是「**抹掉所有非字母数字**」——
 * 对项目名没问题（那边只用它做 exact 一档的粗匹配），但标签承受不了：
 *
 * ```
 *   C   →  "c"        C++  →  "c"        C#   →  "c"      ← 三个不同的东西塌成一个键
 *   F   →  "f"        F#   →  "f"
 *   NET →  "net"      .NET →  "net"
 * ```
 *
 * 后果**不是理论风险**（2026-10-07 实测复现）：
 * `findTagDuplicates` 会把 `C` / `C++` / `C#` 输出成一组 ⇒
 * `suggestCleanup()` **主动建议**「把 `C#`、`C++` 并成 `C`」⇒
 * 而 `mergeTags` 的范围闸门（比的正是本函数）**会放行** ——
 * **用户/agent 照着建议点一下，`C++` 和 `C#` 就没了。**
 * （库里确实存在 `C#`，当时只是没有 `C` 与它撞键 —— 那是运气，不是安全。）
 *
 * ── 为什么「各写一份」在这里是**对的**，不是漂移 ──────────────────────────
 *
 * 项目名与标签**要回答的不是同一个问题**：
 *   · 项目名：**四档**匹配（exact/contains/prefix/tokens），key 只是第一道粗筛，
 *     后面还有人核对、还有置信度分档兜着 ⇒ 可以**宽松**；
 *   · 标签：**只用 exact 一档**，key 就是**最终判据** ⇒ 必须**保守**。
 * ⇒ 拿同一个函数服务这两种判定，才是真正的错。这跟 `categories.js` 里那
 *   「五张互不相干的扩展名表」（**同一件事**各写一份、进而互相漂移）**不是一回事**。
 *
 * ⇒ 本函数**只折叠装饰符**，保留语义符号。两套口径**分开是有意的**。
 *
 * ⚠️ 改这条时验过：真库那 **9 组 / 18 个标签逐键完全相同**（`·` 那组也在，
 *    因为 `·` 属于装饰符），且当时库里**没有任何**含符号的标签会因此新增撞键。
 *
 * @param {string} tag
 * @returns {string} 归一化键；无意义输入回 `''`
 */
export function normalizeTag(tag) {
  return String(tag == null ? '' : tag)
    .normalize('NFKC')
    .replace(TAG_DECOR, '')
    .toLowerCase()
}

/**
 * 标签的「显示形状」——决定规范名时用的几个观察值。
 * @param {string} tag
 */
function shapeOf(tag) {
  const text = String(tag)
  let letters = 0
  let upper = 0
  let lower = 0
  let specials = 0
  for (const ch of text) {
    if (/\p{L}/u.test(ch)) {
      letters += 1
      if (ch !== ch.toLowerCase()) upper += 1
      else if (ch !== ch.toUpperCase()) lower += 1
    } else if (!/\p{N}/u.test(ch)) {
      // 非字母也非数字 = 标点/符号/空白（`·`、`-`、`_`、空格…）
      specials += 1
    }
  }
  return { letters, upper, lower, specials, mixedCase: upper > 0 && lower > 0 }
}

/**
 * 从「标签 → 出现次数」的映射里挑出规范名。
 *
 * 规则链（逐条决定，**结果确定**：同样输入永远同样输出）：
 *   ① **出现次数最多**的胜出（`Godot`×21 胜 `godot`×5）
 *   ② 次数相同时：**保留大小写混写**的那个（`BrowserSkill` 胜 `browser-skill`）
 *      ——「混写」= 同时含大写和小写字母；纯全大写（`DSH`）与纯小写（`dsh`）都**不算**
 *   ③ 再相同：**特殊字符少**的胜出（`卫龙榴莲辣条留恋计划` 胜 `卫龙榴莲辣条·留恋计划`；
 *      也正因为这条，`gpNext`（0 个特殊字符）在**平局**时会胜过 `GP-Next`（1 个 `-`））
 *   ④ 再相同：**长度短**的胜出
 *   ⑤ 再相同：**字典序小**的胜出（最后保证确定性）
 *
 * ⚠️ 规则 ① 是**唯一**能决定 `DSH`(8) vs `dsh`(6) 的因素 ——
 *   `DSH` 胜出是因为**它出现得多**，不是因为我偏好大写。
 *   这条要写清楚，否则后人会以为这里有大小写倾向。
 *   ⚠️ 同理，真库里 `GP-Next`(×3) 胜 `gpNext`(×2) 也是**靠次数**
 *   （若数到平局，③ 会让 `gpNext` 胜 —— 这是刻意的，不是 bug）。
 *   这两个例子说明：「为什么留下的是这个写法」必须**看数据**，不能从名字猜。
 *
 * @param {Array<{tag:string, count:number}>} variants 同一归一键下的所有变体
 * @returns {string} 规范名
 */
export function pickCanonicalTag(variants) {
  const list = Array.isArray(variants) ? variants.filter((v) => v && typeof v.tag === 'string') : []
  if (!list.length) return ''
  const ranked = list.slice().sort((a, b) => {
    const sa = shapeOf(a.tag)
    const sb = shapeOf(b.tag)
    return (b.count - a.count)                                   // ① 次数多的
      || (Number(sb.mixedCase) - Number(sa.mixedCase))            // ② 混写的
      || (sa.specials - sb.specials)                              // ③ 特殊字符少的
      || (a.tag.length - b.tag.length)                            // ④ 短的
      || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)             // ⑤ 字典序
  })
  return ranked[0].tag
}

/**
 * 找出标签集合里的**真重复**（归一化后相同、但写法不同的组）。
 *
 * @param {Array<string|{tag:string,count:number}>} input 标签数组，或 `{tag,count}` 数组
 * @returns {{groups:Array<object>, scanned:number, duplicateTags:number, mergeable:number}}
 *   · `groups[].key`      归一键
 *   · `groups[].canonical` 规范名（保留这个）
 *   · `groups[].from`     会被改写掉的那些写法
 *   · `groups[].variants` `[{tag,count}]`（按次数降序）
 *   · `groups[].total`     涉及多少条记录引用（**上界**，同一记录挂两个变体会重复计）
 */
export function findTagDuplicates(input) {
  const list = Array.isArray(input) ? input : []
  // 接受两种输入：纯字符串数组（次数按 1 计）或 {tag,count}
  const counts = new Map()
  for (const item of list) {
    const tag = typeof item === 'string' ? item : (item && typeof item.tag === 'string' ? item.tag : null)
    if (tag === null) continue
    const n = typeof item === 'string' ? 1 : (Number(item.count) > 0 ? Number(item.count) : 1)
    counts.set(tag, (counts.get(tag) || 0) + n)
  }

  const byKey = new Map()
  for (const [tag, count] of counts) {
    const key = normalizeTag(tag)
    // ⚠️ 归一化后为空 = 这个标签**没有可用身份**（例如整个标签就是 `···`）。
    //    不能把它们归成一组 —— 那等于凭「都无意义」把毫不相干的标签合并。
    //    （与 `project-merge.js` 的 NON_PROJECT_NAMES 同一思路。）
    if (!key) continue
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push({ tag, count })
  }

  const groups = []
  let duplicateTags = 0
  let mergeable = 0
  for (const [key, variants] of byKey) {
    if (variants.length < 2) continue
    const canonical = pickCanonicalTag(variants)
    const sorted = variants.slice().sort((a, b) => (b.count - a.count) || (a.tag < b.tag ? -1 : 1))
    groups.push({
      key,
      canonical,
      from: sorted.filter((v) => v.tag !== canonical).map((v) => v.tag),
      variants: sorted,
      total: sorted.reduce((n, v) => n + v.count, 0),
    })
    duplicateTags += variants.length
    mergeable += variants.length - 1
  }

  // 输出顺序稳定：先按影响面（涉及记录多的在前），再按归一键
  groups.sort((a, b) => (b.total - a.total) || (a.key < b.key ? -1 : 1))
  return { groups, scanned: counts.size, duplicateTags, mergeable }
}

/**
 * 把重复组整理成 store 可执行的合并计划。
 *
 * ⭐ 与 `mergeProjects` 的入参形状**故意不同**：那边是用户勾选的一组名字 + 一个目标名；
 *   这边是**规则已经算好目标**（`canonical`），人要做的是**勾掉不想要的组**。
 *   理由：标签重复是「同串两写」，目标唯一且无争议 —— 让用户为 `DSH`/`dsh` 选目标
 *   是多余的负担。而项目名合并常有「谁是规范名」的真实分歧（`营销创意` 是不是项目名）。
 *
 * @param {Array<object>} groups `findTagDuplicates().groups`
 * @returns {Array<{canonical:string, from:string[], total:number, key:string}>}
 */
export function planTagMerge(groups) {
  return (Array.isArray(groups) ? groups : [])
    .filter((g) => g && typeof g.canonical === 'string' && Array.isArray(g.from) && g.from.length)
    .map((g) => ({ canonical: g.canonical, from: g.from.slice(), total: g.total, key: g.key }))
}

/**
 * 「疑似同族」的**只读**线索 —— 给整理建议单/agent 看，**绝不自动改写**。
 *
 * 判据刻意保守：**一个标签是另一个的前缀，且短的那个 ≥ 2 字符**。
 * 例：`DSH` / `DSH插件`、`三角洲口琴` / `三角洲口琴工具链`。
 *
 * ⚠️ 这里**必须**给出反例警示，因为这一类线索最容易合错：
 *   真实数据里 `dsh-artifact-library` / `dsh-lan-connect` / `dsh-browser` /
 *   `dsh-shield` 共享 `dsh` 前缀，但是**四个不同的插件**。
 *   `project-merge.js` 为此吃过一次「13 个不同项目连成一组」的事故（见那个文件头部）。
 *   ⇒ 所以返回值里带 `warning` 字段，且**不参与任何自动操作**。
 *
 * @param {Array<{tag:string,count:number}>|string[]} input
 * @param {{minPrefix?:number}} [options] 最短公共前缀（默认 2）
 * @returns {Array<{prefix:string, tags:Array<{tag:string,count:number}>}>}
 */
export function suggestTagFamilies(input, options = {}) {
  const minPrefix = Number.isFinite(Number(options.minPrefix)) ? Math.max(1, Math.trunc(Number(options.minPrefix))) : 2
  const list = Array.isArray(input) ? input : []
  const counts = new Map()
  for (const item of list) {
    const tag = typeof item === 'string' ? item : (item && typeof item.tag === 'string' ? item.tag : null)
    if (tag === null || !normalizeTag(tag)) continue
    const n = typeof item === 'string' ? 1 : (Number(item.count) > 0 ? Number(item.count) : 1)
    counts.set(tag, (counts.get(tag) || 0) + n)
  }
  const keys = [...counts.keys()].map((tag) => ({ tag, key: normalizeTag(tag), count: counts.get(tag) }))
  const out = []
  // ⚠️ `used` 存的是**归一化键**不是原始标签：`DSH` 与 `dsh` 归一到同一个键，
  //    用原始标签去重会让它们各产出一次几乎相同的组（第一版就是这样，输出里
  //    同时有「DSH -> …」和「dsh -> …」两组）。同一件事只报一次。
  const used = new Set()
  // 短的当根：这样 `DSH` / `DSH插件` 会在 `DSH` 这一轮被找出来
  const byLen = keys.slice().sort((a, b) => (a.key.length - b.key.length) || (b.count - a.count))
  for (const root of byLen) {
    if (root.key.length < minPrefix) continue
    if (used.has(root.key)) continue
    const members = keys.filter((k) => k.key !== root.key && k.key.length > root.key.length && k.key.startsWith(root.key))
    if (!members.length) continue
    // 组内同键的变体只留出现次数最多的那个（避免把 `DSH`/`dsh` 并列进同一组）
    const seen = new Set([root.key])
    const picked = []
    for (const m of members.slice().sort((a, b) => (b.count - a.count) || (a.tag < b.tag ? -1 : 1))) {
      if (seen.has(m.key)) continue
      seen.add(m.key)
      picked.push(m)
    }
    const group = [root, ...picked]
    for (const m of group) used.add(m.key)
    out.push({
      prefix: root.tag,
      // ⚠️ 只给线索，不给结论
      warning: '同前缀不等于同一件事：真实数据里 dsh-artifact-library / dsh-lan-connect / '
        + 'dsh-browser / dsh-shield 共享 dsh 前缀但是四个不同的插件。合并前请逐个确认。',
      tags: group.map((m) => ({ tag: m.tag, count: m.count })).sort((a, b) => (b.count - a.count) || (a.tag < b.tag ? -1 : 1)),
    })
  }
  return out.sort((a, b) => (b.tags.length - a.tags.length) || (a.prefix < b.prefix ? -1 : 1))
}

/**
 * 标签现状统计 —— 供整理建议单（`artifact_suggest_cleanup`）复用。
 *
 * 「长尾率」是这里最重要的一个数：它是**「标签有没有收敛」的唯一量化指标**。
 * 就绪的判据不是「标签很多」（那很正常），而是「单次标签占比」——
 * 现在 69% 说明每个记录几乎都在自造标签。
 *
 * @param {Array<string>|Map<string,number>} input
 * @returns {{distinct:number, oneOff:number, longTailRate:number, top:Array<{tag:string,count:number}>}}
 */
export function tagStats(input) {
  const counts = new Map()
  if (input instanceof Map) {
    for (const [tag, n] of input) counts.set(String(tag), Number(n) || 0)
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const tag = typeof item === 'string' ? item : (item && typeof item.tag === 'string' ? item.tag : null)
      if (tag === null) continue
      counts.set(tag, (counts.get(tag) || 0) + (typeof item === 'string' ? 1 : (Number(item.count) > 0 ? Number(item.count) : 1)))
    }
  }
  const distinct = counts.size
  let oneOff = 0
  for (const n of counts.values()) if (n === 1) oneOff += 1
  const top = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || (a.tag < b.tag ? -1 : 1))
    .slice(0, 20)
  return {
    distinct,
    oneOff,
    longTailRate: distinct ? oneOff / distinct : 0,
    top,
  }
}
