/**
 * @dsh-external/dsh-artifact-library — DSH 产物库插件
 * 管理 DeepSeek Harness 的产出：模型工具登记/查询 + HTTP API + Web 管理页。
 * 数据存于 ~/.dsh/artifact-library/artifacts.json（可用 DSH_ARTIFACT_LIBRARY_DIR 覆盖）。
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ArtifactStore } from './store.js'
import { registerArtifactTools } from './tools.js'
import { artifactsHandler, uiHandler } from './http.js'
import { guardWrites } from './csrf-guard.js'
import { attachAutoCollect } from './autocollect.js'
import { attachCleanup } from './cleanup.js'
import { runRefineSession } from './refine-session.js'
import { createFileIndex } from './index/engine.js'
import { collectWorkspaceDirs } from './index/workspaces.js'
import path from 'node:path'
import fs from 'node:fs'
import { buildScope, dirsFromArtifacts, isInside } from './index/scope.js'
import { listDirectory, MAX_THUMB_BYTES } from './index/list.js'
import { createSessionChangesObserver } from './session-changes.js'
import { SettingsStore } from './settings.js'
import { registerFileSearchTool } from './index/tool.js'
import { attachWorkspaceWatcher } from './index/watch.js'

export const name = 'artifact-library'

/** 所需服务：webServer（HTTP 路由）、tools（模型工具注册）、sessionController / workspaceController（精炼会话） */
export const inject = ['webServer', 'tools', 'sessionController', 'workspaceController']

const DEFAULT_DATA_DIR = dshHomePath('artifact-library')

export async function apply(ctx, config = {}) {
  const dataDir = (config && config.dataDir) || DEFAULT_DATA_DIR
  const store = new ArtifactStore(dataDir).load()

  /**
   * 设置存储（外观 / 缩略图 / 行为 / 索引范围）。
   * 与 meta.json 分开存：设置能单独导出、导入、回滚。
   */
  const settingsStore = new SettingsStore({ file: path.join(dataDir, 'settings.json') }).load()

  // 把「分类表」接给 store（Step 2b）：新登记时按后缀给默认归类要用它。
  // ⚠️ 传的是**函数**不是当时的数组 —— 分类是用户在设置里随时能改的，
  //    传值就等于把改动冻在启动那一刻（又一处「存进去了但不生效」）。
  //    见 lib/store.js 的 `categoriesProvider` 注释。
  store.setCategoriesProvider(() => settingsStore.get().categories)

  // 文件索引引擎（Everything）：**懒启动** —— 不搜索时不启动任何进程
  const fileIndex = createFileIndex({ dataDir, logger: ctx.logger })

  /**
   * 计算索引范围：DSH 工作区 + 已登记产出所在目录 + 设置里的额外目录。
   *
   * ⚠️ `indexExtraDirs` 在 2026-09-30 之前是**死设置**：这里读了它，但旧 store 的
   *    `updateSettings()` 白名单里没有这个键 → 恒为 `[]`，「用户额外目录」这个能力
   *    实际上从来不存在。现在它归 `lib/settings.js` 管（PUT/导入都能写、校验、导出），
   *    这里改读设置存储 —— 这个键**真的**参与索引范围了。
   */
  const resolveIndexScope = async () => {
    const workspaces = await collectWorkspaceDirs(ctx, ctx.logger)
    const artifactDirs = dirsFromArtifacts(store.items)
    const uiSettings = settingsStore.get()
    const extra = Array.isArray(uiSettings.indexExtraDirs) ? uiSettings.indexExtraDirs : []
    const all = buildScope({ workspaces, artifactDirs, extra })
    // ⚠️ 必须过滤掉**不存在**的目录：实测（2026-09-30）范围里混进两个已删除的目录后，
    //    Everything 实例启动后完全不响应 IPC（es 查询卡死、CPU 0%、库文件不生成）。
    const existing = all.filter((dir) => {
      try { return fs.existsSync(dir) } catch { return false }
    })
    if (existing.length !== all.length) {
      ctx.logger.warn?.(`artifact-library: 索引范围里有 ${all.length - existing.length} 个目录不存在，已跳过`)
    }
    return existing
  }

  /**
   * 文件操作的安全闸门：只允许**索引范围内**的路径。
   *
   * 范围 = DSH 工作区 + 已登记产出所在目录 + 设置里的额外目录。
   * 没有这道闸门，「在资源管理器中定位」就会变成任意路径都能打开的窟窿。
   *
   * @param {string} targetPath 待校验路径
   * @returns {Promise<{ok:boolean, path?:string, error?:string}>}
   */
  const assertInScope = async (targetPath) => {
    try {
      const raw = String(targetPath || '')
      if (!raw.trim()) return { ok: false, error: '路径为空' }
      const resolved = path.resolve(raw)
      const scopeDirs = await resolveIndexScope()
      if (!scopeDirs.some((dir) => isInside(resolved, dir))) {
        return { ok: false, error: '路径不在索引范围内（只允许工作区与已登记产出目录）' }
      }
      return { ok: true, path: resolved }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  }

  /**
   * 会话改动公告观察器（P1）。
   *
   * 订阅 `session/event`，只记 `workspace/changes` 的**最后一次公告**。
   * 注意：这**不是**「用户正在看的那个会话」—— 宿主没有那个概念（详见
   * lib/session-changes.js 顶部）。所以端点把它标成 `derived: true`。
   */
  const sessionChanges = createSessionChangesObserver({ logger: ctx.logger })

  ctx.effect(
    () => {
      // ⚠️ 不把 workspaceChanges 放进 `inject`：那是**可选**依赖。
      //    放进去的话，宿主组合里没挂 @deepseek-ai/dsh-workspace-changes 时
      //    我们整个插件都加载不起来 —— 而目录浏览/产物库本体跟它无关。
      //    改成调用时惰性取，取不到就 503。
      const offEvent = ctx.on('session/event', (session, event) => {
        try {
          sessionChanges.observe(session, event)
        } catch (error) {
          ctx.logger.warn?.('artifact-library: 记录 workspace/changes 公告失败: ' + String((error && error.message) || error))
        }
      })
      const offDisposed = ctx.on('session/disposed', (session) => {
        try {
          sessionChanges.forget(session)
        } catch { /* 忽略 */ }
      })
      return () => {
        try { offEvent() } catch { /* 忽略 */ }
        try { offDisposed() } catch { /* 忽略 */ }
      }
    },
    'artifact-library: session changes observer',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/ext/artifacts',
      // ★ CSRF 栅栏包在**注册处**（不是写进 artifactsHandler）：跨源/CSRF 是接入层关注点，
      //   不是路由的关注点。这样纯路由保持可测、栅栏独立可测、路由内部一行不改（R-5.3）。
      handler: guardWrites(artifactsHandler(store, {
        runRefineSession: (opts) => runRefineSession(ctx, store, opts),
        fileIndex,
        resolveIndexScope,
        assertInScope,
        // 目录浏览：**实时读盘**，不走 Everything 索引。
        // 索引器只负责「全范围搜索」，而「某目录此刻有什么」必须问文件系统 ——
        // 否则范围内刚生成的文件要等索引清单过期（最长 6 小时）才可见。
        listDir: (dir, opts) => listDirectory(dir, opts),
        // 缩略图通道的单文件上限（**仅作兜底**：真实生效值来自设置里的 thumbMaxBytes）
        maxThumbBytes: MAX_THUMB_BYTES,
        // 设置存储：GET/PUT /settings、/settings/schema、/settings/export|import 都用它。
        // 具体校验/导入安全策略全在 lib/settings.js（那边有完整说明）。
        settings: {
          get: () => settingsStore.get(),
          update: (patch) => settingsStore.update(patch),
          export: (legacy) => settingsStore.exportPayload(legacy),
          import: (payload) => settingsStore.importPayload(payload),
        },
        // 设置变更后的副作用：只有「索引范围」真的变了才需要重启索引实例。
        // 不这么做的话 indexExtraDirs 会「存进去了、但搜索范围没变」= 又一个死设置。
        onSettingsChanged: (changedKeys) => {
          if (Array.isArray(changedKeys) && changedKeys.includes('indexExtraDirs')) scheduleScopeRefresh()
        },
        logger: ctx.logger,
        // 会话改动摘要：宿主自取「最近公告」用 recent()，显式坐标走 lookup()。
        // lookup 直接问官方的 ctx.workspaceChanges.summary(sessionId, seq)（纯查表）。
        sessionChanges: {
          recent: () => sessionChanges.recent(),
          lookup: (sessionId, seq) => {
            let service
            try {
              service = ctx.get('workspaceChanges')
            } catch {
              service = undefined
            }
            if (!service || typeof service.summary !== 'function') {
              return { ok: false, reason: 'service-unavailable' }
            }
            const summary = service.summary(sessionId, seq)
            if (summary === undefined || summary === null) return { ok: false, reason: 'not-found' }
            return { ok: true, summary }
          },
        },
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
      })),
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
    () => registerArtifactTools(ctx, store, settingsStore),
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
