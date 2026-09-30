# 产物库 UI 优化设计方案 v1

> 目标：**对标 DSH 官方插件库的收录与观感标准**
> 依据：3 份调研（官方 token 实测 / 官方原生文件树源码 / 文件管理器最佳实践）+ 本机 `app.asar` 实测
> 日期：2026-09-30

---

## 零、一句话诊断

**当前 UI 的问题不是配色，是「密度与 token 都对不上官方」。**

| 项 | 官方/生态标准 | 我们现状 | 差距 |
|:---|:---|:---|:---|
| 列表行高 | **28~32px** | **~110px** | **3.4~4 倍** |
| 缩进 | 每级 **18px** | 视觉很大 | — |
| 路径显示 | **只在表头显示一次** | 每行重复完整路径 | 视觉噪音 |
| 设计 token | **423 个可用** | 用了 26 个 + 自造 `--alf-*` | 主题不一致 |
| 圆角 | `xs4/sm8/md12/lg16/xl20/panel28` | 自造 `10px` | 不统一 |
| 图标 | 按类型映射 + **官方色表** | 单一图标 | 信息缺失 |
| 排序 | 目录优先 + `Intl.Collator({numeric:true})` | 无 | 功能缺失 |
| 虚拟滚动 | 必需（几千文件） | 无 | 性能隐患 |

---

## 一、硬规矩（不可协商）

1. **禁止第二套配色**。只用**宿主 `:root` 实际导出的 token**，**禁止任何 hex**。
   宿主 `:root` 导出的不只是 `--dsw-*`，还有 **5 个 `--ds-*`**（经全量 dump 证实）：
   `--ds-font-family-code`（等宽栈）、`--ds-ease-in-out`、`--ds-transition-duration`、`--ds-transition-duration-fast`、`--ds-transition-duration-slow`。
   ⚠️ 反例：`--dsw-font-mono` 名字看着像官方的，但**全量官方包里 0 个定义点** —— 是幽灵 token。
   生态里被认可的插件（better-sidebar / smooth-stream / genui）全部只消费宿主 token。
2. **必须适配深色模式**。宿主在 `<body>` 挂 `data-ds-dark-theme` 并重绑 alias 值 ——
   **零感知即自动跟随**；自己写 hex 就永远不跟随。
3. **必须适配内容缩放**。宿主有 `--dsh-content-font-delta` / `--dsh-content-font-size`
   —— 用户能在设置里调界面字号，硬编码字号的插件会错位。
4. **禁止 emoji 当图标**（官方明确）。
5. **客户端 bundle 里绝不能出现 `import ... from "react"` 字面量**
   （会打进第二份 React，每个 hook 都 `Invalid hook call`）——必须走 module-loader 借宿主的 React。

---

## 二、设计 token 基线（本机实测，给实现者抄）

### 2.1 圆角（`--dsw-radius-*`）
```
xs 4px   sm 8px   md 12px   lg 16px   xl 20px   panel 28px
```
用法：行/小控件 `sm(8)`；卡片/菜单/下拉 `md(12)`；大卡/图标块 `lg(16)`；插件卡片外层 `xl(20)`。

### 2.2 字体（`--dsw-font-*`，格式 = 字号/行高 字重）
| token | 值 | 用途 |
|:---|:---|:---|
| `--dsw-font-xxxs-11` | 11px/14px 400 | 最弱说明 |
| `--dsw-font-xxs-12` | 12px/18px 400 | 次级信息（路径、时间）|
| `--dsw-font-xs-13` | **13px/20px 400** | **列表正文主力** |
| `--dsw-font-s-14` | 14px/22px 400 | 稍大正文 |
| `--dsw-font-l-20` | 20px/28px 500 | 页面标题 |
| `--ds-font-family-code` | — | 代码/路径等宽。**定义在 ui-theme 的 `:root{}`**（完整等宽栈）。⚠️ `--dsw-font-mono` **是幽灵 token**：全量官方包里 0 个定义点，只有 4 个包当消费方用（其中 `ui-jobs` 还没带 fallback，官方自己也解析不出）—— 不要用 |

字体栈：`--dsw-font-family`（含 PingFang SC / Microsoft YaHei）。

### 2.3 语义颜色
```
背景  --dsw-alias-bg-base / bg-layer-1|2|3 / bg-overlay / specific-sidebar-fill / specific-menu
文字  --dsw-alias-label-primary（主）/ label-secondary / label-tertiary（弱）/ label-caption（最弱）
描边  --dsw-alias-border-l1（最淡）| l2（菜单/抬升面）| l3 | l4；头发丝线用 0.5px
交互  --dsw-alias-interactive-bg-hover（★ hover 唯一正解）/ -active / -hover-danger
状态  --dsw-alias-state-success | state-warn | state-error | state-business-primary
阴影  --dsw-elevation-soft | prominent | panel（用时把描边覆写为 --dsw-elevation-stroke-color）
滚动条 抬升面内覆写 --dsh-scrollbar-thumb
```

### 2.4 文件类型图标色表（官方 `FileTypeIcon.module.css`）
| 类型 | token |
|:---|:---|
| code / markdown / html | `--dsw-static-deepseek-500` |
| excel | `--dsw-static-green-500` |
| word | `--dsw-static-deepseek-450` |
| ppt | `--dsw-static-amber-500` |
| pdf | `--dsw-static-red-600` |
| image / video | `rgb(139,118,246)`（官方注明 violet 无 token）|
| folder | `--dsw-static-amber-400` |
| other | `--dsw-static-neutral-bluish-300` |

---

## 三、目录视图（DirBrowser）重构 —— 本方案核心

### 3.1 行规格（照抄官方 `ui-sidebar-files`）
```css
/* 内容区 */
padding: 8px 0 8px 8px;
/* 每级缩进 */
.level .level { padding-left: 18px; }
/* 行 —— 这就是标准行 */
.row {
  padding: 5px 10px;
  gap: 6px;
  border-radius: var(--dsw-radius-md);   /* 12px */
  min-width: 0;
  width: 100%;
  height: 32px;                          /* 目标：紧凑 28 / 标准 32 / 宽松 44 */
}
.row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.name { white-space: nowrap; text-overflow: ellipsis; overflow: hidden; min-width: 0; }
/* 表头 */
.header { height: 38px; padding: 0 6px 0 16px; gap: 4px;
          border-bottom: .5px solid var(--dsw-alias-border-l3); }
/* 工具栏按钮 */
.tool { width: 28px; height: 28px; padding: 6px; border-radius: var(--dsw-radius-sm); }
.tool svg { width: 15px; height: 15px; }
/* 次要说明 */
.note { font-size: 12px; padding: 3px 10px; color: var(--dsw-alias-label-tertiary); }
```

### 3.2 列布局
```
[16px 图标] [文件名  flex:1 min-width:200px  中间省略]  [N 项 / 大小 80px 右对齐]  [时间 140px 右对齐]  [操作区 72px 占位]
```
- 默认只显示 **文件名 / 大小 / 修改时间**（与 GNOME Nautilus 默认三列一致）
- **长文件名用「中间省略」**（保扩展名可见）—— GNOME 43 明确改用中间省略，
  理由：`super-long-config-name.json` 尾部省略后丢掉的是**文件类型**这个最关键信息
- 数值列右对齐 + `font-variant-numeric: tabular-nums`

### 3.3 去冗余（关键改动）
- **行内彻底删掉路径** → 路径由**顶部面包屑**承担（`PathLabel` 形态：
  目录段 `label-tertiary`、文件名段 `label-primary`、溢出时左侧
  `mask-image: linear-gradient(to right, transparent, black 28px)` 渐隐）
- 面包屑包在 `<nav aria-label="路径">`，末项 `aria-current="page"`

### 3.4 操作按钮
- **`:hover` 或 `:focus-within` 才可见**（用 `visibility`，**保留 72px 占位**防抖动）
- 图标按钮 24×24，热区 ≥28×28，每个带 `aria-label`
- **同时提供右键菜单** + `Shift+F10` 键盘等价路径
- 这是 Win11 文件资源管理器的标准做法（官方说法："保持默认视图干净，同时让高级操作随手可得"）

### 3.5 目录项信息
- 显示 **「N 项」**（不是总大小）；**异步填充**（先 `—`，算完再填）
- 网络盘 / 超深目录自动跳过（照抄 Nautilus `show-directory-item-counts = local-only` 语义）
- **总大小默认不算**（Finder 上这是 2~8 秒的昂贵操作），提供按需触发

### 3.6 排序
- 表头三列可点，`▲/▼` 指示
- **默认：名称升序 + 目录优先**
- 自然序：`new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`
  → `file2` 排在 `file10` 前
- 键盘可达（表头按钮可 Tab 到）

### 3.7 虚拟滚动（必需项）
- 定高 `itemSize = 行高`，overscan 3~5 行
- 用 `transform: translateY` 定位（不用 `margin-top`，避免重排）
- 目录可能几千个文件，这是**必需**不是优化

---

## 四、搜索视图（FilesView）

- **保留路径**，但改**两行式**：
  第 1 行文件名（13px），第 2 行路径（11~12px，`label-tertiary`，中间省略）
  行高放宽到 44~48px（搜索结果跨目录，需要区分来源，这是可接受的）
- 搜索框下方一排 **filter chips**（全部/文档/图片/音视频/代码/压缩包）—— 照抄 Everything 范式
- 搜索输入 **debounce 200ms**
- 排序切换关键词时**重置为默认**
- 占位符给示例：`ext:md path:projects`

---

## 五、视图切换器 → 官方 `SegmentedControl`

```
轨道: padding:4px; gap:2px; radius:--dsw-radius-md(12)
滑块: radius:--dsw-radius-sm(8)
段:   height:28px; padding:0 16px; font-size:13px; line-height:20px; 字重 500
过渡: 160ms ease；prefers-reduced-motion 下关闭
```
替换现在的「一排 button.active 变蓝底」。

---

## 六、状态设计

| 状态 | 做法 |
|:---|:---|
| **空目录** | 48px 图标 + 「这个文件夹是空的」（信息型，无 CTA）|
| **搜索无结果** | 「没有匹配 "xxx" 的文件」+ 建议（检查拼写 / 试 Everything 语法 / 去掉筛选）|
| **加载** | **3~5 行骨架屏**（每行 = 行高），**不用 spinner** |
| **索引未就绪** | 整视图错误态 + 「重试」按钮 + 一句原因 |
| **单文件权限不足/已删** | 行级弱化 + hover 提示，不阻塞整列表 |

动效：hover **80~150ms** `ease-out`；大元素 ≤300ms。

---

## 七、无障碍（上架加分项）

- 目录树：`role="tree"` + W3C treeview 键盘模式
  （`↑↓` 移动、`→` 展开/进入、`←` 折叠/回父、`Home/End`、字母跳转、`*` 展开同级）
- 列表：`role="grid"`（columnheader/row/cell）+ roving tabindex
- 焦点环必须可见（`--dsw-focus-ring-color` / `--dsw-focus-ring-width`）
- hover-only 按钮在 `:focus-within` 时也必须出现

---

## 八、上架 DSH 插件库的必要项（来自目录站实测）

- [ ] 仓库**公开**，README 讲清「做什么 + 怎么装」
- [ ] 明确 **LICENSE**（MIT / Apache-2.0）
- [ ] 打 **`dsh-plugin`** topic
- [ ] **截图放 `docs/screenshots/*.png`**（目录站会**自动抓取**展示）
- [ ] `package.json` 的 `name` 三处**逐字节一致**：
      `package.json.name` / `cordis.patch.yml` 的 `insert.name` / `lib/client.js` 的 `load({id})`
- [ ] 声明 **peer 版本下限**（DSH 启动预检；caret 跨 minor 会被**整行静默禁用**）
- [ ] README 结构：一句话定位 → 截图 → 安装命令 → 版本对照表 → 功能一览 →
      已知限制 → 安全说明 → License
- [ ] 启动日志打一行可自证（如 `[artifact-library] client active`）

---

## 九、实施顺序（收益/成本排序）

| 阶段 | 内容 | 风险 |
|:---|:---|:---|
| **P0** | 目录视图行瘦身（110→32px）+ 去冗余路径 + 类型图标 + 排序 | 中（改动集中在 DirBrowser 渲染）|
| **P1** | 视图切换器换 `SegmentedControl`；圆角/字号全面 token 化；清掉自造 `--alf-*` | 低 |
| **P2** | 搜索视图两行式 + filter chips + 骨架屏 | 低 |
| **P3** | 虚拟滚动 + 无障碍（tree/grid 语义 + 键盘） | 中 |
| **P4** | 上架物料（截图、README、topic、版本声明） | 低 |

---

## 十、实测数据附录（供实现者核对）

### 官方 CSS 数值分布（`app.asar` 统计）
- height：20px×127、18px×120、28px×90、22px×89、16px×86、24px×82、36px×36
- font-size：12px×204、14px×137、13px×113、11px×70
- border-radius：999px×23、4px×17、2px×16、6px×16、10px×12、8px×11、12px×11
- padding：6px×63、4px×55、8px×55、10px×45、12px×43

### 各文件管理器行高对照
| 管理器 | 行高 | 来源 |
|:---|:---|:---|
| VS Code 资源管理器 | ≈22px（硬编码） | issue #11238 |
| Caja | ≥28px（源码常量） | fm-list-view.c |
| Spacedrive | 36px（表头 32px） | 源码常量 |
| GNOME Nautilus | ≈31px | 主题实测 |
| Fluent 2 表格 | Small 32 / Medium 44 / Large 52 | Fluent UI |
| IBM Carbon | xs24 / sm32 / md40 / lg48 / xl64 | CarbonTableSize |
| Ant Design | ~47 | 第三方实测 |
| MUI X DataGrid | 52 | 官方文档 |

---

## 十一、交互与浮层

> **依据**：官方 `.agents/skills/dsh-client-ui-ux/SKILL.md`。
> 这一节的条款**不是本项目自创** —— 第一轮调研时我只提取了布局与圆角部分，**漏了交互与浮层**；
> 现在把它落成可检查项。凡是本节条款，都可在官方那份 SKILL 里找到出处。

### 11.1 浮层三查（官方原文口径）

任何浮层（菜单 / 下拉 / 对话框 / 抽屉 / 提示气泡）必须同时满足：

1. **可关闭** —— 外部点击 或 `Escape` 至少一种能关；**键盘用户必须支持 `Escape`**
2. **视口适配** —— 翻转或滑动，并留边距；**只在真能放下的那侧翻转**（避免来回振荡）
3. **不被裁切** —— portal 到 `body`（或等价地 escape overflow 祖先），不被祖先的 `overflow: hidden` 切掉

### 11.2 对话框语义

- **必须有可访问名**：`role="dialog"` + `aria-label`（或 `aria-labelledby`）
- **必须有焦点管理**：打开时焦点移入浮层，关闭时归还到触发元素
- **`aria-modal` 不是硬性要求** —— 官方未强制。若使用，**必须与背景 `inert`（或等价手段）一起做**；
  **只加属性不加 inert 视为违反**（会误导屏幕阅读器以为背景不可达，实际仍可 Tab 进去）

### 11.3 缩略图与媒体（三查）

- **懒加载**：列表中的图片必须 `loading="lazy"`
- **URL 编码**：路径进 URL 前必须 `encodeURIComponent`
- **失败回退**：加载失败必须回退到类型图标 —— **不留空窗、不出坏链**，且同一项**不反复重试**

### 11.4 反馈面（官方原文口径）

- **瞬时操作结果用应用级 Toast**，且**必须挂在比上报界面活得久的地方**（面板卸载不能带走）
- **操作失败保留数据可见**：**绝不清空内容来显示错误**
- 与界面本身绑定的状态（查询失败 + 重试、字段校验）才用就地 notice
- 错误文案平实、短；**不得推动相邻元素**

### 11.5 加载态

- **列表用骨架屏**；其他页级加载用居中裸 spinner（**绝不放角落**）
- **一页一种加载样式** —— 不要并发区域各自闪光
- **不要空转的定时器**（无内容时不续期；每次 2.2 秒空转一次是实测过的 bug）

### 11.6 快捷键的宿主边界

- 面板内的快捷键**只在面板可见时响应**（如 `rootRef.getClientRects().length > 0`）
- **不得抢占宿主的全局快捷键**，也不得在面板未显示时吞键
- （依据：我们自己踩过的设计点；与官方「不干扰宿主 chrome」的原则一致）

---

## 十二、统一视图控制与就地设置（**已实现**）

> **状态（2026-10-01 凌晨更新）**：本节条款**已在 `lib/client.js` 落地** ✅
> —— 原文写的是「尚未发版，且 `task-6` 仍在改动」，那是**当时的实际情况**；
> 当晚该任务已完成并提交（`46773a2` / `a525231`，并把四条刻度断言进了 `test/ui-spec`）。
> ⚠️ **现在仍在等的是「真机目视验收」，不是「发版」** —— 见 `VISUAL-ACCEPTANCE.md`。
> 行号供核对；**若与代码不符，以代码为准**。

### 12.1 架构决定：**统一 `ViewControl`**（不是两套）

原先「产物视图」与「目录视图」各有一套独立工具栏，直接后果是
**「在目录里切卡片/列表」根本没有地方可放**。现改为**一个 `ViewControl` 组件**，两处共用：

| 使用处 | 位置 |
|:---|:---|
| 产物视图 | `lib/client.js:2066` |
| 目录视图 | `lib/client.js:3181` |
| 组件定义 | `lib/client.js:4879` |

**成分（按 props 按需出现，不传就不渲染）**：

1. **视图类型** —— `role="tablist"`，每项 `role="tab"` + `aria-selected`（照抄官方 SegmentedControl 形态）
2. **密集度（行高）** —— 仅当传入 `onDensity`
3. **卡片尺寸（小/中/大）** —— 仅当传入 `onCardSize`
4. **列设置** —— 仅当传入 `onColumns`

**硬规矩**：新增控件**必须真的生效**（回调真的把值写进设置并触发重渲染），
**不许只渲染不接线**。依据：`indexExtraDirs` 曾经「读它但没人能写它」，
留着这种键比没有更坏（后人会以为它能用）。

### 12.2 列设置（就地可调）

- 列**固定含「名称」**（不列进菜单），可选 `大小` / `修改时间` / `类型`
  （`COLUMN_KEYS`，`lib/client.js:4873`）
- 入口是工具栏里的「**列（N）**」按钮，`N` = 当前可见列数（含名称）
- 点开是 checkbox 浮层，**改完立即生效**，不要求进设置面板
- 无障碍：按钮带 `aria-expanded` + `aria-label`；浮层 `role="group"`
- 默认值 `{ size: true, time: true, type: false }`

### 12.3 项目是第一级**容器**（不是筛选维度）

- `currentProject === null` → 渲染**项目列表**（`lib/client.js:2273`）
- 进入某个项目后才看到该项目的内容，**必须有明确的「返回」路径**
- **保留「全部产物」平铺入口** —— 用户仍需要跨项目浏览
- ⚠️ 视图切换器里**不再有「项目」这一项**：它是**层级**，不是 tab（`lib/client.js:2051`）

### 12.4 引用交互（**三条路，别混**）

| 路径 | 行为 | 现状 |
|:---|:---|:---|
| **`@` 来源注册** | 官方 `ctx.get("inputTriggers").registerSource(...)`，走**输入框的 `@` 菜单** | ✅ 已实现（`client.js:882–1011`，root 作用域） |
| **右键「复制为 @引用」** | 把 `@path` / `@"含空格路径"` **复制进剪贴板** | ✅ 已实现（`client.js:3402–3405`） |
| **拖产物到输入框 = 插入引用** | 从面板**拖出去** | ❌ **未实现**（无 `draggable` / `onDragStart`） |

**措辞纪律**：「复制为 @引用」**只能**说成「复制引用文本」，
**不许**说成「@ 进输入框」—— 真正的插入走输入框的 `@` 菜单。
（代码注释里已经这么标了，见 `client.js:3400`。）

**mention 形状**（与官方 `formatFileMention` 一致）：

- 无空白：`@path`
- 含空白：`@"path with space"`
- 目录：**半开** `@"path/`
- **含 `"` 或控制字符 → 拒收**（官方会拒；不要拼出它认不了的东西）

**降级**：`inputTriggers` 在局域网模式下**不可用**（会打一行
`[artifact-library] inputTriggers 不可用，@ 来源未注册`）——
**不能假设它一定在**，必须有纯文本降级路径。

### 12.5 拖放的两个方向（语义必须分清）

- **拖进来**（系统文件 → 面板）= **登记进产物库**（`client.js:3642` 的 `onDrop`，配合 `pathsFromDrop` `:2722`）
- **拖出去**（面板产物 → 聊天输入框）= **插入引用** —— **未实现**

⚠️ 边界：浏览器 `drop` 只给 `File`、**拿不到真实路径**；而面板内部拖拽用的是
**我们自己的数据**（有 `path`/`id`），所以「拖出去引用」**可行**，
与「从系统拖文件进来」不是一回事。

### 12.6 hover 操作区（不许与虚拟滚动打架）

- 行尾操作按钮 **`hover` 或 `:focus-within` 才可见**（`client.js:235`、`:339`、`:2955`）
- **固定占位防抖动**：目录行 72px 占位（`client.js:233`）；浮出**不得改变行高**，
  否则虚拟滚动会算错位置
