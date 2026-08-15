/**
 * dsh-artifact-library — 模型工具集
 * register_artifact：把产出文件登记进产物库（AGENTS.md「产物库登记」的落地实现）
 * artifact_*：查询/管理产物库
 *
 * 注意：ctx.tools.register 的 parameters 必须是标准 JSON Schema
 * （type:'object' + properties + required 数组），不是 defineTool 的平铺 DSL。
 */

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

export function registerArtifactTools(ctx, store) {
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
        artifact_type: { type: 'string', enum: ['document', 'image', 'audio', 'video', 'code', 'archive', 'other'], description: '产物类型' },
        tags: { type: 'array', items: { type: 'string' }, description: '关键词标签' },
        notes: { type: 'string', description: '备注' },
        status: { type: 'string', enum: ['final', 'archived'], description: 'final=正式版 archived=归档' },
        kind: { type: 'string', enum: ['deliverable', 'reference'], description: 'deliverable=产出 reference=资料（默认 deliverable）' },
        source: { type: 'string', enum: ['session', 'folder-import', 'manual'], description: '来源（默认 manual）' },
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
        return { text: `✅ 已登记 ${rec.id}「${rec.title}」 | ${rec.kind === 'reference' ? '资料' : '产出'} | 项目:${rec.project || '未分类'} | 类型:${rec.artifact_type} | ${rec.needsRefine ? '待精化' : '已精化'}${sessionId ? ` | 来源会话:${sessionId}` : ''}` }
      } catch (e) {
        return { text: `❌ 登记失败：${e.message}` }
      }
    },
  })

  tools.push({
    name: 'artifact_list',
    description: '列出产物库中的产物（默认不含回收站）。可按关键词/项目/类型/标签/待精化筛选、排序。返回精简列表。refine=1 列出待 AI 精化的条目（缺摘要/标签），可配合 artifact_update 补全。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: '关键词（匹配标题/摘要/文件名/路径）' },
        project: { type: 'string', description: '按项目筛选' },
        artifact_type: { type: 'string', description: '按类型筛选' },
        tag: { type: 'string', description: '按标签筛选' },
        kind: { type: 'string', enum: ['deliverable', 'reference'], description: '按产出/资料筛选' },
        refine: { type: 'string', enum: ['', '1', '0'], description: '1=只看待精化 0=只看已精化' },
        status: { type: 'string', enum: ['', 'trashed', 'all'], description: 'trashed=回收站 all=含回收站' },
        sort: { type: 'string', enum: ['created_desc', 'created_asc', 'updated_desc', 'stars_desc', 'size_desc', 'name_asc'], description: '排序' },
        limit: { type: 'number', description: '最多返回条数，默认 50' },
      },
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      const items = store.list(args)
      const lines = items.slice(0, args.limit || 50).map((r) => `${r.id} | ${r.status === 'archived' ? '[归档] ' : ''}${r.kind === 'reference' ? '[资料] ' : ''}${r.needsRefine ? '[待精化] ' : ''}${r.title} | ${r.project || '未分类'} | ${r.artifact_type} | ★${r.stars} | ${r.path}`)
      const head = `产物库共 ${store.items.filter((r) => r.trashed_at === null).length} 条，命中 ${items.length} 条：`
      return { text: [head, ...lines].join('\n') || head + '\n（无）' }
    },
  })

  tools.push({
    name: 'artifact_get',
    description: '按 ID 获取产物完整记录。',
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
    description: '全文检索产物库：搜索标题/摘要/正文内容/文件名，返回匹配项及命中片段。用于"找回以前做过的产出/资料"。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: '搜索关键词（会匹配正文内容）' },
        kind: { type: 'string', enum: ['deliverable', 'reference'], description: '只搜产出或资料，缺省都搜' },
        project: { type: 'string', description: '限定项目' },
        limit: { type: 'number', description: '最多返回条数，默认 20' },
      },
      required: ['q'],
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      const items = store.list({ q: args.q, project: args.project, limit: args.limit || 20 })
      const filtered = args.kind ? items.filter((r) => (args.kind === 'reference') === (r.kind === 'reference')) : items
      if (!filtered.length) return { text: `未找到与 "${args.q}" 匹配的产物/资料` }
      const lines = filtered.map((r) => {
        const snippet = (r.summary || r.contentIndex || r.filename).replace(/\s+/g, ' ').slice(0, 160)
        return `${r.id} | ${r.kind === 'reference' ? '📚资料' : '📦产出'} | ${r.title} | ${r.project || '未分类'} | ★${r.stars}\n   ${snippet}`
      })
      return { text: `命中 ${filtered.length} 条：\n${lines.join('\n')}` }
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
        limit: { type: 'number', description: '最多返回条数，默认 10' },
      },
      required: ['q'],
    },
    timeoutMs: 10000,
    output: textOutput(),
    async execute(args, _exec) {
      const hits = store.searchSemantic(args.q, { kind: args.kind, project: args.project, limit: args.limit || 10 })
      if (!hits.length) return { text: `没有找到与「${args.q}」相关的内容。可以换个说法试试，或用 artifact_list 全量浏览。` }
      const lines = hits.map((h, i) => {
        const kindTag = h.kind === 'reference' ? '📚资料' : '📦产出'
        const tag = h.needsRefine ? ' [待精化]' : ''
        return `${i + 1}. ${h.id} | ${kindTag}${tag} | ${h.title} | ${h.project} | 相关度${h.score}\n   命中词: ${h.matched.join('、')}${h.summary ? `\n   ${h.summary.slice(0, 100)}` : ''}`
      })
      return { text: `「${args.q}」相关度最高的 ${hits.length} 条：\n${lines.join('\n')}` }
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
      parts.push(`- 待精化 ${s.unrefinedCount} 条（缺摘要/标签，可运行立即精炼或 artifact_update 补全）`)
      parts.push(`- 僵尸项目 ${s.staleProjects.length} 个（全部已归档，仅提示）`)
      for (const p of s.staleProjects.slice(0, 5)) parts.push(`  · ${p.project}（${p.count} 条）`)
      return { text: parts.join('\n') }
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

  const disposers = []
  for (const tool of tools) disposers.push(ctx.tools.register(tool))
  return () => { for (const d of disposers) d() }
}
