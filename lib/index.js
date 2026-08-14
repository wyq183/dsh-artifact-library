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

export const name = 'artifact-library'

/** 所需服务：webServer（HTTP 路由）、tools（模型工具注册）、apiProxy（精炼会话） */
export const inject = ['webServer', 'tools', 'apiProxy']

const DEFAULT_DATA_DIR = dshHomePath('artifact-library')

export async function apply(ctx, config = {}) {
  const dataDir = (config && config.dataDir) || DEFAULT_DATA_DIR
  const store = new ArtifactStore(dataDir).load()

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/ext/artifacts',
      handler: artifactsHandler(store, {
        runRefineSession: (opts) => runRefineSession(ctx.apiProxy, store, opts),
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
      text: '产物库已挂载：会话产出文件会自动登记；有「待精化」条目（artifact_list refine=1 查看）时，优先处理带「⚡优先」标记的，用 artifact_update 补全摘要/标签/项目；查询用 artifact_list / artifact_get / artifact_search / artifact_stats；管理页：http://127.0.0.1:3080/ext/artifact-library/',
    }), 'artifact-library: system prompt section')
  }

  ctx.logger.info(`artifact-library: store at ${store.file} (${store.items.length} records)`)
}
