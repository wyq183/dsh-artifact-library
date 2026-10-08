/**
 * 离线 harness：**受管标签表**（Step 3d 接线：存储 / HTTP 契约 / agent 编辑入口）
 *
 * ⚠️ 规则层（`lib/tag-styles.js`）已经自己测透了 78 条（含反向断言）。
 *   **这个文件不重测规则** —— 它测的是**接线**：表存在哪、怎么给出去、谁能让它变、
 *   坏了会不会被拦下来、被拦下来之后有没有**假装写成功**。
 *
 * 九节，按「出错后果」从重到轻排：
 *   A 默认预设：合法 + 结构不变量（含 5 个「已知有病」的默认预设做反向对照）
 *   B 存储位置：`content` 层（**不参与**「微调变 custom」）、不是死设置
 *   C `GET /managed-tags`：**冻结契约**的形状（空表 = `[]`、失败 = `{ok:false}`、局域网对称）
 *   D 往返：`PUT /settings` → `GET /managed-tags` → 落盘 → 重新 load
 *   E 非法数据**被拒且不落盘**（含「超限只报告、不腾位」）
 *   F ★★ 反向对照：拿「已知有病」的实现跑同一批断言，确认它们**真的会红**
 *   G 我没有另造一套校验（与直出函数逐样本等价；且 `limit: 3` 时**必须不同**）
 *   H agent 工具 `artifact_tag_styles`（默认 dry-run、拒非法、不崩）
 *   I 落盘守卫的**输入预处理**也要被验（读不到磁盘文件必须**大声**失败，不许静默当「没变」）
 *
 * 用法：node test/managed-tags.test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { ArtifactStore } from '../lib/store.js'
import { artifactsHandler } from '../lib/http.js'
import { registerArtifactTools } from '../lib/tools.js'
import {
  APPEARANCE_KEYS, CONTENT_KEYS, DEFAULT_MANAGED_TAGS, DEFAULT_SETTINGS,
  SETTING_KEYS, SettingsStore, managedTagRule, validateManagedTagSettings,
} from '../lib/settings.js'
import {
  MANAGED_TAG_LIMIT_UNLIMITED, TAG_COLOR_SLOTS, TAG_ICONS, TAG_SIZES, TAG_STYLE_FIELDS, TAG_WEIGHTS,
  TAG_STYLE_TABLE, buildTagStyleRule, checkManagedTagBudget, validateManagedTags,
} from '../lib/tag-styles.js'
import { normalizeTag } from '../lib/tags.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failed += 1; failures.push(name + ' → ' + (error && error.message ? error.message : String(error))); console.log('  FAIL ' + name + ' → ' + (error && error.message ? error.message : String(error))) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }
/** 断言「这一段会拒绝」—— 比「结果看起来对」硬（同 tag-styles.test.mjs 的写法） */
function assertRejects(fn, needle, label) {
  const r = fn()
  assert(r && r.ok === false, (label || '') + ' 本应被拒，实际放行了：' + JSON.stringify(r))
  assert(typeof r.reason === 'string' && r.reason.length > 0, (label || '') + ' 被拒了但没给理由')
  if (needle) assert(r.reason.indexOf(needle) >= 0, (label || '') + ' 的拒绝理由里没提到 ' + JSON.stringify(needle) + '：' + r.reason)
}
/** 断言「这一段会抛」—— 用于「失败必须大声」的断言（静默返回不算） */
function assertThrows(fn, label) {
  let threw = false
  try { fn() } catch { threw = true }
  assert(threw, (label || '') + ' 本应抛错，实际安静地返回了')
}

// ═══ 临时目录与夹具 ═══════════════════════════════════════════════════════
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alf-managed-'))
let seq = 0
const settingsFile = (name) => path.join(TMP, name + '.json')

/** 一份**合法**的受管表（不碰真库；tag 用明显是夹具的字符串） */
const T1 = { id: 'mt_alpha', tag: '夹具A', color: 'blue', icon: 'code' }
const T2 = { id: 'mt_beta', tag: '夹具B', color: 'green', icon: 'folder', weight: 'bold' }
const T3 = { id: 'mt_gamma', tag: '夹具C' }   // ★ 没样式 —— 照样是受管的（判据不是「有没有样式」）
const GOOD = { limit: MANAGED_TAG_LIMIT_UNLIMITED, tags: [T1, T2, T3] }

/**
 * 直接读**磁盘**上的 settings.json 里的受管表。
 *
 * ⚠️ 读不到 / 解析不了 / 形状不对 ⇒ **抛**，绝不回 `undefined`。
 *   理由：本文件有多条断言是「被拒的数据**没落盘**」，而那种断言有两种**假绿**：
 *     ① 文件路径写错或读失败 → 拿到 `undefined` → 「没变」恒真（**安全感的假象**）；
 *     ② 只比内存不看磁盘 → 落盘那条路根本没被验到。
 *   所以这个读取器必须**大声失败**，而且它自己要被验一次（见 `[I]`）。
 *   返回值 `null` = 磁盘上**没有**这一项（明确的哨兵，不是「读失败」）。
 */
function diskManagedTags(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!raw || typeof raw !== 'object' || !raw.values || typeof raw.values !== 'object') {
    throw new Error('settings.json 形状不对（拿不到 values）: ' + JSON.stringify(raw))
  }
  return raw.values.managedTags === undefined ? null : raw.values.managedTags
}

// ── HTTP 夹具（与 http-contract.test.mjs 同款：真 Writable + 真 Readable）──
function makeResBuf() {
  const chunks = []
  const res = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
  res.statusCode = 0
  res.headers = {}
  res.writeHead = (code, headers) => { res.statusCode = code; Object.assign(res.headers, headers || {}); return res }
  res.bodyText = () => Buffer.concat(chunks).toString('utf8')
  res.json = () => JSON.parse(res.bodyText())
  return res
}
function reqOf(method, url, body, remoteAddress = '127.0.0.1') {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = {}
  req.socket = { remoteAddress }
  return req
}
async function call(handler, method, url, body, remoteAddress) {
  const res = makeResBuf()
  await handler(reqOf(method, url, body, remoteAddress), res)
  return res
}
/**
 * 最小**旧 store 替身**：本文件只打 `/managed-tags` 与 `/settings`，
 * 这两个端点只问它 `getSettings()`（`mergedSettings` 的底座）。刻意不建真 record store ——
 * 那会把这个文件的失败原因和「记录存储」的失败混在一起，排查时看不出是谁坏了。
 */
function fakeStore() {
  return {
    items: [],
    // ⚠️ 必须有 `get`，而且**必须回 null**（= 真实 store 查不到未知 id 时的样子）。
    //    没有它的话，路由顺序写错时这里会抛 500，而我的断言是「不是 404」——
    //    500 !== 404 会让那条断言**因为错误的原因通过**（假绿）。第一版就踩了这个坑：
    //    去掉路由跑一遍，是「条目形状」那条抓到的，而不是专门守路由顺序的那条。
    get: () => null,
    getSettings: () => ({ autoCollect: true, searchLimit: 20 }),
    updateSettings: () => {},
    stats: () => ({ total: 0 }),
    categories: () => ({}),
    list: () => ({ items: [], total: 0 }),
  }
}
/**
 * `deps.settings` 的形状照 `lib/index.js` 的真实注入写。
 *
 * ⚠️ **必须逐字段对齐那一份**（2026-10-08 补）：适配器漏一个字段**不会报错**，
 *   只会让「磁盘上这个键被丢弃了」和「这个键从来没配过」在端点那里长得一样 ——
 *   而 `GET /managed-tags` 的守卫恰恰要靠 `rejectedKeys()` 区分这两者。
 *   我第一版只透出 get/update/export/import，等于那道守卫在**真机上是空转的**
 *   （`lib/http.js` 里记了这次实测）。现在端点对「挂了 settings 却没给访问器」
 *   是**大声失败**，所以这里漏了会直接红，不会静默降级。
 */
function settingsDeps(s) {
  return {
    get: () => s.get(),
    update: (patch) => s.update(patch),
    export: (legacy) => s.exportPayload(legacy),
    import: (payload) => s.importPayload(payload),
    rejectedKeys: () => s.rejected,
  }
}
function freshSettings(name) {
  const file = settingsFile(name)
  return { file, s: new SettingsStore({ file }).load() }
}
function handlerWith(s, extra = {}) {
  const store = fakeStore()
  return { store, handler: artifactsHandler(store, { store, fileIndex: {}, settings: settingsDeps(s), ...extra }) }
}
/** 写一张受管表（成功路径），返回 store 的 update 报告 */
function putManaged(handler, managedTags) {
  return call(handler, 'PUT', '/ext/artifacts/settings', { managedTags })
}

/* ═══ [A] 默认预设 ═══════════════════════════════════════════════════════ */
console.log('\n=== [A] 默认预设：合法、结构不变量、且不是「随便写写」===')
{
  check('★ 默认预设能被规则层通过（它是依琪第一眼看到的东西，不能先坏在自己手里）', () => {
    const r = validateManagedTagSettings(DEFAULT_MANAGED_TAGS)
    assert(r.ok === true, '默认预设没通过校验：' + JSON.stringify(r))
    // 也过一遍**模块级**直出函数（limit=null 时与上面同结果，见 [G]）
    const direct = validateManagedTags(DEFAULT_MANAGED_TAGS.tags)
    assert(direct.ok === true, '直出函数也拒了默认预设：' + JSON.stringify(direct))
  })

  check('默认上限 = 不限（null），不是 0 —— 0 会被规则层判成配置错误', () => {
    assert(DEFAULT_MANAGED_TAGS.limit === MANAGED_TAG_LIMIT_UNLIMITED, '默认 limit: ' + JSON.stringify(DEFAULT_MANAGED_TAGS.limit))
    assert(DEFAULT_MANAGED_TAGS.limit === null, '「不限」的表示法必须是 null')
    assert(DEFAULT_SETTINGS.managedTags === DEFAULT_MANAGED_TAGS, 'DEFAULT_SETTINGS 没接上默认预设')
  })

  check('默认预设 6~10 条（太少=白做，太多=一上来就糊）—— 钉**区间**，不钉当时的那个数', () => {
    const n = DEFAULT_MANAGED_TAGS.tags.length
    assert(n >= 6 && n <= 10, '默认 ' + n + ' 条')
  })

  check('每个默认条目的结构都合法：id 形状 / 色板槽名 / 图标名 / 档位名 / tag 无首尾空白', () => {
    const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
    const seenId = new Set()
    const seenTag = new Set()
    for (const it of DEFAULT_MANAGED_TAGS.tags) {
      assert(ID_RE.test(String(it.id)), 'id 形状不合法：' + JSON.stringify(it.id))
      assert(!seenId.has(it.id), 'id 重复：' + it.id)
      seenId.add(it.id)
      assert(typeof it.tag === 'string' && it.tag.length > 0, 'tag 不能为空：' + JSON.stringify(it))
      assert(it.tag === it.tag.trim(), 'tag 首尾有空白（永远匹配不到记录的死配置）：' + JSON.stringify(it.tag))
      assert(!seenTag.has(it.tag), 'tag 重复：' + it.tag)
      seenTag.add(it.tag)
      if (it.color !== undefined) assert(TAG_COLOR_SLOTS.includes(it.color), '颜色不是色板槽名：' + it.color)
      if (it.icon !== undefined) assert(TAG_ICONS.includes(it.icon), '图标不是 icons.js 里的形状名：' + it.icon)
      if (it.weight !== undefined) assert(TAG_WEIGHTS.includes(it.weight), '字重档名不对：' + it.weight)
      if (it.size !== undefined) assert(TAG_SIZES.includes(it.size), '字号档名不对：' + it.size)
    }
  })

  // ── ★★ 反向对照：证明上面那批「合法」断言**不是恒真** ──────────────────
  // 做法：把默认预设改坏（每一处都是**真实会犯**的错），断言它们**必须被拒**。
  // 如果哪天有人把校验放宽到「什么都收」，这一节会立刻红。
  check('★★ 反向对照：5 个「已知有病」的默认预设必须**全部被拒**（上面那批断言不是空转）', () => {
    const first = DEFAULT_MANAGED_TAGS.tags[0]
    const rest = DEFAULT_MANAGED_TAGS.tags.slice(1)
    const sick = [
      ['把颜色换成 hex（深色模式下不跟随主题）', [{ ...first, color: '#ff0000' }, ...rest]],
      ['自造一个图标名（配置合法但渲染空白）', [{ ...first, icon: 'rocket' }, ...rest]],
      ['tag 末尾多一个空格（永远匹配不到记录）', [{ ...first, tag: first.tag + ' ' }, ...rest]],
      ['只有样式、没有 id（= 拿「有没有样式」当受管判据，循环定义）', [{ tag: 'X', color: 'red' }, ...rest]],
      ['id 大写开头（等于把 __proto__ 那类键放进来）', [{ ...first, id: 'MT_Bad' }, ...rest]],
    ]
    for (const [what, tags] of sick) {
      const r = validateManagedTagSettings({ limit: null, tags })
      assert(r.ok === false, '坏版本竟然通过了：' + what + ' → ' + JSON.stringify(r))
      assert(typeof r.reason === 'string' && r.reason.length > 0, '坏版本被拒了但没说理由：' + what)
    }
    // 再证明「这套坏样本确实会被规则层看见」——以免断言是因为样本构造错了才恒红
    assert(Array.isArray(rest) && rest.length === DEFAULT_MANAGED_TAGS.tags.length - 1, '样本构造有问题')
  })
}

/* ═══ [B] 存储位置：content 层 ═══════════════════════════════════════════ */
console.log('\n=== [B] 存储位置：content 层（不参与「微调变 custom」）+ 不是死设置 ===')
{
  check('managedTags 在 CONTENT_KEYS 里，且 CONTENT_KEYS 与 APPEARANCE_KEYS **不相交**', () => {
    assert(CONTENT_KEYS.includes('managedTags'), 'CONTENT_KEYS: ' + JSON.stringify(CONTENT_KEYS))
    assert(CONTENT_KEYS.includes('categories'), 'categories 不该被挤掉')
    const overlap = CONTENT_KEYS.filter((k) => APPEARANCE_KEYS.includes(k))
    assert(overlap.length === 0, '内容层混进了外观键：' + JSON.stringify(overlap))
  })

  check('★ 写 managedTags **不会**把 preset 打成 custom（这就是放 content 层的理由）', () => {
    const { s } = freshSettings('preset-stays')
    const before = s.get().preset
    const r = s.update({ managedTags: GOOD })
    assert(r.errors.length === 0, 'errors: ' + JSON.stringify(r.errors))
    assert(s.get().preset === before, `preset 被打成了 ${s.get().preset} —— 内容项不该参与「微调」判定`)
    // ★ 反向对照：写一个**外观键**必须真的变 custom —— 否则上面那条断言可能只是
    //   「这套代码永远不会把 preset 变成 custom」而恒真。
    s.update({ density: 'compact' })
    assert(s.get().preset === 'custom', '外观键改了却没变 custom ⇒ 上面那条断言分辨不出好坏')
  })

  check('★ 不是死设置：`managedTags` 在 SETTING_KEYS 里，写进去 `applied` 收、`ignored` 不收', () => {
    assert(SETTING_KEYS.includes('managedTags'), 'SETTING_KEYS 里没有它 ⇒ 会被 update 丢进 ignored（典型的死设置）')
    const { s } = freshSettings('not-dead')
    const r = s.update({ managedTags: GOOD })
    assert(r.applied.includes('managedTags'), 'applied: ' + JSON.stringify(r.applied))
    assert(!r.ignored.includes('managedTags'), 'ignored: ' + JSON.stringify(r.ignored))
    assert(JSON.stringify(s.get().managedTags.tags) === JSON.stringify(GOOD.tags), '内存里没变')
    // ★ 反向对照：一个**真不认识**的键必须落进 ignored —— 证明 ignored 这条通道不是恒空
    const r2 = s.update({ managedTagsXYZ: 1 })
    assert(r2.ignored.includes('managedTagsXYZ'), 'ignored 通道恒空 ⇒ 上面那条断言分辨不出「死设置」')
  })

  check('读回来的形状是 `{limit, tags}`（一个键、两个字段），不是裸数组', () => {
    const { s } = freshSettings('shape')
    s.update({ managedTags: GOOD })
    const got = s.get().managedTags
    assert(got && !Array.isArray(got), '形状不对：' + JSON.stringify(got))
    assert(got.limit === null, 'limit: ' + JSON.stringify(got.limit))
    assert(Array.isArray(got.tags), 'tags 不是数组')
    assert(JSON.stringify(Object.keys(got).sort()) === JSON.stringify(['limit', 'tags']), 'keys: ' + JSON.stringify(Object.keys(got)))
  })
  check('★ `limit` 缺省 = 不限（手写的配置漏了这个字段，不该被当成「一个都不许」）', () => {
    const r = validateManagedTagSettings({ tags: GOOD.tags })
    assert(r.ok === true, JSON.stringify(r))
    assert(r.value.limit === null, 'limit: ' + JSON.stringify(r.value.limit))
    assert(JSON.stringify(r.value.tags) === JSON.stringify(GOOD.tags), 'tags 被动了')
  })

  check('★ 未知的顶层字段进 `notes`（不静默丢 —— 口径同 normalizeStyle）', () => {
    const r = validateManagedTagSettings({ limit: null, tags: [], 配色: 1 })
    assert(r.ok === true, JSON.stringify(r))
    assert(Array.isArray(r.notes) && r.notes.some((n) => n.indexOf('配色') >= 0),
      '未知字段被静默丢了：' + JSON.stringify(r.notes))
    // 反向对照：**合法**的键不该出现在 notes 里（否则这条断言只要「notes 非空」就恒真）
    const clean = validateManagedTagSettings({ limit: null, tags: GOOD.tags })
    assert(clean.notes.every((n) => n.indexOf('不认识') < 0), '合法字段被报成不认识：' + JSON.stringify(clean.notes))
  })
}

/* ═══ [C] GET /managed-tags：冻结契约 ═══════════════════════════════════ */
// ⚠️ 本文件所有异步调用一律放**语句层**，`check()` 里只放同步断言
//    （`check` 不 await 返回值：断言写在 promise 里会**静默丢失** = 假绿）。
console.log('\n=== [C] GET /managed-tags：严格照冻结契约（界面直接吃它）===')
{
  const { s } = freshSettings('http-contract')
  const { handler } = handlerWith(s)
  await putManaged(handler, GOOD)
  const res = await call(handler, 'GET', '/ext/artifacts/managed-tags')
  let body = null
  try { body = res.json() } catch { body = null }

  check('★ 成功：`{ok:true, limit, tags}` —— 键集合**正好**这三个（不多不少）', () => {
    assert(res.statusCode === 200, '状态码 ' + res.statusCode + ' body=' + res.bodyText())
    assert(body !== null, '响应不是 JSON：' + res.bodyText())
    assert(body.ok === true, 'ok 应为 true: ' + res.bodyText())
    assert(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['limit', 'ok', 'tags']),
      '键集合变了（契约是**冻结**的；加字段要当成一次有意的契约变更）：' + JSON.stringify(Object.keys(body)))
    assert(body.limit === null, 'limit 该原样吐 null（不限），实际 ' + JSON.stringify(body.limit))
    assert(Array.isArray(body.tags) && body.tags.length === GOOD.tags.length, 'tags: ' + JSON.stringify(body.tags))
  })

  check('★ 路由先于 `GET :id`：不会被当成产物 id 回 404', () => {
    assert(res.statusCode !== 404, '被当成未知 id 了（路由顺序错）')
    assert(body && body.reason !== 'artifact-not-found', 'body: ' + res.bodyText())
  })

  check('★ 条目形状：只有 id/tag + 4 个样式字段，没有多出来的内部字段', () => {
    const allowed = ['id', 'tag', ...TAG_STYLE_FIELDS]
    for (const it of body.tags) {
      for (const k of Object.keys(it)) assert(allowed.includes(k), '条目里冒出了 ' + k + '：' + JSON.stringify(it))
      assert(typeof it.id === 'string' && typeof it.tag === 'string', 'id/tag 必填：' + JSON.stringify(it))
    }
    assert(body.tags[2].color === undefined, '没配样式的条目不该被补一个默认色：' + JSON.stringify(body.tags[2]))
    assert(body.tags[1].weight === 'bold', '样式没跟上来：' + JSON.stringify(body.tags[1]))
  })

  // 空表：**必须**是 `[]`。界面对 `null` 调 .map 会直接崩。
  const { s: sEmpty } = freshSettings('http-empty')
  const { handler: hEmpty } = handlerWith(sEmpty)
  await putManaged(hEmpty, { limit: null, tags: [] })
  const resEmpty = await call(hEmpty, 'GET', '/ext/artifacts/managed-tags')
  const bodyEmpty = resEmpty.json()
  check('★ 空表 ⇒ `tags: []`（**不是** null），且 limit 仍是 null', () => {
    assert(bodyEmpty.ok === true, resEmpty.bodyText())
    assert(Array.isArray(bodyEmpty.tags), 'tags 不是数组：' + JSON.stringify(bodyEmpty.tags))
    assert(bodyEmpty.tags.length === 0, 'tags: ' + JSON.stringify(bodyEmpty.tags))
    assert(bodyEmpty.tags !== null, 'tags 是 null —— 界面 tags.map 会崩')
    assert(bodyEmpty.limit === null, 'limit: ' + JSON.stringify(bodyEmpty.limit))
  })

  // 存储里的值坏掉（绕过 load/update 塞进去的值）：必须**结构化失败**，
  // 而不是把一张畸形表吐给界面。这条在当前实现下很少触发（load 已经挡过一道），
  // 留着是因为**契约是对外承诺**，而这个函数是唯一能保证形状的地方 —— 且它有断言。
  const { s: sBroken } = freshSettings('http-broken')
  sBroken.values.managedTags = { limit: 2, tags: [T1, T2, T3] }   // 超限：3 条 > 上限 2
  const { handler: hBroken } = handlerWith(sBroken)
  const resBroken = await call(hBroken, 'GET', '/ext/artifacts/managed-tags')
  const bodyBroken = resBroken.json()
  check('★ 存储里的值不合法 ⇒ `{ok:false, error}`（不吐畸形表）', () => {
    assert(resBroken.statusCode === 500, '状态码 ' + resBroken.statusCode)
    assert(bodyBroken.ok === false, 'ok 应为 false: ' + resBroken.bodyText())
    assert(typeof bodyBroken.error === 'string' && bodyBroken.error.length > 0, 'error 是空的：' + resBroken.bodyText())
    assert(bodyBroken.tags === undefined, '失败时不该带 tags：' + resBroken.bodyText())
  })

  // ── 局域网来源：读放行、写照旧拦住（与 categories 对称）──────────────────
  const resLan = await call(handler, 'GET', '/ext/artifacts/managed-tags', undefined, '192.168.1.9')
  const resLanPut = await call(handler, 'PUT', '/ext/artifacts/settings', { managedTags: GOOD }, '192.168.1.9')
  check('★ 局域网来源：GET /managed-tags 放行（只读元数据），写操作照旧 403', () => {
    assert(resLan.statusCode === 200, '局域网读被挡了（状态码 ' + resLan.statusCode + '）—— 隔壁机器上标签会突然没样式，而界面不会解释')
    assert(resLan.json().tags.length === GOOD.tags.length, resLan.bodyText())
    assert(resLanPut.statusCode === 403, '局域网竟然能写设置：' + resLanPut.statusCode)
  })
}

/* ═══ [D] 往返：PUT → GET → 落盘 → 重启 ═══════════════════════════════ */
console.log('\n=== [D] 往返：写进去、读得回来、重启还在 ===')
{
  const { file, s } = freshSettings('roundtrip')
  const { handler } = handlerWith(s)
  await putManaged(handler, GOOD)
  const res = await call(handler, 'GET', '/ext/artifacts/managed-tags')
  const body = res.json()
  const onDisk = diskManagedTags(file)
  const reloaded = new SettingsStore({ file }).load().get().managedTags

  check('★ `PUT /settings` 写进去 → `GET /managed-tags` **逐字**读得回来', () => {
    assert(JSON.stringify(body.tags) === JSON.stringify(GOOD.tags), '往返有损失：' + JSON.stringify(body.tags))
    assert(body.limit === null, 'limit 往返丢了：' + JSON.stringify(body.limit))
  })

  check('★ 真的落盘了（直接读 settings.json），且**重新 load** 之后仍然一致', () => {
    assert(onDisk !== null, '磁盘上根本没有 managedTags —— 它只在内存里，重启就没了')
    assert(JSON.stringify(onDisk.tags) === JSON.stringify(GOOD.tags), '磁盘上不一致：' + JSON.stringify(onDisk))
    assert(JSON.stringify(reloaded.tags) === JSON.stringify(GOOD.tags), '重启后不一致：' + JSON.stringify(reloaded))
  })

  check('★ 导出/导入也带着受管表走（搬配置时它不能丢）', () => {
    const payload = s.exportPayload({})
    assert(payload.settings && payload.settings.managedTags, '导出载荷里没有 managedTags')
    const other = new SettingsStore({ file: settingsFile('roundtrip-2') }).load()
    const imp = other.importPayload(payload)
    assert(imp.ok === true, '导入失败：' + JSON.stringify(imp))
    const got = other.get().managedTags
    assert(JSON.stringify(got.tags) === JSON.stringify(GOOD.tags), '导入后不一致：' + JSON.stringify(got))
  })
}

/* ═══ [E] 非法数据：被拒**且不落盘**（含「超限只报告、不腾位」）═══════════ */
console.log('\n=== [E] 非法数据被拒、且一个字都没落盘 ===')
{
  const { file, s } = freshSettings('reject')
  const { handler } = handlerWith(s)
  await putManaged(handler, GOOD)
  const memBefore = JSON.stringify(s.get().managedTags)
  const diskBefore = JSON.stringify(diskManagedTags(file))

  /** 每一条：调 write（`settingsStore.update` 就是 PUT 走的那条路）→ 断言被拒 + 内存/磁盘都没变 */
  const cases = [
    ['limit: 0（「不限」和「一个都不许」都有人这么写 ⇒ 规则层不猜、整张表拒收）', { limit: 0, tags: GOOD.tags }, 'null'],
    ['limit 是字符串 "3"（类型错，不是「不限」）', { limit: '3', tags: GOOD.tags }, '上限'],
    ['limit 是小数 1.5', { limit: 1.5, tags: GOOD.tags }, '上限'],
    ['缺 id（只有样式没有 id = 拿「有没有样式」当受管判据）', { limit: null, tags: [{ tag: 'X', color: 'red' }] }, '进过受管表'],
    ['tag 带首尾空白（永远匹配不到记录的死配置）', { limit: null, tags: [{ id: 'mt_z', tag: ' 夹具Z ' }] }, '空白'],
    ['hex 颜色（深色模式下不跟随主题）', { limit: null, tags: [{ id: 'mt_z', tag: '夹具Z', color: '#00ff00' }] }, 'hex'],
    ['自造图标名', { limit: null, tags: [{ id: 'mt_z', tag: '夹具Z', icon: 'rocket' }] }, 'icons.js'],
    ['id 重复', { limit: null, tags: [T1, { ...T1, tag: '另一个' }] }, '重复'],
    ['整张表不是对象（直接传数组）', [T1], 'limit'],
    ['值是 null', null, 'limit'],
    ['超限：3 条 > 上限 2（**只报告、绝不腾位**）', { limit: 2, tags: GOOD.tags }, '必须先合并旧的'],
  ]
  const reasons = []
  for (const [what, value] of cases) {
    const r = s.update({ managedTags: value })
    const err = (r.errors || []).find((e) => e.key === 'managedTags')
    reasons.push({ what, err: err ? err.reason : null, mem: JSON.stringify(s.get().managedTags), disk: JSON.stringify(diskManagedTags(file)) })
  }

  check('★ 每一条非法写法都被拒，并且**给出了能照做的理由**（含 [E] 表的期望关键词）', () => {
    cases.forEach(([what, , needle], i) => {
      const got = reasons[i]
      assert(got.err, '竟然放行了：' + what)
      assert(got.err.indexOf(needle) >= 0, `拒绝理由没提到 ${JSON.stringify(needle)}（${what}）→ ${got.err}`)
    })
  })

  check('★★ 被拒之后：内存**和磁盘**都还是原来那张表（一个字都没落盘）', () => {
    for (const got of reasons) {
      assert(got.mem === memBefore, '内存被改了（' + got.what + '）：' + got.mem)
      assert(got.disk === diskBefore, '磁盘被改了（' + got.what + '）：' + got.disk)
    }
  })

  check('★★ 超限**只报告、不腾位**：旧条目一个都没被顶掉', () => {
    const live = s.get().managedTags
    assert(live.tags.length === GOOD.tags.length, '条目数变了：' + live.tags.length)
    assert(JSON.stringify(live.tags) === JSON.stringify(GOOD.tags), '有条目被静默顶掉了：' + JSON.stringify(live.tags))
    assert(live.limit === null, '上限被偷偷改了：' + JSON.stringify(live.limit))
  })

  // 端到端：走 HTTP 的 PUT 也是同一条路。⚠️ PUT /settings 的老契约是「回平面设置」、
  // 响应体里**没有** errors 字段 —— 所以对客户端来说，**唯一**能看出「没生效」的地方
  // 就是响应体里那张表还是旧的。这里把它钉住（免得将来有人改成「静默写成功」）。
  const resBadPut = await putManaged(handler, { limit: 0, tags: GOOD.tags })
  const bodyBadPut = resBadPut.json()
  check('★ 端到端：HTTP PUT 非法值 → 响应体里还是旧表（客户端据此判断「没生效」）', () => {
    assert(resBadPut.statusCode === 200, '状态码 ' + resBadPut.statusCode)
    assert(JSON.stringify(bodyBadPut.managedTags) === memBefore, '响应体里的表变了：' + JSON.stringify(bodyBadPut.managedTags))
    assert(JSON.stringify(s.get().managedTags) === memBefore, '非法值竟然生效了')
    assert(JSON.stringify(diskManagedTags(file)) === diskBefore, '非法值竟然落盘了')
  })
}

/* ═══ [F] ★★ 反向对照：守卫真的会红吗 ═══════════════════════════════════ */
console.log('\n=== [F] ★★ 反向对照：拿「已知有病」的实现跑同一批断言 ===')
{
  // 三个「已知有病」的实现 —— 每一个都是**这次接线真的会犯**的错，不是稻草人：
  //   ① 拿直出的 `validateManagedTags` 当闸门（它绑死在 `limit=null` 的表上，
  //      **看不见用户设的上限**）—— 这正是我第一版想写、后来否掉的写法；
  //   ② 只检查「是不是数组」，不做条目级校验；
  //   ③ 拿直出的 `checkManagedTagBudget` 报「还剩几个位」。
  const brokenIgnoreLimit = (value) => {
    const checked = validateManagedTags(value.tags)
    if (!checked.ok) return { ok: false, reason: checked.reason }
    return { ok: true, value: { limit: value.limit, tags: checked.value } }
  }
  const brokenShapeOnly = (value) => {
    if (!Array.isArray(value.tags)) return { ok: false, reason: '需要数组' }
    return { ok: true, value: { limit: value.limit, tags: value.tags } }
  }
  const overLimit = { limit: 2, tags: GOOD.tags }
  const styleNoId = { limit: null, tags: [{ tag: 'X', color: 'red' }] }
  const hexColor = { limit: null, tags: [{ id: 'mt_z', tag: 'Z', color: '#00ff00' }] }

  check('★★ ①「忽略用户设的上限」的坏版本：超限表必须被它**放行**（否则 [E] 的超限断言分辨不出好坏）', () => {
    assert(validateManagedTagSettings(overLimit).ok === false, '正确版本竟然放行了超限表 —— 反向对照失去前提')
    assert(brokenIgnoreLimit(overLimit).ok === true,
      '坏版本也拒了 ⇒ [E] 的「超限被拒」不是靠 limit 生效的，而是别的原因 —— 那条断言在空转')
  })

  check('★★ ②「只查数组形状」的坏版本：缺 id / hex 必须被它**放行**', () => {
    assert(validateManagedTagSettings(styleNoId).ok === false, '正确版本放行了「只有样式没有 id」')
    assert(brokenShapeOnly(styleNoId).ok === true, '坏版本也拒了 ⇒ [E] 的缺 id 断言分辨不出好坏')
    assert(validateManagedTagSettings(hexColor).ok === false, '正确版本放行了 hex')
    assert(brokenShapeOnly(hexColor).ok === true, '坏版本也拒了 ⇒ [E] 的 hex 断言分辨不出好坏')
  })

  check('★★ ③「用直出函数报预算」的坏版本：明明限 2 却报「不限」—— 回错话也是坏', () => {
    const good = managedTagRule(2).checkBudget(GOOD.tags)
    const bad = checkManagedTagBudget(GOOD.tags)
    assert(good.ok === false && good.unlimited === false && good.limit === 2, '正确版本算错了：' + JSON.stringify(good))
    assert(bad.unlimited === true && bad.limit === null, '坏版本竟然也说对了 ⇒ 这条反向对照没意义')
    assert(JSON.stringify(good) !== JSON.stringify(bad), '两者一样 ⇒ limit 根本没被喂进去')
  })

  check('★★ 默认预设那条「合法」也不是空转：好样本过、坏样本必须红（[A] 的反向对照再确认一次）', () => {
    const goodTags = DEFAULT_MANAGED_TAGS.tags
    const bad = goodTags.map((t, i) => (i === 0 ? { ...t, color: '#ff0000' } : t))
    assert(bad.length === goodTags.length && bad[0].color === '#ff0000', '坏样本没构造出来')
    assert(validateManagedTags(goodTags).ok === true, '好样本被拒了 —— 对照的前提不成立')
    assert(validateManagedTags(bad).ok === false, '坏样本被放行了 —— [A] 的「默认合法」是空转')
  })
}

/* ═══ [G] 校验入口是规则层本体，不是第二套实现 ═════════════════════════ */
console.log('\n=== [G] 校验入口是规则层本体（同一个 builder），不是第二套实现 ===')
{
  const samples = [
    [], [T1], GOOD.tags,
    [{ tag: 'X', color: 'red' }],
    [{ id: 'mt_z', tag: ' 空格 ' }],
    [{ id: 'mt_z', tag: 'Z', color: '#00ff00' }],
    [{ id: 'mt_z', tag: 'Z', icon: 'rocket' }],
    [{ id: 'mt_z', tag: 'Z', weight: 'heavy' }],
    [{ id: 'MT_Z', tag: 'Z' }],
    'not-an-array', null,
  ]
  const ruleDefault = managedTagRule(null)
  const mismatches = []
  for (const smp of samples) {
    const a = JSON.stringify(ruleDefault.validateManaged(smp))
    const b = JSON.stringify(validateManagedTags(smp))
    if (a !== b) mismatches.push(JSON.stringify(smp) + ': ' + a + ' vs ' + b)
    const arr = Array.isArray(smp) ? smp : []
    const ca = JSON.stringify(ruleDefault.checkBudget(arr))
    const cb = JSON.stringify(checkManagedTagBudget(arr))
    if (ca !== cb) mismatches.push('budget ' + JSON.stringify(smp) + ': ' + ca + ' vs ' + cb)
  }
  check('★ limit=null 时，实例与直出函数**逐样本同结果**（11 个样本，含各种畸形输入）', () => {
    assert(samples.length >= 10, '样本太少（' + samples.length + '）—— 这条等价性就没分量了')
    assert(mismatches.length === 0, '不一致：\n' + mismatches.join('\n'))
  })

  check('★ `managedTagRule(null)` 与 `(undefined)` 都等于「不限」（缺省不该变成「一个都不许」）', () => {
    for (const lim of [null, undefined]) {
      const cb = managedTagRule(lim).checkBudget(GOOD.tags)
      assert(cb.unlimited === true && cb.limit === null && cb.free === null, JSON.stringify(cb))
    }
  })

  check('★★ 反面：limit=3 时**必须与直出函数不同** —— 否则说明上限根本没被喂进去', () => {
    const capped = managedTagRule(3).checkBudget(GOOD.tags)
    assert(capped.unlimited === false && capped.limit === 3, JSON.stringify(capped))
    // 钉**关系**（free = limit − count），不钉某个当时的数
    assert(capped.free === 3 - GOOD.tags.length, 'free 该是 limit − count：' + JSON.stringify(capped))
    assert(JSON.stringify(capped) !== JSON.stringify(checkManagedTagBudget(GOOD.tags)), '两者相同 ⇒ limit 没生效')
    assert(managedTagRule(2).checkBudget(GOOD.tags).ok === false, '限 2 却有 3 条，竟然 ok')
  })

  check('★ 上限写坏时：`ok:false` + `unlimited:false` + 理由里说清「不限怎么写」', () => {
    for (const badLimit of [0, -1, 1.5, '3', true]) {
      const cb = managedTagRule(badLimit).checkBudget(GOOD.tags)
      assert(cb.ok === false, '坏上限被放行了：' + JSON.stringify(badLimit) + ' → ' + JSON.stringify(cb))
      assert(cb.unlimited === false, '坏上限竟然报 unlimited=true：' + JSON.stringify(cb))
      assert(typeof cb.reason === 'string' && cb.reason.indexOf('null') >= 0, '理由里该说清「不限怎么写」：' + cb.reason)
    }
  })

  check('★ `TAG_STYLE_TABLE.limit` 仍是「不限」—— 规则层那张表我一个字没改', () => {
    assert(TAG_STYLE_TABLE.limit === null, '规则层的表被改了：' + JSON.stringify(TAG_STYLE_TABLE.limit))
    const rebuilt = buildTagStyleRule({ ...TAG_STYLE_TABLE }, normalizeTag)
    assert(rebuilt.checkBudget([]).unlimited === true, '重建出来的实例不认「不限」')
  })
}

/* ═══ [H] agent 工具：artifact_tag_styles ═══════════════════════════════ */
console.log('\n=== [H] agent 工具 artifact_tag_styles（默认 dry-run、拒非法、不崩）===')
{
  const dir = path.join(TMP, 'toolstore')
  fs.mkdirSync(dir, { recursive: true })
  const store = new ArtifactStore(dir).load()
  const registry = new Map()
  const ctx = { tools: { register(t) { registry.set(t.name, t); return () => registry.delete(t.name) } } }
  const { file, s } = freshSettings('tool-settings')
  registerArtifactTools(ctx, store, s)
  const tool = registry.get('artifact_tag_styles')
  const run = (args) => tool.execute(args, {})
  const memNow = () => JSON.stringify(s.get().managedTags)

  check('★ 工具注册上了：action 枚举 = list/set，有 confirm，描述里写清默认 dry-run 与 hex 不收', () => {
    assert(tool, 'artifact_tag_styles 没注册')
    const prop = tool.parameters.properties.action
    assert(JSON.stringify(prop.enum) === JSON.stringify(['list', 'set']), JSON.stringify(prop.enum))
    assert(Object.prototype.hasOwnProperty.call(tool.parameters.properties, 'confirm'), '缺 confirm 参数')
    assert(/默认只预演|不落盘/.test(tool.description), '描述该说清默认 dry-run：' + tool.description.slice(0, 140))
    assert(/hex/.test(tool.description), '描述该警告 hex 不收：' + tool.description.slice(0, 220))
  })

  // ① list（此时磁盘上还没有 settings.json —— 所以这一条只比内存）
  const memBeforeList = JSON.stringify(s.get())
  const listOut = (await run({ action: 'list' })).text
  check('★ list：报出当前表 / 上限「不限」/ 全部色板与图标 / 怎么落盘', () => {
    assert(/受管标签表/.test(listOut), listOut.slice(0, 200))
    assert(/不限/.test(listOut), '该说清「不限」：' + listOut.slice(0, 320))
    assert(listOut.indexOf(`共 ${DEFAULT_MANAGED_TAGS.tags.length} 条`) >= 0,
      '该报条目数（这里比的是**与默认预设的关系**，不是写死的数）：' + listOut.slice(0, 200))
    assert(TAG_COLOR_SLOTS.every((slot) => listOut.indexOf(slot) >= 0), '该列出全部色板槽名')
    assert(TAG_ICONS.every((ic) => listOut.indexOf(ic) >= 0), '该列出全部图标名')
    assert(/confirm/.test(listOut), '该告诉 agent 怎么落盘：' + listOut.slice(-280))
  })
  check('★ list 是只读的：跑完设置一个字节都没变', () => {
    assert(JSON.stringify(s.get()) === memBeforeList, 'list 竟然改了设置')
  })

  // ② set 不传 confirm = dry-run
  const dryOut = (await run({ action: 'set', tags: [T1, T2] })).text
  check('★ set 不传 confirm ⇒ **只预演**：文案说清，设置一个字没改', () => {
    assert(/预演/.test(dryOut) && /一个字都没改/.test(dryOut), dryOut.slice(-320))
    assert(JSON.stringify(s.get()) === memBeforeList, '预演竟然写进去了')
    assert(dryOut.indexOf('夹具A') >= 0, '预演该把改动后的表列出来：' + dryOut.slice(0, 320))
  })

  // ③ set + confirm = 真落盘（这一步同时把 settings.json 创建出来，后面才能验磁盘）
  const okOut = (await run({ action: 'set', tags: [T1, T2, T3], confirm: true })).text
  const diskAfterOk = diskManagedTags(file)
  check('★ set + confirm:true ⇒ 真的落盘（内存与磁盘都对得上）', () => {
    assert(/✅/.test(okOut), okOut.slice(0, 240))
    assert(JSON.stringify(s.get().managedTags.tags) === JSON.stringify([T1, T2, T3]), '内存: ' + JSON.stringify(s.get().managedTags))
    assert(diskAfterOk !== null && JSON.stringify(diskAfterOk.tags) === JSON.stringify([T1, T2, T3]), '磁盘: ' + JSON.stringify(diskAfterOk))
  })

  // ④ 非法写入：一律拒 + 内存/磁盘都不动
  const memLocked = memNow()
  const diskLocked = JSON.stringify(diskManagedTags(file))
  const badCases = [
    ['hex 颜色', { action: 'set', tags: [{ id: 'mt_z', tag: 'Z', color: '#00ff00' }], confirm: true }, 'hex'],
    ['缺 id（只有样式）', { action: 'set', tags: [{ tag: 'Z', color: 'red' }], confirm: true }, '进过受管表'],
    ['tag 带首尾空白', { action: 'set', tags: [{ id: 'mt_z', tag: ' Z ' }], confirm: true }, '空白'],
    ['limit: 0', { action: 'set', limit: 0, confirm: true }, 'null'],
    ['超限（3 条 > 上限 2）', { action: 'set', limit: 2, confirm: true }, '必须先合并旧的'],
  ]
  const badOuts = []
  for (const [what, args] of badCases) {
    badOuts.push({
      what,
      text: (await run(args)).text,
      mem: memNow(),
      disk: JSON.stringify(diskManagedTags(file)),
    })
  }
  check('★★ 非法写入：一律 ❌，且**内存与磁盘都没变**（含「超限只报告、不腾位」）', () => {
    for (const b of badOuts) {
      assert(/❌/.test(b.text), '没报错（' + b.what + '）：' + b.text.slice(0, 260))
      assert(b.mem === memLocked, '内存被改了（' + b.what + '）：' + b.mem)
      assert(b.disk === diskLocked, '磁盘被改了（' + b.what + '）：' + b.disk)
    }
    assert(JSON.stringify(s.get().managedTags.tags) === JSON.stringify([T1, T2, T3]), '旧条目被静默顶掉了')
  })
  check('★ 拒绝文案说清**怎么改**（limit:0 → 「要表达不限请写 null」，并顺手给出工具里的写法）', () => {
    const byWhat = Object.fromEntries(badOuts.map((b) => [b.what, b.text]))
    assert(/null/.test(byWhat['limit: 0']), byWhat['limit: 0'].slice(0, 320))
    assert(/unlimited/.test(byWhat['limit: 0']), '该顺手告诉 agent 工具里的写法：' + byWhat['limit: 0'].slice(0, 320))
    assert(/进过受管表/.test(byWhat['缺 id（只有样式）']), byWhat['缺 id（只有样式）'].slice(0, 320))
  })

  // ⑤ 参数语义：冲突 / 类型错
  const conflictOut = (await run({ action: 'set', limit: 5, unlimited: true })).text
  check('★ `limit` 与 `unlimited:true` 同时给 ⇒ 明确报「意思冲突」（一个参数不说两种意思）', () => {
    assert(/冲突/.test(conflictOut), conflictOut.slice(0, 300))
  })
  const nullTagsOut = (await run({ action: 'set', tags: null })).text
  const numTagsOut = (await run({ action: 'set', tags: 42 })).text
  check('★★「没传 tags」与「传了但类型不对」分得开：null / 42 明确报错，并提示清空要用 `[]`', () => {
    for (const [what, text] of [['null', nullTagsOut], ['42', numTagsOut]]) {
      assert(/❌/.test(text), what + ' 竟然没报错：' + text.slice(0, 220))
      assert(/\[\]/.test(text), what + ' 的文案该说清「清空请传 []」：' + text.slice(0, 320))
    }
    assert(JSON.stringify(s.get().managedTags.tags) === JSON.stringify([T1, T2, T3]), '这两种写法竟然改了数据')
  })

  // ⑥ 上限真的能编辑、也真的生效
  const capOut = (await run({ action: 'set', limit: 2, tags: [T1, T2], confirm: true })).text
  check('★ 用户自己设的上限**真的生效**（限 2 + 2 条通过，且报告里报出「还剩 0 个位」）', () => {
    assert(/✅/.test(capOut), capOut.slice(0, 240))
    assert(s.get().managedTags.limit === 2, '上限没存进去：' + JSON.stringify(s.get().managedTags.limit))
    assert(/还剩 0 个位/.test(capOut), '报告该说清还剩几个位：' + capOut.slice(0, 320))
  })
  const unlimitedOut = (await run({ action: 'set', unlimited: true, confirm: true })).text
  check('★ `unlimited:true` 把上限打回 null（不限），条目一个不动', () => {
    assert(/✅/.test(unlimitedOut), unlimitedOut.slice(0, 240))
    assert(s.get().managedTags.limit === null, 'limit: ' + JSON.stringify(s.get().managedTags.limit))
    assert(JSON.stringify(s.get().managedTags.tags) === JSON.stringify([T1, T2]), '条目被动了')
    assert(diskManagedTags(file).limit === null, '磁盘上没落盘')
  })
  // ⑧ 契约里的写法（`limit: null`）也要收 —— agent 照合同写不该被拒
  const capOut3 = (await run({ action: 'set', limit: 3, tags: [T1, T2, T3], confirm: true })).text
  const limitAfterCap3 = s.get().managedTags.limit
  const nullLimitOut = (await run({ action: 'set', limit: null, confirm: true })).text
  const limitAfterNull = s.get().managedTags.limit
  check('★ 照**契约**写 `limit: null` 也按「不限」办（不能因为用了合同里的写法就拒）', () => {
    assert(/✅/.test(capOut3) && limitAfterCap3 === 3, '前置失败：上限 3 没设上（' + JSON.stringify(limitAfterCap3) + '）')
    assert(/✅/.test(nullLimitOut), '照契约写 null 竟然被拒：' + nullLimitOut.slice(0, 280))
    assert(limitAfterNull === null, 'limit: ' + JSON.stringify(limitAfterNull))
  })

  // ⑨ notes 必须转达（同一件事的两种写法各占一个受管位 —— 规则层会提示，工具不许吃掉）
  const dupOut = (await run({ action: 'set', tags: [{ id: 'mt_dsh_a', tag: 'DSH' }, { id: 'mt_dsh_b', tag: 'dsh' }], confirm: true })).text
  check('★ `notes` 必须转达：两种写法各占一个受管位 → 提示去走 3b 的合并（吃掉 = 静默）', () => {
    assert(/✅/.test(dupOut), dupOut.slice(0, 280))
    assert(/两种写法|合并/.test(dupOut), '提示被吃掉了（静默）：' + dupOut.slice(0, 420))
    assert(s.get().managedTags.tags.length === 2, '表没写进去：' + JSON.stringify(s.get().managedTags))
  })

  const clearOut = (await run({ action: 'set', tags: [], confirm: true })).text
  check('★ 传 `[]` 才是「清空受管表」（显式、不歧义），并说明空表意味着什么', () => {
    assert(/✅/.test(clearOut), clearOut.slice(0, 240))
    assert(Array.isArray(s.get().managedTags.tags) && s.get().managedTags.tags.length === 0, '没清空：' + JSON.stringify(s.get().managedTags))
    assert(/空表/.test(clearOut), '该说明空表意味着什么：' + clearOut.slice(0, 320))
  })

  // ⑦ 老调用方没接设置存储：读要落回默认、写要明确拒绝，都不许崩
  const registry2 = new Map()
  const ctx2 = { tools: { register(t) { registry2.set(t.name, t); return () => registry2.delete(t.name) } } }
  registerArtifactTools(ctx2, store)   // ⚠️ 不传 settings（降级成只读空表）
  const tool2 = registry2.get('artifact_tag_styles')
  const list2 = (await tool2.execute({ action: 'list' }, {})).text
  const set2 = (await tool2.execute({ action: 'set', tags: [T1], confirm: true }, {})).text
  check('★ 没接设置存储时：list 落回默认预设（不崩），set 明确拒绝（**不假装成功**）', () => {
    assert(/受管标签表/.test(list2), '读崩了：' + list2.slice(0, 220))
    assert(list2.indexOf(`共 ${DEFAULT_MANAGED_TAGS.tags.length} 条`) >= 0, '没落回默认预设：' + list2.slice(0, 220))
    assert(/❌/.test(set2) && /一个字都没改/.test(set2), '写没有明确拒绝（可能假装成功了）：' + set2.slice(0, 320))
  })
}

/* ═══ [I] 守卫的输入预处理也要被验 ═══════════════════════════════════════ */
console.log('\n=== [I] 「没落盘」这类断言的**读取器**本身必须大声失败（不许静默假绿）===')
{
  const { file, s } = freshSettings('disk-reader')
  const existedBefore = fs.existsSync(file)
  s.update({ managedTags: GOOD })
  const existsAfter = fs.existsSync(file)

  check('★ 前置：成功写入**确实**会创建/改写磁盘文件 —— 否则「没变」恒真（等于没验）', () => {
    assert(existedBefore === false, '前置不成立：文件一开始就存在？')
    assert(existsAfter === true, '写成功了却没落盘')
    assert(diskManagedTags(file) !== null, '文件里没有 managedTags')
  })
  check('★★ 读不到文件 ⇒ **抛**（不是安静地回 undefined —— 那会让「没落盘」恒真）', () => {
    assertThrows(() => diskManagedTags(path.join(TMP, 'no-such-settings.json')), '文件不存在')
  })
  check('★★ 文件形状不对 / 不是 JSON ⇒ 也**抛**（读失败必须和「读到了、内容是空」用不同的结果）', () => {
    const wrongShape = path.join(TMP, 'wrong-shape.json')
    fs.writeFileSync(wrongShape, JSON.stringify({ hello: 1 }), 'utf8')
    assertThrows(() => diskManagedTags(wrongShape), '形状不对')
    const notJson = path.join(TMP, 'not-json.json')
    fs.writeFileSync(notJson, '{oops', 'utf8')
    assertThrows(() => diskManagedTags(notJson), '不是 JSON')
  })
  check('★ 反向对照：读取器**确实**读得到刚写进去的真值（否则上面两条「抛」可能只是它永远在抛）', () => {
    const seen = diskManagedTags(file)
    assert(seen && JSON.stringify(seen.tags) === JSON.stringify(GOOD.tags), '读取器读不到真值：' + JSON.stringify(seen))
  })
}

/* ═══ [J] 「磁盘上那份被丢了」必须能看出来（否则端点那道闸门是空转的）═══════ */
console.log('\n=== [J] 磁盘上的受管表被丢弃时，端点必须**说出来**（不许把默认预设冒充成他配的那张表）===')
{
  // ── 这一节守的是什么 ────────────────────────────────────────────────────
  // `SettingsStore.load()` 会把**不合法**的键丢掉，而 `get()` 又拿 `DEFAULT_SETTINGS`
  // 把丢掉的位置**填成默认预设** ⇒ 端点里「把读到的值再过一遍闸门」这个写法
  // **永远为真**（它验的只可能是默认预设）= 空转守卫。
  // 症状：手改 / 同步工具把 `limit` 写成 `0` ⇒ 端点回
  // `{ok:true, limit:null, tags:[8 条默认预设]}`，把默认预设冒充成他配的那张表。
  //
  // ⚠️ 这一节是 2026-10-08 由一个**独立探针**（另写一份真 store + 真 settings 的夹具，
  //    不共用本文件的假 store）实测出来的，不是推演。探针还验过：
  //    把修好的代码里那段 `rejectedKeys` 检查摘掉，它**精确复现**了这 6 条失败。

  const writeRaw = (name, managedTags) => {
    const file = settingsFile(name)
    fs.writeFileSync(file, JSON.stringify({ version: 1, values: { managedTags } }, null, 2), 'utf8')
    return { file, s: new SettingsStore({ file }).load() }
  }
  const readMt = async (handler) => {
    const res = await call(handler, 'GET', '/ext/artifacts/managed-tags')
    let body = null
    try { body = res.json() } catch { body = null }
    return { status: res.statusCode, body, raw: res.bodyText() }
  }
  /** 端点把默认预设冒充成「他配的表」了吗 —— 这才是本节要抓的病 */
  const impersonating = (r) => r.status === 200 && r.body && r.body.ok === true
    && r.body.limit === null && Array.isArray(r.body.tags)
    && r.body.tags.length === DEFAULT_MANAGED_TAGS.tags.length

  // 四种「用户配的、但不合法」的 limit + 两种形状错。全是**手改/同步工具真会写出来的**值。
  // ⚠️ 第三项是「错误信息里该点名哪个字段」的期望值 —— 它是**逐例**给的，
  //    因为 `limit` 坏和 `tags` 坏该说的是两个不同的字段名。
  //    （我第一版对所有例子都断言必须出现 `limit`，于是 `tags` 那条**误报**了 —— 记在这里。）
  const badCases = [
    ['limit 写成 0', { limit: 0, tags: GOOD.tags }, 'limit'],
    ['limit 写成负数', { limit: -5, tags: GOOD.tags }, 'limit'],
    ['limit 写成小数', { limit: 1.5, tags: GOOD.tags }, 'limit'],
    ['limit 写成字符串', { limit: '16', tags: GOOD.tags }, 'limit'],
    ['tags 不是数组', { limit: null, tags: '夹具A' }, '数组'],
    ['整个 managedTags 是个数组', GOOD.tags, 'limit'],
  ]

  for (const [label, bad, needle] of badCases) {
    const { s } = writeRaw('reject-' + badCases.findIndex((c) => c[0] === label), bad)
    const { handler } = handlerWith(s)
    const r = await readMt(handler)
    check('★★ ' + label + ' ⇒ 必须结构化失败，**不许**把默认预设冒充成他配的那张表', () => {
      assert(s.rejected && typeof s.rejected.managedTags === 'string' && s.rejected.managedTags.length > 0,
        '存储层没记下「这个键被丢了」—— 那么端点根本无从知道（这正是空转的根源）：' + JSON.stringify(s.rejected))
      assert(r.status !== 200, '竟然回了 200：' + r.raw)
      assert(r.body && r.body.ok === false, 'ok 应为 false：' + r.raw)
      assert(r.body && r.body.reason === 'invalid-managed-tags', 'reason 该是 invalid-managed-tags：' + r.raw)
      assert(!impersonating(r), '把默认预设冒充成他配的那张表了：' + r.raw)
      // 失败要说清「为什么」—— 光回 500 而不说哪不对，用户无从下手
      assert(typeof r.body.error === 'string' && r.body.error.indexOf(needle) >= 0,
        '错误信息里没提 ' + JSON.stringify(needle) + '（用户看不出是哪个字段坏）：' + r.raw)
    })
  }

  // ── 反向对照 ①：**合法**的磁盘内容必须照旧 200（否则上面六条可能只是「写啥都 500」）──
  {
    const file = settingsFile('reject-good')
    fs.writeFileSync(file, JSON.stringify({ version: 1, values: { managedTags: { limit: 3, tags: GOOD.tags } } }, null, 2), 'utf8')
    const s = new SettingsStore({ file }).load()
    const { handler } = handlerWith(s)
    const r = await readMt(handler)
    check('★ 反向对照：磁盘上是**合法**表时必须照旧 200 且原样吐出来', () => {
      assert(Object.keys(s.rejected || {}).length === 0, '合法内容竟然被记成丢弃：' + JSON.stringify(s.rejected))
      assert(r.status === 200 && r.body.ok === true, '合法表被拒了：' + r.raw)
      assert(r.body.limit === 3 && r.body.tags.length === GOOD.tags.length, '没原样吐出来：' + r.raw)
    })
  }

  // ── 反向对照 ②：**写回来**必须清掉记录（否则「坏过一次」会永远红下去，用户没法自救）──
  {
    const { s } = writeRaw('reject-recover', { limit: 0, tags: GOOD.tags })
    const { handler } = handlerWith(s)
    const before = await readMt(handler)
    check('★ 反向对照：坏表先红一次', () => {
      assert(before.status === 500, '坏表没红，后面「写回来能恢复」就无从谈起：' + before.raw)
    })
    const put = await call(handler, 'PUT', '/ext/artifacts/settings', { managedTags: { limit: 3, tags: GOOD.tags } })
    assert(put.statusCode === 200, 'PUT 竟然失败：' + put.bodyText())
    const after = await readMt(handler)
    check('★★ 用户把表**合法地写回来**之后，端点必须恢复正常（记录要跟着清）', () => {
      assert(!s.rejected || s.rejected.managedTags === undefined,
        '写回来了却还记着「被丢弃」⇒ 用户永远修不好：' + JSON.stringify(s.rejected))
      assert(after.status === 200 && after.body.ok === true, '写回来了还是红的：' + after.raw)
      assert(after.body.limit === 3, '写回来的值没生效：' + after.raw)
    })
  }

  // ── 反向对照 ③：接线漏了 `rejectedKeys()` ⇒ **大声失败**，不许静默降级 ──
  // 这条是本节的元守卫：守卫自己要靠一个访问器，那「访问器没接」就不能是静默的。
  // 实测过：我第一版读的是 `deps.settings.rejected`，而 lib/index.js 那个适配器
  // 只透出 4 个方法 ⇒ 真机上恒为 undefined ⇒ 守卫继续空转。
  {
    const { s } = freshSettings('no-accessor')
    const store = fakeStore()
    const handler = artifactsHandler(store, {
      store,
      fileIndex: {},
      settings: {
        get: () => s.get(),
        update: (p) => s.update(p),
        export: (l) => s.exportPayload(l),
        import: (p) => s.importPayload(p),
        // ★ 刻意**不给** rejectedKeys
      },
    })
    const r = await readMt(handler)
    check('★★ 接线漏了 `rejectedKeys()` ⇒ 500 且说清是接线问题（**不许**静默当成「没有键被丢」）', () => {
      assert(r.status === 500, '静默放行了 —— 守卫又空转了：' + r.raw)
      assert(r.body && r.body.ok === false, 'ok 应为 false：' + r.raw)
      assert(typeof r.body.error === 'string' && r.body.error.indexOf('rejectedKeys') >= 0,
        '错误信息里没点名缺什么，接线的人会找不到：' + r.raw)
      assert(!impersonating(r), '静默回默认表了：' + r.raw)
    })
  }

  // ── 反向对照 ④：没挂 `deps.settings`（老调用方）必须照旧落回默认预设、不崩 ──
  // ⚠️ 这条是防「修守卫时把老路一起修坏了」：老 store-only 的调用方本来就该拿到默认预设。
  {
    const store = fakeStore()
    const handler = artifactsHandler(store, { store, fileIndex: {} })
    const r = await readMt(handler)
    check('★ 没挂 `deps.settings` 的老调用方：照旧落回默认预设（不 500、不崩）', () => {
      assert(r.status === 200 && r.body.ok === true, '老路被修坏了：' + r.raw)
      assert(r.body.limit === null && r.body.tags.length === DEFAULT_MANAGED_TAGS.tags.length, '没落回默认：' + r.raw)
    })
  }
}

/* ═══ [K] 同一个病在**另一个消费者**身上：agent 工具 `artifact_tag_styles` ═══ */
console.log('\n=== [K] agent 工具也必须说出「磁盘上那份被丢了」（同一个病不会因为修了一处就消失）===')
{
  // ⚠️ 为什么单开一节：3c 的教训是「只覆盖一个消费者 ⇒ 另一个漏掉时测试会全绿」。
  //    端点（[J]）和 agent 工具是**两个**独立消费者，各自都要有断言。
  //    这一节也是 2026-10-08 实测出来的：工具会把 8 条默认预设报成「他的受管表」，
  //    而 `set unlimited:true`（agent 以为在「只把上限去掉」）**把默认预设落成了他的配置**。
  const toolFor = (s) => {
    const store = fakeStore()
    const registry = new Map()
    const ctx = { tools: { register(t) { registry.set(t.name, t); return () => registry.delete(t.name) } } }
    registerArtifactTools(ctx, store, s)
    const tool = registry.get('artifact_tag_styles')
    assert(tool, 'artifact_tag_styles 没注册')
    return { tool, run: (args) => tool.execute(args, {}), s }
  }
  const writeRaw = (name, managedTags) => {
    const file = settingsFile(name)
    fs.writeFileSync(file, JSON.stringify({ version: 1, values: { managedTags } }, null, 2), 'utf8')
    return new SettingsStore({ file }).load()
  }
  /** 工具输出里把**默认预设**当成「他的表」报出来了吗（= 冒充） */
  const showsDefaultAsHis = (out) => out.indexOf('三角洲行动') >= 0
    || out.indexOf(`共 ${DEFAULT_MANAGED_TAGS.tags.length} 条`) >= 0
  const admitsDropped = (out) => /不合法|被忽略|丢弃|幻影|默认预设.*不是他/.test(out)

  // ── 前提对照：磁盘上是合法表时，工具照旧正常（否则后面几条可能只是「工具永远在报错」）──
  {
    const s = writeRaw('tool-good', { limit: 2, tags: [T1, T2] })
    const { run } = toolFor(s)
    const out = (await run({ action: 'list' })).text
    check('★ 前提对照：磁盘上是**合法**表时 list 照旧正常（且不冒充）', () => {
      assert(out.indexOf(T1.tag) >= 0, '合法表没被报出来：' + out.slice(0, 240))
      assert(!admitsDropped(out), '合法表竟然报了「被丢弃」：' + out.slice(0, 240))
    })
  }

  for (const [label, bad] of [
    ['limit 写成 0', { limit: 0, tags: [T1, T2] }],
    ['tags 不是数组', { limit: null, tags: T1.tag }],
  ]) {
    const s = writeRaw('tool-bad-' + label.length, bad)
    const { run } = toolFor(s)
    const out = (await run({ action: 'list' })).text
    check('★★ ' + label + ' ⇒ list 必须**顶在最前面**说清「这份是默认预设、不是他的表」', () => {
      assert(admitsDropped(out), '工具没提「被丢弃」：' + out.slice(0, 300))
      // ⚠️ 必须在**开头**：埋在末尾等于没说（agent 只读前几行就下结论是常态）
      assert(admitsDropped(out.slice(0, 200)), '提示没顶在最前面，等于没说：' + out.slice(0, 300))
      assert(showsDefaultAsHis(out), '前提不对：这份确实应该是默认预设（否则这条断言在验别的东西）')
    })
  }

  // ── ★★ 最危险的一条：不许在**幻影表**上改 ──
  {
    const file = settingsFile('tool-phantom')
    fs.writeFileSync(file, JSON.stringify({ version: 1, values: { managedTags: { limit: 0, tags: [T1, T2] } } }, null, 2), 'utf8')
    const s = new SettingsStore({ file }).load()
    const { run } = toolFor(s)
    const out = (await run({ action: 'set', unlimited: true, confirm: true })).text
    // ⚠️ 判据必须是**磁盘上那个文件**，不能是 `s.get()`：
    //    `get()` 本来就会把被丢弃的键填成默认预设，所以「有没有默认预设」恒真、
    //    「和改之前比有没有变」也恒真（两边都是同一份默认预设）—— 两条都是假绿。
    //    我第一版就是这么写的，实测当场红了才发现（记在这里）。
    const onDisk = diskManagedTags(file)
    check('★★ 「只改上限」不许拿默认预设当底稿（否则 = 一次静默的整表替换）', () => {
      assert(/幻影|拒绝/.test(out), '没说清是拒绝：' + out.slice(0, 300))
      assert(onDisk && onDisk.limit === 0, '磁盘上被改写了（上限不再是原来那个坏的 0）：' + JSON.stringify(onDisk))
      assert(onDisk && JSON.stringify(onDisk.tags) === JSON.stringify([T1, T2]),
        '磁盘上的条目被换成了别的（很可能就是默认预设）：' + JSON.stringify(onDisk))
      assert(out.indexOf('三角洲行动') < 0, '工具输出里冒出了默认预设的内容：' + out.slice(0, 300))
    })
  }

  // ── 反向对照（关键）：**没被丢弃**时，「只改上限」必须照旧允许 ──
  // 否则上面那条可能只是「set 不传 tags 永远被拒」的假绿。
  {
    const s = writeRaw('tool-nodrop', { limit: 2, tags: [T1, T2] })
    const { run } = toolFor(s)
    const out = (await run({ action: 'set', unlimited: true, confirm: true })).text
    const now = s.get().managedTags
    check('★ 反向对照：**没被丢弃**时「只改上限」照旧允许（证明上面那条拒的是丢弃、不是拒这个用法）', () => {
      assert(now.limit === null, '上限没被改掉：' + JSON.stringify(now.limit) + ' 输出：' + out.slice(0, 200))
      assert(JSON.stringify(now.tags) === JSON.stringify([T1, T2]), '条目被动了：' + JSON.stringify(now.tags))
    })
  }

  // ── 出路：显式传 `tags` = 有意的整表替换，必须放行，且写完记录要清 ──
  {
    const s = writeRaw('tool-override', { limit: 0, tags: [T1, T2] })
    const { run } = toolFor(s)
    const out = (await run({ action: 'set', tags: [T1, T2, T3], confirm: true })).text
    const now = s.get().managedTags
    const after = (await run({ action: 'list' })).text
    check('★★ 显式传 `tags` 覆盖是允许的（那是一次有意的整表替换），且写完记录要清', () => {
      assert(JSON.stringify(now.tags) === JSON.stringify([T1, T2, T3]), '覆盖没生效：' + JSON.stringify(now.tags) + ' 输出：' + out.slice(0, 200))
      assert(!s.rejected || s.rejected.managedTags === undefined, '写回来了却还记着「被丢弃」：' + JSON.stringify(s.rejected))
      assert(!admitsDropped(after), '覆盖之后 list 还在报「被丢弃」：' + after.slice(0, 240))
    })
  }

  // ── 元守卫：接了存储却问不出「哪些键被丢」⇒ 工具必须**大声拒绝** ──
  {
    const registry = new Map()
    const ctx = { tools: { register(t) { registry.set(t.name, t); return () => registry.delete(t.name) } } }
    // 一个「形状认识、但漏了访问器」的设置替身 —— 正是 lib/index.js 改之前那个样子
    registerArtifactTools(ctx, fakeStore(), {
      get: () => ({ managedTags: { limit: null, tags: [T1] } }),
      update: () => ({ applied: [], errors: [], notes: [] }),
    })
    const tool = registry.get('artifact_tag_styles')
    const out = (await tool.execute({ action: 'list' }, {})).text
    check('★★ 接了存储却问不出「哪些键被丢」⇒ 工具拒绝（不许静默当成「没有键被丢」）', () => {
      assert(/接线不完整|rejectedKeys|拿不到/.test(out), '静默放行了 —— 守卫又空转了：' + out.slice(0, 260))
      assert(!showsDefaultAsHis(out), '竟然还是把默认预设报出来了：' + out.slice(0, 260))
    })
  }
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
