// 设置页接口：GET/PATCH /admin/api/settings（审核规则可改；其余只读且脱敏）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHubW, loggedIn, lastLog } from './write-helpers.mjs'
import { enforceAudit } from '../../src/core/db.js'

const cfgRows = (h) => h.db().prepare("SELECT key, value FROM config WHERE key LIKE 'audit%' ORDER BY key").all()

test('未登录 / 仅 Agent 令牌：GET 与 PATCH 都是 401；缺 CSRF 的 PATCH 是 403', async () => {
  await withHubW(async (h) => {
    const anon = h.client()
    assert.equal((await anon.get('/admin/api/settings')).status, 401)
    assert.equal((await anon.req('PATCH', '/admin/api/settings', { body: { auditMode: 'none' } })).status, 401)
    const tok = h.token('settings-agent', ['read', 'write'])
    assert.equal((await anon.get('/admin/api/settings', { headers: { authorization: `Bearer ${tok}` } })).status, 401)
    const c = await loggedIn(h)
    const noCsrf = await c.req('PATCH', '/admin/api/settings', { body: { auditMode: 'none' } })
    assert.equal(noCsrf.status, 403)
    assert.deepEqual(cfgRows(h), [])
  })
})

test('GET：返回审核规则与只读项；不含密钥、令牌、服务器绝对路径', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const r = await c.get('/admin/api/settings')
    assert.equal(r.status, 200)
    assert.equal(r.json.audit.mode, null)
    assert.deepEqual(r.json.audit.exemptAgents, [])
    assert.ok(r.json.options.kinds.includes('knowledge'))
    assert.ok(r.json.options.agents.includes('claude-code-a'))
    assert.equal(r.json.readonly.recycle.retentionDays, 30)
    assert.equal(r.json.readonly.dedup.threshold, 0.62)
    assert.equal(r.json.readonly.llm.configured, false)
    assert.ok(!r.text.includes(h.home), '不得出现 home 绝对路径')
    assert.ok(!/memory-eternal\.db|memory-hub\.json/.test(r.text), '不得出现库文件/配置文件路径')
  })
})

test('GET 配置了 LLM：只给 model / 主机名 / keySet，不含 key、URL 凭据与路径', async () => {
  const key = 'sk-' + 'ZZtestkeyNOTREAL1234567890abcdef'
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const r = await c.get('/admin/api/settings')
    assert.deepEqual({ ...r.json.readonly.llm, timeoutMs: undefined, reasoningEffort: undefined }, { configured: true, model: 'm-1', baseHost: 'llm.example.test', keySet: true, reasoningEffort: undefined, timeoutMs: undefined })
    for (const needle of [key, 'pw-in-url', 'secretpath', h.home]) assert.ok(!r.text.includes(needle), `响应不得含 ${needle.slice(0, 6)}…`)
  }, { env: { MEMORY_LLM_BASE_URL: 'https://user:pw-in-url@llm.example.test/v1/secretpath', MEMORY_LLM_MODEL: 'm-1', MEMORY_LLM_KEY: key } })
})

test('PATCH：写入审核规则，立即影响 enforceAudit，并写 write_log（不含署名明细之外的内容）', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const r = await c.patch('/admin/api/settings', { auditMode: 'all', auditExemptAgents: ['trusted-a', 'trusted-a', 'bot@x'], auditExemptKinds: ['tool'] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.changed, ['auditMode', 'auditExemptAgents', 'auditExemptKinds'])
    assert.equal(r.json.audit.mode, 'all')
    assert.deepEqual(r.json.audit.exemptAgents, ['trusted-a', 'bot@x'])
    assert.equal(enforceAudit(h.home, 'knowledge', 'trusted-a'), 'approved')
    assert.equal(enforceAudit(h.home, 'knowledge', 'stranger'), 'pending')
    assert.equal(enforceAudit(h.home, 'tool', 'stranger'), 'approved')
    assert.equal((await c.get('/admin/api/settings')).json.audit.mode, 'all')
    const wl = lastLog(h, 'settings_update')
    assert.equal(wl.actor_type, 'admin'); assert.equal(wl.outcome, 'ok'); assert.equal(wl.tool, 'PATCH /settings')
    // 同值再次提交：无变更、不新增日志
    const n = h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='settings_update'").get().n
    const again = await c.patch('/admin/api/settings', { auditMode: 'all' })
    assert.deepEqual(again.json.changed, [])
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='settings_update'").get().n, n)
    // 切到 none：全部免审
    await c.patch('/admin/api/settings', { auditMode: 'none' })
    assert.equal(enforceAudit(h.home, 'knowledge', 'stranger'), 'approved')
    assert.ok(h.logs.text().includes('管理员修改审核设置'))
  })
})

test('PATCH 校验：非法值 / 未知字段 / 空请求 / 超限 一律 400 且库不变', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const many = Array.from({ length: 51 }, (_, i) => `a${i}`)
    const cases = [
      {}, { auditMode: 'maybe' }, { auditMode: 1 }, { auditMode: null }, { auditExemptAgents: 'x' }, { auditExemptAgents: ['bad name!'] }, { auditExemptAgents: [''] }, { auditExemptAgents: [1] },
      { auditExemptAgents: ['x'.repeat(65)] }, { auditExemptAgents: many }, { auditExemptKinds: ['nope'] }, { auditExemptKinds: 'tool' },
      { auditMode: 'all', dedupThreshold: 0.1 }, { llm: { key: 'x' } }, { retentionDays: 5 },
    ]
    for (const body of cases) {
      const r = await c.patch('/admin/api/settings', body)
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80))
    }
    const arr = await c.req('PATCH', '/admin/api/settings', { body: [1], withCsrf: true })
    assert.equal(arr.status, 400)
    assert.deepEqual(cfgRows(h), [])
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='settings_update'").get().n, 0)
  })
})

test('只读模式：PATCH /settings 403 read_only，GET 仍可用', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const r = await c.patch('/admin/api/settings', { auditMode: 'none' })
    assert.equal(r.status, 403); assert.equal(r.json.error, 'read_only')
    assert.equal((await c.get('/admin/api/settings')).status, 200)
    assert.deepEqual(cfgRows(h), [])
  }, { env: { MEMORY_HUB_ADMIN_READONLY: '1' } })
})
