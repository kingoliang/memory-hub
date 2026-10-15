// M2 只读管理 API：分页 / 过滤 / 检索 / 详情 / 队列 / 回收站 / 标签 / 整理预览 / lint / 总览 / 活跃度 / 令牌 / 审计
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { withAdminHub, FAKE_SK } from './admin-helpers.mjs'
import { search, appendUpdate, TITLE_COLLATOR } from '../../src/core/vault.js'
import { tidyPlan, tidyLint } from '../../src/core/tidy.js'
import { getDb } from '../../src/core/db.js'

const logged = async (h) => { const c = h.client(); const r = await c.login(); assert.equal(r.status, 200); return c }
const ms = (s) => (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? Date.parse(s.replace(' ', 'T') + 'Z') : Date.parse(s))
const qs = (o) => '?' + new URLSearchParams(o).toString()
const approvedRows = (h) => getDb(h.home).prepare('SELECT * FROM cards ORDER BY updated_at DESC').all()

async function allPages(c, base, params, limit = 7) {
  const items = []
  let offset = 0
  let total = null
  for (;;) {
    const r = await c.get(`${base}${qs({ ...params, limit, offset })}`)
    assert.equal(r.status, 200, r.text)
    total = r.json.total
    items.push(...r.json.items)
    if (!r.json.items.length || items.length >= total) break
    offset += limit
  }
  return { items, total }
}

test('卡片列表：默认只列 approved，真分页 total/offset/limit，页间无重复无遗漏', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const r = await c.get('/admin/api/cards')
    assert.equal(r.status, 200)
    const sqlTotal = getDb(h.home).prepare('SELECT COUNT(*) n FROM cards').get().n
    assert.equal(sqlTotal, 26)
    assert.equal(r.json.total, sqlTotal)
    assert.equal(r.json.limit, 20)
    assert.equal(r.json.offset, 0)
    assert.equal(r.json.items.length, 20)
    assert.equal((await c.get('/admin/api/cards?offset=20')).json.items.length, 6)
    const { items, total } = await allPages(c, '/admin/api/cards', {}, 7)
    assert.equal(total, 26)
    assert.equal(items.length, 26)
    assert.equal(new Set(items.map((i) => i.path)).size, 26)
    // 默认按 updated 倒序
    const ts = items.map((i) => ms(i.updatedAt))
    assert.deepEqual(ts, [...ts].sort((a, b) => b - a))
    // 越界 offset → 空页但 total 不变
    const far = await c.get('/admin/api/cards?offset=500')
    assert.equal(far.json.items.length, 0)
    assert.equal(far.json.total, 26)
  })
})

test('卡片列表：非法参数 400，limit 上限钳到 200', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    for (const bad of ['limit=0', 'limit=-1', 'limit=abc', 'offset=-5', 'offset=1.5', 'status=hacked', 'sort=body', 'order=sideways', 'createdFrom=notadate', 'updatedTo=2026-13-45']) {
      const r = await c.get('/admin/api/cards?' + bad)
      assert.equal(r.status, 400, bad)
      assert.equal(r.json.error, 'bad_request', bad)
    }
    assert.equal((await c.get('/admin/api/cards?limit=100000')).json.limit, 200)
  })
})

test('列表项不含 id / 正文；摘要有长度上限；字段齐全', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const r = await c.get('/admin/api/cards?limit=50')
    for (const it of r.json.items) {
      assert.ok(!('id' in it) && !('body' in it), '不得暴露 id / body')
      assert.ok(it.excerpt.length <= 200)
      for (const k of ['path', 'title', 'kind', 'tags', 'status', 'agent', 'createdAt', 'updatedAt', 'bodyChars']) assert.ok(k in it, k)
      assert.ok(Array.isArray(it.tags))
    }
  })
})

test('过滤 kind / tag（多值 AND）/ 状态 与直接 SQL 一致', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const rows = approvedRows(h)
    const sqlPaths = (pred) => rows.filter(pred).map((r) => r.path).sort()
    const got = async (params) => (await allPages(c, '/admin/api/cards', params, 50)).items.map((i) => i.path).sort()

    assert.deepEqual(await got({ kind: 'project' }), sqlPaths((r) => r.kind === 'project'))
    assert.equal((await got({ kind: 'project' })).length, 12)
    assert.deepEqual(await got({ tag: 'alpha' }), sqlPaths((r) => JSON.parse(r.tags).includes('alpha')))
    assert.deepEqual(await got({ tag: 'alpha,Node.js' }), sqlPaths((r) => { const t = JSON.parse(r.tags); return t.includes('alpha') && t.includes('Node.js') }))
    assert.equal((await got({ tag: 'alpha,Node.js' })).length, 3)
    assert.deepEqual(await got({ tag: 'alpha,beta' }), [], 'AND 语义：没有同时含两者的卡')
    assert.equal((await got({ tag: 'node.js' })).length, 0, 'tag 精确匹配，区分大小写')
    assert.equal((await got({ tag: '<b>x</b>' })).length, 1, '含特殊字符的标签可过滤')
    assert.deepEqual(await got({ kind: 'knowledge', tag: 'shared' }), sqlPaths((r) => r.kind === 'knowledge' && JSON.parse(r.tags).includes('shared')))
  })
})

test('过滤状态：pending / rejected / deleted / all', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const db = getDb(h.home)
    for (const [st, n] of [['pending', 3], ['rejected', 2], ['deleted', 2]]) {
      const r = await c.get('/admin/api/cards?status=' + st)
      assert.equal(r.json.total, n, st)
      assert.equal(r.json.total, db.prepare('SELECT COUNT(*) n FROM quarantine WHERE status = ?').get(st).n)
      assert.ok(r.json.items.every((i) => i.status === st))
    }
    const all = await c.get('/admin/api/cards?status=all&limit=200')
    assert.equal(all.json.total, 26 + 3 + 2 + 2)
    assert.equal(new Set(all.json.items.map((i) => i.path)).size, 33)
  })
})

test('时间范围过滤（created / updated，兼容 ISO 与 SQLite 默认格式两种时间戳）与直接计算一致', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const rows = approvedRows(h)
    const exp = (pred) => rows.filter(pred).map((r) => r.path).sort()
    const got = async (params) => (await allPages(c, '/admin/api/cards', params, 50)).items.map((i) => i.path).sort()
    assert.ok(rows.some((r) => !r.created_at.includes('T')), '数据集应含 SQLite 默认格式时间戳')
    const from = '2026-09-05', to = '2026-09-10'
    const f = ms('2026-09-05T00:00:00Z'), t = ms('2026-09-10T23:59:59.999Z')
    assert.deepEqual(await got({ createdFrom: from, createdTo: to }), exp((r) => ms(r.created_at) >= f && ms(r.created_at) <= t))
    assert.ok((await got({ createdFrom: from, createdTo: to })).length >= 5)
    assert.deepEqual(await got({ updatedFrom: '2026-09-15T00:00:00Z' }), exp((r) => ms(r.updated_at) >= ms('2026-09-15T00:00:00Z')))
    assert.deepEqual(await got({ updatedTo: '2026-09-03' }), exp((r) => ms(r.updated_at) <= ms('2026-09-03T23:59:59.999Z')))
    assert.deepEqual(await got({ createdFrom: '2030-01-01' }), [])
  })
})

test('署名过滤：精确署名；__none__ = submitted_by 为空的卡；source 可单独过滤；未署名卡的 agent 显示回退 source', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const a = await c.get('/admin/api/cards?agent=claude-code-a&limit=100')
    assert.equal(a.json.total, getDb(h.home).prepare("SELECT COUNT(*) n FROM cards WHERE submitted_by = 'claude-code-a'").get().n)
    assert.ok(a.json.items.every((i) => i.submittedBy === 'claude-code-a'))
    const none = await c.get('/admin/api/cards?agent=__none__&limit=100')
    assert.equal(none.json.total, 3, '空署名的卡必须能被找出来')
    for (const it of none.json.items) {
      assert.equal(it.submittedBy, '')
      assert.equal(it.agent, 'deepseek-harness', '回退显示 source')
      assert.equal(it.agentFromSource, true)
    }
    assert.equal((await c.get('/admin/api/cards?source=deepseek-harness')).json.total, 3)
    assert.equal((await c.get('/admin/api/cards?agent=nobody')).json.total, 0)
  })
})

test('全文检索 q（path / title / body）：命中分数与 memory_recall 同一算法；按分排序', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    for (const q of ['数据库选型', 'alpha-3', '02-Projects', '知识条目 5', 'pendingbody']) {
      const r = await c.get('/admin/api/cards' + qs({ q, limit: 200 }))
      assert.equal(r.status, 200, q)
      const expected = await search(h.home, q, { limit: 1000 })
      const got = new Map(r.json.items.map((i) => [i.path, i.score]))
      assert.deepEqual([...got.keys()].sort(), expected.map((e) => e.path).sort(), q)
      for (const e of expected) assert.equal(got.get(e.path), e.score, `${q} ${e.path}`)
      const scores = r.json.items.map((i) => i.score)
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a), '默认按分数降序')
    }
    // 精确命中排第一
    const top = (await c.get('/admin/api/cards' + qs({ q: 'alpha-3' }))).json.items[0]
    assert.equal(top.title, '项目决策 3')
    // 命中 path / title / body 三种位置
    assert.ok((await c.get('/admin/api/cards' + qs({ q: '02-Projects' }))).json.total >= 12)
    assert.ok((await c.get('/admin/api/cards' + qs({ q: '知识条目 5' }))).json.items.some((i) => i.title === '知识条目 5'))
    assert.ok((await c.get('/admin/api/cards' + qs({ q: '数据库选型' }))).json.total >= 8)
  })
})

test('检索可限定状态与过滤组合；空白 q = 不检索；通配符 % _ 当字面量', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const p = await c.get('/admin/api/cards' + qs({ q: 'pendingbody', status: 'pending' }))
    assert.equal(p.json.total, 3)
    assert.equal((await c.get('/admin/api/cards' + qs({ q: 'pendingbody' }))).json.total, 0, '默认 approved，不含待审')
    const combo = await c.get('/admin/api/cards' + qs({ q: '数据库选型', kind: 'knowledge', tag: 'beta', agent: 'codex-b' }))
    assert.equal(combo.json.total, 8)
    assert.equal((await c.get('/admin/api/cards' + qs({ q: '   ' }))).json.total, 26)
    assert.equal((await c.get('/admin/api/cards' + qs({ q: '%' }))).json.total, 0)
    const lit = getDb(h.home).prepare("SELECT COUNT(*) n FROM cards WHERE instr(lower(path || char(10) || title || char(10) || body), '_') > 0").get().n
    assert.equal((await c.get('/admin/api/cards' + qs({ q: '_' }))).json.total, lit, '_ 只按字面量匹配，不是 LIKE 通配符')
    assert.equal((await c.get('/admin/api/cards' + qs({ q: "'; DROP TABLE cards;--" }))).json.total, 0)
    assert.equal(getDb(h.home).prepare('SELECT COUNT(*) n FROM cards').get().n, 26)
  })
})

test('排序：title（拼音）/ created / updated / path，asc / desc；sort=score 无 q 时按 updated', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const title = (await allPages(c, '/admin/api/cards', { sort: 'title', order: 'asc' }, 50)).items.map((i) => i.title)
    assert.deepEqual(title, [...title].sort((a, b) => TITLE_COLLATOR.compare(a, b)))
    const created = (await allPages(c, '/admin/api/cards', { sort: 'created', order: 'asc' }, 50)).items.map((i) => ms(i.createdAt))
    assert.deepEqual(created, [...created].sort((a, b) => a - b))
    const upd = (await allPages(c, '/admin/api/cards', { sort: 'updated', order: 'asc' }, 50)).items.map((i) => ms(i.updatedAt))
    assert.deepEqual(upd, [...upd].sort((a, b) => a - b))
    const p = (await allPages(c, '/admin/api/cards', { sort: 'path', order: 'desc' }, 50)).items.map((i) => i.path)
    assert.deepEqual(p, [...p].sort().reverse())
    assert.equal((await c.get('/admin/api/cards?sort=score')).status, 200)
    // 跨页全局有序（不是页内有序）
    const pages = await allPages(c, '/admin/api/cards', { sort: 'title', order: 'desc' }, 5)
    const ts = pages.items.map((i) => i.title)
    assert.deepEqual(ts, [...ts].sort((a, b) => TITLE_COLLATOR.compare(b, a)))
  })
})

test('过滤组合 kind×tag×时间×署名 与暴力计算一致', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const rows = approvedRows(h)
    const params = { kind: 'project', tag: 'shared', createdFrom: '2026-09-03', createdTo: '2026-09-09', agent: 'claude-code-a' }
    const exp = rows.filter((r) => r.kind === 'project' && JSON.parse(r.tags).includes('shared') && r.submitted_by === 'claude-code-a' &&
      ms(r.created_at) >= ms('2026-09-03T00:00:00Z') && ms(r.created_at) <= ms('2026-09-09T23:59:59.999Z')).map((r) => r.path).sort()
    const got = (await allPages(c, '/admin/api/cards', params, 50)).items.map((i) => i.path).sort()
    assert.ok(exp.length > 0)
    assert.deepEqual(got, exp)
  })
})

test('tags 列含非法 JSON 的卡不会让列表/标签/检索崩溃', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    getDb(h.home).prepare("UPDATE cards SET tags = 'not-json' WHERE path = (SELECT path FROM cards LIMIT 1)").run()
    for (const e of ['cards', 'cards?tag=alpha', 'cards?q=项目', 'tags', 'facets', 'overview']) assert.equal((await c.get('/admin/api/' + e)).status, 200, e)
  })
})

test('卡片详情：全文、标签、来源、署名令牌名、更新记录、修订历史、审计流转', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const db = getDb(h.home)
    const row = db.prepare("SELECT * FROM cards WHERE submitted_by = 'claude-code-a' AND kind = 'project' LIMIT 1").get()
    await appendUpdate(h.home, row.path, '追加说明：后来发现的补充。')
    db.prepare('INSERT INTO card_revisions (card_path, title, body, tags, kind, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.path, '旧标题', '旧正文', '["x"]', 'project', 'admin', '2026-09-20T00:00:00.000Z')
    db.prepare("INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, 'pending', 'approved', 'admin', '人工批准')").run(row.path)
    const r = await c.get('/admin/api/card' + qs({ path: row.path }))
    assert.equal(r.status, 200, r.text)
    const d = r.json
    assert.equal(d.path, row.path)
    assert.equal(d.body, row.body)
    assert.equal(d.title, row.title)
    assert.equal(d.kind, 'project')
    assert.deepEqual(d.tags, JSON.parse(row.tags))
    assert.equal(d.status, 'approved')
    assert.equal(d.submittedBy, 'claude-code-a')
    assert.equal(d.source, 'claude-code')
    assert.equal(d.signedByToken.name, 'claude-code-a')
    assert.equal(d.signedByToken.exists, true)
    assert.equal(d.signedByToken.revoked, false)
    assert.ok(!('id' in d))
    assert.equal(d.updates.length, 1)
    assert.match(d.updates[0].content, /追加说明/)
    assert.equal(d.revisions.length, 1)
    assert.equal(d.revisions[0].title, '旧标题')
    assert.equal(d.revisions[0].editedBy, 'admin')
    assert.equal(d.history.length >= 1, true)
    assert.equal(d.history[0].newStatus, 'approved')
    assert.equal(d.deletedAt, null)
    // 未署名卡：令牌名不存在
    const un = db.prepare("SELECT path FROM cards WHERE submitted_by = ''").get()
    const u = (await c.get('/admin/api/card' + qs({ path: un.path }))).json
    assert.equal(u.signedByToken, null)
    assert.equal(u.agent, 'deepseek-harness')
  })
})

test('详情：待审 / 驳回 / 回收站卡可读；回收站带剩余天数；不存在 404；缺参数 400', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const db = getDb(h.home)
    const pend = db.prepare("SELECT path FROM quarantine WHERE status = 'pending'").get().path
    const p = (await c.get('/admin/api/card' + qs({ path: pend }))).json
    assert.equal(p.status, 'pending')
    assert.ok(p.quarantine && 'reason' in p.quarantine)
    const rej = db.prepare("SELECT path FROM quarantine WHERE status = 'rejected'").get().path
    assert.equal((await c.get('/admin/api/card' + qs({ path: rej }))).json.reason, '内容重复')
    const del = db.prepare("SELECT path FROM quarantine WHERE status = 'deleted' ORDER BY deleted_at LIMIT 1").get().path
    const d = (await c.get('/admin/api/card' + qs({ path: del }))).json
    assert.equal(d.status, 'deleted')
    assert.equal(d.retention.days, 30)
    assert.equal(d.retention.daysLeft, 1)
    assert.equal((await c.get('/admin/api/card' + qs({ path: 'nope/none.md' }))).status, 404)
    assert.equal((await c.get('/admin/api/card' + qs({ path: '../../etc/passwd' }))).status, 404)
    assert.equal((await c.get('/admin/api/card')).status, 400)
  })
})

test('待审队列：pending / rejected 只读列出，最早的在前，带原因与等待天数', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const all = (await c.get('/admin/api/queue')).json
    assert.equal(all.total, 5)
    assert.deepEqual(all.counts, { pending: 3, rejected: 2 })
    assert.equal(all.items.length, 5)
    assert.ok(all.items.every((i) => ['pending', 'rejected'].includes(i.status)))
    assert.ok(all.items.every((i) => typeof i.ageDays === 'number'))
    const pend = (await c.get('/admin/api/queue?status=pending&limit=2')).json
    assert.equal(pend.total, 3)
    assert.equal(pend.items.length, 2)
    const ts = pend.items.map((i) => ms(i.createdAt))
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b))
    const rej = (await c.get('/admin/api/queue?status=rejected')).json
    assert.equal(rej.items[0].reason, '内容重复')
    assert.equal((await c.get('/admin/api/queue?status=deleted')).status, 400)
  })
})

test('回收站：只读列出已删卡，显示剩余保留天数，快过期的在前', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const r = (await c.get('/admin/api/recycle')).json
    assert.equal(r.total, 2)
    assert.equal(r.retentionDays, 30)
    assert.deepEqual(r.items.map((i) => i.daysLeft), [1, 20])
    assert.ok(r.items.every((i) => i.deletedAt && i.expiresAt && i.path))
    assert.ok(ms(r.items[0].expiresAt) < ms(r.items[1].expiresAt))
  })
})

test('标签统计：按频次排序；同义变体成组；一次性标签标记；q 过滤', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const r = (await c.get('/admin/api/tags')).json
    const by = Object.fromEntries(r.items.map((t) => [t.tag, t]))
    assert.equal(by.shared.count, 20)
    assert.equal(by.alpha.count, 12)
    const counts = r.items.map((t) => t.count)
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a))
    assert.equal(by['once-only'].singleton, true)
    assert.equal(by.alpha.singleton, false)
    assert.ok(r.singletonCount >= 1)
    const grp = r.synonymGroups.find((g) => g.variants.some((v) => v.tag === 'nodejs'))
    assert.ok(grp, '应识别 Node.js / nodejs / node-js 为疑似同义')
    assert.deepEqual(grp.variants.map((v) => v.tag).sort(), ['Node.js', 'nodejs', 'node-js'].sort())
    assert.ok(grp.suggested)
    assert.equal(r.total, r.items.length)
    const f = (await c.get('/admin/api/tags?q=node')).json
    assert.ok(f.items.length >= 3 && f.items.every((t) => /node/i.test(t.tag)))
    assert.equal((await c.get('/admin/api/tags?limit=2')).json.items.length, 2)
  })
})

function fingerprint(h) {
  const db = getDb(h.home)
  const hash = crypto.createHash('sha256')
  for (const t of ['cards', 'quarantine', 'card_updates', 'audit_log', 'config', 'agent_tokens', 'card_sequence', 'card_revisions', 'feedback']) {
    hash.update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()))
  }
  return hash.digest('hex')
}

test('整理预览：与 tidyPlan 一致、纯只读（库指纹不变）、密钥只给路径与类型、不含 id', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const before = fingerprint(h)
    const r = await c.get('/admin/api/tidy/preview')
    assert.equal(r.status, 200, r.text)
    assert.equal(fingerprint(h), before, '预览不得改库')
    const plan = await tidyPlan(h.home, { logger: () => {} })
    assert.equal(r.json.planId, plan.planId)
    assert.equal(r.json.readOnly, true)
    assert.equal(r.json.counts.noise, plan.noise.length)
    assert.ok(r.json.counts.noise >= 1)
    assert.equal(r.json.counts.duplicateGroups, plan.duplicates.length)
    assert.equal(r.json.counts.tagChanges, plan.tags.changes.length)
    assert.equal(r.json.counts.secrets, plan.secrets.length)
    assert.ok(r.json.secrets.length >= 1)
    for (const s of r.json.secrets) assert.deepEqual(Object.keys(s).sort(), ['path', 'types'])
    assert.ok(r.json.secrets.some((s) => s.types.includes('openai-style-key')))
    assert.ok(!/"id":/.test(r.text), '预览不暴露卡 id')
    assert.ok(Array.isArray(r.json.noise) && r.json.noise[0].path)
    assert.equal(fingerprint(h), before)
    // 参数：阈值与每类条数上限
    const lim = (await c.get('/admin/api/tidy/preview?limit=1&threshold=0.9')).json
    assert.equal(lim.options.threshold, 0.9)
    assert.ok(lim.noise.length <= 1 && lim.duplicates.length <= 1 && lim.secrets.length <= 1)
    assert.equal(lim.truncated.noise, lim.counts.noise > 1)
    for (const bad of ['threshold=abc', 'threshold=5', 'limit=0', 'limit=9999']) assert.equal((await c.get('/admin/api/tidy/preview?' + bad)).status, 400, bad)
    // 没有任何 apply 入口
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const w = await c.req(m, '/admin/api/tidy/apply', { body: {}, withCsrf: true })
      assert.ok([404, 405].includes(w.status), `${m} apply 应不存在`)
    }
  })
})

test('lint 健康报告：与 tidyLint 一致，密钥疑似只含路径与类型，integrity=ok', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const r = await c.get('/admin/api/lint')
    assert.equal(r.status, 200)
    const m = await tidyLint(h.home, { logger: () => {} })
    assert.equal(r.json.total, m.total)
    assert.equal(r.json.integrity, 'ok')
    assert.equal(r.json.noise, m.noise)
    assert.equal(r.json.secretSuspects, m.secretSuspects)
    assert.ok(r.json.secrets.length >= 1)
    for (const s of r.json.secrets) assert.deepEqual(Object.keys(s).sort(), ['path', 'types'])
    assert.deepEqual(r.json.quarantine, { pending: 3, rejected: 2, deleted: 2 })
    assert.ok(!('vault' in r.json), '不暴露服务器目录')
    assert.ok(r.json.invariant && r.json.invariant.ok === true)
    assert.ok(r.json.backups && 'count' in r.json.backups)
  })
})

test('总览：总数 / kind 分布 / 隔离区 / 30 天曲线 / vault 大小 / 最近日志 / 署名分布', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const o = (await c.get('/admin/api/overview')).json
    assert.equal(o.cards.total, 26)
    assert.equal(o.cards.byKind.project, 12)
    assert.equal(o.cards.byKind.knowledge, 9)
    assert.deepEqual(o.quarantine, { pending: 3, rejected: 2, deleted: 2 })
    assert.equal(o.daily.length, 30)
    assert.ok(o.daily.every((d) => /^\d{4}-\d\d-\d\d$/.test(d.date) && Number.isInteger(d.count)))
    assert.ok(o.vault.dbBytes > 0)
    assert.ok('backupCount' in o.vault && 'lastBackup' in o.vault)
    assert.ok(o.recentLog.length >= 1 && o.recentLog.length <= 10)
    assert.ok(o.recentLog.every((l) => !('argsDigest' in l) && !('args_digest' in l)))
    const names = Object.fromEntries(o.agents.map((a) => [a.name, a.cards]))
    assert.equal(names['claude-code-a'], 14)
    assert.equal(names['(未署名)'], 3)
    assert.equal(o.llm.configured, false)
    assert.ok(Array.isArray(o.alerts))
    assert.ok('recent7d' in o.cards)
  })
})

test('总览：备份文件存在时显示最近一次备份', async () => {
  await withAdminHub(async (h) => {
    const { backupDb } = await import('../../src/core/db.js')
    const b = await backupDb(h.home)
    assert.ok(b.ok)
    const c = await logged(h)
    const o = (await c.get('/admin/api/overview')).json
    assert.equal(o.vault.backupCount, 1)
    assert.ok(o.vault.lastBackup.bytes > 0)
    assert.match(o.vault.lastBackup.file, /^memory-eternal-.*\.db$/)
    assert.ok(!o.vault.lastBackup.file.includes('/'), '只给文件名，不给服务器路径')
  })
})

test('沉淀活跃度：按署名统计 capture / recall、最近时间、「只读不写」告警；admin 行不计入；如实说明数据缺口', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const a = (await c.get('/admin/api/activity')).json
    assert.equal(a.windowDays, 30)
    const by = Object.fromEntries(a.agents.map((x) => [x.name, x]))
    assert.equal(by['claude-code-a'].captures, 3)
    assert.equal(by['claude-code-a'].recalls, 2)
    assert.ok(by['claude-code-a'].lastCaptureAt)
    assert.ok(by['claude-code-a'].lastRecallAt)
    assert.deepEqual(by['claude-code-a'].captureOutcomes, { ok: 1, dup: 1, denied: 1, error: 0 })
    assert.equal(by['claude-code-a'].readOnlyAlert, false)
    assert.equal(by['codex-b'].captures, 0)
    assert.equal(by['codex-b'].recalls, 2)
    assert.ok(by['codex-b'].lastCaptureAt, '窗口外的最近 capture 仍给出时间')
    assert.equal(by['codex-b'].readOnlyAlert, true)
    assert.equal(by['idle-agent'].captures + by['idle-agent'].recalls, 0)
    assert.equal(by['idle-agent'].tokenKnown, true)
    assert.ok(!by.admin, 'admin 动作不算 Agent 活跃度')
    assert.ok(!('old-agent' in by) || by['old-agent'].tokenRevoked === true)
    const types = a.alerts.map((x) => `${x.type}:${x.agent || x.token || ''}`)
    assert.ok(types.includes('read-only:codex-b'), types.join())
    assert.ok(types.includes('idle-token:idle-agent'), types.join())
    assert.ok(!types.some((t) => t.startsWith('read-only:claude-code-a')))
    assert.ok(!types.some((t) => t.includes('old-agent')), '已吊销令牌不告警')
    assert.ok(a.alerts.some((x) => x.type === 'pending-backlog' && x.count === 3) || a.pendingBacklog === 3)
    assert.equal(a.pendingBacklog, 3)
    assert.equal(a.daily.length, 30)
    assert.equal(a.daily.reduce((s, d) => s + d.capture, 0), 3)
    assert.equal(a.daily.reduce((s, d) => s + d.recall, 0), 4)
    assert.ok(a.dataNotes.length >= 2 && a.dataNotes.every((n) => typeof n === 'string'))
    assert.ok(a.legacy.byCardSubmitter.length >= 1, '历史卡片署名统计')
    // 窗口参数
    const w = (await c.get('/admin/api/activity?days=7&silentDays=7')).json
    assert.equal(Object.fromEntries(w.agents.map((x) => [x.name, x]))['claude-code-a'].captures, 2)
    for (const bad of ['days=0', 'days=9999', 'days=x', 'silentDays=-1']) assert.equal((await c.get('/admin/api/activity?' + bad)).status, 400, bad)
  })
})

test('令牌列表：名称 / 范围 / 创建 / 过期 / 最后使用 / 状态；绝无哈希与明文', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const r = await c.get('/admin/api/tokens')
    assert.equal(r.status, 200)
    assert.equal(r.json.items.length, 4)
    const by = Object.fromEntries(r.json.items.map((t) => [t.name, t]))
    assert.deepEqual(by['claude-code-a'].scopes, ['read', 'write'])
    assert.equal(by['claude-code-a'].status, 'active')
    assert.equal(by['old-agent'].status, 'revoked')
    assert.ok(by['old-agent'].revokedAt)
    assert.ok(by['idle-agent'].expiresAt)
    for (const t of r.json.items) {
      for (const k of ['tokenId', 'name', 'scopes', 'createdAt', 'lastUsedAt', 'expiresAt', 'revokedAt', 'status']) assert.ok(k in t, k)
      assert.ok(!('secretHash' in t) && !('secret_hash' in t))
    }
    for (const row of getDb(h.home).prepare('SELECT secret_hash FROM agent_tokens').all()) assert.ok(!r.text.includes(row.secret_hash))
    getDb(h.home).prepare("UPDATE agent_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE name = 'idle-agent'").run()
    const e = (await c.get('/admin/api/tokens')).json.items.find((t) => t.name === 'idle-agent')
    assert.equal(e.status, 'expired')
  })
})

test('审计日志 write-log：分页与过滤（署名 / 动作 / 结果 / 工具 / 类型），不含参数摘要', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const total = getDb(h.home).prepare('SELECT COUNT(*) n FROM write_log').get().n
    const r = (await c.get('/admin/api/write-log?limit=200')).json
    assert.equal(r.total, total)
    assert.ok(r.items.every((l) => !('argsDigest' in l) && !('args_digest' in l)))
    const ts = r.items.map((l) => ms(l.ts))
    assert.deepEqual(ts, [...ts].sort((a, b) => b - a), '最新在前')
    assert.equal((await c.get('/admin/api/write-log?actor=claude-code-a')).json.total, 5)
    assert.equal((await c.get('/admin/api/write-log?outcome=denied')).json.total, 1)
    assert.equal((await c.get('/admin/api/write-log?tool=memory_capture')).json.total, 4)
    assert.equal((await c.get('/admin/api/write-log?actorType=admin')).json.total >= 1, true)
    assert.equal((await c.get('/admin/api/write-log?limit=3&offset=2')).json.items.length, 3)
    assert.equal((await c.get('/admin/api/write-log?outcome=weird')).status, 400)
  })
})

test('facets：kind / 署名 / 状态 / 标签 的可选值与计数', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const f = (await c.get('/admin/api/facets')).json
    assert.equal(f.kinds.find((k) => k.kind === 'project').count, 12)
    assert.ok(f.agents.some((a) => a.name === 'claude-code-a' && a.value === 'claude-code-a'))
    assert.ok(f.agents.some((a) => a.value === '__none__' && a.count === 3))
    assert.deepEqual(f.statuses.map((s) => s.status), ['approved', 'pending', 'rejected', 'deleted'])
    assert.ok(f.tags.length >= 5)
    assert.ok(f.sources.some((s) => s.name === 'deepseek-harness'))
  })
})

test('所有只读端点不改库（指纹不变，仅允许 admin_sessions / write_log 变化）', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const before = fingerprint(h)
    for (const e of ['overview', 'facets', 'cards?q=项目&status=all', 'queue', 'recycle', 'tags', 'tidy/preview', 'lint', 'activity', 'tokens', 'write-log', 'session']) {
      assert.equal((await c.get('/admin/api/' + e)).status, 200, e)
    }
    const p = getDb(h.home).prepare('SELECT path FROM cards').get().path
    assert.equal((await c.get('/admin/api/card' + qs({ path: p }))).status, 200)
    assert.equal(fingerprint(h), before)
  })
})

test('写方法一律不可用（M3 才有写接口）：POST/PUT/PATCH/DELETE 卡片与批准等 → 404/405', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    for (const [m, p] of [['POST', 'cards'], ['PATCH', 'card?path=x'], ['DELETE', 'card?path=x'], ['POST', 'queue/approve'], ['POST', 'recycle/restore'], ['POST', 'tokens'], ['DELETE', 'tokens'], ['POST', 'tidy/apply']]) {
      const r = await c.req(m, '/admin/api/' + p, { body: {}, withCsrf: true })
      assert.ok([404, 405].includes(r.status), `${m} ${p} → ${r.status}`)
    }
    assert.equal(getDb(h.home).prepare('SELECT COUNT(*) n FROM cards').get().n, 26)
  })
})

test('用 FAKE_SK 作为检索词不会回显（响应不含 q）', async () => {
  await withAdminHub(async (h) => {
    const c = await logged(h)
    const r = await c.get('/admin/api/cards' + qs({ q: FAKE_SK }))
    assert.equal(r.status, 200)
    assert.ok(!r.text.includes(FAKE_SK))
  })
})
