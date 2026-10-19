// memory-hub · 管理界面认证：应急管理员口令（scrypt 哈希存 config 表）+ 服务端会话（admin_sessions，只存会话 id 的 sha256）。
//
// 口令从不以明文落库/落日志；会话 id 是 256 位随机数，库里只存其 sha256；
// CSRF token = HMAC(会话哈希, 固定标签)，与会话绑定，会话销毁即失效。
//
// 多用户（schema v4）：会话的 user_id 指向 admin_users；NULL = 应急入口（身份为 rbac.BREAK_GLASS）。
// 会话每次都回表取用户：停用 / 删除即时失效，改角色 / 团队下一次请求即生效。

import crypto from 'node:crypto'
import { getDb } from '../core/db.js'
import { BREAK_GLASS, principalOf } from './rbac.js'

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 1024
/** 生产强度：N=2^16, r=8, p=1（约 64MB 内存、~150ms）。参数写进哈希本身，日后调高不影响旧哈希校验。 */
export const DEFAULT_COST = Object.freeze({ N: 65536, r: 8, p: 1 })
const KEYLEN = 64
const PW_KEY = 'adminPasswordHash'

export const SESSION_COOKIE = 'mh_sid'
/** 空闲 8 小时过期；无论是否活跃，绝对 7 天过期（PLAN 3.3）。 */
export const SESSION_IDLE_MS = 8 * 3600e3
export const SESSION_ABSOLUTE_MS = 7 * 86400e3
/** last_seen 续期节流：距上次记录不到这么久不再写库。 */
const TOUCH_THROTTLE_MS = 30_000

/** 登录失败限流：同一来源在窗口内最多允许这么多次失败。 */
export const LOGIN_FAIL_LIMIT = 5
export const LOGIN_FAIL_WINDOW_MS = 15 * 60e3
/** 全局（不分来源）失败上限，防分布式撞库。 */
export const LOGIN_GLOBAL_FAIL_LIMIT = 40

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex')
const maxmemFor = ({ N, r }) => 256 * N * r + (1 << 20)

export class AdminAuthError extends Error {
  constructor(message) { super(message); this.name = 'AdminAuthError' }
}

export function validatePassword(pw) {
  if (typeof pw !== 'string') throw new AdminAuthError('口令必须是字符串')
  const len = [...pw].length
  if (len < MIN_PASSWORD_LENGTH) throw new AdminAuthError(`口令至少 ${MIN_PASSWORD_LENGTH} 个字符`)
  if (len > MAX_PASSWORD_LENGTH) throw new AdminAuthError(`口令最多 ${MAX_PASSWORD_LENGTH} 个字符`)
}

/** @returns {string} scrypt$N$r$p$salt(b64)$hash(b64) */
export function hashPassword(password, cost = DEFAULT_COST) {
  const { N, r, p } = { ...DEFAULT_COST, ...cost }
  const salt = crypto.randomBytes(16)
  const dk = crypto.scryptSync(String(password).normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: maxmemFor({ N, r }) })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${dk.toString('base64')}`
}

function parseStored(stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ''))
  if (!m) return null
  const N = Number(m[1]), r = Number(m[2]), p = Number(m[3])
  const isPow2 = N >= 2 && (N & (N - 1)) === 0
  if (!isPow2 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return null
  const salt = Buffer.from(m[4], 'base64'), hash = Buffer.from(m[5], 'base64')
  if (salt.length < 8 || hash.length !== KEYLEN) return null
  return { N, r, p, salt, hash }
}

const check = (password, parsed, dk) => crypto.timingSafeEqual(dk, parsed.hash)

export function verifyPassword(password, stored) {
  const parsed = parseStored(stored)
  if (!parsed || typeof password !== 'string') return false
  try {
    const dk = crypto.scryptSync(password.normalize('NFKC'), parsed.salt, KEYLEN, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: maxmemFor(parsed) })
    return check(password, parsed, dk)
  } catch { return false }
}

/** 异步版（登录路径用，不阻塞事件循环里的 MCP 请求）。 */
export function verifyPasswordAsync(password, stored) {
  const parsed = parseStored(stored)
  if (!parsed || typeof password !== 'string') return Promise.resolve(false)
  return new Promise((resolve) => {
    crypto.scrypt(password.normalize('NFKC'), parsed.salt, KEYLEN, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: maxmemFor(parsed) }, (err, dk) => {
      resolve(!err && check(password, parsed, dk))
    })
  })
}

export function getAdminPasswordHash(root) {
  return getDb(root).prepare('SELECT value FROM config WHERE key = ?').get(PW_KEY)?.value || null
}
export const hasAdminPassword = (root) => parseStored(getAdminPasswordHash(root)) !== null

/** 设置（或更换）管理员口令，并让所有既有会话失效。口令只在内存里出现，不记录。 */
export function setAdminPassword(root, password, { cost } = {}) {
  validatePassword(password)
  const hash = hashPassword(password, cost)
  const db = getDb(root)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare("INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(PW_KEY, hash)
    db.exec('DELETE FROM admin_sessions')
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

const SID_RE = /^[A-Za-z0-9_-]{43}$/

/** @param {number|null} [userId] admin_users.id；省略 / null = 应急入口会话 */
export function createSession(root, now = Date.now(), userId = null) {
  const sid = crypto.randomBytes(32).toString('base64url')
  const sidHash = sha256hex(sid)
  const iso = new Date(now).toISOString()
  const expiresAt = new Date(now + SESSION_ABSOLUTE_MS).toISOString()
  getDb(root).prepare('INSERT INTO admin_sessions (sid_hash, created_at, expires_at, last_seen, user_id) VALUES (?, ?, ?, ?, ?)').run(sidHash, iso, expiresAt, iso, userId ?? null)
  return { sid, sidHash, expiresAt, csrfToken: csrfFor(sidHash) }
}

/** 会话→身份：user_id 为空是应急入口；用户已删 / 已停用 → null（调用方视为会话失效）。 */
function principalForSession(db, userId) {
  if (userId === null || userId === undefined) return { ...BREAK_GLASS }
  const row = db.prepare('SELECT id, username, team, role, disabled_at FROM admin_users WHERE id = ?').get(userId)
  if (!row || row.disabled_at) return null
  return principalOf(row)
}

export function csrfFor(sidHash) {
  return crypto.createHmac('sha256', sidHash).update('memory-hub-csrf-v1').digest('base64url')
}

export function csrfValid(session, token) {
  if (typeof token !== 'string' || !token) return false
  const a = Buffer.from(csrfFor(session.sidHash)), b = Buffer.from(token)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** @returns {{sidHash:string, csrfToken:string, expiresAt:string, user:object}|null} 过期（空闲或绝对）或用户已停用的会话会被顺手删除。 */
export function lookupSession(root, sid, now = Date.now()) {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return null
  const db = getDb(root)
  const sidHash = sha256hex(sid)
  const row = db.prepare('SELECT * FROM admin_sessions WHERE sid_hash = ?').get(sidHash)
  if (!row) return null
  const expires = Date.parse(row.expires_at)
  const seen = Date.parse(row.last_seen)
  if (!(expires > now) || !(seen + SESSION_IDLE_MS > now)) {
    db.prepare('DELETE FROM admin_sessions WHERE sid_hash = ?').run(sidHash)
    return null
  }
  const user = principalForSession(db, row.user_id)
  if (!user) {
    db.prepare('DELETE FROM admin_sessions WHERE sid_hash = ?').run(sidHash)
    return null
  }
  if (now - seen >= TOUCH_THROTTLE_MS) db.prepare('UPDATE admin_sessions SET last_seen = ? WHERE sid_hash = ?').run(new Date(now).toISOString(), sidHash)
  return { sidHash, csrfToken: csrfFor(sidHash), expiresAt: row.expires_at, user }
}

export function destroySession(root, sid) {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return
  getDb(root).prepare('DELETE FROM admin_sessions WHERE sid_hash = ?').run(sha256hex(sid))
}

/** 删除全部已过期（空闲或绝对）的会话行，返回删除条数。 */
export function cleanupSessions(root, now = Date.now()) {
  const r = getDb(root).prepare('DELETE FROM admin_sessions WHERE expires_at <= ? OR last_seen <= ?').run(new Date(now).toISOString(), new Date(now - SESSION_IDLE_MS).toISOString())
  return Number(r.changes || 0)
}

export function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim()
  }
  return out
}

// ---------------------------------------------------------------------------
// 登录失败限流
// ---------------------------------------------------------------------------

export class LoginLimiter {
  constructor({ limit = LOGIN_FAIL_LIMIT, windowMs = LOGIN_FAIL_WINDOW_MS, globalLimit = LOGIN_GLOBAL_FAIL_LIMIT } = {}) {
    this.limit = limit; this.windowMs = windowMs; this.globalLimit = globalLimit
    this.hits = new Map()
    this.all = []
  }
  #prune(ip, now) {
    const arr = (this.hits.get(ip) || []).filter((t) => now - t < this.windowMs)
    if (arr.length) this.hits.set(ip, arr); else this.hits.delete(ip)
    this.all = this.all.filter((t) => now - t < this.windowMs)
    return arr
  }
  /** @returns {number} 0 = 放行；>0 = 需等待的秒数 */
  retryAfter(ip, now = Date.now()) {
    const arr = this.#prune(ip, now)
    const waits = []
    if (arr.length >= this.limit) waits.push(arr[0] + this.windowMs - now)
    if (this.all.length >= this.globalLimit) waits.push(this.all[0] + this.windowMs - now)
    return waits.length ? Math.max(1, Math.ceil(Math.max(...waits) / 1000)) : 0
  }
  fail(ip, now = Date.now()) {
    const arr = this.#prune(ip, now)
    arr.push(now)
    this.hits.set(ip, arr)
    this.all.push(now)
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value)
  }
  reset(ip) { this.hits.delete(ip) }
}
