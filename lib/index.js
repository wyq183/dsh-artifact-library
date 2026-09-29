/**
 * @dsh-external/dsh-artifact-library — DSH 产物库插件
 * 管理 DeepSeek Harness 的产出：模型工具登记/查询 + HTTP API + Web 管理页。
 * 数据存于 ~/.dsh/artifact-library/artifacts.json（可用 DSH_ARTIFACT_LIBRARY_DIR 覆盖）。
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ArtifactStore } from './store.js'
import { registerArtifactTools } from './tools.js'
import { artifactsHandler, uiHandler } from './http.js'
import { attachAutoCollect } from './autocollect.js'
import { attachCleanup } from './cleanup.js'
import { runRefineSession } from './refine-session.js'
import { createFileIndex } from './index/engine.js'
import { collectWorkspaceDirs } from './index/workspaces.js'
import { buildScope, dirsFromArtifacts } from './index/scope.js'
import { registerFileSearchTool } from './index/tool.js'
import { attachWorkspaceWatcher } from './index/watch.js'

export const name = 'artifact-library'

/** 所需服务：webServer（HTTP 路由）、tools（模型工具注册）、sessionController / workspaceController（精炼会话） */
export const inject = ['webServer', 'tools', 'sessionController', 'workspaceController']

const DEFAULT_DATA_DIR = dshHomePath('artifact-library')

export async function apply(ctx, config = {}) {
  const dataDir = (config && config.dataDir) || DEFAULT_DATA_DIR
  const store = new ArtifactStore(dataDir).load()

  // 文件索引引擎（Everything）：**懒启动** —— 不搜索时不启动任何进程
  const fileIndex = createFileIndex({ dataDir, logger: ctx.logger })

  /** 计算索引范围：DSH 工作区 + 已登记产出所在目录 + 设置里的额外目录 */
  const resolveIndexScope = async () => {
    const workspaces = await collectWorkspaceDirs(ctx, ctx.logger)
    const artifactDirs = dirsFromArtifacts(store.items)
    const settings = store.getSettings()
    const extra = Array.isArray(settings.indexExtraDirs) ? settings.indexExtraDirs : []
    return buildScope({ workspaces, artifactDirs, extra })
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/ext/artifacts',
      handler: artifactsHandler(store, {
        runRefineSession: (opts) => runRefineSession(ctx, store, opts),
        fileIndex,
        resolveIndexScope,
        // 模型目录：设置面板 / 精炼弹窗的模型下拉数据源（按 provider 分组 + 部署默认）
        modelCatalog: () => ctx.sessionController.modelCatalog(),
        // 管理页的**绝对**地址（GET /ext/artifacts/ui-url）。
        // 为什么必须由 host 报：客户端插件的页面源在桌面端是 `dsh-app://app/`，
        // 根相对路径 `/ext/artifact-library/` 会解析成 dsh-app 下的路径（不存在，
        // 于是点击静默无反应）；而主窗口的 window.open 策略只放行 http:/https:
        // （交给系统浏览器打开）。所以客户端必须拿到带 host:port 的绝对 http 地址。
        uiUrl: () => ({
          url: `http://127.0.0.1:${String(ctx.webServer.port)}/ext/artifact-library/`,
          port: ctx.webServer.port,
        }),
      }),
    }),
    'artifact-library: /ext/artifacts API',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/ext/artifact-library',
      handler: uiHandler(),
    }),
    'artifact-library: UI page',
  )

  ctx.effect(
    () => registerArtifactTools(ctx, store),
    'artifact-library: model tools',
  )

  // ── 主动纳管：会话工作区自动纳入索引范围 ─────────────────────────────
  //
  // 依琪的核心需求之一：「主动读取 dsh 的工作区里面的内容来进行管理」。
  //
  // 为什么不立刻更新范围：每次范围变化都要重启 Everything 实例（ini 改动需重启才生效），
  // 而会话可能一个个冒出来 —— 所以**防抖攒批**：攒 config.indexScopeDebounceMs（默认 30 秒）
  // 后一次性刷新，把多次重启合并成一次。
  const scopeDebounceMs = Math.max(1000, Number(config.indexScopeDebounceMs) || 30000)
  let scopeTimer = null
  const scheduleScopeRefresh = () => {
    if (scopeTimer) clearTimeout(scopeTimer)
    scopeTimer = setTimeout(() => {
      scopeTimer = null
      Promise.resolve()
        .then(() => resolveIndexScope())
        .then((scopeDirs) => {
          const before = fileIndex.snapshot().scope
          const changed = JSON.stringify(before) !== JSON.stringify(scopeDirs)
          if (!changed) return
          ctx.logger.info?.(`artifact-library: 索引范围更新为 ${scopeDirs.length} 个目录`)
          fileIndex.updateScope(scopeDirs)
        })
        .catch((error) => {
          ctx.logger.warn?.('artifact-library: 刷新索引范围失败: ' + String((error && error.message) || error))
        })
    }, scopeDebounceMs)
  }

  ctx.effect(
    () => {
      const offWatcher = attachWorkspaceWatcher(ctx, {
        logger: ctx.logger,
        onChange: () => scheduleScopeRefresh(),
      })
      return () => {
        try { offWatcher() } catch { /* 忽略 */ }
        if (scopeTimer) { clearTimeout(scopeTimer); scopeTimer = null }
      }
    },
    'artifact-library: workspace watcher (active onboarding)',
  )

  // 文件搜索工具（给模型用）：索引懒启动，首次调用可能要等 Everything 建立索引
  ctx.effect(
    () => registerFileSearchTool(ctx, fileIndex, resolveIndexScope),
    'artifact-library: file search tool',
  )

  // 文件索引生命周期：启动时什么都不做（懒启动）；卸载时正常关闭实例。
  // ⚠️ 必须走 es -exit —— Everything 退出时才写 ini，强杀会丢范围配置（隐私事故）。
  ctx.effect(
    () => () => { fileIndex.shutdown().catch(() => {}) },
    'artifact-library: file index lifecycle',
  )

  // 自动采集：每轮产出自动进库（开关存 meta，设置面板可实时改）
  ctx.effect(
    () => attachAutoCollect(ctx, store, {
      mutationTools: config.mutationTools,
      maxPerTurn: config.maxAutoPerTurn || 20,
    }),
    'artifact-library: auto collect',
  )

  // 定时整理：自跑定时器（默认每周，设置面板可调）
  ctx.effect(
    () => attachCleanup(ctx, store),
    'artifact-library: scheduled cleanup',
  )

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'tool:artifact-library',
      order: 108,
      text: '产物库已挂载：会话产出文件会自动登记；有「待精化」条目（artifact_list refine=1 查看）时，优先处理带「⚡优先」标记的，用 artifact_update 补全摘要/标签/项目；找历史产出用 artifact_find（自然语言描述）或 artifact_search（关键词）；给产出补关联资料用 artifact_suggest_links；定期用 artifact_suggest_cleanup 出整理建议单；查询用 artifact_list / artifact_get / artifact_stats；管理页入口：侧边栏「产物库」按钮，或 /ext/artifact-library/（挂在当前 dsh 的 webServer 端口上，端口由运行时决定）。',
    }), 'artifact-library: system prompt section')
  }

  ctx.logger.info(`artifact-library: store at ${store.file} (${store.items.length} records)`)
}
