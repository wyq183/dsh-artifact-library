# 🐋 dsh-artifact-library · DSH 产物库

**DeepSeek Harness 的「作品柜 + 资料柜」**：自动采集 AI 产出、AI 自动分类整理、跨会话全文检索复用、项目级总览。本地优先，数据绝不出本机。

**The "deliverable vault + reference shelf" for DeepSeek Harness**: auto-collect AI outputs, AI-organize them, full-text search across sessions, and per-project overview. Local-first — your data never leaves the machine.

## ✨ 特性 Features

| 能力 | 说明 |
|---|---|
| **自动采集** | 订阅会话事件，AI 每轮产出的文件自动进库（无需手动登记）|
| **AI 整理分类** | 自动采集后标记「待精化」，会话内模型主动补全摘要/标签/项目；或点「立即精炼」开专属精化会话批量处理 |
| **资料库** | 文件夹一键批量导入（目录名当项目、本地正文索引），产出可关联引用的资料 |
| **全文检索** | 搜标题/摘要/正文/文件名，跨会话找回"以前做过的东西" |
| **项目总览** | `project_overview` 一句话了解某项目的产出与资料 |
| **维护** | 定时整理（去重/文件状态刷新，默认每周）、自动备份（保留 10 份）、导出 JSON |
| **人性化** | 撤销式操作、快捷键、批量操作、图片缩放/音视频倍速预览、缺失文件提醒 |

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
- **AI 侧**：模型自动获得 `register_artifact` / `artifact_list` / `artifact_get` / `artifact_update` / `artifact_trash` / `artifact_restore` / `artifact_stats` / `artifact_search` / `project_overview` 9 个工具
- **精化**：管理页勾选条目 → ⚡ 立即精炼（或 ⚡ 精化项目 / ⚡ 精化文件夹）→ 专属精化会话执行
- **快捷键**：`/` 搜索 · `n` 登记 · `g` 回收站 · `1/2/3` 视图

## 🗂️ 数据模型 Data model

`id / kind(deliverable|reference) / source / path / mime_type / title / summary / project / artifact_type / tags / status / stars / notes / references[] / contentIndex / needsRefine / refineRequested / created_at / updated_at / trashed_at`

## 🔒 隐私 Privacy

- 全文索引、导入、导出全部**本地完成**，零外传
- 外部视觉识别（图片内容分类）默认关闭，需手动开启
- 无遥测、无上报

## ⚖️ License

[MIT](LICENSE)
