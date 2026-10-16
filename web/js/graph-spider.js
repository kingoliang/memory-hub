// 图谱蜘蛛（Canvas 2D 引擎，无 DOM 依赖，模块加载不触碰 document）。
// 外观：青绿色带网格纹圆环 + 中心品红方块，身上伸出 18 条白色点状虚线触手，触手末端“踩”在附近节点上；
// 沿弧线在簇间游走（带拖尾），触手伸缩脉动。游走 / 搜索巡游 / 思考三种行为共用同一套腿部逻辑。
// 性能：身体是预渲染 sprite（drawImage）；所有触手合成一条 path 一次 stroke；落脚点最近邻按帧分摊（每帧至多 4 条腿）。
// 对外只读节点位置（{x,y,c,id}），不改图谱布局；绘制层与命中测试无关，不会拦截任何指针事件。

const TAU = Math.PI * 2
export const LEG_COUNT = 18
export const BODY_R = 15 // 屏幕像素：随缩放不变
const REACH_PX = 86 // 触手基础伸展长度（屏幕像素）
export const THROW_AT = 0.4 // 脚踩到命中节点后，停留进行到该比例时把卡片“扔出去”
const TRAIL_MAX = 80

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
export const easeOutBack = (p) => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2) }

// ---------------------------------------------------------------------------
// 纯函数（有单测）
// ---------------------------------------------------------------------------

/** 二次贝塞尔曲线上的点。 */
export function bezier2(p0, c, p1, u) {
  const v = 1 - u
  return { x: v * v * p0.x + 2 * v * u * c.x + u * u * p1.x, y: v * v * p0.y + 2 * v * u * c.y + u * u * p1.y }
}
/** 二次贝塞尔的切线（未归一化）。 */
export function bezier2Tangent(p0, c, p1, u) {
  return { x: 2 * (1 - u) * (c.x - p0.x) + 2 * u * (p1.x - c.x), y: 2 * (1 - u) * (c.y - p0.y) + 2 * u * (p1.y - c.y) }
}
/** 弧线控制点：两点中点沿垂直方向偏移 len*bend（sign 决定弯向哪一侧）。 */
export function arcControl(p0, p1, bend = 0.28, sign = 1) {
  const dx = p1.x - p0.x; const dy = p1.y - p0.y
  return { x: (p0.x + p1.x) / 2 - dy * bend * sign, y: (p0.y + p1.y) / 2 + dx * bend * sign }
}

/**
 * 为一条腿选落脚点：离理想点 (ix,iy) 最近、半径 tol 内、且未被其它腿占用的节点；没有则 -1。
 * @param {{x:number,y:number}[]} nodes
 * @param {Set<number>} taken
 */
export function pickFoot(nodes, ix, iy, tol, taken) {
  let best = -1; let bd = tol * tol
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const dx = n.x - ix; const dy = n.y - iy
    const d2 = dx * dx + dy * dy
    if (d2 < bd && !(taken && taken.has(i))) { bd = d2; best = i }
  }
  return best
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
/** 开放路径（起点固定）总长。 */
export function routeLength(start, pts) { let t = 0; let c = start; for (const p of pts) { t += dist(c, p); c = p } return t }
/** 最近邻排序 + 2-opt 消除交叉折返（起点固定，开放路径）。确定性：平手按 id。 */
export function orderPath(start, pts) {
  const left = pts.slice(); const out = []; let cur = start
  while (left.length) {
    let bi = 0
    for (let i = 1; i < left.length; i++) { const d = dist(cur, left[i]); const bd = dist(cur, left[bi]); if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && String(left[i].id) < String(left[bi].id))) bi = i }
    cur = left.splice(bi, 1)[0]; out.push(cur)
  }
  let improved = true; let guard = 0
  while (improved && guard++ < 50) {
    improved = false
    for (let i = 0; i < out.length - 1; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const cand = out.slice(0, i).concat(out.slice(i, j + 1).reverse(), out.slice(j + 1))
        if (routeLength(start, cand) < routeLength(start, out) - 1e-6) { out.splice(0, out.length, ...cand); improved = true }
      }
    }
  }
  return out
}

/**
 * 平滑转向的弧线控制点：沿“上一段结束时的行进方向”起飞（C1 连续），与弦方向的夹角超过 maxTurn 时向弦方向收拢（限制转角变化率）。
 * heading 为空（第一段）时退化为对称弧。
 */
export function smoothControl(p0, p1, heading, { k = 0.42, maxTurn = Math.PI * 0.55 } = {}) {
  const dx = p1.x - p0.x; const dy = p1.y - p0.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len; const uy = dy / len
  if (!heading || !Math.hypot(heading.x, heading.y)) return arcControl(p0, p1, 0.2, 1)
  let hx = heading.x; let hy = heading.y; const hl = Math.hypot(hx, hy); hx /= hl; hy /= hl
  const ang = Math.atan2(hx * uy - hy * ux, hx * ux + hy * uy) // 带符号夹角
  if (Math.abs(ang) > maxTurn) { const a = Math.atan2(uy, ux) - Math.sign(ang) * maxTurn; hx = Math.cos(a); hy = Math.sin(a) }
  return { x: p0.x + hx * len * k, y: p0.y + hy * len * k }
}

/**
 * 巡游计划（纯函数，确定性：相同输入 → 相同输出；有单测）。
 *  1. 命中节点按簇分组；簇的访问顺序 = 最近邻 + 2-opt（从蜘蛛当前位置出发）；簇内同样最近邻 + 2-opt；整条路线无交叉折返；
 *  2. 干扰节点只“顺路检查”：每段至多 maxPerLeg 个、总数 ≤ maxDecoys，偏离该段直线不超过阈值，不绕路；
 *  3. 时间表：开场扫描 scanMs；簇间长跳 / 簇内短步按固定速度；每站固定停顿；总时长 ≤ maxMs（先减干扰节点，再压缩停顿，最后等比压缩）。
 * @param {{x:number,y:number}} start
 * @param {{id:string,x:number,y:number,rank:number,title?:string,cluster?:string}[]} hits
 * @param {{id:string,x:number,y:number}[]} candidates 全部节点（挑顺路的干扰节点）
 */
export function buildTourPlan(start, hits, candidates, o = {}) {
  const zoom = o.zoom || 1
  const maxMs = o.maxMs || 12000
  const maxDecoys = o.maxDecoys ?? 6
  const maxPerLeg = o.maxPerLeg ?? 2
  const scanMs = o.scanMs ?? 900
  const hitIds = new Set(hits.map((x) => x.id))
  // 1. 簇优先
  const groups = new Map()
  for (const h of hits) { const k = h.cluster || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(h) }
  const cents = [...groups.entries()].map(([k, arr]) => ({ id: k, x: arr.reduce((a, b) => a + b.x, 0) / arr.length, y: arr.reduce((a, b) => a + b.y, 0) / arr.length, arr }))
  const ordered = []
  let cur = { x: start.x, y: start.y }
  for (const g of orderPath(start, cents)) {
    const inner = orderPath(cur, g.arr)
    ordered.push(...inner)
    cur = inner[inner.length - 1]
  }
  // 2. 顺路干扰节点
  const decoyNear = (a, b, legIdx) => {
    const dx = b.x - a.x; const dy = b.y - a.y; const len = Math.hypot(dx, dy)
    if (len < 40 / zoom) return []
    const thr = Math.max(16 / zoom, Math.min(0.18 * len, 46 / zoom))
    const gap = 24 / zoom
    const found = []
    for (const n of candidates) {
      if (hitIds.has(n.id)) continue
      const t = ((n.x - a.x) * dx + (n.y - a.y) * dy) / (len * len)
      if (t < 0.03 || t > 0.97 || t * len < gap || (1 - t) * len < gap) continue
      const dev = Math.abs((n.x - a.x) * dy - (n.y - a.y) * dx) / len
      if (dev <= thr) found.push({ id: n.id, x: n.x, y: n.y, t, dev, kind: 'decoy', leg: legIdx })
    }
    found.sort((p, q) => p.dev - q.dev || String(p.id).localeCompare(String(q.id)))
    const pick = []
    for (const f of found) { if (pick.length >= maxPerLeg) break; if (pick.every((p) => Math.abs(p.t - f.t) * len >= Math.max(gap * 2, 0.28 * len))) pick.push(f) }
    return pick.sort((p, q) => p.t - q.t)
  }
  const legDecoys = []
  let prev = start
  ordered.forEach((h, i) => { legDecoys.push({ len: dist(prev, h), list: decoyNear(prev, h, i) }); prev = h })
  // 总数上限：优先保留长段上的
  let budget = maxDecoys
  const chosen = new Map()
  for (const lg of legDecoys.map((l, i) => ({ ...l, i })).sort((a, b) => b.len - a.len || a.i - b.i)) {
    const keep = lg.list.slice(0, Math.max(0, Math.min(lg.list.length, budget)))
    budget -= keep.length
    chosen.set(lg.i, keep)
  }
  const compose = (nDecoys) => {
    // 去掉“最后面”的干扰节点直到 nDecoys 个
    const all = []
    ordered.forEach((_, i) => { for (const d of chosen.get(i) || []) all.push(d) })
    const keep = new Set(all.slice(0, nDecoys).map((d) => d.id))
    const out = []
    ordered.forEach((h, i) => { for (const d of chosen.get(i) || []) if (keep.has(d.id)) out.push({ ...d }); out.push({ ...h, kind: 'hit' }) })
    return out
  }
  // 3. 时间表
  const timeline = (stops, { hop, step, hitDwell, decoyDwell }) => {
    let c = { x: start.x, y: start.y }; let t = scanMs
    return stops.map((st) => {
      const dPx = dist(c, st) * zoom
      const isHop = dPx > 170
      const travel = Math.max(isHop ? 380 : 220, (dPx / (isHop ? hop : step)) * 1000)
      const dwell = st.kind === 'hit' ? hitDwell : decoyDwell
      const arriveMs = t + travel
      t = arriveMs + dwell
      c = st
      return { ...st, hop: isHop, travelMs: travel, dwellMs: dwell, arriveMs, leaveMs: t }
    })
  }
  let params = { hop: 680, step: 340, hitDwell: 800, decoyDwell: 260 }
  const nAll = [...chosen.values()].reduce((a, b) => a + b.length, 0)
  let n = nAll
  let stops = timeline(compose(n), params)
  const total = (st) => (st.length ? st[st.length - 1].leaveMs : scanMs)
  while (total(stops) > maxMs && n > 0) { n--; stops = timeline(compose(n), params) }
  for (let k = 0; k < 3 && total(stops) > maxMs; k++) {
    params = { hop: params.hop * 1.4, step: params.step * 1.4, hitDwell: Math.max(420, params.hitDwell * 0.75), decoyDwell: 160 }
    stops = timeline(compose(n), params)
  }
  let scaled = false
  const tot = total(stops)
  if (tot > maxMs) {
    const f = maxMs / tot; scaled = true
    stops = stops.map((st) => ({ ...st, travelMs: st.travelMs * f, dwellMs: st.dwellMs * f, arriveMs: st.arriveMs * f, leaveMs: st.leaveMs * f }))
    return { stops, scanMs: scanMs * f, totalMs: total(stops), scaled, decoyCount: stops.filter((x) => x.kind === 'decoy').length }
  }
  return { stops, scanMs, totalMs: total(stops), scaled, decoyCount: stops.filter((x) => x.kind === 'decoy').length }
}

/** 某节点在巡游开始后 tMs 时刻的状态：命中节点只有脚踩上去（到达时刻）之后才是 highlighted；此前与普通节点完全一致。 */
export function nodeStateAt(plan, id, tMs) {
  const st = plan.stops.find((x) => x.id === id)
  if (!st || tMs < st.arriveMs) return 'normal'
  return st.kind === 'hit' ? 'highlighted' : 'touched'
}
/** “跳过动画”：一次性全部显示 —— 所有命中节点直接是 highlighted。 */
export function skipState(plan) {
  return Object.fromEntries(plan.stops.filter((x) => x.kind === 'hit').map((x) => [x.id, 'highlighted']))
}

// ---------------------------------------------------------------------------
// 预渲染 sprite（懒创建：加载模块时不碰 document）
// ---------------------------------------------------------------------------
const sprites = new Map()
function makeCanvas(size) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(size, size)
  const c = globalThis.document.createElement('canvas'); c.width = size; c.height = size; return c
}
/** 蜘蛛身体：青绿色圆环 + 网格纹 + 中心品红方块。 */
function bodySprite() {
  let c = sprites.get('body')
  if (c) return c
  const S = 256; const m = S / 2
  c = makeCanvas(S)
  const g = c.getContext('2d')
  const teal = '#2ee6c8'
  // 底盘：深色圆盘 + 内部网格（同心圆 + 放射线 + 斜向网线）
  g.fillStyle = 'rgba(4,22,26,.92)'; g.beginPath(); g.arc(m, m, 104, 0, TAU); g.fill()
  g.save(); g.beginPath(); g.arc(m, m, 104, 0, TAU); g.clip()
  g.strokeStyle = 'rgba(46,230,200,.42)'; g.lineWidth = 2
  for (const r of [28, 52, 78]) { g.beginPath(); g.arc(m, m, r, 0, TAU); g.stroke() }
  for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU; g.beginPath(); g.moveTo(m + Math.cos(a) * 14, m + Math.sin(a) * 14); g.lineTo(m + Math.cos(a) * 104, m + Math.sin(a) * 104); g.stroke() }
  g.strokeStyle = 'rgba(46,230,200,.2)'; g.lineWidth = 1.5
  for (let k = -5; k <= 5; k++) { g.beginPath(); g.moveTo(m + k * 22 - 110, m - 110); g.lineTo(m + k * 22 + 110, m + 110); g.stroke(); g.beginPath(); g.moveTo(m + k * 22 + 110, m - 110); g.lineTo(m + k * 22 - 110, m + 110); g.stroke() }
  g.restore()
  // 外环：亮青绿 + 极细外圈
  const rg = g.createLinearGradient(0, 0, S, S)
  rg.addColorStop(0, '#7dfbe6'); rg.addColorStop(0.5, teal); rg.addColorStop(1, '#16a892')
  g.strokeStyle = rg; g.lineWidth = 16; g.beginPath(); g.arc(m, m, 112, 0, TAU); g.stroke()
  g.strokeStyle = 'rgba(125,251,230,.55)'; g.lineWidth = 3; g.beginPath(); g.arc(m, m, 126, 0, TAU); g.stroke()
  // 环上的“节”：16 个小刻痕
  g.fillStyle = 'rgba(4,22,26,.75)'
  for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU; g.save(); g.translate(m + Math.cos(a) * 112, m + Math.sin(a) * 112); g.rotate(a); g.fillRect(-3, -9, 6, 18); g.restore() }
  // 中心：品红光晕 + 方块
  const cg = g.createRadialGradient(m, m, 0, m, m, 46)
  cg.addColorStop(0, 'rgba(255,47,160,.85)'); cg.addColorStop(1, 'rgba(255,47,160,0)')
  g.fillStyle = cg; g.beginPath(); g.arc(m, m, 46, 0, TAU); g.fill()
  g.fillStyle = '#ff2fa0'; g.fillRect(m - 17, m - 17, 34, 34)
  g.fillStyle = '#ffd6ef'; g.fillRect(m - 7, m - 7, 14, 14)
  sprites.set('body', c)
  return c
}
function glow(color, size = 64) {
  const key = color + size
  let c = sprites.get(key)
  if (c) return c
  c = makeCanvas(size)
  const g = c.getContext('2d')
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  const [r, gg, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
  gr.addColorStop(0, `rgba(${r},${gg},${b},.95)`); gr.addColorStop(0.2, `rgba(${r},${gg},${b},.5)`); gr.addColorStop(0.55, `rgba(${r},${gg},${b},.14)`); gr.addColorStop(1, `rgba(${r},${gg},${b},0)`)
  g.fillStyle = gr; g.fillRect(0, 0, size, size)
  sprites.set(key, c)
  return c
}

// ---------------------------------------------------------------------------
// 蜘蛛
// ---------------------------------------------------------------------------
/**
 * @param {{nodes:()=>{x:number,y:number,id:string,c?:{color:string}}[], clusters:()=>{key:string,idxs:number[],color:string,n:number}[], indexOf:(id:string)=>number|undefined, reduced?:boolean, rand?:()=>number, mono?:string, colorOf?:(node:object)=>string}} env
 */
export function createSpider(env) {
  const rand = env.rand || Math.random
  const reduced = !!env.reduced
  const MONO = env.mono || 'ui-monospace, Menlo, monospace'
  const colorOf = env.colorOf || ((n) => n?.c?.color || '#2ee6ff')
  const S = {
    enabled: true, inited: false, x: 0, y: 0, rot: rand() * TAU, T: 0,
    mode: 'wander', seg: null, dwell: 1, lastCluster: '', preferCluster: '',
    trail: [], trailT: 0, trailColor: '#2ee6c8',
    legs: Array.from({ length: LEG_COUNT }, (_, i) => ({ fx: 0, fy: 0, node: -1, pin: -1, t: 0, life: 1.2 + rand() * 1.6, seed: rand() * TAU, init: false, i })),
    cursor: 0, ripples: [],
    collected: new Map(), // id → { rank, t0 }
    tour: null, // { queue:[hit...], cur:hit|null }
    inspect: null, // { id, rank, title, t0, thrown, hero }
    thinkUntil: 0, thinking: false,
    dim: 0, dimTarget: 0,
    view: { zoom: 1, panX: 0, panY: 0 },
  }
  const api = { on: {} }
  const nodes = () => env.nodes() || []

  // ---- 工具 ----
  const nodePos = (i) => { const n = nodes()[i]; return n ? { x: n.x, y: n.y } : null }
  const largestCluster = () => (env.clusters() || []).slice().sort((a, b) => b.n - a.n)[0]
  function spawn() {
    const cl = largestCluster()
    if (!cl) return false
    const n = nodes()[cl.idxs[Math.floor(rand() * cl.idxs.length)]]
    if (!n) return false
    S.x = n.x; S.y = n.y; S.inited = true
    return true
  }
  function pushRipple(x, y, color, big = false) {
    if (reduced) return
    S.ripples.push({ x, y, t0: S.T, color, big })
    if (S.ripples.length > 28) S.ripples.shift()
  }
  const reachWorld = () => REACH_PX / S.view.zoom

  // ---- 行为：游走 ----
  function startSegment(target, { dur, ease = true, bend = 0.28, offDir = null, kind = 'point', nodeIdx = -1, smooth = true }) {
    const p0 = { x: S.x, y: S.y }
    const p1 = target
    const c = smooth ? smoothControl(p0, p1, S.heading) : arcControl(p0, p1, bend, S.preferSign = -(S.preferSign || 1))
    S.seg = { p0, c, p1: { ...p1 }, t0: S.T, dur, ease, offDir, kind, nodeIdx, p1live: null }
  }
  function pickWanderTarget() {
    const cls = (env.clusters() || []).filter((c) => c.idxs.length)
    if (!cls.length) return null
    let pool = S.preferCluster ? cls.filter((c) => c.key === S.preferCluster) : cls
    if (!pool.length) pool = cls
    const others = pool.filter((c) => c.key !== S.lastCluster)
    const list = others.length ? others : pool
    const wsum = list.reduce((s, c) => s + Math.sqrt(c.n), 0)
    let r = rand() * wsum; let cl = list[0]
    for (const c of list) { r -= Math.sqrt(c.n); if (r <= 0) { cl = c; break } }
    const idx = cl.idxs[Math.floor(rand() * cl.idxs.length)]
    const n = nodes()[idx]
    if (!n) return null
    S.lastCluster = cl.key
    return { x: n.x, y: n.y, color: cl.color, idx }
  }
  function beginWander() {
    S.mode = 'wander'; S.seg = null; S.dwell = 0.8 + rand() * 1.6
  }
  function nextWanderSeg() {
    const t = pickWanderTarget()
    if (!t) { S.dwell = 2; return }
    const dScreen = Math.hypot(t.x - S.x, t.y - S.y) * S.view.zoom
    S.trailColor = t.color
    startSegment({ x: t.x, y: t.y }, { dur: clamp(dScreen / 52, 3.5, 14), ease: true, bend: 0.3 })
  }

  // ---- 行为：巡游（路线与时间表来自纯函数 buildTourPlan）----
  function nextTourStop() {
    if (!S.tour) return
    const stop = S.tour.queue.shift()
    if (!stop) { finishTour(); return }
    const i = env.indexOf(stop.id)
    const n = i === undefined ? null : nodes()[i]
    if (!n) { nextTourStop(); return }
    S.tour.cur = stop
    const len = Math.hypot(n.x - S.x, n.y - S.y) || 1
    const offDir = { x: (S.x - n.x) / len, y: (S.y - n.y) / len }
    S.mode = 'tour'
    S.trailColor = colorOf(n)
    startSegment({ x: n.x, y: n.y }, { dur: Math.max(0.12, stop.travelMs / 1000), ease: true, offDir, kind: 'node', nodeIdx: i })
    S.seg.stop = stop
  }
  function arriveTour() {
    const stop = S.seg.stop
    const i = env.indexOf(stop.id)
    const n = i === undefined ? null : nodes()[i]
    S.seg = null
    if (!n) { nextTourStop(); return }
    // 英雄腿：方向最接近“身体→节点”的那条，钉在节点上（脚踩上去）
    const a = Math.atan2(n.y - S.y, n.x - S.x)
    let hero = 0; let bd = Infinity
    S.legs.forEach((l, k) => { const d = Math.abs(Math.atan2(Math.sin(legAngle(k) - a), Math.cos(legAngle(k) - a))); if (d < bd) { bd = d; hero = k } })
    S.legs.forEach((l) => { if (l.pin >= 0) l.pin = -1 })
    S.legs[hero].pin = i
    S.legs[hero].node = i
    S.mode = 'inspect'
    const decoy = stop.kind !== 'hit'
    S.inspect = { id: stop.id, rank: stop.rank, title: stop.title || stop.id, t0: S.T, dur: Math.max(0.1, stop.dwellMs / 1000), thrown: false, hero, idx: i, decoy }
    pushRipple(n.x, n.y, colorOf(n), !decoy)
    if (!decoy) {
      S.collected.set(stop.id, { rank: stop.rank, t0: S.T }) // 脚踩到的这一刻起才高亮
      api.on.inspect?.(stop)
    }
  }
  function tickInspect() {
    const ins = S.inspect
    const p = (S.T - ins.t0) / ins.dur
    if (!ins.decoy && !ins.thrown && p >= THROW_AT) {
      ins.thrown = true
      const n = nodes()[ins.idx]
      if (n) pushRipple(n.x, n.y, '#ffffff', true)
      api.on.throw?.({ id: ins.id, rank: ins.rank, title: ins.title })
    }
    if (p >= 1) {
      S.legs[ins.hero].pin = -1
      S.inspect = null
      nextTourStop()
    }
  }
  function finishTour() {
    S.tour = null; S.seg = null
    S.mode = 'think'; S.thinking = true; S.thinkUntil = 0
    api.on.done?.()
  }

  function legAngle(i) { return (i / LEG_COUNT) * TAU + S.rot * 0.35 }

  // ---- 腿 ----
  function updateLegs(dt) {
    const z = S.view.zoom
    const busy = S.mode === 'think' || S.mode === 'inspect' || S.mode === 'scan'
    const reach = reachWorld() * (S.mode === 'scan' ? 1.4 : 1)
    const pulseAmp = reduced ? 0 : busy ? 0.26 : 0.14
    const pulseF = busy ? (S.mode === 'think' ? 6.5 : S.mode === 'scan' ? 5 : 4.2) : 2
    const nn = nodes()
    // 已被占用的节点
    const taken = new Set()
    for (const l of S.legs) if (l.node >= 0) taken.add(l.node)
    let budget = reduced && !S.legsReady ? LEG_COUNT : 4
    for (let k = 0; k < LEG_COUNT && budget > 0; k++) {
      const i = (S.cursor + k) % LEG_COUNT
      const l = S.legs[i]
      if (l.pin >= 0) continue
      const a = legAngle(i)
      const R = reach * (0.85 + 0.15 * Math.sin(S.T * 0.7 + l.seed))
      const ix = S.x + Math.cos(a) * R; const iy = S.y + Math.sin(a) * R
      let need = !l.init || (l.node < 0 && S.T - l.t > 0.55) || S.T - l.t > l.life
      if (!need && l.node >= 0) {
        const d = Math.hypot(l.fx - S.x, l.fy - S.y) * z
        if (d > REACH_PX * 1.45 || d < REACH_PX * 0.3) need = true
        const nd = nn[l.node]
        if (!nd) need = true
      }
      if (!need) continue
      budget--
      if (l.node >= 0) taken.delete(l.node)
      const j = pickFoot(nn, ix, iy, (REACH_PX * 0.5) / z, taken)
      if (j >= 0) {
        taken.add(j)
        if (j !== l.node) { const n = nn[j]; pushRipple(n.x, n.y, colorOf(n)) }
      }
      l.node = j; l.t = S.T; l.life = 1.3 + rand() * 1.8
      if (!l.init) { l.fx = j >= 0 ? nn[j].x : ix; l.fy = j >= 0 ? nn[j].y : iy; l.init = true }
    }
    S.cursor = (S.cursor + 4) % LEG_COUNT
    if (reduced) S.legsReady = true
    for (const l of S.legs) {
      const i = l.i
      let gx; let gy
      const tn = l.pin >= 0 ? nn[l.pin] : l.node >= 0 ? nn[l.node] : null
      if (tn) { gx = tn.x; gy = tn.y } else {
        const a = legAngle(i); const R = reach * (0.85 + 0.15 * Math.sin(S.T * 0.7 + l.seed))
        gx = S.x + Math.cos(a) * R; gy = S.y + Math.sin(a) * R
      }
      const k = reduced ? 1 : Math.min(1, dt * (l.pin >= 0 ? 16 : 10))
      l.fx += (gx - l.fx) * k; l.fy += (gy - l.fy) * k
      l.ext = 1 - pulseAmp * (0.5 + 0.5 * Math.sin(S.T * pulseF + l.seed * 3 + i * 0.6))
      if (l.pin >= 0) l.ext = 1
    }
  }

  // ---- 每帧更新 ----
  /** @returns {boolean} 是否仍在动画（调用方据此决定要不要继续 rAF） */
  api.update = (dt, view) => {
    S.view = view
    dt = clamp(dt, 0, 0.06)
    S.T += dt
    // 暗化目标：只在第一个命中被踩到之后才开始压暗其余节点（此前画面与普通状态一致，不泄露命中位置）（蜘蛛关闭时收集结果的高亮 / 暗化照样生效）
    S.dimTarget = S.collected.size > 0 ? 0.6 : 0
    const dd = S.dimTarget - S.dim
    S.dim = reduced || Math.abs(dd) < 0.005 ? S.dimTarget : S.dim + dd * Math.min(1, dt * 5)
    const dimAnim = Math.abs(S.dim - S.dimTarget) > 0.001
    if (!S.enabled) return dimAnim
    if (!S.inited && !spawn()) return dimAnim
    if (reduced) { updateLegs(dt); return dimAnim }
    S.rot += dt * 0.5
    if (S.mode === 'wander') {
      if (!S.seg) { S.dwell -= dt; if (S.dwell <= 0) nextWanderSeg() }
    } else if (S.mode === 'scan') {
      if (S.T >= S.scanUntil) nextTourStop()
    } else if (S.mode === 'think') {
      if (S.thinkUntil && S.T >= S.thinkUntil) { S.thinking = false; beginWander() }
    } else if (S.mode === 'inspect') tickInspect()
    if (S.seg) {
      const sg = S.seg
      let p1 = sg.p1
      if (sg.kind === 'node') {
        const n = nodes()[sg.nodeIdx]
        if (n) { const off = 34 / S.view.zoom; p1 = { x: n.x + sg.offDir.x * off, y: n.y + sg.offDir.y * off } }
      }
      const u = clamp((S.T - sg.t0) / sg.dur, 0, 1)
      const e = sg.ease ? easeInOut(u) : u
      const pos = bezier2(sg.p0, sg.c, p1, e)
      const tg = bezier2Tangent(sg.p0, sg.c, p1, Math.min(0.999, e))
      if (Math.hypot(tg.x, tg.y) > 1e-6) S.heading = tg
      S.x = pos.x; S.y = pos.y
      if (u >= 1) {
        if (S.mode === 'tour') arriveTour()
        else { S.seg = null; S.dwell = 1.2 + rand() * 2.4 }
      }
    }
    // 拖尾：按时间采样
    S.trailT += dt
    if (S.trailT > 0.045 && (S.seg || S.mode === 'wander')) {
      S.trailT = 0
      const last = S.trail[S.trail.length - 1]
      if (!last || Math.hypot(last.x - S.x, last.y - S.y) * S.view.zoom > 1.5) { S.trail.push({ x: S.x, y: S.y }); if (S.trail.length > TRAIL_MAX) S.trail.shift() }
    } else if (!S.seg && S.trail.length && S.trailT > 0.12) { S.trailT = 0; S.trail.shift() }
    updateLegs(dt)
    while (S.ripples.length && S.T - S.ripples[0].t0 > 0.9) S.ripples.shift()
    return true
  }

  // ---- 绘制 ----
  /** 暗化其余节点 + 已收集节点的霓虹描边 / 光晕 / 名次角标。放在场景之后、选中高亮与标签之前。 */
  api.drawBackdrop = (g, view, w, h) => {
    if (S.dim > 0.004) { g.globalCompositeOperation = 'source-over'; g.globalAlpha = S.dim; g.fillStyle = '#05060a'; g.fillRect(0, 0, w, h) }
    if (!S.collected.size) { g.globalAlpha = 1; return }
    const nn = nodes()
    for (const [id, info] of S.collected) {
      const i = env.indexOf(id)
      const n = i === undefined ? null : nn[i]
      if (!n) continue
      const px = n.x * view.zoom + view.panX; const py = n.y * view.zoom + view.panY
      if (px < -30 || px > w + 30 || py < -30 || py > h + 30) continue
      const col = colorOf(n)
      const age = S.T - info.t0
      const pop = reduced ? 1 : easeOutBack(clamp(age / 0.35, 0, 1))
      const pulse = reduced ? 0 : Math.sin(S.T * 3 + info.rank) * 1.2
      g.globalCompositeOperation = 'lighter'
      const rg = (20 + pulse) * pop
      g.globalAlpha = 0.95; g.drawImage(glow(col), px - rg, py - rg, rg * 2, rg * 2)
      g.globalCompositeOperation = 'source-over'
      g.globalAlpha = 1; g.lineWidth = 1.7; g.strokeStyle = col
      g.beginPath(); g.arc(px, py, (6.5 + pulse * 0.4) * pop, 0, TAU); g.stroke()
      g.fillStyle = '#fff'; g.beginPath(); g.arc(px, py, 2.6 * pop, 0, TAU); g.fill()
      // 名次角标
      g.font = `700 10px ${MONO}`; g.textAlign = 'center'; g.textBaseline = 'middle'
      const t = String(info.rank); const bw = Math.max(15, g.measureText(t).width + 8)
      const bx = px + 9; const by = py - 20
      g.fillStyle = col; g.fillRect(bx, by, bw, 14)
      g.fillStyle = '#05060a'; g.fillText(t, bx + bw / 2, by + 7.5)
    }
    g.globalAlpha = 1
  }

  /** 蜘蛛本体：拖尾 → 触手（单条 path）→ 落脚点 → 身体 sprite → 涟漪。alpha 由调用方按交互状态给（聚焦/拖拽时调淡）。 */
  api.drawBody = (g, view, w, h, alpha = 0.92) => {
    if (!S.enabled || !S.inited) return
    const z = view.zoom
    const bx = S.x * z + view.panX; const by = S.y * z + view.panY
    const margin = REACH_PX * 1.8
    if (bx < -margin || bx > w + margin || by < -margin || by > h + margin) return
    g.save()
    g.lineCap = 'round'; g.lineJoin = 'round'
    // 拖尾（世界坐标 → 屏幕；三段递增透明度，仅 3 次 stroke）
    const tr = S.trail
    if (tr.length > 3 && !reduced) {
      g.globalCompositeOperation = 'lighter'
      g.strokeStyle = S.trailColor; g.lineWidth = 1.6
      const segs = 3; const per = Math.ceil(tr.length / segs)
      for (let s = 0; s < segs; s++) {
        const a0 = s * per; const a1 = Math.min(tr.length, (s + 1) * per + 1)
        if (a1 - a0 < 2) continue
        g.globalAlpha = alpha * (0.12 + 0.3 * ((s + 1) / segs))
        g.beginPath()
        for (let k = a0; k < a1; k++) { const px = tr[k].x * z + view.panX; const py = tr[k].y * z + view.panY; if (k === a0) g.moveTo(px, py); else g.lineTo(px, py) }
        g.stroke()
      }
    }
    // 身体光晕
    const think = S.mode === 'think'
    g.globalCompositeOperation = 'lighter'
    const hg = BODY_R * (think ? 3.6 + Math.sin(S.T * 6) * 0.5 : 3.1)
    g.globalAlpha = alpha * (think ? 0.65 : 0.4)
    g.drawImage(glow(think ? '#ff2fa0' : '#2ee6c8'), bx - hg, by - hg, hg * 2, hg * 2)
    // 触手：所有腿合并成一条 path，一次 stroke（点状虚线，沿腿向外流动）
    const legPath = new Path2D(); const heroPath = new Path2D(); let hasHero = false
    const footDots = new Path2D()
    for (const l of S.legs) {
      if (!l.init) continue
      const a = legAngle(l.i)
      const sx0 = bx + Math.cos(a) * BODY_R * 0.92; const sy0 = by + Math.sin(a) * BODY_R * 0.92
      let ex = l.fx * z + view.panX; let ey = l.fy * z + view.panY
      const ext = l.ext ?? 1
      ex = sx0 + (ex - sx0) * ext; ey = sy0 + (ey - sy0) * ext
      const dx = ex - sx0; const dy = ey - sy0; const len = Math.hypot(dx, dy)
      if (len < 3) continue
      // 触手弯曲：垂直方向的缓慢摆动，近似“有弹性的肢体”
      const bend = (reduced ? 0.1 : 0.16 * Math.sin(S.T * 1.3 + l.seed)) + 0.08
      const cx = (sx0 + ex) / 2 - dy * bend; const cy = (sy0 + ey) / 2 + dx * bend
      const target = l.pin >= 0 ? heroPath : legPath
      if (l.pin >= 0) hasHero = true
      target.moveTo(sx0, sy0); target.quadraticCurveTo(cx, cy, ex, ey)
      footDots.moveTo(ex + 1.9, ey); footDots.arc(ex, ey, 1.9, 0, TAU)
    }
    g.globalAlpha = alpha * 0.9
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.6
    g.setLineDash([0.1, 4.6]); g.lineDashOffset = reduced ? 0 : -(S.T * (think ? 38 : 14))
    g.stroke(legPath)
    if (hasHero) { g.globalAlpha = alpha; g.lineWidth = 2.4; g.setLineDash([0.1, 3.6]); g.strokeStyle = '#ffe3f6'; g.stroke(heroPath) }
    g.setLineDash([]); g.lineDashOffset = 0
    g.globalCompositeOperation = 'source-over'
    g.globalAlpha = alpha; g.fillStyle = '#ffffff'; g.fill(footDots)
    // 身体：环缓慢旋转
    g.globalAlpha = alpha
    g.translate(bx, by); g.rotate(S.rot)
    const sp = bodySprite()
    g.drawImage(sp, -BODY_R, -BODY_R, BODY_R * 2, BODY_R * 2)
    g.rotate(-S.rot); g.translate(-bx, -by)
    // 思考：绕身体旋转的三个小亮点
    if (think && !reduced) {
      g.globalCompositeOperation = 'lighter'; g.fillStyle = '#ff7ad9'
      for (let k = 0; k < 3; k++) { const a = S.T * 4 + (k * TAU) / 3; g.globalAlpha = alpha; g.beginPath(); g.arc(bx + Math.cos(a) * BODY_R * 1.6, by + Math.sin(a) * BODY_R * 1.6, 2.2, 0, TAU); g.fill() }
    }
    // 涟漪：脚落在节点上时的一圈扩散环（普通触碰淡、命中/检查时亮）
    g.globalCompositeOperation = 'lighter'
    for (const r of S.ripples) {
      const p = (S.T - r.t0) / (r.big ? 0.85 : 0.6)
      if (p < 0 || p > 1) continue
      const px = r.x * z + view.panX; const py = r.y * z + view.panY
      g.globalAlpha = alpha * (r.big ? 0.9 : 0.5) * (1 - p)
      g.lineWidth = r.big ? 2 : 1.1; g.strokeStyle = r.color
      g.beginPath(); g.arc(px, py, (r.big ? 8 : 4) + p * (r.big ? 34 : 14), 0, TAU); g.stroke()
    }
    g.restore()
  }

  /** 检查中的节点：放大发光 + 弹出标题标签（最后画，盖在其它标签上面）。 */
  api.drawInspect = (g, view, w, h, labelOf) => {
    const ins = S.inspect
    if (!S.enabled || !ins || ins.decoy) return
    const n = nodes()[ins.idx]
    if (!n) return
    const px = n.x * view.zoom + view.panX; const py = n.y * view.zoom + view.panY
    const col = colorOf(n)
    const age = S.T - ins.t0
    const pop = easeOutBack(clamp(age / 0.3, 0, 1))
    g.save()
    g.globalCompositeOperation = 'lighter'
    const rg = (30 + Math.sin(S.T * 9) * 3) * pop
    g.globalAlpha = 1; g.drawImage(glow(col), px - rg, py - rg, rg * 2, rg * 2)
    g.globalCompositeOperation = 'source-over'
    g.lineWidth = 2; g.strokeStyle = '#fff'; g.beginPath(); g.arc(px, py, 7 * pop, 0, TAU); g.stroke()
    const txt = labelOf ? labelOf(ins) : ins.title
    g.font = `600 12.5px ${MONO}`; g.textBaseline = 'middle'; g.textAlign = 'left'
    const bw = g.measureText(txt).width + 16; const bh = 24
    let bx = px + 16; let by = py - bh - 12
    if (bx + bw > w - 4) bx = px - bw - 16
    if (by < 4) by = py + 14
    const s = clamp(pop, 0.01, 1.08)
    g.translate(bx + bw / 2, by + bh / 2); g.scale(s, s)
    g.globalAlpha = clamp(age / 0.18, 0, 1)
    g.fillStyle = col; g.fillRect(-bw / 2, -bh / 2, bw, bh)
    g.lineWidth = 1.2; g.strokeStyle = '#fff'; g.strokeRect(-bw / 2 + 0.5, -bh / 2 + 0.5, bw - 1, bh - 1)
    g.fillStyle = '#05060a'; g.fillText(txt, -bw / 2 + 8, 0.5)
    g.restore()
  }

  // ---- 控制接口 ----
  api.setEnabled = (b) => { S.enabled = !!b; if (!b) { S.tour = null; S.inspect = null; S.seg = null } }
  Object.defineProperty(api, 'enabled', { get: () => S.enabled })
  Object.defineProperty(api, 'reduced', { get: () => reduced })
  api.setPreferCluster = (key) => { S.preferCluster = key || '' }
  /** 清掉对旧布局的引用（图谱重建后调用）：落脚点重新选取。 */
  api.reset = () => { for (const l of S.legs) { l.node = -1; l.pin = -1; l.init = false } S.legsReady = false; S.seg = null; S.inited = false; S.trail = []; if (S.tour || S.inspect) { S.tour = null; S.inspect = null; S.mode = 'wander' } }
  api.hasResults = () => S.collected.size > 0 || !!S.tour
  api.isBusy = () => !!S.tour || S.mode === 'think' || S.mode === 'inspect'
  api.collectedIds = () => [...S.collected.keys()]
  /** 巡游：依次走过干扰节点与全部命中节点（见 buildTourPlan）。hits: [{id, rank, title}]（须已在图中）。返回计划，失败返回 null。 */
  api.startTour = (hits, { maxMs = 12000 } = {}) => {
    if (!S.enabled || reduced || !S.inited || !hits.length) return null
    const nn = nodes()
    const pts = hits.map((h) => { const i = env.indexOf(h.id); const n = i === undefined ? null : nn[i]; return n ? { ...h, x: n.x, y: n.y, cluster: n.c?.key || '' } : null }).filter(Boolean)
    if (!pts.length) return null
    S.collected.clear(); S.inspect = null; S.thinking = false
    const plan = buildTourPlan({ x: S.x, y: S.y }, pts, nn, { zoom: S.view.zoom, maxMs })
    S.plan = plan
    S.tour = { queue: plan.stops.slice(), cur: null }
    // 开场先在原地“扫描”（触手展开），再按计划出发
    S.seg = null; S.mode = 'scan'; S.scanUntil = S.T + plan.scanMs / 1000
    return plan
  }
  /** 不播放动画时直接收集（蜘蛛关闭 / 减少动画偏好）。 */
  api.collectNow = (hits) => { S.collected.clear(); for (const h of hits) if (env.indexOf(h.id) !== undefined) S.collected.set(h.id, { rank: h.rank, t0: S.T - 1 }) }
  /** 原地“思考”（脉动）；ms>0 时到点自动回到游走，否则等 release()。 */
  api.think = (ms = 0) => { if (!S.enabled || reduced) return; S.tour = null; S.inspect = null; S.seg = null; S.mode = 'think'; S.thinking = true; S.thinkUntil = ms > 0 ? S.T + ms / 1000 : 0 }
  api.release = () => { if (S.mode === 'think') { S.thinking = false; S.thinkUntil = 0; beginWander(); S.dwell = 0.5 } }
  api.clearResults = () => { S.collected.clear(); S.tour = null; S.inspect = null; for (const l of S.legs) l.pin = -1; if (S.mode === 'tour' || S.mode === 'inspect' || S.mode === 'scan') { S.seg = null; beginWander() } }
  api.snapshot = () => ({ x: S.x, y: S.y, mode: S.mode, T: S.T, planted: S.legs.filter((l) => l.node >= 0).length, legs: S.legs.length, collected: [...S.collected.keys()], inspect: S.inspect?.id || null, plan: S.plan ? { total: S.plan.totalMs, stops: S.plan.stops.length, decoys: S.plan.decoyCount } : null, dim: S.dim, thinking: S.thinking, trail: S.trail.length, enabled: S.enabled })
  return api
}
