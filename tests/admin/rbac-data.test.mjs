// 数据级越权：成员能调的每一个接口，都只能碰到自己可见 / 可改的数据。
//
// 场景（全部写死）：
//   remittance 团队：mia（member）、leo（lead）、bob（member）
//   payments 团队：carl（member）
// 卡片：
//   mia-private   mia 自己的私卡
//   bob-team      bob 的团队卡（mia 能看，不能改；leo 能改）
//   bob-private   bob 的私卡（mia、leo 都看不到）
//   carl-public   其它团队的公开卡（大家都能看，只有 carl 和 admin 能改）
//   carl-team     其它团队的团队卡（remittance 的人都看不到）
//   bob-pending   bob 的待审卡（mia 看不到；leo 能看能审批）
// 令牌：mia、bob 各一枚。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withAdminHub, makeClient, TEST_COST } from './admin-helpers.mjs'
import { createUser } from '../../src/admin/users.js'
import { getDb, closeAllDb } from '../../src/core/db.js'
import { ensureVault, writeCard } from '../../src/core/vault.js'
import { createToken } from '../../src/auth/tokens.js'

const UPW = 'strong-user-pass-01'
const BODY = (t) => `${t} 的正文：数据级越权测试用的合成内容，关键词 越权测试，长度足够避开去重。`

async function seed(home) {
  getDb(home).prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','none')").run()
  await ensureVault(home)
  const put = async (title, owner, team, visibility, status = 'approved') => {
    const r = await writeCard(home, { kind: 'knowledge', title, body: BODY(title), tags: ['越权'], status, submittedBy: owner, owner, team, visibility }, { dedup: false })
    if (!r.ok) throw new Error(JSON.stringify(r))
    return r.path
  }
  const paths = {
    miaPrivate: await put('mia-private', 'mia', 'remittance', 'private'),
    bobTeam: await put('bob-team', 'bob', 'remittance', 'team'),
    bobPrivate: await put('bob-private', 'bob', 'remittance', 'private'),
    carlPublic: await put('carl-public', 'carl', 'payments', 'public'),
    carlTeam: await put('carl-team', 'carl', 'payments', 'team'),
  }
  // 待审卡：auditMode=all 下写入才会进隔离区
  getDb(home).prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','all')").run()
  paths.bobPending = await put('bob-pending', 'bob', 'remittance', 'team', 'pending')
  getDb(home).prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','none')").run()
  for (const [username, team, role] of [['mia', 'remittance', 'member'], ['leo', 'remittance', 'lead'], ['bob', 'remittance', 'member'], ['carl', 'payments', 'member']]) {
    createUser(home, { username, team, role, password: UPW }, { cost: TEST_COST })
  }
  createToken(home, { name: 'mia-claude', scopes: 'read,write', owner: 'mia', team: 'remittance' })
  createToken(home, { name: 'bob-codex', scopes: 'read,write', owner: 'bob', team: 'remittance' })
  closeAllDb()
  return paths
}

async function as(h, username) {
  const c = makeClient(h)
  const r = await c.post('/admin/api/login', { username, password: UPW })
  assert.equal(r.status, 200, r.text)
  const csrf = r.json.csrfToken
  c.w = (method, p, body) => c.req(method, p, { body, headers: { 'x-csrf-token': csrf } })
  return c
}

const titles = (items) => items.map((x) => x.title).sort()
const cardsVisibleTo = async (c, qs = '') => titles((await c.get(`/admin/api/cards?limit=200${qs}`)).json.items)

test('GET /cards：各人只看到可见范围（与 MCP 同一套规则）', async () => {
  await withAdminHub(async (h) => {
    await seed(h.home)
    assert.deepEqual(await cardsVisibleTo(await as(h, 'mia')), ['bob-team', 'carl-public', 'mia-private'])
    assert.deepEqual(await cardsVisibleTo(await as(h, 'carl')), ['carl-public', 'carl-team'])
    // 用过滤参数也绕不过去：直接按 owner=bob 查，bob 的私卡仍不出现
    assert.deepEqual(await cardsVisibleTo(await as(h, 'mia'), '&owner=bob'), ['bob-team'])
    assert.deepEqual(await cardsVisibleTo(await as(h, 'mia'), '&visibility=private'), ['mia-private'])
    // 全文检索同样过滤
    assert.deepEqual(await cardsVisibleTo(await as(h, 'mia'), '&q=' + encodeURIComponent('越权测试')), ['bob-team', 'carl-public', 'mia-private'])
    // 状态切到待审：成员只看到自己的（这里 mia 没有待审卡）
    assert.deepEqual(await cardsVisibleTo(await as(h, 'mia'), '&status=pending'), [])
    assert.deepEqual(await cardsVisibleTo(await as(h, 'leo'), '&status=pending'), ['bob-pending'])
  }, { seed: false })
})

test('GET /card：看不见的卡一律 404（不泄露存在性）', async () => {
  await withAdminHub(async (h) => {
    const p = await seed(h.home)
    const mia = await as(h, 'mia')
    const code = async (path) => (await mia.get('/admin/api/card?path=' + encodeURIComponent(path))).status
    assert.deepEqual(
      [await code(p.miaPrivate), await code(p.bobTeam), await code(p.carlPublic), await code(p.bobPrivate), await code(p.carlTeam), await code(p.bobPending), await code('03-Knowledge/不存在.md')],
      [200, 200, 200, 404, 404, 404, 404],
    )
  }, { seed: false })
})

test('写卡：成员只能改 / 删 / 回滚自己的；看不见的 404，看得见但不是自己的 403', async () => {
  await withAdminHub(async (h) => {
    const p = await seed(h.home)
    const mia = await as(h, 'mia')
    // updatedAt 直接读库（不经接口，避免「取时间戳的人看不见这张卡」干扰被测的权限判断）
    const ts = (path) => getDb(h.home).prepare('SELECT updated_at FROM cards WHERE path = ?').get(path).updated_at
    const edit = async (c, path) => (await c.w('PATCH', '/admin/api/card', { path, expectedUpdatedAt: ts(path), title: '改了标题' })).status
    const del = async (c, path) => (await c.w('DELETE', '/admin/api/card?path=' + encodeURIComponent(path))).status
    const rb = async (c, path) => (await c.w('POST', '/admin/api/card/rollback', { path, expectedUpdatedAt: new Date().toISOString(), revisionId: 1 })).status
    assert.deepEqual([await edit(mia, p.bobTeam), await edit(mia, p.carlPublic), await edit(mia, p.bobPrivate)], [403, 403, 404])
    assert.deepEqual([await del(mia, p.bobTeam), await del(mia, p.carlPublic), await del(mia, p.bobPrivate)], [403, 403, 404])
    assert.deepEqual([await rb(mia, p.bobTeam), await rb(mia, p.bobPrivate)], [403, 404])
    // 团队管理员：能改本团队的 team 卡，改不了其它团队的
    const leo = await as(h, 'leo')
    assert.deepEqual([await edit(leo, p.bobTeam), await edit(leo, p.carlPublic)], [200, 403])
    // 自己的：能改能删
    assert.deepEqual([await edit(mia, p.miaPrivate), await del(mia, p.miaPrivate)], [200, 200])
  }, { seed: false })
})

test('审批：团队管理员只能审本团队的；跨团队的卡不会被批', async () => {
  await withAdminHub(async (h) => {
    const p = await seed(h.home)
    const carl = await as(h, 'carl')
    // carl 是成员，路由级就挡了（403 forbidden_role），这里看团队管理员越团队
    getDb(h.home).prepare("UPDATE admin_users SET role = 'lead' WHERE username = 'carl'").run()
    const r = await carl.w('POST', '/admin/api/queue/approve', { paths: [p.bobPending] })
    // 跨团队的待审卡对 carl 视为不存在：整批没有可操作的卡 → 404（不是 403，不泄露存在性）
    assert.deepEqual({ status: r.status, skipped: r.json.skipped.map((x) => x.reason) }, { status: 404, skipped: ['not_found'] })
    assert.equal(getDb(h.home).prepare('SELECT status FROM quarantine WHERE path = ?').get(p.bobPending).status, 'pending')
    const leo = await as(h, 'leo')
    const ok = await leo.w('POST', '/admin/api/queue/approve', { paths: [p.bobPending] })
    assert.deepEqual({ status: ok.status, affected: ok.json.affected }, { status: 200, affected: 1 })
    assert.equal(getDb(h.home).prepare('SELECT COUNT(*) n FROM quarantine WHERE path = ?').get(p.bobPending).n, 0)
  }, { seed: false })
})

test('图谱 / 蜘蛛 / 标签 / 总览 / facets：都不泄露看不见的卡', async () => {
  await withAdminHub(async (h) => {
    await seed(h.home)
    const mia = await as(h, 'mia')
    const graph = (await mia.get('/admin/api/graph?limit=500')).json
    assert.deepEqual(graph.nodes.map((n) => n.title).sort(), ['bob-team', 'carl-public', 'mia-private'])
    const spider = (await mia.w('POST', '/admin/api/graph/search', { q: '越权测试', limit: 30 })).json
    assert.deepEqual(spider.hits.map((x) => x.title).sort(), ['bob-team', 'carl-public', 'mia-private'])
    const tag = (await mia.get('/admin/api/tags?q=' + encodeURIComponent('越权'))).json.items.find((t) => t.tag === '越权')
    assert.equal(tag.count, 3)
    const facets = (await mia.get('/admin/api/facets')).json
    assert.equal(facets.statuses.find((s) => s.status === 'approved').count, 3)
    assert.deepEqual(facets.statuses.filter((s) => s.status !== 'approved').map((s) => s.count), [0, 0, 0])
    const ov = (await mia.get('/admin/api/overview')).json
    assert.equal(JSON.stringify(ov).includes('bob-private') || JSON.stringify(ov).includes('carl-team'), false)
  }, { seed: false })
})

test('令牌：成员只看到 / 只能撤销自己的；新建的令牌归属强制为本人', async () => {
  await withAdminHub(async (h) => {
    await seed(h.home)
    const mia = await as(h, 'mia')
    assert.deepEqual((await mia.get('/admin/api/tokens')).json.items.map((t) => t.name), ['mia-claude'])
    const bobTok = getDb(h.home).prepare("SELECT token_id FROM agent_tokens WHERE name = 'bob-codex'").get().token_id
    assert.equal((await mia.w('DELETE', '/admin/api/tokens?tokenId=' + bobTok)).status, 404)
    assert.equal((await mia.w('PATCH', '/admin/api/tokens', { tokenId: bobTok, name: 'stolen' })).status, 404)
    const made = await mia.w('POST', '/admin/api/tokens', { name: 'mia-new', scopes: ['read'], owner: 'bob', team: 'payments' })
    assert.equal(made.status, 200, made.text)
    assert.deepEqual([made.json.owner, made.json.team], ['mia', 'remittance'])
    // 成员不能自封 tidy:apply
    assert.equal((await mia.w('POST', '/admin/api/tokens', { name: 'mia-tidy', scopes: ['tidy:apply'] })).status, 403)
  }, { seed: false })
})

test('成员不能批准自己的待审卡（自审漏洞）；团队管理员可以批本团队成员的', async () => {
  await withAdminHub(async (h) => {
    const p = await seed(h.home)
    // bob 是成员，看得见自己的待审卡，但审批路由对成员直接拒绝
    const bob = await as(h, 'bob')
    assert.equal(titles((await bob.get('/admin/api/queue')).json.items).includes('bob-pending'), true)
    const self = await bob.w('POST', '/admin/api/queue/approve', { paths: [p.bobPending] })
    assert.deepEqual({ status: self.status, error: self.json.error }, { status: 403, error: 'forbidden_role' })
    assert.equal(getDb(h.home).prepare('SELECT status FROM quarantine WHERE path = ?').get(p.bobPending).status, 'pending')
  }, { seed: false })
})

test('团队管理员换了团队后，不能审批自己留在旧团队的待审卡（看得见 ≠ 能审批）', async () => {
  await withAdminHub(async (h) => {
    await seed(h.home)
    getDb(h.home).prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','all')").run()
    const r = await writeCard(h.home, { kind: 'knowledge', title: 'leo-old-team-pending', body: BODY('leo-old-team-pending'), status: 'pending', submittedBy: 'leo', owner: 'leo', team: 'payments', visibility: 'team' }, { dedup: false })
    closeAllDb()
    const leo = await as(h, 'leo') // leo 现在是 remittance 的 lead；这张卡属于 payments
    assert.equal(titles((await leo.get('/admin/api/queue')).json.items).includes('leo-old-team-pending'), true)
    const res = await leo.w('POST', '/admin/api/queue/approve', { paths: [r.path] })
    assert.deepEqual({ status: res.status, skipped: res.json.skipped?.map((x) => x.reason) }, { status: 404, skipped: ['not_found'] })
    assert.equal(getDb(h.home).prepare('SELECT status FROM quarantine WHERE path = ?').get(r.path).status, 'pending')
  }, { seed: false })
})
