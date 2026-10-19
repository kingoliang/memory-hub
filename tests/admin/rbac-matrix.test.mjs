// 管理 API 的越权矩阵：三种角色 × 每一个路由。
//
// 这张表是**字面量**（不从 handler 导入）：某个路由悄悄放宽了角色，或新增路由没写进这里，测试都会失败。
// 只断言「角色闸门」这一层：被拒的必须是 403 forbidden_role；放行的不能是 403 forbidden_role
//（放行后业务层可能因参数缺失返回 400/404，那不是本测试关心的）。
// 数据级越权（能不能看到 / 改到别人的卡）在 rbac-data.test.mjs。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withAdminHub, makeClient, TEST_COST } from './admin-helpers.mjs'
import { createUser } from '../../src/admin/users.js'
import { ADMIN_ROUTE_ROLES } from '../../src/admin/handler.js'

const M = ['member', 'lead', 'admin']
const L = ['lead', 'admin']
const A = ['admin']

/** 期望的路由 → 允许的角色。改这里 = 改权限，必须在 code review 里能逐行看清。 */
const EXPECTED = {
  'GET /session': M,
  'POST /logout': M,
  'POST /password': M,
  'GET /overview': M,
  'GET /facets': M,
  'GET /cards': M,
  'GET /card': M,
  'GET /graph': M,
  'POST /graph/search': M,
  'POST /graph/summarize': M,
  'GET /queue': M,
  'GET /tags': M,
  'GET /tokens': M,
  'POST /tokens': M,
  'PATCH /tokens': M,
  'DELETE /tokens': M,
  'PATCH /card': M,
  'DELETE /card': M,
  'POST /card/rollback': M,
  'POST /queue/approve': L,
  'POST /queue/reject': L,
  'GET /recycle': A,
  'POST /card/restore': A,
  'POST /card/purge': A,
  'POST /cards/batch': A,
  'POST /cards/purge': A,
  'GET /tidy/preview': A,
  'POST /tidy/apply': A,
  'GET /tidy/rollbacks': A,
  'POST /tidy/rollback': A,
  'GET /tags/preview': A,
  'POST /tags/rename': A,
  'POST /tags/merge': A,
  'POST /tags/delete': A,
  'GET /lint': A,
  'GET /activity': A,
  'GET /write-log': A,
  'GET /settings': A,
  'PATCH /settings': A,
  'GET /users': A,
  'GET /users/options': A,
  'POST /users': A,
  'PATCH /users': A,
  'POST /users/password': A,
}

test('路由表与期望表完全一致（新增 / 删除路由都必须同步改这里）', () => {
  assert.deepEqual(Object.keys(ADMIN_ROUTE_ROLES).sort(), Object.keys(EXPECTED).sort())
  for (const [k, roles] of Object.entries(EXPECTED)) assert.deepEqual([...ADMIN_ROUTE_ROLES[k]].sort(), [...roles].sort(), k)
})

const UPW = 'strong-user-pass-01'

async function loginAs(h, username) {
  const c = makeClient(h)
  const r = await c.post('/admin/api/login', { username, password: UPW })
  assert.equal(r.status, 200, `${username} 登录失败：${r.text}`)
  c.csrfToken = r.json.csrfToken
  return c
}

test('三种角色 × 全部路由：拒绝的一律 403 forbidden_role，放行的绝不是', async () => {
  await withAdminHub(async (h) => {
    createUser(h.home, { username: 'mia', team: 'remittance', role: 'member', password: UPW }, { cost: TEST_COST })
    createUser(h.home, { username: 'leo', team: 'remittance', role: 'lead', password: UPW }, { cost: TEST_COST })
    createUser(h.home, { username: 'ada', team: 'ops', role: 'admin', password: UPW }, { cost: TEST_COST })
    const clients = { member: await loginAs(h, 'mia'), lead: await loginAs(h, 'leo'), admin: await loginAs(h, 'ada') }

    const mismatches = []
    for (const [key, allowed] of Object.entries(EXPECTED)) {
      if (key === 'POST /logout') continue // 会把会话登出，单独测
      const [method, p] = key.split(' ')
      for (const role of M) {
        const c = clients[role]
        const body = method === 'GET' || method === 'DELETE' ? undefined : {}
        const r = await c.req(method, `/admin/api${p}`, { body, withCsrf: true, headers: { 'x-csrf-token': c.csrfToken } })
        const denied = r.status === 403 && r.json?.error === 'forbidden_role'
        const shouldAllow = allowed.includes(role)
        if (denied === shouldAllow) mismatches.push(`${role} ${key} → ${r.status} ${r.json?.error ?? ''}`)
      }
    }
    assert.deepEqual(mismatches, [])
  }, { seed: false })
})

test('应急入口（原管理员口令，用户名留空）仍可登录且是超级管理员', async () => {
  await withAdminHub(async (h) => {
    const c = makeClient(h)
    const r = await c.login()
    assert.equal(r.status, 200, r.text)
    const s = await c.get('/admin/api/session')
    assert.deepEqual(
      { username: s.json.user.username, role: s.json.user.role, breakGlass: s.json.user.breakGlass },
      { username: 'admin', role: 'admin', breakGlass: true },
    )
    assert.equal((await c.get('/admin/api/users')).status, 200)
  }, { seed: false })
})

test('具名用户登录：错口令 401；停用后无法登录且旧会话立刻 401', async () => {
  await withAdminHub(async (h) => {
    createUser(h.home, { username: 'mia', team: 'remittance', role: 'member', password: UPW }, { cost: TEST_COST })
    const bad = await makeClient(h).post('/admin/api/login', { username: 'mia', password: 'wrong-password-xyz' })
    assert.deepEqual({ status: bad.status, error: bad.json?.error }, { status: 401, error: 'invalid_credentials' })

    const c = await loginAs(h, 'mia')
    assert.equal((await c.get('/admin/api/session')).json.user.username, 'mia')

    const root = makeClient(h); await root.login()
    const off = await root.req('PATCH', '/admin/api/users', { body: { username: 'mia', disabled: true }, withCsrf: true })
    assert.equal(off.status, 200, off.text)
    assert.equal((await c.get('/admin/api/session')).status, 401)
    assert.equal((await makeClient(h).post('/admin/api/login', { username: 'mia', password: UPW })).status, 401)
  }, { seed: false })
})

test('具名用户的口令从不出现在日志与 write_log 里（成功 / 失败 / 改口令 / 管理员重置）', async () => {
  await withAdminHub(async (h) => {
    createUser(h.home, { username: 'mia', team: 'remittance', role: 'member', password: UPW }, { cost: TEST_COST })
    const wrong = 'mia-wrong-SENTINEL-4417'
    const reset = 'mia-reset-SENTINEL-5523'
    const changed = 'mia-changed-SENTINEL-6631'
    await makeClient(h).post('/admin/api/login', { username: 'mia', password: wrong })
    const root = makeClient(h); await root.login()
    assert.equal((await root.req('POST', '/admin/api/users/password', { body: { username: 'mia', password: reset }, withCsrf: true })).status, 200)
    const c = makeClient(h)
    const r = await c.post('/admin/api/login', { username: 'mia', password: reset })
    assert.equal(r.status, 200, r.text)
    const p = await c.req('POST', '/admin/api/password', { body: { oldPassword: reset, newPassword: changed }, headers: { 'x-csrf-token': r.json.csrfToken } })
    assert.equal(p.status, 200, p.text)
    const logs = h.logs.text()
    const wl = JSON.stringify(h.db().prepare('SELECT * FROM write_log').all())
    for (const s of [UPW, wrong, reset, changed]) {
      assert.equal(logs.includes(s), false, `日志含口令 ${s.slice(0, 8)}…`)
      assert.equal(wl.includes(s), false, `write_log 含口令 ${s.slice(0, 8)}…`)
    }
    // 审计里能分清是谁：mia 自己改口令、admin 重置 mia
    assert.deepEqual(
      h.db().prepare("SELECT actor_name, action FROM write_log WHERE action IN ('user_password_reset','password_change') ORDER BY id").all().map((x) => [x.actor_name, x.action]),
      [['admin', 'user_password_reset'], ['mia', 'password_change']],
    )
  }, { seed: false })
})
