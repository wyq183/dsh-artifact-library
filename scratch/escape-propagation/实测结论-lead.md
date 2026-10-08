# 真实浏览器实测：Esc 传播（决定性证据）

> 2026-10-09 00:0x · Windows 侧小琪（Lead）
> 方法：`chrome --headless=new --dump-dom` 跑 `probe.html`，**真的派发 `KeyboardEvent`**，
> 记录哪些处理器被调用。**这是实测，不是推演。**

## 原始 dump（机器产出，未改动）

```
── A · 原始：抽屉=document capture，浮层=document bubble ──
   调用顺序: 抽屉
   抽屉被关: true   浮层被关: false
   🔴 只关了抽屉，浮层没关（= 用户说的「要按两下」）

── B · 错修：两层都 document capture + 都 stopPropagation ──
   调用顺序: 抽屉 → 浮层
   抽屉被关: true   浮层被关: true
   🔴 一次把两层都关了（不是我们要的）

── C · F2：抽屉让路（blockEscape）＋ 浮层 document capture ──
   调用顺序: 浮层
   抽屉被关: false   浮层被关: true
   ✅ 正确 —— 只关了浮层，抽屉还在

── D · F1：浮层=window capture（赌 window 在捕获路径更前）──
   调用顺序: 浮层
   抽屉被关: false   浮层被关: true
   ✅ 正确 —— 只关了浮层，抽屉还在

── E · 对照：只开浮层（没有抽屉抢）──
   调用顺序: 浮层
   抽屉被关: false   浮层被关: true
   ✅ 正确 —— 只关了浮层，抽屉还在
```

## 复现命令

```powershell
$chrome = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
$probe  = "<repo>\scratch\lead-escape-probe\probe.html"
& $chrome --headless=new --disable-gpu --no-sandbox --virtual-time-budget=4000 `
    --dump-dom "file:///$($probe -replace '\\','/')" > dump.html
# 然后在 dump.html 里找 <pre id="RESULT">
```

## 结论（每条都有实测支撑）

**① 用户的「要按两下」被精确复现**（场景 A）
抽屉在 `document` capture 先跑并 `stopPropagation()` ⇒ 浮层的 bubble 处理器收不到
⇒ 一次 Esc 只关掉抽屉。**A 的输出与用户描述完全一致。**

**② 我第一版的修法确实是错的**（场景 B）—— 这是我自我怀疑被实测证实的地方
把浮层也改成 `document` capture 之后：**两个处理器都执行了**，一次 Esc 关掉两层。
原因：两者同在 `document`、同阶段，**按注册顺序**跑，而 `stopPropagation()`
**不阻止同一元素上的其他监听器**（那要 `stopImmediatePropagation()`，MDN 原文）。
⇒ 如果我把那版提交了，用户会从「按两下」变成「一次关两层」——**换了个 bug，没修好**。

**③ F2（`blockEscape` 显式让路）达成契约**（场景 C）
抽屉看到「上面有浮层」就**直接 return、且不 stopPropagation** ⇒ 事件继续走到浮层
⇒ **一次 Esc 只关浮层，抽屉保持打开**。

**④ F1（window capture）也达成**（场景 D），且**顺带回答了两个规范问题**
D 的调用顺序是「浮层」且抽屉**没被关** ⇒ 说明：
- **Q3：`window` 在捕获路径里**，`window` capture 的监听器**比 `document` capture 的先跑**；
- **Q4：在 `window` capture 里 `stopPropagation()` 能截断 `document` 上的 capture 监听器**
  （它们不是同一元素上的兄弟，所以 stopPropagation 有效）。

## 为什么最终选 F2 而不是 F1

两者实测都成立。选 F2 的理由（都是工程性的，不是"看起来更好"）：
1. **不依赖事件路径细节**：F1 依赖「window 一定在路径里」这个我**实测才敢信**的前提；
   哪天宿主把面板渲染进 shadow DOM / iframe，路径就变了，F1 会**静默失效**。
2. **能在渲染树上断言**：F2 的状态是 `blockEscape` 这个 prop，
   测试可以直接断言「浮层开着时抽屉收到 blockEscape=true」——**守卫看得见**。
   F1 只能靠静态扫源码（我们仓库已经被"静态判据写错"坑过好几次）。
3. **意图更清楚**：`blockEscape` 直说「我在你上面，你让路」；
   `window` vs `document` 的阶段差是**隐式**的，读代码的人不容易看出为什么。

⚠️ **F1 的实测结果仍然记在这里**：将来若有人问「为什么不挂 window」，答案是
「挂 window 也能用，但我们选了显式让路，理由见上」——**不是**「挂 window 不行」。
这两句话的区别很重要：前者是取舍，后者是假事实。

## 没验的部分（明写）

- 本探针验的是**监听器拓扑**，不是产物库面板的真实渲染。
  「真实 `lib/client.js` 里 `blockEscape` 真的传下去了吗」由渲染树守卫
  （`test/overlay-escape.test.mjs`，guard-author 在写）覆盖。
- **真机肉眼没看**：面板里点缩略图开浮层、按一次 Esc 的实际手感，仍需人验。
