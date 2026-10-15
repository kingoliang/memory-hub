// M3 待审队列：批准 / 驳回（单个与批量）/ recall 可见性 / write_log
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHubW, loggedIn, rowOf, lastLog } from './write-helpers.mjs'
import { search } from '../../src/core/vault.js'

const pendingPaths = (h) => h.db().prepare("SELECT path FROM quarantine WHERE status='pending' ORDER BY id").all().map((r) => r.path)
const recallable = async (h, p) => (await search(h.home, 'pendingbody', { limit: 30, minScore: 2 })).some((x) => x.path === p)

test('批准：卡进入 cards 并可被 recall；audit_log 记 admin；write_log 记 approve', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const [p] = pendingPaths(h)
    assert.equal(await recallable(h, p), false, '批准前 recall 不可见')
    const r = await c.wpost('/admin/api/queue/approve', { paths: [p] })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.affected, 1)
    assert.equal(h.db().prepare('SELECT status FROM cards WHERE path = ?').get(p).status, 'approved')
    assert.equal(h.db().prepare('SELECT 1 FROM quarantine WHERE path = ?').get(p), undefined)
    assert.equal(await recallable(h, p), true, '批准后 recall 可见')
    const al = h.db().prepare('SELECT * FROM audit_log WHERE card_path = ? ORDER BY id DESC LIMIT 1').get(p)
    assert.equal(al.changed_by, 'admin')
    assert.equal(al.new_status, 'approved')
    assert.equal(lastLog(h, 'approve').card_path, p)
    // 已批准的不能再批准
    assert.equal((await c.wpost('/admin/api/queue/approve', { paths: [p] })).status, 409)
  })
})

test('驳回：带理由，留在隔离区、仍不可 recall；理由可在待审页与详情看到；不带理由也行', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const [p, p2] = pendingPaths(h)
    const r = await c.wpost('/admin/api/queue/reject', { paths: [p], reason: '内容重复，无复用价值' })
    assert.equal(r.status, 200, r.text)
    const row = h.db().prepare('SELECT status, reason FROM quarantine WHERE path = ?').get(p)
    assert.equal(row.status, 'rejected')
    assert.equal(row.reason, '内容重复，无复用价值')
    assert.equal(await recallable(h, p), false)
    const q = await c.get('/admin/api/queue?status=rejected')
    assert.ok(q.json.items.some((i) => i.path === p && i.reason === '内容重复，无复用价值'))
    assert.equal(h.db().prepare('SELECT reason FROM audit_log WHERE card_path = ? ORDER BY id DESC LIMIT 1').get(p).reason, '内容重复，无复用价值')
    assert.equal(lastLog(h, 'reject').card_path, p)
    assert.equal((await c.wpost('/admin/api/queue/reject', { paths: [p2] })).status, 200)
    // 理由过长 400；对已批准的卡驳回 409
    assert.equal((await c.wpost('/admin/api/queue/reject', { paths: [pendingPaths(h)[0]], reason: 'x'.repeat(600) })).status, 400)
    const approved = h.db().prepare('SELECT path FROM cards LIMIT 1').get().path
    assert.equal((await c.wpost('/admin/api/queue/reject', { paths: [approved], reason: 'x' })).status, 409)
  })
})

test('已驳回的卡可以重新批准（队列里的"反悔"）', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const rej = h.db().prepare("SELECT path FROM quarantine WHERE status='rejected' LIMIT 1").get().path
    const r = await c.wpost('/admin/api/queue/approve', { paths: [rej] })
    assert.equal(r.status, 200, r.text)
    assert.equal(rowOf(h, rej).status, 'approved')
  })
})

test('批量批准 / 驳回：多条需要 confirm；返回影响条数；跳过非待审项并列出；上限生效；全部写 write_log', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const ps = pendingPaths(h)
    assert.equal(ps.length, 3)
    const nc = await c.wpost('/admin/api/queue/approve', { paths: ps })
    assert.equal(nc.status, 400)
    assert.equal(nc.json.error, 'confirm_required')
    assert.equal(nc.json.count, 3)
    const ok = await c.wpost('/admin/api/queue/approve', { paths: [...ps, 'x/none.md'], confirm: true })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.affected, 3)
    assert.deepEqual(ok.json.skipped.map((s) => s.path), ['x/none.md'])
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='approve' AND actor_type='admin'").get().n, 3)
    for (const p of ps) assert.equal(await recallable(h, p), true)
    // 批量驳回
    const rej = h.db().prepare("SELECT path FROM quarantine WHERE status='rejected'").all().map((r) => r.path)
    const again = await c.wpost('/admin/api/queue/reject', { paths: rej, confirm: true, reason: '统一驳回' })
    assert.equal(again.status, 409, '已驳回的不能再驳回 → 全部被跳过时返回 409')
  })
})

test('审批的批量上限：超限整批 400，不改任何卡', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const ps = pendingPaths(h)
    const r = await c.wpost('/admin/api/queue/approve', { paths: ps, confirm: true })
    assert.equal(r.status, 400)
    assert.equal(r.json.error, 'batch_too_large')
    assert.equal(pendingPaths(h).length, 3)
  }, { env: { MEMORY_HUB_ADMIN_MAX_BATCH: '2' } })
})
