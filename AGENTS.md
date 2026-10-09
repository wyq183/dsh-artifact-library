# AGENTS.md · 产物库插件

> **给 AI agent 的开工指引。** 人看的入口在 [CONTRIBUTING.md](CONTRIBUTING.md)，
> **完整规范在 [`docs/standards/`](docs/standards/README.md)** —— 这里只放**最容易犯的错**。

---

## 开工前

```sh
npm test              # lint + 全部测试（**必须先绿**，不绿别动手）
```

⚠️ **改 UI 之前先读** [`docs/standards/02-evidence.md`](docs/standards/02-evidence.md) ——
它告诉你**改了 X 就必须跑 Y**。

---

## ⚠️ 五条最容易犯的错（都真栽过）

### 1. 别把"测试全绿"当"功能对了"

本仓库**连着三个 UI bug** 在 **30 个测试文件全绿**的状态下上线
（层级 / 位置 / 尺寸）。原因：测试床是**假 React + 假 DOM** ——
**它没有布局引擎，连 `getBoundingClientRect` 都不存在**。

⇒ **改了 UI 可见的东西（位置/尺寸/层级），必须跑 `npm run render:verify`
或者在真机上看** —— 并**说清是哪种**。

### 2. 别写"抓不到已知 bug"的守卫

**空转的守卫比没有守卫更坏** —— 没有你会警惕，空转的让你以为安全。

⇒ 每条新断言，**先构造一个"已知有病的版本"跑一遍，确认它会红**。
三个方向都要验（正向 / 反向 / **第四向：新功能落地时它还绿吗**）→
[`docs/standards/03-assertions.md`](docs/standards/03-assertions.md)。

### 3. 别把"没验的"说成"验了"

**报告里必须有「我没验证的」一节。** 区分**实测**和**推演**，
区分**逻辑测试证据**和**真机证据**。

⚠️ 这是本仓库**最值钱的传统**，也是唯一不能靠工具补的东西。

### 4. 别在共享工作区用 `git add -A`

多个 agent 共享这个工作区。`git add -A` 会**带走别人尚未提交的改动** ——
真实事故：`git log -S <符号>` 只命中一笔讲文档的提交，
**"为什么会有那段代码"永远查不到**。

⇒ 用 `git add <你自己的路径>`。**已装 pre-commit 钩子会拦这个形态。**

### 5. 别引用不存在的命令 / 过期的数字

⚠️ **文档里的命令会被照着执行。** 本仓库栽过两次：
`SUBMIT-CHECKLIST` 一边禁 `git add -A`、一边在教它；
`docs/standards` 第一版引用了三个不存在的 npm script。

⇒ 写完跑一遍。数字类主张用 `npm run doc:stale` 核。

---

## 这个仓库的结构（改之前先知道）

| 路径 | 是什么 | ⚠️ |
|:--|:--|:--|
| `lib/index.js` | 宿主侧入口 | **不热载，要重启 DSH** |
| `lib/client.js` | 客户端插件（**浏览器 bundle**） | **热载**；**零 `import`**，模块级组件要 `var React = require("react")` |
| `lib/store.js` | 记录存储 / 落盘 / 撤销凭据 | |
| `lib/tools.js` | agent 工具注册 | |
| `lib/platform.js` | 跨平台（reveal / open / 路径） | **不热载** |
| `lib/index/` | 文件索引层 | |
| `test/` | 30 个 `*.test.mjs` + `_strip-comments.mjs`（共享工具） | ⚠️ glob 必须写 `test/*.test.mjs` |
| `tools/` | 门禁脚本（`render-verify` / `pre-commit` / `doc-stale`） | |
| `ui/index.html` | **兜底管理页，不是主界面** | ⚠️ 拿它截图 = 事实性错误 |
| `docs/standards/` | **开发规范** | 改代码前读它 |
| `scratch/` | 实验脚本 | 不进测试套件 |

---

## 命令

```sh
npm test               # lint + 全部测试
npm run check          # 全门禁（lint + 测试 + 重复代码）
npm run render:verify  # 真 Chrome 量几何（**UI 布局改动必跑**）
npm run doc:stale      # 核文档里的过期数字
npm run dup            # 重复代码检测
npm run lint:prune     # 修好一处违规后，把它从棘轮基线里删掉
node test/<某个>.test.mjs   # 单个测试
node tools/install-hooks.mjs  # 装 pre-commit 钩子（换机器后要重跑）
```

---

## 棘轮（`eslint-suppressions.json`）

现有 199 条违规在基线里豁免。**只许减不许增。**
- ✅ 修好一处 → `npm run lint:prune`
- ❌ **不许手工编辑基线文件让它过**

---

## 提交

格式 `type(scope): 做了什么 + 后果`，**修 bug 要写根因**。
完整要求 → [`docs/standards/07-commit.md`](docs/standards/07-commit.md)。
