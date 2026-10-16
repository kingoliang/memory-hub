// 图谱蜘蛛巡游计划（纯函数）：簇优先的无折返路线、顺路干扰节点、确定性、总时长上限、
// “到达前不高亮 / 到达后才高亮 / 跳过动画一次性全部显示”的状态函数、转向平滑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSpider, legCount, activeSlots, assignFeet, steerPath, buildTourPlan, nodeStateAt, skipState, routeLength, orderPath, smoothControl, bezier2, arcControl } from '../../web/js/graph-spider.js'

// 合成数据：3 个簇 × 40 个节点；命中 12 个，相关度在簇间交错（A,B,C,A,B,C…），“按相关度直连”要来回折返
const CENTERS = { A: [0, 0], B: [700, 120], C: [320, 620] }
const nodes = []
let seed = 7
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
for (const [k, [cx, cy]] of Object.entries(CENTERS)) for (let i = 0; i < 40; i++) nodes.push({ id: `${k}${i}`, x: cx + (rnd() - 0.5) * 140, y: cy + (rnd() - 0.5) * 140, cluster: k })
const hitsRankOrder = []
;['A', 'B', 'C'].forEach((k, ci) => { for (let j = 0; j < 4; j++) hitsRankOrder.push({ ...nodes.find((n) => n.id === `${k}${j * 3}`), rank: j * 3 + ci + 1, title: `t-${k}${j}` }) })
hitsRankOrder.sort((a, b) => a.rank - b.rank)
const START = { x: 20, y: 30 }
const plan = (o = {}) => buildTourPlan(START, hitsRankOrder, nodes, { zoom: 1, ...o })
// 命中较少时时间有富余，才会带上顺路的干扰节点；命中多（12 张）时先砍干扰节点保总时长
const plan6 = (o = {}) => buildTourPlan(START, hitsRankOrder.filter((h) => h.rank <= 6), nodes, { zoom: 1, maxMs: 12000, ...o })
const hitStops = (p) => p.stops.filter((s) => s.kind === 'hit')

test('覆盖全部命中点且无重复访问；干扰节点不是命中点', () => {
  const p = plan()
  const ids = p.stops.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(hitStops(p).map((s) => s.id).sort(), hitsRankOrder.map((h) => h.id).sort())
  const hitSet = new Set(hitsRankOrder.map((h) => h.id))
  for (const d of p.stops.filter((s) => s.kind === 'decoy')) assert.ok(!hitSet.has(d.id))
})

test('簇优先：同簇命中连续访问，簇间不来回折返；路程 ≤ “按相关度直连”的 80%', () => {
  const p = plan()
  const seq = hitStops(p).map((s) => nodes.find((n) => n.id === s.id).cluster)
  const runs = seq.filter((c, i) => i === 0 || c !== seq[i - 1])
  assert.equal(new Set(runs).size, runs.length, `簇被重复进入：${seq.join('')}`)
  const mine = routeLength(START, hitStops(p))
  const byRank = routeLength(START, hitsRankOrder)
  assert.ok(mine <= byRank * 0.8, `${mine.toFixed(0)} vs ${byRank.toFixed(0)}`)
  // 含干扰节点的整条路线也不能明显绕路（顺路）
  assert.ok(routeLength(START, p.stops) <= mine * 1.12)
})

test('确定性：相同输入得到完全相同的路线与时间表', () => {
  assert.equal(JSON.stringify(plan()), JSON.stringify(plan()))
  assert.equal(JSON.stringify(plan({ zoom: 2 })), JSON.stringify(plan({ zoom: 2 })))
})

test('干扰节点：总数 ≤ 上限、每段 ≤ 2、不为它们绕路', () => {
  const p = plan6()
  const ds = p.stops.filter((s) => s.kind === 'decoy')
  assert.ok(ds.length >= 1 && ds.length <= 6)
  const perLeg = {}
  for (const d of ds) perLeg[d.leg] = (perLeg[d.leg] || 0) + 1
  assert.ok(Object.values(perLeg).every((c) => c <= 2))
  assert.ok(plan6({ maxDecoys: 2 }).stops.filter((s) => s.kind === 'decoy').length <= 2)
  assert.equal(plan6({ maxDecoys: 0 }).stops.filter((s) => s.kind === 'decoy').length, 0)
})

test('时间表：到达单调递增、开场扫描在先、总时长 ≤ 上限（含命中很多 / 上限很紧）', () => {
  const p = plan()
  assert.ok(p.scanMs > 0 && p.stops[0].arriveMs > p.scanMs)
  for (let i = 1; i < p.stops.length; i++) assert.ok(p.stops[i].arriveMs > p.stops[i - 1].leaveMs - 1e-6)
  assert.ok(p.totalMs <= 6500, `总时长 ${p.totalMs}`)
  assert.ok(p.scanMs <= 400)
  for (const [maxMs, extra] of [[6000, 0], [5000, 0], [12000, 18], [3000, 18]]) {
    const many = hitsRankOrder.concat(Array.from({ length: extra }, (_, i) => ({ ...nodes[i + 50], rank: 100 + i })))
    const q = buildTourPlan(START, many, nodes, { zoom: 1, maxMs })
    assert.ok(q.totalMs <= maxMs + 1e-6, `${maxMs}/${extra}: ${q.totalMs}`)
    assert.equal(q.stops.filter((s) => s.kind === 'hit').length, many.length, '压缩时长也不能丢命中点')
  }
})

test('命中节点状态：到达前不是 highlighted（与普通节点一致），到达后才是；干扰节点只是 touched', () => {
  const p = plan6()
  for (const h of hitStops(p)) {
    assert.equal(nodeStateAt(p, h.id, 0), 'normal')
    assert.equal(nodeStateAt(p, h.id, h.arriveMs - 1), 'normal')
    assert.equal(nodeStateAt(p, h.id, h.arriveMs), 'highlighted')
    assert.equal(nodeStateAt(p, h.id, p.totalMs), 'highlighted')
  }
  const first = hitStops(p)[0]
  const later = hitStops(p)[4]
  assert.equal(nodeStateAt(p, later.id, first.arriveMs + 1), 'normal', '后面的命中点在蜘蛛没到之前不得有任何高亮')
  const d = p.stops.find((s) => s.kind === 'decoy')
  assert.equal(nodeStateAt(p, d.id, d.arriveMs + 1), 'touched')
  assert.equal(nodeStateAt(p, 'not-in-plan', 5000), 'normal')
})

test('跳过动画：一次性全部显示（所有命中点 highlighted，干扰节点不在内）', () => {
  const s = skipState(plan())
  assert.deepEqual(Object.keys(s).sort(), hitsRankOrder.map((h) => h.id).sort())
  assert.ok(Object.values(s).every((v) => v === 'highlighted'))
})

test('转向平滑：起飞方向沿上一段行进方向；与弦夹角超限时被收拢；无朝向时退化为对称弧', () => {
  const p0 = { x: 0, y: 0 }; const p1 = { x: 100, y: 0 }
  const c = smoothControl(p0, p1, { x: 1, y: 0 })
  assert.ok(Math.abs(c.y) < 1e-9 && c.x > 0)
  const back = smoothControl(p0, p1, { x: -1, y: 0 }, { maxTurn: Math.PI / 2 }) // 要求 180° 掉头：被限制到 90°
  assert.ok(Math.abs(back.x) < 1e-6 && Math.abs(back.y) > 1)
  assert.deepEqual(smoothControl(p0, p1, null), arcControl(p0, p1, 0.2, 1))
  const mid = bezier2(p0, c, p1, 0.5)
  assert.ok(mid.x > 0 && mid.x < 100)
})

test('orderPath：最近邻 + 2-opt，不丢点', () => {
  const pts = [{ id: 'a', x: 100, y: 0 }, { id: 'b', x: 10, y: 0 }, { id: 'c', x: 60, y: 5 }, { id: 'd', x: 30, y: -5 }]
  assert.deepEqual(orderPath({ x: 0, y: 0 }, pts).map((p) => p.id), ['b', 'd', 'c', 'a'])
})

// ---------------------------------------------------------------------------
// 缺陷 3/4 + 提速：簇间跳转限速 / 转向平滑 / 总时长 ≤ 6.5s。用真实引擎（createSpider，无 DOM）按 60fps 步进，直接测实际走出的轨迹。
// 数据取自一次实测（7 簇 × ~60 节点，命中 11 个，缩放 0.788）：命中点世界坐标 + 每簇填充节点。
// ---------------------------------------------------------------------------
const REAL_HITS = [
  ['project', 7, -26, -35], ['content', 5, -311, 62], ['prompt', 11, -314, -232], ['prompt', 4, -357, -278],
  ['tool', 2, 58, -378], ['tool', 9, 123, -395], ['knowledge', 6, 359, 12], ['business', 10, 116, 294],
  ['business', 3, 150, 341], ['mistake', 8, -166, 524], ['mistake', 1, -207, 490],
]
const CL_COLOR = { project: '#2ee6ff', content: '#ff7ad9', prompt: '#ffd24a', tool: '#7dfbe6', knowledge: '#9b8cff', business: '#ff9f43', mistake: '#ff5d5d' }
function buildSimEnv() {
  let s = 11; const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
  const ns = []
  const cls = Object.keys(CL_COLOR).map((key) => ({ key, color: CL_COLOR[key], idxs: [], n: 0 }))
  const clOf = (k) => cls.find((c) => c.key === k)
  const add = (id, key, x, y) => { const c = clOf(key); c.idxs.push(ns.length); c.n++; ns.push({ id, x, y, c }) }
  for (const key of Object.keys(CL_COLOR)) {
    const hs = REAL_HITS.filter((h) => h[0] === key)
    const cx = hs.reduce((a, h) => a + h[2], 0) / hs.length; const cy = hs.reduce((a, h) => a + h[3], 0) / hs.length
    for (let i = 0; i < 60; i++) add(`${key}/f${i}`, key, cx + (r() - 0.5) * 260, cy + (r() - 0.5) * 260)
  }
  // 一处稀疏区：远离所有簇，只有 3 个节点
  add('far/0', 'project', 900, 900); add('far/1', 'project', 930, 910); add('far/2', 'project', 910, 950)
  for (const h of REAL_HITS) add(`hit/${h[0]}-${h[1]}`, h[0], h[2], h[3])
  const idx = new Map(ns.map((n, i) => [n.id, i]))
  return { ns, cls, idx, r }
}
function makeSim({ zoom = 0.788, fps = 60 } = {}) {
  const env = buildSimEnv()
  const sp = createSpider({ nodes: () => env.ns, clusters: () => env.cls, indexOf: (id) => env.idx.get(id), rand: env.r, colorOf: (n) => n.c.color })
  const view = { zoom, panX: 0, panY: 0 }
  return { ...env, sp, view, zoom, dt: 1 / fps }
}
function simulateTour(o = {}) {
  const m = makeSim(o)
  for (let i = 0; i < 5; i++) m.sp.update(m.dt, m.view)
  const hits = REAL_HITS.map((h) => ({ id: `hit/${h[0]}-${h[1]}`, rank: h[1], title: `t${h[1]}` }))
  const plan = m.sp.startTour(hits)
  const frames = []; let t = 0
  while (t < 20 && m.sp.snapshot().mode !== 'think') {
    m.sp.update(m.dt, m.view); t += m.dt
    const s = m.sp.snapshot()
    frames.push({ t: t * 1000, x: s.x * m.zoom, y: s.y * m.zoom, mode: s.mode, snap: s })
  }
  return { ...m, plan, frames, doneMs: t * 1000 }
}
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d) }

test('时间表：簇间跳转时长随路径增长、有最小时长、平均速度够快；11 命中整场 ≤ 6.5s，检查停顿 250–350ms，扫描 ≤ 400ms', () => {
  const { plan } = simulateTour()
  const hops = plan.stops.filter((s) => s.hop)
  const steps = plan.stops.filter((s) => !s.hop)
  assert.ok(hops.length >= 4 && steps.length >= 4, `跳转 ${hops.length} 步 ${steps.length}`)
  for (const h of hops) assert.ok(h.travelMs >= 250, `簇间跳转 ${h.travelMs.toFixed(0)}ms 太短（闪现）`)
  const sorted = hops.slice().sort((a, b) => a.pathPx - b.pathPx)
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].travelMs >= sorted[i - 1].travelMs - 1e-6, '路径越长不得越快')
  const avg = (arr) => arr.reduce((a, s) => a + s.pathPx, 0) / (arr.reduce((a, s) => a + s.travelMs, 0) / 1000)
  assert.ok(avg(hops) >= 1200, `簇间平均速度 ${avg(hops).toFixed(0)}px/s`)
  assert.ok(avg(steps) >= 350, `簇内平均速度 ${avg(steps).toFixed(0)}px/s`)
  for (const s of plan.stops.filter((x) => x.kind === 'hit')) assert.ok(s.dwellMs >= 250 - 1e-6 && s.dwellMs <= 350 + 1e-6, `检查停顿 ${s.dwellMs}`)
  assert.ok(plan.scanMs <= 400)
  assert.ok(plan.totalMs <= 6500, `total ${plan.totalMs} scaled ${plan.scaled}`)
})

test('实际轨迹：簇间跳转峰值 ≤ 3300px/s（缓入缓出、不闪现），整场最大转角变化 ≤ 25°/帧@60fps（含离开扫描态的头几帧），整场走完 ≤ 6.5s', () => {
  const { plan, frames, doneMs } = simulateTour()
  assert.ok(doneMs <= 6500, `实际走完 ${doneMs.toFixed(0)}ms`)
  const speed = (i) => Math.hypot(frames[i].x - frames[i - 1].x, frames[i].y - frames[i - 1].y) / ((frames[i].t - frames[i - 1].t) / 1000)
  // 按引擎状态切段（mode === 'tour' 的连续帧 = 一段；与 plan.stops 顺序一一对应，避免逐帧量化漂移）
  const segs = []; let cur = null
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].mode === 'tour') { if (!cur) { cur = []; segs.push(cur) } cur.push(i) } else cur = null
  }
  assert.equal(segs.length, plan.stops.length)
  plan.stops.forEach((s, k) => {
    if (!s.hop) return
    const peak = Math.max(...segs[k].map(speed))
    assert.ok(peak <= 3300, `跳转到 ${s.id} 峰值 ${peak.toFixed(0)}px/s`)
    assert.ok(peak >= 800, `跳转峰值 ${peak.toFixed(0)}px/s 太慢`)
  })
  // 转角：只看“确实在动”的相邻位移向量（位移 < 0.25px 的帧方向不可靠、肉眼也看不出，跳过）
  let worst = 0; let where = 0; let last = null
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].t > plan.totalMs + 50) break
    const dx = frames[i].x - frames[i - 1].x; const dy = frames[i].y - frames[i - 1].y
    if (Math.hypot(dx, dy) < 0.25) continue
    const a = Math.atan2(dy, dx)
    if (last !== null) { const d = angDiff(a, last); if (d > worst) { worst = d; where = frames[i].t } }
    last = a
  }
  assert.ok(worst * 180 / Math.PI <= 25, `最大转角变化 ${(worst * 180 / Math.PI).toFixed(1)}° @${where.toFixed(0)}ms`)
})

test('steerPath：C1 连续（起飞方向 = 给定航向）、终点精确、掉头也不出现尖角', () => {
  const p = steerPath({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -200, y: 5 }, { zoom: 1 })
  assert.deepEqual([p.pts[0], p.pts[1]], [0, 0])
  assert.deepEqual([p.pts[p.pts.length - 2], p.pts[p.pts.length - 1]], [-200, 5])
  let worst = 0; let la = null
  for (let i = 2; i < p.pts.length; i += 2) { const a = Math.atan2(p.pts[i + 1] - p.pts[i - 1], p.pts[i] - p.pts[i - 2]); if (la !== null) worst = Math.max(worst, angDiff(a, la)); la = a }
  assert.ok(worst < 0.2, `相邻采样转角 ${worst}`)
  assert.ok(Math.abs(Math.atan2(p.pts[3] - p.pts[1], p.pts[2] - p.pts[0])) < 0.2, '起飞方向应沿航向')
})

// ---------------------------------------------------------------------------
// 腿：腿数随节点密度变化（纯函数）+ 脚点分配 + 引擎里脚尖必须踩在真实节点上
// ---------------------------------------------------------------------------
test('legCount：上下限、≤ 节点数、单调、滞回不抖动', () => {
  assert.equal(legCount(0, undefined), 0)
  assert.equal(legCount(1, undefined), 1)
  assert.equal(legCount(2, undefined), 2)
  assert.equal(legCount(4, undefined), 3)
  assert.equal(legCount(1000, undefined), 18)
  for (let n = 0; n <= 300; n++) { const k = legCount(n, undefined); assert.ok(k <= n && k <= 18 && (n < 3 || k >= 3)) }
  let prev = -1
  for (let n = 0; n <= 300; n++) { const k = legCount(n, undefined); assert.ok(k >= prev, `n=${n}`); prev = k }
  // 有 prev 时单调（固定 prev，n 增大不减少腿数）
  for (const pv of [3, 8, 12]) { let q = -1; for (let n = 3; n <= 300; n++) { const k = legCount(n, pv); assert.ok(k >= q, `prev=${pv} n=${n}`); q = k } }
  // 滞回：n 在阈值附近来回 ±1 波动，腿数不变化
  let cur = legCount(30, undefined)
  const seq = []
  for (let i = 0; i < 40; i++) { cur = legCount(30 + (i % 2 ? 1 : -1), cur); seq.push(cur) }
  assert.equal(new Set(seq).size, 1, `抖动 ${seq.join(',')}`)
  assert.ok(legCount(120, undefined) > legCount(8, undefined), '稠密处腿数 > 稀疏处')
})

test('activeSlots：恰好 k 个，k 增减一条时只翻转一个槽位', () => {
  for (let k = 0; k <= 18; k++) assert.equal(activeSlots(k).filter(Boolean).length, k)
  for (let k = 3; k < 18; k++) { const a = activeSlots(k); const b = activeSlots(k + 1); assert.equal(a.filter((v, i) => v !== b[i]).length, 1) }
})

test('assignFeet：每条腿落点都属于节点集合且互不相同；检查腿钉在目标节点；节点不足时才出现 -1', () => {
  const nodesNear = Array.from({ length: 30 }, (_, i) => ({ x: Math.cos(i) * (20 + i * 3), y: Math.sin(i) * (20 + i * 3) }))
  const angles = Array.from({ length: 12 }, (_, i) => (i / 12) * Math.PI * 2)
  const out = assignFeet({ x: 0, y: 0 }, nodesNear, angles, { reach: 80, rho: 140, pin: { 4: 7 } })
  assert.equal(out[4], 7, '检查腿 == 目标节点')
  assert.ok(out.every((v) => v >= 0 && v < nodesNear.length))
  assert.equal(new Set(out).size, out.length)
  const few = assignFeet({ x: 0, y: 0 }, nodesNear.slice(0, 5), angles, { reach: 80, rho: 1e9 })
  assert.equal(few.filter((v) => v >= 0).length, 5)
  assert.equal(new Set(few.filter((v) => v >= 0)).size, 5)
})

test('引擎：游走与巡游中，每帧每条落地腿的脚尖都在某个真实节点中心上；检查命中节点时检查腿脚尖精确在目标节点上；腿数随位置密度变化', () => {
  const { frames, ns, idx, plan } = simulateTour()
  let bad = 0; let total = 0; let inspectChecks = 0; let inspectOk = 0
  for (const f of frames) {
    for (const ft of f.snap.feet) {
      if (ft.air) continue
      total++
      if (ft.node < 0 || Math.hypot(ft.x - ns[ft.node].x, ft.y - ns[ft.node].y) > 1e-6) bad++
    }
    const nodesUsed = f.snap.feet.filter((x) => !x.air).map((x) => x.node)
    assert.equal(new Set(nodesUsed).size, nodesUsed.length, '每条腿一个不同的节点')
    if (f.snap.inspect && !f.snap.inspect.startsWith('decoy')) {
      const pinned = f.snap.feet.find((x) => x.pin && !x.air)
      if (pinned) { inspectChecks++; const t = ns[idx.get(f.snap.inspect)]; if (Math.hypot(pinned.x - t.x, pinned.y - t.y) < 1e-6) inspectOk++ }
    }
  }
  assert.ok(total > 1000 && bad === 0, `落地腿 ${total} 帧中 ${bad} 个脚尖不在节点上`)
  assert.ok(inspectChecks >= 11 * 5 && inspectOk === inspectChecks, `检查腿 ${inspectOk}/${inspectChecks}`)
  const airFrames = frames.filter((f) => f.snap.feet.some((x) => x.air)).length
  assert.ok(airFrames > 10, '走动时应有抬脚换脚')
  const counts = frames.map((f) => f.snap.legs)
  assert.ok(Math.max(...counts) <= 18 && Math.max(...counts) > Math.min(...counts), '腿数应随位置变化')
})

function legsAt(nodeCount, spread, { zoom = 1, steps = 240 } = {}) {
  let s = 5; const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
  const cl = { key: 'a', color: '#2ee6ff', idxs: [], n: nodeCount }
  const ns = Array.from({ length: nodeCount }, (_, i) => { cl.idxs.push(i); return { id: `n${i}`, x: (r() - 0.5) * spread, y: (r() - 0.5) * spread, c: cl } })
  const sp = createSpider({ nodes: () => ns, clusters: () => [cl], indexOf: (id) => Number(id.slice(1)), rand: r, colorOf: (n) => n.c.color, reduced: false })
  const view = { zoom, panX: 0, panY: 0 }
  const counts = []; let bad = 0; let tot = 0
  for (let i = 0; i < steps; i++) {
    sp.update(1 / 60, view)
    const sn = sp.snapshot(); counts.push(sn.legs)
    const used = sn.feet.filter((f) => !f.air)
    for (const f of used) { tot++; if (f.node < 0 || Math.hypot(f.x - ns[f.node].x, f.y - ns[f.node].y) > 1e-6) bad++ }
    assert.equal(new Set(used.map((f) => f.node)).size, used.length)
    assert.ok(sn.legs <= nodeCount, `腿数 ${sn.legs} > 节点数 ${nodeCount}`)
  }
  return { counts, bad, tot, last: counts[counts.length - 1] }
}
test('引擎：稠密处腿数多、稀疏处腿数少且 ≤ 节点数；两种情况脚尖都在节点上（装饰游走）', () => {
  const dense = legsAt(120, 200)
  const sparse = legsAt(4, 400)
  const alone = legsAt(2, 400)
  assert.equal(dense.bad + sparse.bad + alone.bad, 0)
  assert.ok(dense.last >= 13, `稠密 ${dense.last}`)
  assert.ok(sparse.last <= 4, `稀疏 ${sparse.last}`)
  assert.ok(alone.last <= 2)
  assert.ok(dense.last > sparse.last + 6)
})

// ---------------------------------------------------------------------------
// 相机跟随（纯函数 graph-camera.js + 真实引擎无头步进）
// ---------------------------------------------------------------------------
import { visibleBox, fitPoints, stepCamera, followStep, viewToCam, camToView, camProject, inBox } from '../../web/js/graph-camera.js'

test('visibleBox：面板在右 → 取左侧；面板在底 → 取上方；收起成顶部小条 → 取下方；无面板 → 整个舞台', () => {
  assert.deepEqual(visibleBox(830, 1000, null), { x: 0, y: 0, w: 830, h: 1000 })
  const r = visibleBox(830, 1000, { x: 488, y: 64, w: 330, h: 924 })
  assert.ok(r.x === 0 && r.w <= 488 && r.w > 400 && r.h === 1000)
  const m = visibleBox(400, 900, { x: 8, y: 450, w: 384, h: 442 })
  assert.ok(m.y === 0 && m.h <= 450 && m.w === 400)
  const c = visibleBox(830, 1000, { x: 488, y: 64, w: 330, h: 44 })
  assert.ok(c.y >= 108 && c.w === 830, JSON.stringify(c))
})

test('fitPoints：所有点落在可见区内并留边距；zoom 受上下限约束', () => {
  const box = { x: 0, y: 0, w: 480, h: 900 }
  const pts = [{ x: -300, y: -100 }, { x: 400, y: 500 }]
  const f = fitPoints(pts, box, { marginPx: 60, zMin: 0.2, zMax: 2 })
  const cam = { cx: f.cx, cy: f.cy, lz: Math.log(f.zoom), vx: 0, vy: 0, vlz: 0 }
  for (const p of pts) assert.ok(inBox(camProject(cam, box, p), box, 59))
  assert.equal(fitPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }], box, { zMin: 0.2, zMax: 1.6 }).zoom, 1.6)
  assert.equal(fitPoints([{ x: 0, y: 0 }, { x: 1e6, y: 1 }], box, { zMin: 0.2, zMax: 1.6 }).zoom, 0.2)
})

test('stepCamera：临界阻尼无超调；相邻帧平移 ≤ 上限、对数缩放变化 ≤ 上限；收敛到目标', () => {
  let cam = { cx: 0, cy: 0, lz: Math.log(1), vx: 0, vy: 0, vlz: 0 }
  const tg = { cx: 800, cy: -300, zoom: 0.5 }
  let maxPan = 0; let maxZ = 0; let overshoot = 0
  for (let i = 0; i < 300; i++) {
    const n = stepCamera(cam, tg, 1 / 60, { omega: 7, maxPan: 2800, maxZoom: 1.8 })
    maxPan = Math.max(maxPan, Math.hypot(n.cx - cam.cx, n.cy - cam.cy) * Math.exp(n.lz) * 60)
    maxZ = Math.max(maxZ, Math.abs(n.lz - cam.lz) * 60)
    overshoot = Math.max(overshoot, n.cx - tg.cx)
    cam = n
  }
  assert.ok(maxPan <= 2800 + 1 && maxZ <= 1.8 + 1e-6, `${maxPan} ${maxZ}`)
  assert.ok(overshoot <= 1, `超调 ${overshoot}`)
  assert.ok(Math.abs(cam.cx - 800) < 1 && Math.abs(Math.exp(cam.lz) - 0.5) < 0.01)
})

test('相机跟随巡游：≥98% 的帧里蜘蛛身体与当前检查节点都在可见区内；zoom 在上下限内；簇间跳转拉远、簇内近景；手动操作后相机不再自动改变', () => {
  const m = makeSim()
  const box = { x: 0, y: 0, w: 480, h: 900 }
  const limits = { zMin: 0.4, zMax: 2.5, zClose: 1.6, marginPx: 70 }
  const view0 = { zoom: 0.788, panX: 240, panY: 450 }
  let cam = viewToCam(view0, box)
  const st = { on: true }
  for (let i = 0; i < 5; i++) m.sp.update(m.dt, camToView(cam, box))
  const hits = REAL_HITS.map((h) => ({ id: `hit/${h[0]}-${h[1]}`, rank: h[1], title: `t${h[1]}` }))
  const plan = m.sp.startTour(hits, { zoom: 1 })
  let n = 0; let ok = 0; let okNode = 0; let nInspect = 0; let maxPan = 0; let maxZ = 0
  const zStep = []
  let t = 0; let guard = 0
  while (m.sp.snapshot().mode !== 'think' && guard++ < 1500) {
    const foc = m.sp.cameraFocus()
    const prev = cam
    cam = followStep(st, cam, { dt: m.dt, mode: 'tour', focus: foc, box, limits })
    maxPan = Math.max(maxPan, Math.hypot(cam.cx - prev.cx, cam.cy - prev.cy) * Math.exp(cam.lz) / m.dt)
    maxZ = Math.max(maxZ, Math.abs(cam.lz - prev.lz) / m.dt)
    m.sp.update(m.dt, camToView(cam, box)); t += m.dt
    const sn = m.sp.snapshot()
    n++
    if (inBox(camProject(cam, box, { x: sn.x, y: sn.y }), box, 0)) ok++
    if (sn.inspect) { nInspect++; const nd = m.ns[m.idx.get(sn.inspect)]; if (inBox(camProject(cam, box, nd), box, 0)) okNode++ }
    zStep.push(Math.exp(cam.lz))
    assert.ok(Math.exp(cam.lz) >= 0.4 - 1e-6 && Math.exp(cam.lz) <= 2.5 + 1e-6)
  }
  if (process.env.DBG) console.log('CAM', (100 * ok / n).toFixed(1), (100 * okNode / nInspect).toFixed(1), 'zoom min/max', Math.min(...zStep).toFixed(2), Math.max(...zStep).toFixed(2), 'pan', maxPan.toFixed(0), 'dz', maxZ.toFixed(2))
  assert.ok(ok / n >= 0.98, `蜘蛛在可见区内的帧 ${(100 * ok / n).toFixed(1)}%`)
  assert.ok(nInspect > 100 && okNode / nInspect >= 0.98, `检查节点在可见区内 ${okNode}/${nInspect}`)
  assert.ok(maxPan <= 2800 + 1 && maxZ <= 1.8 + 1e-6, `相机速度 ${maxPan} / ${maxZ}`)
  // 手动操作后不再自动改相机
  st.on = false
  const frozen = cam
  let c2 = cam
  for (let i = 0; i < 120; i++) { m.sp.update(m.dt, camToView(c2, box)); c2 = followStep(st, c2, { dt: m.dt, mode: 'tour', focus: m.sp.cameraFocus(), box, limits }) }
  assert.equal(c2, frozen)
})
