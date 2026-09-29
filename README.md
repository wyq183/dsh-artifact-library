# 🐋 dsh-artifact-library · DSH 产物库

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-0.7.0-green)
![Platform](https://img.shields.io/badge/platform-DeepSeek%20Harness-4F46E5)

**DeepSeek Harness 的「作品柜 + 资料柜 + 工作台」**：自动采集 AI 产出、AI 自动分类整理、一句话语义检索、AI 替你连线。本地优先，数据绝不出本机。

**The "deliverable vault + reference shelf + shared workspace" for DeepSeek Harness**: auto-collect AI outputs, AI-organize them, semantic search in plain language, AI-suggested linking. Local-first — your data never leaves the machine.

## ✨ 特性 Features

| 能力 | 说明 |
|---|---|
| **本地文件管理器**（v0.7.0 新增） | 内置 [Everything](https://www.voidtools.com/) 引擎（MIT，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)），**毫秒级**本地文件搜索：Everything 语法（`ext:psd` · `dm:today` · `size:>10mb` · `path:项目`），命中项可一键登记为产物。索引范围**严格限定**在「DSH 工作区 + 已登记产出所在目录」，**不索引全盘**，全部本地完成 |
| **自动采集** | 订阅会话事件，AI 每轮产出的文件自动进库，并记录**来源会话**（可回看诞生过程）|
| **AI 整理分类** | 自动采集后标记「待精化」，会话内模型主动补全摘要/标签/项目；或点「立即精炼」开专属精化会话批量处理 |
| **一句话语义搜索** | `artifact_find` / 管理页 🔍 语义搜索：用自然语言描述（「上次那个视频素材」）就能找回，自动拆词加权打分 |
| **AI 替你连线** | `artifact_suggest_links` / 编辑页「相关建议」：自动扫描同项目/同标签/同目录/标题相似的产出与资料，一键填入引用 |
| **整理建议单** | `artifact_suggest_cleanup` / 管理页 🧹：扫描重复记录、文件缺失、待精化、僵尸项目，出可执行建议单 |
| **资料库** | 文件夹一键批量导入（目录名当项目、本地正文索引），产出可关联引用的资料 |
| **项目总览** | `project_overview` 一句话了解某项目的产出与资料 |
| **维护** | 定时整理（去重/文件状态刷新，默认每周）、自动备份（保留 10 份）、导出 JSON |
| **人性化** | 撤销式操作、快捷键、批量操作、图片缩放/音视频倍速预览、缺失文件提醒 |

模型侧一共 **12 个工具**：`register_artifact` / `artifact_list` / `artifact_get` / `artifact_update` / `artifact_trash` / `artifact_restore` / `artifact_stats` / `artifact_search` / `artifact_find` / `artifact_suggest_links` / `artifact_suggest_cleanup` / `project_overview`。

## 📦 安装 Install

```sh
dsh plugin --profile web add github:wyq183/dsh-artifact-library
# 或本地源码：
# dsh plugin --profile web add <本仓库路径>
# 重启 dsh web 生效
```

数据存于 `~/.dsh/artifact-library/`（可用环境变量 `DSH_ARTIFACT_LIBRARY_DIR` 覆盖）。

## 🚀 使用 Usage

- **原生面板（v0.6.0 起，推荐）**：左侧栏 🐋「产物库」图标 → 主区整块打开产物库面板。原生 React 渲染，跟随 DSH 主题：统计条、搜索、kind/状态/项目/排序筛选、卡片·列表·项目三视图、详情抽屉（图片/文本/音视频内联预览）、星级、编辑、回收站/恢复、文件管理器定位、复制路径
- **文件搜索（v0.7.0）**：面板顶部视图切换点「文件」→ 首次点「启动文件索引」（拉起内置 Everything 并建立索引，首次可能需几十秒）→ 之后输入关键词即时出结果。索引范围会在界面上如实显示；命中项可一键「登记」进产物库
- **完整管理页**：侧栏脚部「产物库 · 网页版」，或访问 `<dsh web 地址>/ext/artifact-library/`（默认 `http://127.0.0.1:3080/ext/artifact-library/`）。**登记 / 导入文件夹 / 精炼 / 语义搜索 / 整理建议**目前仍在此页（第二期搬进原生面板）
- **语义搜索**：管理页 🔍 按钮，或让任意会话的 AI 用 `artifact_find`
- **AI 连线**：编辑产物时点「扫描相关条目」，或让 AI 用 `artifact_suggest_links`
- **整理建议**：管理页 🧹 按钮，或让 AI 用 `artifact_suggest_cleanup`
- **精化**：管理页勾选条目 → ⚡ 立即精炼（或 ⚡ 精化项目 / ⚡ 精化文件夹）→ 专属精化会话执行
- **快捷键**：`/` 搜索 · `n` 登记 · `g` 回收站 · `1/2/3` 视图

## 🗂️ 数据模型 Data model

`id / kind(deliverable|reference) / source / path / mime_type / title / summary / project / artifact_type / tags / status / stars / notes / references[] / contentIndex / session_id / agent_id / needsRefine / refineRequested / created_at / updated_at / trashed_at`

## 🔒 隐私 Privacy

- 全文索引、导入、导出、语义搜索全部**本地完成**，零外传
- 无遥测、无上报

## 🛡️ 安全边界 Security（v0.3.1）

- **敏感路径防护**：凭据/密钥类文件名（`credentials`/`creds`/`secret`/`token`/`api key`/`.env`/`.pem`/`.key`/`id_rsa` 等）与凭据目录（`.ssh`/`.gnupg`/`.aws`/`.azure`/`.kube`/`.docker`/`.npmrc`）下的文件，登记与导入一律拒绝，防止密钥泄露进全文索引与文件接口
- **来源限制**：`/ext/artifacts` 的**文件内容读取（`/:id/file`、单条记录、`/export`）与全部写操作仅限本机回环（127.0.0.1）**；局域网来源（`host: 0.0.0.0` 绑定）只读浏览不含文件正文的元数据（列表/搜索/统计/建议）。局域网内预览/编辑/登记/回收等操作用不了，属预期行为——安全优先
- 数据文件 `~/.dsh/artifact-library/` 为本地 JSON，含全文索引，注意本机文件权限

## ⚖️ License

[MIT](LICENSE)

## 📜 更新日志 Changelog

### v0.7.0（2026-09-30）· 本地文件管理器（P1 索引层）

- **内置 Everything 引擎**（`vendor/everything/`：Everything 1.5.0.1423b 便携版 + ES 1.1.0.38，均 MIT）
- **索引范围严格限定**：DSH 工作区 + 已登记产出所在目录 + 用户额外目录；
  实现方式 `auto_include_fixed_volumes=0` + 清空卷列表 + `folders=` 白名单。
  实测：限定前入库 3,217,522 条 / 库 118 MB → 限定后 6 条 / 库 **422 bytes**
- **独立实例** `DSHArtifacts`：与用户自己装的 Everything 完全隔离，不改不卸不干扰
- **懒启动**：不搜索就不启动任何进程；关闭走官方 `-exit`（强杀会丢范围配置）
- 新增 HTTP 路由 `/ext/artifacts/files*`（搜索 / status / start / stop），
  **仅限本机回环访问**（局域网来源 403）
- 面板新增「文件」视图：Everything 语法搜索、命中统计、一键登记为产物、复制目录
- 离线自验 24 项 + 路由 harness 10 项，全绿；含三条硬断言：
  **范围外路径零泄漏** · **中文文件名不乱码** · **全盘可见量受控**

### v0.6.0（2026-09-30）· 搬进 DSH UI 第一期

- **主面板走官方席位**：`sidebar.panellist`（左侧栏图标）+ `main`（主区 keyed slot 面板）——同一条公开路径，官方 `dsh-client-ui-schedule` 的同类做法；**不依赖任何第三方侧栏插件**
- **原生 React 渲染**：统计条、搜索、kind/状态/项目/排序筛选、卡片·列表·项目三视图、详情抽屉（图片/文本/音视频内联预览）、星级打分、编辑（PATCH 局部字段）、回收站/恢复、文件管理器定位、复制路径
- **样式全部读 DSH 设计 token**（`--dsw-alias-*` / `--dsw-font-*` / `--dsw-radius-*` / `--dsw-shadow-*`），**自动跟随深浅主题**
- 完整管理页保留为**兜底入口**（登记 / 导入 / 精炼 / 语义搜索 / 整理建议 第二期搬入）
- **宿主侧 REST API 与数据零改动**；客户端 `apply` 永不抛出（22/22 覆盖：11 种 ctx 形态 + 注册形态 + 四种渲染路径）
- ⚠️ 客户端 entry 抛异常 = **整个应用起不来**（2026-09-28 的教训），所以三条约束不能松：`apply` 全程 try/catch、用 `ctx.get('slots')` 而非 `ctx.slots`、**不导出 `inject`**

详见 [CHANGELOG.md](CHANGELOG.md)。
