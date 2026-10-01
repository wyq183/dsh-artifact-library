/**
 * dsh-artifact-library — 平台接缝层
 *
 * ── 为什么要有这个文件（2026-10-01）────────────────────────────────────────
 *
 * 插件原本是 **Windows 专用**：`process.platform` 判断 **0 处**，硬编码 `C:\`
 * 126 处，`explorer.exe` 直接写死在两个端点里。要适配 Windows + Linux，
 * 平台差异必须先**收进一处**，否则每个调用点各写一遍 `if (isWindows)`，
 * 迟早出现「一半改了、一半忘了」。
 *
 * ── 这里放什么 / 不放什么 ──────────────────────────────────────────────────
 *
 * 放：**「同一件事在不同平台要用不同做法」** 的全部知识。
 *   · 平台身份与标签
 *   · 路径语义（大小写是否敏感）
 *   · 启动外部程序（且**绝不因启动失败打崩宿主**）
 *   · 「在文件管理器里定位 / 用默认程序打开」
 *   · 索引运行时该放哪个缓存目录
 *
 * 不放：任何与产物库业务有关的判断（那是 store/http/index 的事）。
 *
 * ── 一条硬约束（血换来的）─────────────────────────────────────────────────
 *
 * **本文件里任何 spawn 都必须挂 `'error'` 监听。**
 *
 * 2026-10-01 实测复现：`spawn('explorer.exe', …)` 在 Linux 上发出 `'error'`
 * （ENOENT）。未处理的 `'error'` 事件**不是异常，是进程级 abort** ——
 * `try/catch` 抓不到，宿主 dsh web **直接退出（EXIT=1）**。
 * 也就是说：非 Windows 上用户点一下「定位」就能打崩整个应用。
 * 所以对外只暴露 `spawnSoft` / `runOnce` 这类**永不抛、永不裸奔**的包装。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 原始平台串（'win32' / 'linux' / 'darwin' / …） */
export const PLATFORM = process.platform

export const IS_WINDOWS = PLATFORM === 'win32'
export const IS_MACOS = PLATFORM === 'darwin'
export const IS_LINUX = PLATFORM === 'linux'

/** 归一化的平台标签（给日志/状态/文档用，稳定可断言） */
export const PLATFORM_LABEL = IS_WINDOWS ? 'windows'
  : IS_MACOS ? 'macos'
    : IS_LINUX ? 'linux'
      : PLATFORM

/**
 * 该平台的文件系统是否**大小写不敏感**。
 *
 * ⚠️ 这是「平台默认值」，不是「每个挂载点的真相」。Windows 与 macOS 默认不敏感；
 * Linux 默认敏感 —— 但 WSL 上的 `/mnt/c` 走 DrvFs，实际上是**不敏感**的。
 *
 * 所以本值只用于**「要不要把大小写不同的两个路径当成同一个」**这个判断，
 * 且**一律偏向「不当成同一个」**：Linux 上不做有损小写折叠。
 * 理由：折叠错了会把两个真实存在的不同目录**合并成一个**（安全闸门因此放宽，
 * `isInside('/home/A/x','/home/a')` 会返回 true）；不折叠最差只是重复一项，
 * 不会放宽任何边界。**宁可多一项，不可放错门。**
 */
export const CASE_INSENSITIVE_PATHS = IS_WINDOWS || IS_MACOS

/** 文件管理器的名字（写 UI 文案用，别在界面里写死「资源管理器」） */
export function fileManagerName() {
  if (IS_WINDOWS) return '资源管理器'
  if (IS_MACOS) return '访达'
  return '文件管理器'
}

// ═══════════════════════════════════════════════════════════════════════════
// 路径形态识别：**按形态判，不按当前操作系统判**
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么按形态而不是按 `process.platform`：
//   · 跨平台迁移过来的产物记录里存的是 `C:\...`，它在 Linux 上依然该按 **Windows 语义**
//     解析（大小写不敏感、反斜杠是分隔符），否则 `path.dirname('C:\a\b.txt')` 会返回 `'.'`
//     —— 索引范围直接退化成当前目录。
//   · 同一条判据在三个平台上跑出的结果一致，测试也就不用到处 `if (isWindows)`。

/** 是不是 Windows 形态的路径（盘符 `C:\` 或 UNC `\\server\share`） */
export function looksLikeWindowsPath(p) {
  const s = String(p || '')
  if (!s) return false
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true
  if (/^[a-zA-Z]:$/.test(s)) return true
  if (s.startsWith('\\\\')) return true
  return false
}

/** 按**路径形态**选 path 实现（Windows 形态 → path.win32，其余 → 宿主 path） */
export function pathApiFor(p) {
  return looksLikeWindowsPath(p) ? path.win32 : path
}

/** 形态感知的 dirname（Windows 形态路径在 Linux 上也能解析对） */
export function dirnameAuto(p) {
  return pathApiFor(p).dirname(String(p))
}

/** 形态感知的 basename */
export function basenameAuto(p) {
  return pathApiFor(p).basename(String(p))
}

/** 形态感知的 isAbsolute */
export function isAbsoluteAuto(p) {
  return pathApiFor(p).isAbsolute(String(p))
}

/**
 * 该**路径形态**对应的大小写语义。
 * Windows 不敏感；POSIX 敏感。同样只看形态，不看当前操作系统。
 */
export function isCaseInsensitivePath(p) {
  return looksLikeWindowsPath(p)
}

/** 按形态归一化用于比较的键：去尾分隔符 +（仅 Windows 形态）折叠大小写 */
export function canonicalPathKey(p) {
  const s = String(p || '').replace(/[\\/]+$/, '')
  return isCaseInsensitivePath(s) ? s.toLowerCase() : s
}

/**
 * 把路径转成比较用文本（保留原分隔符形态，仅去尾分隔符 + 按形态折叠大小写）。
 * @returns {{text:string, sep:'\\'|'/'}}
 */
export function compareForm(p) {
  const s = String(p || '').replace(/[\\/]+$/, '')
  const win = isCaseInsensitivePath(s)
  return { text: win ? s.toLowerCase() : s, sep: win ? '\\' : '/' }
}

/** 平台能力表：上层据此选后端（而不是到处写 if (IS_WINDOWS)） */
export function platformCapabilities() {
  return {
    platform: PLATFORM_LABEL,
    caseInsensitivePaths: CASE_INSENSITIVE_PATHS,
    // 文件搜索后端：Windows 走内置 Everything（保留既有能力），其余走纯 Node 范围索引
    fileSearchBackend: IS_WINDOWS ? 'everything' : 'node',
    // Windows 专有：独立实例 + ini 配置 + .efu 清单
    usesEverything: IS_WINDOWS,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 启动外部程序：永不抛、永不裸奔
// ═══════════════════════════════════════════════════════════════════════════

function errorText(error) {
  return String((error && error.message) || error || '未知错误')
}

/**
 * 在 PATH 里找一个可执行文件（不经过 shell）。
 *
 * 为什么不用 `which`：那要再起一个子进程，而子进程本身就可能不存在（鸡生蛋）。
 *
 * @param {string} cmd 命令名或绝对路径
 * @returns {string} 绝对路径；找不到返回空串
 */
export function whichSync(cmd) {
  const name = String(cmd || '')
  if (!name) return ''
  if (name.includes('/') || name.includes('\\')) {
    try { return fs.existsSync(name) ? name : '' } catch { return '' }
  }
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts = IS_WINDOWS
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((s) => s.trim()).filter(Boolean)
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext)
      try {
        if (fs.existsSync(full)) return full
      } catch { /* 忽略：只是探测 */ }
    }
  }
  return ''
}

/**
 * 启动一个**分离的**进程，只关心「起来了没有」，不等它结束。
 *
 * ★ 关键：**一定挂 `'error'`**，否则 ENOENT 会以未处理事件的形式 abort 整个宿主。
 *
 * @returns {Promise<{ok:boolean, pid?:number, code?:string, error?:string}>}
 */
export function spawnSoft(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: !!options.windowsVerbatimArguments,
      })
    } catch (error) {
      // spawn 同步抛（参数非法等）：也要收成结果，不能冒泡
      return resolve({ ok: false, code: 'spawn-threw', error: errorText(error) })
    }

    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve(payload)
    }

    // ★★ 这一行就是「点一下定位打崩宿主」的那个 bug 的解药
    child.on('error', (error) => finish({
      ok: false,
      code: (error && error.code) || 'spawn-error',
      error: errorText(error),
    }))
    child.once('spawn', () => {
      try { child.unref() } catch { /* 忽略 */ }
      finish({ ok: true, pid: child.pid, code: 'spawned' })
    })
  })
}

/**
 * 跑一个**短命令**并等它结束（拿退出码）。
 * 用于需要知道成功与否的场景（例如 D-Bus 调用失败要回退另一种方式）。
 *
 * @returns {Promise<{ok:boolean, code:number|null, out:string, err:string, error?:string}>}
 */
export function runOnce(cmd, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let child
    let settled = false
    const out = []
    const err = []

    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        out: Buffer.concat(out).toString('utf8').trim(),
        err: Buffer.concat(err).toString('utf8').trim(),
        ...payload,
      })
    }

    const timer = setTimeout(() => {
      try { child && child.kill() } catch { /* 忽略 */ }
      finish({ ok: false, code: null, error: `超时（${timeoutMs}ms）` })
    }, Math.max(200, timeoutMs))

    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      clearTimeout(timer)
      return finish({ ok: false, code: null, error: errorText(error) })
    }

    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', (error) => finish({
      ok: false,
      code: (error && error.code) || null,
      error: errorText(error),
    }))
    child.on('close', (code) => {
      const n = Number(code)
      finish({ ok: n === 0, code: Number.isFinite(n) ? n : null, error: n === 0 ? undefined : `退出码 ${code}` })
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// 打开 / 定位
// ═══════════════════════════════════════════════════════════════════════════

/** Windows 命令行里给参数加引号（explorer 的 `/select,` 后面必须带引号） */
function winQuote(value) {
  return '"' + String(value) + '"'
}

/**
 * Linux：在文件管理器里选中某个文件。
 *
 * 首选 **D-Bus `org.freedesktop.FileManager1.ShowItems`** —— 这是桌面环境的标准接口
 * （Nautilus / Dolphin / Nemo / Thunar 都实现），能真的「选中」而不是只打开目录。
 * gdbus / dbus-send 谁在就用谁；都不可用（无会话总线、无桌面）就回退「打开所在目录」。
 */
async function revealLinux(target) {
  const uri = pathToFileURL(target).href
  const attempts = [
    {
      cmd: 'gdbus',
      args: [
        'call', '--session',
        '--dest', 'org.freedesktop.FileManager1',
        '--object-path', '/org/freedesktop/FileManager1',
        '--method', 'org.freedesktop.FileManager1.ShowItems',
        "['" + uri.replace(/'/g, "\\'") + "']",
        "''",
      ],
    },
    {
      cmd: 'dbus-send',
      args: [
        '--session',
        '--dest=org.freedesktop.FileManager1',
        '--type=method_call',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1.ShowItems',
        'array:string:' + uri,
        'string:""',
      ],
    },
  ]

  const tried = []
  for (const attempt of attempts) {
    if (!whichSync(attempt.cmd)) { tried.push(`${attempt.cmd}:缺席`); continue }
    const result = await runOnce(attempt.cmd, attempt.args, 3000)
    if (result.ok) return { ok: true, method: attempt.cmd }
    tried.push(`${attempt.cmd}:${result.error || '失败'}`)
  }

  // 回退：打开所在目录（大多数桌面环境的 xdg-open 就是这么做的）
  const dir = path.dirname(target)
  const opener = whichSync('xdg-open') ? 'xdg-open' : (whichSync('gio') ? 'gio' : '')
  if (!opener) {
    return { ok: false, code: 'no-launcher', error: `找不到可用的文件管理器（${tried.join(' · ')}）` }
  }
  const launched = await spawnSoft(opener, opener === 'gio' ? ['open', dir] : [dir])
  if (!launched.ok) return { ok: false, code: launched.code, error: launched.error }
  return { ok: true, method: `${opener}(目录)`, degraded: true }
}

/**
 * 在系统文件管理器里**定位并选中**一个路径。
 *
 * @param {string} target 绝对路径（文件或目录）
 * @returns {Promise<{ok:boolean, method?:string, code?:string, error?:string}>}
 */
export async function revealPath(target) {
  const p = String(target || '')
  if (!p) return { ok: false, code: 'bad-request', error: '路径为空' }

  if (IS_WINDOWS) {
    // ⚠️ `/select,` 后面**必须**带引号：含空格的路径不加引号 explorer 解析不可靠
    const launched = await spawnSoft('explorer.exe', [`/select,${winQuote(p)}`], {
      windowsVerbatimArguments: true,
    })
    return launched.ok
      ? { ok: true, method: 'explorer /select' }
      : { ok: false, code: launched.code, error: launched.error }
  }
  if (IS_MACOS) {
    const launched = await spawnSoft('open', ['-R', p])
    return launched.ok
      ? { ok: true, method: 'open -R' }
      : { ok: false, code: launched.code, error: launched.error }
  }
  return revealLinux(p)
}

/**
 * 用系统默认程序**打开**一个路径。
 *
 * @param {string} target 绝对路径（文件或目录）
 * @returns {Promise<{ok:boolean, method?:string, code?:string, error?:string}>}
 */
export async function openPath(target) {
  const p = String(target || '')
  if (!p) return { ok: false, code: 'bad-request', error: '路径为空' }

  if (IS_WINDOWS) {
    const launched = await spawnSoft('explorer.exe', [winQuote(p)], { windowsVerbatimArguments: true })
    return launched.ok
      ? { ok: true, method: 'explorer' }
      : { ok: false, code: launched.code, error: launched.error }
  }
  if (IS_MACOS) {
    const launched = await spawnSoft('open', [p])
    return launched.ok ? { ok: true, method: 'open' } : { ok: false, code: launched.code, error: launched.error }
  }

  const opener = whichSync('xdg-open') ? 'xdg-open' : (whichSync('gio') ? 'gio' : '')
  if (!opener) {
    return { ok: false, code: 'no-launcher', error: '系统里找不到 xdg-open 或 gio，无法用默认程序打开' }
  }
  const launched = await spawnSoft(opener, opener === 'gio' ? ['open', p] : [p])
  return launched.ok
    ? { ok: true, method: opener }
    : { ok: false, code: launched.code, error: launched.error }
}

// ═══════════════════════════════════════════════════════════════════════════
// 索引运行时目录
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 用户级缓存根目录（**必须落在用户数据目录之外**，见 index/paths.js 的自引用说明）。
 *
 * Windows：`%LOCALAPPDATA%\dsh-artifact-library`（与改造前一致，老用户不用迁移）
 * macOS  ：`~/Library/Caches/dsh-artifact-library`
 * Linux  ：`$XDG_CACHE_HOME/dsh-artifact-library`，没有就用 `~/.cache/dsh-artifact-library`
 *
 * @returns {string} 绝对路径；推导不出来返回空串（调用方自行兜底）
 */
export function userCacheRoot() {
  try {
    if (IS_WINDOWS) {
      const base = process.env.LOCALAPPDATA
        || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '')
      return base ? path.join(base, 'dsh-artifact-library') : ''
    }
    if (IS_MACOS) {
      return path.join(os.homedir(), 'Library', 'Caches', 'dsh-artifact-library')
    }
    const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
    return base ? path.join(base, 'dsh-artifact-library') : ''
  } catch {
    return ''
  }
}

/** 探测结果缓存（`which` 要读盘，别每次查询都做） */
const toolCache = new Map()

/**
 * 带缓存的工具探测。
 * @param {string} cmd
 * @returns {string} 绝对路径或空串
 */
export function findTool(cmd) {
  const key = String(cmd || '')
  if (!key) return ''
  if (!toolCache.has(key)) toolCache.set(key, whichSync(key))
  return toolCache.get(key)
}

/** 清空探测缓存（测试用） */
export function resetToolCache() {
  toolCache.clear()
}
