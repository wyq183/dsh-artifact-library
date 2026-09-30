# 上架清单 Submit checklist

> 目标站点：**`deepseek-harness-plugin.com`**（社区独立站，非官方）
> 目标分类：**`UI Enhancements`**
> 核查时间：2026-09-30 ｜ 核查人：release-prep
> 被核查仓库：`https://github.com/wyq183/dsh-artifact-library`（分支 `master`）

---

## 零、当前状态总览

| # | 站点要求 / 抓取项 | 状态 | 证据 |
|:-:|:---|:--:|:---|
| 1 | 仓库**公开** | ✅ | GitHub API `private: false`；匿名 GET 返回 HTTP 200 |
| 2 | README 说清「做什么 / 怎么装」 | ✅ | `README.md` 重写：Hero → 截图 → TOC → 功能一览 → 安装 → 特性巡礼 → 安全 → 已知限制 → License |
| 3 | 明确 **LICENSE** | ✅ | `LICENSE` = MIT；GitHub API `license.spdx_id = "MIT"` |
| 4 | 打 **`dsh-plugin`** topic | ❌ **缺** | GitHub API `topics: []` —— **空数组，一个 topic 都没打** |
| 5 | 截图 `docs/screenshots/*.png` | ❌ **缺** | 该目录只有 `README.md`（截图规范），**0 张 png** |
| 6 | `package.json.name` 三处一致 | ✅ | 逐字节比对通过（见 §二） |
| 7 | `keywords` 含 `dsh-plugin` | ✅ | `["dsh","dsh-plugin","deepseek-harness","artifact-library","file-manager","everything","local-search"]` |
| 8 | 声明 **peer 版本下限** | ✅ **本次补上** | 新增 `peerDependencies`，下限 `>=0.2.0-rc.2`（见 §三） |
| 9 | 启动日志自证 | 🟡 **半** | 宿主侧有 `artifact-library: store at …`；**客户端侧没有**（见 §四 R4） |
| 10 | 仍在维护（站点倾向项） | ✅ | 最近 push `2026-09-30`；本地 HEAD 已全部推送到 `origin/master` |
| 11 | 语言 / 星数（站点自动抓） | ✅ | `language: JavaScript` · `stars: 1` |

---

## 一、🚧 阻塞项（不解决就别提交）

### B1. 打 `dsh-plugin` topic

站点靠这个 topic 找到插件；**没有它基本等于不会被收录**。API 已确认当前 topics 为空。

GitHub 仓库页 → 右上 ⚙️ (About) → **Topics** → 填 `dsh-plugin`，建议再加：
`deepseek-harness` · `dsh` · `artifact-library` · `file-manager` · `plugin`

> 注意：topic 只接受小写字母、数字、连字符。写 `DSH-Plugin` 无效。

### B2. 补 3 张真实截图

目录站会**自动抓取** `docs/screenshots/*.png` 渲染到详情页。
截什么 / 怎么截 / 命名与尺寸规范 → **[docs/screenshots/README.md](screenshots/README.md)**。

要交的三个文件（名字**逐字符**一致）：

```
docs/screenshots/01-directory.png   目录视图
docs/screenshots/02-search.png      文件搜索
docs/screenshots/03-cards.png       卡片视图
```

- 尺寸优先 **1941×1243**（宿主窗口实际分辨率），退而 **1440×900**，三张保持一致
- **必须在真实运行的 DSH GUI 里截**：本插件是宿主 UI 插件，`ui/index.html` 是兜底管理页，
  拿它截图与用户实际看到的面板**不一致**，属事实性错误
- ⚠️ 首页 README 的截图占位表（写着「待补」）在图片就位后要**同步改成真图**

### B3. 提交并推送这些文件

目录站与 GitHub 只认**已推送**的内容。当前未提交（`git status` 实测）：

```
 M README.md                    ← 本次重写
 M package.json                 ← 本次加 peerDependencies
 M lib/client.js                ← 队友 ui-core 的改动
?? docs/UI-SPEC-v1.md           ← 未跟踪！README 与上架材料都引用了它
?? docs/screenshots/README.md   ← 本次新增
?? docs/SUBMIT-CHECKLIST.md     ← 本文件
?? lib/icons.js                 ← 队友 icon-smith 的改动
?? test/ui-spec.test.mjs        ← 队友 ui-tester 的改动
```

```sh
git add -A
git commit -m "docs: prepare marketplace submission materials"
git push origin master
```

> ⚠️ **`docs/UI-SPEC-v1.md` 尤其别漏**：它此前从未进版本库，但 README、
> `docs/screenshots/README.md`、本清单都引用了它 —— 不推上去就是**死链**。

### B4. 推送后再验一次

目录站抓的是**推送后**的 README。推完隔几分钟，用无痕窗口访问仓库确认
README 渲染正常、截图能显示、Badge 不裂。

---

## 二、✅ `name` 三处一致性（已逐字节验证）

规范要求这三处**逐字节一致**，不一致会导致浏览器侧**半静默失效**（面板不出现、控制台无明显报错）。

| 位置 | 值 | 结果 |
|:---|:---|:--:|
| `package.json` → `name` | `@dsh-external/dsh-artifact-library` | ✅ |
| `cordis.patch.yml` → `insert.name` | `@dsh-external/dsh-artifact-library` | ✅ |
| `lib/client.js` → `ModuleLoader.load({ id })` | `@dsh-external/dsh-artifact-library` | ✅ |

复验命令（**提交前再跑一次**，因为 `lib/client.js` 仍在被改动）：

```powershell
$p = "C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-artifact-library"
$pj  = (Get-Content "$p\package.json" -Raw | ConvertFrom-Json).name
$yml = ((Get-Content "$p\cordis.patch.yml" | Where-Object { $_ -match "^\s*name:\s*" } |
        Select-Object -First 1) -replace "^\s*name:\s*","").Trim().Trim("'").Trim('"')
$cli = ((Get-Content "$p\lib\client.js" | Where-Object { $_ -match '^\s*id:\s*"@' } |
        Select-Object -First 1) -replace '^\s*id:\s*','').Trim().Trim(',').Trim('"')
"$pj | $yml | $cli"
"一致: $(($pj -ceq $yml) -and ($pj -ceq $cli))"
```

> 🧭 **别改错东西**：`cordis.patch.yml` 里还有一个 `id: artifact-library`
> （对应 `lib/index.js` 的 `export const name = 'artifact-library'`）。
> 那是 **Cordis 补丁行 id**，**不是**包名，**不要**把它改成带 scope 的形式。

---

## 三、✅ peer 版本下限（本次新增声明）

### 已做的改动

`package.json` **新增**（原有 `dependencies` 未改动）：

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "~4.0.4",
  "@deepseek-ai/dsh-home-paths": ">=0.2.0-rc.2",
  "@deepseek-ai/dsh-host-webserver": ">=0.2.0-rc.2",
  "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2"
}
```

### 依据（读宿主源码得来，非推测）

宿主 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()`：

- **只读 `peerDependencies`**，`dependencies` 不参与兼容性判定
  → 加之前，本插件的兼容性预检**完全不生效**（函数在字段缺失时直接 `return undefined`）
- **只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`** 两类名字
  → `@deepseek-ai/cordis` 不参与判定，写它只是**跟官方包保持一致**、并让宿主知道去哪里解析
- 判定用 `semver.satisfies(runtime, range, { includePrerelease: true })`
- 不满足 → 插件被判不兼容，需要 `dsh plugin allow-version` **显式放行**才能加载

**当前运行时版本 = `0.2.0-rc.2`**（`dsh-app-boot` / `dsh-tools` / `dsh-home-paths` /
`dsh-host-webserver` / 全部 `dsh-client-*` 包版本一致；`cordis` = `4.0.4`）。

### 为什么用 `>=` 而不是 caret

用真实 `semver` 实现（`semver@7.8.5`）实测，运行时 `0.2.0-rc.2`：

| 范围写法 | 是否通过 | 说明 |
|:---|:--:|:---|
| `>=0.2.0-rc.2` | ✅ | 本次采用 —— **纯下限**，不会反向排掉当前运行时 |
| `~0.2.0-rc.2` | ✅ | 但上界锁 `<0.3.0`，将来 DSH 升 minor 会被挡 |
| `^0.2.0-rc.2` | ✅ | 同上，0.x 的 caret 就是锁 minor |
| `^0.1.0-rc.6` | ✅ | 见下方 R1（**能过**，但语义是旧的） |
| `0.2.0-rc.2`（精确） | ✅ | 官方 `dsh-tools` 对同族包就是精确钉版 |

另外实测：`0.3.0` 满足 `>=0.2.0-rc.2`；`0.1.9` **不**满足 —— 下限语义正确。

---

## 四、⚠️ 本次核查发现的其他问题（不阻塞上架，但建议处理）

### R1. `dependencies` 的范围还是旧的 `^0.1.0-rc.6`

现状：`dependencies` 里三个 `@deepseek-ai/dsh-*` 仍是 `^0.1.0-rc.6`，
而运行时是 `0.2.0-rc.2` —— **声明范围覆盖不到实际运行的宿主**。

- 因为兼容性预检**不读 `dependencies`**，所以不会因此被禁用；插件目前能跑
- 但 `^0.1.0-rc.6` 在 npm 上会解析到 **`0.1.7-rc.2`**（比宿主旧的 minor）；
  若某次安装真的落下本地副本，就可能出现**宿主库版本错位**
- **建议**（需人工决策 + 重启验证，本次未擅改）：与 peer 声明对齐为 `>=0.2.0-rc.2`，
  或直接**移入 `peerDependencies`**（官方客户端包就是**只用 peerDependencies、不写 dependencies**）

> ⚠️ 改 `dependencies` 属于**安装期行为变更**，本会话无法重启验证，故**留作人工决策项**。

### R2. GitHub「About」描述是旧版

API 实测仓库描述：

> DSH 产物库：DeepSeek Harness 的产出/资料管理插件——自动采集 AI 产物、AI 精化整理、全文检索、项目总览，本地优先。

**完全没提 v0.7.0 的文件管理器**（这是当前最大的卖点）。建议改成与 `package.json.description`
一致（后者已包含「本地文件管理器 / 内置 Everything / 毫秒级搜索」）。
设备站详情页会展示仓库信息，描述过时会让页面显得陈旧。

同时 `homepage` 为空，建议填仓库地址或文档页。

### R3. 版本 tag 停在 `v0.4.1`

`package.json` 已到 `0.7.0`，但 git tag 最新只有 `v0.4.1` —— `v0.5.0 / v0.6.0 / v0.7.0` 都没打。
站点会显示「最后 push」，但版本 tag 关系到可信度与「仍在维护」的判断。建议补：

```sh
git tag -a v0.7.0 -m "v0.7.0 — 本地文件管理器（三层索引降级）"
git push origin v0.7.0
```

### R4. 客户端缺一行「启动自证」日志

`docs/UI-SPEC-v1.md` §8 的上架必要项要求：**启动日志打一行可自证**（如 `[artifact-library] client active`）。

- ✅ 宿主侧已有：`lib/index.js` → `ctx.logger.info('artifact-library: store at … (N records)')`
- ❌ 客户端侧**没有**：`lib/client.js` 里只有 `warn()` 包装，没有任何 info 级自证

**为什么需要**：浏览器侧出问题时（席位没注入、`ctx.get('slots')` 拿不到），
面板**不出现也不报错**。有一行自证日志，用户报障时能一眼区分「没加载」和「加载了但没注册上」。

> 🚫 **本次未改** —— `lib/client.js` 是队友 ui-core 的文件，写入范围不重叠。
> 建议由 lead 转给 ui-core 补一行 `console.info("[artifact-library] client active")`
> （注意：`apply` 全程 try/catch 的约束不能破）。

### R5. 别给 `package.json` 加错 `scripts.test`

`test/*.test.mjs` 是**自跑式脚本**（文件头写明 `用法：node test/xxx.test.mjs`），
**不是** `node:test` 用例 —— 加 `"test": "node --test test/"` 会跑不起来。

### R6. 备份文件已在 `.gitignore` 里 ✅

`_night-backup-*/`、`*.bak-*`、`vendor/everything/Everything-*.ini|.db` 都已被忽略，
`git ls-files` 确认未进版本库（因此 `github:` 安装也不会带上）。
无需处理，但**别手贱 `git add -f`**。

### R7. ✅ 「额外索引目录」死设置 —— **已修复**（保留作案例）

**原问题**（2026-09-30 白天发现）：`indexExtraDirs` 全库只出现 **1 次** ——
`lib/index.js` 老实读它，但 `ArtifactStore.getSettings()` / `updateSettings()` 的
白名单里**都没有这个键**，设置面板也没有入口 → **恒为 `[]`**，
「用户额外目录」这个能力**从来不存在**。

**现已修好**（`host-dev` task-8，同日）：

| 位置 | 现状 |
|:---|:---|
| `lib/settings.js:119` | 默认值收录 `indexExtraDirs: []` |
| `lib/settings.js:126` | 列入 `HOST_EFFECTIVE_KEYS` |
| `lib/settings.js:335-344` | 完整校验：数组 / ≤64 项 / 每项字符串 / **绝对路径** / 单条 ≤1024 字符 |
| `lib/index.js:57` | 从 `uiSettings` 读（不再读旧 `store.getSettings()`） |
| `lib/index.js:153-155` | **键变化时真的触发 `scheduleScopeRefresh()`** —— 不再是「存进去了但范围没变」 |
| `lib/client.js:844` | 设置面板有「额外索引目录」字段（每行一个绝对路径） |
| `GET /ext/artifacts/settings` | **实测返回** `"indexExtraDirs":[]` ✅ |

**因此已回滚我此前的文档改动**：README 的能力描述、隐私章节、配置表**重新写回**
「可指定额外目录」，并在 [已知限制](../README.md#limits) 里把它从「尚未接线」
改成「已接线」，同时**保留那段踩坑记录**（它现在是案例，不是缺陷）。

> 📌 **这正是本晚的教训本身**：「注释/文档过期就是坑」。
> 我的旧结论在我写下它几小时后就被队友修好了 ——
> **凡是「某文件没有某功能」这类结论，都必须带时间戳，并在交付前重验一次。**
> 本次交付前重跑了一次全库 grep 才发现；否则 README 会带着一句假话上架。

> 对比之下，其余设置项**都验证过是真的接线了**：
> `autoCollect`（`autocollect.js:55`）、`maxPerTurn`、`cleanupEnabled` /
> `cleanupIntervalDays`（`cleanup.js:66-68`）、`backupKeep`（`cleanup.js:70`）、
> `importMaxSizeMB`（`store.js:454`）、`searchLimit`（`http.js:133`）。

---

## 五、提交动作（按顺序）

```sh
# 1) 补齐 B2 的三张截图到 docs/screenshots/
# 2) 提交 + 推送
git add -A && git commit -m "docs: marketplace submission materials (README, screenshots spec, peer deps)" && git push origin master
# 3) 打 tag
git tag -a v0.7.0 -m "v0.7.0 — 本地文件管理器" && git push origin v0.7.0
# 4) 去 GitHub 设置里补 topic: dsh-plugin          ← 别忘，这是硬要求
# 5) 更新 About 描述 + homepage
# 6) 到 deepseek-harness-plugin.com/submit/ 提交：仓库地址 + 分类 UI Enhancements
```

### 提交后复验

- [ ] 无痕窗口打开仓库：README 渲染正常，**Badge 全部有图**（`Stars` badge 需要仓库公开，已确认公开）
- [ ] `docs/screenshots/` 里三张 png 能在 GitHub 上直接预览
- [ ] 仓库页 Topics 区能看到 `dsh-plugin`
- [ ] `git ls-files | Select-String "screenshots"` 能列出三张 png（确认真的推上去了）
- [ ] 站点详情页抓到的 License = MIT、Language = JavaScript、最后 push 时间已更新

---

## 六、本次交付物索引

| 文件 | 作用 |
|:---|:---|
| `README.md` | 重写为站点要求的九段结构，新增「已知限制」 |
| `package.json` | 新增 `peerDependencies`（下限 `>=0.2.0-rc.2`）；`keywords` 与 `name` 已核对通过 |
| `docs/screenshots/README.md` | 截图清单、命名规范、拍摄与自检步骤（**不含任何伪造图**） |
| `docs/SUBMIT-CHECKLIST.md` | 本文件 |
