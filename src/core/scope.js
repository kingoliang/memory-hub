// memory-hub · 团队可见性与「先自己、后团队」分层检索（纯函数，无 IO）。
//
// 设计见 docs/decisions/2026-10-18-team-scope-own-first-recall.md。
//
// 三件必须记住的语义：
//   1. tier 是**权限**概念，不是排序技巧 —— 决定一条卡对这个 viewer 是否可见、以及可见时属于哪一层。
//   2. 排序键是 tier 优先，其次才是 score。所以一条弱命中的自己的卡会排在强命中的团队卡之前。
//   3. viewer 为 null = 单机模式（无 owner/team 概念）：一切可见、全部同层，退化成旧行为。

/** 可见性白名单。private 只给 owner 本人（**同团队他人也看不到**）。 */
export const VISIBILITIES = ['private', 'team', 'public']
/** 检索时的纳入范围。auto = 自己 → 同团队 → 跨团队公开。 */
export const SCOPE_MODES = ['auto', 'mine', 'team']
/** 层级，数组顺序即排序优先级（self 最先）。 */
export const TIERS = ['self', 'team', 'public']
/** 卡片没写 visibility 时的默认值（与 DB 列默认值一致）。 */
export const DEFAULT_VISIBILITY = 'team'

const TIER_RANK = { self: 0, team: 1, public: 2 }
const str = (x) => (x === undefined || x === null ? '' : String(x))

export function isVisibility(v) {
  return VISIBILITIES.includes(str(v))
}

/** viewer 归一（缺字段补空串，非法值转字符串，不抛）。 */
export function normalizeViewer(viewer) {
  if (!viewer || typeof viewer !== 'object') return { owner: '', team: '' }
  return { owner: str(viewer.owner), team: str(viewer.team) }
}

/** scope → 纳入的 tier 全集合。非法 scope 按 auto。 */
export function visibleTiers(scope) {
  const s = SCOPE_MODES.includes(str(scope)) ? str(scope) : 'auto'
  if (s === 'mine') return ['self']
  if (s === 'team') return ['self', 'team']
  return ['self', 'team', 'public']
}

/**
 * 一条卡相对 viewer 的层级。
 * @returns {'self'|'team'|'public'|null} null = 不可见
 */
export function tierOf(card, viewer) {
  const owner = str(card?.owner)
  const team = str(card?.team)
  const visibility = isVisibility(card?.visibility) ? str(card.visibility) : DEFAULT_VISIBILITY

  if (!viewer) return 'self' // 单机模式
  const v = normalizeViewer(viewer)

  // owner 相同即本人（含双方都为空的历史数据：owner='' 视为同一个"本地人"）
  if (owner === v.owner) return 'self'
  // private 只给本人，**不**降级为 team
  if (visibility === 'private') return null
  // team 要求 team 完全相同；两边都空视为同团队（老库升级路径）
  if (team === v.team) return 'team'
  if (visibility === 'public') return 'public'
  return null
}

/**
 * 过滤 + 排序。返回新对象数组（每个 hit 附带 tier），不改入参、不给入参对象挂字段。
 * 排序：tier 升序 → score 降序 → mtime 降序。
 */
export function rankHits(hits, viewer, scope = 'auto') {
  const allowed = new Set(visibleTiers(scope))
  const out = []
  for (const hit of Array.isArray(hits) ? hits : []) {
    const tier = tierOf(hit, viewer)
    if (!tier || !allowed.has(tier)) continue
    out.push({ ...hit, tier })
  }
  out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || (b.score ?? 0) - (a.score ?? 0) || (b.mtime ?? 0) - (a.mtime ?? 0))
  return out
}

/** tier → 渲染用中文标签（管理界面 / MCP 输出共用，保证两边说法一致）。 */
export function tierLabel(tier, hit = {}) {
  if (tier === 'self') return '自己的记忆'
  if (tier === 'team') return `团队 · ${str(hit.owner) || '未知'}`
  if (tier === 'public') return `公开 · ${str(hit.owner) || '未知'}`
  return '其它'
}
