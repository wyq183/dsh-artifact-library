# 贡献指南 · Contributing

> 人看的入口。**AI agent 看 [AGENTS.md](AGENTS.md)**（那份更短、只讲最容易犯的错）。
> **完整规范在 [`docs/standards/`](docs/standards/README.md)。**

---

## 快速开始

```sh
git clone https://github.com/wyq183/dsh-artifact-library.git
cd dsh-artifact-library
npm install
node tools/install-hooks.mjs     # 装 pre-commit 钩子（⚠️ .git/hooks 不进版本控制，换机器要重跑）
npm test                         # 应该全绿
```

---

## 改代码之前

1. **读 [`docs/standards/01-flow.md`](docs/standards/01-flow.md)** —— 从想清楚到提交的七步
2. **按 [`docs/standards/02-evidence.md`](docs/standards/02-evidence.md) 选证据** ——
   改了 X 就必须跑 Y（**这是最常查的一篇**）
3. ⚠️ **如果改的是 UI** —— 先读那篇的 §三：
   **位置 / 层级 / 尺寸这三类，逻辑测试在物理上看不见**

---

## ⚠️ 这个项目最重要的三条

### 1. 「测试全绿」不等于「功能对了」

本仓库**连着三个 UI bug** 在 30 个测试文件全绿的状态下上线。
测试床是**假 React + 假 DOM** —— **没有布局引擎**。

⇒ UI 可见的改动，**必须**跑 `npm run render:verify` 或在真机上肉眼看过，
并**说清是哪种**。

### 2. 守卫必须**被验过会红**

> **"抓不到已知 bug 的守卫"比"没有守卫"更坏。**

每条新断言都要构造"已知有病的版本"跑一遍。三个方向：
正向（该红时红）/ 反向（错的但像对的不许绿）/
**第四向（新功能落地时它还绿吗）** ——
详见 [`docs/standards/03-assertions.md`](docs/standards/03-assertions.md)。

### 3. 报告里必须有「我没验证的」

区分**实测**和**推演**。这是本仓库最值钱的传统。

---

## 命令

| 命令 | 干什么 |
|:--|:--|
| `npm test` | lint + 全部测试 |
| `npm run check` | 全门禁（lint + 测试 + 重复代码） |
| `npm run render:verify` | **真 Chrome 量几何**（UI 布局改动必跑） |
| `npm run doc:stale` | 核文档里的过期数字 |
| `npm run dup` | 重复代码检测 |
| `npm run lint:prune` | 修好违规后从棘轮基线里删掉它 |
| `node test/x.test.mjs` | 单个测试 |
| `node test/tags.test.mjs <真库目录>` | 带真数据的测试（默认不跑） |

⚠️ **必须带 glob**：`node --test test/` 会 `MODULE_NOT_FOUND`，要写 `test/*.test.mjs`。

---

## 棘轮

`eslint-suppressions.json` 是**基线**（199 条历史违规）。规矩：

- ✅ **只许减** —— 修好一处就 `npm run lint:prune`
- ❌ **不许增** —— 新代码违规会被 lint 直接拦住
- ❌ **不许手工编辑基线文件让它过**

---

## 提交

```
<type>(<scope>): <做了什么 + 后果>
```

- **修 bug 的提交必须写根因**（具体到机制，不是"代码写错了"）
- **必须有「我没验证的」一节**
- ⚠️ **共享工作区禁用 `git add -A`**（会带走别人未提交的改动）——
  pre-commit 钩子会拦这个形态

完整要求 → [`docs/standards/07-commit.md`](docs/standards/07-commit.md)

---

## 结构

见 [AGENTS.md §这个仓库的结构](AGENTS.md)（含热载行为、`ui/index.html` 是兜底页这类坑）。

---

## 上架

要发到 `deepseek-harness-plugin.com` 看
[`docs/SUBMIT-CHECKLIST.md`](docs/SUBMIT-CHECKLIST.md)。
