<a id="top"></a>

# 🐋 dsh-artifact-library · DSH 产物库

![Version](https://img.shields.io/badge/version-0.8.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)
![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-4F46E5)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-0078D4)
![Stars](https://img.shields.io/github/stars/wyq183/dsh-artifact-library?style=flat&label=stars)

**DeepSeek Harness 的「作品柜 + 资料柜 + 工作台」**：自动采集 AI 产出、AI 自动分类整理、一句话语义检索、AI 替你连线，外加一个**内置 Everything 引擎的本地文件管理器**。本地优先，数据绝不出本机。

**The "deliverable vault + reference shelf + shared workspace" for DeepSeek Harness**: auto-collect AI outputs, AI-organize them, semantic search in plain language, AI-suggested linking — plus a local file manager powered by a bundled Everything engine. Local-first — your data never leaves the machine.

---

<a id="screenshots"></a>
## 📸 截图 Screenshots

> ⚠️ **截图待补（0/3）** —— 目录站会自动抓取 `docs/screenshots/*.png`。
> 真图必须在运行中的 DSH GUI 里**人工截取**（本插件是宿主 UI 插件，无法用静态页复现）。
> 截什么、怎么截、命名与尺寸规范见 **[docs/screenshots/README.md](docs/screenshots/README.md)**。

| 目录视图 | 文件搜索 | 卡片视图 |
|:---:|:---:|:---:|
| *待补* `01-directory.png` | *待补* `02-search.png` | *待补* `03-cards.png` |

---

<a id="toc"></a>
## 📑 目录 Table of contents

- [功能一览](#features)
- [安装](#install) · [DSH 版本对照](#compat)
- [特性巡礼](#tour)
  - [原生面板](#tour-panel) · [未发布（开发中）](#unreleased) · [本地文件管理器](#tour-files) · [自动采集与 AI 精化](#tour-collect)
  - [检索与连线](#tour-search) · [维护与备份](#tour-maint) · [模型工具](#tour-tools)
  - [使用与快捷键](#usage) · [数据模型](#data-model) · [配置项](#config)
- [隐私](#privacy)
- [安全边界](#security)
- [已知限制](#limits)
- [更新日志](#changelog)
- [License](#license)

---

<a id="features"></a>
## ✨ 功能一览 Features

| 能力 | 说明 |
|---|---|
| **本地文件管理器**（v0.7.0 新增） | 内置 [Everything](https://www.voidtools.com/) 引擎（MIT，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)），**毫秒级**本地文件搜索：Everything 语法（`ext:psd` · `dm:today` · `size:>10mb` · `path:项目`），命中项可一键登记为产物。索引范围**严格限定**在「DSH 工作区 + 已登记产出所在目录 + 你额外指定的目录」，**不索引全盘**，全部本地完成 |
| **自动采集** | 订阅会话事件，AI 每轮产出的文件自动进库，并记录**来源会话**（可回看诞生过程）|
| **AI 整理分类** | 自动采集后标记「待精化」，会话内模型主动补全摘要/标签/项目；或点「立即精炼」开专属精化会话批量处理 |
| **一句话语义搜索** | `artifact_find` / 管理页 🔍 语义搜索：用自然语言描述（「上次那个视频素材」）就能找回，自动拆词加权打分 |
| **AI 替你连线** | `artifact_suggest_links` / 编辑页「相关建议」：自动扫描同项目/同标签/同目录/标题相似的产出与资料，一键填入引用 |
| **整理建议单** | `artifact_suggest_cleanup` / 管理页 🧹：扫描重复记录、文件缺失、待精化、僵尸项目，出可执行建议单 |
| **资料库** | 文件夹一键批量导入（目录名当项目、本地正文索引），产出可关联引用的资料 |
| **项目总览** | `project_overview` 一句话了解某项目的产出与资料 |
| **维护** | 定时整理（去重/文件状态刷新，默认每周）、自动备份（默认保留 10 份）、导出 JSON |
| **人性化** | 撤销式操作、快捷键、批量操作、图片缩放/音视频倍速预览、缺失文件提醒 |

**平台**：**Windows 与 Linux 都完整可用**（macOS 尚未适配）。

文件索引按平台自动选后端，**上层功能与查询语法完全一致**：

| 平台 | 文件索引后端 | 「在文件管理器中定位」 |
|:---|:---|:---|
| Windows | 内置 Everything 便携版（`vendor/everything/`） | `explorer /select,` |
| Linux | **纯 Node 范围索引**（零外部依赖） | D-Bus `FileManager1.ShowItems` → 回退 `xdg-open` 所在目录 |

两者对外是**同一套接口**（`status / ensureReady / search / listDir / …`），
所以 `ext:png dm:today size:>10mb` 这类语法、面板、工具栏在两边长得一样。
Linux 上**不依赖** plocate/fd/Spotlight 之类的系统工具，也不用装任何东西。
macOS 目前会落到 Node 后端，但路径语义与「用访达打开」这两处**未经验证** —— 别当成已支持。

---

<a id="install"></a>
## 📦 安装 Install

```sh
dsh plugin add github:wyq183/dsh-artifact-library
# 数据落在 web profile 时用：
# dsh plugin --profile web add github:wyq183/dsh-artifact-library
# 或本地源码：
# dsh plugin --profile web add <本仓库路径>
# 重启 dsh web 生效
```

装完**重启 dsh web**。启动日志里应出现一行自证：

```
artifact-library: store at ~/.dsh/artifact-library/artifacts.json (N records)
```

数据存于 `~/.dsh/artifact-library/`（可用环境变量 `DSH_ARTIFACT_LIBRARY_DIR` 覆盖）。

<a id="compat"></a>
### 🧩 DSH 版本对照 Compatibility

本插件声明的 `peerDependencies` 下限为 **`>=0.2.0-rc.2`**。DSH 在启动/安装时会拿插件
`package.json` 的 `peerDependencies` 去比对运行时版本：**不满足的插件会被判为不兼容**，
需要 `dsh plugin allow-version` 显式放行才能加载。

| 插件版本 | 需要 DSH 运行时 | 状态 |
|:---|:---|:---|
| **v0.7.0** | `>= 0.2.0-rc.2` | ✅ 当前版本 |
| v0.6.0 | `>= 0.2.0-rc.2` | 原生面板第一期 |

- 对照依据：运行时 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()`，
  只检查 `peerDependencies` 里 **`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`** 这两类名字，
  用 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定。
- 写法上用**下限**（`>=`）而不是 caret：caret 在跨 minor 时会**静默**把插件挡在门外，
  而带下限的范围不会反过来排掉当前运行时。

---

<a id="tour"></a>
## 🚀 特性巡礼 Feature tour

<a id="tour-panel"></a>
### 🖥️ 原生面板（v0.6.0 起，推荐）

左侧栏 🐋「产物库」图标 → 主区整块打开产物库面板。走的是**官方公开席位**
（`sidebar.panellist` + `main`），**不依赖任何第三方侧栏插件**。

- **原生 React 渲染**，样式全部读 DSH 设计 token（`--dsw-alias-*` / `--dsw-font-*` / `--dsw-radius-*` / `--dsw-shadow-*`），**自动跟随深浅主题**
- 统计条、搜索、kind/状态/项目/排序筛选
- **卡片 · 列表 · 项目**三视图（v0.7.0 已发布形态；下一版的扩展见 [未发布](#unreleased)）
- 详情抽屉：图片 / 文本 / 音视频**内联预览**、星级打分、编辑、回收站/恢复、文件管理器定位、复制路径

<a id="unreleased"></a>
### 🧪 未发布：原生面板的下一版（开发中）

> ⚠️ 下面这些**已经写进代码**（逐条对照 `lib/client.js` 的实现路径核对过），
> 但**尚未发版**，而且此刻仍有人在改（`task-6` 进行中）。**发版前以实际界面为准。**
> 判据一律写**符号名**（函数/常量/端点）而不是行号 —— **行号会漂**，符号名别人能复核。

- **项目成为第一级容器**：打开面板先看到**一个个项目**，点进去才看到该项目里有什么；
  「全部产物」平铺入口保留（`currentProject === null` 时渲染项目列表）
- **产物视图扩到 3 种 + 文件系统 3 种**：卡片 / 列表 / **画廊**、文件 / 目录 / 改动（常量 `VIEWS`）；
  画廊是缩略图墙，虚拟滚动阈值为 60（常量 `GALLERY_VIRTUAL_THRESHOLD`）
- **列设置就地可调**：视图工具栏里的「列（N）」下拉，勾选显示哪些列，改完立即生效
  （`ViewControl` 的 ④ 段 + 常量 `COLUMN_KEYS`）
- **多选 + 批量**：`Ctrl/Cmd 点击`、`Shift 区间`、`空格切换`、`Ctrl+A`、`Esc`；批量
  **登记**（`batchRegister` + `undoBatch` 可一键撤销）/ 复制路径 / 打开 / 移入回收站
- **`@` 引用（三条路）**：
  ① 注册官方 `inputTriggers` 来源（root 作用域，`registerSource`）—— 走输入框的 `@` 菜单；
  ② 行右键「**复制为 @引用**」（`copyAtMention`）复制 `@path` / `@"含空格路径"` 文本；
  ③ **拖出去**：文件/搜索结果行、卡片、列表**都可拖拽**（`draggable` + `onDragStart`），
  `text/plain` 放的就是 mention 文本，另附一个 `application/x-dsh-artifact` 自定义 MIME。
  ⚠️ ②③ 都只是**产出引用文本**；**输入框会不会把它识别成引用 chip，尚未验证** ——
  而那恰恰是唯一能证明「真的能直接引用」的证据，我们**还没拿到**。
- **hover 操作区**：行尾按钮 hover 或 `:focus-within` 才出现，**固定 72px 占位防抖动**（样式 `__dact`）
- **空状态承载新手引导**：不做教程弹窗，引导长在空状态里，且两个按钮都是**真路径**
- **设置面板**：结构从 `GET /settings/schema` 读（**不写死**），含预设与导出/导入

**还没做的（文档里不许写成「有」）**：

- **原生面板里的导入文件夹 / 立即精炼 / 语义搜索 / 整理建议**：这 4 项**仍只在完整管理页**
  （详见 [使用](#usage) 与 [已知限制](#limits)，搬运建议见
  [docs/MIGRATION-PLAN-web-to-panel.md](docs/MIGRATION-PLAN-web-to-panel.md)）
- **「拖出去 = 引用」是否真的生效**：代码这一半做完了（见上），
  但**「粘到输入框会不会变成引用 chip」没人验证过** —— 别当成已完成

<a id="tour-files"></a>
### 🗂️ 本地文件管理器（v0.7.0）

面板顶部视图切换点「文件」→ 首次点「启动文件索引」→ 之后输入关键词即时出结果。
**索引范围会在界面上如实显示**，命中项可一键「登记」进产物库。

- **独立实例** `DSHArtifacts`：与你自己的 Everything 完全隔离，不改不卸不干扰
- **懒启动**：不搜索就不启动任何进程；关闭走官方 `-exit`
- **「目录」视图**：逐层浏览工作区与产出目录，目录在前文件在后，可「打开」/「定位」/「登记」
- **主动纳管**：订阅会话事件，会话的工作目录自动纳入索引范围，防抖攒批 30 秒
  （`config.indexScopeDebounceMs` 可调），把多次会话创建合并成一次实例重启
- 模型侧也能用 `search_files` 搜本地文件（工具描述里如实写明范围边界）

<a id="tour-collect"></a>
### 📥 自动采集与 AI 精化

- 每轮产出**自动登记**，默认每轮上限 20 条（设置面板可调）
- 新条目标记「待精化」，会话内模型会主动补全摘要 / 标签 / 项目
- 也可在管理页勾选条目 → ⚡ **立即精炼**（或 ⚡ 精化项目 / ⚡ 精化文件夹）→ 开**专属精化会话**批量处理
- 精化会话选用哪个模型只作弹窗**预选**，**绝不自动应用**

<a id="tour-search"></a>
### 🔍 检索与连线

- **语义搜索**：管理页 🔍 按钮（**原生面板里还没有**），或让任意会话的 AI 用 `artifact_find`（自然语言描述）
- **关键词检索**：`artifact_search`（**正文前 8000 字符**；更长文档的靠后内容搜不到 ——
  命中行会明确提示「正文已截断」并指明出路）
- **AI 连线**：编辑产物时点「扫描相关条目」，或让 AI 用 `artifact_suggest_links`
- **整理建议**：管理页 🧹 按钮（**原生面板里还没有**），或让 AI 用 `artifact_suggest_cleanup`

<a id="tour-maint"></a>
### 🧰 维护与备份

- **定时整理**：默认每 7 天（`cleanupIntervalDays`，可设 1–365），整理前自动备份
- **自动备份**：默认保留 10 份（`backupKeep`，可设 1–100）
- **导出 JSON**：整库一键导出

<a id="tour-tools"></a>
### 🤖 模型工具 Model tools（13 个）

**12 个产物工具**：`register_artifact` · `artifact_list` · `artifact_get` · `artifact_update` ·
`artifact_trash` · `artifact_restore` · `artifact_stats` · `artifact_search` · `artifact_find` ·
`artifact_suggest_links` · `artifact_suggest_cleanup` · `project_overview`

**外加 1 个文件搜索工具**：`search_files`（本地文件名/路径检索，索引范围与面板一致）

<a id="usage"></a>
### 🕹️ 使用 Usage

- **完整管理页（仍在服役）**：侧栏脚部「产物库 · 网页版」，或访问
  `<dsh web 地址>/ext/artifact-library/`（端口由运行时决定，插件会向宿主索取**绝对**地址）。
  它**暂时还不能下线** —— 下面 5 项重功能里**只有「登记产物」搬进了原生面板**，
  其余 4 项**只有这个页面能做**（后端端点都已就绪，缺的是面板里的 UI）：

  | 重功能 | 原生面板 | 完整管理页 |
  |:---|:---:|:---:|
  | 登记产物 | ✅ 单个 + 多选批量（可撤销） | ✅ |
  | 导入文件夹 | ❌ | ✅ 唯一入口 |
  | 立即精炼 | ❌ | ✅ 唯一入口 |
  | 语义搜索 | ❌ | ✅ 唯一入口 |
  | 整理建议 | ❌ | ✅ 唯一入口 |

- **文件搜索**：面板 →「文件」→ 启动索引 → 输入关键词
- **快捷键**：`/` 搜索 · `n` 登记 · `g` 回收站 · `1/2/3` 视图

<a id="data-model"></a>
### 🗃️ 数据模型 Data model

`id / kind(deliverable|reference) / source / path / mime_type / title / summary / project / artifact_type / tags / status / stars / notes / references[] / contentIndex / session_id / agent_id / needsRefine / refineRequested / created_at / updated_at / trashed_at`

<a id="config"></a>
### ⚙️ 配置项 Config

| 位置 | 键 | 默认 | 说明 |
|:---|:---|:---|:---|
| 环境变量 | `DSH_ARTIFACT_LIBRARY_DIR` | `~/.dsh/artifact-library` | 数据目录 |
| Cordis config | `dataDir` | 同上 | 同上（环境变量优先） |
| Cordis config | `indexScopeDebounceMs` | `30000`（最小 1000） | 会话工作区变化后攒批刷新索引范围的防抖时长 |
| Cordis config | `maxAutoPerTurn` | `20` | 每轮自动采集上限 |
| 设置面板 | `autoCollect` | `true` | 自动采集开关 |
| 设置面板 | `cleanupEnabled` / `cleanupIntervalDays` | `true` / `7` | 定时整理 |
| 设置面板 | `backupKeep` / `backupOnCleanup` | `10` / `true` | 备份份数与整理前备份 |
| 设置面板 | `importMaxSizeMB` | `50` | 文件夹导入的单文件上限（MB） |
| 设置面板 | `searchLimit` | `20` | 语义搜索默认返回条数 |
| 设置面板 | `indexExtraDirs` | `[]` | **额外索引目录**（每行一个绝对路径，≤64 个，自动去重；由宿主执行并触发范围重算） |
| 设置面板 | `preset` / `density` / `defaultView` | `general` / `standard` / `list` | 外观：预设 / 行高密度 / 默认视图 |
| 设置面板 | `columns` / `sortBy` / `sortDir` | `{size,time}` / `name` / `asc` | 显示哪些列 / 排序 |
| 设置面板 | `thumbnails` / `thumbSize` / `galleryThumbSize` / `thumbMaxBytes` | `true` / `16` / `96` / `5242880` | 缩略图开关、尺寸、画廊尺寸、超过多少字节不生成缩略图 |
| 设置面板 | `listLimit` / `virtualThreshold` / `showHidden` / `panelWidth` | `2000` / `200` / `false` / `null` | 列表上限 / 虚拟滚动阈值 / 显示隐藏文件 / 记忆的面板宽度 |

> ⚠️ **上面后 4 行是宿主侧已实现的设置 schema**（`GET /ext/artifacts/settings` 实测返回它们），
> 但**对应的设置面板 UI 尚未发版**（见 [未发布](#unreleased)）。
> 在面板发版前，这些键可以通过 `PUT /ext/artifacts/settings` 直接改。

---

<a id="privacy"></a>
## 🔒 隐私 Privacy

- 正文索引（**每篇前 8000 字符**）、导入、导出、语义搜索全部**本地完成**，零外传
- **无遥测、无上报**
- 文件索引**不索引全盘**：范围 = DSH 工作区 + 已登记产出所在目录 + 你额外指定的目录（`indexExtraDirs`）
- `DSHArtifacts` 是**独立 Everything 实例**，与你自装的 Everything 互不干扰

---

<a id="security"></a>
## 🛡️ 安全边界 Security（v0.3.1 起）

- **敏感路径防护**：凭据/密钥类文件名（`credentials`/`creds`/`secret`/`token`/`api key`/`.env`/`.pem`/`.key`/`id_rsa` 等）与凭据目录（`.ssh`/`.gnupg`/`.aws`/`.azure`/`.kube`/`.docker`/`.npmrc`）下的文件，登记与导入**一律拒绝**，防止密钥泄露进正文索引与文件接口
- **来源限制**：`/ext/artifacts` 的**文件内容读取（`/:id/file`、单条记录、`/export`）与全部写操作仅限本机回环（127.0.0.1）**；局域网来源（`host: 0.0.0.0` 绑定）只读浏览**不含文件正文**的元数据（列表/搜索/统计/建议）。局域网内预览/编辑/登记/回收等操作用不了，属**预期行为**——安全优先
- **文件操作闸门**：文件操作（打开/定位）只放行**索引范围内**的路径，范围外一律 403
- **文件索引路由**：`/ext/artifacts/files*`（搜索 / status / start / stop）**仅限本机回环**，局域网来源 403
- 数据文件 `~/.dsh/artifact-library/` 为本地 JSON，含正文索引（每篇前 8000 字符），注意本机文件权限

---

<a id="limits"></a>
## ⚠️ 已知限制 Known limitations

> 这一节是**如实记录**，不是免责模板。以下每一条都在真机上实测复现过
> （完整事故记录见 [docs/RISK-ANALYSIS.md](docs/RISK-ANALYSIS.md)；
> **该文档 §7 逐条列出了面板各功能的风险、触发条件、影响面与缺口，
> 凡未实测的一律标「未验证」** —— 想评估「装之前该担心什么」看那一节）。

### 1. 文件索引是「三层降级」，首选层是**快照**

索引按 `filelists → ntfs → folder` 依次尝试，第一层成功就不往下走：

| 层 | 机制 | 代价 / 已知缺陷 |
|:-:|:---|:---|
| ① **filelists**（首选） | 只让 Everything 加载一份 `.efu` **文件清单**，不遍历目录、不索引卷 | ✅ 不需要管理员权限 · 不挑磁盘格式 · **实测 2.3 秒就绪** · 多目录全部生效<br>⚠️ **清单是快照** —— 文件增删后不会自动更新 |
| ② **ntfs** | 读卷 MFT + `ntfs_volume_include_onlys` 限制范围 | ✅ 快（实测 30 秒内就绪）<br>⚠️ **需要管理员权限**（普通用户直接失败）<br>⚠️ **只认第一个路径** —— 多目录场景直接残废<br>⚠️ 要读整卷 MFT，隐私上不如清单干净 |
| ③ **folder**（保底） | 让 Everything 自己逐层遍历目录树 | ⚠️ 范围里含 **junction / 符号链接**（如 pnpm 的 `node_modules`）会**僵死**（CPU 0%、IPC 无响应）<br>⚠️ 特定目录组合会**活锁**（CPU 100%、库始终 0 KB）—— 实测 11 万项烧到 **215 秒仍不就绪**<br>⚠️ 这是第三方组件的**固有缺陷**，靠排查无法穷尽规避 |

**快照重建规则**：满足任一条件才重建 ——
清单文件不存在 · 索引范围变了 · **距上次生成超过 6 小时**。

> **实际影响**：新建的文件**最多 6 小时后**才可能出现在文件搜索结果里。
> 想立刻看到，重启 dsh 或改动索引范围（都会立即触发重建）。
> 对「搜项目产出」这个场景够用（产出不是每分钟都在变），但**它不是实时索引**。

**三层全失败时**：会明确报错 + 清理实例 + **不影响产物库其它功能**，只是「文件」视图显示不可用原因。
引擎**懒启动**，你不动文件视图就一个进程都不会起。

### 2. NTFS 模式只认单目录（多目录场景请假定走 folder）

官方文档说 `ntfs_volume_include_onlys` 是「分号分隔的文件夹列表」，
**实测只认第一个路径**。因此只要索引范围不止一个目录 —— 而这是常态
（工作区 + 产出目录，两个就够）—— 就不能指望 NTFS 模式，
普通用户会落到**已知不可靠**的 folder 回退路径上。

### 3. 平台支持（2026-10-01 更新：已不是 Windows 专属）

**Windows** 的文件索引依赖内置 Everything（`vendor/everything/`，MIT，版本已锁 **1.5.0.1423b**）。
**Linux** 走纯 Node 范围索引（`lib/index/backend-node.js`），不依赖任何系统搜索工具，
两者接口与查询语法一致。

仍未验证的是 **macOS**：它会落到 Node 后端，但路径大小写语义（HFS+/APFS 默认不敏感）
与 `open -R` 那两条**没在真机上跑过** —— 代码里有分支，但**没有证据**，别当成已支持。

⚠️ 跨平台迁移的已知限制：产物记录里的 `path` 是**绝对路径且当主键**。
把一份 Windows 上的 `artifacts.json` 直接搬到 Linux，那些 `C:\…` 记录会全部失效
（现在至少**不会**把索引范围退化成 `.` —— `dirsFromArtifacts` 已改成形态感知解析，
但库本身不做路径重映射）。同机跨平台不迁移数据就不会遇到。

### 4. 「完整管理页」的去留（**2026-09-30 夜更新：已具备下线条件，但删不删请依琪定**）

`ui/index.html`（`/ext/artifact-library/`）原本只是**兜底入口**，代码注释里写着
「重功能第二期搬进原生面板」。**截至 2026-09-30 夜，那 5 项已全部有下落** —— 逐条核对：

| 重功能 | 原生面板 | 判据（按**端点 / 函数名**，可复核） |
|:---|:---:|:---|
| 登记产物 | ✅ 已搬 | `registerRow` / `batchRegister` 调 `POST /ext/artifacts` |
| **导入文件夹** | ✅ **已搬**（`ebd4648`）| `ImportPanel` 调 `POST /import`；**原生 picker 优先 + 手动路径兜底** |
| **立即精炼** | ⚖️ **当年拆成两半** | **`/refine-request`（标记优先精化）已搬** `986794e` + 撤销 `5390d68`；<br>**`/refine-session`（开会话）明确判断不做** —— 它依赖「**这台机器上有没有配模型**」，<br>失败面里有一大块无法验证；且「只做读的一半」与现有状态显示重复 |
| **语义搜索** | ✅ **已搬**（`55f397f`）| `SemanticView` 调 `GET /search`；**与关键词走不同通道、不静默降级** |
| **整理建议** | ✅ **已搬**（`e777c74`）| 独立视图调 `GET /suggest-cleanup` / `POST /cleanup-now`（含二次确认 + 真撤销）|

**⇒ 结论：4 项已搬，1 项（`/refine-session`）明确不做且已说明理由。**
**网页版原计划承担的「重功能」已全部有下落** ——
所以它**不再有「未搬完所以不能下线」这个理由**。

> ⚠️ **但「删不删」是产品决定，留给依琪。** 本表只陈述事实：
> **「不能删，因为功能没搬完」这个理由，现在不成立了。**
> 如果决定下线：**先确认网页版独有的「兜底入口」价值**（比如面板加载失败时的应急通道）——
> 那是它现在唯一可能还值得留的理由。

> ⚠️ **本表刻意不写行号** —— **端点 / 函数名不会漂，行号会**。
> （本条在 2026-09-30 夜被更新过：原文写「只搬了 5 个里的 1 个」，那是当时的实测；
> 当晚 4 项搬完 / 1 项判定不做后，那句话就成了**过期陈述**。）
> 第一次核这张表时我引了行号；几小时后再核，「`http.js:494`」**已经不再是 `/import`**
> （队友在同一个文件上继续加端点，`client.js` 更是整体漂了 300+ 行）。
> 所以判据一律用端点/符号名 —— 它们**别人也能复核**。
> 另：唯一带 `import` 的客户端调用是 `/settings/import`（**设置导入**，与文件夹导入无关）。
>
> 🔬 **还有一个坑，我当场踩了**：拿「端点字符串」做判据时，**必须先把注释剥掉**。
> 我把上面这张表写进 `client.js` 的注释后，再拿 `/suggest-cleanup` 去搜 ——
> 立刻「命中」，差点得出「已经搬完了」的反结论。**命中的是我自己写的那句注释，不是代码。**
> **判据本身也会被污染** —— 校验时要 `strip comments` 再搜。

> 所以：**别删 `ui/index.html`**，也别删 `sidebar.footer.action` 那个入口 ——
> 删了就等于把这 4 个功能一起删掉。等它们搬完再谈下线。

### 5. 其它已实测的边界

- **范围规模守卫**：单次范围估算超过 **60,000 项**时会提前返回，避免把 Everything 拖死
  （实测 41 万项的目录会让它**启动即僵死**；排掉 `node_modules` 后立刻恢复）
- **不存在的目录会被跳过**：索引范围里混入已删除的目录曾导致实例完全不响应 IPC，现已过滤并告警
- **「额外索引目录」已接线**（`indexExtraDirs`）：设置里的「额外索引目录」（每行一个**绝对路径**，
  最多 64 个，自动去重），由宿主执行。
  ⚠️ **它曾经是个「死设置」** —— 旧版 `lib/index.js` 会读它，但 `store` 的读写白名单里**都没有这个键**，
  于是恒为 `[]`，「指定额外目录」这个能力**从来不存在**。2026-09-30 已修：
  `settings.js` 收录该键并做校验（数组 / ≤64 项 / 绝对路径 / 单条 ≤1024 字符），
  `index.js` 在它变化时**真的触发索引范围重算**（而不是「存进去了但范围没变」）
- **杀毒软件可能拦截 `Everything.exe`**：目前只能表现为启动失败，尚无专门的人话提示
- **Everything 1.5 仍是 beta**：版本已锁定，**升级前必须重跑** `RISK-ANALYSIS.md` 里的全部对照实验
- **命名注意**：`cordis.patch.yml` 里的 `id: artifact-library` 是 **Cordis 补丁行 id**
  （对应 `lib/index.js` 的 `export const name = 'artifact-library'`），
  **与 `@dsh-external/dsh-artifact-library` 这个包名不是一回事**，改动时别搞混

---

<a id="changelog"></a>
## 📜 更新日志 Changelog

### v0.7.0（2026-09-30）· 本地文件管理器

- **内置 Everything 引擎**（`vendor/everything/`：Everything 1.5.0.1423b 便携版 + ES 1.1.0.38，均 MIT）
- **索引范围严格限定**：DSH 工作区 + 已登记产出所在目录 + 你额外指定的目录。
  实现方式 `auto_include_fixed_volumes=0` + 清空卷列表 + `folders=` 白名单。
  实测：限定前入库 3,217,522 条 / 库 118 MB → 限定后 6 条 / 库 **422 bytes**
  （「额外目录」当时只有读取路径、**写入路径没接线**，是个死设置；2026-09-30 已修好，见 [已知限制](#limits)）
- **索引模式三层降级**：**filelists（首选）→ ntfs → folder（保底）**，
  普通用户无需管理员权限也能用（见 [已知限制](#limits)）
- **独立实例** `DSHArtifacts`：与用户自己装的 Everything 完全隔离，不改不卸不干扰
- **懒启动**：不搜索就不启动任何进程；关闭走官方 `-exit`（强杀会丢范围配置）
- 新增 HTTP 路由 `/ext/artifacts/files*`（搜索 / status / start / stop），**仅限本机回环访问**
- 面板新增「文件」视图：Everything 语法搜索、命中统计、一键登记为产物、复制目录
- **「目录」视图（文件管理器形态）**：逐层浏览工作区与产出目录
- **主动纳管**：订阅会话事件，会话的工作目录**自动**纳入索引范围，防抖攒批 30 秒
- **文件搜索工具**：模型侧也能用 `search_files` 搜本地文件（描述里如实写明范围边界）
- **安全闸门**：文件操作只放行索引范围内的路径；文件索引路由**仅限本机回环**
- 离线自验 24 项 + 路由 harness 10 项，全绿；含三条硬断言：
  **范围外路径零泄漏** · **中文文件名不乱码** · **全盘可见量受控**

### v0.6.0（2026-09-30）· 搬进 DSH UI 第一期

- **主面板走官方席位**：`sidebar.panellist`（左侧栏图标）+ `main`（主区 keyed slot 面板）
- **原生 React 渲染**：统计条、搜索、筛选、三视图、详情抽屉、星级、编辑、回收站、定位、复制路径
- **样式全部读 DSH 设计 token**，**自动跟随深浅主题**
- 完整管理页保留为**兜底入口**（登记 / 导入 / 精炼 / 语义搜索 / 整理建议 第二期搬入）
- **宿主侧 REST API 与数据零改动**；客户端 `apply` 永不抛出
- ⚠️ 客户端 entry 抛异常 = **整个应用起不来**（2026-09-28 的教训），所以三条约束不能松：
  `apply` 全程 try/catch、用 `ctx.get('slots')` 而非 `ctx.slots`、**不导出 `inject`**

---

<a id="license"></a>
## ⚖️ License

[MIT](LICENSE) © 2026 dsh-artifact-library contributors

第三方组件（Everything / ES 等）的许可与来源见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

[↑ 回到顶部](#top)
