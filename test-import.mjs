// 验证 importFolder 异步防卡死 + 智能跳过（临时目录，不碰真实库）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArtifactStore } from './lib/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-import-test-'))
// 构造测试目录结构
fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
fs.mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true })
fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true })
fs.mkdirSync(path.join(root, 'Default', 'Extensions', 'abc'), { recursive: true })
fs.mkdirSync(path.join(root, 'component_crx_cache'), { recursive: true })
fs.writeFileSync(path.join(root, 'docs', 'readme.md'), '# hello docs')
fs.writeFileSync(path.join(root, 'docs', 'sub', 'notes.txt'), 'sub notes')
fs.writeFileSync(path.join(root, 'docs', 'big.bin'), Buffer.alloc(60 * 1024 * 1024)) // 60MB > 50MB 上限
fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x')
fs.writeFileSync(path.join(root, '.git', 'config'), 'x')
fs.writeFileSync(path.join(root, 'Default', 'Extensions', 'abc', 'manifest.json'), '{}')
fs.writeFileSync(path.join(root, 'component_crx_cache', 'f081de18a604e'), 'crx-binary')
fs.writeFileSync(path.join(root, 'desktop.ini'), 'x')

const store = new ArtifactStore(path.join(root, 'data')).load()
const t0 = Date.now()
const result = await store.importFolder(root, { project: 'test-proj' })
const ms = Date.now() - t0
console.log(`import done in ${ms}ms:`, JSON.stringify(result))
const imported = store.items.filter((r) => r.source === 'folder-import')
console.log(`imported: ${imported.length} (期望 2: readme.md + notes.txt)`)
for (const r of imported) console.log('  ', r.filename, '|', r.project, '| tags:', r.tags.join(','))
const paths = imported.map((r) => r.path)
const ok = imported.length === 2
  && paths.some((p) => p.endsWith('readme.md'))
  && paths.some((p) => p.endsWith('notes.txt'))
  && !paths.some((p) => p.includes('node_modules'))
  && !paths.some((p) => p.includes('.git'))
  && !paths.some((p) => p.includes('Default'))
  && !paths.some((p) => p.includes('component_crx_cache'))
  && !paths.some((p) => p.endsWith('big.bin'))
  && !paths.some((p) => p.endsWith('desktop.ini'))
console.log(ok ? '✅ 跳过逻辑正确：node_modules/.git/浏览器缓存/超大文件/系统文件都没进来' : '❌ 跳过逻辑有误')
console.log(`skipped=${result.skipped}（期望 ≥5：node_modules+git+Default+crx_cache+desktop.ini+big.bin 目录级跳过计 skipped）`)

// 清理
fs.rmSync(root, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
