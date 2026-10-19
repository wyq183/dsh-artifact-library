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
      // ⭐ 可点标签（2026-10-19 · 侧栏与管理页一致）
      // ⚠️ <button> 有 UA 默认样式（边框/背景/内边距），必须显式抹掉才能当芯片用
      "." + NS + "__tagpick{cursor:pointer;font:inherit;border:0;background:transparent;padding:0;transition:.12s}",
      "." + NS + "__tagpick:hover{filter:brightness(1.25)}",
      "." + NS + "__tagpick:active{transform:scale(.97)}",
      "." + NS + "__tagpick:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
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
      "." + NS + "__rph{font-size:13px;font-weight:500}",
      "." + NS + "__rpn{color:var(--dsw-alias-label-tertiary);font-size:12px}",
      "." + NS + "__rpstate{padding:14px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}",
      "." + NS + "__rplist{flex:1 1 auto;min-height:0;overflow:auto}",
      // ── 多选下拉（2026-10-19 第 2 步 · 依琪「下拉式展开多选择分类」）──────
      // 容器 position:relative —— 弹层是绝对定位，相对它定位。
      "." + NS + "__rpmulti{position:relative;display:inline-flex;min-width:0}",
      // summary：与原来的 select 外观一致（不要两套视觉）
      "." + NS + "__rpmsum{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:4px 6px;border-radius:var(--dsw-radius-sm);cursor:pointer}",
      "." + NS + "__rpmsum:hover{border-color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__rpmsum:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      // 有选中值 ⇒ 高亮（一眼看出这个维度筛过）
      "." + NS + "__rpmulti--on ." + NS + "__rpmsum{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rpmsumlabel{flex:none;color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__rpmsumval{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "." + NS + "__rpmsumcar{flex:none;font-size:12px;opacity:.7;line-height:1}",
      // 弹层：绝对定位在下方，最大高度 + 内部滚动（标签有 1340 个值）
      "." + NS + "__rpmwrap{position:absolute;top:calc(100% + 4px);left:0;z-index:20;width:max(180px,100%);max-height:280px;overflow:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-primary);box-shadow:0 6px 20px rgba(0,0,0,.18);padding:4px}",
      "." + NS + "__rpmlist{display:flex;flex-direction:column;gap:0}",
      // 选项：整行可点
      "." + NS + "__rpmopt{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:var(--dsw-radius-sm);cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      "." + NS + "__rpmopt:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rpmopt--on{color:var(--dsw-alias-label-primary);font-weight:500}",
      "." + NS + "__rpmck{flex:none;width:13px;height:13px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}",
      "." + NS + "__rpmname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "." + NS + "__rpmcnt{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px}",
      "." + NS + "__rpmempty{padding:6px;color:var(--dsw-alias-label-tertiary);font-size:12px}",
      "." + NS + "__rpmclear{display:block;width:100%;margin-top:4px;border:0;border-top:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:20px;padding:6px;cursor:pointer;text-align:center}",
      "." + NS + "__rpmclear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      // ── 表头（2026-10-19 第 2 步：依琪「顶上分类连同分割线」）────────────────
      // ⚠️ `position:sticky` + 分隔线伪元素：滚动时表头粘住，列标不会跑丢。
      "." + NS + "__rpcols{display:grid;align-items:center;gap:6px;padding:6px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-secondary);font-size:12px;color:var(--dsw-alias-label-tertiary);position:sticky;top:0;z-index:1}",
      "." + NS + "__rpcolck{display:block}",
      // ⚠️⚠️ 这一条是「看不见分割线」的**根因修复**（2026-10-19）：
      //    原来这里同时有 `position:relative` + `overflow:hidden`，
      //    而把手是 `position:absolute; right:-3px` —— 它在格子**外面**，
      //    被 overflow 直接裁掉 ⇒ 一点都看不见、也没法拖。
      //    ⇒ 格子允许溢出，文字由内层 `__rpcoltext` 自己裁（省略号在那层生效）。
      "." + NS + "__rpcol{position:relative;display:block;min-width:0;overflow:visible}",
      // 文字层：裁切与省略号放在这里
      "." + NS + "__rpcoltext{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      // ⭐ 列之间的分割线。⚠️ 绝对定位到**右边缘**，且用 `border` 而不是 `background`
      //    （后者在高 DPI 屏上会糊成 2px）。
      // ⭐ 拖动把手（视觉上是**一根细线**，但可点区 10px —— 否则鼠标抓不住）
      //    常态就可见（依琪：「没看到分割线」—— 不许藏到 hover 才出现）
      "." + NS + "__rpgrip{position:absolute;top:-8px;right:-5px;width:10px;height:calc(100% + 16px);cursor:col-resize;z-index:2}",
      "." + NS + "__rpgrip::after{content:'';position:absolute;top:0;left:4px;width:1px;height:100%;background:var(--dsw-alias-border-l1)}",
      "." + NS + "__rpgrip:hover::after{background:var(--dsw-alias-state-business-primary)}",
      // ⚠️ 行改成 **grid**（2026-10-19 第 2 步）：与表头共用 `rpColumnTemplate()`。
      //    用 flex 的话每行各自算宽度，列永远对不齐（差几像素，看久了很难受）。
      "." + NS + "__rprow{display:grid;align-items:center;gap:6px;min-height:28px;padding:6px 14px}",
      "." + NS + "__rprow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      // ── 五行格（2026-10-19 第 2 步）──────────────────────────────────────
      // ⚠️ 名字格是 **flex 容器**：图标 / 未精炼点 / 标题 横排，标题吃剩余宽度。
      //    这一格在 grid 里是 `1fr`。
      "." + NS + "__rpname{display:flex;align-items:center;gap:6px;min-width:0}",
      // 大小格：大小 + @ 横排（`1fr` 里的 ext/size 是固定 px，这里只要不溢出）
      "." + NS + "__rpszcell{display:flex;align-items:center;gap:2px;justify-content:flex-end;min-width:0}",
      "." + NS + "__rpico{flex:none;display:flex;width:16px;height:16px}",
      "." + NS + "__rpico svg{width:16px;height:16px}",
      "." + NS + "__rpnme{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}",
      "." + NS + "__rpsz{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}",
      "." + NS + "__rpt{font-size:13px}",
      // ── 搜索 + 三个下拉（2026-10-18 晚定稿）────────────────────────────────
      // ⚠️ 头部分**两行**：搜索整行 / 三个下拉 + 计数 + 管理页一行。
      //    620px 里塞一行会挤到输入框不可用。
      "." + NS + "__rphead{display:flex;flex-direction:column;gap:8px;flex:none;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1)}",
      "." + NS + "__rpsearch{display:flex;align-items:center;gap:6px;flex:none}",
      "." + NS + "__rpinput{flex:1 1 auto;min-width:0;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;padding:4px 8px;border-radius:var(--dsw-radius-sm)}",
      "." + NS + "__rpinput::placeholder{color:var(--dsw-alias-label-tertiary)}",
      "." + NS + "__rpinput:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      "." + NS + "__rpclear{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:20px;padding:0 4px;cursor:pointer}",
      "." + NS + "__rpclear:hover{color:var(--dsw-alias-label-primary)}",
      // 第二行：三个下拉 + 计数 + 管理页
      "." + NS + "__rpbar{display:flex;align-items:center;gap:6px;flex:none;min-width:0}",
      // ⭐ 原生 <select>：点开才出临时小窗，**选完即收**。
      // ⚠️ 不给固定宽度 —— 让它们按内容收缩，620px 里才放得下三个。
      // ⚠️ `appearance:none` + 自画箭头：默认箭头在深色主题下对比度太低。
      "." + NS + "__rpsel{flex:0 1 auto;min-width:0;max-width:34%;appearance:none;-webkit-appearance:none;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:4px 18px 4px 6px;border-radius:var(--dsw-radius-sm);cursor:pointer;text-overflow:ellipsis;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-tertiary) 50%),linear-gradient(135deg,var(--dsw-alias-label-tertiary) 50%,transparent 50%);background-position:calc(100% - 10px) 50%,calc(100% - 6px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}",
      "." + NS + "__rpsel:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rpsel:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      // 深色主题下 <option> 也要跟着 —— 否则展开是白底黑字，很刺眼
      "." + NS + "__rpsel option{background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rpopen{flex:none;margin-left:auto;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:4px 8px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}",
      "." + NS + "__rpopen:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rpopen:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      // 截断提示（⚠️ 不许静默截断）
      "." + NS + "__rpnote{flex:none;padding:6px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}",
      // ── 批量操作栏（2026-10-18 晚 · 依琪要的批量选择）────────────────────
      "." + NS + "__rpbatch{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;padding:8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-secondary)}",
      // 行内勾选框
      "." + NS + "__rpck{flex:none;width:13px;height:13px;margin:0 2px 0 0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}",
      // 行内 @ 按钮（默认半透明，hover 才亮 —— 否则每行都挂个 @ 太吵）
      "." + NS + "__rpat{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;padding:0 4px;border-radius:var(--dsw-radius-sm);cursor:pointer;opacity:.55}",
      "." + NS + "__rpat:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rpat:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      // 选中的行
      "." + NS + "__rprow--sel{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover))}",
      // 未精炼标记（依琪 2026-10-18：「标记的新的未被ai精炼的文件」）
      // ⚠️ 用**小圆点**不用文字：620px 里每行挂个「待精炼」会把标题挤掉。
      //    语义靠 title/aria-label 给（悬停能看全）。
      "." + NS + "__rpdot{flex:none;color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:1}",
      // 后缀徽章（依琪 2026-10-18：「文件要显示文件类型，后缀名」）
      // ⚠️ 用**等宽 + 固定最小宽**：`.md` / `.blend` / `.png` 长度不同，
      //    不固定的话每行大小列会左右跳（tabular-nums 已经给了数字，这里给字母）。
      // 行内标签（2026-10-19 · 依琪「标签要快速显示」）
      // ⚠️ 用 `min-width:0` + `overflow:hidden`：标签列是 flex 子项，
      //    不加这两条会被内容撑开，把「名字」挤成省略号。
      // 标签格（grid 的一格）。⚠️ 里面的 `__rptags` 是 rpTagCell 自己的 flex 容器。
      // 标签格：`overflow:hidden` 在这里是**对的**（这一格没有把手，裁掉是预期行为）
      "." + NS + "__rptagcell{min-width:0;overflow:hidden;display:block}",
      // ⚠️⚠️ 关键：标签容器**不换行 + 裁切**，标签本身**不压缩**。
      //    这样空间不够时裁掉的是**末尾整个标签**（拖宽就多露出一个完整的）；
      //    如果给标签 `flex-shrink:1`，就会所有标签一起被压成"…"，谁也看不清 ——
      //    那正是"我明明给了更多空间还是在折叠/看不清"的另一种表现。
      "." + NS + "__rptags{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;flex:0 1 auto;flex-wrap:nowrap}",
      // 标签芯片压小：`tagChips` 默认给预览区用（那边宽敞）
      // ⚠️ 标签本身 `flex:none`（**不压缩**）：宁可末尾被裁，也不要每个都变省略号。
      "." + NS + "__rptags > span{flex:none;font-size:12px;line-height:18px;padding:0 6px;white-space:nowrap}",
      "." + NS + "__rptagmore{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:0 2px}",
      "." + NS + "__rpext{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--dsw-alias-label-tertiary);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-transform:lowercase}",
      // 精炼按钮的 disabled 态
      "." + NS + "__rpopen:disabled{opacity:.45;cursor:not-allowed}",
      // ── AI 整理面板 ──────────────────────────────────────────────────────
      "." + NS + "__rpclean{display:flex;flex-direction:column;gap:10px;padding:10px 14px}",
      "." + NS + "__rpcrow{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm)}",
      "." + NS + "__rpccanon{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}",
      // 预览页的操作行（档 B：让预览能直接动手，不必回管理页）
      "." + NS + "__rpacts{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;padding:8px 14px 0}",
      "." + NS + "__rpact{border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:0 8px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}",
      "." + NS + "__rpact:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      "." + NS + "__rpact:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      "." + NS + "__rpact:disabled{opacity:.45;cursor:not-allowed}",
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
    function fmtSize(b) {
      var n = Number(b) || 0;
      if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
      if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
      return n + " B";
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

    // ── 行规格常量（UI-SPEC §3.1 / §4）────────────────────────────────────
    /** 目录视图行高三档：紧凑 24 / **标准 32（默认）** / 宽松 44。 */
    var ROW_H_COMPACT = 24;
    var ROW_H_STANDARD = 32;
    var ROW_H_LOOSE = 44;
    /** 搜索视图两行式行高（§4：44~48）。 */
    var ROW_H_SEARCH = 44;
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
    var CHANGES_ROUTE = "/session-changes";

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
    var CHIP_EXTS = {
      doc: ["md", "markdown", "txt", "text", "log", "json", "xml", "yml", "yaml", "toml", "ini", "csv", "tsv", "pdf", "doc", "docx", "rtf", "odt", "xls", "xlsx", "ppt", "pptx"],
      image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "tif", "tiff", "heic", "psd", "ai", "fig"],
      media: ["mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"],
      code: ["js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "cs", "php", "lua", "html", "htm", "css", "scss", "less", "sh", "ps1", "bat", "cmd", "sql", "vue", "svelte"],
      archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab", "iso", "jar"],
    };

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

    var SOURCE_LABELS = {
      present: "模型声明",
      manual: "手动登记",
      session: "会话产出",
      "folder-import": "导入资料",
    };

    function tagChips(h, tags, options) {
      var opts = options && typeof options === "object" ? options : {};
      var managed = opts.managed === undefined ? null : opts.managed;
      var surface = typeof opts.surface === "string" && opts.surface ? opts.surface : "chip";
      // 可选的点击回调（2026-10-19 侧栏标签可点）。
      // ⚠️ 不传 ⇒ 渲染成 <span>，**完全不改变**现有调用的行为。
      var onPick = typeof opts.onPick === "function" ? opts.onPick : null;
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
          if (onPick) {

            // ⚠️ 自由词也要能点 —— 否则用户会看到"有样式的能点、没样式的不能点"（假规律）

            kids.push(h("button", {

              type: "button",

              className: NS + "__tagfree " + NS + "__tagpick",

              key: "f" + String(i),

              title: "点一下筛出所有带「" + name + "」的条目",

              onClick: function (event) {

                if (event && event.stopPropagation) event.stopPropagation();

                onPick(name);

              },

            }, name));

          } else {

            kids.push(h("span", { className: NS + "__tagfree", key: "f" + String(i) }, name));

          }
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
        if (onPick) {
          // ⚠️ 用 <button>：键盘 Tab 到得了、读屏认得出是可操作元素（与列表页一致）
          // ⚠️ stopPropagation：标签在预览/行内部，而整块可点（点它会打开预览）
          kids.push(h("button", {
            type: "button",
            className: NS + "__tagchip " + NS + "__tagpick",
            key: "m" + String(i),
            title: (title ? title + " · " : "") + "点一下筛出所有带「" + name + "」的条目",
            style: style,
            onClick: function (event) {
              if (event && event.stopPropagation) event.stopPropagation();
              onPick(name);
            },
          }, inner));
        } else {
          kids.push(h("span", { className: NS + "__tagchip", key: "m" + String(i), title: title, style: style }, inner));
        }
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

    /**
     * 「只看当前工作区」的持久化键。
     *
     * ⭐ **2026-10-18 改成生图插件（`dsh-image-gen`）的做法** —— 依琪指的路。
     *    原来这里是三个**平行按钮**（当前工作区 / 全部 / 当前会话），问题：
     *      · 「当前工作区」按 `cwd` 前缀筛，而产物记的是**登记时**的路径
     *        ⇒ 换个目录就一条都看不见，看起来像"库空了"（语义错配）；
     *      · 三个平行选项让用户以为它们是**同等的一级分类**，
     *        其实「全部」是"不过滤"、另外两个是"过滤条件"—— **不是同一个维度**。
     *
     *    ⇒ 照 `dsh-image-gen` 的结构：**一个复选框 + 一个「当前/总数」徽章**。
     *      默认**勾上**（他只关心自己这次做的东西），勾着才收窄，取消就是全量。
     *      徽章 `min/total` 让他一眼看出"收窄掉了多少"——这是原设计缺的信息。
     *
     *    ⚠️ 过滤在**本地**做（`items` 一次拉全，`useMemo` 数）——
     *      **不额外发请求**。生图插件也是这么做的：切 checkbox 是瞬间的。
     *
     * ⚠️ 每次 `apply` 重跑都不该重置偏好 ⇒ 存 `localStorage`（生图插件用的也是这个键名风格）。
     */
    var RP_SCOPE_KEY = "alf-only-current-workspace";

    /**
     * 读「范围」的初值（三档之一）。⚠️ 读不到/读到脏值就**默认 `workspace`**：
     * 那个 tab 的第一诉求是"我刚做的东西"，但「当前会话」太窄（一次会话往往只有几条）。
     */
    function rpScopeInitial() {
      try {
        var v = localStorage.getItem(RP_SCOPE_KEY);
        for (var i = 0; i < RP_SCOPES.length; i += 1) {
          if (RP_SCOPES[i].id === v) return v;
        }
        // ⚠️ 默认「全部」而不是「当前工作区」（2026-10-19 改）。
        //    **实测依据**：依琪在 `Documents\互通` 下工作，而产物大多在别处 ⇒
        //    默认工作区让面板显示 **27/446**，看起来像"库空了/坏了"
        //    （他自己的截图就是 27/446）。
        //    ⇒ 默认全量，把「工作区」变成一个**主动选择**的收窄动作。
        return "all";
      } catch {
        // 可选 catch 绑定（ES2019）：localStorage 在隐私模式/沙箱里会抛
        return "all";
      }
    }

    /**
     * 归一化路径以便比较（去尾部分隔符、统一斜杠、小写盘符）。
     * ⚠️ 这四条都是 `store.js` 里 `inScopeDir` **踩过的坑**（同一个教训）：
     *    不归一化就会把同一个目录判成不同目录。
     */
    function rpNormPath(p) {
      var s = String(p === undefined || p === null ? "" : p).replace(/\\/g, "/");
      s = s.replace(/\/+$/, "");
      // 盘符统一小写（`C:` 与 `c:` 是同一个盘）
      if (/^[A-Za-z]:/.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
      return s;
    }

    /**
     * 这条记录属不属于「当前工作区」。
     *
     * ⭐ **结构照抄 `dsh-image-gen` 的 `isItemInWorkspace`** —— 核心是**多路匹配 + 双保险**：
     *   ① 多路：`session_id` 命中 / `path` 在根目录下 —— **任一命中即算**；
     *      为什么不能只看一条？因为我们**没有** `workspaceId` 这种强标识，
     *      只有 `session_id` 与 `path` 两个弱标识，单看哪个都会漏。
     *   ② 双保险：**任一方拿不到就返回 `true`**（不过滤）。
     *      ⇒ 这是**关键**：拿不到 cwd 时若返回 `false`，整个列表会**突然空掉**，
     *        用户会以为东西丢了。**宁可多显示，不可误杀。**
     *
     * @param {{session_id?: string, path?: string}} rec 产物记录
     * @param {{cwd?: string, sessionId?: string}} ws 当前工作区上下文
     * @returns {boolean} 是否属于当前工作区
     */
    function rpInWorkspace(rec, ws) {
      if (!rec) return false;
      // ② 双保险：上下文是空的 ⇒ 无法判 ⇒ **放行**（不误杀）
      var hasCwd = !!(ws && ws.cwd);
      var hasSid = !!(ws && ws.sessionId);
      if (!hasCwd && !hasSid) return true;
      // ① 会话命中：同一次会话里登记的，一定属于"我正在做的事"
      if (hasSid && rec.session_id && String(rec.session_id) === String(ws.sessionId)) return true;
      // ① 路径命中：记录在 cwd 之下（含 cwd 本身）
      if (hasCwd && rec.path) {
        var file = rpNormPath(rec.path);
        var root = rpNormPath(ws.cwd);
        if (root && (file === root || file.indexOf(root + "/") === 0)) return true;
      }
      return false;
    }

    /**
     * 范围三档 —— **依琪给的顺序**：当前会话 → 当前工作区 → 全部。
     *
     * ⚠️ 这是**一个维度的三个取值**，所以是**单选下拉**，不是三个平行按钮
     *    （档 B 的教训：平行按钮会让用户以为它们是同级分类）。
     * ⚠️ 也**不是复选框**（2026-10-18 晚依琪否掉了那个方案：
     *    「干嘛全摆出来让人打勾」—— 那版把三组选项在一个小窗里全摊开，
     *    既占地方又让人以为要逐项勾。现在改成三个独立的单选下拉，选完即收）。
     */
    var RP_SCOPES = [
      { id: "session", label: "当前会话" },
      { id: "workspace", label: "当前工作区" },
      { id: "all", label: "全部" },
    ];

    /**
     * 类型筛选（依琪要的：产出 / 资料）。
     *
     * ⚠️ 2026-10-18 晚**去掉了「待精化」** —— 依琪：
     *    「去掉待精炼，只留下一键精炼，跟标记的新的未被ai精炼的文件」。
     *    ⇒ 「未精炼」不是**一种类型**，而是一个**状态标记**（行上挂个点）
     *      + 一个**动作**（一键精炼）。把它塞进类型下拉是维度混淆。
     */
    var RP_FILTERS = [
      { id: "", label: "全部类型", query: {} },
      { id: "deliverable", label: "产出", query: { kind: "deliverable" } },
      { id: "reference", label: "资料", query: { kind: "reference" } },
    ];

    /**
     * ══════════════════════════════════════════════════════════════════════
     * **统一的筛选维度 + 多选判定**（2026-10-19 · 侧栏与管理页共用这一份）
     * ══════════════════════════════════════════════════════════════════════
     *
     * 【为什么要抽出来】
     *   重做前两侧各写一套：侧栏 `RP_FILTERS`（3 个类型）、管理页 `fKind`+`fType`
     *   （2 个 + 57 个），同一个概念两种叫法、选项还不一致。
     *   ⇒ 维度定义与判定**只能有一处**，否则迟早漂移（今晚已经栽过一次：
     *     受管标签行内传对象、预览传数组，两套逻辑两种行为）。
     *
     * 【为什么多选在前端做（依琪 2026-10-19 选 A）】
     *   宿主 `store.list()` 的签名是**单值相等**：
     *       list({ kind, artifact_type, project, tag, … })
     *   没有 `kind[]`。要支持多值就得改 `store.js` + `http.js` + 契约测试。
     *   ⇒ 不动契约：**拉全量一次，之后零请求**（447 条实测 ~200ms）。
     *   ⚠️ 副作用：库很大时首次会慢。超过 5000 条要重新评估（加警告或分页）。
     */

    /**
     * 多选状态的标准形状：`{ 维度名: [值, …] }`。
     * ⚠️ **空数组 = 不筛**（不是"筛不出任何东西"）—— 这是最容易写反的地方。
     */
    var RP_EMPTY_SELECT = { kind: [], artifact_type: [], project: [], tag: [] };

    /** 多选状态的持久化键。 */
    var RP_PICKS_KEY = "alf-rp-picks";

    /**
     * 读多选状态。⚠️ 读不到 / 畸形 ⇒ **全空**（= 不筛，不是筛空）。
     * ⚠️ 存量里某个值已不存在时**原样保留**（用户能在下拉里看到它被勾上并取消）；
     *    不在这里"自动清理"，因为那会让用户的选择在他不知情时消失。
     */
    function rpPicksInitial() {
      var out = { kind: [], artifact_type: [], project: [], tag: [] };
      try {
        var raw = localStorage.getItem(RP_PICKS_KEY);
        if (!raw) return out;
        var saved = JSON.parse(raw);
        for (var k in out) {
          if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
          var v = saved ? saved[k] : null;
          out[k] = Array.isArray(v) ? v.map(String).filter(function (x) { return !!x; }) : [];
        }
      } catch { /* 忽略：全空 */ }
      return out;
    }

    /** 某维度是否"没选任何值"（= 不筛）。 */
    function rpNoPick(sel, key) {
      var v = sel ? sel[key] : null;
      return !Array.isArray(v) || v.length === 0;
    }

    /** 已选总数（给"已选 N 项"文案用）。⚠️ 全维度求和，不是某个维度。 */
    function rpPickCount(sel) {
      var n = 0;
      for (var k in RP_EMPTY_SELECT) {
        if (!Object.prototype.hasOwnProperty.call(RP_EMPTY_SELECT, k)) continue;
        var v = sel ? sel[k] : null;
        if (Array.isArray(v)) n += v.length;
      }
      return n;
    }

    /** 切换一个值的选中状态（返回**新对象**，不许原地改 —— React 靠引用比较）。 */
    function rpTogglePick(sel, key, value) {
      var next = {};
      for (var k in RP_EMPTY_SELECT) {
        if (!Object.prototype.hasOwnProperty.call(RP_EMPTY_SELECT, k)) continue;
        next[k] = Array.isArray(sel && sel[k]) ? (sel[k]).slice() : [];
      }
      var list = next[key] || [];
      var at = list.indexOf(value);
      if (at >= 0) list.splice(at, 1);
      else list.push(value);
      next[key] = list;
      return next;
    }

    /**
     * 一条记录是否通过多选筛选。
     *
     * ⚠️ **维度内 = OR，维度间 = AND**（这是多选筛选的唯一正确答案）：
     *    · 类型选了「产出 + 资料」⇒ 两者都要（OR）
     *    · 项目选了「A」且标签选了「B」⇒ 同时满足（AND）
     * ⚠️ 某维度**空数组 = 不筛**，不许当成"什么都不匹配"（那是把"没选"当"选了空"）。
     */
    function rpMatchPicks(rec, sel) {
      if (!rec) return false;
      // 类型（kind：交付物 / 参考资料）
      if (!rpNoPick(sel, "kind") && sel.kind.indexOf(rec.kind) < 0) return false;
      // 分类（artifact_type：文档 / 图片 / 代码…）
      if (!rpNoPick(sel, "artifact_type") && sel.artifact_type.indexOf(rec.artifact_type) < 0) return false;
      // 项目
      if (!rpNoPick(sel, "project")) {
        var p = String(rec.project || "");
        if (sel.project.indexOf(p) < 0) return false;
      }
      // 标签：**任一命中即可**（标签是多值的，选了 A+B 表示"带 A 或带 B"）
      if (!rpNoPick(sel, "tag")) {
        var tags = Array.isArray(rec.tags) ? rec.tags : [];
        var hit = false;
        for (var i = 0; i < sel.tag.length; i += 1) {
          if (tags.indexOf(sel.tag[i]) >= 0) { hit = true; break; }
        }
        if (!hit) return false;
      }
      return true;
    }

    /**
     * 从一批记录里算出**可选的维度值**（含计数）。
     *
     * ⚠️ 计数必须基于**当前已拉到的全量**，不是"已筛选后的结果"——
     *    否则选一个值之后其他值的计数会失真，用户看到的数字会跳。
     * ⚠️ 排序：先按计数降序（常用的在前），同计数按名称 —— 稳定的顺序。
     */
    function rpPickOptions(items, key) {
      var count = {};
      var list = Array.isArray(items) ? items : [];
      for (var i = 0; i < list.length; i += 1) {
        var r = list[i];
        if (!r) continue;
        if (key === "tag") {
          var tags = Array.isArray(r.tags) ? r.tags : [];
          for (var t = 0; t < tags.length; t += 1) {
            var tk = String(tags[t]);
            count[tk] = (count[tk] || 0) + 1;
          }
        } else {
          var v = String(r[key] === undefined || r[key] === null ? "" : r[key]);
          // ⚠️ 空值不列进选项（"未分类"/"未设项目"这种要单独给，不能混在真值里）
          if (!v) continue;
          count[v] = (count[v] || 0) + 1;
        }
      }
      var out = [];
      for (var name in count) {
        if (Object.prototype.hasOwnProperty.call(count, name)) out.push({ value: name, count: count[name] });
      }
      out.sort(function (a, b) {
        if (b.count !== a.count) return b.count - a.count;
        return a.value < b.value ? -1 : (a.value > b.value ? 1 : 0);
      });
      return out;
    }

    /**
     * 排序四档（依琪要的：时间 / 大小 / 类型 / 名称）。
     *
     * ⚠️ `type` 在宿主侧**没有**对应 `sort` 值（`store.js` 的 `SORT_ORDERS` 只认
     *    created/updated/size/name）⇒ **类型排序在本地做**（按 `artifact_type` 分组，
     *    组内按最近更新）。不为一个 UI 需求去改宿主契约。
     */
    var RP_SORTS = [
      { id: "updated_desc", label: "最近更新" },
      { id: "size_desc", label: "大小" },
      { id: "type", label: "类型" },
      { id: "name_asc", label: "名称" },
    ];

    /** 单次最多渲染多少行（超出**必须明说**，不许静默截断）。 */
    var RP_ROW_LIMIT = 200;

    /**
     * 行内标签的**防御性上限**（不是"显示几个"）。
     *
     * ⚠️⚠️ 2026-10-19 依琪指出的错：
     *    「对我明明给标签更多空间了还在折叠这就不对」
     *    原来这里是 `2`，硬截前 2 个 + `+N` —— **写死的个数**，
     *    完全不理会用户已经把标签列拖宽了。空间够了还在折叠，就是错。
     *
     * ⚠️ 现在**不靠个数折叠，靠 CSS 裁**：
     *    全部渲染，列宽决定显示多少（拖宽就多显示，拖窄就自然截断）。
     *    这个 20 只是**防御**：真库实测最多 13 个标签、常态最多 7 个
     *    ⇒ 正常数据**永不触发**，只在畸形记录上保命（不让行高爆炸）。
     */
    var RP_TAG_SHOW = 20;

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
      // ⚠️ 统一走 `rpManagedTags`（2026-10-19）—— 原来这里自己剥了一层 `.tags`，
      //    而行内没剥 ⇒ 同一个数据两种行为（行内全警告、预览正常）。
      var managedTags = rpManagedTags(props.managed);

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
        // ⚠️ 这里必须用 `fileUrl`（**原图**），**不能**用 `thumbUrlsFor` 那条路。
        //    2026-10-14 修：原来写的是 `thumbUrlsFor(rec).primary` —— 那是
        //    **缩略图端点（会降采样）**，而且在**记录**形状上取 `row.size` 根本取不到
        //    （记录用 `size_bytes`）⇒ 5MB 门槛静默失效。
        //    预览就该给原图：原版 `Thumb(big=true)` 用的也是 `fileUrl(record.id)`。
        body = h("div", { className: NS + "__rpmedia" },
          h("img", { className: NS + "__rpimg", src: fileUrl(rec.id), alt: String(rec.title || rec.filename || "") }));
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
          tagChips(h, rec.tags, { managed: managedTags, surface: "chip", onPick: props.onPickTag }))
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
        // ── 操作行（2026-10-18 · 档 B）────────────────────────────────────
        // ⚠️ 为什么必须有：原来预览页只有「← 返回」—— 看完一个文件想"打开/定位/复制路径"
        //    得**回管理页**再找一遍。那正好毁掉右栏"快"的定位。
        // ⚠️ 四个按钮都是**高频轻动作**；"编辑/回收/精炼"这类**改动数据**的仍留在管理页
        //    （右栏不该有不可逆操作 —— 620px 里误点代价大）。
        h("div", { className: NS + "__rpacts" },
          h("button", {
            type: "button", className: NS + "__rpact",
            title: "在资源管理器中定位",
            onClick: function () { revealRecord(rec); },
          }, "📂 定位"),
          h("button", {
            type: "button", className: NS + "__rpact",
            title: "复制文件路径",
            onClick: function () { copyRecordPath(rec); },
          }, "📋 路径"),
          h("button", {
            type: "button", className: NS + "__rpact",
            title: "用系统默认程序打开",
            onClick: function () { openRecord(rec); },
          }, "↗ 打开"),
          h("button", {
            type: "button", className: NS + "__rpact",
            title: "在管理页里编辑这条（标签/摘要/星级/关联）",
            onClick: openPage,
          }, "✎ 编辑")),
        h("div", { className: NS + "__rppvbody" }, tagRow, body));
    }

    /**
     * 发一个**写请求**（POST）给宿主。
     *
     * ⚠️ 为什么这里自己拼而不用 `apiSend`：`apiSend` 在 2026-10-14 批次 B
     *    随主面板一起删了（右栏当时是只读的，没人调它）。
     *    现在预览页多了操作行又需要写通道 ⇒ **按现在的最小需求**写一个，
     *    不把那个带一堆历史的旧函数搬回来（它还有超时/重试等一堆没人用的分支）。
     *
     * ⚠️ 必须带 `X-DSH-Artifacts` 那个 CSRF 头 —— 宿主在 `http.js` 里校验它，
     *    不带会被 403。头名与值**只在这一处定义**（别抄到第二个地方）。
     *
     * @param {string} path 已编码的路径（含查询串）
     * @returns {Promise<*>} 解析后的 JSON；非 2xx 时 reject
     */
    function apiPost(path) {
      var base = cachedUrl || "";
      // ⚠️ 只取 origin：`cachedUrl` 是管理页的完整 URL，拼接口要的是根
      var origin = "";
      try { origin = base ? new URL(base).origin : ""; } catch { origin = ""; }
      var url = (origin || "") + API + path;
      return fetch(url, {
        method: "POST",
        headers: { accept: "application/json", "x-dsh-artifacts": "1" },
      }).then(function (r) {
        if (!r.ok) return Promise.reject(new Error("HTTP " + String(r.status)));
        return r.json().catch(function () { return {}; });
      });
    }

    /** 弹一条提示（⚠️ 走 `toastBus`：应用级浮层，面板卸载也不丢）。 */
    function notify(message) {
      try { toastBus.emit(message); } catch { /* 提示失败不影响主流程 */ }
    }

    /**
     * 在资源管理器中**定位**这条记录（选中它）。
     *
     * ⚠️ 走 `POST /<id>/open` —— 宿主侧它的实现是 **`revealPath`**（定位，不是打开），
     *    见 `lib/http.js` L765。名字叫 open 是历史原因，**语义是 reveal**。
     * ⚠️ 为什么不用 `files/reveal?path=`：那个按**路径**定位，而产物可能已
     *    `exists:false`（文件不在原位），传旧路径会 404。按 **id** 走由宿主决定。
     */
    function revealRecord(rec) {
      if (!rec || !rec.id) return;
      try {
        apiPost("/" + encodeURIComponent(rec.id) + "/open").catch(function () {
          notify("定位失败（文件可能已不在原位置）");
        });
      } catch {
        // 可选 catch 绑定：同步抛（极少）也不能把预览页带崩
        notify("定位失败");
      }
    }

    /**
     * 复制这条记录的 **@ 引用**（依琪要的：「每个文件都可以点击@快速复制提示词」）。
     *
     * ⚠️ 形状必须与官方 mention **完全一致** —— 复用 `atMention`（那一份已有 3 条测试守着：
     *    无空格 `@path` / 含空格 `@"path"` / 含引号和控制字符判为不可用）。
     *    ⇒ 不在这里自己拼 `"@" + path`，否则含空格的路径会粘不进对话。
     */
    function copyMention(rec) {
      var p = rec && rec.path ? String(rec.path) : "";
      if (!p) { notify("这条记录没有路径"); return; }
      var mention = atMention(p, !!(rec && rec.is_dir));
      if (!mention) { notify("这个路径含引号或控制字符，做不了 @ 引用"); return; }
      writeClipboard(mention, "已复制 " + mention);
    }

    /** 批量复制多条 @ 引用（每行一个）。 */
    function copyMentions(recs) {
      var list = (recs || []).map(function (r) { return atMention(String(r.path || ""), !!r.is_dir); })
        .filter(function (s) { return !!s; });
      if (!list.length) { notify("选中的条目都没有可引用的路径"); return; }
      writeClipboard(list.join("\n"), "已复制 " + String(list.length) + " 条 @ 引用");
    }

    /**
     * 写剪贴板（统一一处，带降级）。
     * ⚠️ `navigator.clipboard` 在**非 https / 非 localhost** 下不存在；
     *    这里宿主是本机 http，通常可用，但**不许假设**（不能用就明说，别静默）。
     */
    function writeClipboard(text, okMessage) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () { notify(okMessage); },
            function () { notify("复制失败（剪贴板被拒）"); }
          );
          return;
        }
      } catch { /* 落到下面 */ }
      notify("剪贴板不可用");
    }

    /** 复制这条记录的文件路径（剪贴板不可用就提示，不抛）。 */
    function copyRecordPath(rec) {
      var p = rec && rec.path ? String(rec.path) : "";
      if (!p) { notify("这条记录没有路径"); return; }
      writeClipboard(p, "已复制路径");
    }

    /**
     * 用系统默认程序**打开文件本身**（不是定位）。
     *
     * ⚠️ 这里必须走 `files/open?path=`（**按路径**）：
     *    `POST /<id>/open` 在宿主侧是 `revealPath`（定位），拿它当"打开"会**行为不对**。
     *    两条端点的语义差别是**真的**，不是命名问题 —— 所以两个按钮走两条路。
     */
    function openRecord(rec) {
      var p = rec && rec.path ? String(rec.path) : "";
      if (!p) { notify("这条记录没有路径"); return; }
      try {
        apiPost("/files/open?path=" + encodeURIComponent(p)).catch(function () {
          notify("打开失败（文件可能已不在原位置）");
        });
      } catch {
        notify("打开失败");
      }
    }

    /**
     * 这条记录该显示什么后缀（**纯函数**，能单测）。
     *
     * ⚠️ 优先级（三条都是踩过坑的）：
     *   ① 宿主算好的 `extension`（带点，如 `.md`）—— 最可信，它和 mime 一起算的；
     *   ② 拿不到就从 `filename` 里抠（**只取最后一个点之后**，且不认 `a.b/c` 里的点）；
     *   ③ 都没有 → 返回 `"?"`，**不返回空串**。
     *      ⚠️ 空串会让徽章变成一个看不见的框（`padding` 还在），看起来像布局错。
     *        返回 `"?"` 至少是诚实的"不知道"。
     *
     * ⚠️ **不是** `artifact_type`：那是"分类"（document / code / image…），
     *    与"文件是什么格式"是两码事 —— 一个 `.md` 既可能归 document 也可能归 code。
     *
     * @param {{extension?: string, filename?: string, path?: string}} rec
     * @returns {string} 形如 `.md` / `.blend` / `?`
     */
    function rpExtOf(rec) {
      if (!rec) return "?";
      var ext = String(rec.extension || "").trim();
      if (ext) return ext.charAt(0) === "." ? ext.toLowerCase() : "." + ext.toLowerCase();
      // 退路：从文件名里抠。⚠️ 先去掉目录部分 —— 否则 `C:\a.b\file` 会抠出 `.b\file`
      var name = String(rec.filename || rec.path || "");
      var slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
      if (slash >= 0) name = name.slice(slash + 1);
      var dot = name.lastIndexOf(".");
      // `dot <= 0` 覆盖两种情况：没有点、或是 dotfile（`.gitignore` 的后缀是空，不是 gitignore）
      if (dot <= 0 || dot === name.length - 1) return "?";
      return "." + name.slice(dot + 1).toLowerCase();
    }

    /**
     * 从 `/managed-tags` 的**响应对象**里取出 `tags` 数组（**唯一出口**）。
     *
     * ⚠️ 为什么必须有这个函数（2026-10-19 的 bug）：
     *    行内标签直接传了整个响应对象给 `tagChips`，而它用
     *    `Array.isArray(managed)` 判断"读没读到" ⇒ 对象一律判成**读不到** ⇒
     *    每行都显示"标签样式读不到"的警告（依琪截图里那串红字就是这么来的）。
     *    而预览页自己多剥了一层 `.tags` ⇒ **同一个数据两种行为**。
     *    ⇒ 收成一个函数，两处都调它，**不可能再漂移**。
     *
     * ⚠️ 三态**不许拍平**（与 `tagChips` 的契约一致）：
     *    · `null`        = **还没拉到 / 拉失败**（`tagChips` 会大声警告）
     *    · `[]`          = **拉到了，但表是空的**（合法的"你没有配受管标签"）
     *    · `[{…}]`       = 拉到了且有内容
     *
     * @param {*} body `apiGet("/managed-tags")` 的返回值（可能是任意畸形）
     * @returns {Array|null} 规范化的 tags 数组，或 `null`
     */
    function rpManagedTags(body) {
      if (!body || typeof body !== "object") return null;
      // ⚠️ `ok === false` 明确表示"拉过且失败" ⇒ 也是 `null`（不是空数组）
      if (body.ok === false) return null;
      // 已是数组（调用方自己剥好了）⇒ 原样用
      if (Array.isArray(body)) return body;
      // 标准形状 `{ok:true, tags:[…]}`
      if (Array.isArray(body.tags)) return body.tags;
      return null;
    }

    /**
     * 列表的**列定义**（2026-10-19 第 2 步）。
     *
     * ⚠️ 顺序是依琪定的：**文件名 / 标签 / 类型 / 大小**。
     *    他说「你要标注好，文件名，标签，这样顶上分类连同分割线」
     *    ⇒ 顶上要**有表头**，且各列之间**有分割线**。
     *
     * ⚠️ 每列给一个 `fr` 权重而不是固定 px：620px 里固定宽度会溢出，
     *    用 fr 才能自适应；拖动改宽度留到第 3 步（那时才引入 px）。
     */
    var RP_COLUMNS = [
      // ⚠️⚠️ **所有列都是固定 px**（2026-10-19 修）。
      //    之前名字列用 `1fr` 吃剩余空间，导致拖**任何**一列时，
      //    多/少出来的空间全给那个 1fr ⇒ 视觉上永远只有"名字/标签之间"在动。
      //    那不是"把手下发错了"，是**布局模型错了**。
      //    ⇒ 现在尾部单独留一个空白列（`minmax(0,1fr)`）吸收剩余空间，
      //      每根把手只改**它左边那一列**（Windows 资源管理器就是这个行为）。
      // ⚠️ 标签列默认给得宽（2026-10-19）：真库中位数是 **6 个标签**，
      //    之前 108px 只够放 2 个 ⇒ 一打开就被裁，看起来像"又折叠了"。
      { key: "name", label: "文件名", min: 110, defaultPx: 180 },
      { key: "tags", label: "标签", min: 44, defaultPx: 180 },
      { key: "ext", label: "类型", min: 36, defaultPx: 46 },
      { key: "size", label: "大小", min: 40, defaultPx: 54 },
    ];

    /** 列宽持久化键。 */
    var RP_COLS_KEY = "alf-rp-widths";

    /**
     * 当前列宽（模块级单例）。
     * ⚠️ 不用 React state：拖动时每帧都改，走 props 会让**整个列表**重渲染。
     *    这里只让"需要重新算模板"的两处（表头 / 行）跟着变。
     */
    var rpWidthsStore = null;
    /** 列宽变化时通知界面重画（由 RightPaneBody 注册）。 */
    var rpWidthsNotify = null;

    function rpGetWidths() {
      if (!rpWidthsStore) rpWidthsStore = rpWidthsInitial();
      return rpWidthsStore;
    }

    /** 设一列的宽并重画。⚠️ 顺手持久化（拖动结束不必再单独存）。 */
    function rpSetColWidth(key, px) {
      var w = rpGetWidths();
      if (w[key] === px) return;
      w[key] = px;
      try { localStorage.setItem(RP_COLS_KEY, JSON.stringify(w)); } catch { /* 忽略 */ }
      if (typeof rpWidthsNotify === "function") rpWidthsNotify();
    }

    /** 双击把手：恢复该列默认宽。 */
    function rpResetCol(col) {
      var w = rpGetWidths();
      if (!Object.prototype.hasOwnProperty.call(w, col.key)) return;
      delete w[col.key];
      try { localStorage.setItem(RP_COLS_KEY, JSON.stringify(w)); } catch { /* 忽略 */ }
      if (typeof rpWidthsNotify === "function") rpWidthsNotify();
    }

    /**
     * 列宽模板（**行与表头共用这一份** —— 各自算必然差几像素）。
     * ⚠️ 前面留出勾选框那一列（`__rpck` 自己定宽）。
     */
    /**
     * 列宽模板。
     *
     * ⚠️ 关键：**每一列都是固定 px，末尾多一个 `minmax(0,1fr)` 空白列**。
     *    这样拖某根把手只改它左边那一列，别的列纹丝不动；
     *    窗口变宽时变宽的是**尾部空白**，不是某一列。
     *    （`minmax(0,1fr)` 而不是 `1fr`：前者允许缩到 0，窄窗口下不会把列挤溢出。）
     */
    function rpColumnTemplate(widths) {
      var cells = RP_COLUMNS.map(function (c) {
        var raw = widths ? widths[c.key] : undefined;
        var n = Number(raw);
        // ⚠️ 存了非法值（`NaN`/负数）⇒ 用默认；存了合法但过小的值 ⇒ **夹到 min**。
        //    不夹到 min 而是退回默认的话，用户拖到很窄会"跳回"默认宽，看起来像没拖成。
        var px = (raw === undefined || raw === null || !isFinite(n)) ? c.defaultPx : Math.max(c.min, Math.round(n));
        return px + "px";
      });
      // 勾选框占位 16px + 四列 + 尾部空白
      return "16px " + cells.join(" ") + " minmax(0,1fr)";
    }

    /** 读存下来的列宽。⚠️ 畸形/负数一律忽略 —— 不能让一个坏值把布局搞崩。 */
    function rpWidthsInitial() {
      var out = {};
      try {
        var raw = localStorage.getItem(RP_COLS_KEY);
        if (!raw) return out;
        var saved = JSON.parse(raw);
        RP_COLUMNS.forEach(function (c) {
          if (c.defaultPx === null) return;
          var v = Number(saved && saved[c.key]);
          if (isFinite(v) && v >= c.min) out[c.key] = v;
        });
      } catch { /* 忽略：用默认 */ }
      return out;
    }

    /**
     * 开始拖动某一列的分隔线。
     *
     * ⚠️ 三个细节都是踩过的：
     *   ① `setPointerCapture` —— 否则鼠标拖出侧栏就收不到 `pointermove`，列宽卡住；
     *   ② `preventDefault` —— 否则拖动会**选中一片文字**（界面上一片蓝）；
     *   ③ 拖完要**成对清理**三个监听（pointerup / pointercancel 都要）——
     *      只在 pointerup 清会在触屏取消时留下野监听。
     */
    function rpStartDrag(event, col) {
      if (!event || !event.currentTarget) return;
      // ⚠️ 2026-10-19 起**没有弹性列**了（全部固定 px），这里不需要再排除。
      try { event.preventDefault(); event.stopPropagation(); } catch { /* 忽略 */ }

      var startX = Number(event.clientX) || 0;
      var grip = event.currentTarget;
      // 起始宽：优先用当前实际渲染宽（比 defaultPx 准 —— 用户可能已经拖过）
      var startW = Number(col.defaultPx);
      try {
        var cell = grip.parentNode;
        if (cell && cell.getBoundingClientRect) startW = cell.getBoundingClientRect().width;
      } catch { /* 忽略 */ }

      try { if (grip.setPointerCapture) grip.setPointerCapture(event.pointerId); } catch { /* 老浏览器 */ }

      var prevCursor = "";
      try { prevCursor = document.body.style.cursor; document.body.style.cursor = "col-resize"; } catch { /* 忽略 */ }

      function onMove(e) {
        var dx = (Number(e.clientX) || 0) - startX;
        // ⚠️ 夹到 min：不夹能拖成负宽 = 这一列消失（看起来像数据丢了）
        var w = Math.max(col.min, Math.round(startW + dx));
        rpSetColWidth(col.key, w);
      }
      function onUp() {
        try { document.body.style.cursor = prevCursor; } catch { /* 忽略 */ }
        try { if (grip.releasePointerCapture) grip.releasePointerCapture(event.pointerId); } catch { /* 忽略 */ }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    }

    /**
     * 表头（文件名 / 标签 / 类型 / 大小 + 每列右侧分隔线）。
     *
     * ⚠️ **不含拖动**（第 3 步再加）。这里只做：标注 + 对齐 + 分割线。
     * ⚠️ 用 `role="row"` + `columnheader` 而不是 `<table>`：
     *    表格布局在"行可点、里面还有勾选框/按钮"时很难做（`<tr>` 里塞 `<button>` 语义也怪），
     *    而 grid + role 能拿到同样的读屏语义，且自由度更高。
     */
    function rpHeader(h, o) {
      return h("div", {
        className: NS + "__rpcols",
        style: { gridTemplateColumns: rpColumnTemplate(rpGetWidths()) },
        role: "row",
      },
        // 勾选框列的占位（让表头与行的列起点对齐）
        h("span", { className: NS + "__rpcolck", "aria-hidden": "true" }),
                RP_COLUMNS.map(function (c, i) {
          var sortable = !!c.sort;
          var last = i === RP_COLUMNS.length - 1;
          return h("span", {
            key: c.key,
            className: NS + "__rpcol" + (sortable ? " " + NS + "__rpcol--on" : ""),
            role: "columnheader",
            title: sortable ? "点击按" + c.label + "排序；右侧竖线可拖动调宽" : c.label + "（右侧竖线可拖动调宽）",
            onClick: sortable && o && o.onSort ? function () { o.onSort(c.sort); } : undefined,
          },
            // ⚠️ 文字包一层：`overflow:hidden` 放**内层**，否则格子的 overflow
            //    会把绝对定位的拖动把手裁掉（第一版就是这么"看不见分割线"的）。
            h("span", { className: NS + "__rpcoltext" }, c.label),
            // ⭐ 拖动把手。最后一列不给（右边没有下一列，一条线悬空很奇怪）。
            last ? null : h("span", {
              className: NS + "__rpgrip",
              role: "separator",
              "aria-orientation": "vertical",
              "aria-label": "拖动调整「" + c.label + "」列宽",
              title: "拖动调整「" + c.label + "」列宽（双击恢复默认）",
              onPointerDown: function (event) { rpStartDrag(event, c); },
              // ⚠️ 拦住点击：否则拖完松手会**顺带触发排序**
              onClick: function (event) { if (event && event.stopPropagation) event.stopPropagation(); },
              onDoubleClick: function (event) {
                if (event && event.stopPropagation) event.stopPropagation();
                rpResetCol(c);
              },
            }));
          }));
    }

    /**
     * 行内标签（**纯函数**）。
     *
     * 依琪 2026-10-18：「我发现你的标签这边没有快速显示啊，帮人快速分辨」
     * 2026-10-19 核对：行里确实**只有** 名字 → 后缀 → 大小，`tagChips` 只在预览页用。
     *
     * ⚠️ **只显示前 `RP_TAG_SHOW` 个 + `+N`**，不全部显示：
     *    620px 的行里塞 6 个标签会把「名字」压没 —— 而名字才是主要信息。
     * ⚠️ 用既有 `tagChips`（吃受管表、带颜色），**不自己拼**：
     *    颜色/字重只有规则层知道，自己拼会与预览区不一致。
     * ⚠️ 折叠了但**信息不丢**：`+N` 的 title 里给全部标签。
     * ⚠️ 没标签时返回 `null`（**不返回 `—`**）：行内空间宝贵，
     *    空标签占一个「—」的宽度纯属浪费 —— 与预览区不同，那里是"字段"必须有值。
     *
     * @param {Function} h React.createElement
     * @param {object} rec 产物记录
     * @param {Array|null} managedTags 受管标签表（`null` = 读不到，交给 tagChips 自己警告）
     */
    function rpTagCell(h, rec, managedTags, onPick) {
      var tags = (rec && rec.tags) ? rec.tags : [];
      if (!tags.length) return null;
      var shown = tags.slice(0, RP_TAG_SHOW);
      var rest = tags.length - shown.length;
      return h("span", {
        className: NS + "__rptags",
        // ⚠️ 悬停看全部（裁切是视觉的，信息不许丢）
        title: tags.join(" / "),
      },
        // ⚠️ **全部渲染**（不再按个数截）：列拖宽就显示更多、拖窄就 CSS 裁掉。
        //    "显示几个"是**列宽的后果**，不该由代码数个数决定。
        tagChips(h, shown, { managed: managedTags, surface: "chip", onPick: onPick }),
        // 防御性折叠：只有超过 20 个（真库最多 13）才会走到这里
        rest > 0
          ? h("span", {
            className: NS + "__rptagmore",
            title: "还有 " + String(rest) + " 个标签：" + tags.slice(RP_TAG_SHOW).join(" / "),
          }, "+" + String(rest) + " 个")
          : null);
    }

    /**
     * 一个**极简下拉**（原生 `<select>`）。
     *
     * ⭐ 2026-10-18 晚定稿：范围 / 筛选 / 排序 = **三个独立的下拉**，不是一个大窗。
     *    ⚠️ 与档 B 的「芯片」以及中间那版「一个大窗里全摊开」都不同：
     *      · 芯片版：三组平铺，占一整行还装不下；
     *      · 大窗版：三组全摊开，依琪否掉 ——「干嘛全摆出来让人打勾」；
     *      · **现在**：三个 `<select>`，点开才出一个临时小窗，**选完即收**。
     *
     * ⚠️ 为什么用原生 `<select>` 而不是自造弹层：
     *    ① 620px 窄栏里自造弹层的**定位/翻转/点外关闭/Esc** 全要自己处理
     *       （`ui-spec` §11.1 那一整套），而原生 select 天然有；
     *    ② 键盘可达性是白送的（方向键、首字母跳转、Esc）；
     *    ③ 手机上会弹系统级选择器，比自造的好用。
     *    ⇒ 这是"找现成方案"那条原则的直接应用。
     *
     * @param {Function} h React.createElement
     * @param {{label: string, value: string, options: Array<{id:string,label:string}>, onChange: Function, title?: string}} o
     * @returns {*} select 节点
     */
    /**
     * 右栏的**错误兜底**（error boundary）。
     *
     * ⚠️⚠️ 为什么必须有（2026-10-18 惨痛教训）：
     *    `RightPaneBody` 以前是**裸注册**的 —— 它在渲染期抛异常时，
     *    React 会把整棵子树卸载 ⇒ **整个应用白屏**，而用户只看到一个白页面，
     *    既没有报错也没有线索。为这个我排查了一个多小时，
     *    静态手段全用尽仍查不到（`node --check` / vm 求值 / 14 个组件逐个渲染 全绿）。
     *
     * ⚠️ 这**不是"排查手段"，是产品缺陷**：
     *    任何插件在渲染期抛异常都不该拖白整个 DSH。宿主没给这层保护，我们自己给。
     *
     * ⚠️ 用**类组件**是 React 的硬要求（`getDerivedStateFromError` 只有类能定义），
     *    不是风格选择。
     * ⚠️ 展示文案里**必带原始错误**：兜底不是把错误藏起来，
     *    是让它**可见且不致命**。否则"白屏"会变成"友好提示但没人知道为什么"。
     */
    var rpBoundaryCls = null;

    /** 缓存的 boundary 类（模块层单例 —— 每次渲染 new 一个子类会丢 state）。 */
    function rpBoundaryClass() {
      if (rpBoundaryCls) return rpBoundaryCls;
      var React = require("react");
      var h = React.createElement;
      var Base = React.Component;
      // ⚠️ 拿不到 Component（假 React / 极端环境）⇒ 给个透传组件，至少不崩
      if (typeof Base !== "function") {
        rpBoundaryCls = function Passthrough(props) { return props && props.children ? props.children : null; };
        return rpBoundaryCls;
      }
      function B(props) {
        Base.call(this, props);
        this.state = { error: null };
        this.handleReload = this.handleReload.bind(this);
      }
      B.prototype = Object.create(Base.prototype);
      B.prototype.constructor = B;
      B.getDerivedStateFromError = function (error) { return { error: error }; };
      B.prototype.componentDidCatch = function (error, info) {
        // ⚠️ 打到 console —— 这是开发者能在 DevTools 看到真因的**唯一**地方
        try {
          console.error("[artifact-library] 右栏渲染抛异常：", error, info && info.componentStack);
        } catch (e) { /* 忽略 */ }
      };
      B.prototype.handleReload = function () { this.setState({ error: null }); };
      B.prototype.render = function () {
        if (this.state && this.state.error) {
          var msg = this.state.error && this.state.error.message
            ? String(this.state.error.message) : String(this.state.error);
          return h("div", { className: NS + "__rpstate" },
            "右栏渲染出错了（已兜住，不影响应用其他部分）：",
            h("div", {
              style: { marginTop: "6px", fontFamily: "ui-monospace,Menlo,Consolas,monospace", fontSize: "12px" },
            }, msg),
            h("div", { style: { marginTop: "10px" } },
              h("button", {
                type: "button", className: NS + "__rpact",
                onClick: this.handleReload,
              }, "重试")));
        }
        return (this.props && this.props.children) ? this.props.children : null;
      };
      rpBoundaryCls = B;
      return B;
    }

    /** 把任意组件包进 boundary（注册席位时用）。 */
    function rpWithBoundary(Component) {
      var React = require("react");
      var h = React.createElement;
      return function Wrapped(props) {
        return h(rpBoundaryClass(), null, h(Component, props));
      };
    }

    /**
     * **多选下拉**（details + 复选框列表）。
     *
     * ⚠️ 三条设计决定：
     *   ① 用 details 白送键盘可达与展开/收起；**唯一要补的是"点外关闭"**
     *      （details 默认不会因点别处而收）。
     *   ② 选完**不自动收** —— 多选时自动收会让人反复点开（每个值都要开一次 = 折磨）。
     *   ③ summary 里显示**已选摘要**（"文档、图片 +2"），收起状态也能看出筛了什么。
     *      只显示"已选 N 项"不够 —— 用户想知道**是哪几项**。
     *
     * @param {Function} h React.createElement
     * @param {object} o {label, options, selected, onToggle, onClear, open, onOpenChange, allLabel, title}
     */
    function rpMultiSelect(h, o) {
      var selected = Array.isArray(o.selected) ? o.selected : [];
      var options = Array.isArray(o.options) ? o.options : [];
      var isOpen = o.open === true;
      var summary;
      if (!selected.length) {
        summary = o.allLabel || ("全部 " + o.label);
      } else if (selected.length <= 2) {
        summary = selected.join("、");
      } else {
        summary = selected.slice(0, 2).join("、") + " +" + String(selected.length - 2);
      }
      return h("div", {
        className: NS + "__rpmulti" + (selected.length ? " " + NS + "__rpmulti--on" : "") + (isOpen ? " " + NS + "__rpmulti--open" : ""),
      },
        h("button", {
          type: "button",
          className: NS + "__rpmsum",
          title: o.title || ("筛选：" + o.label),
          // aria-expanded 让读屏知道展开状态
          "aria-expanded": isOpen ? "true" : "false",
          onClick: function (event) {
            event.preventDefault();
            if (o.onOpenChange) o.onOpenChange(!isOpen);
          },
        },
          h("span", { className: NS + "__rpmsumlabel" }, o.label),
          h("span", { className: NS + "__rpmsumval" }, summary),
          h("span", { className: NS + "__rpmsumcar", "aria-hidden": "true" }, "▾")),
        isOpen
          ? h("div", { className: NS + "__rpmwrap", role: "group", "aria-label": o.label },
            h("div", { className: NS + "__rpmlist" },
              options.length
                ? options.map(function (opt) {
                  var on = selected.indexOf(opt.value) >= 0;
                  return h("label", {
                    key: opt.value,
                    className: NS + "__rpmopt" + (on ? " " + NS + "__rpmopt--on" : ""),
                  },
                    h("input", {
                      type: "checkbox",
                      className: NS + "__rpmck",
                      checked: on,
                      onChange: function () { if (o.onToggle) o.onToggle(opt.value); },
                    }),
                    h("span", { className: NS + "__rpmname" }, opt.value),
                    typeof opt.count === "number"
                      ? h("span", { className: NS + "__rpmcnt" }, String(opt.count))
                      : null);
                })
                : h("div", { className: NS + "__rpmempty" }, "没有可选项")),
            selected.length && o.onClear
              ? h("button", {
                type: "button",
                className: NS + "__rpmclear",
                onClick: function (event) {
                  if (event && event.stopPropagation) event.stopPropagation();
                  o.onClear();
                },
              }, "清空「" + o.label + "」")
              : null)
          : null);
    }
    function rpSelect(h, o) {
      return h("select", {
        className: NS + "__rpsel",
        // ⚠️ `aria-label` 必须带 —— 三个下拉光看值是分不清"这是范围还是排序"的
        "aria-label": o.label,
        title: o.title || o.label,
        value: o.value,
        onChange: function (event) {
          if (event && event.target) o.onChange(event.target.value);
        },
      },
        o.options.map(function (x) {
          return h("option", { key: x.id, value: x.id }, x.label);
        }));
    }

    /**
     * 头部：**搜索框 + 三个下拉 + 计数 + 管理页**（2026-10-18 晚定稿）。
     *
     * ⚠️ 620px 布局：搜索占**整行**，三个下拉 + 计数占第二行，管理页按钮在最右。
     */
    function rpHead(h, o) {
      return h("div", { className: NS + "__rphead" },
        // ── 第一行：搜索 ──
        h("div", { className: NS + "__rpsearch" },
          h("input", {
            type: "search",
            className: NS + "__rpinput",
            placeholder: "搜索标题 / 摘要 / 标签 / 文件名",
            "aria-label": "搜索产物",
            value: o.typed,
            onChange: function (event) { o.setTyped(event && event.target ? event.target.value : ""); },
            // Esc 清空 —— 有搜索框的地方这是肌肉记忆
            onKeyDown: function (event) {
              if (event && event.key === "Escape") { o.setTyped(""); o.setApplied(""); }
            },
          }),
          o.typed
            ? h("button", {
              type: "button",
              className: NS + "__rpclear",
              "aria-label": "清空搜索",
              onClick: function () { o.setTyped(""); o.setApplied(""); },
            }, "✕")
            : null),
        // ── 第二行：范围 / 类型 / 排序 + 计数 + 管理页 ──
        h("div", { className: NS + "__rpbar" },
          rpSelect(h, {
            label: "查看范围", value: o.scope, options: RP_SCOPES, onChange: o.setScope,
            title: "看哪一批（当前会话 / 当前工作区 / 全部）",
          }),
          // ── 多选下拉（2026-10-19 第 2 步）────────────────────────────
          // ⚠️ 「类型」拆成两个维度（原来混在一个下拉里，选项都不一致）：
          //    · 类别 = kind（产出 / 资料）——过滤逻辑层
          //    · 类型 = artifact_type（文档 / 图片 / 代码…）——文件格式层
          rpMultiSelect(h, {
            label: "类别",
            options: o.kindOptions || [],
            selected: (o.picks && o.picks.kind) || [],
            allLabel: "全部",
            open: o.openWhich === "kind",
            onOpenChange: function (next) { if (o.onOpen) o.onOpen(next ? "kind" : ""); },
            onToggle: function (v) { if (o.onPick) o.onPick("kind", v); },
            onClear: function () { if (o.onClearPick) o.onClearPick("kind"); },
            title: "按类别筛选（产出 / 资料）",
          }),
          rpMultiSelect(h, {
            label: "类型",
            options: o.typeOptions || [],
            selected: (o.picks && o.picks.artifact_type) || [],
            allLabel: "全部",
            open: o.openWhich === "artifact_type",
            onOpenChange: function (next) { if (o.onOpen) o.onOpen(next ? "artifact_type" : ""); },
            onToggle: function (v) { if (o.onPick) o.onPick("artifact_type", v); },
            onClear: function () { if (o.onClearPick) o.onClearPick("artifact_type"); },
            title: "按文件类型筛选（文档 / 图片 / 代码…）",
          }),
          rpMultiSelect(h, {
            label: "项目",
            options: o.projectOptions || [],
            selected: (o.picks && o.picks.project) || [],
            allLabel: "全部",
            open: o.openWhich === "project",
            onOpenChange: function (next) { if (o.onOpen) o.onOpen(next ? "project" : ""); },
            onToggle: function (v) { if (o.onPick) o.onPick("project", v); },
            onClear: function () { if (o.onClearPick) o.onClearPick("project"); },
            title: "按项目筛选",
          }),
          rpMultiSelect(h, {
            label: "标签",
            options: o.tagOptions || [],
            selected: (o.picks && o.picks.tag) || [],
            allLabel: "全部",
            open: o.openWhich === "tag",
            onOpenChange: function (next) { if (o.onOpen) o.onOpen(next ? "tag" : ""); },
            onToggle: function (v) { if (o.onPick) o.onPick("tag", v); },
            onClear: function () { if (o.onClearPick) o.onClearPick("tag"); },
            title: "按标签筛选（可多选）",
          }),
          rpSelect(h, {
            label: "排序", value: o.sort, options: RP_SORTS, onChange: o.setSort,
            title: "排序（最近更新 / 大小 / 类型 / 名称）",
          }),
          h("span", { className: NS + "__rpn" },
            o.ready ? String(o.shown) + "/" + String(o.total) : ""),
          // ⚠️ 一键精炼（依琪 2026-10-18）：「只留下一键精炼」——
          //    把**所有未精炼的**交给 AI，不用先筛。带数量，让人知道要动多少条。
          h("button", {
            type: "button",
            className: NS + "__rpopen",
            title: o.unrefined
              ? "把这些未精炼的（缺摘要/标签/项目）交给 AI 精炼，共 " + String(o.unrefined) + " 条"
              : "全部已精炼，没有要处理的",
            "aria-label": "一键精炼未精炼的条目",
            disabled: !o.unrefined,
            onClick: o.onRefineAll,
          }, o.unrefined ? "精炼 " + String(o.unrefined) : "精炼"),
          // ⚠️ 「整理」= AI 整理（项目合并候选）。依琪要的「合并类似项目」入口。
          h("button", {
            type: "button",
            className: NS + "__rpopen",
            title: "AI 整理：扫描可合并的项目名",
            "aria-label": "AI 整理",
            onClick: o.onCleanup,
          }, "整理"),
          // ⚠️ 「管理页」是**低频功能的入口**（登记 / 导入 / 精炼 / 整理建议 / 设置）
          h("button", {
            type: "button",
            className: NS + "__rpopen",
            title: "打开完整管理页（登记 / 导入 / 语义搜索 / 精炼 / 整理建议 / 设置）",
            "aria-label": "打开完整管理页",
            onClick: openPage,
          }, "管理页")));
    }

    /**
     * 批量操作栏（勾了才出现）。
     *
     * ⚠️ 三个动作都是**可逆或低风险**的（依琪 2026-10-18 选的范围）：
     *    · `@ 复制引用` —— 只读，纯剪贴板
     *    · `AI 精炼`    —— **先预览再确认**（24 条一次改动不可逆，不给"一键就改"）
     *    · `回收`       —— 进回收站，可恢复
     *    ⚠️ 故意**没有**「批量改项目 / 批量改标签」：那两个需要逐条确认目标值，
     *      在 620px 里做不成一次点完，留到管理页。
     */
    function rpBatchBar(h, o) {
      if (!o.count) return null;
      return h("div", { className: NS + "__rpbatch" },
        h("span", { className: NS + "__rpn" }, "已选 " + String(o.count) + " 项"),
        h("button", {
          type: "button", className: NS + "__rpact",
          onClick: o.onCopy,
        }, "@ 复制引用"),
        h("button", {
          type: "button", className: NS + "__rpact",
          onClick: o.onRefine,
        }, "AI 精炼"),
        h("button", {
          type: "button", className: NS + "__rpact",
          onClick: o.onTrash,
        }, "回收"),
        h("button", {
          type: "button", className: NS + "__rpclear",
          "aria-label": "取消选择",
          onClick: o.onClear,
        }, "✕"));
    }

    /**
     * AI 整理面板 —— 展示 `GET /suggest-cleanup` 的**项目合并候选**。
     *
     * ⚠️⚠️ **不许一键全合**（这是本文件反复强调的一条）：
     *    候选来自规则层（`exact`/`contains`/`prefix`/`tokens` 四档置信度），
     *    **词像不等于同一个项目**。最后一档 `tokens` 在 `store.js` 里就写着「待确认」。
     *    ⇒ 每一组要**用户自己点「合并」**，且合并后给「撤销」
     *      （`POST /projects/merge-undo`，可整份还原）。
     *
     * @param {Function} h React.createElement
     * @param {{items: Array, onMerge: Function, onUndo: Function, canUndo: boolean}} o
     */
    function rpCleanupPanel(h, o) {
      if (!o || !o.items || !o.items.length) {
        return h("div", { className: NS + "__rpstate" }, "没有发现可以合并的项目名。");
      }
      return h("div", { className: NS + "__rpclean" },
        h("div", { className: NS + "__rpnote" },
          "⚠️ 这些是**规则算出的候选**（名字像 ≠ 同一个项目）—— 每组自己看一眼再点合并。"),
        o.items.map(function (g) {
          var names = (g.names || []).map(function (n) { return n.name + "(" + n.count + ")"; }).join(" / ");
          return h("div", { className: NS + "__rpcrow", key: String(g.canonical) },
            h("div", { className: NS + "__rpccanon" }, "合并到「" + String(g.canonical) + "」"),
            h("div", { className: NS + "__rpn" }, names + " · 共 " + String(g.total) + " 条"),
            h("div", { className: NS + "__rpn" }, "置信度：" + cleanConfidenceLabel(g.confidence)
              + (g.reason ? "（" + g.reason + "）" : "")),
            h("button", {
              type: "button", className: NS + "__rpact",
              onClick: function () { o.onMerge(g); },
            }, "合并这 " + String((g.names || []).length) + " 个名字"));
        }),
        o.canUndo
          ? h("button", {
            type: "button", className: NS + "__rpact",
            onClick: o.onUndo,
          }, "↩ 撤销上一次合并")
          : null);
    }

    /**
     * 置信度 → 人话。
     * ⚠️ 四档的**含义不同**，别都叫"建议"：`exact` 是确定的，`tokens` 只是词重叠。
     */
    function cleanConfidenceLabel(c) {
      return { exact: "确定", contains: "高置信", prefix: "建议核对", tokens: "待确认" }[String(c)] || String(c || "未知");
    }

    /**
     * 空态文案 —— **五种分开**（不许拍平成一句：每种的下一步动作不同）。
     */
    function rpEmptyText(o) {
      if (o.isFiltering) return "没有符合当前搜索/筛选的产物 —— 库不是空的，是条件把结果筛掉了。";
      if (o.droppedByScope) {
        return (o.scopeLabel || "当前范围") + "里没有产物"
          + (o.cwd && o.scope === "workspace" ? "（" + o.cwd + "）" : "")
          + "。库里有 " + String(o.total) + " 条，但都不属于当前范围 —— 把范围切到「全部」就能看到。";
      }
      if (!o.cwd && o.scope === "workspace") return "拿不到当前工作目录 ⇒ 没有按工作区过滤。库里还没有产物。";
      return "库里还没有产物。";
    }

    /**
     * 右栏 tab 正文：**单栏主从**（列表 ↔ 预览）。
     *
     * ⚠️ **620px 窄栏**（实测：右栏 = 视口 45%）⇒ 单列、不换行、
     *    字号 **≥12px**（`ui-spec` [39] 硬断言）。
     *
     * 【定位】这一栏是**快捷板块**，不是"网页版的精简复制"：
     *   · 要"快"：搜索/筛选/预览都在**一次点击**之内；
     *   · 要"全"：登记 / 导入 / 精炼 / 整理 / 设置 / 文件浏览 / 语义搜索 **都在管理页**
     *     （`head` 里那个按钮是它们的**唯一入口**）。
     *   ⇒ 判断"某个功能该放这儿还是管理页"的标准：**高频 + 一屏能完成** 才放这儿。
     *
     * 【数据来源】组件在**模块层**，看不见 `apply` 的作用域 ⇒ 只能走 HTTP（`apiGet`）。
     *   `sessionId` / `useSessions` 是 **slot 系统注入到 props 的 hook**；
     *   现在只用 `sessionId`（「当前会话」粒度），`useSessions` 保留但**不再订阅**。
     *
     * @param {{sessionId?: string, useSessions?: Function}} props slot 注入的 props
     */
    /**
     * 加载 AI 整理建议（`GET /suggest-cleanup`）。
     *
     * ⚠️ 只取**项目合并候选** `projectMerges`（依琪要的「合并类似项目」）；
     *    重复记录 / 缺失 / 待精化那些在管理页有更完整的呈现，不在这儿重复。
     * ⚠️ 拿不到就**如实报错**，不许显示"没有可合并的"（那是把"读失败"说成"结果为空"）。
     */
    function loadCleanup(setClean) {
      setClean({ status: "loading", items: [], canUndo: false, error: "" });
      apiGet("/suggest-cleanup")
        .then(function (body) {
          setClean({
            status: "ready",
            items: (body && Array.isArray(body.projectMerges)) ? body.projectMerges : [],
            // ⚠️ 能否撤销由宿主说了算（`projectMergeUndo` 存在且有内容）
            canUndo: !!(body && body.projectMergeUndo),
            error: "",
          });
        })
        .catch(function (error) {
          setClean({
            status: "error", items: [], canUndo: false,
            error: (error && error.message) ? error.message : String(error),
          });
        });
    }

    /**
     * 执行一次项目合并。
     * ⚠️ `keepVariantAsTag` 不传 = **保持默认 true**（宿主侧缺省 true）——
     *    原项目名会变成 tag，别把「营销创意」那层信息弄丢（`store.js` 注释里依琪拍过板）。
     */
    function doProjectMerge(group, setClean) {
      var names = (group && group.names ? group.names : []).map(function (n) { return String(n.name); })
        .filter(function (n) { return n !== String(group.canonical); });
      if (!names.length) { notify("这一组只有规范名本身，不需要合并"); return; }
      apiPost("/projects/merge", { names: names, to: group.canonical })
        .then(function (r) {
          notify("已合并 " + String(r && r.merged ? r.merged : names.length) + " 个项目名");
          loadCleanup(setClean);
        })
        .catch(function (error) {
          notify("合并失败：" + (error && error.message ? error.message : String(error)));
        });
    }

    /** 撤销最近一次合并（**整份还原** project 与 tags）。 */
    function revertProjectMerge(setClean) {
      apiPost("/projects/merge-undo", {})
        .then(function () { notify("已撤销上一次合并"); loadCleanup(setClean); })
        .catch(function (error) {
          notify("撤销失败：" + (error && error.message ? error.message : String(error)));
        });
    }

    function RightPaneBody(props) {
      var React = require("react");
      var h = React.createElement;
      var sessionId = props && props.sessionId ? String(props.sessionId) : "";
      var useSessions = props && props.useSessions;
      // ⭐ 拿当前会话的 cwd（「仅看此工作区」要它）。
      //    ⚠️ 官方 `sidebar-files` 就是这么拿的 ⇒ 同一套注入面，别自己发明。
      //    拿不到就是空串 ⇒ `rpInWorkspace` 会**放行**（不误杀），不会让列表空掉。
      var cwd = "";
      try {
        if (typeof useSessions === "function" && sessionId) {
          cwd = useSessions(function (sessions) {
            var s = sessions && sessions.byId ? sessions.byId[sessionId] : undefined;
            return (s && s.cwd) ? String(s.cwd) : "";
          }) || "";
        }
      } catch {
        // 可选 catch 绑定（ES2019）：钩子形态变了/服务不在 ⇒ 当拿不到，别抛
        cwd = "";
      }

      // 范围三档（**单选下拉**，默认「当前工作区」）
      // ⚠️ 2026-10-18 晚改：原来是 checkbox + 徽章，依琪否掉了 ——
      //    「干嘛全摆出来让人打勾」。现在是一个下拉，选完即收。
      var scopePair = React.useState(function () { return rpScopeInitial(); });
      var scope = scopePair[0];
      var setScope = scopePair[1];
      // 持久化：每次切换写回。⚠️ 写失败不能影响界面（隐私模式会抛）
      React.useEffect(function () {
        try { localStorage.setItem(RP_SCOPE_KEY, String(scope)); } catch { /* 忽略 */ }
      }, [scope]);

      // 筛选芯片（档 B）：`""` = 全部
      var filterPair = React.useState("");
      // 多选筛选（2026-10-19 第 2 步）——判定/选项在模块层，这里只存状态。
      // ⚠️ 空数组 = 不筛（见 RP_EMPTY_SELECT 的注释）。
      var picksPair = React.useState(function () { return rpPicksInitial(); });
      var picks = picksPair[0];
      var setPicks = picksPair[1];
      /**
       * 点标签 ⇒ 按这个标签筛选（2026-10-19 · 侧栏标签可点）。
       *
       * ⚠️ **复用 `picks.tag`**，不另存一份"当前标签筛选"——
       *    否则下拉里一份、点标签一份，两者迟早不一致（今晚栽过两次同类）。
       * ⚠️ 点同一个标签两次 = 取消（复用 rpTogglePick 的语义，与下拉一致）。
       * ⚠️ 点完**不切换什么视图**（右栏本来就是列表），但要滚回顶部 ——
       *    否则停在原位置会以为"没反应"。
       */
      function pickTag(name) {
        var t = String(name || "");
        if (!t) return;
        setPicks(function (prev) { return rpTogglePick(prev, "tag", t); });
        try {
          var listEl = document.querySelector("." + NS + "__rplist");
          if (listEl) listEl.scrollTop = 0;
        } catch { /* 忽略 */ }
      }

      // 哪个下拉展开着（同时只允许一个 —— 两个叠着会互相遮）
      var openPair = React.useState("");
      var openWhich = openPair[0];
      var setOpenWhich = openPair[1];
      var filter = filterPair[0];
      var setFilter = filterPair[1];
      // 排序（档 B）："updated_desc" | "name_asc"
      var sortPair = React.useState("updated_desc");
      var sort = sortPair[0];
      var setSort = sortPair[1];
      // 搜索：`typed` 是输入框里的字（立即回显），`applied` 是**真的发出去**的
      // ⚠️ 拆成两个 state 是因为要防抖：直接拿 `typed` 进依赖数组会**每敲一个字就发一次请求**。
      var typedPair = React.useState("");
      var typed = typedPair[0];
      var setTyped = typedPair[1];
      var appliedPair = React.useState("");
      var applied = appliedPair[0];
      var setApplied = appliedPair[1];
      var snapPair = React.useState({ status: "loading", items: [], error: "" });
      var snap = snapPair[0];
      var setSnap = snapPair[1];
      // 主从：`openId` 非空 ⇒ 整块换成预览（单栏，不是浮层）
      var openPair = React.useState("");
      var openId = openPair[0];
      var setOpenId = openPair[1];
      // 批量选择（依琪要的：可以批量选择）。用**对象**而不是 Set：
      // ⚠️ React 比较的是引用，Set 改了原地 mutate 不会触发重渲染；对象换新引用才行。
      // ── 弹层的两条基本规矩：点外关闭 / Esc 关闭 ──────────────────────
      // ⚠️ 必须自己补：我用的不是原生 <details>（受控 open），
      //    浏览器的"点外自动收"不生效。
      React.useEffect(function () {
        if (!openWhich) return undefined;
        function onDocDown(event) {
          var node = event && event.target;
          // ⚠️ 点在**弹层或 summary 内部**不算"外面" —— 否则勾一个选项就把它关了
          while (node && node !== document) {
            var cn = node.className;
            if (typeof cn === "string" && cn.indexOf(NS + "__rpmulti") >= 0) return;
            node = node.parentNode;
          }
          setOpenWhich("");
        }
        function onKey(event) {
          if (event && event.key === "Escape") setOpenWhich("");
        }
        document.addEventListener("pointerdown", onDocDown, true);
        document.addEventListener("keydown", onKey);
        return function () {
          document.removeEventListener("pointerdown", onDocDown, true);
          document.removeEventListener("keydown", onKey);
        };
      }, [openWhich]);

      // 多选状态持久化（每次变化写回；失败不影响界面）
      React.useEffect(function () {
        try { localStorage.setItem(RP_PICKS_KEY, JSON.stringify(picks)); } catch { /* 忽略 */ }
      }, [picks]);

      // 列宽变化的"重画"钩子（见 rpWidthsStore 那段注释：不走 props）
      var tickPair = React.useState(0);
      var setTick = tickPair[1];
      React.useEffect(function () {
        rpWidthsNotify = function () { setTick(function (n) { return n + 1; }); };
        return function () { rpWidthsNotify = null; };
      }, []);

      var selectedPair = React.useState({});
      var selected = selectedPair[0];
      var setSelected = selectedPair[1];
      var selectedIds = Object.keys(selected).filter(function (k) { return selected[k]; });
      // AI 整理面板（`null` = 没打开；`{status}` = 打开中）
      var cleanPair = React.useState(null);
      var clean = cleanPair[0];
      var setClean = cleanPair[1];
      // 受管标签表（给预览里的标签芯片用）。`null` = **还没拉到**（与「拉到了但是空表」不同）。
      var managedPair = React.useState(null);
      var managed = managedPair[0];
      var setManaged = managedPair[1];

      // 防抖：`typed` 变了之后 300ms 才写进 `applied`（真正触发请求的那个）。
      // ⚠️ 用 `setTimeout` + cleanup 清掉，别让它堆积 —— 否则快速输入会打出一串请求。
      React.useEffect(function () {
        var timer = setTimeout(function () { setApplied(typed); }, 300);
        return function () { clearTimeout(timer); };
      }, [typed]);

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
      // ⚠️ 用既有的 `listQuery`（别自己拼参数 —— 宿主侧的参数名只有一处定义）。
      //    类型筛选的 `query` 合并进来；搜索走 `q`。
      var f = RP_FILTERS.filter(function (x) { return x.id === filter; })[0] || RP_FILTERS[0];
      // ⚠️ `type` 排序宿主侧**不认**（`SORT_ORDERS` 只有 created/updated/size/name）
      //    ⇒ 请求仍用 `updated_desc` 拉，**类型分组在本地做**（见下面的 wsItems）。
      var hostSort = sort === "type" ? "updated_desc" : sort;
      var filters = { sort: hostSort, q: applied };
      for (var k in f.query) {
        if (Object.prototype.hasOwnProperty.call(f.query, k)) filters[k] = f.query[k];
      }
      // ⭐ **一次拉全** —— 三档范围都在本地筛（与生图插件一致）。
      //    ⚠️ 若把范围下推给宿主，切下拉就要重新拉一次，会有明显的空窗。
      apiGet("/" + listQuery(filters))
        .then(function (items) {
          if (!alive) return;
          setSnap({ status: "ready", items: Array.isArray(items) ? items : [], error: "" });
          })
          .catch(function (error) {
            if (!alive) return;
            setSnap({ status: "error", items: [], error: (error && error.message) ? error.message : String(error) });
          });
        return function () { alive = false; };
      }, [filter, sort, applied]);

      // ── 范围筛选 + 类型排序（**都在本地**）────────────────────────────────
      // ⚠️ 一次拉全、本地筛 —— 切下拉是**瞬间**的，不发请求（与生图插件一致）。
      var wsCtx = { cwd: cwd, sessionId: sessionId };
      var wsItems = React.useMemo(function () {
        if (snap.status !== "ready") return [];
        var list = snap.items;
        // ① 范围（三档）
        if (scope === "session") {
          // ⚠️ 会话范围**只看 sessionId** —— 拿不到就放行（不许误杀，见 rpInWorkspace 的注释）
          list = sessionId ? list.filter(function (rec) {
            return !rec.session_id || String(rec.session_id) === String(sessionId);
          }) : list;
        } else if (scope === "workspace") {
          list = list.filter(function (rec) { return rpInWorkspace(rec, wsCtx); });
        }
        // ② 类型排序（宿主不认 `type`，在这里分组：先按 artifact_type，组内按 updated 倒序）
        // ①.5 多选筛选（**本地**：宿主 API 全是单值，多值只能前端做）
        // ⚠️ 语义见 rpMatchPicks：维度内 OR、维度间 AND、空 = 不筛。
        list = list.filter(function (rec) { return rpMatchPicks(rec, picks); });
        if (sort === "type") {
          list = list.slice().sort(function (a, b) {
            var ta = String(a.artifact_type || "zzz");
            var tb = String(b.artifact_type || "zzz");
            if (ta !== tb) return ta < tb ? -1 : 1;
            return (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0);
          });
        }
        return list;
      }, [snap, scope, sort, cwd, sessionId, picks]);

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

      // ── 头部（一个模块层纯函数 rpHead：搜索 + 三个下拉 + 计数 + 精炼/整理/管理页）──
      // 四个维度的可选项（⚠️ 基于**全量** snap.items，不是筛后的 wsItems ——
      // 否则选了之后别的值的计数会跳，看起来像数据在变）
      var kindOptions = React.useMemo(function () {
        return rpPickOptions(snap.status === "ready" ? snap.items : [], "kind");
      }, [snap]);
      var typeOptions = React.useMemo(function () {
        return rpPickOptions(snap.status === "ready" ? snap.items : [], "artifact_type");
      }, [snap]);
      var projectOptions = React.useMemo(function () {
        return rpPickOptions(snap.status === "ready" ? snap.items : [], "project");
      }, [snap]);
      var tagOptions = React.useMemo(function () {
        return rpPickOptions(snap.status === "ready" ? snap.items : [], "tag");
      }, [snap]);

      var totalCount = snap.status === "ready" ? snap.items.length : 0;
      var shownCount = snap.status === "ready" ? wsItems.length : 0;
      // ⚠️ 未精炼数按**当前列表**算（不是全库）—— 用户看到的"精炼 N"要和他眼前的列表对得上。
      //    若按全库算，他会以为点了会处理 24 条，实际只有眼前 3 条未精炼。
      var unrefinedCount = snap.status === "ready"
        ? wsItems.filter(function (r) { return r.needsRefine; }).length : 0;
      var head = rpHead(h, {
        typed: typed, setTyped: setTyped, setApplied: setApplied,
        scope: scope, setScope: setScope,
        filter: filter, setFilter: setFilter,
        sort: sort, setSort: setSort,
        ready: snap.status === "ready", shown: shownCount, total: totalCount,
        unrefined: unrefinedCount,
        // 多选（2026-10-19 第 2 步）
        picks: picks,
        openWhich: openWhich,
        onOpen: setOpenWhich,
        onPick: function (key, value) {
          setPicks(function (prev) { return rpTogglePick(prev, key, value); });
        },
        onClearPick: function (key) {
          setPicks(function (prev) {
            var next = {};
            for (var k in prev) { if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k]; }
            next[key] = [];
            return next;
          });
        },
        // 选项**基于全量**（不受当前筛选影响 —— 否则选了之后别的计数会跳）
        kindOptions: kindOptions,
        typeOptions: typeOptions,
        projectOptions: projectOptions,
        tagOptions: tagOptions,
        onRefineAll: function () {
          // ⚠️ 右键只负责**打标记 + 引导**，不在这里直接跑 AI：
          //    `refine-session` 会开一个真会话（耗时、要模型），在 620px 的栏里
          //    既看不到进度也接不住失败。
          //    ⇒ 标上 `refine-request`（宿主侧 `requestRefine`，**只打标记不跑**），
          //      然后把人送到管理页（那里有「🚀 立即精炼」会真的跑）。
          var ids = wsItems.filter(function (r) { return r.needsRefine; })
            .map(function (r) { return String(r.id); });
          if (!ids.length) { notify("没有未精炼的条目"); return; }
          apiPost("/refine-request", { ids: ids })
            .then(function () {
              notify("已标记 " + String(ids.length) + " 条待精炼 —— 去管理页点「立即精炼」");
              openPage();
            })
            .catch(function (error) {
              notify("标记失败：" + (error && error.message ? error.message : String(error)));
            });
        },
        onCleanup: function () { loadCleanup(setClean); },
      });

      // ── AI 整理面板（整块替换列表，`← 返回` 回去）──────────────────────────
      if (clean) {
        if (clean.status === "loading") {
          return h("div", { className: NS + "__rp" }, head,
            h("div", { className: NS + "__rpstate" }, "扫描中…"));
        }
        if (clean.status === "error") {
          return h("div", { className: NS + "__rp" }, head,
            h("div", { className: NS + "__rpstate" }, "扫描失败：" + clean.error,
              h("div", { style: { paddingTop: "10px" } },
                h("button", {
                  type: "button", className: NS + "__rpact",
                  onClick: function () { setClean(null); },
                }, "← 返回列表"))));
        }
        return h("div", { className: NS + "__rp" },
          h("div", { className: NS + "__rphead" },
            h("div", { className: NS + "__rpbar" },
              h("button", {
                type: "button", className: NS + "__rpback",
                onClick: function () { setClean(null); },
              }, "← 返回列表"),
              h("span", { className: NS + "__rpn" },
                String(clean.items.length) + " 组可合并项目名"))),
          rpCleanupPanel(h, {
            items: clean.items, canUndo: clean.canUndo,
            onMerge: function (g) { doProjectMerge(g, setClean); },
            onUndo: function () { revertProjectMerge(setClean); },
          }));
      }

      if (snap.status === "loading") {
        return h("div", { className: NS + "__rp" }, head,
          h("div", { className: NS + "__rpstate" }, "读取中…"));
      }
      if (snap.status === "error") {
        return h("div", { className: NS + "__rp" }, head,
          h("div", { className: NS + "__rpstate" }, "读取失败：" + snap.error));
      }

      // ⚠️ 列表用 `wsItems`（已按范围 + 类型排序处理过），不是 `snap.items`。
      //    预览查找也走它 —— 否则切范围后，打开的那条可能已不在列表里。
      var items = wsItems;

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
            onPickTag: pickTag,
            onBack: function () { setOpenId(""); },
          });
        }
        // ⚠️ 切粒度后原来打开的那条可能不在新列表里 ⇒ **自动退回列表**（不留空白页）。
        //    但**不能在渲染期间改状态**（React 会警告，且行为不可预期）——
        //    交给上面那个 effect，等这次渲染提交后再清。
      }

      // ⚠️ **空态要分五种**（不许拍平成一句：每种的下一步动作不同）
      var isFiltering = !!(applied || filter);
      var scopeLabel = (RP_SCOPES.filter(function (x) { return x.id === scope; })[0] || RP_SCOPES[1]).label;
      var droppedByScope = scope !== "all" && !isFiltering
        && snap.items.length > 0 && items.length === 0;
      var emptyText = rpEmptyText({
        isFiltering: isFiltering,
        droppedByScope: droppedByScope,
        cwd: cwd, scope: scope, scopeLabel: scopeLabel,
        total: snap.items.length,
      });

      // ⚠️ 截断必须**明说**（原来 `slice(0,200)` 静默截断，415 条时只显示 200 却不说为什么）
      var shown = items.slice(0, RP_ROW_LIMIT);
      var note = items.length > shown.length
        ? h("div", { className: NS + "__rpnote" },
          "只显示前 " + String(RP_ROW_LIMIT) + " 条（共 " + String(items.length) + " 条）—— 用上面的搜索缩小范围。")
        : null;

      return h("div", { className: NS + "__rp" }, head,
        // 批量操作栏（勾了才出现）—— 依琪要的"可以批量选择"
        rpBatchBar(h, {
          count: selectedIds.length,
          onCopy: function () {
            copyMentions(items.filter(function (r) { return selected[r.id]; }));
          },
          onRefine: function () {
            // ⚠️ **先预览再确认**：24 条一次改动不可逆，不给"一键就改"。
            //    这里先只把选中的 id 交给宿主预览（`refine-session` 的 dry-run 语义），
            //    真正的执行要用户在**管理页**确认 —— 右栏只负责"把要改的挑出来"。
            openPage();
            notify("已选出 " + String(selectedIds.length) + " 条 —— 在管理页里确认后再精炼");
          },
          onTrash: function () {
            // ⚠️ 回收是**可恢复**的（进回收站），但仍要一次确认 —— 批量误点代价大。
            var n = selectedIds.length;
            if (typeof window !== "undefined" && typeof window.confirm === "function"
              && !window.confirm("把选中的 " + String(n) + " 条放进回收站？（可恢复）")) return;
            var seq = Promise.resolve();
            selectedIds.forEach(function (id) {
              seq = seq.then(function () { return apiPost("/" + encodeURIComponent(id) + "/trash", {}); });
            });
            seq.then(function () {
              notify("已回收 " + String(n) + " 条");
              setSelected({});
            }).catch(function (error) {
              notify("回收失败：" + (error && error.message ? error.message : String(error)));
            });
          },
          onClear: function () { setSelected({}); },
        }),
        items.length === 0
          ? h("div", { className: NS + "__rpstate" }, emptyText,
            // ⚠️ 空态必须给**下一步动作**的按钮，不能只说明文字
            droppedByScope
              ? h("div", { style: { paddingTop: "10px" } },
                h("button", {
                  type: "button", className: NS + "__rpact",
                  onClick: function () { setScope("all"); },
                }, "看全部 " + String(snap.items.length) + " 条"))
              : null,
            isFiltering
              ? h("div", { style: { paddingTop: "10px" } },
                h("button", {
                  type: "button", className: NS + "__rpact",
                  onClick: function () { setTyped(""); setApplied(""); setFilter(""); },
                }, "清空搜索与筛选"))
              : null)
          : h("div", { className: NS + "__rplist" },
            // ⭐ 表头（2026-10-19 第 2 步 · 依琪「顶上分类连同分割线」）
            //    ⚠️ 在 `__rplist` **里面**：它要跟着列表一起滚（`position:sticky` 会粘住），
            //       放外面的话横向滚动时表头不动、列标就错位了。
            rpHeader(h, { sort: sort, onSort: setSort }),
            shown.map(function (rec) {
              // 单栏主从：点一行 ⇒ 整块换成预览（不是弹浮层 —— 620px 里浮层会盖住上下文）
              return h("button", {
                // ⚠️ 行从 `<button>` 改成 `<div role="button" tabIndex=0>` ——
                //    因为里面要放**勾选框**，而 `<button>` 里嵌 `<input>` 是非法嵌套
                //    （浏览器会把它拆开，键盘焦点行为也会乱）。
                //    ⇒ 自己补 role / tabIndex / Enter+Space 键盘支持（ui-spec §七）。
                type: "div",
                className: NS + "__rprow" + (selected[rec.id] ? " " + NS + "__rprow--sel" : ""),
                // ⚠️ 行与表头**共用同一份模板**（`rpColumnTemplate()`）——
                //    各自算宽度必然差几像素，表头就永远对不齐。
                style: { gridTemplateColumns: rpColumnTemplate(rpGetWidths()) },
                key: rec.id,
                role: "button",
                tabIndex: 0,
                "aria-pressed": selected[rec.id] ? "true" : "false",
                title: rec.path,
                onClick: function () { setOpenId(rec.id); },
                onKeyDown: function (event) {
                  if (!event) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setOpenId(rec.id);
                  }
                },
              },
                // 勾选框（批量选择用）。⚠️ `stopPropagation` 否则点框会同时打开预览
                h("input", {
                  type: "checkbox",
                  className: NS + "__rpck",
                  "aria-label": "选择 " + String(rec.title || rec.filename || ""),
                  checked: !!selected[rec.id],
                  onClick: function (event) { if (event && event.stopPropagation) event.stopPropagation(); },
                  onChange: function (event) {
                    var on = !!(event && event.target && event.target.checked);
                    setSelected(function (prev) {
                      var next = {};
                      for (var key in prev) {
                        if (Object.prototype.hasOwnProperty.call(prev, key) && key !== rec.id) next[key] = true;
                      }
                      if (on) next[rec.id] = true;
                      return next;
                    });
                  },
                }),
                // ② 名字格（图标 + 未精炼点 + 标题，**包成一格**）
                //    ⚠️ 必须包：grid 的每一格是**一个直接子项**。不包的话图标、点、标题
                //       会各占一列，5 列的模板会被撑成 7、8 列 ⇒ 与表头完全错位。
                h("span", { className: NS + "__rpname" },
                  h("span", {
                    className: NS + "__rpico", "aria-hidden": "true",
                    dangerouslySetInnerHTML: { __html: iconOf(rec.path, rec.is_dir).svg },
                  }),
                  rec.needsRefine
                    ? h("span", {
                      className: NS + "__rpdot",
                      title: "AI 还没精炼过（缺摘要 / 标签 / 项目之一）",
                      "aria-label": "未精炼",
                    }, "●")
                    : null,
                  h("span", { className: NS + "__rpnme" },
                    String(rec.title || rec.filename || rec.path || ""))),
                // ⚠️ 后缀徽章（依琪 2026-10-18：「文件要显示文件类型，后缀名」）。
                //    ⭐ 为什么必须有：行上显示的是 **`title`（人类可读标题）**，
                //      而 title **未必带后缀**（「战斧白模 v2（厚度 + 棱角 + 刃口倒角）」← 这是 .blend）。
                //      光看标题根本不知道那是什么文件、能不能直接打开。
                //    ⚠️ 取值优先级：`extension`（宿主算好的）→ 从 filename 里抠。
                //      **不用** `artifact_type`（那是**分类**：一个 `.md` 可能是 document 也可能是 code，
                //      实测库里 README.md 被归成 `doc`、别的 .md 归成 `document` —— 分类表本身就不齐）。
                // ③ 标签格（2026-10-19 · 依琪「标签要快速显示」）
                //    ⚠️ 列顺序必须与表头一致：**文件名 / 标签 / 类型 / 大小**。
                //       我上一轮按"出现顺序"替换，把类型格放到了标签前 ⇒ 行与表头错位。
                //    ⚠️ **必须再包一层 div**：`rpTagCell` 返回的是两个兄弟（chips + "+N"），
                //       直接放进行里会占**两格**，把后面全部挤歪。
                h("span", { className: NS + "__rptagcell" },
                  rpTagCell(h, rec, rpManagedTags(managed), pickTag)),
                // ④ 类型格。⚠️ 目录显示 `—` 而**不是 null**：
                //    返回 null 会让后面的列**左移一格**，整行就与表头错位了。
                h("span", { className: NS + "__rpext" },
                  rec.is_dir ? "—" : rpExtOf(rec)),
                // ⑤ 大小格（大小 + @ 按钮收在一格）
                //    ⚠️ @ 收进来是为了**不占额外列**；它仍是独立可点按钮
                //       （`stopPropagation` 保证不会顺带打开预览）。
                h("span", { className: NS + "__rpszcell" },
                  h("span", { className: NS + "__rpsz" }, fmtSize(rec.size_bytes)),
                  h("button", {
                    type: "button",
                    className: NS + "__rpat",
                    title: "复制 @ 引用，可以直接贴进对话",
                    "aria-label": "复制 @ 引用",
                    onClick: function (event) {
                      if (event && event.stopPropagation) event.stopPropagation();
                      copyMention(rec);
                    },
                  }, "@")));
            })),
        note);
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
                    return rtSlots.register({ name: "sidebar.right.pane.tab", key: RIGHT_TAB_ID }, rpWithBoundary(RightPaneBody));
                  });
                }, "artifact-library: right tab body");
                inEffect(function () {
                  return rtSlots.inject("sidebar.right.pane.tab.title", function () {
                    return rtSlots.register({ name: "sidebar.right.pane.tab.title", key: RIGHT_TAB_ID }, rpWithBoundary(RightPaneTitle));
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
