# 贡献指南

> **规则全在 [`RULES.md`](RULES.md)。** 这份文件不重复它。

---

## 快速开始

```sh
git clone git@github.com:wyq183/dsh-artifact-library.git
cd dsh-artifact-library
npm install
node tools/install-hooks.mjs   # 装 pre-commit 钩子（.git/hooks 不进版本控制，换机器要重跑）
npm test                       # 应该全绿
```

---

## 动手之前

**读 [`RULES.md`](RULES.md)。** 尤其：

- **§2 抽象层先行** —— 结构性改动 / UI 可见改动，**先交抽象层设计，确认后再写实现**
- **§3 分层与依赖方向** —— 关注点分离、依赖倒置；依赖只能从上往下，不能成环
- **§6.2** —— 改了 UI 布局 ⇒ **必须**跑 `npm run render:verify` 或真机看
- **§1.2** —— 不许把没验证的说成验证过的

---

## 这个项目怎么记录

**代码是唯一的记录，`git log` 是唯一的变更记录。**

- 不写描述"现状"的文档 —— 现状会变，文档不会
- 不写 CHANGELOG —— 一笔提交的信息里写清**根因**，那就是记录
- 想知道"为什么这么定"：看代码和 `git log`

---

## 命令

| 命令 | 干什么 |
|:--|:--|
| `npm test` | lint + 测试 |
| `npm run check` | 全门禁（lint + 测试 + 重复代码 + 过期陈述） |
| `npm run render:verify` | **真 Chrome 量几何**（UI 布局改动必跑） |
| `npm run lint:prune` | 修好违规后从棘轮基线里删掉它 |
| `node test/x.test.mjs` | 单个测试 |
| `node test/tags.test.mjs <真库目录>` | 带真数据的测试（默认不跑） |

⚠️ **必须带 glob**：`node --test test/` 会 `MODULE_NOT_FOUND`，要写 `test/*.test.mjs`。
（也别写裸的 `node --test` —— 它会扫到 `test/` 下一切。见 `RULES.md` §6.6。）

---

## 提交

```
<type>(<scope>): <做了什么 + 后果>
```

- **修 bug 必须写根因**（具体到机制，不是"代码写错了"）
- **必须有「⚠️ 没验证的」一节**
- ⚠️ **不许 `git add -A`**（共享工作区会带走别人未提交的改动）

完整要求 → [`RULES.md`](RULES.md) §9

---

## 上架

要发到 `deepseek-harness-plugin.com` 看 [`docs/SUBMIT-CHECKLIST.md`](docs/SUBMIT-CHECKLIST.md)。
