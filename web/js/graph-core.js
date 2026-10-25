// 知识图谱的纯函数：过滤 / 搜索 / 力导向布局 / 视图变换 / 命中测试。不碰 DOM（tests/admin/graph-core.test.mjs 直接单测）。
// 力导向是自写的轻量实现（O(n²) 斥力 + 弹簧 + 向心 + 按 kind 的弱聚类），~1000 节点内每 tick 仅几毫秒，无第三方依赖。

/** kind → 颜色（与原 memory-eternal 图谱配色一致，深浅主题下都可读）。 */
export const KIND_COLORS = {
  project: '#3B82F6', knowledge: '#10B981', content: '#F59E0B', prompt: '#A855F7',
  business: '#EC4899', tool: '#06B6D4', mistake: '#EF4444', other: '#6B7280',
}
export const kindColor = (k) => KIND_COLORS[k] || KIND_COLORS.other

export const EDGE_LABEL = { link: '[[链接]]', tag: '共享标签', similar: '内容相似' }

/** 半径随度数增长（开方压缩，避免枢纽过大）。 */
export function nodeRadius(degree, maxDegree) {
  const m = Math.max(1, maxDegree)
  return 5 + 11 * Math.sqrt(Math.min(1, Math.max(0, degree) / m))
}

/** 重新统计度数（按给定边）。返回新节点数组（浅拷贝 + degree）。 */
export function withDegrees(nodes, edges) {
  const d = new Map()
  for (const e of edges) { d.set(e.source, (d.get(e.source) || 0) + 1); d.set(e.target, (d.get(e.target) || 0) + 1) }
  return nodes.map((n) => ({ ...n, degree: d.get(n.id) || 0 }))
}

/**
 * 客户端过滤（服务端已按 limit 截断；这里做交互式降噪）。
 * opts: { kinds:Set<string>|null（null=全部）, tag:string, minWeight:number, types:Set<string>|null, hideIsolated:boolean }
 * 度数按过滤后的边重新计算。
 */
export function filterGraph(data, opts = {}) {
  const { kinds = null, tag = '', minWeight = 1, types = null, hideIsolated = false } = opts
  const ok = (n) => (!kinds || kinds.has(n.kind)) && (!tag || (n.tags || []).includes(tag))
  const keep = new Set(data.nodes.filter(ok).map((n) => n.id))
  const edges = data.edges.filter((e) => keep.has(e.source) && keep.has(e.target) && e.weight >= minWeight && (!types || types.has(e.type)))
  let nodes = withDegrees(data.nodes.filter((n) => keep.has(n.id)), edges)
  if (hideIsolated) {
    nodes = nodes.filter((n) => n.degree > 0)
    const ids = new Set(nodes.map((n) => n.id))
    return { nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }
  }
  return { nodes, edges }
}

/** 搜索命中：标题 / 标签 / kind / path 的子串（不区分大小写）。空查询 → null（表示"不高亮"）。 */
export function searchMatches(nodes, term, kindLabel = (k) => k) {
  const q = String(term || '').trim().toLowerCase()
  if (!q) return null
  const hit = new Set()
  for (const n of nodes) {
    if (String(n.title || '').toLowerCase().includes(q) || String(n.id || '').toLowerCase().includes(q) || String(n.kind || '').toLowerCase().includes(q)
      || String(kindLabel(n.kind) || '').toLowerCase().includes(q) || (n.tags || []).some((t) => String(t).toLowerCase().includes(q))) hit.add(n.id)
  }
  return hit
}

/** 邻接表：id → Set<id>。 */
export function adjacency(edges) {
  const m = new Map()
  for (const e of edges) {
    if (!m.has(e.source)) m.set(e.source, new Set()); m.get(e.source).add(e.target)
    if (!m.has(e.target)) m.set(e.target, new Set()); m.get(e.target).add(e.source)
  }
  return m
}

/** 标签统计：[{tag, n}] 按出现次数降序。 */
export function tagCounts(nodes, max = 80) {
  const c = new Map()
  for (const n of nodes) for (const t of n.tags || []) c.set(t, (c.get(t) || 0) + 1)
  return [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max).map(([tag, n]) => ({ tag, n }))
}

// ---------------------------------------------------------------------------
// 力导向布局
// ---------------------------------------------------------------------------

/**
 * 创建布局。prev: Map<id,{x,y}>（沿用上一次的位置避免跳变）。
 * 初始位置：黄金角螺旋（确定性，无随机），保证重复运行结果可复现。
 */
export function createLayout(nodes, edges, { prev = null, kindCenters = true } = {}) {
  const kinds = [...new Set(nodes.map((n) => n.kind))].sort()
  const centers = new Map()
  const R = 120 + Math.sqrt(nodes.length) * 8
  kinds.forEach((k, i) => {
    const a = (i / Math.max(1, kinds.length)) * Math.PI * 2 - Math.PI / 2
    centers.set(k, kinds.length > 1 && kindCenters ? { x: Math.cos(a) * R * 0.45, y: Math.sin(a) * R * 0.45 } : { x: 0, y: 0 })
  })
  const GOLDEN = 2.399963229728653
  const sim = nodes.map((n, i) => {
    const p = prev?.get(n.id)
    const r = 14 * Math.sqrt(i + 1)
    // 布局节点带上原节点的字段（聚合视图要 count / label / color；卡片视图渲染也用到 title 等）
    return { ...n, degree: n.degree || 0, x: p ? p.x : Math.cos(i * GOLDEN) * r, y: p ? p.y : Math.sin(i * GOLDEN) * r, vx: 0, vy: 0, fixed: false }
  })
  const idx = new Map(sim.map((n, i) => [n.id, i]))
  const links = []
  for (const e of edges) {
    const a = idx.get(e.source)
    const b = idx.get(e.target)
    if (a !== undefined && b !== undefined && a !== b) links.push({ a, b, w: e.weight || 1, type: e.type })
  }
  return { nodes: sim, links, idx, centers, alpha: 1 }
}

/** 一步迭代。alpha 随步数衰减，< 0.02 视为收敛。返回当前 alpha。 */
export function stepLayout(L, { repulsion = 2600, linkDistance = 70, gravity = 0.008, clusterPull = 0.008, damping = 0.82, cutoff = 520 } = {}) {
  const n = L.nodes
  const alpha = L.alpha
  const cut2 = cutoff * cutoff
  for (let i = 0; i < n.length; i++) {
    const a = n[i]
    for (let j = i + 1; j < n.length; j++) {
      const b = n[j]
      let dx = a.x - b.x
      let dy = a.y - b.y
      let d2 = dx * dx + dy * dy
      if (d2 > cut2) continue
      if (d2 < 0.01) { dx = ((i + j) % 2 ? 1 : -1) * 0.1; dy = 0.1; d2 = dx * dx + dy * dy }
      const d = Math.sqrt(d2)
      const f = (repulsion * alpha) / d2
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx += fx; a.vy += fy
      b.vx -= fx; b.vy -= fy
    }
  }
  for (const l of L.links) {
    const a = n[l.a]
    const b = n[l.b]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const target = linkDistance / (1 + 0.25 * (l.w - 1))
    const k = 0.06 * Math.min(2, 0.6 + 0.2 * l.w)
    const f = (d - target) * k * alpha
    const fx = (dx / d) * f
    const fy = (dy / d) * f
    a.vx += fx; a.vy += fy
    b.vx -= fx; b.vy -= fy
  }
  for (const a of n) {
    const c = L.centers.get(a.kind) || { x: 0, y: 0 }
    a.vx += (-a.x * gravity + (c.x - a.x) * clusterPull) * alpha * 4
    a.vy += (-a.y * gravity + (c.y - a.y) * clusterPull) * alpha * 4
    if (a.fixed) { a.vx = 0; a.vy = 0; continue }
    a.vx *= damping; a.vy *= damping
    const sp = Math.hypot(a.vx, a.vy)
    if (sp > 40) { a.vx = (a.vx / sp) * 40; a.vy = (a.vy / sp) * 40 }
    a.x += a.vx; a.y += a.vy
  }
  L.alpha = Math.max(0, alpha * 0.985 - 0.0005)
  return L.alpha
}

export const LAYOUT_DONE = 0.02

/** 同步跑 ticks 步（预热/测试用）。 */
export function runLayout(L, ticks = 200, opts) {
  for (let i = 0; i < ticks && L.alpha > LAYOUT_DONE; i++) stepLayout(L, opts)
  return L
}

// ---------------------------------------------------------------------------
// 视图变换
// ---------------------------------------------------------------------------

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 6
export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

/** 把所有节点装进 w×h 视口。返回 { zoom, panX, panY }。 */
export function fitView(nodes, w, h, pad = 36) {
  if (!nodes.length || w <= 0 || h <= 0) return { zoom: 1, panX: w / 2, panY: h / 2 }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const n of nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y) }
  const bw = Math.max(40, x1 - x0) + pad * 2
  const bh = Math.max(40, y1 - y0) + pad * 2
  const zoom = clampZoom(Math.min(w / bw, h / bh, 2.5))
  return { zoom, panX: w / 2 - ((x0 + x1) / 2) * zoom, panY: h / 2 - ((y0 + y1) / 2) * zoom }
}

export const screenToWorld = (v, sx, sy) => ({ x: (sx - v.panX) / v.zoom, y: (sy - v.panY) / v.zoom })
export const worldToScreen = (v, wx, wy) => ({ x: wx * v.zoom + v.panX, y: wy * v.zoom + v.panY })

/** 以屏幕点 (sx,sy) 为锚缩放，锚点下的世界坐标保持不动。 */
export function zoomAt(v, sx, sy, factor) {
  const z = clampZoom(v.zoom * factor)
  const k = z / v.zoom
  return { zoom: z, panX: sx - (sx - v.panX) * k, panY: sy - (sy - v.panY) * k }
}

/** 世界坐标命中测试：返回最近且落在（半径 + 容差）内的节点下标，否则 -1。radiusOf(node) 返回世界半径。 */
export function hitTest(nodes, wx, wy, radiusOf, slack = 3) {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const d = Math.hypot(n.x - wx, n.y - wy)
    if (d <= radiusOf(n) + slack && d < bestD) { best = i; bestD = d }
  }
  return best
}

/** 需要常驻标签的节点：度数最高的 budget 个。 */
export function topLabelIds(nodes, budget) {
  return new Set([...nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, budget).map((n) => n.id))
}
