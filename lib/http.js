/**
 * dsh-artifact-library — HTTP API + 管理页面服务
 * 挂载在 /ext/artifacts（JSON API）和 /ext/artifact-library（管理页）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.resolve(__dirname, '..', 'ui')

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) { req.destroy(); reject(new Error('body too large')) } })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { reject(new Error('invalid JSON')) } })
    req.on('error', reject)
  })
}

/** /ext/artifacts* 的统一处理器：按 method + 路径尾部分发 */
export function artifactsHandler(store, deps = {}) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const tail = url.pathname.replace(/^\/ext\/artifacts/, '').replace(/\/+$/, '') || ''
      const id = tail.startsWith('/') ? tail.slice(1) : tail
      const q = Object.fromEntries(url.searchParams)

      if (req.method === 'GET' && id === 'stats') {
        return sendJson(res, 200, store.stats())
      }
      if (req.method === 'GET' && id === 'categories') {
        return sendJson(res, 200, store.categories())
      }
      // B1 语义搜索：GET /ext/artifacts/search?q=...&kind=&project=&limit=
      if (req.method === 'GET' && id === 'search') {
        const hits = store.searchSemantic(q.q || '', { kind: q.kind, project: q.project, limit: Number(q.limit) || 20 })
        return sendJson(res, 200, { query: q.q || '', hits })
      }
      // C1 连线建议：GET /ext/artifacts/:id/related
      if (req.method === 'GET' && id.endsWith('/related')) {
        const rec = store.get(id.slice(0, -8))
        if (!rec) return sendJson(res, 404, { error: 'not found' })
        return sendJson(res, 200, { id: rec.id, links: store.suggestLinks(rec.id, { limit: Number(q.limit) || 8 }) })
      }
      // C2 整理建议单：GET /ext/artifacts/suggest-cleanup
      if (req.method === 'GET' && id === 'suggest-cleanup') {
        return sendJson(res, 200, store.suggestCleanup())
      }
      if (req.method === 'GET' && id === 'settings') {
        return sendJson(res, 200, store.getSettings())
      }
      if (req.method === 'PUT' && id === 'settings') {
        const body = await readBody(req)
        return sendJson(res, 200, store.updateSettings(body))
      }
      if (req.method === 'POST' && id === 'refine-session') {
        const body = await readBody(req)
        if (!deps.runRefineSession) return sendJson(res, 500, { error: '精化会话功能未启用' })
        const result = await deps.runRefineSession({
          ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
          project: body.project || '',
          folder: !!body.folder,
          all: !!body.all,
        })
        return result.ok ? sendJson(res, 200, result) : sendJson(res, 500, result)
      }
      if (req.method === 'POST' && id === 'refine-request') {
        const body = await readBody(req)
        return sendJson(res, 200, store.requestRefine({
          ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
          project: body.project || '',
          folder: !!body.folder,
        }))
      }
      if (req.method === 'POST' && id === 'cleanup-now') {
        const { runCleanup, backupStore } = await import('./cleanup.js')
        const result = runCleanup(store)
        const bk = backupStore(store)
        store.markCleanupDone()
        return sendJson(res, 200, { ...result, backup: bk.backedUp })
      }
      if (req.method === 'GET' && id === 'export') {
        const data = store.exportData()
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="artifact-library-export.json"',
        })
        return res.end(JSON.stringify(data, null, 2))
      }
      if (req.method === 'POST' && id === 'import') {
        const body = await readBody(req)
        // 本地扫描，绝不上传；project 缺省用目录名
        const result = store.importFolder(body.dir, { project: body.project })
        return sendJson(res, 200, result)
      }
      if (req.method === 'GET' && !id) {
        return sendJson(res, 200, store.list({
          q: q.q, project: q.project, artifact_type: q.artifact_type, tag: q.tag, kind: q.kind, refine: q.refine,
          status: q.status, sort: q.sort, limit: Number(q.limit) || 500,
        }))
      }
      if (req.method === 'GET' && id.endsWith('/file')) {
        const rec = store.get(id.slice(0, -5))
        if (!rec || !rec.exists) return sendJson(res, 404, { error: 'not found or file missing' })
        let st
        try { st = fs.statSync(rec.path) } catch { return sendJson(res, 404, { error: 'file missing' }) }
        if (!st.isFile()) return sendJson(res, 400, { error: 'not a file' })
        res.writeHead(200, { 'content-type': rec.mime_type || 'application/octet-stream', 'content-length': st.size })
        const stream = fs.createReadStream(rec.path)
        stream.on('error', () => { res.destroy() })
        stream.pipe(res)
        return
      }
      if (req.method === 'GET' && id) {
        const rec = store.get(id)
        return rec ? sendJson(res, 200, rec) : sendJson(res, 404, { error: 'not found' })
      }
      if (req.method === 'POST' && !id) {
        const body = await readBody(req)
        return sendJson(res, 201, store.register(body))
      }
      if (req.method === 'PATCH' && id) {
        const body = await readBody(req)
        const rec = store.update(id, body)
        return rec ? sendJson(res, 200, rec) : sendJson(res, 404, { error: 'not found' })
      }
      if (req.method === 'POST' && id.endsWith('/open')) {
        const rec = store.get(id.slice(0, -5))
        if (!rec) return sendJson(res, 404, { error: 'not found' })
        if (!fs.existsSync(rec.path)) return sendJson(res, 404, { error: 'file missing' })
        // Windows 资源管理器定位（/select 选中文件，目录则打开）；只服务已登记路径
        const p = spawn('explorer.exe', ['/select,' + rec.path], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' })
        p.unref()
        return sendJson(res, 200, { ok: true, path: rec.path })
      }
      if (req.method === 'POST' && id.endsWith('/trash')) {
        const rec = store.trash(id.slice(0, -6))
        return rec ? sendJson(res, 200, rec) : sendJson(res, 404, { error: 'not found' })
      }
      if (req.method === 'POST' && id.endsWith('/restore')) {
        const rec = store.restore(id.slice(0, -8))
        return rec ? sendJson(res, 200, rec) : sendJson(res, 404, { error: 'not found' })
      }
      if (req.method === 'DELETE' && id) {
        try {
          const ok = store.hardDelete(id)
          return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not found' })
        } catch (e) {
          return sendJson(res, 400, { error: e.message })
        }
      }
      return sendJson(res, 405, { error: 'method not allowed' })
    } catch (e) {
      return sendJson(res, 400, { error: e.message })
    }
  }
}

/** /ext/artifact-library* 的管理页面（单文件自包含 UI；每次请求读取，改 UI 无需重启） */
export function uiHandler() {
  const page = path.join(UI_DIR, 'index.html')
  let cached = null
  let cachedMtime = 0
  const readPage = () => {
    try {
      const st = fs.statSync(page)
      if (!cached || st.mtimeMs !== cachedMtime) {
        cached = fs.readFileSync(page)
        cachedMtime = st.mtimeMs
      }
      return cached
    } catch {
      return Buffer.from('<!doctype html><title>产物库</title><p>UI 文件缺失</p>')
    }
  }
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const tail = url.pathname.replace(/^\/ext\/artifact-library/, '') || '/'
    if (tail === '/' || tail === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(readPage())
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }
  }
}
