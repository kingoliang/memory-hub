// 令牌归属人从账号列表里选：服务端只接受已存在且未停用的账号，团队取账号的团队；owner 一律小写。
// 事故背景见 docs/decisions/2026-10-19-token-owner-from-user-list.md（账号 guoyouma vs 令牌 GuoyouMa）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHubW, loggedIn } from './write-helpers.mjs'
import { TEST_COST } from '../admin/admin-helpers.mjs'
import { createUser, disableUser } from '../../src/admin/users.js'
import { createToken, listTokens, validateParty } from '../../src/auth/tokens.js'

const UPW = 'strong-user-pass-01'
const seedUsers = (home) => {
  createUser(home, { username: 'guoyouma', team: 'PayTool', role: 'lead', password: UPW }, { cost: TEST_COST })
  createUser(home, { username: 'mia', team: 'remittance', role: 'member', password: UPW }, { cost: TEST_COST })
  createUser(home, { username: 'gone', team: 'old', role: 'member', password: UPW }, { cost: TEST_COST })
  disableUser(home, 'gone')
}

test('GET /users/options：只列未停用账号，字段只有 username/team/role', async () => {
  await withHubW(async (h) => {
    seedUsers(h.home)
    const c = await loggedIn(h)
    const r = await c.get('/admin/api/users/options')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.items, [
      { username: 'guoyouma', team: 'PayTool', role: 'lead' },
      { username: 'mia', team: 'remittance', role: 'member' },
    ])
  }, { seed: false })
})

test('管理员建令牌：owner 必须是已存在账号；团队强制取账号的团队；大小写自动规范', async () => {
  await withHubW(async (h) => {
    seedUsers(h.home)
    const c = await loggedIn(h)
    const ok = await c.wpost('/admin/api/tokens', { name: 'gy-claude', scopes: ['read', 'write'], owner: 'GuoyouMa', team: 'whatever' })
    assert.equal(ok.status, 200, ok.text)
    assert.deepEqual([ok.json.owner, ok.json.team], ['guoyouma', 'PayTool'])

    const ghost = await c.wpost('/admin/api/tokens', { name: 'ghost-tok', scopes: ['read'], owner: 'nobody' })
    assert.deepEqual({ status: ghost.status, error: ghost.json.error, message: ghost.json.message }, { status: 400, error: 'unknown_owner', message: '归属人必须是已存在且未停用的账号：nobody' })

    const disabled = await c.wpost('/admin/api/tokens', { name: 'gone-tok', scopes: ['read'], owner: 'gone' })
    assert.deepEqual({ status: disabled.status, error: disabled.json.error }, { status: 400, error: 'unknown_owner' })

    // 无主令牌（给不属于任何人的自动化脚本）仍允许
    const ownerless = await c.wpost('/admin/api/tokens', { name: 'ci-bot', scopes: ['read'] })
    assert.deepEqual([ownerless.status, ownerless.json.owner, ownerless.json.team], [200, '', ''])
  }, { seed: false })
})

test('管理员改令牌归属：同样只能改成已存在账号，团队跟着账号走', async () => {
  await withHubW(async (h) => {
    seedUsers(h.home)
    const c = await loggedIn(h)
    await c.wpost('/admin/api/tokens', { name: 'gy-claude', scopes: ['read'], owner: 'guoyouma' })
    const id = listTokens(h.home).find((t) => t.name === 'gy-claude').tokenId
    const bad = await c.patch('/admin/api/tokens', { tokenId: id, owner: 'nobody' })
    assert.deepEqual({ status: bad.status, error: bad.json.error }, { status: 400, error: 'unknown_owner' })
    const ok = await c.patch('/admin/api/tokens', { tokenId: id, owner: 'MIA' })
    assert.equal(ok.status, 200, ok.text)
    assert.deepEqual(listTokens(h.home).filter((t) => t.name === 'gy-claude').map((t) => [t.owner, t.team]), [['mia', 'remittance']])
  }, { seed: false })
})

test('validateParty：owner 统一小写，team 保持原样（团队名大小写有意义）', () => {
  assert.deepEqual([validateParty('GuoyouMa', 'owner'), validateParty('PayTool', 'team'), validateParty('', 'owner')], ['guoyouma', 'PayTool', ''])
})

test('CLI / 直接调用 createToken 手填大小写：落库也是小写（与账号对得上）', async () => {
  await withHubW(async (h) => {
    createToken(h.home, { name: 'cli-tok', scopes: 'read', owner: 'GuoyouMa', team: 'PayTool' })
    assert.deepEqual(listTokens(h.home).map((t) => [t.owner, t.team]), [['guoyouma', 'PayTool']])
  }, { seed: false })
})
