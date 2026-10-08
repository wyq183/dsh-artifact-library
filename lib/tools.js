/**
 * dsh-artifact-library — 模型工具集
 * register_artifact：把产出文件登记进产物库（AGENTS.md「产物库登记」的落地实现）
 * artifact_*：查询/管理产物库
 *
 * 注意：ctx.tools.register 的 parameters 必须是标准 JSON Schema
 * （type:'object' + properties + required 数组），不是 defineTool 的平铺 DSL。
 */

import fs from 'node:fs'
// 分类（Step 2c）：agent 工具要能读写**设置里**的分类表，所以 tools 需要拿到 settings。
// 依赖方向是 tools → settings / categories，两者都不反向依赖 tools，不会成环。
import {
  CATEGORY_ICONS, DEFAULT_MANAGED_TAGS, LOCKED_CATEGORY_ID, droppedSettingsKeys, managedTagRule,
  mergeCategories, validateCategories, validateManagedTagSettings,
} from './settings.js'
import { groupByCategory, checkCategoryId, findCategory } from './categories.js'
// 标签治理的规则层（Step 3c 的 artifact_tags 工具用它做 list / suggest / 组装合并计划）。
// ⚠️ 只读用；真正的改写走 store 的 mergeTags / renameTags（那里有范围闸门与撤销凭据）。
import { tagStats, findTagDuplicates, planTagMerge, suggestTagFamilies } from './tags.js'
// 受管标签表（Step 3d）：**改数据前的闸门只有一个** —— settings.js 的
// `validateManagedTagSettings`（它内部用的是 tag-styles.js 的 `buildTagStyleRule` 本体）。
// ⚠️ 这里 import 的是**词表**（给 agent 看可选值）与「不限」哨兵；**不是**那两个直出函数，
//    理由写在 `artifact_tag_styles` 的 `action=set` 分支里（直出函数看不见用户自己设的上限）。
import {
  MANAGED_TAG_LIMIT_UNLIMITED, TAG_COLOR_SLOTS, TAG_ICONS, TAG_SIZES, TAG_STYLE_FIELDS, TAG_WEIGHTS,
} from './tag-styles.js'

function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

const jsonText = (v) => JSON.stringify(v, null, 2)

// ═══════════════════════════════════════════════════════════════════════════
// agent 友好的小工具（2026-09-30 task-12 调研后加的）
//
// 调研发现三件事，这里都是为了治它们：
//   1. 列表**不打印大小/时间** → agent 调了 `sort:size_desc` 也**说不出哪个最大**
//      （顺序对了，但没有数值可引用）—— 见 humanSize
//   2. 计数会说谎：头部写「命中 N 条」，而 N 是**返回条数**（受 limit 截断），
//      不是真实命中数。实证：同一 project 查询 limit=5 →「命中 5 条」，limit=50 →「命中 22 条」
//      —— 见 scanAll / pageOf
//   3. agent 拿不到**可引用的标识**：人类能点「复制为 @引用」，agent 只能自己猜格式
//      —— 见 fileMention
// ═══════════════════════════════════════════════════════════════════════════

/** 列表类工具的扫描上限：库就几百条，全量读进内存再分页，计数才诚实 */
const MAX_SCAN = 10000

/** 人类可读大小（agent 也要能直接念给用户听） */
export function humanSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}

/** 人类可读时间（秒级时间戳 → 本地 YYYY-MM-DD HH:mm） */
export function humanTime(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n * 1000)
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 官方 mention 形状 —— 与 `ui-reference.formatFileMention` 一致，也与客户端
 * `lib/client.js` 的 `atMention()` 一致（**两边都得跟着官方规格走**）：
 *   · 无空白 → `@path`；含空白 → `@"path"`
 *   · 目录末尾补 `/`（半开引号，用于下钻语义）
 *   · 路径统一用**正斜杠**（官方 mention 就是这个形状）
 *   · 含控制字符或 `"` → 返回空串（不可引用）
 *
 * ⚠️ **为什么这是第二份实现**：客户端 `lib/client.js` 是**预打包**的单文件产物，
 * 宿主侧无法 import 它的内部函数（真要共享得先给它加构建步骤 —— 那是 ui-core 的地盘）。
 * 所以这里按其字面规格实现一份，并用 `test/tools-agent.test.mjs` 的**测试向量**把两边
 * 钉在同一个规格上。**规格只有一个（官方的），实现有两处** —— 这点在报告里已写明。
 *
 * @param {string} p 绝对路径
 * @param {{isDirectory?:boolean}} [options]
 * @returns {string} 可粘贴的 `@引用` 文本；不可引用时返回 ''
 */
export function fileMention(p, options = {}) {
  let s = String(p === undefined || p === null ? '' : p).replace(/\\/g, '/')
  if (/[\u0000-\u001f\u007f-\u009f"]/.test(s)) return ''
  const isDirectory = options.isDirectory === true
  if (isDirectory) s = s.replace(/\/+$/, '') + '/'
  if (!/\s/.test(s)) return '@' + s
  return isDirectory ? '@"' + s : '@"' + s + '"'
}

/** 全部命中（不受 limit 截断），用于诚实计数与分页 */
function scanAll(store, args) {
  return store.list({ ...args, limit: MAX_SCAN })
}

/** 从全量命中里取一页，并如实报告分页状态 */
function pageOf(items, offset, limit) {
  const total = items.length
  const start = Math.max(0, Math.trunc(Number(offset)) || 0)
  const size = Math.max(1, Math.trunc(Number(limit)) || 50)
  const page = items.slice(start, start + size)
  return {
    page,
    total,
    offset: start,
    limit: size,
    truncated: start + page.length < total,
    // 一句话描述分页状态，直接给 agent 看
    describe() {
      if (total === 0) return '命中 0 条'
      const head = `命中 ${total} 条，返回第 ${start + 1}-${start + page.length} 条`
      return this.truncated
        ? `${head}（还有 ${total - start - page.length} 条未显示，用 offset=${start + page.length} 继续翻页）`
        : `${head}（已全部显示）`
    },
  }
}

/**
 * 把一次标签改写的预演/执行结果渲染成人话（`artifact_tags` 的 merge / rename 共用）。
 *
 * ⚠️ 两个数**口径不同，都要显示**（这是 3b 里刻意区分的一处）：
 *   · `records`（每组）= **会被改写**的记录数；
 *   · `variants[].records` = 该写法在**全库**的引用数（含那些本来就规范、不会被改的）。
 *   只看前者会把 `DSH` 报成 1 条，而用户要判断的是"这个标签在库里有多重"。
 */
function renderTagPlan(title, r, limit, { preview = true } = {}) {
  const out = [`🏷️ 标签${title} —— ${preview ? '预演结果' : '本次改动'}：`,
    `  ${r.groups} 组 → 会改写 **${r.changed} 条记录**，去掉 ${r.tagsRemoved} 个重复标签`]
  for (const p of r.plans.slice(0, limit)) {
    const vs = p.variants.map((v) => `${v.tag}(${v.records})`).join(' / ')
    out.push(`  · 「${p.canonical}」 ← ${p.from.join('、')}`)
    out.push(`      会动 ${p.records} 条；各写法全库引用：${vs}`)
  }
  if (r.sample && r.sample.length) {
    out.push('  改动样例（前 ' + r.sample.length + ' 条）：')
    for (const s of r.sample) {
      out.push(`    ${s.title}`)
      out.push(`      ${JSON.stringify(s.before)} → ${JSON.stringify(s.after)}`)
    }
  }
  return out.join('\n')
}

/**
 * ★ **无事可做**的渲染（`ok:true && noop:true`）—— 与"失败"和"改成功了"都分开。
 *
 * 为什么必须单独一个渲染点（2026-10-08 修 `ok:false` 双语义时抽出来的）：
 * 这已经是**第 N 次**同一个病 ——「一个值承载两种语义，调用方按其中一种处理」。
 * 抽成函数是为了**一处写对，处处不会漏**（本仓库认可过的解法，同 `undoNotify` / `buildTagSwap`）。
 *
 * ⚠️ 三件事必须同时成立，少一件就是假话：
 *   ① **不能印 ❌** —— 请求完全合法，用户的诉求（库里没有 `dsh` 了）**已经满足**；
 *   ② **不能印 ✅「已改写 N 条」** —— 那会让 agent 以为动了数据（N 是 0）；
 *   ③ 真跑时若与预演不符（**两段式窗口**：两次调用之间库变了），要**明说**是这种情况。
 */
function renderTagNoop(title, r, { confirmed = false, dry = null } = {}) {
  const lines = [
    `✅ **${title}：一个字都没改 —— 也不需要改。**`,
    `   ${r.reason || '没有任何记录命中。'}`,
  ]
  if (confirmed && dry && typeof dry.changed === 'number' && dry.changed > 0) {
    // ★ 两段式窗口：预演说会改 N 条，真跑时 0 条 ⇒ 库在两次调用之间变了。
    //   ⚠️ 这条必须**明说**，否则 agent 会以为"预演 → 确认 → 什么都没发生"是自己的错。
    lines.push(
      '',
      `⚠️ **注意：预演时说会改 ${dry.changed} 条，真跑时一条都没命中** ——`,
      '   说明这两次调用**之间**库变了（自动采集 / 别的会话在写），那些写法已经不在了。',
      '   **不是这次操作失败**，也**没有**任何改动；要改的话请重新预演一次拿最新影响面。',
    )
  } else {
    lines.push(
      '',
      '   · 常见原因：这些写法**本来就不在库里**（拼错？），或者**已经改过了**（终态已成立）。',
      '   · 想看库里现在到底有哪些写法：`action=list` 或 `action=suggest`。',
    )
  }
  return lines.join('\n')
}

/**
 * ★ **失败**的渲染 —— 按 `kind` 分三类（2026-10-08 起 `store` 会给出 `kind`）。
 *
 * 为什么非要分：这三类的**下一步动作完全不同**，而它们原先都印成
 * `❌ 不能这样归一化：…` / `❌ 执行失败：…`，agent 只能靠文案猜：
 *   · `bad-request`    参数没给全        → 补参数，**别重试同样的调用**
 *   · `invalid-plan`   给了但不合法      → **改参数**（拼错 / 跨语义 / 串链），重试同样的调用必然再失败
 *   · `persist-failed` 校验都过了、落盘炸 → **磁盘问题**，数据没改；可重试，但要先查磁盘
 * ⚠️ `persist-failed` 那支必须说清「**一个字都没改**」—— 落盘失败会整份回滚内存
 *   （`persistBulkOp` 的契约），不说清的话 agent 会去「再撤一次」，而根本没东西可撤。
 */
function renderTagFailure(title, r) {
  const kind = r && r.kind ? String(r.kind) : ''
  const err = r && r.error ? String(r.error) : '（没有给出原因）'
  if (kind === 'bad-request') {
    return `❌ ${title}：**参数不完整** —— ${err}\n`
      + '   （这一类是**调用方**的问题，重试同样的调用必然再失败；先把 groups 或 from+to 补齐。）'
  }
  if (kind === 'persist-failed') {
    return `❌ ${title}：**落盘失败，一个字都没改**（记录仍是原样，内存里的改动已整份回滚）—— ${err}\n`
      + '   ⚠️ 这一类是**磁盘/权限**问题，不是参数问题；**没有东西可撤销**（撤销凭据没落盘）。\n'
      + '   先查磁盘空间/权限，再重试。'
  }
  // `invalid-plan` 以及任何**没有 kind 的老调用方**（兼容：文案退化成原来的形状）
  return `❌ 不能这样${title}：${err}`
}

/** 一行产物：**保持旧字段顺序不变，只在末尾追加**（避免破坏按位置解析的调用方） */
function rowLine(rec, store) {
  const flags = `${rec.status === 'archived' ? '[归档] ' : ''}${rec.kind === 'reference' ? '[资料] ' : ''}${rec.needsRefine ? '[待精化] ' : ''}`
  const base = `${rec.id} | ${flags}${rec.title} | ${rec.project || '未分类'} | ${rec.artifact_type} | ★${rec.stars} | ${rec.path}`
  // ★ 追加：大小 / 修改时间 / 可引用文本 —— 没有这三个，agent 说不出「哪个最大」「什么时候的」
  const size = humanSize(rec.size_bytes)
  const time = humanTime(rec.file_modified_at)
  const mention = rec.is_dir ? '' : fileMention(rec.path)
  return `${base} | ${size} | ${time}${mention ? ` | ${mention}` : ''}`
}

/** 能被当文本读的扩展名（artifact_read 用；二进制一律明确拒绝而不是吐乱码） */
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.json5', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.cs', '.php', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gd', '.gdscript',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.xml', '.svg', '.csv', '.tsv', '.log', '.env.example',
])

/** artifact_read 的单文件上限：超过就明确拒绝，而不是把内存/上下文撑爆 */
const READ_MAX_BYTES = 8 * 1024 * 1024
/** artifact_read 默认/最大返回字符数 */
const READ_DEFAULT_CHARS = 4000
const READ_MAX_CHARS = 50000

/**
 * 注册全部产物库工具。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} store ArtifactStore
 * @param {{get:Function,update:Function}} settings **设置存储**（Step 2c 起需要：
 *   `artifact_categories` 要读写设置里的分类表）。缺省时降级成一个只读空表，
 *   保证老的调用方（和只关心登记/查询的测试）不用改也不会崩。
 */
export function registerArtifactTools(ctx, store, settings) {
  const settingsStore = settings && typeof settings.get === 'function' && typeof settings.update === 'function'
    ? settings
    // ⚠️ 替身必须**显式**回答「哪些键被丢弃过」：`rejectedKeys: () => ({})`。
    //    这不是在撒谎 —— 没接设置存储 ⇒ **压根没有 settings.json 这回事** ⇒
    //    确实不可能有「磁盘上的键被丢弃」。这与「接了存储却问不出来」是两件事，
    //    后者会被 `droppedSettingsKeys` 判成 `ok:false` 并让工具**大声拒绝**
    //    （理由见 lib/settings.js 里那个函数的长注释）。
    : {
      get: () => ({ categories: [] }),
      update: () => ({ applied: [], errors: [{ key: 'categories', reason: '本次没有接上设置存储' }], notes: [] }),
      rejectedKeys: () => ({}),
    }
  const tools = []

  tools.push({
    name: 'register_artifact',
    description: '把本次会话产出的文件登记到 DSH 产物库（path 必填，其余可选）。'
      + '完成任务生成了可交付文件（文档/脚本/图片/安装包/原型等）时调用，方便日后检索回顾。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '产物文件的绝对路径（必填）' },
        title: { type: 'string', description: '简洁标题，缺省用文件名' },
        summary: { type: 'string', description: '做了什么、解决什么问题' },
        project: { type: 'string', description: '所属项目名称' },
        deliverable: { type: 'string', description: '交付物类别，如 报告/原型/安装包/设计稿' },
        artifact_type: {
          type: 'string',
          description: '分类 id。**留空则按文件后缀自动归类**（.md→文档 .png→图片 .py→代码…），'
            + '这是推荐的用法。只有在你**确知**这条产物的语义和后缀不一致时才显式指定'
            + '（例如一篇讲代码的 .md 归到 code）。当前有哪些分类用 artifact_categories action=list 查。',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '关键词标签' },
        notes: { type: 'string', description: '备注' },
        status: { type: 'string', enum: ['final', 'archived'], description: 'final=正式版 archived=归档' },
        kind: { type: 'string', enum: ['deliverable', 'reference'], description: 'deliverable=产出 reference=资料（默认 deliverable）' },
        source: { type: 'string', enum: ['session', 'folder-import', 'manual', 'present'], description: '来源（默认 manual）。present=模型用官方 present 工具主动声明' },
        references: { type: 'array', items: { type: 'string' }, description: '引用的资料 ID 列表' },
        session_id: { type: 'string', description: '来源会话 ID（可选，自动采集会填；手动登记可省）' },
        agent_id: { type: 'string', description: '产出 agent 标识（可选）' },
      },
      required: ['path'],
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      try {
        // P2：从调用环境自动带上来源会话 ID（agent 正在哪个会话里干活就记哪个）
        const sessionId = args.session_id || _exec?.agent?.session?.id || ''
        const rec = store.register({ ...args, session_id: sessionId })
        const mention = rec.is_dir ? '' : fileMention(rec.path)
        // ⚠️ 重复登记必须说实话（2026-09-30）：`register()` 命中已有记录时**不会新建**，
        //    只返回已有那条并标 `duplicate:true`。之前这里无条件说「✅ 已登记」，
        //    让 agent 和用户都以为新加了一条 —— 那是**接口在骗人**。
        if (rec.duplicate === true) {
          return { text: `ℹ️ 这个文件**已经在产物库里了**，没有重复添加：${rec.id}「${rec.title}」 | 项目:${rec.project || '未分类'} | ${rec.path}${mention ? ` | 引用:${mention}` : ''}` }
        }
        return { text: `✅ 已登记 ${rec.id}「${rec.title}」 | ${rec.kind === 'reference' ? '资料' : '产出'} | 项目:${rec.project || '未分类'} | 类型:${rec.artifact_type} | ${rec.needsRefine ? '待精化' : '已精化'}${sessionId ? ` | 来源会话:${sessionId}` : ''}${mention ? ` | 引用:${mention}` : ''}` }
      } catch (e) {
        return { text: `❌ 登记失败：${e.message}` }
      }
    },
  })

  tools.push({
    name: 'artifact_list',
    description: '列出产物库中的产物（默认不含回收站）。可按关键词/项目/类型/标签/待精化筛选、排序。'
      + '每行末尾依次给：大小 / 修改时间 / 可粘贴的 @引用文本（可直接放进回答里引用这个产物）。'
      + '头部会如实报「命中 N 条 / 返回第 X-Y 条」，条数多于一次返回时用 offset 翻页（别猜还有多少）。'
      + 'refine=1 列出待 AI 精化的条目（摘要 / 标签 / 项目**三者缺任一项**），可配合 artifact_update 补全。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: '关键词（匹配标题/摘要/文件名/路径/正文）' },
        project: { type: 'string', description: '按项目筛选' },
        artifact_type: { type: 'string', description: '按分类筛选（分类 id 或显示名都行；不填=全部）' },
        tag: { type: 'string', description: '按标签筛选' },
        kind: { type: 'string', enum: ['deliverable', 'reference'], description: '按产出/资料筛选' },
        refine: { type: 'string', enum: ['', '1', '0'], description: '1=只看待精化 0=只看已精化' },
        status: { type: 'string', enum: ['', 'trashed', 'all'], description: 'trashed=回收站 all=含回收站' },
        sort: { type: 'string', enum: ['created_desc', 'created_asc', 'updated_desc', 'stars_desc', 'size_desc', 'name_asc'], description: '排序（size_desc 能找出最大的，行尾会给出真实大小）' },
        limit: { type: 'number', description: '本页最多返回条数，默认 50（上限 500）' },
        offset: { type: 'number', description: '从第几条开始（默认 0）。头部说还有多少条未显示时，用它翻页' },
      },
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      // ★ 先全量命中，再本地分页 —— 这样「命中 N 条」是**真实命中数**，不是被 limit 截断后的数
      const all = scanAll(store, args)
      const p = pageOf(all, args.offset, Math.min(args.limit || 50, 500))
      const activeTotal = store.items.filter((r) => r.trashed_at === null).length
      const head = `产物库共 ${activeTotal} 条（未回收），${p.describe()}：`
      const lines = p.page.map((r) => rowLine(r, store))
      return { text: lines.length ? [head, ...lines].join('\n') : `${head}\n（无）` }
    },
  })

  tools.push({
    name: 'artifact_get',
    description: '按 ID 获取产物**完整记录**（JSON）。'
      + '⚠️ 记录里含 `contentIndex` 正文快照，**最多 8000 字符、且只对 ≤2MB 的文件有** —— '
      + '若 `contentIndexTruncated` 为 true，说明**检索只覆盖了正文前一段**（字段里有 `contentIndexChars`/`contentIndexTotalChars`）。'
      + '想看正文请用 artifact_read（直接读磁盘、可分段、不受这个上限影响）；这里适合看元数据/标签/引用关系。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '产物 ID（art_ 开头）' },
      },
      required: ['id'],
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      const rec = store.get(args.id)
      return { text: rec ? jsonText(rec) : `未找到产物 ${args.id}` }
    },
  })

  tools.push({
    name: 'artifact_update',
    description: '更新产物字段：标题/摘要/项目/交付物类别/类型/标签/备注/引用资料/星级/状态。只更新传入的字段。产出用了哪些资料时填 references（资料 ID 列表）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '产物 ID' },
        title: { type: 'string' },
        summary: { type: 'string' },
        project: { type: 'string' },
        deliverable: { type: 'string' },
        artifact_type: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        references: { type: 'array', items: { type: 'string' }, description: '引用的资料 ID 列表' },
        notes: { type: 'string' },
        stars: { type: 'number', description: '0-5' },
        status: { type: 'string', enum: ['final', 'archived'] },
      },
      required: ['id'],
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      const { id, ...patch } = args
      const rec = store.update(id, patch)
      return { text: rec ? `✅ 已更新 ${id}\n${jsonText(rec)}` : `未找到产物 ${id}` }
    },
  })

  tools.push({
    name: 'artifact_trash',
    description: '把产物移入回收站（软删除，可恢复）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '产物 ID' },
      },
      required: ['id'],
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      const rec = store.trash(args.id)
      return { text: rec ? `🗑️ 已移入回收站 ${args.id}` : `未找到产物 ${args.id}` }
    },
  })

  tools.push({
    name: 'artifact_restore',
    description: '从回收站恢复产物。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '产物 ID' },
      },
      required: ['id'],
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      const rec = store.restore(args.id)
      return { text: rec ? `✅ 已恢复 ${args.id}` : `未找到产物 ${args.id}` }
    },
  })

  tools.push({
    name: 'artifact_stats',
    description: '产物库统计：总数/归档数/回收站数，以及按项目、类型、标签的分布。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute() {
      return { text: jsonText(store.stats()) }
    },
  })

  tools.push({
    name: 'artifact_search',
    description: '检索产物库：搜索标题/摘要/正文/文件名，返回匹配项及命中片段。用于"找回以前做过的产出/资料"。'
      + '⚠️ 正文索引每篇只覆盖前 8000 字符 —— 所以"搜不到"不等于"库里没有"；'
      + '读全文请用 artifact_read（它直接读磁盘，不受此限制）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: '搜索关键词（会匹配正文内容）' },
        kind: { type: 'string', enum: ['deliverable', 'reference'], description: '只搜产出或资料，缺省都搜' },
        project: { type: 'string', description: '限定项目' },
        limit: { type: 'number', description: '本页最多返回条数，默认 20' },
        offset: { type: 'number', description: '从第几条开始（默认 0）' },
      },
      required: ['q'],
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      const all = scanAll(store, { q: args.q, project: args.project })
      // kind 是本地再筛一层（store.list 的 kind 语义与这里一致，但保持原行为不变）
      const filtered = args.kind ? all.filter((r) => (args.kind === 'reference') === (r.kind === 'reference')) : all
      const p = pageOf(filtered, args.offset, args.limit || 20)
      if (!p.total) return { text: `未找到与 "${args.q}" 匹配的产物/资料` }
      const lines = p.page.map((r) => {
        // list() 为性能剥掉了 contentIndex，命中正文片段需按 id 取单条完整记录
        const full = store.get(r.id)
        const snippet = (r.summary || (full && full.contentIndex) || r.filename).replace(/\s+/g, ' ').slice(0, 160)
        const mention = r.is_dir ? '' : fileMention(r.path)
        // ★ 诚实（lead 明确要求）：正文只索引了一部分时必须说出来，
        //   否则用户会以为「搜不到 = 全文里没有」。
        const cut = full && full.contentIndexTruncated
          ? `\n   ⚠️ 正文已截断：只索引了前 ${full.contentIndexChars} 字符${full.contentIndexTotalChars ? `（原文共 ${full.contentIndexTotalChars} 字符）` : ''} —— 这条命中的是前半部分；读全文用 artifact_read（它直接读磁盘，不受此限制）`
          : ''
        return `${r.id} | ${r.kind === 'reference' ? '📚资料' : '📦产出'} | ${r.title} | ${r.project || '未分类'} | ★${r.stars} | ${humanSize(r.size_bytes)} | ${humanTime(r.file_modified_at)}\n   ${snippet}${mention ? `\n   引用: ${mention}` : ''}${cut}`
      })
      return { text: `「${args.q}」${p.describe()}：\n${lines.join('\n')}` }
    },
  })

  tools.push({
    name: 'artifact_find',
    description: '语义搜索产物库：用自然语言描述找产出/资料（B1）。适合模糊提问，如「上次那个视频素材」「给项目做的那张封面图」——会自动拆词、按标题/标签/摘要/正文加权打分召回，返回最相关的若干条及命中词。找不到时也返回最接近的候选，方便追问。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: '自然语言描述（必填），如「上次做的视频素材」「写插件时的调研文档」' },
        kind: { type: 'string', enum: ['deliverable', 'reference'], description: '只搜产出或资料，缺省都搜' },
        project: { type: 'string', description: '限定项目' },
        limit: { type: 'number', description: '本页最多返回条数，默认 10' },
        offset: { type: 'number', description: '从第几条开始（默认 0）' },
      },
      required: ['q'],
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      // ★ 语义搜索也先要全量候选再本地分页（否则「相关度最高的 N 条」里的 N 又会被 limit 悄悄截断）
      // R-4：现在是 **async**（分批让出事件循环），必须 await
      const all = await store.searchSemantic(args.q, { kind: args.kind, project: args.project, limit: MAX_SCAN })
      const p = pageOf(all, args.offset, args.limit || 10)
      if (!p.total) return { text: `没有找到与「${args.q}」相关的内容。可以换个说法试试，或用 artifact_list 全量浏览。` }
      const lines = p.page.map((h, i) => {
        const kindTag = h.kind === 'reference' ? '📚资料' : '📦产出'
        const tag = h.needsRefine ? ' [待精化]' : ''
        const rec = store.get(h.id)
        const mention = rec && !rec.is_dir ? fileMention(rec.path) : ''
        const sizeTime = rec ? `${humanSize(rec.size_bytes)} | ${humanTime(rec.file_modified_at)}` : ''
        return `${p.offset + i + 1}. ${h.id} | ${kindTag}${tag} | ${h.title} | ${h.project} | 相关度${h.score} | ${sizeTime}\n   命中词: ${h.matched.join('、')}${h.summary ? `\n   ${h.summary.slice(0, 100)}` : ''}${mention ? `\n   引用: ${mention}` : ''}`
      })
      return { text: `「${args.q}」${p.describe()}（按相关度）：\n${lines.join('\n')}` }
    },
  })

  tools.push({
    name: 'artifact_suggest_links',
    description: '连线建议（C1）：给定一个产物 ID，找出库里可能相关的产出/资料（同项目/同标签/同目录/标题相似等），用于补全 references 关联。产出用了哪些资料、或哪些产出彼此相关时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '产物 ID（art_ 开头）' },
        limit: { type: 'number', description: '最多返回条数，默认 8' },
      },
      required: ['id'],
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      const rec = store.get(args.id)
      if (!rec) return { text: `未找到产物 ${args.id}` }
      const links = store.suggestLinks(args.id, { limit: args.limit || 8 })
      if (!links.length) return { text: `「${rec.title}」暂无明显的相关条目，可继续积累。` }
      const lines = links.map((l) => `${l.id} | ${l.kind === 'reference' ? '📚资料' : '📦产出'} | ${l.title} | ${l.project} | 关联:${l.reason} | 相关度${l.score}`)
      return { text: `「${rec.title}」的相关候选 ${links.length} 条（用 artifact_update references 关联）：\n${lines.join('\n')}` }
    },
  })

  tools.push({
    name: 'artifact_suggest_cleanup',
    description: '整理建议单（C2）：扫描产物库，给出可执行的整理建议——重复记录、文件丢失、待精化条目、僵尸项目。用于定期整理汇报；用户批准后再用 artifact_trash / artifact_update 执行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute() {
      const s = store.suggestCleanup()
      const parts = [`📋 整理建议单：`]
      parts.push(`- 重复记录 ${s.duplicates.length} 组（保留最新，其余可归档）`)
      for (const d of s.duplicates.slice(0, 10)) {
        parts.push(`  · ${d.path.split(/[\\/]/).pop()} → 保留 ${d.keepId}「${d.keepTitle}」，重复: ${d.dupIds.join(', ')}`)
      }
      parts.push(`- 文件缺失 ${s.missing.length} 条（原文件被移动/删除）`)
      for (const m of s.missing.slice(0, 5)) parts.push(`  · ${m.id}「${m.title}」(${m.path})`)
      parts.push(`- 待精化 ${s.unrefinedCount} 条（摘要 / 标签 / 项目缺任一项；可在完整管理页点「立即精炼」，或用 artifact_update 补全）`)
      parts.push(`- 僵尸项目 ${s.staleProjects.length} 个（全部已归档，仅提示）`)
      for (const p of s.staleProjects.slice(0, 5)) parts.push(`  · ${p.project}（${p.count} 条）`)
      // ── 项目合并候选（2026-10-02）──────────────────────────────────────────
      // 规则层纯本地算出来的，**不是结论是候选**：只有 exact/contains 两档能直接信，
      // 另外两档要人核对。合并用 artifact_merge_projects。
      if (s.projectMerges.length) {
        parts.push(`- 项目合并 ${s.projectMerges.length} 组候选（扫了 ${s.projectsScanned} 个项目名；标记 [exact]/[contains] 的可直接信，另两档需核对）`)
        for (const g of s.projectMerges.slice(0, 8)) {
          const members = g.names.map((n) => `${n.name}(${n.count})`).join('、')
          parts.push(`  · [${g.confidence}] 「${g.canonical}」← ${members}`)
        }
      } else if (s.projectsScanned > 0) {
        parts.push(`- 项目合并：${s.projectsScanned} 个项目名里没有发现可合并的（规则层判断）`)
      }
      if (s.projectMergeUndo) {
        parts.push(`- ℹ️ 有一笔可撤销的合并：${s.projectMergeUndo.count} 条 → 「${s.projectMergeUndo.to}」（artifact_merge_projects 传 undo:true 可撤回）`)
      }
      // ── 标签归一化候选（Step 3b）──────────────────────────────────────────
      // ⚠️ 与项目合并**不同**：标签这边的目标名是规则层算好的（同串两写，无争议），
      //    所以不用标 [exact]/[contains] 那种置信度 —— 这里每一组都是 exact 级。
      //    真正的病是「829 个标签、69% 只出现一次」，而这个数字要给人看见。
      if (s.tagStats) {
        const tail = (s.tagStats.longTailRate * 100).toFixed(0)
        parts.push(`- 标签现状：不同标签 ${s.tagStats.distinct} 个，其中 ${s.tagStats.oneOff} 个只出现 1 次（长尾率 ${tail}% —— 越高说明标签越没收敛）`)
      }
      if (s.tagMerges.length) {
        parts.push(`- 标签归一化 ${s.tagMerges.length} 组（同一件事的两种写法，目标名已算好，无争议）`
          + '→ 用 **artifact_tags** 的 action=merge 执行（默认只预演，要 confirm:true 才落盘）')
        for (const g of s.tagMerges.slice(0, 8)) {
          parts.push(`  · 「${g.canonical}」← ${g.from.join('、')}（合计 ${g.total} 次引用）`)
        }
      }
      if (s.tagMergeUndo) {
        parts.push(`- ℹ️ 有一笔可撤销的标签改写：${s.tagMergeUndo.count} 条 / ${s.tagMergeUndo.groups} 组`
          + '（artifact_tags 传 action=undo-merge 可整份还原，只保留最近一次）')
      }
      return { text: parts.join('\n') }
    },
  })

  tools.push({
    name: 'artifact_merge_projects',
    description: '把若干个「项目名」合并成一个：命中的记录统一改挂到目标项目名，**原项目名转成 tag**（所以「营销创意」「短剧」这类信息不会丢，还能按它筛）。'
      + '用途：收拾「同一个项目的不同产出被记成了好多个项目」——候选从 artifact_suggest_cleanup 的「项目合并」一节拿。'
      + '⚠️ 这是**批量改写数据**：执行前必须先向用户复述「要合并哪些名字、合计多少条、合并成什么」，得到明确同意再调用；'
      + '规则给的 [prefix] / [tokens] 两档候选**不可直接信**（它们只说明名字像，不说明是同一个项目）。'
      + '传 undo:true 可撤销**最近一次**合并（会整份还原那些记录的 project 与 tags）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        names: {
          type: 'array', items: { type: 'string' },
          description: '要合并掉的项目名列表（不要包含目标名）。undo 时可省略。',
        },
        to: { type: 'string', description: '合并到哪个项目名（规范名）。undo 时可省略。' },
        keepVariantAsTag: {
          type: 'boolean',
          description: '是否把原项目名追加成 tag（默认 true；**只有用户明确说不要时才传 false**，否则那层信息就找不回来了）',
        },
        undo: { type: 'boolean', description: 'true = 撤销最近一次合并（此时忽略 names / to / keepVariantAsTag）' },
      },
      required: [],
    },
    timeoutMs: 15000,
    output: textOutput(),
    async execute(args) {
      if (args && args.undo === true) {
        const r = store.undoProjectMerge()
        if (!r.ok) return { text: `❌ 撤销失败：${r.error}` }
        // ⚠️ `warning` **必须转达**（2026-10-08 · 修 F3 时发现的第一版漏洞）：
        //    记录已还原、但「凭据已用掉」没落盘时 store 回 `ok:true + warning`。
        //    工具若把它吃掉，agent 就**看不到**"重启后这份凭据可能还在" —— 等于静默。
        return { text: `↩️ 已撤销上次合并：${r.restored} 条记录的 project / tags 恢复原样（原本合并到「${r.to}」）`
          + (r.warning ? `\n\n⚠️ ${r.warning}` : '') }
      }
      const names = Array.isArray(args && args.names) ? args.names : []
      const to = typeof (args && args.to) === 'string' ? args.to : ''
      if (!names.length || !to) {
        return { text: '❌ 需要同时给 names（要合并掉的项目名数组）和 to（合并到的名字）。若想撤销上次合并，传 undo:true。' }
      }
      const r = store.mergeProjects({
        names,
        to,
        keepVariantAsTag: !(args && args.keepVariantAsTag === false),
      })
      if (!r.ok) return { text: `❌ 合并未执行：${r.error}` }
      return {
        text: `✅ 已合并 ${r.changed} 条记录 → 项目「${r.to}」\n`
          + `   并入的原项目名：${r.from.join('、')}\n`
          + `   ${r.tagsAdded} 条记录的原项目名已转成 tag（可按标签筛回来）\n`
          + '   如要退回：artifact_merge_projects 传 undo:true（只保留最近一次）。',
      }
    },
  })

  tools.push({
    name: 'project_overview',
    description: '快速了解某项目（或全部）的产出与资料：列出该项目的交付物和参考资料清单及摘要。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: '项目名，缺省返回全部项目总览' },
      },
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      return { text: jsonText(store.overview(args.project)) }
    },
  })

  tools.push({
    name: 'artifact_read',
    description: '读取产物库里一个**已登记的文本产物**的正文（md/代码/日志/json/csv 等），**支持分段读大文件**。'
      + '用 id 或 path 指定（二选一）。返回会如实告知：总字符数、本次返回的区间、是否还有后续（用 offset 续读）、以及可粘贴的 @引用文本。'
      + '图片/视频/压缩包等二进制会**明确拒绝**并给出路径，不会吐乱码。'
      + '⚠️ 只能读**已登记进产物库**的文件 —— 这是有意的边界，避免它变成任意读盘的口子。没登记就先 register_artifact。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '产物 ID（art_ 开头）' },
        path: { type: 'string', description: '产物文件的绝对路径（与 id 二选一；必须是已登记的文件）' },
        offset: { type: 'number', description: '从第几个字符开始读（默认 0）。上次返回说还有后续时，用它续读' },
        limit: { type: 'number', description: '本次最多返回多少字符，默认 4000，上限 50000' },
      },
    },
    timeoutMs: 15000,
    output: textOutput(),
    async execute(args, _exec) {
      // 解析记录：id 优先；再按路径查（**必须已登记**）
      let rec = null
      if (typeof args.id === 'string' && args.id.trim()) {
        rec = store.get(args.id.trim())
        if (!rec) return { text: `未找到产物 ${args.id}。可以先用 artifact_search（关键词）或 artifact_find（自然语言）找到它。` }
      } else if (typeof args.path === 'string' && args.path.trim()) {
        rec = store.byPath(args.path.trim())
        if (!rec) {
          return { text: `这个路径**不在产物库里**：${args.path}\nartifact_read 只读已登记的产物（有意为之的安全边界）。\n· 想读它就先 register_artifact 登记；\n· 或者用 artifact_search / artifact_find 找一个已登记的同名产物。` }
        }
      } else {
        return { text: '需要 id 或 path 之一。先用 artifact_search / artifact_find / artifact_list 拿到 id。' }
      }

      if (rec.is_dir) return { text: `「${rec.title}」是一个目录（${rec.path}），没有正文可读。用 artifact_list 或文件浏览看里面的内容。` }
      if (rec.exists === false) return { text: `「${rec.title}」的原文件已经不在了（${rec.path}）。可能被移动或删除；可用 artifact_update 更新记录，或 artifact_trash 清理。` }

      const ext = String(rec.extension || '').toLowerCase()
      if (ext && !TEXT_EXT.has(ext)) {
        return { text: `「${rec.title}」是 ${ext} 文件（${humanSize(rec.size_bytes)}），**不是文本**，读出来会是乱码，所以不读。\n路径: ${rec.path}${fileMention(rec.path) ? `\n引用: ${fileMention(rec.path)}` : ''}` }
      }

      let size = Number(rec.size_bytes) || 0
      try { size = fs.statSync(rec.path).size } catch { /* 用记录里的快照 */ }
      if (size > READ_MAX_BYTES) {
        return { text: `「${rec.title}」有 ${humanSize(size)}，超过 artifact_read 的上限（${humanSize(READ_MAX_BYTES)}），没有读。\n路径: ${rec.path}\n（大文件请用别的办法：例如在终端里 head/tail，或读磁盘上的分片文件。）` }
      }

      let raw
      try {
        raw = fs.readFileSync(rec.path, 'utf8')
      } catch (e) {
        return { text: `读取失败：${e.message}\n路径: ${rec.path}` }
      }

      const total = raw.length
      const offset = Math.max(0, Math.trunc(Number(args.offset)) || 0)
      const limit = Math.max(1, Math.min(Math.trunc(Number(args.limit)) || READ_DEFAULT_CHARS, READ_MAX_CHARS))
      const slice = raw.slice(offset, offset + limit)
      const next = offset + slice.length
      const truncated = next < total

      const mention = fileMention(rec.path)
      const footer = [
        '---',
        `产物: ${rec.id}「${rec.title}」| 类型:${rec.artifact_type} | 项目:${rec.project || '未分类'}`,
        `路径: ${rec.path}`,
        mention ? `引用: ${mention}` : '',
        `正文: 共 ${total} 字符，本次返回第 ${offset}-${next} 字符（${truncated ? `还有 ${total - next} 字符未读，用 offset=${next} 续读` : '已到结尾'}）`,
      ].filter(Boolean).join('\n')

      return { text: `${slice}\n\n${footer}` }
    },
  })

  tools.push({
    name: 'artifact_categories',
    description: '查看/自定义产物库的**分类**（分类 = 每条记录的 artifact_type 指向的东西；例如「文档/图片/代码/…」）。'
      + '分类是**用户可改的设置**，不是写死的枚举 —— 所以用户说「帮我加一个『短剧素材』分类，认 mp4 和 srt」时用这个工具。'
      + 'action=list 先看现状（含每个分类下有几条、哪些记录的分类已经失效）；'
      + 'add/update 加或改（后缀用 exts 传，不带点、小写）；'
      + 'remove 删（**必须先指定 reassign_to**，把该分类下的记录改派到别处 —— 不说改到哪就不会动手）。'
      + '⚠️ 分类一旦删掉，指向它的记录就会变成孤儿，所以删除是「先改派、再删」两步，且可撤销。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'undo-remove'], description: '要做什么（默认 list）' },
        id: { type: 'string', description: '分类 id：小写字母开头，只能含小写字母/数字/下划线/连字符，≤32 字符（如 code、short_drama）' },
        label: { type: 'string', description: '显示名，给用户看的（如「短剧素材」），≤24 字' },
        icon: { type: 'string', enum: CATEGORY_ICONS, description: '图标形状名（颜色由主题决定，不能指定颜色）' },
        exts: { type: 'array', items: { type: 'string' }, description: '这个分类认哪些文件后缀（不带点、小写，如 ["mp4","srt"]）。**只用于新登记的默认归类和筛选归类，不会改写已有记录**' },
        reassign_to: { type: 'string', description: 'action=remove 时必填：该分类下的记录改成哪个分类（分类 id 或显示名）' },
      },
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args) {
      const action = String(args.action || 'list')
      const table = settingsStore.get().categories

      // ── list：把现状说全（含计数与孤儿），让 agent 能直接念给用户 ──────────
      if (action === 'list') {
        const live = store.items.filter((r) => r.trashed_at === null)
        const g = groupByCategory(live, table)
        const lines = g.buckets.map((b) => `  ${b.locked ? '🔒' : '  '} ${b.id.padEnd(14)} ${String(b.label).padEnd(8)} ${String(b.count).padStart(4)} 条  后缀: ${(table.find((c) => c.id === b.id)?.exts || []).join(' ') || '(无)'}`)
        const out = [`产物库分类（共 ${g.buckets.length} 个，合计 ${g.total} 条）：`, ...lines]
        if (g.orphans.length) {
          out.push('', `⚠️ 有 ${g.orphans.length} 个分类**已经不在分类表里了，但还有记录指向它**（孤儿）：`)
          for (const o of g.orphans) out.push(`  ${o.id}  ${o.count} 条`)
          out.push('（这些记录不会消失，但界面上会以 id 显示。要么用 add 把该 id 加回来，要么用 artifact_update 逐条改掉。）')
        }
        out.push('', `可用图标：${CATEGORY_ICONS.join(' / ')}`)
        out.push('「未分类」是兜底分类，不可删 —— 它保证任何记录都不会失联。')
        return { text: out.join('\n') }
      }

      // ⚠️ 分支顺序要紧：`list` / `undo-remove` **不需要 id**，不能放在 id 校验后面。
      //    第一版就是先校验 id 再分派，于是 `action=list` 和「不认识的 action」
      //    都会被一句「分类 id 不能为空」挡掉、永远走不到自己的分支。
      //    （test/tools-agent.test.mjs §N 的三条「❌ 分类 id 不能为空」就是它。）
      const idCheck = checkCategoryId(table, args.id)
      const id = idCheck.ok ? idCheck.id : ''

      // ── undo-remove：先把记录还原，再把分类加回表 ────────────────────────
      if (action === 'undo-remove') {
        const undone = store.undoCategoryRemoval()
        if (!undone.ok) return { text: `❌ ${undone.error}` }
        const back = table.find((c) => c.id === undone.from)
        let readded = false
        if (!back) {
          // 分类本身已经不在表里 → 用最小信息把它加回去（label 暂时就用 id，用户可再改）
          const restored = validateCategories(mergeCategories(table, [{ id: undone.from, label: undone.from, icon: 'other', exts: [] }]))
          if (restored.ok) { settingsStore.update({ categories: restored.value }); readded = true }
        }
        // ⚠️ `warning` 必须转达（理由同上面 `undoProjectMerge` 那处注释）：吃掉它 = 静默。
        return { text: `✅ 已撤销上次的分类改派：${undone.restored} 条记录的分类改回了「${undone.from}」${readded ? '，并把它加回了分类表（显示名暂用 id，可以用 update 改成想要的名字）' : ''}。`
          + (undone.warning ? `\n\n⚠️ ${undone.warning}` : '') }
      }

      // ── add / update：合并式写入（只增改，不动别人）────────────────────────
      if (action === 'add' || action === 'update') {
        if (!idCheck.ok) return { text: `❌ ${idCheck.reason}` }
        const exists = table.some((c) => c.id === id)
        if (action === 'add' && exists) return { text: `❌ 分类 ${id} 已经存在了（要改它请用 action=update）` }
        if (action === 'update' && !exists) return { text: `❌ 没有叫 ${id} 的分类（要新建请用 action=add）。当前有：${table.map((c) => c.id).join(' / ')}` }
        if (id === LOCKED_CATEGORY_ID) return { text: `❌ 「${LOCKED_CATEGORY_ID}」是兜底分类，不能改也不能删（它保证任何记录都不会失联）` }

        const patch = { id }
        if (args.label !== undefined) patch.label = args.label
        if (args.icon !== undefined) patch.icon = args.icon
        if (args.exts !== undefined) patch.exts = args.exts
        // `add` 时缺 label/icon/exts 要有合理默认，否则 validateCategories 会因为空 label 直接拒
        if (action === 'add') {
          if (patch.label === undefined) return { text: `❌ 新建分类必须给 label（显示名）` }
          if (patch.icon === undefined) patch.icon = 'other'
          if (patch.exts === undefined) patch.exts = []
        }
        const merged = mergeCategories(table, [patch])
        const checked = validateCategories(merged)
        if (!checked.ok) return { text: `❌ 分类没通过校验：${checked.reason}` }
        const r = settingsStore.update({ categories: checked.value })
        if (r.errors.length) return { text: `❌ 写入失败：${r.errors.map((e) => e.key + ': ' + e.reason).join('；')}` }
        const cat = checked.value.find((c) => c.id === id)
        const notes = (r.notes || []).concat(checked.notes || [])
        return {
          text: `${action === 'add' ? '✅ 已新建' : '✅ 已更新'}分类「${cat.label}」(${cat.id}) 图标:${cat.icon} 后缀:${cat.exts.join(' ') || '(无)'}`
            + (notes.length ? `\n⚠️ ${notes.join('\n⚠️ ')}` : '')
            + `\n共 ${checked.value.length} 个分类。后缀只影响**新登记**的默认归类，已有记录一条都没动。`,
        }
      }

      // ── remove：先改派、再删（顺序不能反）────────────────────────────────
      if (action === 'remove') {
        if (!idCheck.ok) return { text: `❌ ${idCheck.reason}` }
        if (id === LOCKED_CATEGORY_ID) return { text: `❌ 「${LOCKED_CATEGORY_ID}」是兜底分类，不可删除（它保证任何记录都不会失联）` }
        if (!table.some((c) => c.id === id)) return { text: `❌ 没有叫 ${id} 的分类` }
        let target = String(args.reassign_to || '').trim()
        if (target) {
          const found = findCategory(table, target)
          if (!found) return { text: `❌ reassign_to「${target}」不是一个已知分类。当前有：${table.map((c) => c.id).join(' / ')}` }
          target = found.id
          if (target === id) return { text: `❌ reassign_to 和要删的分类相同（都是 ${id}），没有可改的记录` }
        }
        // 先改派记录（这一步不做任何不可逆的事：没有 reassign_to 时它只回报影响面）
        const moved = store.reassignArtifactType(id, { reassignTo: target })
        if (!moved.ok) {
          return {
            text: `⚠️ 没有删除 ${id}，因为${moved.affected ? `它下面还有 ${moved.affected} 条记录：\n  ${(moved.sample || []).join('\n  ')}${moved.affected > 3 ? `\n  …还有 ${moved.affected - 3} 条` : ''}\n请先告诉我这些记录改成哪个分类（reassign_to），我再动手。` : ` ${moved.error}`}`,
          }
        }
        // 改派成功后才从表里去掉 —— 顺序反了的话，中途失败会留下孤儿
        const stripped = validateCategories(table.filter((c) => c.id !== id))
        if (!stripped.ok) return { text: `⚠️ 记录已改派（${moved.changed} 条 → ${moved.to}），但分类表更新失败：${stripped.reason}` }
        const w = settingsStore.update({ categories: stripped.value })
        if (w.errors.length) return { text: `⚠️ 记录已改派（${moved.changed} 条 → ${moved.to}），但分类表更新失败：${w.errors.map((e) => e.reason).join('；')}` }
        return {
          text: moved.changed === 0
            ? `✅ 已删除分类「${id}」（它下面没有记录，不需要改派）。`
            : `✅ 已删除分类「${id}」，${moved.changed} 条记录改派到了「${moved.to}」。\n`
              + `撤销：action=undo-remove（会把记录改回 ${id}，并把它加回分类表）。`,
        }
      }

      return { text: `❌ 不认识的 action「${action}」（只接受 list / add / update / remove / undo-remove）` }
    },
  })

  // ══════════════════════════════════════════════════════════════════════════
  // artifact_tags —— 标签治理（Step 3c）
  //
  // 依琪原话：「**标签系统**（视频/视频项目/图片项目/学业作业/调研研究/代码bug/备份等）」
  //           「**精炼不只合并相似项目还可细分标签**」
  //           「让 **ai 小白也能通过 agent 快速设置**」
  //
  // 实测现状（2026-10-07）：260 条有效记录里有 **840 个不同标签、580 个只出现一次**（69%）。
  // ⇒ 病不是"标签不够用"，是**没收敛**。这个工具就是那件事的入口。
  //
  // ⚠️ 两条**安全约定**（与 artifact_categories 的 remove 同一套路）：
  //   1. **所有写操作默认 dry-run**：不传 `confirm: true` 就只回报影响面、一个字不改。
  //      理由：这是**唯一会改写已有记录内容**的操作，一次可能动十几条，
  //      而且它没有"按文件名回滚"这种便宜的第二条路（只能靠撤销凭据）。
  //   2. **两个动作的分工必须让 agent 分得清**（见下），别让它自己发明大类名。
  // ══════════════════════════════════════════════════════════════════════════
  tools.push({
    name: 'artifact_tags',
    description: '查看和整理产物库的**标签**。标签是"什么活"那根轴（多对多、人写的语义），'
      + '与「分类」（看是什么文件、由后缀驱动、唯一）不是一回事。'
      + 'action=list 看现状（不同标签数 / 长尾率 / **重复组明细**）；'
      + 'action=suggest 看**同族线索**（只读：哪些标签同前缀，可能是同一件事，也可能不是）；'
      + 'action=merge 把「同一个标签的两种写法」并成一个（如 `DSH`/`dsh`、`Godot`/`godot`）—— '
      + '**目标名由规则算好、无争议**，一次可以把全部重复组都收敛掉；'
      + 'action=rename 显式改名 / 归成大类（如把 `超星`、`弹幕梗` 都归成「学业」）—— '
      + '那是**人的决定**，所以必须由你（或用户）给出目标名，工具不替你猜；'
      + 'action=undo-merge 撤销**最近一次**标签改写（merge 和 rename 共用一份凭据）。'
      + '⚠️ **merge 与 rename 都默认只预演、不落盘** —— 要传 `confirm: true` 才真的改。'
      + '执行前**必须先把影响面复述给用户**（改哪几条、改成什么），得到同意再落盘。'
      + '⚠️ merge 拒绝「具体→抽象」的重分类（`超星`→`学业` 会被拒并提示改走 rename）—— '
      + '那是**有意的范围边界**，不是 bug。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'suggest', 'merge', 'rename', 'undo-merge'],
          description: '要做什么（默认 list）',
        },
        confirm: {
          type: 'boolean',
          description: 'merge / rename 时**必须显式传 true 才会真的落盘**；不传或传 false 只预演、一个字不改',
        },
        groups: {
          type: 'array',
          description: '要执行的改写组：[{canonical:"保留哪个写法", from:["要改掉哪些写法"]}]。'
            + 'merge 不传就用规则层算出来的全部重复组；rename 必须传（目标名可以是库里还没有的新标签名）。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              canonical: { type: 'string', description: '保留 / 要变成的那个标签名' },
              from: { type: 'array', items: { type: 'string' }, description: '要改掉的写法' },
            },
            required: ['canonical', 'from'],
          },
        },
        from: { type: 'string', description: 'rename 的简写：要改掉的单个标签（与 to 配对用，等价于 groups 里一组）' },
        to: { type: 'string', description: 'rename 的简写：改成什么（与 from 配对用）' },
        limit: { type: 'number', description: 'list / suggest 最多列多少行（默认 20，上限 100）' },
      },
    },
    timeoutMs: 15000,
    output: textOutput(),
    async execute(args) {
      const a = args || {}
      const action = String(a.action || 'list')
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100)
      const tagCount = () => store.tagCounts()
      const pct = (n) => (n * 100).toFixed(0) + '%'

      // ── list：现状（含重复组明细 —— 这是"能收敛多少"的答案）──────────────
      if (action === 'list') {
        const counts = tagCount()
        const st = tagStats(counts)
        const dup = findTagDuplicates(counts)
        const out = [
          `产物库标签（${store.items.filter((r) => r.trashed_at === null).length} 条记录里）：`,
          `  不同标签 ${st.distinct} 个 · 只出现 1 次 ${st.oneOff} 个（长尾率 ${pct(st.longTailRate)}）`,
          '',
          `最常见的 ${Math.min(limit, st.top.length)} 个：`,
        ]
        for (const t of st.top.slice(0, limit)) out.push(`  ${String(t.count).padStart(4)} 次  ${t.tag}`)
        if (dup.groups.length) {
          out.push('', `🔁 同一个标签的两种写法：**${dup.groups.length} 组 / 涉及 ${dup.duplicateTags} 个标签**`,
            '（这些是纯去重、目标名无争议 —— 用 action=merge 一次收敛掉；默认只预演）')
          for (const g of dup.groups.slice(0, limit)) {
            out.push(`  「${g.canonical}」 ← ${g.from.join('、')}（合计 ${g.total} 次引用）`)
          }
        } else {
          out.push('', '🔁 没有发现「同一个标签的两种写法」（已经收敛过了）。')
        }
        const undo = store.suggestCleanup().tagMergeUndo
        if (undo) {
          out.push('', `ℹ️ 有一笔可撤销的标签改写：${undo.count} 条 / ${undo.groups} 组`
            + `（action=undo-merge 可整份还原，只保留最近一次）`)
        }
        out.push('', '⚠️ 长尾率越高说明标签越没收敛；但**那些只出现一次的具体标签不要去动** ——',
          '   它们（`超星`、`第213章`、`1080p`）是用户当时记下的信息，归成大类要用 rename 由人决定。')
        return { text: out.join('\n') }
      }

      // ── suggest：只读线索（绝不自动改）────────────────────────────────────
      if (action === 'suggest') {
        const counts = tagCount()
        const families = suggestTagFamilies(counts)
        const out = ['🏷️ 标签同族线索（**只读建议，不会自动改**）：']
        if (!families.length) {
          out.push('  没有发现同前缀的标签族。')
        } else {
          for (const f of families.slice(0, limit)) {
            out.push(`  「${f.prefix}」← ${f.tags.map((t) => `${t.tag}(${t.count})`).join('、')}`)
          }
          // ⚠️ warning 必须转达：同前缀 ≠ 同一件事，真实数据里就有反例
          out.push('', `  ⚠️ ${families[0].warning}`)
        }
        const st = tagStats(counts)
        out.push('', `📊 长尾：不同标签 ${st.distinct} 个，其中 ${st.oneOff} 个只出现 1 次（${pct(st.longTailRate)}）。`,
          '  它们多数**具体而正确**，不要为了"收敛"把它们并掉 ——',
          '  要归成「学业」「调研」这种大类，请用 rename 明确给出目标名（那是人的决定）。')
        return { text: out.join('\n') }
      }

      // ── undo-merge：撤销最近一次（merge / rename 共用一份凭据）────────────
      if (action === 'undo-merge') {
        const r = store.undoTagMerge()
        if (!r.ok) return { text: `❌ 撤销失败：${r.error}` }
        const what = r.mode === 'rename' ? '改名' : '归一化'
        // ⚠️ `warning` 必须转达（理由同上面 `undoProjectMerge` 那处注释）：吃掉它 = 静默。
        return { text: `↩️ 已撤销上次标签${what}：${r.restored} 条记录的标签恢复原样（涉及 ${r.groups} 组）。`
          + (r.warning ? `\n\n⚠️ ${r.warning}` : '') }
      }

      // ── 组装 groups：merge 可省略（用规则层的），rename 必须给 ────────────
      //
      // ⚠️⚠️ **"没传 groups" 与 "传了但不是数组" 必须分开**（2026-10-08 · verifier-3c 逮到，
      //    我原来写的是 `Array.isArray(a.groups) ? a.groups : null` —— 把两者混成同一个 null）：
      //
      //    那个写法等于**同一个值承载两种语义**（本仓库反复栽的那一类）：
      //      · `a.groups === undefined` ⇒ "他没指定" ⇒ **降级成全库重复组**（合理）
      //      · `a.groups === 42`        ⇒ **agent 类型写错了** ⇒ 也降级成全库！
      //    ⇒ 叠加"省略 groups + confirm:true 会跳过预演直接整库改写"，
      //      就成了**一个类型失误被放大成整库改写**的链路，而工具描述明明写着
      //      "执行前必须先把影响面复述给用户"—— 却**没有代码强制**。
      //    ⇒ 实测复现：`{action:'merge', confirm:true, groups:42}` 会真的改数据，
      //      而 **store 层对同样入参是明确报错的**（`ok:false`）—— 只有工具层放行。
      //    ⇒ **所以：给了但类型不对 ⇒ 明确报错，并提示"想全库请干脆别传 groups"。**
      if (a.groups !== undefined && a.groups !== null && !Array.isArray(a.groups)) {
        return {
          text: `❌ groups 要是**数组**（形如 \`[{canonical:"保留哪个", from:["改掉哪些"]}]\`），`
            + `收到的是 ${typeof a.groups}：${JSON.stringify(a.groups)}\n`
            + '   · 想**只改指定的几组** ⇒ 传数组\n'
            + '   · 想**收敛全库的重复组** ⇒ **干脆不要传 groups**（省略这个参数）\n'
            + '⚠️ 没有替你猜哪种意思 —— 类型写错时降级成"整库改写"是最坏的结果。',
        }
      }
      let groups = Array.isArray(a.groups) ? a.groups : null
      if (!groups && typeof a.from === 'string' && typeof a.to === 'string' && a.from && a.to) {
        groups = [{ canonical: a.to, from: [a.from] }]
      }

      if (action === 'merge') {
        if (!groups) {
          // 不传就用规则层算好的全部重复组 —— 这正是"无争议"的那部分
          groups = planTagMerge(findTagDuplicates(tagCount()).groups)
          if (!groups.length) {
            return { text: '✅ 没有需要归一化的标签（库里已经没有「同一件事的两种写法」了）。' }
          }
        }
        const dry = store.mergeTags({ groups, dryRun: true })
        if (!dry.ok) return { text: renderTagFailure('归一化', dry) }
        // ★ 第三态：合法但**无事可做**。这**不是**失败 —— 别印 ❌（原来是 `❌ 不能这样归一化`，
        //   那是一句假话：请求完全合法，只是那些写法本来就不在库里 / 已经改过了）。
        if (dry.noop) return { text: renderTagNoop('归一化', dry, { confirmed: a.confirm === true }) }
        if (a.confirm !== true) {
          return { text: `${renderTagPlan('归一化（同一件事的两种写法）', dry, limit)}\n\n⚠️ **这只是预演，一个字都没改。**\n`
            + '请把上面这些改动**复述给用户并得到同意**，然后再调一次并传 `confirm: true`。' }
        }
        const real = store.mergeTags({ groups })
        if (!real.ok) return { text: renderTagFailure('归一化', real) }
        // ★ 两段式窗口：预演说会改、真跑时一条都没命中 ⇒ 库在这两次调用**之间变了**
        //   （自动采集 / 别的会话在写）。必须**如实说**，不许照「已改写 0 条」渲染。
        if (real.noop) return { text: renderTagNoop('归一化', real, { confirmed: true, dry }) }
        return { text: `${renderTagPlan('归一化（同一件事的两种写法）', real, limit, { preview: false })}\n\n`
          + `✅ 已改写 ${real.changed} 条记录、去掉 ${real.tagsRemoved} 个重复标签。\n`
          + '   如要退回：artifact_tags 传 action=undo-merge（只保留最近一次）。' }
      }

      if (action === 'rename') {
        if (!groups) {
          return {
            text: '❌ rename 需要你**明确给出改法**：groups（[{canonical:"改成什么", from:["改哪些"]}]）'
              + '，或用简写 from + to。\n'
              + '⚠️ 与 merge 不同，rename 的目标名不会被规则层算出来 —— 因为"归成哪个大类"是**人的决定**。\n'
              + '（想先看有哪些值得整理的线索，用 action=suggest 或 action=list。）',
          }
        }
        const dry = store.renameTags({ groups, dryRun: true })
        if (!dry.ok) return { text: renderTagFailure('改名', dry) }
        // ★ 同 merge：0 命中不是失败（见 `renderTagNoop`）
        if (dry.noop) return { text: renderTagNoop('改名', dry, { confirmed: a.confirm === true }) }
        if (a.confirm !== true) {
          return { text: `${renderTagPlan('改名 / 归并', dry, limit)}\n\n⚠️ **这只是预演，一个字都没改。**\n`
            + '⚠️ rename 会**丢掉被改掉的那个标签名**（与 merge 不同，它跨语义），'
            + '所以更要先跟用户确认。\n'
            + '确认后请再调一次并传 `confirm: true`。' }
        }
        const real = store.renameTags({ groups })
        if (!real.ok) return { text: renderTagFailure('改名', real) }
        if (real.noop) return { text: renderTagNoop('改名', real, { confirmed: true, dry }) }
        return { text: `${renderTagPlan('改名 / 归并', real, limit, { preview: false })}\n\n`
          + `✅ 已改写 ${real.changed} 条记录、去掉 ${real.tagsRemoved} 个重复标签。\n`
          + '   如要退回：artifact_tags 传 action=undo-merge（只保留最近一次）。' }
      }

      return { text: `❌ 不认识的 action「${action}」（只接受 list / suggest / merge / rename / undo-merge）` }
    },
  })

  tools.push(managedTagStylesTool(settingsStore))

  const disposers = []
  for (const tool of tools) disposers.push(ctx.tools.register(tool))
  return () => { for (const d of disposers) d() }
}

/* ══════════════════════════════════════════════════════════════════════════
 * artifact_tag_styles —— 受管标签表（Step 3d 接线）
 *
 * 缺口来自设计定稿 §四·5：「让用户/agent 能编辑受管表」。规则层（lib/tag-styles.js）
 * 只管校验，**不管存储、不管 UI** —— 存储在这里（settings 的 content 层）落地。
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 把一张**受管标签表**渲染成人话（`artifact_tag_styles` 的 list 与 set 共用）。
 *
 * ⚠️ 抽成一个函数而不是两处各写一遍：这是**同一件事的两种展示**，
 *   写两份的下场就是本仓库骂过的「同一件事写两份，然后互相漂移」。
 *
 * `budget` 里 **`unlimited` 是判断「不限」的唯一依据**（不是 `limit === null` 自己推）——
 * 规则层把语义字段和数值字段分开就是为这个（见 `MANAGED_TAG_LIMIT_UNLIMITED` 的注释）。
 */
function renderManagedTable(v, budget, notes, title) {
  const cap = budget.unlimited ? '不限（limit: null）' : `${budget.limit} 个`
  const lines = [`🏷️ ${title}：共 ${v.tags.length} 条，上限 ${cap}`
    + (budget.unlimited ? '' : `（已用 ${budget.count}，还剩 ${budget.free} 个位）`)]
  for (const it of v.tags) {
    const style = TAG_STYLE_FIELDS.filter((f) => it[f] !== undefined).map((f) => `${f}=${it[f]}`).join(' ')
    lines.push(`  ${String(it.id).padEnd(18)} ${String(it.tag).padEnd(14)} ${style || '（无样式 —— 照样是受管的）'}`)
  }
  if (!v.tags.length) lines.push('  （空表：所有标签都会渲染成素净的自由关键词）')
  for (const n of notes || []) lines.push('  ⚠️ ' + n)
  return lines
}

/**
 * 受管标签表（醒目样式）的**读写入口** —— 规则层管校验，这里管「让 agent 能改到它」。
 *
 * ⚠️ 为什么不并进 `artifact_tags`（同一件事都在标签那边不是更省事吗）——
 *   那个工具的 `limit` 参数已经是「列表最多显示几行」，而这里要一个**上限**；
 *   两个同名不同义的 `limit` 塞进一个工具，就是本仓库反复栽的
 *   「同一个值/名字承载两种语义」。而且两件事的**动作面**根本不同：
 *     · `artifact_tags`       → 改写**记录里的标签**（多对多、语义轴、有撤销凭据）
 *     · `artifact_tag_styles` → 改**配置**（哪个标签带什么样式），**一条记录都不碰**
 *   合成一个工具，`confirm` 的 dry-run 语义就只对其中一半动作成立 —— agent 更容易用错。
 *
 * 三条与 3c 的 `artifact_tags` **刻意一致**的安全约定：
 *   1. **默认 dry-run**：不传 `confirm: true` 只回报影响面，一个字不改；
 *   2. **超限只报告、绝不腾位**（规则层只拒绝，这里也不替谁顶掉最旧的）；
 *   3. **改数据前必过规则层的闸门**（见 `set` 分支里那句大注释：入口只有一个）。
 */
function managedTagStylesTool(settingsStore) {
  const readManaged = () => {
    const all = settingsStore.get()
    const cur = all && all.managedTags
    // 「读不到」（老调用方没接设置存储）与「空表」是两件事：前者落回默认预设。
    return cur === undefined ? DEFAULT_MANAGED_TAGS : cur
  }
  return {
    name: 'artifact_tag_styles',
    description: '查看/自定义产物库的**受管标签表** —— 也就是「哪几个标签带图标、颜色、字重」那张表。'
      + '用户说「标签都一样素，想用图标和颜色把标签分得更醒目」时用这个。'
      + '⭐ 判据：**进过受管表 = 受管**（不是「有没有样式」）—— 所以样式只是「进过表」的结果；'
      + '没配样式的条目照样是受管的（可以自动打、可以被改名/合并）。'
      + 'action=list 先看现状（每个标签的 id/样式 + 上限 + 可选色板与图标）；'
      + 'action=set 改它（**整表替换**语义：传 `tags` 就是整份新表，想清空传 `[]`；'
      + '只传 `limit` 就是只改上限）。⚠️ **set 默认只预演、不落盘** —— 要传 `confirm: true` 才真的改，'
      + '执行前必须先把影响面复述给用户并得到同意。'
      + '⚠️ 颜色**只收色板槽名**（hex 一律拒：写死颜色在深色主题下不跟随）；'
      + '图标只收 icons.js 里已有的形状名（自造名字会得到「配置合法但渲染空白」）。'
      + '⚠️ 改这里**不会动任何一条记录**（它只决定标签渲染成什么样）—— 要改记录里的标签用 artifact_tags。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'set'], description: '要做什么（默认 list）' },
        tags: {
          type: 'array',
          description: '【set】受管标签条目，**整表替换**（不是追加）：`[{id, tag, color?, icon?, weight?, size?}]`。'
            + 'id 必须 /^[a-z][a-z0-9_-]{0,31}$/（如 mt_godot）；`tag` 是记录里**逐字出现**的字符串'
            + '（不许带首尾空白 —— 带空白永远匹配不到记录，是死配置）；想清空就传 `[]`。'
            + '不传 = 保持当前条目不动。',
          items: {
            type: 'object',
            // ⚠️ **刻意不写 `additionalProperties: false`**：规则层对未知字段的处置是
            // 「进 notes 并点名该写哪个键」（比如写 `bold:true` → 提示「要写的是 weight」）。
            // 在 schema 层就拒掉，会把那条**可执行的纠正提示**换成一句干巴巴的类型错误。
            properties: {
              id: { type: 'string', description: '稳定身份，小写字母开头（改名时靠它把样式跟住）' },
              tag: { type: 'string', description: '记录 rec.tags 里**逐字**出现的那个字符串' },
              color: { type: 'string', description: `色板槽名（${TAG_COLOR_SLOTS.join('/')}），**hex 一律拒**` },
              icon: { type: 'string', description: `图标形状名（${TAG_ICONS.join('/')}）` },
              weight: { type: 'string', description: `${TAG_WEIGHTS.join(' / ')}` },
              size: { type: 'string', description: `${TAG_SIZES.join(' / ')}（⚠️ 只在**分组标题**上生效，芯片上会被摘掉）` },
            },
            required: ['id', 'tag'],
          },
        },
        limit: {
          type: 'number',
          description: '【set】受管标签**上限**（≥1 的整数）。不传 = 保持当前值。'
            + '⚠️ **别传 0** —— 规则层**不猜** `0` 的意思（「不限」和「一个都不许」都有人这么写），'
            + '会拒掉整张表；要「不限」请传 `unlimited: true`。默认本来就是不限，没事不用动它。',
        },
        unlimited: {
          type: 'boolean',
          description: '【set】true = **取消上限**（存储里写成 `null` = 不限，默认就是这个）。'
            + '与 `limit` 同时给会报错 —— 一个参数不该同时说「不限」和「限 N 个」。',
        },
        confirm: {
          type: 'boolean',
          description: '【set】**必须显式传 true 才会真的落盘**；不传或传 false 只预演、一个字不改',
        },
      },
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args) {
      const a = args || {}
      const action = String(a.action || 'list')

      // ⚠️⚠️ **先问「磁盘上那份还在不在」，再看值** —— 顺序反了下面那道闸门就是**空转**的。
      //
      //   `SettingsStore.get()` 会拿默认值把**被丢掉**的键补上 ⇒ 到这里 `readManaged()`
      //   永远给得出一个合法值，`validateManagedTagSettings` 只可能验到「默认预设」，
      //   **永远为真**。而这个工具恰恰是 agent 唯一能看见这张表的窗口 ——
      //   它会照着一份**幻影表**干活。
      //
      //   实测（2026-10-08，独立探针，不是推演）：手改 / 同步工具把
      //   `settings.json` 里的 `limit` 写成 `0` ⇒
      //     · `list` 把 8 条默认预设报成「他的受管表」；
      //     · `set unlimited:true`（agent 以为在「只把上限去掉」）**把默认预设
      //       落成了他的配置** —— 一次静默的整表替换。
      //   端点那边（`GET /managed-tags`）是同一个病，已一并修；两处都修了才算修完
      //   （3c 的教训：只覆盖一个消费者，另一个漏掉时测试会全绿）。
      const probe = droppedSettingsKeys(settingsStore)
      if (!probe.ok) {
        return {
          text: `❌ 接线不完整，**不敢动这张表**：${probe.reason}\n`
            + '（这一条**不允许**静默跳过 —— 跳过就等于「磁盘上那份被丢弃」和「从来没配过」'
            + '长得一样，而这个工具会照着一份**幻影表**干活。）',
        }
      }
      const droppedWhy = probe.rejected.managedTags || probe.rejected.$
      const droppedNote = typeof droppedWhy === 'string' && droppedWhy
        ? `⚠️ settings.json 里的受管表**不合法、已被忽略**（下面这份是**默认预设**，不是他配的那张表）：${droppedWhy}`
        : ''

      // 读路径也过闸门：`settings.json` 可能被手改过。读和写**用同一个校验**，
      // 否则会出现「读得出来、但写不回去」的诡异状态（改一处就坏）。
      const curChecked = validateManagedTagSettings(readManaged())
      if (!curChecked.ok) {
        return { text: `❌ 存储里的受管表不合法：${curChecked.reason}\n（可以用 action=set 传一张合法的表覆盖它。）` }
      }
      const current = curChecked.value

      if (action === 'list') {
        // ⚠️ 预算**必须**用「按当前上限造出来的规则实例」算，不能用直出的
        //    `checkManagedTagBudget`（它绑在 limit=null 的表上，会**回错话**说「不限」）。
        const budget = managedTagRule(current.limit).checkBudget(current.tags)
        const out = renderManagedTable(current, budget, curChecked.notes, '受管标签表（带图标/颜色/字重的那一小撮）')
        if (droppedNote) {
          // ⚠️ 必须**顶在最前面**：这是「你看到的不是他的配置」的警告，
          //    埋在末尾等于没说（agent 只读开头几行就下结论是常态）。
          out.unshift(droppedNote, '（要用一张合法的表覆盖它：action=set 并**显式传 `tags`**。）', '')
        }
        out.push(
          '',
          '判据：**进过受管表 = 受管**（不是「有没有样式」）—— 所以没配样式的条目照样是受管的。',
          `可选颜色（**色板槽名**，一个 hex 都不收）：${TAG_COLOR_SLOTS.join(' / ')}`,
          `可选图标（icons.js 里的形状名）：${TAG_ICONS.join(' / ')}`,
          `字重：${TAG_WEIGHTS.join(' / ')}；字号：${TAG_SIZES.join(' / ')}（⚠️ 字号只在**分组标题**上生效，芯片上会被摘掉）`,
          '',
          '改它用 action=set（**整表替换**；默认只预演，要 confirm:true 才落盘）。',
        )
        return { text: out.join('\n') }
      }
      if (action !== 'set') {
        return { text: `❌ 不认识的 action「${action}」（只接受 list / set）` }
      }

      // ── set：写（默认 dry-run）────────────────────────────────────────────
      // ⚠️ 「磁盘上那份已被丢弃」时，**不许**从当前值推导 —— 因为 `current` 是**默认预设**，
      //    不是他的表。只改上限 / 只改某几条 = 拿默认预设当底稿，等于**静默整表替换**
      //    （实测过：`set unlimited:true` 就把 8 条默认预设落成了他的配置）。
      //    ⇒ 想覆盖必须**显式传 `tags`**（那是一次有意的整表替换，不依赖幻影底稿）。
      if (droppedNote && a.tags === undefined) {
        return {
          text: `❌ 拒绝在**幻影表**上改：${droppedNote}\n`
            + '原因：`get()` 会把被丢弃的键填成默认预设，所以「只改上限」「只改某几条」'
            + '实际上是在拿**默认预设**当底稿 —— 那是一次静默的整表替换。\n'
            + '两条出路：\n'
            + '  · 想用一张新表覆盖它 ⇒ 显式传 `tags`（整表替换语义）；\n'
            + '  · 想先修好原来那份 ⇒ 让他手工改 `settings.json`（把 `limit` 写成 `null` 或 ≥1 的整数）。',
        }
      }
      if (a.tags !== undefined && !Array.isArray(a.tags)) {
        return {
          text: `❌ tags 要是**数组**，收到 ${typeof a.tags}：${JSON.stringify(a.tags)}\n`
            + '   · 想**整表替换** ⇒ 传数组（形如 `[{id:"mt_x", tag:"标签名", color:"blue", icon:"code"}]`）\n'
            + '   · 想**清空受管表** ⇒ 传空数组 `[]`（**不是** null，也不是省略）\n'
            + '   · 想**只改上限、不动条目** ⇒ 干脆不要传 tags\n'
            + '⚠️ 没有替你猜「null 是什么意思」—— 猜错就是一次静默的整表改写。'
            + '（这条口径与 3c 的 `artifact_tags` 一致：**「没传」与「传了但类型不对」必须分开**，'
            + '把两者混成同一个 null，会让一个类型失误被放大成整表改写。）',
        }
      }
      // 上限：`limit` 与 `unlimited:true` 是**同一个意思的两种入口** ——
      // `limit: null` 是**存储/契约**的写法（冻结合同里「不限」就是 null），
      // `unlimited:true` 是**工具参数**的写法（JSON Schema 的 `type:'number'` 表达不了 null，
      // agent 照契约写 null 时不该被拒）。两个都收，只有**意思冲突**（同时说「不限」和「限 N」）才报错。
      let nextLimit = current.limit
      if (a.unlimited === true) {
        if (a.limit !== undefined && a.limit !== null) {
          return {
            text: `❌ unlimited:true 与 limit:${JSON.stringify(a.limit)} **意思冲突** ——`
              + '一个参数不该同时说「不限」和「限 N 个」。只给一个。',
          }
        }
        nextLimit = MANAGED_TAG_LIMIT_UNLIMITED
      } else if (a.limit !== undefined) {
        // `limit: null` 也按「不限」办（照契约的写法）—— 见上面那段。
        nextLimit = a.limit === null ? MANAGED_TAG_LIMIT_UNLIMITED : a.limit
      }
      const candidate = { limit: nextLimit, tags: a.tags === undefined ? current.tags : a.tags }

      // ★★ 改数据前**必过**的闸门：`validateManagedTagSettings`（lib/settings.js）——
      //    它是**唯一**的校验入口，内部用的就是 `lib/tag-styles.js` 的 `buildTagStyleRule` 本体：
      //      `rule.checkBudget`    = 直出的 `checkManagedTagBudget` **同一份实现**；
      //      `rule.validateManaged` = 直出的 `validateManagedTags`   **同一份实现**。
      // ⚠️ 为什么**不**在这里直接调那两个直出函数：它们绑死在**模块级**的 TAG_STYLE_TABLE 上
      //    （`limit` 恒为 `null` = 不限），**看不见用户自己设的上限** ——
      //      · 拿它们当超限闸门 ⇒ 一条**永远为真**的空转守卫（假守卫比没有更坏）；
      //      · 拿它们做「还剩几个位」的报告 ⇒ 明明限 2 却报「不限」，是**回错话**。
      //    等价性有断言钉着（test/managed-tags.test.mjs）：`limit: null` 时两者**逐样本同结果**；
      //    `limit: 3` 时两者**必须不同**（若相同，说明上限根本没被喂进去）。
      const checked = validateManagedTagSettings(candidate)
      if (!checked.ok) {
        const hint = /limit|上限/.test(checked.reason) ? '\n（工具里表达「不限」也可以传 `unlimited: true`。）' : ''
        return { text: `❌ 受管表没通过校验，**一个字都没改**：\n${checked.reason}${hint}` }
      }
      const value = checked.value
      const budget = managedTagRule(value.limit).checkBudget(value.tags)
      const out = renderManagedTable(value, budget, checked.notes, '受管表（改动后）')

      if (a.confirm !== true) {
        out.push(
          '',
          '⚠️ **这只是预演，一个字都没改。**',
          '请把上面这些改动**复述给用户并得到同意**，然后再调一次并传 `confirm: true`。',
        )
        return { text: out.join('\n') }
      }
      const r = settingsStore.update({ managedTags: value })
      if (r.errors && r.errors.length) {
        return { text: `❌ 写入失败，一个字都没改：${r.errors.map((e) => e.key + ': ' + e.reason).join('；')}` }
      }
      out.push('', `✅ 已写入受管表（共 ${value.tags.length} 条，上限 ${budget.unlimited ? '不限' : budget.limit + ' 个'}）。`)
      // `notes` 必须转达（本仓库的老规矩：吃掉 warning = 静默）
      if (r.notes && r.notes.length) out.push('⚠️ ' + r.notes.join('\n⚠️ '))
      return { text: out.join('\n') }
    },
  }
}
