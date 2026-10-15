// M3 卡片编辑 / 修订 / 回滚 / 乐观锁 / 软删 / 恢复 / 永久删 / 批量
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHubW, loggedIn, detail, rowOf, countAll, lastLog } from './write-helpers.mjs'
import { search, appendUpdate } from '../../src/core/vault.js'

const firstApproved = (h) => h.db().prepare("SELECT path FROM cards WHERE title = '项目决策 0'").get().path

test('编辑：改 title/body/tags，返回新 updatedAt；旧版本进 card_revisions；write_log 记 edit 且无正文', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const p = firstApproved(h)
    const d0 = await detail(c, p)
    const r = await c.patch('/admin/api/card', { path: p, expectedUpdatedAt: d0.updatedAt, title: '新标题', body: '全新的正文 secret-needle-xyz', tags: ['t1', 't2', 't1'] })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.path, p)
    assert.deepEqual(r.json.changed.sort(), ['body', 'tags', 'title'])
    assert.notEqual(r.json.updatedAt, d0.updatedAt)
    const d1 = await detail(c, p)
    assert.equal(d1.title, '新标题')
    assert.equal(d1.body, '全新的正文 secret-needle-xyz')
    assert.deepEqual(d1.tags, ['t1', 't2'], '标签去重')
    assert.equal(d1.updatedAt, r.json.updatedAt)
    // 修订：保存的是旧版本
    assert.equal(d1.revisions.length, 1)
    assert.equal(d1.revisions[0].title, d0.title)
    assert.equal(d1.revisions[0].body, d0.body)
    assert.deepEqual(d1.revisions[0].tags, d0.tags)
    assert.equal(d1.revisions[0].kind, d0.kind)
    assert.ok(Number.isInteger(d1.revisions[0].id))
    assert.match(d1.revisions[0].editedBy, /^admin/)
    // summary 同步
    assert.equal(rowOf(h, p).summary, '全新的正文 secret-needle-xyz')
    // 被 recall 搜到新内容
    const hits = await search(h.home, '新标题', { limit: 5, minScore: 2 })
    assert.ok(hits.some((x) => x.path === p))
    // write_log
    const wl = lastLog(h, 'edit')
    assert.equal(wl.actor_type, 'admin')
    assert.equal(wl.card_path, p)
    assert.equal(wl.outcome, 'ok')
    assert.ok(!JSON.stringify(h.db().prepare('SELECT * FROM write_log').all()).includes('secret-needle-xyz'))
  })
})

test('编辑校验：缺 expectedUpdatedAt 400；空标题/空正文/非法 kind/超长/标签非数组 400；无变化不写修订；不存在 404', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const p = firstApproved(h)
    const d = await detail(c, p)
    const base = { path: p, expectedUpdatedAt: d.updatedAt }
    assert.equal((await c.patch('/admin/api/card', { path: p, title: 'x' })).status, 400)
    for (const bad of [{ title: '' }, { title: '   ' }, { body: '' }, { kind: 'bogus' }, { title: 'x'.repeat(300) }, { body: 'x'.repeat(300000) }, { tags: 'a,b' }, { tags: [1, 2] }, { tags: Array(40).fill('t').map((t, i) => t + i) }, { tags: ['x'.repeat(80)] }]) {
      const r = await c.patch('/admin/api/card', { ...base, ...bad })
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60))
      assert.equal(r.json.error, 'bad_request')
    }
    const same = await c.patch('/admin/api/card', { ...base, title: d.title })
    assert.equal(same.status, 200)
    assert.deepEqual(same.json.changed, [])
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM card_revisions').get().n, 0)
    assert.equal((await c.patch('/admin/api/card', { path: 'nope/none.md', expectedUpdatedAt: d.updatedAt, title: 'x' })).status, 404)
    assert.equal((await detail(c, p)).title, d.title, '校验失败不改数据')
  })
})

test('乐观锁：过期的 expectedUpdatedAt → 409 并带当前 updatedAt；Agent 在编辑期间写入同卡也冲突，不丢更新', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const p = firstApproved(h)
    const d = await detail(c, p)
    const r1 = await c.patch('/admin/api/card', { path: p, expectedUpdatedAt: d.updatedAt, title: '第一次' })
    assert.equal(r1.status, 200)
    const stale = await c.patch('/admin/api/card', { path: p, expectedUpdatedAt: d.updatedAt, title: '过期的保存' })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error, 'conflict')
    assert.equal(stale.json.currentUpdatedAt, r1.json.updatedAt)
    assert.equal((await detail(c, p)).title, '第一次')
    // Agent 追加了更新记录（updated_at 变化）
    const d2 = await detail(c, p)
    await new Promise((r) => setTimeout(r, 5))
    await appendUpdate(h.home, p, 'agent 补充了一条')
    const r2 = await c.patch('/admin/api/card', { path: p, expectedUpdatedAt: d2.updatedAt, title: '管理员覆盖?' })
    assert.equal(r2.status, 409)
    assert.equal((await detail(c, p)).title, '第一次')
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM card_updates').get().n, 1, 'agent 的追加仍在')
  })
})

test('修订历史与回滚：回滚到旧版本 = 一次新编辑（本身也留修订，可再回滚）', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const p = firstApproved(h)
    const d0 = await detail(c, p)
    let r = await c.patch('/admin/api/card', { path: p, expectedUpdatedAt: d0.updatedAt, title: 'V2', body: '正文V2', tags: ['v2'] })
    r = await c.patch('/admin/api/card', { path: p, expectedUpdatedAt: r.json.updatedAt, title: 'V3', body: '正文V3', tags: ['v3'] })
    const d3 = await detail(c, p)
    assert.equal(d3.revisions.length, 2)
    const v1 = d3.revisions.find((x) => x.title === d0.title)
    assert.ok(v1)
    const rb = await c.wpost('/admin/api/card/rollback', { path: p, revisionId: v1.id, expectedUpdatedAt: d3.updatedAt })
    assert.equal(rb.status, 200, rb.text)
    const d4 = await detail(c, p)
    assert.equal(d4.title, d0.title)
    assert.equal(d4.body, d0.body)
    assert.deepEqual(d4.tags, d0.tags)
    assert.equal(d4.revisions.length, 3, '回滚前的 V3 也被保存')
    assert.ok(d4.revisions.some((x) => x.title === 'V3'))
    assert.equal(lastLog(h, 'rollback').card_path, p)
    // 过期锁 / 别的卡的修订 / 不存在的修订
    assert.equal((await c.wpost('/admin/api/card/rollback', { path: p, revisionId: v1.id, expectedUpdatedAt: d3.updatedAt })).status, 409)
    assert.equal((await c.wpost('/admin/api/card/rollback', { path: p, revisionId: 99999, expectedUpdatedAt: d4.updatedAt })).status, 404)
    const other = h.db().prepare("SELECT path FROM cards WHERE title = '项目决策 1'").get().path
    const dOther = await detail(c, other)
    assert.equal((await c.wpost('/admin/api/card/rollback', { path: other, revisionId: v1.id, expectedUpdatedAt: dOther.updatedAt })).status, 404, '不能用别的卡的修订')
  })
})

test('改 kind：路径前缀同步变化，修订/反馈跟随新路径，老路径不再存在，recall 仍可见', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const p = firstApproved(h) // 01? 02-Projects/...
    assert.match(p, /^02-Projects\//)
    const d = await detail(c, p)
    const r = await c.patch('/admin/api/card', { path: p, expectedUpdatedAt: d.updatedAt, kind: 'knowledge', title: '换类型后的标题' })
    assert.equal(r.status, 200, r.text)
    assert.match(r.json.path, /^03-Knowledge\//)
    assert.notEqual(r.json.path, p)
    assert.equal(rowOf(h, p), undefined)
    const d2 = await detail(c, r.json.path)
    assert.equal(d2.kind, 'knowledge')
    assert.equal(d2.revisions.length, 1)
    assert.equal(d2.revisions[0].kind, 'project')
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM card_revisions WHERE card_path = ?').get(p).n, 0)
    assert.ok(d2.history.some((x) => /kind/.test(x.reason)))
    assert.equal(lastLog(h, 'edit').card_path, r.json.path)
    const hits = await search(h.home, '换类型后的标题', { limit: 5, minScore: 2 })
    assert.ok(hits.some((x) => x.path === r.json.path))
  })
})

test('编辑待审（隔离区）卡也可以；状态与所在表不变', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const p = h.db().prepare("SELECT path FROM quarantine WHERE status='pending' LIMIT 1").get().path
    const d = await detail(c, p)
    const r = await c.patch('/admin/api/card', { path: p, expectedUpdatedAt: d.updatedAt, body: '改过的待审正文' })
    assert.equal(r.status, 200)
    const row = h.db().prepare('SELECT status, body FROM quarantine WHERE path = ?').get(p)
    assert.equal(row.status, 'pending')
    assert.equal(row.body, '改过的待审正文')
  })
})

test('软删 → 进回收站不可 recall；恢复 → 回主库可 recall；两者写 audit_log(admin) 与 write_log', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const p = firstApproved(h)
    const before = countAll(h)
    const del = await c.del('/admin/api/card?path=' + encodeURIComponent(p))
    assert.equal(del.status, 200, del.text)
    assert.deepEqual(countAll(h), { cards: before.cards - 1, quarantine: before.quarantine + 1 })
    assert.equal(rowOf(h, p).status, 'deleted')
    assert.ok(!(await search(h.home, '项目决策 0', { limit: 30, minScore: 2 })).some((x) => x.path === p))
    assert.equal(lastLog(h, 'delete').card_path, p)
    assert.equal(h.db().prepare("SELECT changed_by FROM audit_log WHERE card_path = ? ORDER BY id DESC LIMIT 1").get(p).changed_by, 'admin')
    // 重复删除 → 409
    assert.equal((await c.del('/admin/api/card?path=' + encodeURIComponent(p))).status, 409)
    const res = await c.wpost('/admin/api/card/restore', { path: p })
    assert.equal(res.status, 200, res.text)
    assert.deepEqual(countAll(h), before)
    assert.equal(rowOf(h, p).status, 'approved')
    assert.ok((await search(h.home, '项目决策 0', { limit: 30, minScore: 2 })).some((x) => x.path === p))
    assert.equal(lastLog(h, 'restore').card_path, p)
    // 恢复一张不在回收站的卡 → 409；不存在 → 404
    assert.equal((await c.wpost('/admin/api/card/restore', { path: p })).status, 409)
    assert.equal((await c.wpost('/admin/api/card/restore', { path: 'x/none.md' })).status, 404)
    assert.equal((await c.del('/admin/api/card?path=' + encodeURIComponent('x/none.md'))).status, 404)
  })
})

test('永久删除：只能对回收站里的卡，必须输入与标题一致的确认串；之后彻底不存在（含修订外的更新记录）', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const p = firstApproved(h)
    const d = await detail(c, p)
    assert.equal((await c.wpost('/admin/api/card/purge', { path: p, confirmTitle: d.title })).status, 409, '未进回收站不能永久删')
    await c.del('/admin/api/card?path=' + encodeURIComponent(p))
    assert.equal((await c.wpost('/admin/api/card/purge', { path: p, confirmTitle: '错的标题' })).status, 400)
    assert.equal((await c.wpost('/admin/api/card/purge', { path: p })).status, 400)
    assert.ok(rowOf(h, p))
    const ok = await c.wpost('/admin/api/card/purge', { path: p, confirmTitle: d.title })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(rowOf(h, p), undefined)
    assert.equal(lastLog(h, 'purge').card_path, p)
  })
})

test('批量软删/恢复：需 confirm；超过上限 400；返回影响条数；非法项被跳过并列出；dryRun 不写', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const paths = h.db().prepare('SELECT path FROM cards ORDER BY id LIMIT 6').all().map((r) => r.path)
    const before = countAll(h)
    // 缺 confirm
    const nc = await c.wpost('/admin/api/cards/batch', { action: 'delete', paths })
    assert.equal(nc.status, 400)
    assert.equal(nc.json.error, 'confirm_required')
    assert.equal(nc.json.count, 6)
    // dryRun
    const dry = await c.wpost('/admin/api/cards/batch', { action: 'delete', paths, dryRun: true })
    assert.equal(dry.status, 200)
    assert.equal(dry.json.dryRun, true)
    assert.equal(dry.json.willAffect, 6)
    assert.deepEqual(countAll(h), before)
    // 非法 action / 空 / 重复路径
    assert.equal((await c.wpost('/admin/api/cards/batch', { action: 'nuke', paths, confirm: true })).status, 400)
    assert.equal((await c.wpost('/admin/api/cards/batch', { action: 'delete', paths: [], confirm: true })).status, 400)
    // 执行：含 1 个不存在的 + 1 个重复
    const run = await c.wpost('/admin/api/cards/batch', { action: 'delete', paths: [...paths, 'x/none.md', paths[0]], confirm: true })
    assert.equal(run.status, 200, run.text)
    assert.equal(run.json.affected, 6)
    assert.deepEqual(run.json.skipped.map((s) => s.path), ['x/none.md'])
    assert.deepEqual(countAll(h), { cards: before.cards - 6, quarantine: before.quarantine + 6 })
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action = 'delete' AND actor_type = 'admin'").get().n, 6)
    // 批量恢复
    const back = await c.wpost('/admin/api/cards/batch', { action: 'restore', paths, confirm: true })
    assert.equal(back.json.affected, 6)
    assert.deepEqual(countAll(h), before)
  })
})

test('批量上限可配置（MEMORY_HUB_ADMIN_MAX_BATCH）：超限整批拒绝且不写任何东西', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const paths = h.db().prepare('SELECT path FROM cards ORDER BY id LIMIT 4').all().map((r) => r.path)
    const before = countAll(h)
    const r = await c.wpost('/admin/api/cards/batch', { action: 'delete', paths, confirm: true })
    assert.equal(r.status, 400)
    assert.equal(r.json.error, 'batch_too_large')
    assert.equal(r.json.max, 3)
    assert.deepEqual(countAll(h), before)
    const ok = await c.wpost('/admin/api/cards/batch', { action: 'delete', paths: paths.slice(0, 3), confirm: true })
    assert.equal(ok.status, 200)
  }, { env: { MEMORY_HUB_ADMIN_MAX_BATCH: '3' } })
})
