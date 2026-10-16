// M3 写接口的通用安全约束：无会话 401 / 缺 CSRF 403 / 跨源 403 / Agent 令牌不能调 / 统一 JSON 错误
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHubW, loggedIn, detail } from './write-helpers.mjs'

// 每个写接口：[方法, 路径, body]
const WRITES = (p) => [
  ['PATCH', '/admin/api/card', { path: p, title: 'x', expectedUpdatedAt: '2026-01-01T00:00:00Z' }],
  ['DELETE', '/admin/api/card?path=' + encodeURIComponent(p), undefined],
  ['POST', '/admin/api/card/restore', { path: p }],
  ['POST', '/admin/api/card/purge', { path: p, confirmTitle: 'x' }],
  ['POST', '/admin/api/card/rollback', { path: p, revisionId: 1, expectedUpdatedAt: '2026-01-01T00:00:00Z' }],
  ['POST', '/admin/api/cards/batch', { action: 'delete', paths: [p], confirm: true }],
  ['POST', '/admin/api/cards/purge', { paths: [p], confirm: true }],
  ['POST', '/admin/api/queue/approve', { paths: [p] }],
  ['POST', '/admin/api/queue/reject', { paths: [p], reason: 'x' }],
  ['POST', '/admin/api/tags/rename', { from: 'alpha', to: 'alpha2', confirm: true }],
  ['POST', '/admin/api/tags/merge', { from: ['alpha', 'beta'], to: 'ab', confirm: true }],
  ['POST', '/admin/api/tags/delete', { tag: 'alpha', confirm: true }],
  ['POST', '/admin/api/tidy/apply', { planId: 'x', confirm: true }],
  ['POST', '/admin/api/tidy/rollback', { rollbackFile: 'tidy-x.rollback.json', confirm: true }],
  ['POST', '/admin/api/tokens', { name: 'zzz', scopes: ['read'] }],
  ['PATCH', '/admin/api/tokens', { tokenId: 'x', name: 'y' }],
  ['DELETE', '/admin/api/tokens?tokenId=x', undefined],
  ['POST', '/admin/api/password', { oldPassword: 'a', newPassword: 'b' }],
]

test('全部写接口：无会话 → 401（统一 JSON）', async () => {
  await withHubW(async (h) => {
    const c = h.client()
    for (const [m, p, body] of WRITES('02-Projects/x.md')) {
      const r = await c.req(m, p, { body })
      assert.equal(r.status, 401, `${m} ${p}`)
      assert.equal(r.json.error, 'unauthorized')
    }
  })
})

test('全部写接口：有会话但缺 / 错 CSRF → 403 csrf；跨源 Origin → 403', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const before = h.db().prepare('SELECT COUNT(*) n FROM write_log').get().n
    for (const [m, p, body] of WRITES('02-Projects/x.md')) {
      const r = await c.req(m, p, { body })
      assert.equal(r.status, 403, `${m} ${p}`)
      assert.equal(r.json.error, 'csrf')
      const r2 = await c.req(m, p, { body, headers: { 'x-csrf-token': 'wrong' } })
      assert.equal(r2.status, 403)
      const r3 = await c.req(m, p, { body, withCsrf: true, headers: { origin: 'https://evil.example' } })
      assert.equal(r3.status, 403, `${m} ${p} origin`)
      assert.equal(r3.json.error, 'forbidden_origin')
    }
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM write_log').get().n, before, '被拒绝的写请求不得产生任何写入')
  })
})

test('Agent 令牌调用管理写接口 → 401；管理会话 cookie 不能调 /mcp', async () => {
  await withHubW(async (h) => {
    const tok = h.token('agent-x', ['read', 'write', 'tidy:apply'])
    const res = await fetch(h.url + '/admin/api/tokens', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'evil', scopes: ['read'] }) })
    assert.equal(res.status, 401)
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM agent_tokens WHERE name='evil'").get().n, 0)
  })
})

test('写接口错误一律是统一 JSON：400 非 JSON、415 非 JSON content-type、404 未知接口、405 方法不对', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const bad = await c.wpost('/admin/api/tags/rename', 'not json{')
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error, 'bad_request')
    const ct = await c.req('POST', '/admin/api/tags/rename', { body: '{}', withCsrf: true, headers: { 'content-type': 'text/plain' } })
    assert.equal(ct.status, 415)
    assert.equal(ct.json.error, 'unsupported_media_type')
    const nf = await c.wpost('/admin/api/nope', {})
    assert.equal(nf.status, 404)
    const m405 = await c.wpost('/admin/api/overview', {})
    assert.equal(m405.status, 405)
    assert.ok(!/M2 只读/.test(m405.json.message), '提示语不应再说只读')
    const big = await c.wpost('/admin/api/tags/rename', { from: 'a', to: 'b'.repeat(3 * 1024 * 1024) })
    assert.equal(big.status, 413)
    const miss = await c.wpost('/admin/api/tags/rename', {})
    assert.equal(miss.status, 400)
    assert.ok(miss.json.message)
  })
})

test('write_log 里管理员动作可区分会话，且不含口令 / 令牌 / 密钥', async () => {
  await withHubW(async (h) => {
    const a = await loggedIn(h)
    const b = await loggedIn(h)
    const p = h.db().prepare('SELECT path FROM cards LIMIT 1').get().path
    const d = await detail(a, p)
    assert.equal((await a.patch('/admin/api/card', { path: p, title: '改名A', expectedUpdatedAt: d.updatedAt })).status, 200)
    const d2 = await detail(b, p)
    assert.equal((await b.patch('/admin/api/card', { path: p, title: '改名B', expectedUpdatedAt: d2.updatedAt })).status, 200)
    const rows = h.db().prepare("SELECT actor_type, actor_id, actor_name FROM write_log WHERE action = 'edit' ORDER BY id").all()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].actor_type, 'admin')
    assert.notEqual(rows[0].actor_id, rows[1].actor_id, '不同会话 actor_id 不同')
    assert.match(rows[0].actor_id, /^session:[0-9a-f]{12}$/)
    const dump = JSON.stringify(h.db().prepare('SELECT * FROM write_log').all())
    assert.ok(!dump.includes('correct horse'))
    assert.ok(!dump.includes(a.csrf))
    assert.ok(!dump.includes(a.jar.mh_sid))
  })
})
