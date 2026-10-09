# 05 · 代码规范

> 提炼自 `code-conventions` / `defensive-patterns` / `module-layering`（**MIT**，`arch3rPro/dsh-skills`），
> 以及本仓库**自己踩过的坑**。`[机器]` 的条目已被 `eslint.config.mjs` 强制。

---

## 一、本仓库的结构与边界

```
lib/
  index.js          ← 宿主侧入口（DSH 加载它）
  client.js         ← 客户端插件（**浏览器 bundle，零 import**）⚠️ 9389 行，待拆
  store.js          ← 记录存储 / 落盘 / 撤销凭据
  tools.js          ← agent 工具注册
  settings.js       ← 设置
  platform.js       ← 跨平台（reveal / open / 路径）
  http.js           ← HTTP 端点
  tags.js / categories.js / project-merge.js / tag-styles.js / icons.js
  index/            ← 文件索引层（engine / walk / efi / es / ini / query / workspaces / backend-node）
test/               ← 30 个 `*.test.mjs` + `_strip-comments.mjs`（共享工具，刻意不叫 .test）
ui/                 ← 兜底管理页（**不是主界面**，主界面在 client.js）
docs/               ← 文档 + 本规范
vendor/             ← 第三方（ES 二进制等）
scratch/            ← 实验/一次性脚本（**不进测试套件**，已被 lint 忽略）
```

### `[人]` 三条边界纪律

1. **`lib/client.js` 是浏览器 bundle，零 `import`。**
   模块级组件要用 React 必须 **`var React = require("react")`**（在函数体内）。
   ⚠️ 顶层 `import` 会让整个 bundle 挂掉。
2. **宿主侧 vs 客户端侧，热载行为不同。**
   `lib/client.js` **热载**（改完刷新即可）；`lib/*.js` 其余**不热载** ⇒ **要重启 DSH**。
   ⚠️ 提交信息里要写明是哪一种。
3. **`ui/index.html` 是兜底页，不是主界面。**
   拿它截图 = 与用户实际看到的不一致（**事实性错误**）。
   详见 `docs/SUBMIT-CHECKLIST.md` B2。

---

## 二、`[机器]` 已被 lint 强制的

| 规则 | 为什么 |
|:--|:--|
| `no-undef`（error） | ⭐ **抓到过一个真 bug**：`getCtx: function () { return ctx; }` —— `ctx` 不在作用域里，一调用就 `ReferenceError`，被 catch 吞掉，**静默废掉原生目录选择器还甩锅给宿主** |
| 禁 hex 颜色（error） | 颜色必须走主题 token（`--dsw-alias-*`），写死 hex 就不跟随深浅主题 |
| `max-lines` 800 / `max-lines-per-function` 150（error） | 官方文档原话：单文件"**不该到几千行**，推荐 100~500" |
| `complexity` 25 / `max-depth` 6（error） | |
| `no-unused-vars` | 死代码 |

⚠️ **棘轮**：现有 199 条违规在 `eslint-suppressions.json` 里豁免。
**只许减不许增** —— 修好一处就 `npx eslint . --prune-suppressions`。

---

## 三、`[清单]` 边界与契约

### 1. 副作用要**可逆**（`code-conventions`）

注册/监听/定时器/临时文件 —— **每个副作用都要有对应的清理**，并**返回 disposer**。

⚠️ 本仓库实证：`apply(ctx)` 返回 disposer；`slots.inject` 的清理、
`atTimer` / `retryTimer` / `domDisposer` / `probe` **逐个 try 着清**。
**清的时候也要 try** —— 一个清理失败不该让后面的清理不跑。

### 2. 显式优于隐式（边界上）

- **跨模块的接口**：参数、返回、错误，都要**写清楚**；
- 宁可多一个显式的 `null` 检查，也不要靠"上游一定会传"。

### 3. 配置优于硬编码

⚠️ 本仓库的坑：`ROW_H_SEARCH = 44` 这类常量已经提出来了，**但 CSS 里还有写死的数字**。
⇒ 新的可调值**先想"它该不该是常量"**。

### 4. 空 catch 必须**说明为什么空**

```js
} catch (error) { /* 忽略 */ }        // ❌ 不许
} catch (error) { /* 拿不到就算了，调用方会走降级路径 */ }   // ✅
```

⚠️ **这条不是风格问题** —— 本仓库那个真 bug 就死在**空 catch 吞掉 ReferenceError**，
然后对外报了一句**假话**（"宿主的目录选择服务不可达"）。

⭐ **推论**：**catch 里不许把"我们自己的错"说成"别人的错"。**
如果 catch 后要降级并告知用户，**先分清是"预期的不可用"还是"意外异常"**。

### 5. 防御性编程（`defensive-patterns`）

用到的地方：**生命周期 / 并发 / 子进程 / teardown / 错误上报 / 不可信 IO**。

⚠️ 本仓库实证：
- `spawnSoft` 曾经**无条件** `windowsHide: true` ⇒ "在文件夹中显示"**静默不弹窗**
  （窗口建了但 `IsWindowVisible = false`）。修法：**改成按选项决定**。
- 宿主接口**随时可能没有**（`ctx.get("slots")` 返回 undefined）⇒ **不判空就是崩**。

### 6. 模块分层（`module-layering`）

**知道你的依赖图。** 当前只有 `lib/client.js` 一个大文件 ⇒ **还没有"层"可管**。
⇒ 顺序是：**先拆文件，再管层**（`dependency-cruiser` 等拆完再上）。

---

## 四、`[人]` 值得警惕的模式

| 味道 | 为什么 |
|:--|:--|
| **同一个 helper 在多处抄** | 本仓库实测：**同一个工具函数抄了 5 份，其中 3 份带着同一个 bug**。⇒ 提到 `test/` 下的共享工具，或 `lib/` 里的模块 |
| **一个函数 800 行** | 已经无法在脑内推理；`max-lines-per-function` 会警告 |
| **"顺手"改了别处** | 停下来：拆成两次提交，或明说 |
| **注释里写着"应该 XXX"但代码没做** | 注释会骗后来人。**要么改代码，要么删注释** |
| **注释里引用了旧写法** | ⚠️ 本仓库栽过：判据搜到**注释里的旧写法** ⇒ 假红 |

---

## 五、`[清单]` 写代码时逐条过

- [ ] 每个副作用有清理吗？清理本身 try 了吗？
- [ ] 每个空 `catch` 都写了"为什么空"吗？
- [ ] `catch` 后报给用户的原因，**是真的原因**吗？（别甩锅给别人）
- [ ] 新加的可调值，该不该提成常量？
- [ ] 有没有把 helper 抄了一份？（该提到共享位置）
- [ ] 如果改了 `lib/client.js`：**没有引入顶层 `import`** 吧？
- [ ] 如果改了宿主侧：提交信息里写了**要重启**吗？

---

## 六、相关

- **断言/守卫的写法** → [03-assertions.md](03-assertions.md)
- **架构与设计决策的完整记录** → `docs/ARCHITECTURE.md`
- **安全边界** → `docs/ARCHITECTURE.md` §六 + `test/scope-guards.test.mjs`
