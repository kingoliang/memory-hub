// DOM 构造助手：所有字符串一律作为文本节点或属性值，永远不经过 HTML 解析。
// 不提供 innerHTML 路径；事件只能通过 on:{click: fn} 注册；style 只能通过 css:{prop: value}（CSSOM，CSP 允许）。
// 模块加载时不触碰 document / location（测试里用假 DOM 驱动）。

const SVG_NS = 'http://www.w3.org/2000/svg'
const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base', 'frame', 'frameset', 'applet', 'img', 'video', 'audio', 'source', 'foreignobject'])
const SVG_TAGS = new Set(['svg', 'path', 'g', 'rect', 'circle', 'line', 'polyline', 'polygon', 'text', 'title', 'defs', 'lineargradient', 'stop'])
const ALLOWED_ATTR = /^(?:class|id|href|title|type|value|placeholder|name|for|role|colspan|rowspan|disabled|checked|selected|readonly|required|rows|cols|min|max|step|maxlength|autocomplete|autofocus|target|rel|hidden|tabindex|open|aria-[\w-]+|data-[\w-]+|viewBox|width|height|d|x|y|x1|x2|y1|y2|rx|ry|cx|cy|r|fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-dasharray|points|transform|opacity|text-anchor|dominant-baseline|font-size|preserveAspectRatio|focusable|offset|stop-color|stop-opacity|fill-opacity|stroke-opacity)$/

/** 只放行 http(s) 链接（外链）与站内哈希路由（#/…）。其余一律丢弃。 */
export function safeHref(v) {
  const s = String(v ?? '').trim()
  if (s.startsWith('#/') || s === '#') return s
  const compact = s.replace(/[\u0000- \u007f-\u009f]/g, '')
  return /^https?:\/\//i.test(compact) ? s : null
}

function doc() {
  const d = globalThis.document
  if (!d) throw new Error('document 不可用')
  return d
}

function append(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return
  if (Array.isArray(child)) { for (const c of child) append(parent, c); return }
  if (typeof child === 'object' && child.nodeType) { parent.appendChild(child); return }
  parent.appendChild(doc().createTextNode(String(child)))
}

function build(ns, tag, attrs, children) {
  const lower = String(tag).toLowerCase()
  if (FORBIDDEN_TAGS.has(lower)) throw new Error(`不允许创建 <${tag}>`)
  const el = ns ? doc().createElementNS(SVG_NS, lower) : doc().createElement(lower)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'on') {
        for (const [evt, fn] of Object.entries(v)) {
          if (typeof fn !== 'function') throw new Error(`事件 ${evt} 必须是函数`)
          el.addEventListener(evt, fn)
        }
        continue
      }
      if (k === 'css') {
        for (const [prop, val] of Object.entries(v)) el.style.setProperty(prop, String(val))
        continue
      }
      if (/^on/i.test(k) || k === 'style' || k === 'src' || !ALLOWED_ATTR.test(k)) throw new Error(`不允许的属性：${k}`)
      if (k === 'href') {
        const safe = safeHref(v)
        if (safe === null) continue
        el.setAttribute('href', safe)
        if (!safe.startsWith('#')) { el.setAttribute('rel', 'noopener noreferrer nofollow'); el.setAttribute('target', '_blank') }
        continue
      }
      el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  append(el, children)
  return el
}

/** h('div', {class:'x', on:{click}}, '文本', h('span', null, '子节点')) */
export function h(tag, attrs, ...children) {
  return build(SVG_TAGS.has(String(tag).toLowerCase()) && String(tag).toLowerCase() !== 'title' ? true : false, tag, attrs, children)
}
/** SVG 元素（命名空间正确）。 */
export function s(tag, attrs, ...children) { return build(true, tag, attrs, children) }

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
  return el
}
export function mount(el, ...children) {
  clear(el)
  append(el, children)
  return el
}
export const frag = (...children) => { const f = doc().createDocumentFragment(); append(f, children); return f }
