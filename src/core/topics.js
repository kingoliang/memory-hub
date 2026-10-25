// memory-hub · 同主题分组与周期性快照识别（GH #4）。纯函数，不读写库。
//
// 旧的近重复判定只看「正文 bigram Jaccard」：蒸馏后的改写卡每次措辞不同，正文相似度远低于阈值，
// 于是同一主题的 24 张卡一组都并不起来。这里改为多信号：
//   标题相似度（去掉日期/时间/序号后的标题主干） + 正文相似度 + 标签重合 + 实体重合（型号 / 版本 / 驼峰名 / 缩写）。
// 周期性快照（同标题主干 + 标题里带时间戳）单独识别为「快照序列」，建议归入一张时间线卡。

import { bigramSet, bigramHashSet, jaccardSets } from './vault.js'
import { tagKey } from './tags.js'

// 日期 / 时间 / 序号模式（按从长到短的顺序剥离）
const STAMP_PATTERNS = [
  /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:[ T_]\d{1,2}[:：时]\d{2}(?:[:：分]\d{2})?秒?)?(?:Z|[+-]\d{2}:?\d{2})?/g, // 2026-10-25 14:30
  /\b\d{8}(?:[T_-]?\d{4,6})?\b/g, // 20261025 / 20261025-1430
  /\d{1,2}月\d{1,2}日(?:\s*\d{1,2}[:：时]\d{2})?/g, // 10月25日 14:30
  /\b\d{1,2}[/-]\d{1,2}\b(?:\s+\d{1,2}:\d{2})?/g, // 10/25 14:30
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g, // 14:30
  /(?:第\s*\d+\s*[次轮期班]|#\d+|\bv?\d+(?:\.\d+){0,2}\s*(?:次|轮))/g, // 第3次 / #12
  /(?:周[一二三四五六日天]|星期[一二三四五六日天]|今天|昨天|早班|晚班|夜班|上午|下午|凌晨)/g,
]
const HAS_STAMP_RE = /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}|\b\d{8}\b|\d{1,2}月\d{1,2}日|\b\d{1,2}[/-]\d{1,2}\b|\b\d{1,2}:\d{2}\b|第\s*\d+\s*[次轮期班]|#\d+/

/** 标题里是否带时间戳 / 序号（快照特征）。 */
export const hasTimestamp = (title) => HAS_STAMP_RE.test(String(title || ''))

export const TIMELINE_SUFFIX = '（时间线）'
const TIMELINE_RE = /[（(]时间线[)）]\s*$/

/** 是否是 tidy 生成的时间线卡（标题以「（时间线）」结尾）。 */
export const isTimelineTitle = (title) => TIMELINE_RE.test(String(title || ''))

/** 剥掉日期/时间/序号（保留大小写），收尾空白/分隔符折叠。 */
export function stripStamps(title) {
  let s = String(title || '').normalize('NFKC').replace(TIMELINE_RE, '')
  for (const re of STAMP_PATTERNS) s = s.replace(re, ' ')
  return s.replace(/[()（）[\]【】]\s*[()（）[\]【】]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-—_:：,，.。·|/]+|[\s\-—_:：,，.。·|/]+$/g, '').trim()
}

/** 标题主干：剥掉日期/时间/序号、时间线后缀与标点后的部分（小写，空白折叠）。 */
export function titleStem(title) {
  return stripStamps(title).replace(/[()（）[\]【】<>《》「」]/g, ' ').replace(/[\s\-—_:：,，.。·|/]+/g, ' ').trim().toLowerCase()
}

/** 时间线卡标题：快照标题去掉时间戳 + 「（时间线）」。 */
export function timelineTitle(title) {
  const base = stripStamps(title) || String(title || '').trim() || '快照'
  return base + TIMELINE_SUFFIX
}

const ENTITY_RE = /[A-Za-z][A-Za-z0-9+_.-]*\d[A-Za-z0-9+_.-]*|\d+[A-Za-z][A-Za-z0-9+_.-]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*|\b[A-Z]{2,}[A-Z0-9]*\b/g
const ENTITY_STOP = new Set(['md', 'api', 'url', 'json', 'http', 'https', 'todo', 'ok', 'id', 'ui', 'ai', 'llm', 'cli'])

/** 实体：型号 / 版本 / 驼峰名 / 全大写缩写（小写去重）。只看标题和正文前 2000 字。 */
export function extractEntities(text) {
  const out = new Set()
  for (const m of String(text || '').slice(0, 2000).matchAll(ENTITY_RE)) {
    const e = m[0].replace(/[.\-_]+$/, '').toLowerCase()
    if (e.length >= 3 && !ENTITY_STOP.has(e) && !/^\d+$/.test(e)) out.add(e)
  }
  return out
}

function setJaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export const TOPIC_DEFAULTS = Object.freeze({
  threshold: 0.5, // 综合得分阈值
  titleStrong: 0.8, // 标题主干相似度达到这个值，且另有一项佐证（正文/标签/实体）即同主题
  weights: { title: 0.45, body: 0.25, tags: 0.15, entities: 0.15 },
  bodyLimit: 4000,
  minSeries: 3, // 快照序列至少几张
  maxGroup: 50, // 单组上限（防止链式把整库并成一组）
})

function prep(c, o) {
  const stem = titleStem(c.title)
  return {
    c,
    stem,
    stamped: hasTimestamp(c.title),
    titleSet: bigramSet(stem),
    bodySet: bigramHashSet(String(c.body || '').slice(0, o.bodyLimit)),
    tagSet: new Set((c.tags || []).filter((t) => t !== 'raw').map(tagKey).filter(Boolean)),
    entSet: extractEntities(`${c.title}\n${c.body || ''}`),
  }
}

/** 两张卡的多信号相似度（返回各分量 + 综合分 + 是否同主题）。 */
export function topicSimilarity(a, b, opts = {}) {
  const o = { ...TOPIC_DEFAULTS, ...opts, weights: { ...TOPIC_DEFAULTS.weights, ...(opts.weights || {}) } }
  const pa = a.titleSet ? a : prep(a, o)
  const pb = b.titleSet ? b : prep(b, o)
  const title = jaccardSets(pa.titleSet, pb.titleSet)
  const tags = setJaccard(pa.tagSet, pb.tagSet)
  const entities = setJaccard(pa.entSet, pb.entSet)
  const w = o.weights
  // 剪枝：正文满分也到不了阈值、且标题不够强 → 不算正文
  const cheap = w.title * title + w.tags * tags + w.entities * entities
  const needBody = cheap + w.body >= o.threshold || title >= o.titleStrong
  const body = needBody ? jaccardSets(pa.bodySet, pb.bodySet) : 0
  const score = cheap + w.body * body
  const corroborated = body >= 0.15 || tags > 0 || entities > 0
  const same = score >= o.threshold || (title >= o.titleStrong && corroborated)
  return { title, body, tags, entities, score, same }
}

const round2 = (x) => Math.round(x * 100) / 100

/**
 * 周期性快照序列：同 kind + 同标题主干 + 标题带时间戳，且至少 minSeries 张。
 * @param cards [{id,path,kind,title,body,tags,updatedAt?}]
 * @returns [{stem, kind, count, first, last, members:[{id,path,title}]}]（按张数降序、主干字典序）
 */
export function planSnapshotSeries(cards, opts = {}) {
  const o = { ...TOPIC_DEFAULTS, ...opts }
  const byStem = new Map()
  const timelines = new Map()
  for (const c of cards) {
    const timeline = isTimelineTitle(c.title)
    if (!timeline && !hasTimestamp(c.title)) continue
    const stem = titleStem(c.title)
    if (stem.replace(/\s/g, '').length < 2) continue
    const k = `${c.kind}\u0000${stem}`
    if (timeline) { const t = timelines.get(k); if (!t || c.id < t.id) timelines.set(k, c); continue }
    if (!byStem.has(k)) byStem.set(k, [])
    byStem.get(k).push(c)
  }
  const out = []
  for (const [k, members] of byStem) {
    const timeline = timelines.get(k) || null
    // 已有时间线卡：哪怕只有 1 张新快照也归进去；还没有：至少 minSeries 张才建议聚合
    if (members.length < (timeline ? 1 : o.minSeries)) continue
    const [kind, stem] = k.split('\u0000')
    members.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id - b.id)
    const keeper = timeline || members[members.length - 1]
    out.push({
      stem, kind, count: members.length,
      first: members[0].createdAt || null, last: members[members.length - 1].createdAt || null,
      timeline: { id: keeper.id, path: keeper.path, title: keeper.title, existing: !!timeline, newTitle: timeline ? keeper.title : timelineTitle(keeper.title) },
      members: members.map((m) => ({ id: m.id, path: m.path, title: m.title, createdAt: m.createdAt || null })),
    })
  }
  return out.sort((a, b) => b.count - a.count || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0))
}

/**
 * 同主题分组（多信号，纯函数，结果确定）：同 kind 内两两比较，得分达标的连边，取连通分量。
 * 保留卡 = 组内正文最长者（平手取 id 小的）。超过 maxGroup 的组只取与保留卡得分最高的 maxGroup-1 张。
 * @param opts.exclude Set<path>：不参与分组的卡（噪声 / 已在近重复组 / 快照序列里）
 * @returns [{canonical:{id,path,title}, members:[{id,path,title,score,title_sim,body_sim,tag_sim,entity_sim}]}]
 */
export function planTopicGroups(cards, opts = {}) {
  const o = { ...TOPIC_DEFAULTS, ...opts, weights: { ...TOPIC_DEFAULTS.weights, ...(opts.weights || {}) } }
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set()
  const items = cards.filter((c) => !exclude.has(c.path)).sort((a, b) => a.id - b.id).map((c) => prep(c, o))
  const parent = items.map((_, i) => i)
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const byKind = new Map()
  items.forEach((it, i) => { if (!byKind.has(it.c.kind)) byKind.set(it.c.kind, []); byKind.get(it.c.kind).push(i) })
  for (const idx of byKind.values()) {
    for (let x = 0; x < idx.length; x++) {
      for (let y = x + 1; y < idx.length; y++) {
        const i = idx[x]; const j = idx[y]
        if (find(i) === find(j)) continue
        if (topicSimilarity(items[i], items[j], o).same) parent[find(j)] = find(i)
      }
    }
  }
  const comps = new Map()
  items.forEach((_, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(i) })
  const groups = []
  for (const members of comps.values()) {
    if (members.length < 2) continue
    members.sort((a, b) => String(items[b].c.body || '').length - String(items[a].c.body || '').length || items[a].c.id - items[b].c.id)
    const head = items[members[0]]
    const rest = members.slice(1).map((i) => ({ it: items[i], s: topicSimilarity(head, items[i], o) }))
      .sort((a, b) => b.s.score - a.s.score || a.it.c.id - b.it.c.id)
      .slice(0, o.maxGroup - 1)
    groups.push({
      canonical: { id: head.c.id, path: head.c.path, title: head.c.title },
      members: rest.map(({ it, s }) => ({
        id: it.c.id, path: it.c.path, title: it.c.title,
        score: round2(s.score), title_sim: round2(s.title), body_sim: round2(s.body), tag_sim: round2(s.tags), entity_sim: round2(s.entities),
      })),
    })
  }
  return groups.sort((a, b) => b.members.length - a.members.length || a.canonical.id - b.canonical.id)
}

/**
 * capture 邻居打分：标题/实体/标签/关键词多信号，比只数关键词命中更能召回「同主题」卡。
 * @param draft {title, body, tags?}
 * @param existing [{path,title,summary,body?,tags?}]
 */
export function neighborScore(draft, existing, wantedTerms) {
  const dTitle = bigramSet(titleStem(draft.title || String(draft.body || '').split('\n')[0].slice(0, 80)))
  const eTitle = bigramSet(titleStem(existing.title))
  const dEnt = draft._ent ?? extractEntities(`${draft.title || ''}\n${draft.body || ''}`)
  const eEnt = extractEntities(`${existing.title}\n${existing.summary || ''}\n${String(existing.body || '').slice(0, 1500)}`)
  const target = `${existing.title}\n${existing.summary || ''}`.toLowerCase()
  let kw = 0
  for (const term of wantedTerms) if (target.includes(term)) kw++
  const kwNorm = wantedTerms.size ? kw / Math.min(wantedTerms.size, 30) : 0
  const title = jaccardSets(dTitle, eTitle)
  const ent = setJaccard(dEnt, eEnt)
  let entHits = 0
  for (const e of dEnt) if (eEnt.has(e)) entHits++
  return { score: 3 * title + 2 * ent + Math.min(1, kwNorm) + 0.25 * Math.min(entHits, 4), title, ent, kw }
}
