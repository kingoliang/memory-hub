// 知识图谱（M4，只读）：暗色霓虹簇云风格的 canvas 力导向图。
// 簇 = 卡片 kind（= 主库顶级目录）；每簇一个霓虹主题色，簇内细密半透明纤维线，簇间留白；节点为细小的点，枢纽带发光。
// 数据来自 GET /admin/api/graph（不含正文）；点击节点后才请求现有卡片详情接口取摘要。
// 交互：点节点 → 向邻居辐射点状虚线 + 邻居小矩形标签、其余变暗；点簇名/簇 → 相机缓动飞到该簇、其余变暗；点空白恢复。
// URL 哈希参数：focus=<card path> 邻域模式、tag、kind、limit。

import { h } from '../dom.js'
import { get } from '../api.js'
import { createSpider } from '../graph-spider.js'
import { createSpiderSearch } from '../graph-spider-ui.js'
import { visibleBox, viewToCam, camToView, followStep, fitPoints, boxCenter } from '../graph-camera.js'
import { kindLabel, fmtNum, fmtDate } from '../format.js'
import { panel, notice, empty, kindBadge, tagChip, icon, pageHead } from '../ui.js'
import { s as svg } from '../dom.js'
import {
  EDGE_LABEL, searchMatches, adjacency, tagCounts,
  createLayout, LAYOUT_DONE, fitView, screenToWorld, zoomAt, hitTest, topLabelIds, clampZoom, filterGraph,
} from '../graph-core.js'

const LIMITS = ['auto', 200, 500, 800, 1500, 2000, 3000, 5000]
const DEFAULT_LIMIT = 'auto'
/** 规范化 limit：URL 里只认 'auto' 或 LIMITS 里的数字，其余回落到自动（= 不带参数）。 */
const normLimit = (raw) => { const n = Number(raw); return LIMITS.includes(n) ? n : DEFAULT_LIMIT }
const KIND_ORDER = ['project', 'knowledge', 'content', 'prompt', 'business', 'tool', 'mistake']
/** 簇主题色（霓虹：青 / 紫 / 黄 / 品红 / 橙 / 薄荷 / 红）。画布恒为深色，与全站主题无关。 */
const NEON = { project: '#2ee6ff', knowledge: '#b47bff', content: '#ffd23f', prompt: '#ff4fd8', business: '#ff8a2b', tool: '#3dffb0', mistake: '#ff4d5e', other: '#8b93a7' }
const neon = (k) => NEON[k] || NEON.other
const BG = '#05060a'
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace'

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r},${g},${b},${a})` }
const mixWhite = (c, t) => { const [r, g, b] = hex(c); const m = (v) => Math.round(v + (255 - v) * t); return `rgb(${m(r)},${m(g)},${m(b)})` }
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)

// 发光精灵：径向渐变一次性预渲染，之后只 drawImage（几千节点也不逐点 shadowBlur）
const spriteCache = new Map()
function glowSprite(color, size = 64) {
  const key = color + size
  let c = spriteCache.get(key)
  if (c) return c
  c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size })
  const g = c.getContext('2d')
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gr.addColorStop(0, rgba(color, 0.95)); gr.addColorStop(0.18, rgba(color, 0.55)); gr.addColorStop(0.5, rgba(color, 0.16)); gr.addColorStop(1, rgba(color, 0))
  g.fillStyle = gr; g.fillRect(0, 0, size, size)
  spriteCache.set(key, c)
  return c
}

// ---------------------------------------------------------------------------
// 簇布局：簇中心确定性打包（互不重叠 + 留白），簇内力导向（网格近邻斥力 + 弹簧 + 向簇心的引力）。O(n·k)，几千节点可跑。
// ---------------------------------------------------------------------------
function buildClusters(nodes) {
  const by = new Map()
  nodes.forEach((n, i) => { const k = n.kind || 'other'; if (!by.has(k)) by.set(k, []); by.get(k).push(i) })
  const rank = (k) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? 99 : i }
  const cls = [...by.entries()].map(([key, idxs]) => ({ key, idxs, n: idxs.length, color: neon(key), tint: mixWhite(neon(key), 0.72), R: 13 * Math.sqrt(idxs.length) + 30, cx: 0, cy: 0, r: 40, hx: 0, hy: 0, dim: 1 }))
    .sort((a, b) => b.n - a.n || rank(a.key) - rank(b.key))
  const placed = []
  cls.forEach((c, ci) => {
    if (!placed.length) { c.hx = 0; c.hy = 0 } else {
      search: for (let rho = 40; ; rho += 30) {
        const steps = 28
        for (let s = 0; s < steps; s++) {
          const a = ((s + ci * 0.37) / steps) * Math.PI * 2
          const x = Math.cos(a) * rho
          const y = Math.sin(a) * rho * 0.82
          if (placed.every((p) => Math.hypot(p.hx - x, p.hy - y) >= p.R + c.R + 70)) { c.hx = x; c.hy = y; break search }
        }
      }
    }
    placed.push(c)
  })
  return cls
}

let gridHead = new Int32Array(0)
function stepClusters(L, alpha = L.alpha) {
  const nodes = L.nodes
  const N = nodes.length
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
  for (let i = 0; i < N; i++) { const a = nodes[i]; if (a.x < x0) x0 = a.x; if (a.x > x1) x1 = a.x; if (a.y < y0) y0 = a.y; if (a.y > y1) y1 = a.y }
  const CELL = Math.max(34, Math.sqrt(((x1 - x0) * (y1 - y0)) / 160000))
  const gw = Math.floor((x1 - x0) / CELL) + 1
  const gh = Math.floor((y1 - y0) / CELL) + 1
  if (gridHead.length < gw * gh) gridHead = new Int32Array(gw * gh)
  const head = gridHead
  head.fill(-1, 0, gw * gh)
  const next = new Int32Array(N)
  const cellOf = new Int32Array(N)
  for (let i = 0; i < N; i++) {
    const a = nodes[i]
    const c = Math.floor((a.y - y0) / CELL) * gw + Math.floor((a.x - x0) / CELL)
    cellOf[i] = c; next[i] = head[c]; head[c] = i
  }
  const C2 = CELL * CELL
  const REP = 1500 * alpha
  for (let i = 0; i < N; i++) {
    const a = nodes[i]
    const cx = cellOf[i] % gw
    const cy = (cellOf[i] / gw) | 0
    for (let yy = Math.max(0, cy - 1); yy <= Math.min(gh - 1, cy + 1); yy++) {
      for (let xx = Math.max(0, cx - 1); xx <= Math.min(gw - 1, cx + 1); xx++) {
        for (let j = head[yy * gw + xx]; j >= 0; j = next[j]) {
          if (j <= i) continue
          const b = nodes[j]
          let dx = a.x - b.x
          let dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 >= C2) continue
          if (d2 < 0.01) { dx = ((i + j) % 2 ? 1 : -1) * 0.1; dy = 0.1; d2 = 0.02 }
          const f = REP / (d2 + 30)
          const d = Math.sqrt(d2)
          const fx = (dx / d) * f; const fy = (dy / d) * f
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
        }
      }
    }
  }
  for (const l of L.links) {
    const a = nodes[l.a]; const b = nodes[l.b]
    const dx = b.x - a.x; const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const same = a.c === b.c
    const f = same ? (d - 30) * 0.04 * alpha : (d - 200) * 0.0008 * alpha
    const fx = (dx / d) * f; const fy = (dy / d) * f
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
  }
  for (let i = 0; i < N; i++) {
    const a = nodes[i]
    const c = a.c
    const dx = c.hx - a.x; const dy = c.hy - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const over = Math.max(0, d - c.R) / d
    const k = (0.012 + over * 0.2) * alpha * 4
    a.vx += dx * k; a.vy += dy * k
    if (a.fixed) { a.vx = 0; a.vy = 0; continue }
    a.vx *= 0.8; a.vy *= 0.8
    const sp = Math.hypot(a.vx, a.vy)
    if (sp > 24) { a.vx = (a.vx / sp) * 24; a.vy = (a.vy / sp) * 24 }
    a.x += a.vx; a.y += a.vy
  }
  L.alpha = Math.max(0, alpha * 0.985 - 0.0005)
  return L.alpha
}

/** 簇的质心 / 区域半径 / 视图框（按均值±2.2σ 截断，避免个别游离点把框撑大）。 */
function recomputeClusters(L) {
  for (const c of L.cl) {
    let sx = 0; let sy = 0
    for (const i of c.idxs) { sx += L.nodes[i].x; sy += L.nodes[i].y }
    const m = c.idxs.length || 1
    c.cx = sx / m; c.cy = sy / m
    let vx = 0; let vy = 0; let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity
    for (const i of c.idxs) {
      const n = L.nodes[i]
      vx += (n.x - c.cx) ** 2; vy += (n.y - c.cy) ** 2
      if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x; if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y
    }
    const sdx = Math.sqrt(vx / m); const sdy = Math.sqrt(vy / m)
    c.bx0 = Math.max(x0, c.cx - 2.2 * sdx); c.bx1 = Math.min(x1, c.cx + 2.2 * sdx)
    c.by0 = Math.max(y0, c.cy - 2.2 * sdy); c.by1 = Math.min(y1, c.cy + 2.2 * sdy)
    c.r = Math.max(36, Math.hypot(sdx, sdy) * 1.55)
  }
}

export default async function render(ctx) {
  const p = ctx.params
  const focus = p.get('focus') || ''
  const limit = normLimit(p.get('limit'))
  const st = { tag: p.get('tag') || '', kind: p.get('kind') || '', minWeight: 1, hideIsolated: false, types: new Set(['link', 'tag', 'similar']), kinds: null, search: '' }
  if (st.kind) st.kinds = new Set([st.kind])
  let data
  try {
    data = await get('graph', { focus, kinds: st.kind || undefined, tag: st.tag || undefined, limit: limit === DEFAULT_LIMIT ? undefined : limit, depth: focus ? 2 : undefined })
  } catch (e) {
    if (e.status === 404 && focus) { ctx.go('#/graph'); return h('div') }
    throw e
  }
  ctx.setTitle('知识图谱')
  // 截断状态下隐藏的卡得靠服务器重新取；一旦发生过一次服务器过滤，本页后续过滤都走服务器（否则清空条件会只剩子集）
  let serverMode = !!data.truncated
  let fetchSeq = 0
  let fetchTimer = 0
  const nav = (patch) => {
    const q = new URLSearchParams()
    const next = { focus, limit: limit === DEFAULT_LIMIT ? '' : limit, ...patch }
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, String(v))
    ctx.go('#/graph' + (q.toString() ? '?' + q : ''))
  }

  // ---------- 状态 ----------
  const canvas = h('canvas', { class: 'graph-canvas', role: 'img', 'aria-label': `知识图谱画布（${fmtNum(data.stats.nodes)} 个节点，按类型分簇；点击节点或簇名聚焦；键盘：+ 放大，- 缩小，0 适应窗口，Esc 取消选中；也可用下方节点列表）`, tabindex: '0' })
  const tip = h('div', { class: 'graph-tip', hidden: true, role: 'tooltip' })
  const stage = h('div', { class: 'graph-stage' }, [canvas, tip])
  const side = h('aside', { class: 'graph-side', 'aria-live': 'polite' })
  const countEl = h('span', { class: 'sub graph-count' })
  const legendEl = h('div', { class: 'graph-legend' })

  let view = { zoom: 1, panX: 0, panY: 0 }
  let L = null // 布局（nodes 与 shown.nodes 下标对齐；L.cl = 簇）
  let shown = { nodes: [], edges: [] }
  let adj = new Map()
  let maxDeg = 1
  let hubDeg = 3
  let matches = null
  let selected = ''
  let focusCluster = '' // 被聚焦的簇 key
  let hover = -1
  let labelIds = new Set()
  let dirty = true
  let raf = 0
  let fitted = false
  let w = 0
  let hgt = 0
  let tween = null
  let labelRects = [] // 上一帧簇名的屏幕矩形（命中用）
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const perf = { frames: 0, last: 0, sum: 0, max: 0 }
  const clusterOf = (key) => L?.cl.find((c) => c.key === key)
  // 蜘蛛：装饰游走 + 搜索巡游（引擎 graph-spider.js，面板 graph-spider-ui.js）
  const SPIDER_KEY = 'mh.graph.spider'
  let spiderOn = true
  try { spiderOn = globalThis.localStorage?.getItem(SPIDER_KEY) !== '0' } catch { /* 隐私模式等 */ }
  const spider = createSpider({
    nodes: () => L?.nodes || [], clusters: () => L?.cl || [], indexOf: (id) => L?.idx.get(id), reduced, mono: MONO,
    colorOf: (n) => n.c.color, planZoom: 1,
  })
  spider.setEnabled(spiderOn)
  // 相机：可见舞台区（扣掉右侧 / 底部结果面板）、蜘蛛跟随（巡游 look-ahead 运镜 / 走完停在全部命中点 / 游走轻微平移）
  let panelNode = null // 结果面板元素（创建后赋值）
  let box = { x: 0, y: 0, w: 0, h: 0 }
  const followSt = { on: true } // “跟随蜘蛛”开关：用户手动操作后置 false，不自动恢复
  let cam = null // 相机状态（graph-camera.js）
  let camView = null // 相机上一次写出的 view（view 被别处改写时据此重新同步）
  let camTour = false // 巡游进行中
  let camHold = null // 巡游结束后的目标视野（全部命中点装进可见区）
  let holdIds = []
  let followBtn = null
  let limCache = null
  const CAM_LIMITS = () => (limCache ||= { zMin: Math.max(0.25, fitView(L.nodes, box.w, box.h).zoom * 0.9), zMax: 2.5, zClose: 1.6, marginPx: 80 })
  function refreshBox() {
    let pr = null
    if (panelNode && !panelNode.hasAttribute('hidden')) {
      const sr = stage.getBoundingClientRect(); const r = panelNode.getBoundingClientRect()
      pr = { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height }
    }
    box = visibleBox(w, hgt, pr)
    limCache = null
    if (holdIds.length && L) camHold = holdTarget()
  }
  function holdTarget() {
    const pts = holdIds.map((id) => { const i = L.idx.get(id); return i === undefined ? null : { x: L.nodes[i].x, y: L.nodes[i].y } }).filter(Boolean)
    if (!pts.length) return null
    const lim = CAM_LIMITS()
    const f = fitPoints(pts, box, { marginPx: 70, zMin: lim.zMin, zMax: 1.8 })
    return f ? { cx: f.cx, cy: f.cy, zoom: f.zoom } : null
  }
  function stopFollow() { if (followSt.on) { followSt.on = false; followBtn?.setAttribute('aria-pressed', 'false') } }
  let spAlpha = 0.92
  let lastT = 0
  let lastDraw = 0

  // ---------- 过滤 / 重建布局 ----------
  function rebuild({ keepPositions = true, refit = false } = {}) {
    const prev = keepPositions && L ? new Map(L.nodes.map((n) => [n.id, { x: n.x, y: n.y }])) : null
    // 服务器模式：选点 / 选边 / 去孤立点已由服务器做过，这里只按返回结果重建布局（再筛一遍会把它又筛没）
    shown = filterGraph(data, serverMode ? {} : { kinds: st.kinds, tag: st.tag, minWeight: st.minWeight, types: st.types, hideIsolated: st.hideIsolated })
    adj = adjacency(shown.edges)
    maxDeg = Math.max(1, ...shown.nodes.map((n) => n.degree))
    const sorted = shown.nodes.map((n) => n.degree).sort((a, b) => b - a)
    hubDeg = Math.max(3, sorted[Math.floor(sorted.length * 0.04)] || 0) // 前 ~4% 且至少 3 条关联的算枢纽（带发光）
    L = createLayout(shown.nodes, shown.edges, { prev })
    L.cl = buildClusters(shown.nodes)
    for (const c of L.cl) {
      c.dim = 1
      c.idxs.forEach((i, k) => {
        const n = L.nodes[i]
        n.c = c
        if (!prev) { const a = k * 2.399963229728653; const rr = (c.R / Math.sqrt(c.n)) * 0.9 * Math.sqrt(k + 1); n.x = c.hx + Math.cos(a) * rr; n.y = c.hy + Math.sin(a) * rr }
      })
    }
    if (focusCluster && !clusterOf(focusCluster)) focusCluster = ''
    if (prev) L.alpha = 0.5
    else { for (let i = 0; i < 260 && L.alpha > LAYOUT_DONE; i++) stepClusters(L) } // 首次：预热后再展示，避免一开始满屏乱跳
    L.alpha = Math.max(L.alpha, prev ? 0.5 : 0.25)
    recomputeClusters(L)
    labelIds = topLabelIds(shown.nodes, shown.nodes.length <= 60 ? shown.nodes.length : 24)
    if (selected && !L.idx.has(selected)) { selected = ''; renderSide() }
    updateMatches()
    renderNodeList()
    countEl.textContent = `显示 ${fmtNum(shown.nodes.length)} 个节点 · ${fmtNum(shown.edges.length)} 条边 · ${L.cl.length} 个簇` + (shown.nodes.length !== data.stats.nodes ? `（已过滤，共 ${fmtNum(data.stats.nodes)}）` : '')
    if (refit || !fitted) { fitNow() }
    spider.reset()
    dirty = true
    kick()
  }
  function fitNow() {
    if (!w || !hgt || !L) return
    refreshBox()
    const fv = fitView(L.nodes, box.w, box.h)
    view = { zoom: fv.zoom, panX: fv.panX + box.x, panY: fv.panY + box.y }
    fitted = true
    tween = null
    dirty = true
  }
  function updateMatches() {
    matches = searchMatches(shown.nodes, st.search, kindLabel)
    dirty = true
  }

  // ---------- 服务器端过滤（仅截断时） ----------
  const filterParams = () => {
    const params = { focus: focus || undefined, limit: limit === DEFAULT_LIMIT ? undefined : limit, depth: focus ? 2 : undefined }
    if (st.tag) params.tag = st.tag
    if (st.kinds) params.kinds = [...st.kinds].join(',')
    params.types = [...st.types].join(',')
    params.min_weight = st.minWeight
    params.hide_isolated = st.hideIsolated ? 1 : 0
    return params
  }
  /** 让服务器按当前条件重新取图：被 limit 截断藏掉的卡也能被标签 / 类型筛回来。过期响应按递增序号丢弃。 */
  async function fetchFilters() {
    const my = ++fetchSeq
    let next
    try { next = await get('graph', filterParams()) } catch (e) {
      if (my !== fetchSeq) return
      if (e.status === 404 && focus) { ctx.go('#/graph'); return }
      return
    }
    if (my !== fetchSeq) return
    data = next
    for (const k of Object.keys(data.stats.byKind)) kindUniverse.add(k)
    if (data.truncated) serverMode = true
    cutNotice()
    drawLegend()
    fillTagOpts()
    rebuild()
  }
  /** 过滤条件变化：服务器模式走服务器（输入类加 150ms 防抖），否则本地过滤快路径（不联网）。 */
  function applyFilters({ debounce = false } = {}) {
    if (!serverMode) { rebuild(); return }
    clearTimeout(fetchTimer)
    if (debounce) fetchTimer = setTimeout(fetchFilters, 150)
    else fetchFilters()
  }

  // ---------- 相机 ----------
  function flyTo(cx, cy, zoom, dur = 650) {
    const z1 = clampZoom(zoom)
    stopFollow() // flyTo 只来自用户操作（点节点 / 簇 / 引用）
    refreshBox()
    const bc = boxCenter(box)
    if (reduced || !w) { view = { zoom: z1, panX: bc.x - cx * z1, panY: bc.y - cy * z1 }; tween = null; dirty = true; kick(); return }
    const c0 = screenToWorld(view, bc.x, bc.y)
    tween = { t0: performance.now(), dur, z0: view.zoom, z1, x0: c0.x, y0: c0.y, x1: cx, y1: cy, bc }
    userMoved = true
    kick()
  }
  function flyToCluster(c) {
    const bw = Math.max(80, c.bx1 - c.bx0) + 120
    const bh = Math.max(80, c.by1 - c.by0) + 120
    refreshBox()
    flyTo((c.bx0 + c.bx1) / 2, (c.by0 + c.by1) / 2, Math.min(box.w / bw, box.h / bh, 3.5))
  }

  // ---------- 绘制 ----------
  // 缩放补偿：节点屏幕半径 = 基础半径 × zoom^NODE_ZOOM_EXP（缓增），世界半径 = 屏幕半径 / zoom；连线宽/标签字号按屏幕像素恒定（commit 1496dda 的行为）。
  const NODE_ZOOM_EXP = 0.2
  const baseR = (n) => 0.8 + 1.5 * Math.sqrt(n.degree / maxDeg) // 屏幕像素：细小的点，度数越高略大
  const radiusOf = (n) => Math.max(0.7, baseR(n) * Math.pow(view.zoom, NODE_ZOOM_EXP)) / view.zoom
  const hubOf = (i) => shown.nodes[i].degree >= hubDeg

  const tagText = (n) => { const t = n.title || n.id; return (t.length > 20 ? t.slice(0, 19) + '…' : t) + ' · ' + kindLabel(n.kind) }

  function draw() {
    const t0 = performance.now()
    const mt = spider.hasResults() ? null : matches // 蜘蛛搜索结果显示时，临时屏蔽标题过滤高亮
    const g = canvas.getContext('2d')
    if (!g || !L) return
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'
    g.fillStyle = BG
    g.fillRect(0, 0, w, hgt)
    const nodes = L.nodes
    const z = view.zoom
    const sx = (x) => x * z + view.panX
    const sy = (y) => y * z + view.panY
    const now = t0 / 1000
    const selI = selected ? L.idx.get(selected) : undefined
    const selN = selI === undefined ? null : nodes[selI]
    const nbrs = selected ? adj.get(selected) : null
    const hoverN = hover >= 0 ? nodes[hover] : null
    const hoverNb = hoverN && !selected ? adj.get(hoverN.id) : null
    const x0 = -view.panX / z - 40 / z; const x1 = (w - view.panX) / z + 40 / z
    const y0 = -view.panY / z - 40 / z; const y1 = (hgt - view.panY) / z + 40 / z

    // 簇星云：每簇一团很淡的彩色光晕，给“云”的体积感
    g.globalCompositeOperation = 'lighter'
    for (const c of L.cl) {
      const rr = c.r * z * 1.7
      if (sx(c.cx) + rr < 0 || sx(c.cx) - rr > w || sy(c.cy) + rr < 0 || sy(c.cy) - rr > hgt) continue
      g.globalAlpha = 0.11 * c.dim
      g.drawImage(glowSprite(c.color, 128), sx(c.cx) - rr, sy(c.cy) - rr, rr * 2, rr * 2)
    }

    // 世界坐标系：边与点（批量成一条 path，一次 stroke/fill）
    g.save()
    g.translate(view.panX, view.panY)
    g.scale(z, z)
    g.lineCap = 'butt'
    const buckets = new Map() // `${簇key}|${link?}` → 路径
    const bucket = (key, c, kind) => { let b = buckets.get(key); if (!b) { b = { c, kind, path: new Path2D() }; buckets.set(key, b) } return b.path }
    for (const l of L.links) {
      const a = nodes[l.a]; const b = nodes[l.b]
      if ((a.x < x0 && b.x < x0) || (a.x > x1 && b.x > x1) || (a.y < y0 && b.y < y0) || (a.y > y1 && b.y > y1)) continue
      const same = a.c === b.c
      const path = same ? bucket(a.c.key + (l.type === 'link' ? '|L' : '|T'), a.c, l.type === 'link' ? 'link' : 'fiber') : bucket('x', null, 'cross')
      path.moveTo(a.x, a.y); path.lineTo(b.x, b.y)
    }
    for (const b of buckets.values()) {
      if (b.kind === 'cross') { g.globalAlpha = 0.035 * (focusCluster || selected ? 0.4 : 1); g.strokeStyle = '#9aa6c0'; g.lineWidth = 0.7 / z }
      else if (b.kind === 'link') { g.globalAlpha = 0.34 * b.c.dim; g.strokeStyle = b.c.color; g.lineWidth = 1 / z }
      else { g.globalAlpha = 0.15 * b.c.dim; g.strokeStyle = b.c.color; g.lineWidth = 0.6 / z }
      g.stroke(b.path)
    }
    // 悬停：被悬停节点的邻边提亮（实线、细）
    if (hoverN && !selected) {
      g.globalAlpha = 0.8; g.lineWidth = 1 / z; g.strokeStyle = hoverN.c.color
      g.beginPath()
      for (const l of L.links) { const a = nodes[l.a]; const b = nodes[l.b]; if (a === hoverN || b === hoverN) { g.moveTo(a.x, a.y); g.lineTo(b.x, b.y) } }
      g.stroke()
    }
    // 点：每簇一批（普通点 = 偏白的簇色小点；被搜索排除的点更暗）
    g.globalCompositeOperation = 'source-over'
    const rr = (n) => radiusOf(n)
    for (const c of L.cl) {
      const dimPath = new Path2D(); const litPath = new Path2D()
      let nl = 0; let nd = 0
      for (const i of c.idxs) {
        const n = nodes[i]
        if (n.x < x0 || n.x > x1 || n.y < y0 || n.y > y1) continue
        if (hubOf(i)) continue // 枢纽走发光精灵
        const lit = !mt || mt.has(n.id)
        const r = rr(n)
        const path = lit ? litPath : dimPath
        path.moveTo(n.x + r, n.y); path.arc(n.x, n.y, r, 0, Math.PI * 2)
        if (lit) nl++; else nd++
      }
      g.fillStyle = c.tint
      if (nl) { g.globalAlpha = (mt ? 0.95 : 0.8) * Math.max(c.dim, 0.14); g.fill(litPath) }
      if (nd) { g.globalAlpha = 0.12 * c.dim; g.fill(dimPath) }
    }
    g.restore()

    // 屏幕坐标系：发光枢纽、选中/邻居、标签
    g.globalAlpha = 1
    const placed = []
    const clash = (b) => placed.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y)
    const onScreen = (px, py, m = 8) => px > -m && px < w + m && py > -m && py < hgt + m
    const sr = (n) => Math.max(0.7, baseR(n) * Math.pow(z, NODE_ZOOM_EXP))
    g.globalCompositeOperation = 'lighter'
    let glows = 0
    for (let i = 0; i < nodes.length && glows < 400; i++) {
      if (!hubOf(i)) continue
      const n = nodes[i]
      const px = sx(n.x); const py = sy(n.y)
      if (!onScreen(px, py, 20)) continue
      const lit = !mt || mt.has(n.id)
      const a = (lit ? 1 : 0.15) * Math.max(n.c.dim, 0.14)
      const rg = sr(n) * 4.2
      g.globalAlpha = 0.6 * a
      g.drawImage(glowSprite(n.c.color), px - rg, py - rg, rg * 2, rg * 2)
      glows++
    }
    // 搜索命中（非枢纽）补一圈小光晕
    if (mt) {
      let k = 0
      for (let i = 0; i < nodes.length && k < 200; i++) {
        const n = nodes[i]
        if (!mt.has(n.id) || hubOf(i)) continue
        const px = sx(n.x); const py = sy(n.y)
        if (!onScreen(px, py, 20)) continue
        const rg = sr(n) * 4.5
        g.globalAlpha = 0.9; g.drawImage(glowSprite(n.c.color), px - rg, py - rg, rg * 2, rg * 2); k++
      }
    }
    g.globalCompositeOperation = 'source-over'
    // 枢纽白色亮核
    g.fillStyle = '#fff'
    for (let i = 0; i < nodes.length; i++) {
      if (!hubOf(i)) continue
      const n = nodes[i]
      const px = sx(n.x); const py = sy(n.y)
      if (!onScreen(px, py)) continue
      g.globalAlpha = 0.95 * Math.max(n.c.dim, 0.14) * (!mt || mt.has(n.id) ? 1 : 0.2)
      g.beginPath(); g.arc(px, py, Math.max(0.9, sr(n) * 0.55), 0, Math.PI * 2); g.fill()
    }

    // 蜘蛛：暗化其余节点 + 已被踩到的命中节点高亮 → 蜘蛛本体（聚焦 / 选中 / 拖拽时调淡，且不拦截任何指针事件）
    spAlpha += ((selected || focusCluster || drag?.moved ? 0.4 : 0.92) - spAlpha) * 0.15
    spider.drawBackdrop(g, view, w, hgt)
    spider.drawBody(g, view, w, hgt, spAlpha)

    // 选中节点：向邻居辐射的点状虚线（带流动）+ 邻居提亮
    const tags = [] // 待放置的小矩形标签（按优先级）
    if (selN) {
      const px = sx(selN.x); const py = sy(selN.y)
      const list = [...nbrs || []].map((id) => L.idx.get(id)).filter((i) => i !== undefined)
      list.sort((a, b) => shown.nodes[b].degree - shown.nodes[a].degree)
      g.lineCap = 'round'
      g.lineWidth = 1.5
      g.setLineDash([0.1, 5.5])
      g.lineDashOffset = reduced ? 0 : -(now * 16)
      g.globalCompositeOperation = 'lighter'
      let drawn = 0
      for (const i of list) {
        const m = nodes[i]
        const qx = sx(m.x); const qy = sy(m.y)
        if (drawn < 160 && (onScreen(qx, qy, 400) || onScreen(px, py, 400))) {
          g.globalAlpha = 0.9
          g.strokeStyle = m.c === selN.c ? '#ffffff' : m.c.color
          g.beginPath(); g.moveTo(px, py); g.lineTo(qx, qy); g.stroke(); drawn++
        }
      }
      g.setLineDash([]); g.lineDashOffset = 0
      // 邻居节点：簇色发光点
      for (const i of list) {
        const m = nodes[i]
        const qx = sx(m.x); const qy = sy(m.y)
        if (!onScreen(qx, qy, 20)) continue
        const rg = Math.max(sr(m), 1.6) * 4
        g.globalAlpha = 0.9; g.drawImage(glowSprite(m.c.color), qx - rg, qy - rg, rg * 2, rg * 2)
      }
      g.globalCompositeOperation = 'source-over'
      g.fillStyle = '#fff'
      for (const i of list) { const m = nodes[i]; const qx = sx(m.x); const qy = sy(m.y); if (onScreen(qx, qy)) { g.globalAlpha = 1; g.beginPath(); g.arc(qx, qy, Math.max(1.3, sr(m) * 0.8), 0, Math.PI * 2); g.fill() } }
      // 选中点：大光晕 + 脉动环
      g.globalCompositeOperation = 'lighter'
      const rg = 22 + (reduced ? 0 : Math.sin(now * 3) * 3)
      g.globalAlpha = 0.95; g.drawImage(glowSprite(selN.c.color), px - rg, py - rg, rg * 2, rg * 2)
      g.globalCompositeOperation = 'source-over'
      if (!reduced) {
        const ph = (now * 0.9) % 1
        g.globalAlpha = (1 - ph) * 0.7; g.lineWidth = 1.2; g.strokeStyle = selN.c.color
        g.beginPath(); g.arc(px, py, 6 + ph * 22, 0, Math.PI * 2); g.stroke()
      }
      g.globalAlpha = 1; g.fillStyle = '#fff'
      g.beginPath(); g.arc(px, py, 3.4, 0, Math.PI * 2); g.fill()
      g.lineWidth = 1.4; g.strokeStyle = selN.c.color; g.beginPath(); g.arc(px, py, 5.6, 0, Math.PI * 2); g.stroke()
      tags.push({ n: selN, i: selI, kind: 'sel' })
      for (const i of list.slice(0, 26)) tags.push({ n: nodes[i], i, kind: 'nbr' })
    }
    if (hoverN && hover !== selI) {
      const px = sx(hoverN.x); const py = sy(hoverN.y)
      g.globalAlpha = 1; g.lineWidth = 1.2; g.strokeStyle = '#fff'
      g.beginPath(); g.arc(px, py, Math.max(3.2, sr(hoverN) + 2), 0, Math.PI * 2); g.stroke()
      tags.push({ n: hoverN, i: hover, kind: 'hover' })
      if (hoverNb) for (const id of [...hoverNb].slice(0, 8)) { const i = L.idx.get(id); if (i !== undefined) tags.push({ n: nodes[i], i, kind: 'nbr' }) }
    }
    if (mt) {
      let k = 0
      for (let i = 0; i < nodes.length && k < 40; i++) if (mt.has(nodes[i].id)) { tags.push({ n: nodes[i], i, kind: 'match' }); k++ }
    }
    if (focusCluster && !selN) {
      const c = clusterOf(focusCluster)
      if (c) [...c.idxs].sort((a, b) => shown.nodes[b].degree - shown.nodes[a].degree).slice(0, 12).forEach((i) => tags.push({ n: nodes[i], i, kind: 'hub' }))
    }
    if (z >= 1.6 && !selN) for (const i of nodes.keys()) { if (labelIds.has(nodes[i].id)) tags.push({ n: nodes[i], i, kind: 'hub' }) }
    if (z > 3) { let k = 0; for (let i = 0; i < nodes.length && k < 90; i++) { const q = nodes[i]; if (q.c.dim > 0.5 && onScreen(sx(q.x), sy(q.y))) { tags.push({ n: q, i, kind: 'faint' }); k++ } } }

    // 簇标签：粗体大号名 + 一行小字 “N cards”；放在簇心偏上。聚焦某簇时其余簇名变淡。
    labelRects = []
    g.textAlign = 'center'
    g.textBaseline = 'alphabetic'
    for (const c of L.cl) {
      const px = sx(c.cx); const py = sy(c.cy) - c.r * z * 0.92 - 8
      const foc = focusCluster === c.key
      const fs = Math.round(Math.min(30, Math.max(15, 13 + Math.sqrt(c.n) * 0.7)))
      const name = kindLabel(c.key)
      g.font = `700 ${fs}px ${MONO}`
      const tw = g.measureText(name).width
      if (px + tw / 2 < 0 || px - tw / 2 > w || py < -40 || py > hgt + 40) continue
      let a = 0.35 + 0.65 * c.dim
      if (z > 2.4 && !foc) a *= 0.35
      g.lineJoin = 'round'
      g.lineWidth = 5; g.strokeStyle = 'rgba(5,6,10,.9)'; g.globalAlpha = a
      g.strokeText(name, px, py)
      g.fillStyle = foc ? '#fff' : mixWhite(c.color, 0.35); g.fillText(name, px, py)
      g.font = `500 ${Math.max(10, Math.round(fs * 0.46))}px ${MONO}`
      const sub = `${c.n} cards`
      g.lineWidth = 4; g.strokeText(sub, px, py + fs * 0.62)
      g.fillStyle = rgba(c.color, 0.85); g.globalAlpha = a * 0.85; g.fillText(sub, px, py + fs * 0.62)
      labelRects.push({ key: c.key, x: px - Math.max(tw, 56) / 2 - 6, y: py - fs - 2, w: Math.max(tw, 56) + 12, h: fs * 1.85 + 8 })
    }

    // 小矩形标签：等宽小字、描边按类型着色，“标题 · 类型”
    g.globalAlpha = 1
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    const order = { sel: 0, hover: 1, nbr: 2, match: 3, hub: 4, faint: 5 }
    tags.sort((a, b) => order[a.kind] - order[b.kind])
    const seen = new Set()
    let budget = 160
    for (const t of tags) {
      if (budget <= 0) break
      if (seen.has(t.i)) continue
      const px = sx(t.n.x); const py = sy(t.n.y)
      if (!onScreen(px, py, 4)) continue
      const sel = t.kind === 'sel'
      g.font = `${sel ? 600 : 500} ${sel ? 12 : 10.5}px ${MONO}`
      const txt = tagText(shown.nodes[t.i])
      const bw = g.measureText(txt).width + 10
      const bh = sel ? 20 : 17
      const gap = sel ? 12 : 6
      const spots = sel ? [[gap, -bh - 4], [gap, 6], [-bw - gap, -bh - 4], [-bw - gap, 6]] : [[gap, 2], [gap, -bh - 2], [-bw - gap, 2], [-bw - gap, -bh - 2]]
      let box = null
      for (const [ox, oy] of spots) { const b = { x: Math.min(Math.max(2, px + ox), w - bw - 2), y: Math.min(Math.max(2, py + oy), hgt - bh - 2), w: bw, h: bh }; if (!clash(b)) { box = b; break } }
      if (!box) { if (t.kind === 'faint' || t.kind === 'hub' || t.kind === 'match') continue; if (t.kind === 'nbr') continue; box = { x: px + spots[0][0], y: py + spots[0][1], w: bw, h: bh } }
      placed.push(box); seen.add(t.i); budget--
      const col = neon(t.n.kind)
      g.globalAlpha = t.kind === 'faint' ? 0.7 : 1
      g.fillStyle = sel ? col : 'rgba(4,5,9,.9)'
      g.fillRect(box.x, box.y, box.w, box.h)
      g.lineWidth = 1; g.strokeStyle = sel ? '#fff' : rgba(col, t.kind === 'faint' ? 0.5 : 0.95)
      g.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
      g.fillStyle = sel ? '#05060a' : '#dde4f2'
      g.fillText(txt, box.x + 5, box.y + box.h / 2 + 0.5)
    }
    spider.drawInspect(g, view, w, hgt, (ins) => (ins.title.length > 28 ? ins.title.slice(0, 27) + '…' : ins.title))
    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'

    const ms = performance.now() - t0
    perf.frames++; perf.last = ms; perf.sum += ms; if (ms > perf.max) perf.max = ms
  }

  // 簇的目标亮度：聚焦簇 → 其余暗；选中节点 → 自己的簇半亮、其余暗；搜索时保持整体可见（点级别另行变暗）
  function dimTarget(c) {
    if (focusCluster) return c.key === focusCluster ? 1 : 0.13
    if (selected) { const n = L.nodes[L.idx.get(selected)]; return n && n.c === c ? 0.6 : 0.14 }
    return 1
  }

  let userMoved = false
  function frame() {
    raf = 0
    if (!canvas.isConnected) { cleanup(); return }
    let active = false
    if (L && L.alpha > LAYOUT_DONE) {
      stepClusters(L); stepClusters(L)
      recomputeClusters(L)
      active = true
      dirty = true
      if (L.alpha <= LAYOUT_DONE && !userMoved) fitNow()
    }
    if (tween) {
      const pr = Math.min(1, (performance.now() - tween.t0) / tween.dur)
      const e = easeInOut(pr)
      const zz = Math.exp(Math.log(tween.z0) + (Math.log(tween.z1) - Math.log(tween.z0)) * e)
      const cx = tween.x0 + (tween.x1 - tween.x0) * e
      const cy = tween.y0 + (tween.y1 - tween.y0) * e
      view = { zoom: zz, panX: tween.bc.x - cx * zz, panY: tween.bc.y - cy * zz }
      if (pr >= 1) tween = null
      active = true; dirty = true
    }
    if (L) {
      for (const c of L.cl) {
        const tg = dimTarget(c)
        const d = tg - c.dim
        if (Math.abs(d) > 0.004) { c.dim = reduced ? tg : c.dim + d * 0.2; active = true; dirty = true } else if (c.dim !== tg) { c.dim = tg; dirty = true }
      }
    }
    if (selected && !reduced) { active = true; dirty = true } // 辐射虚线流动 / 脉动环
    // 蜘蛛：独立计时；只有蜘蛛在动时仅限制高刷屏的重绘频率（60Hz 下不限；5000 节点单帧约 2ms）
    const nowT = performance.now()
    const dtS = lastT ? (nowT - lastT) / 1000 : 0
    lastT = nowT
    // 相机跟随：蜘蛛（巡游 look-ahead / 走完停在命中点 / 游走轻微平移）；与 tween（用户点击飞行）互斥
    if (L && w && !tween && followSt.on && !reduced) {
      if (view !== camView || !cam) { cam = viewToCam(view, box); camView = view }
      const mode = camTour ? 'tour' : camHold ? 'hold' : (spiderOn && !spiderUi.active && !selected && !focusCluster) ? 'wander' : 'off'
      const nc = followStep(followSt, cam, { dt: dtS, mode, focus: spider.cameraFocus(), box, limits: CAM_LIMITS(), hold: camHold })
      if (nc !== cam) {
        const moved = Math.hypot(nc.cx - cam.cx, nc.cy - cam.cy) * Math.exp(nc.lz) > 0.01 || Math.abs(nc.lz - cam.lz) > 1e-5
        cam = nc
        if (moved) { view = camToView(cam, box); camView = view; dirty = true; active = true }
      }
    }
    let spiderAnim = false
    if (L && w) spiderAnim = spider.update(dtS, view)
    if (spiderAnim) {
      if (!active && !dirty && nowT - lastDraw < 10) { raf = requestAnimationFrame(frame); return }
      active = true; dirty = true
    }
    if (dirty) { draw(); dirty = false; lastDraw = nowT }
    if (active) raf = requestAnimationFrame(frame); else lastT = 0
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame) }
  let ro = null
  function cleanup() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    ro?.disconnect()
  }

  function resize() {
    const r = stage.getBoundingClientRect()
    const nw = Math.max(200, Math.round(r.width))
    const nh = Math.max(240, Math.round(r.height))
    if (nw === w && nh === hgt) return
    const first = !w
    w = nw; hgt = nh
    refreshBox()
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1)
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr)
    if (first || !userMoved) fitNow()
    dirty = true
    kick()
  }

  // ---------- 交互 ----------
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  const pick = (e) => { const s = pos(e); const wp = screenToWorld(view, s.x, s.y); return hitTest(L.nodes, wp.x, wp.y, radiusOf, 5 / view.zoom) }
  const labelAt = (s) => labelRects.find((r) => s.x >= r.x && s.x <= r.x + r.w && s.y >= r.y && s.y <= r.y + r.h)?.key || ''
  function clusterAt(s) {
    const wp = screenToWorld(view, s.x, s.y)
    let best = null; let bd = Infinity
    for (const c of L.cl) { const d = Math.hypot(c.cx - wp.x, c.cy - wp.y) / c.r; if (d <= 1 && d < bd) { best = c; bd = d } }
    return best?.key || ''
  }
  let drag = null
  canvas.addEventListener('pointerdown', (e) => {
    if (!L) return
    canvas.setPointerCapture?.(e.pointerId)
    const s = pos(e)
    const i = labelAt(s) ? -1 : pick(e) // 簇名优先于其下的小点
    drag = { mode: i >= 0 ? 'node' : 'pan', i, sx: s.x, sy: s.y, moved: false, panX: view.panX, panY: view.panY }
    if (i >= 0) { L.nodes[i].fixed = true }
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!L) return
    const s = pos(e)
    if (drag) {
      if (Math.abs(s.x - drag.sx) + Math.abs(s.y - drag.sy) > 3) drag.moved = true
      if (drag.mode === 'pan') { if (drag.moved) tween = null; view = { ...view, panX: drag.panX + s.x - drag.sx, panY: drag.panY + s.y - drag.sy }; userMoved = true; if (drag.moved) stopFollow() }
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
    } else {
      tip.setAttribute('hidden', '')
      canvas.style.setProperty('cursor', labelAt(s) || clusterAt(s) ? 'pointer' : 'grab')
    }
  })
  const endDrag = (e) => {
    if (!drag) return
    if (drag.mode === 'node') {
      const n = L.nodes[drag.i]
      if (n) n.fixed = false
      if (!drag.moved) select(shown.nodes[drag.i].id)
    } else if (!drag.moved) {
      const s = e && e.clientX !== undefined ? pos(e) : { x: drag.sx, y: drag.sy }
      const key = labelAt(s) || clusterAt(s)
      if (key && key !== focusCluster) selectCluster(key)
      else clearFocus()
    }
    drag = null
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', () => endDrag(null))
  canvas.addEventListener('pointerleave', () => { if (!drag) { hover = -1; tip.setAttribute('hidden', ''); dirty = true; kick() } })
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const s = pos(e)
    tween = null
    view = zoomAt(view, s.x, s.y, Math.exp(-e.deltaY * 0.0015))
    stopFollow()
    userMoved = true; dirty = true; kick()
  }, { passive: false })
  canvas.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') zoomBtn(1.25)
    else if (e.key === '-') zoomBtn(0.8)
    else if (e.key === '0') { stopFollow(); userMoved = false; fitNow(); kick() }
    else if (e.key === 'Escape') { if (selected || focusCluster || !spiderUi.active) clearFocus(); else spiderUi.clear() }
  })
  function zoomBtn(f) { stopFollow(); tween = null; view = zoomAt(view, w / 2, hgt / 2, f); userMoved = true; dirty = true; kick() }

  function select(id) {
    selected = id
    if (id) focusCluster = ''
    dirty = true
    renderSide()
    kick()
  }
  function selectCluster(key) {
    const c = clusterOf(key)
    if (!c) return
    selected = ''
    focusCluster = key
    spider.setPreferCluster(key)
    flyToCluster(c)
    renderSide()
    dirty = true; kick()
  }
  function clearFocus() {
    const had = selected || focusCluster
    selected = ''; focusCluster = ''
    spider.setPreferCluster('')
    if (had) renderSide()
    dirty = true; kick()
  }
  function centerOn(id) {
    const i = L.idx.get(id)
    if (i === undefined) return
    const n = L.nodes[i]
    flyTo(n.x, n.y, Math.max(view.zoom, 1.4), 500)
    userMoved = true
  }

  // ---------- 右侧面板 ----------
  let sideToken = 0
  function renderSide() {
    const my = ++sideToken
    side.textContent = ''
    const n = selected ? shown.nodes[L.idx.get(selected)] : null
    const fc = !n && focusCluster ? clusterOf(focusCluster) : null
    if (fc) {
      const top = [...fc.idxs].sort((a, b) => shown.nodes[b].degree - shown.nodes[a].degree).slice(0, 14)
      side.append(
        h('div', { class: 'graph-side-head' }, [h('h3', null, [h('i', { class: 'gdot', css: { background: fc.color } }), ` ${kindLabel(fc.key)} · ${fc.n} cards`])]),
        h('p', { class: 'sub' }, '已聚焦该簇，其余簇变暗；点击空白处或按 Esc 恢复。'),
        h('div', { class: 'graph-nbrs' }, [
          h('h4', null, '关联最多的卡片'),
          h('ul', null, top.map((i) => { const m = shown.nodes[i]; return h('li', null, h('button', { type: 'button', class: 'graph-nbr', on: { click: () => { select(m.id); centerOn(m.id) } } }, [h('i', { class: 'gdot', css: { background: fc.color } }), m.title || m.id])) })),
        ]),
      )
      return
    }
    if (!n) {
      side.append(h('div', { class: 'graph-side-empty' }, [
        h('strong', null, '点击节点查看卡片'),
        h('p', { class: 'sub' }, '节点按类型分簇：点击节点向邻居辐射并高亮，点击簇名飞到该簇；拖动节点可调整位置；拖动空白处平移，滚轮缩放；点击空白恢复。'),
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
          return h('li', null, h('button', { type: 'button', class: 'graph-nbr', on: { click: () => { select(id); centerOn(id); dirty = true; kick() } } }, [h('i', { class: 'gdot', css: { background: neon(m.kind) } }), m.title || id]))
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

  // ---------- 蜘蛛搜索面板 ----------
  const spiderUi = createSpiderSearch({
    spider, host: stage,
    nodeScreen: (id) => { const i = L?.idx.get(id); if (i === undefined) return null; const n = L.nodes[i]; return { x: n.x * view.zoom + view.panX, y: n.y * view.zoom + view.panY } },
    hasNode: (id) => !!L?.idx.has(id),
    colorOf: neon, kindLabel,
    onFocus: (path, inGraph) => { if (inGraph) { select(path); centerOn(path) } else nav({ focus: path, tag: '', kind: '' }) },
    onChange: () => { dirty = true; kick() },
    // 巡游开始：跟随强制开启；不播动画（减少动画 / 蜘蛛关闭）时一次性定位到“全部命中点装进可见区”
    onTourStart: (ids, animated) => {
      followSt.on = true; followBtn?.setAttribute('aria-pressed', 'true')
      tween = null; holdIds = ids; camHold = null; camTour = animated; refreshBox()
      if (!animated) { camHold = holdTarget(); if (camHold) { const c = { cx: camHold.cx, cy: camHold.cy, lz: Math.log(camHold.zoom), vx: 0, vy: 0, vlz: 0 }; view = camToView(c, box); camView = view; cam = c; userMoved = true } }
      dirty = true; kick()
    },
    onTourEnd: () => { camTour = false; refreshBox(); kick() }, // 走完 / 跳过：相机平滑移到“全部命中点装进可见区”
    onClear: () => { camTour = false; camHold = null; holdIds = []; refreshBox(); kick() },
    onLayout: () => { refreshBox(); kick() },
  })
  panelNode = spiderUi.panel
  stage.append(spiderUi.panel)

  // ---------- 工具栏 ----------
  // 主行：搜索 / 标签 / 节点上限 / 视图选项（折叠）。缩放等画布操作浮在画布右上角。
  // 图例的类型全集：初次加载 / 每次服务器过滤时只见已知类型，所以只增不减（取消勾选后还能点回来）
  const kindUniverse = new Set(Object.keys(data.stats.byKind))
  if (serverMode) for (const k of KIND_ORDER) kindUniverse.add(k)
  const legendKinds = () => KIND_ORDER.filter((k) => kindUniverse.has(k)).concat([...kindUniverse].filter((k) => !KIND_ORDER.includes(k)))
  const search = h('input', { id: 'graph-search-input', type: 'search', placeholder: '搜索标题 / 标签 / 类型；回车 = 蜘蛛搜索', 'aria-label': '搜索节点（输入即过滤高亮；回车或点「蜘蛛搜索」让蜘蛛按内容检索并 AI 汇总）', autocomplete: 'off',
    on: {
      input: (e) => { st.search = e.target.value; updateMatches(); if (matches?.size === 1) { const id = [...matches][0]; centerOn(id) } kick() },
      keydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runSpider() } },
    } })
  function runSpider() {
    const q = search.value.trim()
    if (!q) { search.focus(); return }
    spiderUi.run(q).then(() => { dirty = true; kick() })
    dirty = true; kick()
  }
  const spiderBtn = h('button', { type: 'button', class: 'graph-spider-btn', title: '让蜘蛛去图谱里找相关卡片（回车），并由 AI 汇总', on: { click: () => runSpider() } }, '蜘蛛搜索')
  const tagSel = h('select', { 'aria-label': '按标签过滤', on: { change: (e) => { st.tag = e.target.value; applyFilters() } } }, [h('option', { value: '' }, '全部标签')])
  /** 标签下拉选项：截断时从服务器全量标签统计取（被藏掉的标签也能选到），未截断时仍从当前数据取。 */
  async function fillTagOpts() {
    let opts = null
    if (serverMode) {
      try { opts = (await get('tags', { limit: 500 })).items.map((t) => ({ tag: t.tag, n: t.count })) } catch { /* 退回本地标签 */ }
    }
    opts ||= tagCounts(data.nodes)
    tagSel.textContent = ''
    tagSel.append(h('option', { value: '' }, '全部标签'))
    for (const t of opts) tagSel.append(h('option', { value: t.tag, selected: t.tag === st.tag }, `${t.tag}（${t.n}）`))
    if (st.tag && !opts.some((t) => t.tag === st.tag)) tagSel.append(h('option', { value: st.tag, selected: true }, st.tag))
  }
  const weightLbl = h('output', { class: 'graph-weight' }, '1')
  const weight = h('input', { type: 'range', min: '1', max: '4', step: '1', value: '1', 'aria-label': '最小边权重', on: { input: (e) => { st.minWeight = Number(e.target.value); weightLbl.textContent = String(st.minWeight); applyFilters({ debounce: true }) } } })
  const isoBox = h('input', { type: 'checkbox', 'aria-label': '隐藏孤立点', on: { change: (e) => { st.hideIsolated = e.target.checked; applyFilters() } } })
  const typeBox = (t) => h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: true, 'aria-label': EDGE_LABEL[t], on: { change: (e) => { if (e.target.checked) st.types.add(t); else st.types.delete(t); applyFilters() } } }), h('span', null, EDGE_LABEL[t])])
  const limitSel = h('select', { 'aria-label': '最多节点数', on: { change: (e) => nav({ limit: e.target.value === DEFAULT_LIMIT ? '' : e.target.value }) } },
    LIMITS.map((n) => h('option', { value: String(n), selected: n === limit }, n === DEFAULT_LIMIT ? '全部节点（自动）' : `最多 ${n} 节点`)))
  const zbtn = (label, fn, ic) => h('button', { type: 'button', class: 'graph-zbtn', title: label, 'aria-label': label, on: { click: fn } }, icon(ic))

  // 图例：kind 色块，点击切换显示该 kind（再点恢复）
  function drawLegend() {
    legendEl.textContent = ''
    for (const k of legendKinds()) {
      const on = !st.kinds || st.kinds.has(k)
      legendEl.append(h('button', { type: 'button', class: 'graph-lg' + (on ? '' : ' off'), 'aria-pressed': on ? 'true' : 'false', title: '点击仅显示/取消该类型',
        on: { click: () => {
          if (!st.kinds) st.kinds = new Set([k])
          else if (st.kinds.has(k) && st.kinds.size === 1) st.kinds = null
          else if (st.kinds.has(k)) st.kinds.delete(k)
          else st.kinds.add(k)
          drawLegend(); applyFilters()
        } } }, [h('i', { class: 'gdot', css: { background: neon(k) } }), `${kindLabel(k)} ${data.stats.byKind[k] || 0}`]))
    }
    legendEl.append(
      h('span', { class: 'graph-lg-sep' }),
      h('span', { class: 'sub' }, '簇 = 类型 · 圆点大小 = 关联数'),
      h('span', { class: 'sub graph-edge-key' }, [h('i', { class: 'ek ek-link' }), '[[链接]]', h('i', { class: 'ek ek-tag' }), '共享标签', h('i', { class: 'ek ek-sim' }), '内容相似']),
    )
  }
  drawLegend()
  fillTagOpts()

  const toolbar = h('div', { class: 'graph-toolbar' }, [
    h('div', { class: 'search-box graph-search' }, [h('label', { class: 'sp-label', for: 'graph-search-input' }, '搜索'), icon('search'), search]),
    spiderBtn,
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
  const spiderToggle = h('button', { type: 'button', class: 'graph-zbtn', title: '蜘蛛：开 / 关', 'aria-label': '蜘蛛动画开关', 'aria-pressed': spiderOn ? 'true' : 'false',
    on: { click: () => {
      spiderOn = !spiderOn
      spider.setEnabled(spiderOn)
      if (!spiderOn) spiderUi.interrupt()
      spiderToggle.setAttribute('aria-pressed', spiderOn ? 'true' : 'false')
      try { globalThis.localStorage?.setItem(SPIDER_KEY, spiderOn ? '1' : '0') } catch { /* 忽略 */ }
      dirty = true; kick()
    } } },
  svg('svg', { class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'aria-hidden': 'true', focusable: 'false' },
    svg('circle', { cx: '12', cy: '12', r: '3.2' }), svg('path', { d: 'M12 8.8V3M12 15.2V21M8.8 12H3M15.2 12H21M9.7 9.7L5 5M14.3 14.3L19 19M14.3 9.7L19 5M9.7 14.3L5 19' })))
  const zoomBar = h('div', { class: 'graph-zoom', role: 'group', 'aria-label': '画布缩放' }, [
    zbtn('放大（+）', () => zoomBtn(1.25), 'plus'), zbtn('缩小（-）', () => zoomBtn(0.8), 'minus'),
    zbtn('适应窗口（0）', () => { stopFollow(); userMoved = false; fitNow(); kick() }, 'fit'),
    zbtn('重新布局', () => { L.alpha = 1; userMoved = false; kick() }, 'refresh'),
    spiderToggle,
    followBtn = h('button', { type: 'button', class: 'graph-zbtn', title: '跟随蜘蛛（相机随蜘蛛运镜；手动拖拽 / 缩放后自动关闭，可再点开）', 'aria-label': '跟随蜘蛛', 'aria-pressed': 'true',
      on: { click: () => { followSt.on = !followSt.on; followBtn.setAttribute('aria-pressed', followSt.on ? 'true' : 'false'); cam = null; kick() } } },
    svg('svg', { class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'aria-hidden': 'true', focusable: 'false' },
      svg('rect', { x: '5', y: '5', width: '14', height: '14' }), svg('path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3' }), svg('circle', { cx: '12', cy: '12', r: '2' }))),
  ])
  stage.append(zoomBar)

  // 键盘 / 读屏可用的替代入口：按关联数排序的节点列表（画布本身依赖指针拖拽与悬停）
  const nodeListEl = h('div', { class: 'graph-nodelist' })
  function renderNodeList() {
    nodeListEl.textContent = ''
    const top = [...shown.nodes].sort((a, b) => b.degree - a.degree).slice(0, 40)
    if (!top.length) { nodeListEl.append(h('p', { class: 'sub' }, '当前过滤条件下没有节点。')); return }
    nodeListEl.append(h('ul', null, top.map((n) => h('li', null, h('button', { type: 'button', class: 'graph-nbr', on: { click: () => { select(n.id); centerOn(n.id); dirty = true; kick() } } }, [h('i', { class: 'gdot', css: { background: neon(n.kind) } }), h('span', { class: 'graph-nbr-title' }, n.title || n.id), h('span', { class: 'sub' }, `${kindLabel(n.kind)} · ${n.degree}`)])))))
    if (shown.nodes.length > top.length) nodeListEl.append(h('p', { class: 'sub' }, `仅列出关联数最高的 ${top.length} 个，共 ${fmtNum(shown.nodes.length)} 个；可用搜索或过滤缩小范围。`))
  }

  // 截断提示降为 info：默认视图（自动上限 + 卡数没超）根本不出提示，只有超上限或用户手动压小上限才出现。
  // 挂在固定容器上，服务器过滤（count 变了）后可重复调用重刷。
  const cutEl = h('div', { class: 'graph-cut' })
  function cutNotice() {
    cutEl.textContent = ''
    if (!data.truncated) return
    cutEl.append(data.stats.limitAuto
      ? notice('info', `卡片数超过 ${fmtNum(data.stats.limit)}，仅显示关联度最高的 ${fmtNum(data.stats.nodes)} 个`, '可用标签 / 类型 / 最小权重缩小范围，或调低“最多节点数”只看重点。')
      : notice('info', '已按所选上限显示', `已按所选上限显示关联度最高的 ${fmtNum(data.stats.nodes)} 个（共匹配 ${fmtNum(data.stats.matchedNodes)} 个）。可调高“最多节点数”，或用标签/类型/最小权重缩小范围。`))
  }
  cutNotice()

  const head = pageHead('06', 'Graph', '知识图谱', `主库 ${fmtNum(data.stats.totalCards)} 张卡 · 边 = [[链接]] / 共享标签 Top-6 / 正文相似（≥0.42）· 只读`, [countEl, focus ? h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => nav({ focus: '' }) } }, '返回全图') : null])

  const root = h('div', { class: 'page graph-page' }, [
    head,
    cutEl,
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
  // 调试 / 自动化测试钩子（只读）：绘制耗时统计与节点屏幕坐标
  canvas.__mhGraph = {
    perf,
    get view() { return view },
    clusters: () => (L ? L.cl.map((c) => ({ key: c.key, n: c.n, x: c.cx * view.zoom + view.panX, y: c.cy * view.zoom + view.panY, dim: c.dim })) : []),
    nodeScreen: (id) => { const i = L?.idx.get(id); if (i === undefined) return null; const n = L.nodes[i]; return { x: n.x * view.zoom + view.panX, y: n.y * view.zoom + view.panY, r: radiusOf(n) * view.zoom } },
    drawNow: () => { draw() },
    state: () => ({ selected, focusCluster, hover, tweening: !!tween }),
    spider: () => spider.snapshot(),
    spiderUi: () => spiderUi.state(),
    spiderObj: spider,
    get box() { return box },
    camera: () => ({ follow: followSt.on, tour: camTour, hold: !!camHold, cam: cam ? { ...cam } : null }),
    nodePoints: () => (L ? L.nodes.map((n) => ({ x: n.x * view.zoom + view.panX, y: n.y * view.zoom + view.panY, id: n.id })) : []),
  }
  return root
}
