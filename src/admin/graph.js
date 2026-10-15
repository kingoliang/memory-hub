// memory-hub · 管理界面「知识图谱」数据层（M4）。只 SELECT，不写任何表，不改 schema。
//
// 语义沿用上游 memory-eternal 的 graph()（节点 = 主库卡片；边 = [[wikilink]] / 共享标签 Top-K / 正文相似），
// 详见 docs/m4-graph.md。输出约定与其它管理查询一致：卡片以 path 为键、标题过遮蔽、**绝不输出正文/摘要**。
//
// 只取主库 cards 表（status='approved' 且未软删）：隔离区（待审/驳回/回收站）的卡不入图。

import { getDb } from '../core/db.js'
import { KIND_ROOTS, bigramHashSet, jaccardSets } from '../core/vault.js'
import { minhashSignature, lshCandidates } from '../core/minhash.js'
import { redactSecrets } from '../core/tidy.js'

export const EDGE_TYPES = ['link', 'tag', 'similar']
export const GRAPH_DEFAULT_LIMIT = 800
export const GRAPH_MAX_LIMIT = 2000
/** 边权重：显式 [[链接]] 最强；正文相似次之；标签边 = 共享标签个数。 */
export const WEIGHT_LINK = 3
export const WEIGHT_SIMILAR = 2

// 与上游 vault.graph() 同值的建图参数
const TAG_TOPK = 6
const SIM_THRESHOLD = 0.42
const DF_CAP = 24
const RARE_CAP = 120
const CAND_CAP = 40
const MH_K = 48
const MH_BANDS = 24
const MH_ROWS = 2
/** 相似度只看正文前 N 字符（控制 ~700 卡规模下的建图耗时；tidy 预览同样截断）。 */
const SIM_BODY_CHARS = 4000
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

function parseTags(raw) {
  try {
    const v = JSON.parse(raw || '[]')
    if (Array.isArray(v)) return [...new Set(v.map((t) => String(t).trim()).filter(Boolean))]
  } catch { /* 非法 JSON：当作无标签 */ }
  return []
}

const isoOrNull = (s) => {
  if (!s) return null
  const str = String(s)
  const t = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(str) ? Date.parse(str.replace(' ', 'T') + 'Z') : Date.parse(str)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** 缓存指纹：任何写卡/改标签/改标题/改正文/审核/追加更新都会改变其中至少一项。 */
function fingerprint(db) {
  const c = db.prepare("SELECT COUNT(*) n, MAX(updated_at) m, SUM(id) s, SUM(LENGTH(tags)) t, SUM(LENGTH(title)) ti, SUM(LENGTH(body)) b FROM cards WHERE status = 'approved' AND deleted_at IS NULL").get()
  const log = db.prepare('SELECT MAX(id) id FROM audit_log').get()
  let upd = 0
  try { upd = db.prepare('SELECT MAX(id) id FROM card_updates').get().id || 0 } catch { /* 老库无此表 */ }
  return [c.n, c.m || '', c.s || 0, c.t || 0, c.ti || 0, c.b || 0, log.id || 0, upd].join('|')
}

/** 全量建图（不含过滤）。返回 { cards, edges, buildMs }。 */
function buildFull(db) {
  const t0 = Date.now()
  const rows = db.prepare("SELECT path, kind, title, tags, status, created_at, updated_at, body FROM cards WHERE status = 'approved' AND deleted_at IS NULL ORDER BY updated_at DESC, path").all()
  const cards = rows.map((r) => ({
    id: r.path, kind: r.kind, title: redactSecrets(r.title).text, rawTitle: r.title || '', tags: parseTags(r.tags), status: r.status,
    createdAt: isoOrNull(r.created_at), updatedAt: isoOrNull(r.updated_at),
  }))
  const byPath = new Map(cards.map((c) => [c.id, c]))
  const byTitle = new Map()
  const byBase = new Map()
  for (const c of cards) {
    if (c.rawTitle && !byTitle.has(c.rawTitle)) byTitle.set(c.rawTitle, c.id)
    const base = c.id.split('/').pop().replace(/\.md$/, '')
    if (!byBase.has(base)) byBase.set(base, c.id)
  }

  const edges = []
  const seen = new Set()
  const addEdge = (a, b, type, weight, extra = {}) => {
    const [x, y] = a < b ? [a, b] : [b, a]
    const key = `${x}\u0000${y}\u0000${type}`
    if (seen.has(key)) return false
    seen.add(key)
    edges.push({ source: x, target: y, type, weight, ...extra })
    return true
  }

  // ---- ① [[wikilink]] ----
  rows.forEach((r, i) => {
    const card = cards[i]
    for (const m of String(r.body || '').matchAll(WIKILINK_RE)) {
      const raw = m[1].trim().replace(/\.md$/, '')
      if (!raw) continue
      const root = KIND_ROOTS[card.kind] || KIND_ROOTS.knowledge
      const cand = [`${root}/${raw}.md`, `${KIND_ROOTS.knowledge}/${raw}.md`, `${raw}.md`].find((p) => p !== card.id && byPath.has(p))
      const target = cand || byTitle.get(raw) || byBase.get(raw)
      if (target && target !== card.id) addEdge(card.id, target, 'link', WEIGHT_LINK)
    }
  })

  // ---- ② 共享标签：按共享标签数取 Top-K（避免同标签全连接爆炸）----
  const tagIndex = new Map()
  for (const c of cards) for (const t of c.tags) {
    const arr = tagIndex.get(t)
    if (arr) arr.push(c.id); else tagIndex.set(t, [c.id])
  }
  const pairBest = new Map()
  for (const card of cards) {
    const weights = new Map()
    for (const tag of card.tags) for (const other of tagIndex.get(tag) || []) if (other !== card.id) weights.set(other, (weights.get(other) || 0) + 1)
    const ranked = [...weights.entries()].sort((x, y) => y[1] - x[1])
    for (const [other, w] of weights.size <= TAG_TOPK ? ranked : ranked.slice(0, TAG_TOPK)) {
      const [x, y] = card.id < other ? [card.id, other] : [other, card.id]
      const key = `${x}\u0000${y}`
      if ((pairBest.get(key) || 0) >= w) continue
      pairBest.set(key, w)
    }
  }
  for (const [key, w] of pairBest) {
    const [x, y] = key.split('\u0000')
    const yt = new Set(byPath.get(y).tags)
    addEdge(x, y, 'tag', w, { tags: byPath.get(x).tags.filter((t) => yt.has(t)).slice(0, 5) })
  }

  // ---- ③ 正文相似（Jaccard(bigram) ≥ 0.42，每卡至多 1 条；稀有 gram 倒排 + MinHash/LSH 取候选，再精确求交）----
  const hashes = new Map()
  const gramDf = new Map()
  rows.forEach((r, i) => {
    const s = bigramHashSet(String(r.body || '').slice(0, SIM_BODY_CHARS))
    hashes.set(cards[i].id, s)
    for (const g of s) gramDf.set(g, (gramDf.get(g) || 0) + 1)
  })
  const rareBy = new Map()
  const rareIndex = new Map()
  for (const c of cards) {
    const buckets = Array.from({ length: DF_CAP + 1 }, () => null)
    for (const g of hashes.get(c.id)) {
      const df = gramDf.get(g) || 0
      if (df > DF_CAP) continue
      ;(buckets[df] ||= []).push(g)
    }
    const rare = []
    for (let df = 1; df <= DF_CAP && rare.length < RARE_CAP; df++) {
      for (const g of buckets[df] || []) { rare.push(g); if (rare.length >= RARE_CAP) break }
    }
    rareBy.set(c.id, rare)
    for (const g of rare) { const a = rareIndex.get(g); if (a) a.push(c.id); else rareIndex.set(g, [c.id]) }
  }
  const sigs = new Map()
  for (const c of cards) sigs.set(c.id, minhashSignature(rareBy.get(c.id), MH_K))
  const lsh = lshCandidates(sigs, { bands: MH_BANDS, rows: MH_ROWS, maxPerCard: CAND_CAP })
  const used = new Set()
  const tagSet = new Map(cards.map((c) => [c.id, new Set(c.tags)]))
  const merged = new Map()
  for (const card of cards) {
    if (used.has(card.id)) continue
    merged.clear()
    for (const g of rareBy.get(card.id)) for (const o of rareIndex.get(g) || []) if (o !== card.id) merged.set(o, (merged.get(o) || 0) + 1)
    for (const o of lsh.get(card.id) || []) if (o !== card.id) merged.set(o, (merged.get(o) || 0) + 2)
    if (!merged.size) continue
    const ranked = [...merged.entries()].sort((x, y) => y[1] - x[1]).slice(0, CAND_CAP)
    const A = hashes.get(card.id)
    for (const [other] of ranked) {
      if (used.has(other)) continue
      const b = byPath.get(other)
      if (!b) continue
      if (b.kind !== card.kind && !card.tags.some((t) => tagSet.get(other).has(t))) continue // 跨 kind 必须至少共享一个标签
      const sim = jaccardSets(A, hashes.get(other), SIM_THRESHOLD)
      if (sim >= SIM_THRESHOLD) {
        addEdge(card.id, other, 'similar', WEIGHT_SIMILAR, { sim: Math.round(sim * 100) / 100 })
        used.add(card.id); used.add(other)
        break
      }
    }
  }
  return { cards, edges, buildMs: Date.now() - t0 }
}

const cache = new Map() // root -> { fp, full }

function getFull(root) {
  const db = getDb(root)
  const fp = fingerprint(db)
  const hit = cache.get(root)
  if (hit && hit.fp === fp) return { full: hit.full, cached: true }
  const full = buildFull(db)
  cache.set(root, { fp, full })
  if (cache.size > 4) cache.delete(cache.keys().next().value)
  return { full, cached: false }
}

export class GraphNotFound extends Error {
  constructor(message) { super(message); this.name = 'GraphNotFound' }
}

/**
 * @param {object} o { tags?:string[], kind?:string, types?:string[], minWeight?:number, focus?:string, depth?:number, hideIsolated?:boolean, limit?:number }
 * 处理顺序：kind/tag 选点 → 按类型/权重选边 → focus 邻域 → 去孤立点 → 按加权度数截断到 limit。
 */
export function graphQuery(root, o = {}) {
  const { full, cached } = getFull(root)
  const limit = o.limit ?? GRAPH_DEFAULT_LIMIT
  const minWeight = o.minWeight ?? 1
  const types = o.types?.length ? new Set(o.types) : null
  const tags = o.tags || []

  let focusCard = null
  if (o.focus) {
    focusCard = full.cards.find((c) => c.id === o.focus)
    if (!focusCard) throw new GraphNotFound('焦点卡片不在知识图谱中（不存在、已删除或在隔离区）')
  }

  const keep = (c) => (!o.kind || c.kind === o.kind) && tags.every((t) => c.tags.includes(t))
  let ids = new Set(full.cards.filter((c) => keep(c) || c === focusCard).map((c) => c.id))
  let edges = full.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.weight >= minWeight && (!types || types.has(e.type)))

  if (focusCard) {
    const adj = new Map()
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, []); adj.get(e.source).push(e.target)
      if (!adj.has(e.target)) adj.set(e.target, []); adj.get(e.target).push(e.source)
    }
    const reached = new Set([focusCard.id])
    let frontier = [focusCard.id]
    for (let d = 0; d < (o.depth ?? 1); d++) {
      const next = []
      for (const id of frontier) for (const n of adj.get(id) || []) if (!reached.has(n)) { reached.add(n); next.push(n) }
      frontier = next
    }
    ids = reached
    edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  }

  const wdeg = new Map()
  for (const e of edges) { wdeg.set(e.source, (wdeg.get(e.source) || 0) + e.weight); wdeg.set(e.target, (wdeg.get(e.target) || 0) + e.weight) }
  if (o.hideIsolated) for (const id of [...ids]) if (!wdeg.has(id) && id !== o.focus) ids.delete(id)

  const totalNodes = ids.size
  let nodesIn = full.cards.filter((c) => ids.has(c.id))
  let truncated = false
  if (nodesIn.length > limit) {
    truncated = true
    nodesIn = nodesIn
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (b.c.id === o.focus) - (a.c.id === o.focus) || (wdeg.get(b.c.id) || 0) - (wdeg.get(a.c.id) || 0) || a.i - b.i)
      .slice(0, limit).map((x) => x.c)
    const kept = new Set(nodesIn.map((c) => c.id))
    edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target))
  }

  const degree = new Map()
  for (const e of edges) { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1) }
  const nodes = nodesIn.map((c) => ({
    id: c.id, title: c.title, kind: c.kind, tags: c.tags, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt, degree: degree.get(c.id) || 0,
  }))
  const byKind = {}
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1
  const byType = { link: 0, tag: 0, similar: 0 }
  for (const e of edges) byType[e.type]++
  return {
    nodes, edges,
    truncated,
    stats: {
      totalCards: full.cards.length, matchedNodes: totalNodes, nodes: nodes.length, edges: edges.length,
      isolated: nodes.filter((n) => n.degree === 0).length, byKind, byType, limit, focus: o.focus || null,
      cached, buildMs: full.buildMs,
    },
  }
}

/** 测试用：清缓存。 */
export function resetGraphCache() { cache.clear() }
