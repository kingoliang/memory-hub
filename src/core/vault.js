// memory-hub · SQLite Vault 存储层（源自 memory-eternal lib/vault.js；已去除图谱 / 多库 / optimize / 导出）
//
// 纯工具函数保持不变；IO 函数全部改用 SQL。
// 底层依赖 lib/db.js 的 getDb(root) → DatabaseSync 实例。

import { getDb, enforceAudit, nextCardId, MAIN_STATUS, QUARANTINE_STATUSES, tableForStatus } from './db.js'
import { minhashSignature, lshCandidates } from './minhash.js'

/** 主题目录根。 */
export const KIND_ROOTS = {
  project: '02-Projects',
  knowledge: '03-Knowledge',
  content: '04-Content',
  prompt: '05-Prompts',
  business: '06-Business',
  tool: '07-Tools',
  mistake: '08-Mistakes',
}

export const CAPTURE_KINDS = ['project', 'knowledge', 'content', 'prompt', 'business', 'tool', 'mistake']

/** 从 Markdown 文本提取 frontmatter 与正文。 */
export function parseCard(text) {
  const meta = { title: '', kind: 'knowledge', tags: [], created: '', updated: '', source: '', formatVersion: 0, status: 'pending', submittedBy: '', severity: 'info', reason: '', deletedAt: '' }
  let body = text
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (m) {
    body = text.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const eq = line.indexOf(':')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (key === 'tags') {
        value = value.replace(/^\[/, '').replace(/\]$/, '')
        meta.tags = value.split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        continue
      }
      if (key === 'formatVersion') {
        meta.formatVersion = Number(value) || 0
      } else if (key === 'kind' || key === 'title' || key === 'created' || key === 'updated' || key === 'source' || key === 'status' || key === 'submittedBy' || key === 'severity' || key === 'reason' || key === 'deletedAt') {
        meta[key] = value.replace(/^['"]|['"]$/g, '')
      }
    }
  }
  if (!meta.status) meta.status = 'pending'
  if (!meta.title) {
    const h = /^#\s+(.+)$/m.exec(body)
    meta.title = h ? h[1].trim() : body.trim().split(/\r?\n/)[0].slice(0, 60)
  }
  const summary = body.trim().slice(0, 200)
  return { meta, body: body.trim(), summary }
}

/** 生成安全 slug（中文保留、非法字符替换为 -）。 */
export function safeSlug(name) {
  const base = String(name || 'card')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return base || 'card'
}

/** 字符 bigram 集合（textSimilarity 的预处理部分，单独暴露供 O(n²) 场景复用）。 */
export function bigramSet(text) {
  const cleaned = String(text)
    .replace(/[\s#*_`|[\]()（）\-—・]+/g, '')
    .toLowerCase()
  const out = new Set()
  for (let i = 0; i < cleaned.length - 1; i++) out.add(cleaned.slice(i, i + 2))
  if (cleaned.length === 1) out.add(cleaned)
  return out
}

/**
 * 与 bigramSet 同规则（同一套清洗），但把每个 bigram 压成 32 位整数再入集合。
 * 为什么单独一份：Set<number> 的构建与求交都比 Set<string> 快数倍，
 * 而 **去重判定** 仍必须用字符串版（语义不能变）—— 所以图谱专用、互不干扰。
 */
export function bigramHashSet(text) {
  const cleaned = String(text)
    .replace(/[\s#*_`|[\]()（）\-—・]+/g, '')
    .toLowerCase()
  const out = new Set()
  for (let i = 0; i < cleaned.length - 1; i++) out.add(hash32(cleaned.slice(i, i + 2)))
  if (cleaned.length === 1) out.add(hash32(cleaned))
  return out
}

/** 32 位 FNV-1a：把 bigram 压成整数键。 */
function hash32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 用预算好的 bigram 集合算 Jaccard（结果与 textSimilarity 完全一致）。
 *
 * `minRatio` 是数学上界剪枝：J ≤ min(|A|,|B|)/max(|A|,|B|)，所以长度比低于阈值时
 * 必然 `J < 阈值`，可直接返回 0 **不迭代**（对「J ≥ 阈值」的判定无损，不是近似）。
 * 图谱的 O(n²) 配对就靠这一步从「每次重新分词两段正文」变成「集合求交」。
 */
export function jaccardSets(ba, bb, minRatio = 0) {
  if (!ba || !bb || ba.size === 0 || bb.size === 0) return 0
  const [small, large] = ba.size <= bb.size ? [ba, bb] : [bb, ba]
  if (minRatio > 0 && small.size / large.size < minRatio) return 0
  let inter = 0
  for (const g of small) if (large.has(g)) inter++
  return inter / (ba.size + bb.size - inter)
}

/** Jaccard-like 相似度：字符 bigram 集合。 */
export function textSimilarity(a, b) {
  return jaccardSets(bigramSet(a), bigramSet(b))
}

/** CJK 感知查询词：整词 + 中文字符 bigram。 */
export function queryTerms(query) {
  const tokens = new Set(String(query).split(/[^\w\u4e00-\u9fff]+/).filter(Boolean))
  for (let i = 0; i < query.length - 1; i++) {
    const c1 = query[i]
    const c2 = query[i + 1]
    if (/[\u4e00-\u9fff]/.test(c1) && /[\u4e00-\u9fff]/.test(c2)) tokens.add(c1 + c2)
  }
  return tokens
}

/**
 * 在目标目录中找与候选文本最相似的现有卡（去重守卫）。比较正文。
 *
 * 只比对 **approved**（P0 修复）：命中后调用方会 `appendUpdate` 往这张卡里追加内容，
 * 而 pending / rejected 是不该再长内容的状态——旧实现只按 `deleted_at IS NULL` 过滤，
 * 会把新知识追加进待审垃圾卡或已被驳回的卡，等于绕过审核往废弃卡里灌数据。
 */
export async function dedupCheck(root, text, threshold = 0.62) {
  return bestDuplicate(await mainStoreBodies(root), text, threshold)
}

/**
 * 主库已审核卡的 `(path, body)` 快照。
 *
 * 批量写入（导入备份）必须用它做**导入前**基线：否则同一份备份里互相近似的卡会在写入
 * 过程中互相判重，把备份当成「重复」丢掉一批（备份是真相源，不能被自己人吞）。
 */
export async function mainStoreBodies(root) {
  const db = getDb(root)
  return db.prepare("SELECT path, body FROM cards WHERE status = 'approved' AND deleted_at IS NULL").all()
}

/** 在一组候选里找与给定文本最相似的一张（≥ 阈值）。候选集合由调用方提供，供快照比对复用。 */
export function bestDuplicate(candidates, text, threshold = 0.62) {
  let best = null
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const score = textSimilarity(text, row?.body || '')
    if (score >= threshold && (!best || score > best.score)) best = { path: row?.path, score }
  }
  return best
}

// 目录名 → kind 推断
function kindFromDir(topDir) {
  for (const [k, v] of Object.entries(KIND_ROOTS)) { if (v.toLowerCase() === String(topDir || '').toLowerCase()) return k }
  return 'knowledge'
}

/** 确保 vault 目录结构存在（即确保 DB 存在）。 */
export async function ensureVault(root) {
  // getDb 会自动建表
  getDb(root)
}

/** 将 SQL 行还原为调用方期望的卡片摘要对象。 */
function rowToCard(row) {
  return {
    path: row.path,
    kind: row.kind,
    title: row.title,
    tags: JSON.parse(row.tags || '[]'),
    summary: row.summary || '',
    created: row.created_at,
    updated: row.updated_at,
    mtime: new Date(row.updated_at).getTime(),
    status: row.status,
    submittedBy: row.submitted_by || '',
    severity: row.severity || 'info',
    reason: row.reason || '',
    deletedAt: row.deleted_at || '',
  }
}

/** 将 SQL 行还原为完整 Markdown 文本（frontmatter + body）。 */
function rowToMarkdown(row) {
  const tags = JSON.parse(row.tags || '[]')
  const lines = [
    '---',
    `formatVersion: 1`,
    `kind: ${row.kind}`,
    `title: ${yamlString(row.title)}`,
    `tags: [${tags.map((t) => yamlString(t)).join(', ')}]`,
    `created: ${row.created_at}`,
    `updated: ${row.updated_at}`,
    `status: ${row.status}`,
    ...(row.deleted_at ? [`deletedAt: ${row.deleted_at}`] : []),
    ...(row.submitted_by ? [`submittedBy: ${yamlString(row.submitted_by)}`] : []),
    ...(row.severity && row.severity !== 'info' ? [`severity: ${row.severity}`] : []),
    ...(row.reason ? [`reason: ${yamlString(row.reason)}`] : []),
    ...(row.source ? [`source: ${row.source}`] : []),
    '---',
    '',
    `# ${row.title}`,
    '',
    row.body.trim(),
    '',
  ]
  // 附加 card_updates
  return { text: lines.join('\n'), tags }
}

/**
 * 智能体署名归一（与客户端 normAgent 同一套规则，供 SQL 过滤用）：
 * 空 / agent / unknown / session:* / DeepSeek Harness → deepseek-harness；claude-code* → claude；其余精确匹配。
 */
function agentWhere(agent, args) {
  const a = String(agent || '').toLowerCase()
  if (a === 'deepseek-harness') {
    args.push('', 'agent', 'unknown', 'deepseek-harness', 'deepseek harness')
    return "(LOWER(COALESCE(submitted_by,'')) IN (?,?,?,?,?) OR submitted_by LIKE 'session:%')"
  }
  if (a === 'claude') { args.push('claude', 'claude-code%'); return "(LOWER(COALESCE(submitted_by,'')) = ? OR submitted_by LIKE ?)" }
  args.push(a)
  return "LOWER(COALESCE(submitted_by,'')) = ?"
}

// ---- 两套存储：主库（cards，只存 approved）/ 隔离区（quarantine，pending·rejected·deleted）--
//
// 下面三个函数负责「把状态白名单翻译成对两张表的查询」。读路径默认只碰主库：
// 主库物理上不含非 approved 行，所以查主库**不需要写状态条件**，也就没有「漏写状态条件」这种 bug 面。

/** 状态白名单 → 需要读的表清单。 */
function storesFor(want) {
  const hasMain = want.includes(MAIN_STATUS)
  const hasQuarantine = want.some((s) => QUARANTINE_STATUSES.includes(s))
  if (hasMain && !hasQuarantine) return [{ table: 'cards', statuses: null }]
  if (hasQuarantine && !hasMain) return [{ table: 'quarantine', statuses: want.filter((s) => QUARANTINE_STATUSES.includes(s)) }]
  return [
    { table: 'cards', statuses: null },
    { table: 'quarantine', statuses: want.filter((s) => QUARANTINE_STATUSES.includes(s)) },
  ]
}

/**
 * 生成一条「跨两套存储」的查询。
 * @param sel    选择列表（如 '*' 或 'path, title'）
 * @param stores storesFor() 的结果
 * @param extra  { kind, agent, tail } —— tail 是 ORDER BY / LIMIT 片段（默认按 updated_at 倒序）
 */
function multiStoreQuery(sel, stores, { kind = '', agent = '', tail = 'ORDER BY updated_at DESC' } = {}) {
  const parts = []
  const args = []
  for (const store of stores) {
    const where = []
    const wargs = []
    if (store.statuses) {
      where.push(`status IN (${store.statuses.map(() => '?').join(',')})`)
      wargs.push(...store.statuses)
    }
    if (kind) { where.push('kind = ?'); wargs.push(kind) }
    if (agent) where.push(agentWhere(agent, wargs))
    parts.push(`SELECT ${sel} FROM ${store.table}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`)
    args.push(...wargs)
  }
  return { sql: parts.join(' UNION ALL ') + ' ' + tail, args }
}

/** 在两张表里按 path 找一行（跨存储读取用，返回 { table, row }）。 */
function findCardRow(db, rel) {
  const inMain = db.prepare('SELECT * FROM cards WHERE path = ?').get(rel)
  if (inMain) return { table: 'cards', row: inMain }
  const inQuarantine = db.prepare('SELECT * FROM quarantine WHERE path = ?').get(rel)
  if (inQuarantine) return { table: 'quarantine', row: inQuarantine }
  return null
}

/** 某个 path 是否已被占用（两张表任意一张里有，就算占用）。 */
function pathTaken(db, rel) {
  if (db.prepare('SELECT 1 FROM cards WHERE path = ?').get(rel)) return true
  return !!db.prepare('SELECT 1 FROM quarantine WHERE path = ?').get(rel)
}

/** 标题排序用的中文排序器（拼音 + 数字感知）；固定 zh-Hans-CN，避免随进程 locale 漂移。 */
export const TITLE_COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/**
 * 列出卡片。
 *
 * 两套存储下 status 的语义：'approved' → 只查主库（**不加状态条件**，主库物理上只有 approved）；
 * 'pending'/'rejected'/'deleted' → 查隔离区；'all' → 两张表 UNION（审核中心用）。
 *
 * @param opts.status  状态白名单（默认 approved = 主库）
 * @param opts.kind    类型过滤（SQL）
 * @param opts.agent   署名过滤（服务端归一，如 deepseek-harness / claude）
 * @param opts.limit   返回条数上限（缺省=全部，供内部调用保持原语义）
 * @param opts.offset  偏移（配合 limit 做真分页）
 * @param opts.sort    'recent'（updated_at DESC，默认）| 'title'（拼音升序，跨页全局有序）
 */
export async function listCards(root, { status, kind, agent, limit, offset = 0, sort = 'recent' } = {}) {
  const want = status ?? [MAIN_STATUS]
  const db = getDb(root)
  const stores = storesFor(want)

  if (sort === 'title') {
    // SQLite 的 ORDER BY 是 UTF-8 字节序，中文标题看着就是乱的 → 只取 path/title 用拼音排好，
    // 再回表取这一页的正文（避免为了排序把所有正文读进内存）。
    const { sql, args } = multiStoreQuery('path, title', stores, { kind, agent, tail: '' })
    const light = db.prepare(sql).all(...args)
    light.sort((a, b) => TITLE_COLLATOR.compare(a.title || '', b.title || ''))
    const start = Math.max(0, offset | 0)
    const page = Number.isInteger(limit) && limit > 0 ? light.slice(start, start + limit) : light.slice(start)
    if (page.length === 0) return []
    const paths = page.map((r) => r.path)
    const rows = []
    for (const store of stores) {
      const ph = paths.map(() => '?').join(',')
      rows.push(...db.prepare(`SELECT * FROM ${store.table} WHERE path IN (${ph})`).all(...paths))
    }
    const byPath = new Map(rows.map((r) => [r.path, rowToCard(r)]))
    return page.map((r) => byPath.get(r.path)).filter(Boolean)
  }

  const tail = Number.isInteger(limit) && limit > 0
    ? `ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    : 'ORDER BY updated_at DESC'
  // 注意：两张表的列数不同（quarantine 多 quarantined_at / quarantine_reason），
  // UNION ALL 必须显式列出公共列，不能用 `*`（否则列会错位）。
  const { sql, args } = multiStoreQuery(
    'id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at',
    stores,
    { kind, agent, tail },
  )
  const finalArgs = Number.isInteger(limit) && limit > 0 ? [...args, limit, Math.max(0, offset | 0)] : args
  return db.prepare(sql).all(...finalArgs).map(rowToCard)
}

/** 计数（分页接口要用 total 判断还有没有下一页）。 */
export async function countCards(root, { status, kind, agent } = {}) {
  const db = getDb(root)
  const stores = storesFor(status ?? [MAIN_STATUS])
  const { sql, args } = multiStoreQuery('COUNT(*) n', stores, { kind, agent, tail: '' })
  return db.prepare(`SELECT SUM(n) n FROM (${sql})`).get(...args).n || 0
}

/** 审核队列：status=pending 或 rejected。 */
export async function auditQueue(root) {
  const cards = await listCards(root, { status: ['pending', 'rejected'] })
  return { pending: cards.filter((c) => c.status === 'pending'), rejected: cards.filter((c) => c.status === 'rejected') }
}

/** 同一个事务里执行 fn（失败自动回滚）。跨表搬家必须原子，否则会丢卡。 */
let savepointSeq = 0
function inTransaction(db, fn) {
  // 已在外层事务里（例如整理批次 tidyApply 把多次软删包进同一个事务）→ 用 SAVEPOINT 嵌套，
  // 内层失败只回滚内层、异常继续上抛由外层决定整体回滚。外层没有事务时行为与原来完全一致。
  if (db.isTransaction) {
    const sp = `me_sp_${++savepointSeq}`
    db.exec(`SAVEPOINT ${sp}`)
    try {
      const out = fn()
      db.exec(`RELEASE ${sp}`)
      return out
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`) } catch { /* 外层会整体回滚 */ }
      throw e
    }
  }
  // IMMEDIATE：一开始就拿写锁（受 busy_timeout 约束）。deferred 事务在读后升级写锁时 WAL 下会直接 BUSY 而不等待
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

/**
 * 把一张卡从一张表搬到另一张表（重建行、保住内容 / 时间戳 / 更新记录）。
 *
 * 为什么不用同一个 id：两张表共享 `path` 命名空间，但 id 由 `card_sequence` 单一发号器
 * 保证**全库唯一**；跨表插入时旧 id 可能已被目标表占用（实测 `UNIQUE constraint failed`）。
 * 所以搬家时重新领号，并把 `card_updates.card_id` 一起改绑 —— 用户视角「更新记录还在」。
 * 之所以要原子：INSERT 成功而 DELETE 失败会留下重复卡；反过来则直接丢卡。
 */
function moveCardBetweenStores(db, from, to, rel, { status, deletedAt = null, quarantineReason = '', updatedAt } = {}) {
  const now = updatedAt || new Date().toISOString()
  return inTransaction(db, () => {
    const src = db.prepare(`SELECT * FROM ${from} WHERE path = ?`).get(rel)
    if (!src) throw new Error(`卡片不在 ${from}: ${rel}`)
    const newId = nextCardId(db)

    if (to === 'quarantine') {
      db.prepare(`
        INSERT INTO quarantine
          (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at, quarantined_at, quarantine_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `).run(newId, src.path, src.kind, src.title, src.tags, src.body, src.summary, status, src.source, src.submitted_by, src.severity, src.reason, src.created_at, now, deletedAt, quarantineReason)
    } else {
      db.prepare(`
        INSERT INTO cards
          (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(newId, src.path, src.kind, src.title, src.tags, src.body, src.summary, status, src.source, src.submitted_by, src.severity, src.reason, src.created_at, now, deletedAt)
    }
    // 更新记录跟着卡走（id 变了，按新 id 改绑）
    db.prepare('UPDATE card_updates SET card_id = ? WHERE card_id = ?').run(newId, src.id)
    db.prepare(`DELETE FROM ${from} WHERE path = ?`).run(rel)
    return { ok: true, status, table: to, oldId: src.id, newId }
  })
}

/** 回收站：隔离区里 status=deleted，按 deleted_at 倒序。 */
export async function recycleList(root) {
  const db = getDb(root)
  const rows = db.prepare('SELECT * FROM quarantine WHERE status = ? ORDER BY deleted_at DESC').all('deleted')
  return rows.map(rowToCard)
}

/** 清理超过 retentionDays 天的回收卡（永久删除）。 */
export async function purgeExpired(root, retentionDays = 30) {
  const db = getDb(root)
  const cut = new Date(Date.now() - retentionDays * 86400000).toISOString()
  const rows = db.prepare('SELECT path FROM quarantine WHERE status = ? AND deleted_at IS NOT NULL AND deleted_at < ?').all('deleted', cut)
  let purged = 0
  for (const row of rows) {
    try { await deleteCard(root, row.path, { permanent: true }); purged++ } catch {}
  }
  return { ok: true, purged }
}

/**
 * 读取一张卡（返回 Markdown 文本）。
 *
 * 两套存储下的语义：
 * - 默认**只读主库**（主库物理上只含 approved）→ 想读未审核内容，必须显式 `allowUnapproved`。
 * - `allowUnapproved: true` 时（审核中心 / 回收站预览）走两张表。
 * 「不存在」与「存在但未审核」是两种不同的错误码，方便上层区分。
 */
export async function readCard(root, rel, { allowUnapproved = false } = {}) {
  const db = getDb(root)
  const mainRow = db.prepare('SELECT * FROM cards WHERE path = ?').get(rel)
  let row = mainRow
  if (!row && allowUnapproved) row = db.prepare('SELECT * FROM quarantine WHERE path = ?').get(rel)
  if (!row) {
    // path 可能在隔离区而不在主库 —— 这种情况不能当成「不存在」，否则审核中心会误判
    const inQuarantine = db.prepare('SELECT status FROM quarantine WHERE path = ?').get(rel)
    const err = new Error(inQuarantine
      ? `卡片在隔离区（${statusLabel(inQuarantine.status)}），未通过审核不能读取正文：${rel}`
      : `卡片不存在: ${rel}`)
    err.code = inQuarantine ? 'CARD_NOT_APPROVED' : 'CARD_NOT_FOUND'
    if (inQuarantine) err.status = inQuarantine.status
    throw err
  }
  const status = String(row.status || '')
  const { text } = rowToMarkdown(row)
  const updates = db.prepare('SELECT content, created_at FROM card_updates WHERE card_id = ? ORDER BY created_at ASC').all(row.id)
  if (updates.length > 0) {
    const updateLines = updates.map((u) => `- ${u.created_at.slice(0, 10)}：${u.content}`)
    return { path: rel, status, store: mainRow ? 'main' : 'quarantine', text: text + '\n## 更新记录\n\n' + updateLines.join('\n') + '\n' }
  }
  return { path: rel, status, store: mainRow ? 'main' : 'quarantine', text }
}

/** 状态中文标签（错误信息与日志用）。 */
function statusLabel(status) {
  const s = String(status || '')
  return s === 'pending' ? '待审核' : s === 'rejected' ? '已驳回' : s === 'deleted' ? '回收站中' : s
}

/**
 * 删除卡片。
 * - 永久删除：从**任一张表**里抹掉（含更新记录，靠外键 CASCADE）。
 * - 软删（默认）：主库卡 → 搬进隔离区并置 deleted；隔离区卡 → 原地置 deleted。
 */
export async function deleteCard(root, rel, { permanent = false } = {}) {
  const db = getDb(root)
  if (permanent) {
    // 先按 path 取 id（两张表共享 id 空间），再清理按 id 关联的更新记录 —— card_updates
    // 不带外键（卡会在两表间搬家），所以级联必须在这里手工做。
    const ids = []
    const mainRow = db.prepare('SELECT id FROM cards WHERE path = ?').get(rel)
    if (mainRow) ids.push(mainRow.id)
    const qRow = db.prepare('SELECT id FROM quarantine WHERE path = ?').get(rel)
    if (qRow) ids.push(qRow.id)
    if (!ids.length) throw new Error('卡片不存在: ' + rel)
    inTransaction(db, () => {
      for (const id of ids) {
        db.prepare('DELETE FROM card_updates WHERE card_id = ?').run(id)
        db.prepare('DELETE FROM feedback WHERE card_path = ?').run(rel)
      }
      db.prepare('DELETE FROM cards WHERE path = ?').run(rel)
      db.prepare('DELETE FROM quarantine WHERE path = ?').run(rel)
    })
    return { ok: true, permanent: true }
  }
  return softDeleteCardSync(db, rel)
}

/**
 * 软删的同步实现（deleteCard 默认路径与整理批次共用）：全程同步、可嵌套进外层事务，
 * 外层批量操作因此能保证「要么整批生效，要么整批回滚」，中途不会有别的异步任务插进来。
 * 默认参数与 v0.10.8 的 deleteCard 软删行为逐字一致。
 */
export function softDeleteCardSync(db, rel, { changedBy = 'delete', reason = '软删进回收站', quarantineReason = '移入回收站' } = {}) {
  const existing = findCardRow(db, rel)
  if (!existing) throw new Error('卡片不存在: ' + rel)
  if (existing.table === 'cards') {
    const r = moveCardBetweenStores(db, 'cards', 'quarantine', rel, { status: 'deleted', deletedAt: new Date().toISOString(), quarantineReason })
    db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)').run(rel, existing.row.status, 'deleted', changedBy, reason)
    return { ok: true, soft: true, ...r }
  }
  const now = new Date().toISOString()
  db.prepare('UPDATE quarantine SET status = ?, deleted_at = ?, updated_at = ? WHERE path = ?').run('deleted', now, now, rel)
  db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)').run(rel, existing.row.status, 'deleted', changedBy, reason)
  return { ok: true, soft: true }
}

/** 恢复回收站的卡：从隔离区搬回主库，status=approved。写审计日志。 */
export async function restoreCard(root, rel) {
  return restoreCardSync(getDb(root), rel)
}

/** restoreCard 的同步实现（整理回滚用，可嵌套进外层事务）。 */
export function restoreCardSync(db, rel, { changedBy = 'restore', reason = '回收站恢复' } = {}) {
  const existing = db.prepare('SELECT status FROM quarantine WHERE path = ?').get(rel)
  if (!existing) throw new Error('卡片不在回收站/隔离区: ' + rel)
  const r = moveCardBetweenStores(db, 'quarantine', 'cards', rel, { status: MAIN_STATUS, deletedAt: null })
  db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)').run(rel, existing.status, MAIN_STATUS, changedBy, reason)
  return { ok: true, restored: true, ...r }
}

/**
 * 更新卡状态（审核操作，唯一入口）。写审计日志。
 *
 * 两套存储的关键点：status 决定这张卡**住在哪张表**。
 * → approved：搬进主库（agent 可召回）；pending/rejected/deleted：留在/搬进隔离区。
 */
export async function setCardStatus(root, rel, status, { changedBy = 'system', reason = '' } = {}) {
  const db = getDb(root)
  const target = String(status)
  const existing = findCardRow(db, rel)
  if (!existing) throw new Error('卡片不存在: ' + rel)

  if (target === MAIN_STATUS) {
    if (existing.table === 'cards') {
      db.prepare('UPDATE cards SET status = ?, updated_at = ? WHERE path = ?').run(target, new Date().toISOString(), rel)
    } else {
      moveCardBetweenStores(db, 'quarantine', 'cards', rel, { status: target, deletedAt: null })
    }
  } else {
    if (existing.table === 'cards') {
      moveCardBetweenStores(db, 'cards', 'quarantine', rel, { status: target, deletedAt: target === 'deleted' ? new Date().toISOString() : null, quarantineReason: reason || '审核流转' })
    } else {
      db.prepare('UPDATE quarantine SET status = ?, deleted_at = ?, updated_at = ? WHERE path = ?')
        .run(target, target === 'deleted' ? new Date().toISOString() : null, new Date().toISOString(), rel)
    }
  }
  db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)').run(rel, existing.row.status, target, changedBy, reason)
  return { ok: true, status: target, store: tableForStatus(target) }
}

/**
 * 原子写卡；先去重，命中返回 {duplicate}。审核守卫在数据库层强制。
 *
 * 两套存储：enforceAudit 判定出的 status 决定**写进哪张表** ——
 * approved → 主库（可被召回）；pending/rejected/deleted → 隔离区（只有审核中心能看）。
 *
 * `dedupAgainst` 传入候选集合时，去重只跟**这些**卡比（导入备份用：基线取导入前的快照，
 * 让同一批里互相近似的卡不会互吞）。
 */
export async function writeCard(root, { kind, title, tags = [], body, source = '', status = 'pending', submittedBy = '', severity = 'info', reason = '', deletedAt = '' }, { threshold = 0.62, dedup = true, dedupAgainst = null } = {}) {
  const db = getDb(root)
  const kindRoot = KIND_ROOTS[kind] || KIND_ROOTS.knowledge

  // 审核守卫：数据库层强制，调用方传的 status 仅作 fallback
  const enforcedStatus = enforceAudit(root, kind, submittedBy, status)
  const targetTable = tableForStatus(enforcedStatus)

  // 去重只在主库（approved）里找 —— 把新知识追加进隔离区里的待审/驳回卡是绕过审核
  if (dedup) {
    const hit = dedupAgainst ? bestDuplicate(dedupAgainst, body, threshold) : await dedupCheck(root, body, threshold)
    if (hit) return { ok: false, duplicate: { ...hit, path: hit.path } }
  }

  // 选 path + 发号 + 插入必须在同一个写事务里：否则多进程并发写时会选中同一个 path，或在查重与插入之间被抢先
  return inTransaction(db, () => {
    const slug = safeSlug(title)
    let rel = `${kindRoot}/${slug}.md`
    let index = 2
    while (pathTaken(db, rel)) {
      rel = `${kindRoot}/${slug}-${index}.md`
      index++
    }

    const now = new Date().toISOString()
    const summary = body.trim().slice(0, 200)
    const id = nextCardId(db) // 跨两张表唯一的 id，由 card_sequence 单一发号器分配
    if (targetTable === 'cards') {
      db.prepare(`
        INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, rel, kind, title, JSON.stringify(tags), body.trim(), summary,
        enforcedStatus, source, submittedBy, severity, reason, now, now, deletedAt || null,
      )
    } else {
      db.prepare(`
        INSERT INTO quarantine (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at, quarantined_at, quarantine_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `).run(
        id, rel, kind, title, JSON.stringify(tags), body.trim(), summary,
        enforcedStatus, source, submittedBy, severity, reason, now, now, deletedAt || null,
        '新卡待审核',
      )
    }
    return { ok: true, path: rel, kind, status: enforcedStatus, store: targetTable }
  })
}

/**
 * 向已存在的卡追加更新记录（跨两张表找，因为审核流转会把卡搬表，但 id 不变）。
 *
 * 注意：调用方（沉淀管线）只在**主库命中去重**时才追加，所以这里不会把新知识灌进隔离区卡。
 */
export async function appendUpdate(root, rel, updateText) {
  const db = getDb(root)
  return inTransaction(db, () => {
    const found = findCardRow(db, rel)
    if (!found) throw new Error('卡片不存在: ' + rel)
    const row = found.row
    const now = new Date().toISOString()
    db.prepare('INSERT INTO card_updates (card_id, content, created_at) VALUES (?, ?, ?)').run(row.id, updateText.trim(), now)
    db.prepare(`UPDATE ${found.table} SET updated_at = ? WHERE id = ?`).run(now, row.id)
    return { ok: true, path: rel, updated: now, store: found.table }
  })
}

/** 合并补充小节标题：整理（tidy）与捕获去重合并共用，二次合并时据此识别并续写同一小节。 */
export const MERGE_SECTION_TITLE = '## 合并补充（来自已合并的近似卡）'

/**
 * 找出 incoming 中「目标正文里没有」的独特行（逐行与目标各行做 bigram Jaccard，
 * 最相近的一行 < lineSim 才算独特）。纯函数。标题行(#)与过短行(<= 8 字)不参与。
 */
export function uniqueLinesAgainst(targetBody, incoming, { lineSim = 0.35, max = 15, maxLineLen = 300, scanLimit = 400 } = {}) {
  const split = (t) => String(t || '').split(/\n+/).map((x) => x.trim()).filter((x) => x.length > 8 && !/^#/.test(x))
  const have = split(targetBody).map((l) => bigramHashSet(l))
  const out = []
  const seen = new Set()
  for (const raw of split(incoming).slice(0, scanLimit)) {
    if (out.length >= max) break
    const l = raw.slice(0, maxLineLen)
    if (seen.has(l)) continue
    const s = bigramHashSet(l)
    let best = 0
    for (const q of have) { best = Math.max(best, jaccardSets(s, q)); if (best >= lineSim) break }
    if (best < lineSim) { out.push(l); seen.add(l) }
  }
  return out
}

/** 把独特行追加进「合并补充」小节（没有则新建）。纯函数。 */
export function withMergeSection(body, lines) {
  if (!lines.length) return body
  const b = String(body || '').trimEnd()
  return b.includes(MERGE_SECTION_TITLE)
    ? b + '\n' + lines.join('\n')
    : b + '\n\n' + MERGE_SECTION_TITLE + '\n\n' + lines.join('\n')
}

/**
 * 把一段文本合并进已有卡（去重命中时用）：只并入正文里没有的独特行，
 * 没有新信息就只刷新 updated_at，不堆 card_updates。仅作用于主库（approved）卡。
 */
export async function mergeIntoCard(root, rel, text, { max = 15, sectionCap = 60 } = {}) {
  const db = getDb(root)
  // 读-改-写放进同一个写事务，避免两个进程同时合并同一张卡时丢更新
  return inTransaction(db, () => mergeIntoCardTx(db, rel, text, { max, sectionCap }))
}

function mergeIntoCardTx(db, rel, text, { max, sectionCap }) {
  const row = db.prepare('SELECT id, body FROM cards WHERE path = ?').get(rel)
  if (!row) throw new Error('卡片不在主库: ' + rel)
  const now = new Date().toISOString()
  const sectionIdx = row.body.indexOf(MERGE_SECTION_TITLE)
  const sectionLines = sectionIdx >= 0 ? row.body.slice(sectionIdx).split('\n').length - 2 : 0
  const room = Math.max(0, Math.min(max, sectionCap - sectionLines))
  const lines = room ? uniqueLinesAgainst(row.body, text, { max: room }) : []
  if (!lines.length) {
    db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(now, row.id)
    return { ok: true, path: rel, merged: 0, updated: now, capped: room === 0 }
  }
  const body = withMergeSection(row.body, lines).trim()
  db.prepare('UPDATE cards SET body = ?, summary = ?, updated_at = ? WHERE id = ?').run(body, body.slice(0, 200), now, row.id)
  return { ok: true, path: rel, merged: lines.length, updated: now }
}

/** 合并多张卡为一张。 */
export async function mergeCards(root, paths) {
  const list = (Array.isArray(paths) ? paths : []).map((p) => String(p || '').trim()).filter(Boolean)
  if (list.length < 2) return { ok: false, error: '至少选 2 张卡' }
  const db = getDb(root)

  const rows = []
  for (const p of list) {
    const found = findCardRow(db, p)
    if (found) rows.push(found.row)
  }
  if (rows.length < 2) return { ok: false, error: '读取失败' }

  const first = rows[0]
  const tags = new Set(JSON.parse(first.tags || '[]'))
  let combined = ''
  rows.forEach((row, i) => {
    const rowTags = JSON.parse(row.tags || '[]')
    rowTags.forEach((t) => tags.add(t))
    combined += (i ? '\n\n---\n\n' : '') + row.body.trim()
  })

  const title = (first.title || '合并记忆') + '（合并）'
  const r = await writeCard(root, { kind: first.kind || 'knowledge', title, tags: [...tags], body: combined, source: 'merge', status: 'pending', submittedBy: 'merge', reason: '多卡合并' }, { dedup: false })
  if (!r.ok) return { ok: false, error: '写入失败' }
  for (const row of rows) { try { await deleteCard(root, row.path, { permanent: true }) } catch {} }
  return { ok: true, path: r.path, merged: rows.length }
}

/** 检索：整词/中文 bigram 命中。 */
export async function search(root, query, { limit = 30, minScore = 0, semantic = false } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  const db = getDb(root)
  // 两套存储后这里**不再需要状态条件**：主库物理上只含 approved。
  const rows = db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all()
  const wanted = queryTerms(q)
  const out = []
  for (const row of rows) {
    const card = rowToCard(row)
    const haystack = `${card.path}\n${card.title}\n${row.body}`.toLowerCase()
    let score = 0
    if (haystack.includes(q.toLowerCase())) score = 3
    for (const term of wanted) {
      if (haystack.includes(term.toLowerCase())) score += 1
    }
    if (semantic) score += Math.round(textSimilarity(q, `${card.title} ${card.summary}`) * 6)
    if (score > 0 && score >= minScore) {
      out.push({ ...card, score, excerpt: row.body.trim().slice(0, 300) })
    }
  }

  // 反馈反哺排序
  const fb = await readFeedback(root)
  const ql = q.toLowerCase()
  const fbByPath = {}
  for (const f of fb) {
    if (!f.path) continue
    const fq = String(f.query || '').toLowerCase()
    const overlap = fq && (fq === ql || ql.includes(fq) || fq.includes(ql) || [...queryTerms(f.query)].some((term) => wanted.has(term)))
    if (!overlap) continue
    const rec = fbByPath[f.path] = fbByPath[f.path] || { useful: 0, irr: 0 }
    if (f.useful) rec.useful += 1; else rec.irr += 1
  }
  for (const hit of out) {
    const rec = fbByPath[hit.path]
    if (rec) hit.score += rec.useful * 2 - rec.irr * 2
  }
  out.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
  return out.slice(0, limit)
}

/** 用量趋势：最近 N 天每天新增卡片数。 */
export async function dailyCounts(root, days = 30) {
  const db = getDb(root)
  const cut = new Date(Date.now() - days * 86400000).toISOString()
  const rows = db.prepare("SELECT DATE(created_at) as d, COUNT(*) as cnt FROM cards WHERE created_at >= ? GROUP BY DATE(created_at)").all(cut)
  const map = new Map(rows.map((r) => [r.d, r.cnt]))
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000)
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    out.push({ date: key, count: map.get(key) || 0 })
  }
  return out
}

/** 统计（主库用量 + 隔离区计数，供侧栏徽标用）。 */
export async function stats(root) {
  const db = getDb(root)
  const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM cards').get()
  const byKindRows = db.prepare('SELECT kind, COUNT(*) as cnt FROM cards GROUP BY kind').all()
  const byKind = Object.fromEntries(byKindRows.map((r) => [r.kind, r.cnt]))

  const now = new Date()
  const dayAgo = new Date(now.getTime() - 86400000).toISOString()
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString()
  const todayRow = db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE updated_at >= ?').get(dayAgo)
  const weekRow = db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE updated_at >= ?').get(weekAgo)
  const tagRows = db.prepare('SELECT tags FROM cards').all()
  const tagSet = new Set()
  for (const r of tagRows) { for (const t of JSON.parse(r.tags || '[]')) tagSet.add(t) }

  const todayCardsRows = db.prepare('SELECT * FROM cards WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 30').all(dayAgo)
  const todayCards = todayCardsRows.map((row) => ({ path: row.path, title: row.title, kind: row.kind, updated: row.updated_at, summary: (row.summary || '').slice(0, 80) }))

  // 隔离区：审核排队情况（侧栏「审核中心」徽标直接读这里）
  const quarantineRows = db.prepare('SELECT status, COUNT(*) n FROM quarantine GROUP BY status').all()
  const quarantine = { pending: 0, rejected: 0, deleted: 0 }
  for (const r of quarantineRows) if (r.status in quarantine) quarantine[r.status] = r.n

  return {
    total: totalRow.cnt,
    today: todayRow.cnt,
    week: weekRow.cnt,
    tags: tagSet.size,
    byKind,
    todayCards,
    quarantine,
  }
}

/** 读取反馈记录。 */
export async function readFeedback(root) {
  const db = getDb(root)
  const rows = db.prepare('SELECT * FROM feedback ORDER BY created_at DESC').all()
  return rows.map((r) => ({ ts: new Date(r.created_at).getTime(), query: r.query, path: r.card_path, useful: r.useful }))
}

/** 添加反馈。 */
export async function addFeedback(root, rec) {
  const db = getDb(root)
  db.prepare('INSERT INTO feedback (query, card_path, useful) VALUES (?, ?, ?)').run(
    rec.query || '',
    rec.path || rec.card_path || '',
    rec.useful ? 1 : 0,
  )
  return { ok: true }
}

/**
 * 概览：主库（正常区）+ 隔离区（异常区）两份统计。
 *
 * `total` / `byKind` / `recent` / `tags` 描述**主库**（agent 能看到的那部分）；
 * `status` / `quarantine` 描述隔离区（审核中心与回收站）。
 */
export async function overview(root) {
  const db = getDb(root)
  const cards = await listCards(root, { status: [MAIN_STATUS] })
  const byKind = {}
  const statusCounts = {}
  for (const c of cards) { byKind[c.kind] = (byKind[c.kind] || 0) + 1; statusCounts[c.status] = (statusCounts[c.status] || 0) + 1 }
  const week = Date.now() - 7 * 86400000
  const recent = cards.filter((c) => c.mtime > week).length
  const tagSet = new Set()
  for (const c of cards) for (const t of c.tags) tagSet.add(t)

  // 隔离区统计：按状态 + 按 kind
  const quarantined = await listCards(root, { status: [...QUARANTINE_STATUSES] })
  const quarantine = { pending: 0, rejected: 0, deleted: 0, total: quarantined.length }
  const quarantineByKind = {}
  for (const c of quarantined) {
    if (c.status in quarantine) quarantine[c.status] += 1
    quarantineByKind[c.kind] = (quarantineByKind[c.kind] || 0) + 1
  }

  return {
    total: cards.length,
    byKind,
    recent,
    tags: tagSet.size,
    status: statusCounts,
    quarantine,
    quarantineByKind,
    roots: Object.fromEntries(Object.entries(KIND_ROOTS).map(([k, v]) => [k, `${v}/`])),
  }
}

function yamlString(value) {
  const s = String(value ?? '')
  return /[:#\[\]{}"',&*!|>%@`]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}
