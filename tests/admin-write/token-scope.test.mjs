// M4 管理界面 · 令牌的归属三元组（owner / team / default_visibility）
//
// 为什么单独有这个测试：schema v3 加了三列，但管理界面是**人**发令牌的地方。
// 只要表单/接口没接上，人发出来的令牌全都是"无主 + team 可见"，分层检索对真人就失效了。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHubW, loggedIn } from './write-helpers.mjs'
import { listTokens } from '../../src/auth/tokens.js'
import { createUser, updateUser } from '../../src/admin/users.js'
import { TEST_COST } from '../admin/admin-helpers.mjs'

// 2026-10-19 起：管理界面里令牌归属人必须是已存在账号，团队跟着账号走（docs/decisions/2026-10-19-token-owner-from-user-list.md）
const seedUsers = (home) => {
  createUser(home, { username: 'alice', team: 'remittance', role: 'member', password: 'strong-user-pass-01' }, { cost: TEST_COST })
  createUser(home, { username: 'bob', team: 'payments', role: 'member', password: 'strong-user-pass-01' }, { cost: TEST_COST })
}

const lastLog = (h, action) => h.db().prepare('SELECT * FROM write_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action)
test('POST /tokens 接受 owner/team/visibility：落库、响应、列表三处一致', async () => {
  await withHubW(async (h) => {
    seedUsers(h.home)
    const c = await loggedIn(h)
    const r = await c.wpost('/admin/api/tokens', { name: 'alice-claude', scopes: ['read', 'write'], owner: 'alice', visibility: 'private' })
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
    assert.deepEqual({ status: badOwner.status, error: badOwner.json.error, message: badOwner.json.message }, { status: 400, error: 'unknown_owner', message: '归属人必须是已存在且未停用的账号：alice liang' })
  }, { seed: false })
})

test('PATCH /tokens 改归属人时团队跟着账号走；单独改团队被拒；写审计', async () => {
  await withHubW(async (h) => {
    seedUsers(h.home)
    const c = await loggedIn(h)
    await c.wpost('/admin/api/tokens', { name: 'movable', scopes: ['read'], owner: 'alice' })
    const tokenId = listTokens(h.home).find((t) => t.name === 'movable').tokenId
    const teamOnly = await c.patch('/admin/api/tokens', { tokenId, team: 'payments' })
    assert.deepEqual({ status: teamOnly.status, error: teamOnly.json.error, message: teamOnly.json.message }, { status: 400, error: 'team_follows_owner', message: '令牌的团队跟着归属人走，不能单独修改；要换团队请改归属人，或在「用户」页改这个人的团队' })
    const r = await c.patch('/admin/api/tokens', { tokenId, owner: 'bob', visibility: 'public' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.changed.sort(), ['owner', 'team', 'visibility'])
    assert.deepEqual(listTokens(h.home).map((t) => [t.owner, t.team, t.defaultVisibility]), [['bob', 'payments', 'public']])
    const log = h.db().prepare("SELECT * FROM write_log WHERE action = 'token_update' ORDER BY id DESC LIMIT 1").get()
    assert.equal(log.outcome, 'ok')
  }, { seed: false })
})

test('PATCH /tokens 只给归属字段也算"有要改的字段"', async () => {
  await withHubW(async (h) => {
    seedUsers(h.home)
    const c = await loggedIn(h)
    await c.wpost('/admin/api/tokens', { name: 'only-scope', scopes: ['read'] })
    const tokenId = listTokens(h.home).find((t) => t.name === 'only-scope').tokenId
    const r = await c.patch('/admin/api/tokens', { tokenId, owner: 'bob' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.changed.sort(), ['owner', 'team'])
    const empty = await c.patch('/admin/api/tokens', { tokenId })
    assert.equal(empty.status, 400)
    assert.match(empty.json.message, /没有要修改的字段/)
  }, { seed: false })
})

test('给一个人换团队：他名下有效令牌的团队同步跟着变（已撤销的不动，别人的不动）', async () => {
  await withHubW(async (h) => {
    seedUsers(h.home)
    const c = await loggedIn(h)
    await c.wpost('/admin/api/tokens', { name: 'alice-a', scopes: ['read'], owner: 'alice' })
    await c.wpost('/admin/api/tokens', { name: 'alice-old', scopes: ['read'], owner: 'alice' })
    await c.wpost('/admin/api/tokens', { name: 'bob-a', scopes: ['read'], owner: 'bob' })
    await c.del('/admin/api/tokens?tokenId=' + listTokens(h.home).find((t) => t.name === 'alice-old').tokenId)
    const r = await c.patch('/admin/api/users', { username: 'alice', team: 'PayTool' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(
      listTokens(h.home).map((t) => [t.name, t.team]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      [['alice-a', 'PayTool'], ['alice-old', 'remittance'], ['bob-a', 'payments']],
    )
    // 直接调 updateUser（CLI 走这条）也同步
    updateUser(h.home, 'bob', { team: 'ops' })
    assert.equal(listTokens(h.home).find((t) => t.name === 'bob-a').team, 'ops')
  }, { seed: false })
})
