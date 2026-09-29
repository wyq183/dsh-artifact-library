# 架构说明 · 文件索引层

> 版本：v0.7.0 ｜ 建立：2026-09-30 ｜ 适用：DSH 0.2.0-rc.2（desktop profile）

---

## 一、为什么做这个

官方文件页 `@deepseek-ai/dsh-client-ui-sidebar-files` 的 README **自己写明了**两条限制：

> - **只有列目录。** 没有搜索、产物过滤、拖拽、重命名、右键菜单或当前文件高亮。
> - **只有一个根。** 树以会话工作目录为根；**Host 本来也拒绝工作区根之外的路径**。

也就是说官方能力 = **逐层网络拉取 + 无搜索 + 锁死工作区根**。

本项目补的正是这三块空白：

| 官方缺的 | 本项目补的 |
|:---|:---|
| 没有搜索 | **毫秒级**本地索引检索（Everything 引擎） |
| 锁死单个会话的工作区根 | **跨工作区 + 已登记产出目录**的统一视图 |
| 只有"文件" | 产物语义层：项目分类 / 星级 / 备注 / 引用 / 自动精炼 |

---

## 二、组件结构

```
┌─ 客户端（浏览器 / dsh-app://）──────────────────────────┐
│  lib/client.js                                          │
│   · sidebar.panellist + main slot  → 产物库主面板        │
│   · FilesView                       → 「文件」视图       │
│       Everything 语法搜索 / 一键登记为产物 / 复制目录     │
└───────────────────────┬─────────────────────────────────┘
                        │ fetch（相对路径；桌面端由宿主转接）
┌───────────────────────▼─────────────────────────────────┐
│  宿主（Node）                                            │
│   lib/http.js        /ext/artifacts/files*  路由分发      │
│   lib/index.js       范围解析 + 引擎生命周期挂载           │
│   lib/index/                                             │
│     engine.js        懒启动门面（ensureReady/search/…)    │
│     es.js            es.exe 调用（走 export 通道）        │
│     ini.js           范围限定配置生成（只在变化时写盘）    │
│     scope.js         纯函数：范围规范化（父子合并/去重）   │
│     workspaces.js    DSH 工作区收集（官方 follow() 投影）  │
│     paths.js         路径与常量                           │
│     tool.js          search_files 模型工具                │
│     selftest.js      离线自验（24 项，真拉起实例）         │
└───────────────────────┬─────────────────────────────────┘
                        │ spawn / -export-json
┌───────────────────────▼─────────────────────────────────┐
│  内置 Everything（vendor/everything/，MIT）               │
│   · Everything.exe 1.5.0.1423b   便携版，独立实例         │
│   · es.exe 1.1.0.38              命令行接口               │
│   实例名 DSHArtifacts —— 与用户自己装的实例完全隔离        │
└─────────────────────────────────────────────────────────┘
```

---

## 三、数据流（一次搜索）

1. 用户在「文件」视图输入，或模型调用 `search_files`
2. → `GET /ext/artifacts/files?q=…`（或工具内部直接调引擎）
3. → `http.js` 分发 → `engine.search()`
4. 引擎未就绪时先 `ensureReady()`：
   - 按当前范围**重写 ini**（只在内容变化时写；写盘后需重启实例才生效）
   - **探测**实例（`es -get-everything-version`，退出码 0 = 活着）
   - 没跑就**拉起**（detached，独立于宿主存活）→ 轮询等就绪（最多 90 秒）
   - ini 变了则**先正常关闭再启动**
5. `es.js` 执行 `es.exe -instance DSHArtifacts -export-json <临时文件> -utf8-bom …`
6. 读回文件、`JSON.parse`、**归一化**（FILETIME → Unix 秒；路径拆出 name/dir/ext）
7. 返回 `{ ok, rows, total, elapsedMs, status }`

---

## 四、关键设计决策（每条都有实测依据）

| 决策 | 为什么这么做 |
|:---|:---|
| **内置 Everything 便携版**（而非要求用户安装） | MIT 许可**实读 `LICENSE.txt` 确认**可分发；用户零安装；与用户已有实例完全隔离（各自 ini/db/进程/IPC） |
| **只索引「工作区 + 已登记产出目录」** | ① 隐私边界清晰 ② **免管理员权限** —— 官方明示 folder indexing「标准用户 + 便携版即可」，不依赖服务 |
| **走 `-export-json` 而不是读 stdout** | es.exe 的 stdout 是**系统 ANSI（GBK）**，Node 内置**不支持 GBK 解码** → 中文文件名必乱码。export 通道写文件是 UTF-8+BOM |
| **懒启动** | 不搜索就不启动任何进程 —— 零常驻开销，不打扰用户 |
| **正常退出（`es -exit`）而非强杀** | Everything **退出时才写 ini**；强杀会丢范围配置 → 下次按默认索引**全盘** = 隐私事故 |
| **串行查询队列** | Everything 本身很快；串行可避免临时文件撞名、避免打满磁盘 I/O |
| **`files` 路由排在 `GET :id` 之前** | 否则 `id='files'` 会被 `store.get()` 当成产物 id 处理 |
| **仅限本机回环** | 文件系统信息不外给局域网（非回环来源一律 403） |
| **引擎缺失返回 503 而非抛错** | 客户端 UI 已热载但宿主路由未加载是常见中间态，要能优雅降级 |

---

## 五、生命周期

```
应用启动
  └─ 插件 apply：创建引擎对象（**不启动任何进程**）
       └─ 注册路由 /ext/artifacts/files*、注册 search_files 工具

首次搜索 / 首次打开「文件」视图
  └─ ensureReady(scope)
       ├─ ensureIni(scope)   → 内容变化才写盘
       ├─ ping()             → 活着？
       ├─ 需要时 shutdown() → 先正常关（保证旧 ini 落盘）
       ├─ spawnInstance()   → detached + unref
       └─ waitReady(90s)    → 轮询 -get-result-count

日常
  └─ 每次搜索：确保就绪 → es 查询 → 归一化返回

应用退出
  └─ 引擎 effect 的 disposer → shutdown()（es -exit）
```

**范围变化**（新增工作区 / 新登记产出目录 / 用户加目录）：
下次 `ensureReady` 会重写 ini 并**重启实例** —— 旧库文件保留，Everything 会重建索引。

---

## 六、安全边界

| 边界 | 实现 |
|:---|:---|
| **不索引全盘** | ini：`auto_include_fixed_volumes=0` + 清空 `ntfs_volume_paths` + `folders=` 白名单<br>实测：限定前 3,217,522 条 / 118 MB → 限定后 **6 条 / 422 bytes** |
| **不需要管理员** | folder indexing 官方支持标准用户；ini 里 `run_as_admin=0` |
| **不碰用户的 Everything** | 独立实例名 `DSHArtifacts`；不修改/替换/卸载用户安装 |
| **不读文件内容** | Everything 只索引文件名与路径；本插件也不读正文 |
| **不外传** | 全部本地；无遥测、无网络请求 |
| **局域网隔离** | `/ext/artifacts/files*` 不在回环白名单 → 非本机来源 403 |
| **不改用户目录** | 所有运行时数据在插件数据目录与 `vendor/` 下的 ini/db |

---

## 七、已知限制（如实说明）

- **只搜文件名/路径，不搜内容** —— 按内容找文件请用 `grep`。这是 Everything 的设计，也是它快的原因。
  （内容检索是后续版本的事。）
- **首次启动索引需要数十秒** —— 首次拉起 Everything 并建立索引；之后毫秒级。
- **Windows only** —— Everything 是 Windows 工具。其他平台需要换引擎（未实现）。
- **包体 +5.26 MB** —— 内置的 Everything 便携版 + ES 命令行。
- **工作区收集是"尽力而为"** —— 官方 `follow()` 的返回形态未在文档中写死，本实现做多形态兼容；
  拿不到时只影响「工作区」那一路，不影响已登记产出目录。
- **范围是白名单快照** —— 新增目录需下次 `ensureReady` 才纳入（会自动重启实例）。

---

## 八、测试

| 套件 | 位置 | 断言数 | 覆盖 |
|:---|:---|---:|:---|
| 引擎离线自验 | `lib/index/selftest.js` | 24 | 范围纯函数 / ini 生成 / **真拉起 Everything 真查询** / 隐私零泄漏 / 中文不乱码 / 正常关闭 |
| 路由 harness | `test/http-files.test.mjs` | 10 | 分发优先级 / 参数透传 / 局域网 403 / 引擎缺失 503 / 原路由回归 |
| 模型工具 | `test/file-search-tool.test.mjs` | 14 | 工具定义合法性 / 正常路径 / limit 钳制 / 空结果 / 异常兜底 |
| 客户端插件 | `test/client-apply.test.mjs` | 22 | apply 永不抛出（11 种 ctx）/ 注册形态 / 渲染路径 |

运行方式：

```powershell
node lib/index/selftest.js            # 需要本机可写，会真拉起一个 Everything 实例（跑完自动关）
node test/http-files.test.mjs
node test/file-search-tool.test.mjs
node test/client-apply.test.mjs
```
