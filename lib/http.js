/**
 * dsh-artifact-library — HTTP API + 管理页面服务
 * 挂载在 /ext/artifacts（JSON API）和 /ext/artifact-library（管理页）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LIST_LIMIT, MAX_THUMB_BYTES, imageMimeFor } from './index/list.js'
import {
  LEGACY_SETTINGS_KEYS, SETTINGS_FORMAT, SETTINGS_VERSION, isHiddenEntryName, settingsSchema,
} from './settings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.resolve(__dirname, '..', 'ui')

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/**
 * 统一的**失败**回应（2026-09-30 加）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有它：调用方不该靠「解析人类可读文本」判断发生了什么
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 起因：客户端判「语义搜索失败」只能 `msg.indexOf('404')` —— 因为失败体里
 * **没有结构化的 reason**。那不可靠：`"404"` 可能出现在别的文本里。
 *
 * 排查后确认的真实失败面（**不是**一个端点的问题，是**所有错误回应**都没有 reason）：
 *   · 未知的 `files/*` 子路由        → 404 `{error:'not found'}`      ← 客户端最容易撞上这个
 *   · `/:id` 系列找不到记录          → 404 `{error:'not found'}`
 *   · 记录在但磁盘文件没了            → 404 `{error:'file missing'}`
 *   · 完全没有匹配的路由（含方法不对）→ 405 `{error:'method not allowed'}`
 *   · handler 内部抛异常             → 400 `{error:e.message}` ← **还有一个错**：内部错误被报成 400（客户端错），
 *                                      而且把异常原文吐出去了
 *
 * ⚠️ **不能靠猜**：`reason` 的选择必须对着上面这几条真实路径来，而不是照着
 *    「语义搜索应该有模型、模型可能不可用」这种**想当然**（本项目里**没有**模型化的语义搜索，
 *    见 `store.searchSemantic` —— 纯内存打分，不会 404）。
 *
 * 契约：`{ ok:false, reason:<机器可读>, error:<给人看>, message:<同 error，给新调用方>, ...extra }`
 *   · **保留 `error` 字段不动**（老调用方/老测试在看它）
 *   · `message` 是 `error` 的别名，供新调用方按 `{ok,reason,message}` 取
 *   · **成功路径也必须带 `ok:true`**，这样调用方永远不用看状态码/文本 —— 只看 `ok`
 *
 * reason 词表（**加新值请写进这里**，它是唯一的真相源）：
 *   route-not-found · artifact-not-found · file-missing · bad-request
 *   internal · method-not-allowed · unavailable
 *   （另有各端点自己的语义化 reason：missing / not-a-file / too-large / unsupported /
 *     nothing-observed / not-found / service-unavailable / prototype-pollution /
 *     format-mismatch / version-mismatch / coordinates-required …）
 */
function fail(res, status, reason, message, extra = {}) {
  sendJson(res, status, { ok: false, reason, error: message, message, ...extra })
}

/**
 * 解析一个「坐标」整数（官方 `coordinate()` 同款语义）：
 * 只接受纯十进制数字串，且必须落在安全整数范围内 —— 拒绝 `1.5` / `-1` / `1e3` / `0x10`。
 * @param {unknown} value 查询串里的原始值
 * @returns {number|undefined}
 */
function coordinate(value) {
  const raw = typeof value === 'string' ? value : ''
  if (!/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : undefined
}

/** 新版设置存储（lib/settings.js）是否已挂上 */
function hasUiSettings(deps) {
  return !!deps.settings && typeof deps.settings.get === 'function'
}

/**
 * 有效设置的**合并视图**：旧 store 的设置 + 新版设置。
 * 两组键不重叠（store: autoCollect/cleanup…/searchLimit；新版: 外观/缩略图/行为/索引范围），
 * 所以直接展开即可。`deps.settings` 没挂时退化成旧的 store-only 行为（离线测试不破）。
 */
function mergedSettings(store, deps) {
  const base = store.getSettings()
  if (!hasUiSettings(deps)) return base
  try {
    return { ...base, ...deps.settings.get() }
  } catch {
    return base
  }
}

/**
 * 请求是否来自本机回环地址。
 * 安全边界（v0.3.1）：webServer 无鉴权中间件，profile 可能绑定 0.0.0.0 供局域网访问；
 * 因此「文件内容读取 / 任意路径登记 / 宿主操作 / 写操作」仅限本机来源，
 * 局域网来源只放行不含文件正文的只读元数据。socket.remoteAddress 来自 TCP 层，不可伪造。
 * 无 socket 的调用方（测试 mock）视为本地。
 */
function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : ''
  if (!addr) return true
  return addr === '::1' || addr === '127.0.0.1' || addr === '::ffff:127.0.0.1'
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) { req.destroy(); reject(new Error('body too large')) } })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { reject(new Error('invalid JSON')) } })
    req.on('error', reject)
  })
}

/** /ext/artifacts* 的统一处理器：按 method + 路径尾部分发 */
export function artifactsHandler(store, deps = {}) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const tail = url.pathname.replace(/^\/ext\/artifacts/, '').replace(/\/+$/, '') || ''
      const id = tail.startsWith('/') ? tail.slice(1) : tail
      const q = Object.fromEntries(url.searchParams)

      // 非回环来源（局域网/外网）仅放行「不含文件正文的只读元数据」；
      // 文件内容（/file、单条含 contentIndex、/export）、任意路径登记、宿主操作与一切写操作仅限本机。
      if (!isLoopback(req)) {
        const localOnly =
          req.method !== 'GET' ||
          id === 'export' ||
          (id !== '' && !['search', 'stats', 'categories', 'settings', 'model-catalog', 'suggest-cleanup', 'ui-url', 'health'].includes(id) && !id.endsWith('/related'))
        if (localOnly) return fail(res, 403, 'local-only', '该操作仅限本机（127.0.0.1）使用，局域网只读浏览请使用列表视图')
      }

      // ── 文件索引（Everything 引擎）───────────────────────────────────────
      // ⚠️ 必须放在 `GET :id`（store.get）之前，否则 id='files' 会被当成产物 id。
      //    子路径统一用 `files/` 前缀分流。
      //    ⚠️ 不在上面的回环白名单里 → 非本机来源一律 403（文件系统信息只给本机）。
      if (id === 'files' || id.startsWith('files/')) {
        const engine = deps.fileIndex
        if (!engine) return fail(res, 503, 'unavailable', '文件索引未启用（未挂载引擎）')
        if (id === 'files/status') {
          return sendJson(res, 200, await engine.status())
        }
        // 在资源管理器中定位 / 用默认程序打开（P2-c）
        // ⚠️ 必须过 assertInScope 这道闸门 —— 只操作索引范围内的路径
        if ((id === 'files/reveal' || id === 'files/open') && req.method === 'POST') {
          const target = typeof q.path === 'string' ? q.path : ''
          if (!target) return fail(res, 400, 'bad-request', 'path 必填')
          const guard = typeof deps.assertInScope === 'function'
            ? await deps.assertInScope(target)
            : { ok: false, error: '范围校验不可用' }
          if (!guard.ok) return fail(res, 403, 'out-of-scope', guard.error || '路径不在索引范围内')
          const resolved = guard.path || target
          if (!fs.existsSync(resolved)) return fail(res, 404, 'file-missing', '文件不存在')
          // 与既有 /open 端点同样的做法：explorer /select 定位，或用默认程序打开
          const args = id === 'files/reveal' ? ['/select,' + resolved] : ['"' + resolved + '"']
          const child = spawn('explorer.exe', args, { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' })
          child.unref()
          return sendJson(res, 200, { ok: true, path: resolved, action: id === 'files/reveal' ? 'reveal' : 'open' })
        }

        // 目录树：列出某目录的直接子项（P2 基础设施）
        //
        // ⚠️ 2026-09-30 起**必须走实时文件系统**（`deps.listDir` → lib/index/list.js）：
        //    原先经过 `engine.listDir`（Everything filelists 快照），导致范围内刚新建的
        //    文件查不到（清单未过期就不重建），「找回」体验直接失效。
        //    下面的 `engine.listDir` 分支只是**兼容兜底**（老调用方/离线 mock 注入的
        //    引擎），生产由 lib/index.js 注入 `listDir`，不会走到它。
        if (id === 'files/list' && req.method === 'GET') {
          const dir = typeof q.dir === 'string' ? q.dir : ''
          if (!dir) return fail(res, 400, 'bad-request', 'dir 必填（绝对路径）')
          // 安全闸门：只放行索引范围内的路径（换数据源 ≠ 放松边界）
          const guard = typeof deps.assertInScope === 'function'
            ? await deps.assertInScope(dir)
            : { ok: false, error: '范围校验不可用' }
          if (!guard.ok) return fail(res, 403, 'out-of-scope', guard.error || '路径不在索引范围内')
          const lister = typeof deps.listDir === 'function'
            ? deps.listDir
            : (typeof engine.listDir === 'function' ? engine.listDir.bind(engine) : null)
          if (!lister) return fail(res, 503, 'unavailable', '目录列举不可用')
          // ★ 设置生效点：`listLimit` 是**默认页大小**（显式 ?limit= 仍然优先），
          //   `showHidden:false` 时过滤点开头与已知系统噪音项。
          const uiSettings = mergedSettings(store, deps)
          const configuredLimit = Number(uiSettings.listLimit)
          const limit = Number(q.limit) > 0
            ? Number(q.limit)
            : (Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : DEFAULT_LIST_LIMIT)
          const result = await lister(guard.path || dir, { limit })
          if (result && result.ok && Array.isArray(result.entries) && uiSettings.showHidden === false) {
            const kept = result.entries.filter((entry) => !isHiddenEntryName(entry && entry.name))
            const removed = result.entries.length - kept.length
            if (removed > 0) {
              // 计数跟着过滤后的结果走，别让前端显示「12 项」却只列出 9 条。
              // ⚠️ `total` / `truncated` 仍然是**扫描层**的口径（过滤发生在取页之后），
              //    所以极端情况下（前 limit 条里混着隐藏项）这一页可能不足 limit 条。
              const fileCount = kept.reduce((n, row) => n + (row.isDirectory ? 0 : 1), 0)
              result.entries = kept
              result.dirCount = kept.length - fileCount
              result.fileCount = fileCount
              result.hiddenFiltered = removed
            }
          }
          return sendJson(res, result.ok ? 200 : 500, result)
        }

        // 缩略图通道：GET /ext/artifacts/files/thumb?path=<绝对路径>
        //
        // 为什么自建而不是直接用官方的 `/api/file`：官方路由（dsh-api-session-controller
        // 的 SessionMediaReferences）确实可用（同源 `<img>` 会带上签名 cookie），但它
        //   · `Cache-Control: private, no-store` —— 网格里每张图每次挂载都重读一遍；
        //   · 走 `ctx.fs`（会话执行世界的读写策略）—— 用户开了受限沙箱时，范围外的
        //     产出目录会被 FS_SANDBOX_DENIED 挡掉，而它们恰恰是产物库要展示的内容。
        // 自建端点只读**索引范围内**的图片，带强缓存，行为与产物库的边界一致。
        if ((id === 'files/thumb') && (req.method === 'GET' || req.method === 'HEAD')) {
          const target = typeof q.path === 'string' ? q.path : ''
          if (!target) return fail(res, 400, 'bad-request', 'path 必填')
          const guard = typeof deps.assertInScope === 'function'
            ? await deps.assertInScope(target)
            : { ok: false, error: '范围校验不可用' }
          if (!guard.ok) return fail(res, 403, 'out-of-scope', guard.error || '路径不在索引范围内')
          const resolved = guard.path || target
          // 只认图片：这条通道不提供通用的「按路径读文件」能力
          const mime = imageMimeFor(resolved)
          if (!mime) return sendJson(res, 415, { ok: false, reason: 'unsupported', error: '不是可预览的图片' })
          let stat
          try {
            stat = fs.statSync(resolved)
          } catch {
            return sendJson(res, 404, { ok: false, reason: 'missing', error: '文件不存在' })
          }
          if (!stat.isFile()) return sendJson(res, 400, { ok: false, reason: 'not-a-file', error: '不是文件' })
          // ★ 设置生效点：`thumbMaxBytes`（0 = 不跳过，任何大小的图都给）
          const uiSettings = mergedSettings(store, deps)
          const configured = Number(uiSettings.thumbMaxBytes)
          const fallback = Number(deps.maxThumbBytes) > 0 ? Number(deps.maxThumbBytes) : MAX_THUMB_BYTES
          const maxBytes = Number.isFinite(configured) && configured >= 0 ? configured : fallback
          if (maxBytes > 0 && stat.size > maxBytes) {
            // 大图不回字节，让前端退回类型图标（413 + 结构化原因）
            return sendJson(res, 413, { ok: false, reason: 'too-large', limit: maxBytes, size: stat.size })
          }
          // ETag = size + mtimeMs，**弱验证器**（前缀 W/ 是刻意的，不是笔误）：
          //   · 用途只有一个 —— 让网格重新挂载时走 304，省掉重复传字节；**不是**完整性/防篡改校验。
          //   · 不读文件内容算哈希，是因为这是缩略图热路径（一次目录刷新可能几十个请求），
          //     为一个缓存提示去全量读盘不划算。
          //   · 已知边界：mtime 只取到毫秒。若同一毫秒内对同一文件写入两次且大小不变
          //     （理论上 NTFS 时间戳精度 100ns，`mtimeMs` 截断后才可能撞上），
          //     客户端可能拿到旧图。对缩略图而言可接受；要绝对正确就得换内容哈希。
          const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
          const headers = {
            'content-type': mime,
            'content-length': String(stat.size),
            'cache-control': 'private, max-age=86400',
            etag,
            'last-modified': stat.mtime.toUTCString(),
            'x-content-type-options': 'nosniff',
            // SVG 是脚本载体：给缩略图套沙箱，别让它在页面源里执行
            ...(mime === 'image/svg+xml' ? { 'content-security-policy': "sandbox; default-src 'none'" } : {}),
          }
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': headers['cache-control'] })
            return res.end()
          }
          res.writeHead(200, headers)
          if (req.method === 'HEAD') return res.end()
          const stream = fs.createReadStream(resolved)
          stream.on('error', () => { res.destroy() })
          stream.pipe(res)
          return
        }
        if (id === 'files/start' && req.method === 'POST') {
          const scopeDirs = typeof deps.resolveIndexScope === 'function' ? await deps.resolveIndexScope() : []
          const result = await engine.ensureReady({ scopeDirs })
          return sendJson(res, result.ok ? 200 : 500, result)
        }
        if (id === 'files/stop' && req.method === 'POST') {
          await engine.shutdown()
          return sendJson(res, 200, { ok: true })
        }
        if (id === 'files' && req.method === 'GET') {
          const result = await engine.search({
            query: typeof q.q === 'string' ? q.q : '',
            limit: Number(q.limit) || 200,
            sort: q.sort || undefined,
          })
          return sendJson(res, result.ok ? 200 : 500, result)
        }
        // ★ 未知的 files/* 子路由：客户端（比宿主新时）最容易撞上这条。
        //   给 reason + 一句能照做的 hint，调用方就不用去解析文本里的 "404" 了。
        return fail(res, 404, 'route-not-found', 'not found', {
          hint: '这个文件索引子路由在当前宿主版本里不存在。若界面比宿主新，重启一次 DSH 让宿主侧路由加载上。',
        })
      }

      if (req.method === 'GET' && id === 'stats') {
        return sendJson(res, 200, store.stats())
      }
      if (req.method === 'GET' && id === 'categories') {
        return sendJson(res, 200, store.categories())
      }
      // 管理页的绝对地址：客户端插件在桌面端必须用它才能打开管理页。
      // 桌面端渲染进程的页面源是 `dsh-app://app/`，根相对路径会解析到错误的源；
      // 且主窗口的 window.open 只放行 http:/https:（转给系统浏览器）。详见 lib/index.js 的说明。
      if (req.method === 'GET' && id === 'ui-url') {
        const info = typeof deps.uiUrl === 'function' ? deps.uiUrl() : undefined
        if (info === undefined || typeof info.url !== 'string') {
          return fail(res, 503, 'unavailable', '宿主暂未提供管理页地址')
        }
        return sendJson(res, 200, info)
      }
      // B1 语义搜索：GET /ext/artifacts/search?q=...&kind=&project=&limit=
      //
      // ⚠️ 两件要说清的事（2026-09-30 排查后）：
      //   1. **它不会因为「模型不可用」而失败** —— `store.searchSemantic` 是**纯内存打分**
      //      （标题/标签/摘要/文件名/路径/正文加权），不调模型、不发网络请求。
      //      所以**不存在** `semantic-unavailable` 这种失败态，别去编它。
      //   2. **「命中 0 条」不是失败** —— 那是 200 + `hits: []`。调用方请按 `ok` 分支，
      //      不要把空数组当错误（旧代码只能靠状态码/文本猜，这是本轮要修掉的毛病）。
      if (req.method === 'GET' && id === 'search') {
        try {
          const hits = store.searchSemantic(q.q || '', { kind: q.kind, project: q.project, limit: Number(q.limit) || store.getSettings().searchLimit || 20 })
          return sendJson(res, 200, { ok: true, query: q.q || '', hits })
        } catch (e) {
          return fail(res, 500, 'internal', `语义搜索失败：${(e && e.message) || e}`)
        }
      }
      // 健康探针（task-15）：**零磁盘 I/O、零索引依赖**，只为回答两个问题 ——
      //   「宿主还活着吗？现在几点？」
      //
      // 为什么需要它：2026-09-30 真机上产物库出现过**骨架屏无限转** —— 请求被浏览器
      // 扩展拦掉之后，客户端既没有报错、也没有超时，只能一直转，用户只能以为插件坏了。
      // 客户端要做「超时 + 可判断的失败」，就需要一个**最便宜、最不可能失败**的探针：
      //   · 不读盘、不查索引、不碰 store → 几乎不可能慢
      //   · 客户端可以先打它测延迟，再据此决定正文请求的超时阈值
      //   · 返回 `now`（宿主时钟），让客户端算耗时**不依赖本机时钟**
      if (req.method === 'GET' && id === 'health') {
        // ★ 这个端点**故意**在局域网也放行（`health` 在下面的白名单里）——
        //   2026-09-30 那次「骨架屏无限转」正是**局域网模式**下发生的，
        //   如果探针在局域网 403，客户端就还是分不清"被拦了"和"宿主死了"。
        //   代价只是 pid/uptime，非回环时连 pid 都不给。
        return sendJson(res, 200, {
          ok: true,
          now: Date.now(),
          uptimeMs: Math.round(process.uptime() * 1000),
          ...(isLoopback(req) ? { pid: process.pid } : {}),
        })
      }
      // C1 连线建议：GET /ext/artifacts/:id/related
      if (req.method === 'GET' && id.endsWith('/related')) {
        const rec = store.get(id.slice(0, -8))
        if (!rec) return fail(res, 404, 'artifact-not-found', 'not found')
        return sendJson(res, 200, { id: rec.id, links: store.suggestLinks(rec.id, { limit: Number(q.limit) || 8 }) })
      }
      // C2 整理建议单：GET /ext/artifacts/suggest-cleanup
      if (req.method === 'GET' && id === 'suggest-cleanup') {
        return sendJson(res, 200, store.suggestCleanup())
      }
      // 会话改动摘要：GET /ext/artifacts/session-changes?sessionId=&seq=  （或 ?recent=1）
      //
      // ⚠️ 先读 lib/session-changes.js 顶部那段说明。要点：
      //   · 宿主**没有**「用户正在看哪个会话」这个概念，所以**默认模式要求调用方给全坐标**
      //     （与官方 GET /api/changes.summary 同一套契约：缺坐标 400、查不到 404）。
      //   · `?recent=1` 是**显式**开关：宿主取「最近一次 workspace/changes 公告」。
      //     这是真事实但不是「当前会话」，所以响应体里带 `derived: true`，
      //     UI 只许标成「最近改动 · 会话 <id>」。
      //   · 从没观察到公告 → 404 `nothing-observed`。**绝不回落到「最近修改的文件」凑数。**
      //
      // **为什么这个端点不过 assertInScope**（这是有意为之，不是漏了）：
      //   ① 官方 `WorkspaceChangedFile.path` 的定义就是「cwd 内相对、cwd 外绝对」
      //      （见 dsh-workspace-changes 的 `durablePathOf`）。会话改到工作区外是**正常情况**，
      //      过了闸门就会把真实改动**悄悄过滤掉** → 变成「少报」，那是另一种更隐蔽的骗人。
      //   ② 它只吐**元数据**（路径 / 增删行数 / turn / cwd），**不吐任何文件内容**。
      //      文件正文仍然只有两条路：`/files/thumb`（过闸门、且只认图片）与既有
      //      `GET /ext/artifacts/:id/file`（只认已登记记录）—— 没有新增任意读盘能力。
      //   ③ 顶层还有既有的回环限制：id 不在非本机白名单里 → 局域网来源一律 403。
      if (req.method === 'GET' && id === 'session-changes') {
        const api = deps.sessionChanges
        if (!api || typeof api.lookup !== 'function' || typeof api.recent !== 'function') {
          return sendJson(res, 503, { ok: false, reason: 'unavailable', error: '会话改动服务未启用' })
        }
        const wantRecent = q.recent === '1' || q.recent === 'true'
        let target
        if (wantRecent) {
          const picked = api.recent()
          if (!picked) {
            return sendJson(res, 404, {
              ok: false,
              reason: 'nothing-observed',
              error: '插件启动以来还没观察到任何 workspace/changes 公告',
            })
          }
          target = { sessionId: picked.sessionId, seq: picked.seq, derived: true, announcedAt: picked.announcedAt }
        } else {
          const sessionId = typeof q.sessionId === 'string' ? q.sessionId.trim() : ''
          const seq = coordinate(q.seq)
          if (!sessionId || seq === undefined) {
            return sendJson(res, 400, {
              ok: false,
              reason: 'coordinates-required',
              error: '需要 sessionId 与 seq（正整数），或显式使用 recent=1',
            })
          }
          target = { sessionId, seq, derived: false }
        }
        const found = await api.lookup(target.sessionId, target.seq)
        if (!found.ok) {
          return sendJson(res, found.reason === 'service-unavailable' ? 503 : 404, {
            ok: false,
            reason: found.reason,
            sessionId: target.sessionId,
            seq: target.seq,
            error: found.reason === 'service-unavailable'
              ? '宿主未挂载 workspaceChanges 服务'
              : '该会话/序号没有可用的改动摘要（会话已销毁，或序号不对）',
          })
        }
        // 形状 = 官方 /api/changes.summary **原样**（将来切回官方路由，渲染层不用改）：
        //   { turn, files: [{path, display, added, deleted, binary?, oversized?}], total, added, deleted }
        //   · index 就是数组下标（官方也没有 index 字段）
        //   · 官方刻意丢掉 cwd（它的调用方自己有 session store）；我们 root 面板没有，
        //     不给 cwd 就没法把相对 path 解析成绝对路径 —— 所以**补一个 cwd**，属于明确扩展。
        //   · before/after **不给**：那是 /api/changes.diff 按需提供的逐文件比较
        //     （官方给它设了 diffTimeoutMs=100 的预算，本来就不是给列表批量用的）。
        const summary = found.summary
        const body = {
          ok: true,
          sessionId: target.sessionId,
          seq: target.seq,
          derived: target.derived,
          ...(target.announcedAt === undefined ? {} : { announcedAt: target.announcedAt }),
          ...(typeof summary.cwd === 'string' ? { cwd: summary.cwd } : {}),
          turn: summary.turn,
          files: Array.isArray(summary.files) ? summary.files : [],
          total: summary.total,
          added: summary.added,
          deleted: summary.deleted,
        }
        return sendJson(res, 200, body)
      }
      if (req.method === 'GET' && id === 'settings') {
        return sendJson(res, 200, mergedSettings(store, deps))
      }
      // 设置 schema：给设置面板的**单一真相源**（预设清单/选项表/默认值/范围），
      // 免得 ui-core 把 5 个预设和枚举表硬编码一份、将来跟宿主漂移。
      if (req.method === 'GET' && id === 'settings/schema') {
        return sendJson(res, 200, { ok: true, ...settingsSchema() })
      }
      // 设置导出：一个 JSON 把用户配置整个搬走
      // ⚠️ 只在回环放行（id 不在非本机白名单里）—— 顺带避免把本机路径清单外泄。
      if (req.method === 'GET' && id === 'settings/export') {
        if (!hasUiSettings(deps)) {
          // 新版设置未挂时，至少把旧 store 的设置导出成一个合法载荷
          return sendJson(res, 200, {
            format: SETTINGS_FORMAT,
            version: SETTINGS_VERSION,
            exportedAt: new Date().toISOString(),
            settings: store.getSettings(),
          })
        }
        return sendJson(res, 200, deps.settings.export(store.getSettings()))
      }
      // 设置导入。安全边界全在 lib/settings.js：任意层级的原型污染键 → **整份拒绝**、
      // 逐键类型/范围校验、未知键进 ignored、格式/版本不匹配明确报错不做猜测迁移。
      // 口径：**按出现键覆盖**（载荷里没出现的键保持不动）。
      if (req.method === 'POST' && id === 'settings/import') {
        const body = await readBody(req)
        if (!hasUiSettings(deps)) return fail(res, 503, 'unavailable', '设置服务未启用')
        const result = deps.settings.import(body)
        if (!result.ok) {
          return sendJson(res, 400, { ok: false, error: result.errors[0] ? result.errors[0].reason : '导入失败', reason: result.fatal, errors: result.errors })
        }
        // 旧 store 的那部分设置交给它自己夹取范围
        if (result.legacyPatch && Object.keys(result.legacyPatch).length > 0) {
          try { store.updateSettings(result.legacyPatch) } catch { /* 单个键坏不影响整单 */ }
        }
        if (result.saved === false) {
          deps.logger?.warn?.('artifact-library: 导入的设置写盘失败（只在内存里，重启会丢）')
        }
        if (typeof deps.onSettingsChanged === 'function') {
          try { deps.onSettingsChanged(result.applied || []) } catch { /* 忽略 */ }
        }
        return sendJson(res, 200, {
          ok: true,
          applied: result.applied || [],
          ignored: result.ignored || [],
          errors: result.errors || [],
          settings: mergedSettings(store, deps),
        })
      }
      if (req.method === 'PUT' && id === 'settings') {
        const body = await readBody(req)
        const patch = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
        // 旧 store 的设置（autoCollect / 整理 / 精炼 …）仍归它管，
        // 新版设置（外观/缩略图/行为/索引范围）归 lib/settings.js —— 两组键不重叠，
        // 所以可以各喂一份、互不干扰。老管理页只发旧键，行为完全不变。
        if (hasUiSettings(deps)) {
          const uiResult = deps.settings.update(patch)
          const legacyOnly = {}
          let hasLegacy = false
          for (const key of Object.keys(patch)) {
            if (LEGACY_SETTINGS_KEYS.includes(key)) { legacyOnly[key] = patch[key]; hasLegacy = true }
          }
          if (hasLegacy) store.updateSettings(legacyOnly)
          // 被拒的键不能让用户以为存进去了 —— 宿主侧留痕（响应体仍是平面设置，保持旧契约）
          if (uiResult.errors.length > 0) {
            deps.logger?.warn?.('artifact-library: 设置未被接受的键：' + uiResult.errors.map((e) => `${e.key}(${e.reason})`).join('; '))
          }
          if (uiResult.saved === false) {
            deps.logger?.warn?.('artifact-library: 设置写盘失败（本次改动只在内存里，重启会丢）')
          }
          if (typeof deps.onSettingsChanged === 'function') {
            try { deps.onSettingsChanged(uiResult.changed || []) } catch { /* 忽略 */ }
          }
        } else {
          store.updateSettings(patch)
        }
        return sendJson(res, 200, mergedSettings(store, deps))
      }
      // 模型目录：给设置面板 / 精炼弹窗的模型下拉用（按 provider 分组 + 部署默认）
      if (req.method === 'GET' && id === 'model-catalog') {
        if (!deps.modelCatalog) return fail(res, 500, 'unavailable', '模型目录不可用')
        try {
          return sendJson(res, 200, await deps.modelCatalog())
        } catch (e) {
          return fail(res, 500, 'internal', `模型目录读取失败: ${e?.message || e}`)
        }
      }
      if (req.method === 'PUT' && id === 'settings') {
        const body = await readBody(req)
        return sendJson(res, 200, store.updateSettings(body))
      }
      if (req.method === 'POST' && id === 'refine-session') {
        const body = await readBody(req)
        if (!deps.runRefineSession) return fail(res, 500, 'unavailable', '精化会话功能未启用')
        const result = await deps.runRefineSession({
          ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
          project: body.project || '',
          folder: !!body.folder,
          all: !!body.all,
          provider: body.provider || '',
          model: body.model || '',
        })
        return result.ok ? sendJson(res, 200, result) : sendJson(res, 500, result)
      }
      if (req.method === 'POST' && id === 'refine-request') {
        const body = await readBody(req)
        return sendJson(res, 200, store.requestRefine({
          ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
          project: body.project || '',
          folder: !!body.folder,
        }))
      }
      // ★ 撤销「⚡优先精化」标记 —— 与 refine-request **完全对称**（同参数、同批量语义）。
      //   为什么要它：lead 明确要求「打错了要能退」，而此前**没有清标记的路径**
      //   （`update()` 白名单不含 `refineRequested` → `PATCH /:id` 会被**静默忽略**），
      //   所以客户端只能「只做标记、不做撤销」——那就是个按了没用的假按钮。
      //   为什么不做成 `PATCH /:id {refineRequested:false}`：见 `store.unrefine()` 的注释
      //   （`update()` 是**用户元数据**通道，`refineRequested` 是**机器状态**；混进去就是后门）。
      if (req.method === 'POST' && id === 'unrefine') {
        const body = await readBody(req)
        return sendJson(res, 200, {
          ok: true,
          ...store.unrefine({
            ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
            project: body.project || '',
            folder: !!body.folder,
          }),
        })
      }
      if (req.method === 'POST' && id === 'cleanup-now') {
        const { runCleanup, backupStore } = await import('./cleanup.js')
        const result = runCleanup(store)
        const bk = backupStore(store)
        store.markCleanupDone()
        return sendJson(res, 200, { ...result, backup: bk.backedUp })
      }
      if (req.method === 'GET' && id === 'export') {
        const data = store.exportData()
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="artifact-library-export.json"',
        })
        return res.end(JSON.stringify(data, null, 2))
      }
      if (req.method === 'POST' && id === 'import') {
        const body = await readBody(req)
        // 本地扫描，绝不上传；project 缺省用目录名（异步遍历，不阻塞事件循环）
        const result = await store.importFolder(body.dir, { project: body.project })
        return sendJson(res, 200, result)
      }
      if (req.method === 'GET' && !id) {
        return sendJson(res, 200, store.list({
          q: q.q, project: q.project, artifact_type: q.artifact_type, tag: q.tag, kind: q.kind, refine: q.refine,
          status: q.status, sort: q.sort, limit: Number(q.limit) || 500,
        }))
      }
      if (req.method === 'GET' && id.endsWith('/file')) {
        const rec = store.get(id.slice(0, -5))
        if (!rec || !rec.exists) return fail(res, 404, 'artifact-not-found', 'not found or file missing')
        let st
        try { st = fs.statSync(rec.path) } catch { return fail(res, 404, 'file-missing', 'file missing') }
        if (!st.isFile()) return sendJson(res, 400, { error: 'not a file' })
        const total = st.size
        const mime = rec.mime_type || 'application/octet-stream'
        const range = req.headers.range
        if (range) {
          // Range 支持：视频/音频拖动进度（seek）依赖 206 分段响应，缺了会拖不动进度条
          const m = /bytes=(\d*)-(\d*)/.exec(range)
          let start = m && m[1] !== '' ? parseInt(m[1], 10) : 0
          let end = m && m[2] !== '' ? parseInt(m[2], 10) : total - 1
          if (!Number.isFinite(start) || start < 0) start = 0
          if (!Number.isFinite(end) || end >= total) end = total - 1
          if (start > end || start >= total) {
            res.writeHead(416, { 'content-range': `bytes */${total}` })
            return res.end()
          }
          res.writeHead(206, {
            'content-type': mime,
            'content-length': end - start + 1,
            'content-range': `bytes ${start}-${end}/${total}`,
            'accept-ranges': 'bytes',
          })
          const stream = fs.createReadStream(rec.path, { start, end })
          stream.on('error', () => { res.destroy() })
          stream.pipe(res)
          return
        }
        res.writeHead(200, { 'content-type': mime, 'content-length': total, 'accept-ranges': 'bytes' })
        const stream = fs.createReadStream(rec.path)
        stream.on('error', () => { res.destroy() })
        stream.pipe(res)
        return
      }
      if (req.method === 'GET' && id) {
        const rec = store.get(id)
        return rec ? sendJson(res, 200, rec) : fail(res, 404, 'artifact-not-found', 'not found')
      }
      if (req.method === 'POST' && !id) {
        const body = await readBody(req)
        return sendJson(res, 201, store.register(body))
      }
      if (req.method === 'PATCH' && id) {
        const body = await readBody(req)
        const rec = store.update(id, body)
        return rec ? sendJson(res, 200, rec) : fail(res, 404, 'artifact-not-found', 'not found')
      }
      if (req.method === 'POST' && id.endsWith('/open')) {
        const rec = store.get(id.slice(0, -5))
        if (!rec) return fail(res, 404, 'artifact-not-found', 'not found')
        if (!fs.existsSync(rec.path)) return fail(res, 404, 'file-missing', 'file missing')
        // Windows 资源管理器定位（/select 选中文件，目录则打开）；只服务已登记路径
        const p = spawn('explorer.exe', ['/select,' + rec.path], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' })
        p.unref()
        return sendJson(res, 200, { ok: true, path: rec.path })
      }
      if (req.method === 'POST' && id.endsWith('/trash')) {
        const rec = store.trash(id.slice(0, -6))
        return rec ? sendJson(res, 200, rec) : fail(res, 404, 'artifact-not-found', 'not found')
      }
      if (req.method === 'POST' && id.endsWith('/restore')) {
        const rec = store.restore(id.slice(0, -8))
        return rec ? sendJson(res, 200, rec) : fail(res, 404, 'artifact-not-found', 'not found')
      }
      if (req.method === 'DELETE' && id) {
        try {
          const ok = store.hardDelete(id)
          return ok ? sendJson(res, 200, { ok: true }) : fail(res, 404, 'artifact-not-found', 'not found')
        } catch (e) {
          return sendJson(res, 400, { error: e.message })
        }
      }
      // 走到这里 = 没有任何路由匹配（含方法不对）。
      // 给 reason：调用方不必再去看 405 的文本。
      return fail(res, 405, 'route-not-found', 'method not allowed', {
        hint: `没有匹配的路由：${req.method} ${url.pathname}。若是界面比宿主新，重启一次 DSH。`,
      })
    } catch (e) {
      // ⚠️ 这里原来一律回 **400** —— 把「宿主内部异常」报成了「客户端错」，还把异常原文吐出去。
      //    现在按来源分流：请求体的问题（invalid JSON / 太大）才是 400，其它是 500 internal。
      const msg = String((e && e.message) || e)
      const clientFault = msg === 'invalid JSON' || msg === 'body too large'
      return fail(res, clientFault ? 400 : 500, clientFault ? 'bad-request' : 'internal', msg)
    }
  }
}

/** /ext/artifact-library* 的管理页面（单文件自包含 UI；每次请求读取，改 UI 无需重启） */
export function uiHandler() {
  const page = path.join(UI_DIR, 'index.html')
  let cached = null
  let cachedMtime = 0
  const readPage = () => {
    try {
      const st = fs.statSync(page)
      if (!cached || st.mtimeMs !== cachedMtime) {
        cached = fs.readFileSync(page)
        cachedMtime = st.mtimeMs
      }
      return cached
    } catch {
      return Buffer.from('<!doctype html><title>产物库</title><p>UI 文件缺失</p>')
    }
  }
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const tail = url.pathname.replace(/^\/ext\/artifact-library/, '') || '/'
    if (tail === '/' || tail === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(readPage())
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }
  }
}
