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

// ---------------------------------------------------------------------------
// 快照系列前缀 + 日期段（GH #11）
//
// 旧实现要求「剥时间戳后的整条标题主干」全等，而真实班次快照标题的尾巴每次都不同，生产库上恒 0 命中。
// 改为「前缀归一键 + 证据 + 日期分段」：键是系列身份，前缀只用来展示，日期是时间线卡的分段单位。
//
// 前缀不能直接当身份：stripStamps() 剥时间后还会残留 `–` / `~` / `/` 之类分隔符，同一批次会写成
// `COMBO 值班 – UAE | …`、`COMBO 值班 ~ UAE | …`、`COMBO 值班 UAE | …` 三种，按前缀分组就把同一天
// 劈成三张时间线卡。所以身份用「前缀归一后的前 2 个词」，前缀本身只取桶内最常见的写法做标题。
// ---------------------------------------------------------------------------

/** 系列前缀的分隔符（取最早出现的一个；全角冒号已由 NFKC 归一成半角）。 */
const PREFIX_DELIMS = [':', '：', '—', '|', '-']
const EDGE_RE = /^[\s\-—_:：,，.。·|/]+|[\s\-—_:：,，.。·|/]+$/g
/** 前缀至少要有一个「非数字词」（2 字以上的字母/汉字），否则纯日期 / 序号就能把全库并成一组。 */
const WORD_RE = /[^\d\s\p{P}\p{S}]{2,}/u

/** 含非数字字符的「词」（纯数字 / 纯标点不算）。 */
const WORDLIKE_RE = /[^\d]/u
/** 系列身份只取前缀的前这么多个词。 */
const SERIES_KEY_WORDS = 2

/**
 * 快照系列身份 key：前缀归一（NFKC、小写、标点符号一律当分隔、折叠空白）后取前 2 个「词」。
 * 纯数字词跳过（`3.5 巡检` 这类前缀不能只剩 `3 5`）。同一批次的 `A – B` / `A ~ B` / `A/B` 因此同键。
 * 不合格返回 ''，该卡就不进快照批次。
 */
export function snapshotSeriesKey(prefix) {
  const words = String(prefix || '').normalize('NFKC').toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ')
    .filter((w) => w && WORDLIKE_RE.test(w))
  return words.slice(0, SERIES_KEY_WORDS).join(' ')
}

/**
 * 快照系列前缀（展示用）：先剥时间戳，再取第一个分隔符之前的部分。
 * 不合格（空，或剥完只剩日期 / 标点 / 单个字符）返回 ''，该卡就不进快照批次。
 */
export function snapshotPrefix(title) {
  const s = stripStamps(title)
  let cut = -1
  for (const d of PREFIX_DELIMS) {
    const i = s.indexOf(d)
    if (i >= 0 && (cut < 0 || i < cut)) cut = i
  }
  const head = (cut < 0 ? s : s.slice(0, cut)).replace(EDGE_RE, '').trim()
  return head && WORD_RE.test(head) ? head : ''
}

const pad2 = (x) => String(x).padStart(2, '0')

/**
 * 快照日期段：标题里的 YYYY-MM-DD / YYYYMMDD / MM-DD 归一成 `YYYY-MM-DD` / `MM-DD`；没有日期返回 ''。
 * 取标题里最早出现的日期（真实快照标题的时间戳在最前面）。
 */
export function snapshotDay(title) {
  const s = String(title || '').normalize('NFKC')
  let m = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`
  m = s.match(/(?:^|\D)(\d{4})(\d{2})(\d{2})(?!\d)/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/(?:^|\D)(\d{1,2})[/-](\d{1,2})(?!\d)/)
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= 31) return `${pad2(m[1])}-${pad2(m[2])}`
  return ''
}

/** 时间线卡标题：前缀 +（日期段）+ 「（时间线）」；一天一张，日期进标题才能幂等。 */
export function snapshotTimelineTitle(prefix, day) {
  return `${prefix}${day ? ' ' + day : ''}${TIMELINE_SUFFIX}`
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

/** 快照序列专用默认值（GH #11）。 */
export const SNAPSHOT_DEFAULTS = Object.freeze({
  maxPoints: 40, // 单序列上限，超出的旧卡留在原处不并入
  minAgeHours: 24, // 序列里最新一张至少这么旧才出建议（避免改写进行中的当天序列）
  bodyCorroborate: 0.15, // 既无共享实体也无共享标签时，正文相似度至少这么高才算同一系列
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

/** 快照证据信号：标签（去 raw）、实体（标题 + 正文前 800 字）、正文 bigram。 */
function snapshotFacts(c, o) {
  return {
    tags: new Set((c.tags || []).filter((t) => t !== 'raw').map(tagKey).filter(Boolean)),
    ent: extractEntities(`${c.title}\n${String(c.body || '').slice(0, 800)}`),
    body: bigramHashSet(String(c.body || '').slice(0, o.bodyLimit)),
  }
}

function overlapHits(a, b) { for (const x of a) if (b.has(x)) return true; return false }

/** 证据强度：共享标签比共享实体更有说服力（只用于在同一桶里挑最像的组）。 */
function evidenceScore(a, b) {
  let n = 0
  for (const x of a.tags) if (b.tags.has(x)) n += 3
  for (const x of a.ent) if (b.ent.has(x)) n += 2
  return n
}

/** 是否有证据：共享实体或共享标签；两者都没有则要求正文相似度 ≥ bodyCorroborate。 */
function corroborates(a, b, o) {
  if (overlapHits(a.tags, b.tags) || overlapHits(a.ent, b.ent)) return true
  return jaccardSets(a.body, b.body) >= o.bodyCorroborate
}

const snapshotTime = (c) => {
  const ms = Date.parse(String(c.updatedAt || c.createdAt || ''))
  return Number.isFinite(ms) ? ms : null
}

/** 桶内展示前缀：出现最多的写法（平手取短的、再取字典序小的），保证结果确定。 */
function displayPrefix(prefixes) {
  let best = ''
  let bestN = -1
  for (const [prefix, n] of prefixes) {
    const better = n > bestN || (n === bestN && (prefix.length < best.length
      || (prefix.length === best.length && prefix < best)))
    if (better) { best = prefix; bestN = n }
  }
  return best
}

/**
 * 周期性快照序列（GH #11）：同 kind + 同系列 key（前缀归一前 2 个词）+ 同日期段，且要证据佐证。
 *
 * 分组不再是「整条标题主干全等」，因为真实快照标题的尾巴每次都不同：
 *   1. 身份 = 前缀归一后的前 2 个词（前缀 = 剥掉时间戳后第一个分隔符之前的部分，必须含非数字词），
 *      展示用的前缀取桶内最常见写法 —— 分隔符残渣（`–` / `~` / `/`）不会再把同一天劈开；
 *   2. 同 key 内还要共享实体 / 共享标签（两者都空则要求正文相似度 ≥ 0.15）才算同一系列；
 *   3. 系列内再按日期（YYYY-MM-DD / MM-DD / YYYYMMDD）分段：一天一张时间线卡，只有 1 张的稀疏日归入不带日期的段（免得一天一张的日常快照被拆成每张一卡）；无日期退化成单段；
 *   4. 单序列最多 maxPoints 张（超出的旧卡留在原处），且最新一张要早于 minAgeHours 才出建议；
 *   5. 已有「（时间线）」卡的序列直接追加（哪怕只有 1 张新卡），保持幂等 + 可回滚；
 *   6. 同一天出现多张时间线卡（历史上被别的批次并过、或前缀写法漂移过）时，保留一张、其余作为附加成员
 *      一并返回，合并方按「### 原标题」逐段保留，不让一天一张的骨架散成多张。
 *
 * @param cards [{id,path,kind,title,body,tags,createdAt?,updatedAt?}]
 * @param opts {minSeries, maxPoints, minAgeHours, bodyCorroborate, maxSeries, now}
 * @returns [{stem, kind, day, count, first, last, timeline, members:[{id,path,title,createdAt}]}]
 *          `stem` 是展示用前缀（桶内最常见写法）；按张数降序、前缀与日期字典序；
 *          `maxSeries` 只截取最前面这么多个序列。
 */
export function planSnapshotSeries(cards, opts = {}) {
  const o = { ...TOPIC_DEFAULTS, ...SNAPSHOT_DEFAULTS, ...opts }
  const nowMs = o.now == null ? Date.now() : new Date(o.now).getTime()
  const maxPoints = Math.max(1, Math.floor(Number(o.maxPoints) || SNAPSHOT_DEFAULTS.maxPoints))
  const minAgeMs = Math.max(0, Number(o.minAgeHours) || 0) * 3_600_000
  const maxSeries = Number(o.maxSeries) > 0 ? Math.floor(Number(o.maxSeries)) : Infinity
  const chrono = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id - b.id

  // 时间线卡按 (kind, 系列 key) 归位，快照卡按 (kind, 系列 key, 日期) 归桶
  const timelines = new Map() // `${kind}\0${key}` -> [{card, day, used}]
  const groups = new Map() // `${kind}\0${key}` -> { prefixes: Map(前缀 -> 次数), byDay: Map(day -> cards[]) }
  const groupFor = (k) => {
    let g = groups.get(k)
    if (!g) { g = { prefixes: new Map(), byDay: new Map() }; groups.set(k, g) }
    return g
  }
  for (const c of cards) {
    const timeline = isTimelineTitle(c.title)
    if (!timeline && !hasTimestamp(c.title)) continue
    const prefix = snapshotPrefix(c.title)
    if (!prefix) continue
    const series = snapshotSeriesKey(prefix)
    if (!series) continue
    const k = `${c.kind}\u0000${series}`
    if (timeline) {
      if (!timelines.has(k)) timelines.set(k, [])
      timelines.get(k).push({ card: c, day: snapshotDay(c.title), used: false })
      continue
    }
    const g = groupFor(k)
    g.prefixes.set(prefix, (g.prefixes.get(prefix) || 0) + 1)
    const day = snapshotDay(c.title)
    if (!g.byDay.has(day)) g.byDay.set(day, [])
    g.byDay.get(day).push(c)
  }

  // 只有时间线卡、没有待归入快照的序列也要处理（同一天多张时间线卡需要合回一张）
  const keys = [...new Set([...groups.keys(), ...timelines.keys()])].sort()
  const out = []
  for (const key of keys) {
    const [kind] = key.split('\u0000')
    const g = groups.get(key) || { prefixes: new Map(), byDay: new Map() }
    const { byDay } = g
    const slots = timelines.get(key) || []
    const prefix = displayPrefix(g.prefixes) || (slots[0] ? stripStamps(slots[0].card.title) : '')
    // 日期段归一：MM-DD 与同年份的 YYYY-MM-DD 视为同一天（真实库里两种写法都出现过）
    const allDays = [...byDay.keys(), ...slots.map((s) => s.day)]
    const canonDay = (d) => (d && d.length === 5 ? allDays.find((x) => x && x.length === 10 && x.endsWith(d)) || d : d)
    // 同一天有 minSeries 张以上、或已经有当天时间线卡的日期才单独成段；其余稀疏日归入不带日期的段
    const days = [...new Set(allDays.map(canonDay))]
      .filter((d) => d && ((byDay.get(d) || []).length >= Math.max(2, o.minSeries) || slots.some((s) => !s.used && canonDay(s.day) === d)))
      .sort()
    const buckets = new Map(days.map((d) => [d, []]))
    const sparse = []
    for (const d of [...byDay.keys()].sort()) {
      const k = canonDay(d)
      if (days.includes(k)) buckets.get(k).push(...byDay.get(d))
      else sparse.push(...byDay.get(d))
    }
    // 不带日期的段：稀疏快照 + 已有无日期时间线卡都要走一遍（后者可能同一天有多张）
    if (sparse.length) buckets.set('', [...(buckets.get('') || []), ...sparse])
    if (slots.some((s) => s.day === '')) buckets.set('', buckets.get('') || [])
    // 稀疏段最后处理：它只能接最近一张已有时间线卡，不能抢走别的日期的专属卡
    const order = buckets.has('')
      ? [...[...buckets.keys()].filter((d) => d !== '').sort(), '']
      : [...buckets.keys()].sort()

    for (const day of order) {
      // 先找同一天的时间线卡，再退到没有日期的时间线卡；稀疏段则接到最近一张（都没用过才算）
      const free = slots.filter((s) => !s.used).sort((a, b) => a.card.id - b.card.id)
      const slot = day
        ? free.find((s) => canonDay(s.day) === day) || free.find((s) => !s.day) || null
        : free.find((s) => !s.day) || free.filter((s) => s.day).sort((a, b) => b.day.localeCompare(a.day))[0] || null
      // 同一天多出来的时间线卡：作为附加成员并进选中的那张，各自保留 ### 原标题（标记已用，不再重复处理）
      const extras = slot ? free.filter((s) => s !== slot && canonDay(s.day) === day) : []
      for (const e of extras) e.used = true
      const members = [...(buckets.get(day) || []), ...extras.map((e) => e.card)].sort(chrono)

      const clusters = []
      if (slot) {
        // 已有时间线卡：照旧直接追加，不再要求证据，也不再卡 minSeries
        clusters.push({ timeline: slot.card, members })
      } else {
        const seeds = []
        for (const c of members) {
          const f = snapshotFacts(c, o)
          let best = null; let bestScore = -1
          for (const cl of seeds) {
            if (!corroborates(cl.facts, f, o)) continue
            const s = evidenceScore(cl.facts, f)
            if (s > bestScore) { best = cl; bestScore = s }
          }
          if (!best) { best = { facts: f, members: [] }; seeds.push(best) }
          best.members.push(c)
        }
        clusters.push(...seeds)
      }

      for (const cl of clusters) {
        // 超上限：留在时间线上的取最新的 maxPoints 张，更旧的留在原处不并入
        const keep = cl.members.length > maxPoints ? cl.members.slice(cl.members.length - maxPoints) : cl.members
        const need = cl.timeline ? 1 : o.minSeries
        if (keep.length < need) continue
        const newest = keep[keep.length - 1]
        const newestMs = snapshotTime(newest)
        // 还在进行中（最新一张不到 minAgeHours）：先不动，免得每轮都改写同一天的时间线卡。
        // 只有时间线卡互相合并（extras）时不卡新鲜度：合回一张不会每轮反复改写。
        if (!extras.length && newestMs !== null && minAgeMs > 0 && nowMs - newestMs < minAgeMs) continue
        if (cl.timeline) slot.used = true
        const keeper = cl.timeline || newest
        out.push({
          stem: prefix, kind, day, count: keep.length,
          first: keep[0].createdAt || null, last: newest.createdAt || null,
          timeline: {
            id: keeper.id, path: keeper.path, title: keeper.title, existing: !!cl.timeline,
            newTitle: cl.timeline ? keeper.title : snapshotTimelineTitle(prefix, day),
          },
          members: keep.map((m) => ({ id: m.id, path: m.path, title: m.title, createdAt: m.createdAt || null })),
        })
      }
    }
  }
  const sorted = out.sort((a, b) => b.count - a.count
    || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)
    || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return Number.isFinite(maxSeries) ? sorted.slice(0, maxSeries) : sorted
}

/**
 * 同主题分组（多信号，纯函数，结果确定）：同 kind 内两两比较，得分达标的连边，取连通分量。
 * 保留卡 = 组内正文最长者（平手取 id 小的）。超过 maxGroup 的组只取与保留卡得分最高的 maxGroup-1 张。
 * 默认跳过「（时间线）」卡：它们标题只差日期、正文又高度相似，留下来才守得住「一天一张」；
 * 同一天多张时间线卡的合并交给 planSnapshotSeries。传 skipTimelines:false 可关掉。
 * @param opts.exclude Set<path>：不参与分组的卡（噪声 / 已在近重复组 / 快照序列里）
 * @returns [{canonical:{id,path,title}, members:[{id,path,title,score,title_sim,body_sim,tag_sim,entity_sim}]}]
 */
export function planTopicGroups(cards, opts = {}) {
  const o = { ...TOPIC_DEFAULTS, ...opts, weights: { ...TOPIC_DEFAULTS.weights, ...(opts.weights || {}) } }
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set()
  const skipTimelines = opts.skipTimelines !== false
  const items = cards
    .filter((c) => !exclude.has(c.path) && !(skipTimelines && isTimelineTitle(c.title)))
    .sort((a, b) => a.id - b.id).map((c) => prep(c, o))
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
