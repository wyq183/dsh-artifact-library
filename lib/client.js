/**
 * dsh-artifact-library — 客户端插件（DSH UI 原生集成）
 *
 * ── v0.6.0：产物库从「网页」搬进 DSH UI 第一期 ──────────────────────────────
 *
 * 之前只有 `sidebar.footer.action` 一个按钮，点了跳系统浏览器开独立管理页；
 * 桌面端还得绕绝对 URL（`dsh-app://` 展不开），是「跳出应用」的体验。
 *
 * 这一版走**官方席位**把它搬进来（不依赖任何第三方侧栏插件）：
 *   1. **主面板**（本期主力）——
 *      `sidebar.panellist`（左侧栏图标条目）+ `main`（root 作用域 keyed slot，主区整块面板）。
 *      两者的 id/key 必须**同为 PANEL_ID**：不一致时点图标会让布局抛错。
 *      这是官方 `dsh-client-ui-schedule` 验证过的同一条公开路径。
 *   2. **兜底入口**（保留）——`sidebar.footer.action` 按钮改为「打开完整管理页」，
 *      重功能（登记/导入/精炼/语义搜索/整理建议）本期内仍在网页里，第二期再搬。
 *
 * 数据全部走宿主侧既有 REST API `/ext/artifacts/*`，**宿主半侧一行未动**。
 *
 * ── 死守的三条（2026-09-28 用一次「应用起不来」换来的，改动时别碰）─────────
 *  ① **`apply` 永不抛出**。客户端 entry 一抛，web boot 判定 entry failed →
 *     **整个应用起不来**（那天连炸两次）。所以全程 try/catch，兜底返回空 disposer。
 *  ② 用 **`ctx.get('slots')`** 而不是 `ctx.slots`：前者是非契约访问器，
 *     服务不在时返回 undefined 而不是抛。
 *  ③ **不导出 `inject`**，保持零依赖 —— 否则 fiber 会卡在「等待服务」上，
 *     表现为 `pending (waiting for service: ...)` → 同样拖垮启动
 *     （kuanfu-compaction-tune 2026-09-29 就是这个死法，已被停用）。
 *
 * 手写 `__ModuleLoader__.load` 格式，无需构建步骤。
 */

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-artifact-library",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 宿主 REST API 前缀（相对路径可用：桌面端会把请求转给宿主）。 */
    var API = "/ext/artifacts";

    /**
     * 完整管理页路径（仅兜底用）。
     *
     * ⚠️ 桌面端**不能**直接拿这个根相对路径去 `window.open`：渲染进程页面源是
     * `dsh-app://app/`，根相对路径会解析成 `dsh-app://app/ext/...`（那个源上没有这条路由）；
     * 而主窗口 `setWindowOpenHandler` 只放行 `http:`/`https:` 并转交系统浏览器，
     * 其余协议一律 deny —— 表现为点击后静默无反应（真踩过）。
     * 所以真正地址由 host 通过 `GET /ext/artifacts/ui-url` 报绝对 URL。
     */
    var PAGE_PATH = "/ext/artifact-library/";

    /** 主面板 id —— `sidebar.panellist` 的 id 与 `main` 的 key 必须是同一个值。 */
    var PANEL_ID = "artifact-library";

    var SLOT_ACTION = "sidebar.footer.action";
    var SLOT_PANELLIST = "sidebar.panellist";
    var SLOT_MAIN = "main";

    var NS = "alf";

    /** host 报来的管理页绝对地址。 */
    var cachedUrl;
    /** 文件内容（图片/文本/音视频）的绝对源前缀；空串则退回相对路径。 */
    var fileOrigin = "";

    var STYLE_ID = "@dsh-external/dsh-artifact-library/ui.css";

    // ── 样式：全部读 DSH 设计 token，自动跟随深浅主题 ─────────────────────
    var css = [
      "." + NS + "{",
      "  --alf-bg:var(--dsw-alias-bg-base, #0d1117);",
      "  --alf-panel:var(--dsw-alias-bg-layer-1, #161b22);",
      "  --alf-panel2:var(--dsw-alias-bg-layer-2, #1c2330);",
      "  --alf-line:var(--dsw-alias-border-l2, #2a3242);",
      "  --alf-line1:var(--dsw-alias-border-l1, #232a36);",
      "  --alf-fg:var(--dsw-alias-label-primary, #e6edf3);",
      "  --alf-dim:var(--dsw-alias-label-secondary, #b8c2cf);",
      "  --alf-dim2:var(--dsw-alias-label-tertiary, #8b98a9);",
      "  --alf-acc:var(--dsw-alias-brand-primary, #4da3ff);",
      "  --alf-warm:var(--dsw-alias-state-warn-primary, #d9a441);",
      "  --alf-danger:var(--dsw-alias-state-error-primary, #f85149);",
      "  --alf-radius:var(--dsw-radius-lg, 10px);",
      "  height:100%;display:flex;flex-direction:column;overflow:hidden;",
      "  background:var(--alf-bg);color:var(--alf-fg);font:inherit;",
      "  box-sizing:border-box;",
      "}",
      "." + NS + " *{box-sizing:border-box}",
      "." + NS + "__fallback{padding:24px;color:var(--alf-dim);font-size:13px}",
      // 头部
      "." + NS + "__head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px 10px;flex:none}",
      "." + NS + "__title{font-size:16px;font-weight:700;letter-spacing:.3px;display:flex;align-items:center;gap:8px}",
      "." + NS + "__stats{display:flex;gap:8px;flex-wrap:wrap}",
      "." + NS + "__stat{background:var(--alf-panel);border:1px solid var(--alf-line1);border-radius:8px;padding:3px 10px;font-size:12px;color:var(--alf-dim2)}",
      "." + NS + "__stat b{color:var(--alf-fg);font-weight:600}",
      "." + NS + "__stat--warn{color:var(--alf-warm);border-color:var(--alf-warm)}",
      "." + NS + "__grow{flex:1}",
      "." + NS + "__warn{font-size:12px;color:var(--alf-warm);padding:6px 18px;flex:none}",
      // 工具条
      "." + NS + "__toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:0 18px 10px;flex:none}",
      "." + NS + "__input,." + NS + "__select{background:var(--alf-panel2);border:1px solid var(--alf-line);color:var(--alf-fg);",
      "  border-radius:8px;padding:6px 11px;font:inherit;font-size:13px;outline:none;min-width:0}",
      "." + NS + "__input:focus,." + NS + "__select:focus{border-color:var(--alf-acc)}",
      "." + NS + "__input{flex:1;min-width:180px}",
      "." + NS + "__btn{background:var(--alf-panel2);border:1px solid var(--alf-line);color:var(--alf-fg);",
      "  border-radius:8px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;",
      "  transition:background .15s,border-color .15s;white-space:nowrap}",
      "." + NS + "__btn:hover{border-color:var(--alf-acc);background:var(--dsw-alias-interactive-bg-hover, rgba(127,160,255,.1))}",
      "." + NS + "__btn:focus-visible{outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--alf-acc));outline-offset:2px}",
      "." + NS + "__btn:disabled{opacity:.5;cursor:default}",
      "." + NS + "__btn--primary{background:var(--dsw-alias-button-primary-fill, var(--alf-acc));border-color:transparent;color:var(--dsw-alias-label-primary-inverted, #04121f);font-weight:600}",
      "." + NS + "__btn--primary:hover{background:var(--dsw-alias-button-primary-hover, #79c0ff)}",
      "." + NS + "__btn--danger{color:var(--alf-danger);border-color:var(--alf-danger)}",
      "." + NS + "__btn--ghost{background:transparent}",
      "." + NS + "__seg{display:flex;gap:2px;background:var(--alf-panel2);border:1px solid var(--alf-line);border-radius:8px;padding:2px}",
      "." + NS + "__seg button{background:transparent;border:0;color:var(--alf-dim2);font:inherit;font-size:12.5px;",
      "  padding:4px 11px;border-radius:6px;cursor:pointer}",
      "." + NS + "__seg button[data-on='1']{background:var(--dsw-alias-interactive-bg-active, rgba(127,160,255,.18));color:var(--alf-fg);font-weight:600}",
      // 内容区
      "." + NS + "__body{flex:1;overflow:auto;padding:4px 18px 26px;position:relative}",
      "." + NS + "__cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:12px}",
      "." + NS + "__card{background:var(--alf-panel);border:1px solid var(--alf-line1);border-radius:var(--alf-radius);",
      "  overflow:hidden;display:flex;flex-direction:column;transition:border-color .15s,transform .15s;cursor:pointer}",
      "." + NS + "__card:hover{border-color:var(--alf-acc);transform:translateY(-2px)}",
      "." + NS + "__thumb{height:118px;background:var(--alf-panel2);display:flex;align-items:center;justify-content:center;overflow:hidden}",
      "." + NS + "__thumb img{width:100%;height:100%;object-fit:cover;display:block}",
      "." + NS + "__thumb span{font-size:32px;opacity:.5}",
      "." + NS + "__cardbody{padding:10px 12px;display:flex;flex-direction:column;gap:5px;flex:1}",
      "." + NS + "__cardtitle{font-weight:600;font-size:13.5px;line-height:1.45;word-break:break-all;",
      "  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      "." + NS + "__summary{color:var(--alf-dim2);font-size:12px;line-height:1.5;",
      "  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      "." + NS + "__badges{display:flex;gap:5px;flex-wrap:wrap;align-items:center;font-size:11px}",
      "." + NS + "__badge{background:var(--alf-panel2);border:1px solid var(--alf-line1);border-radius:20px;padding:0 7px;color:var(--alf-dim2)}",
      "." + NS + "__badge--hot{border-color:var(--alf-warm);color:var(--alf-warm)}",
      "." + NS + "__badge--acc{border-color:var(--alf-acc);color:var(--alf-acc)}",
      "." + NS + "__meta{font-size:11px;color:var(--alf-dim2);display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
      // 星级
      "." + NS + "__stars{letter-spacing:1px;font-size:12px;color:var(--dsw-alias-state-warn-primary, #ffd166);user-select:none}",
      "." + NS + "__stars span{cursor:pointer}",
      // 表格
      "." + NS + "__table{width:100%;border-collapse:collapse;background:var(--alf-panel);border:1px solid var(--alf-line1);border-radius:var(--alf-radius);overflow:hidden}",
      "." + NS + "__table th,." + NS + "__table td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--alf-line1);font-size:12.5px;vertical-align:middle}",
      "." + NS + "__table th{color:var(--alf-dim2);font-weight:600;font-size:11.5px;background:var(--alf-panel2)}",
      "." + NS + "__table tr:last-child td{border-bottom:0}",
      "." + NS + "__table tbody tr{cursor:pointer}",
      "." + NS + "__table tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover, rgba(127,160,255,.07))}",
      "." + NS + "__path{color:var(--alf-dim2);font-size:11px;word-break:break-all}",
      // 分组
      "." + NS + "__group{margin-bottom:16px}",
      "." + NS + "__grouph{font-size:13.5px;color:var(--alf-dim);margin:0 0 9px;display:flex;align-items:center;gap:8px;font-weight:600}",
      "." + NS + "__grouph em{color:var(--alf-dim2);font-size:11.5px;font-style:normal;font-weight:400}",
      // 抽屉
      "." + NS + "__mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.35));z-index:5}",
      "." + NS + "__drawer{position:absolute;top:0;right:0;bottom:0;width:min(430px,92%);z-index:6;",
      "  background:var(--alf-panel);border-left:1px solid var(--alf-line);",
      "  box-shadow:var(--dsw-shadow-lv3, -14px 0 40px rgba(0,0,0,.35));",
      "  display:flex;flex-direction:column;overflow:hidden}",
      "." + NS + "__drawerh{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--alf-line1);flex:none}",
      "." + NS + "__drawerb{flex:1;overflow:auto;padding:14px 15px 20px;display:flex;flex-direction:column;gap:12px}",
      "." + NS + "__drawerf{display:flex;gap:7px;flex-wrap:wrap;padding:11px 15px;border-top:1px solid var(--alf-line1);flex:none}",
      "." + NS + "__field{display:flex;flex-direction:column;gap:4px}",
      "." + NS + "__label{font-size:11.5px;color:var(--alf-dim2)}",
      "." + NS + "__value{font-size:12.5px;color:var(--alf-fg);word-break:break-all;line-height:1.6}",
      "." + NS + "__preview{background:var(--alf-panel2);border:1px solid var(--alf-line1);border-radius:var(--alf-radius);overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:120px;max-height:320px}",
      "." + NS + "__preview img{max-width:100%;max-height:320px;display:block}",
      "." + NS + "__preview video,." + NS + "__preview audio{max-width:100%;display:block}",
      "." + NS + "__pre{width:100%;max-height:300px;overflow:auto;margin:0;padding:12px;",
      "  font-family:var(--dsw-font-mono, ui-monospace,Consolas,monospace);font-size:11.5px;line-height:1.6;",
      "  white-space:pre-wrap;word-break:break-all;color:var(--alf-dim)}",
      // 空态 / toast
      "." + NS + "__empty{color:var(--alf-dim2);text-align:center;padding:52px 20px;font-size:13px;line-height:1.9}",
      "." + NS + "__toast{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);z-index:9;",
      "  background:var(--dsw-alias-toast-bg, var(--alf-panel2));color:var(--dsw-alias-toast-label, var(--alf-fg));",
      "  border:1px solid var(--alf-line);border-radius:8px;padding:9px 16px;font-size:12.5px;",
      "  box-shadow:var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.3));max-width:80%;text-align:center}",
      // 侧栏脚部入口（兜底）
      "." + NS + "-entry{",
      "  display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;",
      "  margin:4px 0;padding:7px 10px;",
      "  border-radius:8px;cursor:pointer;user-select:none;",
      "  font:inherit;font-size:13px;font-weight:600;line-height:1.4;text-align:left;",
      "  color:var(--dsw-alias-label-primary, #e6edf3);",
      "  background:var(--dsw-alias-interactive-bg-hover, rgba(127,160,255,.08));",
      "  border:1px solid var(--dsw-alias-border-l2, #2a3242);",
      "  transition:background .15s, border-color .15s;",
      "}",
      "." + NS + "-entry:hover{",
      "  background:var(--dsw-alias-interactive-bg-hover-solid, rgba(127,160,255,.16));",
      "  border-color:var(--dsw-alias-brand-primary, #4da3ff);",
      "}",
      "." + NS + "-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, #4da3ff);outline-offset:2px}",
      "." + NS + "-entry .alf-ei{font-size:16px;line-height:1}",
      "." + NS + "-entry .alf-el{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "body[data-ds-collapsed] ." + NS + "-entry{display:none}",
    ].join("\n");

    /** 只在有控制台时告警，绝不抛出。 */
    function warn() {
      try {
        if (typeof console !== "undefined" && console.warn) {
          console.warn.apply(console, ["[artifact-library]"].concat(Array.prototype.slice.call(arguments)));
        }
      } catch (error) { /* 忽略 */ }
    }

    /** 注入样式。永不抛出。 */
    function injectCss() {
      try {
        if (typeof document === "undefined") return;
        if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]")) return;
        var tag = document.createElement("style");
        tag.setAttribute("data-plugin-css", STYLE_ID);
        tag.textContent = css;
        (document.head || document.documentElement).appendChild(tag);
      } catch (error) { /* 样式注入失败不影响功能 */ }
    }

    /**
     * 预热：拿管理页绝对地址 + 推导文件内容的绝对源。
     * 桌面端 `<img src="/ext/...">` 会被解析到 `dsh-app://app/...`（那个源上没有文件路由），
     * 所以图片/音视频一律用 host 报的绝对源拼。永不抛出。
     */
    function primeUrl() {
      try {
        fetch(API + "/ui-url", { headers: { accept: "application/json" } })
          .then(function (response) { return response.ok ? response.json() : undefined })
          .then(function (body) {
            if (!body || typeof body.url !== "string" || body.url === "") return;
            cachedUrl = body.url;
            try {
              fileOrigin = new URL(body.url).origin;
            } catch (error) { fileOrigin = ""; }
          })
          .catch(function () { /* 取不到就退回相对路径 */ });
      } catch (error) { /* fetch 不可用也无所谓 */ }
    }

    /** 文件内容 URL（图片/文本/音视频共用）。 */
    function fileUrl(id) {
      return (fileOrigin || "") + API + "/" + encodeURIComponent(id) + "/file";
    }

    /** 打开完整管理页（兜底）。永不抛出。 */
    function openPage() {
      try {
        if (typeof cachedUrl === "string" && cachedUrl !== "") {
          window.open(cachedUrl, "_blank", "noopener");
          return;
        }
        fetch(API + "/ui-url", { headers: { accept: "application/json" } })
          .then(function (response) { return response.ok ? response.json() : undefined })
          .then(function (body) {
            if (body && typeof body.url === "string" && body.url !== "") {
              cachedUrl = body.url;
              window.open(body.url, "_blank", "noopener");
            }
          })
          .catch(function () {
            try { window.open(PAGE_PATH, "_blank", "noopener"); } catch (error) { /* 忽略 */ }
          });
      } catch (error) { /* 绝不抛出 */ }
    }

    // ── 数据层（全部走既有的 /ext/artifacts REST API）────────────────────
    function apiGet(path) {
      return fetch(API + path, { headers: { accept: "application/json" } }).then(function (response) {
        if (!response.ok) return Promise.reject(new Error("HTTP " + String(response.status)));
        return response.json();
      });
    }

    function apiSend(path, method, body) {
      return fetch(API + path, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(function (response) {
        if (!response.ok) {
          return response.json().catch(function () { return {}; }).then(function (json) {
            return Promise.reject(new Error((json && json.error) || ("HTTP " + String(response.status))));
          });
        }
        return response.json().catch(function () { return {}; });
      });
    }

    var TYPE_ICON = { image: "🖼️", audio: "🎵", video: "🎬", document: "📄", code: "💻", archive: "📦" };

    function typeIcon(t) {
      return TYPE_ICON[t] || "📎";
    }

    function fmtSize(b) {
      var n = Number(b) || 0;
      if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
      if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
      return n + " B";
    }

    function fmtDate(ts) {
      if (!ts) return "—";
      try {
        return new Date(Number(ts) * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      } catch (error) { return "—"; }
    }

    function isImage(record) {
      return !!(record && typeof record.mime_type === "string" && record.mime_type.indexOf("image/") === 0);
    }

    /** 由当前筛选状态拼列表查询串。 */
    function listQuery(filters) {
      var params = [];
      function add(key, value) {
        if (value === undefined || value === null || value === "") return;
        params.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
      }
      add("sort", filters.sort || "created_desc");
      add("q", filters.q);
      add("kind", filters.kind);
      add("refine", filters.refine);
      add("project", filters.project);
      add("limit", "1000");
      if (filters.trash) add("status", "trashed");
      return params.length ? "?" + params.join("&") : "";
    }

    // ── 小组件 ────────────────────────────────────────────────────────────
    /** 星级（点击即写）。 */
    function Stars(h, record, onSet) {
      var kids = [];
      for (var i = 1; i <= 5; i += 1) {
        /* eslint-disable no-loop-func */
        kids.push(h("span", {
          key: String(i),
          title: "点击打分",
          onClick: function (event) {
            event.stopPropagation();
            if (onSet) onSet(record.id, i);
          },
        }, i <= (record.stars || 0) ? "★" : "☆"));
        /* eslint-enable no-loop-func */
      }
      return h("div", { className: NS + "__stars" }, kids);
    }

    /** 缩略图（图片用绝对源；缺失/非图片退回图标）。 */
    function Thumb(h, record, big) {
      if (!record.exists) {
        return h("div", { className: big ? NS + "__preview" : NS + "__thumb" },
          h("span", { title: "文件缺失" }, "🚫"));
      }
      if (isImage(record)) {
        return h("div", { className: big ? NS + "__preview" : NS + "__thumb" },
          h("img", { src: fileUrl(record.id), alt: "", loading: "lazy" }));
      }
      return h("div", { className: big ? NS + "__preview" : NS + "__thumb" },
        h("span", null, typeIcon(record.artifact_type)));
    }

    /** 一批徽章（类型 / 资料 / 待精化 / 项目 / 归档）。 */
    function Badges(h, record) {
      var kids = [
        h("span", { className: NS + "__badge", key: "t" }, typeIcon(record.artifact_type) + " " + String(record.artifact_type || "other")),
      ];
      if (record.kind === "reference") kids.push(h("span", { className: NS + "__badge", key: "k" }, "📚 资料"));
      if (record.needsRefine) {
        kids.push(h("span", {
          className: NS + "__badge " + NS + "__badge--hot",
          key: "r",
        }, record.refineRequested ? "⚡ 优先精化" : "待精化"));
      }
      if (record.project) kids.push(h("span", { className: NS + "__badge " + NS + "__badge--acc", key: "p" }, String(record.project)));
      if (record.status === "archived") kids.push(h("span", { className: NS + "__badge", key: "a" }, "归档"));
      return h("div", { className: NS + "__badges" }, kids);
    }

    // ── 主面板 ────────────────────────────────────────────────────────────
    /**
     * 面板外壳：只负责自保。
     *
     * ⚠️ 官方行为是「抛异常的组件会把整个 slot entry 变空白」（console:
     * `slot entry crashed in '<slot>'`）→ 表现是「什么都没有、不报错、也不崩」。
     * 所以宁可降级成一行说明，也不要让条目静默消失。**看得见的问题好过看不见的消失。**
     */
    function Panel(props) {
      var React = require("react");
      var h = React.createElement;
      try {
        if (typeof React.useState !== "function" || typeof React.useEffect !== "function") {
          return h("div", { className: NS },
            h("div", { className: NS + "__fallback" },
              "产物库：当前 React 运行时没有 hooks（拿到的是子集），无法渲染交互界面。请把这句话告诉小琪。"));
        }
        return h(PanelInner, null);
      } catch (error) {
        warn("渲染失败：", error);
        return h("div", { className: NS },
          h("div", { className: NS + "__fallback" },
            "产物库渲染失败：" + (error && error.message ? error.message : String(error))));
      }
    }

    /** 内层：真界面。hooks 必须在组件函数里调用，所以单独一层。 */
    function PanelInner(props) {
      var React = require("react");
      var h = React.createElement;

      var stateData = React.useState({ items: [], stats: null, cats: { projects: [], types: [], tags: [] }, loading: true, error: "" });
      var data = stateData[0];
      var setData = stateData[1];

      var stateFilters = React.useState({ q: "", kind: "", refine: "", project: "", sort: "created_desc", view: "card", trash: false });
      var filters = stateFilters[0];
      var setFilters = stateFilters[1];

      var stateDetail = React.useState(null);
      var detail = stateDetail[0];
      var setDetail = stateDetail[1];

      var stateToast = React.useState("");
      var toast = stateToast[0];
      var setToast = stateToast[1];

      var debounceRef = React.useRef(null);
      var toastRef = React.useRef(null);
      var filtersRef = React.useRef(filters);
      filtersRef.current = filters;

      /** 弹一条提示（2.2 秒自动消失）。 */
      var showToast = React.useCallback(function (message) {
        setToast(String(message));
        if (toastRef.current) clearTimeout(toastRef.current);
        toastRef.current = setTimeout(function () { setToast(""); }, 2200);
      }, []);

      /** 拉列表（用当前筛选）。 */
      var reload = React.useCallback(function () {
        var current = filtersRef.current;
        setData(function (previous) {
          var next = {};
          for (var key in previous) if (Object.prototype.hasOwnProperty.call(previous, key)) next[key] = previous[key];
          next.loading = true;
          next.error = "";
          return next;
        });
        apiGet("/" + listQuery(current))
          .then(function (items) {
            setData(function (previous) {
              return {
                items: Array.isArray(items) ? items : [],
                stats: previous.stats,
                cats: previous.cats,
                loading: false,
                error: "",
              };
            });
          })
          .catch(function (error) {
            setData({
              items: [],
              stats: null,
              cats: { projects: [], types: [], tags: [] },
              loading: false,
              error: error && error.message ? error.message : String(error),
            });
          });
      }, []);

      /** 拉元数据（统计 + 分类）。 */
      var reloadMeta = React.useCallback(function () {
        Promise.all([apiGet("/categories"), apiGet("/stats")])
          .then(function (pair) {
            setData(function (previous) {
              return {
                items: previous.items,
                stats: pair[1],
                cats: pair[0] || { projects: [], types: [], tags: [] },
                loading: previous.loading,
                error: previous.error,
              };
            });
          })
          .catch(function () { /* 元数据失败不致命 */ });
      }, []);

      React.useEffect(function () {
        reloadMeta();
      }, [reloadMeta]);

      React.useEffect(function () {
        reload();
      }, [reload, filters.q, filters.kind, filters.refine, filters.project, filters.sort, filters.trash]);

      React.useEffect(function () {
        return function () {
          if (toastRef.current) clearTimeout(toastRef.current);
          if (debounceRef.current) clearTimeout(debounceRef.current);
        };
      }, []);

      /** 改一个筛选字段。 */
      function patchFilters(patch) {
        setFilters(function (previous) {
          var next = {};
          for (var key in previous) if (Object.prototype.hasOwnProperty.call(previous, key)) next[key] = previous[key];
          for (var patchKey in patch) if (Object.prototype.hasOwnProperty.call(patch, patchKey)) next[patchKey] = patch[patchKey];
          return next;
        });
      }

      /** 搜索框：本地即时回显 + 300ms 防抖触发查询。 */
      function onSearch(value) {
        patchFilters({ q: value });
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(function () {
          setFilters(function (previous) {
            var next = {};
            for (var key in previous) if (Object.prototype.hasOwnProperty.call(previous, key)) next[key] = previous[key];
            next.q = value;
            return next;
          });
        }, 300);
      }

      /** 打分。 */
      function setStars(id, n) {
        apiSend("/" + encodeURIComponent(id), "PATCH", { stars: n })
          .then(function () { showToast("★ " + String(n)); reload(); })
          .catch(function (error) { showToast("❌ " + error.message); });
      }

      /** 在文件管理器中定位。 */
      function openFolder(id) {
        apiSend("/" + encodeURIComponent(id) + "/open", "POST")
          .then(function () { showToast("📂 已在文件管理器中打开"); })
          .catch(function (error) { showToast("❌ " + error.message); });
      }

      /** 复制路径。 */
      function copyPath(record) {
        try {
          navigator.clipboard.writeText(record.path).then(function () {
            showToast("📋 路径已复制");
          }).catch(function () {
            showToast("📋 " + record.path);
          });
        } catch (error) {
          showToast("📋 " + record.path);
        }
      }

      /** 回收 / 恢复。 */
      function trashOne(id) {
        apiSend("/" + encodeURIComponent(id) + "/trash", "POST")
          .then(function () {
            showToast("🗑️ 已移入回收站");
            setDetail(null);
            reload();
            reloadMeta();
          })
          .catch(function (error) { showToast("❌ " + error.message); });
      }

      function restoreOne(id) {
        apiSend("/" + encodeURIComponent(id) + "/restore", "POST")
          .then(function () {
            showToast("↩️ 已恢复");
            setDetail(null);
            reload();
            reloadMeta();
          })
          .catch(function (error) { showToast("❌ " + error.message); });
      }

      /** 保存编辑（PATCH 局部字段）——由抽屉里的编辑态调用。 */
      function saveEdit(id, patch) {
        apiSend("/" + encodeURIComponent(id), "PATCH", patch)
          .then(function (updated) {
            showToast("✅ 已保存");
            setDetail(updated && updated.id ? updated : null);
            reload();
            reloadMeta();
          })
          .catch(function (error) { showToast("❌ " + error.message); });
      }

      var stats = data.stats || {};
      var head = h("div", { className: NS + "__head" },
        h("div", { className: NS + "__title" }, "🐋 产物库"),
        h("div", { className: NS + "__stats" },
          h("div", { className: NS + "__stat" }, "共 ", h("b", null, String(stats.total || 0)), " 件"),
          h("div", { className: NS + "__stat" }, "待精化 ", h("b", null, String(stats.pendingRefine || 0))),
          h("div", { className: NS + "__stat" }, "归档 ", h("b", null, String(stats.archived || 0))),
          h("div", { className: NS + "__stat" }, "回收站 ", h("b", null, String(stats.trashed || 0)))
        ),
        h("span", { className: NS + "__grow" }),
        h("button", {
          type: "button", className: NS + "__btn",
          onClick: function () { reloadMeta(); reload(); },
        }, "↻ 刷新"),
        h("button", {
          type: "button", className: NS + "__btn " + NS + "__btn--ghost",
          title: "登记 / 导入 / 精炼 / 语义搜索 / 整理建议 仍在完整管理页里（第二期搬进来）",
          onClick: openPage,
        }, "完整管理页 ↗")
      );

      var toolbar = h("div", { className: NS + "__toolbar" },
        h("input", {
          className: NS + "__input", type: "text", placeholder: "搜索标题 / 摘要 / 正文 / 文件名…",
          value: filters.q,
          onChange: function (event) { onSearch(event.target.value); },
        }),
        h("select", {
          className: NS + "__select", value: filters.kind,
          onChange: function (event) { patchFilters({ kind: event.target.value }); },
        },
          h("option", { value: "" }, "全部"),
          h("option", { value: "deliverable" }, "产出"),
          h("option", { value: "reference" }, "资料")
        ),
        h("select", {
          className: NS + "__select", value: filters.refine,
          onChange: function (event) { patchFilters({ refine: event.target.value }); },
        },
          h("option", { value: "" }, "全部状态"),
          h("option", { value: "1" }, "待精化"),
          h("option", { value: "0" }, "已精化")
        ),
        h("select", {
          className: NS + "__select", value: filters.project,
          onChange: function (event) { patchFilters({ project: event.target.value }); },
        },
          h("option", { value: "" }, "全部项目"),
          (data.cats.projects || []).map(function (name, i) {
            return h("option", { key: "p" + String(i), value: name }, String(name));
          })
        ),
        h("select", {
          className: NS + "__select", value: filters.sort,
          onChange: function (event) { patchFilters({ sort: event.target.value }); },
        },
          h("option", { value: "created_desc" }, "最新登记"),
          h("option", { value: "created_asc" }, "最早登记"),
          h("option", { value: "updated_desc" }, "最近更新"),
          h("option", { value: "stars_desc" }, "星级最高"),
          h("option", { value: "size_desc" }, "文件最大"),
          h("option", { value: "name_asc" }, "名称 A→Z")
        ),
        h("div", { className: NS + "__seg" },
          [["card", "卡片"], ["list", "列表"], ["project", "项目"], ["files", "文件"], ["dir", "目录"]].map(function (pair) {
            return h("button", {
              key: pair[0], type: "button",
              "data-on": filters.view === pair[0] ? "1" : "0",
              onClick: function () { patchFilters({ view: pair[0] }); },
            }, pair[1]);
          })
        ),
        h("button", {
          type: "button",
          className: NS + "__btn" + (filters.trash ? " " + NS + "__btn--primary" : ""),
          onClick: function () { patchFilters({ trash: !filters.trash }); },
        }, "🗑️ 回收站")
      );

      var bodyKids = [];
      // 文件视图与产物数据无关，必须排在 error / 空库 / loading 之前，
      // 否则库为空或加载中时它会永远显示不出来。
      if (filters.view === "files") {
        bodyKids.push(h(FilesView, { key: "files", onToast: showToast }));
      } else if (filters.view === "dir") {
        bodyKids.push(h(DirBrowser, { key: "dir", onToast: showToast }));
      } else if (data.error) {
        bodyKids.push(h("div", { className: NS + "__empty", key: "err" },
          "❌ 加载失败：" + data.error,
          h("br", null),
          "（确认产物库插件已安装、宿主已重启）"));
      } else if (data.loading && !data.items.length) {
        bodyKids.push(h("div", { className: NS + "__empty", key: "loading" }, "加载中…"));
      } else if (!data.items.length) {
        bodyKids.push(h("div", { className: NS + "__empty", key: "empty" },
          filters.trash ? "🗑️ 回收站是空的" : "✨ 这里还没有符合条件的产物",
          h("br", null),
          filters.q || filters.kind || filters.refine || filters.project
            ? "试试清空筛选条件"
            : "让 Agent 调用 register_artifact 登记，或到「完整管理页」导入文件夹"));
      } else if (filters.view === "list") {
        bodyKids.push(renderTable(h, data.items, filters, { openFolder: openFolder, setDetail: setDetail, trashOne: trashOne, restoreOne: restoreOne }));
      } else if (filters.view === "project") {
        bodyKids.push(renderProjects(h, data.items, setDetail));
      } else {
        bodyKids.push(renderCards(h, data.items, setDetail));
      }

      var body = h("div", { className: NS + "__body" }, bodyKids);

      return h("div", { className: NS },
        head,
        toolbar,
        body,
        detail ? h(DetailDrawer, {
          key: detail.id,
          record: detail,
          onClose: function () { setDetail(null); },
          onSave: saveEdit,
          onOpenFolder: openFolder,
          onCopyPath: copyPath,
          onTrash: trashOne,
          onRestore: restoreOne,
          onToast: showToast,
        }) : null,
        toast ? h("div", { className: NS + "__toast" }, toast) : null
      );
    }

    /**
     * 目录浏览视图（「文件管理器」的样子）。
     *
     * 与「文件」视图的分工：
     *   · 文件视图 = 全范围**搜索**（Everything 语法）
     *   · 本视图   = 按目录**逐层浏览**（面包屑 + 上级 + 当前目录内容）
     *
     * 数据来自 `/ext/artifacts/files/list?dir=`，它走 Everything 的 `-parent` 选项，
     * 只返回**直接子项**（实测：`parent:"…"` 当搜索串、`depth:1` 都返回空）。
     *
     * 条目自带的 `isDirectory` 来自尾部分隔符（Everything 结果里没有类型字段）。
     */
    function DirBrowser(props) {
      var React = require("react");
      var h = React.createElement;

      var sPath = React.useState("");
      var path = sPath[0];
      var setPath = sPath[1];

      var sEntries = React.useState([]);
      var entries = sEntries[0];
      var setEntries = sEntries[1];

      var sPhase = React.useState("idle"); // idle | loading | ready | error
      var phase = sPhase[0];
      var setPhase = sPhase[1];

      var sError = React.useState("");
      var error = sError[0];
      var setError = sError[1];

      var sScope = React.useState([]);
      var scope = sScope[0];
      var setScope = sScope[1];

      var notify = typeof props.onToast === "function" ? props.onToast : function () {};

      /** 取索引范围当浏览起点 */
      React.useEffect(function () {
        apiGet("/files/status")
          .then(function (st) {
            var dirs = st && Array.isArray(st.scope) ? st.scope : [];
            setScope(dirs);
            if (dirs.length) setPath(dirs[0]);
            else setPhase("idle");
          })
          .catch(function (err) {
            setPhase("error");
            setError(err && err.message ? err.message : String(err));
          });
      }, []);

      /** 载入当前目录的直接子项 */
      React.useEffect(function () {
        if (!path) return;
        setPhase("loading");
        apiGet("/files/list?dir=" + encodeURIComponent(path))
          .then(function (res) {
            setEntries(Array.isArray(res.entries) ? res.entries : []);
            setPhase("ready");
          })
          .catch(function (err) {
            setPhase("error");
            setError(err && err.message ? err.message : String(err));
          });
      }, [path]);

      /** 上级目录（Windows 路径） */
      function parentOf(p) {
        var s = String(p).replace(/[\\/]+$/, "");
        var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
        if (i < 0) return "";
        var up = s.slice(0, i);
        if (/^[A-Za-z]:$/.test(up)) return up + "\\";
        return up;
      }

      /** 登记某个文件为产物 */
      function registerRow(row) {
        notify("⏳ 登记中…");
        apiSend("", "POST", {
          path: row.path,
          title: row.name,
          kind: "deliverable",
          source: "manual",
          tags: row.ext ? [row.ext] : [],
        })
          .then(function () { notify("✅ 已登记：" + row.name); })
          .catch(function (err) { notify("❌ " + (err && err.message ? err.message : String(err))); });
      }

      function copyPath(row) {
        try {
          navigator.clipboard.writeText(row.path)
            .then(function () { notify("📋 路径已复制"); })
            .catch(function () { notify("📋 " + row.path); });
        } catch (e) {
          notify("📋 " + row.path);
        }
      }

      var upPath = parentOf(path);
      var bar = h("div", { className: NS + "__bar" },
        h("button", {
          type: "button", className: NS + "__btn",
          disabled: !upPath,
          onClick: function () { if (upPath) setPath(upPath); },
        }, "⬆ 上级"),
        h("button", {
          type: "button", className: NS + "__btn",
          onClick: function () { if (path) { setPhase("loading"); setPath(path + " "); setTimeout(function () { setPath(path); }, 0); } },
        }, "↻ 刷新"),
        h("span", { className: NS + "__path", style: { flex: "1", marginLeft: "8px" } }, path || "（未选择目录）"),
        h("button", {
          type: "button", className: NS + "__btn",
          onClick: function () { copyPath({ path: path }); },
        }, "📋 复制路径")
      );

      var roots = null;
      if (scope.length > 1) {
        roots = h("div", { className: NS + "__bar" },
          h("span", { className: NS + "__meta" }, "范围根："),
          scope.map(function (dir, i) {
            return h("button", {
              key: String(i),
              type: "button",
              className: NS + "__btn" + (dir === path ? " " + NS + "__btn--primary" : ""),
              style: { fontSize: "11.5px", padding: "2px 8px" },
              title: dir,
              onClick: function () { setPath(dir); },
            }, dir.split(/[\\/]/).filter(Boolean).pop() || dir);
          })
        );
      }

      var body;
      if (!path) {
        body = h("div", { className: NS + "__empty" },
          "还没有可浏览的目录",
          h("br", null),
          h("span", { style: { fontSize: "12px" } }, "索引范围为空 —— 先到「文件」视图启动索引，或登记几个产出"));
      } else if (phase === "loading") {
        body = h("div", { className: NS + "__empty" }, "载入中…");
      } else if (phase === "error") {
        body = h("div", { className: NS + "__empty" },
          "❌ " + error,
          h("br", null),
          h("span", { style: { fontSize: "12px" } },
            "若提示 404：文件索引路由是宿主侧改动，重启一次 DSH 即可（本界面已就绪）"));
      } else if (!entries.length) {
        body = h("div", { className: NS + "__empty" }, "这个目录是空的");
      } else {
        var sorted = entries.slice().sort(function (a, b) {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return String(a.name).localeCompare(String(b.name), "zh-CN");
        });
        body = h("div", { className: NS + "__list" }, sorted.map(function (row, i) {
          return h("div", {
            key: String(i),
            className: NS + "__row",
            style: { gridTemplateColumns: "1fr auto", cursor: row.isDirectory ? "pointer" : "default" },
            onClick: row.isDirectory
              ? function () { setPath(row.path.replace(/[\\/]+$/, "")); }
              : undefined,
          },
            h("div", { className: NS + "__k", style: { fontWeight: "400" } },
              h("div", { style: { fontSize: "13px" } },
                (row.isDirectory ? "📁 " : "📄 ") + (row.name || row.path)),
              row.isDirectory ? null : h("div", { className: NS + "__path" }, row.dir || "")),
            h("div", { className: NS + "__v", style: { textAlign: "right", whiteSpace: "nowrap" } },
              row.isDirectory ? h("span", { className: NS + "__meta" }, "目录") : fmtSize(row.size),
              !row.isDirectory && row.modified ? h("div", { style: { fontSize: "11px" } }, fmtDate(row.modified)) : null,
              row.isDirectory ? null : h("div", { style: { marginTop: "4px" } },
                h("button", {
                  type: "button", className: NS + "__btn",
                  style: { fontSize: "11px", padding: "2px 8px" },
                  onClick: function (event) { event.stopPropagation(); registerRow(row); },
                }, "登记"),
                h("button", {
                  type: "button", className: NS + "__btn",
                  style: { fontSize: "11px", padding: "2px 8px", marginLeft: "4px" },
                  onClick: function (event) { event.stopPropagation(); copyPath(row); },
                }, "复制")))
          );
        }));
      }

      return h("div", { className: NS, style: { gap: "10px" } }, bar, roots, body);
    }

    /**
     * 文件搜索视图（Everything 引擎）。
     *
     * 与产物视图的区别：这里搜的是**文件系统**（文件名 / 路径），
     * 不经过产物库数据；命中后可一键「登记为产物」，把两套东西连起来。
     *
     * 引擎是**懒启动**的：
     *   checking → 查状态
     *   idle     → 未启动，显示范围与「启动」按钮
     *   starting → 正在拉起 Everything 并建索引（首次可能几十秒）
     *   ready    → 可搜索
     *   error    → 显示原因 + 重试
     */
    function FilesView(props) {
      var React = require("react");
      var h = React.createElement;

      var sQuery = React.useState("");
      var query = sQuery[0];
      var setQuery = sQuery[1];

      var sRows = React.useState([]);
      var rows = sRows[0];
      var setRows = sRows[1];

      var sMeta = React.useState(null);
      var meta = sMeta[0];
      var setMeta = sMeta[1];

      var sStatus = React.useState(null);
      var status = sStatus[0];
      var setStatus = sStatus[1];

      var sPhase = React.useState("checking");
      var phase = sPhase[0];
      var setPhase = sPhase[1];

      var sError = React.useState("");
      var error = sError[0];
      var setError = sError[1];

      var sBusy = React.useState(false);
      var busy = sBusy[0];
      var setBusy = sBusy[1];

      var debounceRef = React.useRef(null);
      var notify = typeof props.onToast === "function" ? props.onToast : function () {};

      /**
       * 把传输层错误翻成人话。
       * 典型中间态：客户端 UI 已热载、但宿主侧的 /files 路由还没加载（需重启），
       * 这时裸报「HTTP 404」用户看不懂。
       */
      function explainError(err) {
        var msg = err && err.message ? String(err.message) : String(err);
        if (msg.indexOf("404") >= 0) {
          return "宿主尚未加载文件索引路由 —— 重启一次 DSH 即可生效（本界面已就绪）";
        }
        if (msg.indexOf("503") >= 0) {
          return "宿主没有挂载文件索引引擎（插件版本可能过旧）";
        }
        return msg;
      }

      /** 查引擎状态（轻量：宿主会用 es 探测一次实例是否在跑） */
      var refreshStatus = React.useCallback(function () {
        return apiGet("/files/status")
          .then(function (st) {
            setStatus(st);
            setPhase(st && st.ready ? "ready" : "idle");
            return st;
          })
          .catch(function (err) {
            setPhase("error");
            setError(explainError(err));
            return null;
          });
      }, []);

      React.useEffect(function () {
        refreshStatus();
        return function () {
          if (debounceRef.current) clearTimeout(debounceRef.current);
        };
      }, [refreshStatus]);

      /** 启动索引：按当前范围拉起 Everything（首次要建索引） */
      function startIndex() {
        setPhase("starting");
        setError("");
        apiSend("/files/start", "POST")
          .then(function (res) {
            setStatus(res);
            if (res && res.ok) {
              setPhase("ready");
              notify("✅ 文件索引已就绪");
            } else {
              setPhase("error");
              setError((res && res.error) || "启动失败");
            }
          })
          .catch(function (err) {
            setPhase("error");
            setError(explainError(err));
          });
      }

      /** 搜索（250ms 防抖） */
      function runSearch(next) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(function () {
          setBusy(true);
          apiGet("/files?limit=200&q=" + encodeURIComponent(next || ""))
            .then(function (res) {
              setRows(Array.isArray(res.rows) ? res.rows : []);
              setMeta({
                total: Number(res.total) || 0,
                elapsedMs: Number(res.elapsedMs) || 0,
                truncated: !!res.truncated,
              });
              if (res.status) setStatus(res.status);
              setBusy(false);
            })
            .catch(function (err) {
              setBusy(false);
              setError(err && err.message ? err.message : String(err));
            });
        }, 250);
      }

      /** 命中项一键登记进产物库 */
      function registerRow(row) {
        notify("⏳ 登记中…");
        apiSend("", "POST", {
          path: row.path,
          title: row.name,
          kind: "deliverable",
          source: "manual",
          tags: row.ext ? [row.ext] : [],
        })
          .then(function () { notify("✅ 已登记：" + row.name); })
          .catch(function (err) { notify("❌ " + (err && err.message ? err.message : String(err))); });
      }

      /** 复制所在目录（未登记文件不能用产物库的「在资源管理器打开」端点） */
      function copyDir(row) {
        var target = row.dir || row.path;
        try {
          navigator.clipboard.writeText(target)
            .then(function () { notify("📋 目录已复制"); })
            .catch(function () { notify("📋 " + target); });
        } catch (err) {
          notify("📋 " + target);
        }
      }

      // ── 状态条 ──────────────────────────────────────────────────────────
      var scopeCount = status && Array.isArray(status.scope) ? status.scope.length : 0;
      var head = h("div", { className: NS + "__bar" },
        h("span", { className: NS + "__badge " + (phase === "ready" ? NS + "__badge--acc" : "") },
          phase === "ready" ? "● 索引就绪" : (phase === "starting" ? "◌ 启动中" : (phase === "error" ? "✕ 出错" : "○ 未启动"))),
        h("span", { className: NS + "__meta" }, "范围 " + String(scopeCount) + " 个目录"),
        status && status.instance ? h("span", { className: NS + "__meta" }, "实例 " + String(status.instance)) : null,
        h("span", { className: NS + "__grow", style: { flex: "1" } }),
        h("button", {
          type: "button", className: NS + "__btn",
          onClick: function () { refreshStatus(); },
        }, "↻ 查状态")
      );

      // ── 各阶段主体 ──────────────────────────────────────────────────────
      var body;
      if (phase === "checking") {
        body = h("div", { className: NS + "__empty" }, "检查索引状态…");
      } else if (phase === "idle") {
        body = h("div", { className: NS + "__empty" },
          "文件索引尚未启动",
          h("br", null),
          h("span", { style: { fontSize: "12px" } },
            "索引范围：" + String(scopeCount) + " 个目录（DSH 工作区 + 已登记产出所在目录）"),
          h("br", null),
          h("button", {
            type: "button",
            className: NS + "__btn " + NS + "__btn--primary",
            style: { marginTop: "10px" },
            onClick: startIndex,
          }, "启动文件索引"),
          h("div", { style: { fontSize: "11.5px", marginTop: "8px", opacity: 0.75 } },
            "仅索引上述范围，不索引全盘；索引数据全部留在本机。"));
      } else if (phase === "starting") {
        body = h("div", { className: NS + "__empty" },
          "正在拉起 Everything 并建立索引…",
          h("br", null),
          h("span", { style: { fontSize: "12px" } }, "首次建立索引可能需要几十秒，请稍候"));
      } else if (phase === "error") {
        body = h("div", { className: NS + "__empty" },
          "❌ " + error,
          h("br", null),
          h("button", { type: "button", className: NS + "__btn", onClick: refreshStatus }, "重试"),
          h("button", { type: "button", className: NS + "__btn", onClick: startIndex, style: { marginLeft: "8px" } }, "强制启动"));
      } else {
        var resultRows = rows.map(function (row, i) {
          return h("div", {
            key: String(i),
            className: NS + "__row",
            style: { gridTemplateColumns: "1fr auto" },
          },
            h("div", { className: NS + "__k", style: { fontWeight: "400" } },
              h("div", { style: { fontSize: "13px", wordBreak: "break-all" } }, row.name || row.path),
              h("div", { className: NS + "__path" }, row.dir || "")),
            h("div", { className: NS + "__v", style: { textAlign: "right", whiteSpace: "nowrap" } },
              fmtSize(row.size),
              row.modified ? h("div", { style: { fontSize: "11px" } }, fmtDate(row.modified)) : null,
              h("div", { style: { marginTop: "4px" } },
                h("button", {
                  type: "button", className: NS + "__btn",
                  style: { fontSize: "11px", padding: "2px 8px" },
                  onClick: function () { registerRow(row); },
                }, "登记"),
                h("button", {
                  type: "button", className: NS + "__btn",
                  style: { fontSize: "11px", padding: "2px 8px", marginLeft: "4px" },
                  onClick: function () { copyDir(row); },
                }, "复制目录")))
          );
        });

        body = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
          h("input", {
            className: NS + "__input",
            type: "text",
            placeholder: "全文搜索文件名/路径，支持 Everything 语法：ext:psd · dm:today · size:>10mb · path:项目",
            value: query,
            onChange: function (event) {
              setQuery(event.target.value);
              runSearch(event.target.value);
            },
          }),
          meta
            ? h("div", { className: NS + "__meta" },
              "命中 " + String(meta.total) + " 条",
              meta.rows ? null : null,
              meta.elapsedMs ? " · 耗时 " + String(meta.elapsedMs) + " ms" : "",
              meta.truncated ? " · 仅显示前 200 条" : "")
            : null,
          busy ? h("div", { className: NS + "__empty" }, "搜索中…")
            : (rows.length ? h("div", { className: NS + "__list" }, resultRows)
              : h("div", { className: NS + "__empty" }, query ? "没有匹配的文件" : "输入关键词开始搜索（留空则列出范围内全部文件）"))
        );
      }

      return h("div", { className: NS, style: { gap: "10px" } }, head, body);
    }

    /** 卡片视图。 */
    function renderCards(h, items, setDetail) {
      return h("div", { className: NS + "__cards" },
        items.map(function (record) {
          return h("div", {
            key: record.id,
            className: NS + "__card",
            onClick: function () { setDetail(record); },
          },
            Thumb(h, record, false),
            h("div", { className: NS + "__cardbody" },
              h("div", { className: NS + "__cardtitle" }, String(record.title || record.id)),
              record.summary ? h("div", { className: NS + "__summary" }, String(record.summary)) : null,
              Badges(h, record),
              h("div", { className: NS + "__meta" },
                h("span", null, fmtSize(record.size_bytes)),
                record.created_at ? h("span", null, fmtDate(record.created_at)) : null,
                record.session_id ? h("span", { title: "来源会话：" + String(record.session_id) }, "🎬 " + String(record.session_id).slice(0, 12)) : null
              )
            )
          );
        })
      );
    }

    /** 项目视图（按 project 分组）。 */
    function renderProjects(h, items, setDetail) {
      var groups = {};
      var order = [];
      items.forEach(function (record) {
        var name = record.project || "(未分类)";
        if (!groups[name]) { groups[name] = []; order.push(name); }
        groups[name].push(record);
      });
      return h("div", null, order.map(function (name) {
        var group = groups[name];
        return h("div", { className: NS + "__group", key: name },
          h("div", { className: NS + "__grouph" }, "📁 " + name, h("em", null, String(group.length) + " 件")),
          renderCards(h, group, setDetail)
        );
      }));
    }

    /** 列表视图。 */
    function renderTable(h, items, filters, actions) {
      var rows = items.map(function (record) {
        var trashMode = !!filters.trash;
        return h("tr", {
          key: record.id,
          onClick: function () { actions.setDetail(record); },
        },
          h("td", null, isImage(record) && record.exists
            ? h("img", { src: fileUrl(record.id), alt: "", style: { width: "42px", height: "30px", objectFit: "cover", borderRadius: "5px", display: "block" } })
            : h("span", { style: { fontSize: "16px" } }, typeIcon(record.artifact_type))),
          h("td", null,
            h("b", null, String(record.title || record.id)),
            h("div", { className: NS + "__path" }, String(record.path || ""))),
          h("td", null, String(record.project || "—")),
          h("td", null, String(record.artifact_type || "—")),
          h("td", null, fmtSize(record.size_bytes)),
          h("td", null, fmtDate(record.created_at)),
          h("td", { style: { whiteSpace: "nowrap" } },
            trashMode
              ? h("button", {
                type: "button", className: NS + "__btn",
                onClick: function (event) { event.stopPropagation(); actions.restoreOne(record.id); },
              }, "恢复")
              : h("button", {
                type: "button", className: NS + "__btn " + NS + "__btn--danger",
                onClick: function (event) { event.stopPropagation(); actions.trashOne(record.id); },
              }, "回收"))
        );
      });
      return h("table", { className: NS + "__table" },
        h("thead", null, h("tr", null,
          ["", "产物", "项目", "类型", "大小", "登记时间", "操作"].map(function (label, i) {
            return h("th", { key: "h" + String(i) }, label);
          }))),
        h("tbody", null, rows));
    }

    // ── 详情抽屉 ──────────────────────────────────────────────────────────
    /** 详情 + 预览 + 编辑。所有数据来自已加载的那条记录，预览按需读文件。 */
    function DetailDrawer(props) {
      var React = require("react");
      var h = React.createElement;
      var record = props.record;

      var stateEditing = React.useState(false);
      var editing = stateEditing[0];
      var setEditing = stateEditing[1];

      var stateDraft = React.useState({
        title: record.title || "",
        summary: record.summary || "",
        project: record.project || "",
        deliverable: record.deliverable || "",
        tags: (record.tags || []).join(", "),
        notes: record.notes || "",
      });
      var draft = stateDraft[0];
      var setDraft = stateDraft[1];

      var stateText = React.useState(null);
      var text = stateText[0];
      var setText = stateText[1];

      var mime = String(record.mime_type || "");
      var canText = record.exists && (mime.indexOf("text/") === 0 || mime.indexOf("json") >= 0 || mime.indexOf("xml") >= 0 || mime.indexOf("javascript") >= 0 || mime.indexOf("markdown") >= 0);

      // 文本类文件：读前 200 KB 显示（图片/音视频走原生标签，不读）
      React.useEffect(function () {
        if (!canText) return undefined;
        var alive = true;
        fetch(fileUrl(record.id))
          .then(function (response) { return response.ok ? response.text() : Promise.reject(new Error("HTTP " + String(response.status))); })
          .then(function (body) { if (alive) setText(String(body).slice(0, 200000)); })
          .catch(function (error) { if (alive) setText("（读取失败：" + (error && error.message ? error.message : String(error)) + "）"); });
        return function () { alive = false; };
      }, [record.id, canText]);

      function field(label, value) {
        return h("div", { className: NS + "__field", key: label },
          h("div", { className: NS + "__label" }, label),
          h("div", { className: NS + "__value" }, value));
      }

      function editField(label, key, multiline) {
        return h("div", { className: NS + "__field", key: key },
          h("div", { className: NS + "__label" }, label),
          multiline
            ? h("textarea", {
              className: NS + "__input", rows: 3, value: draft[key],
              onChange: function (event) { setDraft(Object.assign({}, draft, { [key]: event.target.value })); },
            })
            : h("input", {
              className: NS + "__input", type: "text", value: draft[key],
              onChange: function (event) { setDraft(Object.assign({}, draft, { [key]: event.target.value })); },
            }));
      }

      /** 预览区：图片 / 音视频 / 文本 / 缺失。 */
      function preview() {
        if (!record.exists) {
          return h("div", { className: NS + "__preview" }, h("div", { className: NS + "__empty" }, "🚫 文件已不在原位置"));
        }
        if (isImage(record)) {
          return h("div", { className: NS + "__preview" }, h("img", { src: fileUrl(record.id), alt: "" }));
        }
        if (mime.indexOf("video/") === 0) {
          return h("div", { className: NS + "__preview" }, h("video", { src: fileUrl(record.id), controls: true }));
        }
        if (mime.indexOf("audio/") === 0) {
          return h("div", { className: NS + "__preview", style: { padding: "18px" } }, h("audio", { src: fileUrl(record.id), controls: true }));
        }
        if (canText) {
          return h("div", { className: NS + "__preview", style: { alignItems: "stretch", maxHeight: "320px", overflow: "auto" } },
            h("pre", { className: NS + "__pre" }, text === null ? "读取中…" : text));
        }
        return h("div", { className: NS + "__preview" },
          h("div", { className: NS + "__empty" }, typeIcon(record.artifact_type) + " " + (mime || "未知类型") + "（不支持内联预览）"));
      }

      var footer = editing
        ? [
          h("button", {
            type: "button", className: NS + "__btn " + NS + "__btn--primary", key: "save",
            onClick: function () {
              var patch = {
                title: draft.title,
                summary: draft.summary,
                project: draft.project,
                deliverable: draft.deliverable,
                notes: draft.notes,
                tags: draft.tags.split(",").map(function (t) { return t.trim(); }).filter(Boolean),
              };
              props.onSave(record.id, patch);
              setEditing(false);
            },
          }, "💾 保存"),
          h("button", {
            type: "button", className: NS + "__btn", key: "cancel",
            onClick: function () { setEditing(false); },
          }, "取消"),
        ]
        : [
          h("button", {
            type: "button", className: NS + "__btn", key: "open",
            onClick: function () { props.onOpenFolder(record.id); },
          }, "📂 文件夹"),
          h("button", {
            type: "button", className: NS + "__btn", key: "copy",
            onClick: function () { props.onCopyPath(record); },
          }, "📋 路径"),
          h("button", {
            type: "button", className: NS + "__btn", key: "edit",
            onClick: function () { setEditing(true); },
          }, "✏️ 编辑"),
          h("span", { className: NS + "__grow", key: "g" }),
          record.status === "trashed"
            ? h("button", {
              type: "button", className: NS + "__btn", key: "restore",
              onClick: function () { props.onRestore(record.id); },
            }, "↩️ 恢复")
            : h("button", {
              type: "button", className: NS + "__btn " + NS + "__btn--danger", key: "trash",
              onClick: function () { props.onTrash(record.id); },
            }, "🗑️ 回收"),
        ];

      return h("div", null,
        h("div", { className: NS + "__mask", onClick: props.onClose }),
        h("div", { className: NS + "__drawer" },
          h("div", { className: NS + "__drawerh" },
            h("div", { className: NS + "__title", style: { fontSize: "14px" } }, editing ? "编辑产物" : String(record.title || record.id)),
            h("span", { className: NS + "__grow" }),
            h("button", { type: "button", className: NS + "__btn " + NS + "__btn--ghost", onClick: props.onClose }, "✕")
          ),
          h("div", { className: NS + "__drawerb" },
            preview(),
            editing
              ? h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
                editField("标题", "title"),
                editField("摘要", "summary", true),
                editField("所属项目", "project"),
                editField("交付物类别", "deliverable"),
                editField("标签（逗号分隔）", "tags"),
                editField("备注", "notes", true))
              : h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
                Badges(h, record),
                record.summary ? field("摘要", String(record.summary)) : null,
                field("路径", String(record.path || "—")),
                field("项目", String(record.project || "—")),
                (record.tags && record.tags.length) ? field("标签", (record.tags || []).join(" · ")) : null,
                (record.references && record.references.length) ? field("引用资料", (record.references || []).join(", ")) : null,
                field("大小 / 时间", fmtSize(record.size_bytes) + " · " + fmtDate(record.created_at)),
                record.session_id ? field("来源会话", String(record.session_id)) : null,
                record.notes ? field("备注", String(record.notes)) : null,
                Stars(h, record, null))
          ),
          h("div", { className: NS + "__drawerf" }, footer)
        )
      );
    }

    // ── 侧栏席位组件 ──────────────────────────────────────────────────────
    /**
     * 左侧栏图标（`sidebar.panellist` 条目）。
     * 只画图标 —— 标签文字由侧栏外壳用注册时的 `label` 渲染。
     * 点击行为由框架处理（切到同 id 的 `main` 面板）。
     */
    function PanelIcon() {
      var React = require("react");
      var h = React.createElement;
      return h("svg", {
        width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
      },
        h("path", { d: "M3 8.5A2 2 0 0 1 5 6.5h3.6a1 1 0 0 1 .8.4l1.1 1.5H19a2 2 0 0 1 2 2v6.1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }),
        h("path", { d: "M7 13.6h10" })
      );
    }

    /** 侧栏脚部入口（兜底）：打开完整管理页。 */
    function FooterEntry() {
      var React = require("react");
      var h = React.createElement;
      return h("button", {
        type: "button",
        className: NS + "-entry",
        title: "打开完整管理页（登记 / 导入 / 精炼 / 语义搜索 / 整理建议）",
        onClick: openPage,
      },
        h("span", { className: "alf-ei" }, "🐋"),
        h("span", { className: "alf-el" }, "产物库 · 网页版")
      );
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────
    /**
     * **保证永不抛出**——客户端 entry 抛异常会拖垮整次 web boot。
     * 用 `ctx.get('slots')`（非契约访问器，服务不在时返回 undefined 而不抛），
     * 不导出 `inject`（否则 fiber 会卡在等待服务上 → 同样拖垮启动）。
     *
     * @param {object} ctx 客户端插件上下文。
     * @returns {Function} disposer
     */
    /**
     * 启动探针：把「ctx 里到底有没有 slots」直接画在界面上（排查用，临时）。
     * 纯 DOM，不依赖任何服务；失败也不抛。
     */
    function bootProbe(ctx) {
      try {
        if (typeof document === "undefined") return null;
        var text = "ALF-PROBE";
        try {
          var hasGet = !!(ctx && typeof ctx.get === "function");
          text += " hasGet=" + hasGet;
          if (hasGet) {
            var probeSlots = ctx.get("slots");
            text += " slots=" + (probeSlots === undefined ? "undefined" : (probeSlots === null ? "null" : typeof probeSlots));
            if (probeSlots) text += " inject=" + typeof probeSlots.inject + " register=" + typeof probeSlots.register;
          }
        } catch (probeError) {
          text += " ERR=" + (probeError && probeError.message ? probeError.message : String(probeError));
        }
        var stale = document.getElementById("alf-boot-probe");
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
        var node = document.createElement("div");
        node.id = "alf-boot-probe";
        node.textContent = text;
        node.setAttribute("style", "position:fixed;right:8px;top:44px;z-index:2147483647;background:#e11d48;color:#fff;font:11px/1.5 monospace;padding:4px 8px;border-radius:4px;max-width:60vw;word-break:break-all");
        (document.body || document.documentElement).appendChild(node);
        return node;
      } catch (error) {
        return null;
      }
    }

    /** 往探针上追加一行备注（不改抛）。 */
    function probeNote(node, extra) {
      try {
        if (node) node.textContent = String(node.textContent || "") + " | " + String(extra);
      } catch (error) { /* 忽略 */ }
    }

    /** 找侧边栏列——**不写死哈希**，用 class 子串匹配（hash 随构建变化）。 */
    function findSidebar() {
      try {
        return document.querySelector('[class*="sidebarCol"]')
          || document.querySelector('[class*="sidebar"] [class*="footArea"]');
      } catch (error) {
        return null;
      }
    }

    /** 造 DOM 版入口按钮（slots 不可用时的保底）。 */
    function makeDomButton() {
      var btn = document.createElement("div");
      btn.className = NS + "-entry";
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.title = "打开产物库完整管理页（DOM 兜底入口）";
      btn.innerHTML = '<span class="alf-ei">🐋</span><span class="alf-el">产物库 · 网页版</span>';
      btn.addEventListener("click", openPage);
      btn.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openPage();
        }
      });
      return btn;
    }

    /**
     * DOM 兜底：React 会重渲染侧边栏把节点冲掉，所以用轻量定时器兜住。
     * @returns {Function} disposer
     */
    function applyViaDom() {
      injectCss();
      var timer = setInterval(function () {
        try {
          if (typeof document === "undefined") return;
          var col = findSidebar();
          if (!col) return;
          if (col.querySelector("." + NS + "-entry")) return;
          var btn = makeDomButton();
          var foot = col.querySelector('[class*="footArea"]') || col.querySelector('[class*="settingsArea"]');
          if (foot && foot.parentElement) foot.parentElement.insertBefore(btn, foot);
          else col.appendChild(btn);
        } catch (error) { /* 单次挂载失败不致命，下一次 tick 会重试 */ }
      }, 1500);
      return function () {
        try {
          clearInterval(timer);
          if (typeof document === "undefined") return;
          var nodes = document.querySelectorAll("." + NS + "-entry");
          for (var i = 0; i < nodes.length; i += 1) nodes[i].remove();
        } catch (error) { /* 清理失败无所谓 */ }
      };
    }

    /**
     * 插件入口。**保证永不抛出**——客户端 entry 抛异常会拖垮整次 web boot。
     *
     * 关键教训（2026-09-30 依琪反馈"按钮没了"才定位到）：
     *   **`ctx.get('slots')` 在本 entry 执行时可能还没就绪**（返回 undefined）。
     *   v0.5.0 之所以还能看见「🐋 产物库」，是因为它拿不到 slots 时会**退回 DOM 注入**；
     *   v0.6.0 第一版把这个兜底删了 → 一个入口都不剩。
     *   所以现在三条一起上：**轮询等 slots**（不声明 inject，避免 fiber 卡住拖垮启动）
     *   + **DOM 兜底**（保证入口存在）+ **探针**（把真相画在界面上）。
     *
     * @param {object} ctx 客户端插件上下文。
     * @returns {Function} disposer
     */
    function apply(ctx) {
      // 先清掉可能残留的旧诊断条（上一版代码 / 上一次 apply 留下的）
      try {
        if (typeof document !== "undefined") {
          var staleProbe = document.getElementById("alf-boot-probe");
          if (staleProbe && staleProbe.parentNode) staleProbe.parentNode.removeChild(staleProbe);
        }
      } catch (error) { /* 忽略 */ }

      // 诊断条默认**完全静默**，只有页面 URL 带 `alfdebug` 时才画出来。
      var probe = (function () {
        try {
          if (typeof location === "undefined") return null;
          if (String(location.search || "").indexOf("alfdebug") < 0) return null;
        } catch (error) { return null; }
        return bootProbe(ctx);
      })();

      primeUrl();
      injectCss();

      var registered = false;
      var attempts = 0;
      var retryTimer = null;
      var domDisposer = null;

      /** 试着拿 slots 并注册三个席位。true = 至少一个注册调用没抛。 */
      function tryRegister() {
        attempts += 1;
        var slots;
        try {
          slots = (ctx && typeof ctx.get === "function") ? ctx.get("slots") : undefined;
        } catch (error) {
          warn("slot 获取失败：", error);
          return false;
        }
        if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return false;
        var any = false;
        // ① 主面板：侧栏图标 + 主区面板。
        //    ⚠️ 两处 id/key 必须同为 PANEL_ID；不一致时点图标会让布局抛错。
        try {
          slots.inject(SLOT_MAIN, function () {
            return slots.register({
              name: SLOT_MAIN,
              key: PANEL_ID,
              inject: function () { return {}; },
            }, Panel);
          });
          any = true;
        } catch (error) { warn("注册主面板失败：", error); }
        try {
          slots.inject(SLOT_PANELLIST, function () {
            return slots.register({
              name: SLOT_PANELLIST,
              id: PANEL_ID,
              order: 12,
              label: function () { return "产物库"; },
            }, PanelIcon);
          });
          any = true;
        } catch (error) { warn("注册侧栏图标失败：", error); }
        // ② 脚部入口：打开完整管理页。
        try {
          slots.inject(SLOT_ACTION, function () {
            return slots.register({
              name: SLOT_ACTION,
              id: "artifact-library-page",
              order: 60,
            }, FooterEntry);
          });
          any = true;
        } catch (error) { warn("注册脚部入口失败：", error); }
        return any;
      }

      registered = tryRegister();
      probeNote(probe, "reg1=" + registered);

      if (!registered) {
        retryTimer = setInterval(function () {
          if (registered) return;
          if (tryRegister()) {
            registered = true;
            if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
            probeNote(probe, "reg@" + attempts);
            // 原生入口已就位，撤掉 DOM 兜底，避免出现两个入口
            if (domDisposer) {
              try { domDisposer(); } catch (error) { /* 忽略 */ }
              domDisposer = null;
            }
          } else if (attempts >= 20) {
            if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
            probeNote(probe, "giveup@" + attempts);
          }
        }, 1500);
        try { domDisposer = applyViaDom(); } catch (error) { warn("DOM 兜底失败：", error); }
      }

      return function () {
        try { if (retryTimer) clearInterval(retryTimer); } catch (error) { /* 忽略 */ }
        try { if (domDisposer) domDisposer(); } catch (error) { /* 忽略 */ }
        try { if (probe && probe.parentNode) probe.parentNode.removeChild(probe); } catch (error) { /* 忽略 */ }
      };
    }

    exports.apply = apply;
    return module.exports;
  },
});
