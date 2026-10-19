// memory-hub · 管理界面账号（admin_users）：建 / 改 / 停用 / 认证。
//
// 设计见 docs/decisions/2026-10-19-admin-multi-user-rbac.md。
// - username 同时是 owner（与 Agent 令牌的 --owner 对齐），规则同 tokens.validateParty，统一小写；
// - 口令复用 auth.js 的 scrypt 格式与强度；只在内存里出现，不落日志；
// - 停用 / 改口令 → 删除该用户的全部会话（立即踢下线）；改角色 / 团队 → 会话下一次请求即生效（会话每次都回表取用户）。

import { getDb } from '../core/db.js'
import { hashPassword, verifyPasswordAsync, validatePassword, AdminAuthError } from './auth.js'
import { ROLES, isRole, BREAK_GLASS, principalOf } from './rbac.js'

export class UserError extends Error {
  /** @param {'bad_request'|'conflict'|'not_found'} kind */
  constructor(message, kind = 'bad_request') { super(message); this.name = 'UserError'; this.kind = kind }
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TEAM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const nowIso = () => new Date().toISOString()

export function normalizeUsername(name) {
  return String(name ?? '').trim().toLowerCase()
}

function validateUsername(name) {
  const n = normalizeUsername(name)
  if (!NAME_RE.test(n)) throw new UserError('用户名只能含字母数字与 . _ -，以字母或数字开头，最长 64 字符')
  if (n === BREAK_GLASS.username) throw new UserError('admin 是保留用户名（应急入口专用）')
  return n
}
function validateTeam(team) {
  const t = String(team ?? '').trim()
  if (t !== '' && !TEAM_RE.test(t)) throw new UserError('team 只能含字母数字与 . _ -，以字母或数字开头，最长 64 字符')
  return t
}
function validateRole(role) {
  const r = String(role ?? '').trim()
  if (!isRole(r)) throw new UserError(`role 只能是 ${ROLES.join(' / ')}`)
  return r
}
function checkPassword(pw) {
  try { validatePassword(pw) } catch (e) { throw new UserError(e instanceof AdminAuthError ? e.message : '口令不合法') }
}

const toPublic = (r) => ({
  id: r.id, username: r.username, team: r.team, role: r.role,
  createdAt: r.created_at, updatedAt: r.updated_at, disabledAt: r.disabled_at, disabled: !!r.disabled_at, lastLoginAt: r.last_login_at,
})

function rowByName(db, username) {
  return db.prepare('SELECT * FROM admin_users WHERE username = ?').get(normalizeUsername(username))
}
function mustGet(db, username) {
  const row = rowByName(db, username)
  if (!row) throw new UserError(`用户不存在：${normalizeUsername(username)}`, 'not_found')
  return row
}
const dropSessions = (db, userId) => db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(userId)

export function createUser(root, { username, team = '', role = 'member', password }, { cost } = {}) {
  const n = validateUsername(username)
  const t = validateTeam(team)
  const r = validateRole(role)
  checkPassword(password)
  const db = getDb(root)
  if (rowByName(db, n)) throw new UserError(`用户名已存在：${n}`, 'conflict')
  const now = nowIso()
  const info = db.prepare('INSERT INTO admin_users (username, team, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(n, t, r, hashPassword(password, cost), now, now)
  return toPublic(db.prepare('SELECT * FROM admin_users WHERE id = ?').get(Number(info.lastInsertRowid)))
}

export function listUsers(root) {
  return getDb(root).prepare('SELECT * FROM admin_users ORDER BY username').all().map(toPublic)
}

export function getUser(root, username) {
  const row = rowByName(getDb(root), username)
  return row ? toPublic(row) : null
}

/** 改团队 / 角色（undefined = 不动）。返回改动了哪些字段。 */
export function updateUser(root, username, { team, role } = {}) {
  const db = getDb(root)
  const row = mustGet(db, username)
  const sets = []
  const args = []
  const changed = []
  if (team !== undefined) { const t = validateTeam(team); if (t !== row.team) { sets.push('team = ?'); args.push(t); changed.push('team') } }
  if (role !== undefined) { const r = validateRole(role); if (r !== row.role) { sets.push('role = ?'); args.push(r); changed.push('role') } }
  if (sets.length) db.prepare(`UPDATE admin_users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, nowIso(), row.id)
  // 换团队：这个人名下未撤销令牌的团队同步跟着变，令牌团队永远与账号团队一致（已撤销的保留历史值）
  if (changed.includes('team')) db.prepare('UPDATE agent_tokens SET team = ? WHERE owner = ? AND revoked_at IS NULL').run(validateTeam(team), row.username)
  return { username: row.username, changed }
}

export function setUserPassword(root, username, password, { cost } = {}) {
  checkPassword(password)
  const db = getDb(root)
  const row = mustGet(db, username)
  db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(password, cost), nowIso(), row.id)
  dropSessions(db, row.id)
  return { username: row.username }
}

export function disableUser(root, username) {
  const db = getDb(root)
  const row = mustGet(db, username)
  if (!row.disabled_at) db.prepare('UPDATE admin_users SET disabled_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), row.id)
  dropSessions(db, row.id)
  return { username: row.username, disabled: true }
}

export function enableUser(root, username) {
  const db = getDb(root)
  const row = mustGet(db, username)
  if (row.disabled_at) db.prepare('UPDATE admin_users SET disabled_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), row.id)
  return { username: row.username, disabled: false }
}

/**
 * 校验用户名 + 口令。成功返回 principal（不含口令哈希），失败 / 不存在 / 已停用一律返回 null（不区分原因，防枚举）。
 * 不存在的用户也跑一次哈希比较，避免靠响应时间判断用户名是否存在。
 */
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64')
export async function authenticateUser(root, username, password) {
  const db = getDb(root)
  const row = rowByName(db, username)
  const ok = await verifyPasswordAsync(String(password ?? ''), row?.password_hash || DUMMY_HASH)
  if (!row || !ok || row.disabled_at) return null
  db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id)
  return principalOf(row)
}

/** 会话回表：用户已删 / 已停用 → null。 */
export function principalById(root, id) {
  const row = getDb(root).prepare('SELECT * FROM admin_users WHERE id = ?').get(id)
  if (!row || row.disabled_at) return null
  return principalOf(row)
}
