// memory-hub · Agent 令牌：创建 / 校验 / 撤销 / 范围。
//
// 格式 mh_<tokenId>_<secret>；库里只存 sha256(secret) 与 tokenId，明文只在创建时返回一次。
// 高熵随机令牌用 sha256 足够（无需口令式 KDF）；比较用 timingSafeEqual。

import crypto from 'node:crypto'
import { getDb } from '../core/db.js'

export const SCOPES = ['read', 'write', 'tidy:apply']
const TOKEN_RE = /^mh_([A-Za-z0-9]{1,32})_([A-Za-z0-9_-]{20,128})$/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/
/** last_used_at 节流：同一令牌两次落盘至少间隔这么久，避免每次读请求都变成一次写事务。 */
export const LAST_USED_THROTTLE_MS = 60_000

export class TokenError extends Error {
  /** @param {'bad_request'|'conflict'|'not_found'} [kind] 供管理 API 映射 HTTP 状态；CLI 不用 */
  constructor(message, kind = 'bad_request') { super(message); this.name = 'TokenError'; this.kind = kind }
}

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex')
const DUMMY_HASH = Buffer.from(sha256hex('memory-hub-dummy'), 'hex')

/** 'read,write' / ['read','write'] → 去重排序后的合法 scope 数组；非法或为空抛 TokenError。 */
export function parseScopes(input) {
  const arr = (Array.isArray(input) ? input : String(input ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean)
  if (!arr.length) throw new TokenError(`scope 不能为空（可选：${SCOPES.join(', ')}）`)
  const bad = arr.filter((s) => !SCOPES.includes(s))
  if (bad.length) throw new TokenError(`非法 scope：${bad.join(', ')}（可选：${SCOPES.join(', ')}）`)
  return SCOPES.filter((s) => arr.includes(s))
}

/**
 * 权限矩阵（PLAN 第 4 节）：
 *   需要 read       → 持有 read / write / tidy:apply 任一即可
 *   需要 write      → write 或 tidy:apply
 *   需要 tidy:apply → 仅 tidy:apply
 */
export function scopeAllows(granted, required) {
  const g = new Set(granted)
  if (required === 'read') return g.has('read') || g.has('write') || g.has('tidy:apply')
  if (required === 'write') return g.has('write') || g.has('tidy:apply')
  if (required === 'tidy:apply') return g.has('tidy:apply')
  return false
}

export function validateName(name) {
  const n = String(name ?? '').trim()
  if (!NAME_RE.test(n)) throw new TokenError('令牌名（name）只能含字母数字与 . _ : @ -，以字母或数字开头，最长 64 字符')
  return n
}

/** @returns {{tokenId:string, name:string, scopes:string[], expiresAt:string|null, token:string}} token 为明文，仅此一次 */
export function createToken(root, { name, scopes, expiresAt = null }) {
  const n = validateName(name)
  const sc = parseScopes(scopes)
  let exp = null
  if (expiresAt) {
    const t = Date.parse(expiresAt)
    if (Number.isNaN(t)) throw new TokenError(`expiresAt 不是合法时间：${expiresAt}`)
    exp = new Date(t).toISOString()
  }
  const db = getDb(root)
  const tokenId = crypto.randomBytes(8).toString('hex')
  const secret = crypto.randomBytes(32).toString('base64url')
  try {
    db.prepare('INSERT INTO agent_tokens (token_id, name, secret_hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tokenId, n, sha256hex(secret), JSON.stringify(sc), new Date().toISOString(), exp)
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw new TokenError(`令牌名已存在：${n}（被一枚未撤销的令牌使用；已撤销令牌的名字可以复用）`, 'conflict')
    throw e
  }
  return { tokenId, name: n, scopes: sc, expiresAt: exp, token: `mh_${tokenId}_${secret}` }
}

const toPublic = (r) => ({
  tokenId: r.token_id,
  name: r.name,
  scopes: JSON.parse(r.scopes),
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
})

/** 列表：不含任何密钥材料。 */
export function listTokens(root) {
  return getDb(root).prepare('SELECT token_id, name, scopes, created_at, last_used_at, expires_at, revoked_at FROM agent_tokens ORDER BY created_at, token_id').all().map(toPublic)
}

/** 按名字或 tokenId 撤销（立即生效：校验每次都查库）。 */
export function revokeToken(root, nameOrId) {
  const db = getDb(root)
  const key = String(nameOrId ?? '').trim()
  // 名字可复用（schema v2）：同名时优先命中未撤销的那枚
  const row = db.prepare('SELECT token_id, name, revoked_at FROM agent_tokens WHERE name = ? OR token_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC LIMIT 1').get(key, key)
  if (!row) throw new TokenError(`令牌不存在：${key}`, 'not_found')
  if (row.revoked_at) throw new TokenError(`令牌已撤销：${row.name}`, 'conflict')
  db.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), row.token_id)
  return { tokenId: row.token_id, name: row.name }
}

/** 修改令牌名 / 过期时间（明文与哈希不变）。expiresAt: undefined = 不改，null = 清除过期，字符串 = 设为该时间（须为将来）。已撤销的令牌不可改。 */
export function updateToken(root, tokenId, { name, expiresAt } = {}) {
  const db = getDb(root)
  const row = db.prepare('SELECT token_id, name, revoked_at, expires_at FROM agent_tokens WHERE token_id = ?').get(String(tokenId ?? ''))
  if (!row) throw new TokenError(`令牌不存在：${tokenId}`, 'not_found')
  if (row.revoked_at) throw new TokenError(`令牌已撤销，不能再修改：${row.name}`, 'conflict')
  const sets = []
  const args = []
  const changed = []
  if (name !== undefined) {
    const n = validateName(name)
    if (n !== row.name) { sets.push('name = ?'); args.push(n); changed.push('name') }
  }
  if (expiresAt !== undefined) {
    let exp = null
    if (expiresAt !== null) {
      const t = Date.parse(expiresAt)
      if (Number.isNaN(t)) throw new TokenError(`expiresAt 不是合法时间：${expiresAt}`)
      if (t <= Date.now()) throw new TokenError('expiresAt 必须是将来的时间（想让它立刻失效请用"撤销"）')
      exp = new Date(t).toISOString()
    }
    sets.push('expires_at = ?'); args.push(exp); changed.push('expiresAt')
  }
  if (!sets.length) return { tokenId: row.token_id, name: row.name, changed: [] }
  try {
    db.prepare(`UPDATE agent_tokens SET ${sets.join(', ')} WHERE token_id = ? AND revoked_at IS NULL`).run(...args, row.token_id)
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw new TokenError(`令牌名已存在：${name}（被一枚未撤销的令牌使用）`, 'conflict')
    throw e
  }
  return { tokenId: row.token_id, name: name !== undefined ? String(name).trim() : row.name, changed }
}

/**
 * 校验明文令牌（不含 "Bearer " 前缀）。
 * @returns {{ok:true, token:{tokenId:string,name:string,scopes:string[]}} | {ok:false, reason:'malformed'|'unknown'|'mismatch'|'revoked'|'expired'}}
 * reason 仅供内部日志，绝不原样返回给调用方（避免枚举）。
 */
export function verifyToken(root, bearer) {
  const m = typeof bearer === 'string' ? TOKEN_RE.exec(bearer) : null
  if (!m) return { ok: false, reason: 'malformed' }
  const [, tokenId, secret] = m
  const row = getDb(root).prepare('SELECT * FROM agent_tokens WHERE token_id = ?').get(tokenId)
  const given = Buffer.from(sha256hex(secret), 'hex')
  const stored = row ? Buffer.from(row.secret_hash, 'hex') : DUMMY_HASH
  const same = stored.length === given.length && crypto.timingSafeEqual(stored, given)
  if (!row) return { ok: false, reason: 'unknown' }
  if (!same) return { ok: false, reason: 'mismatch' }
  if (row.revoked_at) return { ok: false, reason: 'revoked' }
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: 'expired' }
  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0
  if (!last || Date.now() - last >= LAST_USED_THROTTLE_MS) {
    try { getDb(root).prepare('UPDATE agent_tokens SET last_used_at = ? WHERE token_id = ?').run(new Date().toISOString(), tokenId) } catch { /* 统计字段，失败不影响鉴权 */ }
  }
  return { ok: true, token: { tokenId, name: row.name, scopes: JSON.parse(row.scopes) } }
}
