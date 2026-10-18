// M4 管理界面 · 令牌的归属三元组（owner / team / default_visibility）
//
// 为什么单独有这个测试：schema v3 加了三列，但管理界面是**人**发令牌的地方。
// 只要表单/接口没接上，人发出来的令牌全都是"无主 + team 可见"，分层检索对真人就失效了。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHubW, loggedIn } from './write-helpers.mjs'
import { listTokens } from '../../src/auth/tokens.js'

const lastLog = (h, action) => h.db().prepare('SELECT * FROM write_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action)
test('POST /tokens 接受 owner/team/visibility：落库、响应、列表三处一致', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const r = await c.wpost('/admin/api/tokens', { name: 'alice-claude', scopes: ['read', 'write'], owner: 'alice', team: 'remittance', visibility: 'private' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(
      { owner: r.json.owner, team: r.json.team, defaultVisibility: r.json.defaultVisibility },
      { owner: 'alice', team: 'remittance', defaultVisibility: 'private' },
    )
    assert.deepEqual(
      h.db().prepare("SELECT owner, team, default_visibility FROM agent_tokens WHERE name = 'alice-claude'").all().map((x) => [x.owner, x.team, x.default_visibility]),
      [['alice', 'remittance', 'private']],
    )
    const list = await c.get('/admin/api/tokens')
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.items.map((t) => [t.name, t.owner, t.team, t.defaultVisibility]), [['alice-claude', 'alice', 'remittance', 'private']])
    // 审计里也要有一条创建记录（args_digest 是参数摘要哈希，不是明文）
    const log = lastLog(h, 'token_create')
    assert.equal(log.outcome, 'ok')
    assert.match(log.args_digest, /^[0-9a-f]{32}$/)
  }, { seed: false })
})

test('POST /tokens 缺省归属：owner/team 空串、visibility 默认 team（与 DB 列默认一致）', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const r = await c.wpost('/admin/api/tokens', { name: 'plain', scopes: ['read'] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual([r.json.owner, r.json.team, r.json.defaultVisibility], ['', '', 'team'])
    assert.deepEqual(listTokens(h.home).map((t) => [t.owner, t.team, t.defaultVisibility]), [['', '', 'team']])
  }, { seed: false })
})

test('POST /tokens 非法归属 → 400，且消息是字面量', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const bad = await c.wpost('/admin/api/tokens', { name: 'bad-vis', scopes: ['read'], visibility: 'shared' })
    assert.equal(bad.status, 400, bad.text)
    assert.match(bad.json.message, /visibility 只能是 private \/ team \/ public/)
    const badOwner = await c.wpost('/admin/api/tokens', { name: 'bad-owner', scopes: ['read'], owner: 'alice liang' })
    assert.equal(badOwner.status, 400, badOwner.text)
    assert.match(badOwner.json.message, /owner 只能含字母数字/)
  }, { seed: false })
})

test('PATCH /tokens 可改 owner/team/visibility，并写审计', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    await c.wpost('/admin/api/tokens', { name: 'movable', scopes: ['read'], owner: 'alice', team: 'remittance' })
    const tokenId = listTokens(h.home).find((t) => t.name === 'movable').tokenId
    const r = await c.patch('/admin/api/tokens', { tokenId, team: 'payments', visibility: 'public' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.changed.sort(), ['team', 'visibility'])
    assert.deepEqual(listTokens(h.home).map((t) => [t.owner, t.team, t.defaultVisibility]), [['alice', 'payments', 'public']])
    const log = h.db().prepare("SELECT * FROM write_log WHERE action = 'token_update' ORDER BY id DESC LIMIT 1").get()
    assert.equal(log.outcome, 'ok')
  }, { seed: false })
})

test('PATCH /tokens 只给归属字段也算"有要改的字段"', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    await c.wpost('/admin/api/tokens', { name: 'only-scope', scopes: ['read'] })
    const tokenId = listTokens(h.home).find((t) => t.name === 'only-scope').tokenId
    const r = await c.patch('/admin/api/tokens', { tokenId, owner: 'bob' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.changed, ['owner'])
    const empty = await c.patch('/admin/api/tokens', { tokenId })
    assert.equal(empty.status, 400)
    assert.match(empty.json.message, /没有要修改的字段/)
  }, { seed: false })
})
