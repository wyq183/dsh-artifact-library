# Changelog

## 0.3.4 (2026-09-05)

**兼容 DSH 0.1.2-rc.1（apiProxy 移除）：**

- **插件可重新加载**：`inject` 移除已被 DSH 删除的 `apiProxy` 服务，改为注入 `sessionController` / `workspaceController`，解决「pending (waiting for service: apiProxy) → 插件树加载失败 → 产物库不可用」
- **「立即精炼」改用新 Host API**：`ctx.apiProxy.workspace.create/sessions.create/sessions.prompt`（RPC `{payload}` 形状）迁移到 `ctx.workspaceController.create({path})` / `ctx.sessionController.create({workspaceId})` / `ctx.sessionController.rename(...)` / `ctx.sessionController.prompt({requestId,...}, signal)`
- 精化会话标题在新 API 下改为 best-effort rename，失败不阻断精化

**测试：**

- `test-apply.mjs` 同步更新为 `sessionController` / `workspaceController` mock，覆盖「首次创建 + 二次复用 + prompt 带 signal」路径

## 0.3.3 (2026-08-15)

**Bug 修复：**

- **音视频进度条可拖动**：`/ext/artifacts/:id/file` 支持 HTTP Range（206 分段响应），浏览器里视频/音频预览可以 seek 拖动进度，不再卡在开头

## 0.3.2 (2026-08-15)

**Bug 修复：**

- **预览关闭即停止播放**：修复音频/视频预览后点关闭（✕ / Escape / 点背景）仍在后台播放的问题——`closeLb` 现在会清空预览区释放媒体元素。图片/文本类型不受影响

## 0.3.1 (2026-08-15)

**安全加固（审查修复）：**

- **高危 · 未授权访问**：`webServer` 无鉴权中间件，profile 可能绑定 `0.0.0.0` 供局域网访问——修复后 `/ext/artifacts` 的**文件内容读取（/file、单条含正文、/export）与一切写操作（登记/导入/回收/删除/设置/精化/explorer 打开）仅限本机回环来源**；局域网来源只放行不含文件正文的只读元数据（列表/搜索/分类/统计/建议/设置只读）
- **高危 · 任意路径登记**：`register()` 增加敏感路径防护（与导入同规则）——凭据/密钥文件名（credentials/creds/secret/token/api key/.env/.pem/.key/id_rsa 等）与凭据目录（.ssh/.gnupg/.aws/.azure/.kube/.docker/.npmrc）下的文件一律拒绝进库，堵死「登记任意本地文件 → /file 下载」链
- **中 · 大目录导入 O(n²)**：`importFolder` 改为批量登记 + 一次性落盘（deferSave），不再逐文件全量重写 artifacts.json
- **低 · artifact_search 正文片段**：命中正文内容时按 id 取单条记录回填 contentIndex，片段不再只显示摘要
- **低 · 精化会话自愈**：`refineSessionId` 复用失败（会话被删/失效）时自动清缓存，下次重新创建，不再永久失败
- **低 · 引用一致性**：`update` 写入 references 时剔除不存在/已回收/自引用的 id

**测试**：test-http 新增 9 项（敏感文件名/凭据目录拒绝、局域网 403 矩阵、引用清理）；全量回归通过。

## 0.3.0 (2026-08-15)

**平台特性集成 —— 让 AI 自己用库：**

- **P1 · 12 个全局模型工具**：新增 `artifact_find`（自然语言语义搜索，自动拆词 + 标题/标签/摘要/正文加权打分 + 命中词展示）、`artifact_suggest_links`（连线建议：同项目/同标签/同目录/标题相似）、`artifact_suggest_cleanup`（整理建议单）；`register_artifact` 自动记录来源会话（exec.agent.session.id）
- **P2 · 产出可溯源**：自动采集与登记都写入 `session_id`，卡片/详情展示来源会话

**检索与整理升级：**

- **B1 · 语义搜索**：管理页 🔍 按钮 + `artifact_find` 工具，用一句话描述找回历史产出/资料
- **C1 · AI 自动连线**：编辑产物时「扫描相关条目」一键填入引用（references）
- **C2 · 整理建议单**：管理页 🧹 按钮 + `artifact_suggest_cleanup` 工具，重复记录（一键归档）/文件缺失/待精化/僵尸项目，出可执行建议

**其他：**

- 管理页新增：语义搜索弹窗、整理建议面板、编辑页相关建议、来源会话徽标
- 测试：test-apply 覆盖新工具 execute 顺序 + P2 来源追踪；测试数据隔离（apply 走临时 dataDir，不污染真实库）
- 取舍：早期设计里的「产物库助手专属会话」因与 P1 全局工具能力重复（任何会话都能直接调工具问库）而移除，不占用多余入口

## 0.2.0 (2026-08-15)

- **自动采集**：订阅会话事件，AI 每轮产出的文件自动进库（kind=deliverable, source=session），去重、读类工具忽略、每轮上限
- **AI 精化体系**：待精化标记（缺摘要/标签）、会话内模型精化闭环、用户主动「立即精炼」（单个/项目/文件夹/全量，专属精化会话复用）
- **资料库**：文件夹批量导入（目录名当项目、本地正文索引、二进制/超大跳过）、产出↔资料关联（references）
- **检索增强**：全文检索（正文索引）、project_overview 项目概览
- **维护**：定时整理（去重+文件状态刷新，默认周更可调）、自动备份（快照保留 10 份）、导出 JSON
- **人性化**：撤销式 toast、快捷键、批量操作（回收/改项目/加标签）、统计概览、缺失文件提醒、预览升级（图片缩放/平移、音视频倍速）
- **设置面板**：自动采集/整理频率/立即整理，全部可配
- 修复：工具 execute 参数顺序（框架约定 execute(args, exec)）、路径规范化去重、老数据回填
