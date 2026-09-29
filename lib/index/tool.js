/**
 * dsh-artifact-library — 文件搜索工具（给模型用）
 *
 * 让 AI 也能搜本地文件：Everything 语法、毫秒级。
 * 与产物库的关系：产物库管「已登记的产出」，本工具管「文件系统里有什么」，
 * 命中后可再用 register_artifact 登记进来。
 *
 * ⚠️ 索引范围**只含** DSH 工作区 + 已登记产出所在目录（依琪 2026-09-30 选定）——
 * 搜不到范围外的文件是**设计**，不是 bug。工具描述里如实写明，避免模型误判。
 *
 * ⚠️ Everything 只索引**文件名与路径**，不索引文件内容 ——
 * 按内容找文件应该用 grep 工具，不是这里。
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

function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}

function fmtDate(unixSeconds) {
  if (!unixSeconds) return ''
  try {
    return new Date(unixSeconds * 1000).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
  } catch {
    return ''
  }
}

/**
 * 注册 search_files 工具。
 * @param {object} ctx cordis 上下文（需 tools 服务）
 * @param {object} fileIndex createFileIndex 的返回值
 * @param {() => Promise<string[]>} resolveIndexScope 计算索引范围
 * @returns {Function} disposer
 */
export function registerFileSearchTool(ctx, fileIndex, resolveIndexScope) {
  return ctx.tools.register({
    name: 'search_files',
    description: '在本地文件系统里按**文件名/路径**搜索（Everything 索引，毫秒级）。'
      + '适用：用户问「那个文件在哪」「找一下 XX 相关的文件」，或需要在一批产出/资料里定位具体文件。'
      + '索引范围**仅限** DSH 工作区与已登记产出所在目录（不含全盘 —— 搜不到范围外的文件是预期的，不是故障）。'
      + '语法：ext:pdf 按扩展名 · dm:today 今天改过 · size:>10mb 按大小 · path:项目名 路径含某段 · 空格=AND · | =OR · !=NOT；query 留空则列出范围内全部文件。'
      + '注意：Everything 只索引**文件名与路径**，不索引文件内容 —— 按内容找文件请用 grep。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Everything 搜索语法（留空 = 列出范围内全部）' },
        limit: { type: 'number', description: '最多返回条数，默认 50，上限 500' },
        sort: { type: 'string', description: '排序：name / path / size / date-modified（可选）' },
      },
      required: ['query'],
    },
    timeoutMs: 120000, // 首次调用可能要先拉起 Everything 并建索引
    output: textOutput(),
    async execute(args) {
      try {
        const scopeDirs = typeof resolveIndexScope === 'function' ? await resolveIndexScope() : []
        const ready = await fileIndex.ensureReady({ scopeDirs })
        if (!ready.ok) {
          return { text: `❌ 文件索引不可用：${ready.error || '未知原因'}\n（可在产物库面板的「文件」视图里点「启动文件索引」重试）` }
        }

        const limit = Math.max(1, Math.min(Math.trunc(args.limit) || 50, 500))
        const result = await fileIndex.search({
          query: typeof args.query === 'string' ? args.query : '',
          limit,
          sort: args.sort || undefined,
        })
        if (!result.ok) {
          return { text: `❌ 搜索失败：${result.error || '未知原因'}` }
        }
        if (!result.rows.length) {
          return {
            text: `没有匹配的文件（查询：${args.query || '（空）'}）。\n`
              + `索引范围仅含 ${scopeDirs.length} 个目录（DSH 工作区 + 已登记产出所在目录），范围外搜不到属正常。`,
          }
        }

        const lines = result.rows.map((row, index) => {
          const size = fmtSize(row.size)
          const date = fmtDate(row.modified)
          return `${index + 1}. ${row.path}${size || date ? `  [${size}${size && date ? ' · ' : ''}${date}]` : ''}`
        })
        const head = `命中 ${result.total} 条`
          + `（本次返回 ${result.rows.length} 条${result.truncated ? '，已截断' : ''}`
          + `${result.elapsedMs >= 0 ? ` · 耗时 ${result.elapsedMs} ms` : ''}）`
          + ` · 索引范围 ${scopeDirs.length} 个目录`
        return { text: head + '\n\n' + lines.join('\n') }
      } catch (error) {
        return { text: `❌ search_files 异常：${String((error && error.message) || error)}` }
      }
    },
  })
}
