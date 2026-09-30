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
 *   2. **兜底入口**（仍在服役，别删）—— `sidebar.footer.action` 按钮打开完整管理页。
 *      「第二期」只搬了 5 个里的 1 个（2026-09-30 逐条核对端点与调用）：
 *        ✅ 登记产物 —— 已搬（registerRow / batchRegister → POST /ext/artifacts）
 *        ❌ 导入文件夹 —— 未搬（全文无 POST /import；唯一调用方是 ui/index.html）
 *        ❌ 立即精炼   —— 未搬（无 /refine-session、/refine-request）
 *        ❌ 语义搜索   —— 未搬（主搜索框走 GET /ext/artifacts?q=，关键词≠语义）
 *        ❌ 整理建议   —— 未搬（无 /suggest-cleanup、/cleanup-now）
 *      这 4 项后端端点都已在 lib/http.js 就绪，缺的只是本文件里的 UI。
 *      → 搬完之前，ui/index.html 与这个入口都不能删。
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
    //   三条硬规矩：① 禁止 hex/rgba（自己写死颜色就永远不跟随深浅主题）；
    //   ② 禁止自造 CSS 变量（--alf-* 已全部清除）；③ 禁止 emoji 当图标。
    //   尺寸全部吃 --dsh-content-font-delta：用户调内容字号时布局不错位。
    var css = [
      "." + NS + "{",
      "  height:100%;display:flex;flex-direction:column;overflow:hidden;",
      "  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);",
      "  font-family:var(--dsw-font-family);font-size:var(--dsh-content-font-size-secondary,13px);",
      "  line-height:1.5;box-sizing:border-box;",
      "}",
      "." + NS + " *{box-sizing:border-box}",
      "." + NS + "__fallback{padding:24px;color:var(--dsw-alias-label-tertiary);font-size:13px}",
      // 头部
      "." + NS + "__head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px 10px;flex:none}",
      "." + NS + "__title{font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));font-weight:600;letter-spacing:.2px;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary)}",
      "." + NS + "__stats{display:flex;gap:8px;flex-wrap:wrap}",
      "." + NS + "__stat{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:3px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__stat b{color:var(--dsw-alias-label-primary);font-weight:600}",
      "." + NS + "__stat--warn{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-label)}",
      "." + NS + "__grow{flex:1}",
      "." + NS + "__warn{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label);padding:6px 18px;flex:none}",
      // 工具条
      "." + NS + "__toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:0 18px 10px;flex:none}",
      // 输入框属于「高层级表面」：border:0 + elevation（不把中性 border 和阴影配对）
      "." + NS + "__input,." + NS + "__select{background:var(--dsw-alias-bg-layer-2);border:0;box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);",
      "  border-radius:var(--dsw-radius-md);padding:5px 10px;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;outline:none;min-width:0}",
      "." + NS + "__input:focus-visible,." + NS + "__select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      "." + NS + "__input{flex:1;min-width:180px}",
      "." + NS + "__btn{display:inline-flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);",
      "  border-radius:var(--dsw-radius-sm);padding:5px 11px;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;cursor:pointer;",
      "  transition:background 100ms ease-out,border-color 100ms ease-out;white-space:nowrap}",
      "." + NS + "__btn:hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
      "." + NS + "__btn:disabled{opacity:.45;cursor:default}",
      "." + NS + "__btn--primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted);font-weight:500}",
      "." + NS + "__btn--primary:hover{background:var(--dsw-alias-button-primary-hover)}",
      "." + NS + "__btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      "." + NS + "__btn--ghost{background:transparent}",
      // 视图切换器 = 官方 SegmentedControl：外 R12 / 4px 内缩 / 段 R8 / 160ms
      "." + NS + "__seg{display:inline-flex;gap:2px;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);flex:none}",
      "." + NS + "__segi{height:calc(28px + var(--dsh-content-font-delta,0px));padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);",
      "  font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background 160ms ease,color 160ms ease}",
      "." + NS + "__segi:hover{color:var(--dsw-alias-label-primary)}",
      "." + NS + "__segi[data-on='1']{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__segi:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}",
      "@media (prefers-reduced-motion:reduce){." + NS + "__segi{transition:none}}",
      // 内容区
      "." + NS + "__body{flex:1;overflow:auto;padding:4px 18px 26px;position:relative;min-height:0}",
      "." + NS + "__cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:12px}",
      "." + NS + "__card{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);",
      "  overflow:hidden;display:flex;flex-direction:column;transition:border-color 100ms ease-out;cursor:pointer}",
      "." + NS + "__card:hover{border-color:var(--dsw-alias-border-l4)}",
      "." + NS + "__thumb{height:118px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;overflow:hidden}",
      "." + NS + "__thumb img{width:100%;height:100%;object-fit:cover;display:block}",
      "." + NS + "__cardbody{padding:10px 12px;display:flex;flex-direction:column;gap:5px;flex:1}",
      "." + NS + "__cardtitle{font-weight:600;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.45;word-break:break-all;",
      "  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      "." + NS + "__summary{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;",
      "  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      "." + NS + "__badges{display:flex;gap:5px;flex-wrap:wrap;align-items:center;font-size:11px;line-height:16px}",
      "." + NS + "__badge{display:inline-flex;align-items:center;gap:3px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);",
      "  border-radius:999px;corner-shape:round;padding:0 7px;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__badge--hot{border-color:var(--dsw-alias-state-warn-label);color:var(--dsw-alias-state-warn-label)}",
      "." + NS + "__badge--acc{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
      "." + NS + "__meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
      // 星级（SVG，不用 emoji）
      "." + NS + "__stars{display:inline-flex;gap:1px;color:var(--dsw-alias-label-caption);user-select:none}",
      "." + NS + "__star{background:0 0;border:0;padding:1px;cursor:pointer;color:inherit;display:inline-flex;border-radius:var(--dsw-radius-sm)}",
      "." + NS + "__star svg{width:13px;height:13px}",
      "." + NS + "__star:hover,." + NS + "__star--on{color:var(--dsw-alias-state-warn-label)}",
      "." + NS + "__star:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      // 表格
      "." + NS + "__table{width:100%;border-collapse:collapse;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);overflow:hidden}",
      "." + NS + "__table th,." + NS + "__table td{text-align:left;padding:7px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;vertical-align:middle}",
      "." + NS + "__table th{color:var(--dsw-alias-label-tertiary);font-weight:500;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2)}",
      "." + NS + "__table tr:last-child td{border-bottom:0}",
      "." + NS + "__table tbody tr{cursor:pointer}",
      "." + NS + "__table tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__path{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;word-break:break-all}",
      // 分组
      "." + NS + "__group{margin-bottom:16px}",
      "." + NS + "__grouph{font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;color:var(--dsw-alias-label-secondary);margin:0 0 9px;display:flex;align-items:center;gap:8px;font-weight:600}",
      "." + NS + "__grouph em{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-style:normal;font-weight:400}",
      // 抽屉（高层级表面：border:0 + elevation）
      "." + NS + "__mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);z-index:5}",
      "." + NS + "__drawer{position:absolute;top:0;right:0;bottom:0;width:min(430px,92%);z-index:6;",
      "  background:var(--dsw-alias-bg-layer-1);border:0;box-shadow:var(--dsw-elevation-panel);",
      "  display:flex;flex-direction:column;overflow:hidden}",
      "." + NS + "__drawerh{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}",
      "." + NS + "__drawerb{flex:1;overflow:auto;padding:14px 15px 20px;display:flex;flex-direction:column;gap:12px}",
      "." + NS + "__drawerf{display:flex;gap:7px;flex-wrap:wrap;padding:11px 15px;border-top:.5px solid var(--dsw-alias-border-l1);flex:none}",
      "." + NS + "__field{display:flex;flex-direction:column;gap:4px}",
      "." + NS + "__label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__value{font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary);word-break:break-all;line-height:1.6}",
      "." + NS + "__preview{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:120px;max-height:320px}",
      "." + NS + "__preview img{max-width:100%;max-height:320px;display:block}",
      "." + NS + "__preview video,." + NS + "__preview audio{max-width:100%;display:block}",
      "." + NS + "__pre{width:100%;max-height:300px;overflow:auto;margin:0;padding:12px;",
      "  font-family:var(--ds-font-family-code, ui-monospace, Consolas, monospace);font-size:11px;line-height:1.6;",
      "  white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}",
      // 空态 / toast
      "." + NS + "__empty{color:var(--dsw-alias-label-tertiary);text-align:center;padding:52px 20px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.9}",
      "." + NS + "__toast{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);z-index:9;",
      "  background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);border:0;",
      "  border-radius:var(--dsw-radius-md);padding:9px 16px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;",
      "  box-shadow:var(--dsw-elevation-prominent);max-width:80%;text-align:center}",
      // 应用级浮层（shell.overlay）里是 fixed 定位，且不抢鼠标事件
      "." + NS + "__toast--shell{position:fixed;bottom:28px;z-index:40;pointer-events:none}",
      // ── 目录视图（UI-SPEC §三）──────────────────────────────────────────
      "." + NS + "__bar{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;padding:2px 0 6px}",
      "." + NS + "__crumbs{display:flex;align-items:center;gap:2px;flex:1;min-width:0;overflow:hidden}",
      "." + NS + "__crumbs--fade{-webkit-mask-image:linear-gradient(to right,transparent,black 28px);mask-image:linear-gradient(to right,transparent,black 28px)}",
      "." + NS + "__crumb{background:0 0;border:0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;",
      "  padding:3px 6px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}",
      "." + NS + "__crumb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__crumb[aria-current='page']{color:var(--dsw-alias-label-primary);font-weight:500}",
      "." + NS + "__crumb:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      "." + NS + "__crumbs>*+*::before{content:'/';color:var(--dsw-alias-label-caption);margin-right:2px;font-size:12px}",
      "." + NS + "__dhead{display:flex;align-items:center;gap:6px;height:38px;padding:0 10px;flex:none;",
      "  border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      "." + NS + "__dcol{background:0 0;border:0;color:inherit;font:inherit;font-size:12px;line-height:18px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;padding:2px 4px;border-radius:var(--dsw-radius-sm)}",
      "." + NS + "__dcol:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__dcol:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      "." + NS + "__dcol[aria-sort='ascending'],." + NS + "__dcol[aria-sort='descending']{color:var(--dsw-alias-label-primary)}",
      // 列宽与行内列对齐：名称可伸缩（min 200px）/ 大小 80px / 时间 140px
      "." + NS + "__dcol--name{flex:1;min-width:200px;justify-content:flex-start}",
      "." + NS + "__dcol--size{width:80px;flex:none;justify-content:flex-end}",
      "." + NS + "__dcol--time{width:140px;flex:none;justify-content:flex-end}",
      "." + NS + "__dlist{display:flex;flex-direction:column}",
      // 虚拟滚动（>200 行才用）：自己拥有滚动容器，只有可见行在 DOM 里
      "." + NS + "__dwrap{height:100%;display:flex;flex-direction:column;min-height:0}",
      "." + NS + "__dscroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}",
      // 行：H32（标准档，UI-SPEC §3.1）。三档密度由 data-density 决定，不在内联样式里编码。
      "." + NS + "__drow{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:var(--dsw-radius-md);min-width:0;width:100%;",
      "  height:32px;min-height:calc(32px + var(--dsh-content-font-delta,0px));cursor:default;transition:background 100ms ease-out;outline:none}",
      "." + NS + "__dlist[data-density='compact'] ." + NS + "__drow{height:24px;min-height:calc(24px + var(--dsh-content-font-delta,0px))}",
      "." + NS + "__dlist[data-density='loose'] ." + NS + "__drow{height:44px;min-height:calc(44px + var(--dsh-content-font-delta,0px))}",
      "." + NS + "__drow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__drow:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}",
      "." + NS + "__drow[data-dir='1']{cursor:pointer}",
      "." + NS + "__drow[data-missing='1']{color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__dname{flex:1;min-width:200px;max-width:100%;display:flex;align-items:baseline;overflow:hidden;white-space:nowrap}",
      "." + NS + "__dnameText{display:flex;min-width:0;max-width:100%;overflow:hidden;align-items:baseline}",
      "." + NS + "__nmh{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "." + NS + "__nmt{flex:none;white-space:nowrap}",
      "." + NS + "__dsize{width:80px;flex:none;text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "." + NS + "__dtime{width:140px;flex:none;text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}",
      "." + NS + "__dtype{width:72px;flex:none;text-align:right;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "." + NS + "__dcol--type{width:72px;flex:none;justify-content:flex-end}",
      // ── 统一视图控制（task-11 架构 A）─────────────────────────────────────
      "." + NS + "__viewctl{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}",
      // 卡片 hover 操作区（task-13 C1）：**绝对定位** —— 不参与布局，所以 hover 不改卡片尺寸/网格
      "." + NS + "__cardact{position:absolute;top:6px;right:6px;z-index:2;display:flex;gap:2px;padding:2px;",
      "  background:var(--dsw-alias-bg-layer-3);border:0;border-radius:var(--dsw-radius-sm);box-shadow:var(--dsw-elevation-soft);",
      "  opacity:0;pointer-events:none;transition:opacity 100ms ease-out}",
      "." + NS + "__card:hover ." + NS + "__cardact,." + NS + "__card:focus-within ." + NS + "__cardact{opacity:1;pointer-events:auto}",
      "@media (prefers-reduced-motion:reduce){." + NS + "__cardact{transition:none}}",
      "." + NS + "__colpick{position:relative;display:inline-flex}",
      // ── 项目容器（task-11 ①）────────────────────────────────────────────
      "." + NS + "__projects{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;padding:4px 0}",
      "." + NS + "__pcard{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);",
      "  padding:12px 14px;display:flex;flex-direction:column;gap:5px;cursor:pointer;transition:border-color 100ms ease-out}",
      "." + NS + "__pcard:hover{border-color:var(--dsw-alias-border-l4)}",
      "." + NS + "__pcard:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      "." + NS + "__pcard--all{background:var(--dsw-alias-bg-layer-2)}",
      "." + NS + "__pcname{font-weight:600;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary);word-break:break-all}",
      "." + NS + "__pcmeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      "." + NS + "__pchint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}",
      // 目录里的卡片视图（与画廊同族的方块，只是尺寸档不同）
      "." + NS + "__dcards{display:flex;flex-wrap:wrap;gap:12px;align-content:flex-start}",
      // 操作区：固定 72px 占位防抖动，hover / :focus-within 才可见
      "." + NS + "__dact{width:72px;flex:none;display:flex;justify-content:flex-end;gap:0;visibility:hidden}",
      "." + NS + "__drow:hover ." + NS + "__dact,." + NS + "__drow:focus-within ." + NS + "__dact,." + NS + "__dact[data-open='1']{visibility:visible}",
      "." + NS + "__act{position:relative;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;background:0 0;border:0;",
      "  border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}",
      "." + NS + "__act::after{content:'';position:absolute;inset:-2px}",
      "." + NS + "__act:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__act:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      "." + NS + "__act svg{width:15px;height:15px}",
      "." + NS + "__fi{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}",
      "." + NS + "__fi svg{width:16px;height:16px}",
      // 图片缩略图：与图标同尺寸（16px，不撑行高），样式照抄官方缩略图
      "." + NS + "__dthumb{width:16px;height:16px;flex:none;display:block;object-fit:cover;",
      "  border:.5px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2)}",
      // Ctrl+P 快速跳转（浮层：position:fixed，逃出面板的 overflow:hidden 裁剪）
      "." + NS + "__finder{position:fixed;z-index:25;max-width:560px;box-sizing:border-box;",
      "  padding:8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);border:0;",
      "  box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column;gap:6px;overflow:hidden}",
      "." + NS + "__finderList{flex:1;min-height:0;max-height:280px;overflow:auto;display:flex;flex-direction:column;gap:1px}",
      "." + NS + "__finderItem{display:flex;align-items:center;gap:8px;background:0 0;border:0;color:var(--dsw-alias-label-primary);",
      "  font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;text-align:left;padding:6px 10px;",
      "  border-radius:var(--dsw-radius-sm);cursor:pointer}",
      "." + NS + "__finderItem:hover,." + NS + "__finderItem[data-on='1']{background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__finderHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:0 4px}",
      // 骨架屏：3~5 行，每行 = 行高（不用 spinner）
      "." + NS + "__skels{display:flex;flex-direction:column}",
      "." + NS + "__skel{height:32px;min-height:calc(32px + var(--dsh-content-font-delta,0px));display:flex;align-items:center;padding:5px 10px}",
      "." + NS + "__skelb{display:block;height:calc(12px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__skel:nth-child(1) ." + NS + "__skelb{width:34%}",
      "." + NS + "__skel:nth-child(2) ." + NS + "__skelb{width:52%}",
      "." + NS + "__skel:nth-child(3) ." + NS + "__skelb{width:44%}",
      "." + NS + "__skel:nth-child(4) ." + NS + "__skelb{width:61%}",
      // 状态块（空目录 / 无结果 / 索引未就绪）
      "." + NS + "__state{display:flex;flex-direction:column;align-items:center;gap:10px;padding:44px 20px;color:var(--dsw-alias-label-tertiary);text-align:center}",
      "." + NS + "__stateico{width:48px;height:48px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-caption)}",
      "." + NS + "__stateico svg{width:48px;height:48px}",
      "." + NS + "__statetitle{color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size,14px);line-height:22px}",
      "." + NS + "__statehint{font-size:12px;line-height:1.9;max-width:520px}",
      "." + NS + "__staterow{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}",
      // 说明行（例如列表被截断）
      // ── 画廊（缩略图墙；虚拟滚动用更低阈值，`galleryThumbSize` 立即生效）──────
      "." + NS + "__gwrap{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1}",
      "." + NS + "__gbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      "." + NS + "__gbar ." + NS + "__input{flex:1;min-width:200px}",
      "." + NS + "__gallery{display:flex;flex-wrap:wrap;gap:12px;overflow:auto;align-content:flex-start;flex:1;min-height:0;padding:4px}",
      "." + NS + "__gcell{margin:0;display:flex;flex-direction:column;gap:6px;align-items:center;cursor:pointer}",
      "." + NS + "__gcell[data-dir=\"1\"]{cursor:pointer}",
      "." + NS + "__gbox{display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);overflow:hidden}",
      "." + NS + "__gimg{object-fit:cover;display:block;border-radius:var(--dsw-radius-sm)}",
      "." + NS + "__gcap{max-width:100%;overflow:hidden}",
      "." + NS + "__gname{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}",
      "." + NS + "__note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:6px 10px 0}",
      // ── 多选与批量（task-9 §4.2）────────────────────────────────────────
      "." + NS + "__drow[data-sel='1']{background:var(--dsw-alias-interactive-bg-active)}",
      "." + NS + "__drow[data-sel='1']:hover{background:var(--dsw-alias-interactive-bg-active)}",
      "." + NS + "__selbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none;padding:5px 8px;margin:0 0 6px;",
      "  background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md)}",
      "." + NS + "__selcount{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}",
      "." + NS + "__selundo{display:inline-flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}",
      "." + NS + "__pathedit{display:inline-flex;align-items:center;gap:6px;flex:1;min-width:220px}",
      "." + NS + "__pathedit ." + NS + "__input{flex:1;min-width:180px}",
      // 拖入登记的目标区（拖拽经过时高亮；放上去 = 登记）
      "." + NS + "__drop{position:absolute;inset:0;z-index:12;display:flex;align-items:center;justify-content:center;",
      "  background:var(--dsw-alias-bg-mask-1);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);",
      "  border:2px dashed var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-lg);pointer-events:none}",
      // ── 设置面板（面板内页面）────────────────────────────────────────────
      "." + NS + "__setwrap{display:flex;flex-direction:column;gap:10px;min-height:0}",
      "." + NS + "__setpage{display:flex;flex-direction:column;gap:12px}",
      "." + NS + "__setbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      "." + NS + "__setgroup{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:10px 12px;display:flex;flex-direction:column;gap:8px}",
      "." + NS + "__setgh{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-weight:600;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__sethint{font-style:normal;font-weight:400;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__setrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:5px 0;border-top:.5px solid var(--dsw-alias-border-l1)}",
      "." + NS + "__setrow:first-of-type{border-top:0}",
      "." + NS + "__setlabel{display:flex;flex-direction:column;gap:2px;min-width:180px;flex:1;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__setctl{flex:none;display:inline-flex;align-items:center;gap:6px}",
      "." + NS + "__setval{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      "." + NS + "__input--num{width:110px}",
      "." + NS + "__input--lines{min-width:260px;font-family:var(--ds-font-family-code, ui-monospace, Consolas, monospace);font-size:11px}",
      "." + NS + "__switch{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}",
      "." + NS + "__setcols{display:inline-flex;gap:10px;flex-wrap:wrap}",
      "." + NS + "__setcol{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      "." + NS + "__setfile{display:none}",
      "." + NS + "__setreport{background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md);padding:10px 12px;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      "." + NS + "__setrh{font-weight:600;color:var(--dsw-alias-label-primary)}",
      "." + NS + "__setrerr{color:var(--dsw-alias-state-error-primary)}",
      // 右键菜单（自绘）。
      // 注：官方要求复用共享 Menu/MenuSurface，但本插件**没有构建步骤**（lib/client.js 直接跑），
      //     无法 import 官方组件，故用官方 token 自绘；且**不覆盖** --dsw-menu-surface-fill /
      //     --dsw-menu-backdrop-filter —— 菜单材质交给宿主。
      "." + NS + "__menu{position:fixed;z-index:30;min-width:172px;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);",
      "  border:0;box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column;gap:1px}",
      "." + NS + "__mi{display:flex;align-items:center;gap:8px;background:0 0;border:0;color:var(--dsw-alias-label-primary);font:inherit;",
      "  font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;text-align:left;padding:6px 10px;border-radius:var(--dsw-radius-sm);cursor:pointer}",
      "." + NS + "__mi:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__mi:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}",
      // ── 搜索视图（UI-SPEC §四）：两行式 ─────────────────────────────────
      "." + NS + "__chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:none}",
      "." + NS + "__chip{display:inline-flex;align-items:center;height:calc(26px + var(--dsh-content-font-delta,0px));padding:0 12px;border-radius:999px;corner-shape:round;",
      "  border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background 100ms ease-out}",
      "." + NS + "__chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__chip[data-on='1']{background:var(--dsw-alias-interactive-bg-active);border-color:transparent;color:var(--dsw-alias-label-primary)}",
      "." + NS + "__chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      "." + NS + "__frow{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:var(--dsw-radius-md);min-width:0;width:100%;",
      "  min-height:calc(" + ROW_H_SEARCH + "px + var(--dsh-content-font-delta,0px));transition:background 100ms ease-out}",
      "." + NS + "__frow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__frow:hover ." + NS + "__dact,." + NS + "__frow:focus-within ." + NS + "__dact{visibility:visible}",
      "." + NS + "__fmain{flex:1;min-width:200px;display:flex;flex-direction:column;justify-content:center;overflow:hidden}",
      "." + NS + "__fname{display:flex;min-width:0;align-items:baseline;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary)}",
      "." + NS + "__fdir{display:flex;min-width:0;align-items:baseline;font-size:11px;line-height:calc(16px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__fv{display:flex;flex-direction:column;gap:8px}",
      "." + NS + "__flist{display:flex;flex-direction:column}",
      // 「本轮改动」：两行式（文件名 + 目录），右侧 +/- 行数
      "." + NS + "__chgmain{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;overflow:hidden}",
      "." + NS + "__chgadd{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums;font-weight:500}",
      "." + NS + "__chgdel{color:var(--dsw-alias-state-error-primary);font-variant-numeric:tabular-nums;font-weight:500}",
      // 侧栏脚部入口（兜底）
      "." + NS + "-entry{",
      "  display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;",
      "  margin:4px 0;padding:7px 10px;",
      "  border-radius:var(--dsw-radius-sm);cursor:pointer;user-select:none;",
      "  font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-weight:500;line-height:1.4;text-align:left;",
      "  color:var(--dsw-alias-label-primary);",
      "  background:0 0;",
      "  border:.5px solid var(--dsw-alias-border-l2);",
      "  transition:background 100ms ease-out, border-color 100ms ease-out;",
      "}",
      "." + NS + "-entry:hover{",
      "  background:var(--dsw-alias-interactive-bg-hover);",
      "  border-color:var(--dsw-alias-border-l4);",
      "}",
      "." + NS + "-entry:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
      "." + NS + "-entry ." + NS + "-ei{display:inline-flex;align-items:center;color:var(--dsw-alias-label-secondary)}",
      "." + NS + "-ei svg{width:15px;height:15px}",
      "." + NS + "-entry ." + NS + "-el{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
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


    // ── 图标消费者（冻结接口 iconForName(name, isDirectory) → {svg, color}）──
    /**
     * 取一行/一张卡片要用的图标。
     *
     * **唯一的图标出口**：将来换成官方 `ui-primitives` 的 `FileTypeIcon`，
     * 只改这个函数，所有调用点不动。
     */
    function iconOf(name, isDirectory) {
      try {
        var got = iconForName(name, isDirectory);
        if (got && typeof got.svg === "string" && got.svg !== "") return got;
      } catch (error) { /* 绝不因为图标让整行画不出来 */ }
      return { svg: SHAPE_MARKUP.other, color: FILE_TYPE_COLORS.other };
    }

    /** 产物记录没有文件名时，用 artifact_type 反推一个代表性扩展名。 */
    var ARTIFACT_TYPE_EXT = { image: "png", audio: "mp3", video: "mp4", document: "docx", code: "js", archive: "zip", other: "bin" };

    /** 一条产物记录（产物库条目）的图标：优先按真实文件名分类。 */
    function iconForRecord(record) {
      var raw = record && record.path ? String(record.path) : "";
      if (!raw) raw = "x." + (ARTIFACT_TYPE_EXT[(record && record.artifact_type) || "other"] || "bin");
      return iconOf(raw, false);
    }

    /** 图标渲染：16×16 容器 + currentColor + 数据里的颜色。 */
    function IconView(h, icon, key) {
      return h("span", {
        key: key,
        className: NS + "__fi",
        style: { color: icon.color },
        "aria-hidden": "true",
        dangerouslySetInnerHTML: { __html: icon.svg },
      });
    }

    // ── 行规格常量（UI-SPEC §3.1 / §4）────────────────────────────────────
    /** 目录视图行高三档：紧凑 24 / **标准 32（默认）** / 宽松 44。 */
    var ROW_H_COMPACT = 24;
    var ROW_H_STANDARD = 32;
    var ROW_H_LOOSE = 44;
    /** 搜索视图两行式行高（§4：44~48）。 */
    var ROW_H_SEARCH = 44;
    /** 目录视图的三档密度（§3.1）：常量是唯一真相，CSS 与下拉都从这里取。 */
    var DENSITY_OPTIONS = [
      { key: "compact", label: "紧凑", h: ROW_H_COMPACT },
      { key: "standard", label: "标准", h: ROW_H_STANDARD },
      { key: "loose", label: "宽松", h: ROW_H_LOOSE },
    ];
    /** 每级缩进 18px（照抄官方 ui-sidebar-files 的 `.level .level`）。 */
    var INDENT_PER_LEVEL = 18;
    /** 目录行内边距（行左右各 10px，与 spec `.row{padding:5px 10px}` 一致）。 */
    var ROW_PAD_LEFT = 10;

    /** 行的左缩进（层级 × 18px）。DirBrowser 当前是单层浏览，depth 恒为 0。 */
    function rowIndent(depth) {
      return String(ROW_PAD_LEFT + (Number(depth) || 0) * INDENT_PER_LEVEL) + "px";
    }

    // ── 虚拟滚动（§3.7）──────────────────────────────────────────────────
    /**
     * 只在**超过阈值**的目录才启用：`/files/list` 默认 2000 条（硬上限 10000，超了带 `truncated`），几千文件的目录
     * 一次性渲染会卡；小目录走原路径，行为与虚拟化前逐字一致（风险最小）。
     * overscan 4 行；定位用 `transform: translateY`（不用 margin-top，避免重排）。
     */
    var VIRTUAL_THRESHOLD = 200;
    /** 列表缩略图缺省边长（设置的 `thumbSize` 覆盖它；16/24/32）。 */
    var THUMB_LIST_SIZE = 16;
    /** 画廊虚拟滚动阈值：**比列表低**（每屏项目少、单块更贵，200 对画廊是错的）。 */
    var GALLERY_VIRTUAL_THRESHOLD = 60;
    var VIRTUAL_OVERSCAN = 4;
    /** 一屏兜底高度（拿不到真实视口高度时用），只影响首帧渲染多少行。 */
    var VIRTUAL_VIEWPORT_FALLBACK = 600;

    /**
     * 读宿主的内容字号增量（`--dsh-content-font-delta`，形如 "2px"）。
     * 行高 = 基础档 + 该增量，所以虚拟滚动的 itemSize 必须把它算进去，否则行会错位。
     * 读不到就返回 0（旧宿主 / 测试环境）。
     */
    function contentFontDelta() {
      try {
        if (typeof document === "undefined" || typeof getComputedStyle !== "function") return 0;
        var host = document.body || document.documentElement;
        if (!host) return 0;
        var raw = getComputedStyle(host).getPropertyValue("--dsh-content-font-delta");
        var n = parseFloat(String(raw || ""));
        return isFinite(n) ? n : 0;
      } catch (error) { return 0; }
    }

    /** 当前密度下的一行实际高度（px）。 */
    function rowHeightPx(densityKey) {
      var base = ROW_H_STANDARD;
      if (densityKey === "compact") base = ROW_H_COMPACT;
      else if (densityKey === "loose") base = ROW_H_LOOSE;
      return base + contentFontDelta();
    }

    /** 自然序：file2 排在 file10 前（官方 ui-sidebar-files 同款）。 */
    var byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

    // ── 按路径取文件（官方认证路由）+ 缩略图 ────────────────────────────────
    /** 目录视图里可以出缩略图的图片扩展名（小写、无点）。 */
    var THUMB_EXTS = ["png", "jpg", "jpeg", "jpe", "gif", "webp", "bmp", "ico", "svg", "avif"];
    /** 超过这个大小的图片不拉缩略图（大图会把列表拖慢）。 */
    var THUMB_MAX_BYTES = 5 * 1024 * 1024;

    /** 取小写扩展名（无点）。 */
    function extOfName(name) {
      var s = String(name === undefined || name === null ? "" : name);
      var i = s.lastIndexOf(".");
      return i > 0 ? s.slice(i + 1).toLowerCase() : "";
    }

    /**
     * 文档基地址 —— 照抄官方 `documentpreview` 的 `fileMediaUrl` 思路：
     * 用**文档相对**地址，Web GUI（`http://127.0.0.1:19387/`）与桌面端
     * （`dsh-app://app/`）两种 origin 都能解析，不用分别硬编码。
     */
    function appBase() {
      try {
        if (typeof document !== "undefined" && typeof document.baseURI === "string") {
          var b = document.baseURI;
          if (/^https?:/i.test(b) || b.indexOf("dsh-app://app/") === 0) return b;
        }
      } catch (error) { /* 忽略 */ }
      if (fileOrigin && /^https?:/i.test(fileOrigin)) return fileOrigin + "/";
      return "";
    }

    /**
     * 官方「按路径取文件」的认证路由：`api/file?path=…`（同源请求自动带 cookie）。
     *
     * ⚠️ 现在**只当缩略图的后备**：官方这条走 `ctx.fs`（会话执行世界的读写策略），
     * 用户开受限沙箱时会被 `FS_SANDBOX_DENIED` 挡掉**范围外的产出目录** ——
     * 而那正是产物库要看的内容。首选是自建的 `/ext/artifacts/files/thumb`。
     */
    function officialFileUrl(p) {
      var raw = String(p === undefined || p === null ? "" : p);
      if (!/^[A-Za-z]:[\\/]/.test(raw) && raw.charAt(0) !== "/") return "";
      if (/^[/\\]{2}/.test(raw)) return "";
      if (/[\u0000-\u001f\u007f]/.test(raw)) return "";
      var base = appBase();
      if (!base) return "";
      try {
        return new URL("api/file?path=" + encodeURIComponent(raw), base).href;
      } catch (error) { return ""; }
    }

    /**
     * 本行该不该出缩略图，以及**两级 URL**（首选自建 / 后备官方）。
     *
     * 门槛：是文件、不是符号链接（链接不解析目标，直接给类型图标）、
     * 是图片扩展名、尺寸不超 5MB（端点也会拦 413，前端先拦可少一次请求）。
     * 自建端点用根相对路径即可 —— 插件其它 API 同前缀，两种 origin 都已经在走。
     */
    function thumbUrlsFor(row) {
      if (!row || row.isDirectory) return null;
      if (row.isSymbolicLink) return null;
      if (THUMB_EXTS.indexOf(extOfName(row.name || row.path)) < 0) return null;
      var size = Number(row.size);
      if (isFinite(size) && size > THUMB_MAX_BYTES) return null;
      return {
        primary: API + "/files/thumb?path=" + encodeURIComponent(String(row.path)),
        fallback: officialFileUrl(row.path),
      };
    }

    /**
     * 行的时间戳 → 毫秒。
     * 兼容两种形状：Everything 时代的 `modified`（秒）与 host 侧 readdir 的 `mtimeMs`（毫秒）。
     */
    function rowTimeMs(row) {
      if (!row) return 0;
      var ms = Number(row.mtimeMs);
      if (isFinite(ms) && ms > 0) return ms;
      var sec = Number(row.modified);
      if (isFinite(sec) && sec > 0) return sec * 1000;
      return 0;
    }

    /** 行的「修改时间」列文案（两种时间形状通吃）。 */
    function rowTimeText(row) {
      var ms = rowTimeMs(row);
      if (!ms) return "—";
      try {
        return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      } catch (error) { return "—"; }
    }

    // ── 「最近改动」端点适配（URL 只在这一处拼）────────────────────────────
    /**
     * 宿主端点：`/ext/artifacts/session-changes`，**形状与官方 `api/changes.summary` 原样对齐**
     * （host-dev task-7）。两种模式：
     *   · `?sessionId=&seq=` —— 坐标必须给全。**root 作用域的面板拿不到这两个值**（宿主机没有
     *     「用户正在看哪个会话」这个概念），所以这条我们实际用不上；
     *   · **`?recent=1`** —— 宿主自取「**最近一次** workspace/changes 公告」。响应带 `derived:true`。
     *
     * ⚠️ `derived:true` **不是「本次会话」**，UI 只许标「最近改动 · 会话 <短id>」。
     * `recent` 只认 `1` 或 `true`；不给坐标又不给 `recent` 会 400。
     */
    var CHANGES_ROUTE = "/session-changes";

    /** 拼「最近改动」请求路径（参数全部 encodeURIComponent）。`seq=0` 是合法坐标，别当空值。 */
    function sessionChangesUrl(sessionId, seq, recent) {
      if (recent) return CHANGES_ROUTE + "?recent=1";
      var params = [];
      if (sessionId) params.push("sessionId=" + encodeURIComponent(String(sessionId)));
      if (seq !== undefined && seq !== null && seq !== "") params.push("seq=" + encodeURIComponent(String(seq)));
      return CHANGES_ROUTE + (params.length ? "?" + params.join("&") : "");
    }

    /** 路径切成「目录前缀 + 末段」（`/` 与 `\` 都算分隔符）。 */
    function splitPathParts(p) {
      var s = String(p === undefined || p === null ? "" : p).replace(/[\\/]+$/, "");
      var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
      if (i < 0) return { dir: "", name: s };
      return { dir: s.slice(0, i + 1), name: s.slice(i + 1) };
    }

    /** 相对 cwd 的路径拼成绝对路径（端点给的是相对路径，cwd 外才是绝对）。 */
    function absoluteUnder(cwd, p) {
      var path = String(p === undefined || p === null ? "" : p);
      if (!path) return "";
      if (/^[A-Za-z]:[\\/]/.test(path) || path.charAt(0) === "/") return path;
      var base = String(cwd || "").replace(/[\\/]+$/, "");
      if (!base) return path;
      var rel = path.replace(/^[\\/]+/, "");
      // Windows 基路径下把相对段的 `/` 统一成 `\` —— 混用分隔符虽能用，但统一后更好读、也便于比较
      if (/^[A-Za-z]:/.test(base)) rel = rel.replace(/\//g, "\\");
      return base + "\\" + rel;
    }

    /**
     * 把端点返回值规范成渲染用的行模型（**官方原样字段**）：
     * `files[i] = { path, display, added, deleted, binary?, oversized? }`，
     * `index` 就是数组下标（官方没有该字段）。
     * `path` 在 cwd 内是相对路径 → 用响应里的 `cwd` 拼绝对（定位与图标分类都要绝对路径）。
     */
    function normalizeChanges(payload) {
      var raw = payload && payload.files;
      if (!Array.isArray(raw)) raw = payload && payload.changes;
      if (!Array.isArray(raw)) return [];
      var cwd = payload && payload.cwd ? String(payload.cwd) : "";
      return raw.map(function (item, i) {
        var source = item || {};
        var relative = String(source.path || source.display || "");
        var display = String(source.display || relative);
        var absolute = absoluteUnder(cwd, relative);
        var parts = splitPathParts(absolute || display);
        var added = Number(source.added);
        var deleted = Number(source.deleted);
        if (!isFinite(deleted)) deleted = Number(source.removed);
        return {
          index: i,
          path: absolute || display,
          relative: relative,
          display: display,
          dir: parts.dir,
          name: parts.name,
          added: isFinite(added) && added > 0 ? added : 0,
          deleted: isFinite(deleted) && deleted > 0 ? deleted : 0,
          binary: !!source.binary,
          oversized: !!source.oversized,
        };
      });
    }

    // ── 浮层定位（UI-SPEC §11.1②）────────────────────────────────────────
    /** 浮层与视口边缘的最小间距。 */
    var OVERLAY_MARGIN = 8;
    /** 浮层与锚点之间的间隙。 */
    var OVERLAY_GAP = 2;
    /**
     * 首帧用的**估计尺寸**（真实尺寸要等渲染完才量得到）。
     * 用估计值先夹一次，保证第一帧就不会飞出视口；渲染后再用实测尺寸校正。
     */
    var OVERLAY_ESTIMATE = { width: 208, height: 196 };

    /**
     * 把「锚点矩形 + 浮层尺寸 + 视口尺寸」算成最终坐标（纯函数，方便静态与单元验证）。
     *
     * 两条规则，顺序不能反：
     *  1. **翻转**：默认向下弹；**只有上方真放得下**（`aboveSpace >= height`）才翻上去 ——
     *     否则会出现「翻上去也放不下」的来回振荡。
     *  2. **夹取**：横竖都夹进视口并留 `OVERLAY_MARGIN`，**永远兜底** —— 保证四边不越界。
     *
     * @param {{left?:number, top?:number, right?:number, bottom?:number}} anchor 锚点矩形（视口坐标）
     * @param {{width?:number, height?:number}} size 浮层实测/估计尺寸
     * @param {{width?:number, height?:number}} viewport 视口尺寸
     * @returns {{x:number, y:number, placement:string}} 最终左上角坐标 + 落在哪一侧
     */
    function placeMenu(anchor, size, viewport) {
      var margin = OVERLAY_MARGIN;
      var gap = OVERLAY_GAP;
      var width = Math.max(Number(size && size.width) || 0, 0);
      var height = Math.max(Number(size && size.height) || 0, 0);
      var vw = Number(viewport && viewport.width) || 0;
      var vh = Number(viewport && viewport.height) || 0;
      var left = Number(anchor && anchor.left) || 0;
      var top = Number(anchor && anchor.top) || 0;
      var right = isFinite(Number(anchor && anchor.right)) ? Number(anchor.right) : left;
      var bottom = isFinite(Number(anchor && anchor.bottom)) ? Number(anchor.bottom) : top;
      // 量不到视口就别乱动（宁可原位，也不要算到屏幕外）
      if (!vw || !vh) return { x: left, y: bottom + gap, placement: "bottom" };

      var belowSpace = vh - bottom - gap - margin;
      var aboveSpace = top - gap - margin;
      var placement = "bottom";
      var y = bottom + gap;
      if (belowSpace < height && aboveSpace >= height) {
        y = top - gap - height;              // 只在**上方真放得下**时才翻，避免来回振荡
        placement = "top";
      }
      var x = right;                         // 默认贴锚点右侧展开
      x = Math.min(x, vw - width - margin);
      x = Math.max(x, margin);
      y = Math.min(y, vh - height - margin);
      y = Math.max(y, margin);
      return { x: x, y: y, placement: placement };
    }

    /** 最近访问过的目录（Ctrl+P 快速跳转用）。模块级：活得比一次渲染久。 */
    var RECENT_DIRS = [];
    var RECENT_DIRS_MAX = 12;

    // ── 设置面板的辅助（**键/枚举/范围全部来自 schema，不写死**）──────────
    /**
     * 设置键的文案。schema 只给结构（defaults/enums/ranges/booleans…）不给文案，
     * 所以中文标签补在这里；**未知键回落成键名**（后端加键时面板照样渲染得出来，
     * 只是没中文标签），不会因为缺文案而隐藏设置项。
     */
    var SETTING_LABELS = {
      preset: { label: "预设", hint: "一套起点值。选完仍可逐项微调；微调后宿主会自动标成「自定义」，已应用的值不会丢。" },
      density: { label: "行高密度", hint: "紧凑 24px / 标准 32px / 宽松 44px" },
      defaultView: { label: "默认视图", hint: "打开产物库时先落在哪个视图" },
      columns: { label: "列表列", hint: "目录视图里显示哪些列" },
      sortBy: { label: "默认排序", hint: "" },
      sortDir: { label: "排序方向", hint: "" },
      thumbnails: { label: "显示缩略图", hint: "图片行用缩略图代替类型图标" },
      thumbSize: { label: "缩略图尺寸", hint: "列表里缩略图的边长（px）" },
      galleryThumbSize: { label: "画廊缩略图尺寸", hint: "画廊视图方形缩略图的边长（px）" },
      thumbMaxBytes: { label: "缩略图大小上限", hint: "超过这个字节数的图不加载缩略图（0 = 不限制）。由宿主执行。" },
      listLimit: { label: "每次列出条数", hint: "目录一次返回多少条（越大越慢）。由宿主执行；显式传 limit 时以显式值为准。" },
      virtualThreshold: { label: "虚拟滚动阈值", hint: "超过多少行启用虚拟滚动（0 = 总是启用）" },
      showHidden: { label: "显示隐藏项", hint: "默认隐藏「点开头」的文件与已知系统噪音文件（desktop.ini / Thumbs.db / $RECYCLE.BIN…）。⚠️ 这是**近似规则** —— Windows 的「隐藏」文件属性读不到（Node fs.Stats 不暴露），不等于遵循系统隐藏设置。由宿主执行。" },
      panelWidth: { label: "面板宽度", hint: "null = 自动。目前只记忆数值，宽度生效留到有验收手段时再接。" },
      indexExtraDirs: { label: "额外索引目录", hint: "每行一个绝对路径（最多 64 个，自动去重）。由宿主执行。" },
      customPresets: { label: "自定义预设", hint: "高级：{ 名字: 部分外观键 }，名字限 [A-Za-z0-9_-]{1,32}" },
    };
    /** 列开关的中文名（columns 是嵌套对象）。 */
    var COLUMN_LABELS = { size: "大小", time: "修改时间", type: "类型" };

    function settingText(key) {
      if (Object.prototype.hasOwnProperty.call(SETTING_LABELS, key)) return SETTING_LABELS[key];
      return { label: String(key), hint: "" };
    }

    /** 控件形态**由 schema 推导**（不写死键）：boolean / enum / range / object / lines / other。 */
    function settingKind(schema, key) {
      if (schema && Array.isArray(schema.booleans) && schema.booleans.indexOf(key) >= 0) return "boolean";
      if (schema && schema.enums && schema.enums[key]) return "enum";
      if (schema && schema.ranges && schema.ranges[key]) return "range";
      if (key === "columns" || key === "customPresets") return "object";
      if (key === "indexExtraDirs") return "lines";
      return "other";
    }

    /** 人类可读的当前值（只读回显用）。 */
    function settingValueText(value) {
      if (value === null || value === undefined) return "自动";
      if (typeof value === "boolean") return value ? "开" : "关";
      if (Array.isArray(value)) return value.length ? value.join("、") : "（空）";
      if (typeof value === "object") {
        var parts = [];
        for (var key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) parts.push(key + "=" + String(value[key]));
        }
        return parts.length ? parts.join(" · ") : "（空）";
      }
      return String(value);
    }

    // ── `@` 引用来源（照抄官方 ui-reference 的结构）────────────────────────
    /**
     * 官方通道：root 作用域服务 `ctx.get("inputTriggers")`（`dsh-client-ui-input-trigger`，
     * `super(ctx, "inputTriggers")`），`registerSource(src)` 注册一个 `@` 来源。
     * 官方 `ui-reference:233` / `ui-skill:432` / `ui-commands:789` 都是这么做的。
     *
     * ⭐ 关键：`candidates(session, request)` 是**输入框在自己的会话作用域里回调我们**，
     * 所以我们**不需要知道「当前会话」** —— 这正好绕过了 root 作用域拿不到会话的死路
     * （session-changes 那条路就栽在这里）。
     *
     * ※ 我们**不做** hover 直接注入：那需要一个带有效 `draftRev` 的检测段
     * （`ui-conversation` 的 `insertReference(ref, span)` 会校验），外部构造不出来；
     * 硬做只能退化成「复制路径」，是假功能。
     */
    var AT_SOURCE_NAME = "artifact-library";

    /**
     * 官方 mention 形状（**官方函数名**是 `ui-reference.formatFileMention`；
     * **本文件里我们自己的这份叫 `atMention`**，宿主的兄弟实现叫 `fileMention` —— 三者不要写混）：
     * 无空白用 `@path`；含空白用 `@"path"`（目录是半开 `@"path`，用于下钻语义）；
     * 含控制字符或 `"` 一律判为不可用（返回空串）。
     * 路径统一用正斜杠 —— 官方 mention 就是这个形状。
     */
    function atMention(path, isDirectory) {
      var p = String(path === undefined || path === null ? "" : path).replace(/\\/g, "/");
      if (/[\u0000-\u001f\u007f-\u009f"]/.test(p)) return "";
      if (isDirectory) p = p.replace(/\/+$/, "") + "/";
      if (!/\s/.test(p)) return "@" + p;
      return isDirectory ? '@"' + p : '@"' + p + '"';
    }

    /** 候选行的 `value`（纯 JSON 字符串，选中后回传给 onPick 解析）。 */
    function atValueOf(path, label, isDirectory) {
      return JSON.stringify({ path: String(path || ""), label: String(label || ""), dir: !!isDirectory });
    }

    /** 解析候选行的 `value`（失败返回 null，绝不抛）。 */
    function parseAtValue(value) {
      try {
        var parsed = JSON.parse(String(value || ""));
        if (!parsed || typeof parsed.path !== "string" || parsed.path === "") return null;
        return { path: parsed.path, label: String(parsed.label || ""), isDirectory: !!parsed.dir };
      } catch (error) { return null; }
    }

    /** 取文件名（正/反斜杠都认）。 */
    function baseNameOf(p) {
      var s = String(p || "").replace(/[\\/]+$/, "");
      var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
      return i < 0 ? s : s.slice(i + 1);
    }

    /**
     * 注册 `@` 来源。**拿不到服务就优雅跳过**（旧宿主 / 该服务没装），
     * 并留一句可检索的日志 —— 将来用户问「为什么 @ 菜单里没有产物库」时能回答。
     *
     * @param {object} ctx 客户端插件上下文
     * @returns {Function|null} 注销函数（挂进 apply 的 disposer 链，避免重复注册）
     */
    function registerAtSource(ctx) {
      var triggers = null;
      try {
        triggers = ctx && typeof ctx.get === "function" ? ctx.get("inputTriggers") : undefined;
      } catch (error) { triggers = undefined; }
      if (!triggers || typeof triggers.registerSource !== "function") {
        try {
          if (typeof console !== "undefined" && console.info) {
            console.info("[artifact-library] inputTriggers 不可用，@ 来源未注册");
          }
        } catch (error) { /* 忽略 */ }
        return null;
      }

      var source = {
        trigger: "@",
        name: AT_SOURCE_NAME,
        showGroupTitle: false,
        /** 输入框在自己的会话作用域里回调：候选 = 产物库里的产物（按查询过滤）。 */
        candidates: function (session, request) {
          var req = request || {};
          var query = String(req.query || "").trim();
          if (req.signal && req.signal.aborted) return Promise.resolve([]);
          // 走我们自己的既有点：搜索产物（不依赖 Everything，索引没起也能用）
          return apiGet("/" + listQuery({ q: query, sort: "updated_desc" }))
            .then(function (items) {
              var list = Array.isArray(items) ? items : [];
              var rows = [];
              for (var i = 0; i < list.length && rows.length < 24; i += 1) {
                var record = list[i] || {};
                var path = String(record.path || "");
                if (!path) continue;
                var mention = atMention(path, false);
                if (!mention) continue;
                var name = baseNameOf(path) || String(record.title || record.id || "");
                var parts = splitPathParts(path);
                rows.push({
                  name: name,
                  description: parts.dir,
                  icon: "file",
                  section: "产物库",
                  value: atValueOf(path, name, false),
                });
              }
              return rows;
            })
            .catch(function () { return []; });   // 候选取不到就当没有，绝不打断输入框
        },
        /** 选中：插入的是**真正的引用 chip**（`source` 必须是本来源的名字，codec 才认）。 */
        onPick: function (pick) {
          var candidate = pick && pick.candidate ? pick.candidate : {};
          var parsed = parseAtValue(candidate.value);
          if (!parsed) return undefined;
          var mention = atMention(parsed.path, parsed.isDirectory);
          if (!mention) return undefined;
          return {
            insert: {
              source: AT_SOURCE_NAME,
              ref: mention,
              label: parsed.label || baseNameOf(parsed.path),
              appearance: parsed.isDirectory ? "folder" : "file",
              clipboardText: mention,
            },
          };
        },
        /** 引用序列化（照抄 ui-reference 的 codec 形状：ref 本身就是可读文本）。 */
        codec: {
          clipboardText: function (ref) { return ref; },
          serialize: function (ref) { return Promise.resolve(ref); },
        },
      };

      try {
        var disposer = triggers.registerSource(source);
        try {
          if (typeof console !== "undefined" && console.info) {
            console.info("[artifact-library] @ 来源已注册（在输入框打 @ 选产物库）");
          }
        } catch (error) { /* 忽略 */ }
        return function () {
          try { if (typeof disposer === "function") disposer(); } catch (error) { /* 忽略 */ }
        };
      } catch (error) {
        warn("@ 来源注册失败：", error);
        return null;
      }
    }
    /** 记一个最近目录（去重、最新的在前）。 */
    function rememberDir(p) {
      var dir = String(p || "").replace(/[\\/]+$/, "");
      if (!dir) return;
      var next = [dir];
      for (var i = 0; i < RECENT_DIRS.length && next.length < RECENT_DIRS_MAX; i += 1) {
        if (RECENT_DIRS[i] !== dir) next.push(RECENT_DIRS[i]);
      }
      RECENT_DIRS = next;
    }

    /**
     * 中间省略用的切分：主干交给 CSS 截断、扩展名整段留下。
     * GNOME 43 的理由：尾部省略丢掉的是**文件类型**这个最关键信息。
     */
    function nameParts(name) {
      var s = String(name === undefined || name === null ? "" : name);
      var dot = s.lastIndexOf(".");
      if (dot > 0 && dot < s.length - 1 && s.length - dot <= 12) {
        return { head: s.slice(0, dot), tail: s.slice(dot) };
      }
      return { head: s, tail: "" };
    }

    /** 中间省略的渲染（head 可截断 / tail 永远完整）。 */
    function NameText(h, name, className, key) {
      var parts = nameParts(name);
      return h("span", { key: key, className: className, title: String(name || "") },
        h("span", { className: NS + "__nmh" }, parts.head),
        parts.tail ? h("span", { className: NS + "__nmt" }, parts.tail) : null);
    }

    /** 搜索视图的筛选 chips（照抄 Everything 范式）。 */
    var FILTER_CHIPS = [
      { key: "", label: "全部" },
      { key: "doc", label: "文档" },
      { key: "image", label: "图片" },
      { key: "media", label: "音视频" },
      { key: "code", label: "代码" },
      { key: "archive", label: "压缩包" },
    ];
    var CHIP_EXTS = {
      doc: ["md", "markdown", "txt", "text", "log", "json", "xml", "yml", "yaml", "toml", "ini", "csv", "tsv", "pdf", "doc", "docx", "rtf", "odt", "xls", "xlsx", "ppt", "pptx"],
      image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "tif", "tiff", "heic", "psd", "ai", "fig"],
      media: ["mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"],
      code: ["js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "cs", "php", "lua", "html", "htm", "css", "scss", "less", "sh", "ps1", "bat", "cmd", "sql", "vue", "svelte"],
      archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab", "iso", "jar"],
    };

    /** 命中哪个 chip 组（认不出来算 other，任何 chip 都不隐藏它）。 */
    function chipOfName(name) {
      var s = String(name || "");
      var i = s.lastIndexOf(".");
      var ext = i > 0 ? s.slice(i + 1).toLowerCase() : "";
      if (!ext) return "";
      for (var key in CHIP_EXTS) {
        if (Object.prototype.hasOwnProperty.call(CHIP_EXTS, key) && CHIP_EXTS[key].indexOf(ext) >= 0) return key;
      }
      return "other";
    }

    /** chip 是否命中（"全部"/"other" 永远命中）。 */
    function chipMatches(chip, name) {
      if (!chip) return true;
      return chipOfName(name) === chip;
    }

    /** 只统计本地盘符路径的目录项数（照抄 Nautilus 的 local-only 语义；网络盘/UNC 跳过）。 */
    function isLocalPath(p) {
      return /^[A-Za-z]:[\\/]/.test(String(p || ""));
    }

    /** 骨架屏：3~5 行，每行正好一行高（不要 spinner）。 */
    function SkeletonRows(h, count) {
      var kids = [];
      for (var i = 0; i < count; i += 1) {
        kids.push(h("div", { className: NS + "__skel", key: "sk" + String(i) },
          h("span", { className: NS + "__skelb" })));
      }
      return h("div", { className: NS + "__skels", "aria-hidden": "true" }, kids);
    }

    // ── Toast 总线（模块级：活得比面板久）────────────────────────────────
    /**
     * 官方 UX 规范：瞬时结果用**应用级** Toast，且必须挂在**比上报界面活得久**的地方。
     * 面板内渲染的话，用户一关面板 toast 就没了 —— 所以走 `shell.overlay`。
     *
     * 回退：宿主的 slot 表里没有 `shell.overlay`（旧版本）时，`ShellToast` 根本不会被挂载，
     * 于是 `hasOverlay` 保持 false，`PanelInner.showToast` 自动退回面板内 toast。
     * **判定依据是「组件真的挂上了」而不是「注册没抛」** —— 注册成功但 slot 不存在时也不会丢提示。
     */
    var SLOT_OVERLAY = "shell.overlay";
    var toastBus = {
      message: "",
      timer: null,
      listeners: [],
      hasOverlay: false,
      subscribe: function (fn) {
        toastBus.listeners.push(fn);
        return function () {
          var i = toastBus.listeners.indexOf(fn);
          if (i >= 0) toastBus.listeners.splice(i, 1);
        };
      },
      emit: function (message) {
        toastBus.message = String(message === undefined || message === null ? "" : message);
        var snapshot = toastBus.listeners.slice();
        for (var i = 0; i < snapshot.length; i += 1) {
          try { snapshot[i](toastBus.message); } catch (error) { /* 单个订阅者出错不影响其他 */ }
        }
        if (toastBus.timer) { clearTimeout(toastBus.timer); toastBus.timer = null; }
        // 空消息 = 收起，不再续定时器（否则会每 2.2 秒空转一次）
        if (toastBus.message === "") return;
        toastBus.timer = setTimeout(function () { toastBus.emit(""); }, 2200);
      },
    };

    /** 应用级 Toast 浮层（`shell.overlay`）：面板卸载也不丢。 */
    function ShellToast() {
      var React = require("react");
      var h = React.createElement;

      var sMessage = React.useState(toastBus.message);
      var message = sMessage[0];
      var setMessage = sMessage[1];

      React.useEffect(function () {
        toastBus.hasOverlay = true;   // 真挂上了才算数（决定面板内是否兜底）
        var unsubscribe = toastBus.subscribe(function (next) { setMessage(next); });
        return function () {
          toastBus.hasOverlay = false;
          try { unsubscribe(); } catch (error) { /* 忽略 */ }
        };
      }, []);

      if (!message) return null;
      return h("div", {
        className: NS + "__toast " + NS + "__toast--shell",
        role: "status",
        "aria-live": "polite",
      }, String(message));
    }

    /** 状态块（空 / 无结果 / 错误态）：48px 图标 + 标题 + 提示 + 可选按钮。 */
    function StateBlock(h, iconSvg, title, hints, actions, key) {
      var kids = [
        h("span", { className: NS + "__stateico", "aria-hidden": "true", dangerouslySetInnerHTML: { __html: iconSvg } }),
        h("span", { className: NS + "__statetitle" }, title),
      ];
      (hints || []).forEach(function (line, i) {
        kids.push(h("span", { className: NS + "__statehint", key: "h" + String(i) }, line));
      });
      if (actions && actions.length) kids.push(h("span", { className: NS + "__staterow" }, actions));
      return h("div", { className: NS + "__state", key: key, role: "status" }, kids);
    }

    /** 状态图标（自绘，不用 emoji）。 */
    var STATE_ICON_FOLDER =
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M2.6 7.6a1.6 1.6 0 0 1 1.6-1.6h4.2l1.8 2.2h8.6a1.6 1.6 0 0 1 1.6 1.6v9a1.6 1.6 0 0 1-1.6 1.6H4.2a1.6 1.6 0 0 1-1.6-1.6z"/></svg>';
    var STATE_ICON_SEARCH =
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4 21 21"/></svg>';
    var STATE_ICON_ALERT =
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M12 3.4 21.4 20H2.6z"/><path d="M12 9.6v4.6"/><path d="M12 17.2h.01"/></svg>';

    /** 行内小图标按钮（打开 / 定位 / 登记 / 复制…），热区 ≥28×28 由 CSS 的 ::after 撑开。 */
    function RowAction(h, label, svgInner, onClick, extraClass) {
      return h("button", {
        type: "button",
        className: NS + "__act" + (extraClass ? " " + extraClass : ""),
        "aria-label": label,
        title: label,
        onClick: onClick,
        dangerouslySetInnerHTML: {
          __html: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + svgInner + "</svg>",
        },
      });
    }

    var ACT_ICON_OPEN = '<path d="M9.4 2.6H13.4v4"/><path d="M13.4 2.6 7.2 8.8"/><path d="M12.4 9.6v3.2a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V4.9a1 1 0 0 1 1-1h3.2"/>';
    /** `@` 引用图标（task-13：一键引用）。 */
    var ACT_ICON_AT = '<circle cx="8" cy="8" r="3.1"/><path d="M11.1 8v1.1a1.7 1.7 0 0 0 3.4 0V8a6.5 6.5 0 1 0-2.6 5.2"/>';
    var ACT_ICON_REVEAL = '<path d="M2.6 4.6a1 1 0 0 1 1-1h2.6l1.1 1.4h5.1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1z"/><path d="m6.6 9.4 1.8 1.8 1.8-1.8"/><path d="M8.4 11.2V7.4"/>';
    var ACT_ICON_REGISTER = '<path d="M8 3.4v9.2"/><path d="M3.4 8h9.2"/>';
    var ACT_ICON_COPY = '<rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.2"/><path d="M10.4 5.6V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.4a1 1 0 0 0 1 1h1.6"/>';

    // >>> INLINE-ICONS-BEGIN（由 scratch/inline-icons.cjs 生成，请勿手改）
    // 图标表内联自 lib/icons.js（因插件运行时无法 require 包内相对 ESM，见 chunk 规则）。改图标请改 lib/icons.js 再同步此处。
    // 纯数据 + 纯函数：零 import、零副作用。将来换成官方 ui-primitives 的 FileTypeIcon 时，
    // 只需要换掉下面 iconOf() 的实现，所有调用点不动。
    // 源文件指纹 lib/icons.js sha256[:16] = 3f7b7a93afa95679（两边不一致 = 漂移，需要同步）
    const FILE_TYPE_COLORS = {
      code: 'var(--dsw-static-deepseek-500)',
      markdown: 'var(--dsw-static-deepseek-500)',
      html: 'var(--dsw-static-deepseek-500)',
      excel: 'var(--dsw-static-green-500)',
      word: 'var(--dsw-static-deepseek-450)',
      ppt: 'var(--dsw-static-amber-500)',
      pdf: 'var(--dsw-static-red-600)',
      media: 'rgb(139,118,246)', // violet：官方注明无 token，唯一例外
      folder: 'var(--dsw-static-amber-400)',
      other: 'var(--dsw-static-neutral-bluish-300)',
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 图形素材：16×16 线性图标（16 种语义图形，靠「形状 + 颜色」区分）
     * 页框统一 x 4→12 / y 1.6→14.4，右上角折角。
     * 下面存的是「图形本体」，外壳由 SVG_OPEN/SVG_CLOSE 统一套（见 ICON_TABLE.shapes）
     * ──────────────────────────────────────────────────────────────────────── */
    const PAGE = 'M4 1.6h4.8L12 4.8v9.6H4z' // 带折角的文档
    const PAGE_FOLD = 'M8.8 1.6v3.2h3.2' // 折角折线
    const PLAIN_PAGE = 'M4 1.6h8v12.8H4z' // 无折角（纯文本）

    const SHAPE_SVG = {
      // 1. 目录
      folder:
        '<path d="M2.2 4.4a1 1 0 0 1 1-1h3.1l1.3 1.7h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z"/>',

      // 2. 源码：文档 + 终端提示符 >_（比 < > 在 16px 下更像"代码"）
      code:
        `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
        '<path d="M5.6 7.2 7.3 9 5.6 10.8"/><path d="M8.4 10.8h3.1"/>',

      // 3. JSON：文档 + { }（中点是尖的，别画成圆括号）
      json:
        `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
        '<path d="M7 6.7H6.2a.8.8 0 0 0-.8.8v1.1a.8.8 0 0 0-.8.8a.8.8 0 0 0 .8.8v1.1a.8.8 0 0 0 .8.8H7"/>' +
        '<path d="M9 6.7h.8a.8.8 0 0 1 .8.8v1.1a.8.8 0 0 1 .8.8a.8.8 0 0 1-.8.8v1.1a.8.8 0 0 1-.8.8H9"/>',

      // 4. Markdown：文档 + M
      markdown: `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/><path d="M5.7 11.6V7.8l2 2.4 2-2.4v3.8"/>`,

      // 5. HTML：文档 + </ >（左右尖括号各让开，中间的斜杠不压线）
      html:
        `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
        '<path d="M6.4 7.6 5.3 9.4l1.1 1.8"/><path d="M8.5 6.7 7.5 12.1"/><path d="M9.6 7.6 10.7 9.4 9.6 11.2"/>',

      // 6. Word / 富文本文档：文档 + 折角 + 三条正文线
      doc:
        `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
        '<path d="M5.9 7.4h4.2"/><path d="M5.9 9.6h4.2"/><path d="M5.9 11.8h2.6"/>',

      // 7. 纯文本：无折角文档 + 四行
      text:
        `<path d="${PLAIN_PAGE}"/>` +
        '<path d="M5.9 5.4h4.2"/><path d="M5.9 7.6h4.2"/><path d="M5.9 9.8h4.2"/><path d="M5.9 12h2.2"/>',

      // 8. 表格：文档 + 网格
      sheet:
        `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
        '<rect x="5.4" y="6.6" width="5.2" height="6" rx="0.5"/>' +
        '<path d="M5.4 8.6h5.2"/><path d="M8 6.6v6"/>',

      // 9. 演示文稿：投影板 + 支架（无页框，形状自成一类）
      slides:
        '<path d="M2.4 4.4a.8.8 0 0 1 .8-.8h9.6a.8.8 0 0 1 .8.8v5.6a.8.8 0 0 1-.8.8H3.2a.8.8 0 0 1-.8-.8z"/>' +
        '<path d="M8 10.8v2.4"/><path d="M5.6 13.6h4.8"/>',

      // 10. PDF：文档 + 一行 + 实心印章（实心块是它和 word 的区分点）
      pdf:
        `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>` +
        '<path d="M5.9 7.4h4.2"/>' +
        '<rect x="5.6" y="9.4" width="4.8" height="2.8" rx="0.7" fill="currentColor"/>',

      // 11. 图片：相框 + 太阳 + 山
      image:
        '<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.2"/>' +
        '<circle cx="5.9" cy="6.6" r="1.05"/>' +
        '<path d="M3.2 12.3 6.6 8.8l1.9 2.1 2-2.3 2.5 3.7"/>',

      // 12. 视频：画面 + 播放三角
      video:
        '<rect x="2.4" y="3.6" width="11.2" height="8.8" rx="1.2"/>' +
        '<path d="M6.5 6.2 10.2 8l-3.7 1.8z" fill="currentColor"/>',

      // 13. 音频：双音符（符头 + 符干 + 符梁）
      audio:
        '<circle cx="5.5" cy="11.4" r="1.15"/><circle cx="10.3" cy="10.2" r="1.15"/>' +
        '<path d="M6.65 11.4V5.8"/><path d="M11.45 10.2V4.6"/><path d="M6.65 5.8 11.45 4.6"/>',

      // 14. 压缩包：盒身 + 盒盖 + 拉链
      archive:
        '<path d="M2.6 3.2h10.8v2.4H2.6z"/><path d="M3.4 5.6h9.2v8.4H3.4z"/>' +
        '<path d="M8 5.6v3.4"/><rect x="7.3" y="9" width="1.4" height="1.8" rx="0.4"/>',

      // 15. 二进制 / 可执行 / 字体：芯片（方形本体 + 八只引脚）
      binary:
        '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.3"/>' +
        '<path d="M6.6 2.4v2"/><path d="M9.4 2.4v2"/>' +
        '<path d="M6.6 11.6v2"/><path d="M9.4 11.6v2"/>' +
        '<path d="M2.4 6.6h2"/><path d="M2.4 9.4h2"/>' +
        '<path d="M11.6 6.6h2"/><path d="M11.6 9.4h2"/>',

      // 16. 未知类型：光板文档
      other: `<path d="${PAGE}"/><path d="${PAGE_FOLD}"/>`,
    }

    /** 图形 → 官方色表键（16 种图形收敛到 8 个颜色 + folder） */
    const SHAPE_COLOR = {
      folder: 'folder',
      code: 'code',
      json: 'code',
      markdown: 'markdown',
      html: 'html',
      doc: 'word',
      text: 'other',
      sheet: 'excel',
      slides: 'ppt',
      pdf: 'pdf',
      image: 'media',
      video: 'media',
      audio: 'media',
      archive: 'other',
      binary: 'other',
      other: 'other',
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 扩展名 → 图形（键一律小写、不含前导点；多段扩展名整段写，如 tar.gz）
     * ──────────────────────────────────────────────────────────────────────── */
    const EXT_TYPE = {
      // 源码
      js: 'code', mjs: 'code', cjs: 'code', jsx: 'code', ts: 'code', tsx: 'code',
      py: 'code', pyw: 'code', rb: 'code', go: 'code', rs: 'code', java: 'code',
      kt: 'code', kts: 'code', swift: 'code', c: 'code', h: 'code', cc: 'code',
      cpp: 'code', cxx: 'code', hpp: 'code', cs: 'code', php: 'code', lua: 'code',
      pl: 'code', r: 'code', dart: 'code', scala: 'code', groovy: 'code',
      vue: 'code', svelte: 'code',
      // 样式 / 脚本 / 配置 —— 一并归 code（形状靠内容区分成本高，颜色一致）
      css: 'code', scss: 'code', sass: 'code', less: 'code', styl: 'code',
      sh: 'code', bash: 'code', zsh: 'code', fish: 'code', ps1: 'code', psm1: 'code',
      bat: 'code', cmd: 'code', sql: 'code',
      yml: 'code', yaml: 'code', toml: 'code', ini: 'code', cfg: 'code',
      conf: 'code', env: 'code', properties: 'code', xml: 'code', plist: 'code',
      // 数据
      json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', geojson: 'json',
      // 文本 / 文档
      md: 'markdown', markdown: 'markdown', mdx: 'markdown', rst: 'markdown',
      txt: 'text', text: 'text', log: 'text', nfo: 'text', srt: 'text', vtt: 'text',
      html: 'html', htm: 'html', xhtml: 'html',
      doc: 'doc', docx: 'doc', rtf: 'doc', odt: 'doc', pages: 'doc',
      xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', csv: 'sheet', tsv: 'sheet',
      ods: 'sheet', numbers: 'sheet',
      ppt: 'slides', pptx: 'slides', pps: 'slides', ppsx: 'slides', odp: 'slides', key: 'slides',
      pdf: 'pdf',
      // 图片 / 音视频
      png: 'image', jpg: 'image', jpeg: 'image', jpe: 'image', gif: 'image',
      webp: 'image', avif: 'image', svg: 'image', bmp: 'image', ico: 'image',
      tif: 'image', tiff: 'image', heic: 'image', heif: 'image', raw: 'image',
      psd: 'image', psb: 'image', ai: 'image', xd: 'image', fig: 'image', blend: 'image',
      mp4: 'video', m4v: 'video', mov: 'video', avi: 'video', mkv: 'video',
      webm: 'video', wmv: 'video', flv: 'video', mpg: 'video', mpeg: 'video', m2ts: 'video',
      mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio',
      ogg: 'audio', oga: 'audio', opus: 'audio', wma: 'audio', mid: 'audio', midi: 'audio',
      // 压缩包
      zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
      tgz: 'archive', bz2: 'archive', xz: 'archive', zst: 'archive', lz: 'archive',
      lzma: 'archive', cab: 'archive', iso: 'archive', jar: 'archive', war: 'archive',
      'tar.gz': 'archive', 'tar.bz2': 'archive', 'tar.xz': 'archive', 'tar.zst': 'archive',
      // 二进制 / 可执行 / 字体
      exe: 'binary', msi: 'binary', dll: 'binary', so: 'binary', dylib: 'binary',
      bin: 'binary', lnk: 'binary', app: 'binary', apk: 'binary', deb: 'binary',
      rpm: 'binary', dmg: 'binary', class: 'binary', pyc: 'binary', wasm: 'binary',
      ttf: 'binary', otf: 'binary', woff: 'binary', woff2: 'binary', eot: 'binary',
    }

    /* ────────────────────────────────────────────────────────────────────────
     * 文件名 → 图形（优先于扩展名）
     * ──────────────────────────────────────────────────────────────────────── */
    const FILENAME_TYPE = {
      // 包/工程清单：JSON
      'package.json': 'json',
      'package-lock.json': 'json',
      'composer.json': 'json',
      'tsconfig.json': 'json',
      'jsconfig.json': 'json',
      'manifest.json': 'json',
      // 忽略文件 / 编辑器配置：纯文本
      '.gitignore': 'text',
      '.gitattributes': 'text',
      '.gitmodules': 'text',
      '.npmignore': 'text',
      '.dockerignore': 'text',
      '.eslintignore': 'text',
      '.prettierignore': 'text',
      '.editorconfig': 'text',
      // 说明文档（无扩展名的按 Markdown 惯例）
      'readme': 'markdown',
      'readme.md': 'markdown',
      'agents.md': 'markdown',
      'claude.md': 'markdown',
      'contributing.md': 'markdown',
      'changelog.md': 'markdown',
      'code_of_conduct.md': 'markdown',
      'security.md': 'markdown',
      // 许可证 / 法务文本
      license: 'text',
      licence: 'text',
      copying: 'text',
      notice: 'text',
      authors: 'text',
      'license.md': 'markdown',
      'license.txt': 'text',
      // 构建脚本
      dockerfile: 'code',
      makefile: 'code',
      rakefile: 'code',
      gemfile: 'code',
      vagrantfile: 'code',
      procfile: 'code',
      'cmakelists.txt': 'code',
      '.env': 'code',
    }

    /** 前缀规则：Dockerfile.prod / .env.local 这类 */
    const FILENAME_PREFIX_TYPE = [
      ['dockerfile', 'code'],
      ['.env', 'code'],
      ['makefile', 'code'],
    ]

    /** SVG 外壳：16×16、currentColor、aria-hidden（图形本体之外的一切） */
    const SVG_OPEN =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" ' +
      'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true" focusable="false">'
    const SVG_CLOSE = '</svg>'

    /** 预拼成完整 inline SVG（图形本体 + 外壳）：ICON_TABLE.shapes 与门禁扫描都用它 */
    const SHAPE_MARKUP = Object.keys(SHAPE_SVG).reduce((acc, name) => {
      acc[name] = SVG_OPEN + SHAPE_SVG[name] + SVG_CLOSE
      return acc
    }, {})

    /* ════════════════════════════════════════════════════════════════════════
     * ICON_TABLE —— 图标表的**单一真相源**
     *
     * 纯 JSON 可序列化：只有字符串 / 对象 / 数组，**没有函数、没有正则**
     * （`JSON.parse(JSON.stringify(ICON_TABLE))` 往返后行为逐字节一致，见自测）。
     *
     * 内联进 lib/client.js 时把 `ICON_TABLE` 与 `buildIconResolver` 两段源码
     * 原样粘贴即可 —— 数据与逻辑都在，不需要人工翻译任何一步。
     * ════════════════════════════════════════════════════════════════════════ */
    const ICON_TABLE = {
      /** 色键 → CSS 值（官方 token，无 hex） */
      colors: { ...FILE_TYPE_COLORS },
      /** 图形键 → 色键 */
      shapeColor: { ...SHAPE_COLOR },
      /** 图形键 → 完整 inline SVG 字符串（已含外壳，开箱即用） */
      shapes: { ...SHAPE_MARKUP },
      /** 扩展名（小写、无点、可多段）→ 图形键 */
      extensions: { ...EXT_TYPE },
      /** 完整文件名（小写）→ 图形键，优先于扩展名 */
      filenames: { ...FILENAME_TYPE },
      /** 文件名前缀 → 图形键（Dockerfile.prod / .env.local） */
      filenamePrefixes: FILENAME_PREFIX_TYPE.map((pair) => [pair[0], pair[1]]),
      /** 目录用的图形键 */
      dirType: 'folder',
      /** 认不出来时回落的图形键 */
      fallback: 'other',
    }

    /**
     * 由一张表造出解析函数 —— **自包含**（不引用本文件任何私有 helper），
     * 因此可以整段复制进 `lib/client.js`。
     *
     * @param {object} [table] 形如 `ICON_TABLE` 的纯数据表
     * @returns {(name: string, isDirectory?: boolean) => { svg: string, color: string }}
     *   返回值恰好 `{ svg, color }`；另挂了 `.typeOf(name, isDirectory)` 便于排查
     */
    function buildIconResolver(table) {
      const t = table || {}
      const shapes = t.shapes || {}
      const colors = t.colors || {}
      const shapeColor = t.shapeColor || {}
      const extMap = t.extensions || {}
      const nameMap = t.filenames || {}
      const prefixes = Array.isArray(t.filenamePrefixes) ? t.filenamePrefixes : []
      const fallback = shapes[t.fallback] ? t.fallback : 'other'
      const dirType = shapes[t.dirType] ? t.dirType : fallback

      /** 取路径最后一段（客户端里不能 import node:path） */
      function baseName(name) {
        const s = String(name == null ? '' : name).replace(/[\\/]+$/, '')
        const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
        return i === -1 ? s : s.slice(i + 1)
      }

      /** 扩展名候选，最长优先：a.tar.gz → ['tar.gz', 'gz'] */
      function candidates(base) {
        const out = []
        const parts = base.split('.')
        for (let i = 1; i < parts.length; i++) {
          const cand = parts.slice(i).join('.')
          if (cand) out.push(cand)
        }
        return out.sort((a, b) => b.length - a.length)
      }

      /** 判定图形键 */
      function typeOf(name, isDirectory) {
        const raw = String(name == null ? '' : name)
        if (isDirectory || /[\\/]$/.test(raw)) return dirType

        const base = baseName(raw).toLowerCase()
        if (!base) return fallback

        const exact = nameMap[base]
        if (exact) return exact

        for (let i = 0; i < prefixes.length; i++) {
          const pair = prefixes[i]
          if (pair && typeof pair[0] === 'string' && base.indexOf(pair[0]) === 0) return pair[1]
        }

        // 无扩展名的裸文件：只有文件名规则认得出（LICENSE / Dockerfile …），
        // 其余一律当未知类型 —— 不去猜内容
        const list = candidates(base)
        for (let i = 0; i < list.length; i++) {
          const hit = extMap[list[i]]
          if (hit) return hit
        }
        return fallback
      }

      function resolve(name, isDirectory) {
        const type = typeOf(name, isDirectory)
        const colorKey = shapeColor[type] || fallback
        return {
          svg: shapes[type] || shapes[fallback] || '',
          color: colors[colorKey] || colors[fallback] || '',
        }
      }
      resolve.typeOf = typeOf
      resolve.extensionCandidates = function (name) {
        return candidates(baseName(String(name == null ? '' : name)).toLowerCase())
      }
      return resolve
    }

    /** 模块级解析器：与内联版 `buildIconResolver(ICON_TABLE)` 完全等价 */
    const resolveIcon = buildIconResolver(ICON_TABLE)

    /**
     * 按文件名取图标与颜色。
     *
     * @param {string} name 文件名或路径（路径只取最后一段）
     * @param {boolean} [isDirectory] 是否目录
     * @returns {{ svg: string, color: string }}
     *   svg   —— 16×16 inline SVG 字符串，stroke/fill 用 currentColor
     *   color —— `var(--dsw-static-*)` 或 `rgb(139,118,246)`，**不含 hex**
     */
    function iconForName(name, isDirectory) {
      const hit = resolveIcon(name, isDirectory)
      // 冻结契约：只回 { svg, color }，多一个字段都不要
      return { svg: hit.svg, color: hit.color }
    }

    /**
     * 判定图形键（folder / code / json / …）—— 调试与自测用，不在冻结契约内。
     */
    function fileTypeOf(name, isDirectory) {
      return resolveIcon.typeOf(name, isDirectory)
    }

    /**
     * 扩展名候选，最长优先：`extensionCandidates('a.tar.gz')` → `['tar.gz','gz']`
     */
    function extensionCandidates(name) {
      return resolveIcon.extensionCandidates(name)
    }
    // <<< INLINE-ICONS-END

    // ── 小组件 ────────────────────────────────────────────────────────────
    /** 星形路径（实心 / 空心共用一条，避免 emoji 字符 ★☆）。 */
    var STAR_PATH = "M8 1.9 9.85 6h4.35l-3.5 2.7 1.35 4.3L8 10.4l-4.05 2.6L5.3 8.7 1.8 6h4.35z";

    /** 一颗星（点击即写）。单颗单独建函数，避开循环里的闭包捕获。 */
    function StarButton(h, record, n, onSet) {
      var on = n <= (record.stars || 0);
      return h("button", {
        key: "star" + String(n),
        type: "button",
        className: NS + "__star" + (on ? " " + NS + "__star--on" : ""),
        "aria-label": "打 " + String(n) + " 星",
        title: "点击打分",
        onClick: function (event) {
          event.stopPropagation();
          if (onSet) onSet(record.id, n);
        },
        dangerouslySetInnerHTML: {
          __html: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="' +
            STAR_PATH + '"' + (on ? ' fill="currentColor"' : "") + "/></svg>",
        },
      });
    }

    /** 星级（点击即写）。 */
    function Stars(h, record, onSet) {
      var kids = [];
      for (var i = 1; i <= 5; i += 1) kids.push(StarButton(h, record, i, onSet));
      return h("div", { className: NS + "__stars", role: "group", "aria-label": "星级" }, kids);
    }

    /** 缩略图（图片用绝对源；缺失/非图片退回图标）。 */
    /**
     * 卡片/详情上的缩略图区。`px` = 卡片尺寸档位换算出的高度（task-11 ③），
     * 不给就用 CSS 里的默认高 —— 这样「小/中/大」在卡片视图里肉眼可见。
     */
    function Thumb(h, record, big, px) {
      var box = big ? NS + "__preview" : NS + "__thumb";
      var style = (!big && isFinite(Number(px)) && Number(px) > 0) ? { height: String(Math.round(Number(px) * 1.2)) + "px" } : null;
      if (!record.exists) {
        return h("div", { className: box, style: style },
          h("span", { className: NS + "__fi", "aria-hidden": "true", dangerouslySetInnerHTML: { __html: iconOf(record.path, false).svg } }));
      }
      if (isImage(record)) {
        return h("div", { className: box, style: style },
          h("img", { src: fileUrl(record.id), alt: "", loading: "lazy" }));
      }
      return h("div", { className: box, style: style },
        h("span", { className: NS + "__fi", "aria-hidden": "true", dangerouslySetInnerHTML: { __html: iconForRecord(record).svg } }));
    }

    /** 一批徽章（类型 / 资料 / 待精化 / 项目 / 归档）。 */
    /**
     * 来源 → 人话。
     *
     * 刻意**按 `source` 分组说明「这东西是谁弄进来的」**，而不是按扩展名猜类型
     * （host-dev 的数据佐证：`out/`/`build/`/`dist/` 里常是**真交付物** —— 渲染的 mp4、
     * 导出的 .blend、编译的 .exe；按扩展名或目录名过滤会把真东西误杀）。
     *
     * `present` 是模型用官方 `present` 工具**明确声明**的交付物（最高置信来源）。
     */
    var SOURCE_LABELS = {
      present: "模型声明",
      manual: "手动登记",
      session: "会话产出",
      "folder-import": "导入资料",
    };

    function sourceLabel(source) {
      var key = String(source || "");
      if (Object.prototype.hasOwnProperty.call(SOURCE_LABELS, key)) return SOURCE_LABELS[key];
      return key;   // 未知来源原样显示，不吞掉（后端加新 source 时看得见）
    }

    /** 卡片/详情上的徽标。 */
    function Badges(h, record) {
      var typeIcon = iconForRecord(record);
      var kids = [
        h("span", { className: NS + "__badge", key: "t" },
          h("span", { className: NS + "__fi", style: { color: typeIcon.color }, "aria-hidden": "true", dangerouslySetInnerHTML: { __html: typeIcon.svg } }),
          String(record.artifact_type || "other")),
      ];
      if (record.kind === "reference") kids.push(h("span", { className: NS + "__badge", key: "k" }, "资料"));
      // 来源徽标：模型声明的最该让人一眼看见（它是「AI 主动说这是我做的东西」）
      if (record.source) {
        kids.push(h("span", {
          className: NS + "__badge" + (record.source === "present" ? " " + NS + "__badge--acc" : ""),
          key: "s",
          title: "来源：" + sourceLabel(record.source),
        }, sourceLabel(record.source)));
      }
      if (record.needsRefine) {
        kids.push(h("span", {
          className: NS + "__badge " + NS + "__badge--hot",
          key: "r",
        }, record.refineRequested ? "优先精化" : "待精化"));
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

      /** 「本会话」筛选：只看最近一轮会话登记的产物（用户最关心「这一轮到底改了什么」）。 */
      var sSessionOnly = React.useState(false);
      var sessionOnly = sSessionOnly[0];
      var setSessionOnly = sSessionOnly[1];

      /** 用户是否手动切过视图（切过就不再被设置里的 defaultView 覆盖）。 */
      var viewTouchedRef = React.useRef(false);

      /**
       * 「改动」入口**只在真的有数据时才出现**（null = 还没探到 / false = 没有）。
       *
       * 依据 lead 的判定：`/session-changes?recent=1` 若一直 404（`nothing-observed`），
       * 它就是个「永远 404 的端点」→ 该做的是**把入口整块摘掉**，而不是留个空面板等它。
       * 探到 `files.length > 0` 才置 true；网络错误也按 false 处理（不占用户注意力）。
       */
      var sChanges = React.useState(null);
      var changesAvailable = sChanges[0];
      var setChangesAvailable = sChanges[1];

      /**
       * 当前设置（**渲染真的读它** —— 设置面板改完立即生效，不是只存值）。
       * 初值 null：拉到之前用内置缺省渲染；拉到之后以宿主值为准。
       */
      var sSettings = React.useState(null);
      var settings = sSettings[0];
      var setSettings = sSettings[1];

      var debounceRef = React.useRef(null);
      var toastRef = React.useRef(null);
      var filtersRef = React.useRef(filters);
      filtersRef.current = filters;

      /**
       * 弹一条提示（2.2 秒自动消失）。
       * 有应用级浮层（`shell.overlay`）时走它 —— 面板卸载也不会丢；没有则退回面板内 toast。
       */
      var showToast = React.useCallback(function (message) {
        if (toastBus.hasOverlay) {
          toastBus.emit(message);
          return;
        }
        setToast(String(message));
        if (toastRef.current) clearTimeout(toastRef.current);
        toastRef.current = setTimeout(function () { setToast(""); }, 2200);
      }, []);

      /** 拉列表（用当前筛选）。 */
      var reload = React.useCallback(function () {        var current = filtersRef.current;
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

      /**
       * 探一次「最近改动」有没有数据：**有才显示入口**。
       * 404/网络错误/空列表都按「没有」处理 —— 不占用户注意力（lead 的判定：一直 404 就该整块摘掉）。
       */
      React.useEffect(function () {
        var alive = true;
        apiGet(sessionChangesUrl("", "", true))
          .then(function (payload) {
            if (!alive) return;
            setChangesAvailable(normalizeChanges(payload).length > 0 ? true : false);
          })
          .catch(function () { if (alive) setChangesAvailable(false); });
        return function () { alive = false; };
      }, []);

      /**
       * 拉一次设置：**渲染要真的读它**（行高/列/缩略图/虚拟滚动阈值/默认视图…）。
       * 拉不到就用内置缺省 —— 面板照常能用，只是设置项暂时按缺省渲染。
       */
      React.useEffect(function () {
        var alive = true;
        apiGet("/settings")
          .then(function (payload) {
            if (!alive) return;
            // 统一叫 `prefs`：渲染侧一律用 `prefs.<键>` 取值（门禁按这个名字查「有没有消费点」）
            var prefs = payload && typeof payload === "object" ? payload : null;
            setSettings(prefs);
            // 默认视图：只在用户没手动切过视图时套用一次（`viewTouchedRef` 防覆盖用户选择）
            if (prefs && !viewTouchedRef.current && typeof prefs.defaultView === "string") {
              if (prefs.defaultView === "gallery") setFilters(function (previous) {
                return Object.assign({}, previous, { view: "gallery" });
              });
              else if (prefs.defaultView === "list") setFilters(function (previous) {
                return Object.assign({}, previous, { view: "list" });
              });
            }
          })
          .catch(function () { /* 设置拉不到不致命：按内置缺省渲染 */ });
        return function () { alive = false; };
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
          .then(function () { showToast("已打分 " + String(n) + " 星"); reload(); })
          .catch(function (error) { showToast("打分失败：" + error.message); });
      }

      /** 在文件管理器中定位。 */
      function openFolder(id) {
        apiSend("/" + encodeURIComponent(id) + "/open", "POST")
          .then(function () { showToast("已在文件管理器中打开"); })
          .catch(function (error) { showToast("打开失败：" + error.message); });
      }

      /** 复制路径。 */
      function copyPath(record) {
        try {
          navigator.clipboard.writeText(record.path).then(function () {
            showToast("路径已复制");
          }).catch(function () {
            showToast(record.path);
          });
        } catch (error) {
          showToast(record.path);
        }
      }

      /** 回收 / 恢复。 */
      function trashOne(id) {
        apiSend("/" + encodeURIComponent(id) + "/trash", "POST")
          .then(function () {
            showToast("已移入回收站");
            setDetail(null);
            reload();
            reloadMeta();
          })
          .catch(function (error) { showToast("回收失败：" + error.message); });
      }

      function restoreOne(id) {
        apiSend("/" + encodeURIComponent(id) + "/restore", "POST")
          .then(function () {
            showToast("已恢复");
            setDetail(null);
            reload();
            reloadMeta();
          })
          .catch(function (error) { showToast("恢复失败：" + error.message); });
      }

      /** 保存编辑（PATCH 局部字段）——由抽屉里的编辑态调用。 */
      function saveEdit(id, patch) {
        apiSend("/" + encodeURIComponent(id), "PATCH", patch)
          .then(function (updated) {
            showToast("已保存");
            setDetail(updated && updated.id ? updated : null);
            reload();
            reloadMeta();
          })
          .catch(function (error) { showToast("保存失败：" + error.message); });
      }

      /**
       * 项目容器（task-11 ①）：`null` = **停在项目列表**（第一级），`"__all__"` = 全部产物，
       * 其它字符串 = 进到某个项目里。
       *
       * 之前「项目」只是切换器里的一个 tab（**筛选维度**）—— 用户要的是
       * **容器**：先看到一个个项目，点进去才看到里面有什么。
       */
      var sProject = React.useState(null);
      var currentProject = sProject[0];
      var setCurrentProject = sProject[1];

      /**
       * 产物侧多选（task-13 A）：卡片/列表/搜索结果三处共用这一份选择。
       * 形状与目录侧一致（`{paths, anchor}`），**快捷键语义也复用同一套**
       * （Ctrl/Cmd 点击切换、Shift 区间、Ctrl+A 全选、Esc 清空）—— 不另发明一套。
       */
      var sPanelSel = React.useState({ ids: {}, anchor: -1 });
      var panelSel = sPanelSel[0];
      var setPanelSel = sPanelSel[1];

      /** 产物右键菜单（task-13 C3）：`{x, y, anchor, record}` 或 null。 */
      var sArtMenu = React.useState(null);
      var artMenu = sArtMenu[0];
      var setArtMenu = sArtMenu[1];

      /**
       * 就地改设置（视图控制用）：PUT 后用宿主返回值回显 —— 与设置面板同一条路径，
       * 不做乐观更新。这样「改列 / 改尺寸」既立即生效、又真的落盘（重启还在）。
       */
      function patchSettings(patch, note) {
        setSettings(function (previous) {
          var merged = {};
          if (previous && typeof previous === "object") {
            for (var k in previous) if (Object.prototype.hasOwnProperty.call(previous, k)) merged[k] = previous[k];
          }
          for (var p in patch) if (Object.prototype.hasOwnProperty.call(patch, p)) merged[p] = patch[p];
          return merged;
        });
        apiSend("/settings", "PUT", patch)
          .then(function (latest) {
            if (latest && typeof latest === "object") setSettings(latest);
            if (note) showToast(note);
          })
          .catch(function (error) {
            showToast("设置没保存成功：" + (error && error.message ? error.message : String(error)));
            apiGet("/settings").then(function (latest) {
              if (latest && typeof latest === "object") setSettings(latest);
            }).catch(function () { /* 忽略 */ });
          });
      }

      // ── 产物侧：定位 / 打开 / 右键菜单（task-13 C1/C3）──────────────────────
      /** 在文件夹中显示（复用 Host 已有的 `/files/reveal`，已过 assertInScope）。 */
      function revealRecord(record) {
        if (!record || !record.path) { showToast("这条产物没有文件路径（可能是导入条目）"); return; }
        apiSend("/files/reveal?path=" + encodeURIComponent(record.path), "POST")
          .then(function () { showToast("已在资源管理器中定位"); })
          .catch(function (error) { showToast("定位失败：" + (error && error.message ? error.message : String(error))); });
      }
      /** 用系统默认程序打开。 */
      function openRecord(record) {
        if (!record || !record.path) { showToast("这条产物没有文件路径"); return; }
        apiSend("/files/open?path=" + encodeURIComponent(record.path), "POST")
          .then(function () { showToast("已交给系统打开"); })
          .catch(function (error) { showToast("打开失败：" + (error && error.message ? error.message : String(error))); });
      }

      /**
       * 打开产物右键菜单（task-13 C3）。**这是新建的**（产物侧原先零 `onContextMenu`），
       * 结构与目录侧那套一致：`placeMenu` 定位（§11.1②）+ Escape 关闭 + `menuRef`。
       * `aria-label="产物操作"` —— 与目录侧的「文件操作」区分开（两条判据各自可钉）。
       */
      var artMenuRef = React.useRef(null);
      function openArtMenu(record, event) {
        var vw = (typeof window !== "undefined" && Number(window.innerWidth)) || 0;
        var vh = (typeof window !== "undefined" && Number(window.innerHeight)) || 0;
        var point = {
          left: Number(event && event.clientX) || 0,
          top: Number(event && event.clientY) || 0,
          right: Number(event && event.clientX) || 0,
          bottom: Number(event && event.clientY) || 0,
        };
        var placed = placeMenu(point, OVERLAY_ESTIMATE, { width: vw, height: vh });
        setArtMenu({ x: placed.x, y: placed.y, anchor: point, record: record });
      }
      React.useEffect(function () {
        if (!artMenu) return;
        function onEsc(event) { if (event.key === "Escape") setArtMenu(null); }
        document.addEventListener("keydown", onEsc);
        return function () { document.removeEventListener("keydown", onEsc); };
      }, [artMenu]);
      // 用实测尺寸再夹一次（与目录侧菜单同一条思路：首帧估计 + 渲染后校正）
      React.useEffect(function () {
        if (!artMenu) return;
        try {
          var node = artMenuRef.current;
          if (!node || typeof node.getBoundingClientRect !== "function") return;
          var rect = node.getBoundingClientRect();
          var vw = (typeof window !== "undefined" && Number(window.innerWidth)) || 0;
          var vh = (typeof window !== "undefined" && Number(window.innerHeight)) || 0;
          if (!vw || !vh || !rect.width || !rect.height) return;
          var placed = placeMenu(artMenu.anchor, { width: rect.width, height: rect.height }, { width: vw, height: vh });
          if (placed.x !== artMenu.x || placed.y !== artMenu.y) {
            setArtMenu({ x: placed.x, y: placed.y, anchor: artMenu.anchor, record: artMenu.record });
          }
        } catch (error) { /* 量不到就按原位显示 */ }
      });

      // ── 产物侧多选 + 引用（task-13 A/B）────────────────────────────────────
      /** 已选中的产物（按当前可见顺序）。 */
      function panelSelRows() {
        return (typeof projectFilteredItems !== "undefined" ? projectFilteredItems : visibleItems)
          .filter(function (record) { return panelSel.ids[record.id] === 1; });
      }
      function panelSelCount() {
        var n = 0;
        for (var k in panelSel.ids) if (Object.prototype.hasOwnProperty.call(panelSel.ids, k)) n += 1;
        return n;
      }
      function clearPanelSel() { setPanelSel({ ids: {}, anchor: -1 }); }
      function togglePanelSel(record) {
        var next = {};
        for (var k in panelSel.ids) if (Object.prototype.hasOwnProperty.call(panelSel.ids, k)) next[k] = 1;
        if (next[record.id]) delete next[record.id];
        else next[record.id] = 1;
        setPanelSel({ ids: next, anchor: projectFilteredItems.indexOf(record) });
      }
      function rangePanelSel(record) {
        var to = projectFilteredItems.indexOf(record);
        var from = panelSel.anchor >= 0 && panelSel.anchor < projectFilteredItems.length ? panelSel.anchor : to;
        var lo = Math.min(from, to);
        var hi = Math.max(from, to);
        var next = {};
        for (var k in panelSel.ids) if (Object.prototype.hasOwnProperty.call(panelSel.ids, k)) next[k] = 1;
        for (var i = lo; i <= hi; i += 1) if (projectFilteredItems[i]) next[projectFilteredItems[i].id] = 1;
        setPanelSel({ ids: next, anchor: from });
      }

      /**
       * 一键引用（task-13 B）：把选中项拼成**官方 mention 文本**写进剪贴板。
       *
       * ⚠️ 两个已知边界（如实处理，不假装）：
       *  1. `codec.clipboardText` 在**输入框的会话作用域**里，root 侧拿不到 → 用同一规格的
       *     本地 `atMention()`（与官方 `formatFileMention` 同形状，已有 6 条共享向量）。
       *  2. **粘贴后能不能被识别成引用 chip 由输入框决定** —— 我们只能保证文本符合规格。
       * 多条之间用**一个空格**分隔（输入框按 `@` 逐个解析；不能用换行，那会变成多条消息）。
       */
      function copyMentions(rows) {
        var mentions = [];
        var skipped = 0;
        rows.forEach(function (record) {
          if (!record.path) { skipped += 1; return; }
          var text = atMention(record.path, false);
          if (!text) { skipped += 1; return; }
          mentions.push(text);
        });
        if (!mentions.length) {
          showToast(skipped ? "这些产物没有可引用的文件路径（可能是导入条目）" : "没有可引用的内容");
          return;
        }
        var text = mentions.join(" ");
        var done = function () {
          showToast("已复制 " + String(mentions.length) + " 条引用" + (skipped ? "（" + String(skipped) + " 条没有路径，已跳过）" : "") + "：粘到聊天框即可");
        };
        // 剪贴板 API 在非安全上下文/无权限时会抛 —— 失败要把文本露出来让用户手抄
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(function () { showToast(text); });
          } else {
            showToast(text);
          }
        } catch (error) { showToast(text); }
      }

      var stats = data.stats || {};      var head = h("div", { className: NS + "__head" },
        h("div", { className: NS + "__title" },
          h("span", { className: NS + "__fi", style: { color: iconOf("x", true).color }, "aria-hidden": "true", dangerouslySetInnerHTML: { __html: iconOf("x", true).svg } }),
          "产物库"),
        h("div", { className: NS + "__stats" },
          h("div", { className: NS + "__stat" }, "共 ", h("b", null, String(stats.total || 0)), " 件"),
          h("div", { className: NS + "__stat" }, "待精化 ", h("b", null, String(stats.pendingRefine || 0))),
          h("div", { className: NS + "__stat" }, "归档 ", h("b", null, String(stats.archived || 0))),
          h("div", { className: NS + "__stat" }, "回收站 ", h("b", null, String(stats.trashed || 0)))
        ),
        h("span", { className: NS + "__grow" }),
        h("button", {
          type: "button", className: NS + "__btn", "aria-label": "刷新",
          onClick: function () { reloadMeta(); reload(); },
        }, "刷新"),
        h("button", {
          type: "button",
          className: NS + "__btn" + (filters.settings ? " " + NS + "__btn--primary" : ""),
          "aria-pressed": filters.settings ? "true" : "false",
          "aria-label": "设置",
          onClick: function () { patchFilters({ settings: !filters.settings }); },
        }, "设置"),
        h("button", {
          type: "button", className: NS + "__btn " + NS + "__btn--ghost",
          title: "登记 / 导入 / 精炼 / 语义搜索 / 整理建议 仍在完整管理页里（第二期搬进来）",
          onClick: openPage,
        }, "完整管理页")
      );

      // 视图切换器里**不再有「项目」** —— 项目是第一级容器（见 `currentProject`），不是筛选维度
      var VIEWS = [["card", "卡片"], ["list", "列表"], ["gallery", "画廊"], ["files", "文件"], ["dir", "目录"], ["changes", "改动"]];

      // 「改动」只在探到真有数据时才出现在切换器里（否则它就是个永远 404 的入口）
      var viewOptions = changesAvailable ? VIEWS : VIEWS.filter(function (pair) { return pair[0] !== "changes"; });
      // 如果用户正停在「改动」而它已经不可用，落回卡片视图（避免显示一个不存在的视图）
      var activeView = filters.view === "changes" && !changesAvailable ? "card" : filters.view;

      // ── 视图控制（task-11 架构 A：产物侧与目录侧共用同一套控件）──────────────
      var prefs = settings && typeof settings === "object" ? settings : {};
      var panelColumns = prefs.columns && typeof prefs.columns === "object" ? prefs.columns : { size: true, time: true, type: false };
      var panelCardSize = cardSizeKeyFromPx(prefs.galleryThumbSize);
      var viewControl = null;
      // 只在「产物类」视图里显示视图控制（文件/目录/改动各有自己的工具栏）
      if (activeView === "card" || activeView === "list" || activeView === "gallery") {
        viewControl = h(ViewControl, {
          key: "viewctl",
          label: "产物",
          view: activeView === "gallery" ? "gallery" : (activeView === "list" ? "list" : "card"),
          onView: function (kind) { patchFilters({ view: kind }); },
          density: typeof prefs.density === "string" ? prefs.density : "standard",
          onDensity: function (next) { patchSettings({ density: next }, "行高已改"); },
          cardSize: panelCardSize,
          onCardSize: function (next) { patchSettings({ galleryThumbSize: cardSizePx(next) }, "卡片尺寸已改"); },
          columns: panelColumns,
          onColumns: function (next) { patchSettings({ columns: next }, "列已改"); },
        });
      }

      /**
       * 「本会话」= 最近一轮会话登记/更新的产物。
       *
       * 用户原话：「最怕的就是一句『已经帮你改好了。』到底改了什么却看不出来」。
       * 官方那套按文件列 diff 的路线（`api/changes.summary` + `workspace/changes` 事件）
       * 需要本报文拿不到的 session/seq 上下文（详见交付报告），所以这里先做**产物层**
       * 能确证的那一半：会话 id 取自列表里 created_at 最大的那条记录（agent 刚登记的
       * 产物必然带 session_id），用它把「这一轮产出了什么」筛出来。
       */
      var latestSession = "";
      var latestAt = -1;
      var latestCount = 0;
      for (var li = 0; li < data.items.length; li += 1) {
        var rec = data.items[li];
        if (!rec || !rec.session_id) continue;
        var at = Number(rec.created_at) || 0;
        if (at >= latestAt) { latestAt = at; latestSession = String(rec.session_id); }
      }
      for (var lj = 0; lj < data.items.length; lj += 1) {
        if (String((data.items[lj] || {}).session_id || "") === latestSession && latestSession) latestCount += 1;
      }
      var visibleItems = (sessionOnly && latestSession)
        ? data.items.filter(function (item) { return String(item.session_id || "") === latestSession; })
        : data.items;
      var toolbar = h("div", { className: NS + "__toolbar" },
        h("input", {
          className: NS + "__input", type: "text", placeholder: "搜索标题 / 摘要 / 正文 / 文件名，支持 ext:md path:projects 这类语法…",
          "aria-label": "搜索产物",
          value: filters.q,
          onChange: function (event) { onSearch(event.target.value); },
        }),
        h("select", {
          className: NS + "__select", value: filters.kind, "aria-label": "按类型筛选",
          onChange: function (event) { patchFilters({ kind: event.target.value }); },
        },
          h("option", { value: "" }, "全部"),
          h("option", { value: "deliverable" }, "产出"),
          h("option", { value: "reference" }, "资料")
        ),
        h("select", {
          className: NS + "__select", value: filters.refine, "aria-label": "按精化状态筛选",
          onChange: function (event) { patchFilters({ refine: event.target.value }); },
        },
          h("option", { value: "" }, "全部状态"),
          h("option", { value: "1" }, "待精化"),
          h("option", { value: "0" }, "已精化")
        ),
        h("select", {
          className: NS + "__select", value: filters.project, "aria-label": "按项目筛选",
          onChange: function (event) { patchFilters({ project: event.target.value }); },
        },
          h("option", { value: "" }, "全部项目"),
          (data.cats.projects || []).map(function (name, i) {
            return h("option", { key: "p" + String(i), value: name }, String(name));
          })
        ),
        h("select", {
          className: NS + "__select", value: filters.sort, "aria-label": "排序",
          onChange: function (event) { patchFilters({ sort: event.target.value }); },
        },
          h("option", { value: "created_desc" }, "最新登记"),
          h("option", { value: "created_asc" }, "最早登记"),
          h("option", { value: "updated_desc" }, "最近更新"),
          h("option", { value: "stars_desc" }, "星级最高"),
          h("option", { value: "size_desc" }, "文件最大"),
          h("option", { value: "name_asc" }, "名称 A→Z")
        ),
        // 视图切换器：官方 SegmentedControl 形态（外 R12 / 4px 内缩 / 段 R8 / 160ms）
        h("div", { className: NS + "__seg", role: "tablist", "aria-label": "视图切换" },
          viewOptions.map(function (pair) {
            var on = activeView === pair[0];
            return h("button", {
              key: pair[0], type: "button", role: "tab",
              className: NS + "__segi",
              "aria-selected": on ? "true" : "false",
              "data-on": on ? "1" : "0",
              onClick: function () { patchFilters({ view: pair[0] }); },
            }, pair[1]);
          })
        ),
        viewControl,
        // ── 搜索模式开关（MIGRATION-PLAN 第 1 项：把「语义搜索」搬进面板）───────
        //   两种模式**打不同的端点**（关键词 → `?q=`；语义 → `/search?q=`），
        //   结果集与排序规则都不同 —— 所以这是一个「换通道」的开关，不是换个标签。
        h("div", { key: "mode", className: NS + "__seg", role: "tablist", "aria-label": "搜索模式" },
          [["keyword", "关键词"], ["semantic", "语义"]].map(function (pair) {
            var on = (filters.mode === "semantic" ? "semantic" : "keyword") === pair[0];
            return h("button", {
              key: pair[0], type: "button", role: "tab",
              className: NS + "__segi",
              "aria-selected": on ? "true" : "false",
              "data-on": on ? "1" : "0",
              title: pair[0] === "semantic" ? "按意思找（/search 端点）" : "按字面找（标题/路径/标签）",
              onClick: function () { patchFilters({ mode: pair[0] }); },
            }, pair[1]);
          })),
        filters.mode === "semantic"
          ? h("span", { className: NS + "__sethint", key: "modehint" }, "按意思找，不是按字面")
          : null,
        h("button", {
          type: "button", "aria-pressed": sessionOnly ? "true" : "false",
          className: NS + "__btn" + (sessionOnly ? " " + NS + "__btn--primary" : ""),
          disabled: !latestSession,
          title: latestSession
            ? "只看最近一轮会话登记的产物（会话 " + latestSession.slice(0, 12) + "）"
            : "列表里还没有带会话标记的产物",
          onClick: function () { setSessionOnly(!sessionOnly); },
        }, latestSession ? "本会话（" + String(latestCount) + "）" : "本会话"),
        h("button", {
          type: "button", "aria-pressed": filters.trash ? "true" : "false",
          className: NS + "__btn" + (filters.trash ? " " + NS + "__btn--primary" : ""),
          onClick: function () { patchFilters({ trash: !filters.trash }); },
        }, "回收站")
      );

      // ── ① 项目是第一级容器 ────────────────────────────────────────────────
      //   停在项目列表（`currentProject === null`）时：先看到一个个项目；
      //   进去后才看得到该项目里的产物；面包屑随时能回到列表。
      var projectEntries = (data.cats.projects || []).map(function (name) {
        var key = String(name);
        var own = data.items.filter(function (item) { return String(item.project || "") === key; });
        var newest = 0;
        own.forEach(function (item) {
          var at = Number(item.updated_at || item.created_at) || 0;
          if (at > newest) newest = at;
        });
        return { name: key, count: own.length, newest: newest };
      });
      var projectList = h("div", { className: NS + "__projects", role: "list", "aria-label": "项目" },
        h("div", {
          key: "__all__",
          className: NS + "__pcard " + NS + "__pcard--all",
          role: "listitem",
          tabIndex: 0,
          "aria-label": "全部产物",
          onClick: function () { setCurrentProject("__all__"); },
          onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCurrentProject("__all__"); } },
        },
          h("div", { className: NS + "__pcname" }, "全部产物"),
          h("div", { className: NS + "__pcmeta" }, String(data.items.length) + " 件 · 平铺看所有东西"),
          h("div", { className: NS + "__pchint" }, "不想按项目分的时候用这个")),
        projectEntries.map(function (item) {
          return h("div", {
            key: item.name,
            className: NS + "__pcard",
            role: "listitem",
            tabIndex: 0,
            "aria-label": item.name + "（" + String(item.count) + " 件）",
            onClick: function () { setCurrentProject(item.name); },
            onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCurrentProject(item.name); } },
          },
            h("div", { className: NS + "__pcname" }, item.name),
            h("div", { className: NS + "__pcmeta" }, String(item.count) + " 件" + (item.newest ? " · 最近 " + fmtDate(item.newest) : "")),
            h("div", { className: NS + "__pchint" }, "点进去看这个项目里有什么"));
        }),
        projectEntries.length ? null : h("div", { className: NS + "__pchint", style: { padding: "10px 2px" } },
          "还没有带项目标记的产物 —— 用「全部产物」平铺看，或给产物设置项目后它们会出现在这里。"));

      var insideProject = currentProject !== null;      // 进去之后把列表按项目过滤（"__all__" 不过滤）—— 层级感来自「面包屑 + 过滤」两件事
      var projectFilteredItems = (!insideProject || currentProject === "__all__")
        ? visibleItems
        : visibleItems.filter(function (item) { return String(item.project || "") === currentProject; });

      var projectCrumb = insideProject ? h("div", { className: NS + "__bar", key: "pcrumbs" },        h("button", {
          type: "button", className: NS + "__btn", "aria-label": "返回项目列表",
          onClick: function () { setCurrentProject(null); },
        }, "← 项目列表"),
        h("nav", { className: NS + "__crumbs", "aria-label": "位置" },
          h("span", { className: NS + "__crumb" }, currentProject === "__all__" ? "全部产物" : "项目"),
          h("span", { className: NS + "__crumb", "aria-current": "page" }, currentProject === "__all__" ? "全部" : currentProject)),
        h("span", { className: NS + "__meta" }, String(projectFilteredItems.length) + " 件")) : null;

      var bodyKids = [];
      var semanticMode = filters.mode === "semantic";
      // ★ 语义模式**整块换掉产物列表**（它走的是另一条通道，不与关键词结果混在一起）
      if (semanticMode && activeView !== "files" && activeView !== "dir" && activeView !== "changes" && !filters.settings) {
        bodyKids.push(h(SemanticView, {
          key: "semantic",
          query: filters.q,
          kind: filters.kind,
          project: filters.project,
          onToast: showToast,
          onOpenRecord: function (record) { setDetail(record); },
          renderRecords: function (records) {
            return renderCards(h, records, setDetail, {
              cardPx: cardSizePx(panelCardSize),
              act: {
                onRef: copyMentions, onReveal: revealRecord, onOpen: openRecord,
                onContext: openArtMenu,
                isSelected: function (record) { return panelSel.ids[record.id] === 1; },
              },
            });
          },
        }));
      } else      // 文件视图与产物数据无关，必须排在 error / 空库 / loading 之前，
      // 否则库为空或加载中时它会永远显示不出来。
      if (activeView === "files") {
        bodyKids.push(h(FilesView, { key: "files", onToast: showToast, onGoDir: function () { patchFilters({ view: "dir" }); } }));
      } else if (activeView === "dir") {
        bodyKids.push(h(DirBrowser, {
          key: "dir",
          onToast: showToast,
          settings: settings,
          onGoFiles: function () { patchFilters({ view: "files" }); },
          onSettings: patchSettings,
        }));
      } else if (activeView === "gallery") {
        // 画廊：直接对**当前目录**的内容做缩略图墙（所以复用 DirBrowser 的取数逻辑）
        bodyKids.push(h(GalleryBrowser, { key: "gallery", onToast: showToast, settings: settings }));
      } else if (activeView === "changes") {
        // 「本轮改动」也不依赖产物数据，同样排在 error / 空库 / loading 之前
        bodyKids.push(h(ChangesView, {
          key: "changes",
          onToast: showToast,
          onFallback: function () {
            setSessionOnly(true);
            patchFilters({ view: "card" });
          },
        }));
      } else if (data.error) {
        bodyKids.push(StateBlock(h, STATE_ICON_ALERT, "加载失败：" + data.error,
          ["确认产物库插件已安装、宿主已重启"], [
            h("button", {
              key: "retry", type: "button", className: NS + "__btn",
              onClick: function () { reloadMeta(); reload(); },
            }, "重试"),
          ], "err"));
      } else if (data.loading && !data.items.length) {
        // 加载 = 3~5 行骨架屏，不用 spinner
        bodyKids.push(h("div", { key: "loading" }, SkeletonRows(h, 4)));
      } else if (currentProject === null) {
        // ★ 第一级：项目列表（含「全部产物」入口）。**这是「容器」，不是筛选维度。**
        bodyKids.push(h("div", { key: "projects" }, projectList));
      } else if (!projectFilteredItems.length) {
        var hasFilter = !!(filters.q || filters.kind || filters.refine || filters.project);
        // ── 空状态承载引导（lead 定的方向）──────────────────────────────────
        //   ① **不做教程弹窗**（用户会关掉），引导就长在空状态里；
        //   ② 对**新用户**（库真的是空的）回答的不是「怎么用」，而是「**你的东西去哪了**」；
        //   ③ 其余空状态统一走「下一步能做什么」，而不是「什么都没有」。
        //   ④ 所有动作都必须是**真能点的真路径**，不写做不到的话。
        var isFirstRun = !hasFilter && !filters.trash && !sessionOnly;
        bodyKids.push(isFirstRun
          ? StateBlock(h, STATE_ICON_FOLDER,
            "这里会自动收着你让 AI 做出来的东西",
            ["你让 Agent 生成/修改的文件，会在它登记后出现在这里 —— 不用你自己翻目录找。",
              "现在库还是空的。有两个立刻能用的入口：去「文件」里挑一个已有文件登记，或者从完整管理页导入一整个文件夹。"],
            [
              // 真路径①：文件视图里每行都有「登记进产物库」（files/list + /register，都已存在）
              h("button", {
                key: "go-files", type: "button", className: NS + "__btn " + NS + "__btn--primary",
                onClick: function () { patchFilters({ view: "files" }); },
              }, "去「文件」里挑一个登记"),
              // 真路径②：完整管理页的导入（第二期才搬进来，这里如实指向它）
              h("button", {
                key: "go-page", type: "button", className: NS + "__btn",
                onClick: openPage,
              }, "从完整管理页导入文件夹"),
            ],
            "firstrun")
          : StateBlock(h,
            filters.trash ? STATE_ICON_FOLDER : STATE_ICON_SEARCH,
            sessionOnly ? "这一轮还没有新登记的产物"
              : (filters.trash ? "回收站是空的"
                : (filters.q ? "没有匹配「" + filters.q + "」的产物" : "没有符合当前筛选的产物")),
            sessionOnly
              ? ["「本会话」只看最近一轮会话登记的产物；这一轮可能还没登记东西。"]
              : (hasFilter
                ? ["下一步：清空筛选看全部，或换一个关键词。"]
                : ["下一步：让 Agent 登记产物，或从完整管理页导入。"]),
            sessionOnly ? [
              h("button", {
                key: "allsess", type: "button", className: NS + "__btn " + NS + "__btn--primary",
                onClick: function () { setSessionOnly(false); },
              }, "看全部产物"),
            ] : (hasFilter ? [
              h("button", {
                key: "clear", type: "button", className: NS + "__btn " + NS + "__btn--primary",
                onClick: function () { patchFilters({ q: "", kind: "", refine: "", project: "" }); },
              }, "清空筛选看全部"),
            ] : [
              h("button", {
                key: "go-files2", type: "button", className: NS + "__btn",
                onClick: function () { patchFilters({ view: "files" }); },
              }, "去「文件」里挑一个登记"),
            ]),
            "empty"));
      } else if (activeView === "list") {
        bodyKids.push(renderTable(h, projectFilteredItems, filters, {
          openFolder: openFolder, setDetail: setDetail, trashOne: trashOne, restoreOne: restoreOne,
          columns: panelColumns, density: typeof prefs.density === "string" ? prefs.density : "standard",
          onRef: copyMentions, onReveal: revealRecord, onOpen: openRecord,
          onContext: openArtMenu, onToggleSel: togglePanelSel, onRangeSel: rangePanelSel,
          isSelected: function (record) { return panelSel.ids[record.id] === 1; },
        }));
      } else {
        bodyKids.push(renderCards(h, projectFilteredItems, setDetail, {
          cardPx: cardSizePx(panelCardSize),
          density: typeof prefs.density === "string" ? prefs.density : "standard",
          act: {
            onRef: copyMentions, onReveal: revealRecord, onOpen: openRecord,
            onContext: openArtMenu, onToggleSel: togglePanelSel, onRangeSel: rangePanelSel,
            isSelected: function (record) { return panelSel.ids[record.id] === 1; },
          },
        }));
      }

      // ── 产物侧：批量条（「已选 N 项」+ 一键引用）+ 右键菜单 ─────────────────
      var pCount = panelSelCount();
      var pSelRows = pCount ? panelSelRows() : [];
      var panelSelBar = pCount ? h("div", { className: NS + "__selbar", role: "toolbar", "aria-label": "批量操作（产物）" },
        h("span", { className: NS + "__selcount" }, "已选 " + String(pCount) + " 项"),
        h("button", {
          type: "button", className: NS + "__btn " + NS + "__btn--primary", "aria-label": "一键引用（复制到剪贴板）",
          onClick: function () { copyMentions(pSelRows); },
        }, "一键引用（复制）"),
        h("button", {
          type: "button", className: NS + "__btn", "aria-label": "复制路径",
          onClick: function () {
            var text = pSelRows.map(function (r) { return String(r.path || ""); }).filter(Boolean).join("\r\n");
            try {
              if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () { showToast("已复制 " + String(pSelRows.length) + " 条路径"); }).catch(function () { showToast(text); });
              } else { showToast(text); }
            } catch (error) { showToast(text); }
          },
        }, "复制路径"),
        h("button", {
          type: "button", className: NS + "__btn", "aria-label": "清空选择", title: "清空选择（Esc）",
          onClick: clearPanelSel,
        }, "清空选择"),
        h("span", { className: NS + "__sethint" }, "粘贴到聊天输入框即可引用（多条之间用空格分隔）")) : null;

      var artMenuNode = artMenu ? h("div", {
        className: NS + "__menu",
        role: "menu",
        "aria-label": "产物操作",
        ref: artMenuRef,
        style: { left: String(artMenu.x) + "px", top: String(artMenu.y) + "px" },
        onClick: function (event) { event.stopPropagation(); },
      },
        artMenu.record.path ? h("button", {
          type: "button", role: "menuitem", className: NS + "__mi",
          onClick: function () { var r = artMenu.record; setArtMenu(null); copyMentions([r]); },
        }, "复制为 @引用") : null,
        h("button", {
          type: "button", role: "menuitem", className: NS + "__mi",
          onClick: function () { var r = artMenu.record; setArtMenu(null); revealRecord(r); },
        }, "在文件夹中显示"),
        h("button", {
          type: "button", role: "menuitem", className: NS + "__mi",
          onClick: function () { var r = artMenu.record; setArtMenu(null); openRecord(r); },
        }, "用默认程序打开"),
        h("button", {
          type: "button", role: "menuitem", className: NS + "__mi",
          onClick: function () {
            var r = artMenu.record;
            setArtMenu(null);
            try {
              if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(String(r.path || "")); showToast("路径已复制");
              } else { showToast(String(r.path || "")); }
            } catch (error) { showToast(String(r.path || "")); }
          },
        }, "复制路径"),
        h("button", {
          type: "button", role: "menuitem", className: NS + "__mi",
          onClick: function () { var r = artMenu.record; setArtMenu(null); setDetail(r); },
        }, "查看详情")
      ) : null;

      var body = h("div", { className: NS + "__body" }, bodyKids);

      // 设置是**面板内页面**：打开时整块替换工具栏+内容（设置项的效果就在这个面板里，
      // 放到宿主全局设置页会让用户「改完看不见变化」）。
      if (filters.settings) {
        return h("div", { className: NS },
          head,
          h("div", { className: NS + "__body" },
            h(SettingsPanel, {
              key: "settings",
              onToast: showToast,
              onClose: function () { patchFilters({ settings: false }); },
            })),
          toast ? h("div", { className: NS + "__toast" }, toast) : null);
      }

      return h("div", { className: NS },
        head,
        insideProject && !filters.settings ? projectCrumb : null,
        toolbar,
        panelSelBar,
        body,
        artMenuNode,
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
     * 数据来自 `/ext/artifacts/files/list?dir=`：host 侧**实时 `fs.readdir`**（不再依赖
     * Everything 快照），所以**索引没启动也能浏览**，且新建的文件立刻可见。
     * 返回 `entries` 每项带 `path/name/isDirectory/isSymbolicLink/size/mtimeMs`，
     * 顶层带 `total/truncated/limit`；目录被 `assertInScope` 挡下时回 403（文案在 `error` 里）。
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

      /**
       * 排序（§3.6）：默认名称升序 + 目录优先。
       * **`null` = 还没在本视图里手动改过** → 用设置里的 `sortBy`/`sortDir`（改设置立即生效）。
       */
      var sSort = React.useState(null);
      var sortOverride = sSort[0];
      var setSort = sSort[1];

      /** 行高密度（§3.1）：同样是「手动覆盖」，未覆盖时取设置里的 `density`。 */
      var sDensity = React.useState(null);
      var densityOverride = sDensity[0];
      var setDensity = sDensity[1];

      /**
       * 多选（task-9 §4.2）：`{ paths: {path:1}, anchor: number }`。
       * 用对象当集合（同一目录里 path 唯一），避免 Set 在浅比较里每次都算「变了」。
       */
      var sSel = React.useState({ paths: {}, anchor: -1 });
      var sel = sSel[0];
      var setSel = sSel[1];

      /** 面包屑编辑态：`null` = 不是编辑态；字符串 = 输入框里的当前值。 */
      var sCrumbEdit = React.useState(null);
      var crumbEdit = sCrumbEdit[0];
      var setCrumbEdit = sCrumbEdit[1];

      /**
       * 目录里的呈现方式（task-11 ②）：`null` = 跟着设置走，否则是用户在目录里就地选的。
       * 目录与产物**共用同一套三档语义**（卡片/列表/画廊），控件也是同一个 `ViewControl`。
       */
      var sDirView = React.useState(null);
      var dirViewOverride = sDirView[0];
      var setDirView = sDirView[1];

      /** 批量操作的「可退回」凭据：{ ids, note }（登记成功后出现「撤销」）。 */
      var sBatchUndo = React.useState(null);
      var batchUndo = sBatchUndo[0];
      var setBatchUndo = sBatchUndo[1];

      /** 拖拽经过面板（`dragenter/over` 计数 > 0 时显示投放提示）。 */
      var sDragOver = React.useState(0);
      var dragOver = sDragOver[0];
      var setDragOver = sDragOver[1];

      /** 最近访问过的目录（模块级记录，只读用来渲染下拉；不额外进状态）。 */
      var recent = RECENT_DIRS.slice(0, RECENT_DIRS_MAX);

      // ── 从设置取值（设置面板改完立即生效，不再有「读了不生效」的键）──────
      var prefs = props.settings && typeof props.settings === "object" ? props.settings : {};
      var density = densityOverride || (typeof prefs.density === "string" ? prefs.density : "standard");
      var sort = sortOverride || {
        by: typeof prefs.sortBy === "string" ? prefs.sortBy : "name",
        dir: typeof prefs.sortDir === "string" ? prefs.sortDir : "asc",
      };
      /** 虚拟滚动阈值：0 = 总是启用；缺省回落到内置常量。 */
      var virtualThreshold = isFinite(Number(prefs.virtualThreshold)) ? Number(prefs.virtualThreshold) : VIRTUAL_THRESHOLD;
      var showThumbnails = prefs.thumbnails !== false;
      var thumbSize = isFinite(Number(prefs.thumbSize)) ? Number(prefs.thumbSize) : THUMB_LIST_SIZE;
      var columns = prefs.columns && typeof prefs.columns === "object" ? prefs.columns : { size: true, time: true, type: false };
      /** 目录里的呈现方式：就地选的优先，其次跟着设置的默认视图，最后回落列表（目录的传统形态）。 */
      var dirView = dirViewOverride
        || (prefs.defaultView === "gallery" ? "gallery" : (prefs.defaultView === "card" ? "card" : "list"));
      /** 卡片/缩略图尺寸（档位 ↔ galleryThumbSize 像素，不新造设置键）。 */
      var cardPx = isFinite(Number(prefs.galleryThumbSize)) ? Number(prefs.galleryThumbSize) : 96;

      /** 目录项「N 项」：异步填充（算完才出现，先显示 —）。 */
      var sCounts = React.useState({});
      var counts = sCounts[0];
      var setCounts = sCounts[1];

      /** 右键菜单：{x, y, row} 或 null。 */
      var sMenu = React.useState(null);
      var menu = sMenu[0];
      var setMenu = sMenu[1];

      /** roving tabindex：当前可 Tab 到的那一行。 */
      var sFocus = React.useState(0);
      var focusIdx = sFocus[0];
      var setFocusIdx = sFocus[1];

      /** 重试令牌：变化即重新载入当前目录。 */
      var sReload = React.useState(0);
      var reloadToken = sReload[0];
      var setReloadToken = sReload[1];

      /** 计数任务的代号：切换目录即作废上一轮，避免结果串台。 */
      var countRunRef = React.useRef(0);

      /** 虚拟滚动（>200 行才启用）：滚动位置 + 视口高度。 */
      var sScroll = React.useState({ top: 0, height: VIRTUAL_VIEWPORT_FALLBACK });
      var scrollState = sScroll[0];
      var setScroll = sScroll[1];
      /** 虚拟滚动容器（读 scrollTop / clientHeight 用）。 */
      var scrollRef = React.useRef(null);
      /** 键盘移动后，目标行渲染出来再聚焦（虚拟化时目标行可能还没进 DOM）。 */
      var pendingFocusRef = React.useRef(null);

      /** 缩略图加载失败的路径 → 回退阶段（"primary" = 自建失败试官方；"1" = 全失败用图标）。 */
      var sThumbFailed = React.useState({});
      var thumbFailed = sThumbFailed[0];
      var setThumbFailed = sThumbFailed[1];

      /** Ctrl+P 快速跳转浮层：{q, cursor} 或 null。 */
      var sFinder = React.useState(null);
      var finder = sFinder[0];
      var setFinder = sFinder[1];
      /**
       * 当前目录列表的元信息（`{total, truncated}`）。
       * host 侧实时 readdir 会截断（默认 2000 / 硬上限 10000），
       * 截断了必须在 UI 上说清楚，否则用户会以为文件丢了。
       */
      var sListMeta = React.useState(null);
      var listMeta = sListMeta[0];
      var setListMeta = sListMeta[1];
      /** 本视图根节点：用来判断「面板当前可见」再响应 Ctrl+P。 */
      var rootRef = React.useRef(null);
      /** 打开浮层前的焦点元素：关闭时归还（§11.2 对话框焦点管理）。 */
      var finderReturnRef = React.useRef(null);

      /** 打开快速跳转：记住触发元素（关闭归还焦点），并记下当时的面板矩形（浮层定位）。 */
      function openFinder(trigger) {
        finderReturnRef.current = trigger || null;
        var box = null;
        try {
          var root = rootRef.current;
          if (root && typeof root.getBoundingClientRect === "function") {
            var rect = root.getBoundingClientRect();
            if (rect && rect.width) box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          }
        } catch (error) { /* 量不到就用兜底位置 */ }
        setFinder({ q: "", cursor: 0, box: box });
      }

      /** 关闭快速跳转：把焦点归还给打开它的元素。 */
      function closeFinder() {
        setFinder(null);
        try {
          var node = finderReturnRef.current;
          if (node && typeof node.focus === "function") node.focus();
        } catch (error) { /* 归还失败不影响功能 */ }
      }

      /** 缩略图失败一档：自建失败 → 试官方；官方也失败 → 记住用图标（不留空窗、不反复重试）。 */
      function markThumbFailed(p) {
        setThumbFailed(function (previous) {
          var next = {};
          for (var key in previous) if (Object.prototype.hasOwnProperty.call(previous, key)) next[key] = previous[key];
          next[p] = previous[p] ? "1" : "primary";
          return next;
        });
      }

      function onListScroll(event) {
        try {
          var node = event.currentTarget;
          setScroll({ top: Number(node.scrollTop) || 0, height: Number(node.clientHeight) || VIRTUAL_VIEWPORT_FALLBACK });
        } catch (error) { /* 忽略 */ }
      }

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
        countRunRef.current += 1;
        rememberDir(path);                    // Ctrl+P 的「最近目录」
        setPhase("loading");
        setCounts({});
        setFocusIdx(0);
        apiGet("/files/list?dir=" + encodeURIComponent(path))
          .then(function (res) {
            var list = res && Array.isArray(res.entries) ? res.entries : [];
            setEntries(list);
            setListMeta({
              total: isFinite(Number(res && res.total)) ? Number(res.total) : list.length,
              truncated: !!(res && res.truncated),
              limit: isFinite(Number(res && res.limit)) ? Number(res.limit) : 0,
              // 宿主在**真的过滤掉东西时**才给这个字段（showHidden=true 时不出现）
              hiddenFiltered: isFinite(Number(res && res.hiddenFiltered)) ? Number(res.hiddenFiltered) : 0,
            });
            setPhase("ready");
            fillCounts(list, countRunRef.current);
          })
          .catch(function (err) {
            setPhase("error");
            setError(err && err.message ? err.message : String(err));
          });
      }, [path, reloadToken]);

      /**
       * 目录项的「N 项」：**异步填充**，先显示 `—`。
       *
       * 只统计本地盘符路径（照抄 Nautilus 的 `show-directory-item-counts = local-only`，
       * 网络盘 / UNC 一律跳过）；最多算 40 个目录、3 个并发，算不出来就不打扰用户。
       * 总大小**不算**（Finder 上这是 2~8 秒的昂贵操作）。
       */
      function fillCounts(list, token) {
        var queue = [];
        for (var i = 0; i < list.length && queue.length < 40; i += 1) {
          var candidate = list[i];
          // 符号链接不统计（host 侧对 junction 标 isDirectory，但链接目标不解析）
          if (candidate && candidate.isDirectory && !candidate.isSymbolicLink && isLocalPath(candidate.path)) queue.push(candidate);
        }
        var active = 0;
        function pump() {
          if (token !== countRunRef.current) return;
          while (active < 3 && queue.length) {
            /* eslint-disable no-loop-func */
            (function (target) {
              active += 1;
              // limit=1 就够了：新的 /files/list 会返回整个目录的 `total`（真实条目数）
              apiGet("/files/list?dir=" + encodeURIComponent(target.path) + "&limit=1")
                .then(function (res) {
                  var entriesLen = res && Array.isArray(res.entries) ? res.entries.length : 0;
                  var total = Number(res && res.total);
                  var label;
                  if (isFinite(total) && total >= 0) label = String(total);
                  else if (res && res.truncated) label = entriesLen + "+";
                  else label = String(entriesLen);
                  setCounts(function (previous) {
                    var next = {};
                    for (var key in previous) if (Object.prototype.hasOwnProperty.call(previous, key)) next[key] = previous[key];
                    next[target.path] = label;
                    return next;
                  });
                })
                .catch(function () { /* 算不出来就不显示 */ })
                .then(function () { active -= 1; pump(); });
            })(queue.shift());
            /* eslint-enable no-loop-func */
          }
        }
        pump();
      }

      /** 上级目录（Windows 路径） */
      function parentOf(p) {
        var s = String(p).replace(/[\\/]+$/, "");
        var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
        if (i < 0) return "";
        var up = s.slice(0, i);
        if (/^[A-Za-z]:$/.test(up)) return up + "\\";
        return up;
      }

      /** 面包屑切片：路径只在顶部显示**一次**，行内不再重复。 */
      function crumbItems(p) {
        var raw = String(p || "").replace(/[\\/]+$/, "");
        var parts = raw.split(/[\\/]+/).filter(function (s) { return s !== ""; });
        var items = [];
        var acc = "";
        for (var i = 0; i < parts.length; i += 1) {
          var seg = parts[i];
          if (i === 0) acc = /^[A-Za-z]:$/.test(seg) ? seg + "\\" : seg;
          else acc = acc.charAt(acc.length - 1) === "\\" ? acc + seg : acc + "\\" + seg;
          items.push({ label: seg, path: acc });
        }
        return items;
      }

      /** 排序：目录永远优先，组内按选定列（自然序，file2 在 file10 前）。 */
      function sortedEntries() {
        var arr = entries.slice();
        arr.sort(function (a, b) {
          if (!!a.isDirectory !== !!b.isDirectory) return a.isDirectory ? -1 : 1;
          var r;
          if (sort.by === "size") r = (Number(a.size) || 0) - (Number(b.size) || 0);
          else if (sort.by === "time") r = (Number(a.modified) || 0) - (Number(b.modified) || 0);
          else r = byName.compare(String(a.name || ""), String(b.name || ""));
          if (r === 0) r = byName.compare(String(a.name || ""), String(b.name || ""));
          return sort.dir === "desc" ? -r : r;
        });
        return arr;
      }

      /** 点表头：同列切升降序，换列回到升序（**以当前生效的排序为基准**，不是以覆盖值为基准）。 */
      function toggleSort(by) {
        var current = sort;
        setSort(current.by === by
          ? { by: by, dir: current.dir === "asc" ? "desc" : "asc" }
          : { by: by, dir: "asc" });
      }

      /**
       * 拖入登记（task-9 §4.3）。
       *
       * ⚠️ **诚实边界**：浏览器只给 `File` 对象，**拿不到真实路径**（安全模型）。
       * 拿得到路径的只有 Electron 的 `webUtils.getPathForFile(file)`，或老版本挂在 `file.path` 上。
       * 所以这里按顺序试：`webUtils` → `file.path` → 都没有就**明说做不到**，
       * 并告诉用户替代路径（用「文件」视图搜索后逐条登记）。**不假装登记成功。**
       *
       * 与虚拟滚动不冲突：本文件**从来没有实现过「拖拽选中」**（多选只用 Ctrl/Shift/空格），
       * 所以拖拽只有一个含义：**投放 = 登记**。
       */
      function pathsFromDrop(dataTransfer) {
        var out = [];
        var unknown = 0;
        var files = dataTransfer && dataTransfer.files ? dataTransfer.files : [];
        var webUtils = null;
        try {
          // 只有 Electron 环境有；require 拿不到就跳过
          webUtils = require("electron").webUtils;
        } catch (error) { webUtils = null; }
        for (var i = 0; i < files.length; i += 1) {
          var file = files[i];
          var path = "";
          if (webUtils && typeof webUtils.getPathForFile === "function") {
            try { path = String(webUtils.getPathForFile(file) || ""); } catch (error) { path = ""; }
          }
          if (!path && file && typeof file.path === "string") path = file.path;
          if (path) out.push(path);
          else unknown += 1;
        }
        return { paths: out, unknown: unknown };
      }

      /** 投放：先把路径登记成产物（逐个 POST /），结果如实报。 */
      function handleDrop(event) {
        event.preventDefault();
        setDragOver(0);
        var got = pathsFromDrop(event.dataTransfer);
        if (!got.paths.length) {
          notify(got.unknown
            ? "这个环境拿不到拖入文件的真实路径（浏览器安全限制），请用「文件」视图搜索后点「登记」"
            : "没有读到拖入的文件");
          return;
        }
        var rows = got.paths.map(function (p) {
          var parts = splitPathParts(p);
          var dot = parts.name.lastIndexOf(".");
          return { path: p, name: parts.name, ext: dot > 0 ? parts.name.slice(dot + 1).toLowerCase() : "" };
        });
        batchRegister(rows);
        notify("已收到 " + String(got.paths.length) + " 个文件，开始登记…" + (got.unknown ? "（另有 " + String(got.unknown) + " 个拿不到路径）" : ""));
      }

      /** 进入某个目录（列表里的路径都带尾部分隔符）。 */
      function openRow(row) {
        setPath(String(row.path).replace(/[\\/]+$/, ""));
      }

      // ── 多选（task-9 §4.2）────────────────────────────────────────────────
      /** 当前选中的行（按 sorted 顺序，供批量操作与计数用）。 */
      function selectedRows() {
        return sortedEntries().filter(function (row) { return sel.paths[row.path] === 1; });
      }
      function selCount() {
        var n = 0;
        for (var k in sel.paths) if (Object.prototype.hasOwnProperty.call(sel.paths, k)) n += 1;
        return n;
      }
      function clearSel() {
        setSel({ paths: {}, anchor: -1 });
      }
      /** Ctrl/Cmd 点击：切换单行。 */
      function toggleSel(row) {
        var next = {};
        for (var k in sel.paths) if (Object.prototype.hasOwnProperty.call(sel.paths, k)) next[k] = 1;
        if (next[row.path]) delete next[row.path];
        else next[row.path] = 1;
        var index = sortedEntries().indexOf(row);
        setSel({ paths: next, anchor: index });
      }
      /** Shift 点击：以锚点为起点做区间选（区间内全选，不反向取消）。 */
      function rangeSel(row) {
        var list = sortedEntries();
        var to = list.indexOf(row);
        var from = sel.anchor >= 0 && sel.anchor < list.length ? sel.anchor : to;
        var lo = Math.min(from, to);
        var hi = Math.max(from, to);
        var next = {};
        for (var k in sel.paths) if (Object.prototype.hasOwnProperty.call(sel.paths, k)) next[k] = 1;
        for (var i = lo; i <= hi; i += 1) if (list[i]) next[list[i].path] = 1;
        setSel({ paths: next, anchor: from });
      }
      function selectAll() {
        var list = sortedEntries();
        var next = {};
        for (var i = 0; i < list.length; i += 1) next[list[i].path] = 1;
        setSel({ paths: next, anchor: 0 });
      }

      /**
       * 批量登记：逐项 POST `/`（既有的登记端点）。
       * **可退回**：把宿主返回的记录 id 收起来 → 提供「撤销：移入回收站」。
       */
      function batchRegister(rows) {
        if (!rows.length) return;
        var targets = rows.filter(function (r) { return !r.isDirectory; });
        if (!targets.length) { notify("选中的都是文件夹，没有可登记的文件"); return; }
        notify("登记 " + String(targets.length) + " 项…");
        var done = [];
        var failed = 0;
        var dup = 0;
        var chain = Promise.resolve();
        targets.forEach(function (row) {
          chain = chain.then(function () {
            return apiSend("", "POST", {
              path: row.path, title: row.name, kind: "deliverable", source: "manual",
              tags: row.ext ? [row.ext] : [],
            }).then(function (record) {
              // host-dev：同一路径已有有效记录时**不再新建**，返回已有那条 + duplicate:true
              // → 这种情况不该进「撤销」名单（撤销它 = 把用户早就有的东西移进回收站）
              if (record && record.duplicate) { dup += 1; return; }
              if (record && record.id) done.push(record.id);
            }).catch(function () { failed += 1; });
          });
        });
        chain.then(function () {
          if (!done.length) {
            notify(dup ? "这些文件都已经在产物库里了（" + String(dup) + " 项）" : "登记失败：" + String(failed) + " 项都没成功");
            return;
          }
          var ids = done.slice();
          var note = "已登记 " + String(ids.length) + " 项"
            + (dup ? "，另有 " + String(dup) + " 项本来就在库里" : "")
            + (failed ? "（失败 " + String(failed) + " 项）" : "");
          setBatchUndo({ ids: ids, note: note });
          notify("已登记 " + String(ids.length) + " 项" + (failed ? "，失败 " + String(failed) + " 项" : ""));
          clearSel();
          setReloadToken(reloadToken + 1);
        });
      }

      /** 撤销批量登记：把刚登记的那批移入回收站（宿主已有的 /:id/trash）。 */
      function undoBatch() {
        if (!batchUndo || !batchUndo.ids.length) return;
        var ids = batchUndo.ids.slice();
        notify("正在撤销 " + String(ids.length) + " 项…");
        var chain = Promise.resolve();
        ids.forEach(function (id) {
          chain = chain.then(function () {
            return apiSend("/" + encodeURIComponent(id) + "/trash", "POST").catch(function () { /* 单项失败不打断 */ });
          });
        });
        chain.then(function () {
          setBatchUndo(null);
          notify("已撤销：这 " + String(ids.length) + " 项已移入回收站");
          setReloadToken(reloadToken + 1);
        });
      }

      /** 批量复制路径（每行一个，一次写进剪贴板）。 */
      function batchCopy(rows) {
        var text = rows.map(function (r) { return r.path; }).join("\r\n");
        try {
          navigator.clipboard.writeText(text)
            .then(function () { notify("已复制 " + String(rows.length) + " 条路径"); })
            .catch(function () { notify(text); });
        } catch (error) { notify(text); }
      }

      /** 批量打开（逐个交给系统默认程序；宿主逐个处理，失败计数如实报）。 */
      function batchOpen(rows) {
        var targets = rows.filter(function (r) { return !r.isDirectory; });
        if (!targets.length) { notify("选中的都是文件夹"); return; }
        notify("打开 " + String(targets.length) + " 项…");
        var failed = 0;
        var chain = Promise.resolve();
        targets.forEach(function (row) {
          chain = chain.then(function () {
            return apiSend("/files/open?path=" + encodeURIComponent(row.path), "POST").catch(function () { failed += 1; });
          });
        });
        chain.then(function () {
          notify(failed ? "打开了 " + String(targets.length - failed) + " 项，失败 " + String(failed) + " 项" : "已交给系统打开 " + String(targets.length) + " 项");
        });
      }

      /** 登记某个文件为产物 */
      function registerRow(row) {
        notify("登记中…");
        apiSend("", "POST", {
          path: row.path,
          title: row.name,
          kind: "deliverable",
          source: "manual",
          tags: row.ext ? [row.ext] : [],
        })
          .then(function (record) {
      // host-dev：同一路径已有有效记录 → 返回已有那条 + duplicate:true（**没有新建**）。
      // 这时说「已登记」会让人以为新加了一条，所以分开说。
      if (record && record.duplicate) notify("这个文件已经在产物库里了：" + row.name);
      else notify("已登记：" + row.name);
    })
          .catch(function (err) { notify("登记失败：" + (err && err.message ? err.message : String(err))); });
      }

      /**
       * 文件操作：用默认程序打开 / 在资源管理器中定位。
       * 宿主侧有 assertInScope 安全闸门 —— 只放行索引范围内的路径，
       * 所以这里即使传了范围外的路径也会被 403 挡掉。
       */
      function fileOp(action, row) {
        notify(action === "open" ? "打开中…" : "定位中…");
        apiSend("/files/" + action + "?path=" + encodeURIComponent(row.path), "POST")
          .then(function () {
            notify(action === "open" ? "已交给系统打开" : "已在资源管理器中定位");
          })
          .catch(function (err) {
            notify((action === "open" ? "打开失败：" : "定位失败：") + (err && err.message ? err.message : String(err)));
          });
      }

      function copyPath(row) {
        try {
          navigator.clipboard.writeText(row.path)
            .then(function () { notify("路径已复制"); })
            .catch(function () { notify(row.path); });
        } catch (e) {
          notify(row.path);
        }
      }

      /** 复制一段 `@` 引用文本（诚实降级：就是复制，不是注入输入框）。 */
      function copyAtMention(row) {
        var mention = atMention(row.path, !!row.isDirectory);
        if (!mention) { notify("这个路径不能写成 @引用"); return; }
        try {
          navigator.clipboard.writeText(mention)
            .then(function () { notify("已复制 @引用：" + mention); })
            .catch(function () { notify(mention); });
        } catch (e) {
          notify(mention);
        }
      }

      /** 一行的操作按钮：≤3 个，装进 72px 固定占位（hover / :focus-within 才可见）。 */
      function rowActions(row) {
        var isDir = !!row.isDirectory;
        var kids = [];
        if (isDir) {
          kids.push(RowAction(h, "打开文件夹", ACT_ICON_OPEN, function (event) { event.stopPropagation(); openRow(row); }));
        } else {
          kids.push(RowAction(h, "用系统默认程序打开", ACT_ICON_OPEN, function (event) { event.stopPropagation(); fileOp("open", row); }));
          kids.push(RowAction(h, "在资源管理器中定位", ACT_ICON_REVEAL, function (event) { event.stopPropagation(); fileOp("reveal", row); }));
          kids.push(RowAction(h, "登记进产物库", ACT_ICON_REGISTER, function (event) { event.stopPropagation(); registerRow(row); }));
        }
        return kids;
      }

      /**
       * 打开右键菜单（**唯一入口**）：F10 与鼠标右键都走这里。
       *
       * 坐标一律经 `placeMenu()`（§11.1②：夹取 + 只在真能放下那侧翻转），
       * 这里先用 `OVERLAY_ESTIMATE` 估一次保证首帧不飞出视口，渲染后再用实测尺寸校正一次。
       */
      function openMenu(row, anchor) {
        var vw = (typeof window !== "undefined" && Number(window.innerWidth)) || 0;
        var vh = (typeof window !== "undefined" && Number(window.innerHeight)) || 0;
        var point = {
          left: Number(anchor && anchor.left) || 0,
          top: Number(anchor && anchor.top) || 0,
          right: isFinite(Number(anchor && anchor.right)) ? Number(anchor.right) : (Number(anchor && anchor.left) || 0),
          bottom: isFinite(Number(anchor && anchor.bottom)) ? Number(anchor.bottom) : (Number(anchor && anchor.top) || 0),
        };
        // 夹取/翻转只在 placeMenu 里做一次 —— 这里直接用它的结果，不重复算（避免两处各自演化）
        var placed = placeMenu(point, OVERLAY_ESTIMATE, { width: vw, height: vh });
        setMenu({ x: placed.x, y: placed.y, anchor: point, row: row });
      }

      /** 键盘等价路径（W3C treeview 风格）：↑↓ 移动 / → 进入 / ← 回父 / Home End / Shift+F10 出菜单。 */
      function onRowKey(event, row, index, list) {
        var key = event.key;
        var target = event.currentTarget;
        // 多选的键盘等价路径（task-9 §4.2）：Space 切换、Ctrl/Cmd+A 全选、Escape 清空
        if (key === " " || key === "Spacebar") { event.preventDefault(); toggleSel(row); return; }
        if ((key === "a" || key === "A") && (event.ctrlKey || event.metaKey)) { event.preventDefault(); selectAll(); return; }
        if (key === "Escape" && selCount()) { event.preventDefault(); clearSel(); return; }
        function focusAt(next) {
          if (next < 0 || next >= list.length) return;
          setFocusIdx(next);
          // 虚拟化时目标行可能还没进 DOM：先把它滚进视口，等渲染完由 effect 聚焦
          if (virtual) {
            pendingFocusRef.current = next;
            try {
              var host = scrollRef.current;
              if (host) {
                var top = next * itemSize;
                var viewTop = Number(host.scrollTop) || 0;
                var viewH = Number(host.clientHeight) || VIRTUAL_VIEWPORT_FALLBACK;
                if (top < viewTop) host.scrollTop = top;
                else if (top + itemSize > viewTop + viewH) host.scrollTop = top + itemSize - viewH;
              }
            } catch (error) { /* 滚动失败不影响别的键 */ }
            return;
          }
          try {
            var siblings = target && target.parentNode ? target.parentNode.children : null;
            var node = siblings ? siblings[next] : null;
            if (node && typeof node.focus === "function") node.focus();
          } catch (error) { /* 焦点移动失败不影响功能 */ }
        }
        if (key === "ArrowDown") { event.preventDefault(); focusAt(index + 1); }
        else if (key === "ArrowUp") { event.preventDefault(); focusAt(index - 1); }
        else if (key === "Home") { event.preventDefault(); focusAt(0); }
        else if (key === "End") { event.preventDefault(); focusAt(list.length - 1); }
        else if (key === "ArrowRight") { event.preventDefault(); if (row.isDirectory) openRow(row); else fileOp("reveal", row); }
        else if (key === "ArrowLeft") { event.preventDefault(); var up = parentOf(path); if (up) setPath(up); }
        else if (key === "Enter" || key === " ") { event.preventDefault(); if (row.isDirectory) openRow(row); else fileOp("open", row); }
        else if (key === "F10" && event.shiftKey) {
          event.preventDefault();
          try {
            var rect = target.getBoundingClientRect();
            openMenu(row, { left: rect.right - 8, top: rect.top, right: rect.right - 8, bottom: rect.bottom });
          } catch (error) { openMenu(row, { left: 120, top: 120, right: 120, bottom: 120 }); }
        }
      }

      /** Ctrl+P：快速跳到范围根 / 最近目录。**面板可见时才响应**，不抢宿主全局快捷键。 */
      React.useEffect(function () {
        function onKey(event) {
          if (!(event.ctrlKey || event.metaKey)) return;
          if (String(event.key || "").toLowerCase() !== "p") return;
          try {
            var node = rootRef.current;
            var visible = node && typeof node.getClientRects === "function" && node.getClientRects().length > 0;
            if (!visible) return;               // 面板没显示 → 不管这个键
          } catch (error) { return; }
          event.preventDefault();
          if (finder) closeFinder();
          else openFinder(event.target || null);
        }
        try {
          if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("keydown", onKey);
        } catch (error) { /* 忽略 */ }
        return function () {
          try {
            if (typeof document !== "undefined" && document.removeEventListener) document.removeEventListener("keydown", onKey);
          } catch (error) { /* 忽略 */ }
        };
      }, []);

      /** 右键菜单元素：用来做视口适配（§11.1②：贴边/底部弹出时不越界）。 */
      var menuRef = React.useRef(null);

      /**
       * 菜单渲染走 `placeOverlay()`：量一次实测尺寸，再算最终坐标（夹取 + 必要时翻转）。
       * 只调整一次 —— 调整后坐标稳定，effect 再跑也不会继续改（不会来回振荡）。
       */
      React.useEffect(function () {
        if (!menu) return;
        try {
          var node = menuRef.current;
          if (!node || typeof node.getBoundingClientRect !== "function") return;
          var rect = node.getBoundingClientRect();
          var vw = (typeof window !== "undefined" && Number(window.innerWidth)) || 0;
          var vh = (typeof window !== "undefined" && Number(window.innerHeight)) || 0;
          if (!vw || !vh || !rect.width || !rect.height) return;
          var placed = placeMenu(menu.anchor, { width: rect.width, height: rect.height }, { width: vw, height: vh });
          if (placed.x !== menu.x || placed.y !== menu.y) {
            setMenu({ x: placed.x, y: placed.y, anchor: menu.anchor, row: menu.row });
          }
        } catch (error) { /* 量不到就按原位置显示，不影响功能 */ }
      });

      /** 右键菜单：点空白处 / Escape 关闭。 */
      React.useEffect(function () {
        if (!menu) return undefined;
        function closeMenu() { setMenu(null); }
        function onEsc(event) { if (event.key === "Escape") setMenu(null); }
        try {
          if (typeof document !== "undefined" && document.addEventListener) {
            document.addEventListener("click", closeMenu);
            document.addEventListener("keydown", onEsc);
          }
        } catch (error) { /* 忽略 */ }
        return function () {
          try {
            if (typeof document !== "undefined" && document.removeEventListener) {
              document.removeEventListener("click", closeMenu);
              document.removeEventListener("keydown", onEsc);
            }
          } catch (error) { /* 忽略 */ }
        };
      }, [menu]);

      var upPath = parentOf(path);
      var crumbs = crumbItems(path);
      var crumbView = crumbs;
      var crumbFaded = false;
      if (crumbs.length > 5) {
        // 太深就折叠中间段（溢出时左侧渐隐，见 CSS 的 mask-image）
        crumbView = [crumbs[0], { label: "…", path: crumbs[crumbs.length - 2].path }, crumbs[crumbs.length - 2], crumbs[crumbs.length - 1]];
        crumbFaded = true;
      }
      var crumbNav = h("nav", {
        className: NS + "__crumbs" + (crumbFaded ? " " + NS + "__crumbs--fade" : ""),
        "aria-label": "路径",
      }, crumbView.map(function (item, i) {
        var last = i === crumbView.length - 1;
        return h("button", {
          key: "c" + String(i),
          type: "button",
          className: NS + "__crumb",
          title: item.path,
          "aria-current": last ? "page" : undefined,
          onClick: function () { if (!last) setPath(item.path); },
        }, item.label);
      }));

      // ── 面包屑可编辑（task-9 §4.6）────────────────────────────────────────
      //   点「编辑路径」把面包屑换成输入框，回车跳转；非法/越界路径由宿主报错（会显示在错误态里）。
      var pathEditor = crumbEdit === null ? crumbNav : h("span", { className: NS + "__pathedit" },
        h("input", {
          className: NS + "__input", type: "text", value: crumbEdit, "aria-label": "编辑路径",
          autoFocus: true,
          onChange: function (event) { setCrumbEdit(event.target.value); },
          onKeyDown: function (event) {
            if (event.key === "Enter") {
              var target = String(crumbEdit || "").trim();
              setCrumbEdit(null);
              if (target) { setPath(target); setReloadToken(reloadToken + 1); }
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setCrumbEdit(null);
            }
          },
        }),
        h("button", {
          type: "button", className: NS + "__btn",
          onClick: function () { setCrumbEdit(null); },
        }, "取消"));

      var bar = h("div", { className: NS + "__bar" },
        h("button", {
          type: "button", className: NS + "__btn", "aria-label": "上级目录",
          disabled: !upPath,
          onClick: function () { if (upPath) setPath(upPath); },
        }, "上级"),
        h("button", {
          type: "button", className: NS + "__btn", "aria-label": "刷新当前目录",
          onClick: function () { setReloadToken(reloadToken + 1); },
        }, "刷新"),
        pathEditor,
        // 最近访问过的目录（复用 Ctrl+P 的模块级记录；用原生 select，零新增状态）
        recent.length
          ? h("select", {
            className: NS + "__select", "aria-label": "最近访问过的目录",
            value: "", onChange: function (event) { if (event.target.value) setPath(event.target.value); },
          },
            [h("option", { key: "r0", value: "" }, "最近…")].concat(recent.map(function (dir, i) {
              return h("option", { key: "r" + String(i), value: dir, title: dir }, baseNameOf(dir) || dir);
            })))
          : null,
        crumbEdit === null
          ? h("button", {
            type: "button", className: NS + "__btn", "aria-label": "编辑路径",
            onClick: function () { setCrumbEdit(path); },
          }, "编辑路径")
          : null,
        // ── 视图控制（与产物侧**同一套控件**，task-11 ②③）────────────────
        //   列与尺寸写进真设置（PUT，重启还在）；目录的呈现方式是本视图的就地选择。
        h(ViewControl, {
          key: "dirviewctl",
          label: "目录",
          view: dirView,
          onView: function (kind) { setDirView(kind); },
          density: density,
          onDensity: function (next) {
            setDensity(next);
            if (typeof props.onSettings === "function") props.onSettings({ density: next }, "行高已改");
          },
          cardSize: cardSizeKeyFromPx(cardPx),
          onCardSize: function (next) {
            if (typeof props.onSettings === "function") props.onSettings({ galleryThumbSize: cardSizePx(next) }, "卡片尺寸已改");
          },
          columns: columns,
          onColumns: function (next) {
            if (typeof props.onSettings === "function") props.onSettings({ columns: next }, "列已改");
          },
        }),
        h("button", {
          type: "button", className: NS + "__btn", "aria-label": "复制当前目录路径",
          onClick: function () { copyPath({ path: path }); },
        }, "复制路径")
      );

      // ── 批量操作条（task-9 §4.2）──────────────────────────────────────────
      //   ① **明确的视觉与计数**：「已选 N 项」+「清空选择」；
      //   ② 每个动作都必须真的接上宿主端点（复制=剪贴板，登记=POST /，打开=POST /files/open）；
      //   ③ **可退回**：批量登记后给「撤销」（把刚登记的移入回收站）。
      var count = selCount();
      var selRows = count ? selectedRows() : [];
      var selBar = (count || batchUndo) ? h("div", { className: NS + "__selbar", role: "toolbar", "aria-label": "批量操作" },
        count ? h("span", { className: NS + "__selcount" }, "已选 " + String(count) + " 项") : null,
        count ? h("button", {
          type: "button", className: NS + "__btn", "aria-label": "批量复制路径",
          onClick: function () { batchCopy(selRows); },
        }, "复制路径") : null,
        count ? h("button", {
          type: "button", className: NS + "__btn " + NS + "__btn--primary", "aria-label": "批量登记进产物库",
          onClick: function () { batchRegister(selRows); },
        }, "登记进产物库") : null,
        count ? h("button", {
          type: "button", className: NS + "__btn", "aria-label": "批量用默认程序打开",
          onClick: function () { batchOpen(selRows); },
        }, "打开") : null,
        count ? h("button", {
          type: "button", className: NS + "__btn", "aria-label": "清空选择", title: "清空选择（Esc）",
          onClick: clearSel,
        }, "清空选择") : null,
        batchUndo ? h("span", { className: NS + "__selundo" },
          h("span", { className: NS + "__meta" }, batchUndo.note),
          h("button", {
            type: "button", className: NS + "__btn", "aria-label": "撤销刚才的批量登记",
            onClick: undoBatch,
          }, "撤销（移入回收站）")) : null
      ) : null;

      var roots = null;
      if (scope.length > 1) {
        roots = h("div", { className: NS + "__bar" },
          h("span", { className: NS + "__meta" }, "范围根："),
          scope.map(function (dir, i) {
            return h("button", {
              key: String(i),
              type: "button",
              className: NS + "__btn" + (dir === path ? " " + NS + "__btn--primary" : ""),
              title: dir,
              "aria-label": "切换到 " + dir,
              onClick: function () { setPath(dir); },
            }, dir.split(/[\\/]/).filter(Boolean).pop() || dir);
          })
        );
      }

      // 列头：名称（固定）/ 大小 / 修改时间 / 类型 —— **哪些列显示由设置的 `columns` 决定**（task-11 ③）
      var headCols = [{ by: "name", label: "名称", cls: NS + "__dcol--name" }];
      if (columns.size !== false) headCols.push({ by: "size", label: "大小", cls: NS + "__dcol--size" });
      if (columns.time !== false) headCols.push({ by: "time", label: "修改时间", cls: NS + "__dcol--time" });
      if (columns.type === true) headCols.push({ by: "name", label: "类型", cls: NS + "__dcol--type" });
      var headRow = dirView === "list" ? h("div", { className: NS + "__dhead", role: "row" },
        headCols.map(function (col) {
          var active = sort.by === col.by;
          var ariaSort = !active ? "none" : (sort.dir === "asc" ? "ascending" : "descending");
          return h("button", {
            key: col.by,
            type: "button",
            role: "columnheader",
            className: NS + "__dcol " + col.cls,
            "aria-sort": ariaSort,
            onClick: function () { toggleSort(col.by); },
          }, col.label + (active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""));
        }),
        h("span", { className: NS + "__dact", "aria-hidden": "true" })
      ) : null;

      var sorted = sortedEntries();

      // ── 虚拟滚动（§3.7）：阈值来自设置（`virtualThreshold: 0` = 总是启用）──────
      //   小目录走原路径（DOM 结构与行为逐字不变，键盘/焦点语义完全一致）。
      //   `aria-rowcount` 取**全量** sorted.length，`aria-rowindex` 取**绝对** 1-based 下标，
      //   否则屏幕阅读器只知道"有 N 行"却不知道当前读的是第几行。
      var virtual = virtualThreshold === 0 ? sorted.length > 0 : sorted.length > virtualThreshold;
      var itemSize = rowHeightPx(density);
      var winStart = 0;
      var winEnd = sorted.length;
      if (virtual) {
        var viewH = scrollState.height || VIRTUAL_VIEWPORT_FALLBACK;
        winStart = Math.max(0, Math.floor(scrollState.top / itemSize) - VIRTUAL_OVERSCAN);
        winEnd = Math.min(sorted.length, winStart + Math.ceil(viewH / itemSize) + VIRTUAL_OVERSCAN * 2);
      }

      var listRows = sorted.slice(winStart, winEnd).map(function (row, j) {
        var i = winStart + j;                       // 全量下标：焦点、aria-rowindex 都用它
        var isDir = !!row.isDirectory;
        var count = counts[row.path];
        // 图片（非目录、非符号链接、不超限、没全失败过）出缩略图，其余出类型图标。
        // URL 两级：首选自建 /files/thumb（过 assertInScope），失败退官方 api/file，再失败退图标。
        var thumbStage = thumbFailed[row.path];
        var thumb = "";
        // `thumbnails: false` 时整列不出图（设置真的生效，不是只存值）
        if (showThumbnails && !isDir && thumbStage !== "1") {
          var thumbUrls = thumbUrlsFor(row);
          if (thumbUrls) thumb = thumbStage ? (thumbUrls.fallback || "") : thumbUrls.primary;
        }
        return h("div", {
          key: String(i),
          className: NS + "__drow",
          role: "row",
          "data-dir": isDir ? "1" : "0",
          "data-missing": row.exists === false ? "1" : "0",
          "data-sel": sel.paths[row.path] === 1 ? "1" : "0",
          "aria-selected": sel.paths[row.path] === 1 ? "true" : "false",
          "data-index": String(i),
          "aria-rowindex": String(i + 1),
          tabIndex: i === focusIdx ? 0 : -1,
          "aria-label": String(row.name || row.path),
          style: { paddingLeft: rowIndent(0) },
          // 点击语义（task-9 §4.2）：Ctrl/Cmd = 切换单行；Shift = 区间；普通点击 = 目录进入 / 清空选择
          onClick: function (event) {
            if (event.ctrlKey || event.metaKey) { event.preventDefault(); toggleSel(row); return; }
            if (event.shiftKey) { event.preventDefault(); rangeSel(row); return; }
            if (selCount()) { clearSel(); }
            if (isDir) openRow(row);
          },
          onFocus: function () { setFocusIdx(i); },
          onContextMenu: function (event) {
            event.preventDefault();
            // 右键点在未选中的行上 → 先把选择收敛到这一行（跟系统文件管理器一致）
            if (sel.paths[row.path] !== 1) setSel({ paths: (function () { var o = {}; o[row.path] = 1; return o; })(), anchor: i });
            // 鼠标位置当作「锚点在鼠标处」的 rect 传进去，夹取/翻转交给 openMenu
            openMenu(row, { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY });
          },
          onKeyDown: function (event) { onRowKey(event, row, i, sorted); },
        },
          h("span", { role: "gridcell" },
            thumb
              ? h("img", {
                className: NS + "__dthumb",
                src: thumb,
                alt: "",
                loading: "lazy",
                // 缩略图尺寸来自设置（thumbSize: 16/24/32），改完立即生效
                style: { width: String(thumbSize) + "px", height: String(thumbSize) + "px" },
                onError: function () { markThumbFailed(row.path); },
              })
              : IconView(h, iconOf(row.name || row.path, isDir), "ico")),
          h("span", { className: NS + "__dname", role: "gridcell" },
            NameText(h, row.name || row.path, NS + "__dnameText", "nm")),
          columns.size === false ? null
            : h("span", { className: NS + "__dsize", role: "gridcell" }, isDir ? (count ? count + " 项" : "—") : fmtSize(row.size)),
          columns.time === false ? null
            : h("span", { className: NS + "__dtime", role: "gridcell" }, rowTimeText(row)),
          columns.type === true
            ? h("span", { className: NS + "__dtype", role: "gridcell" }, isDir ? "文件夹" : (String(row.name || "").split(".").pop() || "—").toLowerCase())
            : null,
          h("span", { className: NS + "__dact", role: "gridcell", "data-open": menu && menu.row === row ? "1" : "0" }, rowActions(row))
        );
      });

      /** 虚拟滚动下：目标行滚进视口并渲染出来后，再把焦点交给它。 */
      React.useEffect(function () {
        var pending = pendingFocusRef.current;
        if (pending === null || !virtual) return;
        if (pending < winStart || pending >= winEnd) return;
        pendingFocusRef.current = null;
        try {
          var host = scrollRef.current;
          var node = host && typeof host.querySelector === "function"
            ? host.querySelector('[data-index="' + String(pending) + '"]')
            : null;
          if (node && typeof node.focus === "function") node.focus();
        } catch (error) { /* 聚焦失败不影响功能 */ }
      });

      var menuNode = menu ? h("div", {
        className: NS + "__menu",
        role: "menu",
        "aria-label": "文件操作",
        ref: menuRef,
        style: { left: String(menu.x) + "px", top: String(menu.y) + "px" },
        onClick: function (event) { event.stopPropagation(); },
      },
        menu.row.isDirectory
          ? h("button", {
            type: "button", role: "menuitem", className: NS + "__mi",
            onClick: function () { setMenu(null); openRow(menu.row); },
          }, "打开文件夹")
          : h("button", {
            type: "button", role: "menuitem", className: NS + "__mi",
            onClick: function () { setMenu(null); fileOp("open", menu.row); },
          }, "用默认程序打开"),
        h("button", {
          type: "button", role: "menuitem", className: NS + "__mi",
          onClick: function () { setMenu(null); fileOp("reveal", menu.row); },
        }, "在资源管理器中定位"),
        h("button", {
          type: "button", role: "menuitem", className: NS + "__mi",
          onClick: function () { setMenu(null); copyPath(menu.row); },
        }, "复制路径"),
        // 诚实命名：这就是**复制一段 `@` 引用文本**，不是「@ 进输入框」。
        // 真正的引用插入走输入框的 `@` 菜单（root 服务 inputTriggers 的 registerSource）。
        h("button", {
          type: "button", role: "menuitem", className: NS + "__mi",
          onClick: function () { setMenu(null); copyAtMention(menu.row); },
        }, "复制为 @引用"),
        menu.row.isDirectory ? null : h("button", {
          type: "button", role: "menuitem", className: NS + "__mi",
          onClick: function () { setMenu(null); registerRow(menu.row); },
        }, "登记进产物库")
      ) : null;

      var body;
      if (!path) {
        body = StateBlock(h, STATE_ICON_FOLDER, "还没有可浏览的目录",
          ["索引范围为空 —— 先到「文件」视图启动索引，或登记几个产出"], null, "nodir");
      } else if (phase === "loading") {
        // 加载 = 骨架屏（每行正好一行高），不要 spinner
        body = SkeletonRows(h, 5);
      } else if (phase === "error") {
        body = StateBlock(h, STATE_ICON_ALERT, "目录读取失败：" + error,
          ["若提示 404：文件索引路由是宿主侧改动，重启一次 DSH 即可（本界面已就绪）"], [
            h("button", {
              key: "retry", type: "button", className: NS + "__btn", "aria-label": "重试",
              onClick: function () { setReloadToken(reloadToken + 1); },
            }, "重试"),
          ], "err");
      } else if (!sorted.length) {
        // ★ 空态分两种（lead 点名的 UX 问题）：真的空 vs **被 showHidden 过滤成空**
        //   —— 后者若只说「空的」，用户会以为文件丢了（正是「找回」叙事最怕的体验）。
        var hiddenCount = listMeta && listMeta.hiddenFiltered ? listMeta.hiddenFiltered : 0;
        body = hiddenCount > 0
          ? StateBlock(h, STATE_ICON_FOLDER,
            "这里有 " + String(hiddenCount) + " 个隐藏项被过滤了",
            ["默认隐藏「点开头」的文件与已知系统噪音文件（desktop.ini / Thumbs.db 等）。",
              "这是近似规则 —— Windows 的「隐藏」文件属性读不到，不等于遵循系统隐藏设置。"], [
              h("button", {
                key: "showhidden", type: "button", className: NS + "__btn " + NS + "__btn--primary",
                "aria-label": "显示隐藏项",
                onClick: function () {
                  // 打开 showHidden 后重载：改的是真设置（宿主行为），不是本地开关
                  apiSend("/settings", "PUT", { showHidden: true })
                    .then(function () { setReloadToken(reloadToken + 1); notify("已改为显示隐藏项"); })
                    .catch(function (err) { notify("设置失败：" + (err && err.message ? err.message : String(err))); });
                },
              }, "显示这 " + String(hiddenCount) + " 个隐藏项"),
            ], "hidden")
          : StateBlock(h, STATE_ICON_FOLDER, "这个文件夹是空的",
            ["下一步：去上一级看看，或者用「文件」视图按关键词搜（不用一层层翻）。"],
            [
              h("button", {
                key: "up", type: "button", className: NS + "__btn",
                onClick: function () {
                  var parent = splitPathParts(path).dir.replace(/[\\/]+$/, "");
                  if (parent) setPath(parent);
                },
              }, "↑ 上一级"),
              h("button", {
                key: "tofiles", type: "button", className: NS + "__btn",
                onClick: function () { if (typeof props.onGoFiles === "function") props.onGoFiles(); },
              }, "用「文件」搜索"),
            ], "empty");
      } else if (dirView === "card" || dirView === "gallery") {
        // ── 目录里的卡片 / 画廊（task-11 ②）：同一份数据换种呈现 ─────────────
        //   尺寸来自「卡片尺寸」档位（⇄ galleryThumbSize），坏图仍走两级回退。
        var cellPx = dirView === "gallery" ? cardPx + 46 : Math.max(Math.round(cardPx * 1.6), 120);
        body = h("div", { className: NS + (dirView === "gallery" ? "__gallery" : "__dcards"), "data-card-size": String(cardPx), role: "grid", "aria-label": "目录内容（" + (dirView === "gallery" ? "画廊" : "卡片") + "）" },
          sorted.map(function (row, i) {
            var isDir = !!row.isDirectory;
            var stage = thumbFailed[row.path];
            var src = "";
            if (!isDir && showThumbnails && stage !== "1") {
              var urls = thumbUrlsFor(row);
              if (urls) src = stage ? (urls.fallback || "") : urls.primary;
            }
            return h("figure", {
              key: row.path + "#" + String(i),
              className: NS + "__gcell",
              "data-dir": isDir ? "1" : "0",
              "data-index": String(i),
              style: { width: String(cellPx) + "px" },
              title: row.path,
              onClick: function (event) {
                if (event.ctrlKey || event.metaKey) { toggleSel(row); return; }
                if (event.shiftKey) { rangeSel(row); return; }
                if (isDir) openRow(row);
              },
              onContextMenu: function (event) {
                event.preventDefault();
                if (sel.paths[row.path] !== 1) setSel({ paths: (function () { var o = {}; o[row.path] = 1; return o; })(), anchor: i });
                openMenu(row, { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY });
              },
            },
              h("div", { className: NS + "__gbox", style: { width: String(cellPx) + "px", height: String(cellPx - 46 + 46) + "px" },
                outline: sel.paths[row.path] === 1 ? "2px solid var(--dsw-alias-state-business-primary)" : null },
                src
                  ? h("img", {
                    className: NS + "__gimg",
                    src: src,
                    alt: "",
                    loading: "lazy",
                    style: { width: String(dirView === "gallery" ? cardPx : Math.round(cardPx * 1.2)) + "px", height: String(dirView === "gallery" ? cardPx : Math.round(cardPx * 1.2)) + "px" },
                    onError: function () { markThumbFailed(row.path); },
                  })
                  : h("span", { className: NS + "__gicon" }, IconView(h, iconOf(row.name || row.path, isDir), "ico"))),
              h("figcaption", { className: NS + "__gcap" }, NameText(h, row.name || row.path, NS + "__gname", "gname")));
          }));
        if (listMeta && listMeta.truncated) {
          body = h("div", null, body, h("div", { className: NS + "__note" },
            "仅显示前 " + String(listMeta.limit || sorted.length) + " 项，共 " + String(listMeta.total) + " 项"));
        }
      } else {
        var grid = h("div", {
          className: NS + "__dlist",
          "data-density": density,
          role: "grid",
          "aria-label": "目录内容",
          "aria-rowcount": String(sorted.length),
          style: virtual ? { position: "relative", height: String(sorted.length * itemSize) + "px" } : null,
        }, virtual
          // transform（不是 margin-top）：定位不触发重排
          ? h("div", { style: { transform: "translateY(" + String(winStart * itemSize) + "px)" } }, listRows)
          : listRows);

        if (virtual) {
          // 自己的滚动容器：行数多时只有可见行在 DOM 里
          body = h("div", { className: NS + "__dwrap" },
            headRow,
            h("div", {
              className: NS + "__dscroll",
              ref: scrollRef,
              onScroll: onListScroll,
            }, grid));
        } else {
          body = h("div", null, headRow, grid);
        }
        // 被截断了就说清楚（host 侧默认 2000 / 硬上限 10000），否则用户会以为文件丢了
        if (listMeta && listMeta.truncated) {
          body = h("div", null, body, h("div", { className: NS + "__note" },
            "仅显示前 " + String(listMeta.limit || sorted.length) + " 项，共 " + String(listMeta.total) + " 项"));
        }
      }

      // ── Ctrl+P 快速跳转浮层：范围根 + 最近目录 ────────────────────────────
      var finderNode = null;
      if (finder) {
        var seenDir = {};
        var candidates = [];
        var pushDir = function (dirPath, tag) {
          var key = String(dirPath || "");
          if (!key || seenDir[key]) return;
          seenDir[key] = "1";
          candidates.push({ path: key, tag: tag });
        };
        for (var si = 0; si < scope.length; si += 1) pushDir(scope[si], "范围根");
        for (var ri = 0; ri < RECENT_DIRS.length; ri += 1) pushDir(RECENT_DIRS[ri], "最近");
        var finderQ = String(finder.q || "").toLowerCase();
        var finderHits = candidates.filter(function (item) {
          return !finderQ || item.path.toLowerCase().indexOf(finderQ) >= 0;
        }).slice(0, 30);
        var finderCursor = Math.min(Math.max(Number(finder.cursor) || 0, 0), Math.max(finderHits.length - 1, 0));

        // position:fixed（见 CSS）—— 逃出 `.alf{overflow:hidden}`，面板矮时也不会被裁；
        // 坐标同样经 placeMenu() 走一遍夹取/翻转（§11.1②），锚点取打开那一刻的面板矩形。
        var finderBox = finder.box;
        var finderSize = finderBox
          ? {
            width: Math.max(Math.round(finderBox.width) - 36, 280),
            height: Math.min(Math.max(Math.round(finderBox.height) - 80, 160), 280),
          }
          : { width: 520, height: 280 };
        var finderViewport = {
          width: (typeof window !== "undefined" && Number(window.innerWidth)) || 0,
          height: (typeof window !== "undefined" && Number(window.innerHeight)) || 0,
        };
        var finderAnchor = finderBox
          ? { left: Math.round(finderBox.left) + 18, top: Math.round(finderBox.top) + 52, right: Math.round(finderBox.left) + 18, bottom: Math.round(finderBox.top) + 52 }
          : { left: 24, top: 96, right: 24, bottom: 96 };
        var finderPlaced = placeMenu(finderAnchor, finderSize, finderViewport);
        var finderStyle = {
          left: String(Math.max(finderPlaced.x, OVERLAY_MARGIN)) + "px",
          top: String(Math.max(finderPlaced.y, OVERLAY_MARGIN)) + "px",
          width: String(finderSize.width) + "px",
          maxHeight: String(Math.min(Math.max(finderSize.height, 160), 280)) + "px",
        };

        finderNode = h("div", {
          className: NS + "__finder",
          role: "dialog",
          "aria-label": "快速跳转",
          style: finderStyle,
        },
          h("input", {
            className: NS + "__input",
            type: "text",
            "aria-label": "快速跳转目录",
            placeholder: "输入目录名或路径片段，回车跳转",
            value: finder.q,
            autoFocus: true,
            onChange: function (event) { setFinder({ q: event.target.value, cursor: 0 }); },
            onKeyDown: function (event) {
              if (event.key === "Escape") { event.preventDefault(); closeFinder(); }
              else if (event.key === "ArrowDown") {
                event.preventDefault();
                setFinder({ q: finder.q, cursor: Math.min(finderCursor + 1, finderHits.length - 1) });
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setFinder({ q: finder.q, cursor: Math.max(finderCursor - 1, 0) });
              } else if (event.key === "Enter") {
                event.preventDefault();
                var target = finderHits[finderCursor];
                if (target) { setPath(target.path); closeFinder(); }
              }
            },
          }),
          h("div", { className: NS + "__finderList" },
            finderHits.length
              ? finderHits.map(function (item, i) {
                return h("button", {
                  key: "f" + String(i),
                  type: "button",
                  className: NS + "__finderItem",
                  "data-on": i === finderCursor ? "1" : "0",
                  title: item.path,
                  onClick: function () { setPath(item.path); closeFinder(); },
                },
                  h("span", { className: NS + "__meta" }, item.tag),
                  item.path);
              })
              : h("div", { className: NS + "__finderHint" }, "没有匹配的目录")),
          h("div", { className: NS + "__finderHint" }, "↑↓ 选择 · 回车跳转 · Esc 关闭 · Ctrl+P 开关")
        );
      }

      return h("div", {
        "data-density": density,
        ref: rootRef,
        style: { position: "relative" },
        // 拖入登记：`dragenter/over` 计数用来显示投放提示，`drop` 才真的登记
        onDragEnter: function (event) { event.preventDefault(); setDragOver(dragOver + 1); },
        onDragOver: function (event) { event.preventDefault(); },
        onDragLeave: function (event) { event.preventDefault(); setDragOver(Math.max(dragOver - 1, 0)); },
        onDrop: handleDrop,
      }, bar, selBar, roots, body, dragOver > 0 ? h("div", { className: NS + "__drop" },
        "松手即登记进产物库") : null, menuNode, finderNode);
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

      /** 搜索框下方的 filter chips（§四）：默认「全部」。 */
      var sChip = React.useState("");
      var chip = sChip[0];
      var setChip = sChip[1];

      /** 本地排序：**换关键词时重置为默认**（§四）。 */
      /** 搜索结果里的多选（task-13 A 的第四处）：与目录/产物同一套快捷键语义。 */
      var sSel = React.useState({ paths: {}, anchor: -1 });
      var fvSel = sSel[0];
      var setFvSel = sSel[1];

      var sSort = React.useState({ by: "name", dir: "asc" });
      var sort = sSort[0];
      var setSort = sSort[1];

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
          return "文件索引暂时不可用（可能在重建索引）—— 稍等再试，或点「查状态」看看";
        }
        if (msg.indexOf("500") >= 0) {
          return "文件索引查询出错 —— 点「查状态」确认索引是否已就绪；若显示「索引就绪」请再试一次";
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
              notify("文件索引已就绪");
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

      /** 搜索（**200ms** 防抖，§四） */
      function runSearch(next) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(function () {
          setBusy(true);
          setSort({ by: "name", dir: "asc" });   // §四：换关键词 → 排序重置为默认
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
        }, 200);
      }

      /** 命中项一键登记进产物库 */
      function registerRow(row) {
        notify("登记中…");
        apiSend("", "POST", {
          path: row.path,
          title: row.name,
          kind: "deliverable",
          source: "manual",
          tags: row.ext ? [row.ext] : [],
        })
          .then(function (record) {
      // host-dev：同一路径已有有效记录 → 返回已有那条 + duplicate:true（**没有新建**）。
      // 这时说「已登记」会让人以为新加了一条，所以分开说。
      if (record && record.duplicate) notify("这个文件已经在产物库里了：" + row.name);
      else notify("已登记：" + row.name);
    })
          .catch(function (err) { notify("登记失败：" + (err && err.message ? err.message : String(err))); });
      }

      /** 在资源管理器中定位（搜索命中项都在索引范围内，过得了宿主侧的 assertInScope 闸门） */
      function revealRow(row) {
        notify("定位中…");
        apiSend("/files/reveal?path=" + encodeURIComponent(row.path), "POST")
          .then(function () { notify("已在资源管理器中定位"); })
          .catch(function (err) { notify("定位失败：" + (err && err.message ? err.message : String(err))); });
      }

      /** 复制所在目录（未登记文件不能用产物库的「在资源管理器打开」端点） */
      function copyDir(row) {
        var target = row.dir || row.path;
        try {
          navigator.clipboard.writeText(target)
            .then(function () { notify("目录已复制"); })
            .catch(function () { notify(target); });
        } catch (err) {
          notify(target);
        }
      }

      /** chip 过滤（客户端做，不额外打扰索引）。 */
      function visibleRows() {
        return rows.filter(function (row) { return chipMatches(chip, row.name || row.path); });
      }

      /** 排序（§四允许切列；自然序，file2 在 file10 前）。 */
      function sortedRows(list) {
        var arr = list.slice();
        arr.sort(function (a, b) {
          var r;
          if (sort.by === "size") r = (Number(a.size) || 0) - (Number(b.size) || 0);
          else if (sort.by === "time") r = (Number(a.modified) || 0) - (Number(b.modified) || 0);
          else r = byName.compare(String(a.name || ""), String(b.name || ""));
          return sort.dir === "desc" ? -r : r;
        });
        return arr;
      }

      function toggleSort(by) {
        setSort(function (previous) {
          if (previous.by === by) return { by: by, dir: previous.dir === "asc" ? "desc" : "asc" };
          return { by: by, dir: "asc" };
        });
      }

      // ── 状态条 ──────────────────────────────────────────────────────────
      var scopeCount = status && Array.isArray(status.scope) ? status.scope.length : 0;
      var head = h("div", { className: NS + "__bar" },
        h("span", { className: NS + "__badge " + (phase === "ready" ? NS + "__badge--acc" : "") },
          phase === "ready" ? "索引就绪" : (phase === "starting" ? "启动中" : (phase === "error" ? "出错" : "未启动"))),
        h("span", { className: NS + "__meta" }, "范围 " + String(scopeCount) + " 个目录"),
        status && status.instance ? h("span", { className: NS + "__meta" }, "实例 " + String(status.instance)) : null,
        h("span", { className: NS + "__grow", style: { flex: "1" } }),
        h("button", {
          type: "button", className: NS + "__btn", "aria-label": "查状态",
          onClick: function () { refreshStatus(); },
        }, "查状态")
      );

      // ── 各阶段主体 ──────────────────────────────────────────────────────
      var body;
      if (phase === "checking") {
        // 加载 = 骨架屏（不要 spinner）
        body = SkeletonRows(h, 4);
      } else if (phase === "idle") {
        // 索引未就绪 = 说清「下一步能做什么」+ 一键启动（不是「出错了」）
        body = StateBlock(h, STATE_ICON_ALERT, "搜索需要先启动文件索引",
          ["下一步：点下面的「启动文件索引」；建好后这里就能直接搜文件名/路径。",
            "索引范围：" + String(scopeCount) + " 个目录（DSH 工作区 + 已登记产出所在目录）。",
            "仅索引上述范围，**不索引全盘**；索引数据全部留在本机。",
            "不想建索引也可以：用「目录」视图逐层浏览（实时读盘，不需要索引）。"], [
            h("button", {
              key: "start", type: "button", className: NS + "__btn " + NS + "__btn--primary",
              onClick: startIndex,
            }, "启动文件索引"),
            h("button", {
              key: "godir", type: "button", className: NS + "__btn",
              onClick: function () { if (typeof props.onGoDir === "function") props.onGoDir(); },
            }, "先去「目录」里浏览"),
            h("button", {
              key: "retry", type: "button", className: NS + "__btn",
              onClick: function () { refreshStatus(); },
            }, "重试"),
          ], "idle");
      } else if (phase === "starting") {
        body = h("div", null,
          StateBlock(h, STATE_ICON_SEARCH, "正在拉起 Everything 并建立索引…",
            ["首次建立索引可能需要几十秒，请稍候"], null, "starting"),
          SkeletonRows(h, 4));
      } else if (phase === "error") {
        body = StateBlock(h, STATE_ICON_ALERT, error,
          ["若提示 404：文件索引路由是宿主侧改动，重启一次 DSH 即可（本界面已就绪）"], [
            h("button", { key: "retry", type: "button", className: NS + "__btn", onClick: function () { refreshStatus(); } }, "重试"),
            h("button", { key: "force", type: "button", className: NS + "__btn", onClick: startIndex }, "强制启动"),
          ], "err");
      } else {
        var visible = sortedRows(visibleRows());
      /** 复制一段 @引用 文本（诚实命名：就是复制，不是「@ 进输入框」）。 */
      function copyMentionText(text) {
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
              .then(function () { notify("已复制 @引用：" + text); })
              .catch(function () { notify(text); });
          } else { notify(text); }
        } catch (error) { notify(text); }
      }

      /** 当前选中的搜索结果行。 */
      function fvSelectedRows() {
        return visible.filter(function (row) { return fvSel.paths[row.path] === 1; });
      }
      function fvSelCount() {
        var n = 0;
        for (var k in fvSel.paths) if (Object.prototype.hasOwnProperty.call(fvSel.paths, k)) n += 1;
        return n;
      }

      var resultRows = visible.map(function (row, i) {
          var selected = fvSel.paths[row.path] === 1;
          var mention = atMention(row.path, false);
          return h("div", {
            key: String(i),
            className: NS + "__frow",
            role: "row",
            "data-sel": selected ? "1" : "0",
            "aria-selected": selected ? "true" : "false",
            "aria-label": String(row.path || row.name),
            draggable: mention ? "true" : undefined,
            onDragStart: mention ? function (event) {
              try {
                event.dataTransfer.setData("text/plain", mention);
                event.dataTransfer.setData("application/x-dsh-artifact", JSON.stringify({ path: row.path, mention: mention }));
                event.dataTransfer.effectAllowed = "copy";
              } catch (error) { /* 忽略 */ }
            } : undefined,
            onClick: function (event) {
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                var next = {};
                for (var k in fvSel.paths) if (Object.prototype.hasOwnProperty.call(fvSel.paths, k)) next[k] = fvSel.paths[k];
                if (next[row.path]) delete next[row.path]; else next[row.path] = 1;
                setFvSel({ paths: next, anchor: i });
                return;
              }
              if (event.shiftKey) {
                event.preventDefault();
                var to = i;
                var from = fvSel.anchor >= 0 && fvSel.anchor < visible.length ? fvSel.anchor : to;
                var lo = Math.min(from, to);
                var hi = Math.max(from, to);
                var range = {};
                for (var k2 in fvSel.paths) if (Object.prototype.hasOwnProperty.call(fvSel.paths, k2)) range[k2] = fvSel.paths[k2];
                for (var j = lo; j <= hi; j += 1) if (visible[j]) range[visible[j].path] = 1;
                setFvSel({ paths: range, anchor: from });
                return;
              }
              if (row.isDirectory) return;   // 目录行不跳转（搜索视图按关键词工作）
            },
            onContextMenu: function (event) { event.preventDefault(); registerRow(row); },
          },
            h("span", { role: "gridcell" }, IconView(h, iconOf(row.name || row.path, false), "ico")),
            h("span", { className: NS + "__fmain", role: "gridcell" },
              NameText(h, row.name || row.path, NS + "__fname", "nm"),
              NameText(h, row.dir || "", NS + "__fdir", "dr")),
            h("span", { className: NS + "__dsize", role: "gridcell" }, fmtSize(row.size)),
            h("span", { className: NS + "__dtime", role: "gridcell" }, row.modified ? fmtDate(row.modified) : "—"),
            h("span", { className: NS + "__dact", role: "gridcell" },
              mention ? RowAction(h, "复制为 @引用", ACT_ICON_AT, function (event) { event.stopPropagation(); copyMentionText(mention); }) : null,
              RowAction(h, "登记进产物库", ACT_ICON_REGISTER, function (event) { event.stopPropagation(); registerRow(row); }),
              RowAction(h, "在资源管理器中定位", ACT_ICON_REVEAL, function (event) { event.stopPropagation(); revealRow(row); }),
              RowAction(h, "复制所在目录", ACT_ICON_COPY, function (event) { event.stopPropagation(); copyDir(row); })
            )
          );
        });

        body = h("div", { className: NS + "__fv" },
          h("input", {
            className: NS + "__input",
            type: "text",
            "aria-label": "搜索文件",
            placeholder: "搜索文件名 / 路径，支持 Everything 语法：ext:md · path:projects · dm:today · size:>10mb",
            value: query,
            onChange: function (event) {
              setQuery(event.target.value);
              runSearch(event.target.value);
            },
          }),
          h("div", { className: NS + "__chips", role: "group", "aria-label": "按类型筛选" },
            FILTER_CHIPS.map(function (item) {
              var on = chip === item.key;
              return h("button", {
                key: "chip" + item.key,
                type: "button",
                className: NS + "__chip",
                "data-on": on ? "1" : "0",
                "aria-pressed": on ? "true" : "false",
                onClick: function () { setChip(item.key); },
              }, item.label);
            })
          ),
          // 搜索结果里的批量条（task-13 A 的第四处）：与目录/产物同一套语义
          fvSelCount() ? h("div", { className: NS + "__selbar", role: "toolbar", "aria-label": "批量操作（搜索结果）" },
            h("span", { className: NS + "__selcount" }, "已选 " + String(fvSelCount()) + " 项"),
            h("button", {
              type: "button", className: NS + "__btn " + NS + "__btn--primary", "aria-label": "一键引用（复制到剪贴板）",
              onClick: function () {
                var mentions = fvSelectedRows().map(function (r) { return atMention(r.path, false); }).filter(Boolean);
                if (!mentions.length) { notify("选中的项没有可引用的路径"); return; }
                copyMentionText(mentions.join(" "));
              },
            }, "一键引用（复制）"),
            h("button", {
              type: "button", className: NS + "__btn", "aria-label": "批量登记进产物库",
              onClick: function () {
                var rows = fvSelectedRows();
                var done = 0;
                var chain = Promise.resolve();
                rows.forEach(function (row) {
                  chain = chain.then(function () {
                    return apiSend("", "POST", { path: row.path, title: row.name, kind: "deliverable", source: "manual", tags: row.ext ? [row.ext] : [] })
                      .then(function (record) { if (!record || !record.duplicate) done += 1; })
                      .catch(function () { /* 单项失败不打断 */ });
                  });
                });
                chain.then(function () {
                  notify("已登记 " + String(done) + " 项");
                  setFvSel({ paths: {}, anchor: -1 });
                });
              },
            }, "登记进产物库"),
            h("button", {
              type: "button", className: NS + "__btn", "aria-label": "清空选择",
              onClick: function () { setFvSel({ paths: {}, anchor: -1 }); },
            }, "清空选择")) : null,
          meta
            ? h("div", { className: NS + "__meta" },
              "命中 " + String(meta.total) + " 条",
              meta.elapsedMs ? " · 耗时 " + String(meta.elapsedMs) + " ms" : "",
              meta.truncated ? " · 仅显示前 200 条" : "",
              chip ? " · 已按「" + (FILTER_CHIPS.filter(function (c) { return c.key === chip; })[0] || {}).label + "」筛选" : "",
              " · 列表 " + String(visible.length) + " 行")
            : null,
          busy ? SkeletonRows(h, 4)
            : (visible.length
              ? h("div", { className: NS + "__flist", role: "grid", "aria-label": "搜索结果" }, resultRows)
              : (query
                // 空结果统一走「下一步能做什么」（不是「什么都没有」）：给**能点的**动作
                ? StateBlock(h, STATE_ICON_SEARCH, "没有匹配「" + query + "」的文件",
                  ["下一步：换个关键词，或放宽筛选（Everything 语法：ext:md · path:projects · dm:today · size:>10mb）"],
                  [
                    chip ? h("button", {
                      key: "clearchip", type: "button", className: NS + "__btn " + NS + "__btn--primary",
                      onClick: function () { setChip(""); },
                    }, "把类型筛选切回「全部」") : null,
                    h("button", {
                      key: "clearq", type: "button", className: NS + "__btn",
                      onClick: function () { setQuery(""); runSearch(""); },
                    }, "清空关键词，列出范围内全部"),
                  ].filter(Boolean), "noresult")
                : StateBlock(h, STATE_ICON_SEARCH, "在这里找文件（不需要先想好路径）",
                  ["直接输入关键词，留空会列出范围内的全部文件。",
                    "也支持 Everything 语法：ext:md（按扩展名）· path:projects（按路径）· dm:today（按修改时间）· size:>10mb（按大小）。",
                    "找到之后，点行尾的「登记」就能把它收进产物库。"],
                  [
                    h("button", {
                      key: "tryext", type: "button", className: NS + "__btn " + NS + "__btn--primary",
                      onClick: function () { setQuery("ext:md"); runSearch("ext:md"); },
                    }, "试一下 ext:md"),
                  ], "empty")))
        );
      }

      return h("div", null, head, body);
    }

    /**
     * 「本轮改动」视图（P1）。
     *
     * 用户原话：「最怕的就是一句**『已经帮你改好了。』到底改了什么却看不出来**」。
     *
     * 数据来自宿主端点 `/ext/artifacts/session-changes`（形状与官方 `api/changes.summary` 对齐，
     * 见 `sessionChangesUrl` 的说明）。**渐进增强**：
     *   - 端点就绪 → 逐文件列出 path + 增删行数，点击即定位（复用 `files/reveal`，已过 assertInScope）；
     *   - 端点未就绪（404/503）→ 明确状态 + 一键退回「本会话」产物视图；
     *   - 无论哪种情况都**不空面板、不抛错**。
     */
    function ChangesView(props) {
      var React = require("react");
      var h = React.createElement;

      var sPhase = React.useState("loading");   // loading | ready | quiet | error
      var phase = sPhase[0];
      var setPhase = sPhase[1];

      var sRows = React.useState([]);
      var rows = sRows[0];
      var setRows = sRows[1];

      var sMeta = React.useState(null);
      var meta = sMeta[0];
      var setMeta = sMeta[1];

      var sError = React.useState("");
      var error = sError[0];
      var setError = sError[1];

      var sReload = React.useState(0);
      var reloadToken = sReload[0];
      var setReloadToken = sReload[1];

      var notify = typeof props.onToast === "function" ? props.onToast : function () {};
      // 注：**不用** props.sessionId —— 宿主机没有「用户正在看哪个会话」的概念，
      // root 作用域的面板也拿不到 sessionId+seq，所以固定走 `?recent=1`（响应带 derived:true）。

      React.useEffect(function () {
        var alive = true;
        setPhase("loading");
        // 只用 recent=1：宿主机没有「用户正在看哪个会话」这个概念，root 面板也拿不到 sessionId+seq。
        apiGet(sessionChangesUrl("", "", true))
          .then(function (payload) {
            if (!alive) return;
            setRows(normalizeChanges(payload));
            setMeta({
              sessionId: payload && payload.sessionId ? String(payload.sessionId) : "",
              seq: payload && payload.seq !== undefined && payload.seq !== null ? payload.seq : "",
              derived: !!(payload && payload.derived),
              announcedAt: payload && payload.announcedAt ? Number(payload.announcedAt) : 0,
              total: payload && isFinite(Number(payload.total)) ? Number(payload.total) : 0,
            });
            setPhase("ready");
          })
          .catch(function (err) {
            if (!alive) return;
            var message = err && err.message ? String(err.message) : String(err);
            setError(message);
            // host-dev 的语义：404(nothing-observed / not-found) = 还没有公告过 → **静默**处理，
            // 不是错误（插件启动后必须真跑过一轮会改文件的对话才有数据）。
            if (message.indexOf("404") >= 0) setPhase("quiet");
            else if (message.indexOf("400") >= 0) setPhase("quiet");   // 坐标语义不符也按无事发生
            else setPhase("error");                                      // 503 / 网络 → 才值得说
          });
        return function () { alive = false; };
      }, [reloadToken]);

      /** 在资源管理器中定位（复用既有端点，能复用就不新开） */
      function locate(row) {
        notify("定位中…");
        apiSend("/files/reveal?path=" + encodeURIComponent(row.path), "POST")
          .then(function () { notify("已在资源管理器中定位"); })
          .catch(function (err) { notify("定位失败：" + (err && err.message ? err.message : String(err))); });
      }

      var body;
      if (phase === "loading") {
        body = SkeletonRows(h, 4);
      } else if (phase === "quiet") {
        // host-dev 语义：404(nothing-observed / not-found) = 还没观察到公告 → **静默**，
        // 不弹错、不吓人；这里只留一句说明，不占主内容。
        body = StateBlock(h, STATE_ICON_FOLDER, "还没有观察到文件改动",
          ["插件启动后需要真的跑过一轮会改文件的对话，宿主才会记录改动公告"],
          [h("button", {
            key: "fallback", type: "button", className: NS + "__btn",
            onClick: function () { if (typeof props.onFallback === "function") props.onFallback(); },
          }, "看本会话产物")],
          "quiet");
      } else if (phase === "error") {
        body = StateBlock(h, STATE_ICON_ALERT, "读取最近改动失败：" + error,
          ["若宿主刚重启过，稍后重试一次"], [
            h("button", {
              key: "retry", type: "button", className: NS + "__btn",
              onClick: function () { setReloadToken(reloadToken + 1); },
            }, "重试"),
          ], "err");
      } else if (!rows.length) {
        body = StateBlock(h, STATE_ICON_FOLDER, "这次公告里没有文件改动",
          [meta && meta.sessionId ? "会话 " + String(meta.sessionId).slice(0, 8) : "宿主返回了空列表"],
          null, "none");
      } else {
        body = h("div", { className: NS + "__flist", role: "grid", "aria-label": "最近改动" },
          rows.map(function (row, i) {
            return h("div", {
              key: String(row.index) + ":" + String(i),
              className: NS + "__frow",
              role: "row",
              "aria-rowindex": String(i + 1),
              "aria-label": row.path,
              title: row.path,
              onClick: function () { locate(row); },
            },
              h("span", { role: "gridcell" }, IconView(h, iconOf(row.path, false), "ico")),
              h("span", { className: NS + "__chgmain", role: "gridcell" },
                NameText(h, row.name || row.display, NS + "__fname", "nm"),
                h("span", { className: NS + "__fdir" }, row.dir)),
              h("span", { className: NS + "__dsize", role: "gridcell" },
                row.binary ? h("span", { className: NS + "__meta" }, "二进制")
                  : (row.oversized ? h("span", { className: NS + "__meta" }, "超大")
                    : h("span", { className: NS + "__chgadd" }, "+" + String(row.added)))),
              h("span", { className: NS + "__dtime", role: "gridcell" },
                (row.binary || row.oversized) ? h("span", { className: NS + "__meta" }, "—")
                  : h("span", { className: NS + "__chgdel" }, "-" + String(row.deleted))),
              h("span", { className: NS + "__dact", role: "gridcell" },
                RowAction(h, "在资源管理器中定位", ACT_ICON_REVEAL, function (event) {
                  event.stopPropagation();
                  locate(row);
                }))
            );
          }));
      }

      return h("div", null,
        h("div", { className: NS + "__bar" },
          // ⚠️ 措辞约束：这些数据来自宿主的「最近一次公告」，**不是「当前会话」**
          //    （宿主机没有「用户正在看哪个会话」的概念）→ 只许说「最近改动 · 会话 <短id>」。
          h("span", { className: NS + "__meta" }, "最近改动 · " + String(rows.length) + " 个文件"),
          meta && meta.sessionId ? h("span", { className: NS + "__meta" }, "会话 " + String(meta.sessionId).slice(0, 8)) : null,
          meta && meta.derived ? h("span", { className: NS + "__meta" }, "宿主自取最近公告") : null,
          h("span", { className: NS + "__grow", style: { flex: "1" } }),
          h("button", {
            type: "button", className: NS + "__btn", "aria-label": "刷新最近改动",
            onClick: function () { setReloadToken(reloadToken + 1); },
          }, "刷新")
        ),
        body);
    }

    /**
     * 设置面板（面板内页面，不占宿主 `settings.section` 席位）。
     *
     * **为什么放面板内**：我们 11 个「客户端生效」的键全是**本体渲染**（行高/列/缩略图/画廊/虚拟滚动…），
     * 放到宿主全局设置页里，用户改完当场看不见变化（面板在另一个 tab）。
     * 原则：**设置项的作用域要和它的效果在同一个可见区域。**
     *
     * 三条硬约定：
     *  1. **结构全部从 `GET /settings/schema` 读**（defaults/enums/ranges/booleans/appearanceKeys/hostEffectiveKeys/presets）
     *     —— 后端加键改范围，这里自动跟上，不写死。
     *  2. **不做乐观更新**：每次 `PUT` 之后用宿主返回值/重读结果回显（失败时 UI 不会停在与实际不一致的状态）。
     *  3. **预设不自己套用**：`PUT {preset}` 由宿主展开起点值，这里只渲染返回值；
     *     `preset === 'custom'` 就显示「自定义（基于…）」—— 状态由宿主维护，我们不重复维护。
     */
    function SettingsPanel(props) {
      var React = require("react");
      var h = React.createElement;

      var sSchema = React.useState(null);
      var schema = sSchema[0];
      var setSchema = sSchema[1];

      var sValues = React.useState(null);
      var values = sValues[0];
      var setValues = sValues[1];

      var sPhase = React.useState("loading");   // loading | ready | error
      var phase = sPhase[0];
      var setPhase = sPhase[1];

      var sError = React.useState("");
      var error = sError[0];
      var setError = sError[1];

      var sBusy = React.useState("");
      var busy = sBusy[0];
      var setBusy = sBusy[1];

      /** 导入结果：{applied, ignored, errors} 或 null（**如实展示三类清单**，不是一句「成功」）。 */
      var sImport = React.useState(null);
      var importReport = sImport[0];
      var setImportReport = sImport[1];

      /** 撤销栈（只存最近一次改动前的快照）。 */
      var sUndo = React.useState(null);
      var undoValues = sUndo[0];
      var setUndoValues = sUndo[1];

      /** 「另存为我的预设」输入值（null = 没在输入）。 */
      var sNewName = React.useState(null);
      var newName = sNewName[0];
      var setNewName = sNewName[1];

      /** 待确认删除的自定义预设名（两步确认：删配置比删文件更让人心疼）。 */
      var sConfirmDel = React.useState("");
      var confirmDel = sConfirmDel[0];
      var setConfirmDel = sConfirmDel[1];

      var notify = typeof props.onToast === "function" ? props.onToast : function () {};

      React.useEffect(function () {
        var alive = true;
        setPhase("loading");
        Promise.all([apiGet("/settings/schema"), apiGet("/settings")])
          .then(function (both) {
            if (!alive) return;
            setSchema(both[0] || null);
            setValues(both[1] && typeof both[1] === "object" ? both[1] : {});
            setPhase("ready");
          })
          .catch(function (err) {
            if (!alive) return;
            setError(err && err.message ? String(err.message) : String(err));
            setPhase("error");
          });
        return function () { alive = false; };
      }, []);

      /** 写设置：**先 PUT、再用宿主返回的值回显**（不乐观更新）。 */
      function put(patch, note) {
        setBusy(note || "保存中…");
        var before = values;
        apiSend("/settings", "PUT", patch)
          .then(function (latest) {
            setValues(latest && typeof latest === "object" ? latest : values);
            if (before) setUndoValues(before);
            notify(note ? note + " 已保存" : "已保存");
          })
          .catch(function (err) {
            // 失败时**重读**一次，保证 UI 与实际一致（被拒的键宿主保持原值）
            notify("保存失败：" + (err && err.message ? err.message : String(err)));
            apiGet("/settings").then(function (latest) {
              if (latest && typeof latest === "object") setValues(latest);
            }).catch(function () { /* 忽略 */ });
          })
          .then(function () { setBusy(""); });
      }

      /** 撤销：把上一次改动前的快照整体写回。 */
      function undo() {
        if (!undoValues) return;
        var target = undoValues;
        setUndoValues(null);
        setBusy("撤销中…");
        apiSend("/settings", "PUT", target)
          .then(function (latest) { setValues(latest && typeof latest === "object" ? latest : target); notify("已撤销上一次改动"); })
          .catch(function (err) { notify("撤销失败：" + (err && err.message ? err.message : String(err))); })
          .then(function () { setBusy(""); });
      }

      /** 恢复默认：把 schema 里的 defaults 整包写回。 */
      function resetDefaults() {
        if (!schema || !schema.defaults) return;
        put(schema.defaults, "恢复默认");
      }

      // ── 自定义预设（task-9 §2 的「不写死」落点）──────────────────────────
      /** 名字规则与宿主一致：`/^[A-Za-z0-9_-]{1,32}$/`。 */
      var PRESET_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

      /** 现有自定义预设：{ 名字: Partial<外观键> }。 */
      function customMap() {
        var raw = values && values.customPresets;
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      }
      /** 内置预设 id 集合（来自 schema.presets，不写死）。 */
      function builtinIds() {
        return (schema && Array.isArray(schema.presets) ? schema.presets : []).map(function (p) { return p.id; });
      }
      /**
       * **从当前状态派生的值包**（用户调到满意的样子直接存下来）。
       * 只取 schema 里的 `appearanceKeys` —— 与宿主对自定义预设的校验口径一致
       * （自定义预设只存外观键，这样它才能参与「切预设 = 应用一组外观」）。
       */
      function appearanceSnapshot() {
        var keys = schema && Array.isArray(schema.appearanceKeys) ? schema.appearanceKeys : [];
        var snapshot = {};
        keys.forEach(function (key) {
          if (values && Object.prototype.hasOwnProperty.call(values, key)) snapshot[key] = values[key];
        });
        return snapshot;
      }
      /** 另存为我的预设（名字校验在本地先做一遍，宿主再校验一次）。 */
      function saveAsPreset() {
        var name = String(newName || "").trim();
        if (!PRESET_NAME_RE.test(name)) {
          notify("预设名只能用字母/数字/_/-，长度 1~32");
          return;
        }
        if (builtinIds().indexOf(name) >= 0) {
          notify("「" + name + "」是内置预设名，换一个");
          return;
        }
        var next = {};
        var current = customMap();
        for (var k in current) if (Object.prototype.hasOwnProperty.call(current, k)) next[k] = current[k];
        next[name] = appearanceSnapshot();
        putPresets(next, "已另存为我的预设「" + name + "」");
        setNewName(null);
      }
      /** 删除自定义预设（两步确认；删错了还能用上面的「撤销」写回）。 */
      function deletePreset(name) {
        var next = {};
        var current = customMap();
        for (var k in current) {
          if (Object.prototype.hasOwnProperty.call(current, k) && k !== name) next[k] = current[k];
        }
        setConfirmDel("");
        putPresets(next, "已删除我的预设「" + name + "」");
      }
      /** 写 customPresets（整包覆盖：宿主的合并口径是「按出现键覆盖」）。 */
      function putPresets(map, note) {
        put(tagOf("customPresets", map), note);
      }
      /** 当前预设是自定义的哪一个（用于显示「基于…」）。 */
      function currentCustomName() {
        var id = values && values.preset ? String(values.preset) : "";
        return Object.prototype.hasOwnProperty.call(customMap(), id) ? id : "";
      }

      /** 导出：取导出载荷 → 下载成 JSON 文件。 */
      function exportSettings() {
        setBusy("导出中…");
        apiGet("/settings/export")
          .then(function (payload) {
            var text = JSON.stringify(payload, null, 2);
            try {
              var blob = new Blob([text], { type: "application/json" });
              var url = URL.createObjectURL(blob);
              var a = document.createElement("a");
              a.href = url;
              a.download = "dsh-artifact-library-settings.json";
              if (document.body) document.body.appendChild(a);
              a.click();
              if (a.remove) a.remove();
              URL.revokeObjectURL(url);
              notify("设置已导出");
            } catch (error) {
              notify("导出失败：" + (error && error.message ? error.message : String(error)));
            }
          })
          .catch(function (err) { notify("导出失败：" + (err && err.message ? err.message : String(err))); })
          .then(function () { setBusy(""); });
      }

      /** 导入：读文件 → POST → **展示 applied / ignored / errors 三类清单**。 */
      function importFile(file) {
        if (!file) return;
        setBusy("导入中…");
        setImportReport(null);
        var reader = new FileReader();
        reader.onload = function () {
          var payload;
          try {
            payload = JSON.parse(String(reader.result || ""));
          } catch (error) {
            setBusy("");
            setImportReport({ applied: [], ignored: [], errors: [{ key: "(文件)", reason: "不是合法 JSON" }] });
            return;
          }
          apiSend("/settings/import", "POST", payload)
            .then(function (result) {
              var report = {
                applied: Array.isArray(result && result.applied) ? result.applied : [],
                ignored: Array.isArray(result && result.ignored) ? result.ignored : [],
                errors: Array.isArray(result && result.errors) ? result.errors : [],
              };
              setImportReport(report);
              if (result && result.settings && typeof result.settings === "object") setValues(result.settings);
              notify("导入完成：生效 " + String(report.applied.length) + " 项");
            })
            .catch(function (err) {
              // 400 时宿主给了 errors[]；把它透出来（别吞成「导入失败」四个字）
              setImportReport({ applied: [], ignored: [], errors: [{ key: "(请求)", reason: err && err.message ? String(err.message) : String(err) }] });
            })
            .then(function () { setBusy(""); });
        };
        reader.onerror = function () {
          setBusy("");
          setImportReport({ applied: [], ignored: [], errors: [{ key: "(文件)", reason: "读取失败" }] });
        };
        reader.readAsText(file);
      }

      // ── 控件（形态由 schema 推导）────────────────────────────────────────
      function controlFor(key, value, kind) {
        var disabled = !!busy;
        if (kind === "boolean") {
          return h("input", {
            type: "checkbox", className: NS + "__switch", checked: !!value, disabled: disabled,
            "aria-label": settingText(key).label,
            onChange: function (event) { put(tagOf(key, event.target.checked), null); },
          });
        }
        if (kind === "enum") {
          return h("select", {
            className: NS + "__select", value: String(value), disabled: disabled,
            "aria-label": settingText(key).label,
            onChange: function (event) { put(tagOf(key, event.target.value), null); },
          }, (schema.enums[key] || []).map(function (option) {
            return h("option", { key: "o" + String(option), value: String(option) }, String(option));
          }));
        }
        if (kind === "range") {
          var range = schema.ranges[key] || [];
          return h("input", {
            className: NS + "__input " + NS + "__input--num", type: "number", disabled: disabled,
            value: value === null || value === undefined ? "" : String(value),
            min: String(range[0]), max: String(range[1]), step: "1",
            "aria-label": settingText(key).label,
            onChange: function (event) {
              var raw = event.target.value;
              if (raw === "") { put(tagOf(key, key === "panelWidth" ? null : Number(range[0])), null); return; }
              put(tagOf(key, Number(raw)), null);
            },
          });
        }
        if (kind === "lines") {
          var lines = Array.isArray(value) ? value.join("\n") : "";
          return h("textarea", {
            className: NS + "__input " + NS + "__input--lines", rows: 3, disabled: disabled,
            value: lines, "aria-label": settingText(key).label,
            placeholder: "C:\\path\\one\nD:\\path\\two",
            onChange: function (event) {
              var list = String(event.target.value).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
              put(tagOf(key, list), null);
            },
          });
        }
        if (kind === "object") {
          // columns：逐键开关（键从**当前值**来，不写死）
          if (key === "columns") {
            var colKeys = [];
            var source = value && typeof value === "object" ? value : (schema.defaults && schema.defaults.columns) || {};
            for (var ck in source) if (Object.prototype.hasOwnProperty.call(source, ck)) colKeys.push(ck);
            return h("span", { className: NS + "__setcols" }, colKeys.map(function (col) {
              return h("label", { className: NS + "__setcol", key: "col" + col },
                h("input", {
                  type: "checkbox", className: NS + "__switch", checked: !!(value && value[col]), disabled: disabled,
                  onChange: function (event) {
                    var next = {};
                    for (var k in value) if (Object.prototype.hasOwnProperty.call(value, k)) next[k] = value[k];
                    next[col] = !!event.target.checked;
                    put(tagOf("columns", next), null);
                  },
                }),
                COLUMN_LABELS[col] || col);
            }));
          }
          // customPresets：不在键行里编辑（这一行的控件是给「我的预设」区用的）
          return h("span", { className: NS + "__setval" }, settingValueText(value));
        }
        return h("span", { className: NS + "__setval" }, settingValueText(value));
      }

      /** 只对「外观类」键做 PUT（其余键同理，但标签更直白）。 */
      function tagOf(key, value) {
        var patch = {};
        patch[key] = value;
        return patch;
      }

      var body;
      if (phase === "loading") {
        body = SkeletonRows(h, 4);
      } else if (phase === "error") {
        body = StateBlock(h, STATE_ICON_ALERT, "设置读取失败：" + error,
          ["若宿主刚重启过，稍后重试一次"], null, "seterr");
      } else {
        var hostKeys = (schema && Array.isArray(schema.hostEffectiveKeys)) ? schema.hostEffectiveKeys : [];
        var defaults = (schema && schema.defaults) || {};
        var keys = [];
        for (var dk in defaults) if (Object.prototype.hasOwnProperty.call(defaults, dk)) keys.push(dk);
        var groups = [
          { key: "appearance", title: "显示与浏览", hint: "改完当场生效（这些是渲染侧设置，宿主只负责存取）", list: keys.filter(function (k) { return hostKeys.indexOf(k) < 0; }) },
          { key: "host", title: "宿主行为", hint: "会真的改变后端行为：页大小、隐藏项过滤、缩略图大小上限、索引范围", list: keys.filter(function (k) { return hostKeys.indexOf(k) >= 0; }) },
        ];

        var presetNode = null;
        if (schema && Array.isArray(schema.presets) && schema.presets.length) {
          var current = values && values.preset ? String(values.preset) : "";
          var known = schema.presets.some(function (p) { return p.id === current; });
          var customs = customMap();
          var customNames = [];
          for (var cn in customs) if (Object.prototype.hasOwnProperty.call(customs, cn)) customNames.push(cn);
          customNames.sort();
          var isCustomCurrent = customNames.indexOf(current) >= 0;
          var currentLabel = known
            ? (schema.presets.filter(function (p) { return p.id === current; })[0] || {}).label
            : current;
          presetNode = h("div", { className: NS + "__setgroup" },
            h("div", { className: NS + "__setgh" }, "预设",
              current === "custom"
                ? h("em", { className: NS + "__sethint" }, "自定义（基于 " + String(currentLabel || "预设") + "）—— 你已偏离预设，切预设会整体重置那一包")
                : h("em", { className: NS + "__sethint" }, "当前：" + String(currentLabel || "—"))),
            h("div", { className: NS + "__setrow" },
              h("select", {
                className: NS + "__select",
                value: (known || isCustomCurrent) ? current : "custom",
                disabled: !!busy,
                "aria-label": "预设",
                onChange: function (event) { setConfirmDel(""); put(tagOf("preset", event.target.value), "切换预设"); },
              }, schema.presets.map(function (p) {
                return h("option", { key: "p" + p.id, value: p.id, title: p.hint || "" }, p.label || p.id);
              })
                // ★ 自定义预设**真的进下拉**（否则「有这项但选不到」）
                .concat(customNames.map(function (name) {
                  return h("option", { key: "cp" + name, value: name, title: "我的预设" }, "我的：" + name);
                }))
                .concat((known || isCustomCurrent) ? [] : [h("option", { key: "pcustom", value: "custom" }, "自定义")])),
              h("span", { className: NS + "__sethint" }, "预设是**起点值包**，选完每一项仍可单独微调；微调后宿主会自动标成自定义，已应用的值不会丢。")),
            h("div", { className: NS + "__setrow" },
              schema.presets.map(function (p) {
                return h("button", {
                  key: "pb" + p.id, type: "button", className: NS + "__btn", disabled: !!busy,
                  title: p.hint || "", onClick: function () { setConfirmDel(""); put(tagOf("preset", p.id), "切换预设 " + (p.label || p.id)); },
                }, p.label || p.id);
              })),
            // ── 我的预设（从当前状态派生；不要求用户从零填 15 个键）──────────
            h("div", { className: NS + "__setrow" },
              h("span", { className: NS + "__setlabel" },
                "我的预设",
                h("em", { className: NS + "__sethint" }, "把你现在这套外观设置存成一个命名预设（只存外观键，和宿主的校验口径一致）。存完会出现在上面的下拉里。")),
              h("span", { className: NS + "__setctl" },
                newName === null
                  ? h("button", {
                    type: "button", className: NS + "__btn " + NS + "__btn--primary", disabled: !!busy,
                    "aria-label": "另存为我的预设",
                    onClick: function () { setNewName(""); },
                  }, "另存为我的预设…")
                  : h("span", { className: NS + "__pathedit" },
                    h("input", {
                      className: NS + "__input", type: "text", value: newName, autoFocus: true,
                      "aria-label": "预设名", placeholder: "名字（字母/数字/_/-，≤32）", maxLength: 32,
                      onChange: function (event) { setNewName(event.target.value); },
                      onKeyDown: function (event) {
                        if (event.key === "Enter") { event.preventDefault(); saveAsPreset(); }
                        else if (event.key === "Escape") { event.stopPropagation(); setNewName(null); }
                      },
                    }),
                    h("button", { type: "button", className: NS + "__btn " + NS + "__btn--primary", disabled: !!busy, "aria-label": "保存预设", onClick: saveAsPreset }, "保存"),
                    h("button", { type: "button", className: NS + "__btn", onClick: function () { setNewName(null); } }, "取消"))),
            ),
            customNames.length
              ? h("div", { className: NS + "__setrow" },
                h("span", { className: NS + "__setlabel" }, "已保存 " + String(customNames.length) + " 个"),
                h("span", { className: NS + "__setctl " + NS + "__setcols" }, customNames.map(function (name) {
                  return h("span", { className: NS + "__setcol", key: "mine" + name },
                    h("button", {
                      type: "button", className: NS + "__btn", disabled: !!busy,
                      "aria-label": "切换到我的预设 " + name,
                      onClick: function () { put(tagOf("preset", name), "切换到我的预设 " + name); },
                    }, name),
                    confirmDel === name
                      // 两步确认：删配置比删文件更让人心疼
                      ? h("span", null,
                        h("button", {
                          type: "button", className: NS + "__btn " + NS + "__btn--danger", disabled: !!busy,
                          "aria-label": "确认删除预设 " + name,
                          onClick: function () { deletePreset(name); },
                        }, "确认删除"),
                        h("button", { type: "button", className: NS + "__btn", onClick: function () { setConfirmDel(""); } }, "算了"))
                      : h("button", {
                        type: "button", className: NS + "__btn", disabled: !!busy,
                        "aria-label": "删除我的预设 " + name,
                        onClick: function () { setConfirmDel(name); },
                      }, "删除"));
                })),
                h("span", { className: NS + "__sethint" }, "删错了可以点上面的「撤销」写回（我把删除前的整份设置留着了）。"))
              : null);
        }

        body = h("div", { className: NS + "__setpage" },
          h("div", { className: NS + "__setbar" },
            h("span", { className: NS + "__meta" }, busy || (values && values.preset ? "预设：" + String(values.preset) : "设置")),
            h("span", { className: NS + "__grow", style: { flex: "1" } }),
            h("button", { type: "button", className: NS + "__btn", disabled: !undoValues || !!busy, "aria-label": "撤销上一次改动", onClick: undo }, "撤销"),
            h("button", { type: "button", className: NS + "__btn", disabled: !!busy, "aria-label": "恢复默认", onClick: resetDefaults }, "恢复默认"),
            h("button", { type: "button", className: NS + "__btn", "aria-label": "导出设置", disabled: !!busy, onClick: exportSettings }, "导出"),
            h("label", { className: NS + "__btn", title: "导入设置 JSON" },
              "导入",
              h("input", {
                type: "file", accept: "application/json,.json", className: NS + "__setfile",
                "aria-label": "导入设置",
                onChange: function (event) {
                  var file = event.target.files && event.target.files[0];
                  importFile(file);
                  event.target.value = "";
                },
              })),
            h("button", { type: "button", className: NS + "__btn", "aria-label": "返回产物库", onClick: function () { if (typeof props.onClose === "function") props.onClose(); } }, "返回")),
          presetNode,
          importReport ? h("div", { className: NS + "__setreport" },
            h("div", { className: NS + "__setrh" }, "导入结果"),
            h("div", null, "生效 " + String(importReport.applied.length) + " 项：" + (importReport.applied.join("、") || "—")),
            h("div", { className: NS + "__sethint" }, "忽略 " + String(importReport.ignored.length) + " 项：" + (importReport.ignored.join("、") || "—")),
            importReport.errors.length
              ? h("div", { className: NS + "__setrerr" }, "被拒 " + String(importReport.errors.length) + " 项：" +
                importReport.errors.map(function (e) { return String((e && e.key) || "?") + "（" + String((e && e.reason) || "") + "）"; }).join("；"))
              : null) : null,
          groups.map(function (group) {
            return h("div", { className: NS + "__setgroup", key: group.key },
              h("div", { className: NS + "__setgh" }, group.title, h("em", { className: NS + "__sethint" }, group.hint)),
              group.list.map(function (key) {
                var text = settingText(key);
                var kind = settingKind(schema, key);
                return h("div", { className: NS + "__setrow", key: "s" + key },
                  h("span", { className: NS + "__setlabel" },
                    text.label,
                    text.hint ? h("em", { className: NS + "__sethint" }, text.hint) : null),
                  h("span", { className: NS + "__setctl" }, controlFor(key, values ? values[key] : undefined, kind)),
                  h("span", { className: NS + "__setval" }, settingValueText(values ? values[key] : undefined)));
              }));
          }));
      }

      return h("div", { className: NS + "__setwrap" }, body);
    }

    /**
     * 画廊视图（`defaultView: 'gallery'` 的目标形态，面向内容创作者）。
     *
     * 与卡片视图的分工：**卡片 = 产物卡片**（标题/摘要/标签，看「这是什么」），
     * **画廊 = 文件缩略图墙**（谁的图好看，看「长什么样」）。受众不同，所以是新视图而不是改写卡片。
     *
     * 三条硬约束（lead 定）：
     *  1. **虚拟滚动必须覆盖画廊**：每屏项目少、单块更贵 → 用**更低**的阈值（60），不复用列表的 200。
     *  2. **`galleryThumbSize` 真的生效**（不是只存值）—— 直接进栅格与方块尺寸。
     *  3. **onError 回退**：坏图退成「类型图标 + 文件名」的方块，不留空洞。
     */
    function GalleryBrowser(props) {
      var React = require("react");
      var h = React.createElement;

      /** 当前目录（空 = 范围根，由宿主决定）。 */
      var sPath = React.useState("");
      var path = sPath[0];
      var setPath = sPath[1];

      var sEntries = React.useState([]);
      var entries = sEntries[0];
      var setEntries = sEntries[1];

      var sPhase = React.useState("loading");
      var phase = sPhase[0];
      var setPhase = sPhase[1];

      var sError = React.useState("");
      var error = sError[0];
      var setError = sError[1];

      var sReload = React.useState(0);
      var reloadToken = sReload[0];
      var setReloadToken = sReload[1];

      var notify = typeof props.onToast === "function" ? props.onToast : function () {};

      /** 先问一次范围根：画廊要有具体目录才好看（空路径时先落到第一个根）。 */
      React.useEffect(function () {
        var alive = true;
        apiGet("/files/status")
          .then(function (status) {
            if (!alive) return;
            var roots = status && Array.isArray(status.roots) ? status.roots : [];
            if (roots.length && !path) setPath(String(roots[0].path || roots[0]));
          })
          .catch(function () { /* 拿不到根就按空路径请求，宿主会给默认 */ });
        return function () { alive = false; };
      }, []);

      /** 取当前目录内容（与目录视图同一端点，所以「索引没起也能用」这条同样成立）。 */
      React.useEffect(function () {
        var alive = true;
        setPhase("loading");
        var url = "/files/list" + (path ? "?dir=" + encodeURIComponent(path) : "");
        apiGet(url)
          .then(function (res) {
            if (!alive) return;
            setEntries(res && Array.isArray(res.entries) ? res.entries : []);
            setPhase("ready");
          })
          .catch(function (err) {
            if (!alive) return;
            setError(err && err.message ? String(err.message) : String(err));
            setPhase("error");
          });
        return function () { alive = false; };
      }, [path, reloadToken]);

      var sThumbFailed = React.useState({});
      var thumbFailed = sThumbFailed[0];
      var setThumbFailed = sThumbFailed[1];

      var sScroll = React.useState({ top: 0, height: 0 });
      var scrollState = sScroll[0];
      var setScrollState = sScroll[1];

      var gridRef = React.useRef(null);
      var prefs = props.settings && typeof props.settings === "object" ? props.settings : {};
      var size = isFinite(Number(prefs.galleryThumbSize)) ? Number(prefs.galleryThumbSize) : 96;
      var showThumbs = prefs.thumbnails !== false;
      var threshold = isFinite(Number(prefs.virtualThreshold)) ? Number(prefs.virtualThreshold) : VIRTUAL_THRESHOLD;
      // 画廊用自己的阈值：设置里的 virtualThreshold 若比它更小（更激进）就听设置的
      var gate = Math.min(threshold === 0 ? 0 : threshold, GALLERY_VIRTUAL_THRESHOLD);

      /** 缩略图失败分两级（与目录视图同一套语义）：undefined → primary → fallback → "1"(图标终态)。 */
      function markFailed(key) {
        setThumbFailed(function (previous) {
          var stage = previous[key];
          var next = {};
          for (var k in previous) if (Object.prototype.hasOwnProperty.call(previous, k)) next[k] = previous[k];
          next[key] = stage ? "1" : "primary";
          return next;
        });
      }

      /** 滚进视口时记一下位置（虚拟滚动只渲染窗口内）。 */
      function onScroll(event) {
        var node = event.currentTarget;
        setScrollState({ top: node.scrollTop, height: node.clientHeight });
      }

      var items = entries.filter(function (row) { return !!row; });
      var virtual = gate === 0 ? items.length > 0 : items.length > gate;

      // 方块边长 = 缩略图 + 内边距 + 文件名两行的高度
      var cellPx = size + 46;
      var viewport = scrollState.height || VIRTUAL_VIEWPORT_FALLBACK;
      var perRow = 0;
      try {
        var width = (gridRef.current && gridRef.current.clientWidth) || 720;
        perRow = Math.max(1, Math.floor((width + 12) / (cellPx + 12)));
      } catch (error) { perRow = 6; }
      var rowPx = cellPx + 12;
      var startIndex = 0;
      var endIndex = items.length;
      if (virtual) {
        var firstRow = Math.max(0, Math.floor(scrollState.top / rowPx) - 1);
        var rowCount = Math.ceil(viewport / rowPx) + 2;
        startIndex = Math.max(0, firstRow * perRow);
        endIndex = Math.min(items.length, (firstRow + rowCount) * perRow);
      }
      var visible = items.slice(startIndex, endIndex);

      var cells = visible.map(function (row, j) {
        var index = startIndex + j;
        var isDir = !!row.isDirectory;
        var stage = thumbFailed[row.path];
        var src = "";
        if (!isDir && showThumbs && stage !== "1") {
          var urls = thumbUrlsFor(row);
          if (urls) src = stage ? (urls.fallback || "") : urls.primary;
        }
        return h("figure", {
          key: row.path + "#" + String(index),
          className: NS + "__gcell",
          "data-index": String(index),
          "data-dir": isDir ? "1" : "0",
          style: { width: String(cellPx) + "px" },
          title: row.path,
          onClick: isDir ? function () { setPath(String(row.path)); } : undefined,
        },
          h("div", {
            className: NS + "__gbox",
            style: { width: String(cellPx) + "px", height: String(cellPx - 46 + 46) + "px" },
          },
            src
              ? h("img", {
                className: NS + "__gimg",
                src: src,
                alt: "",
                loading: "lazy",
                style: { width: String(size) + "px", height: String(size) + "px" },
                onError: function () { markFailed(row.path); },
              })
              // 坏图 / 非图片 → 类型图标方块（不留空洞）
              : h("span", { className: NS + "__gicon" }, IconView(h, iconOf(row.name || row.path, false), "ico"))),
          h("figcaption", { className: NS + "__gcap" }, NameText(h, row.name || row.path, NS + "__gname", "gn"))
        );
      });

      return h("div", { className: NS + "__gwrap" },
        h("div", { className: NS + "__gbar" },
          h("button", {
            type: "button", className: NS + "__btn", "aria-label": "上一级",
            onClick: function () {
              var parent = splitPathParts(path).dir.replace(/[\\/]+$/, "");
              setPath(parent);
            },
          }, "↑ 上一级"),
          h("input", {
            className: NS + "__input", type: "text", value: path, "aria-label": "当前目录",
            onChange: function (event) { setPath(event.target.value); },
            onKeyDown: function (event) { if (event.key === "Enter") setReloadToken(reloadToken + 1); },
          }),
          h("button", {
            type: "button", className: NS + "__btn", "aria-label": "刷新",
            onClick: function () { setReloadToken(reloadToken + 1); },
          }, "刷新"),
          h("span", { className: NS + "__meta" }, items.length ? String(items.length) + " 项" : "")),
        phase === "loading" ? SkeletonRows(h, 3)
          : (phase === "error" ? StateBlock(h, STATE_ICON_ALERT, "读取失败：" + error, ["检查路径是否存在、是否在允许范围内"], null, "galerr")
            : h("div", {
              className: NS + "__gallery",
              ref: gridRef,
              onScroll: onScroll,
              role: "grid",
              "aria-label": "画廊",
              "aria-rowcount": String(items.length),
              "aria-colcount": String(perRow || 1),
            },
              virtual
                ? h("div", { style: { paddingTop: String(Math.floor(startIndex / perRow) * rowPx) + "px" } }, cells)
                : cells,
              items.length ? null : StateBlock(h, STATE_ICON_FOLDER, "这个目录是空的", null, null, "galempty"))));
    }

    // ── 统一「视图控制」（task-11 架构选择 A）────────────────────────────────
    /**
     * 一套控件，两处共用：**产物列表**与**目录**都用它决定「怎么呈现」。
     *
     * 为什么统一（而不是各写一套）：③ 要的「可选哪些列 / 卡片大中小」在两侧**是同一个概念**；
     * 各写一份会让 `columns` 这一个设置键长出两个消费点 —— 而「两处各写一份、一处忘了接」
     * 正是 `indexExtraDirs` 那个坑的原形。
     *
     * 状态**不在这个组件里**：它是纯展示（值 + 回调），状态由各自宿主持有
     * （产物侧直接读/写 `settings`，目录侧一个本地覆盖 + `settings`）——
     * 统一的是**控件与语义**，不是状态，所以不会引入新的同步问题。
     *
     * 唯一例外：列选择浮层的开合状态必须有个地方放，就放在这里（**组件内部唯一一个 hook**）。
     *
     * @param props.view / onView          卡片 | 列表 | 画廊
     * @param props.density / onDensity    紧凑 | 标准 | 宽松（不给 onDensity 就不显示）
     * @param props.cardSize / onCardSize  小 | 中 | 大
     * @param props.columns / onColumns    { size, time, type }（name 恒显示，不可关）
     * @param props.label                  无障碍前缀（如「目录」/「产物」），避免两个工具栏的控件同名
     */
    var CARD_SIZES = [
      { key: "sm", label: "小", px: 48 },
      { key: "md", label: "中", px: 96 },
      { key: "lg", label: "大", px: 160 },
    ];

    /** 卡片尺寸档位 ↔ 缩略图边长（尺寸真正的落点是 `galleryThumbSize`，不新造设置键）。 */
    function cardSizePx(key) {
      var found = CARD_SIZES.filter(function (item) { return item.key === key; })[0];
      return found ? found.px : CARD_SIZES[1].px;
    }
    /** 由缩略图边长反推最接近的档位（设置里存的是像素，UI 上是三档）。 */
    function cardSizeKeyFromPx(px) {
      var n = Number(px);
      if (!isFinite(n)) return "md";
      var best = CARD_SIZES[1];
      var bestGap = Infinity;
      CARD_SIZES.forEach(function (item) {
        var gap = Math.abs(item.px - n);
        if (gap < bestGap) { bestGap = gap; best = item; }
      });
      return best.key;
    }

    /** 视图类型的三档（产物与目录共用同一组语义）。 */
    var VIEW_KINDS = [
      { key: "card", label: "卡片" },
      { key: "list", label: "列表" },
      { key: "gallery", label: "画廊" },
    ];

    var COLUMN_KEYS = [
      { key: "size", label: "大小" },
      { key: "time", label: "修改时间" },
      { key: "type", label: "类型" },
    ];

    function ViewControl(props) {
      var React = require("react");
      var h = React.createElement;

      /** 列选择浮层的开合（本组件唯一的 hook）。 */
      var sColsOpen = React.useState(false);
      var colsOpen = sColsOpen[0];
      var setColsOpen = sColsOpen[1];

      var label = props.label ? String(props.label) + "：" : "";
      var views = Array.isArray(props.views) ? props.views : VIEW_KINDS;
      var columns = props.columns && typeof props.columns === "object" ? props.columns : { size: true, time: true, type: false };

      var kids = [];

      // ① 视图类型（卡片/列表/画廊）—— 与产物视图同一套 SegmentedControl 形态
      kids.push(h("div", {
        key: "views",
        className: NS + "__seg",
        role: "tablist",
        "aria-label": label + "呈现方式",
      }, views.map(function (item) {
        var on = props.view === item.key;
        return h("button", {
          key: "v" + item.key,
          type: "button",
          role: "tab",
          className: NS + "__segi",
          "data-on": on ? "1" : "0",
          "aria-selected": on ? "true" : "false",
          "aria-label": label + item.label,
          onClick: function () { if (typeof props.onView === "function") props.onView(item.key); },
        }, item.label);
      })));

      // ② 密集度（行高）—— 只在宿主给了 onDensity 时出现
      if (typeof props.onDensity === "function") {
        kids.push(h("select", {
          key: "density",
          className: NS + "__select",
          "aria-label": label + "行高密度",
          value: String(props.density || "standard"),
          onChange: function (event) { props.onDensity(event.target.value); },
        }, DENSITY_OPTIONS.map(function (item) {
          return h("option", { key: item.key, value: item.key, title: "行高 " + String(item.h) + "px" }, item.label);
        })));
      }

      // ③ 卡片尺寸（小/中/大）
      if (typeof props.onCardSize === "function") {
        kids.push(h("select", {
          key: "size",
          className: NS + "__select",
          "aria-label": label + "卡片尺寸",
          value: String(props.cardSize || "md"),
          onChange: function (event) { props.onCardSize(event.target.value); },
        }, CARD_SIZES.map(function (item) {
          return h("option", { key: item.key, value: item.key, title: "约 " + String(item.px) + "px" }, "尺寸 " + item.label);
        })));
      }

      // ④ 列设置（就地可调；name 恒显示所以不列出来）
      if (typeof props.onColumns === "function") {
        var onCount = COLUMN_KEYS.filter(function (item) { return columns[item.key] !== false; }).length;
        kids.push(h("span", { key: "cols", className: NS + "__colpick" },
          h("button", {
            type: "button",
            className: NS + "__btn",
            "aria-expanded": colsOpen ? "true" : "false",
            "aria-label": label + "选择显示的列",
            onClick: function () { setColsOpen(!colsOpen); },
          }, "列（" + String(onCount + 1) + "）"),
          colsOpen ? h("div", {
            className: NS + "__menu",
            role: "group",
            "aria-label": label + "列设置",
            style: { position: "absolute", top: "100%", left: "0", marginTop: "4px" },
          },
            h("div", { className: NS + "__mi", style: { color: "var(--dsw-alias-label-tertiary)", cursor: "default" } }, "名称（固定显示）"),
            COLUMN_KEYS.map(function (item) {
              var on = columns[item.key] !== false;
              return h("label", { key: "c" + item.key, className: NS + "__mi" },
                h("input", {
                  type: "checkbox",
                  className: NS + "__switch",
                  checked: on,
                  "aria-label": "显示「" + item.label + "」列",
                  onChange: function (event) {
                    var next = {};
                    for (var k in columns) if (Object.prototype.hasOwnProperty.call(columns, k)) next[k] = columns[k];
                    next[item.key] = !!event.target.checked;
                    props.onColumns(next);
                  },
                }),
                item.label);
            })) : null));
      }

      return h("span", { className: NS + "__viewctl" }, kids);
    }

    /** 语义搜索的条数与防抖（**不用设置的 `listLimit`**：语义结果是「找东西」，不是翻页浏览）。 */
    var SEMANTIC_LIMIT = 20;
    var SEMANTIC_DEBOUNCE = 200;

    /**
     * 语义搜索视图（`filters.mode === 'semantic'`，MIGRATION-PLAN 第 1 项）。
     *
     * ⚠️ **为什么不复用关键词查询（`listQuery`）** —— 这条理由必须写在代码里，
     * 否则后人会觉得「明明能复用一个请求，为什么另写」，然后改成语义不对的版本：
     *   · 关键词模式走 `GET /ext/artifacts?q=…` —— **字面匹配**（按标题/路径/标签筛）；
     *   · 语义模式走 `GET /ext/artifacts/search?q=…` —— **按意思找**，返回**按 score 排序**的命中，
     *     并带 `matched[]`（说明「为什么它被搜到」）。
     *   两者**结果集、排序规则、可解释性都不同**；混起来就会出现「看着像筛选、其实是猜」的界面。
     *
     * ⚠️ **不静默降级**：这条通道挂了就**明说不可用**并提示切回关键词模式 ——
     * 绝不在语义模式里偷偷给关键词结果（那等于让用户以为在按意思搜、其实在按字面搜）。
     *
     * 端点返回**部分记录**（`{id,title,kind,project,score,matched[]}`）→ 所以这里
     * **不假设有 title/kind/project**，点开某条时才 `GET /:id` 取完整记录（可能 404 → 如实说）。
     */
    function SemanticView(props) {
      var React = require("react");
      var h = React.createElement;

      var sHits = React.useState([]);
      var hits = sHits[0];
      var setHits = sHits[1];

      var sPhase = React.useState("idle");   // idle | loading | ready | error
      var phase = sPhase[0];
      var setPhase = sPhase[1];

      var sError = React.useState("");
      var error = sError[0];
      var setError = sError[1];

      var sExpanded = React.useState(null);   // 「在卡片里看这些结果」之后的完整记录
      var expanded = sExpanded[0];
      var setExpanded = sExpanded[1];

      var sBusy = React.useState(false);
      var busy = sBusy[0];
      var setBusy = sBusy[1];

      var query = String(props.query || "").trim();
      var notify = typeof props.onToast === "function" ? props.onToast : function () {};

      /** 语义查询（200ms 自链式 setTimeout 防抖；绝不用 setInterval）。 */
      React.useEffect(function () {
        if (!query) { setHits([]); setExpanded(null); setPhase("idle"); return undefined; }
        var alive = true;
        setPhase("loading");
        var timer = setTimeout(function () {
          var url = "/search?q=" + encodeURIComponent(query) + "&limit=" + String(SEMANTIC_LIMIT)
            + (props.kind ? "&kind=" + encodeURIComponent(String(props.kind)) : "")
            + (props.project ? "&project=" + encodeURIComponent(String(props.project)) : "");
          apiGet(url)
            .then(function (payload) {
              if (!alive) return;
              setHits(payload && Array.isArray(payload.hits) ? payload.hits : []);
              setExpanded(null);
              setPhase("ready");
            })
            .catch(function (err) {
              if (!alive) return;
              setError(err && err.message ? String(err.message) : String(err));
              setPhase("error");
            });
        }, SEMANTIC_DEBOUNCE);
        return function () { alive = false; if (timer) clearTimeout(timer); };
      }, [query, props.kind, props.project]);

      /** 点开一条：先取完整记录再开详情（失败如实说，别让「点了没反应」）。 */
      function open(hit) {
        if (!hit || !hit.id) { notify("这条命中没有 id，打不开"); return; }
        notify("读取中…");
        apiGet("/" + encodeURIComponent(String(hit.id)))
          .then(function (record) {
            if (record && record.id) { if (typeof props.onOpenRecord === "function") props.onOpenRecord(record); }
            else notify("这条记录已经不在了（可能被删或回收）");
          })
          .catch(function (err) {
            var msg = err && err.message ? String(err.message) : String(err);
            notify(msg.indexOf("404") >= 0 ? "这条记录已经不在了（可能被删或回收）" : "读取失败：" + msg);
          });
      }

      /** 「在卡片里看这些结果」：**点了才**批量取完整记录（成本转移给真正需要的人）。 */
      function expandAll() {
        var ids = hits.map(function (hit) { return hit && hit.id; }).filter(Boolean);
        if (!ids.length) { notify("没有可展开的结果"); return; }
        setBusy(true);
        notify("正在取 " + String(ids.length) + " 条完整记录…");
        var out = [];
        var missed = 0;
        var chain = Promise.resolve();
        ids.forEach(function (id) {
          chain = chain.then(function () {
            return apiGet("/" + encodeURIComponent(String(id)))
              .then(function (record) { if (record && record.id) out.push(record); else missed += 1; })
              .catch(function () { missed += 1; });
          });
        });
        chain.then(function () {
          setBusy(false);
          setExpanded({ records: out, missed: missed });
          notify("取到 " + String(out.length) + " 条" + (missed ? "，有 " + String(missed) + " 条已不在" : ""));
        });
      }

      // 字段可能缺（端点是部分记录）→ 全部走兜底，不假设 title/kind/project 存在
      function titleOf(hit) { return String((hit && (hit.title || hit.id)) || "(无标题)"); }
      function matchedLabel(name) {
        var map = { title: "标题", project: "项目", tags: "标签", tag: "标签", summary: "摘要", notes: "备注", path: "路径", kind: "类型", source: "来源" };
        return map[String(name)] || String(name);
      }

      var body;
      if (expanded) {
        body = h("div", null,
          h("div", { className: NS + "__meta", style: { padding: "6px 0" } },
            "这些结果的完整记录（" + String(expanded.records.length) + " 条" + (expanded.missed ? "，另有 " + String(expanded.missed) + " 条已不在" : "") + "）"),
          typeof props.renderRecords === "function" ? props.renderRecords(expanded.records) : null,
          h("div", { className: NS + "__staterow", style: { padding: "10px 0" } },
            h("button", {
              type: "button", className: NS + "__btn",
              onClick: function () { setExpanded(null); },
            }, "← 回到语义结果列表")));
      } else if (phase === "idle") {
        body = StateBlock(h, STATE_ICON_SEARCH, "按意思找东西（语义搜索）",
          ["试试「上次那个讲预算的表格」「给客户的封面图」这种描述 —— 不用记住文件名。",
            "和关键词搜索不同：关键词是**按字面**匹配，这里是**按意思**找。",
            "输入后稍等，结果会带「为什么它被搜到」。"], null, "semantic-idle");
      } else if (phase === "loading") {
        body = SkeletonRows(h, 4);
      } else if (phase === "error") {
        // ★ 不静默降级：明说这条通道不可用，并给出**用户自己选**的替代路径
        body = StateBlock(h, STATE_ICON_ALERT, "语义搜索不可用：" + error,
          ["这条通道由宿主的 /search 端点提供；用不了时**不会**偷偷给你关键词结果。",
            "下一步：切回「关键词」模式按文件名/路径精确找（那是另一条通道，结果也完全不同）。"], null, "semantic-err");
      } else if (!hits.length) {
        body = StateBlock(h, STATE_ICON_SEARCH, "没有找到相关的东西",
          ["换个说法再试（语义搜索对「描述」比「关键词」更敏感）", "或切回关键词模式按文件名/路径精确找"], null, "semantic-none");
      } else {
        body = h("div", null,
          h("div", { className: NS + "__bar" },
            h("span", { className: NS + "__meta" }, "返回前 " + String(hits.length) + " 条（按相关度排序）"),
            h("span", { className: NS + "__grow", style: { flex: "1" } }),
            h("button", {
              type: "button", className: NS + "__btn", disabled: busy,
              "aria-label": "在卡片里看这些结果",
              onClick: expandAll,
            }, "在卡片里看这些结果")),
          h("div", { className: NS + "__flist", role: "grid", "aria-label": "语义搜索结果" },
            hits.map(function (hit, i) {
              var matched = Array.isArray(hit && hit.matched) ? hit.matched : [];
              return h("div", {
                key: String((hit && hit.id) || i),
                className: NS + "__frow",
                role: "row",
                "aria-rowindex": String(i + 1),
                "aria-label": titleOf(hit),
                title: (hit && hit.id) ? String(hit.id) : "",
                onClick: function () { open(hit); },
              },
                h("span", { role: "gridcell" }, IconView(h, iconOf(titleOf(hit), false), "ico")),
                h("span", { className: NS + "__fmain", role: "gridcell" },
                  NameText(h, titleOf(hit), NS + "__fname", "nm"),
                  h("span", { className: NS + "__fdir" },
                    "相关度 " + String(Math.round(Number(hit && hit.score) || 0)),
                    hit && hit.kind ? " · " + String(hit.kind) : "",
                    // ★ matched：解释「为什么它被搜到」—— 语义搜索最怕「它凭什么这么说」
                    matched.length ? " · 命中：" + matched.map(matchedLabel).join("、") : "")),
                h("span", { className: NS + "__dsize", role: "gridcell" }, hit && hit.project ? String(hit.project) : "—"),
                h("span", { className: NS + "__dtime", role: "gridcell" }, ""));
            })));
      }

      return h("div", { className: NS + "__semantic" }, body);
    }

    /**
     * 卡片视图。`opts.cardPx` = 卡片尺寸档位换算出的缩略图边长（task-11 ③：小/中/大就地可调）。
     * `opts.act` = 交互（task-13）：多选、一键引用、定位、打开、右键、**拖出去 = 引用**。
     */
    function renderCards(h, items, setDetail, opts) {
      var options = opts || {};
      var cardPx = isFinite(Number(options.cardPx)) ? Number(options.cardPx) : 96;
      var minWidth = Math.max(Math.round(cardPx * 2.5), 220);
      var act = options.act || {};
      return h("div", {
        className: NS + "__cards",
        "data-card-size": String(cardPx),
        style: { gridTemplateColumns: "repeat(auto-fill,minmax(" + String(minWidth) + "px,1fr))" },
      },
        items.map(function (record) {
          var selected = typeof act.isSelected === "function" && act.isSelected(record);
          // 拖出去 = 引用：**必须真的带载荷**（`setData`），否则拖了等于没拖
          var mention = record.path ? atMention(record.path, false) : "";
          return h("div", {
            key: record.id,
            className: NS + "__card",
            "data-sel": selected ? "1" : "0",
            "aria-selected": selected ? "true" : "false",
            draggable: mention ? "true" : undefined,
            onDragStart: mention ? function (event) {
              try {
                event.dataTransfer.setData("text/plain", mention);
                event.dataTransfer.setData("application/x-dsh-artifact", JSON.stringify({ id: record.id, path: record.path, mention: mention }));
                event.dataTransfer.effectAllowed = "copy";
              } catch (error) { /* 拖拽失败不影响点击 */ }
            } : undefined,
            onClick: function (event) {
              if (event.ctrlKey || event.metaKey) { event.preventDefault(); if (act.onToggleSel) act.onToggleSel(record); return; }
              if (event.shiftKey) { event.preventDefault(); if (act.onRangeSel) act.onRangeSel(record); return; }
              setDetail(record);
            },
            onContextMenu: act.onContext ? function (event) { event.preventDefault(); act.onContext(record, event); } : undefined,
          },
            Thumb(h, record, false, cardPx),
            // hover 浮出的操作区（task-13 C1）：**绝对定位**，不参与布局 → 不影响卡片尺寸
            h("div", { className: NS + "__cardact" },
              mention ? RowAction(h, "复制为 @引用", ACT_ICON_AT, function (event) { event.stopPropagation(); if (act.onRef) act.onRef([record]); }) : null,
              RowAction(h, "在文件夹中显示", ACT_ICON_REVEAL, function (event) { event.stopPropagation(); if (act.onReveal) act.onReveal(record); }),
              RowAction(h, "用默认程序打开", ACT_ICON_OPEN, function (event) { event.stopPropagation(); if (act.onOpen) act.onOpen(record); })),
            h("div", { className: NS + "__cardbody" },
              h("div", { className: NS + "__cardtitle" }, String(record.title || record.id)),
              record.summary ? h("div", { className: NS + "__summary" }, String(record.summary)) : null,
              Badges(h, record),
              h("div", { className: NS + "__meta" },
                h("span", null, fmtSize(record.size_bytes)),
                record.created_at ? h("span", null, fmtDate(record.created_at)) : null,
                record.session_id ? h("span", { title: "来源会话：" + String(record.session_id) }, String(record.session_id).slice(0, 12)) : null
              )
            )
          );
        })
      );
    }

    /** 列表视图。`actions.columns` 决定显示哪些列（task-11 ③：**就地可调**）。
     * 名称列（含缩略图）恒显示 —— 关掉「名称」的表没有意义。
     */
    function renderTable(h, items, filters, actions) {
      var cols = actions.columns && typeof actions.columns === "object" ? actions.columns : { size: true, time: true, type: true };
      var rowH = rowHeightPx(actions.density);
      var rows = items.map(function (record) {
        var trashMode = !!filters.trash;
        var cells = [
          h("td", { key: "ico", style: { height: String(rowH) + "px" } }, isImage(record) && record.exists
            ? h("img", { src: fileUrl(record.id), alt: "", style: { width: "42px", height: "30px", objectFit: "cover", borderRadius: "var(--dsw-radius-sm)", display: "block" } })
            : IconView(h, iconForRecord(record), "ico")),
          h("td", { key: "name" },
            h("b", null, String(record.title || record.id)),
            h("div", { className: NS + "__path" }, String(record.path || ""))),
          h("td", { key: "proj" }, String(record.project || "—")),
        ];
        if (cols.type !== false) cells.push(h("td", { key: "type" }, String(record.artifact_type || "—")));
        if (cols.size !== false) cells.push(h("td", { key: "size" }, fmtSize(record.size_bytes)));
        if (cols.time !== false) cells.push(h("td", { key: "time" }, fmtDate(record.created_at)));
        var selected = typeof actions.isSelected === "function" && actions.isSelected(record);
        var mention = record.path ? atMention(record.path, false) : "";
        cells.push(h("td", { key: "act", style: { whiteSpace: "nowrap" } },
          h("span", { className: NS + "__dact", "data-open": "1" },
            mention ? RowAction(h, "复制为 @引用", ACT_ICON_AT, function (event) { event.stopPropagation(); if (actions.onRef) actions.onRef([record]); }) : null,
            RowAction(h, "在文件夹中显示", ACT_ICON_REVEAL, function (event) { event.stopPropagation(); if (actions.onReveal) actions.onReveal(record); }),
            RowAction(h, "用默认程序打开", ACT_ICON_OPEN, function (event) { event.stopPropagation(); if (actions.onOpen) actions.onOpen(record); })),
          trashMode
            ? h("button", {
              type: "button", className: NS + "__btn",
              onClick: function (event) { event.stopPropagation(); actions.restoreOne(record.id); },
            }, "恢复")
            : h("button", {
              type: "button", className: NS + "__btn " + NS + "__btn--danger",
              onClick: function (event) { event.stopPropagation(); actions.trashOne(record.id); },
            }, "回收")));
        return h("tr", {
          key: record.id,
          "data-sel": selected ? "1" : "0",
          "aria-selected": selected ? "true" : "false",
          draggable: mention ? "true" : undefined,
          onDragStart: mention ? function (event) {
            try {
              event.dataTransfer.setData("text/plain", mention);
              event.dataTransfer.setData("application/x-dsh-artifact", JSON.stringify({ id: record.id, path: record.path, mention: mention }));
              event.dataTransfer.effectAllowed = "copy";
            } catch (error) { /* 忽略 */ }
          } : undefined,
          onClick: function (event) {
            if (event.ctrlKey || event.metaKey) { event.preventDefault(); if (actions.onToggleSel) actions.onToggleSel(record); return; }
            if (event.shiftKey) { event.preventDefault(); if (actions.onRangeSel) actions.onRangeSel(record); return; }
            actions.setDetail(record);
          },
          onContextMenu: actions.onContext ? function (event) { event.preventDefault(); actions.onContext(record, event); } : undefined,
        }, cells);
      });
      var headers = ["", "产物", "项目"];
      if (cols.type !== false) headers.push("类型");
      if (cols.size !== false) headers.push("大小");
      if (cols.time !== false) headers.push("登记时间");
      headers.push("操作");
      return h("table", { className: NS + "__table", role: "grid", "aria-label": "产物列表" },
        h("thead", null, h("tr", null,
          headers.map(function (label, i) {
            return h("th", { key: "h" + String(i), role: "columnheader" }, label);
          }))),
        h("tbody", null, rows));
    }

    // ── 详情抽屉 ──────────────────────────────────────────────────────────
    /** 详情 + 预览 + 编辑。所有数据来自已加载的那条记录，预览按需读文件。 */
    function DetailDrawer(props) {
      var React = require("react");
      var h = React.createElement;
      var record = props.record;

      /**
       * 对话框焦点管理（§11.2）：打开时把焦点移进来（关闭按钮 `autoFocus`），
       * 关闭时**归还给打开它的那个元素**。
       * 注意：这里在**首次渲染时**就抓取 `document.activeElement`（`useRef` 的初值表达式
       * 每次渲染都会求值、但只存第一次），否则等 effect 跑起来时 `autoFocus` 已经把焦点抢走了。
       */
      var returnFocusRef = React.useRef((function () {
        try {
          if (typeof document !== "undefined") return document.activeElement || null;
        } catch (error) { /* 忽略 */ }
        return null;
      })());

      React.useEffect(function () {
        return function () {
          try {
            var node = returnFocusRef.current;
            if (node && typeof node.focus === "function") node.focus();
          } catch (error) { /* 归还失败不影响功能 */ }
        };
      }, []);

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
          return h("div", { className: NS + "__preview" }, h("div", { className: NS + "__empty" }, "文件已不在原位置"));
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
          h("div", { className: NS + "__empty" }, (mime || "未知类型") + "（不支持内联预览）"));
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
          }, "保存"),
          h("button", {
            type: "button", className: NS + "__btn", key: "cancel",
            onClick: function () { setEditing(false); },
          }, "取消"),
        ]
        : [
          h("button", {
            type: "button", className: NS + "__btn", key: "open",
            onClick: function () { props.onOpenFolder(record.id); },
          }, "打开文件夹"),
          h("button", {
            type: "button", className: NS + "__btn", key: "copy",
            onClick: function () { props.onCopyPath(record); },
          }, "复制路径"),
          h("button", {
            type: "button", className: NS + "__btn", key: "edit",
            onClick: function () { setEditing(true); },
          }, "编辑"),
          h("span", { className: NS + "__grow", key: "g" }),
          record.status === "trashed"
            ? h("button", {
              type: "button", className: NS + "__btn", key: "restore",
              onClick: function () { props.onRestore(record.id); },
            }, "恢复")
            : h("button", {
              type: "button", className: NS + "__btn " + NS + "__btn--danger", key: "trash",
              onClick: function () { props.onTrash(record.id); },
            }, "移入回收站"),
        ];

      return h("div", null,
        h("div", { className: NS + "__mask", onClick: props.onClose }),
        h("div", { className: NS + "__drawer", role: "dialog", "aria-label": "产物详情" },
          h("div", { className: NS + "__drawerh" },
            h("div", { className: NS + "__title" }, editing ? "编辑产物" : String(record.title || record.id)),
            h("span", { className: NS + "__grow" }),
            h("button", {
              type: "button", className: NS + "__btn " + NS + "__btn--ghost",
              "aria-label": "关闭", autoFocus: true, onClick: props.onClose,
            }, "关闭")
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
        "aria-label": "打开产物库完整管理页",
        title: "打开完整管理页（登记 / 导入 / 精炼 / 语义搜索 / 整理建议）",
        onClick: openPage,
      },
        h("span", { className: NS + "-ei", "aria-hidden": "true", dangerouslySetInnerHTML: { __html: iconOf("x", true).svg } }),
        h("span", { className: NS + "-el" }, "产物库 · 网页版")
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
        node.setAttribute("style", "position:fixed;right:8px;top:44px;z-index:2147483647;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-inverted);font:11px/1.5 monospace;padding:4px 8px;border-radius:var(--dsw-radius-sm);max-width:60vw;word-break:break-all");
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
      // 这里刻意写成真正的 HTML 属性串：DOM 兜底路径没有 React，属性必须直接落进 innerHTML
      btn.innerHTML = '<span class="' + NS + '-ei" aria-hidden="true">' + iconOf("x", true).svg + '</span>'
        + '<span class="' + NS + '-el">产物库 · 网页版</span>';
      btn.setAttribute("aria-label", "打开产物库完整管理页");
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
     * DOM 兜底：React 会重渲染侧边栏把节点冲掉，所以用一个**自链式 setTimeout**兜住
     * （不用 setInterval：单次 tick 结束后才排下一次，不会重叠、也不会「空转」——
     * 一旦原生入口注册成功，`apply` 会调 disposer 把它停掉）。
     * @returns {Function} disposer
     */
    function applyViaDom() {
      injectCss();
      var stopped = false;
      var timer = null;

      function tick() {
        if (stopped) return;
        try {
          if (typeof document === "undefined") return;
          var col = findSidebar();
          if (col && !col.querySelector("." + NS + "-entry")) {
            var btn = makeDomButton();
            var foot = col.querySelector('[class*="footArea"]') || col.querySelector('[class*="settingsArea"]');
            if (foot && foot.parentElement) foot.parentElement.insertBefore(btn, foot);
            else col.appendChild(btn);
          }
        } catch (error) { /* 单次挂载失败不致命，下一次 tick 会重试 */ }
        if (!stopped) timer = setTimeout(tick, 1500);
      }

      timer = setTimeout(tick, 1500);
      return function () {
        try {
          stopped = true;
          if (timer) clearTimeout(timer);
          timer = null;
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

      // 客户端启动自证：面板没出现时能区分「bundle 没加载」和「加载了但没注册上」。
      // 全程不抛（这条日志本身也在 try/catch 里）。
      try {
        if (typeof console !== "undefined" && console.info) {
          console.info("[artifact-library] client active");
        }
      } catch (error) { /* 忽略 */ }

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
        // ③ 应用级 Toast 浮层：官方 UX 要求瞬时结果挂在「比上报界面活得久」的地方。
        //    ⚠️ 宿主 slot 表里没有 shell.overlay 时（旧版本）这里可能不抛但也不会挂载，
        //    所以**是否兜底由 ShellToast 挂载时置位的 toastBus.hasOverlay 决定**，不由这里的成败决定。
        //    这一步失败**不算** any（三个必需席位才是「注册成功」的判据）。
        try {
          slots.inject(SLOT_OVERLAY, function () {
            return slots.register({
              name: SLOT_OVERLAY,
              id: PANEL_ID + ".toast",
              order: 90,
            }, ShellToast);
          });
        } catch (error) { warn("注册 Toast 浮层失败（将退回面板内提示）：", error); }
        return any;
      }

      registered = tryRegister();
      probeNote(probe, "reg1=" + registered);

      if (!registered) {
        // 自链式 setTimeout（不是 setInterval）：单次尝试结束后才排下一次，不重叠；
        // 注册成功或试满 20 次即彻底停下，不留空转的定时器。
        var scheduleRetry = function () {
          retryTimer = setTimeout(function () {
            retryTimer = null;
            if (registered) return;
            if (tryRegister()) {
              registered = true;
              probeNote(probe, "reg@" + attempts);
              // 原生入口已就位，撤掉 DOM 兜底，避免出现两个入口
              if (domDisposer) {
                try { domDisposer(); } catch (error) { /* 忽略 */ }
                domDisposer = null;
              }
              return;
            }
            if (attempts >= 20) {
              probeNote(probe, "giveup@" + attempts);
              return;
            }
            scheduleRetry();
          }, 1500);
        };
        scheduleRetry();
        try { domDisposer = applyViaDom(); } catch (error) { warn("DOM 兜底失败：", error); }
      }

      // `@` 引用来源：注册在 root 服务 `inputTriggers` 上（**不走 slots.inject**，所以不计入席位）。
      // 服务不在时 registerAtSource 会显式跳过并留日志，返回 null —— 绝不抛。
      var atDisposer = registerAtSource(ctx);

      return function () {
        try { if (atDisposer) atDisposer(); } catch (error) { /* 忽略 */ }
        try { if (retryTimer) clearTimeout(retryTimer); } catch (error) { /* 忽略 */ }
        try { if (domDisposer) domDisposer(); } catch (error) { /* 忽略 */ }
        try { if (probe && probe.parentNode) probe.parentNode.removeChild(probe); } catch (error) { /* 忽略 */ }
      };
    }

    exports.apply = apply;
    return module.exports;
  },
});
