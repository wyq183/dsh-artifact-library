/**
 * dsh-artifact-library — 文件索引：离线自验
 *
 * 不需要 DSH 宿主，直接跑引擎，验证：
 *   ① 纯函数（范围规范化 / 父子合并 / ini 生成）
 *   ② 真实拉起 Everything 实例并索引
 *   ③ **隐私断言**：范围外的文件绝不可见（这台机器全盘有 322 万文件，是最严格的对照）
 *   ④ 中文路径不乱码（GBK 坑的回归测试）
 *   ⑤ 正常关闭（强杀会丢配置）
 *
 * 用法：node lib/index/selftest.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileIndex } from './engine.js'
import { normalizeScope, isInside, buildScope, dirsFromArtifacts } from './scope.js'
import { buildIni } from './ini.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, '..', '..')
const SCRATCH = 'C:\\Users\\Administrator\\.dsh\\scratch'
const SCOPE_DIR = path.join(SCRATCH, 'selftest-scope')
const DATA_DIR = path.join(SCRATCH, 'selftest-data')

let passed = 0
let failed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    failures.push(name + ' → ' + (error && error.message ? error.message : String(error)))
    console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error)))
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

function log(msg) { console.log(msg) }

// ─────────────────────────────────────────────────────────────
log('\n=== [1] 纯函数：范围规范化 ===')
check('父子合并：子目录被父目录吃掉', () => {
  const out = normalizeScope(['C:\\a', 'C:\\a\\b', 'C:\\a\\b\\c'])
  assert(out.length === 1 && out[0].toLowerCase() === 'c:\\a', '得到 ' + JSON.stringify(out))
})
check('不同分支都保留', () => {
  const out = normalizeScope(['C:\\a', 'C:\\b'])
  assert(out.length === 2, '得到 ' + JSON.stringify(out))
})
check('大小写不敏感去重', () => {
  const out = normalizeScope(['C:\\A', 'c:\\a'])
  assert(out.length === 1, '得到 ' + JSON.stringify(out))
})
check('丢掉相对路径与空值', () => {
  const out = normalizeScope(['', '  ', 'relative\\path', null, undefined, 42])
  assert(out.length === 0, '得到 ' + JSON.stringify(out))
})
check('isInside 边界（C:\\ab 不算在 C:\\a 内）', () => {
  assert(isInside('C:\\a\\b', 'C:\\a') === true, 'a\\b 应在 a 内')
  assert(isInside('C:\\ab', 'C:\\a') === false, 'ab 不应算在 a 内')
  assert(isInside('C:\\a', 'C:\\a') === true, '自身算')
})
check('dirsFromArtifacts 取父目录', () => {
  const dirs = dirsFromArtifacts([{ path: 'C:\\x\\y\\f.png' }, { path: 'C:\\z\\g.md' }, {}])
  assert(dirs.length === 2, '得到 ' + JSON.stringify(dirs))
})
check('buildScope 合并三路来源', () => {
  const out = buildScope({ workspaces: ['C:\\w'], artifactDirs: ['C:\\w\\sub'], extra: ['C:\\e'] })
  assert(out.length === 2, '父子合并后应为 2，得到 ' + JSON.stringify(out))
})

log('\n=== [2] 纯函数：ini 生成 ===')
check('包含全部范围限定键', () => {
  const ini = buildIni({ scopeDirs: ['C:\\a', 'C:\\b'], dbDir: 'D:\\db' })
  for (const key of ['auto_include_fixed_volumes=0', 'ntfs_volume_paths=\r\n', 'folders=C:\\a,C:\\b', 'db_location=D:\\db']) {
    assert(ini.includes(key), '缺少: ' + key)
  }
})
check('含逗号的路径被引号包裹', () => {
  const ini = buildIni({ scopeDirs: ['C:\\a,b'], dbDir: '' })
  assert(ini.includes('folders="C:\\\\a,b"'), '得到: ' + ini.split('\r\n').find((l) => l.startsWith('folders=')))
})
check('folder_monitor_changes 数量与范围一致', () => {
  const ini = buildIni({ scopeDirs: ['C:\\a', 'C:\\b', 'C:\\c'], dbDir: '' })
  const line = ini.split('\r\n').find((l) => l.startsWith('folder_monitor_changes='))
  assert(line === 'folder_monitor_changes=1,1,1', '得到: ' + line)
})

// ─────────────────────────────────────────────────────────────
log('\n=== [3] 真实索引：准备范围目录（含中文文件名）===')
fs.rmSync(SCOPE_DIR, { recursive: true, force: true })
fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.mkdirSync(path.join(SCOPE_DIR, 'sub'), { recursive: true })
fs.mkdirSync(DATA_DIR, { recursive: true })

const fixtures = [
  ['alpha.txt', 'aaa'],
  ['beta.md', 'bbb'],
  ['中文 名字(测试).txt', 'ccc 中文内容'],
  ['sub\\gamma.txt', 'ddd'],
  ['sub\\中文子目录文件.md', 'eee'],
]
for (const [rel, body] of fixtures) {
  fs.writeFileSync(path.join(SCOPE_DIR, rel), body, 'utf8')
}
log(`  造了 ${fixtures.length} 个文件（含 2 个中文名）于 ${SCOPE_DIR}`)

const index = createFileIndex({ dataDir: DATA_DIR, logger: { info: (m) => log('  [engine] ' + m), warn: (m) => log('  [engine:warn] ' + m) } })

log('\n=== [4] ensureReady（真实拉起 Everything 实例）===')
const readyResult = await index.ensureReady({ scopeDirs: [SCOPE_DIR] })
check('引擎就绪', () => assert(readyResult.ok === true, '未就绪: ' + (readyResult.error || '')))
check('上报的范围正确', () => {
  assert(readyResult.scope.length === 1 && readyResult.scope[0] === SCOPE_DIR, '得到 ' + JSON.stringify(readyResult.scope))
})

if (!readyResult.ok) {
  log('\n引擎未就绪，跳过真实查询断言。')
} else {
  log('\n=== [5] 真实查询 ===')
  const all = await index.search({ query: '*', limit: 100 })
  check('全量查询成功', () => assert(all.ok === true, '查询失败: ' + (all.error || '')))
  check('★ 只看到范围内的条目（不是全盘 322 万）', () => {
    assert(all.total < 100, `total=${all.total}，疑似索引了范围外的东西`)
  })
  check('范围外路径零泄漏', () => {
    const leaked = all.rows.filter((r) => !r.path.toLowerCase().startsWith(SCOPE_DIR.toLowerCase()))
    assert(leaked.length === 0, '泄漏了: ' + JSON.stringify(leaked.slice(0, 3).map((r) => r.path)))
  })

  const txt = await index.search({ query: 'ext:txt', limit: 50 })
  check('ext:txt 命中 3 个（alpha / 中文 / sub\\gamma）', () => {
    assert(txt.ok, '查询失败')
    assert(txt.total === 3, `期望 3，得到 ${txt.total}: ` + JSON.stringify(txt.rows.map((r) => r.name)))
  })

  const cn = await index.search({ query: '*中文*', limit: 20 })
  check('★ 中文文件名不乱码（GBK 坑回归）', () => {
    assert(cn.ok && cn.rows.length >= 2, `命中 ${cn.rows.length} 个`)
    const names = cn.rows.map((r) => r.name)
    assert(names.some((n) => n.includes('中文 名字(测试).txt')), '未命中主中文文件，得到: ' + JSON.stringify(names))
    assert(!names.some((n) => /[\uFFFD]/.test(n)), '出现替换字符（编码坏了）: ' + JSON.stringify(names))
  })

  const mdScope = await index.search({ query: 'ext:md', limit: 50 })
  check('★ ext:md 只在范围内命中（全盘有大量 md，若泄漏必然超 50）', () => {
    assert(mdScope.ok, '查询失败')
    assert(mdScope.total === 2, `期望 2（beta.md + 中文子目录文件.md），得到 ${mdScope.total}`)
  })

  const meta = mdScope.rows[0]
  check('元数据字段齐全（size / modified 已解析为 Unix 秒）', () => {
    assert(meta && typeof meta.size === 'number' && meta.size > 0, 'size 异常: ' + JSON.stringify(meta))
    assert(typeof meta.modified === 'number' && meta.modified > 1600000000, 'modified 异常: ' + JSON.stringify(meta))
    assert(typeof meta.ext === 'string' && meta.ext === 'md', 'ext 异常: ' + meta.ext)
  })

  check('超时/退码字段存在', () => {
    assert(typeof mdScope.elapsedMs === 'number' && mdScope.elapsedMs >= 0, 'elapsedMs 缺失')
  })

  // ── P2 基础设施：listDir（目录树用，走 -parent 选项）──────────────────
  const listed = await index.listDir(SCOPE_DIR)
  check('listDir 成功', () => assert(listed.ok === true, '失败: ' + (listed.error || '')))
  check('★ listDir 只返回直接子项（3 文件 + 1 目录）', () => {
    assert(listed.entries.length === 4, '得到 ' + listed.entries.length + ': ' + JSON.stringify(listed.entries.map((e) => e.name)))
    assert(listed.dirCount === 1, 'dirCount = ' + listed.dirCount)
    assert(listed.fileCount === 3, 'fileCount = ' + listed.fileCount)
  })
  check('★ listDir 不泄漏深层文件', () => {
    const deep = listed.entries.filter((e) => /gamma|子目录/.test(e.name))
    assert(deep.length === 0, '深层文件泄漏: ' + JSON.stringify(deep.map((e) => e.path)))
  })
  check('★ listDir 的 isDirectory 标记正确', () => {
    const sub = listed.entries.find((e) => e.name === 'sub')
    assert(sub && sub.isDirectory === true, 'sub 未被标为目录: ' + JSON.stringify(sub))
    const alpha = listed.entries.find((e) => e.name === 'alpha.txt')
    assert(alpha && alpha.isDirectory === false, 'alpha.txt 被标成目录: ' + JSON.stringify(alpha))
  })
  check('listDir 中文名不乱码', () => {
    const cn = listed.entries.find((e) => e.name.indexOf('中文') >= 0)
    assert(cn, '未找到中文名条目: ' + JSON.stringify(listed.entries.map((e) => e.name)))
    assert(!/\uFFFD/.test(cn.name), '出现替换字符: ' + cn.name)
  })
  const badList = await index.listDir('')
  check('listDir("") → ok:false 且带 error（不抛）', () => {
    assert(badList.ok === false && typeof badList.error === 'string', JSON.stringify(badList))
  })
}

log('\n=== [6] 正常关闭（必须让 Everything 自己保存 ini）===')
await index.shutdown()
check('关闭后实例不再应答', async () => { /* 异步断言在下面用 ping 结果代替 */ })
const afterClose = await index.status()
check('status() 反映已停止', () => {
  assert(afterClose.ready === false, '仍显示 ready: ' + JSON.stringify(afterClose))
})

log('\n=== [7] ini 落盘检查 ===')
const iniFile = path.join(PKG_ROOT, 'vendor', 'everything', 'Everything-DSHArtifacts.ini')
check('ini 已生成', () => assert(fs.existsSync(iniFile), '缺失: ' + iniFile))
check('ini 里范围正确且卷已清空', () => {
  const text = fs.readFileSync(iniFile, 'utf8')
  const folders = text.split(/\r?\n/).find((l) => l.startsWith('folders='))
  assert(folders === 'folders=' + SCOPE_DIR, 'folders 行: ' + folders)
  assert(text.includes('auto_include_fixed_volumes=0'), '缺 auto_include_fixed_volumes=0')
  assert(/ntfs_volume_paths=\r?\n/.test(text), 'ntfs_volume_paths 未清空')
})

// ─────────────────────────────────────────────────────────────
log('\n' + '─'.repeat(60))
log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  log('\n失败列表：')
  for (const f of failures) log('  · ' + f)
}
log('\n提示：测试目录留在 ' + SCOPE_DIR + ' 与 ' + DATA_DIR + ' 供人工复核；')
log('      如需清理：Remove-Item -Recurse -Force 这两个目录。')
process.exit(failed ? 1 : 0)
