// 共享 UI 组件。全部通过 dom.js 构造，文本一律经文本节点。

import { h, s } from './dom.js'
import { kindLabel, statusLabel, relTime, fmtDate, fmtNum, secretLabel } from './format.js'

const ICONS = {
  overview: 'M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6v-9h-6v9zm0-16v5h6V4h-6z',
  cards: 'M6 3h9l4 4v14H6V3zm8 1.5V8h3.5L14 4.5zM8.5 12h7M8.5 15.5h7M8.5 8.5h3',
  queue: 'M4 6h16M4 12h16M4 18h10',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  tag: 'M3 12V4h8l10 10-8 8L3 12zm5-4.5h.01',
  broom: 'M14 3l7 7-3 3-7-7 3-3zM11 6L3 14l4 4 8-8M6 17l-2 4',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  heart: 'M12 20s-8-4.8-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 9c0 6.2-8 11-8 11z',
  key: 'M14.5 9.5a4.5 4.5 0 11-2 3.7L4 21v-3h3v-3h3l2.2-2.2',
  log: 'M5 4h14v16H5V4zm3 4h8M8 12h8M8 16h5',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zm5 12l5 5',
  logout: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9',
  warn: 'M12 3l10 18H2L12 3zm0 7v5m0 3h.01',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 8v6m0-9h.01',
  check: 'M5 12l5 5 9-10',
  lock: 'M6 11h12v9H6v-9zm3 0V8a3 3 0 016 0v3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  moon: 'M20 14A8 8 0 0110 4a8 8 0 1010 10z',
}

export function icon(name, cls = '') {
  return s('svg', { class: 'icon ' + cls, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: ICONS[name] || ICONS.info }))
}

export const badge = (text, tone = 'neutral', title) => h('span', { class: `badge badge-${tone}`, title }, text)
export const kindBadge = (k) => h('span', { class: `badge kind kind-${k}` }, kindLabel(k))
export function statusBadge(st) {
  const tone = { approved: 'ok', pending: 'warn', rejected: 'bad', deleted: 'mute' }[st] || 'neutral'
  return badge(statusLabel(st), tone)
}
export const secretBadge = (types) => (types && types.length
  ? h('span', { class: 'badge badge-bad', title: '疑似含明文密钥：' + types.map(secretLabel).join('、') + '（界面已遮蔽具体值）' }, [icon('lock', 'icon-sm'), '疑似密钥 · ', types.map(secretLabel).join('、')])
  : null)

export const tagChip = (tag, href) => (href
  ? h('a', { class: 'tag', href }, tag)
  : h('span', { class: 'tag' }, tag))

export function panel(title, body, { actions, cls = '', sub } = {}) {
  return h('section', { class: 'panel ' + cls }, [
    title || actions ? h('header', { class: 'panel-head' }, [h('div', null, [h('h2', null, title), sub ? h('p', { class: 'sub' }, sub) : null]), actions ? h('div', { class: 'panel-actions' }, actions) : null]) : null,
    h('div', { class: 'panel-body' }, body),
  ])
}

export function stat(label, value, { hint, tone = '', href } = {}) {
  const inner = [h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, typeof value === 'number' ? fmtNum(value) : value), hint ? h('div', { class: 'stat-hint' }, hint) : null]
  return href ? h('a', { class: `stat stat-link ${tone}`, href }, inner) : h('div', { class: `stat ${tone}` }, inner)
}

export function notice(kind, title, text) {
  return h('div', { class: `notice notice-${kind}`, role: kind === 'bad' ? 'alert' : 'note' }, [icon(kind === 'bad' || kind === 'warn' ? 'warn' : 'info'), h('div', null, [title ? h('strong', null, title) : null, text ? h('p', null, text) : null])])
}

export const empty = (text, sub) => h('div', { class: 'empty' }, [h('div', { class: 'empty-art', 'aria-hidden': 'true' }, '∅'), h('p', null, text), sub ? h('p', { class: 'sub' }, sub) : null])
export const loading = (text = '加载中…') => h('div', { class: 'loading', role: 'status' }, [h('span', { class: 'spinner' }), text])
export function errorBlock(err) {
  return notice('bad', '加载失败', err?.message || String(err))
}

/** 水平条：值按 max 归一，宽度走 CSSOM 变量（CSP 允许）。 */
export function barRow(label, value, max, { tone = 'accent', href, suffix } = {}) {
  const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0
  const lab = href ? h('a', { class: 'bar-label', href }, label) : h('span', { class: 'bar-label' }, label)
  return h('div', { class: 'bar-row' }, [lab, h('div', { class: `bar bar-${tone}`, role: 'presentation' }, h('i', { css: { '--w': pct + '%' } })), h('span', { class: 'bar-value' }, [fmtNum(value), suffix || ''])])
}

/** 迷你折线/面积图（SVG）。points: [{label, value}] */
export function sparkline(points, { height = 90, label = '' } = {}) {
  const w = 600
  const max = Math.max(1, ...points.map((p) => p.value))
  const step = points.length > 1 ? w / (points.length - 1) : w
  const pad = 6
  const y = (v) => height - pad - (v / max) * (height - pad * 2)
  const pts = points.map((p, i) => `${(i * step).toFixed(1)},${y(p.value).toFixed(1)}`)
  const area = `0,${height} ${pts.join(' ')} ${w},${height}`
  const total = points.reduce((a, p) => a + p.value, 0)
  return h('figure', { class: 'chart' }, [
    s('svg', { class: 'spark', viewBox: `0 0 ${w} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${label}：合计 ${total}` }, [
      s('polygon', { points: area, class: 'spark-area' }),
      s('polyline', { points: pts.join(' '), class: 'spark-line', fill: 'none' }),
    ]),
    h('figcaption', null, [h('span', null, points[0]?.label || ''), h('span', null, `峰值 ${max} · 合计 ${fmtNum(total)}`), h('span', null, points[points.length - 1]?.label || '')]),
  ])
}

/** 双系列柱状图。series: [{label, a, b}]；a=沉淀(强调色)，b=召回(次色)。 */
export function dualBars(series, { height = 120, aLabel = '沉淀', bLabel = '召回' } = {}) {
  const w = 600
  const max = Math.max(1, ...series.map((d) => Math.max(d.a, d.b)))
  const slot = w / Math.max(1, series.length)
  const bw = Math.max(1.5, slot * 0.36)
  const bars = []
  series.forEach((d, i) => {
    const x = i * slot + slot * 0.1
    const ha = (d.a / max) * (height - 8)
    const hb = (d.b / max) * (height - 8)
    if (d.b > 0) bars.push(s('rect', { x: x.toFixed(1), y: (height - hb).toFixed(1), width: bw.toFixed(1), height: hb.toFixed(1), class: 'bar-b', rx: '1' }, s('title', null, `${d.label} ${bLabel} ${d.b}`)))
    if (d.a > 0) bars.push(s('rect', { x: (x + bw + 1).toFixed(1), y: (height - ha).toFixed(1), width: bw.toFixed(1), height: ha.toFixed(1), class: 'bar-a', rx: '1' }, s('title', null, `${d.label} ${aLabel} ${d.a}`)))
  })
  return h('figure', { class: 'chart' }, [
    s('svg', { class: 'dual', viewBox: `0 0 ${w} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `每日${aLabel}与${bLabel}` }, [s('line', { x1: '0', x2: String(w), y1: String(height - 0.5), y2: String(height - 0.5), class: 'axis' }), ...bars]),
    h('figcaption', null, [h('span', null, series[0]?.label || ''), h('span', { class: 'legend' }, [h('i', { class: 'dot dot-a' }), aLabel, h('i', { class: 'dot dot-b' }), bLabel, `（峰值 ${max}）`]), h('span', null, series[series.length - 1]?.label || '')]),
  ])
}

export function pager({ total, offset, limit }, go) {
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(total, offset + limit)
  const prevOff = Math.max(0, offset - limit)
  const nextOff = offset + limit
  return h('nav', { class: 'pager', 'aria-label': '分页' }, [
    h('span', { class: 'pager-info' }, `第 ${fmtNum(from)}–${fmtNum(to)} 条，共 ${fmtNum(total)} 条`),
    h('div', { class: 'pager-btns' }, [
      h('button', { type: 'button', class: 'btn btn-ghost', disabled: offset <= 0, on: { click: () => go(prevOff) } }, '上一页'),
      h('button', { type: 'button', class: 'btn btn-ghost', disabled: nextOff >= total, on: { click: () => go(nextOff) } }, '下一页'),
    ]),
  ])
}

export const timeEl = (iso) => h('time', { title: fmtDate(iso) }, relTime(iso))

/** 通用只读表格。cols: [{key,label,render?,cls?}] */
export function table(cols, rows, { cls = '', emptyText = '暂无数据' } = {}) {
  if (!rows.length) return empty(emptyText)
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table ' + cls }, [
    h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.cls || '' }, c.label)))),
    h('tbody', null, rows.map((r) => h('tr', null, cols.map((c) => h('td', { class: c.cls || '', 'data-label': c.label }, c.render ? c.render(r) : r[c.key] ?? '—'))))),
  ]))
}

export function cardLink(path, title) {
  return h('a', { class: 'card-link', href: `#/card?path=${encodeURIComponent(path)}` }, title || path)
}
