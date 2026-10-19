// 管理界面 RBAC 纯函数：角色、可见性、可编辑、可审批、令牌归属。
//
// 期望值全部写死（playbook 坑七）。这里锁的是「权限语义」本身，接口层的越权矩阵在 rbac-matrix.test.mjs。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROLES, isRole, BREAK_GLASS, principalOf, isAdmin,
  canSeeCard, canEditCard, canModerateCard, canManageToken, tokenScopeFor, roleAllows,
} from '../../src/admin/rbac.js'

const ALICE = principalOf({ id: 1, username: 'alice', team: 'remittance', role: 'member' })
const LEAD = principalOf({ id: 2, username: 'lena', team: 'remittance', role: 'lead' })
const ROOT = principalOf({ id: 3, username: 'root', team: 'ops', role: 'admin' })
const card = (owner, team, visibility, status = 'approved') => ({ owner, team, visibility, status })

test('角色常量是完整集合，顺序即权限高低', () => {
  assert.deepEqual(ROLES, ['member', 'lead', 'admin'])
  assert.deepEqual(['member', 'lead', 'admin', 'Admin', '', null].map(isRole), [true, true, true, false, false, false])
})

test('应急入口（原管理员口令）是超级管理员，用户名固定为 admin', () => {
  assert.deepEqual(BREAK_GLASS, { id: null, username: 'admin', team: '', role: 'admin', breakGlass: true })
  assert.equal(isAdmin(BREAK_GLASS), true)
  assert.equal(isAdmin(ALICE), false)
  assert.equal(isAdmin(LEAD), false)
})

test('principalOf：只取需要的字段；非法角色降为 member（宁可少权限）', () => {
  assert.deepEqual(principalOf({ id: 9, username: 'x', team: 't', role: 'superuser', password_hash: 'h' }),
    { id: 9, username: 'x', team: 't', role: 'member', breakGlass: false })
})

test('roleAllows：路由声明的角色集合', () => {
  assert.deepEqual(
    [roleAllows(ALICE, ['member', 'lead', 'admin']), roleAllows(ALICE, ['admin']), roleAllows(LEAD, ['lead', 'admin']), roleAllows(ROOT, ['admin'])],
    [true, false, true, true],
  )
})

test('canSeeCard：成员 = MCP 同一套规则；待审卡只看自己的；管理员看全部', () => {
  const cases = [
    card('alice', 'remittance', 'private'),
    card('bob', 'remittance', 'team'),
    card('bob', 'remittance', 'private'),
    card('carol', 'payments', 'public'),
    card('carol', 'payments', 'team'),
    card('alice', 'remittance', 'team', 'pending'),
    card('bob', 'remittance', 'team', 'pending'),
  ]
  assert.deepEqual(cases.map((c) => canSeeCard(ALICE, c)), [true, true, false, true, false, true, false])
  // 团队管理员能看本团队的待审卡（要审它），其余与成员相同
  assert.deepEqual(cases.map((c) => canSeeCard(LEAD, c)), [false, true, false, true, false, true, true])
  assert.deepEqual(cases.map((c) => canSeeCard(ROOT, c)), [true, true, true, true, true, true, true])
})

test('canEditCard：成员只能改自己的；团队管理员加本团队；管理员全部；看不见的一定改不了', () => {
  const cases = [
    card('alice', 'remittance', 'private'),
    card('bob', 'remittance', 'team'),
    card('bob', 'remittance', 'private'),
    card('carol', 'payments', 'public'),
  ]
  assert.deepEqual(cases.map((c) => canEditCard(ALICE, c)), [true, false, false, false])
  assert.deepEqual(cases.map((c) => canEditCard(LEAD, c)), [false, true, false, false])
  assert.deepEqual(cases.map((c) => canEditCard(ROOT, c)), [true, true, true, true])
})

test('canModerateCard：只有团队管理员（本团队）与管理员能审批', () => {
  const pend = (owner, team) => card(owner, team, 'team', 'pending')
  assert.deepEqual(
    [canModerateCard(ALICE, pend('alice', 'remittance')), canModerateCard(LEAD, pend('bob', 'remittance')), canModerateCard(LEAD, pend('carol', 'payments')), canModerateCard(ROOT, pend('carol', 'payments'))],
    [false, true, false, true],
  )
})

test('令牌：非管理员只能管自己的，且新建时 owner/team 强制为本人', () => {
  const mine = { owner: 'alice', team: 'remittance' }
  const others = { owner: 'bob', team: 'remittance' }
  assert.deepEqual([canManageToken(ALICE, mine), canManageToken(ALICE, others), canManageToken(LEAD, others), canManageToken(ROOT, others)], [true, false, false, true])
  assert.deepEqual(tokenScopeFor(ALICE, { owner: 'bob', team: 'payments' }), { owner: 'alice', team: 'remittance' })
  assert.deepEqual(tokenScopeFor(ROOT, { owner: 'bob', team: 'payments' }), { owner: 'bob', team: 'payments' })
})
