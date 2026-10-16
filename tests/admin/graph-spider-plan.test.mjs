// 图谱蜘蛛巡游计划（纯函数）：簇优先的无折返路线、顺路干扰节点、确定性、总时长上限、
// “到达前不高亮 / 到达后才高亮 / 跳过动画一次性全部显示”的状态函数、转向平滑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTourPlan, nodeStateAt, skipState, routeLength, orderPath, smoothControl, bezier2, arcControl } from '../../web/js/graph-spider.js'

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
const plan6 = (o = {}) => buildTourPlan(START, hitsRankOrder.filter((h) => h.rank <= 6), nodes, { zoom: 1, ...o })
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
  assert.ok(p.totalMs <= 12000)
  for (const [maxMs, extra] of [[12000, 0], [5000, 0], [12000, 18], [3000, 18]]) {
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
