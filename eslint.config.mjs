/**
 * ESLint 扁平配置（2026-10-09 建）
 * ══════════════════════════════════════════════════════════════════════════
 * 【为什么现在才建】
 * 依琪 2026-10-09：「**如果一个项目一开始按照规范来开发，肯定比现在这样稳的多**」。
 * 他是对的。审了一遍项目基建，结果是**零**：
 *   ESLint / Prettier / editorconfig / CI / CONTRIBUTING —— 全无；
 *   `package.json` 的 `scripts` 和 `devDependencies` **都是空的**。
 *
 * 【建它的直接原因：一个真 bug】
 * 我拿 ESLint **跑了一次这个项目**，`no-undef` **一行配置**当场抓到一个真 bug：
 *   `lib/client.js` 的 `getCtx: function () { return ctx; }` —— `ctx` 不在作用域里，
 *   一调用就 `ReferenceError`，被 `nativePicker` 的 catch 吞掉 ⇒
 *   **原生目录选择器永久不可用，还甩锅给宿主**（「宿主的目录选择服务不可达」是假话）。
 *   已修（提交 `5b52922`）。
 *
 * 【⚠️ 但这份配置**不是**从零设计的 —— 我按调研的结论做了取舍】
 *   · **官方 DSH 用的是 Oxlint 不是 ESLint**（`.oxlintrc.json`，12.7 KB）。
 *     本机没装 Oxlint，且 ESLint 生态更成熟 ⇒ **先用 ESLint**，
 *     将来若要跟官方对齐再迁（规则集可平移）。
 *   · **没有上 airbnb**：调研原话——「9389 行零 lint 历史上开 airbnb 会得到几千条
 *     warning，**第二天就会被人关掉**」。正确顺序是 `recommended` + 少数几条 error 起步。
 *   · **没有上 TypeScript**：纯 JS 项目，加构建步骤收益/代价比最差。
 *
 * 【棘轮策略（ratchet）：老代码一行不改，新代码从第一行起被管住】
 *   规则全部写 **error**（不是 warn —— warn 会被无视）。
 *   现有违规用 ESLint 官方的 **bulk suppressions** 压进基线：
 *       npx eslint --suppress-all
 *   然后**提交 `eslint-suppressions.json`**。
 *   ⇒ 违规数**只许减不许增**；新代码违反 = 当场红。
 *   ⚠️ 官方细节：bulk suppressions **只抑制 `"error"` 级规则，`"warn"` 不抑制**。
 *      这是"规则必须写 error 不能写 warn"的官方依据。
 *   ⚠️ 加 `-Werror` 之类的临时压制**不许**（那会绕过棘轮）。
 */

import js from '@eslint/js'

export default [
  // ── 忽略 ────────────────────────────────────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      'scratch/**',            // 我的实验/一次性脚本，不是产品代码
      '_night-backup-*/**',
      'vendor/**',
      '**/*.min.js',
    ],
  },

  // ── ① 基础：官方推荐 ────────────────────────────────────────────────────
  js.configs.recommended,

  // ── ② 这个项目的环境（宿主是 DSH 桌面端：浏览器 + Node 混合）───────────
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // 浏览器（客户端插件 lib/client.js 跑在渲染进程里）
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        location: 'readonly', history: 'readonly', fetch: 'readonly',
        console: 'readonly', getComputedStyle: 'readonly', matchMedia: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        MutationObserver: 'readonly', IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly', DOMParser: 'readonly', NodeFilter: 'readonly',
        KeyboardEvent: 'readonly', MouseEvent: 'readonly', CustomEvent: 'readonly',
        Event: 'readonly', Element: 'readonly', Node: 'readonly', HTMLElement: 'readonly',
        Blob: 'readonly', File: 'readonly', FileReader: 'readonly', FormData: 'readonly',
        Headers: 'readonly', Request: 'readonly', Response: 'readonly',
        TextDecoder: 'readonly', TextEncoder: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', crypto: 'readonly',
        performance: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
        WebSocket: 'readonly', Worker: 'readonly', Image: 'readonly', Audio: 'readonly',
        XMLHttpRequest: 'readonly', btoa: 'readonly', atob: 'readonly',
        structuredClone: 'readonly', queueMicrotask: 'readonly',
        alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
        // Node（宿主侧 lib/*.js 跑在主进程 / 测试里）
        process: 'readonly', Buffer: 'readonly', setImmediate: 'readonly',
        clearImmediate: 'readonly', global: 'readonly', __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },

  // ── ③ 测试文件：`node:test` 的写法比较自由，关掉几条噪音规则 ─────────────
  {
    files: ['test/**/*.mjs', 'test/**/*.js'],
    rules: {
      // 测试里大量用「构造一个已知有病的输入」⇒ 未使用变量是刻意的
      'no-unused-vars': 'off',
    },
  },

  // ── ④ 这个项目的**架构约束**（把"注释里的约定"变成机器能查的）──────────
  {
    files: ['lib/**/*.js'],
    rules: {
      // ⚠️ 这几条是**我手工审计过、写进注释的约定**，现在让机器也管：
      'no-restricted-syntax': ['error',
        {
          // 禁 hex 颜色 —— 本仓库约定：颜色必须走主题 token（写死 hex 不跟随深浅主题）
          // ⚠️ 但 `lib/icons.js` 的 svg 里可能有正当的 hex ⇒ 见下面的 override
          selector: "Literal[value=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/]",
          message: 'hex 颜色：本仓库约定颜色必须走主题 token（--dsw-alias-*），写死 hex 就不跟随深浅主题。',
        },
      ],
      // 规模上限：治「lib/client.js 9389 行」
      // ⚠️ 官方 max-lines 文档原话：「most people would agree it should not be in the
      //    thousands. Recommendations usually range from 100 to 500 lines.」
      //    现有文件会靠 bulk suppressions 压进基线（棘轮），新文件从第一行起受限。
      'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }],
      'complexity': ['error', 25],
      'max-depth': ['error', 6],
    },
  },

  // ── ⑤ icons.js 的例外（svg 里的 hex 是图标定义的一部分）─────────────────
  {
    files: ['lib/icons.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]
