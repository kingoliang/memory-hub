// memory-hub · 检索 / 召回用的纯文本工具：剥离 Markdown、生成 summary、取命中词附近的片段。
// 全部是纯函数，不碰数据库。

/** summary 生成规则的版本号：规则变了就 +1，回填（backfillSummaries）据此判断要不要重算。 */
export const SUMMARY_VERSION = 1
export const SUMMARY_MAX = 200

/**
 * 剥离 Markdown 噪声，保留可读文字（换行保留，供分段 / 取片段用）。
 * 处理：围栏代码行标记、标题 #、引用 >、列表符号、表格竖线与分隔行、水平线、
 * 粗体 / 斜体 / 删除线 / 行内代码标记、[文字](链接)、![图](链接)、[[wikilink]]、HTML 标签。
 */
export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[A-Za-z][^>\n]*>/g, '')
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|?)+[ \t]*$\n?/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, ' ')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1')
    .replace(/`+([^`\n]*)`+/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase()

/**
 * summary：剥离 Markdown 后的首段有效文本（跳过与标题重复的行），≤ 200 字，按句界截断。
 * 为什么：旧实现是正文前 200 字，98% 以 `# 标题` 开头，片段里几乎没有信息。
 */
export function makeSummary(body, title = '', max = SUMMARY_MAX) {
  const t = norm(title)
  const lines = stripMarkdown(body).split('\n').map((l) => l.trim())
  const useful = lines.filter((l) => l && !(t && norm(l) === t))
  let out = ''
  for (const l of useful) {
    if (out.length >= max) break
    out += (out ? ' ' : '') + l
  }
  return cutAtBoundary(out, max)
}

const SENT_END = /[。！？；!?;]/

/** 截到 max 以内：优先句末，其次空白，最后硬切；被截时补「…」。 */
export function cutAtBoundary(s, max) {
  const str = String(s ?? '')
  if (str.length <= max) return str
  const floor = Math.floor(max * 0.6)
  for (let i = max - 1; i >= floor; i--) if (SENT_END.test(str[i])) return str.slice(0, i + 1)
  const ws = str.lastIndexOf(' ', max - 1)
  if (ws >= floor) return str.slice(0, ws).trimEnd() + '…'
  return str.slice(0, max - 1).trimEnd() + '…'
}

/**
 * 命中词附近的片段：在剥离 Markdown 的正文里选一个约 max 字的窗口，使它覆盖的查询词（按优先级加权）最多；
 * 同分取更靠前的。窗口起点对齐到句首 / 空白（只往后挪，不会把命中词挤出窗口），前后被截时加「…」。
 * 与标题完全相同的首行先去掉（它不提供新信息）。都不命中则退回 summary 式的开头。
 * @param {string} body
 * @param {string[]} terms 已按优先级排好（如整句 > 稀有词 > 常见词），小写
 */
export function snippetAround(body, terms, { max = 160, title = '' } = {}) {
  const t = norm(title)
  const lines = stripMarkdown(body).split('\n')
  while (lines.length && (!lines[0].trim() || (t && norm(lines[0]) === t))) lines.shift()
  const plain = lines.join(' ').replace(/\s+/g, ' ').trim()
  const lower = plain.toLowerCase()
  const list = [...new Set(terms.filter(Boolean))]
  const weight = new Map(list.map((x, k) => [x, list.length - k]))
  const occ = []
  for (const x of list) {
    for (let i = lower.indexOf(x), n = 0; i >= 0 && n < 50; i = lower.indexOf(x, i + x.length), n++) occ.push([i, x])
  }
  if (!occ.length) return makeSummary(body, title, max)
  if (plain.length <= max) return plain
  occ.sort((a, b) => a[0] - b[0])
  let best = null
  for (const [pos, x] of occ) {
    // 候选窗口：以这个命中开头附近（留一点前文）
    const start = Math.max(0, Math.min(pos - Math.floor(max / 5), plain.length - max))
    const end = start + max
    const seen = new Set()
    let score = 0
    for (const [p2, y] of occ) {
      if (p2 < start) continue
      if (p2 + y.length > end) break
      if (!seen.has(y)) { seen.add(y); score += weight.get(y) }
    }
    if (!best || score > best.score) best = { start, score, first: pos, firstLen: x.length }
  }
  let start = best.start
  if (start > 0) {
    // 往后对齐到句首 / 空白，但不越过窗口里的第一个命中
    const room = plain.slice(start, Math.min(best.first, start + 30))
    const k = room.search(/[。！？；!?;\s]/)
    if (k >= 0) start += k + 1
  }
  const end = Math.min(plain.length, start + max)
  return (start > 0 ? '…' : '') + plain.slice(start, end).trim() + (end < plain.length ? '…' : '')
}

const CJK = /[\u4e00-\u9fff]/

/** CJK 感知查询词：整词 + 中文字符 bigram（从 vault.js 迁来，vault.js 仍原样导出）。 */
export function queryTerms(query) {
  const q = String(query ?? '')
  const tokens = new Set(q.split(/[^\w\u4e00-\u9fff]+/).filter(Boolean))
  for (let i = 0; i < q.length - 1; i++) {
    if (CJK.test(q[i]) && CJK.test(q[i + 1])) tokens.add(q[i] + q[i + 1])
  }
  return tokens
}

/**
 * 查询计划：把查询拆成「单元」（空白 / 标点分隔的整词）与「检索词」（整词 + 整词内的中文 bigram），
 * 并给每个检索词一个查询权重 qw。规则：
 *   - 不含中文 bigram 的整词（英文词、单个汉字、两个汉字的词）：qw = 1；
 *   - 含 k 个 bigram 的长中文词：整词 qw = 0.5，每个 bigram 0.5/k —— 整词命中最好，命中一部分也有分。
 * 返回 { units: [{ token, bigrams[] }], terms: Map<term, qw> }，全部小写。
 */
export function queryPlan(query) {
  const q = String(query ?? '').toLowerCase()
  const units = []
  const terms = new Map()
  const add = (t, w) => terms.set(t, (terms.get(t) || 0) + w)
  for (const token of new Set(q.split(/[^\w\u4e00-\u9fff]+/).filter(Boolean))) {
    const grams = []
    for (let i = 0; i < token.length - 1; i++) {
      if (CJK.test(token[i]) && CJK.test(token[i + 1])) grams.push(token[i] + token[i + 1])
    }
    const bigrams = [...new Set(grams)].filter((g) => g !== token)
    units.push({ token, bigrams })
    if (!bigrams.length) { add(token, 1); continue }
    add(token, 0.5)
    for (const g of bigrams) add(g, 0.5 / bigrams.length)
  }
  return { units, terms }
}
