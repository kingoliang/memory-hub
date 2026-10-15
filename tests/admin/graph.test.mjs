// M4 知识图谱 API：鉴权、过滤、limit/truncated、focus 邻域、不含已删除/隔离卡、只读模式可访问、响应不含正文
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withAdminHub, FAKE_SK } from './admin-helpers.mjs'
import { writeCard, deleteCard } from '../../src/core/vault.js'
import { getDb } from '../../src/core/db.js'

const logged = async (h) => { const c = h.client(); const r = await c.login(); assert.equal(r.status, 200); return c }
const G = '/admin/api/graph'
const NODE_KEYS = ['createdAt', 'degree', 'id', 'kind', 'status', 'tags', 'title', 'updatedAt']

test('鉴权：未登录 401；Agent 令牌也不行；只接受 GET', async () => {
  await withAdminHub(async (h) => {
    const anon = h.client()
    assert.equal((await anon.get(G)).status, 401)
    const tok = h.token('graph-agent', ['read'])
    assert.equal((await anon.get(G, { headers: { authorization: `Bearer ${tok}` } })).status, 401)
    const c = await logged(h)
    assert.equal((await c.get(G)).status, 200)
    assert.equal((await c.req('POST', G, { body: {}, withCsrf: true })).status, 405)
  })
})

test('结构：只含主库 approved 卡；节点只有白名单字段；边端点都在节点里；stats 自洽', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const r = await c.get(G)
    assert.equal(r.status, 200, r.text)
    const { nodes, edges, stats, truncated } = r.json
    const sqlTotal = getDb(h.home).prepare('SELECT COUNT(*) n FROM cards').get().n
    assert.equal(nodes.length, sqlTotal)
    assert.equal(truncated, false)
    assert.equal(stats.totalCards, sqlTotal)
    assert.equal(stats.nodes, nodes.length)
    assert.equal(stats.edges, edges.length)
    for (const n of nodes) {
      assert.deepEqual(Object.keys(n).sort(), NODE_KEYS)
      assert.equal(n.status, 'approved')
    }
    const ids = new Set(nodes.map((n) => n.id))
    assert.equal(ids.size, nodes.length)
    for (const e of edges) {
      assert.ok(ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
      assert.ok(['link', 'tag', 'similar'].includes(e.type))
      assert.ok(e.weight >= 1)
    }
    // degree = 返回边里该节点出现的次数
    const deg = new Map()
    for (const e of edges) for (const x of [e.source, e.target]) deg.set(x, (deg.get(x) || 0) + 1)
    for (const n of nodes) assert.equal(n.degree, deg.get(n.id) || 0)
    assert.ok(stats.byType.tag > 0, '种子卡共享 alpha/shared 标签，应有标签边')
    assert.equal(Object.values(stats.byKind).reduce((a, b) => a + b, 0), nodes.length)
  })
})

test('不泄露：隔离区/回收站的卡不入图；响应不含任何正文、密钥；标题里的密钥被遮蔽', async () => {
  await withAdminHub(async (h) => {
    const leaky = await writeCard(h.home, { kind: 'tool', title: `密钥 ${FAKE_SK} 标题`, tags: ['once-only'], body: 'UNIQUE-BODY-MARKER-9f3 正文不应出现', status: 'approved' }, { dedup: false })
    assert.ok(leaky.ok)
    const c = await logged(h)
    const r = await c.get(G)
    assert.equal(r.status, 200)
    const paths = new Set(r.json.nodes.map((n) => n.id))
    const db = getDb(h.home)
    for (const row of db.prepare('SELECT path, title FROM quarantine').all()) {
      assert.ok(!paths.has(row.path), `隔离/回收站卡不应入图：${row.path}`)
      assert.ok(!r.text.includes(row.title), '隔离卡标题不应出现')
    }
    for (const needle of ['pendingbody', '驳回正文', '回收站正文', 'UNIQUE-BODY-MARKER-9f3', '背景与结论', FAKE_SK]) {
      assert.ok(!r.text.includes(needle), `响应不应包含：${needle}`)
    }
    assert.ok(r.text.includes('已遮蔽'), '标题中的密钥应被遮蔽')
    // 新软删一张：缓存必须随之失效，且被删卡不再出现
    const victim = r.json.nodes.find((n) => n.kind === 'project').id
    await deleteCard(h.home, victim)
    const r2 = await c.get(G)
    assert.ok(!r2.json.nodes.some((n) => n.id === victim))
    assert.equal(r2.json.nodes.length, r.json.nodes.length - 1)
    assert.ok(!r2.json.edges.some((e) => e.source === victim || e.target === victim))
  })
})

test('过滤：kind / tag（需同时具备）/ types / min_weight / hide_isolated', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const k = await c.get(`${G}?kind=mistake`)
    assert.ok(k.json.nodes.length === 3 && k.json.nodes.every((n) => n.kind === 'mistake'))
    const t = await c.get(`${G}?tag=alpha,Node.js`)
    assert.equal(t.json.nodes.length, 3)
    assert.ok(t.json.nodes.every((n) => n.tags.includes('alpha') && n.tags.includes('Node.js')))
    const ty = await c.get(`${G}?types=similar`)
    assert.ok(ty.json.edges.every((e) => e.type === 'similar'))
    const all = await c.get(G)
    const mw = await c.get(`${G}?min_weight=2`)
    assert.ok(mw.json.edges.length < all.json.edges.length)
    assert.ok(mw.json.edges.every((e) => e.weight >= 2))
    const hi = await c.get(`${G}?hide_isolated=1`)
    assert.ok(hi.json.nodes.every((n) => n.degree > 0))
    assert.ok(hi.json.nodes.length < all.json.nodes.length, '种子里有标签孤立的卡（legacy/once-only…）')
    for (const bad of ['limit=0', 'limit=abc', 'min_weight=0', 'depth=9', 'types=foo', 'hide_isolated=yes', 'status=pending', 'status=deleted']) {
      assert.equal((await c.get(`${G}?${bad}`)).status, 400, bad)
    }
  })
})

test('limit / truncated：按加权度数保留，边只留两端都在的；超大 limit 被钳制', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const r = await c.get(`${G}?limit=5`)
    assert.equal(r.status, 200)
    assert.equal(r.json.nodes.length, 5)
    assert.equal(r.json.truncated, true)
    assert.equal(r.json.stats.matchedNodes, 26)
    const ids = new Set(r.json.nodes.map((n) => n.id))
    assert.ok(r.json.edges.every((e) => ids.has(e.source) && ids.has(e.target)))
    const full = await c.get(G)
    assert.equal(full.json.truncated, false)
    assert.equal((await c.get(`${G}?limit=999999`)).json.stats.limit, 2000)
  })
})

test('focus：邻域 = 焦点 + depth 跳邻居；未知/隔离/已删 → 404', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const full = (await c.get(G)).json
    const focus = full.nodes.find((n) => n.degree > 0 && n.degree < full.nodes.length - 1).id
    const nb = new Set()
    for (const e of full.edges) { if (e.source === focus) nb.add(e.target); if (e.target === focus) nb.add(e.source) }
    const r = await c.get(`${G}?focus=${encodeURIComponent(focus)}`)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(new Set(r.json.nodes.map((n) => n.id)), new Set([focus, ...nb]))
    assert.equal(r.json.stats.focus, focus)
    const r2 = await c.get(`${G}?focus=${encodeURIComponent(focus)}&depth=2`)
    assert.ok(r2.json.nodes.length >= r.json.nodes.length)
    // 孤立焦点：只返回它自己
    const lone = (await c.get(`${G}?hide_isolated=0`)).json.nodes.find((n) => n.degree === 0)
    if (lone) assert.deepEqual((await c.get(`${G}?focus=${encodeURIComponent(lone.id)}`)).json.nodes.map((n) => n.id), [lone.id])
    assert.equal((await c.get(`${G}?focus=${encodeURIComponent('nope/none.md')}`)).status, 404)
    const q = getDb(h.home).prepare('SELECT path FROM quarantine LIMIT 1').get().path
    assert.equal((await c.get(`${G}?focus=${encodeURIComponent(q)}`)).status, 404)
  })
})

test('边类型：[[wikilink]] 与 正文相似 都能被识别（link 权重 3，similar 带 sim）', async () => {
  await withAdminHub(async (h) => {
    const a = await writeCard(h.home, { kind: 'knowledge', title: '链接源卡', tags: ['lk-a'], body: '这里引用 [[链接目标卡]] 以及 [[不存在的卡]]。', status: 'approved' }, { dedup: false })
    const b = await writeCard(h.home, { kind: 'knowledge', title: '链接目标卡', tags: ['lk-b'], body: '被引用的卡，内容完全不同 zzz。', status: 'approved' }, { dedup: false })
    const long = '部署流程说明：先备份数据库然后停止服务再替换二进制最后重启并验证健康检查，回滚时恢复备份并重启服务确认监控恢复正常。'
    const s1 = await writeCard(h.home, { kind: 'tool', title: '部署说明甲', tags: ['sim-x'], body: long, status: 'approved' }, { dedup: false })
    const s2 = await writeCard(h.home, { kind: 'tool', title: '部署说明乙', tags: ['sim-y'], body: long + '补充一句。', status: 'approved' }, { dedup: false })
    assert.ok(a.ok && b.ok && s1.ok && s2.ok)
    const c = await logged(h)
    const g = (await c.get(G)).json
    const link = g.edges.find((e) => e.type === 'link')
    assert.ok(link, '应有 link 边')
    assert.deepEqual([link.source, link.target].sort(), [a.path, b.path].sort())
    assert.equal(link.weight, 3)
    assert.equal(g.edges.filter((e) => e.type === 'link').length, 1, '不存在的链接目标不产生边')
    const sim = g.edges.find((e) => e.type === 'similar' && [e.source, e.target].includes(s1.path))
    assert.ok(sim, '近重复正文应有 similar 边')
    assert.deepEqual([sim.source, sim.target].sort(), [s1.path, s2.path].sort())
    assert.ok(sim.sim >= 0.42 && sim.sim <= 1)
    // 缓存：第二次命中
    assert.equal((await c.get(G)).json.stats.cached, true)
  })
})

test('只读模式（MEMORY_HUB_ADMIN_READONLY=1）下图谱仍可访问', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const r = await c.get(G)
    assert.equal(r.status, 200)
    assert.ok(r.json.nodes.length > 0)
    const w = await c.req('POST', '/admin/api/tags/rename', { body: { from: 'alpha', to: 'zzz' }, withCsrf: true })
    assert.equal(w.status, 403, '写接口在只读模式被拒，证明环境确为只读')
  }, { env: { MEMORY_HUB_ADMIN_READONLY: '1' } })
})

test('规模：300 张卡的建图 + 查询在合理时间内完成', async () => {
  await withAdminHub(async (h) => {
    for (let i = 0; i < 300; i++) {
      const r = await writeCard(h.home, { kind: ['project', 'knowledge', 'tool'][i % 3], title: `规模卡 ${i}`, tags: [`g${i % 10}`, `h${i % 7}`], body: `第 ${i} 张规模测试卡。主题 ${i % 13}，编号 ${i * 7919}，细节 ${'x'.repeat(i % 5)} ${i % 3 ? '补充内容' : '另一段内容'}。`, status: 'approved' }, { dedup: false })
      assert.ok(r.ok)
    }
    const c = await logged(h)
    const t0 = Date.now()
    const r = await c.get(G)
    const dt = Date.now() - t0
    assert.equal(r.json.nodes.length, 326)
    assert.ok(dt < 5000, `首次建图 ${dt}ms 过慢`)
    const t1 = Date.now()
    await c.get(`${G}?kind=tool&min_weight=2`)
    assert.ok(Date.now() - t1 < 500, '命中缓存的过滤查询应很快')
  }, { })
})
