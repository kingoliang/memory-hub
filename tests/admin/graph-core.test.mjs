// M4 图谱前端纯函数：过滤 / 搜索 / 布局 / 视图变换 / 命中测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nodeRadius, withDegrees, filterGraph, searchMatches, adjacency, tagCounts, createLayout, stepLayout, runLayout, LAYOUT_DONE,
  fitView, screenToWorld, worldToScreen, zoomAt, hitTest, topLabelIds, kindColor, ZOOM_MAX, ZOOM_MIN,
} from '../../web/js/graph-core.js'

const N = (id, kind = 'knowledge', tags = []) => ({ id, title: `标题 ${id}`, kind, tags, degree: 0 })
const E = (source, target, type = 'tag', weight = 1) => ({ source, target, type, weight })
const sample = () => ({
  nodes: [N('a', 'project', ['x', 'y']), N('b', 'project', ['x']), N('c', 'tool', ['y']), N('d', 'tool', []), N('e', 'mistake', ['z'])],
  edges: [E('a', 'b', 'tag', 1), E('a', 'c', 'link', 3), E('b', 'c', 'similar', 2), E('c', 'd', 'tag', 2)],
})

test('withDegrees：按给定边重算度数', () => {
  const g = sample()
  const d = Object.fromEntries(withDegrees(g.nodes, g.edges).map((n) => [n.id, n.degree]))
  assert.deepEqual(d, { a: 2, b: 2, c: 3, d: 1, e: 0 })
})

test('filterGraph：kind / tag / minWeight / types / hideIsolated，且度数按过滤后重算', () => {
  const g = sample()
  assert.equal(filterGraph(g).nodes.length, 5)
  const k = filterGraph(g, { kinds: new Set(['project']) })
  assert.deepEqual(k.nodes.map((n) => n.id), ['a', 'b'])
  assert.equal(k.edges.length, 1)
  assert.deepEqual(k.nodes.map((n) => n.degree), [1, 1])
  assert.deepEqual(filterGraph(g, { tag: 'y' }).nodes.map((n) => n.id), ['a', 'c'])
  const mw = filterGraph(g, { minWeight: 2 })
  assert.deepEqual(mw.edges.map((e) => e.type).sort(), ['link', 'similar', 'tag'])
  assert.ok(mw.edges.every((e) => e.weight >= 2))
  assert.deepEqual(filterGraph(g, { types: new Set(['link']) }).edges.length, 1)
  const hi = filterGraph(g, { hideIsolated: true })
  assert.ok(!hi.nodes.some((n) => n.id === 'e'))
  assert.equal(filterGraph(g, { types: new Set(['link']), hideIsolated: true }).nodes.length, 2)
  // 不修改入参
  assert.equal(g.nodes[0].degree, 0)
})

test('searchMatches：标题/标签/kind/中文 kind 名，空查询 → null', () => {
  const g = sample()
  assert.equal(searchMatches(g.nodes, '  '), null)
  assert.deepEqual([...searchMatches(g.nodes, '标题 c')], ['c'])
  assert.deepEqual([...searchMatches(g.nodes, 'Z')], ['e'])
  assert.deepEqual([...searchMatches(g.nodes, 'tool')].sort(), ['c', 'd'])
  assert.deepEqual([...searchMatches(g.nodes, '踩坑', (k) => ({ mistake: '踩坑' })[k] || k)], ['e'])
  assert.equal(searchMatches(g.nodes, '不存在').size, 0)
})

test('adjacency / tagCounts', () => {
  const g = sample()
  const adj = adjacency(g.edges)
  assert.deepEqual([...adj.get('c')].sort(), ['a', 'b', 'd'])
  assert.equal(adj.get('e'), undefined)
  assert.deepEqual(tagCounts(g.nodes).slice(0, 2).map((t) => t.tag), ['x', 'y'])
  assert.equal(tagCounts(g.nodes, 1).length, 1)
})

test('nodeRadius：随度数单调增长且有界', () => {
  assert.ok(nodeRadius(0, 10) < nodeRadius(5, 10))
  assert.ok(nodeRadius(5, 10) < nodeRadius(10, 10))
  assert.equal(nodeRadius(99, 10), nodeRadius(10, 10))
  assert.ok(Number.isFinite(nodeRadius(0, 0)))
  assert.equal(kindColor('nope'), kindColor('other'))
})

test('布局：确定性、有限数值、连边节点比孤立节点更近、会收敛', () => {
  const g = sample()
  const nodes = withDegrees(g.nodes, g.edges)
  const run = () => { const L = createLayout(nodes, g.edges); runLayout(L, 400); return L }
  const L1 = run()
  const L2 = run()
  assert.deepEqual(L1.nodes.map((n) => [n.x, n.y]), L2.nodes.map((n) => [n.x, n.y]), '同输入同输出')
  for (const n of L1.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y))
  assert.ok(L1.alpha <= LAYOUT_DONE + 1e-9, '应收敛')
  const pos = Object.fromEntries(L1.nodes.map((n) => [n.id, n]))
  const dist = (p, q) => Math.hypot(pos[p].x - pos[q].x, pos[p].y - pos[q].y)
  assert.ok(dist('a', 'c') < dist('a', 'e'), '有连边的比孤立点近')
  assert.ok(dist('a', 'b') > 4, '节点不应重叠成一点')
})

test('布局：沿用 prev 位置；重叠点不产生 NaN；fixed 节点不动', () => {
  const g = sample()
  const prev = new Map(g.nodes.map((n) => [n.id, { x: 5, y: 5 }])) // 全部重叠
  const L = createLayout(withDegrees(g.nodes, g.edges), g.edges, { prev })
  assert.equal(L.nodes[0].x, 5)
  L.nodes[0].fixed = true
  runLayout(L, 50)
  assert.equal(L.nodes[0].x, 5)
  for (const n of L.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y))
  assert.ok(L.nodes.slice(1).some((n) => n.x !== 5 || n.y !== 5), '重叠点应被斥力推开')
})

test('布局：800 节点单步耗时可接受', () => {
  const nodes = Array.from({ length: 800 }, (_, i) => ({ ...N('n' + i, i % 2 ? 'tool' : 'project'), degree: 1 }))
  const edges = Array.from({ length: 1500 }, (_, i) => E('n' + (i % 800), 'n' + ((i * 7 + 3) % 800)))
  const L = createLayout(nodes, edges)
  const t0 = performance.now()
  for (let i = 0; i < 5; i++) stepLayout(L)
  assert.ok((performance.now() - t0) / 5 < 60, '单步应 < 60ms')
})

test('视图：fitView 装得下全部节点；zoomAt 锚点不动且被钳制；坐标互逆', () => {
  const pts = [{ x: -200, y: -100 }, { x: 300, y: 150 }]
  const v = fitView(pts, 800, 500)
  for (const p of pts) {
    const s = worldToScreen(v, p.x, p.y)
    assert.ok(s.x >= 0 && s.x <= 800 && s.y >= 0 && s.y <= 500)
  }
  const anchor = screenToWorld(v, 123, 77)
  const v2 = zoomAt(v, 123, 77, 1.5)
  const back = screenToWorld(v2, 123, 77)
  assert.ok(Math.abs(anchor.x - back.x) < 1e-9 && Math.abs(anchor.y - back.y) < 1e-9)
  assert.equal(zoomAt(v, 0, 0, 1e9).zoom, ZOOM_MAX)
  assert.equal(zoomAt(v, 0, 0, 1e-9).zoom, ZOOM_MIN)
  const w = worldToScreen(v, 10, 20)
  const r = screenToWorld(v, w.x, w.y)
  assert.ok(Math.abs(r.x - 10) < 1e-9 && Math.abs(r.y - 20) < 1e-9)
  assert.ok(Number.isFinite(fitView([], 0, 0).zoom))
})

test('hitTest：命中最近的、半径外不命中；topLabelIds 取度数最高', () => {
  const nodes = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }]
  const r = () => 8
  assert.equal(hitTest(nodes, 9, 0, r, 0), 1)
  assert.equal(hitTest(nodes, 4, 0, r, 0), 0)
  assert.equal(hitTest(nodes, 100, 100, r), -1)
  const ids = topLabelIds([{ id: 'p', degree: 1 }, { id: 'q', degree: 9 }, { id: 'r', degree: 5 }], 2)
  assert.deepEqual([...ids].sort(), ['q', 'r'])
})
