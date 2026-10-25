// memory-hub · BM25 风格检索（memory_recall / 管理界面蜘蛛搜索 / 管理界面全文检索共用）。
//
// 打分（BM25F 简化版，不依赖 FTS 分词）：
//   检索词 = 查询里的整词 + 长中文词内部的字符 bigram（见 text.js queryPlan，各带查询权重 qw）；
//   每个检索词：tf' = 3·tf(标题+路径) + 2·tf(标签) + tf(正文+更新记录)/(1 - b + b·len/avgLen)
//               s   = idf · qw · tf'·(k1+1)/(tf'+k1)            idf = ln(1 + (N-df+0.5)/(df+0.5))
//   覆盖率 c = 被命中「单元」（整词）的 idf 加权占比（长中文词按命中 bigram 的比例算部分覆盖）；
//   最终分 = Σs · (0.5 + c)，整句原样出现再 ×1.25（标题里 ×1.5）；有用 / 无关反馈 ×(1 ± 0.25·n)。
//   → 稀有的实体词（ASCII 词、少见词）因 IDF 自然加权；只命中通用词的卡分数低，同分大幅减少。
//
// 缓存：每个库一份内存索引（各字段小写文本 + 长度统计 + 检索词倒排的 LRU）。
// 每次查询先跑一条签名 SQL（卡数 / MAX(updated_at) / id 和 / 标题·标签·路径·正文长度和 / 更新记录数，1 万卡约 10ms），
// 签名变了就重建；另有 60 秒兜底过期，覆盖「同一毫秒内等长改写」这类签名看不到的变更（写路径也可调 invalidateIndex）。

import { getDb } from './db.js'
import { queryPlan } from './text.js'

const K1 = 1.2
const B = 0.75
const W_TITLE = 3
const W_TAGS = 2
const MAX_AGE_MS = 60_000
const POSTINGS_CACHE = 2000

const SIG_SQL = 'SELECT COUNT(*) n, MAX(updated_at) u, TOTAL(id) s, TOTAL(LENGTH(tags)) t, TOTAL(LENGTH(title)) ti, TOTAL(LENGTH(path)) p, TOTAL(LENGTH(body)) b FROM cards'
const UPD_SIG_SQL = 'SELECT COUNT(*) n, MAX(id) m FROM card_updates'

function parseTags(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.map((t) => String(t)) : [] } catch { return [] }
}

/** 一张卡 → 检索文档（只存小写字段与长度；原文按需回表）。 */
export function makeDoc(row, updatesText = '') {
  const tags = parseTags(row.tags)
  const body = String(row.body || '') + (updatesText ? '\n' + updatesText : '')
  return {
    path: row.path,
    t: `${row.title || ''}\n${row.path || ''}`.toLowerCase(),
    g: tags.join(' ').toLowerCase(),
    b: body.toLowerCase(),
    len: body.length,
  }
}

/** card_id → 更新记录正文（拼成一段）。 */
function updatesById(db) {
  const m = new Map()
  try {
    for (const u of db.prepare('SELECT card_id, content FROM card_updates ORDER BY created_at ASC').all()) {
      m.set(u.card_id, (m.has(u.card_id) ? m.get(u.card_id) + '\n' : '') + u.content)
    }
  } catch { /* 旧库无此表 */ }
  return m
}

/** 把任意一组行做成文档集（管理界面检索隔离区时用；行需含 id/path/title/tags/body）。 */
export function docsFromRows(db, rows) {
  const upd = updatesById(db)
  return makeCorpus(rows.map((r) => makeDoc(r, upd.get(r.id) || '')))
}

function makeCorpus(docs) {
  const total = docs.reduce((a, d) => a + d.len, 0)
  return { docs, avgLen: docs.length ? Math.max(1, total / docs.length) : 1, postings: new Map() }
}

function countIn(hay, term) {
  if (!hay) return 0
  let n = 0
  let i = hay.indexOf(term)
  while (i >= 0) { n++; i = hay.indexOf(term, i + term.length) }
  return n
}

/** 检索词的倒排：[[docIdx, tfTitle, tfTags, tfBody], ...]（按文档集缓存，LRU）。 */
function postingsOf(corpus, term) {
  const hit = corpus.postings.get(term)
  if (hit) { corpus.postings.delete(term); corpus.postings.set(term, hit); return hit }
  const list = []
  corpus.docs.forEach((d, i) => {
    const a = countIn(d.t, term), g = countIn(d.g, term), b = countIn(d.b, term)
    if (a || g || b) list.push([i, a, g, b])
  })
  corpus.postings.set(term, list)
  if (corpus.postings.size > POSTINGS_CACHE) corpus.postings.delete(corpus.postings.keys().next().value)
  return list
}

const idfOf = (n, df) => Math.log(1 + (n - df + 0.5) / (df + 0.5))

/**
 * 对文档集打分。返回按分数降序的 [{ i, score, coverage, matched:Set<term> }]。
 * @param opts.strict  严格模式（召回用）：idf 加权覆盖率 ≥ 0.5 或整句命中才算命中，挡住只沾到一个通用词 / 一个 bigram 的卡
 * @param opts.boost   (docIdx) → 额外乘子（反馈加权）
 */
export function scoreCorpus(corpus, query, { strict = false, boost = null } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const { units, terms } = queryPlan(q)
  const N = corpus.docs.length
  if (!q || !N || !terms.size) return []
  const acc = new Map()
  const termIdf = new Map()
  for (const [term, qw] of terms) {
    const list = postingsOf(corpus, term)
    const idf = idfOf(N, list.length)
    termIdf.set(term, idf)
    for (const [i, a, g, b] of list) {
      const d = corpus.docs[i]
      const tf = W_TITLE * a + W_TAGS * g + b / (1 - B + (B * d.len) / corpus.avgLen)
      const s = idf * qw * (tf * (K1 + 1)) / (tf + K1)
      const e = acc.get(i) || { i, raw: 0, matched: new Set() }
      e.raw += s
      e.matched.add(term)
      acc.set(i, e)
    }
  }
  // 单元的 idf：整词本身的 idf；长中文词再与其 bigram 的平均 idf 取大（整词极少出现时不至于被高估）
  // 全库都不出现的单元（拼错的词、库外的词）不计入覆盖率分母：否则一个错别字就会把所有结果挡掉
  const present = (t) => (corpus.postings.get(t)?.length || 0) > 0
  const unitW = units.map((u) => {
    if (!present(u.token) && !u.bigrams.some(present)) return 0
    return Math.max(termIdf.get(u.token) || 0, u.bigrams.length ? u.bigrams.reduce((a, g) => a + (termIdf.get(g) || 0), 0) / u.bigrams.length : 0) || 1e-6
  })
  const unitSum = unitW.reduce((a, b) => a + b, 0)
  if (unitSum <= 0) return []
  const multi = units.length > 1 || /[^\w\u4e00-\u9fff]/.test(q)
  const out = []
  for (const e of acc.values()) {
    let cov = 0
    units.forEach((u, k) => {
      let f = e.matched.has(u.token) ? 1 : 0
      if (!f && u.bigrams.length) f = u.bigrams.filter((g) => e.matched.has(g)).length / u.bigrams.length
      cov += unitW[k] * f
    })
    const coverage = cov / unitSum
    const d = corpus.docs[e.i]
    const phrase = multi && (d.t.includes(q) ? 1.5 : d.b.includes(q) || d.g.includes(q) ? 1.25 : 0)
    if (strict && coverage < 0.5 && !phrase) continue
    let score = e.raw * (0.5 + coverage) * (phrase || 1)
    if (boost) score *= boost(e.i)
    if (score > 0) out.push({ i: e.i, score: Math.round(score * 1000) / 1000, coverage, matched: e.matched })
  }
  out.sort((x, y) => y.score - x.score)
  return out
}

// ---- 主库索引缓存 ----
const indexes = new Map()

function signature(db) {
  const a = db.prepare(SIG_SQL).get()
  let u = { n: 0, m: 0 }
  try { u = db.prepare(UPD_SIG_SQL).get() } catch { /* 无表 */ }
  return `${a.n}|${a.u}|${a.s}|${a.t}|${a.ti}|${a.p}|${a.b}|${u.n}|${u.m}`
}

/** 主库（approved）检索索引：签名不变且未过期则复用。返回 { corpus, rows }，rows 与 corpus.docs 一一对应（不含正文）。 */
export function mainIndex(root, { now = Date.now() } = {}) {
  const db = getDb(root)
  const sig = signature(db)
  const cur = indexes.get(db)
  if (cur && cur.sig === sig && now - cur.builtAt < MAX_AGE_MS) return cur
  const rows = db.prepare('SELECT id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at FROM cards ORDER BY updated_at DESC').all()
  const upd = updatesById(db)
  const corpus = makeCorpus(rows.map((r) => makeDoc(r, upd.get(r.id) || '')))
  for (const r of rows) { r.bodyChars = String(r.body || '').length; delete r.body }
  const idx = { sig, builtAt: now, corpus, rows }
  indexes.set(db, idx)
  return idx
}

/** 让某个库的索引立即失效（写路径可调用；不调用也会在签名变化 / 60 秒后自动重建）。 */
export function invalidateIndex(root) {
  try { indexes.delete(getDb(root)) } catch { /* 库未打开 */ }
}
