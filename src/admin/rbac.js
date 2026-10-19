// memory-hub · 管理界面 RBAC（纯函数，无 IO）。
//
// 设计见 docs/decisions/2026-10-19-admin-multi-user-rbac.md。
//
// 原则：
//   1. 可见性复用 core/scope.js 的 tierOf —— 网页上看到的必须和 MCP 检索到的是同一套规则；
//   2. 看不见的一定改不了（canEdit/canModerate 都先过 canSee）；
//   3. 拿不准就少给权限：非法角色降为 member。

import { tierOf } from '../core/scope.js'

/** 角色，数组顺序 = 权限从低到高。 */
export const ROLES = ['member', 'lead', 'admin']
export const isRole = (r) => ROLES.includes(r)

/** 应急入口（原单管理员口令）的身份：超级管理员。 */
export const BREAK_GLASS = Object.freeze({ id: null, username: 'admin', team: '', role: 'admin', breakGlass: true })

const str = (x) => (x === undefined || x === null ? '' : String(x))

/** 由用户行构造会话里的身份；只取需要的字段，绝不带口令哈希。 */
export function principalOf(row) {
  return {
    id: row?.id ?? null,
    username: str(row?.username),
    team: str(row?.team),
    role: isRole(row?.role) ? row.role : 'member',
    breakGlass: false,
  }
}

export const isAdmin = (p) => p?.role === 'admin'
export const isLead = (p) => p?.role === 'lead'

/** 路由级检查：principal 的角色是否在路由声明的集合里。 */
export function roleAllows(p, roles) {
  return Array.isArray(roles) && roles.includes(p?.role)
}

const viewerOf = (p) => ({ owner: p.username, team: p.team })
const isOwn = (p, card) => str(card?.owner) === p.username
const sameTeam = (p, card) => str(card?.team) === p.team && p.team !== ''

/**
 * 能否看到这张卡。
 * - admin：全部；
 * - 已批准卡：与 MCP 检索同一套规则（tierOf 非 null）；
 * - 待审 / 驳回 / 已删：只看自己的；团队管理员另可看本团队的（要审它）。
 */
export function canSeeCard(p, card) {
  if (isAdmin(p)) return true
  const status = str(card?.status) || 'approved'
  if (status !== 'approved') return isOwn(p, card) || (isLead(p) && sameTeam(p, card))
  return tierOf(card, viewerOf(p)) !== null
}

/** 能否编辑 / 软删 / 回滚这张卡：自己的；团队管理员加本团队的（private 除外）；admin 全部。 */
export function canEditCard(p, card) {
  if (isAdmin(p)) return true
  if (!canSeeCard(p, card)) return false
  if (isOwn(p, card)) return true
  return isLead(p) && sameTeam(p, card)
}

/** 能否审批（批准 / 驳回）：团队管理员限本团队；admin 全部。 */
export function canModerateCard(p, card) {
  if (isAdmin(p)) return true
  return isLead(p) && sameTeam(p, card)
}

/** 能否管理（看 / 改 / 撤销）一枚令牌：非 admin 只能管 owner 是自己的。 */
export function canManageToken(p, token) {
  if (isAdmin(p)) return true
  return str(token?.owner) === p.username && p.username !== ''
}

/** 新建令牌时的归属：非 admin 强制为本人与本团队，忽略请求里的 owner/team。 */
export function tokenScopeFor(p, requested = {}) {
  if (isAdmin(p)) return { owner: str(requested.owner), team: str(requested.team) }
  return { owner: p.username, team: p.team }
}
