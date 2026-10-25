// GH #4 / #5：同主题分组、周期性快照聚合、规范标签表、写入时标签归一、标签上限统一。
// 全部用合成数据（固定种子），不含任何真实卡片内容。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { closeAllDb, insertCard, cjk, tmpDir, fingerprint } from './tidy-fixture.mjs'
import { ensureVault } from '../../src/core/vault.js'
import { getDb } from '../../src/core/db.js'
import { tidyPlan, tidyApply, tidyRollback, planTagNormalize, formatTidyPlan, TIDY_BATCHES } from '../../src/core/tidy.js'
import { titleStem, hasTimestamp, extractEntities, topicSimilarity, planTopicGroups, planSnapshotSeries, timelineTitle } from '../../src/core/topics.js'
import { canonicalizeTags, loadTagTables, resolveMaxTags, topTags, tagKey, DEFAULT_MAX_TAGS } from '../../src/core/tags.js'
import { captureCard, pickNeighbors, summarizeTurnDetailed, NEIGHBOR_SUMMARY_CHARS } from '../../src/core/capture.js'

after(() => closeAllDb())
const quiet = { logger: () => {} }

async function freshVault() {
  const root = await tmpDir('mc-org-')
  await ensureVault(root)
  return { root, db: getDb(root) }
}

// 同一主题的「改写卡」：标题几乎相同、正文措辞完全不同（bigram Jaccard 很低），但共享实体与标签
function seedRewrites(db, n = 5) {
  const paths = []
  for (let i = 0; i < n; i++) {
    const p = `02-Projects/model-deploy-${i}.md`
    insertCard(db, {
      path: p, kind: 'project', title: `ModelX-7B 在 GPU-A100 机器上的部署实测${i ? ' v' + (i + 1) : ''}`,
      tags: ['ModelX', 'deploy'], body: `# ModelX-7B 部署\n\nModelX-7B 在 GPU-A100 上，vLLM 0.6 运行。\n${cjk(260 + i * 20)}`,
    })
    paths.push(p)
  }
  return paths
}

function seedSnapshots(db, n = 4) {
  const paths = []
  for (let i = 0; i < n; i++) {
    const d = `2026-10-${String(10 + i).padStart(2, '0')}`
    const p = `02-Projects/oncall-${d}.md`
    insertCard(db, { path: p, kind: 'project', title: `值班巡检快照 ${d} 09:00`, tags: ['oncall'], body: `# 值班巡检快照\n\n状态：${cjk(120)}\n队列：${cjk(80)}`, updatedAt: `${d}T09:00:00.000Z` })
    paths.push(p)
  }
  return paths
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('titleStem / hasTimestamp：剥掉日期、时间、序号；timelineTitle 带后缀', () => {
  assert.equal(titleStem('值班巡检快照 2026-10-12 09:00'), titleStem('值班巡检快照 2026-10-13 21:30'))
  assert.equal(titleStem('日报 20261025'), titleStem('日报 20261026'))
  assert.equal(titleStem('周会纪要 10月25日'), titleStem('周会纪要 10月26日'))
  assert.ok(hasTimestamp('值班巡检快照 2026-10-12 09:00'))
  assert.ok(!hasTimestamp('Redis 缓存策略'))
  assert.equal(timelineTitle('值班巡检快照 2026-10-12 09:00'), '值班巡检快照（时间线）')
  assert.equal(titleStem('值班巡检快照（时间线）'), titleStem('值班巡检快照 2026-10-12'))
})

test('extractEntities：型号 / 版本 / 驼峰 / 缩写', () => {
  const e = extractEntities('ModelX-7B 在 GPU-A100 上用 vLLM 0.6 跑，ComfyUI 出图，HTTP 接口')
  assert.ok(e.has('modelx-7b') && e.has('gpu-a100') && e.has('comfyui'))
  assert.ok(!e.has('http'), '常见缩写停用')
})

test('topicSimilarity：改写卡正文相似度低，但多信号判为同主题；无关卡不判', () => {
  const a = { id: 1, kind: 'project', title: 'ModelX-7B 在 GPU-A100 机器上的部署实测', tags: ['ModelX'], body: 'ModelX-7B GPU-A100 ' + cjk(300) }
  const b = { id: 2, kind: 'project', title: 'ModelX-7B 在 GPU-A100 机器上的部署实测 v2', tags: ['modelx'], body: 'ModelX-7B GPU-A100 ' + cjk(300) }
  const c = { id: 3, kind: 'project', title: '前端构建工具选型', tags: ['vite'], body: cjk(300) }
  const ab = topicSimilarity(a, b)
  assert.ok(ab.body < 0.3, `改写卡正文相似度低（${ab.body}）`)
  assert.ok(ab.same, JSON.stringify(ab))
  assert.ok(!topicSimilarity(a, c).same)
})

test('planTopicGroups：确定性；不跨 kind；exclude 生效；保留最长', () => {
  const cards = [
    { id: 1, path: 'a.md', kind: 'project', title: 'ModelX-7B 部署实测', tags: ['ModelX'], body: 'ModelX-7B ' + cjk(100) },
    { id: 2, path: 'b.md', kind: 'project', title: 'ModelX-7B 部署实测 v2', tags: ['ModelX'], body: 'ModelX-7B ' + cjk(400) },
    { id: 3, path: 'c.md', kind: 'knowledge', title: 'ModelX-7B 部署实测 v3', tags: ['ModelX'], body: 'ModelX-7B ' + cjk(200) },
    { id: 4, path: 'd.md', kind: 'project', title: '无关', tags: [], body: cjk(200) },
  ]
  const g1 = planTopicGroups(cards)
  assert.deepEqual(g1, planTopicGroups([...cards].reverse()), '输入顺序不影响结果')
  assert.equal(g1.length, 1)
  assert.equal(g1[0].canonical.path, 'b.md')
  assert.deepEqual(g1[0].members.map((m) => m.path), ['a.md'])
  assert.equal(planTopicGroups(cards, { exclude: new Set(['a.md']) }).length, 0)
})

test('planSnapshotSeries：同主干 + 时间戳且 ≥ minSeries 才成序列；已有时间线卡 1 张也归入', () => {
  const mk = (id, title, kind = 'project') => ({ id, path: `${id}.md`, kind, title, body: cjk(50), tags: [], createdAt: `2026-10-${10 + id}` })
  const cards = [mk(1, '巡检 2026-10-11'), mk(2, '巡检 2026-10-12'), mk(3, '巡检 2026-10-13'), mk(4, '日报 2026-10-11'), mk(5, '日报 2026-10-12')]
  const s = planSnapshotSeries(cards)
  assert.equal(s.length, 1)
  assert.equal(s[0].count, 3)
  assert.equal(s[0].timeline.path, '3.md', '默认保留最新一张作为时间线卡')
  assert.equal(s[0].timeline.newTitle, '巡检（时间线）')
  const s2 = planSnapshotSeries([mk(6, '巡检（时间线）'), mk(7, '巡检 2026-10-20')])
  assert.equal(s2.length, 1)
  assert.equal(s2[0].timeline.path, '6.md')
  assert.equal(s2[0].timeline.existing, true)
})

test('planTagNormalize：持久化规范写法优先于计数（不翻转）；新选定的进 decided', () => {
  const rows = [
    { id: 1, path: 'a', title: 'x', tags: JSON.stringify(['comfyui']) },
    { id: 2, path: 'b', title: 'x', tags: JSON.stringify(['comfyui']) },
    { id: 3, path: 'c', title: 'x', tags: JSON.stringify(['ComfyUI', 'H20']) },
    { id: 4, path: 'd', title: 'x', tags: JSON.stringify(['h20']) },
  ]
  const free = planTagNormalize(rows, { maxTags: 6 })
  assert.equal(free.decided[tagKey('ComfyUI')], 'comfyui', '没有规范表时按计数')
  const pinned = planTagNormalize(rows, { maxTags: 6, canon: { [tagKey('ComfyUI')]: 'ComfyUI' } })
  assert.equal(pinned.map.comfyui, 'ComfyUI', '规范表里的写法胜出，即使计数少')
  assert.ok(!(tagKey('ComfyUI') in pinned.decided))
})

test('resolveMaxTags：MEMORY_TAG_MAX 统一上限；非法值回落默认', () => {
  assert.equal(resolveMaxTags({}), DEFAULT_MAX_TAGS)
  assert.equal(resolveMaxTags({ MEMORY_TAG_MAX: '3' }), 3)
  assert.equal(resolveMaxTags({ MEMORY_TAG_MAX: '0' }), DEFAULT_MAX_TAGS)
  assert.equal(resolveMaxTags({ MEMORY_TAG_MAX: 'abc' }), DEFAULT_MAX_TAGS)
})

// ---------------------------------------------------------------------------
// 规范标签表 + 写入时归一
// ---------------------------------------------------------------------------

test('canonicalizeTags：已有写法胜出并钉进规范表；之后计数反转也不变', async () => {
  const { db } = await freshVault()
  insertCard(db, { path: '03-Knowledge/a.md', title: 'a', tags: ['ComfyUI'], body: cjk(50) })
  const r1 = canonicalizeTags(db, ['comfyui', 'COMFYUI', 'new-tag'])
  assert.deepEqual(r1.tags, ['ComfyUI', 'new-tag'], '同键去重 + 归到已有写法')
  assert.equal(loadTagTables(db).canon[tagKey('comfyui')], 'ComfyUI')
  // 小写写法后来居上：计数反转，但规范表已钉住
  for (let i = 0; i < 5; i++) insertCard(db, { path: `03-Knowledge/b${i}.md`, title: 'b', tags: ['comfyui'], body: cjk(50) })
  assert.deepEqual(canonicalizeTags(db, ['comfyui']).tags, ['ComfyUI'])
  // 同义表：跨键映射
  db.prepare("INSERT INTO config (key, value) VALUES ('tagSynonyms', ?)").run(JSON.stringify({ [tagKey('py')]: 'Python' }))
  assert.deepEqual(canonicalizeTags(db, ['py', 'python']).tags, ['Python'])
})

test('captureCard：同一标签不同大小写写入后归一（GH #5 验收）', async () => {
  const { root, db } = await freshVault()
  await captureCard(root, { kind: 'tool', title: 'Docker 网络排查', tags: ['Docker', 'network'], body: '# Docker 网络\n\n' + cjk(300), status: 'approved' })
  await captureCard(root, { kind: 'tool', title: 'Compose 卷挂载', tags: ['docker', 'NETWORK', 'volume'], body: '# Compose\n\n' + cjk(300), status: 'approved' })
  const all = db.prepare('SELECT tags FROM cards ORDER BY id').all().map((r) => JSON.parse(r.tags))
  assert.deepEqual(all, [['Docker', 'network'], ['Docker', 'network', 'volume']])
})

test('captureCard：标签数受 MEMORY_TAG_MAX 限制', async () => {
  const { root, db } = await freshVault()
  await captureCard(root, { kind: 'tool', title: '多标签卡', tags: ['a1', 'b1', 'c1', 'd1', 'e1'], body: '# 多标签\n\n' + cjk(300), status: 'approved' }, { env: { MEMORY_TAG_MAX: '3' } })
  assert.equal(JSON.parse(db.prepare('SELECT tags FROM cards').get().tags).length, 3)
})

test('topTags：按出现次数降序，同键给规范写法，排除 raw 与只出现一次的', async () => {
  const { db } = await freshVault()
  for (let i = 0; i < 3; i++) insertCard(db, { path: `03-Knowledge/t${i}.md`, title: 't', tags: ['ComfyUI', 'raw'], body: cjk(30) })
  insertCard(db, { path: '03-Knowledge/u.md', title: 'u', tags: ['comfyui', 'once'], body: cjk(30) })
  insertCard(db, { path: '03-Knowledge/v.md', title: 'v', tags: ['redis'], body: cjk(30) })
  insertCard(db, { path: '03-Knowledge/w.md', title: 'w', tags: ['redis'], body: cjk(30) })
  assert.deepEqual(topTags(db), ['ComfyUI', 'redis'])
})

// ---------------------------------------------------------------------------
// capture 邻居 + prompt
// ---------------------------------------------------------------------------

test('pickNeighbors：按标题/实体召回同主题卡，摘要给足上下文', async () => {
  const { root, db } = await freshVault()
  seedRewrites(db, 3)
  // 干扰卡：关键词多但主题不同
  for (let i = 0; i < 10; i++) insertCard(db, { path: `03-Knowledge/noise-${i}.md`, title: `部署 实测 机器 记录 ${i}`, tags: ['misc'], body: '部署 实测 机器 记录 ' + cjk(200) })
  const n = await pickNeighbors(root, { title: 'ModelX-7B 在 GPU-A100 机器上的部署实测补充', body: 'ModelX-7B 在 GPU-A100 上新测了吞吐。' + cjk(100) }, 8)
  assert.ok(n[0].path.startsWith('02-Projects/model-deploy-'), n.map((x) => x.path).join(','))
  assert.ok(n.slice(0, 3).every((x) => x.path.startsWith('02-Projects/model-deploy-')))
  assert.ok(n[0].summary.length > 120 && n[0].summary.length <= NEIGHBOR_SUMMARY_CHARS, '摘要比旧版 120 字更长')
  assert.ok(Array.isArray(n[0].tags) && !('body' in n[0]))
})

test('summarizeTurnDetailed：prompt 带已有标签与标签上限，邻居带标签与长摘要', async () => {
  let seen
  const llm = {
    async *stream(opts) {
      seen = opts
      yield { type: 'text', text: JSON.stringify({ save: true, title: '缓存策略补充', kind: 'knowledge', tags: ['Redis', 'a', 'b', 'c', 'd', 'e', 'f', 'g'], body: '# 缓存策略补充\n\n' + '要点：TTL 加随机抖动，防止同时过期。'.repeat(8) }) }
    },
  }
  const talk = '用户：缓存雪崩怎么解决？\n助手：在 TTL 上加随机过期时间，避免大量 key 同时失效；用互斥锁重建缓存。这是一个设计决策，要点如下：一、二、三。'.repeat(2)
  const long = '要点'.repeat(200)
  const r = await summarizeTurnDetailed(llm, { provider: 'p', model: 'm' }, talk, {
    existing: [{ path: '03-Knowledge/redis.md', title: 'Redis 缓存策略', tags: ['Redis', 'cache'], summary: long }],
    knownTags: ['Redis', 'ComfyUI'], maxTags: 4,
  })
  const prompt = seen.messages[0].content[0].text
  assert.ok(prompt.includes('已有标签') && prompt.includes('Redis、ComfyUI'))
  assert.ok(prompt.includes('〔Redis、cache〕'))
  assert.ok(prompt.includes('要点'.repeat(100)), '邻居摘要不再只给 120 字')
  assert.ok(/tags 最多 4 个/.test(seen.system))
  assert.ok(r.card.tags.length <= DEFAULT_MAX_TAGS, '蒸馏标签上限与 tidy 统一（默认 6，不再是 8）')
})

// ---------------------------------------------------------------------------
// tidy：plan 报告 + 幂等 + 可选批次 + 回滚
// ---------------------------------------------------------------------------

test('tidyPlan：报告同主题组与快照序列；不在默认批次里', async () => {
  const { root, db } = await freshVault()
  const rw = seedRewrites(db, 5)
  const sn = seedSnapshots(db, 4)
  const plan = await tidyPlan(root, quiet)
  assert.equal(plan.duplicates.length, 0, '改写卡正文相似度低，旧的近重复判定抓不到')
  assert.equal(plan.topics.length, 1)
  assert.deepEqual([plan.topics[0].canonical.path, ...plan.topics[0].members.map((m) => m.path)].sort(), [...rw].sort())
  assert.equal(plan.snapshots.length, 1)
  assert.equal(plan.snapshots[0].count, 4)
  assert.deepEqual(plan.snapshots[0].members.map((m) => m.path), sn)
  assert.ok(!TIDY_BATCHES.includes('topics') && !TIDY_BATCHES.includes('snapshots'), '默认不自动合并/删除')
  const text = formatTidyPlan(plan)
  assert.ok(text.includes('同主题组') && text.includes('周期性快照序列') && text.includes('值班巡检快照（时间线）'))
})

test('tidyPlan 幂等：连续两次 planId 与结果一致；默认 apply 不动同主题/快照卡', async () => {
  const { root, db } = await freshVault()
  seedRewrites(db, 4)
  seedSnapshots(db, 3)
  insertCard(db, { path: '07-Tools/x.md', kind: 'tool', title: 'x', tags: ['comfyui', 'H20'], body: cjk(80) })
  insertCard(db, { path: '07-Tools/y.md', kind: 'tool', title: 'y', tags: ['ComfyUI', 'h20'], body: cjk(80) })
  const p1 = await tidyPlan(root, quiet)
  const p2 = await tidyPlan(root, quiet)
  assert.equal(p1.planId, p2.planId)
  assert.deepEqual(p1.topics, p2.topics)
  assert.deepEqual(p1.snapshots, p2.snapshots)
  // 默认批次执行：标签规整一次并钉进规范表
  const res = await tidyApply(root, { ...quiet, confirm: true, planId: p1.planId })
  assert.equal(res.ok, true, JSON.stringify(res.batches))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cards').get().n, 9, '默认批次不合并同主题 / 快照卡')
  const canon = loadTagTables(db).canon
  assert.ok(canon[tagKey('comfyui')] && canon[tagKey('h20')])
  // 再 plan：标签无变化，且即使之后小写写法计数反超也不翻转
  const p3 = await tidyPlan(root, quiet)
  assert.equal(p3.tags.changes.length, 0)
  const pinned = canon[tagKey('comfyui')]
  const other = pinned === 'comfyui' ? 'ComfyUI' : 'comfyui'
  for (let i = 0; i < 4; i++) insertCard(db, { path: `07-Tools/z${i}.md`, kind: 'tool', title: 'z', tags: [other], body: cjk(80) })
  const p4 = await tidyPlan(root, quiet)
  assert.ok(p4.tags.changes.every((c) => c.new.includes(pinned) && !c.new.includes(other)), '规范写法不随计数翻转')
  assert.deepEqual(p4.tags.decided, {})
})

test('可选批次 topics：合并同主题组，可回滚', async () => {
  const { root, db } = await freshVault()
  const rw = seedRewrites(db, 4)
  const before = fingerprint(db)
  const plan = await tidyPlan(root, quiet)
  const res = await tidyApply(root, { ...quiet, confirm: true, planId: plan.planId, batches: ['topics'] })
  assert.equal(res.ok, true, JSON.stringify(res.batches))
  assert.equal(res.batches[0].counts.removed, 3)
  const left = db.prepare("SELECT path, body FROM cards WHERE path LIKE '02-Projects/model-deploy-%'").all()
  assert.equal(left.length, 1)
  assert.ok(left[0].body.includes('合并补充'))
  assert.equal(db.prepare("SELECT COUNT(*) n FROM quarantine WHERE status='deleted'").get().n, 3)
  assert.ok(existsSync(res.rollbackFile))
  const rb = await tidyRollback(root, res.rollbackFile, quiet)
  assert.equal(rb.ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cards').get().n, rw.length)
  const strip = (s) => JSON.parse(s).cards.map(({ updated_at: _u, id: _i, ...r }) => r) // 回收站恢复会重新发 id（既有行为）
  assert.deepEqual(strip(fingerprint(db)), strip(before))
})

test('可选批次 snapshots：归入时间线卡（改标题 + 时间线小节），再次 plan 幂等，可回滚', async () => {
  const { root, db } = await freshVault()
  const sn = seedSnapshots(db, 4)
  const before = fingerprint(db)
  const plan = await tidyPlan(root, quiet)
  const res = await tidyApply(root, { ...quiet, confirm: true, planId: plan.planId, batches: ['snapshots'] })
  assert.equal(res.ok, true, JSON.stringify(res.batches))
  const rows = db.prepare('SELECT path, title, body FROM cards').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].path, sn[sn.length - 1])
  assert.equal(rows[0].title, '值班巡检快照（时间线）')
  assert.ok(rows[0].body.includes('## 时间线'))
  for (const p of sn.slice(0, -1)) assert.ok(rows[0].body.includes(`### 值班巡检快照 ${p.slice(-13, -3)}`), p)
  const again = await tidyPlan(root, quiet)
  assert.equal(again.snapshots.length, 0, '归并后再 plan 没有新的快照建议')
  // 新快照进来：归入已有时间线卡
  insertCard(db, { path: '02-Projects/oncall-2026-10-20.md', kind: 'project', title: '值班巡检快照 2026-10-20 09:00', tags: ['oncall'], body: cjk(100) })
  const p3 = await tidyPlan(root, quiet)
  assert.equal(p3.snapshots.length, 1)
  assert.equal(p3.snapshots[0].timeline.existing, true)
  // 回滚第一次归并
  db.prepare("DELETE FROM cards WHERE path = '02-Projects/oncall-2026-10-20.md'").run()
  const rb = await tidyRollback(root, res.rollbackFile, quiet)
  assert.equal(rb.ok, true)
  const strip = (s) => JSON.parse(s).cards.map(({ updated_at: _u, id: _i, ...r }) => r) // 回收站恢复会重新发 id（既有行为）
  assert.deepEqual(strip(fingerprint(db)), strip(before), '标题 / 正文 / 标签逐字还原')
})

test('未知批次仍被拒绝；可选批次参与 plannedDeletes 与 maxDelete 保险', async () => {
  const { root, db } = await freshVault()
  seedRewrites(db, 4)
  const bad = await tidyApply(root, { ...quiet, batches: ['nope'] })
  assert.equal(bad.code, 'unknown_batch')
  const dry = await tidyApply(root, { ...quiet, batches: ['topics'] })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.plannedDeletes, 3)
  const over = await tidyApply(root, { ...quiet, confirm: true, batches: ['topics'], maxDelete: 2 })
  assert.equal(over.code, 'max_delete_exceeded')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cards').get().n, 4)
})
