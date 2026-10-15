// memory-hub · 管理界面只读查询。所有函数只 SELECT（会话表与 write_log 的写入在 auth/handler 里，不在这里）。
//
// 输出约定（对应 PLAN 第 3.3、5 节与任务红线）：
//   - 卡片以 path 为键，不暴露 id；
//   - 不输出令牌哈希/明文、口令哈希、会话 id、args_digest；
//   - 卡片正文/摘要/更新记录/修订里的疑似明文密钥一律遮蔽成 [已遮蔽:类型]，并标注类型；
//   - 时间戳容忍两种格式：ISO（new Date().toISOString()）与 SQLite 默认 `YYYY-MM-DD HH:MM:SS`（按 UTC 解析）。

import fs from 'node:fs'
import path from 'node:path'
import { getDb, checkMainStoreInvariant, DB_FILENAME } from '../core/db.js'
import { queryTerms, TITLE_COLLATOR, RECYCLE_RETENTION_DAYS } from '../core/vault.js'
import { tidyPlan, tidyLint, detectSecrets, redactSecrets, tagKey } from '../core/tidy.js'
import { OUTCOMES, ACTOR_TYPES } from '../core/writelog.js'

export const UNSIGNED = '__none__'
export const UNSIGNED_LABEL = '(未署名)'
export const LIST_STATUSES = ['approved', 'pending', 'rejected', 'deleted']
export const SORTS = ['updated', 'created', 'title', 'path', 'score']
const DAY = 86400e3
const EXCERPT_CHARS = 200

export class BadRequest extends Error {
  constructor(message) { super(message); this.name = 'BadRequest' }
}

/** 两种时间戳格式 → epoch ms；无法解析 → 0。 */
export function tsMs(s) {
  if (!s) return 0
  const str = String(s)
  const t = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(str) ? Date.parse(str.replace(' ', 'T') + 'Z') : Date.parse(str)
  return Number.isNaN(t) ? 0 : t
}
const isoOrNull = (s) => (s ? new Date(tsMs(s)).toISOString() : null)

function parseTags(raw) {
  try {
    const v = JSON.parse(raw || '[]')
    if (Array.isArray(v)) return v.map((t) => String(t).trim()).filter(Boolean)
  } catch { /* 非法 JSON：当作无标签，lint 会单独报告 */ }
  return []
}

const agentOf = (r) => {
  const by = r.submitted_by || ''
  const src = r.source || ''
  return { agent: by || src || UNSIGNED_LABEL, agentFromSource: !by && !!src }
}

const excerptOf = (body) => redactSecrets(String(body || '').slice(0, 1000)).text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)

// ---------------------------------------------------------------------------
// 卡片列表
// ---------------------------------------------------------------------------

function storesFor(status) {
  if (status === 'approved') return [{ table: 'cards', where: '' }]
  if (status === 'all') return [{ table: 'cards', where: '' }, { table: 'quarantine', where: '' }]
  return [{ table: 'quarantine', where: 'status = ?', args: [status] }]
}

/**
 * @param {object} f { status, kind, tags[], agent, source, q, createdFrom, createdTo, updatedFrom, updatedTo, sort, order, limit, offset }
 */
export function listCards(root, f) {
  const db = getDb(root)
  const q = String(f.q || '').trim()
  const needBody = q.length > 0
  const rows = []
  for (const st of storesFor(f.status)) {
    const where = []
    const args = []
    if (st.where) { where.push(st.where); args.push(...(st.args || [])) }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
    if (f.agent === UNSIGNED) where.push("COALESCE(submitted_by,'') = ''")
    else if (f.agent) { where.push('submitted_by = ?'); args.push(f.agent) }
    if (f.source) { where.push('source = ?'); args.push(f.source) }
    const cols = `path, kind, title, tags, status, source, submitted_by, created_at, updated_at, deleted_at, LENGTH(body) AS body_chars${needBody ? ', body' : ''}`
    rows.push(...db.prepare(`SELECT ${cols} FROM ${st.table}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`).all(...args))
  }

  let items = rows.map((r) => ({ r, tags: parseTags(r.tags), created: tsMs(r.created_at), updated: tsMs(r.updated_at) }))
  if (f.tags?.length) items = items.filter((x) => f.tags.every((t) => x.tags.includes(t)))
  if (f.createdFrom != null) items = items.filter((x) => x.created >= f.createdFrom)
  if (f.createdTo != null) items = items.filter((x) => x.created <= f.createdTo)
  if (f.updatedFrom != null) items = items.filter((x) => x.updated >= f.updatedFrom)
  if (f.updatedTo != null) items = items.filter((x) => x.updated <= f.updatedTo)

  if (needBody) {
    // 与 memory_recall（vault.search）同一套打分：整串命中 +3，每个查询词（整词 + 中文二元组）命中 +1；haystack = path + title + body
    const ql = q.toLowerCase()
    const terms = [...queryTerms(q)].map((t) => t.toLowerCase())
    const scored = []
    for (const x of items) {
      const hay = `${x.r.path}\n${x.r.title}\n${x.r.body}`.toLowerCase()
      let score = hay.includes(ql) ? 3 : 0
      for (const t of terms) if (hay.includes(t)) score += 1
      if (score > 0) scored.push({ ...x, score })
    }
    items = scored
  }

  const dir = f.order === 'asc' ? 1 : -1
  const sort = f.sort === 'score' && !needBody ? 'updated' : f.sort
  const cmp = {
    updated: (a, b) => (a.updated - b.updated) * dir,
    created: (a, b) => (a.created - b.created) * dir,
    title: (a, b) => TITLE_COLLATOR.compare(a.r.title || '', b.r.title || '') * dir,
    path: (a, b) => (a.r.path < b.r.path ? -1 : a.r.path > b.r.path ? 1 : 0) * dir,
    score: (a, b) => (a.score - b.score) * dir,
  }[sort]
  items.sort((a, b) => cmp(a, b) || b.updated - a.updated || (a.r.path < b.r.path ? -1 : 1))

  const total = items.length
  const page = items.slice(f.offset, f.offset + f.limit)
  return { total, page, hasScore: needBody }
}

/** 把页内的行补全为输出项（读正文只为生成遮蔽后的摘要与密钥类型，正文本身不输出）。 */
function hydrate(db, page, extra = () => ({})) {
  const bodyOf = new Map()
  for (const table of ['cards', 'quarantine']) {
    const paths = page.filter((x) => (table === 'cards') === (x.r.status === 'approved')).map((x) => x.r.path)
    if (!paths.length) continue
    for (const b of db.prepare(`SELECT path, body FROM ${table} WHERE path IN (${paths.map(() => '?').join(',')})`).all(...paths)) bodyOf.set(b.path, b.body)
  }
  return page.map((x) => {
    const body = x.r.body ?? bodyOf.get(x.r.path) ?? ''
    const { agent, agentFromSource } = agentOf(x.r)
    return {
      path: x.r.path,
      title: redactSecrets(x.r.title).text,
      kind: x.r.kind,
      tags: x.tags,
      status: x.r.status,
      agent, agentFromSource,
      submittedBy: x.r.submitted_by || '',
      source: x.r.source || '',
      createdAt: isoOrNull(x.r.created_at),
      updatedAt: isoOrNull(x.r.updated_at),
      deletedAt: isoOrNull(x.r.deleted_at),
      bodyChars: x.r.body_chars,
      excerpt: excerptOf(body),
      secretTypes: detectSecrets(`${x.r.title}\n${body}`),
      ...(x.score !== undefined ? { score: x.score } : {}),
      ...extra(x),
    }
  })
}

export function cardsPage(root, f) {
  const { total, page } = listCards(root, f)
  return { total, offset: f.offset, limit: f.limit, items: hydrate(getDb(root), page) }
}

// ---------------------------------------------------------------------------
// 待审队列 / 回收站
// ---------------------------------------------------------------------------

export function queuePage(root, { status, limit, offset }) {
  const db = getDb(root)
  const counts = { pending: 0, rejected: 0 }
  for (const r of db.prepare("SELECT status, COUNT(*) n FROM quarantine WHERE status IN ('pending','rejected') GROUP BY status").all()) counts[r.status] = r.n
  const statuses = status === 'all' ? ['pending', 'rejected'] : [status]
  const rows = db.prepare(`SELECT path, kind, title, tags, status, source, submitted_by, created_at, updated_at, deleted_at, reason, quarantine_reason, quarantined_at, LENGTH(body) AS body_chars FROM quarantine WHERE status IN (${statuses.map(() => '?').join(',')})`).all(...statuses)
    .map((r) => ({ r, tags: parseTags(r.tags), created: tsMs(r.created_at), updated: tsMs(r.updated_at) }))
  rows.sort((a, b) => a.created - b.created || (a.r.path < b.r.path ? -1 : 1))
  const now = Date.now()
  const page = rows.slice(offset, offset + limit)
  return {
    total: rows.length, counts, offset, limit,
    items: hydrate(db, page, (x) => ({ reason: redactSecrets(x.r.reason || '').text, quarantineReason: x.r.quarantine_reason || '', ageDays: Math.max(0, Math.floor((now - x.created) / DAY)) })),
  }
}

export function recyclePage(root, { limit, offset }) {
  const db = getDb(root)
  const rows = db.prepare("SELECT path, kind, title, tags, status, source, submitted_by, created_at, updated_at, deleted_at, LENGTH(body) AS body_chars FROM quarantine WHERE status = 'deleted'").all()
    .map((r) => ({ r, tags: parseTags(r.tags), created: tsMs(r.created_at), updated: tsMs(r.updated_at), deleted: tsMs(r.deleted_at) }))
  const now = Date.now()
  const expiry = (x) => (x.deleted || x.updated) + RECYCLE_RETENTION_DAYS * DAY
  rows.sort((a, b) => expiry(a) - expiry(b))
  const page = rows.slice(offset, offset + limit)
  return {
    total: rows.length, retentionDays: RECYCLE_RETENTION_DAYS, offset, limit,
    items: hydrate(db, page, (x) => ({ expiresAt: new Date(expiry(x)).toISOString(), daysLeft: Math.max(0, Math.ceil((expiry(x) - now) / DAY)) })),
  }
}

// ---------------------------------------------------------------------------
// 卡片详情
// ---------------------------------------------------------------------------

export function cardDetail(root, cardPath) {
  const db = getDb(root)
  let row = db.prepare('SELECT * FROM cards WHERE path = ?').get(cardPath)
  let inQuarantine = false
  if (!row) { row = db.prepare('SELECT * FROM quarantine WHERE path = ?').get(cardPath); inQuarantine = !!row }
  if (!row) return null
  const red = (s) => redactSecrets(s)
  const body = red(row.body)
  const types = new Set(body.types)

  const updates = db.prepare('SELECT content, created_at FROM card_updates WHERE card_id = ? ORDER BY id').all(row.id).map((u) => {
    const r = red(u.content); r.types.forEach((t) => types.add(t))
    return { content: r.text, createdAt: isoOrNull(u.created_at) }
  })
  const revisions = db.prepare('SELECT id, title, body, tags, kind, edited_by, edited_at FROM card_revisions WHERE card_path = ? ORDER BY id DESC LIMIT 50').all(cardPath).map((v) => {
    const r = red(v.body); r.types.forEach((t) => types.add(t))
    return { id: v.id, title: red(v.title).text, body: r.text, tags: parseTags(v.tags), kind: v.kind, editedBy: v.edited_by, editedAt: isoOrNull(v.edited_at) }
  })
  const history = db.prepare('SELECT old_status, new_status, changed_by, reason, created_at FROM audit_log WHERE card_path = ? ORDER BY id DESC LIMIT 50').all(cardPath)
    .map((h) => ({ oldStatus: h.old_status, newStatus: h.new_status, changedBy: h.changed_by, reason: red(h.reason || '').text, createdAt: isoOrNull(h.created_at) }))
  const writes = db.prepare('SELECT ts, actor_type, actor_name, tool, action, outcome FROM write_log WHERE card_path = ? ORDER BY id DESC LIMIT 20').all(cardPath)
    .map((w) => ({ ts: w.ts, actorType: w.actor_type, actorName: w.actor_name, tool: w.tool, action: w.action, outcome: w.outcome }))

  let signedByToken = null
  if (row.submitted_by) {
    const t = db.prepare('SELECT name, revoked_at, expires_at FROM agent_tokens WHERE name = ? ORDER BY revoked_at IS NOT NULL, created_at DESC LIMIT 1').get(row.submitted_by)
    signedByToken = t
      ? { name: t.name, exists: true, revoked: !!t.revoked_at, expired: !!t.expires_at && tsMs(t.expires_at) <= Date.now() }
      : { name: row.submitted_by, exists: false, revoked: false, expired: false }
  }

  let retention = null
  if (row.status === 'deleted') {
    const exp = (tsMs(row.deleted_at) || tsMs(row.updated_at)) + RECYCLE_RETENTION_DAYS * DAY
    retention = { days: RECYCLE_RETENTION_DAYS, expiresAt: new Date(exp).toISOString(), daysLeft: Math.max(0, Math.ceil((exp - Date.now()) / DAY)) }
  }
  const { agent, agentFromSource } = agentOf(row)
  return {
    path: row.path, title: red(row.title).text, kind: row.kind, tags: parseTags(row.tags), status: row.status,
    body: body.text, summary: red(row.summary || '').text,
    source: row.source || '', submittedBy: row.submitted_by || '', agent, agentFromSource, severity: row.severity || 'info',
    reason: red(row.reason || '').text,
    createdAt: isoOrNull(row.created_at), updatedAt: isoOrNull(row.updated_at), deletedAt: isoOrNull(row.deleted_at),
    signedByToken,
    quarantine: inQuarantine ? { quarantinedAt: isoOrNull(row.quarantined_at), reason: row.quarantine_reason || '' } : null,
    retention,
    redacted: types.size > 0,
    secretTypes: [...types],
    updates, revisions, history, writes,
  }
}

// ---------------------------------------------------------------------------
// 标签
// ---------------------------------------------------------------------------

export function tagStats(root, { q, limit }) {
  const counts = new Map()
  for (const r of getDb(root).prepare('SELECT tags FROM cards').all()) for (const t of new Set(parseTags(r.tags))) counts.set(t, (counts.get(t) || 0) + 1)
  const all = [...counts.entries()].map(([tag, count]) => ({ tag, count, singleton: count === 1 }))
  all.sort((a, b) => b.count - a.count || TITLE_COLLATOR.compare(a.tag, b.tag))
  const groups = new Map()
  for (const it of all) { const k = tagKey(it.tag); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it) }
  const synonymGroups = [...groups.entries()].filter(([, v]) => v.length > 1).map(([key, v]) => ({
    key, variants: v.map((x) => ({ tag: x.tag, count: x.count })), suggested: v[0].tag, cards: v.reduce((s, x) => s + x.count, 0),
  })).sort((a, b) => b.cards - a.cards)
  const ql = String(q || '').toLowerCase()
  const filtered = ql ? all.filter((t) => t.tag.toLowerCase().includes(ql)) : all
  return {
    total: filtered.length, distinct: all.length, singletonCount: all.filter((t) => t.singleton).length,
    items: filtered.slice(0, limit), synonymGroups,
  }
}

// ---------------------------------------------------------------------------
// 整理预览 / lint
// ---------------------------------------------------------------------------

export async function tidyPreview(root, { threshold, limit }) {
  const plan = await tidyPlan(root, { threshold, logger: () => {} })
  const cap = (arr) => arr.slice(0, limit)
  const red = (s) => redactSecrets(s).text
  const dupAbsorb = plan.duplicates.reduce((n, g) => n + g.absorbs.length, 0)
  return {
    readOnly: true,
    planId: plan.planId,
    generatedAt: plan.generatedAt,
    options: { threshold: plan.options.threshold, maxTags: plan.options.maxTags, rawMaxChars: plan.options.rawMaxChars, noiseCategories: plan.options.noiseCategories },
    totals: plan.totals,
    counts: {
      noise: plan.noise.length, duplicateGroups: plan.duplicates.length, duplicateAbsorbable: dupAbsorb,
      tagChanges: plan.tags.changes.length, kindMisplaced: plan.kindMisplaced.length, secrets: plan.secrets.length, oversizeRaw: plan.oversizeRaw.length,
    },
    truncated: {
      noise: plan.noise.length > limit, duplicates: plan.duplicates.length > limit, tags: plan.tags.changes.length > limit,
      kindMisplaced: plan.kindMisplaced.length > limit, secrets: plan.secrets.length > limit, oversizeRaw: plan.oversizeRaw.length > limit,
    },
    noise: cap(plan.noise).map((n) => ({ path: n.path, title: red(n.title), category: n.category, reason: n.reason })),
    duplicates: cap(plan.duplicates).map((g) => ({
      canonical: { path: g.canonical.path, title: red(g.canonical.title) },
      absorbs: g.absorbs.map((a) => ({ path: a.path, title: red(a.title), sim: a.sim, uniqueLines: a.uniqueLines })),
    })),
    tags: {
      distinctBefore: plan.tags.distinctBefore, distinctAfter: plan.tags.distinctAfter,
      map: Object.fromEntries(Object.entries(plan.tags.map).slice(0, limit)),
      mapSize: Object.keys(plan.tags.map).length,
      changes: cap(plan.tags.changes).map((c) => ({ path: c.path, old: c.old, new: c.new, malformed: !!c.malformed })),
    },
    kindMisplaced: cap(plan.kindMisplaced).map((k) => ({ path: k.path, kind: k.kind, expectedKind: k.expectedKind })),
    secrets: cap(plan.secrets).map((s) => ({ path: s.path, types: s.types })),
    oversizeRaw: cap(plan.oversizeRaw).map((r) => ({ path: r.path, title: red(r.title), chars: r.chars })),
  }
}

export function backupInfo(root) {
  const dir = path.join(path.resolve(root), 'backups')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => /^memory-eternal-.*\.db$/.test(f)).map((f) => { const st = fs.statSync(path.join(dir, f)); return { file: f, bytes: st.size, at: st.mtime.toISOString(), ms: st.mtimeMs } })
  } catch { /* 目录尚不存在 */ }
  files.sort((a, b) => b.ms - a.ms)
  const last = files[0] ? { file: files[0].file, bytes: files[0].bytes, at: files[0].at } : null
  return { count: files.length, last }
}

export async function lintReport(root) {
  const m = await tidyLint(root, { logger: () => {} })
  const { vault: _omit, ...rest } = m // 不向界面暴露服务器目录
  const inv = checkMainStoreInvariant(root)
  const b = backupInfo(root)
  return {
    ...rest,
    invariant: { ok: inv.ok, mainTotal: inv.mainTotal, violations: inv.violations },
    backups: { count: b.count, last: b.last },
  }
}

// ---------------------------------------------------------------------------
// 令牌 / 审计日志
// ---------------------------------------------------------------------------

export function tokenList(root) {
  const db = getDb(root)
  const since = new Date(Date.now() - 30 * DAY).toISOString()
  const calls = Object.fromEntries(db.prepare("SELECT actor_name, COUNT(*) n FROM write_log WHERE actor_type = 'agent' AND ts >= ? GROUP BY actor_name").all(since).map((r) => [r.actor_name, r.n]))
  const items = db.prepare('SELECT token_id, name, scopes, created_at, last_used_at, expires_at, revoked_at FROM agent_tokens ORDER BY created_at, token_id').all().map((t) => {
    const expired = !!t.expires_at && tsMs(t.expires_at) <= Date.now()
    return {
      tokenId: t.token_id, name: t.name, scopes: JSON.parse(t.scopes), createdAt: t.created_at, lastUsedAt: t.last_used_at, expiresAt: t.expires_at, revokedAt: t.revoked_at,
      status: t.revoked_at ? 'revoked' : expired ? 'expired' : 'active', calls30d: calls[t.name] || 0,
    }
  })
  return { total: items.length, items }
}

export function writeLogPage(root, f) {
  const where = []
  const args = []
  if (f.actor) { where.push('actor_name = ?'); args.push(f.actor) }
  if (f.actorType) { where.push('actor_type = ?'); args.push(f.actorType) }
  if (f.tool) { where.push('tool = ?'); args.push(f.tool) }
  if (f.action) { where.push('action = ?'); args.push(f.action) }
  if (f.outcome) { where.push('outcome = ?'); args.push(f.outcome) }
  if (f.from != null) { where.push('ts >= ?'); args.push(new Date(f.from).toISOString()) }
  if (f.to != null) { where.push('ts <= ?'); args.push(new Date(f.to).toISOString()) }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : ''
  const db = getDb(root)
  const total = db.prepare(`SELECT COUNT(*) n FROM write_log${w}`).get(...args).n
  const items = db.prepare(`SELECT ts, actor_type, actor_name, tool, action, card_path, outcome, ip FROM write_log${w} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`).all(...args, f.limit, f.offset)
    .map((l) => ({ ts: l.ts, actorType: l.actor_type, actorName: l.actor_name, tool: l.tool, action: l.action, cardPath: l.card_path, outcome: l.outcome, ip: l.ip }))
  return { total, offset: f.offset, limit: f.limit, items }
}
export const WRITE_LOG_OUTCOMES = OUTCOMES
export const WRITE_LOG_ACTOR_TYPES = ACTOR_TYPES

// ---------------------------------------------------------------------------
// facets / 总览
// ---------------------------------------------------------------------------

export function facets(root) {
  const db = getDb(root)
  const kinds = db.prepare('SELECT kind, COUNT(*) count FROM cards GROUP BY kind ORDER BY count DESC, kind').all()
  const agentRows = db.prepare('SELECT submitted_by, source FROM cards').all()
  const byAgent = new Map()
  const bySource = new Map()
  let unsigned = 0
  for (const r of agentRows) {
    if (r.submitted_by) byAgent.set(r.submitted_by, (byAgent.get(r.submitted_by) || 0) + 1); else unsigned++
    if (r.source) bySource.set(r.source, (bySource.get(r.source) || 0) + 1)
  }
  const agents = [...byAgent.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name, count]) => ({ name, value: name, count }))
  if (unsigned) agents.push({ name: UNSIGNED_LABEL, value: UNSIGNED, count: unsigned })
  const q = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM quarantine GROUP BY status').all().map((r) => [r.status, r.n]))
  const statuses = [
    { status: 'approved', count: agentRows.length }, { status: 'pending', count: q.pending || 0 },
    { status: 'rejected', count: q.rejected || 0 }, { status: 'deleted', count: q.deleted || 0 },
  ]
  const tags = tagStats(root, { q: '', limit: 100 }).items
  return { kinds, agents, sources: [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })), statuses, tags }
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10)

export function dailySeries(days, stamps) {
  const map = new Map()
  for (const ms of stamps) { if (ms) map.set(utcDay(ms), (map.get(utcDay(ms)) || 0) + 1) }
  const out = []
  const now = Date.now()
  for (let i = days - 1; i >= 0; i--) { const d = utcDay(now - i * DAY); out.push({ date: d, count: map.get(d) || 0 }) }
  return out
}

function fileBytes(p) { try { return fs.statSync(p).size } catch { return 0 } }

export function overview(root, { config, alerts: extraAlerts = [] } = {}) {
  const db = getDb(root)
  const cardsRows = db.prepare('SELECT kind, submitted_by, created_at FROM cards').all()
  const byKind = {}
  const agents = new Map()
  for (const r of cardsRows) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1
    const n = r.submitted_by || UNSIGNED_LABEL
    agents.set(n, (agents.get(n) || 0) + 1)
  }
  const tagSet = new Set()
  for (const r of db.prepare('SELECT tags FROM cards').all()) for (const t of parseTags(r.tags)) tagSet.add(t)
  const q = { pending: 0, rejected: 0, deleted: 0 }
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM quarantine GROUP BY status').all()) if (r.status in q) q[r.status] = r.n
  const created = cardsRows.map((r) => tsMs(r.created_at))
  const week = Date.now() - 7 * DAY
  const dbFile = path.join(path.resolve(root), DB_FILENAME)
  const b = backupInfo(root)
  const recentLog = db.prepare('SELECT ts, actor_type, actor_name, tool, action, card_path, outcome FROM write_log ORDER BY ts DESC, id DESC LIMIT 10').all()
    .map((l) => ({ ts: l.ts, actorType: l.actor_type, actorName: l.actor_name, tool: l.tool, action: l.action, cardPath: l.card_path, outcome: l.outcome }))

  const alerts = [...extraAlerts]
  if (q.pending > 0) alerts.push({ level: 'info', type: 'pending-backlog', count: q.pending, message: `有 ${q.pending} 张待审卡；批准前它们不会被 memory_recall 搜到` })
  if (!b.last) alerts.push({ level: 'warn', type: 'no-backup', message: '还没有任何备份文件（服务运行满 30 秒后会自动做首次备份）' })
  else if (Date.now() - Date.parse(b.last.at) > 36 * 3600e3) alerts.push({ level: 'warn', type: 'stale-backup', message: `最近一次备份是 ${b.last.at}，已超过 36 小时` })
  if (config && !config.llm) alerts.push({ level: 'info', type: 'llm-not-configured', message: '蒸馏模型未配置：memory_capture 将降级为原文卡（kind=content, tags=raw）' })

  return {
    cards: { total: cardsRows.length, byKind, tags: tagSet.size, recent7d: created.filter((t) => t >= week).length },
    quarantine: q,
    daily: dailySeries(30, created),
    vault: { dbBytes: fileBytes(dbFile), walBytes: fileBytes(dbFile + '-wal'), backupCount: b.count, lastBackup: b.last },
    agents: [...agents.entries()].map(([name, cards]) => ({ name, cards })).sort((a, c) => c.cards - a.cards || (a.name < c.name ? -1 : 1)),
    recentLog,
    llm: { configured: !!config?.llm, model: config?.llm?.model || null },
    alerts,
  }
}

// ---------------------------------------------------------------------------
// 沉淀活跃度
// ---------------------------------------------------------------------------

export const DATA_NOTES = [
  'write_log 自 M1 起才有记录；此前（DSH 插件时代）的沉淀与召回没有调用日志，只能从卡片的 submitted_by 反推（见 legacy.byCardSubmitter），无法还原当时的 recall 次数。',
  'write_log 只记 action（create / append / merge / skip）与 outcome（ok / dup / denied / error），不记 skipped 的具体原因（太短 / 噪声 / 模型判定不值得保存），因此无法按原因统计 skipped。',
  'write_log 不存 recall 的返回内容，因此没有「召回命中数 / 空结果率」。',
  'stdio 模式的身份是客户端自报（MEMORY_HUB_AGENT），不是不可伪造的署名；只有 HTTP 令牌署名可信。',
  '审批时延取自 audit_log 的 pending→approved 流转；管理界面的批准操作在 M3 才有，目前只能统计 CLI/历史批准。',
]

export function activity(root, { days, silentDays }) {
  const db = getDb(root)
  const now = Date.now()
  const winStart = new Date(now - days * DAY).toISOString()
  const silentStart = new Date(now - silentDays * DAY).toISOString()
  const A = "actor_type = 'agent'"
  const per = new Map()
  const get = (name) => {
    if (!per.has(name)) per.set(name, { name, captures: 0, recalls: 0, others: 0, captureOutcomes: { ok: 0, dup: 0, denied: 0, error: 0 }, captureActions: {}, lastCaptureAt: null, lastRecallAt: null, lastCallAt: null, silentCaptures: 0, silentRecalls: 0 })
    return per.get(name)
  }
  for (const r of db.prepare(`SELECT actor_name, tool, MAX(ts) last FROM write_log WHERE ${A} GROUP BY actor_name, tool`).all()) {
    const a = get(r.actor_name)
    if (r.tool === 'memory_capture') a.lastCaptureAt = !a.lastCaptureAt || r.last > a.lastCaptureAt ? r.last : a.lastCaptureAt
    if (r.tool === 'memory_recall') a.lastRecallAt = !a.lastRecallAt || r.last > a.lastRecallAt ? r.last : a.lastRecallAt
    a.lastCallAt = !a.lastCallAt || r.last > a.lastCallAt ? r.last : a.lastCallAt
  }
  const daily = new Map()
  for (const r of db.prepare(`SELECT actor_name, tool, action, outcome, ts FROM write_log WHERE ${A} AND ts >= ?`).all(winStart)) {
    const a = get(r.actor_name)
    const day = r.ts.slice(0, 10)
    const d = daily.get(day) || { capture: 0, recall: 0 }
    if (r.tool === 'memory_capture') {
      a.captures++; d.capture++
      if (r.outcome in a.captureOutcomes) a.captureOutcomes[r.outcome]++
      a.captureActions[r.action] = (a.captureActions[r.action] || 0) + 1
      if (r.ts >= silentStart) a.silentCaptures++
    } else if (r.tool === 'memory_recall') {
      a.recalls++; d.recall++
      if (r.ts >= silentStart) a.silentRecalls++
    } else a.others++
    daily.set(day, d)
  }
  const tokens = new Map(db.prepare('SELECT name, created_at, expires_at, revoked_at FROM agent_tokens').all().map((t) => [t.name, t]))
  for (const [name, t] of tokens) if (!t.revoked_at) get(name)
  const agents = [...per.values()].map((a) => {
    const t = tokens.get(a.name)
    return {
      name: a.name, tokenKnown: !!t, tokenRevoked: !!t?.revoked_at, tokenExpired: !!t?.expires_at && tsMs(t.expires_at) <= now,
      captures: a.captures, recalls: a.recalls, others: a.others, captureOutcomes: a.captureOutcomes, captureActions: a.captureActions,
      lastCaptureAt: a.lastCaptureAt, lastRecallAt: a.lastRecallAt, lastCallAt: a.lastCallAt,
      captureRecallRatio: a.recalls ? Math.round((a.captures / a.recalls) * 100) / 100 : null,
      readOnlyAlert: a.silentRecalls > 0 && a.silentCaptures === 0,
    }
  }).sort((a, b) => (b.captures + b.recalls) - (a.captures + a.recalls) || (a.name < b.name ? -1 : 1))

  const alerts = []
  for (const a of agents) {
    if (a.readOnlyAlert) alerts.push({ level: 'warn', type: 'read-only', agent: a.name, message: `${a.name} 最近 ${silentDays} 天有召回但没有任何沉淀（只读不写）；请检查它是否加载了 instructions / 客户端片段、是否看得到 memory_capture` })
  }
  for (const [name, t] of tokens) {
    if (t.revoked_at || (t.expires_at && tsMs(t.expires_at) <= now)) continue
    const a = per.get(name)
    if (!a?.lastCallAt) alerts.push({ level: 'info', type: 'idle-token', token: name, neverUsed: true, message: `令牌 ${name} 还没有任何调用记录` })
    else if (a.lastCallAt < silentStart) alerts.push({ level: 'warn', type: 'idle-token', token: name, neverUsed: false, message: `令牌 ${name} 已超过 ${silentDays} 天没有调用（最近 ${a.lastCallAt}）` })
  }
  const pend = db.prepare("SELECT COUNT(*) n, MIN(created_at) oldest FROM quarantine WHERE status = 'pending'").get()
  if (pend.n > 0) alerts.push({ level: 'info', type: 'pending-backlog', count: pend.n, message: `待审积压 ${pend.n} 张；auditMode=all 时未批准的卡搜不到` })

  const series = []
  for (let i = days - 1; i >= 0; i--) { const d = utcDay(now - i * DAY); series.push({ date: d, capture: daily.get(d)?.capture || 0, recall: daily.get(d)?.recall || 0 }) }

  const lat = db.prepare("SELECT a.created_at AS decided, c.created_at AS created FROM audit_log a JOIN cards c ON c.path = a.card_path WHERE a.old_status = 'pending' AND a.new_status = 'approved'").all()
    .map((r) => (tsMs(r.decided) - tsMs(r.created)) / 3600e3).filter((h) => h >= 0)
  const legacyMap = new Map()
  for (const r of db.prepare("SELECT submitted_by FROM cards UNION ALL SELECT submitted_by FROM quarantine WHERE status <> 'deleted'").all()) {
    const n = r.submitted_by || UNSIGNED_LABEL
    legacyMap.set(n, (legacyMap.get(n) || 0) + 1)
  }
  return {
    windowDays: days, silentDays, generatedAt: new Date(now).toISOString(),
    totals: { captures: agents.reduce((s, a) => s + a.captures, 0), recalls: agents.reduce((s, a) => s + a.recalls, 0) },
    agents, alerts, daily: series,
    pendingBacklog: pend.n, oldestPendingAt: pend.oldest ? isoOrNull(pend.oldest) : null,
    avgApprovalHours: lat.length ? Math.round((lat.reduce((s, x) => s + x, 0) / lat.length) * 10) / 10 : null,
    legacy: { byCardSubmitter: [...legacyMap.entries()].map(([name, cards]) => ({ name, cards })).sort((a, b) => b.cards - a.cards || (a.name < b.name ? -1 : 1)) },
    dataNotes: DATA_NOTES,
  }
}
