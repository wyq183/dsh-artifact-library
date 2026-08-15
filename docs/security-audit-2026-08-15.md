# 产物库插件安全审查与修复记录（2026-08-15 · v0.3.1）

审查对象：`@dsh-external/dsh-artifact-library` v0.3.0（web profile 装配实例）
审查方式：源码逐模块 + 4 组测试脚本 + 真实 HTTP 攻击链验证 + 管理页实测

## 一、审查发现

### 🔴 高危 · 未授权任意文件读取 + 宿主操作（当时真实可利用）

- `webServer`（dsh-host-webserver）是纯路由分发器，**无鉴权中间件**；`/api` 有信任围栏，但插件注册的 `/ext/artifacts*` 完全裸奔
- 当时 web profile 绑定 `host: '0.0.0.0'`（为手机局域网访问）→ 局域网内任何设备可直达这些接口
- 攻击链（已实测证实）：
  1. `POST /ext/artifacts` 可登记**任意本地路径**——`register()` 无敏感过滤（仅 `importFolder` 有防护，直接 POST 可绕过）
  2. `GET /ext/artifacts/:id/file` 流式返回该文件完整内容（实测读出假密钥文件）
  3. 附带：`POST /:id/open` 弹宿主机 explorer、`DELETE` 硬删、`POST /import` 扫任意目录、`PUT /settings` 改配置

### 🟠 中 · 大目录导入 O(n²) 写盘

`importFolder` 每登记一个文件都同步全量重写 `artifacts.json`（writeFileSync + renameSync），n 个文件 = n 次全量序列化+写盘。

### 🟡 低

1. `artifact_search` 正文 snippet 失效：`store.list()` 剥掉了 `contentIndex`，工具侧永远取不到正文片段（命中仍准确）
2. `refineSessionId` 复用不校验会话存在性，会话被删后 prompt 永久失败且不清缓存
3. `references` 不校验 id 存在性，可引用不存在的 id

## 二、修复措施（v0.3.1）

| 级别 | 修复 |
| --- | --- |
| 高危 | `store.register()` 增加敏感路径防护：凭据/密钥文件名正则（credentials/creds/secret/token/api key/.env/.pem/.key/id_rsa 等）+ 凭据目录任意段拒绝（.ssh/.gnupg/.aws/.azure/.kube/.docker/.npmrc）；`importFolder` 复用同一检测并补 `.dsh` 等导入根拒绝 |
| 高危 | `http.js` 来源限制：非回环来源（局域网）只放行不含文件正文的只读元数据（列表/搜索/统计/建议/设置只读）；`/:id` 单条（含 contentIndex）、`/:id/file`、`/export` 与一切写操作仅限本机（socket.remoteAddress 判定，TCP 层不可伪造） |
| 中 | `register()` 支持 `deferSave`，`importFolder` 批量登记后一次性落盘 |
| 低 | `artifact_search` 命中后按 id 取单条回填正文片段 |
| 低 | `refineSessionId` prompt 失败/异常时清缓存自愈，下次重建 |
| 低 | `update()` 写入 references 时剔除不存在/已回收/自引用 id |
| 文档 | README 新增「安全边界」一节；CHANGELOG 记录 v0.3.1 |

## 三、验证

- **单元/自测**：test-http 17 项全过（新增：敏感文件名拒绝、凭据目录拒绝、局域网 403 矩阵、引用清理）；test-import / test-apply 全过
- **真实攻击链回归**（临时数据 + 真 HTTP server）：本机登记敏感路径 → 400；局域网登记/读 /file/删除 → 403；局域网列表 → 200
- **装配实例验证**：热重载后 curl `POST /ext/artifacts`（.ssh 路径）→ 400；库内无污染记录；`/ext/artifact-library/` 返回完整 UI；`/ext/artifacts` 列表正常
- 热重载：`dev_reload_package dsh-artifact-library` 成功（清缓存 7 模块，重建 1 fiber）

## 四、遗留观察（未修，低优先级）

- 语义搜索/连线建议为全量暴力扫描（当前库小无感；上千条 + 大 contentIndex 会慢，可考虑预建索引）
- `list()` 默认 limit 500 与工具默认 50 不一致（无 bug，冗余）
- `cleanup-now` 同步执行，大库时阻塞 HTTP 响应
- 测试脚本（test-*.mjs）按社区包惯例留在本地（gitignore），不进 npm 包
