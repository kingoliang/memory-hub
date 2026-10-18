// M4 管理界面 · 卡片列表的归属展示与过滤（owner / team / visibility）
//
// 管理界面是审核发生的地方：看不到"这是谁的卡、谁能看到"，就没法审。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withAdminHub } from './admin-helpers.mjs'
import { loggedIn } from '../admin-write/write-helpers.mjs'
import { getDb, closeAllDb } from '../../src/core/db.js'
import { ensureVault, writeCard } from '../../src/core/vault.js'

const put = (home, title, c) => writeCard(home, {
  kind: 'knowledge', title, body: `${title} 的正文：团队可见性过滤要用真实数据验，原因是只看形状看不出越权。`,
  status: 'approved', submittedBy: c.owner || 'system', ...c,
}, { dedup: false })

async function withScopedCards(fn) {
  return withAdminHub(async (h) => {
    getDb(h.home).prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','none')").run()
    await ensureVault(h.home)
    await put(h.home, '自己的团队卡', { owner: 'kingo', team: 'remittance', visibility: 'team' })
    await put(h.home, '他人的团队卡', { owner: 'alice', team: 'remittance', visibility: 'team' })
    await put(h.home, '他人的私卡', { owner: 'alice', team: 'remittance', visibility: 'private' })
    await put(h.home, '跨团队公开卡', { owner: 'bob', team: 'payments', visibility: 'public' })
    closeAllDb()
    const c = await loggedIn(h)
    return fn(h, c)
  }, { seed: false })
}

// 按 UTF-16 码元排序（确定性，不依赖 pinyin 表）；期望值写死为这个顺序
const titles = (r) => r.json.items.map((x) => x.title).sort()
const scopeOf = (x) => [x.owner, x.team, x.visibility]

test('GET /cards 列表项带 owner/team/visibility', async () => {
  await withScopedCards(async (_h, c) => {
    const r = await c.get('/admin/api/cards?limit=50')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.total, 4)
    const byTitle = Object.fromEntries(r.json.items.map((x) => [x.title, scopeOf(x)]))
    assert.deepEqual(Object.keys(byTitle).sort(), ['他人的团队卡', '他人的私卡', '自己的团队卡', '跨团队公开卡'])
    assert.deepEqual(byTitle['他人的私卡'], ['alice', 'remittance', 'private'])
  })
})

test('GET /cards 按 owner / team / visibility 过滤（含组合）', async () => {
  await withScopedCards(async (_h, c) => {
    const byOwner = await c.get('/admin/api/cards?owner=alice&limit=50')
    assert.equal(byOwner.status, 200)
    assert.deepEqual(titles(byOwner), ['他人的团队卡', '他人的私卡'])

    const byTeam = await c.get('/admin/api/cards?team=remittance&limit=50')
    assert.deepEqual(titles(byTeam), ['他人的团队卡', '他人的私卡', '自己的团队卡'])

    const byVis = await c.get('/admin/api/cards?visibility=private&limit=50')
    assert.deepEqual(titles(byVis), ['他人的私卡'])

    const combo = await c.get('/admin/api/cards?owner=alice&visibility=private&limit=50')
    assert.deepEqual(titles(combo), ['他人的私卡'])

    const none = await c.get('/admin/api/cards?owner=nobody&limit=50')
    assert.deepEqual({ total: none.json.total, items: none.json.items }, { total: 0, items: [] })
  })
})

test('GET /cards 非法 visibility → 400 且列出允许值', async () => {
  await withScopedCards(async (_h, c) => {
    const r = await c.get('/admin/api/cards?visibility=shared')
    assert.equal(r.status, 400, r.text)
    assert.match(r.json.message, /visibility 只能是：private \/ team \/ public/)
  })
})

test('待审队列也带归属（审核时要知道是谁的卡）', async () => {
  await withAdminHub(async (h) => {
    getDb(h.home).prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','all')").run()
    await ensureVault(h.home)
    await put(h.home, '待审的私卡', { owner: 'alice', team: 'remittance', visibility: 'private' })
    closeAllDb()
    const c = await loggedIn(h)
    const r = await c.get('/admin/api/queue?limit=50')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.items.map((x) => [x.title, ...scopeOf(x)]), [['待审的私卡', 'alice', 'remittance', 'private']])
  }, { seed: false })
})
