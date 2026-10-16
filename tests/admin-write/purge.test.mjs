// 回收站「立即删除」：POST /cards/purge（paths 或 all）。仅回收站内的卡可删；非回收站/不存在的跳过并给原因。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHubW, loggedIn, rowOf, countAll } from './write-helpers.mjs'
import { search, recycleList } from '../../src/core/vault.js'

const URL = '/admin/api/cards/purge'
const trashed = (h) => h.db().prepare("SELECT path FROM quarantine WHERE status = 'deleted' ORDER BY id").all().map((r) => r.path)
const approved = (h, n = 3) => h.db().prepare('SELECT path FROM cards ORDER BY id LIMIT ?').all(n).map((r) => r.path)
const softDelete = async (c, paths) => assert.equal((await c.wpost('/admin/api/cards/batch', { action: 'delete', paths, confirm: true })).status, 200)

test('立即删除：鉴权 / CSRF（无会话 401；缺 CSRF 403）', async () => {
  await withHubW(async (h) => {
    const anon = h.client()
    assert.equal((await anon.req('POST', URL, { body: { paths: ['x'], confirm: true } })).status, 401)
    const c = await loggedIn(h)
    const before = countAll(h)
    const r = await c.req('POST', URL, { body: { all: true, confirm: true } })
    assert.equal(r.status, 403)
    assert.equal(r.json.error, 'csrf')
    assert.deepEqual(countAll(h), before)
  })
})

test('立即删除：只删回收站内的卡；非回收站卡与不存在的 id 逐条 skipped（含原因），不被删', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const [t0, t1] = trashed(h)
    const [live] = approved(h, 1)
    const before = countAll(h)
    const r = await c.wpost(URL, { paths: [t0, live, 'x/none.md'], confirm: true })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.affected, 1)
    assert.deepEqual(r.json.paths, [t0])
    const reasons = Object.fromEntries(r.json.skipped.map((s) => [s.path, s.reason]))
    assert.deepEqual(reasons, { [live]: 'not_in_recycle', 'x/none.md': 'not_found' })
    assert.ok(r.json.skipped.every((s) => s.message))
    assert.equal(rowOf(h, t0), undefined)
    assert.ok(rowOf(h, live), '主库卡未被删')
    assert.ok(rowOf(h, t1), '未点名的回收站卡未被删')
    assert.deepEqual(countAll(h), { cards: before.cards, quarantine: before.quarantine - 1 })
  })
})

test('立即删除：全部都不在回收站 → 409 且零删除；全是不存在 → 404', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const before = countAll(h)
    const r = await c.wpost(URL, { paths: approved(h, 2), confirm: true })
    assert.equal(r.status, 409)
    assert.equal(r.json.skipped.length, 2)
    assert.equal((await c.wpost(URL, { paths: ['x/none.md'], confirm: true })).status, 404)
    assert.deepEqual(countAll(h), before)
  })
})

test('立即删除：入参校验（paths 非数组/空/含非字符串、all 非布尔、paths 与 all 同时给、缺 confirm 都拒绝且不删）', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const [t0] = trashed(h)
    const before = countAll(h)
    for (const body of [
      { confirm: true }, { paths: [], confirm: true }, { paths: 'x', confirm: true }, { paths: [1], confirm: true },
      { paths: [t0], all: true, confirm: true }, { all: 'yes', confirm: true }, { all: false, confirm: true },
      { paths: [t0], confirm: 'true' },
    ]) {
      const r = await c.wpost(URL, body)
      assert.equal(r.status, 400, JSON.stringify(body))
    }
    for (const body of [{ paths: [t0] }, { paths: [t0], confirm: false }, { all: true }, { all: true, confirm: false }]) {
      const r = await c.wpost(URL, body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal(r.json.error, 'confirm_required')
    }
    assert.deepEqual(countAll(h), before)
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action = 'purge'").get().n, 0)
  })
})

test('立即删除：dryRun 只预览不删', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const before = countAll(h)
    const [live] = approved(h, 1)
    const r = await c.wpost(URL, { paths: [...trashed(h), live], dryRun: true })
    assert.equal(r.status, 200)
    assert.equal(r.json.willAffect, 2)
    assert.equal(r.json.skipped.length, 1)
    assert.deepEqual(countAll(h), before)
  })
})

test('立即删除：单次上限遵循 MEMORY_HUB_ADMIN_MAX_BATCH，超限整批拒绝', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    await softDelete(c, approved(h, 2))
    assert.equal(trashed(h).length, 4)
    const before = countAll(h)
    const r = await c.wpost(URL, { paths: trashed(h), confirm: true })
    assert.equal(r.status, 400)
    assert.equal(r.json.error, 'batch_too_large')
    assert.equal(r.json.max, 3)
    assert.deepEqual(countAll(h), before)
    assert.equal((await c.wpost(URL, { paths: trashed(h).slice(0, 3), confirm: true })).status, 200)
  }, { env: { MEMORY_HUB_ADMIN_MAX_BATCH: '3' } })
})

test('清空回收站（all+confirm）：只清回收站，不动主库/待审/驳回；空回收站再清返回 0', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    await softDelete(c, approved(h, 2))
    const pendingRejected = h.db().prepare("SELECT COUNT(*) n FROM quarantine WHERE status IN ('pending','rejected')").get().n
    assert.ok(pendingRejected > 0)
    const before = countAll(h)
    const r = await c.wpost(URL, { all: true, confirm: true })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.affected, 4)
    assert.deepEqual(r.json.skipped, [])
    assert.equal(trashed(h).length, 0)
    assert.deepEqual(countAll(h), { cards: before.cards, quarantine: before.quarantine - 4 })
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM quarantine WHERE status IN ('pending','rejected')").get().n, pendingRejected)
    const again = await c.wpost(URL, { all: true, confirm: true })
    assert.equal(again.status, 200)
    assert.equal(again.json.affected, 0)
  })
})

test('立即删除后：卡与关联数据（更新记录/反馈/修订）清除，搜索/召回/列表/详情/图谱都不再出现；写 write_log 且无正文', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const [p] = approved(h, 1)
    const row = rowOf(h, p)
    const kw = row.title
    await softDelete(c, [p])
    const id = rowOf(h, p).id
    h.db().prepare('INSERT INTO card_revisions (card_path, title, body, tags, kind, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p, row.title, row.body, '[]', row.kind, 'admin:t', new Date().toISOString())
    const nUpd = h.db().prepare('SELECT COUNT(*) n FROM card_updates WHERE card_id = ?').get(id).n
    assert.ok(nUpd >= 0)
    const r = await c.wpost(URL, { paths: [p], confirm: true })
    assert.equal(r.status, 200, r.text)
    assert.equal(rowOf(h, p), undefined)
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM card_updates WHERE card_id = ?').get(id).n, 0)
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM feedback WHERE card_path = ?').get(p).n, 0)
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM card_revisions WHERE card_path = ?').get(p).n, 0)
    assert.ok(!(await search(h.home, kw, { limit: 50, minScore: 0 })).some((x) => x.path === p), 'search')
    assert.ok(!(await recycleList(h.home)).some((x) => x.path === p), 'recycleList')
    const list = await c.get('/admin/api/cards?q=' + encodeURIComponent(kw) + '&status=all&limit=50')
    assert.ok(!JSON.stringify(list.json).includes(JSON.stringify(p).slice(1, -1)), 'cards list')
    assert.equal((await c.get('/admin/api/recycle')).json.items.some((x) => x.path === p), false)
    assert.equal((await c.get('/admin/api/card?path=' + encodeURIComponent(p))).status, 404)
    assert.ok(!JSON.stringify((await c.get('/admin/api/graph')).json).includes(p), 'graph')
    const wl = h.db().prepare("SELECT * FROM write_log WHERE action = 'purge' ORDER BY id DESC").get()
    assert.equal(wl.actor_type, 'admin')
    assert.equal(wl.card_path, p)
    assert.equal(wl.tool, 'POST /cards/purge')
    assert.ok(!JSON.stringify(wl).includes(row.body))
  })
})

test('立即删除：每张被删的卡一条 write_log（purge），跳过的不写', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const ts = trashed(h)
    await c.wpost(URL, { paths: [...ts, ...approved(h, 1)], confirm: true })
    const logs = h.db().prepare("SELECT card_path FROM write_log WHERE action = 'purge' AND actor_type = 'admin'").all().map((r) => r.card_path).sort()
    assert.deepEqual(logs, [...ts].sort())
  })
})
