// memory-hub · HTTP 服务：单进程单端口，默认 127.0.0.1。
//   POST {base}/mcp     MCP Streamable HTTP（无状态，dual-era：2025 年代 initialize 与 2026-07-28 server/discover 皆可）
//   POST {base}/api/ingest 会话文本摄入（Bearer 令牌，需 write scope；见 docs/ingest-api.md）
//   GET  {base}/healthz 存活探针（无需鉴权）
//   {base}/admin/        管理界面静态文件（M2，只读）；{base}/admin/api/* 管理 API（会话 cookie 认证，与 /mcp 的令牌认证互相独立）
//   GET  {base}/         302 → {base}/admin/

import http from 'node:http'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { validateBind } from './config.js'
import { getDb, backupDb, DB_FILENAME } from './core/db.js'
import { purgeExpired, RECYCLE_RETENTION_DAYS } from './core/vault.js'
import { createAdminHandler } from './admin/handler.js'
import { hasAdminPassword, cleanupSessions } from './admin/auth.js'
import { writeLog } from './core/writelog.js'
import { verifyToken, scopeAllows } from './auth/tokens.js'
import { findTool, toolEnabled } from './tools/registry.js'
import { runIngest, validateIngestBody } from './core/ingest.js'
import { buildMcpServer, llmFromConfig, SERVER_VERSION } from './transport/mcp-server.js'
import { getLogger } from './logger.js'
import fs from 'node:fs'
import path from 'node:path'

/** 请求体上限（capture.text 上限 64K 字符，按 UTF-8 最坏 4 字节 + JSON 开销留余量）。 */
export const MAX_BODY_BYTES = 1024 * 1024
const DRAIN_LIMIT = 16 * 1024 * 1024
/** 认证失败限流：同一来源 60 秒内最多允许这么多次失败，超过返回 429。 */
export const AUTH_FAIL_LIMIT = 10
const AUTH_FAIL_WINDOW_MS = 60_000
const OAUTH_PROBE_RE = /^\/(?:\.well-known\/(?:oauth-|openid-)[\w./-]*|register|authorize|token)$/

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...headers })
  res.end(body)
}

const hostnameOf = (hostHeader) => {
  const h = String(hostHeader || '').toLowerCase()
  if (h.startsWith('[')) { const i = h.indexOf(']'); return i > 0 ? h.slice(0, i + 1) : h }
  return h.split(':')[0]
}

function clientIp(req, config) {
  if (config.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (xff) return xff
  }
  return req.socket.remoteAddress || ''
}

class FailureLimiter {
  constructor() { this.hits = new Map() }
  #prune(ip, now) {
    const arr = (this.hits.get(ip) || []).filter((t) => now - t < AUTH_FAIL_WINDOW_MS)
    if (arr.length) this.hits.set(ip, arr); else this.hits.delete(ip)
    return arr
  }
  blocked(ip) { return this.#prune(ip, Date.now()).length >= AUTH_FAIL_LIMIT }
  fail(ip) {
    const now = Date.now()
    const arr = this.#prune(ip, now)
    arr.push(now)
    this.hits.set(ip, arr)
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value)
  }
}

/** 读取请求体，超过 max 则丢弃剩余内容（有上限地排空，保证客户端能收到 413 而不是连接被重置）。 */
async function readBody(req, max) {
  const chunks = []
  let size = 0
  let total = 0
  let tooLarge = false
  for await (const c of req) {
    total += c.length
    if (total > DRAIN_LIMIT) { req.destroy(); throw Object.assign(new Error('body too large'), { status: 413 }) }
    if (tooLarge) continue
    size += c.length
    if (size > max) { tooLarge = true; chunks.length = 0; continue }
    chunks.push(c)
  }
  if (tooLarge) throw Object.assign(new Error('body too large'), { status: 413 })
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * @param {object} config loadConfig 的结果
 * @param {{logger?: object, scheduler?: boolean}} [opts]
 * @returns {Promise<{port:number, host:string, close: () => Promise<void>, server: http.Server}>}
 */
export async function startServer(config, { logger = getLogger(), scheduler = true } = {}) {
  validateBind(config)
  getDb(config.dbRoot) // 打开并迁移；失败直接抛出，不带病启动
  const log = logger
  const llm = llmFromConfig(config)
  const limiter = new FailureLimiter()
  const base = config.basePath
  const admin = createAdminHandler({ config, log, llm })

  const factory = (ctx) => {
    const a = ctx.authInfo
    if (!a) throw new Error('missing authInfo') // 不可能：鉴权在 handler 之前
    return buildMcpServer({
      identity: { type: 'agent', id: String(a.extra?.tokenId || ''), name: a.clientId, ip: String(a.extra?.ip || '') },
      scopes: a.scopes, config, log, llm, transport: 'http',
    })
  }
  const nodeHandler = toNodeHandler(createMcpHandler(factory), { onerror: (e) => log.error('MCP 适配层错误', { error: String(e?.message || e) }) })

  const originAllowed = (origin) => {
    let u
    try { u = new URL(origin) } catch { return false }
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname.toLowerCase())) return true
    return config.allowedOrigins.includes(u.origin.toLowerCase())
  }

  // 没带凭据 = 标准的 Bearer 质询（RFC 6750 §3.1），不是猜测行为：回 401 + WWW-Authenticate 说明如何认证，不计入失败限流。
  // （实测 Claude Code 对同一次连接会连发多个无令牌请求；如果每个都计失败，一次连接就会被误算成多次攻击，还会连累同机其它客户端。）
  const challenge = (res, ip, method) => {
    log.info('请求未带令牌，已质询', { ip, method })
    sendJson(res, 401, { error: 'unauthorized', message: '需要 Bearer 令牌：请在请求头加 Authorization: Bearer <令牌>（令牌由管理员在管理界面或 memory-hub token create 创建）' }, { 'www-authenticate': 'Bearer realm="memory-hub"' })
  }
  // 带了凭据但无效（格式错 / 不存在 / 不匹配 / 过期 / 撤销）：每个请求恰好计一次失败；响应不区分具体原因，避免枚举。
  const denyAuth = (res, ip, reason) => {
    limiter.fail(ip)
    log.warn('鉴权失败', { ip, reason })
    sendJson(res, 401, { error: 'unauthorized', message: '令牌无效（不存在、已过期或已被撤销）' }, { 'www-authenticate': 'Bearer realm="memory-hub", error="invalid_token"' })
  }

  /** 公共鉴权（/mcp 与 /api/ingest 共用）：Origin → 失败限流 → Bearer 令牌。已写好响应时返回 null，否则 {tok, ip}。 */
  const authenticate = (req, res) => {
    const origin = req.headers.origin
    if (origin !== undefined && !originAllowed(String(origin))) {
      log.warn('Origin 校验失败', { origin: String(origin).slice(0, 200) })
      sendJson(res, 403, { error: 'forbidden origin' })
      return null
    }

    const ip = clientIp(req, config)
    if (limiter.blocked(ip)) {
      log.warn('鉴权失败过多，已限流', { ip })
      sendJson(res, 429, { error: 'too many failed attempts' }, { 'retry-after': '60' })
      return null
    }
    const authHeader = String(req.headers.authorization || '').trim()
    if (!authHeader || /^Bearer$/i.test(authHeader)) { challenge(res, ip, req.method); return null }
    const m = /^Bearer\s+(\S+)$/i.exec(authHeader)
    if (!m) { denyAuth(res, ip, 'malformed-header'); return null }
    const v = verifyToken(config.dbRoot, m[1])
    if (!v.ok) { denyAuth(res, ip, v.reason); return null }
    return { tok: v.token, ip }
  }

  /** POST {base}/api/ingest：会话文本摄入。鉴权 → write scope → 读 body（413）→ 校验（400）→ runIngest。 */
  const handleIngest = async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    const authed = authenticate(req, res)
    if (!authed) return
    const { tok, ip } = authed
    if (!scopeAllows(tok.scopes, 'write')) {
      log.warn('scope 不足，已拒绝', { actor: tok.name, tool: 'ingest', required: 'write' })
      try { writeLog(config.dbRoot, { actorType: 'agent', actorId: tok.tokenId, actorName: tok.name, tool: 'ingest', action: 'deny', outcome: 'denied', ip }) } catch (e) { log.error('write_log 写入失败', { error: String(e?.message || e) }) }
      return sendJson(res, 403, { status: 'forbidden', reason: 'insufficient scope: write required' }, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="write"' })
    }
    let raw
    try { raw = await readBody(req, config.ingest.maxBodyBytes) } catch (e) {
      if (e.status === 413) return sendJson(res, 413, { status: 'invalid', reason: 'payload too large' }, { connection: 'close' })
      throw e
    }
    let parsed
    try { parsed = JSON.parse(raw) } catch { return sendJson(res, 400, { status: 'invalid', reason: 'body 不是合法 JSON' }) }
    const v = validateIngestBody(parsed)
    if (!v.ok) {
      log.warn('ingest 请求校验失败', { actor: tok.name, reason: v.reason })
      return sendJson(res, 400, { status: 'invalid', reason: v.reason })
    }
    const out = await runIngest({ config, identity: { tokenId: tok.tokenId, name: tok.name, ip }, llm, log, input: v.value })
    return sendJson(res, out.http, out.body)
  }

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://placeholder')
    const pathname = url.pathname
    if (!config.allowedHosts.includes(hostnameOf(req.headers.host))) {
      log.warn('Host 校验失败', { host: String(req.headers.host || '').slice(0, 100) })
      return sendJson(res, 403, { error: 'forbidden host' })
    }
    if (pathname === `${base}/healthz`) {
      return sendJson(res, 200, { ok: true, version: SERVER_VERSION, bind: req.socket.localAddress })
    }
    if (admin.owns(pathname)) return admin.handle(req, res, url)
    if (pathname === `${base}/api/ingest`) return handleIngest(req, res)
    if (pathname !== `${base}/mcp`) {
      // OAuth 发现/动态注册探测：客户端收到 401 后会去试这些路径，最后报"Dynamic Client Registration rejected (HTTP 404)"。
      // 本服务不做 OAuth（只认静态 Bearer 令牌），所以仍是 404，但把原因写进响应体——客户端会把响应体原样带进它的报错。
      if (OAUTH_PROBE_RE.test(pathname) || (base && OAUTH_PROBE_RE.test(pathname.slice(base.length)))) {
        return sendJson(res, 404, { error: 'not found', message: '本服务不支持 OAuth / 动态客户端注册，只认静态 Bearer 令牌：请在 MCP 客户端配置里加请求头 Authorization: Bearer <令牌>（令牌由管理员创建，见管理界面“令牌”页）' })
      }
      return sendJson(res, 404, { error: 'not found' })
    }

    const authed = authenticate(req, res)
    if (!authed) return
    const { tok, ip } = authed

    let parsed
    if (req.method === 'POST') {
      let raw
      try { raw = await readBody(req, MAX_BODY_BYTES) } catch (e) {
        if (e.status === 413) return sendJson(res, 413, { error: 'payload too large' }, { connection: 'close' })
        throw e
      }
      try { parsed = JSON.parse(raw) } catch {
        return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
      // scope 预检：调用了对该令牌可见性已启用、但 scope 不足的工具 → 403（规范要求的状态码）
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
        if (msg?.method !== 'tools/call') continue
        const def = findTool(msg.params?.name)
        if (def && toolEnabled(def, config) && !scopeAllows(tok.scopes, def.scope)) {
          log.warn('scope 不足，已拒绝', { actor: tok.name, tool: def.name, required: def.scope })
          try { writeLog(config.dbRoot, { actorType: 'agent', actorId: tok.tokenId, actorName: tok.name, tool: def.name, action: 'deny', outcome: 'denied', ip, args: msg.params?.arguments }) } catch (e) { log.error('write_log 写入失败', { error: String(e?.message || e) }) }
          return sendJson(res, 403, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: `insufficient scope: ${def.scope} required` } }, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${def.scope}"` })
        }
      }
    }

    req.auth = { token: '', clientId: tok.name, scopes: tok.scopes, extra: { tokenId: tok.tokenId, ip } }
    res.setHeader('x-accel-buffering', 'no') // 反代（nginx）不要缓冲流式响应
    await nodeHandler(req, res, parsed)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error('请求处理异常', { error: String(e?.message || e).slice(0, 300) })
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); else res.end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve() })
  })
  const addr = server.address()
  if (!hasAdminPassword(config.dbRoot)) log.warn('管理员口令未设置：管理界面无法登录。请运行 `memory-hub admin set-password` 设置（口令从 stdin 读取，不经命令行参数）')
  let stopScheduler = () => {}
  if (scheduler) stopScheduler = startScheduler(config, log)
  log.info('memory-hub listening', {
    host: addr.address, port: addr.port, basePath: base || '/', db: path.join(config.dbRoot, DB_FILENAME),
    exposeTidyApply: config.exposeTidyApply, remote: config.allowRemote, adminUi: `${base}/admin/`, adminLoginReady: hasAdminPassword(config.dbRoot),
    llm: config.llm ? { configured: true, model: config.llm.model, keySet: !!config.llm.apiKey } : { configured: false, note: '蒸馏未配置：memory_capture 将降级为原文卡' },
  })
  return {
    server, port: addr.port, host: addr.address,
    close: async () => {
      stopScheduler()
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.() })
    },
  }
}

/** 定时任务：每小时检查一次——距上次备份超过 24 小时则备份；顺带清理过期回收站。首次检查在启动 30 秒后。 */
export function startScheduler(config, log) {
  const tick = async () => {
    try {
      const dir = path.join(config.dbRoot, 'backups')
      let latest = 0
      try {
        for (const f of fs.readdirSync(dir)) if (/^memory-eternal-.*\.db$/.test(f)) latest = Math.max(latest, fs.statSync(path.join(dir, f)).mtimeMs)
      } catch { /* 目录尚不存在 */ }
      if (Date.now() - latest > 24 * 3600e3) {
        const r = await backupDb(config.dbRoot)
        if (r.ok) log.info('每日备份完成', { file: path.basename(r.path), bytes: r.bytes })
        else log.error('每日备份失败', { error: r.error })
      }
      const p = await purgeExpired(config.dbRoot, RECYCLE_RETENTION_DAYS)
      if (p.purged) log.info('回收站清理', { purged: p.purged })
      const s = cleanupSessions(config.dbRoot)
      if (s) log.info('清理过期管理会话', { removed: s })
    } catch (e) { log.error('定时任务异常', { error: String(e?.message || e) }) }
  }
  const first = setTimeout(tick, 30_000)
  const timer = setInterval(tick, 3600e3)
  first.unref(); timer.unref()
  return () => { clearTimeout(first); clearInterval(timer) }
}
