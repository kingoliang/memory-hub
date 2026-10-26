// memory-hub · 管理界面 HTTP 处理：静态文件 + /admin/api/*（M2 只读 + M3 写接口 + 登录/登出）。
//
// 与 /mcp 完全独立的认证：管理 API 只认会话 cookie（mh_sid），Agent 令牌在这里一律 401；
// 非 GET 请求（logout 与全部 M3 写接口）必须通过 Origin 校验 + CSRF token；写接口只收 application/json。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SESSION_COOKIE, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, LoginLimiter,
  hasAdminPassword, getAdminPasswordHash, verifyPasswordAsync, createSession, lookupSession, destroySession,
  cleanupSessions, csrfValid, parseCookies,
} from './auth.js'
import * as Q from './queries.js'
import * as G from './graph.js'
import { writeLog } from '../core/writelog.js'
import { HttpError } from './errors.js'
import * as Ops from './ops.js'
import * as Settings from './settings.js'
import { createGraphSearch } from './graph-search.js'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web')
/** 虽是 POST 但不修改库的接口：只读模式下放行。 */
const READONLY_OK = new Set(['/graph/search', '/graph/summarize'])
const MAX_LOGIN_BODY = 8 * 1024
/** 写接口请求体上限（编辑正文最多 20 万字符，按 UTF-8 最坏 3 字节 + JSON 开销留余量）。 */
export const MAX_WRITE_BODY = 2 * 1024 * 1024
const DRAIN_LIMIT = 16 * 1024 * 1024
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
}

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
].join('; ')

export function createAdminHandler({ config, log, llm = null }) {
  const base = config.basePath
  const root = config.dbRoot
  const adminBase = `${base}/admin`
  const limiter = new LoginLimiter()

  const clientIp = (req) => {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      if (xff) return xff
    }
    return req.socket.remoteAddress || ''
  }
  const isSecure = (req) => !!req.socket.encrypted || (config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https')

  const securityHeaders = (req) => ({
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...(isSecure(req) ? { 'strict-transport-security': 'max-age=15552000' } : {}),
  })

  const send = (req, res, status, body, headers = {}) => {
    res.writeHead(status, { ...securityHeaders(req), ...headers })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
  const sendJson = (req, res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj)
    send(req, res, status, body, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...headers })
  }

  const originOk = (req) => {
    const origin = req.headers.origin
    if (origin === undefined) {
      const sfs = String(req.headers['sec-fetch-site'] || '')
      return !(sfs === 'cross-site')
    }
    let u
    try { u = new URL(String(origin)) } catch { return false }
    if (u.host.toLowerCase() === String(req.headers.host || '').toLowerCase()) return true
    return config.allowedOrigins.includes(u.origin.toLowerCase())
  }

  const cookieAttrs = (req, maxAge) => `Path=${adminBase}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`

  async function readJson(req, max) {
    const chunks = []
    let size = 0
    let tooLarge = false
    for await (const c of req) {
      size += c.length
      if (size > DRAIN_LIMIT) { req.destroy(); throw new HttpError(413, 'payload_too_large', '请求体过大') }
      if (tooLarge) continue
      if (size > max) { tooLarge = true; chunks.length = 0; continue } // 有上限地排空，保证客户端收到 413 而不是连接被重置
      chunks.push(c)
    }
    if (tooLarge) throw new HttpError(413, 'payload_too_large', '请求体过大')
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'bad_request', '请求体不是合法 JSON') }
  }

  // ---- 参数解析 ----
  const P = (url) => url.searchParams
  const intParam = (url, name, { def, min, max, clamp = false }) => {
    const raw = P(url).get(name)
    if (raw === null || raw === '') return def
    if (!/^-?\d+$/.test(raw)) throw new HttpError(400, 'bad_request', `${name} 必须是整数`)
    const n = Number(raw)
    if (n < min) throw new HttpError(400, 'bad_request', `${name} 不能小于 ${min}`)
    if (n > max) { if (clamp) return max; throw new HttpError(400, 'bad_request', `${name} 不能大于 ${max}`) }
    return n
  }
  const enumParam = (url, name, allowed, def) => {
    const raw = P(url).get(name)
    if (raw === null || raw === '') return def
    if (!allowed.includes(raw)) throw new HttpError(400, 'bad_request', `${name} 只能是：${allowed.join(' / ')}`)
    return raw
  }
  const dateParam = (url, name, endOfDay) => {
    const raw = P(url).get(name)
    if (raw === null || raw === '') return null
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ].+)?$/.test(raw)) throw new HttpError(400, 'bad_request', `${name} 必须是 YYYY-MM-DD 或 ISO 时间`)
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    const t = Date.parse(dateOnly ? raw + 'T00:00:00Z' : raw)
    if (Number.isNaN(t)) throw new HttpError(400, 'bad_request', `${name} 不是合法时间`)
    return dateOnly && endOfDay ? t + 86400e3 - 1 : t
  }
  const strParam = (url, name, max = 200) => {
    const v = P(url).get(name)
    if (v === null) return ''
    if (v.length > max) throw new HttpError(400, 'bad_request', `${name} 过长`)
    return v
  }
  const paging = (url, defLimit = 20) => ({ limit: intParam(url, 'limit', { def: defLimit, min: 1, max: 200, clamp: true }), offset: intParam(url, 'offset', { def: 0, min: 0, max: 10_000_000 }) })

  // ---- 路由表 ----
  const deps = { config, log }
  const spider = createGraphSearch({ config, log, llm })
  const routes = {
    'GET /session': (ctx) => ({ authenticated: true, passwordSet: true, readOnly: !!config.adminReadOnly, csrfToken: ctx.session.csrfToken, expiresAt: ctx.session.expiresAt, idleTimeoutMs: SESSION_IDLE_MS }),
    'GET /overview': async () => {
      const act = Q.activity(root, { days: 30, silentDays: 7 })
      return Q.overview(root, { config, alerts: act.alerts.filter((a) => a.type === 'read-only' || (a.type === 'idle-token' && !a.neverUsed)) })
    },
    'GET /facets': () => Q.facets(root),
    'GET /cards': (ctx) => {
      const u = ctx.url
      const f = {
        ...paging(u),
        status: enumParam(u, 'status', [...Q.LIST_STATUSES, 'all'], 'approved'),
        kind: strParam(u, 'kind', 50),
        tags: strParam(u, 'tag', 500).split(',').map((t) => t.trim()).filter(Boolean),
        agent: strParam(u, 'agent', 100),
        source: strParam(u, 'source', 100),
        q: strParam(u, 'q', 500),
        createdFrom: dateParam(u, 'createdFrom', false), createdTo: dateParam(u, 'createdTo', true),
        updatedFrom: dateParam(u, 'updatedFrom', false), updatedTo: dateParam(u, 'updatedTo', true),
        sort: enumParam(u, 'sort', Q.SORTS, 'updated'),
        order: enumParam(u, 'order', ['asc', 'desc'], 'desc'),
      }
      if (f.q && !P(u).get('sort')) f.sort = 'score'
      return Q.cardsPage(root, f)
    },
    'GET /card': (ctx) => {
      const p = strParam(ctx.url, 'path', 500)
      if (!p) throw new HttpError(400, 'bad_request', '缺少 path 参数')
      const d = Q.cardDetail(root, p)
      if (!d) throw new HttpError(404, 'not_found', '卡片不存在')
      return d
    },
    'GET /graph': async (ctx) => {
      // 只读（GET）：即使 MEMORY_HUB_ADMIN_READONLY=1 也可访问；节点不含正文/摘要，详情走 GET /card
      const u = ctx.url
      enumParam(u, 'status', ['approved'], 'approved') // 图只含主库（approved）卡；隔离区/回收站不入图
      const types = strParam(u, 'types', 100).split(',').map((t) => t.trim()).filter(Boolean)
      for (const t of types) if (!G.EDGE_TYPES.includes(t)) throw new HttpError(400, 'bad_request', `types 只能是：${G.EDGE_TYPES.join(' / ')}`)
      // kinds：逗号分隔，最多 7 个（= 全部 kind）；与 kind 同时存在时取并集
      const kinds = [...new Set(strParam(u, 'kinds', 500).split(',').map((t) => t.trim()).filter(Boolean))]
      if (kinds.length > 7) throw new HttpError(400, 'bad_request', 'kinds 最多 7 个')
      const hi = P(u).get('hide_isolated')
      if (hi !== null && !['', '0', '1'].includes(hi)) throw new HttpError(400, 'bad_request', 'hide_isolated 只能是 0 或 1')
      // mode / cluster_by：只接受枚举值；mode=clusters 为聚合视图（忽略 limit、不截断）
      const mode = enumParam(u, 'mode', G.GRAPH_MODES, 'cards')
      const clusterBy = enumParam(u, 'cluster_by', G.CLUSTER_BYS, 'kind')
      try {
        return await G.graphQuery(root, {
          mode,
          clusterBy,
          kind: strParam(u, 'kind', 50),
          kinds,
          tags: strParam(u, 'tag', 500).split(',').map((t) => t.trim()).filter(Boolean),
          types,
          minWeight: intParam(u, 'min_weight', { def: 1, min: 1, max: 20 }),
          focus: strParam(u, 'focus', 500),
          depth: intParam(u, 'depth', { def: 1, min: 1, max: 3 }),
          hideIsolated: hi === '1',
          // 不带 limit = 自动上限（全部节点，除非超过 GRAPH_AUTO_LIMIT）；显式 limit 1~GRAPH_MAX_LIMIT，超出钳到上限
          limit: intParam(u, 'limit', { min: 1, max: G.GRAPH_MAX_LIMIT, clamp: true }),
        })
      } catch (e) {
        if (e instanceof G.GraphNotFound) throw new HttpError(404, 'not_found', e.message)
        throw e
      }
    },
    // 蜘蛛搜索（POST 但不改库）：会话 + Origin + CSRF 照常校验；只读模式下仍可用（见 READONLY_OK）
    'POST /graph/search': async (ctx) => spider.search(root, await ctx.json(), Ops.actorOf(ctx.session, ctx.ip), ctx.session),
    'POST /graph/summarize': async (ctx) => spider.summarize(root, await ctx.json(), Ops.actorOf(ctx.session, ctx.ip), ctx.session),
    'GET /queue': (ctx) => Q.queuePage(root, { ...paging(ctx.url, 50), status: enumParam(ctx.url, 'status', ['pending', 'rejected', 'all'], 'all') }),
    'GET /recycle': (ctx) => Q.recyclePage(root, paging(ctx.url, 50)),
    'GET /tags': (ctx) => Q.tagStats(root, { q: strParam(ctx.url, 'q', 100), limit: intParam(ctx.url, 'limit', { def: 500, min: 1, max: 5000, clamp: true }) }),
    'GET /tidy/preview': async (ctx) => {
      const raw = P(ctx.url).get('threshold')
      let threshold
      if (raw !== null && raw !== '') {
        threshold = Number(raw)
        if (!Number.isFinite(threshold) || threshold < 0.05 || threshold > 1) throw new HttpError(400, 'bad_request', 'threshold 必须在 0.05 ~ 1 之间')
      }
      return Q.tidyPreview(root, { threshold, limit: intParam(ctx.url, 'limit', { def: 30, min: 1, max: 200 }) })
    },
    'GET /lint': () => Q.lintReport(root),
    'GET /activity': (ctx) => Q.activity(root, { days: intParam(ctx.url, 'days', { def: 30, min: 1, max: 365 }), silentDays: intParam(ctx.url, 'silentDays', { def: 7, min: 1, max: 365 }) }),
    'GET /tokens': () => Q.tokenList(root),
    'GET /settings': () => Settings.getSettings(root, { config }),
    'GET /write-log': (ctx) => {
      const u = ctx.url
      return Q.writeLogPage(root, {
        ...paging(u, 50),
        actor: strParam(u, 'actor', 100), tool: strParam(u, 'tool', 100), action: strParam(u, 'action', 50),
        actorType: enumParam(u, 'actorType', Q.WRITE_LOG_ACTOR_TYPES, ''),
        outcome: enumParam(u, 'outcome', Q.WRITE_LOG_OUTCOMES, ''),
        from: dateParam(u, 'from', false), to: dateParam(u, 'to', true),
      })
    },
    // ---- M3 写接口（会话 + Origin + CSRF 已在 api() 里统一校验）----
    'PATCH /card': async (ctx) => Ops.editCard(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'DELETE /card': (ctx) => Ops.softDelete(root, Ops.actorOf(ctx.session, ctx.ip), strParam(ctx.url, 'path', 500), deps),
    'POST /card/restore': async (ctx) => Ops.restore(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'POST /card/purge': async (ctx) => Ops.purge(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'POST /card/rollback': async (ctx) => Ops.rollbackCard(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'POST /cards/batch': async (ctx) => Ops.batchCards(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'POST /cards/purge': async (ctx) => Ops.purgeCards(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'POST /queue/approve': async (ctx) => Ops.moderate(root, Ops.actorOf(ctx.session, ctx.ip), 'approve', await ctx.json(), deps),
    'POST /queue/reject': async (ctx) => Ops.moderate(root, Ops.actorOf(ctx.session, ctx.ip), 'reject', await ctx.json(), deps),
    'GET /tags/preview': (ctx) => Ops.previewTagOp(root, { op: strParam(ctx.url, 'op', 20), from: strParam(ctx.url, 'from', 2000), to: strParam(ctx.url, 'to', 200) }),
    'POST /tags/rename': async (ctx) => Ops.applyTagOp(root, Ops.actorOf(ctx.session, ctx.ip), 'rename', await ctx.json(), deps),
    'POST /tags/merge': async (ctx) => Ops.applyTagOp(root, Ops.actorOf(ctx.session, ctx.ip), 'merge', await ctx.json(), deps),
    'POST /tags/delete': async (ctx) => Ops.applyTagOp(root, Ops.actorOf(ctx.session, ctx.ip), 'delete', await ctx.json(), deps),
    'POST /tidy/apply': async (ctx) => Ops.tidyApplyAdmin(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'GET /tidy/rollbacks': () => Ops.listRollbacks(root),
    'POST /tidy/rollback': async (ctx) => Ops.rollbackAdmin(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'POST /tokens': async (ctx) => Ops.createTokenAdmin(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'PATCH /tokens': async (ctx) => Ops.updateTokenAdmin(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'DELETE /tokens': (ctx) => Ops.revokeTokenAdmin(root, Ops.actorOf(ctx.session, ctx.ip), strParam(ctx.url, 'tokenId', 100), deps),
    'PATCH /settings': async (ctx) => Settings.updateSettings(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), deps),
    'POST /password': async (ctx) => {
      const out = await Ops.changePassword(root, Ops.actorOf(ctx.session, ctx.ip), await ctx.json(), { ...deps, limiter })
      return { ...out, __headers: { 'set-cookie': `${SESSION_COOKIE}=; ${cookieAttrs(ctx.req, 0)}` } }
    },
    'POST /logout': (ctx) => {
      destroySession(root, ctx.sid)
      try { writeLog(root, { actorType: 'admin', actorName: 'admin', action: 'logout', outcome: 'ok', ip: ctx.ip }) } catch (e) { log.error('write_log 写入失败', { error: String(e?.message || e).slice(0, 200) }) }
      return { ok: true, __headers: { 'set-cookie': `${SESSION_COOKIE}=; ${cookieAttrs(ctx.req, 0)}` } }
    },
  }
  const knownPaths = new Set(Object.keys(routes).map((k) => k.split(' ')[1]).concat('/login'))

  async function login(req, res, ip) {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'unsupported_media_type', '登录请求必须是 application/json')
    if (!originOk(req)) { log.warn('管理员登录：Origin 校验失败', { ip }); throw new HttpError(403, 'forbidden_origin', '来源不被允许') }
    const wait = limiter.retryAfter(ip)
    if (wait > 0) {
      log.warn('管理员登录失败过多，已限流', { ip, retryAfterSec: wait })
      throw new HttpError(429, 'too_many_attempts', `尝试次数过多，请 ${wait} 秒后再试`, { 'retry-after': String(wait) })
    }
    if (!hasAdminPassword(root)) {
      throw new HttpError(503, 'password_not_set', '尚未设置管理员口令：请在服务器上运行 `memory-hub admin set-password` 后再登录')
    }
    const body = await readJson(req, MAX_LOGIN_BODY)
    const pw = body?.password
    if (typeof pw !== 'string' || pw.length < 1 || pw.length > 1024) throw new HttpError(400, 'bad_request', '需要 password 字段（字符串）')
    const ok = await verifyPasswordAsync(pw, getAdminPasswordHash(root))
    if (!ok) {
      limiter.fail(ip)
      log.warn('管理员登录失败', { ip })
      try { writeLog(root, { actorType: 'admin', actorName: 'admin', action: 'login', outcome: 'denied', ip }) } catch (e) { log.error('write_log 写入失败', { error: String(e?.message || e).slice(0, 200) }) }
      throw new HttpError(401, 'invalid_credentials', '口令不正确')
    }
    limiter.reset(ip)
    cleanupSessions(root)
    const s = createSession(root)
    log.info('管理员登录', { ip })
    try { writeLog(root, { actorType: 'admin', actorName: 'admin', action: 'login', outcome: 'ok', ip }) } catch (e) { log.error('write_log 写入失败', { error: String(e?.message || e).slice(0, 200) }) }
    sendJson(req, res, 200, { ok: true, csrfToken: s.csrfToken, expiresAt: s.expiresAt }, {
      'set-cookie': `${SESSION_COOKIE}=${s.sid}; ${cookieAttrs(req, Math.floor(SESSION_ABSOLUTE_MS / 1000))}`,
    })
  }

  async function api(req, res, url, rel) {
    const ip = clientIp(req)
    const method = req.method
    try {
      if (rel === '/login') {
        if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '登录只接受 POST', { allow: 'POST' })
        return await login(req, res, ip)
      }
      const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE]
      const session = lookupSession(root, sid)
      if (!session) {
        throw Object.assign(new HttpError(401, 'unauthorized', '未登录或会话已过期'), { extra: { passwordSet: hasAdminPassword(root) } })
      }
      const safeMethod = method === 'GET' || method === 'HEAD'
      if (!safeMethod) {
        if (!originOk(req)) throw new HttpError(403, 'forbidden_origin', '来源不被允许')
        if (!csrfValid(session, req.headers['x-csrf-token'])) throw new HttpError(403, 'csrf', 'CSRF token 缺失或无效')
        if (config.adminReadOnly && rel !== '/logout' && !READONLY_OK.has(rel)) {
          log.warn('只读模式：已拒绝写请求', { method, path: rel, ip })
          throw new HttpError(403, 'read_only', '管理界面处于只读模式（MEMORY_HUB_ADMIN_READONLY=1），写操作已被禁用')
        }
      }
      const key = `${method === 'HEAD' ? 'GET' : method} ${rel}`
      const fn = routes[key]
      if (!fn) {
        if (knownPaths.has(rel)) throw new HttpError(405, 'method_not_allowed', '该接口不支持此方法')
        throw new HttpError(404, 'not_found', '接口不存在')
      }
      const json = async () => {
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'unsupported_media_type', '写请求必须是 application/json')
        return readJson(req, MAX_WRITE_BODY)
      }
      const out = await fn({ req, url, session, sid, ip, json })
      const { __headers, ...payload } = out && typeof out === 'object' ? out : { value: out }
      return sendJson(req, res, 200, payload, __headers || {})
    } catch (e) {
      if (e instanceof HttpError) {
        return sendJson(req, res, e.status, { error: e.code, message: e.message, ...(e.extra || {}) }, e.headers || {})
      }
      if (e instanceof Q.BadRequest) return sendJson(req, res, 400, { error: 'bad_request', message: e.message })
      log.error('管理 API 异常', { path: rel, error: String(e?.message || e).slice(0, 300) })
      return sendJson(req, res, 500, { error: 'internal', message: '服务器内部错误' })
    }
  }

  function serveStatic(req, res, rel) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method Not Allowed', { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
    let name = rel === '/' ? 'index.html' : rel.slice(1)
    let decoded
    try { decoded = decodeURIComponent(name) } catch { return send(req, res, 400, 'Bad Request', { 'content-type': 'text/plain; charset=utf-8' }) }
    if (/[\0\\]/.test(decoded) || decoded.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.'))) {
      return send(req, res, 404, 'Not Found', { 'content-type': 'text/plain; charset=utf-8' })
    }
    const ext = path.extname(decoded).toLowerCase()
    const abs = path.resolve(WEB_DIR, decoded)
    if (!MIME[ext] || !abs.startsWith(WEB_DIR + path.sep)) return send(req, res, 404, 'Not Found', { 'content-type': 'text/plain; charset=utf-8' })
    let st
    try { st = fs.statSync(abs) } catch { return send(req, res, 404, 'Not Found', { 'content-type': 'text/plain; charset=utf-8' }) }
    if (!st.isFile()) return send(req, res, 404, 'Not Found', { 'content-type': 'text/plain; charset=utf-8' })
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
    if (req.headers['if-none-match'] === etag) return send(req, res, 304, undefined, { etag })
    const data = fs.readFileSync(abs)
    send(req, res, 200, data, { 'content-type': MIME[ext], 'content-length': data.length, 'cache-control': 'no-cache', etag })
  }

  /** 该路径是否归管理界面处理（含根路径重定向）。 */
  const owns = (pathname) => pathname === adminBase || pathname.startsWith(adminBase + '/') || pathname === `${base}/` || (base !== '' && pathname === base)

  async function handle(req, res, url) {
    const pathname = url.pathname
    if (pathname === `${base}/` || (base !== '' && pathname === base) || pathname === adminBase) {
      return send(req, res, 302, undefined, { location: `${adminBase}/`, 'cache-control': 'no-store' })
    }
    const rel = pathname.slice(adminBase.length) // 以 / 开头
    if (rel === '/api' || rel.startsWith('/api/')) return api(req, res, url, rel.slice('/api'.length) || '/')
    return serveStatic(req, res, rel)
  }

  return { owns, handle, cleanup: () => cleanupSessions(root) }
}
