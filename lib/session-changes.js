/**
 * dsh-artifact-library — 「会话改动公告」观察器（宿主侧）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 先读这段：这个模块**解决不了**「用户正在看哪个会话」的问题
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-30 实测（写代码前先验证过）：
 *
 *   · **宿主侧不存在「活动会话 / 当前会话」概念。** `ctx.sessions.list()` 的文档是
 *     "All live sessions, in creation order" —— 创建序，没有活动时间、没有 active 标记。
 *     扫遍整个 app.asar 找 `activeSession* / currentSessionId / viewingSession /
 *     focusedSession / selectedSessionId / lastSessionId / recentSession`：**只命中
 *     两个，且都在客户端包**（`dsh-client-ui-workspace` 的 React state、
 *     `dsh-client-ui-subagent` 的 React prop）。「用户在看哪个会话」是**浏览器端状态**，
 *     从来没上报给宿主。
 *
 *   · 官方 `GET /api/changes.summary` 的做法是**要求调用方把坐标传进来**
 *     （`?sessionId=&seq=`，缺一个 400、查不到 404）。它的客户端从**会话作用域的插槽**
 *     拿 `sessionId` 和本轮公告的 `seq`。我们插件的面板注册在 `main`（root 作用域），
 *     拿不到那个上下文 —— 所以这条路对我们是断的。
 *
 * 那这个模块能给什么？**「最近一次 announce 了 `workspace/changes` 的顶层会话」**。
 * 这是一个**定义清楚的客观事实**，不是猜的，也**不等于**「当前会话」：
 *
 *   · 能拿到 → `announcedAt` / `sessionId` / `seq` 全部是真值，可以被 UI 如实标注；
 *   · 拿不到（从没观察到） → 返回 `undefined`，端点回 404。**绝不回落到
 *     「最近修改的文件」之类的凑数** —— 那会变成「看起来能用、其实在骗人」。
 *
 * 因此 API 层把 `derived` 标记放进响应体：只要 `derived: true`，UI 就**只能**
 * 标成「最近改动 · 会话 <id>」，不许标成「本次会话改动」。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么 `ctx.on('session/event', …)` 能收到**所有**会话的事件
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 这是官方 `@deepseek-ai/dsh-workspace-changes` 自己的订阅方式（它的 `apply()` 里就是
 * `ctx.on('session/event', (session, event) => …)`），不是我们发明的。机制我用
 * **从 app.asar 原样抽出来的 cordis** 跑过实验（9/9 通过）：
 *
 *   1. `Session.append()` → `ctx.events.dispatch('emit', [carrier, 'session/event', session, event])`。
 *   2. Cordis 给每个 ctx 发一个 EventsService **门面**（`root.events !== child.events`），
 *      但**所有门面共用同一个 `_hooks` 表** → 在哪注册都能互通。
 *   3. `dispatch` 唯一的过滤点是 `thisArg?.[Context.filter]`（`symbols.filter`），
 *      而它**只在 `RegistryService.notify` 里给 `internal/service` 事件设置**；
 *      session 的 carrier 上没有 → **不经过滤**，root 上的监听器照收。
 *      （反证也验过：给 thisArg 挂一个返回 false 的 `symbols.filter`，监听器**会**被滤掉。）
 *
 * ⚠️ 以上是「源码 + 独立实验」级证据。**真机确认**要等插件重载后看 info 日志
 *    「观察到 workspace/changes 公告：session=<id> seq=<n>」是否真的打出来。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 「最近」的口径（lead 明确要求写清，否则将来没人知道是按什么定的）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · 同一会话公告多次 → 每个会话**只留最后一次**（后到的覆盖先到的）。
 *   · 多个会话都公告过 → 比 `announcedAt`，**取最大的那个**。
 *   · `announcedAt` 取事件自带的 `event.time`（追加时就写死的真实时刻），
 *     取不到才退回 `Date.now()`。相同时刻（同毫秒）时**后观察到的胜**。
 *   · 只记**顶层会话**：官方只在 `eligible(session)` 通过时才会 append 这个事件
 *     （subagent / delegationDepth>0 会被排除），这里按 `session.header` 再兜一道，
 *     避免将来别的插件 append 出 subagent 的公告污染「最近」。
 */

/** 最多跟踪多少个会话的最后一次公告（超了按 announcedAt 淘汰最旧的） */
export const MAX_TRACKED_SESSIONS = 64

/** 从会话对象上安全地取 sessionId */
function sessionIdOf(session) {
  const id = session && typeof session.id === 'string' ? session.id : ''
  return id.trim() ? id.trim() : ''
}

/**
 * 是否该忽略这个会话的公告（subagent 不算「用户的一次会话」）。
 * 口径与官方 `dsh-workspace-changes` 的 `eligible()` 保持一致。
 */
function isIgnorableSession(session) {
  const header = session && session.header
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && depth > 0
}

/**
 * 创建一个「会话改动公告」观察器。
 *
 * @param {{logger?: object, now?: () => number}} [options]
 * @returns {{
 *   observe: (session: object, event: object) => boolean,
 *   forget: (session: object) => void,
 *   recent: () => {sessionId:string, seq:number, turn?:number, announcedAt:number} | undefined,
 *   tracked: () => number,
 *   clear: () => void,
 * }}
 */
export function createSessionChangesObserver(options = {}) {
  const logger = options.logger
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  /** sessionId → { sessionId, seq, turn?, announcedAt } —— 每会话只留**最后一次** */
  const bySession = new Map()

  /** 淘汰 announcedAt 最小的那个（容量保护） */
  function evictOldest() {
    let victim = null
    for (const record of bySession.values()) {
      if (victim === null || record.announcedAt < victim.announcedAt) victim = record
    }
    if (victim !== null) bySession.delete(victim.sessionId)
  }

  return {
    /**
     * 喂一个 `session/event` 事件。只有 `workspace/changes` 会被记下来。
     * @returns {boolean} 是否记录了一条公告
     */
    observe(session, event) {
      if (!event || typeof event !== 'object') return false
      if (event.type !== 'workspace/changes') return false
      const sessionId = sessionIdOf(session)
      if (!sessionId) return false
      if (isIgnorableSession(session)) return false
      const seq = Number(event.seq)
      if (!Number.isSafeInteger(seq) || seq < 0) return false
      const turn = event.data && Number.isSafeInteger(event.data.turn) ? event.data.turn : undefined
      // 事件自带 time（追加时写死）；拿不到才用本地时钟
      const announcedAt = Number.isFinite(event.time) && event.time > 0 ? Number(event.time) : now()
      bySession.set(sessionId, { sessionId, seq, turn, announcedAt })
      if (bySession.size > MAX_TRACKED_SESSIONS) evictOldest()
      logger?.info?.(
        `artifact-library: 观察到 workspace/changes 公告：session=${sessionId} seq=${seq} turn=${turn ?? '?'}`,
      )
      return true
    },

    /** 会话销毁：丢掉它的记录（summary 服务那边也会同步失效） */
    forget(session) {
      const sessionId = sessionIdOf(session)
      if (sessionId) bySession.delete(sessionId)
    },

    /** 最近一次公告（跨会话比 announcedAt）。从没观察到就返回 undefined。 */
    recent() {
      let best
      for (const record of bySession.values()) {
        if (best === undefined || record.announcedAt >= best.announcedAt) best = record
      }
      return best === undefined ? undefined : { ...best }
    },

    /** 当前跟踪的会话数（诊断用） */
    tracked() {
      return bySession.size
    },

    /** 清空（测试/卸载用） */
    clear() {
      bySession.clear()
    },
  }
}
