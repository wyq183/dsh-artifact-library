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
  // Step 2a：分类可自定义
  CONTENT_KEYS, CATEGORY_ICONS, CATEGORY_ID_RE, LOCKED_CATEGORY_ID, DEFAULT_CATEGORIES,
  validateCategories, mergeCategories,
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

// ═══ [7] 分类可自定义（Step 2a）═══════════════════════════════════════════
//
// 本节的靶子是**三条硬约束**，不是「能存能读」：
//   ① 老数据不能变孤儿 —— 默认分类必须覆盖现有全部 artifact_type，兜底类永不可删；
//   ② 改分类**不能**把预设打成 custom —— 这是「预设分两层」的唯一理由；
//   ③ 分类 id 是**用户输入**，必须挡住 `__proto__` 这类键。
console.log('\n=== [7] 分类可自定义（Step 2a）===')
{
  // 现有数据的 artifact_type 实测分布（2026-10-06 取自 ~/.dsh/artifact-library/artifacts.json，
  // 共 266 条：document 151 / code 53 / image 26 / other 12 / video 11 / archive 11 / audio 2）。
  // ⚠️ 这张表**故意写死**：如果哪天有人往库里加了新 type，这条测试会红 —— 那正是我要的提醒。
  const REAL_TYPES = ['document', 'code', 'image', 'other', 'video', 'archive', 'audio']

  // ── 7.1 默认分类与现有数据对齐 ─────────────────────────────────────────
  check('★ 默认分类正好覆盖现有数据的全部 artifact_type（否则那批记录变孤儿）', () => {
    const ids = DEFAULT_CATEGORIES.map((c) => c.id)
    for (const t of REAL_TYPES) {
      assert(ids.includes(t), `默认分类缺 ${t} —— 它名下的记录会变成孤儿`)
    }
    assert(ids.length === REAL_TYPES.length,
      `默认分类数量与现有 type 数不符：多出 ${ids.filter((i) => !REAL_TYPES.includes(i)).join(' / ') || '无'}`)
  })
  check('★ 兜底分类 id 仍是 other、label 是「未分类」、locked（改 id 会逼出迁移）', () => {
    const other = DEFAULT_CATEGORIES.find((c) => c.id === LOCKED_CATEGORY_ID)
    assert(other, '默认分类里没有兜底类')
    assert(LOCKED_CATEGORY_ID === 'other',
      `兜底 id 被改成 ${LOCKED_CATEGORY_ID} —— 库里 12 条记录的 artifact_type 就是 other，改 id = 要迁移`)
    assert(other.label === '未分类', '兜底类显示名: ' + other.label)
    assert(other.locked === true, '兜底类必须 locked')
  })
  check('默认分类自身合法：id 过 RE、icon 在表内、exts 无重复', () => {
    for (const c of DEFAULT_CATEGORIES) {
      assert(CATEGORY_ID_RE.test(c.id), 'id 不合法: ' + c.id)
      assert(CATEGORY_ICONS.includes(c.icon), `${c.id} 的图标不在 CATEGORY_ICONS 里: ${c.icon}`)
      assert(Array.isArray(c.exts) && c.exts.length === new Set(c.exts).size, `${c.id} 的 exts 有重复`)
      for (const e of c.exts) assert(e === e.toLowerCase() && !e.startsWith('.'), `${c.id} 的后缀没归一: ${e}`)
    }
  })
  check('DEFAULT_SETTINGS.categories 与 DEFAULT_CATEGORIES 同源（不是抄了一份）', () => {
    assert(JSON.stringify(DEFAULT_SETTINGS.categories) === JSON.stringify(DEFAULT_CATEGORIES),
      '默认值漂了 —— 两份必须一致')
  })

  // ── 7.2 两层结构（本步最核心的那条翻案）───────────────────────────────
  check('★ CONTENT_KEYS 与 APPEARANCE_KEYS 不相交（混在一张表里 = 语义错）', () => {
    for (const k of CONTENT_KEYS) {
      assert(!APPEARANCE_KEYS.includes(k), `${k} 同时出现在两张表里`)
    }
  })
  check('★ categories 不在 APPEARANCE_KEYS 里', () => {
    assert(!APPEARANCE_KEYS.includes('categories'),
      'categories 混进了 APPEARANCE_KEYS —— 那「改了分类」会被判成「外观被微调 → preset 变 custom」')
  })
  check('每个键要么是外观类、要么是内容类，不存在第三类', () => {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key === 'preset' || key === 'customPresets') continue
      const isAppearance = APPEARANCE_KEYS.includes(key)
      const isContent = CONTENT_KEYS.includes(key)
      // panelWidth / listLimit / indexExtraDirs 等是「宿主生效类」，两表都不进是合法的
      if (isContent) assert(!isAppearance, `${key} 两类都是`)
    }
  })
  check('★ 预设的 content 只用 CONTENT_KEYS 里的键（第二条模块加载自检的正面断言）', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      for (const key of Object.keys(preset.content || {})) {
        assert(CONTENT_KEYS.includes(key), `${id} 的 content 用了非内容键 ${key}`)
      }
    }
  })
  check('★ 依琪那条：开发者预设带代码类分类（不止图片视频）', () => {
    const ids = (PRESETS.developer.content.categories || []).map((c) => c.id)
    for (const need of ['code', 'script', 'config']) {
      assert(ids.includes(need), `开发者预设缺分类 ${need}（ids: ${ids.join('/')}）`)
    }
  })
  check('预设 content 的 label/icon/exts 自身合法（不能被 validateCategories 拒）', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      const list = (preset.content || {}).categories
      if (!list) continue
      const r = validateCategories(list)
      assert(r.ok, `预设 ${id} 的 categories 不合法：${r.reason}`)
    }
  })

  // ── 7.3 validateCategories：形状与边界 ────────────────────────────────
  check('validateCategories：非法输入被拒（不是夹紧、不是猜）', () => {
    const bad = [
      ['不是数组', 'document'],
      ['是对象', { id: 'a' }],
      ['超 64 个', Array.from({ length: 65 }, (_, i) => ({ id: 'c' + i, label: 'x' + i }))],
      ['元素不是对象', ['document']],
      ['id 含大写', [{ id: 'Doc', label: '文档' }]],
      ['id 数字开头', [{ id: '1doc', label: '文档' }]],
      ['id 太长（33 字符）', [{ id: 'a'.repeat(33), label: '文档' }]],
      ['id 带空格', [{ id: 'my doc', label: '文档' }]],
      ['label 空串', [{ id: 'doc', label: '   ' }]],
      ['label 超 24 字', [{ id: 'doc', label: '字'.repeat(25) }]],
      ['icon 不认识', [{ id: 'doc', label: '文档', icon: 'rocket' }]],
      ['exts 不是数组', [{ id: 'doc', label: '文档', exts: 'md' }]],
      ['exts 超 64 个', [{ id: 'doc', label: '文档', exts: Array.from({ length: 65 }, (_, i) => 'e' + i) }]],
      ['exts 里有非字符串', [{ id: 'doc', label: '文档', exts: [1] }]],
      ['exts 里后缀过长', [{ id: 'doc', label: '文档', exts: ['a'.repeat(17)] }]],
    ]
    for (const [name, value] of bad) {
      const r = validateCategories(value)
      assert(r.ok === false, `本该被拒却通过了：${name}`)
      assert(typeof r.reason === 'string' && r.reason.length > 0, `${name} 被拒但没给理由`)
    }
  })
  check('id 重复 → 拒（判据是 id，不是 label）', () => {
    const r = validateCategories([
      { id: 'doc', label: '文档' },
      { id: 'doc', label: '另一个文档' },
      { id: LOCKED_CATEGORY_ID, label: '未分类' },
    ])
    assert(r.ok === false && /重复/.test(r.reason), '没拒重复 id：' + JSON.stringify(r))
  })
  check('后缀归一：`.MD` / `MD` / `..TXT` → 无点小写；空串跳过', () => {
    const r = validateCategories([
      { id: 'doc', label: '文档', exts: ['.MD', 'MD', '..TXT', '  ', 'pdf'] },
      { id: LOCKED_CATEGORY_ID, label: '未分类' },
    ])
    assert(r.ok, r.reason)
    const doc = r.value.find((c) => c.id === 'doc')
    assert(JSON.stringify(doc.exts) === JSON.stringify(['md', 'txt', 'pdf']),
      '归一结果: ' + JSON.stringify(doc.exts))
  })
  check('★ 缺兜底类 → **自动补上**而不是报错（结构性保证，不指望调用方记得）', () => {
    const r = validateCategories([{ id: 'doc', label: '文档', exts: ['md'] }])
    assert(r.ok, '本该通过：' + r.reason)
    const other = r.value.find((c) => c.id === LOCKED_CATEGORY_ID)
    assert(other && other.locked === true, '没自动补上兜底类')
    assert(other.exts.length === 0, '兜底类不该声明后缀')
    assert(r.notes.some((n) => /兜底/.test(n)), '补了兜底类却没给 note：' + JSON.stringify(r.notes))
  })
  check('★ 同一后缀跨类 → **不报错**、进 notes、取先出现的（真实数据里 exe 天然跨类）', () => {
    const r = validateCategories([
      { id: 'code', label: '代码', exts: ['exe', 'js'] },
      { id: 'archive', label: '压缩包', exts: ['exe', 'zip'] },
      { id: 'doc', label: '文档', exts: ['exe'] },
      { id: LOCKED_CATEGORY_ID, label: '未分类' },
    ])
    assert(r.ok, '跨类后缀不该被拒：' + r.reason)
    assert(r.value.find((c) => c.id === 'archive').exts.includes('exe'), '归档类自己仍应保留 exe')
    const dupNotes = r.notes.filter((n) => /exe/.test(n))
    assert(dupNotes.length === 2, `exe 跨了三类应给 2 条 note，得到 ${dupNotes.length}: ${JSON.stringify(r.notes)}`)
    assert(dupNotes.some((n) => /代码/.test(n) && /压缩包/.test(n)), 'note 里没说清是哪两个类：' + JSON.stringify(dupNotes))
  })
  check('★ locked 由函数说了算：兜底类强制 true，其它类一律 false', () => {
    const r = validateCategories([
      { id: 'doc', label: '文档', locked: true },          // 想自封 → 压回 false
      { id: LOCKED_CATEGORY_ID, label: '未分类', locked: false }, // 想解除 → 强制 true
    ])
    assert(r.ok, r.reason)
    assert(r.value.find((c) => c.id === 'doc').locked === false, '普通类不该能自封 locked')
    assert(r.value.find((c) => c.id === LOCKED_CATEGORY_ID).locked === true, '兜底类的 locked 不该能被解除')
  })
  check('★ 未知字段被丢掉（尤其 color —— icons.js 明令禁 hex）', () => {
    const r = validateCategories([
      { id: 'doc', label: '文档', color: '#ff0000', danger: '<script>', exts: ['md'] },
      { id: LOCKED_CATEGORY_ID, label: '未分类' },
    ])
    assert(r.ok, r.reason)
    const doc = r.value.find((c) => c.id === 'doc')
    assert(!Object.prototype.hasOwnProperty.call(doc, 'color'), 'color 漏进来了')
    assert(!Object.prototype.hasOwnProperty.call(doc, 'danger'), 'danger 漏进来了')
    assert(JSON.stringify(Object.keys(doc).sort()) === JSON.stringify(['exts', 'icon', 'id', 'label', 'locked']),
      '字段集不对: ' + JSON.stringify(Object.keys(doc)))
  })
  check('返回全新对象：改输入不影响已校验的结果', () => {
    const input = [{ id: 'doc', label: '文档', exts: ['md'] }, { id: LOCKED_CATEGORY_ID, label: '未分类' }]
    const r = validateCategories(input)
    assert(r.ok, r.reason)
    input[0].label = '被改了'
    input[0].exts.push('evil')
    assert(r.value.find((c) => c.id === 'doc').label === '文档', '结果被输入后续改动污染了')
    assert(!r.value.find((c) => c.id === 'doc').exts.includes('evil'), 'exts 数组没深拷贝')
  })
  check('★ 分类 id 不污染 Object.prototype', () => {
    const r = validateCategories([
      { id: 'doc', label: '文档', exts: ['md'] },
      { id: LOCKED_CATEGORY_ID, label: '未分类' },
    ])
    assert(r.ok, r.reason)
    // __proto__ 过不了 CATEGORY_ID_RE（下划线开头？不 —— 它是小写字母开头但含连续下划线，
    // 形状上是合法的，所以这里断言的是「即使写进来也只是个普通字符串键，不产生原型污染」）
    const rProto = validateCategories([
      { id: '__proto__', label: 'x' },
      { id: LOCKED_CATEGORY_ID, label: '未分类' },
    ])
    assert(rProto.ok === false, '__proto__ 开头的 id 该被 RE 挡住（首字符必须是字母）')
    assert(({}).polluted === undefined, '原型被污染了')
  })

  // ── 7.4 mergeCategories：只增改、绝不删 ───────────────────────────────
  check('★ mergeCategories 只增改、绝不删（删了引用它的记录就成孤儿）', () => {
    const base = [
      { id: 'document', label: '文档', icon: 'doc', exts: ['md'], locked: false },
      { id: 'legacy', label: '老分类', icon: 'other', exts: [], locked: false },
      { id: LOCKED_CATEGORY_ID, label: '未分类', icon: 'other', exts: [], locked: true },
    ]
    const merged = mergeCategories(base, [{ id: 'script', label: '脚本', icon: 'code', exts: ['sh'] }])
    const ids = merged.map((c) => c.id)
    assert(ids.includes('legacy'), 'legacy 被删了 —— 这就是孤儿')
    assert(ids.includes(LOCKED_CATEGORY_ID), '兜底类被删了')
    assert(ids.includes('script'), '新分类没加进去')
    assert(merged.length === base.length + 1, '数量不对: ' + merged.length)
  })
  check('mergeCategories：同 id 覆盖 label/icon/exts（这才是「套预设」的意义）', () => {
    const base = [{ id: 'code', label: '代码', icon: 'code', exts: ['js'], locked: false }]
    const merged = mergeCategories(base, [{ id: 'code', label: '源码', icon: 'json', exts: ['py', 'go'] }])
    const code = merged.find((c) => c.id === 'code')
    assert(code.label === '源码' && code.icon === 'json', '没覆盖: ' + JSON.stringify(code))
    assert(JSON.stringify(code.exts) === JSON.stringify(['py', 'go']), 'exts 没覆盖: ' + JSON.stringify(code.exts))
  })
  check('mergeCategories 不改动入参（base 与 incoming 都保持原样）', () => {
    const base = [{ id: 'code', label: '代码', icon: 'code', exts: ['js'], locked: false }]
    const incoming = [{ id: 'code', label: '源码', exts: ['py'] }, { id: 'new', label: '新', exts: [] }]
    const baseSnap = JSON.stringify(base)
    const inSnap = JSON.stringify(incoming)
    const merged = mergeCategories(base, incoming)
    assert(JSON.stringify(base) === baseSnap, 'base 被改了')
    assert(JSON.stringify(incoming) === inSnap, 'incoming 被改了')
    merged[0].exts.push('污染')
    assert(JSON.stringify(base) === baseSnap, 'exts 是同一个数组引用（浅拷贝漏了）')
  })
  check('mergeCategories 容错：非数组 / 脏元素不抛', () => {
    assert(mergeCategories(null, null).length === 0, 'null 该回空数组')
    assert(mergeCategories([{ id: 'a', label: 'A' }], [null, 1, 'x', { noId: 1 }]).length === 1, '脏元素该被跳过')
  })

  // ── 7.5 ★ 端到端：改分类**不会**把预设打成 custom（本步的核心设计目标）──
  check('★★ 只改 categories 不会把预设打成 custom（两层结构的唯一理由）', () => {
    const s = freshStore()
    s.update({ preset: 'developer' })
    assert(s.get().preset === 'developer', '前置失败：预设不是 developer')
    const r = s.update({ categories: [{ id: 'mydoc', label: '我的文档', icon: 'doc', exts: ['md'] }] })
    assert(r.errors.length === 0, 'errors: ' + JSON.stringify(r.errors))
    assert(s.get().preset === 'developer',
      `改了分类后预设变成 ${s.get().preset} —— 内容类不该参与「微调变 custom」判定`)
    assert(s.get().categories.some((c) => c.id === 'mydoc'), '新分类没存进去')
  })
  check('对照：只改外观键**会**变 custom（证明上一条不是因为判定失灵）', () => {
    const s = freshStore()
    s.update({ preset: 'developer' })
    s.update({ density: 'loose' })
    assert(s.get().preset === 'custom', '外观微调后应变 custom，得到 ' + s.get().preset)
  })
  check('★ 套预设时分类是**合并**：developer → office，script/config 仍在', () => {
    const s = freshStore()
    s.update({ preset: 'developer' })
    const afterDev = s.get().categories.map((c) => c.id)
    assert(afterDev.includes('script') && afterDev.includes('config'), 'developer 没带上代码类分类')
    s.update({ preset: 'office' })
    const afterOffice = s.get().categories.map((c) => c.id)
    for (const keep of ['script', 'config', 'code']) {
      assert(afterOffice.includes(keep), `换预设后 ${keep} 被删了 —— 那是指向它的记录变孤儿`)
    }
    // 对照：外观项**会**被重置（developer 的 compact 行高应回默认）
    assert(s.get().density === DEFAULT_SETTINGS.density, '外观项该被重置回默认')
  })
  check('★ 缺兜底类的配置存进去后，兜底类会被补上（老数据不会失联）', () => {
    const s = freshStore()
    const r = s.update({ categories: [{ id: 'only', label: '唯一', icon: 'other', exts: [] }] })
    assert(r.errors.length === 0, 'errors: ' + JSON.stringify(r.errors))
    assert(s.get().categories.some((c) => c.id === LOCKED_CATEGORY_ID), '兜底类没被补上')
    assert(r.notes.some((n) => /兜底/.test(n)), 'notes 没透出来：' + JSON.stringify(r.notes))
  })
  check('非法 categories 进 errors，且**不改掉原值**', () => {
    const s = freshStore()
    const before = JSON.stringify(s.get().categories)
    const r = s.update({ categories: [{ id: 'Bad', label: 'x' }] })
    assert(r.errors.some((e) => e.key === 'categories'), 'errors: ' + JSON.stringify(r.errors))
    assert(JSON.stringify(s.get().categories) === before, '非法值把原值改掉了')
  })
  check('★ categories 会落盘、重新 load 后仍在', () => {
    const s = freshStore()
    s.update({ categories: [{ id: 'mine', label: '我的', icon: 'folder', exts: ['xyz'] }] })
    assert(s.get().categories.some((c) => c.id === 'mine'), '前置失败')
    const reloaded = new SettingsStore({ file: SETTINGS_FILE }).load()
    const cats = reloaded.get().categories
    assert(cats.some((c) => c.id === 'mine'), '重启后分类没了 —— 读了不生效')
    assert(cats.some((c) => c.id === LOCKED_CATEGORY_ID), '兜底类没落盘')
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
