// 知识图谱（M4，只读）：canvas 力导向图。节点 = 主库卡片，颜色 = kind，大小 = 度数；边 = [[链接]] / 共享标签 / 内容相似。
// 数据来自 GET /admin/api/graph（不含正文）；点击节点后才请求现有卡片详情接口取摘要。
// URL 哈希参数：focus=<card path> 邻域模式、tag、kind、limit。

import { h } from '../dom.js'
import { get } from '../api.js'
import { kindLabel, fmtNum, fmtDate } from '../format.js'
import { panel, notice, empty, kindBadge, tagChip, icon, pageHead } from '../ui.js'
import {
  EDGE_LABEL, kindColor, nodeRadius, filterGraph, searchMatches, adjacency, tagCounts,
  createLayout, stepLayout, runLayout, LAYOUT_DONE, fitView, screenToWorld, zoomAt, hitTest, topLabelIds, clampZoom,
} from '../graph-core.js'

const LIMITS = [200, 500, 800, 1500, 2000]
const DEFAULT_LIMIT = 800
const KIND_ORDER = ['project', 'knowledge', 'content', 'prompt', 'business', 'tool', 'mistake']

export default async function render(ctx) {
  const p = ctx.params
  const focus = p.get('focus') || ''
  const limit = LIMITS.includes(Number(p.get('limit'))) ? Number(p.get('limit')) : DEFAULT_LIMIT
  const st = { tag: p.get('tag') || '', kind: p.get('kind') || '', minWeight: 1, hideIsolated: false, types: new Set(['link', 'tag', 'similar']), kinds: null, search: '' }
  let data
  try {
    data = await get('graph', { focus, limit, depth: focus ? 2 : undefined })
  } catch (e) {
    if (e.status === 404 && focus) { ctx.go('#/graph'); return h('div') }
    throw e
  }
  ctx.setTitle('知识图谱')
  const nav = (patch) => {
    const q = new URLSearchParams()
    const next = { focus, limit: limit === DEFAULT_LIMIT ? '' : limit, ...patch }
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, String(v))
    ctx.go('#/graph' + (q.toString() ? '?' + q : ''))
  }

  // ---------- 状态 ----------
  const canvas = h('canvas', { class: 'graph-canvas', role: 'img', 'aria-label': `知识图谱画布（${fmtNum(data.stats.nodes)} 个节点；键盘：+ 放大，- 缩小，0 适应窗口，Esc 取消选中；也可用下方节点列表）`, tabindex: '0' })
  const tip = h('div', { class: 'graph-tip', hidden: true, role: 'tooltip' })
  const stage = h('div', { class: 'graph-stage' }, [canvas, tip])
  const side = h('aside', { class: 'graph-side', 'aria-live': 'polite' })
  const countEl = h('span', { class: 'sub graph-count' })
  const legendEl = h('div', { class: 'graph-legend' })

  let view = { zoom: 1, panX: 0, panY: 0 }
  let L = null // 布局
  let shown = { nodes: [], edges: [] }
  let adj = new Map()
  let maxDeg = 1
  let matches = null
  let selected = ''
  let hover = -1
  let labelIds = new Set()
  let dirty = true
  let raf = 0
  let fitted = false
  let w = 0
  let hgt = 0
  let colors = null

  const readColors = () => {
    const cs = getComputedStyle(document.documentElement)
    const v = (n, d) => cs.getPropertyValue(n).trim() || d
    colors = { text: v('--text', '#222'), muted: v('--muted', '#666'), line: v('--line-strong', '#ccc'), accent: v('--accent', '#2457d6'), surface: v('--surface', '#fff'), edge: v('--graph-edge', '#8a97ab'), link: v('--graph-link', '#2457d6') }
  }
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  const onScheme = () => { colors = null; dirty = true; kick() }
  mq?.addEventListener?.('change', onScheme)
  globalThis.addEventListener?.('mh-theme', onScheme) // 手动切换主题（theme.js 派发）

  // ---------- 过滤 / 重建布局 ----------
  function rebuild({ keepPositions = true, refit = false } = {}) {
    const prev = keepPositions && L ? new Map(L.nodes.map((n) => [n.id, { x: n.x, y: n.y }])) : null
    shown = filterGraph(data, { kinds: st.kinds, tag: st.tag, minWeight: st.minWeight, types: st.types, hideIsolated: st.hideIsolated })
    adj = adjacency(shown.edges)
    maxDeg = Math.max(1, ...shown.nodes.map((n) => n.degree))
    L = createLayout(shown.nodes, shown.edges, { prev })
    if (prev) L.alpha = 0.5
    else runLayout(L, 260) // 首次：预热后再展示，避免一开始满屏乱跳
    L.alpha = Math.max(L.alpha, prev ? 0.5 : 0.25)
    labelIds = topLabelIds(shown.nodes, shown.nodes.length <= 60 ? shown.nodes.length : 24)
    if (selected && !L.idx.has(selected)) { selected = ''; renderSide() }
    updateMatches()
    renderNodeList()
    countEl.textContent = `显示 ${fmtNum(shown.nodes.length)} 个节点 · ${fmtNum(shown.edges.length)} 条边` + (shown.nodes.length !== data.stats.nodes ? `（已过滤，共 ${fmtNum(data.stats.nodes)}）` : '')
    if (refit || !fitted) { fitNow() }
    dirty = true
    kick()
  }
  function fitNow() {
    if (!w || !hgt || !L) return
    view = fitView(L.nodes, w, hgt)
    fitted = true
    dirty = true
  }
  function updateMatches() {
    matches = searchMatches(shown.nodes, st.search, kindLabel)
    dirty = true
  }

  // ---------- 绘制 ----------
  // 缩放补偿：ctx 按 zoom 放大世界坐标，节点/描边/标签若按世界单位绘制会随缩放等比暴涨。
  // 节点屏幕半径 = 基础半径 × zoom^NODE_ZOOM_EXP（缓增），世界半径 = 屏幕半径 / zoom；描边/连线/标签字号按 1/zoom 保持屏幕恒定。
  const NODE_ZOOM_EXP = 0.2
  const radiusOf = (n) => nodeRadius(n.degree, maxDeg) * Math.pow(view.zoom, NODE_ZOOM_EXP - 1)
  function draw() {
    const ctx2 = canvas.getContext('2d')
    if (!ctx2 || !L) return
    if (!colors) readColors()
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1)
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx2.clearRect(0, 0, w, hgt)
    ctx2.save()
    ctx2.translate(view.panX, view.panY)
    ctx2.scale(view.zoom, view.zoom)
    const nodes = L.nodes
    const focusId = hover >= 0 ? nodes[hover]?.id : selected
    const nbrs = focusId ? adj.get(focusId) : null
    const dense = nodes.length > 80
    // 边
    for (const l of L.links) {
      const a = nodes[l.a]
      const b = nodes[l.b]
      const touch = focusId && (a.id === focusId || b.id === focusId)
      const dim = (focusId && !touch) || (matches && !(matches.has(a.id) || matches.has(b.id)))
      ctx2.globalAlpha = touch ? 0.95 : dim ? 0.05 : l.type === 'link' ? (dense ? 0.5 : 0.7) : dense ? 0.22 : 0.4
      ctx2.strokeStyle = touch ? colors.accent : l.type === 'link' ? colors.link : colors.edge
      ctx2.lineWidth = (touch ? 1.8 : l.type === 'link' ? 1.6 : 0.9) / view.zoom
      ctx2.setLineDash(l.type === 'similar' ? [5 / view.zoom, 4 / view.zoom] : l.type === 'tag' ? [] : [])
      ctx2.beginPath(); ctx2.moveTo(a.x, a.y); ctx2.lineTo(b.x, b.y); ctx2.stroke()
    }
    ctx2.setLineDash([])
    // 节点
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const r = radiusOf(n)
      const isSel = n.id === selected
      const isNb = !!nbrs && nbrs.has(n.id)
      const hit = !matches || matches.has(n.id)
      const faded = (focusId && n.id !== focusId && !isNb) || !hit
      ctx2.globalAlpha = faded ? 0.14 : 1
      ctx2.fillStyle = kindColor(n.kind)
      ctx2.beginPath(); ctx2.arc(n.x, n.y, r, 0, Math.PI * 2); ctx2.fill()
      ctx2.lineWidth = 1.4 / view.zoom // 与背景同色的细环：相邻节点不糊成一团
      ctx2.strokeStyle = colors.surface
      ctx2.stroke()
      if (isSel || i === hover || (matches && hit)) {
        if (isSel) { ctx2.save(); ctx2.globalAlpha = 0.22; ctx2.fillStyle = colors.accent; ctx2.beginPath(); ctx2.arc(n.x, n.y, r + 6 / view.zoom, 0, Math.PI * 2); ctx2.fill(); ctx2.restore() }
        ctx2.lineWidth = 2.4 / view.zoom
        ctx2.strokeStyle = isSel ? colors.text : colors.accent
        ctx2.beginPath(); ctx2.arc(n.x, n.y, r, 0, Math.PI * 2); ctx2.stroke()
      }
    }
    // 标签：特殊节点（选中/悬停/邻居/搜索命中）优先，其余按关联数从高到低；与已放置标签重叠的普通标签直接跳过，避免挤成一团
    ctx2.globalAlpha = 1
    const fs = 12 / view.zoom
    ctx2.font = `${fs}px system-ui, sans-serif`
    ctx2.textAlign = 'center'
    ctx2.textBaseline = 'top'
    const showAll = view.zoom > 3
    const cand = []
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const special = n.id === selected || i === hover || (nbrs && nbrs.has(n.id)) || (matches && matches.has(n.id))
      if (special || labelIds.has(n.id) || showAll) cand.push({ i, special: !!special, deg: shown.nodes[i]?.degree || 0 })
    }
    cand.sort((a, b) => (b.special - a.special) || (b.deg - a.deg))
    const placed = []
    const clash = (b) => placed.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y)
    let budget = 220
    for (const c of cand) {
      if (budget <= 0) break
      const n = nodes[c.i]
      const t = shown.nodes[c.i]?.title || n.id
      const txt = t.length > 18 ? t.slice(0, 17) + '…' : t
      const y = n.y + radiusOf(n) + 2
      const wd = ctx2.measureText(txt).width
      const box = { x: n.x - wd / 2 - 2, y, w: wd + 4, h: fs * 1.25 }
      if (!c.special && clash(box)) continue
      placed.push(box)
      ctx2.lineWidth = 3 / view.zoom
      ctx2.strokeStyle = colors.surface
      ctx2.globalAlpha = c.special ? 1 : 0.9
      ctx2.strokeText(txt, n.x, y)
      ctx2.fillStyle = colors.text
      ctx2.fillText(txt, n.x, y)
      budget--
    }
    ctx2.restore()
    ctx2.globalAlpha = 1
  }

  function frame() {
    raf = 0
    if (!canvas.isConnected) { cleanup(); return }
    let active = false
    if (L && L.alpha > LAYOUT_DONE) {
      stepLayout(L); stepLayout(L)
      active = true
      dirty = true
      if (L.alpha <= LAYOUT_DONE && !userMoved) fitNow()
    }
    if (dirty) { draw(); dirty = false }
    if (active) raf = requestAnimationFrame(frame)
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame) }
  let userMoved = false
  let ro = null
  function cleanup() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    ro?.disconnect()
    mq?.removeEventListener?.('change', onScheme)
    globalThis.removeEventListener?.('mh-theme', onScheme)
  }

  function resize() {
    const r = stage.getBoundingClientRect()
    const nw = Math.max(200, Math.round(r.width))
    const nh = Math.max(240, Math.round(r.height))
    if (nw === w && nh === hgt) return
    const first = !w
    w = nw; hgt = nh
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1)
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr)
    if (first || !userMoved) fitNow()
    dirty = true
    kick()
  }

  // ---------- 交互 ----------
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  const pick = (e) => { const s = pos(e); const wp = screenToWorld(view, s.x, s.y); return hitTest(L.nodes, wp.x, wp.y, radiusOf, 3 / view.zoom) }
  let drag = null
  canvas.addEventListener('pointerdown', (e) => {
    if (!L) return
    canvas.setPointerCapture?.(e.pointerId)
    const i = pick(e)
    const s = pos(e)
    drag = { mode: i >= 0 ? 'node' : 'pan', i, sx: s.x, sy: s.y, moved: false, panX: view.panX, panY: view.panY }
    if (i >= 0) { L.nodes[i].fixed = true }
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!L) return
    const s = pos(e)
    if (drag) {
      if (Math.abs(s.x - drag.sx) + Math.abs(s.y - drag.sy) > 3) drag.moved = true
      if (drag.mode === 'pan') { view = { ...view, panX: drag.panX + s.x - drag.sx, panY: drag.panY + s.y - drag.sy }; userMoved = true }
      else if (drag.moved) {
        const wp = screenToWorld(view, s.x, s.y)
        const n = L.nodes[drag.i]
        n.x = wp.x; n.y = wp.y; n.vx = 0; n.vy = 0
        L.alpha = Math.max(L.alpha, 0.3)
      }
      dirty = true; kick()
      return
    }
    const i = pick(e)
    if (i !== hover) { hover = i; dirty = true; kick() }
    if (i >= 0) {
      const n = shown.nodes[i]
      tip.textContent = ''
      tip.append(h('strong', null, n.title || n.id), h('span', null, ` ${kindLabel(n.kind)} · 关联 ${n.degree}`))
      tip.removeAttribute('hidden')
      tip.style.setProperty('left', Math.min(s.x + 14, w - 220) + 'px')
      tip.style.setProperty('top', Math.min(s.y + 14, hgt - 50) + 'px')
      canvas.style.setProperty('cursor', 'pointer')
    } else { tip.setAttribute('hidden', ''); canvas.style.setProperty('cursor', 'grab') }
  })
  const endDrag = () => {
    if (!drag) return
    if (drag.mode === 'node') {
      const n = L.nodes[drag.i]
      if (n) n.fixed = false
      if (!drag.moved) select(shown.nodes[drag.i].id)
    } else if (!drag.moved) { select('') }
    drag = null
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)
  canvas.addEventListener('pointerleave', () => { if (!drag) { hover = -1; tip.setAttribute('hidden', ''); dirty = true; kick() } })
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const s = pos(e)
    view = zoomAt(view, s.x, s.y, Math.exp(-e.deltaY * 0.0015))
    userMoved = true; dirty = true; kick()
  }, { passive: false })
  canvas.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') zoomBtn(1.25)
    else if (e.key === '-') zoomBtn(0.8)
    else if (e.key === '0') { userMoved = false; fitNow(); kick() }
    else if (e.key === 'Escape') select('')
  })
  function zoomBtn(f) { view = zoomAt(view, w / 2, hgt / 2, f); userMoved = true; dirty = true; kick() }

  function select(id) {
    selected = id
    dirty = true
    renderSide()
    kick()
  }
  function centerOn(id) {
    const i = L.idx.get(id)
    if (i === undefined) return
    const n = L.nodes[i]
    const z = clampZoom(Math.max(view.zoom, 1.4))
    view = { zoom: z, panX: w / 2 - n.x * z, panY: hgt / 2 - n.y * z }
    userMoved = true
  }

  // ---------- 右侧面板 ----------
  let sideToken = 0
  function renderSide() {
    const my = ++sideToken
    side.textContent = ''
    const n = selected ? shown.nodes[L.idx.get(selected)] : null
    if (!n) {
      side.append(h('div', { class: 'graph-side-empty' }, [
        h('strong', null, '点击节点查看卡片'),
        h('p', { class: 'sub' }, '悬停高亮关联；拖动节点可调整位置；拖动空白处平移，滚轮缩放。'),
        focus ? h('p', { class: 'sub' }, '当前为邻域模式（2 跳）。') : null,
      ]))
      return
    }
    const nbrIds = [...(adj.get(n.id) || [])]
    const excerpt = h('p', { class: 'graph-excerpt sub' }, '加载摘要…')
    side.append(
      h('div', { class: 'graph-side-head' }, [kindBadge(n.kind), h('h3', null, n.title || '（无标题）')]),
      n.tags.length ? h('div', { class: 'card-row-tags' }, n.tags.slice(0, 12).map((t) => tagChip(t))) : null,
      h('dl', { class: 'graph-facts' }, [
        h('dt', null, '关联数'), h('dd', null, String(n.degree)),
        h('dt', null, '更新'), h('dd', null, fmtDate(n.updatedAt)),
        h('dt', null, '创建'), h('dd', null, fmtDate(n.createdAt)),
      ]),
      excerpt,
      h('div', { class: 'graph-side-actions' }, [
        h('a', { class: 'btn btn-primary btn-sm', href: `#/card?path=${encodeURIComponent(n.id)}` }, '打开卡片详情'),
        h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => nav({ focus: n.id, tag: '', kind: '' }) } }, '以此为中心展开'),
      ]),
      nbrIds.length ? h('div', { class: 'graph-nbrs' }, [
        h('h4', null, `相邻卡片（${nbrIds.length}）`),
        h('ul', null, nbrIds.slice(0, 14).map((id) => {
          const m = shown.nodes[L.idx.get(id)]
          return h('li', null, h('button', { type: 'button', class: 'graph-nbr', on: { click: () => { select(id); centerOn(id); dirty = true; kick() } } }, [h('i', { class: 'gdot', css: { background: kindColor(m.kind) } }), m.title || id]))
        })),
        nbrIds.length > 14 ? h('p', { class: 'sub' }, `另有 ${nbrIds.length - 14} 张未列出`) : null,
      ]) : null,
    )
    get('card', { path: n.id }).then((d) => {
      if (my !== sideToken) return
      const t = String(d.body || '').replace(/\s+/g, ' ').trim()
      excerpt.textContent = t ? t.slice(0, 280) + (t.length > 280 ? '…' : '') : '（正文为空）'
    }).catch((e) => { if (my === sideToken) excerpt.textContent = '摘要加载失败：' + (e.message || e) })
  }

  // ---------- 工具栏 ----------
  // 主行：搜索 / 标签 / 节点上限 / 视图选项（折叠）。缩放等画布操作浮在画布右上角。
  const kindsPresent = KIND_ORDER.filter((k) => data.stats.byKind[k]).concat(Object.keys(data.stats.byKind).filter((k) => !KIND_ORDER.includes(k)))
  const search = h('input', { type: 'search', placeholder: '搜索标题 / 标签 / 类型', 'aria-label': '搜索节点（命中的节点会高亮）', autocomplete: 'off',
    on: { input: (e) => { st.search = e.target.value; updateMatches(); if (matches?.size === 1) { const id = [...matches][0]; centerOn(id) } kick() } } })
  const tagOpts = tagCounts(data.nodes)
  const tagSel = h('select', { 'aria-label': '按标签过滤', on: { change: (e) => { st.tag = e.target.value; rebuild() } } }, [
    h('option', { value: '' }, '全部标签'),
    ...tagOpts.map((t) => h('option', { value: t.tag, selected: t.tag === st.tag }, `${t.tag}（${t.n}）`)),
  ])
  if (st.tag && !tagOpts.some((t) => t.tag === st.tag)) tagSel.append(h('option', { value: st.tag, selected: true }, st.tag))
  const weightLbl = h('output', { class: 'graph-weight' }, '1')
  const weight = h('input', { type: 'range', min: '1', max: '4', step: '1', value: '1', 'aria-label': '最小边权重', on: { input: (e) => { st.minWeight = Number(e.target.value); weightLbl.textContent = String(st.minWeight); rebuild() } } })
  const isoBox = h('input', { type: 'checkbox', 'aria-label': '隐藏孤立点', on: { change: (e) => { st.hideIsolated = e.target.checked; rebuild() } } })
  const typeBox = (t) => h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: true, 'aria-label': EDGE_LABEL[t], on: { change: (e) => { if (e.target.checked) st.types.add(t); else st.types.delete(t); rebuild() } } }), h('span', null, EDGE_LABEL[t])])
  const limitSel = h('select', { 'aria-label': '最多节点数', on: { change: (e) => nav({ limit: Number(e.target.value) === DEFAULT_LIMIT ? '' : e.target.value }) } },
    LIMITS.map((n) => h('option', { value: String(n), selected: n === limit }, `最多 ${n} 节点`)))
  const zbtn = (label, fn, ic) => h('button', { type: 'button', class: 'graph-zbtn', title: label, 'aria-label': label, on: { click: fn } }, icon(ic))

  // 图例：kind 色块，点击切换显示该 kind（再点恢复）
  function drawLegend() {
    legendEl.textContent = ''
    for (const k of kindsPresent) {
      const on = !st.kinds || st.kinds.has(k)
      legendEl.append(h('button', { type: 'button', class: 'graph-lg' + (on ? '' : ' off'), 'aria-pressed': on ? 'true' : 'false', title: '点击仅显示/取消该类型',
        on: { click: () => {
          if (!st.kinds) st.kinds = new Set([k])
          else if (st.kinds.has(k) && st.kinds.size === 1) st.kinds = null
          else if (st.kinds.has(k)) st.kinds.delete(k)
          else st.kinds.add(k)
          drawLegend(); rebuild()
        } } }, [h('i', { class: 'gdot', css: { background: kindColor(k) } }), `${kindLabel(k)} ${data.stats.byKind[k]}`]))
    }
    legendEl.append(
      h('span', { class: 'graph-lg-sep' }),
      h('span', { class: 'sub' }, '圆点大小 = 关联数'),
      h('span', { class: 'sub graph-edge-key' }, [h('i', { class: 'ek ek-link' }), '[[链接]]', h('i', { class: 'ek ek-tag' }), '共享标签', h('i', { class: 'ek ek-sim' }), '内容相似']),
    )
  }
  drawLegend()
  if (st.kind) st.kinds = new Set([st.kind])

  const toolbar = h('div', { class: 'graph-toolbar' }, [
    h('div', { class: 'search-box graph-search' }, [icon('search'), search]),
    h('label', { class: 'graph-ctl' }, [h('span', null, '标签'), tagSel]),
    limitSel,
    h('details', { class: 'graph-opts' }, [
      h('summary', null, [icon('sliders', 'icon-sm'), '视图选项']),
      h('div', { class: 'graph-opts-body' }, [
        h('label', { class: 'graph-ctl' }, [h('span', null, '最小权重'), weight, weightLbl]),
        h('label', { class: 'check' }, [isoBox, h('span', null, '隐藏孤立点')]),
        h('div', { class: 'graph-types', role: 'group', 'aria-label': '显示的边类型' }, [typeBox('link'), typeBox('tag'), typeBox('similar')]),
      ]),
    ]),
  ])
  const zoomBar = h('div', { class: 'graph-zoom', role: 'group', 'aria-label': '画布缩放' }, [
    zbtn('放大（+）', () => zoomBtn(1.25), 'plus'), zbtn('缩小（-）', () => zoomBtn(0.8), 'minus'),
    zbtn('适应窗口（0）', () => { userMoved = false; fitNow(); kick() }, 'fit'),
    zbtn('重新布局', () => { L.alpha = 1; userMoved = false; kick() }, 'refresh'),
  ])
  stage.append(zoomBar)

  // 键盘 / 读屏可用的替代入口：按关联数排序的节点列表（画布本身依赖指针拖拽与悬停）
  const nodeListEl = h('div', { class: 'graph-nodelist' })
  function renderNodeList() {
    nodeListEl.textContent = ''
    const top = [...shown.nodes].sort((a, b) => b.degree - a.degree).slice(0, 40)
    if (!top.length) { nodeListEl.append(h('p', { class: 'sub' }, '当前过滤条件下没有节点。')); return }
    nodeListEl.append(h('ul', null, top.map((n) => h('li', null, h('button', { type: 'button', class: 'graph-nbr', on: { click: () => { select(n.id); centerOn(n.id); dirty = true; kick() } } }, [h('i', { class: 'gdot', css: { background: kindColor(n.kind) } }), h('span', { class: 'graph-nbr-title' }, n.title || n.id), h('span', { class: 'sub' }, `${kindLabel(n.kind)} · ${n.degree}`)])))))
    if (shown.nodes.length > top.length) nodeListEl.append(h('p', { class: 'sub' }, `仅列出关联数最高的 ${top.length} 个，共 ${fmtNum(shown.nodes.length)} 个；可用搜索或过滤缩小范围。`))
  }

  const head = pageHead('06', 'Graph', '知识图谱', `主库 ${fmtNum(data.stats.totalCards)} 张卡 · 边 = [[链接]] / 共享标签 Top-6 / 正文相似（≥0.42）· 只读`, [countEl, focus ? h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => nav({ focus: '' }) } }, '返回全图') : null])

  const root = h('div', { class: 'page graph-page' }, [
    head,
    data.truncated ? notice('warn', '节点过多，已按关联度截断', `匹配 ${fmtNum(data.stats.matchedNodes)} 个节点，仅显示关联度最高的 ${fmtNum(data.stats.nodes)} 个。可调高“最多节点数”，或用标签/类型/最小权重缩小范围。`) : null,
    panel(null, [toolbar, legendEl], { cls: 'panel-filters graph-controls' }),
    data.nodes.length === 0 ? empty('主库里还没有卡片', '图谱只展示已批准的卡片；沉淀并批准几张卡后这里会出现关系网络', h('a', { class: 'btn', href: '#/queue' }, '去待审队列'), 'graph') : h('div', { class: 'graph-layout' }, [stage, side]),
    data.nodes.length ? h('details', { class: 'fold graph-fold' }, [h('summary', null, [h('span', { class: 'fold-title' }, '节点列表（键盘 / 读屏替代入口）'), h('span', { class: 'sub' }, '按关联数排序，回车选中并定位')]), h('div', { class: 'fold-body' }, nodeListEl)]) : null,
  ])

  if (data.nodes.length) {
    ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null
    ro?.observe(stage)
    // 先同步算一版布局；容器挂载后（下一帧）再量尺寸并适配
    rebuild({ keepPositions: false })
    renderSide()
    requestAnimationFrame(() => { resize(); if (focus && L.idx.has(focus)) select(focus) })
  }
  return root
}
