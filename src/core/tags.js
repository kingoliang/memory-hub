// memory-hub · 规范标签表（GH #5）。
//
// 问题：标签写入时不做归一，tidy 的规范写法只按「当天计数」挑，于是 `comfyui ↔ ComfyUI` 每天来回翻转；
// 蒸馏允许 8 个标签而 tidy 裁到 4 个，新卡第二天就被改。
//
// 做法：
//   - DB config 表持久化两张映射（JSON 对象，键都是 tagKey）：
//       tagCanon     归一键 → 规范写法（一旦选定不再按计数变化，只有管理员 rename/merge 或回滚能改）
//       tagSynonyms  归一键 → 目标规范写法（rename/merge 跨键时记录，如 `py → Python`）
//   - 写入（capture / ingest / 管理界面编辑）时 canonicalizeTags：先查同义，再查规范表；
//     规范表里没有 → 用库里已有写法（多者胜）并写入规范表；库里也没有 → 新写法本身成为规范写法。
//   - 每卡标签上限统一为一个配置项：环境变量 MEMORY_TAG_MAX（默认 6），蒸馏与 tidy 共用。

/** 归一键：NFKC + 小写 + 去掉空白/下划线/连字符/点/中点。 */
export const tagKey = (t) => String(t).normalize('NFKC').toLowerCase().replace(/[\s_\-·.]+/g, '')

export const TAG_CANON_KEY = 'tagCanon'
export const TAG_SYNONYMS_KEY = 'tagSynonyms'
export const DEFAULT_MAX_TAGS = 6
export const TAG_MAX_LEN = 30

/** 每卡标签上限（蒸馏 / tidy 共用）：MEMORY_TAG_MAX，1~20，默认 6。 */
export function resolveMaxTags(env = process.env) {
  const v = env?.MEMORY_TAG_MAX
  const n = Number(v)
  return v !== undefined && String(v).trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 20 ? n : DEFAULT_MAX_TAGS
}

function readMap(db, key) {
  let raw
  try { raw = db.prepare('SELECT value FROM config WHERE key = ?').get(key)?.value } catch { return {} }
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => k && typeof x === 'string' && x.trim()))
  } catch { return {} }
}

/** 读持久化的规范表与同义表（都是 {tagKey: 写法}）。 */
export function loadTagTables(db) {
  return { canon: readMap(db, TAG_CANON_KEY), synonyms: readMap(db, TAG_SYNONYMS_KEY) }
}

/** config 原始值（回滚文件记录「改动前」用；不存在为 null）。 */
export function readConfigRaw(db, key) {
  try { return db.prepare('SELECT value FROM config WHERE key = ?').get(key)?.value ?? null } catch { return null }
}

/** 写回 config 原始值；value=null 表示删除该键。 */
export function writeConfigRaw(db, key, value) {
  if (value === null || value === undefined) { db.prepare('DELETE FROM config WHERE key = ?').run(key); return }
  db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value)
}

/** 合并写入规范表 / 同义表：patch 的值为 null 表示删除该键。返回是否有变化。 */
export function patchTagTable(db, key, patch) {
  const cur = readMap(db, key)
  let changed = false
  for (const [k, v] of Object.entries(patch || {})) {
    if (!k) continue
    if (v === null) { if (k in cur) { delete cur[k]; changed = true } continue }
    if (cur[k] !== v) { cur[k] = v; changed = true }
  }
  if (changed) writeConfigRaw(db, key, Object.keys(cur).length ? JSON.stringify(cur) : null)
  return changed
}

function parseTagsJson(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [] } catch { return [] }
}

/** 库里（主库 + 隔离区）每个写法的出现次数。 */
export function tagUsage(db) {
  const counts = new Map()
  for (const table of ['cards', 'quarantine']) {
    let rows = []
    try { rows = db.prepare(`SELECT tags FROM ${table}`).all() } catch { continue }
    for (const r of rows) for (const t of parseTagsJson(r.tags)) { const s = t.trim(); if (s) counts.set(s, (counts.get(s) || 0) + 1) }
  }
  return counts
}

/** 变体里选规范写法：次数多者胜；平手 → 小写优先 → 连字符优先于空格 → 短者 → 字典序。 */
export function pickCanonical(variants, counts) {
  return [...variants].sort((a, b) =>
    (counts.get(b) || 0) - (counts.get(a) || 0)
    || (b === b.toLowerCase()) - (a === a.toLowerCase())
    || (!/\s/.test(b)) - (!/\s/.test(a))
    || a.length - b.length
    || (a < b ? -1 : a > b ? 1 : 0))[0]
}

/**
 * 写入时把标签归到规范写法。
 * @param tags 原始标签数组
 * @param opts {persist=true, maxTags, maxLen}：persist 时把新选定的规范写法写入 tagCanon（之后不再变）
 * @returns {{tags:string[], mapped:{from:string,to:string}[]}}
 */
export function canonicalizeTags(db, tags, { persist = true, maxTags, maxLen = TAG_MAX_LEN } = {}) {
  const { canon, synonyms } = loadTagTables(db)
  let usage = null
  const decided = {}
  const out = []
  const seen = new Set()
  const mapped = []
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = String(raw ?? '').trim().slice(0, maxLen)
    if (!t) continue
    let k = tagKey(t)
    if (!k) continue
    let target = synonyms[k] ?? null
    if (target) k = tagKey(target)
    let c = canon[k] ?? decided[k]
    if (!c) {
      usage ??= tagUsage(db)
      const variants = [...usage.keys()].filter((v) => tagKey(v) === k)
      c = variants.length ? pickCanonical(variants, usage) : (target || t)
      decided[k] = c
    }
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
    if (c !== t) mapped.push({ from: t, to: c })
  }
  if (persist && Object.keys(decided).length) patchTagTable(db, TAG_CANON_KEY, decided)
  return { tags: Number.isInteger(maxTags) ? out.slice(0, maxTags) : out, mapped }
}

/** 热门已有标签（主库，按出现次数降序；同键只取规范写法）：给蒸馏 prompt 复用。 */
export function topTags(db, limit = 40) {
  const { canon } = loadTagTables(db)
  const counts = new Map()
  let rows = []
  try { rows = db.prepare('SELECT tags FROM cards').all() } catch { return [] }
  for (const r of rows) for (const t of parseTagsJson(r.tags)) {
    if (t === 'raw') continue
    const k = tagKey(t)
    if (!k) continue
    const e = counts.get(k) || { n: 0, spell: new Map() }
    e.n++; e.spell.set(t, (e.spell.get(t) || 0) + 1)
    counts.set(k, e)
  }
  return [...counts.entries()]
    .filter(([, e]) => e.n >= 2)
    .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([k, e]) => canon[k] ?? pickCanonical([...e.spell.keys()], e.spell))
}
