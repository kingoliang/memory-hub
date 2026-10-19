// 管理界面账号：建 / 改 / 停用 / 认证；会话绑定用户；停用即踢下线。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpHome, rmrf } from '../helpers.mjs'
import { getDb, closeAllDb } from '../../src/core/db.js'
import { TEST_COST } from './admin-helpers.mjs'
import { createUser, listUsers, updateUser, setUserPassword, disableUser, enableUser, authenticateUser, UserError } from '../../src/admin/users.js'
import { createSession, lookupSession } from '../../src/admin/auth.js'

const PW = 'alice-strong-pass-1'
async function withRoot(fn) {
  const home = tmpHome()
  try { return await fn(home) } finally { closeAllDb(); rmrf(home) }
}

test('schema v4：admin_users 表与 admin_sessions.user_id 列', async () => {
  await withRoot(async (home) => {
    const db = getDb(home)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
    assert.deepEqual(cols('admin_users'), ['id', 'username', 'team', 'role', 'password_hash', 'created_at', 'updated_at', 'disabled_at', 'last_login_at'])
    assert.equal(cols('admin_sessions').includes('user_id'), true)
  })
})

test('createUser / listUsers：不返回口令哈希；用户名转小写', async () => {
  await withRoot(async (home) => {
    createUser(home, { username: 'Alice', team: 'remittance', role: 'member', password: PW }, { cost: TEST_COST })
    createUser(home, { username: 'lena', team: 'remittance', role: 'lead', password: PW }, { cost: TEST_COST })
    const rows = listUsers(home)
    assert.deepEqual(rows.map((u) => [u.username, u.team, u.role, u.disabled]), [['alice', 'remittance', 'member', false], ['lena', 'remittance', 'lead', false]])
    assert.deepEqual(Object.keys(rows[0]).sort(), ['createdAt', 'disabled', 'disabledAt', 'id', 'lastLoginAt', 'role', 'team', 'updatedAt', 'username'])
  })
})

test('createUser 校验：重名 409、非法用户名 / 角色 / 弱口令 400，消息写死', async () => {
  await withRoot(async (home) => {
    createUser(home, { username: 'alice', team: 'remittance', role: 'member', password: PW }, { cost: TEST_COST })
    const kind = (fn) => { try { fn(); return 'ok' } catch (e) { return e instanceof UserError ? `${e.kind}:${e.message}` : String(e) } }
    assert.deepEqual([
      kind(() => createUser(home, { username: 'alice', team: 'x', role: 'member', password: PW }, { cost: TEST_COST })),
      kind(() => createUser(home, { username: 'a b', team: 'x', role: 'member', password: PW }, { cost: TEST_COST })),
      kind(() => createUser(home, { username: 'bob', team: 'x', role: 'root', password: PW }, { cost: TEST_COST })),
      kind(() => createUser(home, { username: 'bob', team: 'x', role: 'member', password: 'short' }, { cost: TEST_COST })),
      kind(() => createUser(home, { username: 'admin', team: 'x', role: 'member', password: PW }, { cost: TEST_COST })),
    ], [
      'conflict:用户名已存在：alice',
      'bad_request:用户名只能含字母数字与 . _ -，以字母或数字开头，最长 64 字符',
      'bad_request:role 只能是 member / lead / admin',
      'bad_request:口令至少 10 个字符',
      'bad_request:admin 是保留用户名（应急入口专用）',
    ])
  })
})

test('authenticateUser：正确口令通过并更新 last_login；错口令 / 不存在 / 已停用都失败', async () => {
  await withRoot(async (home) => {
    createUser(home, { username: 'alice', team: 'remittance', role: 'member', password: PW }, { cost: TEST_COST })
    const ok = await authenticateUser(home, 'Alice', PW)
    assert.deepEqual(ok && { id: typeof ok.id, username: ok.username, team: ok.team, role: ok.role }, { id: 'number', username: 'alice', team: 'remittance', role: 'member' })
    assert.equal(typeof listUsers(home)[0].lastLoginAt, 'string')
    assert.deepEqual([await authenticateUser(home, 'alice', 'wrong-password-xx'), await authenticateUser(home, 'nobody', PW)], [null, null])
    disableUser(home, 'alice')
    assert.equal(await authenticateUser(home, 'alice', PW), null)
  })
})

test('会话绑定用户：lookupSession 带出 user；停用用户 → 其全部会话立即失效', async () => {
  await withRoot(async (home) => {
    const u = createUser(home, { username: 'alice', team: 'remittance', role: 'member', password: PW }, { cost: TEST_COST })
    const s = createSession(home, Date.now(), u.id)
    assert.deepEqual(lookupSession(home, s.sid).user, { id: u.id, username: 'alice', team: 'remittance', role: 'member', breakGlass: false })
    const glass = createSession(home)
    assert.deepEqual(lookupSession(home, glass.sid).user, { id: null, username: 'admin', team: '', role: 'admin', breakGlass: true })
    disableUser(home, 'alice')
    assert.equal(lookupSession(home, s.sid), null)
    assert.equal(lookupSession(home, glass.sid) !== null, true)
  })
})

test('改角色 / 团队 / 口令：会话里的身份随之更新；改口令踢掉该用户的会话', async () => {
  await withRoot(async (home) => {
    const u = createUser(home, { username: 'alice', team: 'remittance', role: 'member', password: PW }, { cost: TEST_COST })
    const s = createSession(home, Date.now(), u.id)
    updateUser(home, 'alice', { role: 'lead', team: 'payments' })
    assert.deepEqual(lookupSession(home, s.sid).user, { id: u.id, username: 'alice', team: 'payments', role: 'lead', breakGlass: false })
    setUserPassword(home, 'alice', 'another-strong-pass-2', { cost: TEST_COST })
    assert.equal(lookupSession(home, s.sid), null)
    assert.notEqual(await authenticateUser(home, 'alice', 'another-strong-pass-2'), null)
    enableUser(home, 'alice')
    assert.deepEqual(listUsers(home).map((x) => [x.username, x.disabled]), [['alice', false]])
  })
})

test('CLI user create/list/set-role/disable：口令只从 stdin 读，命令行带口令直接拒绝', async () => {
  const { spawnSync } = await import('node:child_process')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../bin/memory-hub.mjs')
  await withRoot(async (home) => {
    const env = { PATH: process.env.PATH, MEMORY_HUB_HOME: home }
    const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env, timeout: 30000 })
    const made = run(['user', 'create', '--username', 'Alice', '--team', 'remittance', '--role', 'lead'], 'alice-strong-pass-1\n')
    assert.equal(made.status, 0, made.stderr)
    assert.equal(made.stdout, '已创建：alice（团队 remittance，角色 lead）\n')
    assert.equal(run(['user', 'create', '--username', 'bob', '--password', 'x'], '').status, 1)
    assert.equal(run(['user', 'set-role', 'alice', 'member']).stdout, 'alice：已修改\n')
    assert.equal(run(['user', 'disable', 'alice']).stdout, 'alice：已停用并踢下线\n')
    const list = JSON.parse(run(['user', 'list', '--json']).stdout)
    assert.deepEqual(list.map((u) => [u.username, u.team, u.role, u.disabled]), [['alice', 'remittance', 'member', true]])
    assert.equal(JSON.stringify(list).includes('alice-strong-pass-1'), false)
  })
})
