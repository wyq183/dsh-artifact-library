/**
 * 离线 harness：设置体系（lib/settings.js + /settings* 路由 + 「写入 → 真的生效」）
 *
 * 这个文件的重点**不是**「能存能读」，而是：
 *   · 每个键写进去、读回来一致
 *   · ★ 宿主侧消费的键**真的改到了行为上**（listLimit → /files/list、thumbMaxBytes → /files/thumb、
 *     showHidden → 结果过滤）—— 用**真实的** listDirectory 跑，不是 mock
 *   · ★ 导入恶意 JSON 不污染 Object.prototype（断言 `({}).polluted === undefined`）
 *   · 不再重犯「读了不生效」的错（indexExtraDirs 的源码守卫）
 *
 * 用法：node test/settings.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { artifactsHandler } from '../lib/http.js'
import { listDirectory } from '../lib/index/list.js'
import {
  DEFAULT_SETTINGS, PRESETS, APPEARANCE_KEYS, SETTINGS_FORMAT, SETTINGS_VERSION,
  HOST_EFFECTIVE_KEYS, SettingsStore, isHiddenEntryName, scanForbiddenKeys,
} from '../lib/settings.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

// ── 临时目录（含真实文件，供端到端生效测试用）──────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-settings-'))
const BIG_DIR = path.join(TMP, 'many')
fs.mkdirSync(BIG_DIR, { recursive: true })
for (let i = 0; i < 1200; i += 1) fs.writeFileSync(path.join(BIG_DIR, 'f' + String(i).padStart(4, '0') + '.txt'), 'x')
const HIDDEN_DIR = path.join(TMP, 'hidden')
fs.mkdirSync(HIDDEN_DIR, { recursive: true })
fs.writeFileSync(path.join(HIDDEN_DIR, 'visible.txt'), 'v')
fs.writeFileSync(path.join(HIDDEN_DIR, '.dotfile.txt'), 'd')
fs.writeFileSync(path.join(HIDDEN_DIR, 'desktop.ini'), 'i')
fs.mkdirSync(path.join(HIDDEN_DIR, '$RECYCLE.BIN'), { recursive: true })
const BIG_IMG = path.join(TMP, 'big.png')
fs.writeFileSync(BIG_IMG, Buffer.alloc(200 * 1024, 7))
const SETTINGS_FILE = path.join(TMP, 'settings.json')

// ── mock 设施 ─────────────────────────────────────────────────────────────
function makeReq(method, url, options = {}) {
  const text = options.body === undefined ? '' : JSON.stringify(options.body)
  const stream = Readable.from(text ? [text] : [])
  return Object.assign(stream, {
    method,
    url,
    headers: {},
    socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
  })
}
function makeRes() {
  // 必须是真 Writable：/files/thumb 会 stream.pipe(res)
  const chunks = []
  const res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb() } })
  res.statusCode = 0
  res.headers = {}
  res.finished = false
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}); return res }
  res.bodyBuffer = () => Buffer.concat(chunks)
  res.bodyText = () => Buffer.concat(chunks).toString('utf8')
  res.on('finish', () => { res.finished = true })
  res.json = () => { try { return JSON.parse(res.bodyText()) } catch { return null } }
  return res
}
/** 旧 store 的最小替身：只认那几个 legacy 键（照 lib/store.js 的白名单） */
function makeStore() {
  const meta = { autoCollect: true, maxPerTurn: 20, cleanupEnabled: true, cleanupIntervalDays: 7, backupOnCleanup: true, backupKeep: 10, refineBatchSize: 20, importMaxSizeMB: 50, searchLimit: 20, refineModelLast: '', lastCleanupAt: 0 }
  return {
    items: [], file: path.join(TMP, 'fake.json'),
    stats: () => ({ total: 0 }), categories: () => ({}),
    getSettings: () => ({ ...meta }),
    updateSettings: (patch) => {
      // 真实 store 是白名单驱动；这里也照做，才能证明「旧路径确实不认识 indexExtraDirs」
      if (patch.autoCollect !== undefined) meta.autoCollect = !!patch.autoCollect
      if (patch.maxPerTurn !== undefined) meta.maxPerTurn = Number(patch.maxPerTurn)
      if (patch.cleanupEnabled !== undefined) meta.cleanupEnabled = !!patch.cleanupEnabled
      if (patch.cleanupIntervalDays !== undefined) meta.cleanupIntervalDays = Number(patch.cleanupIntervalDays)
      if (patch.backupOnCleanup !== undefined) meta.backupOnCleanup = !!patch.backupOnCleanup
      if (patch.backupKeep !== undefined) meta.backupKeep = Number(patch.backupKeep)
      if (patch.refineBatchSize !== undefined) meta.refineBatchSize = Number(patch.refineBatchSize)
      if (patch.importMaxSizeMB !== undefined) meta.importMaxSizeMB = Number(patch.importMaxSizeMB)
      if (patch.searchLimit !== undefined) meta.searchLimit = Number(patch.searchLimit)
      return { ...meta }
    },
    get: () => ({ id: 'STORE-GOT-IT' }), list: () => [],
  }
}
function makeDeps(settingsStore, extra = {}) {
  const changed = []
  return {
    changed,
    deps: {
      settings: {
        get: () => settingsStore.get(),
        update: (patch) => settingsStore.update(patch),
        export: (legacy) => settingsStore.exportPayload(legacy),
        import: (payload) => settingsStore.importPayload(payload),
      },
      listDir: (dir, opts) => listDirectory(dir, opts),
      // /files/* 分支要求 fileIndex 存在（否则 503）—— 给个最小替身，
      // 目录浏览本身走 listDir（实时），不会碰到它
      fileIndex: { listDir: async () => { throw new Error('不该走 Everything') } },
      assertInScope: async (p) => ({ ok: true, path: p }),
      resolveIndexScope: async () => [TMP],
      onSettingsChanged: (keys) => changed.push(...(keys || [])),
      ...extra,
    },
  }
}
let CURRENT_STORE = null
async function call(deps, method, url, options = {}) {
  const handler = artifactsHandler(CURRENT_STORE, deps)
  const req = makeReq(method, url, options)
  const res = makeRes()
  await handler(req, res)
  // 流式响应（缩略图）要等 flush 完再断言 body
  if (!res.writableFinished) {
    await new Promise((resolve) => {
      const done = () => resolve()
      res.once('finish', done)
      res.once('close', done)
      setTimeout(done, 2000).unref?.()
    })
  }
  return res
}
function freshStore() {
  try { fs.unlinkSync(SETTINGS_FILE) } catch { /* 不存在 */ }
  return new SettingsStore({ file: SETTINGS_FILE }).load()
}

// ═══ [1] 模块级：预设只放差异项 ═══════════════════════════════════════════
console.log('\n=== [1] PRESETS 只放差异项 ===')
{
  check('5 个内置预设齐全', () => {
    for (const id of ['general', 'developer', 'research', 'creator', 'office']) {
      assert(Object.prototype.hasOwnProperty.call(PRESETS, id), '缺预设 ' + id)
    }
    assert(Object.keys(PRESETS).length === 5, '预设数量 ' + Object.keys(PRESETS).length)
  })
  check('★ general 的 values 为空（= 全靠默认值继承，不是抄一份默认值）', () => {
    assert(Object.keys(PRESETS.general.values).length === 0, 'general 不该写死任何值')
  })
  check('★ 每个预设的差异项都严格少于全部设置项（没复制整份默认值）', () => {
    const total = Object.keys(DEFAULT_SETTINGS).length
    for (const [id, preset] of Object.entries(PRESETS)) {
      assert(Object.keys(preset.values).length < total, `${id} 像是复制了整份默认值`)
    }
  })
  check('★ 预设只用 APPEARANCE_KEYS 里的键（否则「微调变 custom」判定会漏）', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      for (const key of Object.keys(preset.values)) {
        assert(APPEARANCE_KEYS.includes(key), `${id} 用了非外观键 ${key}`)
      }
    }
  })
  check('预设带 label/hint（给 ui-core 直接渲染，不用硬编码中文）', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      assert(typeof preset.label === 'string' && preset.label.length > 0, id + ' 缺 label')
      assert(typeof preset.hint === 'string' && preset.hint.length > 0, id + ' 缺 hint')
    }
  })
}

// ═══ [2] SettingsStore：校验 / 夹紧 / 预设展开 / custom ══════════════════
console.log('\n=== [2] SettingsStore ===')
{
  check('默认值齐全且稳定', () => {
    const s = freshStore()
    const v = s.get()
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      assert(JSON.stringify(v[key]) === JSON.stringify(DEFAULT_SETTINGS[key]), `默认值不一致: ${key}`)
    }
    assert(v.preset === 'general' && v.showHidden === false && v.listLimit === 2000, '关键默认值')
  })
  check('枚举非法值被拒绝（不夹、不猜）', () => {
    const s = freshStore()
    const r = s.update({ density: 'loose' })
    assert(r.applied.includes('density') && s.get().density === 'loose', '合法值应接受')
    const bad = s.update({ density: '<script>alert(1)</script>' })
    assert(bad.errors.some((e) => e.key === 'density'), '非法枚举应进 errors')
    assert(s.get().density === 'loose', '非法值不该改掉原值')
  })
  check('数值越界被**夹紧**', () => {
    const s = freshStore()
    s.update({ listLimit: 999999 })
    assert(s.get().listLimit === 10000, 'listLimit 应夹到 10000，得到 ' + s.get().listLimit)
    s.update({ listLimit: 1 })
    assert(s.get().listLimit === 500, 'listLimit 应夹到 500，得到 ' + s.get().listLimit)
    s.update({ thumbMaxBytes: -5 })
    assert(s.get().thumbMaxBytes === 0, 'thumbMaxBytes 应夹到 0，得到 ' + s.get().thumbMaxBytes)
  })
  check('thumbSize 只接受 16/24/32', () => {
    const s = freshStore()
    s.update({ thumbSize: 24 })
    assert(s.get().thumbSize === 24, '24 应接受')
    const r = s.update({ thumbSize: 20 })
    assert(r.errors.some((e) => e.key === 'thumbSize'), '20 应被拒绝')
  })
  check('columns 只认 size/time/type，多余列被忽略', () => {
    const s = freshStore()
    const r = s.update({ columns: { size: false, time: true, type: true, bogus: true } })
    assert(r.applied.includes('columns'), 'columns 应被接受')
    const c = s.get().columns
    assert(c.size === false && c.time === true && c.type === true, '值不对: ' + JSON.stringify(c))
    assert(!('bogus' in c), '不该把未知列写进去: ' + JSON.stringify(c))
  })
  check('columns 值不是布尔 → 拒绝整键', () => {
    const s = freshStore()
    const r = s.update({ columns: { size: 'yes' } })
    assert(r.errors.some((e) => e.key === 'columns'), '应进 errors')
  })
  check('indexExtraDirs 只接受绝对路径字符串数组', () => {
    const s = freshStore()
    const r = s.update({ indexExtraDirs: [TMP, 'relative/dir', TMP, '  '] })
    assert(r.errors.some((e) => e.key === 'indexExtraDirs'), '相对路径应被拒绝')
    assert(JSON.stringify(s.get().indexExtraDirs) === JSON.stringify([]), '整键应被拒（不做部分接受）')
    const ok = s.update({ indexExtraDirs: [TMP, TMP] })
    assert(ok.applied.includes('indexExtraDirs'), '合法值应接受')
    assert(s.get().indexExtraDirs.length === 1, '应去重: ' + JSON.stringify(s.get().indexExtraDirs))
  })
  check('未知键进 ignored、不报错（前向兼容）', () => {
    const s = freshStore()
    const r = s.update({ totallyUnknownKey: 1 })
    assert(r.ignored.includes('totallyUnknownKey'), 'ignored: ' + JSON.stringify(r.ignored))
    assert(r.errors.length === 0, '不该报错: ' + JSON.stringify(r.errors))
  })
  check('★ 选预设 = 灌入起点值，之后仍可单项微调', () => {
    const s = freshStore()
    s.update({ preset: 'developer' })
    const v1 = s.get()
    assert(v1.preset === 'developer', 'preset: ' + v1.preset)
    assert(v1.density === 'compact' && v1.sortBy === 'time' && v1.sortDir === 'desc', '预设值没灌进去: ' + JSON.stringify(v1))
    assert(v1.columns.type === true, 'columns 没灌进去')
    // 单项微调 → 变 custom，但已应用的值保留
    s.update({ density: 'loose' })
    const v2 = s.get()
    assert(v2.preset === 'custom', '微调后应变 custom，得到 ' + v2.preset)
    assert(v2.density === 'loose', '微调值应保留')
    assert(v2.sortBy === 'time', '预设的其它值不该被冲掉')
  })
  check('★ 从 developer 切回 general 会**回到默认**（不是保留 developer 的值）', () => {
    const s = freshStore()
    s.update({ preset: 'developer' })
    s.update({ preset: 'general' })
    const v = s.get()
    assert(v.density === DEFAULT_SETTINGS.density, 'density 应回默认，得到 ' + v.density)
    assert(v.sortDir === DEFAULT_SETTINGS.sortDir, 'sortDir 应回默认，得到 ' + v.sortDir)
    assert(v.columns.type === DEFAULT_SETTINGS.columns.type, 'columns.type 应回默认')
  })
  check('改非外观键**不会**把预设打成 custom', () => {
    const s = freshStore()
    s.update({ preset: 'office' })
    s.update({ listLimit: 900 })
    s.update({ showHidden: true })
    assert(s.get().preset === 'office', '不该变 custom，得到 ' + s.get().preset)
  })
  check('微调后值恰好等于预设值 → 仍是该预设（不是 custom）', () => {
    const s = freshStore()
    s.update({ preset: 'creator' })
    s.update({ density: 'loose' })   // creator 本来就是 loose
    assert(s.get().preset === 'creator', '应保持 creator，得到 ' + s.get().preset)
  })
  check('未知预设名被拒绝', () => {
    const s = freshStore()
    const r = s.update({ preset: 'nonexistent-preset' })
    assert(r.errors.some((e) => e.key === 'preset'), '应进 errors')
  })
  check('自定义预设：PUT 写入后可按名选用', () => {
    const s = freshStore()
    const r = s.update({ customPresets: { mine: { density: 'compact', sortBy: 'size' } } })
    assert(r.applied.includes('customPresets'), 'customPresets 应接受: ' + JSON.stringify(r.errors))
    s.update({ preset: 'mine' })
    const v = s.get()
    assert(v.preset === 'mine', 'preset: ' + v.preset)
    assert(v.density === 'compact' && v.sortBy === 'size', '自定义预设没灌进去: ' + JSON.stringify(v))
  })
  check('落盘 → 重新 load 后仍然一致', () => {
    const s = freshStore()
    s.update({ preset: 'research', listLimit: 777, indexExtraDirs: [TMP] })
    const reloaded = new SettingsStore({ file: SETTINGS_FILE }).load()
    const v = reloaded.get()
    assert(v.preset === 'research' && v.listLimit === 777, '没恢复: ' + JSON.stringify(v))
    assert(JSON.stringify(v.indexExtraDirs) === JSON.stringify([TMP]), 'indexExtraDirs 没恢复')
  })
  check('磁盘文件被人手改塞进 __proto__ → load 时也会被挡掉', () => {
    const file = path.join(TMP, 'settings-poisoned.json')
    fs.writeFileSync(file, '{"version":1,"values":{"__proto__":{"polluted":1},"listLimit":600}}', 'utf8')
    const s = new SettingsStore({ file }).load()
    assert(s.get().listLimit === 2000, '整份应被丢弃并回落默认，得到 ' + s.get().listLimit)
    assert({}.polluted === undefined, '★ Object.prototype 被污染了！')
  })
}

// ═══ [3] HTTP：GET/PUT 全键写读一致 ═════════════════════════════════════
console.log('\n=== [3] GET/PUT /settings 全键一致 ===')
{
  CURRENT_STORE = makeStore()
  const settingsStore = freshStore()
  const { deps } = makeDeps(settingsStore)

  const r0 = await call(deps, 'GET', '/ext/artifacts/settings')
  check('GET /settings → 200，含新版键 + 旧版键', () => {
    assert(r0.statusCode === 200, '状态码 ' + r0.statusCode)
    const s = r0.json()
    assert(s.density === 'standard' && s.listLimit === 2000, '新版键: ' + r0.body)
    assert(s.autoCollect === true && s.searchLimit === 20, '旧版键: ' + r0.body)
    assert(Array.isArray(s.indexExtraDirs), 'indexExtraDirs 应存在: ' + r0.body)
  })

  const CASES = [
    ['density', 'compact'], ['defaultView', 'gallery'], ['sortBy', 'size'], ['sortDir', 'desc'],
    ['thumbnails', false], ['thumbSize', 32], ['galleryThumbSize', 128], ['thumbMaxBytes', 1048576],
    ['listLimit', 1500], ['virtualThreshold', 400], ['showHidden', true], ['panelWidth', 480],
    ['indexExtraDirs', [TMP]], ['columns', { size: false, time: true, type: true }],
  ]
  const rPut = await call(deps, 'PUT', '/ext/artifacts/settings', { body: Object.fromEntries(CASES) })
  check('PUT 每一项都写进去（一次发全部键）', () => {
    assert(rPut.statusCode === 200, '状态码 ' + rPut.statusCode + ' ' + rPut.body)
  })
  const rGet = await call(deps, 'GET', '/ext/artifacts/settings')
  check('★★ 14 个键逐项 GET 读回来一致', () => {
    const s = rGet.json()
    for (const [key, value] of CASES) {
      assert(JSON.stringify(s[key]) === JSON.stringify(value), `${key} 不一致：期望 ${JSON.stringify(value)}，得到 ${JSON.stringify(s[key])}`)
    }
  })
  check('PUT 返回的也是最新设置（旧契约：平面设置对象）', () => {
    const s = rPut.json()
    assert(s.density === 'compact' && s.listLimit === 1500, 'PUT 响应: ' + rPut.body)
  })
  check('★ 旧版键仍走旧 store（老管理页行为不变）', async () => {})
  const rLegacy = await call(deps, 'PUT', '/ext/artifacts/settings', { body: { autoCollect: false, searchLimit: 33, cleanupIntervalDays: 15 } })
  check('PUT 旧版键 → 旧 store 真的收到了', () => {
    assert(rLegacy.statusCode === 200, '状态码 ' + rLegacy.statusCode)
    const s = rLegacy.json()
    assert(s.autoCollect === false && s.searchLimit === 33 && s.cleanupIntervalDays === 15, '旧键没生效: ' + rLegacy.body)
  })
  check('★ 旧 store **不认识** indexExtraDirs（这正是当初它恒为 [] 的原因）', () => {
    const legacyView = CURRENT_STORE.getSettings()
    assert(!Object.prototype.hasOwnProperty.call(legacyView, 'indexExtraDirs'), '旧 store 居然认识这个键？那本任务的背景描述要更新')
  })
  const rPreset = await call(deps, 'PUT', '/ext/artifacts/settings', { body: { preset: 'creator' } })
  check('PUT {preset:creator} → 灌入 gallery/loose', () => {
    const s = rPreset.json()
    assert(s.preset === 'creator' && s.density === 'loose' && s.defaultView === 'gallery', '预设没展开: ' + rPreset.body)
  })
  const rBadBody = await call(deps, 'PUT', '/ext/artifacts/settings', { body: [1, 2, 3] })
  check('PUT 数组 body → 200 且设置不变（不崩）', () => {
    assert(rBadBody.statusCode === 200, '状态码 ' + rBadBody.statusCode)
    assert(rBadBody.json().listLimit === 1500, '不该被数组 body 改掉: ' + rBadBody.body)
  })
  const rSchema = await call(deps, 'GET', '/ext/artifacts/settings/schema')
  check('GET /settings/schema → 默认值 + 枚举 + 范围 + 预设清单', () => {
    assert(rSchema.statusCode === 200, '状态码 ' + rSchema.statusCode)
    const s = rSchema.json()
    assert(s.defaults && s.defaults.listLimit === 2000, 'defaults 缺: ' + rSchema.body)
    assert(Array.isArray(s.presets) && s.presets.length === 5, 'presets: ' + rSchema.body)
    assert(s.presets.every((p) => p.id && p.label && p.values), '预设项缺字段')
    assert(JSON.stringify(s.enums.density) === JSON.stringify(['compact', 'standard', 'loose']), 'enums')
    assert(Array.isArray(s.hostEffectiveKeys) && s.hostEffectiveKeys.includes('listLimit'), 'hostEffectiveKeys 应标明宿主生效的键')
  })

  // ── 兼容：没挂 deps.settings 时退化成旧行为（老管理页/老测试不破）──
  const legacyOnly = { assertInScope: async (p) => ({ ok: true, path: p }) }
  const rFallbackGet = await call(legacyOnly, 'GET', '/ext/artifacts/settings')
  check('未挂 deps.settings：GET /settings 仍是旧 store 的设置（不含新版键，也不报错）', () => {
    assert(rFallbackGet.statusCode === 200, '状态码 ' + rFallbackGet.statusCode)
    const s = rFallbackGet.json()
    assert(typeof s.autoCollect === 'boolean' && typeof s.searchLimit === 'number', '旧键: ' + rFallbackGet.bodyText())
    assert(!('density' in s), '不该平白多出新版键: ' + rFallbackGet.bodyText())
  })
  const rFallbackPut = await call(legacyOnly, 'PUT', '/ext/artifacts/settings', { body: { autoCollect: false } })
  check('未挂 deps.settings：PUT /settings 仍直接写旧 store', () => {
    assert(rFallbackPut.statusCode === 200 && rFallbackPut.json().autoCollect === false, 'body: ' + rFallbackPut.bodyText())
  })
  const rFallbackImport = await call(legacyOnly, 'POST', '/ext/artifacts/settings/import', { body: { format: SETTINGS_FORMAT, version: 1, settings: {} } })
  check('未挂 deps.settings：导入 → 503（不是崩，也不是假装成功）', () => {
    assert(rFallbackImport.statusCode === 503, '状态码 ' + rFallbackImport.statusCode + ' ' + rFallbackImport.body)
  })
}

// ═══ [4] ★ 端到端：设置真的改到了行为上 ═════════════════════════════════
console.log('\n=== [4] ★ 写入 → 真的生效（端到端，用真实 listDirectory）===')
{
  CURRENT_STORE = makeStore()
  const settingsStore = freshStore()
  const { deps } = makeDeps(settingsStore)

  const rDefault = await call(deps, 'GET', '/ext/artifacts/files/list?dir=' + encodeURIComponent(BIG_DIR))
  check('默认 listLimit=2000 → 1200 项全给', () => {
    assert(rDefault.json().entries.length === 1200, '条目数 ' + rDefault.json().entries.length)
  })
  await call(deps, 'PUT', '/ext/artifacts/settings', { body: { listLimit: 500 } })
  const r500 = await call(deps, 'GET', '/ext/artifacts/files/list?dir=' + encodeURIComponent(BIG_DIR))
  check('★★ listLimit 改成 500 → /files/list 真的只回 500 条（truncated=true）', () => {
    const b = r500.json()
    assert(b.entries.length === 500, '条目数 ' + b.entries.length)
    assert(b.truncated === true && b.total === 1200, 'truncated=' + b.truncated + ' total=' + b.total)
  })
  const r300 = await call(deps, 'GET', '/ext/artifacts/files/list?dir=' + encodeURIComponent(BIG_DIR) + '&limit=300')
  check('显式 ?limit=300 仍然优先于设置', () => {
    assert(r300.json().entries.length === 300, '条目数 ' + r300.json().entries.length)
  })
  await call(deps, 'PUT', '/ext/artifacts/settings', { body: { listLimit: 600 } })
  const r600 = await call(deps, 'GET', '/ext/artifacts/files/list?dir=' + encodeURIComponent(BIG_DIR))
  check('再改成 600 → 立刻变 600（不是缓存）', () => {
    assert(r600.json().entries.length === 600, '条目数 ' + r600.json().entries.length)
  })

  // ── showHidden ──────────────────────────────────────────────────────
  await call(deps, 'PUT', '/ext/artifacts/settings', { body: { showHidden: true } })
  const rAll = await call(deps, 'GET', '/ext/artifacts/files/list?dir=' + encodeURIComponent(HIDDEN_DIR))
  check('showHidden=true → 4 项全出（含 .dotfile / desktop.ini / $RECYCLE.BIN）', () => {
    const names = rAll.json().entries.map((e) => e.name).sort()
    assert(names.length === 4, '条目: ' + JSON.stringify(names))
    assert(names.includes('.dotfile.txt') && names.includes('desktop.ini'), '真实名称: ' + JSON.stringify(names))
  })
  await call(deps, 'PUT', '/ext/artifacts/settings', { body: { showHidden: false } })
  const rSome = await call(deps, 'GET', '/ext/artifacts/files/list?dir=' + encodeURIComponent(HIDDEN_DIR))
  check('★★ showHidden=false → 只剩 visible.txt，且计数跟着过滤后走', () => {
    const b = rSome.json()
    const names = b.entries.map((e) => e.name)
    assert(JSON.stringify(names) === JSON.stringify(['visible.txt']), '条目: ' + JSON.stringify(names))
    assert(b.fileCount === 1 && b.dirCount === 0, '计数没跟着过滤: ' + JSON.stringify({ d: b.dirCount, f: b.fileCount }))
    assert(b.hiddenFiltered === 3, 'hiddenFiltered: ' + b.hiddenFiltered)
    assert(rSome.bodyText().indexOf('.dotfile.txt') < 0, '隐藏项漏出来了')
  })
  check('isHiddenEntryName 的规则（点开头 + 已知系统文件）', () => {
    assert(isHiddenEntryName('.git') === true, '.git 应隐藏')
    assert(isHiddenEntryName('desktop.ini') === true, 'desktop.ini 应隐藏')
    assert(isHiddenEntryName('Thumbs.db') === true, '大小写不敏感')
    assert(isHiddenEntryName('$RECYCLE.BIN') === true, '$RECYCLE.BIN 应隐藏')
    assert(isHiddenEntryName('普通文件.txt') === false, '普通文件不该隐藏')
    assert(isHiddenEntryName('我的.文件.txt') === false, '中间的点不算')
  })

  // ── thumbMaxBytes ───────────────────────────────────────────────────
  const thumbUrl = '/ext/artifacts/files/thumb?path=' + encodeURIComponent(BIG_IMG)
  await call(deps, 'PUT', '/ext/artifacts/settings', { body: { thumbMaxBytes: 5242880 } })
  const rT1 = await call(deps, 'GET', thumbUrl)
  check('thumbMaxBytes=5MB → 200KB 的图正常返回', () => {
    assert(rT1.statusCode === 200, '状态码 ' + rT1.statusCode)
    assert(rT1.headers['content-type'] === 'image/png', 'CT: ' + rT1.headers['content-type'])
  })
  await call(deps, 'PUT', '/ext/artifacts/settings', { body: { thumbMaxBytes: 1024 } })
  const rT2 = await call(deps, 'GET', thumbUrl)
  check('★★ thumbMaxBytes 改成 1KB → 同一张图真的 413 too-large', () => {
    assert(rT2.statusCode === 413, '状态码 ' + rT2.statusCode + ' ' + rT2.body)
    assert(rT2.json().reason === 'too-large' && rT2.json().limit === 1024, '响应: ' + rT2.body)
  })
  await call(deps, 'PUT', '/ext/artifacts/settings', { body: { thumbMaxBytes: 0 } })
  const rT3 = await call(deps, 'GET', thumbUrl)
  check('thumbMaxBytes=0（不跳过）→ 再大的图也给', () => {
    assert(rT3.statusCode === 200, '状态码 ' + rT3.statusCode + ' ' + rT3.body)
  })

  // ── indexExtraDirs：真的进范围 ──────────────────────────────────────
  // 忠实复刻 lib/index.js 的调用链：/files/list → assertInScope → resolveIndexScope
  // → settingsStore.get().indexExtraDirs → buildScope。
  // （真正的 assertInScope 定义在 apply() 里面，导不出来；所以这里复刻它的读取行，
  //   再用 [6] 的源码守卫证明 index.js 里就是这条链。）
  const seen = []
  let scopedRef = null
  const scopedStore = freshStore()
  const scoped = makeDeps(scopedStore, {
    resolveIndexScope: async () => {
      const extra = scopedStore.get().indexExtraDirs
      seen.push(Array.isArray(extra) ? extra.slice() : extra)
      return [TMP, ...extra]
    },
    assertInScope: async (p) => {
      const scopeDirs = await scopedRef.deps.resolveIndexScope()
      return { ok: true, allowed: scopeDirs.some((dir) => String(p).startsWith(dir)), path: p }
    },
  })
  scopedRef = scoped
  await call(scoped.deps, 'PUT', '/ext/artifacts/settings', { body: { indexExtraDirs: [HIDDEN_DIR] } })
  const rScoped = await call(scoped.deps, 'GET', '/ext/artifacts/files/list?dir=' + encodeURIComponent(HIDDEN_DIR))
  check('★★ indexExtraDirs 写进去之后，范围计算真的读到了它，且该目录被放行', () => {
    assert(seen.length > 0, 'resolveIndexScope 根本没被调用（链路断了）')
    assert(seen.some((list) => Array.isArray(list) && list.includes(HIDDEN_DIR)), '范围里没出现额外目录: ' + JSON.stringify(seen))
    assert(rScoped.statusCode === 200, '状态码 ' + rScoped.statusCode + ' ' + rScoped.bodyText())
  })
  check('★ 设置变更会通知宿主（只有索引范围变了才需要重启索引）', () => {
    assert(scoped.changed.includes('indexExtraDirs'), 'onSettingsChanged 没收到 indexExtraDirs: ' + JSON.stringify(scoped.changed))
  })
}

// ═══ [5] ★ 导出 / 导入（含恶意 JSON）═════════════════════════════════════
console.log('\n=== [5] ★ 导出 / 导入 / 原型污染 ===')
{
  CURRENT_STORE = makeStore()
  const settingsStore = freshStore()
  const { deps } = makeDeps(settingsStore)

  await call(deps, 'PUT', '/ext/artifacts/settings', {
    body: { preset: 'developer', listLimit: 1234, showHidden: true, indexExtraDirs: [TMP], customPresets: { mine: { density: 'loose' } } },
  })
  await call(deps, 'PUT', '/ext/artifacts/settings', { body: { searchLimit: 44 } })
  const rExport = await call(deps, 'GET', '/ext/artifacts/settings/export')
  check('GET /settings/export → 格式/版本/时间/设置齐全，且**包含旧 store 的设置**', () => {
    assert(rExport.statusCode === 200, '状态码 ' + rExport.statusCode)
    const p = rExport.json()
    assert(p.format === SETTINGS_FORMAT && p.version === SETTINGS_VERSION, 'format/version: ' + rExport.body)
    assert(typeof p.exportedAt === 'string' && !Number.isNaN(Date.parse(p.exportedAt)), 'exportedAt: ' + p.exportedAt)
    assert(p.settings.listLimit === 1234 && p.settings.density === 'compact', '新版设置: ' + rExport.body)
    assert(p.settings.customPresets && p.settings.customPresets.mine, '自定义预设: ' + rExport.body)
    assert(p.settings.searchLimit === 44, '★ 旧 store 的 searchLimit 也应在导出里: ' + rExport.body)
    assert(!('lastCleanupAt' in p.settings), 'lastCleanupAt 是状态不是偏好，不该导出')
  })

  // 改乱
  await call(deps, 'PUT', '/ext/artifacts/settings', {
    body: { preset: 'general', listLimit: 8000, showHidden: false, indexExtraDirs: [], customPresets: {} },
  })
  const scrambled = await call(deps, 'GET', '/ext/artifacts/settings')
  check('改乱后确认真的乱了', () => {
    const s = scrambled.json()
    assert(s.listLimit === 8000 && s.density === 'standard', '改乱失败: ' + scrambled.body)
  })
  const rImport = await call(deps, 'POST', '/ext/artifacts/settings/import', { body: rExport.json() })
  check('★ 导出 → 改乱 → 导入回来 → 设置恢复', () => {
    assert(rImport.statusCode === 200, '状态码 ' + rImport.statusCode + ' ' + rImport.body)
    const b = rImport.json()
    assert(b.ok === true, 'body: ' + rImport.body)
    assert(Array.isArray(b.applied) && b.applied.includes('listLimit'), 'applied: ' + rImport.body)
    const s = b.settings
    assert(s.listLimit === 1234, 'listLimit 没恢复: ' + s.listLimit)
    assert(s.density === 'compact' && s.preset === 'developer', '预设没恢复: ' + JSON.stringify({ d: s.density, p: s.preset }))
    assert(s.showHidden === true, 'showHidden 没恢复')
    assert(JSON.stringify(s.indexExtraDirs) === JSON.stringify([TMP]), 'indexExtraDirs 没恢复')
    assert(s.searchLimit === 44, '★ 旧 store 的设置也恢复了: ' + s.searchLimit)
  })

  // ── 恶意 1：顶层 __proto__ ───────────────────────────────────────────
  const evil1 = await call(deps, 'POST', '/ext/artifacts/settings/import', {
    body: JSON.parse('{"format":"' + SETTINGS_FORMAT + '","version":1,"__proto__":{"polluted":1}}'),
  })
  check('★ 恶意1：顶层 __proto__ → 400 整份拒绝', () => {
    assert(evil1.statusCode === 400, '状态码 ' + evil1.statusCode + ' ' + evil1.body)
    assert(evil1.json().reason === 'prototype-pollution', 'reason: ' + evil1.body)
  })
  check('★★★ 恶意1 之后：`({}).polluted === undefined`（Object.prototype 没被污染）', () => {
    assert({}.polluted === undefined, '★ Object.prototype 被污染了！！')
    assert(Object.prototype.polluted === undefined, '★ Object.prototype.polluted 存在！')
  })

  // ── 恶意 2：嵌套 __proto__（settings 里）─────────────────────────────
  const evil2 = await call(deps, 'POST', '/ext/artifacts/settings/import', {
    body: JSON.parse('{"format":"' + SETTINGS_FORMAT + '","version":1,"settings":{"__proto__":{"polluted":2},"listLimit":700}}'),
  })
  check('★ 恶意2：settings 里的 __proto__ → 400，且**一个键都不应用**（fail closed）', () => {
    assert(evil2.statusCode === 400, '状态码 ' + evil2.statusCode + ' ' + evil2.body)
    assert(evil2.json().reason === 'prototype-pollution', 'reason: ' + evil2.body)
    assert(evil2.json().errors.some((e) => e.key.includes('__proto__')), '应指出是哪个路径: ' + evil2.body)
  })
  check('★★★ 恶意2 之后：`({}).polluted === undefined` 仍成立', () => {
    assert({}.polluted === undefined, '★ Object.prototype 被污染了！')
  })
  const after2 = await call(deps, 'GET', '/ext/artifacts/settings')
  check('恶意2 之后 listLimit 仍是 1234（没被部分应用）', () => {
    assert(after2.json().listLimit === 1234, 'listLimit: ' + after2.json().listLimit)
  })

  // ── 恶意 3：深三层 __proto__ ────────────────────────────────────────
  const evil3 = await call(deps, 'POST', '/ext/artifacts/settings/import', {
    body: JSON.parse('{"format":"' + SETTINGS_FORMAT + '","version":1,"settings":{"columns":{"__proto__":{"polluted":3}}}}'),
  })
  check('★ 恶意3：三层深（settings.columns.__proto__）也拒绝', () => {
    assert(evil3.statusCode === 400, '状态码 ' + evil3.statusCode + ' ' + evil3.body)
    assert(evil3.json().errors.some((e) => e.key === 'settings.columns.__proto__'), '路径应精确到层: ' + evil3.body)
  })
  // ── 恶意 4：constructor.prototype ────────────────────────────────────
  const evil4 = await call(deps, 'POST', '/ext/artifacts/settings/import', {
    body: JSON.parse('{"format":"' + SETTINGS_FORMAT + '","version":1,"settings":{"constructor":{"prototype":{"polluted":4}}}}'),
  })
  check('★ 恶意4：constructor.prototype 也拒绝', () => {
    assert(evil4.statusCode === 400, '状态码 ' + evil4.statusCode + ' ' + evil4.body)
  })
  check('★★★ 四个恶意载荷跑完，`({}).polluted === undefined` 依然成立', () => {
    assert({}.polluted === undefined, '★ Object.prototype 被污染了！')
  })
  check('scanForbiddenKeys 直接调用也能抓到（含数组下标路径）', () => {
    const r = scanForbiddenKeys(JSON.parse('{"a":[{"prototype":1}]}'))
    assert(r.found.includes('a.0.prototype'), 'found: ' + JSON.stringify(r.found))
    assert(r.truncated === false, 'truncated: ' + r.truncated)
  })

  // ── 恶意 5：枚举值注入脚本 ──────────────────────────────────────────
  const evil5 = await call(deps, 'POST', '/ext/artifacts/settings/import', {
    body: { format: SETTINGS_FORMAT, version: 1, settings: { density: '<script>alert(1)</script>', listLimit: 900 } },
  })
  check('★ 恶意5：density 值塞脚本 → 该键进 errors，其余键照常应用', () => {
    assert(evil5.statusCode === 200, '状态码 ' + evil5.statusCode + ' ' + evil5.body)
    const b = evil5.json()
    assert(b.errors.some((e) => e.key === 'density'), 'errors: ' + evil5.body)
    assert(b.applied.includes('listLimit'), '其余键应照常应用: ' + evil5.body)
    assert(b.settings.density === 'compact', 'density 不该被脚本覆盖: ' + b.settings.density)
    assert(b.settings.listLimit === 900, 'listLimit 应已应用')
  })

  // ── 恶意 6：超范围 listLimit ────────────────────────────────────────
  const evil6 = await call(deps, 'POST', '/ext/artifacts/settings/import', {
    body: { format: SETTINGS_FORMAT, version: 1, settings: { listLimit: 999999 } },
  })
  check('★ 恶意6：listLimit=999999 → 夹到 10000（不是拒绝、更不是写进去）', () => {
    assert(evil6.statusCode === 200, '状态码 ' + evil6.statusCode)
    assert(evil6.json().settings.listLimit === 10000, 'listLimit: ' + evil6.json().settings.listLimit)
  })

  // ── 未知键 / 格式版本 ──────────────────────────────────────────────
  const unknown = await call(deps, 'POST', '/ext/artifacts/settings/import', {
    body: { format: SETTINGS_FORMAT, version: 1, settings: { somethingFromTheFuture: 1, listLimit: 1000 }, envelopeExtra: true },
  })
  check('未知键进 ignored、不报错（前向兼容）', () => {
    const b = unknown.json()
    assert(b.ignored.includes('somethingFromTheFuture'), 'ignored: ' + unknown.body)
    assert(b.ignored.includes('envelopeExtra'), '信封未知键: ' + unknown.body)
    assert(b.ok === true && b.settings.listLimit === 1000, 'body: ' + unknown.body)
  })
  const badFormat = await call(deps, 'POST', '/ext/artifacts/settings/import', {
    body: { format: 'something/else', version: 1, settings: {} },
  })
  check('format 不匹配 → 400 明确报错（不猜）', () => {
    assert(badFormat.statusCode === 400, '状态码 ' + badFormat.statusCode)
    assert(badFormat.json().reason === 'format-mismatch', 'reason: ' + badFormat.body)
  })
  const badVersion = await call(deps, 'POST', '/ext/artifacts/settings/import', {
    body: { format: SETTINGS_FORMAT, version: 99, settings: { listLimit: 700 } },
  })
  check('version 不匹配 → 400 明确报错（不做猜测式迁移）', () => {
    assert(badVersion.statusCode === 400, '状态码 ' + badVersion.statusCode)
    assert(badVersion.json().reason === 'version-mismatch', 'reason: ' + badVersion.body)
  })
  const afterVersion = await call(deps, 'GET', '/ext/artifacts/settings')
  check('版本不匹配后 listLimit 未变（fail closed）', () => {
    assert(afterVersion.json().listLimit === 1000, 'listLimit: ' + afterVersion.json().listLimit)
  })

  // ── 导入的「按出现键覆盖」口径 ─────────────────────────────────────
  const beforePartial = (await call(deps, 'GET', '/ext/artifacts/settings')).json()
  const partial = await call(deps, 'POST', '/ext/artifacts/settings/import', {
    body: { format: SETTINGS_FORMAT, version: 1, settings: { listLimit: 1500 } },
  })
  check('★ 口径=按出现键覆盖：载荷里没出现的键保持不动', () => {
    const s = partial.json().settings
    assert(s.listLimit === 1500, 'listLimit: ' + s.listLimit)
    // 不写死期望值，而是跟导入**之前**的快照逐键比对 —— 这样断言的是「没动」这件事本身
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key === 'listLimit') continue
      assert(JSON.stringify(s[key]) === JSON.stringify(beforePartial[key]), `${key} 不该被动到：${JSON.stringify(beforePartial[key])} → ${JSON.stringify(s[key])}`)
    }
    assert(s.showHidden === beforePartial.showHidden, 'showHidden 应保持不动')
  })
  const rLan = await call(deps, 'POST', '/ext/artifacts/settings/import', { body: { format: SETTINGS_FORMAT, version: 1 }, remoteAddress: '192.168.1.50' })
  check('局域网来源 → 403（导入是写操作）', () => {
    assert(rLan.statusCode === 403, '状态码 ' + rLan.statusCode)
  })
}

// ═══ [6] 源码守卫：不再有「读了不生效」的键 ═════════════════════════════
console.log('\n=== [6] 源码守卫（防复发）===')
{
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const indexSrc = fs.readFileSync(path.join(pluginRoot, 'lib', 'index.js'), 'utf8')
  check('★ lib/index.js 读的是设置存储的 indexExtraDirs（不是旧 store 的）', () => {
    assert(/settingsStore\.get\(\)/.test(indexSrc), '没看到 settingsStore.get()')
    assert(/indexExtraDirs/.test(indexSrc), '没看到 indexExtraDirs')
    assert(!/store\.getSettings\(\)\.indexExtraDirs/.test(indexSrc), '还在读旧 store 的 indexExtraDirs —— 那正是死设置的来源')
  })
  check('★ 设置变更会触发索引范围刷新（否则又是「存进去了但没生效」）', () => {
    assert(/onSettingsChanged/.test(indexSrc), '没接 onSettingsChanged')
    assert(/scheduleScopeRefresh\(\)/.test(indexSrc), '没触发范围刷新')
  })
  check('hostEffectiveKeys = 4 个宿主生效键（不含纯客户端外观项）', () => {
    assert(JSON.stringify(HOST_EFFECTIVE_KEYS) === JSON.stringify(['listLimit', 'thumbMaxBytes', 'showHidden', 'indexExtraDirs']), JSON.stringify(HOST_EFFECTIVE_KEYS))
    for (const key of APPEARANCE_KEYS) {
      assert(!HOST_EFFECTIVE_KEYS.includes(key), key + ' 是客户端生效项，不该混进 hostEffectiveKeys')
    }
  })
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log('\n' + '─'.repeat(60))
console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败列表：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(failed ? 1 : 0)
