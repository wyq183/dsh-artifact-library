# 搬运建议：把「完整管理页」的 4 个重功能搬进原生面板

> 作者：release-prep ｜ 2026-09-30 夜
> 依据：**端点级核对**（`lib/http.js` 路由 + `lib/client.js` 实际调用）+ **真机 API 实测**
> 性质：**排期建议**，不是实现。所有复杂度是**估计**，已标注依据。

---

## 零、一句话结论

**4 个功能的后端端点全部就绪、实测可用 —— 搬运成本集中在 UI。**
建议顺序：**语义搜索 → 整理建议 → 标记优先精化 → 导入文件夹 → 开精化会话**。

| 序 | 功能 | 复杂度 | 为什么排这里 |
|:-:|:---|:---:|:---|
| 1 | **语义搜索** | **低** | 面板已有搜索框与结果渲染，**只差一个模式开关**；且它是「找回」叙事的正门 |
| 2 | **整理建议** | **中低** | 主动价值最高；5 组数据 + 4 个动作，动作**全部映射到已有端点** |
| 3 | **标记优先精化** | **很低** | 精炼的**便宜一半**；面板已有批量操作条，加一项即可 |
| 4 | **导入文件夹** | **中** | ⚠️ 成本由**一个待验证点**决定（见 §5）；且它主要是**一次性**需求 |
| 5 | **开精化会话** | **高** | 精炼的**贵的一半**：模型选择 + 长任务反馈 + 多条错误路径 |

---

## 一、前提（已核对的现状）

逐条核对 `lib/client.js` 的实际调用后确认：**5 个重功能只搬了 1 个**。

| 功能 | 原生面板 | 后端端点（`lib/http.js`，按**端点字符串**定位） |
|:---|:--:|:---|
| 登记产物 | ✅ 已搬 | `POST /ext/artifacts`（`req.method === 'POST' && !id`）→ `store.register` |
| 导入文件夹 | ❌ | `id === 'import'` → `store.importFolder` ✅ |
| 立即精炼 | ❌ | `id === 'refine-session'`、`id === 'refine-request'` ✅ |
| 语义搜索 | ❌ | `id === 'search'` → `store.searchSemantic` ✅ |
| 整理建议 | ❌ | `id === 'suggest-cleanup'` → `store.suggestCleanup`、`id === 'cleanup-now'` ✅ |

> ⚠️ **本文件刻意不写行号** —— 第一次写这稿时我引了行号，**几小时后再核，`http.js:494`
> 已经从 `store.importFolder` 变成了 `store.requestRefine`**（队友在同一个文件上继续加端点），
> `client.js` 更是整体漂了 300+ 行。
> **所以判据一律用「端点字符串 / 函数名」，它们不会漂，别人也能复核。**

> **结论级判据（可复核）**：`client.js` 全文搜不到 `/import`、`/search`、`/suggest-cleanup`、
> `/cleanup-now`、`/refine-session`、`/refine-request`；唯一含 `import` 的是
> `/settings/import`（设置导入，另一回事）。

> 🔬 **但「搜端点字符串」有它自己的坑：必须先剥掉注释。**
> 我把上面这张表写进 `client.js` 的注释之后，再拿 `/suggest-cleanup` 去搜 —— **立刻命中**，
> 差一点就得出「已经搬完了」的反结论。**命中的是我自己写的注释，不是代码。**
> 正确做法：`strip` 掉 `/* */` 与 `//` 之后再搜（本文件的注释占比约 13%：272909 → 236698 字符）。
> **判据本身也会被污染 —— 校验方法要一起校验。**

---

## 二、可直接复用的积木（省成本的关键）

搬运时**先看这张表**，别重造。**位置一律给符号名，不给行号**：

| 已有 | 在 `lib/client.js` 里找什么 | 能用在哪 |
|:---|:---|:---|
| `apiGet` / `apiSend` | `function apiGet` / `function apiSend` | 全部 4 个功能 |
| **多选 + 批量操作条** | 注释 `批量操作条`、`多选`；`selbar` 样式 | 精炼（选条目）、整理建议（选重复项） |
| **批量撤销** | `batchRegister` / `undoBatch`（→ `/:id/trash`） | 整理建议的**破坏性动作**（**直接照抄这个模式**） |
| **抽屉** | 样式 `__drawer`（430px，头 `__drawerh` / 体 `__drawerb` / 脚 `__drawerf`） | 整理建议单、导入表单 |
| **浮层 + 视口夹取** | `OVERLAY_MARGIN` / `OVERLAY_GAP` / `OVERLAY_ESTIMATE` | 任何下拉/菜单 |
| **Toast（走 `shell.overlay`）** | 搜 `shell.overlay`；注释说「面板内渲染的话，用户一关面板 toast 就没了」 | 全部异步结果反馈 |
| **StateBlock** | `StateBlock`（空/错/加载骨架屏） | 语义搜索无结果、索引未就绪 |
| `__input` / `__select` / `__input--lines` | 样式名同名 | 导入表单（路径、项目名、多行） |
| **设置面板**（schema 驱动） | `GET /settings/schema` + `apiGet("/settings/schema")` | 精炼的模型下拉可照抄它的渲染方式 |
| `ViewControl` | `function ViewControl` | 视图/密度/卡片尺寸/列设置 |
| `GET /model-catalog` | 实测：`{default, routableProviders[], groups[{id,name,models[{id,name}]}]}` | 精炼的模型选择 |

**⚠️ 没有的东西（要新建）**：

- **没有通用 modal / dialog 组件**（只有抽屉和菜单）→ 需要弹窗的功能要么用抽屉，要么先造一个 Dialog
- **没有目录选择器** → 但见 §5，**很可能是免费的**

---

## 三、四个功能的搬运卡

### 3.1 语义搜索 ｜ 复杂度 **低** ｜ 建议 **第 1 个**

**目标形态**：**不要新开视图**。在已有搜索框旁边加一个**模式开关**（`关键词 | 语义`），
语义模式走 `GET /search`，结果复用现有的卡片/列表渲染（`hit.score` 显示成「相关度 N」）。

**需要的调用**（实测契约）：

```
GET /ext/artifacts/search?q=<描述>&kind=&project=&limit=12
→ { query, hits: [ { id, title, kind, project, score, needsRefine } ] }
```

**为什么便宜**：
- 搜索框、输入防抖、结果渲染、空状态**全部已有**（搜索框那个 `__input` + `StateBlock`）
- 只需加：一个开关 + 一次 `apiGet` + 在结果里显示 `score`
- **不需要新组件**

**风险 / 要注意**：
- 语义搜索对**很短的查询**可能返回 0 条 —— 空状态必须**说人话**（「没找到相关的，试试描述得具体一点」），
  不能是「无结果」
- `hits` 和关键词结果是**不同形状**（语义带 `score`、不带 `path`），渲染层要做一次适配。
  建议：语义结果**只渲染成列表**（不参与卡片/画廊），降低适配面
- `limit` 默认取 `settings.searchLimit`（20）—— 面板应读设置而不是写死 12

**估计**：改动集中在一处，**新增 ≤1 个组件**。

---

### 3.2 整理建议 ｜ 复杂度 **中低** ｜ 建议 **第 2 个**

**目标形态**：**抽屉**（复用 `__drawer`）——它是「一份可执行清单」，不是导航视图。

**需要的调用**（实测契约）：

```
GET /ext/artifacts/suggest-cleanup
→ { duplicates: [ {path, keepId, keepTitle, dupIds[], dupTitles[]} ],
     missing:    [ {id, title, path, kind} ],
     unrefinedCount: <n>,
     suggestRefine:  [ {id, title, kind} ],      // 最多 20 条
     staleProjects:  [ {project, count} ] }

POST /ext/artifacts/cleanup-now   → { deduped, refreshed, missing, backup }
```

**5 组 → 4 个动作**（动作全部已有端点，无需后端改动）：

| 组 | 动作 | 走哪个端点 |
|:---|:---|:---|
| `duplicates` | 清理重复（保留 `keepId`，其余移入回收站） | `POST /:id/trash` × N —— **照抄 `batchRegister` 的撤销模式** |
| `missing` | 归档记录（**文件本身不动**，页面已这么写，务必保留这句） | `PATCH /:id {status:'archived'}` |
| `unrefinedCount` / `suggestRefine` | 「去精炼」→ 切到精炼流程 | 无（跳转）或 `POST /refine-request` |
| `staleProjects` | **仅提示**（后端注释明确「不自动动」） | — |
| 整组 | 「立即整理一次」 | `POST /cleanup-now` |

**为什么是「中低」**：
- 数据一次取全，**无需分页/懒加载**
- 抽屉、Toast、StateBlock 全现成
- 唯一要小心的是**破坏性动作**：必须**确认 + 可撤销**。好消息是 `batchUndo` 模式已经存在，
  **照抄即可**（登记那批就是这么做的：先收 id 再提供「撤销：移入回收站」）

**风险**：
- `missing` 的语义容易被误读成「能找回文件」—— 页面上那句
  「整理只能刷新状态、找不回文件」**必须原样搬过来**
- 回收站动作若中途失败要**如实报失败条数**（照抄 `batchRegister` 的 `failed` 计数）

---

### 3.3 标记优先精化 ｜ 复杂度 **很低** ｜ 建议 **第 3 个（顺手做）**

**⭐ 关键建议：把「精炼」劈成两半做。**

精炼在网页上有 4 个入口，但它们的成本**差一个数量级**：

| 入口 | 端点 | 成本 |
|:---|:---|:---|
| 精化所选 / 精化项目 / 精化文件夹 | `POST /refine-request` → `{marked}` | **极低** —— 只是打个标记 + Toast |
| **开精化会话**（立即精炼） | `POST /refine-session` → `{sessionId, ok}` | **高**（见 3.5） |

**建议**：现在就把便宜的三个吃掉 —— 在**已有的批量操作条**上加一项
「⚡ 标记为优先精化」，走 `POST /refine-request {ids}`。

```
POST /ext/artifacts/refine-request   { ids:[...] } | { project } | { folder:true }
→ { marked: <n> }
```

**为什么值得单独列为一步**：它**几乎零成本**（复用现有多选 + 一条 `apiSend` + Toast），
但能立刻让「多选」这条路径多一个有用出口，而不是等精炼全做完才一起上。

---

### 3.4 导入文件夹 ｜ 复杂度 **中** ｜ 建议 **第 4 个**

**目标形态**：抽屉或 Dialog —— 目录（只读 + 「选择…」）/ 项目名 / 「开始导入」/ 结果报告。

**需要的调用**（实测契约）：

```
POST /ext/artifacts/import   { dir, project }
→ { count, project, skipped }
```

**成本几乎全部集中在「怎么选目录」** —— 而这里有个**好消息**（见 §5）。

**注意**：
- 网页上有句必须保留的说明：「扫描该文件夹下所有文件，作为『资料』导入……
  **全程本地完成，绝不上传任何内容**」—— 这是信任面，**照搬**
- 结果要如实展示 `count` / `skipped`（跳过里含**敏感文件**与重复项 —— `store.importFolder` 明确跳过凭据类），
  **不要只说「导入成功」**（我们的设置导入就是这么做的，保持一致）
- 有 `maxFiles = 10000` / `maxSizeBytes` 上限，**大目录要有进度或至少「处理中」态**（现在是同步等待）
- 它主要是**一次性**需求（初始导入一批资料），所以**不该排在需要它的地方前面**

---

### 3.5 开精化会话（立即精炼）｜ 复杂度 **高** ｜ 建议 **最后**

**目标形态**：Dialog：模型下拉（按 provider 分组）+ 范围（所选/项目/文件夹/全部）+ 「开始精炼」
→ 派发后 Toast 报 `sessionId` 前缀与待精化条数。

**需要的调用**：

```
GET  /ext/artifacts/model-catalog
→ { default:{provider,model,reasoningEffort}, routableProviders[], groups:[{id,name,models:[{id,name}]}] }

POST /ext/artifacts/refine-session  { ids[] | project | folder | all, provider, model }
→ 成功：{ sessionId, ok: true, pendingCount }
→ 失败：{ sessionId: undefined, ok: false, error }   → HTTP 500
```

> ⚠️ **实测提醒（容易踩）**：在 `lib/refine-session.js` 的 `runRefineSession()` 里，
> **`pendingCount` 只在最后那一个成功 `return` 上**；5 条失败 `return` 都没有它
> （`workspace.create 未返回 workspaceId` / `workspace 准备失败` / `会话准备失败` /
> `模型选择失败` / `prompt 被拒`）。
> 而且**它的 JSDoc 只写了 `{sessionId, ok, error?}`，漏了 `pendingCount`**
> —— **别只读 JSDoc 就下结论**（这正是本晚反复出现的那类坑）。
> 网页版那个 Toast（`ui/index.html` 里的 `startRefineSession`）直接用了 `r.pendingCount`，
> **失败路径下会显示 `undefined`** —— 搬到面板时**记得先判 `ok`**。

**为什么贵**（逐条都有代码依据，`lib/refine-session.js`）：
- **模型选择**：要渲染分组下拉 + 默认值 + 「上次选用」预选（`refineModelLast`），
  且必须明确「**只作用于本次精炼会话，不改部署默认模型**」（页面原话，是重要承诺）
- **异步长任务**：后端要 `workspace.create` → `session.create` → `rename` → `selectModel` → `prompt`，
  任何一步都可能失败，且失败信息是**具体的**（`workspace.create 未返回 workspaceId`、
  `模型选择失败…`）—— **不能吞成「精炼失败」**
- **会话是复用的**（`meta.refineSessionId`），状态在宿主侧，面板只能报「已派发」，
  **无法显示精炼进度**（进度发生在那个会话里）—— 这个诚实边界要写进 UI
- 有 `refineBatchSize`（默认 20）分批概念，面板要不要暴露这个设置需要产品决策

**结论**：这一项**值得做，但要单独排期**，并且**先把 3.3 那半做了**，让用户至少能用上便宜的路径。

---

## 四、建议顺序与理由（汇总）

```
1. 语义搜索        低   ← 复用最多、风险最低、直击「找回」
2. 整理建议        中低 ← 主动价值最高；动作全走已有端点；撤销模式可照抄
3. 标记优先精化    很低 ← 精炼的便宜一半；顺手就能上
4. 导入文件夹      中   ← ⚠️ 先验证 §5；且是一次性需求
5. 开精化会话      高   ← 模型选择 + 长任务 + 多条错误路径，单独排期
```

**与 lead 倾向的差异（一处）**：lead 倾向「语义搜索 + 整理建议」先行 —— **我同意**。
我只补了两点：
- **把「精炼」劈成两半**，便宜的「标记优先精化」提前到第 3（不必等第 5 个做完）
- **导入文件夹不是排在第几的问题，而是「先验证一个点」的问题** —— 若 §5 验证不通过，
  它可能从「中」跳到「高」（要自己写目录浏览器）

---

## 五、⭐ 唯一需要先验证的点（决定 3.4 的成本）

**问题**：面板能不能**免费**拿到系统目录选择器？

**查到的答案（从宿主源码追出来的，不是猜）**：

客户端根服务 **`uiWorkspace`** 上有一个现成方法：

```js
// @deepseek-ai/dsh-client-ui-workspace/lib/client.js
super(ctx, "uiWorkspace")                       // 服务名 = uiWorkspace
async pickDirectory() {
  const result = await this.directoryPicker.pick()
  if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
  return result.value                            // ← 目录绝对路径
}
async listDirectory(path, signal) { ... }        // ← 还有：列目录
async createDirectory(path, name) { ... }        // ← 还有：新建目录
```

- `directoryPicker` 来自 **`ctx.remote.directoryPicker`**（宿主侧 Remote 命名空间），
  由 `dsh-client-ui-workspace` 注入 —— 也就是说**它是宿主提供的，不需要我们自己装 picker 包**
- 如果成立，导入文件夹的「选目录」就是 **一行**：
  ```js
  const dir = await ctx.get('uiWorkspace').pickDirectory()
  ```
  **成本从「高」掉到「中」**，且不需要改 `package.json` 的 `dsh.client.inject`

**⚠️ 两个必须实测、我不确定的点**（不能只信源码 —— 本晚已经踩过一次「源码里在 ≠ 运行时可达」）：

1. **运行时可达性**：`ctx.get('uiWorkspace')` 能不能真的拿到服务？
   它依赖 `remote.directoryPicker` 这个 Remote 命名空间被装上 ——
   **桌面端与网页端（局域网）可能不一样**。
2. **取消语义**：`pickDirectory()` 的注释只说了「失败就抛」。用户**点取消**时是返回 `null`
   还是也抛错，**我没有验证过** —— 而 native flow（走 `desktop.pick()`）在取消时是显式
   走 `onCancel` 的，两条路径不一定一致。**探针跑通后顺手点一次「取消」测一下。**

另外 `listDirectory` 的存在意味着**兜底方案也不贵**：验证不通过就自建一个应用内目录浏览器
（host 里还有 `dsh-client-ui-directory-picker-browse` 这个「应用内浏览」变体可以参考）。

### 验证方法（给 ui-core，约 5 行）

在 `apply(ctx)` 里加一段**一次性探针**（可直接并入已有的 `alfdebug` 诊断条，
它的门控机制已经有了，见 `client.js` 的 `bootProbe`）：

```js
try {
  var ws = ctx.get('uiWorkspace');
  console.info('[alf-probe] uiWorkspace=' + typeof ws
    + ' pickDirectory=' + (ws && typeof ws.pickDirectory));
} catch (error) { console.warn('[alf-probe] 取 uiWorkspace 失败', error); }
```

- 打出 `pickDirectory=function` → §3.4 按「中」排期
- 打出 `undefined` 或整段抛错 → §3.4 升为「高」，走 `listDirectory` 自建浏览器

---

## 六、明确「不做」的事

- **不删 `ui/index.html`**，不删 `sidebar.footer.action` 入口 —— 4 个功能搬完之前，它们是唯一入口
- **不改任何后端端点** —— 这一轮**只需要写 UI**（这是本建议最大的省力点）
- **不擅自改 `lib/**`** —— 本文件只是建议；实现由 ui-core（`client.js`）排期
- **不把「标记优先精化」当成「立即精炼」** —— 两者用户预期不同，文案上必须分开
  （前者是「下次会话优先处理」，后者是「现在就派一个会话去干」）
