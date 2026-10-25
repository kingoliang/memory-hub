// 检索相关性回归（GH #3）+ recall 片段 / summary（GH #2）。全部用合成数据（scripts/demo/seed-demo.mjs），不含任何真实卡片。
//
// 场景复刻线上问题：库里有大量「只命中通用词」的卡（部署 / 实测 / 配置），而真正相关的卡含一个稀有实体词。
// 旧打分（整句 +3 / 每词 +1、不计 IDF）下这些卡同分、按时间排，实体卡被埋掉；BM25 下实体卡必须排第一。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpHome, rmrf } from '../helpers.mjs'
import { closeAllDb, getDb } from '../../src/core/db.js'
import {
  writeCard, search, searchCards, appendUpdate, setCardStatus, mergeIntoCard, backfillSummaries, makeSummary, stripMarkdown, snippetAround, invalidateIndex,
} from '../../src/core/vault.js'
import { seedDemoLibrary } from '../../scripts/demo/seed-demo.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const legacyVault = await import(pathToFileURL(path.join(here, '../fixtures/legacy/vault.js')))
const legacyDb = await import(pathToFileURL(path.join(here, '../fixtures/legacy/db.js')))

/** 合成实体卡：实体词只出现在这一张卡里（ASCII 名 / 生僻中文名），其余词都是全库通用词。 */
const ENTITIES = [
  { title: '推理服务上线手册', entity: 'zephyrine', body: (e) => `# 推理服务上线手册\n\n## 背景\n\n${'上线前要确认依赖、配置与回滚路径，部署窗口避开高峰。'.repeat(6)}\n\n## 结论\n\n${e} 推理服务的部署要先停掉其他占内存的进程，再按顺序拉起；实测冷启动约 35 秒。` },
  { title: '值班交接要点', entity: '鹭岛巡检', body: (e) => `# 值班交接要点\n\n${'交接时同步告警、未完成工单与已知风险，部署变更要写清楚。'.repeat(5)}\n\n**${e}**：每周一次，覆盖配置漂移与证书过期，实测能提前发现大部分问题。` },
  { title: '构建缓存加速', entity: 'quillmesh', body: (e) => `# 构建缓存加速\n\n- 背景：构建慢。\n- 方案：远程缓存 + 增量编译。\n- 工具：${e} 负责缓存分发，部署在构建集群旁路。\n\n${'配置项按环境分层，默认值写在仓库里。'.repeat(8)}` },
]
/** 「只沾通用词」的噪声卡：标题与正文反复出现 部署 / 实测 / 配置，但不含任何实体词。 */
async function seedNoise(root, n = 60) {
  for (let i = 0; i < n; i++) {
    await writeCard(root, {
      kind: i % 2 ? 'tool' : 'project', title: `部署记录 ${i}`, tags: ['部署'],
      body: `# 部署记录 ${i}\n\n## 部署步骤\n\n先构建，再部署到测试环境，实测通过后部署生产；配置变更同步到配置中心。第 ${i} 次部署实测正常。`,
      status: 'approved', submittedBy: 'fx',
    }, { dedup: false })
  }
}
async function seedEntities(root) {
  const out = []
  for (const e of ENTITIES) {
    const r = await writeCard(root, { kind: 'knowledge', title: e.title, tags: [], body: e.body(e.entity), status: 'approved', submittedBy: 'fx' }, { dedup: false })
    out.push({ ...e, path: r.path })
  }
  return out
}

test('相关性回归：实体词查询的首条必须是含实体词的卡（合成演示库 + 通用词噪声卡）', async () => {
  const root = tmpHome()
  try {
    await seedDemoLibrary(root, { cards: 240 })
    await seedNoise(root)
    // 实体卡最早写入之后，再写一批噪声卡，让它在「同分按时间排」下必然垫底
    const ents = await seedEntities(root)
    await seedNoise(root, 20)
    for (const e of ents) {
      for (const q of [`${e.entity} 部署`, `${e.entity} 实测`, `${e.entity} 配置`, e.entity]) {
        const { total, hits } = await searchCards(root, q, { limit: 5, strict: true })
        assert.ok(total >= 1, q)
        assert.equal(hits[0].path, e.path, `「${q}」首条应为含实体词的卡，实际：${hits.map((h) => h.title).join(' | ')}`)
        assert.ok(hits[0].snippet.toLowerCase().includes(e.entity.toLowerCase()), `「${q}」片段应含实体词：${hits[0].snippet}`)
      }
    }
    // 演示库里的主题词查询：首条标题或标签必须含查询词
    for (const q of ['布隆过滤器', '灰度切流', '增量位点', '幂等键']) {
      const { hits } = await searchCards(root, q, { limit: 5, strict: true })
      assert.ok(hits.length >= 1, q)
      assert.ok(`${hits[0].title}\n${hits[0].snippet}`.includes(q), `「${q}」首条应命中查询词：${hits[0].title} / ${hits[0].snippet}`)
    }
  } finally { closeAllDb(); rmrf(root) }
})

test('前后对比：顺带提到实体词的噪声卡与真正的实体卡在旧打分下同分按时间排，新打分把实体卡排第一', async () => {
  const oldRoot = tmpHome(), newRoot = tmpHome()
  try {
    // 真正讲 zephyrine 部署的卡（最早写入）+ 40 张「部署记录」：每张都顺带提一句 zephyrine
    const cards = [{ kind: 'knowledge', title: 'zephyrine 上线手册', tags: ['zephyrine'], body: '# zephyrine 上线手册\n\nzephyrine 的部署步骤：先停掉其他占内存的进程，再拉起 zephyrine；zephyrine 冷启动约 35 秒，健康检查通过后才放流量。' }]
    // 真实库里「部署」远比实体词常见：120 张与 zephyrine 无关的部署卡
    for (let i = 0; i < 120; i++) cards.push({ kind: 'tool', title: `构建发布 ${i}`, tags: [], body: `# 构建发布 ${i}\n\n部署脚本第 ${i} 版：镜像构建后部署到测试环境，实测通过再部署生产。` })
    for (let i = 0; i < 40; i++) cards.push({ kind: 'project', title: `部署记录 ${i}`, tags: [], body: `# 部署记录 ${i}\n\n先构建，再部署到测试环境，实测通过后部署生产。部署期间顺带停掉了 zephyrine 释放内存。第 ${i} 次部署正常。` })
    for (const c of cards) {
      await legacyVault.writeCard(oldRoot, { ...c, status: 'approved', submittedBy: 'fx' }, { dedup: false })
      await writeCard(newRoot, { ...c, status: 'approved', submittedBy: 'fx' }, { dedup: false })
    }
    const q = 'zephyrine 部署'
    const oldHits = await legacyVault.search(oldRoot, q, { limit: 5, minScore: 2 })
    const { total, hits } = await searchCards(newRoot, q, { limit: 5, strict: true })
    // 旧：41 张卡（实体卡 + 顺带提到的部署记录）都是 2 分，按更新时间排 → 实体卡挤不进前 5
    assert.equal(new Set(oldHits.map((h) => h.score)).size, 1, '前提：旧打分前 5 全部同分')
    assert.ok(!oldHits.some((h) => h.title === 'zephyrine 上线手册'), '前提：旧打分下实体卡不在前 5')
    assert.equal(hits[0].title, 'zephyrine 上线手册')
    assert.equal(total, 41, '总命中数如实返回')
    assert.ok(hits[0].score > hits[1].score * 1.5, `实体卡应明显领先：${hits.map((h) => h.score).join(', ')}`)
  } finally { legacyDb.closeAllDb(); closeAllDb(); rmrf(oldRoot); rmrf(newRoot) }
})

test('严格模式挡住只沾一个通用词的卡；宽松模式（管理界面全文检索）仍列出', async () => {
  const root = tmpHome()
  try {
    await seedNoise(root, 10)
    const [e] = await seedEntities(root)
    const strict = await searchCards(root, `${e.entity} 回滚路径 窗口`, { strict: true })
    assert.deepEqual(strict.hits.map((h) => h.path), [e.path], '只有覆盖多数查询词的卡入选')
    const loose = await searchCards(root, `${e.entity} 回滚路径 窗口 部署`, { strict: false, limit: 100 })
    assert.equal(loose.hits[0].path, e.path)
    assert.ok(loose.total > 10, '宽松模式命中任一检索词即列出')
    // 库里没有的词不影响覆盖率：错别字 / 库外词 + 实体词照样命中
    assert.equal((await searchCards(root, `${e.entity} xqzvvnope`, { strict: true })).hits[0]?.path, e.path)
  } finally { closeAllDb(); rmrf(root) }
})

test('标题 / 标签加权：同样只出现一次，在标题或标签里的卡排在正文里的前面', async () => {
  const root = tmpHome()
  try {
    const filler = '这是一段与检索无关的填充文字，用于让三张卡的正文长度接近。'.repeat(4)
    const a = await writeCard(root, { kind: 'knowledge', title: '普通笔记甲', tags: [], body: `${filler}\n提到一次 lumenfold。`, status: 'approved' }, { dedup: false })
    const b = await writeCard(root, { kind: 'knowledge', title: '普通笔记乙', tags: ['lumenfold'], body: filler, status: 'approved' }, { dedup: false })
    const c = await writeCard(root, { kind: 'knowledge', title: 'lumenfold 速查', tags: [], body: filler, status: 'approved' }, { dedup: false })
    const hits = await search(root, 'lumenfold', { strict: true })
    assert.deepEqual(hits.map((h) => h.path), [c.path, b.path, a.path])
  } finally { closeAllDb(); rmrf(root) }
})

test('追加的更新记录也参与检索；片段取命中处上下文并剥离 Markdown', async () => {
  const root = tmpHome()
  try {
    const long = '与查询无关的背景铺垫。'.repeat(40)
    const r = await writeCard(root, { kind: 'knowledge', title: '长卡', tags: [], body: `# 长卡\n\n## 背景\n\n${long}\n\n**关键**：\`orchidex\` 的端口要改成 [配置文档](http://example.invalid) 里写的值。\n\n${long}`, status: 'approved' }, { dedup: false })
    const [hit] = await search(root, 'orchidex 端口', { strict: true })
    assert.equal(hit.path, r.path)
    assert.match(hit.snippet, /orchidex 的端口要改成 配置文档 里写的值/)
    assert.ok(!/[#*`\]]|\(http/.test(hit.snippet), `片段不应带 Markdown 噪声：${hit.snippet}`)
    assert.ok(hit.snippet.length <= 170)
    await appendUpdate(root, r.path, '补充：saffronet 网关的超时调到 30 秒。')
    const [up] = await search(root, 'saffronet', { strict: true })
    assert.equal(up?.path, r.path, '更新记录里的词也要能召回')
  } finally { closeAllDb(); rmrf(root) }
})

test('索引缓存：写卡 / 改状态 / 合并 / 追加更新后立即可见，不返回陈旧结果', async () => {
  const root = tmpHome()
  try {
    await seedNoise(root, 5)
    assert.equal((await search(root, 'velvetine', { strict: true })).length, 0)
    const r = await writeCard(root, { kind: 'knowledge', title: '新卡', tags: [], body: 'velvetine 的说明。', status: 'approved' }, { dedup: false })
    assert.equal((await search(root, 'velvetine', { strict: true }))[0]?.path, r.path, '新写入立即可见')
    await setCardStatus(root, r.path, 'rejected')
    assert.equal((await search(root, 'velvetine', { strict: true })).length, 0, '驳回后立即不可见')
    await setCardStatus(root, r.path, 'approved')
    assert.equal((await search(root, 'velvetine', { strict: true })).length, 1)
    await mergeIntoCard(root, r.path, '合并进来一行新信息：cobaltine 的阈值是 0.7，已经实测确认。')
    assert.equal((await search(root, 'cobaltine', { strict: true }))[0]?.path, r.path, '合并后的正文立即可检索')
    // 只改标签（签名可能不变）：显式失效后可见
    getDb(root).prepare('UPDATE cards SET tags = ? WHERE path = ?').run('["ambrette"]', r.path)
    invalidateIndex(root)
    assert.equal((await search(root, 'ambrette', { strict: true }))[0]?.path, r.path)
  } finally { closeAllDb(); rmrf(root) }
})

test('性能：1 万张卡的库，缓存命中后单次查询在百毫秒内', async () => {
  const root = tmpHome()
  try {
    const db = getDb(root)
    const ins = db.prepare("INSERT INTO cards (id, path, kind, title, tags, body, summary, status, created_at, updated_at) VALUES (?, ?, 'knowledge', ?, '[]', ?, '', 'approved', ?, ?)")
    const words = ['部署', '实测', '配置', '缓存', '数据库', '回滚', '告警', '值班', 'node', 'sqlite', 'deploy']
    db.exec('BEGIN')
    for (let i = 1; i <= 10000; i++) {
      const body = Array.from({ length: 60 }, (_, k) => words[(i * 7 + k * 13) % words.length]).join('，') + `。编号 n${i}。`
      ins.run(i, `03-Knowledge/c${i}.md`, `卡 ${i}`, body, new Date(1e12 + i).toISOString(), new Date(1e12 + i).toISOString())
    }
    db.exec('COMMIT')
    await search(root, '部署 实测', { strict: true }) // 建索引
    const t0 = performance.now()
    for (const q of ['部署 回滚', 'sqlite 配置', 'n4242', '告警 值班 缓存']) await search(root, q, { limit: 5, strict: true })
    const per = (performance.now() - t0) / 4
    assert.ok(per < 150, `单次查询 ${per.toFixed(1)}ms`)
    assert.equal((await search(root, 'n4242', { limit: 1, strict: true }))[0].path, '03-Knowledge/c4242.md')
  } finally { closeAllDb(); rmrf(root) }
})

test('summary：剥离 Markdown 后的首段有效文本，跳过与标题重复的行；新写入 / 合并 / 回填一致', async () => {
  assert.equal(makeSummary('# 数据库选型\n\n## 背景\n\n- **结论**：用 [SQLite](http://example.invalid) 存储。\n- 原因 `零依赖`', '数据库选型'), '背景 结论：用 SQLite 存储。 原因 零依赖')
  assert.equal(stripMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'), 'a b\n1 2')
  assert.equal(stripMarkdown('[[某张卡]] 与 [[x|别名]]'), '某张卡 与 别名')
  assert.ok(makeSummary('甲'.repeat(500)).length <= 200)
  assert.match(snippetAround('# t\n\n' + '前文。'.repeat(100) + '命中 targetword 这里。' + '后文。'.repeat(100), ['targetword']), /^….*targetword.*…$/)

  const root = tmpHome()
  try {
    const r = await writeCard(root, { kind: 'knowledge', title: '标题卡', tags: [], body: '# 标题卡\n\n## 小节\n\n真正的第一段内容。', status: 'approved' }, { dedup: false })
    const db = getDb(root)
    assert.equal(db.prepare('SELECT summary FROM cards WHERE path = ?').get(r.path).summary, '小节 真正的第一段内容。')
    // 模拟旧库：summary 是正文前 200 字（以 # 开头）
    db.prepare('UPDATE cards SET summary = ? WHERE path = ?').run('# 标题卡\n\n## 小节', r.path)
    const q = await writeCard(root, { kind: 'knowledge', title: '待审卡', tags: [], body: '# 待审卡\n\n待审正文。', status: 'pending' }, { dedup: false })
    db.prepare('UPDATE quarantine SET summary = ? WHERE path = ?').run('# 待审卡', q.path)
    db.prepare("DELETE FROM config WHERE key = 'summaryVersion'").run()
    const before = db.prepare('SELECT updated_at FROM cards WHERE path = ?').get(r.path).updated_at
    const first = backfillSummaries(root)
    assert.equal(first.skipped, false)
    assert.equal(first.updated, 2)
    assert.equal(db.prepare('SELECT summary FROM cards WHERE path = ?').get(r.path).summary, '小节 真正的第一段内容。')
    assert.equal(db.prepare('SELECT summary FROM quarantine WHERE path = ?').get(q.path).summary, '待审正文。')
    assert.equal(db.prepare('SELECT updated_at FROM cards WHERE path = ?').get(r.path).updated_at, before, '回填不改 updated_at')
    assert.deepEqual(backfillSummaries(root), { updated: 0, scanned: 0, skipped: true }, '幂等：第二次直接跳过')
    assert.equal(backfillSummaries(root, { force: true }).updated, 0, '强制重算也不会再改')
  } finally { closeAllDb(); rmrf(root) }
})
