// 正文相似边（③）与建图并发语义：阈值仍是精确 Jaccard ≥ 0.42、每卡至多 1 条、跨 kind 必须共享标签；
// 建图是异步的，期间事件循环不被堵死；同一指纹的并发请求合并成一次建图。
import test from 'node:test'
import assert from 'node:assert/strict'
import { graphQuery } from '../../src/admin/graph.js'
import { writeCard, bigramHashSet, jaccardSets } from '../../src/core/vault.js'
import { closeAllDb } from '../../src/core/db.js'
import { tmpHome, rmrf } from '../helpers.mjs'

/** 20 个互不相同的 base36 片段，每段用自己的字母表，方便按「共享段数」控制 Jaccard。 */
const seg = (i) => `seg${i}`.padEnd(20, String.fromCharCode(97 + (i % 26))).split('').join('')
const body = (segs) => segs.map((i) => `${seg(i)}。`).join('')

const simEdges = (g) => g.edges.filter((e) => e.type === 'similar')
const sorted = (e) => [e.source, e.target].sort()

test('正文相似：只按精确 Jaccard ≥ 0.42 出边，边上的 sim 就是精确值；明显不相似不出边', async () => {
  const home = tmpHome('mh-graph-sim-')
  try {
    // 共享 6/10 段与 2/10 段：前者远高于 0.42，后者远低于
    const near1 = await writeCard(home, { kind: 'knowledge', title: '近重复甲', tags: ['s1'], body: body([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), status: 'approved' }, { dedup: false })
    const near2 = await writeCard(home, { kind: 'knowledge', title: '近重复乙', tags: ['s2'], body: body([1, 2, 3, 4, 5, 6, 71, 81, 91, 101]), status: 'approved' }, { dedup: false })
    const far1 = await writeCard(home, { kind: 'knowledge', title: '远亲甲', tags: ['s3'], body: body([201, 202, 203, 204, 205, 206, 207, 208, 209, 210]), status: 'approved' }, { dedup: false })
    const far2 = await writeCard(home, { kind: 'knowledge', title: '远亲乙', tags: ['s4'], body: body([201, 202, 301, 302, 303, 304, 305, 306, 307, 308]), status: 'approved' }, { dedup: false })
    const g = await graphQuery(home, { limit: 1_000_000 })
    const sims = simEdges(g)
    const near = sims.find((e) => sorted(e).join() === [near1.path, near2.path].sort().join())
    assert.ok(near, '共享 6/10 段的正文应有 similar 边')
    // 语义等价：边上的 sim 必须等于用 vault 的 bigram 集合算出来的精确 Jaccard
    const ref = jaccardSets(bigramHashSet(body([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), bigramHashSet(body([1, 2, 3, 4, 5, 6, 71, 81, 91, 101])))
    assert.ok(ref >= 0.42, `参照实现也应过阈值，实际 ${ref}`)
    assert.equal(near.sim, Math.round(ref * 100) / 100)
    assert.equal(sims.filter((e) => sorted(e).includes(far1.path)).length, 0, '共享 2/10 段不该出边')
    assert.equal(sims.filter((e) => sorted(e).includes(far2.path)).length, 0)
  } finally {
    closeAllDb()
    rmrf(home)
  }
})

test('正文相似：每卡至多 1 条 similar 边', async () => {
  const home = tmpHome('mh-graph-sim1-')
  try {
    const base = [1, 2, 3, 4, 5, 6, 7, 8]
    for (let i = 0; i < 6; i++) {
      const swapped = [...base.slice(0, 6), 70 + i, 90 + i]
      await writeCard(home, { kind: 'knowledge', title: `同一份说明 ${i}`, tags: [`t${i}`], body: body(swapped), status: 'approved' }, { dedup: false })
    }
    const g = await graphQuery(home, { limit: 1_000_000 })
    const deg = new Map()
    for (const e of simEdges(g)) {
      for (const id of [e.source, e.target]) deg.set(id, (deg.get(id) || 0) + 1)
    }
    assert.ok(deg.size > 0, 'gs 应有相似边')
    for (const [id, d] of deg) assert.equal(d, 1, `${id} 有 ${d} 条 similar 边`)
  } finally {
    closeAllDb()
    rmrf(home)
  }
})

test('正文相似：跨 kind 必须至少共享一个标签', async () => {
  const shared = body([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  // 两个独立的库：同样的跨 kind 近重复正文，只差「有没有共享标签」
  const noTagHome = tmpHome('mh-graph-simkind-a-')
  const tagHome = tmpHome('mh-graph-simkind-b-')
  try {
    await writeCard(noTagHome, { kind: 'knowledge', title: '跨类甲', tags: ['cross-tag'], body: shared, status: 'approved' }, { dedup: false })
    await writeCard(noTagHome, { kind: 'tool', title: '跨类乙', tags: ['other-tag'], body: shared, status: 'approved' }, { dedup: false })
    assert.equal(simEdges(await graphQuery(noTagHome, { limit: 1_000_000 })).length, 0, '没有共享标签的跨 kind 近重复不出边')

    const a = await writeCard(tagHome, { kind: 'knowledge', title: '跨类甲', tags: ['cross-tag'], body: shared, status: 'approved' }, { dedup: false })
    const b = await writeCard(tagHome, { kind: 'tool', title: '跨类乙', tags: ['other-tag', 'cross-tag'], body: shared, status: 'approved' }, { dedup: false })
    const sims = simEdges(await graphQuery(tagHome, { limit: 1_000_000 }))
    assert.equal(sims.length, 1, '共享了标签就应出边')
    assert.deepEqual(sorted(sims[0]), [a.path, b.path].sort())
    assert.equal(sims[0].sim, 1, '正文完全相同 → sim = 1')
  } finally {
    closeAllDb()
    rmrf(noTagHome)
    rmrf(tagHome)
  }
})

test('正文相似：整批共用长模板（每 gram 的 DF 远超旧 DF_CAP=24）时仍能连出边', async () => {
  const home = tmpHome('mh-graph-simdense-')
  try {
    // 旧实现只索引 DF ≤ 24 的 gram，模板一被大量复用就整批落空（5000 张合成卡只出 1 条边）
    const template = Array.from({ length: 40 }, (_, k) => `${seg(k)}。`).join('')
    for (let i = 0; i < 200; i++) {
      const own = [900 + i, 2000 + i]
      await writeCard(home, { kind: 'knowledge', title: `模板卡 ${i}`, tags: [`d${i % 10}`], body: `${template}${body(own)}`, status: 'approved' }, { dedup: false })
    }
    const sims = simEdges(await graphQuery(home, { limit: 1_000_000 }))
    assert.ok(sims.length >= 80, `共用模板应连出大量边，实际 ${sims.length}`)
    for (const e of sims) assert.ok(e.sim >= 0.42)
  } finally {
    closeAllDb()
    rmrf(home)
  }
})

test('建图异步：期间事件循环被让出，并发请求的最大等待远小于总建图时间', async () => {
  const home = tmpHome('mh-graph-yield-')
  try {
    // 造 600 张长正文、彼此不相似的卡：建图量足够大，事件循环若被占住会被明显测到
    for (let i = 0; i < 3000; i++) {
      const segs = Array.from({ length: 90 }, (_, k) => i * 1000 + k)
      await writeCard(home, { kind: 'knowledge', title: `让出测试 ${i}`, tags: [`y${i % 20}`], body: body(segs), status: 'approved' }, { dedup: false })
    }
    let maxLag = 0
    let last = performance.now()
    const t = setInterval(() => {
      const now = performance.now()
      maxLag = Math.max(maxLag, now - last)
      last = now
    }, 5)
    const t0 = performance.now()
    const pending = graphQuery(home, { limit: 1_000_000 })
    assert.equal(typeof pending.then, 'function', 'graphQuery 必须返回 Promise')
    // 建图期间并发「轻请求」：每次只等下一条 setImmediate，测最大等待
    let maxWait = 0
    const waits = Array.from({ length: 20 }, async () => {
      const s = performance.now()
      await new Promise((r) => setImmediate(r))
      maxWait = Math.max(maxWait, performance.now() - s)
    })
    const g = await pending
    const total = performance.now() - t0
    await Promise.all(waits)
    clearInterval(t)
    assert.equal(g.nodes.length, 3000)
    assert.ok(total > 100, `建图应有一定耗时才有对比意义，实际 ${Math.round(total)}ms`)
    assert.ok(maxWait < 100, `并发请求最大等待 ${Math.round(maxWait)}ms 应 < 100ms（总耗时 ${Math.round(total)}ms）`)
    assert.ok(maxLag < 150, `事件循环最大停顿 ${Math.round(maxLag)}ms 应 < 150ms`)
  } finally {
    closeAllDb()
    rmrf(home)
  }
})

test('并发同一指纹：只建一次图；写库后指纹变化才重建', async () => {
  const home = tmpHome('mh-graph-inflight-')
  const origLog = console.log
  const lines = []
  console.log = (...a) => { lines.push(a.join(' ')); origLog(...a) }
  const builds = () => lines.filter((l) => l.startsWith('BUILD_TIMINGS')).length
  try {
    process.env.MH_GRAPH_DEBUG = '1'
    for (let i = 0; i < 20; i++) {
      await writeCard(home, { kind: 'knowledge', title: `并发测试 ${i}`, tags: [`c${i}`], body: body([i, i + 1, i + 2]), status: 'approved' }, { dedup: false })
    }
    lines.length = 0
    const results = await Promise.all(Array.from({ length: 5 }, () => graphQuery(home, { limit: 1_000_000 })))
    assert.equal(builds(), 1, '同一指纹的并发请求只该建一次图')
    for (const r of results) assert.equal(r.nodes.length, 20)
    assert.equal(results.filter((r) => r.stats.cached === false).length, 5, '共享结果的请求都算未命中缓存')

    const again = await graphQuery(home, { limit: 1_000_000 })
    assert.equal(again.stats.cached, true)
    assert.equal(builds(), 1, '缓存命中不再建图')

    await writeCard(home, { kind: 'knowledge', title: '新卡', tags: ['new'], body: body([999, 998, 997]), status: 'approved' }, { dedup: false })
    const after = await graphQuery(home, { limit: 1_000_000 })
    assert.equal(after.stats.cached, false, '写库后指纹变化必须重建')
    assert.equal(after.nodes.length, 21)
    assert.equal(builds(), 2)
  } finally {
    delete process.env.MH_GRAPH_DEBUG
    console.log = origLog
    closeAllDb()
    rmrf(home)
  }
})
