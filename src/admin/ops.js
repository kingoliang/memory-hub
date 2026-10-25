// memory-hub · 管理界面写操作（M3）：编辑/回滚、软删/恢复/永久删、批量、待审、标签、整理 apply/回滚、令牌、口令。
//
// 约定：
//   - 全部以 path 为键；校验失败抛 HttpError（统一 JSON 由 handler 输出）；
//   - 每个写操作都写 write_log（actor_type=admin，actor_id=session:<会话哈希前 12 位>，可区分会话；不记口令/令牌/正文）；
//   - 多步写入放进同一个 BEGIN IMMEDIATE 事务（与 Agent 并发写同一库安全）；
//   - 批量操作：超过 config.adminMaxBatch 整批拒绝；多条必须 confirm=true；非法项跳过并逐条列出；
//   - 响应里不出现服务器绝对路径（备份/回滚文件只给文件名）。

import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../core/db.js'
import {
  KIND_ROOTS, findCardRow, pathTaken, inTransaction, softDeleteCardSync, restoreCardSync, setCardStatusSync, deleteCard, purgeCardSync,
} from '../core/vault.js'
import {
  tidyApply, tidyRollback, backupBeforeTidy, selfCheck, snapshotCounts, detectSecrets, ALL_TIDY_BATCHES,
} from '../core/tidy.js'
import { canonicalizeTags, loadTagTables, readConfigRaw, patchTagTable, tagKey, TAG_CANON_KEY, TAG_SYNONYMS_KEY } from '../core/tags.js'
import { writeLog } from '../core/writelog.js'
import { createToken, revokeToken, updateToken, parseScopes, TokenError } from '../auth/tokens.js'
import { verifyPasswordAsync, getAdminPasswordHash, setAdminPassword, validatePassword, AdminAuthError } from './auth.js'
import { HttpError } from './errors.js'
import { tsMs } from './queries.js'

const KINDS = Object.keys(KIND_ROOTS)
export const LIMITS = Object.freeze({ title: 200, body: 200_000, tagLen: 50, tagCount: 30, reason: 500, path: 500 })
const MARKER_RE = /\[已遮蔽:[^\]]*\]/

const bad = (msg, extra) => new HttpError(400, 'bad_request', msg, undefined, extra)
const notFound = (msg) => new HttpError(404, 'not_found', msg)
const conflict = (msg, extra) => new HttpError(409, 'conflict', msg, undefined, extra)
const iso = (s) => (s ? new Date(tsMs(s)).toISOString() : null)

/** actor: { sidHash, ip }。write_log 里只留会话哈希前 12 位，足以区分会话又无法用来冒用。 */
export const actorOf = (session, ip) => ({ id: `session:${String(session?.sidHash || '').slice(0, 12)}`, ip: ip || '' })

function audit(root, actor, log, e) {
  try {
    writeLog(root, { actorType: 'admin', actorId: actor.id, actorName: 'admin', ip: actor.ip, outcome: 'ok', ...e })
  } catch (err) { log.error('write_log 写入失败', { action: e.action, error: String(err?.message || err).slice(0, 200) }) }
}

// ---- 参数校验 ----
function reqPath(v, name = 'path') {
  if (typeof v !== 'string' || !v.trim()) throw bad(`缺少 ${name}`)
  if (v.length > LIMITS.path) throw bad(`${name} 过长`)
  return v
}
function reqTimestamp(v, name) {
  if (typeof v !== 'string' || !v || Number.isNaN(Date.parse(v))) throw bad(`${name} 必需（用卡片详情里的 updatedAt，做并发冲突检测）`)
  return v
}
function cleanTag(t, name = '标签') {
  if (typeof t !== 'string') throw bad(`${name}必须是字符串`)
  const v = t.trim()
  if (!v) throw bad(`${name}不能为空`)
  if ([...v].length > LIMITS.tagLen) throw bad(`${name}最长 ${LIMITS.tagLen} 个字符`)
  if (/[\u0000-\u001f\u007f]/.test(v)) throw bad(`${name}不能含控制字符`)
  return v
}
function reqConfirm(v) {
  if (v !== undefined && typeof v !== 'boolean') throw bad('confirm 必须是布尔值')
  return v === true
}
function uniquePaths(paths, max) {
  if (!Array.isArray(paths) || !paths.length) throw bad('paths 必须是非空数组')
  const seen = new Set()
  for (const p of paths) seen.add(reqPath(p, 'paths 里的路径'))
  const list = [...seen]
  if (list.length > max) throw new HttpError(400, 'batch_too_large', `单次批量最多 ${max} 张（当前 ${list.length} 张）；请分批执行`, undefined, { max, count: list.length })
  return list
}

// ===========================================================================
// 卡片：编辑 / 回滚
// ===========================================================================

function parseTagArray(raw) {
  try { const v = JSON.parse(raw || '[]'); if (Array.isArray(v)) return v.map((t) => String(t).trim()).filter(Boolean) } catch { /* 非法 JSON：当作无标签 */ }
  return []
}

function applyEdit(root, actor, log, p, expectedUpdatedAt, fields, action) {
  const db = getDb(root)
  const out = inTransaction(db, () => {
    const found = findCardRow(db, p)
    if (!found) throw notFound('卡片不存在')
    const row = found.row
    const cur = iso(row.updated_at)
    if (tsMs(row.updated_at) !== tsMs(expectedUpdatedAt)) {
      throw conflict('卡片在你打开之后被修改过（可能是 Agent 追加了内容或另一个管理会话保存了），请刷新后重新编辑', { currentUpdatedAt: cur })
    }
    const next = {
      title: fields.title !== undefined ? fields.title : row.title,
      body: fields.body !== undefined ? fields.body : row.body,
      tags: fields.tags !== undefined ? fields.tags : parseTagArray(row.tags),
      kind: fields.kind !== undefined ? fields.kind : row.kind,
    }
    const changed = []
    if (next.title !== row.title) changed.push('title')
    if (next.body !== row.body) changed.push('body')
    if (JSON.stringify(next.tags) !== JSON.stringify(parseTagArray(row.tags))) changed.push('tags')
    if (next.kind !== row.kind) changed.push('kind')
    if (!changed.length) return { path: p, changed, updatedAt: cur }
    if (changed.includes('body') && MARKER_RE.test(next.body) && !MARKER_RE.test(row.body)) {
      throw bad('正文里含有界面的"已遮蔽"标记：这张卡含疑似明文密钥，界面显示的是遮蔽后的文本，直接保存会把标记写进正文。请先删掉标记再保存（或用回滚/CLI 处理）。')
    }
    const now = new Date().toISOString()
    // 旧版本进修订表（回滚本身也是一次编辑，所以也会留下被回滚前的版本）
    db.prepare('INSERT INTO card_revisions (card_path, title, body, tags, kind, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p, row.title, row.body, JSON.stringify(parseTagArray(row.tags)), row.kind, `admin:${actor.id}`, now)
    let newPath = p
    if (changed.includes('kind')) {
      const base = p.split('/').pop().replace(/\.md$/i, '')
      newPath = `${KIND_ROOTS[next.kind]}/${base}.md`
      for (let i = 2; pathTaken(db, newPath); i++) newPath = `${KIND_ROOTS[next.kind]}/${base}-${i}.md`
    }
    db.prepare(`UPDATE ${found.table} SET path = ?, title = ?, body = ?, summary = ?, tags = ?, kind = ?, updated_at = ? WHERE path = ?`)
      .run(newPath, next.title, next.body, next.body.trim().slice(0, 200), JSON.stringify(next.tags), next.kind, now, p)
    if (newPath !== p) {
      db.prepare('UPDATE card_revisions SET card_path = ? WHERE card_path = ?').run(newPath, p)
      db.prepare('UPDATE feedback SET card_path = ? WHERE card_path = ?').run(newPath, p)
      db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)')
        .run(newPath, row.status, row.status, 'admin', `kind ${row.kind} → ${next.kind}，路径 ${p} → ${newPath}`)
    }
    return { path: newPath, changed, updatedAt: now, secretTypes: changed.includes('body') ? detectSecrets(next.title + '\n' + next.body) : [] }
  })
  if (out.changed.length) {
    audit(root, actor, log, { tool: 'PATCH /card', action, cardPath: out.path, args: { changed: out.changed } })
    log.info(action === 'rollback' ? '管理员回滚卡片到旧版本' : '管理员编辑卡片', { path: out.path, changed: out.changed, actor: actor.id })
  }
  return { ok: true, ...out }
}

export function editCard(root, actor, input, { log }) {
  const p = reqPath(input?.path)
  const expected = reqTimestamp(input?.expectedUpdatedAt, 'expectedUpdatedAt')
  const f = {}
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) throw bad('标题不能为空')
    if ([...input.title.trim()].length > LIMITS.title) throw bad(`标题最长 ${LIMITS.title} 个字符`)
    f.title = input.title.trim()
  }
  if (input.body !== undefined) {
    if (typeof input.body !== 'string' || !input.body.trim()) throw bad('正文不能为空')
    if (input.body.length > LIMITS.body) throw bad(`正文最长 ${LIMITS.body} 个字符`)
    f.body = input.body.trim()
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) throw bad('tags 必须是字符串数组')
    const tags = [...new Set(input.tags.map((t) => cleanTag(t)))]
    if (tags.length > LIMITS.tagCount) throw bad(`标签最多 ${LIMITS.tagCount} 个`)
    // GH #5：按 tagKey 归到规范写法（要改规范写法本身请用「标签 → 重命名」，它会同步更新规范表）
    f.tags = canonicalizeTags(getDb(root), tags, { maxLen: LIMITS.tagLen }).tags
  }
  if (input.kind !== undefined) {
    if (!KINDS.includes(input.kind)) throw bad(`kind 只能是：${KINDS.join(' / ')}`)
    f.kind = input.kind
  }
  if (!Object.keys(f).length) throw bad('没有要修改的字段（title / body / tags / kind）')
  return applyEdit(root, actor, log, p, expected, f, 'edit')
}

export function rollbackCard(root, actor, input, { log }) {
  const p = reqPath(input?.path)
  const expected = reqTimestamp(input?.expectedUpdatedAt, 'expectedUpdatedAt')
  const id = Number(input?.revisionId)
  if (!Number.isInteger(id) || id < 1) throw bad('revisionId 必须是正整数')
  const rev = getDb(root).prepare('SELECT * FROM card_revisions WHERE id = ? AND card_path = ?').get(id, p)
  if (!rev) throw notFound('该卡片没有这个修订版本')
  return applyEdit(root, actor, log, p, expected, {
    title: rev.title, body: rev.body, tags: parseTagArray(rev.tags), ...(KINDS.includes(rev.kind) ? { kind: rev.kind } : {}),
  }, 'rollback')
}

// ===========================================================================
// 软删 / 恢复 / 永久删 / 批量
// ===========================================================================

export function softDelete(root, actor, p, { log }) {
  reqPath(p)
  const db = getDb(root)
  inTransaction(db, () => {
    const found = findCardRow(db, p)
    if (!found) throw notFound('卡片不存在')
    if (found.row.status === 'deleted') throw conflict('这张卡已经在回收站里')
    softDeleteCardSync(db, p, { changedBy: 'admin', reason: '管理员软删进回收站' })
  })
  audit(root, actor, log, { tool: 'DELETE /card', action: 'delete', cardPath: p })
  log.info('管理员软删卡片', { path: p, actor: actor.id })
  return { ok: true, path: p, daysKept: 30 }
}

export function restore(root, actor, input, { log }) {
  const p = reqPath(input?.path)
  const db = getDb(root)
  inTransaction(db, () => {
    const found = findCardRow(db, p)
    if (!found) throw notFound('卡片不存在')
    if (found.table !== 'quarantine' || found.row.status !== 'deleted') throw conflict('这张卡不在回收站里，无需恢复')
    restoreCardSync(db, p, { changedBy: 'admin', reason: '管理员从回收站恢复' })
  })
  audit(root, actor, log, { tool: 'POST /card/restore', action: 'restore', cardPath: p })
  log.info('管理员恢复卡片', { path: p, actor: actor.id })
  return { ok: true, path: p }
}

export async function purge(root, actor, input, { log }) {
  const p = reqPath(input?.path)
  const db = getDb(root)
  const found = findCardRow(db, p)
  if (!found) throw notFound('卡片不存在')
  if (found.table !== 'quarantine' || found.row.status !== 'deleted') throw conflict('只能永久删除回收站里的卡片：请先软删')
  if (typeof input?.confirmTitle !== 'string' || input.confirmTitle !== found.row.title) throw bad('确认失败：请原样输入这张卡的标题以确认永久删除')
  await deleteCard(root, p, { permanent: true })
  db.prepare('DELETE FROM card_revisions WHERE card_path = ?').run(p)
  audit(root, actor, log, { tool: 'POST /card/purge', action: 'purge', cardPath: p })
  log.warn('管理员永久删除卡片', { path: p, actor: actor.id })
  return { ok: true, path: p }
}

/**
 * 回收站「立即删除」（跳过 30 天保留期）：{paths[], confirm:true} 或 {all:true, confirm:true}。
 * 只删回收站里的卡；其余（非回收站 / 不存在）逐条 skipped。物理删除复用 purgeCardSync（同 /card/purge），整批单事务。
 * all 由服务端取回收站全部卡，不受 adminMaxBatch 限制（paths 形式受限）。
 */
export function purgeCards(root, actor, input, { config, log }) {
  const hasPaths = input?.paths !== undefined
  const all = input?.all
  if (all !== undefined && all !== true) throw bad('all 只能是 true（清空回收站）')
  if (all === true && hasPaths) throw bad('paths 与 all 不能同时给')
  if (all !== true && !hasPaths) throw bad('需要 paths（要永久删除的卡）或 all:true（清空回收站）')
  let paths = input.paths
  if (all === true) {
    paths = getDb(root).prepare("SELECT path FROM quarantine WHERE status = 'deleted' ORDER BY id").all().map((r) => r.path)
    if (!paths.length) {
      if (!reqConfirm(input.confirm)) throw new HttpError(400, 'confirm_required', '清空回收站需要 confirm=true', undefined, { count: 0, willAffect: 0 })
      return { ok: true, affected: 0, skipped: [], paths: [] }
    }
  }
  return runBatch(root, actor, log, {
    tool: 'POST /cards/purge', action: 'purge', paths, confirm: reqConfirm(input.confirm), dryRun: input.dryRun, maxBatch: all === true ? Infinity : config.adminMaxBatch, needConfirm: true,
    labelOf: all === true ? '清空回收站（永久删除）' : '永久删除回收站卡片',
    classify: (f) => {
      if (!f) return { code: 'not_found', message: '卡片不存在' }
      if (!(f.table === 'quarantine' && f.row.status === 'deleted')) return { code: 'not_in_recycle', message: '不在回收站，未删除' }
      return null
    },
    exec: (db, p) => { purgeCardSync(db, p); db.prepare('DELETE FROM card_revisions WHERE card_path = ?').run(p) },
  })
}

/** 批量执行的公共骨架：校验 → 分类（可做/跳过）→ dryRun / confirm → 单事务执行。 */
function runBatch(root, actor, log, { tool, action, paths, confirm, dryRun, maxBatch, needConfirm, classify, exec, labelOf }) {
  const list = uniquePaths(paths, maxBatch)
  const db = getDb(root)
  const todo = []
  const skipped = []
  for (const p of list) {
    const found = findCardRow(db, p)
    const why = classify(found)
    if (why) skipped.push({ path: p, reason: why.code, message: why.message }); else todo.push({ path: p, title: found.row.title })
  }
  if (dryRun === true) return { ok: true, dryRun: true, count: list.length, willAffect: todo.length, items: todo, skipped }
  if (needConfirm && !confirm) {
    throw new HttpError(400, 'confirm_required', `这是批量操作，将影响 ${todo.length} 张卡片：请确认后带 confirm=true 重新提交`, undefined, { count: list.length, willAffect: todo.length })
  }
  if (!todo.length) {
    const allMissing = skipped.every((s) => s.reason === 'not_found')
    throw new HttpError(allMissing ? 404 : 409, allMissing ? 'not_found' : 'conflict', skipped.length === 1 ? skipped[0].message : '所选卡片都不满足操作条件', undefined, { skipped })
  }
  inTransaction(db, () => { for (const t of todo) exec(db, t.path) })
  for (const t of todo) audit(root, actor, log, { tool, action, cardPath: t.path, args: { batch: todo.length } })
  log.info(`管理员${labelOf}`, { affected: todo.length, skipped: skipped.length, actor: actor.id })
  return { ok: true, affected: todo.length, skipped, paths: todo.map((t) => t.path) }
}

export function batchCards(root, actor, input, { config, log }) {
  const action = input?.action
  if (!['delete', 'restore'].includes(action)) throw bad('action 只能是 delete 或 restore')
  const del = action === 'delete'
  return runBatch(root, actor, log, {
    tool: 'POST /cards/batch', action, paths: input.paths, confirm: reqConfirm(input.confirm), dryRun: input.dryRun, maxBatch: config.adminMaxBatch, needConfirm: true,
    labelOf: del ? '批量软删卡片' : '批量恢复卡片',
    classify: (f) => {
      if (!f) return { code: 'not_found', message: '卡片不存在' }
      if (del && f.row.status === 'deleted') return { code: 'already_deleted', message: '已在回收站' }
      if (!del && !(f.table === 'quarantine' && f.row.status === 'deleted')) return { code: 'not_in_recycle', message: '不在回收站' }
      return null
    },
    exec: (db, p) => (del
      ? softDeleteCardSync(db, p, { changedBy: 'admin', reason: '管理员批量软删' })
      : restoreCardSync(db, p, { changedBy: 'admin', reason: '管理员批量恢复' })),
  })
}

// ===========================================================================
// 待审队列
// ===========================================================================

export function moderate(root, actor, op, input, { config, log }) {
  const approve = op === 'approve'
  let reason = ''
  if (input?.reason !== undefined) {
    if (typeof input.reason !== 'string') throw bad('reason 必须是字符串')
    if ([...input.reason].length > LIMITS.reason) throw bad(`理由最长 ${LIMITS.reason} 个字符`)
    reason = input.reason.trim()
  }
  const paths = Array.isArray(input?.paths) ? input.paths : null
  const multi = paths && new Set(paths).size > 1
  return runBatch(root, actor, log, {
    tool: `POST /queue/${op}`, action: op, paths: input?.paths, confirm: reqConfirm(input?.confirm), dryRun: input?.dryRun, maxBatch: config.adminMaxBatch, needConfirm: !!multi,
    labelOf: approve ? '批准待审卡片' : '驳回待审卡片',
    classify: (f) => {
      if (!f) return { code: 'not_found', message: '卡片不存在' }
      const st = f.table === 'quarantine' ? f.row.status : 'approved'
      if (approve && !['pending', 'rejected'].includes(st)) return { code: 'not_in_queue', message: st === 'approved' ? '已经是已批准状态' : '不在待审队列里' }
      if (!approve && st !== 'pending') return { code: st === 'rejected' ? 'already_rejected' : 'not_in_queue', message: st === 'rejected' ? '已经是已驳回状态' : '不在待审队列里' }
      return null
    },
    exec: (db, p) => {
      setCardStatusSync(db, p, approve ? 'approved' : 'rejected', { changedBy: 'admin', reason: reason || (approve ? '管理员批准' : '管理员驳回') })
      if (!approve && reason) db.prepare('UPDATE quarantine SET reason = ?, quarantine_reason = ? WHERE path = ?').run(reason, reason, p)
    },
  })
}

// ===========================================================================
// 标签：预览 / 重命名 / 合并 / 删除（备份 + 自检 + 回滚文件）
// ===========================================================================

function tagOpSpec(op, input) {
  if (op === 'rename') {
    const from = cleanTag(input?.from, '原标签'); const to = cleanTag(input?.to, '新标签')
    if (from === to) throw bad('新旧标签相同')
    return { op, from: [from], to }
  }
  if (op === 'merge') {
    if (!Array.isArray(input?.from) || !input.from.length) throw bad('from 必须是非空的标签数组')
    const from = [...new Set(input.from.map((t) => cleanTag(t, '源标签')))]
    const to = cleanTag(input?.to, '目标标签')
    const srcs = from.filter((t) => t !== to)
    if (!srcs.length) throw bad('没有需要合并的源标签（源标签都等于目标标签）')
    return { op, from: srcs, to }
  }
  if (op === 'delete') {
    const t = input?.tag ?? (Array.isArray(input?.from) ? input.from[0] : input?.from)
    return { op, from: [cleanTag(t, '标签')], to: null }
  }
  throw bad('op 只能是 rename / merge / delete')
}

function transformTags(tags, spec) {
  const src = new Set(spec.from)
  const out = []
  for (const t of tags) {
    if (!src.has(t)) { if (!out.includes(t)) out.push(t); continue }
    if (spec.op === 'delete') continue
    if (!out.includes(spec.to)) out.push(spec.to)
  }
  return out
}

/** 受影响的卡（两张表都算：待审/回收站里的卡也带标签）。tags 非法 JSON 的行不碰。 */
function tagImpact(db, spec) {
  const rows = []
  for (const table of ['cards', 'quarantine']) {
    for (const r of db.prepare(`SELECT path, title, tags FROM ${table}`).all()) {
      let tags
      try { tags = JSON.parse(r.tags || '[]') } catch { continue }
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) continue
      const next = transformTags(tags, spec)
      if (JSON.stringify(next) !== JSON.stringify(tags)) rows.push({ table, path: r.path, title: r.title, before: r.tags, next })
    }
  }
  return rows
}

export function previewTagOp(root, query) {
  const spec = tagOpSpec(query.op, { from: query.op === 'merge' ? String(query.from || '').split(',') : query.from, tag: query.from, to: query.to })
  const rows = tagImpact(getDb(root), spec)
  const present = new Set()
  for (const r of rows) for (const t of JSON.parse(r.before)) if (spec.from.includes(t)) present.add(t)
  return {
    op: spec.op, from: spec.from, to: spec.to,
    affectedCards: rows.length, fromPresent: present.size, merging: present.size,
    byStore: { cards: rows.filter((r) => r.table === 'cards').length, quarantine: rows.filter((r) => r.table === 'quarantine').length },
    samples: rows.slice(0, 20).map((r) => ({ path: r.path, title: r.title, store: r.table })),
  }
}

const stampName = () => new Date().toISOString().replace(/[:.]/g, '-')
const backupInfoOf = (b) => ({ file: path.basename(b.path), bytes: b.bytes, cards: b.cards, quarantine: b.quarantine, verified: b.verified })

/**
 * rename / merge 后同步规范表与同义表（管理员的选择就是新的规范写法，此后 tidy / 写入都按它来）：
 *   - canon[key(to)] = to；
 *   - 每个跨键的源标签：synonyms[key(from)] = to，并删掉 canon[key(from)]；
 *   - 原本指向某个源标签的同义项改指向 to。
 * 改动前的原始值记进回滚文件（rollback.config），回滚时整体还原。
 */
function updateTagTables(db, spec, rollback) {
  const before = { [TAG_CANON_KEY]: readConfigRaw(db, TAG_CANON_KEY), [TAG_SYNONYMS_KEY]: readConfigRaw(db, TAG_SYNONYMS_KEY) }
  const { synonyms } = loadTagTables(db)
  const toKey = tagKey(spec.to)
  const canonPatch = { [toKey]: spec.to }
  const synPatch = {}
  const fromKeys = new Set(spec.from.map(tagKey).filter((k) => k && k !== toKey))
  for (const k of fromKeys) { synPatch[k] = spec.to; canonPatch[k] = null }
  for (const [k, v] of Object.entries(synonyms)) if (fromKeys.has(tagKey(v)) || (tagKey(v) === toKey && v !== spec.to)) synPatch[k] = spec.to
  if (synonyms[toKey]) synPatch[toKey] = null // 目标自身不能再被同义到别处
  const c1 = patchTagTable(db, TAG_CANON_KEY, canonPatch)
  const c2 = patchTagTable(db, TAG_SYNONYMS_KEY, synPatch)
  if (c1) rollback.config.push({ key: TAG_CANON_KEY, before: before[TAG_CANON_KEY] })
  if (c2) rollback.config.push({ key: TAG_SYNONYMS_KEY, before: before[TAG_SYNONYMS_KEY] })
}

export function applyTagOp(root, actor, op, input, { log }) {
  const spec = tagOpSpec(op, input)
  const confirm = reqConfirm(input?.confirm)
  const db = getDb(root)
  const rows = tagImpact(db, spec)
  const action = `tag_${op}`
  if (!confirm) throw new HttpError(400, 'confirm_required', `将影响 ${rows.length} 张卡片的标签：请确认后带 confirm=true 提交`, undefined, { affectedCards: rows.length, op })
  if (input.expectedAffected !== undefined && input.expectedAffected !== rows.length) {
    throw conflict(`预览时影响 ${input.expectedAffected} 张，现在是 ${rows.length} 张：库在预览之后变化，请重新预览`, { affectedCards: rows.length })
  }
  if (!rows.length) return { ok: true, noop: true, affectedCards: 0, op }

  let backup
  try { backup = backupBeforeTidy(root, (lvl, m) => log[lvl === 'ERROR' ? 'error' : 'info']('标签操作备份 ' + m), { prefix: 'pre-tags' }) } catch (e) {
    audit(root, actor, log, { tool: `POST /tags/${op}`, action, outcome: 'error', args: spec })
    log.error('标签操作备份失败，未改动数据', { error: String(e?.message || e).slice(0, 200) })
    throw new HttpError(500, 'backup_failed', `备份失败，未改动任何数据：${e.message}`)
  }
  const before = snapshotCounts(db)
  const rollback = { version: 1, tool: 'memory-eternal-tidy', kind: 'tags', op, createdAt: new Date().toISOString(), backup: path.basename(backup.path), removed: [], merged: [], tags: [] }
  rollback.config = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const r of rows) {
      db.prepare(`UPDATE ${r.table} SET tags = ? WHERE path = ?`).run(JSON.stringify(r.next), r.path)
      rollback.tags.push({ path: r.path, before: r.before })
    }
    if (spec.to) updateTagTables(db, spec, rollback)
    const check = selfCheck(db, root, before, 0)
    const failures = [...check.failures]
    const badQ = db.prepare('SELECT tags FROM quarantine').all().filter((q) => { try { const v = JSON.parse(q.tags); return !Array.isArray(v) || v.some((t) => typeof t !== 'string') } catch { return true } }).length
    if (badQ) failures.push(`隔离区里 tags 非法的卡：${badQ} 张`)
    const after = snapshotCounts(db)
    if (JSON.stringify(after) !== JSON.stringify(before)) failures.push('卡片总数在标签操作前后不一致')
    if (failures.length) throw new Error('自检失败：' + failures.join('；'))
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    audit(root, actor, log, { tool: `POST /tags/${op}`, action, outcome: 'error', args: spec })
    log.error('标签操作自检失败，已整批回滚', { op, error: String(e?.message || e).slice(0, 300) })
    throw new HttpError(500, 'self_check_failed', `${e.message}（已整批回滚，数据未改动；备份 ${path.basename(backup.path)}）`)
  }
  const rollbackFile = `tags-${stampName()}.rollback.json`
  fs.writeFileSync(path.join(path.resolve(root), 'backups', rollbackFile), JSON.stringify(rollback, null, 1), { mode: 0o600 })
  audit(root, actor, log, { tool: `POST /tags/${op}`, action, args: spec })
  log.info('管理员标签操作完成', { op, affectedCards: rows.length, from: spec.from.length, actor: actor.id })
  return { ok: true, op, from: spec.from, to: spec.to, affectedCards: rows.length, backup: backupInfoOf(backup), rollbackFile }
}

// ===========================================================================
// 整理：apply / 回滚入口
// ===========================================================================

let tidyBusy = false
const ROLLBACK_NAME_RE = /^(?:tidy|tags)-[A-Za-z0-9._-]{1,150}\.rollback\.json$/

export async function tidyApplyAdmin(root, actor, input, { log }) {
  const confirm = reqConfirm(input?.confirm)
  let batches
  if (input?.batches !== undefined) {
    if (!Array.isArray(input.batches) || !input.batches.length || input.batches.some((b) => !ALL_TIDY_BATCHES.includes(b))) throw bad(`batches 只能包含：${ALL_TIDY_BATCHES.join(' / ')}`)
    batches = input.batches
  }
  let maxDelete
  if (input?.maxDelete !== undefined) {
    if (!Number.isInteger(input.maxDelete) || input.maxDelete < 0 || input.maxDelete > 5000) throw bad('maxDelete 必须是 0~5000 的整数')
    maxDelete = input.maxDelete
  }
  let threshold
  if (input?.threshold !== undefined) {
    if (typeof input.threshold !== 'number' || !(input.threshold >= 0.05 && input.threshold <= 1)) throw bad('threshold 必须在 0.05 ~ 1 之间')
    threshold = input.threshold
  }
  let planId
  if (input?.planId !== undefined) {
    if (typeof input.planId !== 'string' || input.planId.length > 64) throw bad('planId 不合法')
    planId = input.planId
  }
  if (confirm && !planId) throw new HttpError(400, 'plan_id_required', '执行整理必须带 planId：先在"整理预览"生成计划，再用它的 planId 执行', undefined, {})
  if (tidyBusy) throw conflict('另一个整理操作正在进行，请稍后再试')
  tidyBusy = true
  try {
    const res = await tidyApply(root, { confirm, planId, batches, maxDelete, threshold, logger: (lvl, m) => log[String(lvl).toLowerCase() === 'error' ? 'error' : String(lvl).toLowerCase() === 'warn' ? 'warn' : 'info']('整理 ' + m) })
    const tool = 'POST /tidy/apply'
    const summary = res.plan ? {
      noise: res.plan.noise.length, duplicateGroups: res.plan.duplicates.length,
      duplicateAbsorbable: res.plan.duplicates.reduce((n, g) => n + g.absorbs.length, 0), tagChanges: res.plan.tags.changes.length,
      topicGroups: res.plan.topics.length, snapshotSeries: res.plan.snapshots.length,
    } : undefined
    const view = {
      ok: res.ok, dryRun: res.dryRun, planId: res.planId, plannedDeletes: res.plannedDeletes, summary,
      batches: res.batches, ...(res.backup ? { backup: backupInfoOf(res.backup) } : {}),
      ...(res.rollbackFile ? { rollbackFile: path.basename(res.rollbackFile) } : {}), ...(res.after ? { after: res.after } : {}),
    }
    if (res.ok === false && !res.batches) {
      audit(root, actor, log, { tool, action: confirm ? 'tidy_apply' : 'tidy_dry_run', outcome: 'error', args: { planId, batches } })
      const status = { plan_stale: 409, max_delete_exceeded: 400, unknown_batch: 400 }[res.code] || 500
      throw new HttpError(status, res.code || 'tidy_failed', res.error || '整理失败', undefined, { planId: res.planId, plannedDeletes: res.plannedDeletes })
    }
    if (!confirm) {
      audit(root, actor, log, { tool, action: 'tidy_dry_run', args: { planId, batches } })
      return view
    }
    audit(root, actor, log, { tool, action: 'tidy_apply', outcome: res.ok ? 'ok' : 'error', args: { planId, batches, maxDelete } })
    if (!res.ok) {
      const selfCheckFail = res.batches.some((b) => /自检失败/.test(b.error || ''))
      log.error('管理员整理未完成，失败批次已自动回滚', { actor: actor.id })
      throw new HttpError(500, selfCheckFail ? 'self_check_failed' : 'batch_failed', selfCheckFail ? '批后自检失败：该批已自动回滚，库未被改动（详见各批次结果）' : '有批次失败，已自动回滚该批', undefined, view)
    }
    log.info('管理员整理完成', { planId: res.planId, actor: actor.id, after: res.after })
    return view
  } finally { tidyBusy = false }
}

export function listRollbacks(root) {
  const dir = path.join(path.resolve(root), 'backups')
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => ROLLBACK_NAME_RE.test(f)) } catch { /* 目录尚不存在 */ }
  const items = files.map((f) => {
    const st = fs.statSync(path.join(dir, f))
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { /* 损坏的文件照列出 */ }
    return {
      file: f, createdAt: meta.createdAt || st.mtime.toISOString(), kind: meta.kind || 'tidy', op: meta.op || null,
      removed: meta.removed?.length || 0, merged: meta.merged?.length || 0, tagsChanged: meta.tags?.length || 0, ms: st.mtimeMs,
    }
  }).sort((a, b) => b.ms - a.ms).slice(0, 50)
  return { items: items.map(({ ms, ...r }) => r) }
}

export async function rollbackAdmin(root, actor, input, { log }) {
  const name = input?.rollbackFile
  if (typeof name !== 'string' || !ROLLBACK_NAME_RE.test(name) || name.includes('..')) throw bad('rollbackFile 必须是回滚文件名（tidy-*.rollback.json 或 tags-*.rollback.json），不接受路径')
  if (!reqConfirm(input?.confirm)) throw new HttpError(400, 'confirm_required', '回滚会把对应整理/标签操作改动过的卡恢复到操作前：请确认后带 confirm=true 提交', undefined, { rollbackFile: name })
  const file = path.join(path.resolve(root), 'backups', name)
  if (!fs.existsSync(file)) throw notFound('回滚文件不存在（可能已使用过或已被清理）')
  if (tidyBusy) throw conflict('另一个整理操作正在进行，请稍后再试')
  tidyBusy = true
  try {
    let backup
    try { backup = backupBeforeTidy(root, () => {}, { prefix: 'pre-rollback' }) } catch (e) {
      throw new HttpError(500, 'backup_failed', `回滚前备份失败，未改动任何数据：${e.message}`)
    }
    const res = await tidyRollback(root, file, { logger: (lvl, m) => log[String(lvl).toLowerCase() === 'error' ? 'error' : 'info']('整理回滚 ' + m) })
    audit(root, actor, log, { tool: 'POST /tidy/rollback', action: 'tidy_rollback', outcome: res.ok ? 'ok' : 'error', args: { rollbackFile: name } })
    if (!res.ok) throw new HttpError(/不是有效/.test(res.error || '') ? 400 : 500, /不是有效/.test(res.error || '') ? 'bad_request' : 'rollback_failed', res.error || '回滚失败')
    fs.renameSync(file, file + '.done') // 回滚文件只能用一次：再用会用旧数据覆盖之后的新编辑
    log.info('管理员执行整理回滚', { file: name, restored: res.restored, reverted: res.reverted, actor: actor.id })
    return { ok: true, restored: res.restored, reverted: res.reverted, backup: backupInfoOf(backup) }
  } finally { tidyBusy = false }
}

// ===========================================================================
// 令牌
// ===========================================================================

const tokenErr = (e) => {
  if (!(e instanceof TokenError)) return e
  const status = { conflict: 409, not_found: 404 }[e.kind] || 400
  return new HttpError(status, status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'bad_request', e.message)
}

export function createTokenAdmin(root, actor, input, { log }) {
  if (typeof input?.name !== 'string') throw bad('需要令牌名 name')
  if (!Array.isArray(input.scopes)) throw bad('scopes 必须是数组（read / write / tidy:apply）')
  let expiresAt = null
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const t = typeof input.expiresAt === 'string' ? Date.parse(input.expiresAt) : NaN
    if (Number.isNaN(t)) throw bad('expiresAt 不是合法时间')
    if (t <= Date.now()) throw bad('expiresAt 必须是将来的时间')
    expiresAt = new Date(t).toISOString()
  }
  let made
  try {
    parseScopes(input.scopes)
    made = createToken(root, { name: input.name, scopes: input.scopes, expiresAt })
  } catch (e) { throw tokenErr(e) }
  audit(root, actor, log, { tool: 'POST /tokens', action: 'token_create', args: { name: made.name, scopes: made.scopes, expiresAt } })
  log.info('管理员创建令牌', { name: made.name, scopes: made.scopes, expiresAt, actor: actor.id })
  return { ok: true, tokenId: made.tokenId, name: made.name, scopes: made.scopes, expiresAt: made.expiresAt, token: made.token, notice: '明文令牌仅显示一次：关闭此窗口后无法再次查看。请立即复制并妥善保存。' }
}

export function revokeTokenAdmin(root, actor, tokenId, { log }) {
  if (typeof tokenId !== 'string' || !tokenId) throw bad('缺少 tokenId')
  let r
  try {
    const row = getDb(root).prepare('SELECT token_id FROM agent_tokens WHERE token_id = ?').get(tokenId)
    if (!row) throw new TokenError(`令牌不存在：${tokenId}`, 'not_found')
    r = revokeToken(root, tokenId)
  } catch (e) { throw tokenErr(e) }
  audit(root, actor, log, { tool: 'DELETE /tokens', action: 'token_revoke', args: { name: r.name } })
  log.warn('管理员撤销令牌', { name: r.name, actor: actor.id })
  return { ok: true, tokenId: r.tokenId, name: r.name }
}

export function updateTokenAdmin(root, actor, input, { log }) {
  if (typeof input?.tokenId !== 'string' || !input.tokenId) throw bad('缺少 tokenId')
  if (input.name === undefined && input.expiresAt === undefined) throw bad('没有要修改的字段（name / expiresAt）')
  if (input.name !== undefined && typeof input.name !== 'string') throw bad('name 必须是字符串')
  if (input.expiresAt !== undefined && input.expiresAt !== null && typeof input.expiresAt !== 'string') throw bad('expiresAt 必须是时间字符串或 null')
  let r
  try { r = updateToken(root, input.tokenId, { name: input.name, expiresAt: input.expiresAt }) } catch (e) { throw tokenErr(e) }
  if (r.changed.length) {
    audit(root, actor, log, { tool: 'PATCH /tokens', action: 'token_update', args: { changed: r.changed, name: r.name } })
    log.info('管理员修改令牌', { name: r.name, changed: r.changed, actor: actor.id })
  }
  return { ok: true, tokenId: r.tokenId, name: r.name, changed: r.changed }
}

// ===========================================================================
// 管理员口令
// ===========================================================================

export async function changePassword(root, actor, input, { limiter, log }) {
  if (typeof input?.oldPassword !== 'string' || !input.oldPassword) throw bad('需要旧口令 oldPassword')
  if (typeof input?.newPassword !== 'string' || !input.newPassword) throw bad('需要新口令 newPassword')
  const wait = limiter.retryAfter(actor.ip)
  if (wait > 0) {
    log.warn('管理员改口令：尝试过多，已限流', { ip: actor.ip, retryAfterSec: wait })
    throw new HttpError(429, 'too_many_attempts', `尝试次数过多，请 ${wait} 秒后再试`, { 'retry-after': String(wait) })
  }
  const ok = await verifyPasswordAsync(input.oldPassword, getAdminPasswordHash(root))
  if (!ok) {
    limiter.fail(actor.ip)
    log.warn('管理员改口令：旧口令不正确', { ip: actor.ip })
    audit(root, actor, log, { tool: 'POST /password', action: 'password_change', outcome: 'denied' })
    throw new HttpError(401, 'invalid_credentials', '旧口令不正确')
  }
  try { validatePassword(input.newPassword) } catch (e) { if (e instanceof AdminAuthError) throw bad(e.message); throw e }
  if (input.newPassword === input.oldPassword) throw bad('新口令不能与旧口令相同')
  setAdminPassword(root, input.newPassword) // 同时让所有会话（含当前）失效
  limiter.reset(actor.ip)
  audit(root, actor, log, { tool: 'POST /password', action: 'password_change' })
  log.warn('管理员口令已修改，所有会话已失效', { actor: actor.id })
  return { ok: true, message: '口令已修改，所有会话已失效，请用新口令重新登录' }
}
