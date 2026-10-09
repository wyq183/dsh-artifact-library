# 04 · 测试

> 核心一句话（来自 `testing-tiers`）：
> **tests must exercise the real entry path and verify the world, not the component's self-report.**
> **A mock-heavy unit suite can be 100% green while the shipped behavior is broken** ——
> 这正是本仓库踩过的那个坑。

---

## 一、本仓库的测试床，以及它**看不见**什么

**先认清工具，再谈怎么用。** 本仓库有两套测试床，能力完全不同：

| 测试床 | 是什么 | **能验** | **看不见** |
|:--|:--|:--|:--|
| **假 React**（`client-render.test.mjs` 等） | 手写的 `React.createElement` 桩 + 假 DOM 节点 | 渲染树形状、hook 顺序与槽位、props 传递、纯函数 | ⚠️ **布局（位置/尺寸/层级）** —— 假 DOM **没有布局引擎**，连 `getBoundingClientRect` 都不存在 |
| **真 Chrome**（`scratch/render-verify/`） | 真 CSS + 真结构 → headless Chrome → `getBoundingClientRect` | **几何**：被裁、越界、尺寸 | 需要浏览器；不含事件路径 |

⚠️ **假 DOM 里没有的东西**（写测试时先想清楚）：
`getBoundingClientRect` · `getComputedStyle` · 合成层 · 真实事件传播路径 · z-index 生效 · OS 覆盖层。

⇒ **"30 个测试文件全绿"是结构性必然，不是质量信号。**
本仓库连着三个 UI bug 就是这么上线的。

---

## 二、选哪一层（按"最浅的、真的会因它失败的那层"）

| 层 | 能证明 | 什么时候用 |
|:--|:--|:--|
| **单元** | 一个函数按契约工作 | 行为局限在一个模块内 |
| **集成** | 几个模块协同 | 共享契约或接线变了 |
| **真入口路径** ⭐ | **发布出去的那个入口真的能跑** | 产品可见的插件/入口/组合变了 |
| **端到端** | 装配好的系统对着真实外部边界能跑 | 触及 provider / 网络 / 跨系统 |
| **快照** | 外部契约/呈现输出稳定 | 模型可见、协议可见、人可见的输出变了 |

⭐ **"真入口路径"这一层是本仓库最缺的。**
`testing-tiers` 原话：
> **A hand-built harness that calls the component directly proves plumbing,
> not that the shipped entry works.**

本仓库的 `test/client-apply.test.mjs` **就是在补这一层**
（它走真模块工厂 → `apply(ctx)` → 真注册路径，而不是直接调组件）。

⚠️ **两个陷阱**（原话）：
- **"守卫只有在回归真的会让它失败时才叫守卫。"**
  插件没有注入时，一个 loader 冒烟测试**可以在"默认导出替换了必需具名导出"时照样绿** ——
  ⇒ **加一条显式断言"非法形态不存在"，并证明它**：引入回归 → 看它变红 → 撤回。
- **"真入口路径"指的是发布出去的产物**，不是源码模式的垫片。

---

## 三、⭐ 本仓库的三条硬规矩

### 1. 断言要验「世界」，不是「组件的自述」

> An e2e assertion re-runs the command or re-reads the file **externally**;
> asserting on the component's own output lets a **cheating component** pass.

**具体到本仓库**：
- 验"文件写进去了" → **重新读一遍那个文件**，别信函数返回值；
- 验"没动别的文件" → **断言它们逐字节相同**；
- 验"HTTP 返回了" → **真发一次请求**，别调内部函数。

### 2. 只在**昂贵或不确定**的边界上 mock

> Mock only the expensive or non-deterministic boundary — an external API,
> the network, the clock. **Keep everything downstream real.**

⚠️ 本仓库的反面教材：**假 React 把"下游"也 mock 掉了** ⇒ 布局整个消失。
⇒ **能真的就真的**：真 CSS、真 Chrome、真文件系统（临时目录）、真 HTTP。

### 3. 测试自己管资源

**在测试里创建 harness，在 teardown 里销毁 —— 即使失败或重试也要销毁。**

⚠️ 本仓库踩过：`defersave-persistence.test.mjs` **每跑一次全套就漏一个临时目录**
（实测 184 → 185）。
⇒ 已修：**失败时保留目录当证据，成功时才删**（这是有意的取舍，写在注释里）。

---

## 四、覆盖率的正确用法

> **Coverage is necessary, never sufficient.**
> Line coverage proves lines ran, not that the feature works as shipped.

- ⚠️ 本仓库有大量**静态扫描源码**的测试（`ui-spec` / `overlay-escape`）——
  它们**跑起来几乎不"覆盖"产品代码**（只是读文本），所以**覆盖率口径会失真**。
- ⇒ **别把覆盖率当门禁。** 要看的指标是：
  **"这条回归会不会让某个测试失败？"**（这需要反向 bite-test，见 [03-assertions.md](03-assertions.md)）
- 未覆盖的行**常常是死代码** —— **删掉**，而不是硬补一个测试。

---

## 五、测试描述的是**行为**，不是**正确性**

> Tests pin behavior. When behavior intentionally changes, the tests change with it —
> **do not preserve a "correct" test for obsolete behavior.**

⚠️ **但小心**：这条**不是**"改测试让它过"的许可证。
判断标准是：**这个行为变更是有意的吗？**
- 有意 → 测试跟着改，**并在提交信息里解释行为变更**；
- 无意 → **那是 bug**，改实现。

⚠️ 本仓库的坑：`H15` / `K13` 断言的是 `ok === false` ——
**把当时那个 bug 的行为钉成了期望**。修 bug 时它们立刻红了。
⇒ 正解是**保留意图、换掉形状**，不是删掉它。

---

## 六、`[清单]` 写测试时逐条过

- [ ] **我这次要验的东西，这个测试床里有吗？** 没有 → 换测试床或换验证方式
- [ ] **产品可见的改动**，有**真入口路径**的测试吗？（不是手搭 harness 直接调组件）
- [ ] **断言验的是外部状态**（重跑/重读），不是组件自述吗？
- [ ] **mock 只在昂贵/不确定的边界**上吗？下游是真的吗？
- [ ] **资源在 teardown 里销毁**了吗（含失败路径）？
- [ ] **测试文件从共享工具里 import**，而不是**抄一份**？
      （本仓库的病：同一个 helper 被抄了 5 份、3 份带着同一个 bug）
- [ ] 如果我改了**共享测试工具**：**跑了全套**吗？（它是别人的输入）

---

## 七、共享测试工具的放置规矩

⚠️ **本仓库的现状**：`test/_strip-comments.mjs` **刻意不叫 `*.test.mjs`** ——
所以 `node --test test/*.test.mjs` **天然不会**把它当测试跑。**这个命名是有意的。**

**规矩**：
- 共享工具放 `test/` 下、**用 `_` 开头且不带 `.test.`**
  （⚠️ 用 `test/helpers/` 目录更好，但**必须确认 glob 不会匹配到它** ——
  当前 glob 是 `test/*.test.mjs`，只匹配**一层**且必须带 `.test.`，所以两层目录天然安全）；
- **不许把工具函数抄进各个测试文件** —— 抄一份就是一份会漂移的知识；
- 改了共享工具 ⇒ **跑全套**（见 [02-evidence.md](02-evidence.md)）。

⚠️ **注意 `node --test` 的 glob 陷阱**：必须写 `test/*.test.mjs`。
`node --test test/` 会 `MODULE_NOT_FOUND`（本仓库踩过）。

---

## 八、相关

- **怎么写断言**（本仓库最重要） → [03-assertions.md](03-assertions.md)
- **这次改动该跑什么** → [02-evidence.md](02-evidence.md)
- **测试的完整纪律与反例** → `docs/ARCHITECTURE.md` §8.1 / §8.2 / §8.3
