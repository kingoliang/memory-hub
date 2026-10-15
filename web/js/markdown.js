// 最小 Markdown 子集：解析成 AST，再用 dom.js 的 h() 构造节点。
// 安全设计：输入里的 HTML 永远只是文本（不存在“原始 HTML”节点类型）；链接只允许 http(s)；
// 解析是线性/有界的（单个标记的闭合符号最多向后看 SCAN_LIMIT 个字符），病态输入不会拖死页面。
// 支持：# 标题、段落、- / 1. 列表、``` 代码块、> 引用、---、`行内代码`、**粗体**、*斜体*、[文字](http(s)链接)。

import { h } from './dom.js'

export const MAX_INPUT_CHARS = 200_000
const SCAN_LIMIT = 2000

/** 链接白名单：只放行 http(s)；剥掉控制字符/空白后再检查，挡 java\tscript: 之类的变形。 */
export function safeUrl(u) {
  const s = String(u ?? '').trim()
  const compact = s.replace(/[\u0000- \u007f-\u009f]/g, '')
  return /^https?:\/\/[^/\s]/i.test(compact) ? s : null
}

function findClose(text, from, closer) {
  // 只看 from 之后 SCAN_LIMIT 个字符的窗口：每次调用代价有上界，整体 O(n * SCAN_LIMIT)
  const j = text.slice(from, from + SCAN_LIMIT + closer.length).indexOf(closer)
  return j < 0 ? -1 : from + j
}

/** 行内解析：返回节点数组。 */
export function parseInline(text, depth = 0) {
  const out = []
  let buf = ''
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = '' } }
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '`') {
      const j = findClose(text, i + 1, '`')
      if (j > i + 1) { flush(); out.push({ type: 'code', text: text.slice(i + 1, j) }); i = j + 1; continue }
    } else if (c === '*' && text[i + 1] === '*' && depth < 3) {
      const j = findClose(text, i + 2, '**')
      if (j > i + 2) { flush(); out.push({ type: 'strong', children: parseInline(text.slice(i + 2, j), depth + 1) }); i = j + 2; continue }
    } else if (c === '*' && depth < 3 && text[i + 1] !== ' ' && text[i + 1] !== '*') {
      const j = findClose(text, i + 1, '*')
      if (j > i + 1 && text[j - 1] !== ' ') { flush(); out.push({ type: 'em', children: parseInline(text.slice(i + 1, j), depth + 1) }); i = j + 1; continue }
    } else if (c === '[' && depth < 3) {
      const close = findClose(text, i + 1, ']')
      if (close > i && text[close + 1] === '(') {
        const end = findClose(text, close + 2, ')')
        if (end > close + 1) {
          const label = text.slice(i + 1, close)
          const href = safeUrl(text.slice(close + 2, end))
          flush()
          if (href) out.push({ type: 'link', href, children: parseInline(label, depth + 1) })
          else out.push(...parseInline(label, depth + 1)) // 不安全链接：只保留文字
          i = end + 1
          continue
        }
      }
    }
    buf += c
    i++
  }
  flush()
  return out
}

/** 块级解析。 */
export function parseMarkdown(src, depth = 0) {
  let text = String(src ?? '')
  const truncated = text.length > MAX_INPUT_CHARS
  if (truncated) text = text.slice(0, MAX_INPUT_CHARS)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  let para = []
  const flushPara = () => { if (para.length) { blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) }); para = [] } }
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      flushPara()
      const buf = []
      i++
      const closeRe = new RegExp('^\\s{0,3}' + (fence[1][0] === '`' ? '`' : '~') + '{' + fence[1].length + ',}\\s*$')
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      blocks.push({ type: 'code', lang: fence[2] || '', text: buf.join('\n') })
      continue
    }
    const hd = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (hd) { flushPara(); blocks.push({ type: 'heading', level: hd[1].length, children: parseInline(hd[2]) }); i++; continue }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); blocks.push({ type: 'hr' }); i++; continue }
    if (depth < 4 && /^\s{0,3}>/.test(line)) {
      flushPara()
      const buf = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { buf.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++ }
      blocks.push({ type: 'quote', children: parseMarkdown(buf.join('\n'), depth + 1) })
      continue
    }
    const li = /^\s{0,6}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
    if (li) {
      flushPara()
      const ordered = /\d/.test(li[1])
      const items = []
      while (i < lines.length) {
        const m = /^\s{0,6}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i])
        if (!m || /\d/.test(m[1]) !== ordered) break
        items.push(parseInline(m[2]))
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    if (line.trim() === '') { flushPara(); i++; continue }
    para.push(line)
    i++
  }
  flushPara()
  if (truncated) blocks.push({ type: 'paragraph', children: [{ type: 'text', text: `（内容过长，已只渲染前 ${MAX_INPUT_CHARS} 个字符）` }] })
  return blocks
}

function inlineNodes(nodes) {
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return n.text
      case 'code': return h('code', null, n.text)
      case 'strong': return h('strong', null, inlineNodes(n.children))
      case 'em': return h('em', null, inlineNodes(n.children))
      case 'link': return h('a', { href: n.href }, inlineNodes(n.children))
      default: return ''
    }
  })
}

function blockNode(b) {
  switch (b.type) {
    case 'heading': return h('h' + Math.min(6, b.level + 1), { class: 'md-h' }, inlineNodes(b.children)) // 卡片标题已是 h1，正文标题整体降一级
    case 'paragraph': return h('p', null, inlineNodes(b.children))
    case 'list': return h(b.ordered ? 'ol' : 'ul', null, b.items.map((it) => h('li', null, inlineNodes(it))))
    case 'code': return h('pre', { class: 'md-code' }, h('code', null, b.text))
    case 'quote': return h('blockquote', null, b.children.map(blockNode))
    case 'hr': return h('hr')
    default: return ''
  }
}

/** 渲染为 DOM 节点（所有文本经 createTextNode，不走 HTML 解析）。 */
export function renderMarkdown(src) {
  return h('div', { class: 'md' }, parseMarkdown(src).map(blockNode))
}
