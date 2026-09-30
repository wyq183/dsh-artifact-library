/**
 * 写请求的 CSRF 栅栏 —— **纵深防御，两道**（2026-09-30，R-5.3 核实后由 lead 拍板）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 背景：不是「DSH 没有防护」，而是「插件没接上官方已有的防护」
 * ═══════════════════════════════════════════════════════════════════════════
 * 实测（无副作用端点）：
 *   · `POST /ext/artifacts/refine-request` + `Content-Type: text/plain`
 *     + `Origin: http://evil.example` → **HTTP 200，被完整处理**
 *   · 同一个 webServer 上，**官方 `/api`** 带跨源 Origin → **403 forbidden**；
 *     带伪造 Host → **401 unauthorized**
 *   ⇒ 官方在 `/api` 上**有** Origin/Host 栅栏，而本插件的
 *     `/ext/artifacts/*` 是 `webServer.register` 自己注册的 prefix 路由，
 *     **绕过了那层**。所以修法是**照抄官方的栅栏**，不是自己发明一套。
 *
 * 影响面（校准过，不夸大）：恶意页面**读不到响应**（无 CORS 头）→ **不是数据外泄**；
 * 但 11 个写端点全裸（`/import`、`/cleanup-now`、`/:id/open`、`/refine-session`…）
 * → 性质是**完整性 + 可用性**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 两道栅栏（只作用于**非安全方法**，即 GET/HEAD/OPTIONS 之外）
 * ═══════════════════════════════════════════════════════════════════════════
 * **第一道 · 同源栅栏**（与官方一致）：
 *   `Origin`（缺失时退回 `Referer`）的 host 必须与请求的 `Host` 相同。
 *   · `Origin: null` **一律拒绝** —— 沙箱 iframe / `data:` / `file:` 页面就是这个值，
 *     它是**攻击面的常客**，不是「无法判断所以放行」。
 *   · 拿不到 `Host` 时**不阻断**（HTTP/1.0 无 Host；且此时第二道仍然拦着）——
 *     只在**能证明**跨源时才拒，避免误伤。
 *
 * **第二道 · 自定义头**（标准 CSRF 防御）：
 *   必须带 `X-DSH-Artifacts: 1`。自定义头会**触发预检**，所以
 *   **即使浏览器/代理把 Origin 抹掉**，恶意页面也发不出这个请求。
 *
 * ⚠️ **为什么不校验 `Content-Type === application/json`**：
 *   实测 `multipart/form-data`（同样是 CORS 安全清单内的值）**也能打进来** ——
 *   单靠它是个**半吊子方案**，会被误当成"修好了"。这是本项目明确不做的方案。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 迁移影响（必须让调用方知道，否则会"改完就坏"）
 * ═══════════════════════════════════════════════════════════════════════════
 *   · **GET 一律不受影响** → 缩略图（`<img src>`）、列表、`/files/status`、`/health` 照旧。
 *     这一点是刻意的：`<img>` 发不了自定义头，栅栏若管 GET 会把缩略图全打死。
 *   · **所有写请求（POST/PUT/DELETE/PATCH）现在必须带 `X-DSH-Artifacts: 1`**
 *     → 面板/脚本要各加**一行**。这是有意的对外契约变更。
 *   · **同源调用方不需要任何 CORS 处理**（同源请求不触发预检）。
 *   · **万一桌面端是跨源**（如自定义 scheme `dsh-app://`）→ 靠 `allowedOrigins`
 *     显式白名单，并**只对白名单来源**回预检。**绝不做「无条件回 `Access-Control-Allow-Origin: *`」**
 *     —— 那等于把第二道栅栏当场作废。
 */

/** 写请求必须带的头（值只要求存在且非空，不校验具体值） */
export const CSRF_HEADER = 'x-dsh-artifacts'

/**
 * 默认放行的（非本机同源）来源白名单。
 *
 * ⚠️ **这一条不加就会把桌面端面板的所有写操作打死** —— 不是理论风险：
 *   · `lib/index.js` 的注释写明「客户端插件的页面源在桌面端是 `dsh-app://app/`」
 *   · `lib/client.js` 里面板是**直连绝对地址** `fetch(API + "…")`（API 是
 *     `http://127.0.0.1:<port>/ext/artifacts`）→ 对 `dsh-app://app/` 来说这是**跨源**
 *   ⇒ 面板的每次写请求都会带 `Origin: dsh-app://app`，栅栏必须放行它。
 *
 * 为什么放行它是**安全**的：`Origin` 由浏览器写入、**页面无法伪造**；
 * 而 `dsh-app://app` 是 DSH 桌面端自己的页面源 —— 攻击者要劫持它，
 * 必须先能往应用包里塞页面（那时候什么都晚了，CSRF 不是主要矛盾）。
 *
 * ⚠️ 真机验证项：若桌面端实际用的源不是 `dsh-app://app`（比如换成别的 scheme/主机名），
 *    **症状**是面板所有写操作返回 403 `cross-origin-blocked`，**GET 一律正常**
 *    （缩略图/列表照旧）。修法是一行：把真实来源加进这里。
 */
export const DEFAULT_ALLOWED_ORIGINS = ['dsh-app://app']

/** 这几类方法视为「安全」（只读）：不设栅栏 —— 缩略图/列表/健康探针都靠它 */
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * 取头（**大小写不敏感**）。
 * ⚠️ 不能只做 `h[name]`：Node 的 `req.headers` 恰好总是小写，但**别把正确性建立在
 *    调用方的实现细节上** —— 单测/别的适配层传进来的可能是原始大小写。
 */
function headerOf(req, name) {
  const h = req && req.headers
  if (!h) return ''
  const want = name.toLowerCase()
  let v
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === want) { v = h[k]; break }
  }
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) v = v[0]
  return String(v)
}

/** 取 URL 的 host（含端口）；解析不了返回 '' */
function hostOfUrl(value) {
  try {
    const u = new URL(String(value))
    // 自定义 scheme（dsh-app://x）的 host 解析同样适用
    return u.host || (u.protocol ? `${u.protocol}//` : '')
  } catch { return '' }
}

/**
 * 判定一个请求能不能写。
 * @param {any} req
 * @param {{allowedOrigins?: string[]}} [options]
 *   `allowedOrigins`：**显式**白名单（完整 origin，如 `['dsh-app://app']`）。
 *   默认空 —— 即只允许同源。加白名单请想清楚：等于给那个来源开了写权限。
 * @returns {{ok:true} | {ok:false, status:number, reason:string, message:string, hint?:string}}
 */
export function checkWriteRequest(req, options = {}) {
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (SAFE_METHODS.has(method)) return { ok: true }

  const origin = headerOf(req, 'origin')
  const referer = headerOf(req, 'referer')
  const host = headerOf(req, 'host')
  const allowed = Array.isArray(options.allowedOrigins) ? options.allowedOrigins : DEFAULT_ALLOWED_ORIGINS

  // ── 第一道：同源栅栏 ────────────────────────────────────────────────
  const claim = origin || referer
  if (origin === 'null') {
    return {
      ok: false, status: 403, reason: 'cross-origin-blocked',
      message: '拒绝：Origin 为 null（沙箱/本地文件页面），不允许发起写操作。',
      hint: '写操作请从面板（同源）发起；命令行走第一道栅栏需要不带 Origin，并带上 X-DSH-Artifacts 头。',
    }
  }
  if (claim) {
    const claimHost = hostOfUrl(claim)
    const whitelisted = allowed.some((o) => {
      const oh = hostOfUrl(o)
      return oh && (oh === claimHost || String(o) === claim)
    })
    // ⚠️ 只在**能证明**跨源时才拒：拿不到 `Host` 时无法比较（HTTP/1.0、某些代理），
    //    此时**不阻断** —— 第二道（自定义头）仍然拦着，不是"放行"。
    //    （这一条我第一版写错了：`host ? ... : false` 让缺 Host 的请求一律被拒。）
    if (!whitelisted && host && claimHost !== host) {
      return {
        ok: false, status: 403, reason: 'cross-origin-blocked',
        message: `拒绝跨源写操作：来源 ${claimHost || claim} 与目标 ${host} 不一致。`,
        hint: '同源面板不需要额外配置。若确实需要跨源（如桌面端自定义 scheme），把它加进 allowedOrigins 白名单。',
      }
    }
  }

  // ── 第二道：自定义头（会触发预检，因此 Origin 被抹掉也拦得住）────────
  if (!headerOf(req, CSRF_HEADER)) {
    return {
      ok: false, status: 403, reason: 'csrf-header-missing',
      message: `拒绝写操作：缺少 ${CSRF_HEADER} 头。`,
      hint: `写请求请带 ${CSRF_HEADER}: 1（自定义头会触发预检，恶意页面发不出来）。GET 不受影响。`,
    }
  }

  return { ok: true }
}

/**
 * 预检响应（跨源白名单来源专用）。
 *
 * ⚠️ **只对白名单来源**回 CORS 头，且**只回它自己那个来源**（不是 `*`）。
 * 对非白名单来源，这里**什么都不回** → 浏览器预检失败 → 恶意页面发不出写请求。
 * 这正是第二道栅栏起作用的地方。
 */
export function handlePreflight(req, res, options = {}) {
  const origin = headerOf(req, 'origin')
  const allowed = Array.isArray(options.allowedOrigins) ? options.allowedOrigins : DEFAULT_ALLOWED_ORIGINS
  const ok = origin && allowed.some((o) => String(o) === origin || (hostOfUrl(o) && hostOfUrl(o) === hostOfUrl(origin)))
  if (!ok) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('preflight denied')
    return true
  }
  res.writeHead(204, {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': CSRF_HEADER,
    'access-control-max-age': '600',
    vary: 'Origin',
  })
  res.end()
  return true
}

/**
 * 把栅栏**包在**处理器外面。
 *
 * ⚠️ 为什么包在注册处（`lib/index.js`）而不是写进 `artifactsHandler`：
 *   `artifactsHandler` 是**纯路由**，直接调用它的单测有一大批（不需要构造 headres）；
 *   而「跨源/CSRF」是**服务器接入层**的关注点，不是路由的关注点。
 *   包在注册处 = 纯路由保持可测 + 栅栏**独立可测** + 路由内部逻辑一行不用改。
 *   （官方的栅栏也在连接层，不在每个 handler 里 —— 这与「照抄官方」一致。）
 */
export function guardWrites(handler, options = {}) {
  return async function guarded(req, res) {
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method === 'OPTIONS') return handlePreflight(req, res, options)
    const verdict = checkWriteRequest(req, options)
    if (!verdict.ok) {
      res.writeHead(verdict.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: false, reason: verdict.reason, error: verdict.message, message: verdict.message, hint: verdict.hint,
      }))
      return
    }
    return handler(req, res)
  }
}
