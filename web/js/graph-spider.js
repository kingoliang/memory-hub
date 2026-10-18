// 图谱蜘蛛（Canvas 2D 引擎，无 DOM 依赖，模块加载不触碰 document）。
// 外观：青绿色带网格纹圆环 + 中心品红方块，身上伸出 18 条白色点状虚线触手，触手末端“踩”在附近节点上；
// 沿弧线在簇间游走（带拖尾），触手伸缩脉动。游走 / 搜索巡游 / 思考三种行为共用同一套腿部逻辑。
// 性能：身体是预渲染 sprite（drawImage）；所有触手合成一条 path 一次 stroke；落脚点最近邻按帧分摊（每帧至多 4 条腿）。
// 对外只读节点位置（{x,y,c,id}），不改图谱布局；绘制层与命中测试无关，不会拦截任何指针事件。

const TAU = Math.PI * 2
export const BODY_R = 15 // 屏幕像素：随缩放不变
export const THROW_AT = 0.4 // 脚踩到命中节点后，停留进行到该比例时把卡片“扔出去”
const TRAIL_MAX = 80

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
/** 正弦缓入缓出：端点速度为 0，峰值速度 = π/2 × 平均速度（立方缓动是 3×，同样时长下更急冲）。 */
export const easeSine = (p) => 0.5 - 0.5 * Math.cos(Math.PI * p)
/** 簇间跳转 = 屏幕距离 > HOP_PX 的一段。时长 = max(最小时长, 路径长 / 平均速度)：随距离增长，且有下限，不会闪现。 */
export const HOP_PX = 170
export const HOP_MIN_MS = 250
export const STEP_MIN_MS = 90 // 簇内短步最小时长
/** 各段平均速度上限（屏幕 px/s）。正弦缓动峰值 = π/2 × 平均，所以跳转峰值 ≤ ~3300px/s，簇内短步峰值 ≤ ~1250px/s。 */
export const HOP_VAVG_MAX = 2100
export const STEP_VAVG_MAX = 800
export const TURN_RATE_MAX = 25 // rad/s（理论上限 ≈ 24°/帧@60fps，实测更小：转弯主要发生在缓入的低速段）
export const TOUR_MAX_MS = 6300 // 搜索巡游总时长上限
export const TOUR_SCAN_MS = 400 // 开场扫描
export const LEG_SLOTS = 18 // 腿槽位数（上限）
export const LEG_COUNT = LEG_SLOTS
export const LEG_MIN = 3
export const LEG_RHO_PX = 140 // 统计“附近节点数”/ 选落脚点的屏幕半径
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
 * 受曲率限制的转向路径（纯函数）：从 p0 出发，初始航向 h0（C1 连续），每走 ds 最多转 ds/R，朝 p1 追踪（先按最大曲率转弯、对准后直线切过去）。
 * R = min(rMin, 0.9·d/(2|sinα|))：目标必在转弯圆之外，保证收敛、不绕圈；峰值转角率 = 速度 / R，由路径长度与时长共同限定（见 buildTourPlan）。
 * 返回 {pts:[x0,y0,x1,y1…], cum:[累计弧长], len, endDir}；h0 为空时直接朝向 p1。
 */
export function steerPath(p0, h0, p1, { zoom = 1, rMinPx = 160, k = 0.9 } = {}) {
  const L = Math.hypot(p1.x - p0.x, p1.y - p0.y)
  const hh = h0 && Math.hypot(h0.x, h0.y) > 1e-9 ? h0 : null
  let th = hh ? Math.atan2(hh.y, hh.x) : Math.atan2(p1.y - p0.y, p1.x - p0.x)
  if (L < 1e-9) return { pts: [p0.x, p0.y], cum: [0], len: 0, endDir: { x: Math.cos(th), y: Math.sin(th) }, R: Infinity }
  // 恒定最大曲率半径 R：目标在转弯圆之外（R < d / (2|sin α|)）才能“先转弯、再直线切过去”而不绕圈
  const alpha = Math.atan2(Math.sin(Math.atan2(p1.y - p0.y, p1.x - p0.x) - th), Math.cos(Math.atan2(p1.y - p0.y, p1.x - p0.x) - th))
  const R = Math.min(rMinPx / zoom, (k * L) / (2 * Math.max(Math.abs(Math.sin(alpha)), 0.05)))
  const ds = Math.max(L / 240, 0.4 / zoom)
  const lim = ds / R
  const pts = [p0.x, p0.y]
  let x = p0.x; let y = p0.y
  for (let i = 0; i < 8000; i++) {
    const dx = p1.x - x; const dy = p1.y - y; const d = Math.hypot(dx, dy)
    if (d <= ds * 1.01) break
    const phi = Math.atan2(dy, dx)
    const dth = clamp(Math.atan2(Math.sin(phi - th), Math.cos(phi - th)), -lim, lim)
    th += dth; x += Math.cos(th) * ds; y += Math.sin(th) * ds
    pts.push(x, y)
  }
  pts.push(p1.x, p1.y)
  const cum = [0]
  for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]))
  const n = pts.length
  let ex = pts[n - 2] - pts[n - 4]; let ey = pts[n - 1] - pts[n - 3]
  const el = Math.hypot(ex, ey)
  if (el < 1e-9) { ex = Math.cos(th); ey = Math.sin(th) } else { ex /= el; ey /= el }
  return { pts, cum, len: cum[cum.length - 1], endDir: { x: ex, y: ey }, R }
}
/** 路径上弧长 s 处的位置与单位切线。 */
export function pathAt(path, s) {
  const { pts, cum } = path
  if (cum.length < 2) return { x: pts[0], y: pts[1], dx: path.endDir.x, dy: path.endDir.y }
  const t = clamp(s, 0, path.len)
  let lo = 0; let hi = cum.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= t) lo = m; else hi = m }
  const seg = cum[hi] - cum[lo] || 1
  const f = (t - cum[lo]) / seg
  const x0 = pts[lo * 2]; const y0 = pts[lo * 2 + 1]; const x1 = pts[hi * 2]; const y1 = pts[hi * 2 + 1]
  const l = Math.hypot(x1 - x0, y1 - y0) || 1
  return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, dx: (x1 - x0) / l, dy: (y1 - y0) / l }
}

/**
 * 腿数（纯函数）：附近（屏幕半径 LEG_RHO_PX 内）节点数 n 越多腿越多。目标 = clamp(round(1.6·√n), 3, 18)，再 ≤ n（腿数绝不超过节点数，不允许悬空腿）。
 * 滞回：与上一次腿数 prev 比，1.6·√n 偏离 prev 不到 0.9（= 0.5 的四舍五入带 + 0.4 的滞回）时保持 prev，避免节点数在阈值附近波动时腿数抖动。
 * 对应：n=1…2 → n；n=4 → 3；n=9 → 5；n=25 → 8；n=64 → 13；n≥127 → 18。
 */
export function legCount(n, prev) {
  const raw = 1.6 * Math.sqrt(Math.max(0, n))
  let k = prev === undefined || prev === null || prev < 0 ? Math.round(raw) : Math.abs(raw - prev) < 0.9 ? prev : Math.round(raw)
  k = clamp(k, LEG_MIN, LEG_SLOTS)
  return Math.min(k, Math.max(0, Math.floor(n)))
}
/** 槽位启用顺序：黄金角间隔，任意前缀都近似均匀分布在圆周上；k 增减一条 = 只翻转一个槽位。 */
const SLOT_ORDER = (() => {
  const free = Array.from({ length: LEG_SLOTS }, (_, i) => i); const out = []
  for (let j = 0; j < LEG_SLOTS; j++) {
    const pos = ((j * 0.6180339887) % 1) * LEG_SLOTS
    let bi = 0; let bd = Infinity
    free.forEach((slot, k) => { const d = Math.min(Math.abs(slot - pos), LEG_SLOTS - Math.abs(slot - pos)); if (d < bd - 1e-9) { bd = d; bi = k } })
    out.push(free.splice(bi, 1)[0])
  }
  return out
})()
/** 从 LEG_SLOTS 个槽位里均匀挑 k 个“在用”的腿。 */
export function activeSlots(k, total = LEG_SLOTS) {
  const kk = clamp(Math.round(k), 0, total)
  const out = new Array(total).fill(false)
  for (let j = 0; j < kk; j++) out[SLOT_ORDER[j]] = true
  return out
}
/**
 * 脚点分配（纯函数）：每条腿一个互不相同的节点（节点下标 = nodes 的下标）。
 * 每条腿的理想落点 = 身体 + 方向 angles[i] × reach；所有(腿,节点)按理想点距离升序贪心配对。pin = {腿下标: 节点下标} 先占位（检查腿踩目标节点）。
 * 只考虑离身体 ≤ rho 的节点；节点不够时该腿为 -1（调用方应减少腿数，不画悬空腿）。
 */
export function assignFeet(body, nodes, angles, { reach = 90, rho = Infinity, pin = {} } = {}) {
  const out = new Array(angles.length).fill(-1)
  const taken = new Set()
  for (const [li, ni] of Object.entries(pin)) { out[Number(li)] = ni; taken.add(ni) }
  const pairs = []
  angles.forEach((a, li) => {
    if (out[li] >= 0) return
    const ix = body.x + Math.cos(a) * reach; const iy = body.y + Math.sin(a) * reach
    for (let ni = 0; ni < nodes.length; ni++) {
      if (taken.has(ni)) continue
      const n = nodes[ni]
      if (Math.hypot(n.x - body.x, n.y - body.y) > rho) continue
      pairs.push([Math.hypot(n.x - ix, n.y - iy), li, ni])
    }
  })
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2])
  for (const [, li, ni] of pairs) if (out[li] < 0 && !taken.has(ni)) { out[li] = ni; taken.add(ni) }
  return out
}
/** 单条腿换脚：离理想点 (ix,iy) 最近、离身体 ≤ rho、未被占用的节点；没有则 -1。 */
export function pickStep(nodes, ix, iy, taken, body, rho) {
  let best = -1; let bd = Infinity
  const r2 = rho * rho
  for (let i = 0; i < nodes.length; i++) {
    if (taken.has(i)) continue
    const n = nodes[i]
    const bx = n.x - body.x; const by = n.y - body.y
    if (bx * bx + by * by > r2) continue
    const d = (n.x - ix) * (n.x - ix) + (n.y - iy) * (n.y - iy)
    if (d < bd) { bd = d; best = i }
  }
  return best
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
  const maxMs = o.maxMs || TOUR_MAX_MS
  const maxDecoys = o.maxDecoys ?? 6
  const maxPerLeg = o.maxPerLeg ?? 2
  const scanMs = o.scanMs ?? TOUR_SCAN_MS
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
  // 3. 时间表：每段路径用 steerPath 实际生成（受曲率限制、C1 连续），时长按路径长度算
  const OFF = 34 / zoom // 身体停在离节点 34 屏幕像素处（检查腿伸过去踩节点中心）
  const timeline = (stops, { hop, step, hitDwell, decoyDwell }) => {
    let c = { x: start.x, y: start.y }; let body = { x: start.x, y: start.y }; let hdg = o.heading || null
    let t = scanMs
    return stops.map((st) => {
      const dPx = dist(c, st) * zoom
      const isHop = dPx > HOP_PX
      const l0 = dist(body, st) || 1
      const end = { x: st.x + ((body.x - st.x) / l0) * OFF, y: st.y + ((body.y - st.y) / l0) * OFF }
      const path = steerPath(body, hdg, end, { zoom })
      const pathPx = path.len * zoom
      // 时长 = 按平均速度算的时长，且不得短到让“峰值速度 / 转弯半径”超过 TURN_RATE_MAX（急转弯的段给更多时间，转角变化 ≤ ~20°/帧@60fps）
      const turnMs = ((Math.PI / 2) * pathPx) / (TURN_RATE_MAX * Math.max(1, path.R * zoom)) * 1000
      const travel = Math.max(turnMs, isHop
        ? Math.max(HOP_MIN_MS, (pathPx / Math.min(hop, HOP_VAVG_MAX)) * 1000)
        : Math.max(STEP_MIN_MS, (pathPx / Math.min(step, STEP_VAVG_MAX)) * 1000))
      const dwell = st.kind === 'hit' ? hitDwell : decoyDwell
      const arriveMs = t + travel
      t = arriveMs + dwell
      c = st; body = end; hdg = path.endDir
      return { ...st, hop: isHop, distPx: dPx, pathPx, path, travelMs: travel, dwellMs: dwell, arriveMs, leaveMs: t }
    })
  }
  // 时间不够时的顺序：先减干扰节点 → 再压缩停顿（命中停顿最低 250ms）并加快步速 → 最后只等比压缩“停顿 / 扫描 / 短步”，簇间跳转保持限速
  let params = { hop: 1500, step: 620, hitDwell: 320, decoyDwell: 150 }
  const nAll = [...chosen.values()].reduce((a, b) => a + b.length, 0)
  let n = nAll
  let stops = timeline(compose(n), params)
  const total = (st) => (st.length ? st[st.length - 1].leaveMs : scanMs)
  while (total(stops) > maxMs && n > 0) { n--; stops = timeline(compose(n), params) }
  for (let k = 0; k < 4 && total(stops) > maxMs; k++) {
    params = { hop: params.hop * 1.15, step: params.step * 1.25, hitDwell: Math.max(250, params.hitDwell * 0.9), decoyDwell: 110 }
    stops = timeline(compose(n), params)
  }
  let scaled = false
  const tot = total(stops)
  if (tot > maxMs) {
    scaled = true
    const hopSum = stops.filter((x) => x.hop).reduce((a, x) => a + x.travelMs, 0)
    // 只压缩非跳转部分；跳转本身已占去绝大部分预算时才退回整体等比压缩
    const keepHops = hopSum < maxMs * 0.7
    const f = keepHops ? (maxMs - hopSum) / (tot - hopSum) : maxMs / tot
    let t = 0; let prev = 0
    stops = stops.map((st) => {
      const gap = st.arriveMs - st.travelMs - prev // 上一站离开 → 本站出发之间的间隔（首站为扫描时间）
      const travel = keepHops && st.hop ? st.travelMs : st.travelMs * f
      const dwell = st.dwellMs * f
      t += gap * f + travel
      const arriveMs = t; t += dwell; prev = st.leaveMs
      return { ...st, travelMs: travel, dwellMs: dwell, arriveMs, leaveMs: t }
    })
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
    legs: Array.from({ length: LEG_SLOTS }, (_, i) => ({ fx: 0, fy: 0, node: -1, last: -1, pin: -1, a: 0, air: false, fl: null, t: 0, life: 0.6 + rand() * 1.0, seed: rand() * TAU, starvedUntil: 0, i })),
    legInit: false, legWant: undefined, legCur: 0, legStepT: 0, slots: activeSlots(0),
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
    S.mode = 'wander'; S.seg = null; S.dwell = 0.4 + rand() * 0.8
  }
  function nextWanderSeg() {
    const t = pickWanderTarget()
    if (!t) { S.dwell = 2; return }
    const dScreen = Math.hypot(t.x - S.x, t.y - S.y) * S.view.zoom
    S.trailColor = t.color
    startSegment({ x: t.x, y: t.y }, { dur: clamp(dScreen / 104, 1.8, 7), ease: true, bend: 0.3 })
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
    S.mode = 'tour'
    S.trailColor = colorOf(n)
    // 路径来自计划（steerPath：受曲率限制、起飞方向 = 上一段结束方向）；没有时（理论上不会）现场生成
    const path = stop.path || steerPath({ x: S.x, y: S.y }, S.heading, { x: n.x, y: n.y }, { zoom: S.view.zoom })
    S.seg = { path, t0: S.T, dur: Math.max(0.08, stop.travelMs / 1000), ease: easeSine, kind: 'path', nodeIdx: i, stop }
  }
  function arriveTour() {
    const stop = S.seg.stop
    const i = env.indexOf(stop.id)
    const n = i === undefined ? null : nodes()[i]
    S.seg = null
    if (!n) { nextTourStop(); return }
    // 检查腿：在用的腿里方向最接近“身体→节点”的那条，钉在节点中心上（脚踩上去）
    const a = Math.atan2(n.y - S.y, n.x - S.x)
    let hero = -1; let bd = Infinity
    S.legs.forEach((l, k) => { if (!S.slots[k] && l.a < 1) return; const d = Math.abs(Math.atan2(Math.sin(legAngle(k) - a), Math.cos(legAngle(k) - a))); if (d < bd) { bd = d; hero = k } })
    if (hero < 0) hero = 0
    S.legs.forEach((l) => { if (l.pin >= 0) l.pin = -1 })
    S.legs[hero].pin = i
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

  const legAngle = (i) => (i / LEG_SLOTS) * TAU + S.rot * 0.35
  const legRho = () => LEG_RHO_PX / S.view.zoom
  // 触手末端永远钉在真实节点上：换脚 = 旧节点上的触手淡出 + 新节点上的淡入；伸出 = 原地淡入；收起 = 锚在旧节点上淡出。
  // 过渡只动透明度与触手中段弯曲，不让脚尖经过节点之间的空白处。l.last = 收起中的锚点节点。
  function releaseLeg(l) { if (l.node >= 0) l.last = l.node; l.node = -1; l.fl = null }
  /** 换脚过渡：from = 正在淡出的旧锚点节点（-1 表示从无到有）。 */
  const stepFrom = (l) => (l.node >= 0 ? l.node : l.a > 0 ? l.last : -1)
  /** 首次 / 重建后：按节点密度一次性站好（每条腿一个互不相同的节点）。 */
  function initLegs() {
    const nn = nodes(); const rho = legRho()
    const near = []
    for (let i = 0; i < nn.length; i++) if (Math.hypot(nn[i].x - S.x, nn[i].y - S.y) <= rho) near.push(i)
    S.legWant = legCount(near.length, undefined); S.legCur = S.legWant
    S.slots = activeSlots(S.legCur)
    const idxs = S.legs.map((_, i) => i).filter((i) => S.slots[i])
    const feet = assignFeet({ x: S.x, y: S.y }, near.map((i) => nn[i]), idxs.map(legAngle), { reach: rho * 0.62, rho })
    for (const l of S.legs) { l.node = -1; l.last = -1; l.a = 0; l.fl = null; l.air = false; l.fx = S.x; l.fy = S.y }
    idxs.forEach((li, k) => { const ni = feet[k] >= 0 ? near[feet[k]] : -1; const l = S.legs[li]; if (ni >= 0) { l.node = ni; l.fx = nn[ni].x; l.fy = nn[ni].y; l.a = 1; l.t = S.T - rand() * 0.6 } })
    S.legInit = true
  }
  function updateLegs(dt) {
    if (!S.legInit) initLegs()
    const nn = nodes(); const rho = legRho(); const z = S.view.zoom
    const body = { x: S.x, y: S.y }
    // 1. 附近节点数 → 腿数（带滞回；逐条增减，间隔 ≥ 70ms）
    let nNear = 0; const r2 = rho * rho
    for (let i = 0; i < nn.length; i++) { const dx = nn[i].x - S.x; const dy = nn[i].y - S.y; if (dx * dx + dy * dy <= r2) nNear++ }
    S.legWant = legCount(nNear, S.legWant)
    if (reduced) S.legCur = S.legWant
    else if (S.legCur !== S.legWant && S.T - S.legStepT >= 0.07) { S.legCur += Math.sign(S.legWant - S.legCur); S.legStepT = S.T }
    S.legCur = Math.min(S.legCur, Math.max(0, nNear))
    S.slots = activeSlots(S.legCur)
    // 2. 占用表 + 检查腿先占位
    const taken = new Set()
    for (const l of S.legs) if (l.node >= 0) taken.add(l.node)
    for (const l of S.legs) {
      if (l.pin < 0) continue
      if (l.node !== l.pin) {
        for (const o of S.legs) if (o !== l && o.node === l.pin) releaseLeg(o)
        if (l.node >= 0) taken.delete(l.node)
        const from = stepFrom(l)
        l.node = l.pin; taken.add(l.pin); l.t = S.T
        l.fl = reduced ? null : { t0: S.T, dur: 0.08, from }
      }
      l.a = 1
    }
    // 3. 在用 / 收起
    const R0 = rho * 0.62
    const flying = () => S.legs.reduce((c, l) => c + (l.fl && l.pin < 0 ? 1 : 0), 0)
    const cap = Math.max(1, Math.floor(S.legCur / 3))
    for (const l of S.legs) {
      const i = l.i
      const want = (S.slots[i] || l.pin >= 0) && S.T >= l.starvedUntil
      if (want) l.a = reduced ? 1 : Math.min(1, l.a + dt / 0.2)
      else {
        if (l.node >= 0) { taken.delete(l.node); releaseLeg(l) }
        l.a = reduced ? 0 : Math.max(0, l.a - dt / 0.12)
        if (l.a === 0) { l.last = -1; l.fx = S.x; l.fy = S.y }
      }
      if (want && l.node < 0 && l.pin < 0) {
        const ang = legAngle(i)
        const j = pickStep(nn, S.x + Math.cos(ang) * R0, S.y + Math.sin(ang) * R0, taken, body, rho)
        if (j >= 0) { const from = stepFrom(l); l.node = j; taken.add(j); l.t = S.T; l.fl = reduced ? null : { t0: S.T, dur: 0.18, from } } else l.starvedUntil = S.T + 0.3
      }
    }
    // 4. 步态：拉太长的腿每帧都处理（簇间快速跳转时不能等轮到，否则会拖出横跨屏幕的长线）；
    //    太久没动的腿轮流检查几条，抬脚换到更合适的节点（同时在空中的腿不超过 cap）
    let budget = reduced ? LEG_SLOTS : 3
    let nFly = flying()
    for (let k = 0; k < LEG_SLOTS; k++) {
      const l = S.legs[(S.cursor + k) % LEG_SLOTS]
      if (l.node < 0 || l.a < 1 || l.pin >= 0) continue
      const tn = nn[l.node]
      if (!tn) { releaseLeg(l); continue }
      const fd = Math.hypot(tn.x - S.x, tn.y - S.y)
      const stretch = fd > rho * 1.05
      if (l.fl && !stretch) continue
      if (!stretch && budget <= 0) continue
      if (!stretch) budget--
      const aged = S.T - l.t > l.life
      if (!stretch && !aged) continue
      if (!reduced && nFly >= cap && !stretch) continue
      const ang = legAngle(l.i); const R = R0 * (0.85 + 0.15 * Math.sin(S.T * 1.4 + l.seed))
      const old = l.node
      taken.delete(l.node)
      const j = pickStep(nn, S.x + Math.cos(ang) * R, S.y + Math.sin(ang) * R, taken, body, rho)
      if (j < 0 && stretch) { releaseLeg(l); l.starvedUntil = S.T + 0.3; continue }
      l.t = S.T; l.life = 0.6 + rand() * 1.0
      if (j < 0 || j === l.node) { taken.add(l.node); continue }
      l.node = j; taken.add(j)
      if (!reduced) { l.fl = { t0: S.T, dur: 0.11, from: old }; nFly++ }
    }
    S.cursor = (S.cursor + 3) % LEG_SLOTS
    // 5. 脚的位置 = 锚点节点中心（世界坐标，随缩放 / 布局跟随）；换脚过渡结束即清除 fl。
    for (const l of S.legs) {
      if (l.fl && S.T - l.fl.t0 >= l.fl.dur) l.fl = null
      const tn = l.node >= 0 ? nn[l.node] : l.last >= 0 ? nn[l.last] : null
      if (tn) { l.fx = tn.x; l.fy = tn.y } else if (l.node >= 0) releaseLeg(l)
      if (l.node < 0 && l.last >= 0 && !nn[l.last]) l.last = -1
      l.air = !!l.fl || l.a < 1
    }
  }
  /**
   * 当前要画的触手（渲染与 snapshot 共用，测试量的就是实际画出来的东西）。
   * 每条：node = 末端所在节点下标（末端 = 该节点中心，从不悬空），alpha = 0..1，hero = 检查腿，lift = 0..1 抬脚弯曲强度。
   */
  function legStrokes() {
    const nn = nodes(); const out = []
    // 超出伸展范围的触手（身体刚跳走、旧脚还没来得及换）按长度淡出，绝不画成横跨屏幕的长线；脚尖仍在节点上
    const rho = legRho()
    const reachFade = (ni) => { const n = nn[ni]; const d = Math.hypot(n.x - S.x, n.y - S.y); return clamp((1.5 * rho - d) / (0.4 * rho), 0, 1) }
    const push = (s) => { s.alpha *= reachFade(s.node); out.push(s) }
    for (const l of S.legs) {
      if (l.a < 0.01) continue
      if (l.node >= 0 && nn[l.node]) {
        let inA = l.a; let lift = 0
        if (l.fl) {
          const p = clamp((S.T - l.fl.t0) / l.fl.dur, 0, 1); const e = easeInOut(p)
          lift = Math.sin(p * Math.PI)
          if (l.fl.from >= 0 && l.fl.from !== l.node && nn[l.fl.from]) push({ leg: l, node: l.fl.from, alpha: l.a * (1 - e), hero: false, lift })
          inA *= e
        }
        if (l.pin >= 0) out.push({ leg: l, node: l.node, alpha: inA, hero: true, lift }) // 检查腿：始终完整可见
        else push({ leg: l, node: l.node, alpha: inA, hero: false, lift })
      } else if (l.last >= 0 && nn[l.last]) {
        push({ leg: l, node: l.last, alpha: l.a, hero: false, lift: 0 })
      }
    }
    return out.filter((s) => s.alpha > 0.02)
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
      const u = clamp((S.T - sg.t0) / sg.dur, 0, 1)
      if (sg.path) {
        const pos = pathAt(sg.path, easeSine(u) * sg.path.len)
        S.x = pos.x; S.y = pos.y; S.heading = { x: pos.dx, y: pos.dy }
        if (u >= 1) arriveTour()
      } else {
        const e = typeof sg.ease === 'function' ? sg.ease(u) : sg.ease ? easeInOut(u) : u
        const pos = bezier2(sg.p0, sg.c, sg.p1, e)
        const tg = bezier2Tangent(sg.p0, sg.c, sg.p1, Math.min(0.999, e))
        if (Math.hypot(tg.x, tg.y) > 1e-6) S.heading = tg
        S.x = pos.x; S.y = pos.y
        if (u >= 1) { S.seg = null; S.dwell = 0.6 + rand() * 1.2 }
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
    const margin = LEG_RHO_PX * 1.4
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
    // 透明度分 4 档合批：每档一条 path、一次 stroke（过渡中的触手只是档位不同，不额外增加绘制次数）
    const nn = nodes()
    const tiers = [0.25, 0.5, 0.75, 1].map((a) => ({ a, legs: new Path2D(), dots: new Path2D(), used: false }))
    const heroPath = new Path2D(); let hasHero = false
    for (const s of legStrokes()) {
      const n = nn[s.node]
      // 脚尖 = 锚点节点的屏幕位置（世界坐标 → 屏幕，随缩放跟随），任何状态下都不缩短、不插值
      const ex = n.x * z + view.panX; const ey = n.y * z + view.panY
      const dx0 = ex - bx; const dy0 = ey - by; const l0 = Math.hypot(dx0, dy0)
      if (l0 < BODY_R) continue // 节点在身体下面：脚尖被身体盖住，不画触手
      const sx0 = bx + (dx0 / l0) * BODY_R * 0.92; const sy0 = by + (dy0 / l0) * BODY_R * 0.92
      const dx = ex - sx0; const dy = ey - sy0
      // 触手弯曲：垂直方向的缓慢摆动（只摆中间，不动脚尖）；换脚时中段甩一下
      const bend = (reduced ? 0.1 : 0.16 * Math.sin(S.T * 2.6 + s.leg.seed)) + 0.08 + 0.22 * s.lift
      const cx = (sx0 + ex) / 2 - dy * bend; const cy = (sy0 + ey) / 2 + dx * bend
      if (s.hero) { hasHero = true; heroPath.moveTo(sx0, sy0); heroPath.quadraticCurveTo(cx, cy, ex, ey); continue }
      const t = tiers[clamp(Math.ceil(s.alpha * 4) - 1, 0, 3)]
      t.used = true
      t.legs.moveTo(sx0, sy0); t.legs.quadraticCurveTo(cx, cy, ex, ey)
      t.dots.moveTo(ex + 1.9, ey); t.dots.arc(ex, ey, 1.9, 0, TAU)
    }
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.6
    g.setLineDash([0.1, 4.6]); g.lineDashOffset = reduced ? 0 : -(S.T * (think ? 76 : 28))
    for (const t of tiers) if (t.used) { g.globalAlpha = alpha * 0.9 * t.a; g.stroke(t.legs) }
    if (hasHero) { g.globalAlpha = alpha; g.lineWidth = 2.4; g.setLineDash([0.1, 3.6]); g.strokeStyle = '#ffe3f6'; g.stroke(heroPath) }
    g.setLineDash([]); g.lineDashOffset = 0
    g.globalCompositeOperation = 'source-over'
    g.fillStyle = '#ffffff'
    for (const t of tiers) if (t.used) { g.globalAlpha = alpha * t.a; g.fill(t.dots) }
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
  api.reset = () => { for (const l of S.legs) { l.node = -1; l.last = -1; l.pin = -1; l.a = 0; l.fl = null } S.legInit = false; S.seg = null; S.inited = false; S.trail = []; if (S.tour || S.inspect) { S.tour = null; S.inspect = null; S.mode = 'wander' } }
  /** 相机跟随用：蜘蛛身体、当前目标、接下来 2 个目标（世界坐标）。 */
  api.cameraFocus = () => ({ body: { x: S.x, y: S.y }, cur: S.tour?.cur ? { x: S.tour.cur.x, y: S.tour.cur.y } : null, ahead: (S.tour?.queue || []).slice(0, 2).map((q) => ({ x: q.x, y: q.y })), touring: !!S.tour })
  api.hasResults = () => S.collected.size > 0 || !!S.tour
  api.isBusy = () => !!S.tour || S.mode === 'think' || S.mode === 'inspect'
  api.collectedIds = () => [...S.collected.keys()]
  /** 巡游：依次走过干扰节点与全部命中节点（见 buildTourPlan）。hits: [{id, rank, title}]（须已在图中）。返回计划，失败返回 null。 */
  api.startTour = (hits, { maxMs = TOUR_MAX_MS, zoom } = {}) => {
    if (!S.enabled || reduced || !S.inited || !hits.length) return null
    const nn = nodes()
    const pts = hits.map((h) => { const i = env.indexOf(h.id); const n = i === undefined ? null : nn[i]; return n ? { ...h, x: n.x, y: n.y, cluster: n.c?.key || '' } : null }).filter(Boolean)
    if (!pts.length) return null
    S.collected.clear(); S.inspect = null; S.thinking = false
    const plan = buildTourPlan({ x: S.x, y: S.y }, pts, nn, { zoom: zoom || env.planZoom || S.view.zoom, maxMs, heading: S.heading })
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
  api.snapshot = () => ({ x: S.x, y: S.y, mode: S.mode, T: S.T, planted: S.legs.filter((l) => l.node >= 0 && !l.air).length, legs: S.legs.filter((l) => l.a > 0.01).length, legWant: S.legWant, heading: S.heading ? { ...S.heading } : null, feet: S.legs.filter((l) => l.a > 0.01).map((l) => ({ x: l.fx, y: l.fy, air: l.air, node: l.node, pin: l.pin >= 0, a: l.a })), tips: legStrokes().map((s) => { const n = nodes()[s.node]; return { x: n.x, y: n.y, node: s.node, alpha: s.alpha, hero: s.hero } }), collected: [...S.collected.keys()], inspect: S.inspect?.id || null, plan: S.plan ? { total: S.plan.totalMs, stops: S.plan.stops.length, decoys: S.plan.decoyCount } : null, dim: S.dim, thinking: S.thinking, trail: S.trail.length, enabled: S.enabled })
  return api
}
