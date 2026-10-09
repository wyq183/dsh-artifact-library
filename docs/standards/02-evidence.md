# 02 · 变更 → 证据映射

> **这是本目录最常查的一篇。**
> 目的：**按你改了什么，选出最小的、真的能抓住回归的证据** —— 不是每次无脑跑全套。

---

## 为什么不能"无脑跑全套"

两个原因，都踩过：

1. **全套绿 ≠ 你改的东西被验了。** 本仓库连着三个 UI bug 在
   **30 个测试文件全绿**的状态下上线 —— 因为那些测试**在物理上看不见**布局。
2. **无脑跑全套会让你忽略"这次该补哪条证据"。** 全套是**兜底**，不是**答案**。

⇒ 规则：**先按下面的表选，选不出再跑全套。**

---

## 一、按「你改了哪个文件」查

| 改了 | 必须跑（最小集） | 为什么 |
|:--|:--|:--|
| **`lib/client.js` 的 CSS / 布局 / 尺寸** | `npm run test:unit` ＋ **`npm run render:verify`** | ⚠️ **逻辑测试看不见布局**。`render:verify` 用真 Chrome 量几何 —— 唯一能抓"控件被裁"的东西 |
| `lib/client.js` 的渲染 / 组件结构 | `node test/client-render.test.mjs` | 它喂**假 React**，能抓渲染树形状、hook 顺序 |
| `lib/client.js` 的键盘 / 浮层 / 事件 | `node test/overlay-escape.test.mjs` | 真派发事件（自己实现 capture→bubble） |
| `lib/client.js` 的 UI 规范（字号/颜色/token） | `node test/ui-spec.test.mjs` | 它有编号条款门禁（R-9 等） |
| `lib/client.js` 的标签芯片 / 样式 | `node test/tag-chip.test.mjs` ＋ `tag-styles` | |
| `lib/client.js` 的 CSS 注入 | `node test/css-hotload.test.mjs` | 抓"改了不生效" |
| **`lib/store.js`**（记录/落盘/撤销） | `node test/tags.test.mjs` ＋ `persist-fail` ＋ `noop-semantics` | 落盘失败与撤销凭据是**有故事**的地方 |
| `lib/tools.js`（agent 工具） | `node test/tools-agent.test.mjs` | 工具数、schema、转达 warning |
| `lib/settings.js` | `node test/settings.test.mjs` ＋ `managed-tags` | |
| `lib/platform.js`（reveal/open/路径） | `node test/platform-port.test.mjs` | ⚠️ **宿主侧，不热载，要重启才生效** |
| `lib/http.js`（端点） | `node test/http-contract.test.mjs` ＋ `http-files` ＋ `csrf-guard` | |
| `lib/tags.js` / `categories.js` / `project-merge.js` | 对应的 `*.test.mjs` | |
| **`test/_strip-comments.mjs`**（共享工具） | `node test/strip-comments.test.mjs` ＋ **所有 import 它的测试** | ⚠️ 它是**多个文件的输入预处理** —— 它坏 = 一片静默假绿 |
| **`eslint.config.mjs` / `eslint-suppressions.json`** | `npm run lint` | ⚠️ 棘轮基线**只许减不许增** |
| 只有 `docs/**` / `README.md` | `npm run lint` 就够 | 文档不跑测试 |
| `package.json` 的 scripts / 依赖 | `npm test`（全套） | 影响所有人 |

⚠️ **改了共享工具（`test/_strip-comments.mjs` 这类）要跑全套** —— 它是别人的输入。

---

## 二、按「这次改动的性质」查（比文件更准）

| 性质 | 证据 | 备注 |
|:--|:--|:--|
| **纯逻辑**（一个模块内部） | 那个模块的测试 | 最便宜 |
| **共享契约**（两个模块之间的接口） | 两端各自的测试 ＋ 契约测试 | |
| **UI 可见输出** | 渲染树测试 **＋ 真机/真浏览器** | ⚠️ 缺一不可，见下 |
| **落盘 / 持久化** | 那条路径的测试 ＋ **失败路径** | 别只测成功路径 |
| **跨平台**（路径 / 进程 / 编码） | `platform-port` ＋ `CROSS-PLATFORM.md` 的清单 | |
| **安全边界**（路径范围 / CSRF） | `scope-guards` ＋ `csrf-guard` | |

---

## 三、⚠️ 三类"必须额外加真机/真浏览器"的改动

**这三类，逻辑测试一律看不见。** 不是"测试写得不够好"，是**测试床里没有那个东西**：

| 类别 | 为什么逻辑测试看不见 | 该用什么 |
|:--|:--|:--|
| **位置**（元素放哪、会不会被挡） | 假 DOM 没有布局 | 真机看 / `render:verify` 量盒子 |
| **层级**（谁盖谁、z-index、事件阶段） | 假 DOM 没有合成层、没有真实事件路径 | 真 Chrome 派发事件（`scratch/escape-propagation/` 那套） |
| **尺寸**（被容器裁、flex 压缩） | 假 DOM 没有布局引擎 | `npm run render:verify`（**它已被反向对照验过**） |

⚠️ **"窗口控制按钮挡住 ×" 这一类机器抓不到** —— 它是 **OS 画的覆盖层**
（DSH 的 `titleBarOverlay`，**不是 DOM**、**CDP 截图也拍不到**）。
⇒ 只能靠「**设计上避开 + 守卫钉住别放回去**」（见 `test/overlay-escape.test.mjs` 的 `C4d`）。

---

## 四、全套什么时候跑

**只有这四种情况**跑全套：

1. 改的东西**跨了很多模块**（比如重构一个到处被 import 的 helper）；
2. 改了 `test/` 下的**共享工具**；
3. **CI 上**（CI 的职责就是兜底）；
4. **诊断一个 CI 失败**时。

⚠️ **别因为"要提交了"就再跑一遍已经绿的全套** —— 那是浪费。
绿过的、且改动没碰到它的，不用重跑。

---

## 五、选证据时最容易犯的三个错

| 错 | 症状 | 怎么避免 |
|:--|:--|:--|
| **只跑了一个测试就宣称"验过了"** | 那个测试**根本没走到**你改的分支 | 用例里加一条「**确实走到了**」的断言（本仓库栽过：`K5`/`K12`/`H11`） |
| **用"测试全绿"当"功能对了"** | 测试床看不见你要验的东西 | 先问：**我这次要验的东西，这个测试床里有吗？** |
| **改了共享工具只跑自己的测试** | 别人的测试在静默假绿 | 见 §一 那条 ⚠️ |

---

## 六、命令速查

```sh
npm test                                  # lint + 全部测试
npm run check                             # 全门禁（推荐提交前跑）
npm run lint                              # 只 lint
npm run render:verify                     # 真 Chrome 量几何（UI 布局改动必跑）
node test/<某个>.test.mjs                  # 单个测试
node test/tags.test.mjs "<真库目录>"        # 带真数据的测试（默认不跑）
```

⚠️ **必须带 glob**：`node --test test/` 会 `MODULE_NOT_FOUND`，要写 `test/*.test.mjs`。
