// memory-hub · 迁移工具：对账（verify，PLAN 6.3.2）与反向增量（reverse，PLAN 6.3.1 回滚）。
//
// 全部使用"原始"SQLite 连接（不经 getDb）：getDb 会对打开的库做 schema 迁移，而这里的两端
// 一端可能是必须保持旧 schema 的旧库原件（反向导入的目标）。输出只含计数 / id / 检查结论，
// 绝不打印卡片标题或正文。

import * as sqlite from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const { DatabaseSync } = sqlite
const DB_FILE = 'memory-eternal.db'

export class MigrateError extends Error { constructor(m) { super(m); this.name = 'MigrateError' } }

/** 目录 → 目录下的 memory-eternal.db；文件 → 原样。 */
export function resolveDbFile(p) {
  const abs = path.resolve(String(p ?? ''))
  let st
  try { st = fs.statSync(abs) } catch { throw new MigrateError(`库不存在：${abs}`) }
  return st.isDirectory() ? path.join(abs, DB_FILE) : abs
}

function openDb(p, { readOnly }) {
  const file = resolveDbFile(p)
  if (!fs.existsSync(file)) throw new MigrateError(`库文件不存在：${file}`)
  const db = new DatabaseSync(file, { readOnly })
  db.exec('PRAGMA busy_timeout=5000')
  return { db, file }
}

const sha = (...parts) => crypto.createHash('sha256').update(parts.map((x) => String(x ?? '')).join('|')).digest('hex')
const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
const colsOf = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
const all = (db, sql, ...a) => db.prepare(sql).all(...a)

/** 读出一个库做对账所需的全部"摘要"（不含正文明文，指纹是哈希）。 */
function snapshot(db) {
  const rows = { cards: [], quarantine: [] }
  for (const t of ['cards', 'quarantine']) {
    if (!tableExists(db, t)) continue
    rows[t] = all(db, `SELECT id, path, kind, title, tags, body, status FROM ${t}`)
  }
  const fp = new Set()
  for (const t of ['cards', 'quarantine']) for (const r of rows[t]) fp.add(sha(r.path, r.kind, r.title, r.tags, r.body, r.status))
  const countBy = (t, col) => {
    const m = new Map()
    for (const r of rows[t]) m.set(r[col], (m.get(r[col]) || 0) + 1)
    return m
  }
  const pathOfId = new Map()
  for (const t of ['cards', 'quarantine']) for (const r of rows[t]) pathOfId.set(r.id, r.path)
  const key = (sql, f) => {
    const s = new Map()
    try { for (const r of all(db, sql)) { const k = sha(...f(r)); s.set(k, (s.get(k) || 0) + 1) } } catch { /* 表缺失按空 */ }
    return s
  }
  const seq = tableExists(db, 'card_sequence') ? db.prepare("SELECT seq FROM card_sequence WHERE name='card'").get()?.seq ?? 0 : 0
  const maxId = Math.max(0, ...rows.cards.map((r) => r.id), ...rows.quarantine.map((r) => r.id))
  return {
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    userVersion: db.prepare('PRAGMA user_version').get().user_version,
    rows,
    total: rows.cards.length + rows.quarantine.length,
    cardsByKind: countBy('cards', 'kind'),
    quarantineByKind: countBy('quarantine', 'kind'),
    quarantineByStatus: countBy('quarantine', 'status'),
    mainBadStatus: rows.cards.filter((r) => r.status !== 'approved').length,
    bothTables: rows.cards.filter((r) => rows.quarantine.some((q) => q.path === r.path)).length,
    fp, seq, maxId,
    updates: key('SELECT card_id, content, created_at FROM card_updates', (r) => ['u', pathOfId.get(r.card_id) ?? `orphan#${r.card_id}`, r.content, r.created_at]),
    feedback: key('SELECT query, card_path, useful, created_at FROM feedback', (r) => ['f', r.query, r.card_path, r.useful, r.created_at]),
    audit: key('SELECT card_path, old_status, new_status, changed_by, reason, created_at FROM audit_log', (r) => ['a', r.card_path, r.old_status, r.new_status, r.changed_by, r.reason, r.created_at]),
  }
}

const mapStr = (m) => [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([k, v]) => `${k}=${v}`).join(',') || '-'
const sumMap = (m) => [...m.values()].reduce((a, b) => a + b, 0)
const mapsEqual = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
const mapSubset = (a, b) => [...a].every(([k, v]) => (b.get(k) || 0) >= v)
const setDiff = (a, b) => [...a].filter((x) => !b.has(x)).length

/**
 * 对账：source（旧库/快照）→ target（新库）。
 * 严格模式（默认）：两边逐项相等；allowTargetExtra：允许目标"只多不少"（切换后新增的卡）。
 * @returns {{ok:boolean, checks:{name:string, ok:boolean, detail:string}[]}}
 */
export function verifyMigration({ source, target, allowTargetExtra = false }) {
  const S = openDb(source, { readOnly: true })
  const T = openDb(target, { readOnly: true })
  try {
    const s = snapshot(S.db), t = snapshot(T.db)
    const checks = []
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })
    const mode = allowTargetExtra ? '（允许目标多出）' : ''

    add('integrity', s.integrity === 'ok' && t.integrity === 'ok', `source=${s.integrity} target=${t.integrity}`)

    const cardsOk = allowTargetExtra ? t.rows.cards.length + t.rows.quarantine.length >= s.total : (t.rows.cards.length === s.rows.cards.length && mapsEqual(s.quarantineByStatus, t.quarantineByStatus))
    add('counts', cardsOk, `cards ${s.rows.cards.length}→${t.rows.cards.length}；quarantine ${mapStr(s.quarantineByStatus)} → ${mapStr(t.quarantineByStatus)}${mode}`)

    const kindsOk = allowTargetExtra ? mapSubset(s.cardsByKind, t.cardsByKind) && mapSubset(s.quarantineByKind, t.quarantineByKind) : mapsEqual(s.cardsByKind, t.cardsByKind) && mapsEqual(s.quarantineByKind, t.quarantineByKind)
    add('kinds', kindsOk, `cards ${mapStr(s.cardsByKind)} → ${mapStr(t.cardsByKind)}${mode}`)

    const missing = setDiff(s.fp, t.fp), extra = setDiff(t.fp, s.fp)
    add('fingerprints', missing === 0 && (allowTargetExtra || extra === 0), `指纹 sha256(path|kind|title|tags|body|status)：源 ${s.fp.size}，目标 ${t.fp.size}；源有目标无 ${missing}，目标多出 ${extra}${mode}`)

    add('sequence', t.seq >= s.seq && t.maxId <= t.seq, `seq ${s.seq}→${t.seq}；目标 MAX(id)=${t.maxId}`)
    add('invariant', t.mainBadStatus === 0 && t.bothTables === 0, `主库非 approved ${t.mainBadStatus}；path 同时在两张表 ${t.bothTables}`)

    const side = (name) => (allowTargetExtra ? mapSubset(s[name], t[name]) : mapsEqual(s[name], t[name]))
    add('sidetables', side('updates') && side('feedback') && side('audit'),
      `card_updates ${sumMap(s.updates)}→${sumMap(t.updates)}；feedback ${sumMap(s.feedback)}→${sumMap(t.feedback)}；audit_log ${sumMap(s.audit)}→${sumMap(t.audit)}${mode}`)

    return { ok: checks.every((c) => c.ok), source: S.file, target: T.file, checks }
  } finally { S.db.close(); T.db.close() }
}

export function formatChecks(r) {
  const lines = r.checks.map((c) => `${c.ok ? '[PASS]' : '[FAIL]'} ${c.name.padEnd(13)} ${c.detail}`)
  lines.push(`RESULT: ${r.ok ? 'PASS' : 'FAIL'}`)
  return lines.join('\n') + '\n'
}

// ───────────────────────── 反向增量 ─────────────────────────

const CARD_COLS_IGNORE = new Set(['id'])

function rowsByPath(db) {
  const m = new Map()
  for (const t of ['cards', 'quarantine']) {
    if (!tableExists(db, t)) continue
    for (const r of all(db, `SELECT * FROM ${t}`)) m.set(r.path, { table: t, row: r })
  }
  return m
}
const sameRow = (a, b, cols) => a.table === b.table && cols.every((c) => c === 'id' || (a.row[c] ?? null) === (b.row[c] ?? null))

function computePlan(fromDb, tgtDb) {
  const fromRows = rowsByPath(fromDb), tgtRows = rowsByPath(tgtDb)
  const cols = {
    cards: colsOf(tgtDb, 'cards').filter((c) => colsOf(fromDb, 'cards').includes(c)),
    quarantine: colsOf(tgtDb, 'quarantine').filter((c) => colsOf(fromDb, 'quarantine').includes(c)),
  }
  const adds = [], changes = []
  let unchanged = 0
  for (const [p, f] of fromRows) {
    const t = tgtRows.get(p)
    if (!t) adds.push(f)
    else if (sameRow(f, t, cols[f.table])) unchanged++
    else changes.push({ ...f, oldTable: t.table })
  }
  const missing = [...tgtRows.keys()].filter((p) => !fromRows.has(p))
  return { fromRows, tgtRows, cols, adds, changes, unchanged, missing }
}

/** 计划（不改任何库）。 */
export function planReverse({ from, target }) {
  const F = openDb(from, { readOnly: true }), T = openDb(target, { readOnly: true })
  try {
    if (F.file === T.file) throw new MigrateError('--from 与 --target 是同一个文件')
    const p = computePlan(F.db, T.db)
    const fs0 = snapshot(F.db), ts0 = snapshot(T.db)
    const newKeys = (a, b) => [...a.keys()].filter((k) => !b.has(k)).length
    return {
      add: p.adds.length, change: p.changes.length, moved: p.changes.filter((c) => c.oldTable !== c.table).length,
      unchanged: p.unchanged, missingInNew: p.missing.length,
      updatesToAdd: newKeys(fs0.updates, ts0.updates), auditToAdd: newKeys(fs0.audit, ts0.audit), feedbackToAdd: newKeys(fs0.feedback, ts0.feedback),
      seqFrom: ts0.seq, seqTo: Math.max(ts0.seq, fs0.seq),
    }
  } finally { F.db.close(); T.db.close() }
}

function writeExport(file, fromDb, plan) {
  const out = {
    exportedAt: new Date().toISOString(),
    note: '含卡片正文，按敏感数据保管',
    cards: [...plan.adds.map((x) => ({ action: 'add', table: x.table, ...x.row })), ...plan.changes.map((x) => ({ action: 'change', table: x.table, ...x.row }))],
    missingInNew: plan.missing,
    card_updates: all(fromDb, 'SELECT u.content, u.created_at, COALESCE(c.path, q.path) AS path FROM card_updates u LEFT JOIN cards c ON c.id = u.card_id LEFT JOIN quarantine q ON q.id = u.card_id'),
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

/**
 * 把"新库"里相对"旧库"新增/变更的卡导回旧库（旧库须已停止写入）。默认只出计划；execute 才写。
 * - 只碰旧库原有的 7 张表，绝不升级旧库 schema；写前先 backup API 留底（pre-reverse-<时间>.db，0600）。
 * - 同 path 的行整体替换（含跨表搬家）；id 优先沿用新库的，被旧库别的卡占用则在旧库发新号。
 * - 新库里"消失"的 path（永久删除）默认只报告，pruneMissing 才在旧库删除。
 * - card_updates / audit_log / feedback 按自然键补缺；card_sequence 取两边较大者。
 */
export async function applyReverse({ from, target, execute = false, pruneMissing = false, exportFile }) {
  const F = openDb(from, { readOnly: true })
  const T = openDb(target, { readOnly: !execute })
  try {
    if (F.file === T.file) throw new MigrateError('--from 与 --target 是同一个文件')
    for (const t of ['cards', 'quarantine', 'card_sequence']) if (!tableExists(T.db, t)) throw new MigrateError(`目标不是 memory 库（缺表 ${t}）：${T.file}`)
    const plan = computePlan(F.db, T.db)
    const summary = {
      add: plan.adds.length, change: plan.changes.length, moved: plan.changes.filter((c) => c.oldTable !== c.table).length,
      unchanged: plan.unchanged, missingInNew: plan.missing.length, prune: pruneMissing,
    }
    if (exportFile) writeExport(path.resolve(exportFile), F.db, plan)
    if (!execute) return { ok: true, executed: false, plan: summary, exportFile: exportFile && path.resolve(exportFile) }

    // 1) 留底（backup API，一致性副本），并校验
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
    const backup = path.join(path.dirname(T.file), `pre-reverse-${stamp}.db`)
    await sqlite.backup(T.db, backup)
    fs.chmodSync(backup, 0o600)
    const bk = new DatabaseSync(backup)
    try {
      const ic = bk.prepare('PRAGMA integrity_check').get().integrity_check
      if (ic !== 'ok') throw new MigrateError(`留底 integrity_check 失败：${ic}`)
      bk.exec('PRAGMA journal_mode=DELETE')
    } finally { bk.close() }

    // 2) 单事务写入
    const db = T.db
    db.exec('PRAGMA foreign_keys = OFF') // 旧库 card_updates 的历史 FK 不应阻碍"同 path 删后重插"
    const fromSnap = snapshot(F.db)
    const pathOfFromId = new Map()
    for (const t of ['cards', 'quarantine']) for (const r of fromSnap.rows[t]) pathOfFromId.set(r.id, r.path)
    const idTaken = (id) => !!db.prepare('SELECT 1 FROM cards WHERE id = ? UNION ALL SELECT 1 FROM quarantine WHERE id = ?').get(id, id)
    let seq = db.prepare("SELECT seq FROM card_sequence WHERE name='card'").get().seq
    const allocId = () => { seq += 1; return seq }
    db.exec('BEGIN IMMEDIATE')
    try {
      const delPath = (p) => { db.prepare('DELETE FROM cards WHERE path = ?').run(p); db.prepare('DELETE FROM quarantine WHERE path = ?').run(p) }
      const insertRow = (x) => {
        const cols = plan.cols[x.table]
        const old = plan.tgtRows.get(x.row.path)
        const oldId = old?.row.id
        delPath(x.row.path)
        let id = x.row.id
        if (idTaken(id)) id = allocId()
        const names = ['id', ...cols.filter((c) => !CARD_COLS_IGNORE.has(c))]
        const vals = names.map((c) => (c === 'id' ? id : x.row[c] ?? null))
        db.prepare(`INSERT INTO ${x.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...vals)
        // 旧库里这张卡原有的更新记录跟着卡走（id 可能变了）
        if (oldId !== undefined && oldId !== id) db.prepare('UPDATE card_updates SET card_id = ? WHERE card_id = ?').run(id, oldId)
        seq = Math.max(seq, id)
      }
      for (const x of plan.adds) insertRow(x)
      for (const x of plan.changes) insertRow(x)

      if (pruneMissing) {
        for (const p of plan.missing) {
          const old = plan.tgtRows.get(p)
          db.prepare('DELETE FROM card_updates WHERE card_id = ?').run(old.row.id)
          db.prepare('DELETE FROM feedback WHERE card_path = ?').run(p)
          delPath(p)
        }
      }

      // 侧表按自然键补缺
      const idOfPath = (p) => db.prepare('SELECT id FROM cards WHERE path = ? UNION ALL SELECT id FROM quarantine WHERE path = ?').get(p, p)?.id
      const have = {
        u: new Set(all(db, 'SELECT card_id, content, created_at FROM card_updates').map((r) => `${r.card_id}\u0001${r.content}\u0001${r.created_at}`)),
        a: new Set(all(db, 'SELECT card_path, old_status, new_status, changed_by, reason, created_at FROM audit_log').map((r) => [r.card_path, r.old_status, r.new_status, r.changed_by, r.reason, r.created_at].join('\u0001'))),
        f: new Set(all(db, 'SELECT query, card_path, useful, created_at FROM feedback').map((r) => [r.query, r.card_path, r.useful, r.created_at].join('\u0001'))),
      }
      for (const r of all(F.db, 'SELECT card_id, content, created_at FROM card_updates')) {
        const id = idOfPath(pathOfFromId.get(r.card_id))
        if (id === undefined) continue
        const k = `${id}\u0001${r.content}\u0001${r.created_at}`
        if (have.u.has(k)) continue
        db.prepare('INSERT INTO card_updates (card_id, content, created_at) VALUES (?, ?, ?)').run(id, r.content, r.created_at)
        have.u.add(k)
      }
      for (const r of all(F.db, 'SELECT card_path, old_status, new_status, changed_by, reason, created_at FROM audit_log')) {
        const k = [r.card_path, r.old_status, r.new_status, r.changed_by, r.reason, r.created_at].join('\u0001')
        if (have.a.has(k)) continue
        db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(r.card_path, r.old_status, r.new_status, r.changed_by, r.reason, r.created_at)
        have.a.add(k)
      }
      for (const r of all(F.db, 'SELECT query, card_path, useful, created_at FROM feedback')) {
        const k = [r.query, r.card_path, r.useful, r.created_at].join('\u0001')
        if (have.f.has(k)) continue
        db.prepare('INSERT INTO feedback (query, card_path, useful, created_at) VALUES (?, ?, ?, ?)').run(r.query, r.card_path, r.useful, r.created_at)
        have.f.add(k)
      }
      seq = Math.max(seq, fromSnap.seq)
      db.prepare("UPDATE card_sequence SET seq = ? WHERE name = 'card'").run(seq)
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
      return { ok: false, executed: false, error: String(e?.message || e), plan: summary, backup }
    }
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* 非 WAL */ }
    const ic = db.prepare('PRAGMA integrity_check').get().integrity_check
    return { ok: ic === 'ok', executed: true, plan: summary, backup, integrity: ic, seq, exportFile: exportFile && path.resolve(exportFile) }
  } finally { F.db.close(); T.db.close() }
}

export function formatPlan(r) {
  const p = r.plan
  const lines = [
    r.executed ? '[reverse] 已执行' : '[reverse] dry-run（未改任何库；加 --execute 才写入旧库）',
    `  新增 ${p.add}；变更 ${p.change}（其中跨表搬家 ${p.moved}）；无变化 ${p.unchanged}；新库里已永久删除而旧库仍有 ${p.missingInNew}${p.prune ? '（--prune-purged：已/将在旧库删除）' : '（默认保留，不删）'}`,
  ]
  if (r.backup) lines.push(`  留底：${r.backup}`)
  if (r.exportFile) lines.push(`  增量导出：${r.exportFile}（含正文，0600）`)
  if (r.executed) lines.push(`  integrity_check=${r.integrity}；card_sequence.seq=${r.seq}`)
  if (r.error) lines.push(`  失败（已回滚，旧库未变）：${r.error}`)
  return lines.join('\n') + '\n'
}
