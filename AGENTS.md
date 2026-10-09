# AGENTS.md · 产物库插件

> ## ⚠️ 开工第一件事：读 [`RULES.md`](RULES.md)
>
> **规则全在那里，这里不重复。** 不读就动手 = 违反规则。
>
> 下面只放三件"读 RULES.md 之前就该知道"的事。

---

## 一、这个仓库怎么记录

**代码是唯一的记录，`git log` 是唯一的变更记录。**

- **不写**描述"现状"的文档（架构说明、设计说明、状态报告、规范汇编）
- **不写** CHANGELOG / 进展日志 / ADR —— 一笔提交的信息里写清**根因**，那就是决策记录
- 唯一允许的第三方工具是 **codegraph**（`codegraph explore <问题>`）
- **不许**引入第二套记忆系统 / 知识库 / 向量库 —— 那会上下文污染

⇒ 想知道"为什么这么定"：**看代码和 `git log`**。

---

## 二、两条最容易违反的（完整版在 RULES.md）

**1. 改了 UI 可见输出（位置 / 尺寸 / 层级）⇒ 必须跑 `npm run render:verify`
或在真机上看，并说清是哪种。**
逻辑测试**在物理上看不见**布局 —— 本仓库三个 UI bug 全是在 **30 个测试文件全绿**时上线的。

**2. 不许把没验证的说成验证过的。报告里必须有「我没验证的」一节。**
（`RULES.md` §1.2 —— 比任何技术规则都重要。）

---

## 三、命令

```sh
npm test               # lint + 测试（提交前必须过）
npm run check          # 全门禁（lint + 测试 + 重复代码 + 过期陈述）
npm run render:verify  # 真 Chrome 量几何（**UI 布局改动必跑**）
npm run lint:prune     # 修好违规后，从棘轮基线里删掉它
node test/<某个>.test.mjs            # 单个测试
node test/tags.test.mjs "<真库目录>"  # 带真数据的测试（默认不跑）

codegraph explore <问题>   # 查代码结构和调用链
codegraph context <任务>   # 为任务取上下文
```

---

## 四、结构（改之前先知道）

| 路径 | 是什么 | ⚠️ |
|:--|:--|:--|
| `RULES.md` | **规则。唯一来源。** | 开工必读 |
| `lib/index.js` | 宿主侧入口（组装根） | **不热载，要重启 DSH** |
| `lib/client.js` | 客户端插件（**浏览器 bundle**） | **热载**；**顶层零 import**；9414 行，只许变小 |
| `lib/store.js` `tools.js` `http.js` `settings.js` | 应用层 | 依赖方向见 `RULES.md` §3 |
| `lib/categories.js` `tags.js` `project-merge.js` `tag-styles.js` | 领域层（叶子） | **只许 import node 内置** |
| `lib/index/` | 文件索引子系统 | 不许反向 import 上层 |
| `test/` | 30 个 `*.test.mjs` + `_strip-comments.mjs`（共享工具） | glob 必须写 `test/*.test.mjs` |
| `tools/` | 门禁脚本（`assert-ran` / `pre-commit` / `doc-stale` / `render-verify`） | |
| `ui/index.html` | **兜底管理页，不是主界面** | ⚠️ 拿它截图 = 事实性错误 |
| `scratch/` | 实验脚本 | 不进测试套件 |

---

## 五、提交

`<type>(<scope>): <做了什么 + 后果>`，**修 bug 要写根因**。
**必须有「⚠️ 没验证的」一节。**
**不许 `git add -A`**（共享工作区，会带走别人未提交的改动；pre-commit 钩子会拦）。
完整要求 → [`RULES.md`](RULES.md) §9。
