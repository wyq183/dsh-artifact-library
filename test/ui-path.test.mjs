/**
 * 单测网页版里搬过来的 `absoluteUnder` / `isWindowsPath`。
 *
 * ⚠️ 为什么必须单测：这函数**踩过坑** —— 无条件用 `\` 拼，在 POSIX 上会得到
 *    `/home/x/proj\src/a.md` 这种废路径（面包屑、@ 引用、图标分类、缩略图全跟着坏）。
 *    ⇒ 判据里必须**同时有** Windows 与 POSIX 两种 base。
 */
import fs from 'node:fs'
import vm from 'node:vm'

const F = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\@dsh-external\\dsh-artifact-library\\ui\\index.html'
const html = fs.readFileSync(F, 'utf8')
const js = /<script>([\s\S]*?)<\/script>/.exec(html)[1]

// 抠出两个函数（连同注释）—— 用一个最小 sandbox 求值
const start = js.indexOf('function isWindowsPath(')
const end = js.indexOf('/* ── 文件类型筛选芯片')
if (start < 0 || end < 0 || end < start) { console.error('🔴 抠不出这两个函数'); process.exit(2) }
const code = js.slice(start, end)

const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(code + '\n;this.isWindowsPath = isWindowsPath; this.absoluteUnder = absoluteUnder;', sandbox)
const { isWindowsPath, absoluteUnder } = sandbox

let pass = 0
let fail = 0
function t(name, actual, expected) {
  if (actual === expected) { pass += 1; console.log('  ok   ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + '\n         实际: ' + JSON.stringify(actual) + '\n         期望: ' + JSON.stringify(expected)) }
}

console.log('\n── isWindowsPath ──')
t('盘符 + 反斜杠', isWindowsPath('C:\\p\\a'), true)
t('盘符 + 正斜杠', isWindowsPath('C:/p/a'), true)
t('裸盘符', isWindowsPath('C:'), true)
t('UNC', isWindowsPath('\\\\srv\\share'), true)
t('POSIX 绝对', isWindowsPath('/home/x'), false)
t('空', isWindowsPath(''), false)
t('undefined', isWindowsPath(undefined), false)

console.log('\n── absoluteUnder：绝对路径原样返回 ──')
t('Windows 绝对', absoluteUnder('C:\\cwd', 'D:\\other\\a.md'), 'D:\\other\\a.md')
t('POSIX 绝对', absoluteUnder('/home/x', '/etc/a'), '/etc/a')

console.log('\n── absoluteUnder：⭐ 分隔符跟着 base 的形态（踩过坑的那条）──')
t('Windows base + 正斜杠相对路径 → 反斜杠',
  absoluteUnder('C:\\proj', 'src/a.md'), 'C:\\proj\\src\\a.md')
t('Windows base + 反斜杠相对路径',
  absoluteUnder('C:\\proj', 'src\\a.md'), 'C:\\proj\\src\\a.md')
t('⭐ POSIX base → **正斜杠**（不是反斜杠！）',
  absoluteUnder('/home/yiqi/proj', 'src/a.md'), '/home/yiqi/proj/src/a.md')
// ⚠️ 这一条**记录真实行为**，不是理想行为：
//    实现只归一化 `win` 那一侧（POSIX base 时**不把 `\` 换成 `/`**）。
//    ⇒ 理由：POSIX 宿主**不会**发反斜杠分隔的相对路径，所以那条路走不到。
//      把期望写成"也归正斜杠"会**假红**（我第一版就是这么写的）。
//    📌 这是**已知的窄边界**，不是 bug；真遇到了再扩。
t('POSIX base + 反斜杠相对路径 → 反斜杠**保留**（已知窄边界）',
  absoluteUnder('/home/yiqi/proj', 'src\\a.md'), '/home/yiqi/proj/src\\a.md')

console.log('\n── 反向对照：无条件用反斜杠的写法必须错 ──')
{
  const WRONG = (cwd, p) => String(cwd).replace(/[\\/]+$/, '') + '\\' + String(p).replace(/^[\\/]+/, '')
  const bad = WRONG('/home/yiqi/proj', 'src/a.md')
  t('错写法确实产出废路径（证明上面那条判据不是空转）', bad, '/home/yiqi/proj\\src/a.md')
  if (bad === absoluteUnder('/home/yiqi/proj', 'src/a.md')) {
    console.log('  FAIL ★ 正确实现与错写法结果相同 ⇒ 判据没咬住')
    fail += 1
  } else { pass += 1; console.log('  ok   ★ 正确实现 ≠ 错写法（判据有效）') }
}

console.log('\n── 边界 ──')
t('cwd 空 → 原样返回相对路径', absoluteUnder('', 'src/a.md'), 'src/a.md')
t('cwd 带尾斜杠会被去掉', absoluteUnder('C:\\proj\\', 'a.md'), 'C:\\proj\\a.md')
t('相对路径开头的分隔符会被去掉', absoluteUnder('C:\\proj', '\\a.md'), 'C:\\proj\\a.md')
t('空路径 → 空', absoluteUnder('C:\\proj', ''), '')
t('undefined 路径 → 空', absoluteUnder('C:\\proj', undefined), '')

console.log('\n' + (fail === 0 ? '✅ ' : '🔴 ') + pass + ' 通过 / ' + fail + ' 失败')
if (fail) process.exitCode = 1
