// M3 令牌管理 + 管理员口令修改
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { withHubW, loggedIn, PW } from './write-helpers.mjs'
import { rpc } from '../helpers.mjs'
import { listTokens, createToken, revokeToken } from '../../src/auth/tokens.js'
import { setAdminPassword, verifyPassword, getAdminPasswordHash } from '../../src/admin/auth.js'
import { TEST_COST } from '../admin/admin-helpers.mjs'

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

test('创建令牌：明文只在创建响应里出现一次；库里只有哈希；列表/日志/审计里都没有明文；该令牌可用', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const r = await c.wpost('/admin/api/tokens', { name: 'new-agent', scopes: ['read', 'write'], expiresAt: new Date(Date.now() + 7 * 86400e3).toISOString() })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.ok, true)
    const tok = r.json.token
    assert.match(tok, /^mh_[A-Za-z0-9]+_[A-Za-z0-9_-]{20,}$/)
    assert.equal(r.json.name, 'new-agent')
    assert.deepEqual(r.json.scopes, ['read', 'write'])
    assert.match(r.json.notice, /仅显示一次/)
    const secret = tok.split('_').slice(2).join('_')
    // 库里只有哈希
    const row = h.db().prepare("SELECT * FROM agent_tokens WHERE name = 'new-agent'").get()
    assert.equal(row.secret_hash, sha256(secret))
    assert.ok(!JSON.stringify(h.db().prepare('SELECT * FROM agent_tokens').all()).includes(secret))
    assert.ok(!JSON.stringify(h.db().prepare('SELECT * FROM write_log').all()).includes(secret))
    assert.ok(!h.logs.text().includes(secret), '服务日志无明文')
    // 之后任何读取都没有明文
    const list = await c.get('/admin/api/tokens')
    assert.ok(!list.text.includes(secret))
    assert.ok(!(await c.get('/admin/api/write-log?limit=200')).text.includes(secret))
    assert.ok(list.json.items.some((t) => t.name === 'new-agent' && t.status === 'active'))
    // 令牌能用
    assert.equal((await rpc(h.url, tok, 'tools/list')).status, 200)
    const wl = h.db().prepare("SELECT * FROM write_log WHERE action='token_create'").get()
    assert.equal(wl.actor_type, 'admin')
    assert.equal(wl.outcome, 'ok')
  })
})

test('创建令牌校验：非法名/空名/空 scope/非法 scope/过期时间在过去或不是时间 → 400；活跃重名 → 409；tidy:apply 允许显式授予', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    for (const body of [{ name: '', scopes: ['read'] }, { name: 'bad name!', scopes: ['read'] }, { name: 'ok1', scopes: [] }, { name: 'ok1', scopes: ['root'] }, { name: 'ok1', scopes: 'read' }, { name: 'ok1', scopes: ['read'], expiresAt: 'yesterday' }, { name: 'ok1', scopes: ['read'], expiresAt: new Date(Date.now() - 1000).toISOString() }]) {
      const r = await c.wpost('/admin/api/tokens', body)
      assert.equal(r.status, 400, JSON.stringify(body))
    }
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM agent_tokens WHERE name = 'ok1'").get().n, 0)
    const dup = await c.wpost('/admin/api/tokens', { name: 'claude-code-a', scopes: ['read'] })
    assert.equal(dup.status, 409)
    assert.equal(dup.json.error, 'conflict')
    const t = await c.wpost('/admin/api/tokens', { name: 'tidy-bot', scopes: ['tidy:apply'] })
    assert.equal(t.status, 200)
    assert.deepEqual(t.json.scopes, ['tidy:apply'])
  })
})

test('撤销后该令牌访问 /mcp 立即 401；重复撤销 409；不存在 404；列表标记已撤销', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const made = await c.wpost('/admin/api/tokens', { name: 'to-revoke', scopes: ['read'] })
    const tok = made.json.token
    assert.equal((await rpc(h.url, tok, 'tools/list')).status, 200)
    const rv = await c.del('/admin/api/tokens?tokenId=' + made.json.tokenId)
    assert.equal(rv.status, 200, rv.text)
    assert.equal((await rpc(h.url, tok, 'tools/list')).status, 401)
    assert.equal((await c.del('/admin/api/tokens?tokenId=' + made.json.tokenId)).status, 409)
    assert.equal((await c.del('/admin/api/tokens?tokenId=nope')).status, 404)
    assert.equal((await c.del('/admin/api/tokens')).status, 400)
    const item = (await c.get('/admin/api/tokens')).json.items.find((t) => t.name === 'to-revoke')
    assert.equal(item.status, 'revoked')
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='token_revoke' AND actor_type='admin'").get().n, 1)
  })
})

test('已撤销令牌的名字可以复用（schema v2：唯一性只约束未撤销令牌）；活跃重名仍被拒绝；旧令牌不会复活', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const a = await c.wpost('/admin/api/tokens', { name: 'reuse-me', scopes: ['read'] })
    assert.equal((await c.wpost('/admin/api/tokens', { name: 'reuse-me', scopes: ['read'] })).status, 409)
    await c.del('/admin/api/tokens?tokenId=' + a.json.tokenId)
    const b = await c.wpost('/admin/api/tokens', { name: 'reuse-me', scopes: ['read', 'write'] })
    assert.equal(b.status, 200, b.text)
    assert.notEqual(b.json.tokenId, a.json.tokenId)
    assert.equal((await rpc(h.url, a.json.token, 'tools/list')).status, 401, '旧令牌仍是失效的')
    assert.equal((await rpc(h.url, b.json.token, 'tools/list')).status, 200)
    // 按名字撤销时命中的是活跃那枚
    assert.deepEqual(revokeToken(h.home, 'reuse-me').tokenId, b.json.tokenId)
    assert.equal((await rpc(h.url, b.json.token, 'tools/list')).status, 401)
    assert.equal(listTokens(h.home).filter((t) => t.name === 'reuse-me').length, 2)
  })
})

test('改名 / 改过期时间：改名唯一性按活跃令牌；expiresAt:null 清除过期；已撤销的不能改；改名后令牌依旧可用', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const a = await c.wpost('/admin/api/tokens', { name: 'rename-me', scopes: ['read'], expiresAt: new Date(Date.now() + 86400e3).toISOString() })
    const r = await c.patch('/admin/api/tokens', { tokenId: a.json.tokenId, name: 'renamed', expiresAt: null })
    assert.equal(r.status, 200, r.text)
    const row = h.db().prepare('SELECT * FROM agent_tokens WHERE token_id = ?').get(a.json.tokenId)
    assert.equal(row.name, 'renamed')
    assert.equal(row.expires_at, null)
    assert.equal((await rpc(h.url, a.json.token, 'tools/list')).status, 200)
    assert.equal((await c.patch('/admin/api/tokens', { tokenId: a.json.tokenId, name: 'codex-b' })).status, 409, '与活跃令牌重名')
    assert.equal((await c.patch('/admin/api/tokens', { tokenId: a.json.tokenId, name: 'bad name' })).status, 400)
    assert.equal((await c.patch('/admin/api/tokens', { tokenId: a.json.tokenId, expiresAt: 'garbage' })).status, 400)
    assert.equal((await c.patch('/admin/api/tokens', { tokenId: a.json.tokenId })).status, 400, '没有任何要改的字段')
    assert.equal((await c.patch('/admin/api/tokens', { tokenId: 'nope', name: 'zzz' })).status, 404)
    const when = new Date(Date.now() + 3 * 86400e3).toISOString()
    assert.equal((await c.patch('/admin/api/tokens', { tokenId: a.json.tokenId, expiresAt: when })).status, 200)
    assert.equal(h.db().prepare('SELECT expires_at FROM agent_tokens WHERE token_id = ?').get(a.json.tokenId).expires_at, when)
    await c.del('/admin/api/tokens?tokenId=' + a.json.tokenId)
    assert.equal((await c.patch('/admin/api/tokens', { tokenId: a.json.tokenId, name: 'again' })).status, 409)
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='token_update'").get().n, 2)
  })
})

test('修改管理员口令：需要旧口令；旧口令错 401 且不改；新口令太短 400；成功后旧口令失效、所有会话失效、新口令可登录', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const other = await loggedIn(h)
    const before = getAdminPasswordHash(h.home)
    const wrong = await c.wpost('/admin/api/password', { oldPassword: 'not-the-password', newPassword: 'a-brand-new-password-123' })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.json.error, 'invalid_credentials')
    assert.equal(getAdminPasswordHash(h.home), before)
    assert.equal((await c.wpost('/admin/api/password', { newPassword: 'a-brand-new-password-123' })).status, 400, '缺旧口令')
    assert.equal((await c.wpost('/admin/api/password', { oldPassword: PW, newPassword: 'short' })).status, 400)
    assert.equal((await c.wpost('/admin/api/password', { oldPassword: PW, newPassword: PW })).status, 400, '新旧相同')
    assert.equal(getAdminPasswordHash(h.home), before)
    const NEW = 'a-brand-new-password-123'
    const ok = await c.wpost('/admin/api/password', { oldPassword: PW, newPassword: NEW })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.ok, true)
    assert.notEqual(getAdminPasswordHash(h.home), before)
    assert.equal(verifyPassword(NEW, getAdminPasswordHash(h.home)), true)
    // 所有会话失效
    assert.equal((await c.get('/admin/api/session')).status, 401)
    assert.equal((await other.get('/admin/api/session')).status, 401)
    const fresh = h.client()
    assert.equal((await fresh.login(PW)).status, 401)
    assert.equal((await fresh.login(NEW)).status, 200)
    // 日志与审计里没有任何口令
    const dump = JSON.stringify(h.db().prepare('SELECT * FROM write_log').all()) + h.logs.text()
    assert.ok(!dump.includes(PW) && !dump.includes(NEW) && !dump.includes('not-the-password'))
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='password_change' AND outcome='ok'").get().n, 1)
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='password_change' AND outcome='denied'").get().n, 1)
  })
})

test('旧口令连错会被限流（与登录共用来源限流）：超过阈值 → 429', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    let last = 0
    for (let i = 0; i < 7; i++) last = (await c.wpost('/admin/api/password', { oldPassword: 'wrong-' + i, newPassword: 'a-brand-new-password-123' })).status
    assert.equal(last, 429)
    // 限流期间连正确旧口令也先被挡，口令不变
    assert.equal((await c.wpost('/admin/api/password', { oldPassword: PW, newPassword: 'a-brand-new-password-123' })).status, 429)
  })
})
