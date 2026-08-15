# 🐋 dsh-artifact-library · DSH 产物库

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-0.3.0-green)
![Platform](https://img.shields.io/badge/platform-DeepSeek%20Harness-4F46E5)

**DeepSeek Harness 的「作品柜 + 资料柜 + 工作台」**：自动采集 AI 产出、AI 自动分类整理、一句话语义检索、AI 替你连线、专属「产物库助手」会话。本地优先，数据绝不出本机。

**The "deliverable vault + reference shelf + shared workspace" for DeepSeek Harness**: auto-collect AI outputs, AI-organize them, semantic search in plain language, AI-suggested linking, and a dedicated assistant session. Local-first — your data never leaves the machine.

## ✨ 特性 Features

| 能力 | 说明 |
|---|---|
| **自动采集** | 订阅会话事件，AI 每轮产出的文件自动进库，并记录**来源会话**（可回看诞生过程）|
| **AI 整理分类** | 自动采集后标记「待精化」，会话内模型主动补全摘要/标签/项目；或点「立即精炼」开专属精化会话批量处理 |
| **一句话语义搜索** | `artifact_find` / 管理页 🔍 语义搜索：用自然语言描述（「上次那个视频素材」）就能找回，自动拆词加权打分 |
| **AI 替你连线** | `artifact_suggest_links` / 编辑页「相关建议」：自动扫描同项目/同标签/同目录/标题相似的产出与资料，一键填入引用 |
| **产物库助手会话** | 侧边栏 🤖「问产物库」：创建专属助手会话，用聊天的方式问库（找东西、看统计、要整理建议），模型调工具回答 |
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

- **管理页**：`http://127.0.0.1:3080/ext/artifact-library/`（侧边栏 🐋 入口）
- **问产物库**：侧边栏 🤖 按钮 → 创建/复用「产物库助手」会话 → 到会话列表打开它，用自然语言提问
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

## ⚖️ License

[MIT](LICENSE)

## 📜 更新日志 Changelog

详见 [CHANGELOG.md](CHANGELOG.md)。
