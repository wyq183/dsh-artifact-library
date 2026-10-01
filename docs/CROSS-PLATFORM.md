# 跨平台适配（Windows + Linux）· 2026-10-01

> 起点：插件原来是 **Windows 专用** —— `process.platform` 判断 **0 处**，
> 硬编码 `C:\` **126 处**，`spawn('explorer.exe', …)` **2 处**。
> 终点：**Windows 与 Linux 都完整可用**，同一个包、同一套接口、同一套查询语法。
> **macOS 明确不在本次范围内**（依琪 2026-10-01 拍板：先只适配 Linux + Windows）。

---

## 一、先修掉的三件「会真出事」的事

### 1. ★★★ 非 Windows 上点一下「定位」会**打崩整个 dsh web**

`lib/http.js` 原来直接 `spawn('explorer.exe', …)` 且**没有挂 `'error'` 监听**。
Node 里未处理的 `'error'` 事件**不是异常，是进程级 abort** —— `try/catch` 抓不到。

实测复现（Linux，Node 22）：

```
$ node -e "const{spawn}=require('child_process');const c=spawn('explorer.exe',['/select,/tmp'],{detached:true,stdio:'ignore'});c.unref()"
Error: spawn explorer.exe ENOENT
Node.js v22.23.3
$ echo $?
1
```

也就是说：**Linux 上用户点一次「在文件管理器中定位」，整个 DSH 就退了。**
不是功能不可用，是宿主没了。

**修法**：所有外部启动一律走 `lib/platform.js`，那里只有两个出口
（`spawnSoft` / `runOnce`），两个都**强制挂 `'error'`**、永不抛。
`test/platform-port.test.mjs` 用**子进程对照实验**把这条钉死：
同样的写法「不挂监听 = 进程死 / 挂监听 = 活着」。

### 2. ★★ 安全护栏在 POSIX 上**完全空转**

`lib/store.js` 的导入根判据整段建立在盘符上：

```js
const isDrive = /^[a-z]:$/i.test(parts[0])   // POSIX 路径永远不是盘符
if (isDrive && PROTECTED_TOPLEVEL_NAMES.has(toplevel)) { ...拒绝... }
```

后果（实测）：`checkImportRoot('/etc')`、`'/usr'`、`'/'`、`'/System'` **全部返回 ok:true**
—— 在 Linux 上可以**把 `/etc` 整批导进产物库**。

**修法**：判据从「当前操作系统」改成「**路径形态**」（盘符形态 / POSIX 绝对形态），
于是同一份代码两边都对，顺带也保住了跨平台迁移过来的 `C:\…` 老记录。
新增 POSIX 系统目录名单与 `/home/<你>`（`/Users/<你>`）整份拒绝。
同时**修了校验顺序**：敏感判定必须**先于**存在性检查 ——
否则敏感根一旦「路径不存在」，就会被当成普通错误放过去（这条在 Linux 上就是这么暴露的）。

### 3. ★★ 客户端恒用反斜杠拼路径

```js
return base + "\\" + rel;   // lib/client.js
```

于是 Linux 上 `/home/yiqi/proj` + `src/a.md` → `/home/yiqi/proj\src/a.md`。
面包屑、相对路径导航、缩略图 URL、@ 引用会**挨个坏**。
另外 `isLocalPath` 只认盘符 → Linux 上**永远返回 false**，目录项的「N 项」永远算不出来
（静默失效，不报错）。

**修法**：抽出 `isWindowsPath()` / `sepFor()`，全部按**形态**分派；
`isLocalPath` 补 POSIX 绝对路径（UNC 网络盘仍判否）；
`parentOf('/home')` 原来返回空串（等于「没有上级」，面包屑卡住），现在返回 `/`。

---

## 二、文件索引：为什么是「纯 Node 自建」而不是找个 Everything 替身

调研过一圈，候选都被硬条件否掉了：

| 候选 | 否掉的硬理由 |
|:---|:---|
| `plocate` / `locate` | **只有路径字符串**（无大小/时间/类型）；库由 root 定时重建、可能过期几小时；GPL **不能随包分发** |
| `fd` | 默认不装（Debian 里还叫 `fdfind`）；没有元数据 |
| `inotifywait` | 是事件源不是查询索引；**WSL 的 `/mnt/c` 上根本不工作** |
| `tracker`（GNOME） | 重依赖、需要 D-Bus/portal、无头环境常没有 |
| `mdfind`（Spotlight） | 只有 macOS；可能被关；而且**它索引全盘** —— 与「范围白名单」的隐私契约冲突 |

关键判断：**本插件的隐私契约已经把问题缩小了** ——
范围是「DSH 工作区 + 已登记产出目录」，有 `SCOPE_ITEM_LIMIT` 与噪音剪枝封顶。
这个尺度下**不需要 Everything 的 MFT 级速度**，需要的是
「不依赖用户装了什么、跨平台行为一致、隐私边界不放宽」。

### 分层

```
lib/index/engine.js          ← 门面：按平台选后端（Everything 实现**原样留在这个文件里**）
  ├─ Everything 后端         Windows，vendor/everything/，行为与改造前完全一致
  └─ backend-node.js         Linux，纯 Node 范围索引
       ├─ walk.js            异步、有界、平台中立的范围扫描器
       ├─ query.js           Everything 语法的查询编译器（纯函数）
       └─ list.js            （既有）实时目录列举，本来就跨平台
```

**两个后端对外逐字段一致**：`status / ensureReady / cancel / search / listDir /
updateScope / shutdown / snapshot`，连快照里那组客户端契约字段
（`phase/ready/now/elapsedMs/stalled/stallHintMs/cancellable/hint`）都同名同义。
所以 `lib/http.js`、`lib/index.js`、`lib/index/tool.js` **一行都没改** ——
平台差异止步于门面，这是刻意约束。

> ⚠️ Everything 实现**没有**被搬去别的文件，原因不只是少改少错：
> `test/perf-guards.test.mjs` 有一组**按函数名切片**的源码守卫
> （`async function waitReady` … `async function shutdown`），搬走等于把守卫一起废掉。
> 顺带一条教训：那组守卫用的是裸 `indexOf`，**连注释里都不能出现锚点原文**
> —— 本次就踩了一次（头注释里写了函数名，守卫切出一段废片报红）。

### 查询语义不下沉到后端

`query.js` 把 Everything 语法编译成谓词，由纯 JS 对内存行集求值：

```
空格 AND · `|` OR · `!` NOT · "带空格" · ext: · name: · path: · folder: · type:
size:>10mb · size:1kb..1mb · dm:today/week/month/YYYY-MM-DD/>… · dc: · * ?
```

好处是**用户和模型不用换脑子**：`search_files` 的描述、README、肌肉记忆全不用改。

> 第一版把 `|` 的备选和同组其他词一起按 AND 拼了，于是 `ext:md|ext:pdf`
> 要求「既是 md 又是 pdf」→ 恒为 0 条。**自测当场抓到**，已修并加了断言。

### 三个「不是优化，是必需」的细节

1. **`indexDir` 在 Linux 上会落进索引范围**（自引用）
   原来只认 `LOCALAPPDATA || XDG_CACHE_HOME`，而 Linux 服务/非登录会话里
   `XDG_CACHE_HOME` 经常是空的（本机实测**两个都为空**）→ 直接落到
   `~/.dsh/artifact-library/index` —— 正是源码注释警告过的「库写进被索引目录」。
   现在统一走 `platform.userCacheRoot()`（Windows 仍是 `%LOCALAPPDATA%`，老用户不用迁移）。

2. **目录浏览永远实时读盘**
   内存索引是**快照**；如果目录浏览也吃它，就会重演 `list.js` 当初解决的
   「agent 刚生成的文件在目录视图里看不见」。所以 `listDir` 直连 `listDirectory`，
   搜索才走索引 —— 与 Windows 侧完全同构。

3. **变更监听只做失效标记**
   `fs.watch(recursive)` 成功就置 `dirty`，下次搜索后台重建；探测失败（例如 WSL 的
   `/mnt/*`、网络盘）就**如实退化为 TTL**，不假装有监听。

---

## 三、UI：把「看着像两套」的东西合成一套

依琪原话：

> 「**按钮太多，怎么卡片跟列表还有单独宽高大小设置的，我都以为是一起的，
> 不简洁不直观**；顺手你可以参考对应平台的文件管理的快捷操作模式」

在真机截图里，这两句都能对上号：

| 问题 | 证据 |
|:---|:---|
| 视图切换器**有两份** | 顶部 `VIEWS`（卡片/列表/画廊/文件/目录/整理）与 `ViewControl` 内部那份都在改 `filters.view` —— 屏幕上是两个一模一样的分段控件 |
| 尺寸**有两个下拉且总在显示** | `标准`（行高密度）与 `尺寸 中`（卡片尺寸）并排，**在列表视图里也显示卡片尺寸**，反之亦然 |

改动（都在 `lib/client.js` 的 `ViewControl`）：

- **视图类型只留一个入口**：产物侧顶部的完整切换器已经是它了，`ViewControl` 传
  `showViews: false` 不再重复渲染。
- **尺寸合并成一个控件**，含义跟着当前视图走：列表 → 「行高 紧凑/标准/宽松」，
  卡片/画廊 → 「尺寸 小/中/大」。
- **列设置只在列表视图出现**（卡片/画廊里它没有任何意义，纯噪音）。

效果（真机截图对比，同一行工具栏）：

```
改前：[卡片 列表 画廊] [标准▾] [尺寸 中▾] [列（3）] [导入文件夹] [关键词 语义] [本会话] [回收站]
改后：[行高 标准▾]      [列（3）] [导入文件夹] [关键词 语义] [本会话] [回收站]
```

### 补齐原生文件管理器的肌肉记忆

| 快捷键 | 行为 | 依据 |
|:---|:---|:---|
| **双击** | 进入目录 / 打开文件 | 资源管理器 · 访达 · GNOME 文件都是 |
| **Backspace** | 回上一级 | 同上 |
| **Alt+↑ / Alt+←** | 回上一级 | 同上 |
| **F5 / Ctrl+R** | 刷新 | 同上 |
| **Ctrl + 滚轮** | 缩放（列表改行高、卡片改尺寸） | Nautilus 缩放滑杆 / 访达图标大小 / VS Code 字号 |

**单击语义也改回原生**：原来**单击就进目录**（网页习惯）——
结果是「想看看这个文件夹里几项」做不到（一点就被带走），「想多选几个文件夹」也做不到。
现在**单击选中、双击进入**。

⚠️ 两条必须守住的边界（缺一条就从「顺手」变成「抢键」）：

- **焦点在输入框/下拉里时一律不管** —— 否则在路径框里按 Backspace 删字会把目录翻上一级。
- **面板不可见时一律不管** —— 宿主的 Backspace/F5 不能被吃掉。

这两条都有真机断言（见下）。

---

## 四、验证证据（都是真跑出来的，不是"应该没问题"）

### 1. 离线测试

`node test/*.test.mjs` → **17 个文件 555 项全绿**（改造前 499 项，本次新增 56 项）。

新增 `test/platform-port.test.mjs` 覆盖：路径形态语义 · 安全护栏两套判据 ·
**启动失败不打崩宿主（子进程对照）** · Linux 启动器回退链（用 PATH 桩，不弹窗）·
查询编译器 · 便携后端端到端 · 后端分流 · http 定位/打开的成功与失败分支
（原来**成功分支零覆盖**，注释里自认「只测拒绝分支，成功会真启动 explorer」）。

### 2. Linux 真机（独立实例，端口 3141，**不碰 3080 那个**）

```
GET  /ext/artifacts/files/status   → backend=node  mode=nodefs  ready=true  items=3
                                      scope=['/home/yiqi/alf-demo/作品']
GET  /ext/artifacts/files?q=ext:md → total=2  第一章.md, 正文.md
GET  /ext/artifacts/files?q=folder: → total=1  第三章
POST /files/reveal (范围内)         → ok=true  method="xdg-open(目录)"
POST /files/reveal (范围外)         → HTTP 403
```

范围恰好是「已登记产出所在目录」，**兄弟目录 `资料/` 没被纳进来** —— 隐私边界成立。

### 3. 无头浏览器（Playwright + 项目内 Chromium）

`verify-shortcuts.py` → **7/7**：双击进子目录 · Backspace 回上级 · Alt+↑ 回上级 ·
Ctrl+滚轮缩放 · 输入框内 Backspace 只删字不翻目录 · 行上有焦点时 Backspace 仍回上级。

顺带一个连带确认：目录行显示 `第三章 **1 项**` —— 这个「N 项」在 Linux 上原来永远算不出来
（`isLocalPath` 只认盘符），现在有了。

---

## 五、明说没做的部分

| 事项 | 状态 |
|:---|:---|
| **macOS** | 依琪拍板砍掉。代码里 `open -R` / `~/Library/Caches` / APFS 大小写都有分支，但**没有真机证据** —— 别当成已支持 |
| **跨平台数据迁移** | `artifacts.json` 里 `path` 是**绝对路径且当主键**，`load()` 不做路径重映射。把 Windows 的库搬到 Linux，那些 `C:\…` 记录会全部失效。现在至少**不会**把索引范围退化成 `.`（`dirsFromArtifacts` 已改形态感知），但库本身要另做重映射 |
| **`vendor/everything/` 的死重** | 5.26 MB 的 Windows 二进制，非 Windows 用户白拿体积。要不要按平台裁剪分发是**产品决定** |
| **`lib/index/selftest.js`** | 它整个是 Everything 专用（拉起 `es.exe`、写 ini、用 `C:\Users\Administrator\...`）。已加**显式早退**（非 Windows 直接退出并指向该跑的测试），免得产生一堆假红 |
| **面板仍是两行工具栏** | 在「文件 / 目录 / 整理」这些视图下，上面那两行**产物筛选器**（搜索框/状态/项目/关键词/本会话/回收站）其实是无关的。收起它们能把三行压成一行 —— **属于设计决定，等拍板** |

---

## 六、被这次改造顺手证实/证伪的旧记录

| 旧说法 | 实测 |
|:---|:---|
| `isInside('/home/A/x','/home/a')` 为 true（测绘报告） | ✅ 属实，**会放宽越界闸门** → 已修 |
| `normalizeScope(['C:\a','C:\a\b'])` 返回 `[]` | ✅ 属实（Windows 形态路径被整段丢弃）→ 已修 |
| `dirsFromArtifacts` 在 Linux 上把目录变成 `'.'` | ✅ 属实（`path.dirname('C:\a\b.txt')==='.'`）→ 已修 |
| 「32 个 commit」/「33 个 commit」（历史记忆） | ⚠️ 已过期，实测 **64 个** |
| README「仅 Windows，其他平台优雅降级」 | ❌ 已过期 → 已更新 |
