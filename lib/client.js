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
 *      **「第二期」5 项已全部有下落**（2026-09-30 夜更新：4 项搬完、1 项判定不做）：
 *        ✅ 登记产物 —— 已搬（registerRow / batchRegister → POST /ext/artifacts）
 *        ✅ 导入文件夹 —— 已搬（ImportPanel → POST /import；原生 picker + 手动路径兜底）
 *        ⚖️ 立即精炼   —— **拆成两半**：`/refine-request`（标记优先精化）已搬 + 真撤销；
 *                        `/refine-session`（开会话）**判定不做**
 *                        （依赖「这台机器上有没有配模型」，失败面里有一大块无法验证）
 *        ✅ 语义搜索   —— 已搬（SemanticView → GET /search；与关键词走不同通道、不静默降级）
 *        ✅ 整理建议   —— 已搬（独立视图 → GET /suggest-cleanup / POST /cleanup-now）
 *      → **「不能删，因为功能没搬完」这个理由已不成立**；
 *        但「删不删」是产品决定（见 README §「完整管理页」的去留）。
 *        ⚠️ 它现在唯一可能还值得留的理由是「面板加载失败时的应急通道」。
 *      ⚠️ **本注释旧版写的是「只搬了 5 个里的 1 个」** —— 那是 2026-09-30 白天的实测，
 *        **当晚搬完后就成了过期陈述**。这个反例留在这里：
 *        **「实测结论」也有保质期**，而它过期时**不会自己喊**。
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


    var NS = "alf";

    /** host 报来的管理页绝对地址。 */
    var cachedUrl;
    /** 文件内容（图片/文本/音视频）的绝对源前缀；空串则退回相对路径。 */
    var fileOrigin = "";
    // ⚠️ 这里原来有一个 `var hostCtx = null;`（**2026-10-14 删**）。
    //
    //   它是 2026-10-09 为修一个真 bug 加的：模块层的 `PanelInner` 里写着
    //   `getCtx: function () { return ctx; }`，而 `ctx` 只是 `apply(ctx)` 的形参
    //   ⇒ **不在那个作用域里**，一调用就 `ReferenceError`，还被 `nativePicker()`
    //   的 catch 吞掉 ⇒ 用户看到「宿主的目录选择服务不可达」这句**假话**。
    //
    //   2026-10-14 依琪拍板「主区面板不要了，全部转到右侧栏」⇒ `PanelInner` 连同
    //   `getCtx` 一起删了，`hostCtx` 于是**只剩声明和赋值、没有任何读取**（死代码）。
    //   右栏组件**不需要 ctx**（它们走 HTTP），所以这个通道一并去掉。
    //
    //   ⚠️ 那个 bug 的**教训还留着**，只是换了地方守：
    //      · `test/scope-leak.test.mjs` —— 现在守的是一般形式
    //        「**形参里没有 `ctx` 的模块层函数，不许引用裸 `ctx`**」；
    //      · `docs/DEPRECATED-TESTS.md` —— 记着这段历史与它当初守的具体写法。
    //   ⚠️ 真需要模块级 ctx 时**再把它加回来**（别留着一个没人读的变量，
    //      那会让人以为它已经接好了）。

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
      "." + NS + "__stat{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:4px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      // 「待精化 N」做成可点（2026-10-03 · 新手可上手）：它原来是纯 div，而新用户的第一个问题就是"这是什么"。
      // ⚠️ 只复位「字体族」—— 不能用 `font:inherit`，那会把 `.__stat` 的 `font-size:12px` 一起覆盖掉。
      // padding / 圆角 / 字号**都不在这里重写**（继承 `.__stat`，也就不触碰 R-9 刻度的允许集）。
      // 【2026-10-03 · 小琪琪视觉审计 5B】做成可点之后**必须让人看出来能点** ——
      //   她逐个量了四个统计格：标签 DIV、color 全同 rgb(129,133,140)、字重全 400、
      //   边框背景全同、**唯一区别只有 cursor 和 hover 边框色**。
      //   ⇒ 「待精化」虽然是 BUTTON，视觉上和另外三个死数字一模一样 ⇒ **功能做了等于没做**。
      //   这里只加一个**链接色**（不加上划线、不加图标、不加字）—— 一眼可辨，且不破坏"更和谐"。
      "." + NS + "__stat--link{font-family:inherit;cursor:pointer;transition:border-color 100ms ease-out;color:var(--dsw-alias-state-business-primary)}",
      "." + NS + "__stat--link:hover{border-color:var(--dsw-alias-border-l4)}",
      "." + NS + "__stat--link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      "." + NS + "__stat b{color:var(--dsw-alias-label-primary);font-weight:600}",
      "." + NS + "__stat--warn{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-label)}",
      "." + NS + "__grow{flex:1}",
      "." + NS + "__warn{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label);padding:6px 18px;flex:none}",
      // 工具条
      "." + NS + "__toolbar{display:flex;gap:8px 10px;flex-wrap:wrap;align-items:center;padding:0 18px 10px;flex:none}",
      // ── 自适应（2026-09-30）：窄面板下**不许横向溢出、不许把分段控件拆行** ──────────
      // 用的都是**不变量**，不是像素级美观判断，所以不用看真实界面也能做对：
      //   ① 搜索框可收缩（min-width:0）—— 它先让位，而不是把别的控件顶出去
      //   ② 分段控件（视图/模式切换）**内部与整体都不换行**（拆开会让「一组选项」读不出来）
      //   ③ 下拉/按钮**成组换行**（各自 flex:none，靠工具条整体 wrap 成第二行）
      //   ④ 窄到 520px 以下时搜索框**独占一行**（避免它被挤成 60px 宽的「打字看不到」状态）
      //   ⑤ **任何控件都不隐藏** —— 隐藏等于把功能藏起来，是退步
      "." + NS + "{container-type:inline-size}",
      "." + NS + "__toolbar>." + NS + "__input{flex:1 1 220px;min-width:0}",
      "." + NS + "__toolbar>." + NS + "__select{flex:0 1 auto;max-width:100%}",
      "." + NS + "__toolbar>." + NS + "__seg,." + NS + "__toolbar>." + NS + "__btn,." + NS + "__toolbar>." + NS + "__viewctl{flex:none}",
      // ⚠️ **这里故意没有 `.__viewctl:last-child{margin-left:auto}`**（2026-10-06 真机复验后的决定）。
      //    那个「把显示控件推到最右」的写法**是对的**，但：**热载不会重插 CSS**
      //    （2026-10-02 记过一次硬坑，这次又踩到）—— 我改完 CSS 后真机截图里它**根本没生效**，
      //    而「重启应用才能验」这件事在我这边做不到（重启会杀掉当前会话所属的进程）。
      //    ⇒ 于是选择**不依赖 CSS 也能成立**的布局：显示控件排在工具条最后，
      //      这一排塞满时它自然换到**下一行**（实测就是这样：`显示: 列表 ▾  行高标准 ▾  列（3）` 自成一行）。
      //      好处是**现在看到的 = 重启后看到的**，不会留下一个「重启后布局突然变样」的惊喜。
      //    ⇒ 如果将来要改成「同一排靠右」，必须**改完 CSS 后重启应用再截图**才算验证过。
      "." + NS + "__seg{white-space:nowrap;flex-wrap:nowrap}",
      "@container (max-width:520px){." + NS + "__toolbar>." + NS + "__input{flex-basis:100%}}",
      "@container (max-width:400px){." + NS + "__toolbar{gap:6px 8px;padding:0 12px 8px}}",
      // 输入框属于「高层级表面」：border:0 + elevation（不把中性 border 和阴影配对）
      "." + NS + "__input,." + NS + "__select{background:var(--dsw-alias-bg-layer-2);border:0;box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-primary);",
      "  border-radius:var(--dsw-radius-md);padding:5px 10px;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;outline:none;min-width:0}",
      "." + NS + "__input:focus-visible,." + NS + "__select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      "." + NS + "__input{flex:1;min-width:180px}",
      "." + NS + "__btn{display:inline-flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);",
      "  border-radius:var(--dsw-radius-sm);padding:5px 10px;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;cursor:pointer;",
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
      "." + NS + "__body{flex:1;overflow:auto;padding:4px 18px 24px;position:relative;min-height:0}",
      "." + NS + "__cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:12px}",
      "." + NS + "__card{position:relative;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);",
      "  overflow:hidden;display:flex;flex-direction:column;transition:border-color 100ms ease-out;cursor:pointer}",
      "." + NS + "__card:hover{border-color:var(--dsw-alias-border-l4)}",
      "." + NS + "__card:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}",
      "." + NS + "__thumb{height:118px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;overflow:hidden}",
      // 卡片里**包着缩略图**的那层（2026-10-08）：只为了给它挂一个独立的点击区。
      // ⚠️ 本身**不引入任何布局**（`display:block` 撑满宽度），否则会改卡片尺寸 ——
      //    而卡片尺寸是 R-9 门禁与真机截图都在盯的东西。
      "." + NS + "__cardthumb{display:block;position:relative}",
      // 可点时才给指针 + 悬停高亮（非媒体的卡片不该出现"能点"的暗示）。
      // 判据用 `[title]`：只有媒体那条分支才设 title，所以它**就是**「可点」的标记。
      "." + NS + "__cardthumb[title]{cursor:zoom-in}",
      "." + NS + "__cardthumb[title]:hover{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}",
      "." + NS + "__thumb img{width:100%;height:100%;object-fit:cover;display:block}",
      "." + NS + "__cardbody{padding:10px 12px;display:flex;flex-direction:column;gap:6px;flex:1}",
      "." + NS + "__cardtitle{font-weight:600;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.45;word-break:break-all;",
      "  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      "." + NS + "__summary{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;",
      "  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      "." + NS + "__badges{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;line-height:16px}",
      "." + NS + "__badge{display:inline-flex;align-items:center;gap:4px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);",
      "  border-radius:999px;corner-shape:round;padding:0 8px;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__badge--hot{border-color:var(--dsw-alias-state-warn-label);color:var(--dsw-alias-state-warn-label)}",
      "." + NS + "__badge--acc{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
      // ── 标签芯片（Step 3d · 缺口 3/6）──────────────────────────────────────
      // 「受管标签」渲染成带 图标 + 颜色 + 字重 的胶囊；**自由关键词保持素文本**。
      // ⚠️ 三条刻意的约束，都不是审美：
      //   ① 颜色/字重**一律来自内联的规则层**（`tagStyleRule`），这里**不写任何色值** ——
      //      `__badge` 那种固定色在这里不行：标签的颜色是用户配的（且只允许 token，见 §一.2.1）。
      //   ② **字号不在这里设** —— 规则层的 `applySurface` 已经把 `size` 从 chip 面上摘掉了
      //      （并给出理由）。芯片再自己写一个字号就是绕过规则层做第二套决定。
      //      这里只声明「行高/字号跟 __badges 同档」（12px/16px），与最接近的视觉同类保持一致。
      //   ③ 圆角走 `999px` 胶囊（R-9 明确允许的那一个例外值），padding 走节奏刻度。
      "." + NS + "__tagchips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;line-height:16px}",
      "." + NS + "__tagchip{display:inline-flex;align-items:center;gap:4px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);",
      "  border-radius:999px;corner-shape:round;padding:0 8px;color:var(--dsw-alias-label-secondary)}",
      // 芯片内的图标比行内文件图标小一档（16 → 12）：胶囊本身只有 18px 高，16px 图标会把文字挤出去。
      "." + NS + "__tagchipi{flex:none;display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px}",
      "." + NS + "__tagchipi svg{width:12px;height:12px}",
      // 自由关键词：素文本，但**不隐藏**（它也是记录的一部分）—— 用三级灰与芯片区分。
      "." + NS + "__tagfree{color:var(--dsw-alias-label-tertiary)}",
      // 标签样式读取失败时的**大声**提示（§「失败必须大声」：读不到 ≠ 读到了但是空）。
      "." + NS + "__tagwarn{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:16px}",
      "." + NS + "__meta{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
      // 星级（SVG，不用 emoji）
      "." + NS + "__stars{display:inline-flex;gap:2px;color:var(--dsw-alias-label-caption);user-select:none}",
      // 【2026-10-03 补】星号是**文字**（★/☆），原来没写字号 → 吃**浏览器默认 13.3333px**
      //（Linux 侧第二轮量化：`__star` / `__act` 是全场唯一没有 token 的两个控件）。
      // `__act` 里只有内联 SVG（size 由 CSS 给），字号不影响视觉；但**星号会**，
      // 所以这里显式补 `font:inherit` + 与正文同档的字号，避免默认值随浏览器漂移。
      "." + NS + "__star{background:0 0;border:0;padding:2px;cursor:pointer;color:inherit;display:inline-flex;border-radius:var(--dsw-radius-sm);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1}",
      "." + NS + "__star svg{width:13px;height:13px}",
      "." + NS + "__star:hover,." + NS + "__star--on{color:var(--dsw-alias-state-warn-label)}",
      "." + NS + "__star:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      // 表格
      "." + NS + "__table{width:100%;border-collapse:collapse;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);overflow:hidden}",
      "." + NS + "__table th,." + NS + "__table td{text-align:left;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;vertical-align:middle}",
      "." + NS + "__table th{color:var(--dsw-alias-label-tertiary);font-weight:500;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2)}",
      "." + NS + "__table tr:last-child td{border-bottom:0}",
      "." + NS + "__table tbody tr{cursor:pointer}",
      "." + NS + "__table tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__path{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;word-break:break-all}",
      // 分组
      "." + NS + "__group{margin-bottom:16px}",
      "." + NS + "__grouph{font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;color:var(--dsw-alias-label-secondary);margin:0 0 9px;display:flex;align-items:center;gap:8px;font-weight:600}",
      "." + NS + "__grouph em{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;font-style:normal;font-weight:400}",
      // 抽屉（高层级表面：border:0 + elevation）
      "." + NS + "__mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);z-index:5}",
      "." + NS + "__drawer{position:absolute;top:0;right:0;bottom:0;width:min(430px,92%);z-index:6;",
      "  background:var(--dsw-alias-bg-layer-1);border:0;box-shadow:var(--dsw-elevation-panel);",
      "  display:flex;flex-direction:column;overflow:hidden}",
      "." + NS + "__drawerh{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}",
      "." + NS + "__drawerb{flex:1;overflow:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:12px}",
      "." + NS + "__drawerf{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l1);flex:none}",
      "." + NS + "__field{display:flex;flex-direction:column;gap:4px}",
      "." + NS + "__label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__value{font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary);word-break:break-all;line-height:1.6}",
      // ⚠️⚠️ **`flex:none` 是必需的，不是优化**（2026-10-09 依琪实测报的「**视频的按钮都被挡住了**」）：
      //   `__drawerb` 是**纵向 flex 容器**，而 `__preview` 是它的 flex 项 —— 默认 `flex-shrink:1`。
      //   抽屉内容一超高（这条记录有视频 + 标签 + 摘要 + 路径），`__preview` 就被**压缩**，
      //   一路压到 `min-height:120px`，而它 `overflow:hidden` ⇒ **把视频底部裁掉**；
      //   而**视频的原生控件恰好就在底部** ⇒ 用户看到的就是「按钮被挡住」。
      //   📸 实测佐证（他的截图量出来的）：可见高 ≈ **118px**，
      //      正好等于这里的 `min-height:120px`；`0:00 / 0:04`、播放键、`1x`、音量、全屏
      //      **只露出上半截**（下半截被裁）。
      //   ⇒ `flex:none` = `0 0 auto`（**不涨不缩**）：`__preview` 保持自己的内容高度，
      //     超出的部分交给 `__drawerb` 的 `overflow:auto` **滚动** —— 那才是对的。
      "." + NS + "__preview{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:120px;max-height:320px;flex:none}",
      "." + NS + "__preview img{max-width:100%;max-height:320px;display:block}",
      // ⚠️ 视频的 `max-height` 必须有，而且要**小于** `__preview` 的 `max-height:320px`。
      //   原来它只有 `max-width`（`img` 那条有 `max-height:320px`，视频没有 —— 不对称）：
      //   竖版视频在 391px 宽下会算出 ~695px 高 ⇒ `__preview` 卡在 320 ⇒ `overflow:hidden`
      //   又把它裁掉，**控件再次被挡**。
      //   ⚠️ 用 300 而不是贴着 320：视频控件**紧贴下边缘**，
      //      而 `__preview` 的 320 是含边框的（1~2px 的裁剪都会切到控件）。
      //      （`img` 那条维持 320 不动：图片下边缘没有要紧的东西，且它的值被真机截图盯着。）
      "." + NS + "__preview video{max-width:100%;max-height:300px;display:block}",
      "." + NS + "__preview audio{max-width:100%;display:block}",
      // 详情里可点开浮层的图（2026-10-08）：给"能点"的视觉提示。
      // ⚠️ 只加 cursor + hover 描边，**不动尺寸**（尺寸受 R-9 与真机截图盯着）。
      "." + NS + "__preview--zoom{cursor:zoom-in}",
      "." + NS + "__preview--zoom:hover{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}",
      "." + NS + "__pre{width:100%;max-height:300px;overflow:auto;margin:0;padding:12px;",
      "  font-family:var(--ds-font-family-code, ui-monospace, Consolas, monospace);font-size:12px;line-height:1.6;",
      "  white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}",
      // ── 媒体预览浮层（`MediaLightbox`；2026-10-08 · 依琪要「快速预览放大图片 + 快捷播放音视频」）──
      // ⚠️ 为什么用 `position:fixed` + 高 z-index：它是**覆盖整个面板**的浮层，
      //    不能受父容器 `overflow` 裁剪（详情抽屉与卡片容器都有 overflow）。
      // ⚠️ 颜色**全部走 token**，一个 hex 都没有（ui-spec 的 §一.1 门禁会抓）。
      "." + NS + "__lb{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;",
      "  background:var(--dsw-alias-bg-mask, rgba(0,0,0,.62));backdrop-filter:blur(2px)}",
      "." + NS + "__lbhead{display:flex;align-items:center;gap:8px;padding:10px 14px;flex:none;",
      "  background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l1)}",
      "." + NS + "__lbtitle{flex:1;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:18px;",
      "  color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "." + NS + "__lbcount{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__lbbody{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;padding:12px}",
      // 图片：`contain` 保证整张看得见；放大后靠 `__lbbody` 滚动 + 拖动平移
      "." + NS + "__lbimg{max-width:100%;max-height:100%;display:block;object-fit:contain;user-select:none}",
      "." + NS + "__lbmedia{max-width:min(1100px,100%);max-height:100%;display:block}",
      "." + NS + "__lbimg[data-zoom=\"1\"]{max-width:none;max-height:none;cursor:grab}",
      "." + NS + "__lbnav{position:absolute;top:50%;transform:translateY(-50%);z-index:1;",
      "  width:40px;height:64px;border:0;border-radius:var(--dsw-radius-md);cursor:pointer;",
      "  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:18px;line-height:1}",
      "." + NS + "__lbnav[disabled]{opacity:.35;cursor:default}",
      "." + NS + "__lbnav--prev{left:10px}",
      "." + NS + "__lbnav--next{right:10px}",
      "." + NS + "__lbfoot{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;",
      "  background:var(--dsw-alias-bg-layer-1);border-top:.5px solid var(--dsw-alias-border-l1)}",
      // ⚠️ `flex:1` 让提示占满左侧，把**关闭按钮组推到右侧** —— 这是刻意的：
      //    底部右侧是**安全区**（窗口控制按钮只在**顶部**），而顶部右侧是"禁飞区"（见 `__lbx` 注释）。
      "." + NS + "__lbhint{flex:1;min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      // ★ **×** 关闭按钮（2026-10-08 依琪「最好有个 xx 给鼠标点」；**2026-10-09 挪到底部**）。
      //
      // ⚠️⚠️ **为什么不在右上角**（依琪 2026-10-09 实测反馈：「右上角的 xx 被 dsh 的 xx 挡住了」）：
      //   本浮层是 `position:fixed;inset:0` —— 铺满**整个视口**，
      //   所以**它的右上角就是 DSH 窗口的右上角**。
      //   而窗口控制按钮（最小化/最大化/关闭）在 web 内容**之上**（Electron 的 titleBar 层），
      //   **z-index 再高也盖不过它** ⇒ 右上角对浮层来说是**禁飞区**。
      //   （对照：详情抽屉的「关闭」没被挡 —— 因为抽屉在**面板内**，它的右上角不是窗口右上角。）
      //   ⇒ 结论：**铺满视口的浮层，任何东西都别放在右上角。**
      //   ⚠️ 这也解释了为什么"往下挪一点"或"往左挪一点"都不是好解 ——
      //     那要靠猜窗口按钮的宽高（随 DPI / 系统版本 / 最大化与否变），是**魔数**。
      //     **底部**没有这个问题：窗口按钮只在顶部。
      // ⚠️ 尺寸给足 32×32（鼠标热区），字号 20px 让 × 本身显眼。
      "." + NS + "__lbx{flex:none;width:32px;height:32px;padding:0;border:.5px solid var(--dsw-alias-border-l1);",
      "  border-radius:var(--dsw-radius-md);cursor:pointer;background:var(--dsw-alias-bg-layer-2);",
      "  color:var(--dsw-alias-label-primary);font-size:20px;line-height:1;display:inline-flex;",
      "  align-items:center;justify-content:center}",
      "." + NS + "__lbx:hover{background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))}",
      // 空态 / toast
      "." + NS + "__empty{color:var(--dsw-alias-label-tertiary);text-align:center;padding:52px 20px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.9}",
      "." + NS + "__toast{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);z-index:9;",
      "  background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);border:0;",
      "  border-radius:var(--dsw-radius-md);padding:8px 16px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;",
      "  box-shadow:var(--dsw-elevation-prominent);max-width:80%;text-align:center}",
      // 应用级浮层（shell.overlay）里是 fixed 定位，且不抢鼠标事件
      "." + NS + "__toast--shell{position:fixed;bottom:28px;z-index:40;pointer-events:none}",
      // ── 目录视图（UI-SPEC §三）──────────────────────────────────────────
      "." + NS + "__bar{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;padding:2px 0 6px}",
      // 目录工具栏自适应：**路径栏可收缩**（它先让位），导航按钮与视图控件成组换行；
      // 窄到 520px 以下路径栏独占一行（路径是这一屏最重要的信息，不该被挤到看不见）。
      "." + NS + "__bar>." + NS + "__input{flex:1 1 200px;min-width:0}",
      "." + NS + "__bar>." + NS + "__btn,." + NS + "__bar>." + NS + "__seg,." + NS + "__bar>." + NS + "__viewctl{flex:none}",
      "@container (max-width:520px){." + NS + "__bar>." + NS + "__input{flex-basis:100%}}",
      "." + NS + "__crumbs{display:flex;align-items:center;gap:2px;flex:1;min-width:0;overflow:hidden}",
      "." + NS + "__crumbs--fade{-webkit-mask-image:linear-gradient(to right,transparent,black 28px);mask-image:linear-gradient(to right,transparent,black 28px)}",
      "." + NS + "__crumb{background:0 0;border:0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;",
      "  padding:4px 6px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}",
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
      // ── 整理建议（MIGRATION-PLAN 第 2 项）────────────────────────────────
      // ── 导入文件夹（MIGRATION-PLAN 第 4 项）──────────────────────────────
      "." + NS + "__import{padding:2px 0}",
      "." + NS + "__pathedit{display:flex;gap:6px;align-items:center;flex-wrap:nowrap;flex:1;min-width:220px}",
      "." + NS + "__setreport{margin-top:6px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      "." + NS + "__setrerr{color:var(--dsw-alias-label-error)}",
      "." + NS + "__setrh{font-weight:600;color:var(--dsw-alias-label-primary)}",
      "." + NS + "__sugs{display:flex;flex-direction:column;gap:8px}",
      "." + NS + "__sug{display:flex;align-items:flex-start;gap:12px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);",
      "  border-radius:var(--dsw-radius-lg);padding:10px 12px;flex-wrap:wrap}",
      "." + NS + "__sugmain{flex:1;min-width:220px;display:flex;flex-direction:column;gap:4px}",
      "." + NS + "__sugtitle{font-weight:600;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary);word-break:break-all}",
      "." + NS + "__sugwhy{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__sugact{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}",
      "." + NS + "__viewctl{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}",
      // 卡片 hover 操作区（task-13 C1）：**绝对定位** —— 不参与布局，所以 hover 不改卡片尺寸/网格
      "." + NS + "__cardact{position:absolute;top:6px;right:6px;z-index:2;display:flex;gap:2px;padding:2px;",
      "  background:var(--dsw-alias-bg-layer-3);border:0;border-radius:var(--dsw-radius-sm);box-shadow:var(--dsw-elevation-soft);",
      "  opacity:0;visibility:hidden;pointer-events:none;transition:opacity 100ms ease-out}",
      "." + NS + "__card:hover ." + NS + "__cardact,." + NS + "__card:focus-within ." + NS + "__cardact{opacity:1;visibility:visible;pointer-events:auto}",
      "@media (prefers-reduced-motion:reduce){." + NS + "__cardact{transition:none}}",
      // 索引覆盖汇总：一行、可点、不抢版面（只在搜索态 + 真有截断项时出现）
      "." + NS + "__truncnote{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 18px 6px;padding:6px 10px;",
      "  background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);",
      "  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
      "." + NS + "__linkbtn{background:0 0;border:0;padding:2px 4px;font:inherit;color:var(--dsw-alias-state-business-primary);cursor:pointer;text-decoration:underline}",
      "." + NS + "__linkbtn:hover{filter:brightness(1.1)}",
      "." + NS + "__colpick{position:relative;display:inline-flex}",
      // ── 项目容器（task-11 ①）────────────────────────────────────────────
      "." + NS + "__projects{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;padding:4px 0}",
      "." + NS + "__pcard{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);",
      "  padding:12px 16px;display:flex;flex-direction:column;gap:6px;cursor:pointer;transition:border-color 100ms ease-out}",
      "." + NS + "__pcard:hover{border-color:var(--dsw-alias-border-l4)}",
      "." + NS + "__pcard:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      "." + NS + "__pcard--all{background:var(--dsw-alias-bg-layer-2)}",
      "." + NS + "__pcname{font-weight:600;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary);word-break:break-all}",
      "." + NS + "__pcmeta{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      "." + NS + "__pchint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-caption)}",
      // 目录里的卡片视图（与画廊同族的方块，只是尺寸档不同）
      "." + NS + "__dcards{display:flex;flex-wrap:wrap;gap:12px;align-content:flex-start}",
      // 操作区：固定 72px 占位防抖动，hover / :focus-within 才可见
      "." + NS + "__dact{width:72px;flex:none;display:flex;justify-content:flex-end;gap:0;visibility:hidden}",
      "." + NS + "__drow:hover ." + NS + "__dact,." + NS + "__drow:focus-within ." + NS + "__dact,." + NS + "__dact[data-open='1']{visibility:visible}",
      // 表格行（`<tr>`）不是 `__drow`，原来靠 `data-open='1'` **写死常驻** ——
      // 每行挂着 3 个图标 + 一个红框「回收」，一屏十几行就是十几个红框
      // （Linux 侧 Q3 / Windows 侧 art-ui-14 都复现了）。
      // 下面用**更高特异性**覆盖那个 `[data-open='1']`（JS 侧保持 "1" 不动，
      // 避免「热载重跑 JS 但不重插 <style>」造成半成品 —— 这是我踩过的坑）：
      // 表格里先一律隐藏，hover / :focus-within 才出现，与卡片/列表行统一。
      "." + NS + "__table tbody tr ." + NS + "__dact[data-open='1']{visibility:hidden}",
      "." + NS + "__table tbody tr:hover ." + NS + "__dact,." + NS + "__table tbody tr:focus-within ." + NS + "__dact{visibility:visible}",
      "." + NS + "__trashbtn{visibility:hidden}",
      "." + NS + "__table tbody tr:hover ." + NS + "__trashbtn,." + NS + "__table tbody tr:focus-within ." + NS + "__trashbtn{visibility:visible}",
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
      "." + NS + "__finderList{flex:1;min-height:0;max-height:280px;overflow:auto;display:flex;flex-direction:column;gap:2px}",
      "." + NS + "__finderItem{display:flex;align-items:center;gap:8px;background:0 0;border:0;color:var(--dsw-alias-label-primary);",
      "  font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;text-align:left;padding:6px 10px;",
      "  border-radius:var(--dsw-radius-sm);cursor:pointer}",
      "." + NS + "__finderItem:hover,." + NS + "__finderItem[data-on='1']{background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__finderHint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:0 4px}",
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
      // ── 目录卡片用的缩略图块（`__gcell` 一族）────────────────────────────────
      // ⚠️ **2026-10-08 删掉了三条死样式**：`__gwrap` / `__gbar`（含 `__gbar .__input`）/
      //    `__gallery` —— 画廊退役（见 `VIEW_KINDS`），它们的使用点（`GalleryBrowser`
      //    与目录的画廊档）一起删了 ⇒ 定义还在、使用为 0 = **死 CSS**（本仓库明确反对）。
      //    下面这几条**不是**死的：目录卡片（`DirBrowser` 的 `dirView === 'card'`）在用。
      "." + NS + "__gcell{margin:0;display:flex;flex-direction:column;gap:6px;align-items:center;cursor:pointer}",
      "." + NS + "__gcell[data-dir=\"1\"]{cursor:pointer}",
      "." + NS + "__gbox{display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);overflow:hidden}",
      "." + NS + "__gimg{object-fit:cover;display:block;border-radius:var(--dsw-radius-sm)}",
      "." + NS + "__gcap{max-width:100%;overflow:hidden}",
      "." + NS + "__gname{font-size:12px;line-height:15px;color:var(--dsw-alias-label-secondary);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}",
      "." + NS + "__note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:6px 10px 0}",
      // ── 多选与批量（task-9 §4.2）────────────────────────────────────────
      "." + NS + "__drow[data-sel='1']{background:var(--dsw-alias-interactive-bg-active)}",
      "." + NS + "__drow[data-sel='1']:hover{background:var(--dsw-alias-interactive-bg-active)}",
      // 【2026-10-03 · 解「选中时列表下移 50px」】视觉顺序与 DOM 顺序解耦 —— **但只对产物侧**。
      //
      // ⚠️⚠️ **选择器必须收窄成 `.alf > .alf__selbar`（直系子级）** —— 用宽泛的
      //      `.__selbar{order:1}` 会**溢出到另外两处**，而 Linux 侧第七轮实测证明那两处都会坏：
      //
      //   · **目录侧**：它的 wrapper（`:4568`）**没有 className、是 `display:block`**
      //     → `order` 在非 flex/grid 容器里**被直接忽略** → 目录侧 **仍然 +50px**（白改）。
      //   · **文件视图**：父级 `__fv` 确实是 flex column → `order` **生效了**，但效果是
      //     把条排到**结果列表的末尾**：12 行时装得下（y=678）看着还行，
      //     **60 行时条落到 y=2214 —— 视口只有 900 高，离可视区 1388px，而且跟着内容滚**。
      //     ⇒ 那正是 `client-render.test.mjs` 那句「虚拟滚动时会被藏走」要防的事，
      //       **它在文件视图里真的发生了**（断言没白留，只是我原先让它拦错了地方）。
      //
      // 收窄的依据：**只有产物侧的 wrapper 是 `.alf`**（`display:flex;flex-direction:column`），
      // `.alf > .__selbar` 精确命中"直接挂在 `.alf` 下的那条批量条"，另外两处一个不沾。
      // 目录侧与文件视图**留待"重构列表"那一轮**（要和 tabindex / roving focus 一起动滚动结构），
      // 现状已记进 `互通/任务板/UI-问题清单-windows.md` §7.8。
      "." + NS + "__selbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none;padding:6px 8px;margin:0 0 6px;",
      "  background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md)}",
      "." + NS + ">." + NS + "__selbar{order:1}",
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
      "." + NS + "__sethint{font-style:normal;font-weight:400;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__setrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 0;border-top:.5px solid var(--dsw-alias-border-l1)}",
      "." + NS + "__setrow:first-of-type{border-top:0}",
      "." + NS + "__setlabel{display:flex;flex-direction:column;gap:2px;min-width:180px;flex:1;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__setctl{flex:none;display:inline-flex;align-items:center;gap:6px}",
      "." + NS + "__setval{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      "." + NS + "__input--num{width:110px}",
      "." + NS + "__input--lines{min-width:260px;font-family:var(--ds-font-family-code, ui-monospace, Consolas, monospace);font-size:12px}",
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
      "  border:0;box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column;gap:2px}",
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
      "." + NS + "__fdir{display:flex;min-width:0;align-items:baseline;font-size:12px;line-height:calc(16px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__fv{display:flex;flex-direction:column;gap:8px}",
      "." + NS + "__flist{display:flex;flex-direction:column}",
      // 「本轮改动」：两行式（文件名 + 目录），右侧 +/- 行数
      "." + NS + "__chgmain{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;overflow:hidden}",
      "." + NS + "__chgadd{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums;font-weight:500}",
      "." + NS + "__chgdel{color:var(--dsw-alias-state-error-primary);font-variant-numeric:tabular-nums;font-weight:500}",
      // 侧栏脚部入口（兜底）
      "." + NS + "-entry{",
      "  display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;",
      "  margin:4px 0;padding:6px 10px;",
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
      // ── 项目合并（2026-10-02）─────────────────────────────────────────────
      // 同一项目的不同产出被记成多个项目名。后端只出候选、绝不自动合并 ——
      // 这一节让用户逐组确认（可改名、可单独取消成员、可撤销）。
      "." + NS + "__merge{display:flex;flex-direction:column;gap:8px;margin-top:16px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l3)}",
      "." + NS + "__mergetop{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
      "." + NS + "__mergetitle{flex:none;font-weight:600;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;color:var(--dsw-alias-label-primary)}",
      "." + NS + "__mergesum{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      "." + NS + "__mergenote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__mergeerr{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
      // 撤销条：与顶部「撤销刚才的整理」同族，单独包一层好让用户一眼看到
      "." + NS + "__mundo{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-2);",
      "  border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:8px 10px;",
      "  font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      "." + NS + "__mcards{display:flex;flex-direction:column;gap:8px}",
      "." + NS + "__mcard{display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1);",
      "  border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);padding:10px 12px}",
      "." + NS + "__mhead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}",
      "." + NS + "__mtolabel{flex:none;font-weight:600;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary)}",
      // 名字输入框**不铺满整行**：`合并为「<名字>」` 里的引号是拿来"括住"名字的，
      // 输入框一旦撑到上千像素，两个引号隔着一整屏，读起来就不是「」而像两个孤立的符号
      // （2026-10-02 真机截图看到的）。上限 380px 足够放长项目名，超出的在框内滚动。
      "." + NS + "__mname{flex:0 1 380px;min-width:110px}",
      "." + NS + "__mhint{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label)}",
      "." + NS + "__mmembers{display:flex;flex-direction:column;gap:2px}",
      "." + NS + "__mmember{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--dsw-radius-sm);",
      "  cursor:pointer;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;color:var(--dsw-alias-label-primary)}",
      "." + NS + "__mmember:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__mmember input{flex:none;width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}",
      "." + NS + "__mmname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "." + NS + "__mmcount{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      "." + NS + "__mfoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      "." + NS + "__mmeta{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);flex:1;min-width:150px}",

      // ── 右侧栏 tab（2026-10-14 · 档 1a）──────────────────────────────────
      // ⚠️ 右栏是**窄列**（实测 620px = 视口 45%）⇒ 全部单列、不换行、
      //    字号 **≥12px**（ui-spec [39] 硬断言）、gap 只用 {0,2,4,6,8,10,12,16}。
      //    颜色只取 --dsw-alias-*（禁 hex，ui-spec §一.1）。
      "." + NS + "__rp{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rphead{display:flex;align-items:center;gap:8px;flex:none;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1)}",
      "." + NS + "__rph{font-size:13px;font-weight:500}",
      "." + NS + "__rpn{color:var(--dsw-alias-label-tertiary);font-size:12px}",
      "." + NS + "__rpstate{padding:14px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}",
      "." + NS + "__rplist{flex:1 1 auto;min-height:0;overflow:auto}",
      "." + NS + "__rprow{display:flex;align-items:center;gap:8px;min-height:28px;padding:6px 14px}",
      "." + NS + "__rprow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      "." + NS + "__rpico{flex:none;display:flex;width:16px;height:16px}",
      "." + NS + "__rpico svg{width:16px;height:16px}",
      "." + NS + "__rpnme{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}",
      "." + NS + "__rpsz{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}",
      "." + NS + "__rpt{font-size:13px}",
      // 粒度切换：三个小按钮（不用 select —— 620px 里 select 太占地方且展开后遮挡列表）
      "." + NS + "__rpseg{display:flex;align-items:center;gap:2px;flex:1 1 auto;min-width:0}",
      "." + NS + "__rpsegbtn{flex:none;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:0 8px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}",
      "." + NS + "__rpsegbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rpsegbtn--on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
      "." + NS + "__rpsegbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      // ── 预览（档 1c）────────────────────────────────────────────────────
      "." + NS + "__rprow{width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      "." + NS + "__rprow:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}",
      "." + NS + "__rppv{display:flex;flex-direction:column;height:100%;min-height:0}",
      "." + NS + "__rppvhead{display:flex;align-items:center;gap:8px;flex:none;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1)}",
      "." + NS + "__rpback{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;padding:0;cursor:pointer;white-space:nowrap}",
      "." + NS + "__rpback:hover{color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rppvname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}",
      "." + NS + "__rppvbody{flex:1 1 auto;min-height:0;overflow:auto;padding:0 14px 14px}",
      "." + NS + "__rptext{margin:0;padding-top:10px}",
      "." + NS + "__rppre{margin:0;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rpmd{padding-top:10px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rpmedia{display:flex;align-items:center;justify-content:center;padding:14px 0}",
      "." + NS + "__rpimg{max-width:100%;max-height:60vh;border-radius:var(--dsw-radius-sm)}",
      "." + NS + "__rpvideo{width:100%;max-height:60vh;border-radius:var(--dsw-radius-sm)}",
      "." + NS + "__rpaudio{width:100%}",
      // 预览里的标签芯片行（2026-10-14 从主面板移植）
      "." + NS + "__rptags{padding-top:10px}",
    ].join("\n");

    /** 只在有控制台时告警，绝不抛出。 */
    function warn() {
      try {
        if (typeof console !== "undefined" && console.warn) {
          console.warn.apply(console, ["[artifact-library]"].concat(Array.prototype.slice.call(arguments)));
        }
      } catch (error) { /* 忽略 */ }
    }

    /**
     * 注入样式。永不抛出。
     *
     * ── ⚠️ 2026-10-07：`data-plugin` 这一行**不能删**（它治的是"热载后 CSS 不更新"）──
     *
     * 原来的现象：「改了 CSS，热载后真机上一点不变」，一直被当成环境脾气。**不是。**
     *
     * 宿主 `dsh-client-modules` 删插件样式时**只认 `data-plugin` 属性**：
     *   `removeOwnedStyles(id)` → `querySelectorAll("style[data-plugin]")` 且值 === id
     * 而这个属性是**宿主在 `materialize()` 里"认领"未打标的 style 时打上的**
     * （`claimStyles`：`style:not([data-plugin])` → 打上 ownerId）。
     *
     * ⚠️ 关键在**时机**：`claimStyles` 只在 `factory()`（= 模块**顶层**代码）执行后跑一次。
     *   · **官方插件都在模块顶层注入 CSS** ⇒ 正好落在认领窗口里，属性被打上；
     *   · **我们是在 `apply()` 里调本函数**（apply 在 materialize **之后**）⇒ 窗口早关了。
     *
     * 于是链条是：
     * ```
     *   apply 里注入 → 没有 data-plugin → removeOwnedStyles 删不掉它
     *                → 热载后旧 <style> 还在
     *                → 本函数开头的守卫命中旧标签 → 直接 return
     *                → 新 CSS 永远进不来
     * ```
     * 还有一个副作用：**未打标的标签会被"后来 materialize 的别的插件"认领走**，
     * 于是**那个插件一热载，产物库的样式被一起删掉**（"样式突然没了"的隐藏来源）。
     *
     * ⇒ 自己把 id 打上（与官方插件同形），标签就归我们自己所有、热载时被正确清理。
     *
     * ⚠️ `PLUGIN_ID` 必须是**包名**（不是 `index.js` 里那个 `export const name`）：
     *    宿主的 `ownerId` 来自 client 模块清单的 `row.id`，而那份清单是**按包**扫
     *    `dsh.client` 字段生成的（`package.json` 的 `exports["./client"]`）。
     *    实证：配置里是 `id: artifact-library` / `name: '@dsh-external/dsh-artifact-library'`，
     *    而官方插件打的也是包名（`@deepseek-ai/dsh-client-locale`）。
     *
     * ── 顺带自我认领（为什么不是"发现已存在就直接 return"）────────────────────
     * 光加属性有个**过渡期缺口**：本次修改**之前**已经注入的那个标签是**未打标**的，
     * 宿主按 id 删不掉它 ⇒ 守卫又会命中它 ⇒ 新 CSS 还是进不来，
     * **非得刷新一次页面才行**。所以这里改成：发现已有标签就**就地认领 + 同步内容**。
     * 这样热载**立刻**生效，也顺便对"宿主没删掉"的那条路兜了底。
     */
    var PLUGIN_ID = "@dsh-external/dsh-artifact-library";
    function injectCss() {
      try {
        if (typeof document === "undefined") return;
        var existing = document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]");
        if (existing) {
          // 已有标签：补上归属（旧版本注入的标签没有这个属性）+ 让内容跟上最新的 css
          if (existing.getAttribute("data-plugin") !== PLUGIN_ID) existing.setAttribute("data-plugin", PLUGIN_ID);
          if (existing.textContent !== css) existing.textContent = css;
          return;
        }
        var tag = document.createElement("style");
        tag.setAttribute("data-plugin-css", STYLE_ID);
        // ★ 让宿主认得这是我们插件的样式（否则热载时删不掉旧的 → 新的进不来）
        tag.setAttribute("data-plugin", PLUGIN_ID);
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
    /**
     * 把 HTTP 失败变成**带结构化 `reason` 的错误**。
     *
     * host-dev 2026-09-30 起，所有失败回应统一为
     * `{ ok:false, reason:'…', error:'给人看的话', message:'同 error' }`；常用 reason：
     * `route-not-found`（路由不存在 → 提示重启宿主）/ `artifact-not-found` / `file-missing` /
     * `local-only`（局域网只读）/ `out-of-scope`（不在索引范围）/ `unavailable` / `bad-request` / `internal`。
     *
     * ⚠️ **不要再按状态码文本判分支**（`msg.indexOf("404")` 那套已废弃）：
     * 那是「能用但脆」的做法 —— ui-tester 当时**拒绝为它加判据**，理由正是不想把脆做法固化成规范。
     * 新代码一律 `err.reason === '…'`（`err.status` 也留着，便于兜底）。
     */
    function httpError(status, json, fallback) {
      var reason = json && typeof json.reason === "string" ? json.reason : "";
      var text = (json && (json.error || json.message)) || fallback || ("HTTP " + String(status));
      var error = new Error(String(text));
      error.status = status;
      error.reason = reason;                 // ★ 结构化判据
      error.body = json || null;
      return error;
    }

    /**
     * 请求层的**超时兜底**（R-1：今晚所有「骨架屏无限转」的共同根）。
     *
     * 为什么必须有：没有它时，**任何慢请求或挂住的请求都会让界面永远停在骨架屏** ——
     * 不超时、不报错、无法取消，用户唯一能做的是刷新页面。
     * 它的价值不只在自身：**它是「全表扫描」「同步读大目录」这类慢操作的放大器**
     * —— 慢操作的代价本来是「等」，没有超时就变成「界面死了」。
     *
     * 取 12 秒（不是 5 秒）：大目录列目录 / 全表语义搜索在真机上本来就要几秒，
     * 阈值太短会把**正常的慢**误报成故障（那是比不超时更烦人的体验）。
     * 超时后给的是**可重试的明确失败**，而不是继续转。
     */
    var REQUEST_TIMEOUT_MS = 12000;

    /** 给一次 fetch 挂上 `AbortController` + 超时；结算后一定清掉计时器（防泄漏）。 */
    function fetchWithTimeout(url, init, timeoutMs) {
      var ms = isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS;
      var controller = null;
      var timer = null;
      var timedOut = false;     // ★ 只有「我们自己的计时器开火」才算超时（见下方结算分支）
      try { controller = new AbortController(); } catch (error) { controller = null; }
      var options = {};
      for (var key in init) if (Object.prototype.hasOwnProperty.call(init, key)) options[key] = init[key];
      if (controller) options.signal = controller.signal;
      if (controller) {
        timer = setTimeout(function () {
          timedOut = true;      // ★ 先立旗再 abort，否则结算时无法区分是谁中止的
          try { controller.abort(); } catch (error) { /* 忽略 */ }
        }, ms);
      }
      function clear() { if (timer) { clearTimeout(timer); timer = null; } }
      return fetch(url, options).then(
        function (response) { clear(); return response; },
        function (error) {
          clear();
          var aborted = controller && controller.signal && controller.signal.aborted;
          if (aborted || (error && error.name === "AbortError")) {
            if (timedOut) {
              var timeoutError = new Error("请求超过 " + String(Math.round(ms / 1000)) + " 秒没有响应");
              timeoutError.reason = "timeout";     // ★ 结构化判据（与宿主的 reason 同族）
              timeoutError.status = 0;
              timeoutError.timeoutMs = ms;
              return Promise.reject(timeoutError);
            }
            // 【2026-10-03 修】`AbortError` 有两种来源，原来**混为一谈**：
            //   ① 我们自己的计时器开火 = 真超时（上面那支，reason: "timeout"）
            //   ② **外部中止** —— 面板组件卸载重建（热载）/ 这次请求已被新的取代
            // ② 原来被报成「超过 12 秒没有响应」，还引导用户「看看宿主侧的负载」——
            //   **方向完全指错**。我实测时它把我误导了十几分钟：界面一直说超时、重试也没用，
            //   而同时用 PowerShell 直打同一个端点 **HTTP 200 / 138ms**，宿主一直好好的。
            //   浏览器网络日志里那几条写得明明白白是 `net::ERR_ABORTED`（被中止），不是超时。
            var cancelError = new Error("请求已取消（界面重建，或已被新的请求取代）");
            cancelError.reason = "canceled";
            cancelError.status = 0;
            return Promise.reject(cancelError);
          }
          var netError = new Error(error && error.message ? String(error.message) : "网络请求失败");
          netError.reason = "network";
          return Promise.reject(netError);
        }
      );
    }

    function apiGet(path, timeoutMs) {
      return fetchWithTimeout(API + path, { headers: { accept: "application/json" } }, timeoutMs).then(function (response) {
        if (!response.ok) {
          return response.json().catch(function () { return {}; }).then(function (json) {
            return Promise.reject(httpError(response.status, json));
          });
        }
        return response.json();
      });
    }

    /**
     * 写请求通道（POST/PUT/PATCH/DELETE）—— **所有写操作都必须走这里**。
     *
     * ⚠️ `X-DSH-Artifacts: 1` 是宿主侧的 **CSRF 栅栏**（host-dev 2026-09-30 加）：
     *   · 自定义头会触发**预检**，恶意页面（`text/plain` + 跨源 Origin）发不出来；
     *   · 宿主另有一道同源栅栏（跨源 Origin / Referer → 403）。
     * **漏掉这个头 = 插件重载后所有写操作 403（`csrf-header-missing`）**，
     * 而症状是「**能看不能改**」—— 列表、缩略图、搜索全正常，只有写失败，最难查的那类。
     *
     * **GET 一律不加**（刻意设计）：缩略图是 `<img src>`、下载是 `<a href>`，
     * **它们发不出自定义头** —— 栅栏若管 GET 会把缩略图全打死。
     * ⇒ 所以**任何新增写操作都必须经 `apiSend`**，别自己写 `fetch(...)`；
     *   冒烟里有一条断言盯着「源码里不许出现 apiSend 之外的写方法」。
     */
    function apiSend(path, method, body, timeoutMs) {
      return fetchWithTimeout(API + path, {
        method: method,
        headers: {
          "Content-Type": "application/json",
          "X-DSH-Artifacts": "1",          // ★ CSRF 栅栏（少这一行 → 能看不能改）
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, timeoutMs).then(function (response) {
        if (!response.ok) {
          return response.json().catch(function () { return {}; }).then(function (json) {
            return Promise.reject(httpError(response.status, json));
          });
        }
        return response.json().catch(function () { return {}; });
      });
    }

    /**
     * 千分位（只用于「字符数」这类大数字；条数之类的小数字保持原样，别啰嗦）。
     */
    function fmtCount(n) {
      var v = Math.round(Number(n) || 0);
      return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /**
     * 「正文索引被截断」的提示文案（host-dev 2026-09-30：`contentIndex` 持久化上限 8000 字符）。
     *
     * ⚠️ **为什么要显式告诉用户**：裁索引之后，搜一个**只出现在长文档后半部分**的词会**搜不到**
     * （以前能搜到）。这属于「**无声迁移**」—— 用户会以为检索一直覆盖全文，
     * 于是把「没搜到」理解成「没有这个东西」，而不是「检索没覆盖到」。
     * 和「语义搜索不可用时不许偷偷降级」是同一条原则：**状态变了，必须让用户知道。**
     *
     * 返回 `""` 表示**这个记录没被截断**（正常情况，界面上什么都不显示）。
     */
    function indexCoverageNote(rec) {
      if (!rec || !rec.contentIndexTruncated) return "";
      var used = Number(rec.contentIndexChars) || 0;
      var total = Number(rec.contentIndexTotalChars) || 0;
      var head = "正文只索引了前 " + fmtCount(used) + " 字符";
      if (!total) return "正文已截断：" + head + " —— 更靠后的内容搜不到；详情里可直接读全文。";
      var pct = Math.max(1, Math.round((used / total) * 100));
      return "正文已截断：" + head + "（原文共 " + fmtCount(total) + " 字符，约覆盖 " + String(pct) + "%）"
        + " —— 更靠后的内容搜不到；在详情里可直接读全文（不受此限制）。";
    }

    /** 搜索结果行里的小标记（短句，行内显示，不抢版面）。 */
    function indexCoverageTag(rec) {
      if (!rec || !rec.contentIndexTruncated) return "";
      var used = Number(rec.contentIndexChars) || 0;
      return " · 正文只索引了前 " + fmtCount(used) + " 字符";
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
      // 分类（Step 2d）：宿主侧 store.list 早就支持 artifact_type 这个参数，
      // 缺的**只有前端** —— 面板此前压根没有分类筛选（`cats.types` 拉回来就扔了）。
      add("artifact_type", filters.artifact_type);
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
    // ⚠️ 2026-10-08 删掉了 `GALLERY_VIRTUAL_THRESHOLD = 60`：画廊退役（见 `VIEW_KINDS`），
    //    它唯一的消费点（`GalleryBrowser`）一起删了 —— 留着就是**死常量**。
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

    /**
     * 是不是 Windows 形态路径（盘符 `C:\` 或 UNC `\\server`）。
     *
     * ⚠️ 客户端**不能** import node:path（会破坏 module-loader 的借壳约定），
     * 所以这里按**路径形态**自己判 —— 关键点是：判据必须是「路径长什么样」，
     * 而不是「当前是什么操作系统」。否则跨平台迁移过来的 `C:\…` 记录在 Linux 上
     * 会被拼成 `/home/yiqi\C:\…` 这种废路径。
     */
    function isWindowsPath(p) {
      var s = String(p === undefined || p === null ? "" : p);
      if (!s) return false;
      if (/^[A-Za-z]:[\\/]/.test(s)) return true;
      if (/^[A-Za-z]:$/.test(s)) return true;
      return s.indexOf("\\\\") === 0;
    }


    /** 相对 cwd 的路径拼成绝对路径（端点给的是相对路径，cwd 外才是绝对）。 */
    function absoluteUnder(cwd, p) {
      var path = String(p === undefined || p === null ? "" : p);
      if (!path) return "";
      if (/^[A-Za-z]:[\\/]/.test(path) || path.charAt(0) === "/") return path;
      var base = String(cwd || "").replace(/[\\/]+$/, "");
      if (!base) return path;
      var rel = path.replace(/^[\\/]+/, "");
      // ★ 分隔符必须跟着 **base 的形态**走。
      //   原来无条件 `return base + "\\" + rel`，于是 POSIX 上
      //   `/home/yiqi/proj` + `src/a.md` → `/home/yiqi/proj\src/a.md`（废路径，
      //   面包屑、@ 引用、图标分类、缩略图 URL 全会跟着坏）。
      var win = isWindowsPath(base);
      if (win) rel = rel.replace(/\//g, "\\");
      return base + (win ? "\\" : "/") + rel;
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

    // ── 「产物」这一档与「显示形式」分家（2026-10-06 · 依琪反馈）────────────────
    //
    // 原话：「**至于是卡片展示还是列表应该是另一个专门的显示设置来管理**」。
    // 顶部那个切换器原来 7 档，其实混了**三种不同的问题**：
    //   · 怎么看（显示形式）→ 卡片 / 列表 / 画廊
    //   · 看哪来的数据      → 文件 / 目录
    //   · 干什么活          → 整理 / 改动
    // 三件事并排在一排里，用户没法回答「我点这一档到底在选什么」。
    //
    // ⇒ 切换器只留**数据来源 / 工作模式**；产物侧的「卡片/列表/画廊」交给右上角的
    //   `ViewControl`（它本来就有这三档，见 VIEW_KINDS，所以那个组件一行都不用改）。
    //
    // ⚠️ `filters.view` 的**存储值一个字都不改**（仍是 card/list/gallery/files/dir/…）——
    //   `settings.defaultView` 的取值、`settings.json` 里的现值全按这些值走；
    //   改存储值等于把老用户的设置读成不认识的东西。
    //   所以这里只加**一层判断**，不动数据。
    //
    // ⚠️ **2026-10-08：`gallery` 从这一组里拿掉了**（依琪拍板退役画廊，理由见 `VIEW_KINDS`）。
    //   影响面**只有一处**、而且正是想要的效果：老设置里若还留着 `view:'gallery'` /
    //   `defaultView:'gallery'`，`isProductView()` 会判**否** ⇒ 自动落回卡片。
    //   **不迁移、不报错、不崩** —— 一个已经退役的档位不该让面板打不开。
    var PRODUCT_VIEWS = ["card", "list"];
    /**
     * 用户上次用的产物显示形式。模块级：活得比一次渲染久。
     *
     * 为什么需要它：点「产物」这一档时，`filters.view` 必须落到一个**具体形式**
     * （card/list/gallery），而用户从「目录」点回来时，我们不该永远弹回卡片 ——
     * 应该回到他上次看产物用的那一档。
     * 初值空串，由设置里的 `defaultView`（若确实是三档之一）播种，见拉设置那段。
     */

    // ── 设置面板的辅助（**键/枚举/范围全部来自 schema，不写死**）──────────
    /**
     * 设置键的文案。schema 只给结构（defaults/enums/ranges/booleans…）不给文案，
     * 所以中文标签补在这里；**未知键回落成键名**（后端加键时面板照样渲染得出来，
     * 只是没中文标签），不会因为缺文案而隐藏设置项。
     */
    var SETTING_LABELS = {
      preset: { label: "预设", hint: "一套起点值。选完仍可逐项微调；微调后会自动标成「自定义」，已应用的值不会丢。" },
      density: { label: "行高密度", hint: "紧凑 24px / 标准 32px / 宽松 44px" },
      defaultView: { label: "默认视图", hint: "打开产物库时先落在哪个视图" },
      columns: { label: "列表列", hint: "目录视图里显示哪些列" },
      sortBy: { label: "默认排序", hint: "" },
      sortDir: { label: "排序方向", hint: "" },
      thumbnails: { label: "显示缩略图", hint: "图片行用缩略图代替类型图标" },
      thumbSize: { label: "缩略图尺寸", hint: "列表里缩略图的边长（px）" },
      // ⚠️ 设置键仍叫 `galleryThumbSize`（**存储值不动** —— 改名等于把老设置读成不认识的东西），
      //    但**显示名改了**：2026-10-08 画廊退役后，它唯一的落点是**卡片尺寸**
      //    （见 `cardSizePx` / `cardSizeKeyFromPx`）。继续叫「画廊缩略图尺寸」会让人找不到它。
      galleryThumbSize: { label: "卡片尺寸", hint: "卡片视图里方块缩略图的边长（px）" },
      thumbMaxBytes: { label: "缩略图大小上限", hint: "超过这个字节数的图不加载缩略图（0 = 不限制）" },
      listLimit: { label: "每次列出条数", hint: "目录一次返回多少条（越大越慢）；显式传入 limit 时以传入值为准" },
      virtualThreshold: { label: "滚动优化阈值", hint: "超过多少行改用虚拟滚动（0 = 总是启用）" },
      showHidden: { label: "显示隐藏项", hint: "默认隐藏「点开头」的文件与已知系统噪音文件（desktop.ini / Thumbs.db / $RECYCLE.BIN…）。⚠️ 这是「近似规则」——读不到 Windows 的「隐藏」文件属性，不等于遵循系统隐藏设置" },
      panelWidth: { label: "面板宽度", hint: "留空（或 null）= 自动。目前只记忆数值，宽度生效留到有验收手段时再接" },
      indexExtraDirs: { label: "额外索引目录", hint: "每行一个绝对路径（最多 64 个，自动去重）" },
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
     * 注册 `@` 来源。
     *
     * ⭐ **返回值是三态，调用方必须区分**（2026-10-06 改：小琪琪独立复核逮到的洞 ——
     *   原来「服务没到」和「注册真抛了」共用同一个 `null`，导致**永久失败被重试 20 次**、
     *   刷 20 行 warn，而真正该重试的那次反而分不出来）：
     *   - `Function`  —— 注册成功，返回注销函数（挂进 apply 的 disposer 链）。
     *   - `undefined` —— **服务还没到**（`inputTriggers` 不存在 / 形状不对）。**可重试**：
     *                    本插件加载早于 `dsh-client-ui-input-trigger` 是常态，slots 那条路同理。
     *   - `null`      —— **注册真的抛了**。**永久失败**，再试 19 次也是同一个错，只会刷日志。
     *
     * @param {object} ctx 客户端插件上下文
     * @returns {Function|undefined|null} 见上
     */
    function registerAtSource(ctx) {
      var triggers = null;
      try {
        triggers = ctx && typeof ctx.get === "function" ? ctx.get("inputTriggers") : undefined;
      } catch (error) { triggers = undefined; }
      if (!triggers || typeof triggers.registerSource !== "function") {
        // ⚠️ **这里不打日志**（2026-10-06 改）：加了重试之后，每次失败都打会刷屏 20 行。
        //    日志统一由调用处的重试包装打（成功一次 / 永久失败一次 / 试满一次）。
        return undefined;
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
        // 成功日志**只由调用处的重试包装打一次**。
        // 2026-10-06 删掉了这里的第二行：小琪琪复核时在同一份控制台里看到两条「已注册」，
        // 排查了一轮才发现是两次页面加载各打一条 —— 但两行文案不同本身就会误导人，去掉。
        return function () {
          try { if (typeof disposer === "function") disposer(); } catch (error) { /* 忽略 */ }
        };
      } catch (error) {
        // 注册本身抛了 = **永久失败**（宿主实现形状不匹配之类），调用方见到 null 要立刻停重试。
        warn("@ 来源注册失败（永久，不再重试）：", error);
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

    /**
     * 只统计「本地路径」的目录项数（照抄 Nautilus 的 local-only 语义；网络盘/UNC 跳过）。
     *
     * ⚠️ 原来只认盘符 `/^[A-Za-z]:[\\/]/`，于是在 Linux 上**永远返回 false**
     *    → 目录项的「N 项」永远算不出来（功能静默失效，不报错）。
     *    现在：Windows 本地盘 → true，UNC 网络盘 → false，POSIX 绝对路径 → true。
     *    （POSIX 侧不区分挂载类型 —— 那是近似的，但比"永远 false"强得多。）
     */
    function isLocalPath(p) {
      var s = String(p || "");
      if (/^[A-Za-z]:[\\/]/.test(s)) return true;
      if (s.indexOf("\\\\") === 0) return false;
      return s.charAt(0) === "/";
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
    /** 闪电（优先精化）。**SVG，不是 emoji** —— 约束禁止 emoji 当图标。 */
    var ACT_ICON_BOLT = '<path d="M9.2 1.6 3.8 9.1h3.3l-.9 5.3 5.6-7.6H8.4z"/>';
    var ACT_ICON_REVEAL = '<path d="M2.6 4.6a1 1 0 0 1 1-1h2.6l1.1 1.4h5.1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1z"/><path d="m6.6 9.4 1.8 1.8 1.8-1.8"/><path d="M8.4 11.2V7.4"/>';
    /**
     * 【2026-10-03 加】垃圾桶图标 —— 给**卡片**的 hover 操作区用。
     * 为什么：列表行有「回收」而卡片没有（Linux 侧第一轮普查 P2 的一致性条目），
     * 同一个东西两种视图两套能力，用户得记住"哪个视图能删"。
     * 用图标而不是像列表那样放文字按钮：卡片 hover 区是 `position:absolute; top:6px; right:6px`，
     * 放文字会把整块往左撑、盖住标题。
     */
    var ACT_ICON_TRASH = '<path d="M2.8 4.6h10.4"/><path d="M6.4 4.6V3.4a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.2"/><path d="M4.4 4.6l.6 8.1a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.6-8.1"/><path d="M6.8 7v4.4M9.2 7v4.4"/>';
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

    /**
     * 扩展名候选，最长优先：`extensionCandidates('a.tar.gz')` → `['tar.gz','gz']`
     */
    function extensionCandidates(name) {
      return resolveIcon.extensionCandidates(name)
    }
    // <<< INLINE-ICONS-END

// >>> INLINE-TAG-STYLES-BEGIN（由 scratch/inline-tag-styles.cjs 生成，请勿手改）
    // 标签「醒目样式」规则层内联自 lib/tag-styles.js + lib/tags.js（原因同 INLINE-ICONS：
    // 插件运行时加载不到包内相对 ESM，客户端只能内联）。改规则请改**源文件**再跑
    //   node scratch/inline-tag-styles.cjs
    // 重新生成 —— 下面这段一个字都别手改。
    //
    // 三段都是机械复制（求值 → JSON 字面量 → 源码），没有一行人工翻译：
    //   ① TAG_STYLE_TABLE   求值后的纯 JSON（源里是 Object.fromEntries(...) 现算的，
    //                        所以必须先求值；照抄源码文本会抄到一段引用模块私有名字的表达式）
    //   ② buildTagStyleRule 函数源码（自包含）
    //   ③ normalizeTag      读路径的归一化兜底（源 lib/tags.js）+ 它的私有依赖 TAG_DECOR。
    //                        **不内联它 = 客户端退化成逐字匹配**，与 Node 侧算出不同结果
    //                        （定稿 §2.3 要避免的那种：给 DSH 配了色，挂在 dsh 上的记录素净）
    //
    // 源文件指纹 lib/tag-styles.js sha256[:16] = 3ea81dcee3d1d6c2（两边不一致 = 漂移，需要重新生成）
    // 源文件指纹 lib/tags.js sha256[:16] = ab95bb362ed0a423（同上；它只为 normalizeTag + TAG_DECOR 而来）
    const TAG_STYLE_TABLE = {
      "colors": {
        "neutral": "var(--dsw-static-neutral-bluish-300)",
        "blue": "var(--dsw-static-deepseek-500)",
        "sky": "var(--dsw-static-deepseek-450)",
        "green": "var(--dsw-static-green-500)",
        "amber": "var(--dsw-static-amber-500)",
        "orange": "var(--dsw-static-amber-400)",
        "red": "var(--dsw-static-red-600)",
        "violet": "rgb(139,118,246)"
      },
      "icons": [
        "folder",
        "code",
        "json",
        "markdown",
        "html",
        "doc",
        "text",
        "sheet",
        "slides",
        "pdf",
        "image",
        "video",
        "audio",
        "archive",
        "binary",
        "other"
      ],
      "weights": {
        "normal": 400,
        "bold": 600
      },
      "sizes": {
        "small": "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
        "normal": "var(--dsh-content-font-size-secondary, 13px)",
        "large": "var(--dsh-content-font-size, 14px)"
      },
      "channels": [
        "color",
        "icon",
        "weight",
        "size"
      ],
      "channelSurface": {
        "color": "both",
        "icon": "both",
        "weight": "both",
        "size": "group"
      },
      "surfaces": {
        "chip": "标签芯片",
        "group": "分组标题"
      },
      "limit": null
    }

    /** 装饰符正则（源 lib/tags.js 的 TAG_DECOR；normalizeTag 只依赖它一个外部名字） */
    const TAG_DECOR = /[\s\u00b7\u30fb\u2027\u2219\u22c5\u2010\u2011\u2012\u2013\u2014\u2015\-_]+/gu

    function normalizeTag(tag) {
      return String(tag == null ? '' : tag)
        .normalize('NFKC')
        .replace(TAG_DECOR, '')
        .toLowerCase()
    }

    function buildTagStyleRule(table, keyOf) {
      const t = table && typeof table === 'object' ? table : {}
      const colors = t.colors && typeof t.colors === 'object' ? t.colors : {}
      const icons = (Array.isArray(t.icons) ? t.icons : []).filter((x) => typeof x === 'string')
      const weights = t.weights && typeof t.weights === 'object' ? t.weights : {}
      const sizes = t.sizes && typeof t.sizes === 'object' ? t.sizes : {}
      const channels = (Array.isArray(t.channels) && t.channels.length ? t.channels : ['color', 'icon', 'weight', 'size'])
        .filter((c) => typeof c === 'string')
      const channelSurface = t.channelSurface && typeof t.channelSurface === 'object' ? t.channelSurface : {}
      const surfaces = t.surfaces && typeof t.surfaces === 'object' ? t.surfaces : {}
      /* ── 受管上限（`null` = 不限）─────────────────────────────────────────────
       * 依琪 2026-10-08 拍板：「可以自定义不设上限」⇒ 默认**不设**，但机制**留全**。
       *
       * ⚠️ 严格解析、**不夹不猜**，三种状态分得开：
       *   · 字段缺失 / `null` → **不限**（默认）
       *   · ≥1 的正整数      → 上限就是它
       *   · 其它（0 / 负数 / 小数 / 字符串…）→ **表配置错误**，明确报错
       * 为什么非法值不「当不限」就算了：`0` 既有人用来表示「不限」（ulimit 那套惯例）、
       * 也有人用来表示「一个都不许」—— 静默按其中一种办，就是「同一个值承载两种语义」。
       * 报错 = 把选择权还给写配置的人（同 `ENUMS` 的「越界拒绝、不夹不猜」）。
       *
       * ⚠️ 旧代码这里是 `Number.isFinite(t.limit) && t.limit > 0 ? Math.trunc(t.limit) : 16`：
       * 一个写错的 `0` 会被**静默变成 16**（没人会知道），而那个 16 本来就不该本模块替他定。
       * 两个毛病一起修掉 —— **更替的理由写在注释里，不是把旧写法删掉。**
       */
      const LIMIT_UNLIMITED = null
      const rawLimit = t.limit
      const limitGiven = rawLimit !== null && rawLimit !== undefined
      const limitInvalid = limitGiven && !(Number.isInteger(rawLimit) && rawLimit >= 1)
      const LIMIT = limitGiven && !limitInvalid ? rawLimit : LIMIT_UNLIMITED
      const LIMIT_PROBLEM = limitInvalid
        ? '受管上限（limit）不合法：收到 ' + JSON.stringify(rawLimit) + '。'
          + '要表达「不限」请写 null（或直接删掉这个字段）；要设上限请写 ≥1 的整数。'
          + '⚠️ 本模块**不猜** `0` 的意思 ——「不限」和「一个都不许」都有人这么写，'
          + '猜错会得到一个**看起来成功的**配置。'
        : ''
      const key = typeof keyOf === 'function' ? keyOf : function (s) { return s === null || s === undefined ? '' : String(s) }

      const COLOR_SLOTS = Object.keys(colors)
      const COLOR_VALUES = COLOR_SLOTS.map(function (slot) { return colors[slot] })
      const WEIGHT_NAMES = Object.keys(weights)
      const SIZE_NAMES = Object.keys(sizes)
      const SURFACE_NAMES = Object.keys(surfaces)
      /** 样式字段的白名单 —— **遍历这张表，不遍历输入的键**（`validateCategories` 的既有套路） */
      const STYLE_FIELDS = ['color', 'icon', 'weight', 'size']
      /**
       * id 的形状。与 `settings.js` 的 `CATEGORY_ID_RE` **同源但各写一份** ——
       * 理由照 `categories.js:177-179`：本模块要零 `node:` 依赖、要保持可内联，
       * 不能 import 一个自己写着 `import fs from 'node:fs'` 的模块。
       * **测试里有一条断言两份必须同值**（`[B] B3`），防止漂移。
       */
      const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

      function isPlain(v) {
        return typeof v === 'object' && v !== null && !Array.isArray(v)
      }
      function text(v) {
        return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v))
      }

      /* ── 色板 ─────────────────────────────────────────────────────────────── */

      /**
       * 校验一个颜色值，返回它对应的**槽名**。
       *
       * 接受两种写法（都必须在色板里）：
       *   ① 槽名本身：`'red'`（大小写不敏感、可带首尾空白）
       *   ② 色板里已有的**完整字面量**：`'var(--dsw-static-red-600)'` / `'rgb(139,118,246)'`
       *      —— 取值器从 `TAG_STYLE_TABLE.colors` 读到什么就该能原样填回来。
       *
       * ⚠️ **hex 一律拒绝，不做「就近映射」**。这条路我**刻意不走**，理由：
       *   · 「最近的 token」是我在猜他的意图 —— `#ff0000` 到底是 `red`(pdf) 还是
       *     状态色里的 error？没有唯一答案，而我一旦猜错，用户看到的是
       *     「设置成功了」（因为他填的颜色被吃掉了），这比报错坏得多；
       *   · 而且静默改写会把**深色模式翻车**这件事藏起来：他以为自己填了红，
       *     换到深色主题发现颜色没跟着变，却不知道是被改写过的。
       *   ⇒ `test/tag-styles.test.mjs` 的 `[C]` 节是**反向断言**：hex、rgb()/hsl()
       *     的非色板值、CSS 颜色名、`var()` 里的未知 token —— **全部必须被拒**。
       *
       * @returns {{ok:true, slot:string, value:string}|{ok:false, reason:string}}
       */
      function resolveColor(input) {
        if (typeof input !== 'string') {
          return { ok: false, reason: '颜色要写成色板槽名的字符串，收到 ' + JSON.stringify(input ?? null) }
        }
        const raw = input.trim()
        if (!raw) return { ok: false, reason: '颜色不能是空字符串（不想要颜色就别写这个字段）' }
        if (raw.indexOf('#') >= 0) {
          return {
            ok: false,
            reason: '颜色里不许出现 hex（' + JSON.stringify(raw) + '）。'
              + 'lib/icons.js 头部写着「禁止 hex：颜色只允许 var(--dsw-static-*)」——'
              + '自己写死颜色在深色模式下不会跟随主题（宿主靠重绑 token 换色）。'
              + '可选色板槽名：' + COLOR_SLOTS.join(' / '),
          }
        }
        // ① 槽名
        if (Object.prototype.hasOwnProperty.call(colors, raw)) return { ok: true, slot: raw, value: colors[raw] }
        const lower = raw.toLowerCase()
        if (Object.prototype.hasOwnProperty.call(colors, lower)) return { ok: true, slot: lower, value: colors[lower] }
        // ② 色板里已有的完整字面量（取值器填回来的那条路）
        const hit = COLOR_VALUES.indexOf(raw)
        if (hit >= 0) return { ok: true, slot: COLOR_SLOTS[hit], value: raw }
        return {
          ok: false,
          reason: '颜色只接受色板槽名（' + COLOR_SLOTS.join(' / ') + '）'
            + '或色板里已有的完整 token 字面量；收到 ' + JSON.stringify(raw) + '。'
            + '⚠️ 色板不是可以自由发挥的 —— 它借的是 icons.js 的官方色表，本模块不新增颜色。',
        }
      }

      /* ── 样式对象 ─────────────────────────────────────────────────────────── */

      /**
       * 被否决过的写法 → 该写什么。
       * 只收录**已经见过/可预期**的误写，用来把 notes 写成「可执行的纠正」。
       * ⚠️ 这是**提示表，不是别名表** —— 命中它不会自动改写（见 `normalizeStyle` ①）。
       */
      const UNKNOWN_HINTS = {
        bold: 'weight',
        isBold: 'weight',
        fontWeight: 'weight',
        fontSize: 'size',
        colour: 'color',
        bg: 'color',
        background: 'color',
        iconName: 'icon',
      }

      /**
       * 校验并**规范化**一个样式对象。
       *
       * 形状照 `validateCategories`（`settings.js:460-475`）的既有套路：
       * **遍历自己写死的字段名、不遍历输入的键**；每个字段单独类型检查；
       * 返回**全新对象**（绝不把输入对象原样存进去）。
       *
       * 两条与 `validateCategories` 不同的地方，都是**理由充分的**：
       *
       * ① **未知字段不静默丢** —— 进 `notes`，并且**必须点名**「哪个键、该写什么」。
       *    理由：依琪原话是「**是否加粗**」—— 一个很自然的写法就是
       *    `{ bold: true }`。静默丢掉它 = 「agent 以为设了加粗，界面上是普通」
       *    = 本仓库反复要防的**静默空转**。`notes` 非空是调用方该看的东西
       *    （`settings.js` 的导入也是这个形状：`{ok, values, ignored, errors}`）。
       *    ⚠️ 但**不做别名自动改写**：`bold` 不会被当成 `weight:'bold'`。
       *    一个字段只准有一种写法，否则立刻长出第二套词汇表。
       * ② **越界是拒绝，不是夹紧** —— 与 `RANGES`（数值型，夹紧）**刻意不同**。
       *    这些是**枚举**，不是有序量：「字号填 99」夹成 `large` 是在替用户猜，
       *    而 `ENUMS` 的既有口径就是「只接受这些值，其它一律拒绝（不夹、不猜）」。
       *
       * @param {unknown} input
       * @returns {{ok:true, style:object, notes:string[]}|{ok:false, reason:string}}
       */
      function normalizeStyle(input) {
        if (input === null || input === undefined) return { ok: true, style: {}, notes: [] }
        if (!isPlain(input)) return { ok: false, reason: '样式要是一个对象，收到 ' + JSON.stringify(input ?? null) }
        const style = {}
        const notes = []
        for (const field of STYLE_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(input, field)) continue
          const value = input[field]
          // 显式写 null / undefined = 「这条通道不设置」。与「字段不存在」等价，不算错。
          if (value === null || value === undefined) continue
          if (field === 'color') {
            const r = resolveColor(value)
            if (!r.ok) return { ok: false, reason: r.reason }
            style.color = r.slot
            continue
          }
          if (field === 'icon') {
            if (typeof value !== 'string' || icons.indexOf(value) < 0) {
              return {
                ok: false,
                reason: '图标只接受 icons.js 里已有的形状名：' + icons.join(' / ')
                  + '；收到 ' + JSON.stringify(value ?? null)
                  + '。⚠️ 别自造图标名 —— 图标集是内联进客户端的，自造会得到「配置合法但渲染空白」。',
              }
            }
            style.icon = value
            continue
          }
          if (field === 'weight') {
            if (typeof value !== 'string' || WEIGHT_NAMES.indexOf(value) < 0) {
              return {
                ok: false,
                reason: '字重只有两档：' + WEIGHT_NAMES.join(' / ') + '；收到 ' + JSON.stringify(value ?? null)
                  + '。⚠️ 不收数值（如 ' + JSON.stringify(weights[WEIGHT_NAMES[0]]) + '）—— 「受限档位」的意思是'
                  + '档名固定，数值由本模块给（见 WEIGHT_VALUES 的注释：600 才是本项目的「加粗」口径）。',
              }
            }
            style.weight = value
            continue
          }
          if (field === 'size') {
            if (typeof value !== 'string' || SIZE_NAMES.indexOf(value) < 0) {
              return {
                ok: false,
                reason: '字号只有三档：' + SIZE_NAMES.join(' / ') + '；收到 ' + JSON.stringify(value ?? null)
                  + '。⚠️ 不接受任意值 —— 844 个标签里如果 10 个标签 10 种字号，'
                  + '那不是更醒目，是更花。',
              }
            }
            style.size = value
            continue
          }
        }

        // 未知字段 → notes（**必须点名 + 给出该写的键**，否则这条提示等于没有）
        for (const k of Object.keys(input)) {
          if (STYLE_FIELDS.indexOf(k) >= 0) continue
          const suggest = UNKNOWN_HINTS[k]
          notes.push(
            suggest
              ? '样式里的 ' + JSON.stringify(k) + ' 不认识，已忽略 —— 要写的是 ' + JSON.stringify(suggest) + '。'
              : '样式里的 ' + JSON.stringify(k) + ' 不认识，已忽略（可用字段：' + STYLE_FIELDS.join(' / ') + '）。',
          )
        }
        return { ok: true, style, notes }
      }

      /* ── 受管表 ───────────────────────────────────────────────────────────── */

      /**
       * 校验并规范化**整张受管标签表**。
       *
       * 一条受管条目 = `{ id, tag, color?, icon?, weight?, size? }`
       *   · `id` —— **稳定的身份**（改名时靠它把样式跟住，照分类 id/label 的分工）
       *   · `tag` —— 记录里**逐字出现**的那个字符串（`rec.tags` 里存的原文）
       *   · 其余 4 个是样式，可缺 —— **缺样式的条目照样是受管**（这正是「样式不是判据」）
       *
       * ⚠️ `tag` **逐字保留、不 trim** —— 这是 3b 学到的教训（`tags.js:286-289`）：
       *   `[管理] 任何一次 trim 都会让键对不上记录里的值`，结果就是
       *   「报告说改了、实际一条没改」的静默空转。
       *   但**首尾带空白本身要拒绝**：那种条目**永远匹配不到任何记录**（记录里的标签
       *   要么是 trim 过的、要么是别的写法），它是**死配置**，静默接受等于骗人。
       *
       * ⚠️ 上限（`limit`）：**默认不限**（依琪 2026-10-08 拍板）；用户**自己设了**就
       *   **真的生效**（超了照旧拒绝、照旧**不腾位**）。表里的 `limit` 本身写坏了
       *   （`0` / 负数 / 小数 / 字符串）⇒ **整张表拒收**并说清怎么改 —— 不当不限放行。
       *
       * @param {unknown} value
       * @returns {{ok:true, value:object[], notes:string[]}|{ok:false, reason:string}}
       */
      function validateManaged(value) {
        if (value === undefined || value === null) return { ok: true, value: [], notes: [] }
        if (!Array.isArray(value)) return { ok: false, reason: '受管标签表需要数组，收到 ' + JSON.stringify(value ?? null) }
        // 表里的 limit 写坏了 ⇒ 整张表都不收（**不是**当不限放行）。理由见上面 LIMIT 那段。
        if (LIMIT_PROBLEM) return { ok: false, reason: LIMIT_PROBLEM }
        // ⚠️ 只有**用户自己设了**上限才走这段；默认（不限）下这条路根本不会触发。
        if (LIMIT !== LIMIT_UNLIMITED && value.length > LIMIT) {
          return {
            ok: false,
            reason: '受管标签最多 ' + LIMIT + ' 个，收到 ' + value.length + ' 个。'
              + '⚠️ 这个上限是**你自己设的**（把 `limit` 写 null 就取消）。'
              + '「受管」的整个意义是「一小撮能被看见的」，超了它会长成第二个 844。'
              + '要加新的，先合并掉旧的 —— 本模块**不会**替你顶掉最后一个（静默降级比报错糟得多）。',
          }
        }
        const out = []
        const seenId = new Set()
        const seenTag = new Set()
        const seenKey = new Map()
        const notes = []
        for (let i = 0; i < value.length; i += 1) {
          const raw = value[i]
          const at = '受管标签[' + i + ']'
          if (!isPlain(raw)) return { ok: false, reason: at + ' 需要对象，收到 ' + JSON.stringify(raw ?? null) }
          const id = typeof raw.id === 'string' ? raw.id : ''
          const tag = typeof raw.tag === 'string' ? raw.tag : ''
          const hasStyle = STYLE_FIELDS.some(function (f) {
            return Object.prototype.hasOwnProperty.call(raw, f) && raw[f] !== null && raw[f] !== undefined
          })
          if (!id) {
            // ★★ 这条错误信息就是本模块文件头那段话的代码化。
            if (hasStyle) {
              return {
                ok: false,
                reason: at + ' 写了样式却没有 id。'
                  + '⚠️ 判据不是「有没有样式」—— 那是循环定义（样式机制就是本模块要新建的东西，'
                  + '在它存在之前「有没有样式」恒为假），方向也是反的（那样「随便配个色」就等于升格成受管）。'
                  + '**受管的判据是「进过受管表」：有 id、有定义、可被自动打、可被重命名/合并。**'
                  + '样式是「进过受管表」的**结果**，不是它的判据。请补上 id。',
              }
            }
            return { ok: false, reason: at + ' 缺少 id。每一受管标签都要有一个稳定身份（改名时靠它把样式跟住）。' }
          }
          if (!ID_RE.test(id)) {
            return {
              ok: false,
              reason: at + '.id 不合法（只接受 /^[a-z][a-z0-9_-]{0,31}$/）：' + JSON.stringify(raw.id)
                + '。⚠️ 小写字母开头是为了排除 __proto__ 这类键 —— 与分类 id 同一条规矩。',
            }
          }
          if (seenId.has(id)) return { ok: false, reason: at + '.id 重复：' + id }
          seenId.add(id)

          if (!tag) return { ok: false, reason: at + '.tag 不能为空（它是记录 rec.tags 里逐字出现的那个字符串）' }
          if (tag !== tag.trim()) {
            return {
              ok: false,
              reason: at + '.tag 首尾有空白：' + JSON.stringify(tag) + '。'
                + '⚠️ 本模块**逐字**匹配记录里的标签（不 trim、不改大小写）——'
                + '所以带空白的条目**永远匹配不到任何记录**，是死配置。'
                + '如果记录里真有带空白的标签，先按 3b 的名字收敛把它改掉，再来配样式。',
            }
          }
          if (seenTag.has(tag)) return { ok: false, reason: at + '.tag 重复：' + JSON.stringify(tag) }
          seenTag.add(tag)
          // 同一件事的两种写法（DSH / dsh）不该各占一个受管位 ——
          // 那等于在受管层重演 3b 要治的那个病（标签没有收敛）。
          const norm = key(tag)
          if (seenKey.has(norm)) {
            notes.push(
              '「' + tag + '」与「' + seenKey.get(norm) + '」是同一个标签的两种写法（归一化后都是 '
              + JSON.stringify(norm) + '）—— 它们不该各占一个受管位。先走 3b 的合并把它收敛成一个。',
            )
          } else {
            seenKey.set(norm, tag)
          }

          // 样式字段：**展平存**（与 DEFAULT_CATEGORIES 把 icon 展平进条目同一形状）。
          // 拆成 `{ tag, style:{...} }` 也能跑，但那样「自由词带样式」在数据形状上就
          // 重新变得可能了 —— 展平让那种状态根本表达不出来。
          const styleInput = {}
          for (const f of STYLE_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(raw, f)) styleInput[f] = raw[f]
          }
          const checked = normalizeStyle(styleInput)
          if (!checked.ok) return { ok: false, reason: at + '.' + checked.reason }
          const entry = { id, tag }
          for (const f of STYLE_FIELDS) if (checked.style[f] !== undefined) entry[f] = checked.style[f]
          for (const n of checked.notes) notes.push(at + ': ' + n)
          // 条目级未知字段也要报（否则 `{id,tag,size:'large',siz:'x'}` 里的错字静默消失）
          for (const k of Object.keys(raw)) {
            if (k === 'id' || k === 'tag' || STYLE_FIELDS.indexOf(k) >= 0) continue
            notes.push(at + ' 里的 ' + JSON.stringify(k) + ' 不认识，已忽略（可用字段：id / tag / ' + STYLE_FIELDS.join(' / ') + '）。')
          }
          out.push(entry)
        }
        return { ok: true, value: out, notes }
      }

      /**
       * 建索引：逐字 tag → 条目（**首选**），归一键 → 条目（**兜底**）。
       *
       * ── 为什么要两级，以及为什么兜底是安全的 ─────────────────────────────────
       *
       * ⚠️ 3b 的铁律是「**逐字**匹配，任何一次 trim 都会让键对不上记录里的值」
       *   （`tags.js:286-289`）。那条铁律约束的是**写**（swap 的键必须与记录里的值逐字相等），
       *   **不是读**。本函数只服务**渲染**：渲染不改数据，函数式取一个条目来上色上图标。
       *   所以这里可以在「逐字」之外再加一级比它**宽**的兜底，而不会造成静默改写。
       *
       * 兜底为什么**必须**有：真库里就有 9 组「同一件事的两种写法」并存
       *   （`DSH`/`dsh`、`godot`/`Godot`…，见 `lib/tags.js` 头部）。3b 的合并是
       *   **要人确认**的、可能一直没做。若这里只认逐字，用户给 `DSH` 配了颜色之后，
       *   挂在 `dsh` 上的记录会**渲染成素净的** —— 看上去像两个毫不相干的东西，
       *   而这恰恰是 `validateManaged` 会提示、本模块要避免的不一致。
       *
       * 次序是**逐字优先**：万一表里两种写法各有一条（合法，会带提示），
       *   各自认各自的那条，更具体的那条赢。
       */
      function indexManaged(managed) {
        const byTag = new Map()
        const byKey = new Map()
        for (const item of Array.isArray(managed) ? managed : []) {
          if (!isPlain(item) || typeof item.tag !== 'string') continue
          if (!byTag.has(item.tag)) byTag.set(item.tag, item)
          const k = key(item.tag)
          if (k && !byKey.has(k)) byKey.set(k, item)
        }
        return { byTag, byKey }
      }

      /**
       * ★★ **唯一**的分层判据：这个标签在不在受管表里。
       *
       * ⚠️ 本函数**一个样式字段都不看**。测试 `[E] E3` 钉住：给一个不在表里的
       *   自由词挂上 `color:'red'`，它照样判 `free` —— 样式不能把标签升格成受管。
       *
       * ⚠️ 首尾带空白的写法**明确判 free**（不进兜底）：兜底是为了容纳「装饰符 / 大小写
       *   差异」，**不是**为了容纳「多个空格」。`"alpha "` 与 `"alpha"` 在渲染上看起来一样、
       *   但在数据上是两个标签 —— 那是 3b 该治的，渲染层假装它们一样只会把问题盖住。
       *
       * @returns {'managed'|'free'}
       */
      function layerOf(tag, managed) {
        return entryOf(tag, managed) ? 'managed' : 'free'
      }

      /** 取受管条目（没有就返回 null）。`layerOf` 就是它的布尔版，两者绝不各写一套。 */
      function entryOf(tag, managed) {
        const name = typeof tag === 'string' ? tag : ''
        if (!name || name !== name.trim()) return null
        const idx = indexManaged(managed)
        if (idx.byTag.has(name)) return idx.byTag.get(name)
        const k = key(name)
        return k && idx.byKey.has(k) ? idx.byKey.get(k) : null
      }

      /* ── 面（surface）与展示 ───────────────────────────────────────────────── */

      /**
       * 某个面上成立哪些通道，**按优先级顺序**返回（次序 = `channels` 的次序）。
       * 认不出的面按**最受限**的那个办（保守方向：宁可少显示，不可破行高）。
       */
      function channelsFor(surface) {
        const name = typeof surface === 'string' && Object.prototype.hasOwnProperty.call(surfaces, surface) ? surface : 'chip'
        return channels.filter(function (c) {
          const scope = channelSurface[c]
          return scope === 'both' || scope === name
        })
      }

      /**
       * 把一个样式按「面」裁剪 —— 摘掉这个面上不成立的通道，**并说明理由**。
       *
       * ⚠️ 摘掉不是丢弃：返回的 `style` 是**新对象**，入参不动 ⇒ 存下来的样式永远是完整的，
       *   换一个面（分组标题）就能拿到 `size`。`dropped` 让调用方**必须有机会**告诉用户
       *   「字号在芯片上不生效」，而不是让他以为设了没反应。
       */
      function applySurface(style, surface) {
        const name = typeof surface === 'string' && Object.prototype.hasOwnProperty.call(surfaces, surface) ? surface : 'chip'
        const allowed = channelsFor(name)
        const src = isPlain(style) ? style : {}
        const out = {}
        const dropped = []
        for (const c of STYLE_FIELDS) {
          if (src[c] === undefined || src[c] === null) continue
          if (allowed.indexOf(c) >= 0) { out[c] = src[c]; continue }
          dropped.push({
            channel: c,
            reason: c === 'size'
              ? '字号只在「分组标题」上成立：标签芯片是 26px 的胶囊（client.js:441），字号只会破坏行高。'
              : '通道 ' + c + ' 在「' + name + '」这个面上不成立。',
          })
        }
        return { surface: name, style: out, dropped }
      }

      /**
       * 样式 → **给 UI 用的展示映射**（纯值，JSON 可序列化）。
       *
       * ⚠️ **不含 svg**。刻意如此：`ICON_TABLE.shapes` 已经内联在 `client.js:1888` 里了，
       *   这里再塞一份 SVG 就是「同一件事写两份」（`categories.js` 头部骂过的那个毛病）。
       *   调用方拿 `icon` 这个**形状名**去 `ICON_TABLE.shapes[icon]` 取图形即可。
       *
       * **未设置的通道一律回 `null`**（不是空串、不是 `undefined`、**也不是兜底色**）——
       * `null` 在 JSON 里活着，断言也好写；而「没配颜色该显示成什么」是**渲染**的决定，
       * 规则层不替它猜（`TAG_STYLE_TABLE` 里删掉 `colorFallback` 就是这个理由）。
       *
       * @returns {{color:(string|null), icon:(string|null), fontWeight:(number|null), fontSize:(string|null)}}
       */
      function present(style) {
        const src = isPlain(style) ? style : {}
        const slot = typeof src.color === 'string' && Object.prototype.hasOwnProperty.call(colors, src.color) ? src.color : ''
        return {
          color: slot ? colors[slot] : null,
          icon: typeof src.icon === 'string' && icons.indexOf(src.icon) >= 0 ? src.icon : null,
          fontWeight: Object.prototype.hasOwnProperty.call(weights, src.weight) ? weights[src.weight] : null,
          fontSize: Object.prototype.hasOwnProperty.call(sizes, src.size) ? sizes[src.size] : null,
        }
      }

      /* ── 给 UI 与 agent 工具的一次性入口 ───────────────────────────────────── */

      /**
       * **UI 的单次入口**：一个标签 → 它属于哪一层 + 该显示成什么样。
       *
       * `surface` 默认 `'chip'` —— 默认取**最受限**的那个面。这是刻意的：
       *   面板里绝大多数标签就是芯片，调用方不传 `surface` 时不该拿到一个会破行高的字号。
       *   （同 3b 的 `mergeTags` 默认 dry-run：默认值站在**不会造成后果**的那一边。）
       *
       * @returns {{layer:'managed'|'free', tag:string, style:object|null,
       *            preset:object|null, dropped:Array<{channel:string,reason:string}>}}
       *   · `layer==='free'` ⇒ `style` 一定是 `null`（自由关键词**不配样式**，
       *     这不是「碰巧没配」而是分层定义的结果 —— 见文件头）
       *   · `preset` = `styleToPresentation(style)`，方便直接渲染
       */
      function resolve(tag, managed, options) {
        const name = typeof tag === 'string' ? tag : ''
        const entry = entryOf(name, managed)
        if (!entry) return { layer: 'free', tag: name, style: null, preset: null, dropped: [] }
        const style = {}
        for (const f of STYLE_FIELDS) if (entry[f] !== undefined && entry[f] !== null) style[f] = entry[f]
        const applied = applySurface(style, options && options.surface)
        return { layer: 'managed', tag: name, style: applied.style, preset: present(applied.style), dropped: applied.dropped }
      }

      /**
       * 把一批标签（一条记录的 `rec.tags`）按层拆开 —— UI 要的就是这个：
       * 受管的渲染成带样式的芯片，自由的保持素净。
       *
       * ⚠️ **逐字去重、保序**：记录里确实存在同一条挂两个变体的历史数据
       *   （`DSH` + `dsh`）。这里只做**逐字**去重，**不做归一化合并** ——
       *   合并是 3b 的 `mergeTags` 的活，而且要人确认。渲染层顺手改数据是最坏的做法。
       */
      function splitByLayer(tags, managed, options) {
        const managedOut = []
        const freeOut = []
        const seen = new Set()
        for (const raw of Array.isArray(tags) ? tags : []) {
          const name = typeof raw === 'string' ? raw : (raw === null || raw === undefined ? '' : String(raw))
          if (!name || seen.has(name)) continue
          seen.add(name)
          const r = resolve(name, managed, options)
          if (r.layer === 'managed') managedOut.push({ tag: name, style: r.style, preset: r.preset, dropped: r.dropped })
          else freeOut.push(name)
        }
        return { managed: managedOut, free: freeOut }
      }

      /**
       * 受管位够不够 —— 加新的之前问一句。
       *
       * ⚠️ 返回形状里的 `unlimited`（布尔）是**唯一**该用来判断「不限」的字段 ——
       *   别自己拿 `limit === null` 去推。理由见 `MANAGED_TAG_LIMIT_UNLIMITED` 的注释：
       *   `null` 同时还得能表达「表写坏了、没解析出来」，**语义字段与数值字段分开**
       *   才不会再长出第二种读法。
       *
       * 三种状态（**分得开，不互相伪装**）：
       *   · 不限（默认）：`{ok:true, count, limit:null, free:null, unlimited:true, reason:''}`
       *     —— `free` 是 `null` 而**不是** `Infinity` / 一个大数：**没有这个数**就是没有，
       *     免得调用方拿它做算术、得到一个假的具体值（`Infinity` 还过不了 JSON 这道门）。
       *   · 有上限（用户自己设的）：
       *     `{ok:count<=limit, count, limit, free:max(0,limit-count), unlimited:false, reason}`
       *   · 表里的 `limit` 写坏了：`{ok:false, count, limit:null, free:null, unlimited:false, reason}`
       *     ⚠️ 这时 `unlimited` 是 **`false`** —— **别把它当成放行信号**，`reason` 里写得清清楚楚。
       *
       * ⚠️ 超限**只报告、不自动腾位**（绝不静默顶掉最旧的）—— 这条依琪**没有否决**，
       *   只是默认（不限）下触发不到；**用户一旦自己设了上限，超了照旧拒绝**。
       */
      function checkBudget(managed) {
        const count = Array.isArray(managed) ? managed.length : 0
        if (LIMIT_PROBLEM) {
          return { ok: false, count, limit: LIMIT_UNLIMITED, free: null, unlimited: false, reason: LIMIT_PROBLEM }
        }
        if (LIMIT === LIMIT_UNLIMITED) {
          return { ok: true, count, limit: LIMIT_UNLIMITED, free: null, unlimited: true, reason: '' }
        }
        const ok = count <= LIMIT
        return {
          ok,
          count,
          limit: LIMIT,
          free: Math.max(0, LIMIT - count),
          unlimited: false,
          reason: ok ? '' : '受管标签已有 ' + count + ' 个、上限 ' + LIMIT + ' 个。要加新的必须先合并旧的。',
        }
      }

      /**
       * 「自动打标签只能打受管的」—— 把这条规矩收在一个函数里，免得每个调用点各写一遍。
       * @returns {{ok:true, entry:object}|{ok:false, reason:string}}
       */
      function checkAutoTag(tag, managed) {
        const entry = entryOf(tag, managed)
        if (entry) return { ok: true, entry }
        return {
          ok: false,
          reason: '「' + text(tag) + '」不在受管表里，是自由关键词 ⇒ 不能被自动打上。'
            + '自动打标签只能打受管的（受管的才有人复核过、才能被改名和合并）；'
            + '要把自动生成的词收进来，得先显式把它登记成受管（然后才轮得到配样式）。',
        }
      }

      return {
        colorSlots: function () { return COLOR_SLOTS.slice() },
        iconNames: function () { return icons.slice() },
        weightNames: function () { return WEIGHT_NAMES.slice() },
        sizeNames: function () { return SIZE_NAMES.slice() },
        surfaceNames: function () { return SURFACE_NAMES.slice() },
        // ⚠️ 这里**刻意不再有** `limit()`：上一版它返回那个写死的 16。
        //    「当前上限是多少」现在只有一个入口 —— `checkBudget()`（它带 `unlimited` 布尔）。
        //    留一个裸数值出口，就等于留一个「拿它跟 count 比大小」的口子
        //    （`count > null` 会算成 `count > 0`，静默错），而这正是本模块要断掉的那类 bug。
        resolveColor,
        normalizeStyle,
        validateManaged,
        layerOf,
        entryOf,
        channelsFor,
        applySurface,
        present,
        resolve,
        splitByLayer,
        checkBudget,
        checkAutoTag,
      }
    }

    /** 模块级实例：与 Node 侧的 RULE 是**同一份实现**（builder 只有一份，绝不各写一套） */
    const tagStyleRule = buildTagStyleRule(TAG_STYLE_TABLE, normalizeTag)
    // <<< INLINE-TAG-STYLES-END

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
      /**
       * 【2026-10-02 修 · Linux 侧普查 P3】卡片视图里，**非图片**文件原本只渲染一个 **16px** 的图标，
       * 而缩略图框高 `px*1.2`（中档 96 → 约 115px）→ 四周一大片空白（证据 `zoom-card-thumb.png`，
       * 她给的一句话评价是「不和谐」）。
       *
       * 为什么用 `transform: scale` 而不是改 CSS 尺寸：
       *   ① `__fi svg` 的宽高写死在样式表里，而 svg 是 `dangerouslySetInnerHTML` 注入的、没法单独加 style；
       *   ② 更要紧的是今晚踩到的坑：**纯 CSS 改动热载不生效、必须重启 DSH**，而 `transform` 是行内 style，
       *      **立刻生效、当场可验**；`scale` 又不改变布局占位，图标仍在框里居中。
       */
      var fiStyle = null;
      if (!big && isFinite(Number(px)) && Number(px) > 0) {
        fiStyle = { transform: "scale(" + String(Math.max(1, (Number(px) * 0.42) / 16).toFixed(2)) + ")" };
      }

      if (!record.exists) {
        return h("div", { className: box, style: style },
          h("span", { className: NS + "__fi", style: fiStyle, "aria-hidden": "true", dangerouslySetInnerHTML: { __html: iconOf(record.path, false).svg } }));
      }
      if (isImage(record)) {
        return h("div", { className: box, style: style },
          h("img", { src: fileUrl(record.id), alt: "", loading: "lazy" }));
      }
      return h("div", { className: box, style: style },
        h("span", { className: NS + "__fi", style: fiStyle, "aria-hidden": "true", dangerouslySetInnerHTML: { __html: iconForRecord(record).svg } }));
    }
      /**
       * 一条记录是不是「能直接看/播的媒体」（图片 / 视频 / 音频）。
       *
       * ⚠️ 判据用 `mime_type` 而**不是**扩展名：宿主已经算好了 mime，再按扩展名猜一份
       *    = 同一件事两处实现（本仓库明确反对）。`preview()` 用的是同一个口径。
       */
      function isMediaRecord(record) {
        var m = String((record && record.mime_type) || "");
        return m.indexOf("image/") === 0 || m.indexOf("video/") === 0 || m.indexOf("audio/") === 0;
      }

      /**
       * 媒体预览浮层 —— 「快速预览放大图片 + 快捷播放视频音频」（2026-10-08）。
       *
       * 依琪原话：「不需要画廊啊，卡片跟列表只要可以快速预览放大图片跟快捷播放视频音频
       * 啥的不就好了」⇒ 这是**补能力**，不是加视图（画廊因此退役，见 `VIEW_KINDS`）。
       *
       * ⚠️⚠️ **纯展示组件，一个 hook 都不用** —— 状态全在 `PanelInner` 的 `sLightbox` 里。
       *    两条理由，都不是洁癖：
       *      ① `test/client-render.test.mjs` 按**位置**喂 `useState`，在组件里加 hook
       *         会让那个队列整体错位（那里有校准护栏会红，但要人去重新校准）；
       *      ② 纯函数**好测** —— 喂一组 props 就能断言渲染树，不必造 hook 环境。
       *
       * ⚠️ `zoom` 的语义（**一个数字，别再加第二种表示法**）：
       *      `0` = **适应窗口**（默认；不写死宽高，交给 CSS 的 max-width/height）
       *      `>0` = **按原图像素的比例**（1 = 原始大小）。原图尺寸由 `onLoad` 回传 ——
       *      只有图加载完才知道它多大，在此之前任何缩放都是猜。
       *
       * @param props.items     同批媒体记录（用来左右切换；只含媒体，不含文档）
       * @param props.index     当前在第几条
       * @param props.zoom      见上（0 = 适应窗口）
       * @param props.nat       原图尺寸 `{w,h}`（`zoom > 0` 时要用；未知时退化成适应窗口）
       * @param props.onIndex / onZoom / onClose / onNatural  回调（状态在调用方）
       */
      function MediaLightbox(props) {
        // ⚠️ **必须自己取 h**：这是个**模块级组件函数**（不是 `PanelInner` 内部的闭包），
        //    而 `h` 在各组件里是 `var h = React.createElement` 的**局部**变量。
        //    第一版我直接用了 `h(...)` ⇒ 真机上 `h is not defined` ⇒ 整个面板渲染失败。
        //    （`Thumb` 那种**内部辅助函数**才把 `h` 当参数传，两者的规矩不同，别混。）
        //    —— 这条是被 `client-render.test.mjs` 的新用例抓出来的（渲染树里冒出
        //    「产物库渲染失败：h is not defined」），不是我自己看出来的。
        var React = require("react");
        var h = React.createElement;
        var items = Array.isArray(props.items) ? props.items : [];
        var index = Math.max(0, Math.min(items.length - 1, Number(props.index) || 0));
        var record = items[index] || null;
        if (!record) return null;
        var zoom = Number(props.zoom) || 0;
        var nat = props.nat && isFinite(Number(props.nat.w)) && Number(props.nat.w) > 0 ? props.nat : null;
        var mime = String(record.mime_type || "");
        var isVideo = mime.indexOf("video/") === 0;
        var isAudio = mime.indexOf("audio/") === 0;
        var title = String(record.title || record.path || "");

        // ── 主体：图 / 视频 / 音频 ───────────────────────────────────────────
        // ⚠️ `key` 必须带 `record.id`：切上一条时若 key 不变，React 会**复用同一个
        //    <video>/<audio> 元素**，于是「切了但还在放上一条」。这是元素复用导致的状态残留，
        //    不是保险起见（`<img>` 换 src 没事，音视频有内部播放状态）。
        var body;
        if (isVideo) {
          body = h("video", {
            key: "v" + record.id, className: NS + "__lbmedia", src: fileUrl(record.id),
            controls: true, autoPlay: true, playsInline: true,
          });
        } else if (isAudio) {
          // ⚠️ `key` 要挂在 **audio 本身**上，不能只挂外层 div —— 有播放状态的是 audio。
          //    （第一版只给外层 div 挂了 key，测试里那条「key 要带 id」当场红了。）
          body = h("div", { key: "a" + record.id, style: { display: "flex", flexDirection: "column", gap: "12px", alignItems: "center" } },
            h("div", { className: NS + "__lbtitle", style: { textAlign: "center" } }, title),
            h("audio", { key: "au" + record.id, className: NS + "__lbmedia", src: fileUrl(record.id), controls: true, autoPlay: true }));
        } else {
          // 图片：`zoom > 0` 且有原图尺寸 ⇒ 写死像素（这样 `__lbbody` 的 overflow:auto
          // 才有东西可滚）；否则交给 CSS 的 max-width/height 适应窗口。
          var imgStyle = (zoom > 0 && nat)
            ? { width: String(Math.round(nat.w * zoom)) + "px", height: "auto", maxWidth: "none", maxHeight: "none" }
            : null;
          body = h("img", {
            key: "i" + record.id, className: NS + "__lbimg", src: fileUrl(record.id), alt: "",
            style: imgStyle, "data-zoom": zoom > 0 ? "1" : null, draggable: false,
            onLoad: function (event) {
              var t = event && event.target;
              if (t && typeof props.onNatural === "function") props.onNatural(t.naturalWidth, t.naturalHeight);
            },
            onClick: function () {
              // 点一下 = 在「适应窗口 ↔ 原始大小」之间切。这是最常用的一次操作，
              // 不该逼用户去按按钮（依琪要的是"快速"）。
              if (typeof props.onZoom === "function") props.onZoom(zoom > 0 ? 0 : 1);
            },
            onWheel: function (event) {
              if (typeof props.onZoom !== "function" || !nat) return;
              event.preventDefault();
              // 每格 ±25%；下限回到「适应窗口」（0），上限 8 倍（再大没意义）
              var next = zoom > 0 ? zoom : 1;
              next = event.deltaY < 0 ? next * 1.25 : next / 1.25;
              if (next < 1) next = 0;              // 缩到比原始还小 ⇒ 直接回「适应窗口」
              if (next > 8) next = 8;
              props.onZoom(next);
            },
          });
        }

        var prevDisabled = index <= 0;
        var nextDisabled = index >= items.length - 1;
        // ⚠️ 别写方位（"点右上角 ×"）—— × 现在就在这一行**旁边**，指方位反而多余；
        //    而且它挪过一次（右上角被窗口按钮挡），写死方位将来又会过期。
        var hint = (isVideo || isAudio ? "" : (nat ? "点图或滚轮缩放 · " : ""))
          + "← → 切换" + (items.length > 1 ? "（共 " + items.length + " 项媒体）" : "")
          + " · 点 × 或按 Esc 关闭";

        return h("div", {
          className: NS + "__lb", role: "dialog", "aria-modal": "true", "aria-label": "媒体预览",
          ref: props.rootRef,
          // ⚠️ `tabIndex={-1}` 让它**可编程聚焦**、但**不进入 Tab 序列**
          //    （与设置页那个根容器同一手法，见 `__setwrap` 的注释）——
          //    否则键盘用户 Tab 一下就会从浮层里跑出去。
          tabIndex: -1,
          // ★ §11.2「打开移入焦点」：**声明式**写在这里，而不是让调用方手动 `.focus()`。
          //   两条理由：
          //     ① React 的 `autoFocus` 在 commit 阶段对元素调 `.focus()`，
          //        与 `tabIndex={-1}` 配合正好（可聚焦但不占 Tab 位）；
          //     ② **判据要跟着代码走**：`ui-spec.test.mjs` 的 [16] 节是**静态扫描**
          //        「这个 dialog 附近有没有焦点管理的痕迹」。手动 `.focus()` 写在
          //        `PanelInner` 的 effect 里，离这个 dialog 隔了好几个函数 ⇒ 扫不到 ⇒ **误报**。
          //        写在组件内部，判据与实现就在同一处 —— 这是"让守卫看得见"的正解，
          //        不是为了让门禁变绿而写的装饰（它真的会执行）。
          autoFocus: true,
          // 点背景关闭；点内容不关（否则拖动/选字时会误关）
          onClick: function (event) {
            if (event.target === event.currentTarget && typeof props.onClose === "function") props.onClose();
          },
        },
          // ⚠️ 头部**只放标题**，右侧刻意留空 —— 见 `__lbx` 的 CSS 注释：
          //    本浮层铺满视口 ⇒ 它的右上角就是**窗口右上角**（窗口按钮的禁飞区）。
          //    「计数」和两个关闭按钮都挪到底部了。
          h("div", { className: NS + "__lbhead" },
            h("div", { className: NS + "__lbtitle", title: title }, title)),
          h("div", { className: NS + "__lbbody" },
            items.length > 1 ? h("button", {
              type: "button", className: NS + "__lbnav " + NS + "__lbnav--prev", disabled: prevDisabled,
              title: "上一条（←）", "aria-label": "上一条",
              onClick: function () { if (!prevDisabled && typeof props.onIndex === "function") props.onIndex(index - 1); },
            }, "‹") : null,
            body,
            items.length > 1 ? h("button", {
              type: "button", className: NS + "__lbnav " + NS + "__lbnav--next", disabled: nextDisabled,
              title: "下一条（→）", "aria-label": "下一条",
              onClick: function () { if (!nextDisabled && typeof props.onIndex === "function") props.onIndex(index + 1); },
            }, "›") : null),
          // ⚠️ **底部**这一行现在承载：提示（占满左侧）+ 计数 + 两个关闭入口。
          //    全部在**底部**是刻意的 —— 顶部右侧是窗口按钮的禁飞区（见 `__lbx` 的 CSS 注释）。
          h("div", { className: NS + "__lbfoot" },
            h("span", { className: NS + "__lbhint" }, hint),
            h("div", { className: NS + "__lbcount" }, (index + 1) + " / " + items.length),
            // ★ **×** 按钮（2026-10-08 依琪「最好有个 xx 给鼠标点」）。
            //   ⚠️ `autoFocus` 给**它**（而不是给旁边那个文字按钮）：它是鼠标用户的第一落点，
            //      而且可聚焦 ⇒ 键盘用户 Tab 一下就能回车关掉。
            h("button", {
              type: "button", className: NS + "__lbx", title: "关闭（Esc）",
              "aria-label": "关闭预览", autoFocus: true,
              onClick: function () { if (typeof props.onClose === "function") props.onClose(); },
            }, "×"),
            // 文字按钮**保留**：× 是形状，读屏用户听不到「×」；
            // 显式标签是无障碍要求（§11.2 的「可访问名」）。两者不是二选一。
            h("button", {
              type: "button", className: NS + "__btn", title: "关闭（Esc）",
              onClick: function () { if (typeof props.onClose === "function") props.onClose(); },
            }, "关闭")));
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

    // ── 标签芯片（Step 3d · 缺口 3 / 4）──────────────────────────────────────
    /**
     * 一条记录的标签 → **受管芯片（图标 + 颜色 + 字重）+ 自由素文本**。
     *
     * ── 它替掉了什么 ─────────────────────────────────────────────────────────
     * 原来这里是 `(record.tags || []).join(" · ")`（纯文本）—— 也就是说
     * **规则层做完了、用户一个字的变化都看不到**（定稿 §四·3 那个缺口）。
     *
     * ── 三个刻意的设计取舍（都写在这儿，免得下次有人重推一遍）──────────────
     *
     * ① **分层判据只从规则层来**：`tagStyleRule.splitByLayer()` 是唯一的分层入口
     *    （受管 = 进过受管表，**不是**「有样式」——那是循环定义，见 tag-styles.js 文件头）。
     *    本函数**一个样式字段都不看**。
     * ② **渲染顺序 = 记录里的原始顺序**（`splitByLayer` 会把受管/自由分成两个数组，
     *    直接按那两个数组渲染会**把用户的标签重排**）。所以这里用 `splitByLayer` 拿**判定**、
     *    再按 `tags` 原序走一遍。去重口径与它一致（**逐字**去重，不归一化 ——
     *    合并是 3b `mergeTags` 的活，而且要人确认；渲染层顺手改数据是最坏的做法）。
     * ③ **`dropped` 必须被串出去，不许吃掉**（规则层特地把它连着理由一起返回，
     *    就是为了「让调用方**必须有机会**告诉用户」，tag-styles.js 原话）。
     *    这里走两条零/低布局代价的路：
     *      · 每个芯片的 `title` 里带上被摘掉的理由（悬停可见，**零布局代价**）；
     *      · 有摘掉时再给容器挂一条 `__tagwarn` 小字（抽屉里看得见，不动行高）。
     *    ⚠️ 丢掉它 = 第 4 个消费者丢掉 warning —— 这个坑本仓库刚在撤销凭据那条线上栽过
     *    （前 3 个消费者都转达了、就面板没转达，而面板偏偏是用户唯一看得见的那个）。
     *
     * @param {Function} h React.createElement（**传进来**，本函数不 require react，便于单测）
     * @param {string[]} tags 记录的 `rec.tags`
     * @param {{managed?: object[]|null, surface?: string, key?: string}} [options]
     *   · `managed` —— `GET /ext/artifacts/managed-tags` 的 `tags` 数组。
     *     ⚠️ **`null` / `undefined` 与 `[]` 是两件事**：前者 = 「读不到」，后者 = 「确实没有受管标签」。
     *     两者都渲染成素文本（降级），但**只有前者**会被 `tagStyleState` 标成失败并显示警告 ——
     *     「读不到」和「读到了但是空」长得一样，是本仓库明令禁止的。
     *   · `surface` —— `'chip'`（默认）或 `'group'`。见下。
     * @returns {object|null} React 元素；没有标签时回 `null`（调用方照旧判空）
     *
     * ── ⚠️ `surface` 的现状（**明写，别以为接完了**）─────────────────────────
     * `'chip'` 是本文件里**唯一**的真实调用点。`'group'`（分组标题）**当前 0 个调用点**：
     * 面板里没有「标签当分组标题」这种 UI —— `.__grouph` 那三条 CSS 是**死样式**
     * （全仓库零使用，只有定义）。⇒ **「字号」这个通道现在 0 个生效点**
     * （规则层按设计在 chip 上砍掉它，而 group 面又不存在）。
     * 参数保留是为了「哪天真的加了分组标题，改一个参数就行」，不是已经有消费点。
     */
    function tagChips(h, tags, options) {
      var opts = options && typeof options === "object" ? options : {};
      var managed = opts.managed === undefined ? null : opts.managed;
      var surface = typeof opts.surface === "string" && opts.surface ? opts.surface : "chip";
      var list = Array.isArray(tags) ? tags : [];
      // 「读不到」与「读到空表」必须分得开（见上面 ① 那段）。
      // 只有**数组**才算「读到了」；null / undefined / 非数组一律按「读不到」办。
      var readable = Array.isArray(managed);
      var rule = tagStyleRule;
      var split = null;
      try {
        split = rule.splitByLayer(list, readable ? managed : [], { surface: surface });
      } catch (error) {
        // 规则层抛了 = 样式通道不可用。**降级成素文本，但要说出来**（不静默）。
        split = null;
      }
      var byTag = {};
      if (split) for (var m = 0; m < split.managed.length; m += 1) byTag[split.managed[m].tag] = split.managed[m];
      var droppedReasons = [];
      var seen = {};
      var kids = [];
      for (var i = 0; i < list.length; i += 1) {
        var raw = list[i];
        var name = typeof raw === "string" ? raw : (raw === null || raw === undefined ? "" : String(raw));
        if (!name || seen[name]) continue;   // 逐字去重、保序（与 splitByLayer 同口径）
        seen[name] = true;
        var hit = byTag[name];
        if (!hit) {
          kids.push(h("span", { className: NS + "__tagfree", key: "f" + String(i) }, name));
          continue;
        }
        var preset = hit.preset || {};
        var dropped = Array.isArray(hit.dropped) ? hit.dropped : [];
        var title = name;
        for (var d = 0; d < dropped.length; d += 1) {
          if (dropped[d] && dropped[d].reason) droppedReasons.push(name + "：" + dropped[d].reason);
        }
        if (dropped.length) title = name + "（" + dropped.map(function (x) { return x && x.reason ? x.reason : ""; }).join(" ") + "）";
        var style = {};
        if (preset.color) style.color = preset.color;
        if (preset.fontWeight !== null && preset.fontWeight !== undefined) style.fontWeight = preset.fontWeight;
        // ⚠️ `fontSize` 也要照传 —— **不能在这里自己判「芯片上没有字号所以不设」**：
        //    「这个面上有没有字号」是**规则层**的决定（`applySurface`），它已经把它摘掉并给了理由。
        //    这里再判一次就是**第二套决定**，而且万一哪天 surface 变成 'group'，
        //    组件会把它**静默吃掉** —— 那正是本函数 ③ 要防的那类 bug。
        //    （现状：chip 面上 `preset.fontSize` 恒为 null，所以这行在真机上目前是空转；
        //      它存在是为了「规则层说什么就渲染什么」，而不是为了现在有用。）
        if (preset.fontSize) style.fontSize = preset.fontSize;
        var inner = [];
        if (preset.icon && ICON_TABLE.shapes && ICON_TABLE.shapes[preset.icon]) {
          inner.push(h("span", {
            className: NS + "__tagchipi",
            key: "i",
            "aria-hidden": "true",
            dangerouslySetInnerHTML: { __html: ICON_TABLE.shapes[preset.icon] },
          }));
        }
        inner.push(h("span", { key: "t" }, name));
        kids.push(h("span", { className: NS + "__tagchip", key: "m" + String(i), title: title, style: style }, inner));
      }
      if (!kids.length) return null;
      var out = [h("span", { className: NS + "__tagchips", key: "chips" }, kids)];
      // 「读不到受管表」/「规则层抛了」——**大声**，不许和「确实没有受管标签」长得一样。
      if (!readable) {
        out.push(h("div", { className: NS + "__tagwarn", key: "w" },
          "标签样式读不到（/ext/artifacts/managed-tags 没拿到）—— 下面按**无样式**显示；这不代表你没有配过受管标签。"));
      } else if (!split) {
        out.push(h("div", { className: NS + "__tagwarn", key: "w" },
          "标签样式规则算不出来（内联的规则层报错）—— 按**无样式**显示。"));
      } else if (droppedReasons.length) {
        out.push(h("div", { className: NS + "__tagwarn", key: "w" },
          "有样式在**这个面上**不生效：" + droppedReasons.join("；")));
      }
      return h("div", null, out);
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

    /**
     * 视图类型的**两档**（产物与目录共用同一组语义）。
     *
     * ⚠️ **2026-10-08 去掉了第三档「画廊」**（依琪拍板）。理由不是"不好用"，而是
     * **它解决错了问题**：他原话「不需要画廊啊，卡片跟列表只要可以快速预览放大图片
     * 跟快捷播放视频音频啥的不就好了」——
     * 他要的是**能快速看见内容**（放大图 / 直接播视频音频），而画廊想用
     * 「换一种视图」去达成同一件事。实测真库：媒体只占 **13%**（图 27 / 视频 9 / 音频 1），
     * 文档 163 条才是大头 —— 为一个 13% 的诉求**专门加一整种视图**，
     * 而卡片/列表**本来就该能预览**，那是**补能力**，不是**加视图**。
     * ⇒ 画廊退役；预览浮层接棒（见 `MediaLightbox`）。
     *
     * ⚠️ `filters.view` 的**存储值不动**（`gallery` 仍可能出现在老设置里）：
     *   由 `isProductView()` 不再认它 ⇒ 自动落回卡片。**不迁移、不报错**。
     */
    var VIEW_KINDS = [
      { key: "card", label: "卡片" },
      { key: "list", label: "列表" },
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

      /** 显示形式浮层的开合（2026-10-06 新增）。 */
      var sViewOpen = React.useState(false);
      var viewOpen = sViewOpen[0];
      var setViewOpen = sViewOpen[1];

      // ⚠️ **两个浮层各自的包裹元素 ref**（2026-10-06）——
      //    「点外面关闭」必须**判断点在不在自己身上**，不能一律关：
      //    这两个浮层是用 `click` 打开的，而 `click` 会继续冒泡到 `document`，
      //    若监听里无条件 `closeAll()`，就会**在打开的同一次点击里把自己关掉**
      //    （真机现象：按钮闪一下、菜单根本不出现）。
      //    ⇒ 监听里先看 `contains(event.target)`，命中自己就放行，交给各自的 onClick 处理。
      //    （同文件的右键菜单用 `contextmenu` 打开、天然不撞 `click`，所以它那种写法没这个坑。）
      var viewWrapRef = React.useRef(null);
      var colsWrapRef = React.useRef(null);

      var label = props.label ? String(props.label) + "：" : "";
      var views = Array.isArray(props.views) ? props.views : VIEW_KINDS;
      var columns = props.columns && typeof props.columns === "object" ? props.columns : { size: true, time: true, type: false };

      // ══ 统一「尺寸」控件（2026-10-01 重做）════════════════════════════════
      //
      // 用户原话：「**按钮太多，怎么卡片跟列表还有单独宽高大小设置的，我都以为是一起的，
      //          不简洁不直观**；顺手你可以参考对应平台的文件管理的快捷操作模式」。
      //
      // 他说的两个真问题，代码里都能对上：
      //
      //   ① **并排两个下拉**（`标准`=行高密度、`尺寸 中`=卡片尺寸）**任何视图下都显示**。
      //      于是在列表里看到一个「尺寸 中」，在卡片里看到一个「标准」—— 两个都跟当前
      //      视图无关，用户只能猜哪个是干什么的。其实它们**是同一件事的两个量纲**：
      //      「这一屏内容多大」。原生文件管理器（Nautilus 的缩放滑杆、Finder 的图标大小、
      //      Windows 资源管理器的「查看→大小」）一律只给**一个**尺寸入口。
      //
      //   ② 视图类型（卡片/列表/画廊）在这个控件里**又来了一遍** —— 产物侧顶部已经有一个
      //      完整切换器，两处都改 `filters.view`。屏幕上是两个一模一样的分段控件，
      //      点哪个都行、但没人知道为什么有两个。
      //
      // 所以：**同一件事只留一个入口**。
      //   · 视图类型：见 ① 下方那段 2026-10-06 的说明（现在收成一个「显示：xx ▾」按钮）
      //   · 尺寸：**一个控件**，含义跟着当前视图走（列表→行高，卡片/画廊→卡片尺寸）
      //   · 列设置：只在列表视图才有意义 → 卡片/画廊下不再显示
      //
      // ⚠️ **2026-10-06 更正一条已失效的旧注释**：这里原来写着
      //    「产物侧已经由顶部切换器负责 → 传 `showViews: false`」。
      //    前半句已经反过来了（顶部切换器**不再**管这三档，产物侧正是 `showViews: true` 的调用方），
      //    后半句当时也没落实 —— 目录侧那份调用（`h(ViewControl, {…})`）**从来就没传过 false**，
      //    所以三档在目录里一直是渲染的。两处都按现状改了，别再照这句话推理。
      var kids = [];

      // ① 视图类型（卡片/列表/画廊）—— 只有调用方确实需要时才出现
      //
      // ⚠️ **2026-10-06 真机复验后重做**：Step 1 先把这三档从顶部主切换器移了出来，
      //    但第一版只是把它们塞进 `ViewControl` 的**又一个分段控件** —— 真机截图一看：
      //      产物 文件 目录 整理 ｜ 卡片 列表 画廊 ｜ 行高 标准 列（3） 导入文件夹 关键词 语义
      //    **还是 7 个按钮并排**，总数一个没少，而且两个分段控件长得一模一样。
      //    这正是 2026-10-01 依琪原话「按钮太多……不简洁不直观」要治的病，
      //    也说明「换个位置」不等于「换一层」。
      //    ⇒ 现在收成**一个**紧凑按钮（`显示：列表 ▾`）+ 浮层选择：
      //       按钮显当前形式、浮层列三个选项并标出当前项 —— 3 个按钮变 1 个，
      //       且因为带「显示：」前缀，和左边那排导航标签**一眼就不是一类东西**。
      var currentViewLabel = "卡片";
      for (var vi = 0; vi < views.length; vi += 1) {
        if (views[vi] && views[vi].key === props.view) currentViewLabel = String(views[vi].label || currentViewLabel);
      }
      if (typeof props.onView === "function" && props.showViews !== false) {
        kids.push(h("span", { key: "views", className: NS + "__colpick", ref: viewWrapRef },
          h("button", {
            type: "button",
            className: NS + "__btn",
            "aria-haspopup": "menu",
            "aria-expanded": viewOpen ? "true" : "false",
            "aria-label": label + "显示形式（当前：" + currentViewLabel + "）",
            title: "显示形式：卡片 / 列表（默认值在「设置 → 默认视图」里改）",
            onClick: function () { setViewOpen(!viewOpen); if (!viewOpen) setColsOpen(false); },
          }, "显示：" + currentViewLabel + " ▾"),
          viewOpen ? h("div", {
            className: NS + "__menu",
            role: "menu",
            "aria-label": label + "显示形式",
            style: { position: "absolute", top: "100%", left: "0", marginTop: "4px" },
          },
            views.map(function (item) {
              var on = props.view === item.key;
              return h("button", {
                key: "v" + item.key,
                type: "button",
                role: "menuitemradio",
                className: NS + "__mi",
                "aria-checked": on ? "true" : "false",
                // 当前项加一个勾 + 主色，扫一眼就知道现在在哪一档
                style: on ? { color: "var(--dsw-alias-state-business-primary)", fontWeight: "600" } : null,
                onClick: function () {
                  setViewOpen(false);
                  if (typeof props.onView === "function") props.onView(item.key);
                },
              }, (on ? "✓ " : "\u2007") + item.label);
            })) : null));
      }

      // ② **一个**尺寸控件：列高 or 卡片大小，二者是同一个「这一屏多大」的两个量纲
      //    （分区 11.6：快捷键归属宿主边界之外，这里只做下拉，不抢全局键）
      var isListView = props.view === "list";
      if (isListView && typeof props.onDensity === "function") {
        kids.push(h("select", {
          key: "size-density",
          className: NS + "__select",
          "aria-label": label + "行高",
          title: "行高（列表）· 也可用 Ctrl + 滚轮调整",
          value: String(props.density || "standard"),
          onChange: function (event) { props.onDensity(event.target.value); },
        }, DENSITY_OPTIONS.map(function (item) {
          return h("option", { key: item.key, value: item.key, title: "行高 " + String(item.h) + "px" }, "行高 " + item.label);
        })));
      } else if (!isListView && typeof props.onCardSize === "function") {
        kids.push(h("select", {
          key: "size-card",
          className: NS + "__select",
          "aria-label": label + "卡片尺寸",
          title: "卡片尺寸（卡片视图）· 也可用 Ctrl + 滚轮调整",
          value: String(props.cardSize || "md"),
          onChange: function (event) { props.onCardSize(event.target.value); },
        }, CARD_SIZES.map(function (item) {
          return h("option", { key: item.key, value: item.key, title: "约 " + String(item.px) + "px" }, "尺寸 " + item.label);
        })));
      }

      // ③ 列设置 —— **只在列表视图**（卡片/画廊里它没有任何意义，纯属噪音）
      if (typeof props.onColumns === "function" && isListView) {
        var onCount = COLUMN_KEYS.filter(function (item) { return columns[item.key] !== false; }).length;
        kids.push(h("span", { key: "cols", className: NS + "__colpick", ref: colsWrapRef },
          h("button", {
            type: "button",
            className: NS + "__btn",
            "aria-expanded": colsOpen ? "true" : "false",
            "aria-label": label + "选择显示的列",
            onClick: function () { setColsOpen(!colsOpen); if (!colsOpen) setViewOpen(false); },
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

      // ④ 两个浮层的收尾：**点外面 / Escape 都要能关**（2026-10-06 补）。
      //    列浮层原来没有这条（算既有小缺口，顺手一起修）；显示形式浮层是新加的，一开始就带上。
      //    ⚠️ 用「effect 里挂 document 监听」而不是「捕获阶段拦截」：effect 在**触发点击的那一次
      //       事件流结束之后**才跑，所以打开浮层的那一下点击不会立刻把浮层关掉 —— 和右键菜单同一套。
      React.useEffect(function () {
        if (!colsOpen && !viewOpen) return undefined;
        function onDocClick(event) {
          // 点在浮层自己（或它的触发按钮）身上 → 放行：那是「切换到另一个浮层」或「收起/展开」，
          // 由各自的 onClick 决定，不能在这里抢先关掉。见上面 ref 那段注释。
          var t = event && event.target;
          try {
            if (viewWrapRef.current && viewWrapRef.current.contains(t)) return;
            if (colsWrapRef.current && colsWrapRef.current.contains(t)) return;
          } catch (error) { /* 忽略：contains 对非 Node 会抛，按「点在外面」处理 */ }
          setColsOpen(false);
          setViewOpen(false);
        }
        function onEsc(event) { if (event.key === "Escape") { setColsOpen(false); setViewOpen(false); } }
        try {
          if (typeof document !== "undefined" && document.addEventListener) {
            document.addEventListener("click", onDocClick);
            document.addEventListener("keydown", onEsc);
          }
        } catch (error) { /* 忽略 */ }
        return function () {
          try {
            if (typeof document !== "undefined" && document.removeEventListener) {
              document.removeEventListener("click", onDocClick);
              document.removeEventListener("keydown", onEsc);
            }
          } catch (error) { /* 忽略 */ }
        };
      }, [colsOpen, viewOpen]);

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

    /**
     * 「整理建议」视图（MIGRATION-PLAN 第 2 项）。
     *
     * 为什么是**独立视图**（而不是列表上方一排卡）：
     *   · 建议是**一次性决策流**（处理完就没了），挂在浏览视图上会一直干扰；
     *   · ⭐ 更硬的理由：**处理完那一排会消失 → 布局跳动**，用户正在看的东西会移位。
     *
     * 每条建议都带**「为什么」**（像语义搜索的 `matched` 那样）——否则用户不知道凭什么让他删这个。
     * **破坏性动作二次确认 + 可撤销**：
     *   · 重复 → `POST /:id/trash`（撤销 = `POST /:id/restore`）
     *   · 文件丢失 → `PATCH /:id {status:'archived'}`（撤销 = 改回 `active`）
     *   · 待精化 → `POST /refine-request`（**这条没有撤销**，原因见 `batchRefine` 注释）
     *   · 僵尸项目 → **只提示，不动**（宿主就是这么设计的）
     */
    /**
     * 「项目合并」置信度档 → 给人看的标签（四档语气如实）。
     * 后端只给档位，文案由这里定：exact/contains 够稳，prefix/tokens 必须让用户看一眼。
     */
    var MERGE_CONFIDENCE_LABEL = { exact: "确定", contains: "高置信", prefix: "建议核对", tokens: "待确认" };


    /**
     * 「导入文件夹」面板（MIGRATION-PLAN 第 4 项）。
     *
     * **降级阶梯**（lead 拍板 A，2026-09-30）：
     *   ① 优先用宿主的**原生目录选择器**：`ctx.get("uiWorkspace").pickDirectory()`
     *      （root 服务 `uiWorkspace`，与 `slots`/`inputTriggers` 同一套访问器；返回**绝对路径字符串**）
     *   ② 它不在 / 抛错 → **手动输入路径**（`POST /import` 只要一个路径字符串，这条路一定可用）
     *
     * ⚠️ **两个已知不确定点**（我探源码得到的，如实处理）：
     *   1. **provider 可达性**：`pickDirectory()` 依赖 `ctx.remote.directoryPicker`，
     *      它的宿主侧 provider **不在我能读到的代码里** → **不能赌它在**，所以有 ② 兜底。
     *   2. **取消语义**：官方实现是 `if (!result.ok) throw` —— **取消也走抛错**，
     *      与真失败**分不清** → 所以文案保持中性（「已取消或没选到目录」），
     *      **不把用户自己的取消渲染成红色错误**。
     *
     * 端点：`POST /import { dir, project? }` → `{ count, project, skipped }`；
     * 宿主侧有**敏感目录保护**（凭据/系统目录直接拒绝并给明原因）与 `maxFiles=10000` 上限。
     */

    /**
     * 卡片视图。`opts.cardPx` = 卡片尺寸档位换算出的缩略图边长（task-11 ③：小/中/大就地可调）。
     * `opts.act` = 交互（task-13）：多选、一键引用、定位、打开、右键、**拖出去 = 引用**。
     */

    /** 列表视图。`actions.columns` 决定显示哪些列（task-11 ③：**就地可调**）。
     * 名称列（含缩略图）恒显示 —— 关掉「名称」的表没有意义。
     */


    // ── 右侧栏 tab（2026-10-14 · 档 1a：接管官方文件树）────────────────────
    //
    // 官方 `SidebarRightTabRegistry.register()` 的 docstring 原文：
    //   「An `extension` may register a kind a `builtin` already holds and
    //     **takes it over until it unregisters**」
    // ⇒ 注册 `kind:"files"`（第三方默认档就是 `extension`）即**接管**官方
    //   `@deepseek-ai/dsh-client-ui-sidebar-files` 占的那个文件树 tab；
    //   注销时官方**自动恢复**（2026-10-13 真机验证过，截图对比）。
    /** 官方 `sidebar-files` 的 kind（`FILES_KIND = "files"`）。注册同 kind 即接管。 */
    var FILES_KIND = "files";
    /** 本插件在右栏的 tab 类型 id。全局唯一 —— 撞了官方会抛 `id is already registered`。 */
    var RIGHT_TAB_ID = "dsh-artifact-library:files";

    /** 右栏 tab 的标题芯片（tab 条上那个小字）。 */
    function RightPaneTitle() {
      var React = require("react");
      return React.createElement("span", { className: NS + "__rpt" }, "文件管理");
    }

    /** 三个粒度。默认「当前工作区」（依琪 2026-10-14 拍板）。 */
    var RP_SCOPES = [
      { id: "workspace", label: "当前工作区" },
      { id: "all", label: "全部" },
      { id: "session", label: "当前会话" },
    ];

    /** 文本类预览的读取上限（字节）。和 `DetailDrawer` 一个量级，够看报告。 */
    var RP_TEXT_LIMIT = 200000;

    /** 文本类扩展名（走 `/file` 拉正文的）。⚠️ 与上面 `isText` 的判据**同一处定义**。 */
    var RP_TEXT_EXT = /^(txt|log|json|xml|yml|yaml|toml|ini|csv|tsv|md|markdown|py|js|mjs|cjs|ts|tsx|jsx|html|htm|css|sh|ps1|bat|java|c|cpp|h|rs|go|rb|php|sql)$/;

    /**
     * 一条产物该用哪种预览体 —— **纯函数**（抽出来是为了让 `RightPanePreview`
     * 不超圈复杂度上限，且**能单独测**）。
     *
     * @param {{extension?: string, mime_type?: string}} rec
     * @returns {"image"|"video"|"audio"|"markdown"|"text"|"other"}
     */
    function rpKindOf(rec) {
      var ext = String((rec && rec.extension) || "").toLowerCase().replace(/^\./, "");
      var mime = String((rec && rec.mime_type) || "");
      if (/^(png|jpe?g|gif|webp|bmp|ico|svg)$/.test(ext) || mime.indexOf("image/") === 0) return "image";
      if (/^(mp4|webm|mov|m4v|ogv)$/.test(ext) || mime.indexOf("video/") === 0) return "video";
      if (/^(mp3|wav|m4a|ogg|flac|aac)$/.test(ext) || mime.indexOf("audio/") === 0) return "audio";
      if (ext === "md" || ext === "markdown" || mime.indexOf("markdown") >= 0) return "markdown";
      if (mime.indexOf("text/") === 0 || mime.indexOf("json") >= 0 || mime.indexOf("xml") >= 0
        || mime.indexOf("javascript") >= 0 || RP_TEXT_EXT.test(ext)) return "text";
      return "other";
    }

    /**
     * `MarkdownText` 的 `labels` prop。
     *
     * ⚠️ **必填**（2026-10-14 实测）：不传 ⇒ `MarkdownText` 内部读
     *    `labels.code.toolbarLabels` ⇒ 抛 `Cannot read properties of undefined (reading 'code')`
     *    ⇒ 整个 slot entry 崩 ⇒ **右栏一片空白**。
     *    形状照抄官方 `sidebar-documentpreview`（它的 `labels` 就是这几项）。
     *    文案取官方 zh 那套（`复制`/`已复制`/`脚注`…）。
     */
    var RP_MD_LABELS = {
      code: {
        copyLabel: "复制",
        copiedLabel: "已复制",
        toolbarLabels: { codeLabel: "代码", wrapLabel: "自动换行", unwrapLabel: "取消换行" },
      },
      footnotes: "脚注",
    };

    /**
     * 取官方 `MarkdownText` 组件（**带缓存** —— 别每次渲染都 require）。
     *
     * ⚠️ **只在真正要渲染 md 时才调**（惰性）：`require` 拿不到会抛，
     *    虽然这里包了 try，但**不该在模块加载期就碰它** —— 那会让"某个版本没有
     *    primitives"直接拖垮整个插件（死守第①条）。
     *
     * @returns {Function|null} 拿不到返回 `null`（调用方退回 `<pre>`，不假装成功）
     */
    var rpMdCache;
    function rpMarkdownText() {
      if (rpMdCache !== undefined) return rpMdCache;
      rpMdCache = null;
      try {
        var prim = require("@deepseek-ai/dsh-client-ui-primitives");
        // ⚠️ 判**真值**而不是 `typeof === "function"`：实测它是 `object`
        //    （`forwardRef`/`memo` 包装过的组件），`typeof` 判函数会**永远为假** ⇒ 静默退回 `<pre>`。
        if (prim && prim.MarkdownText) rpMdCache = prim.MarkdownText;
      } catch {
        // 可选 catch 绑定（ES2019）：不声明用不到的变量 ⇒ **不往棘轮基线里塞新豁免**
        rpMdCache = null;
      }
      return rpMdCache;
    }

    /**
     * 右栏内的**预览体**（档 1c）。
     *
     * 【用什么渲染】
     * · `.md` ⇒ 官方共享基线的 **`MarkdownText`**（`require("@deepseek-ai/dsh-client-ui-primitives")`）。
     *   ⚠️ 2026-10-14 **真机实测过**它能 require 得到（282 个导出，含 `MarkdownText`）——
     *   这条必须实测：`require` 拿不到会**抛**，而 entry 抛异常会拖垮整次 web boot（死守第①条）。
     *   它的官方定位是「**不可信 GFM** 与 TeX 数学」⇒ **XSS 由它负责**，我们不自己写渲染器。
     * · 图片 ⇒ `<img>` 走既有 `/files/thumb`（过 `assertInScope`）
     * · 视频/音频 ⇒ 原生标签走 `fileUrl(id)`
     * · 其他文本 ⇒ `<pre>` 兜底
     *
     * @param {{record: object, onBack: Function}} props
     */
    function RightPanePreview(props) {
      var React = require("react");
      var h = React.createElement;
      var rec = props.record || {};
      var pair = React.useState({ status: "loading", text: "", error: "" });
      var snap = pair[0];
      var setSnap = pair[1];

      var kind = rpKindOf(rec);
      var isText = kind === "text" || kind === "markdown";

      // 受管标签表 → `tagChips` 要的 `managed` 数组（**三态，别拍平**）。
      //
      // ⭐ 2026-10-14 **从主面板移植过来**（面板删了，但这个功能是活的）：
      //   · `{ok:true, tags:[…]}` → 传数组
      //   · `{ok:false}` / 还没拉到  → 传 `null` = **读不到**（`tagChips` 会显示警告）
      //   ⚠️ **故意不**在失败时传 `[]`：那会让「读不到」和「读到了但是空」长得一样，
      //      而这两件事的下一步动作不同（一个去查设置，一个什么都不用做）。
      var managedTags = (props.managed && props.managed.ok === true && Array.isArray(props.managed.tags))
        ? props.managed.tags
        : null;

      React.useEffect(function () {
        if (!isText || !rec.exists) return undefined;
        var alive = true;
        setSnap({ status: "loading", text: "", error: "" });
        fetch(fileUrl(rec.id), { headers: { accept: "text/plain" } })
          .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error("HTTP " + String(r.status))); })
          .then(function (body) {
            if (!alive) return;
            setSnap({ status: "ready", text: String(body).slice(0, RP_TEXT_LIMIT), error: "" });
          })
          .catch(function (error) {
            if (!alive) return;
            setSnap({ status: "error", text: "", error: (error && error.message) ? error.message : String(error) });
          });
        return function () { alive = false; };
      }, [rec.id, isText]);

      var body;
      if (!rec.exists) {
        body = h("div", { className: NS + "__rpstate" }, "文件已不在原位置");
      } else if (kind === "image") {
        body = h("div", { className: NS + "__rpmedia" },
          h("img", { className: NS + "__rpimg", src: thumbUrlsFor(rec).primary, alt: String(rec.title || rec.filename || "") }));
      } else if (kind === "video") {
        body = h("div", { className: NS + "__rpmedia" },
          h("video", { className: NS + "__rpvideo", src: fileUrl(rec.id), controls: true }));
      } else if (kind === "audio") {
        body = h("div", { className: NS + "__rpmedia" },
          h("audio", { className: NS + "__rpaudio", src: fileUrl(rec.id), controls: true }));
      } else if (snap.status === "loading") {
        body = h("div", { className: NS + "__rpstate" }, "读取中…");
      } else if (snap.status === "error") {
        body = h("div", { className: NS + "__rpstate" }, "读取失败：" + snap.error);
      } else if (kind === "markdown") {
        // ⭐ 官方 MarkdownText：不可信 GFM + TeX，XSS 由它负责（我们不自己写渲染器）
        var Md = rpMarkdownText();
        if (Md) {
          // ⚠️ `labels` **必填** —— 不传会让 MarkdownText 内部抛错、整个 slot 崩（实测过）
          body = h("div", { className: NS + "__rpmd" },
            h(Md, { text: snap.text, streaming: false, labels: RP_MD_LABELS }));
        } else {
          // 拿不到就用 <pre> 兜底（**不是**假装渲染成功）
          body = h("div", { className: NS + "__rptext" }, h("pre", { className: NS + "__rppre" }, snap.text));
        }
      } else if (kind === "text") {
        body = h("div", { className: NS + "__rptext" }, h("pre", { className: NS + "__rppre" }, snap.text));
      } else {
        body = h("div", { className: NS + "__rpstate" }, "这类文件暂不支持在右栏预览。");
      }

      // 标签芯片行（移植自旧面板的 `field("标签", tagChips(...))`）。
      // ⚠️ 只在**有标签**时渲染（旧面板也是这个条件）；没标签时不占一行。
      //    `tagChips` 在「受管表读不到」时会自己吐一个 `__tagwarn` —— 那是它的事，不在这里判。
      var tagRow = (rec.tags && rec.tags.length)
        ? h("div", { className: NS + "__rptags" },
          tagChips(h, rec.tags, { managed: managedTags, surface: "chip" }))
        : null;

      return h("div", { className: NS + "__rppv" },
        h("div", { className: NS + "__rppvhead" },
          h("button", {
            type: "button",
            className: NS + "__rpback",
            "aria-label": "返回列表",
            onClick: props.onBack,
          }, "← 返回"),
          h("span", { className: NS + "__rppvname", title: rec.path },
            String(rec.title || rec.filename || "")),
          h("span", { className: NS + "__rpsz" }, fmtSize(rec.size_bytes))),
        h("div", { className: NS + "__rppvbody" }, tagRow, body));
    }

    /**
     * 右栏 tab 正文：**单栏主从**（列表 ↔ 预览）。
     *
     * ⚠️ **620px 窄栏**（实测：右栏 = 视口 45%）⇒ 单列、不换行、
     *    字号 **≥12px**（`ui-spec` [39] 硬断言）。
     *
     * 【数据来源】组件在**模块层**，看不见 `apply` 的作用域 ⇒ 只能走 HTTP（`apiGet`）。
     *   但 `sessionId` / `useSessions` 是 **slot 系统注入到 props 的 hook**
     *   （官方 `sidebar-files` 就是这么拿 `cwd` 的：`useSessions(s => s.byId[sessionId]?.cwd)`）
     *   ⇒ 用同样的方式拿「当前工作区」。
     *
     * @param {{sessionId?: string, useSessions?: Function}} props slot 注入的 props
     */
    function RightPaneBody(props) {
      var React = require("react");
      var h = React.createElement;
      var sessionId = props && props.sessionId ? String(props.sessionId) : "";
      var useSessions = props && props.useSessions;

      // 当前会话的工作目录（cwd）—— 拿不到就是空串（宿主可能没有工作区概念）
      var cwd = "";
      try {
        if (typeof useSessions === "function" && sessionId) {
          cwd = useSessions(function (sessions) {
            var s = sessions && sessions.byId ? sessions.byId[sessionId] : undefined;
            return (s && s.cwd) ? String(s.cwd) : "";
          }) || "";
        }
      } catch {
        // 可选 catch 绑定（ES2019）：不声明用不到的变量 ⇒ **不往棘轮基线里塞新豁免**
        cwd = "";
      }

      var scopePair = React.useState("workspace");
      var scope = scopePair[0];
      var setScope = scopePair[1];
      var snapPair = React.useState({ status: "loading", items: [], error: "" });
      var snap = snapPair[0];
      var setSnap = snapPair[1];
      // 主从：`openId` 非空 ⇒ 整块换成预览（单栏，不是浮层）
      var openPair = React.useState("");
      var openId = openPair[0];
      var setOpenId = openPair[1];
      // 受管标签表（给预览里的标签芯片用）。`null` = **还没拉到**（与「拉到了但是空表」不同）。
      var managedPair = React.useState(null);
      var managed = managedPair[0];
      var setManaged = managedPair[1];

      // ⚠️ 只拉一次（不依赖 scope）—— 受管标签表是**全局设置**，不随筛选变。
      //    失败时置 `{ok:false}` 而不是 `null`：让「拉过且失败」与「还没拉」也能分开。
      React.useEffect(function () {
        var alive = true;
        apiGet("/managed-tags")
          .then(function (body) { if (alive) setManaged(body); })
          .catch(function () { if (alive) setManaged({ ok: false }); });
        return function () { alive = false; };
      }, []);

      React.useEffect(function () {
        var alive = true;
        setSnap({ status: "loading", items: [], error: "" });
        // ⚠️ 用既有的 `listQuery`（别自己拼参数 —— 宿主侧的参数名只有一处定义）
        var query = listQuery({ sort: "updated_desc" });
        if (scope === "workspace" && cwd) {
          query += "&scope_dir=" + encodeURIComponent(cwd);
        } else if (scope === "session" && sessionId) {
          query += "&session_id=" + encodeURIComponent(sessionId);
        }
        apiGet("/" + query)
          .then(function (items) {
            if (!alive) return;
            setSnap({ status: "ready", items: Array.isArray(items) ? items : [], error: "" });
          })
          .catch(function (error) {
            if (!alive) return;
            setSnap({ status: "error", items: [], error: (error && error.message) ? error.message : String(error) });
          });
        return function () { alive = false; };
      }, [scope, cwd, sessionId]);

      // 打开的那条不在当前列表里（切粒度 / 记录被删）⇒ 退回列表。
      // ⚠️ 放在 effect 里而不是渲染期间：渲染期间改状态是 React 反模式。
      React.useEffect(function () {
        if (!openId) return;
        if (snap.status !== "ready") return;
        var found = false;
        for (var i = 0; i < snap.items.length; i += 1) {
          if (snap.items[i].id === openId) { found = true; break; }
        }
        if (!found) setOpenId("");
      }, [openId, snap]);

      // 头部：粒度切换（用原生 button，不用 select —— 620px 里 select 太占地方）
      var head = h("div", { className: NS + "__rphead" },
        h("div", { className: NS + "__rpseg", role: "group", "aria-label": "查看范围" },
          RP_SCOPES.map(function (s) {
            return h("button", {
              key: s.id,
              type: "button",
              className: NS + "__rpsegbtn" + (scope === s.id ? " " + NS + "__rpsegbtn--on" : ""),
              "aria-pressed": scope === s.id ? "true" : "false",
              onClick: function () { setScope(s.id); },
            }, s.label);
          })),
        h("span", { className: NS + "__rpn" },
          snap.status === "ready" ? String(snap.items.length) + " 条" : ""),
        // ⚠️ 这个「管理页」按钮是**低频功能的唯一入口**（2026-10-14 档 1d）：
        //    删掉 `sidebar.footer.action`（左下角「产物库 · 网页版」）之后，
        //    登记 / 导入 / 精炼 / 整理建议 / 设置 **都只在 HTTP 管理页里**，
        //    没有这个按钮用户就**进不去**。所以它跟着面板一起搬过来。
        h("button", {
          type: "button",
          className: NS + "__rpopen",
          title: "打开完整管理页（登记 / 导入 / 语义搜索 / 精炼 / 整理建议 / 设置）",
          "aria-label": "打开完整管理页",
          onClick: openPage,
        }, "管理页"));

      if (snap.status === "loading") {
        return h("div", { className: NS + "__rp" }, head,
          h("div", { className: NS + "__rpstate" }, "读取中…"));
      }
      if (snap.status === "error") {
        return h("div", { className: NS + "__rp" }, head,
          h("div", { className: NS + "__rpstate" }, "读取失败：" + snap.error));
      }

      var items = snap.items;

      // 主从：打开某条 ⇒ 整块换成预览（**不保留列表** —— 620px 里并排两栏都太窄）
      if (openId) {
        var opened = null;
        for (var i = 0; i < items.length; i += 1) {
          if (items[i].id === openId) { opened = items[i]; break; }
        }
        if (opened) {
          return h(RightPanePreview, {
            record: opened,
            managed: managed,
            onBack: function () { setOpenId(""); },
          });
        }
        // ⚠️ 切粒度后原来打开的那条可能不在新列表里 ⇒ **自动退回列表**（不留空白页）。
        //    但**不能在渲染期间改状态**（React 会警告，且行为不可预期）——
        //    交给下面那个 effect，等这次渲染提交后再清。
      }

      var emptyText = scope === "workspace"
        ? (cwd ? "这个工作区里还没有登记过的产物。" : "当前会话没有工作区，无法按工作区筛选。")
        : (scope === "session" ? "这个会话还没有登记过的产物。" : "库里还没有产物。");

      return h("div", { className: NS + "__rp" }, head,
        items.length === 0
          ? h("div", { className: NS + "__rpstate" }, emptyText)
          : h("div", { className: NS + "__rplist" },
            items.slice(0, 200).map(function (rec) {
              // 单栏主从：点一行 ⇒ 整块换成预览（不是弹浮层 —— 620px 里浮层会盖住上下文）
              return h("button", {
                type: "button",
                className: NS + "__rprow",
                key: rec.id,
                title: rec.path,
                onClick: function () { setOpenId(rec.id); },
              },
                h("span", {
                  className: NS + "__rpico", "aria-hidden": "true",
                  dangerouslySetInnerHTML: { __html: iconOf(rec.path, rec.is_dir).svg },
                }),
                h("span", { className: NS + "__rpnme" },
                  String(rec.title || rec.filename || rec.path || "")),
                h("span", { className: NS + "__rpsz" }, fmtSize(rec.size_bytes)));
            })));
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
      var domDisposer = null;

      // 服务到达：用官方 `ctx.inject(deps, cb)`，不再自己写重试（2026-10-13 改）。
      // 它新建**子 plugin**，等待隔离在子 fiber 里 ⇒ 本插件的 apply 立即返回，
      // 不会「卡在 pending 拖垮启动」（那正是"不导出 inject"要防的事）。
      // 旧实现的自链式重试有个**静默失败**：单个 `any` 布尔当总闸，
      // `slots` 一到就永久停止重试 ⇒ 更晚到的服务（如 `sidebarRightTabs`）永远问不到。
      // 详见提交信息。
      var slotsDisposer = null;

      /**
       * 把一次席位注册包进 `ctx.effect`，让 cordis 管生命周期。
       *
       * ⚠️ 不加会撞 id：**热载重跑 `apply` 时旧 fiber 的清理还没跑完**，
       * 同一个 `id` 被注册第二次 ⇒ `tab type id "…" is already registered`
       * （2026-10-13 真机验证时实测到）。
       *
       * @param {Function} fn 执行注册，返回 disposer
       * @param {string} label 诊断用标签
       * @returns {*} `fn` 的返回值
       */
      function inEffect(fn, label) {
        try {
          if (ctx && typeof ctx.effect === "function") return ctx.effect(fn, label);
        } catch (error) { warn("ctx.effect 失败，直接执行：", error); }
        try { return fn(); } catch (error) { warn("注册失败：", error); return undefined; }
      }

      /**
       * 拿到 slots 后注册剩余席位。
       *
       * ⭐ **2026-10-14 档 1d：三个旧席位已删**（依琪拍板「主区面板不要了，全部转到右侧栏」
       *    「左边的都不要了」）：
       *      · `main`（主区面板，`Panel`）
       *      · `sidebar.panellist`（左侧栏图标，`PanelIcon`）
       *      · `sidebar.footer.action`（左下脚部入口，`FooterEntry`）
       *    ⇒ 现在**只剩应用级 Toast 浮层**这一个席位。
       *    ⚠️ 完整管理页的入口**搬进了右栏**（见 `RightPaneBody` 头部那个按钮），
       *    否则删掉 `FooterEntry` 后用户**没有入口**打开登记/导入/精炼那些低频功能。
       *
       * ⚠️ 返回值仍是「三态」语义（见 `registerAtSource` 注释）——
       *    但**只剩一个非必需席位**，所以这里恒返回 `true`：
       *    「拿到 slots 就算成功」，Toast 挂不上不算失败（它有面板内兜底）。
       *
       * @returns {boolean} 恒 `true`（拿到 slots 即成功）
       */
      function registerSlots(slots) {
        if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return false;
        // 应用级 Toast 浮层：官方 UX 要求瞬时结果挂在「比上报界面活得久」的地方。
        // ⚠️ 宿主 slot 表里没有 shell.overlay 时（旧版本）这里可能不抛但也不会挂载，
        //    所以**是否兜底由 ShellToast 挂载时置位的 toastBus.hasOverlay 决定**，不由这里的成败决定。
        try {
          inEffect(function () {
            return slots.inject(SLOT_OVERLAY, function () {
              return slots.register({
                name: SLOT_OVERLAY,
                id: PANEL_ID + ".toast",
                order: 90,
              }, ShellToast);
            });
          }, "artifact-library: toast");
        } catch (error) { warn("注册 Toast 浮层失败（将退回面板内提示）：", error); }
        return true;
      }

      /** 注册成功后的收尾：撤掉 DOM 兜底（避免两个入口），并记诊断。 */
      function onSlotsReady(slots) {
        var ok = registerSlots(slots);
        registered = ok;
        probeNote(probe, "reg=" + ok);
        if (ok && domDisposer) {
          try { domDisposer(); } catch (error) { /* 忽略 */ }
          domDisposer = null;
        }
        if (!ok) {
          // 拿到了 slots 但一个席位都没注册上 —— 这是**真失败**，不是"服务没到"。
          // ⚠️ 不重试（重试只会重复同一个错误、刷日志）。
          warn("slots 已就绪但席位注册全部失败（永久）");
        }
        return ok;
      }

      // ── 右侧栏 tab：注册 `kind:"files"` **接管**官方文件树（2026-10-14 · 档 1a）──
      //
      // ⭐ 机制（2026-10-13 真机验证过）：官方 `SidebarRightTabRegistry` 的
      //   `enter()` 里 `if (RANKS[entry.band] > RANKS[held.inForce.band])` ⇒
      //   `extension` 档（第三方默认）注册 `builtin` 已占的 kind ⇒ **接管**；
      //   注销时 `leave()` 里 `slot.inForce = slot.shadowed` ⇒ **官方自动回来**。
      //   ⇒ 这就是依琪要的「**可开关、默认开启**」，不用额外设计。
      //
      // ⚠️ 用 `ctx.inject(["sidebarRightTabs","slots"], cb)` 等服务就绪 ——
      //    与 `slots` 那条路同一个 API（等待隔离在子 fiber，不拖垮启动）。
      if (ctx && typeof ctx.inject === "function") {
        try {
          ctx.inject(["sidebarRightTabs", "slots"], function (owner) {
            var rtDisposer = null;
            try {
              var tabs = owner && typeof owner.get === "function" ? owner.get("sidebarRightTabs") : undefined;
              if (!tabs || typeof tabs.register !== "function") {
                probeNote(probe, "rt=no-service");
                return;
              }
              // ⚠️ **必须包在 `ctx.effect` 里**：热载会重跑 apply 而旧 fiber 的清理可能还没跑完，
              //    同一个 id 注册第二次 ⇒ 官方抛 `id is already registered`（2026-10-13 实测到）。
              rtDisposer = inEffect(function () {
                return tabs.register({
                  id: RIGHT_TAB_ID,
                  kind: FILES_KIND,
                  title: function () { return "文件管理"; },
                  guide: [{
                    id: RIGHT_TAB_ID + ":entry",
                    order: 12,
                    title: function () { return "文件管理"; },
                    description: function () { return "产物库：登记过的产物 + 项目 + 标签"; },
                  }],
                });
              }, "artifact-library: right tab type");
              probeNote(probe, "rt=registered");

              // tab 正文 + 标题芯片（两个 keyed 席位，key 必须与上面 id 一致）
              var rtSlots = owner && typeof owner.get === "function" ? owner.get("slots") : undefined;
              if (rtSlots && typeof rtSlots.inject === "function") {
                inEffect(function () {
                  return rtSlots.inject("sidebar.right.pane.tab", function () {
                    return rtSlots.register({ name: "sidebar.right.pane.tab", key: RIGHT_TAB_ID }, RightPaneBody);
                  });
                }, "artifact-library: right tab body");
                inEffect(function () {
                  return rtSlots.inject("sidebar.right.pane.tab.title", function () {
                    return rtSlots.register({ name: "sidebar.right.pane.tab.title", key: RIGHT_TAB_ID }, RightPaneTitle);
                  });
                }, "artifact-library: right tab title");
                probeNote(probe, "rt=seats");
              }
            } catch (rtError) {
              warn("右栏 tab 注册失败：", rtError);
            }
            return rtDisposer;
          });
        } catch (rtOuter) {
          warn("右栏 ctx.inject 调用失败：", rtOuter);
        }
      }

      // ⭐ 官方写法：等服务就绪再执行回调。**等待被隔离在子 fiber 里**，
      //    本插件的 apply 立即返回（这正是"不导出 inject"想达到的效果，但更干净）。
      //
      // ⚠️ `ctx.inject` 返回的是**子 fiber**（源码：`return this.plugin({ inject, apply: callback })`）。
      //    它不提供 disposer 方法，但 `ctx.effect` 里返回它会被 cordis 当 effect 处理 ——
      //    所以这里**不把它塞进 effect**，只在插件卸载时靠 cordis 的 fiber 级联清理。
      if (ctx && typeof ctx.inject === "function") {
        try {
          slotsDisposer = ctx.inject(["slots"], function (owner) {
            try {
              var s = owner && typeof owner.get === "function" ? owner.get("slots") : undefined;
              onSlotsReady(s);
            } catch (error) { warn("ctx.inject 回调里注册失败：", error); }
          });
          probeNote(probe, "inject-armed");
        } catch (error) {
          // `ctx.inject` 抛了（形状不对）⇒ 退回一次性 get
          warn("ctx.inject 调用失败，退回一次性 get：", error);
          try { onSlotsReady(ctx.get("slots")); } catch (error2) { warn("退路也失败：", error2); }
        }
      } else {
        // 旧宿主没有 ctx.inject ⇒ 一次性 get（**不再自己重试**）
        probeNote(probe, "no-inject-api");
        try { onSlotsReady(ctx && typeof ctx.get === "function" ? ctx.get("slots") : undefined); }
        catch (error) { warn("slot 获取失败：", error); }
      }

      // 席位没就位时画 DOM 兜底入口（页面右下角一个按钮）。
      // ⚠️ 与旧实现的区别：**不再等 1.5 秒后重试**，而是先画上；
      //    席位就位后由 `onSlotsReady` 撤掉（`domDisposer`）。
      if (!registered) {
        try { domDisposer = applyViaDom(); } catch (error) { warn("DOM 兜底失败：", error); }
      }

      // `@` 引用来源：注册在 root 服务 `inputTriggers` 上（**不走 slots.inject**，所以不计入席位）。
      //
      // ⚠️ **2026-10-06 修：原来只调一次，拿不到就永久放弃 —— 和 slots 那个 bug 同源。**
      //    真机复现（WSL 测试床，`ritest5`）：
      //      console: `[artifact-library] inputTriggers 不可用，@ 来源未注册`
      //      视觉  : 输入框打 `@`，候选里**只有目录和对话，没有「产物库」**
      //    ⇒ 也就是说**这个功能一直是坏的**，上个会话发现了却只删掉提示文案、没修注册
      //      （见上面那段 2026-10-03 的注释）。
      //    现在照抄同一文件里 slots 那套**自链式 setTimeout 重试**（20 次 × 1500ms）。
      //    ⚠️ 这也是「快捷挂起区 → 引用到输入框」的前提，不修的话那条做不了。
      //
      //    ⚠️ **2026-10-06 二改**：小琪琪独立复核指出，`registerAtSource` 原来用**同一个 `null`**
      //    表示「服务没到（该重试）」和「注册真抛了（不该重试）」⇒ 永久失败会被重试 20 次刷屏。
      //    现在返回值是三态（见 `registerAtSource` 注释），`null` 一出现就 `atFatal = true` 立刻停；
      //    并且三种结局都写进 probe（`at-reg@N` / `at-fatal@N` / `at-giveup@N`），
      //    和 slots 那条路的 `reg@N` / `giveup@N` 对齐 —— 之前 `@` 只有 console，没进 probe。
      var atDisposer = null;
      var atAttempts = 0;
      var atTimer = null;
      var atRegistered = false;
      var atFatal = false;

      /**
       * 试注册 @ 来源。
       * @returns {boolean} true = 成功；false = 没成（此时看 `atFatal` 决定还要不要再试）
       */
      function tryRegisterAt() {
        atAttempts += 1;
        var disposer;
        try {
          disposer = registerAtSource(ctx);
        } catch (error) {
          // registerAtSource 内部已全 catch，能走到这里说明是它之外的意外 —— 当永久失败处理。
          warn("@ 来源注册异常（永久，不再重试）：", error);
          atFatal = true;
          return false;
        }
        if (typeof disposer === "function") {
          atDisposer = disposer;
          atRegistered = true;
          return true;
        }
        // null = 注册真抛了（永久）；undefined = 服务还没到（可重试）。见 registerAtSource 的注释。
        if (disposer === null) atFatal = true;
        return false;
      }

      if (tryRegisterAt()) {
        probeNote(probe, "at-reg@" + atAttempts);
        try { console.info("[artifact-library] @ 来源已注册（第 " + atAttempts + " 次尝试）"); } catch (error) { /* 忽略 */ }
      } else if (atFatal) {
        probeNote(probe, "at-fatal@" + atAttempts);
        try { console.info("[artifact-library] @ 来源注册失败（永久），不再重试"); } catch (error) { /* 忽略 */ }
      } else {
        var scheduleAtRetry = function () {
          atTimer = setTimeout(function () {
            atTimer = null;
            if (atRegistered) return;
            if (tryRegisterAt()) {
              probeNote(probe, "at-reg@" + atAttempts);
              try { console.info("[artifact-library] @ 来源已注册（第 " + atAttempts + " 次尝试，服务晚到）"); } catch (error) { /* 忽略 */ }
              return;
            }
            if (atFatal) {
              probeNote(probe, "at-fatal@" + atAttempts);
              try { console.info("[artifact-library] @ 来源注册失败（永久），不再重试"); } catch (error) { /* 忽略 */ }
              return;
            }
            if (atAttempts >= 20) {
              probeNote(probe, "at-giveup@" + atAttempts);
              try { console.info("[artifact-library] inputTriggers 试满 20 次仍不可用，@ 来源未注册"); } catch (error) { /* 忽略 */ }
              return;
            }
            scheduleAtRetry();
          }, 1500);
        };
        scheduleAtRetry();
      }

      return function () {
        // ⚠️ `slotsDisposer` 是 `ctx.inject` 返回的**子 fiber**（对象），不是函数 ——
        //    只有它恰好是函数时才调（旧宿主 / 形状变化时）。
        try { if (typeof slotsDisposer === "function") slotsDisposer(); } catch (error) { /* 忽略 */ }
        try { if (atDisposer) atDisposer(); } catch (error) { /* 忽略 */ }
        try { if (atTimer) clearTimeout(atTimer); } catch (error) { /* 忽略 */ }
        try { if (domDisposer) domDisposer(); } catch (error) { /* 忽略 */ }
        try { if (probe && probe.parentNode) probe.parentNode.removeChild(probe); } catch (error) { /* 忽略 */ }
      };
    }

    exports.apply = apply;
    return module.exports;
  },
});