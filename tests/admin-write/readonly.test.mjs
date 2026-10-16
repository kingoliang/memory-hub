// MEMORY_HUB_ADMIN_READONLY=1：所有写接口 403 read_only，读与登录登出不受影响，库不被改动
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHubW, loggedIn, PW } from './write-helpers.mjs'

test('只读模式：写接口一律 403 read_only 且零写入；读接口与登录/登出正常；/session 标明 readOnly', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const snap = () => JSON.stringify([h.db().prepare('SELECT path, title, body, tags FROM cards ORDER BY path').all(), h.db().prepare('SELECT COUNT(*) n FROM agent_tokens').get(), h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE actor_type='admin' AND action NOT IN ('login','logout')").get()])
    const before = snap()
    const p = h.db().prepare('SELECT path FROM cards LIMIT 1').get().path
    const writes = [
      ['PATCH', '/admin/api/card', { path: p, title: 'x', expectedUpdatedAt: '2026-01-01T00:00:00Z' }],
      ['DELETE', '/admin/api/card?path=' + encodeURIComponent(p), undefined],
      ['POST', '/admin/api/cards/batch', { action: 'delete', paths: [p], confirm: true }],
      ['POST', '/admin/api/cards/purge', { paths: [p], confirm: true }],
      ['POST', '/admin/api/queue/approve', { paths: [p] }],
      ['POST', '/admin/api/tags/rename', { from: 'alpha', to: 'z', confirm: true }],
      ['POST', '/admin/api/tidy/apply', { planId: 'x', confirm: true }],
      ['POST', '/admin/api/tokens', { name: 'nope', scopes: ['read'] }],
      ['POST', '/admin/api/password', { oldPassword: PW, newPassword: 'another-password-123' }],
    ]
    for (const [m, u, body] of writes) {
      const r = await c.req(m, u, { body, withCsrf: true })
      assert.equal(r.status, 403, `${m} ${u}`)
      assert.equal(r.json.error, 'read_only')
    }
    assert.equal(snap(), before)
    assert.equal((await c.get('/admin/api/cards')).status, 200)
    assert.equal((await c.get('/admin/api/session')).json.readOnly, true)
    assert.equal((await c.wpost('/admin/api/logout', {})).status, 200)
    assert.equal((await h.client().login()).status, 200)
  }, { env: { MEMORY_HUB_ADMIN_READONLY: '1' } })
})

test('默认不是只读：/session.readOnly=false', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    assert.equal((await c.get('/admin/api/session')).json.readOnly, false)
  })
})
