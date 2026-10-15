// M3 顺手修复：401 说明 / 失败限流不重复计数 / HTTP 隐藏服务器绝对路径 / recall 空结果也写 write_log（设计选择）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { rpc, toolText, MCP_HEADERS } from './helpers.mjs'
import { withHub } from './hub-helpers.mjs'
import { writeCard } from '../src/core/vault.js'
import { AUTH_FAIL_LIMIT } from '../src/server.js'

const post = (url, headers = {}, method = 'POST') => fetch(url + '/mcp', { method, headers: { ...MCP_HEADERS, ...headers }, body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined })

test('a. 无令牌：401 + 规范 WWW-Authenticate + 清晰 JSON 错误信息', async () => {
  await withHub(async (h) => {
    const res = await post(h.url)
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="memory-hub"')
    assert.match(res.headers.get('content-type') || '', /application\/json/)
    const j = await res.json()
    assert.equal(j.error, 'unauthorized')
    assert.match(j.message, /需要 Bearer 令牌/)
    assert.ok(!/mh_/.test(JSON.stringify(j)))
  })
})

test('a. 无效令牌：401 + invalid_token，信息不泄露原因细节；OAuth 发现路径返回清晰 JSON 404（不做 OAuth）', async () => {
  await withHub(async (h) => {
    const res = await post(h.url, { authorization: 'Bearer mh_abc_zzzzzzzzzzzzzzzzzzzzzzzz' })
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate') || '', /^Bearer realm="memory-hub", error="invalid_token"/)
    const j = await res.json()
    assert.match(j.message, /令牌无效/)
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/register', '/authorize', '/token']) {
      const r = await fetch(h.url + p, { method: p === '/register' ? 'POST' : 'GET' })
      assert.equal(r.status, 404, p)
      const j = await r.json()
      assert.equal(j.error, 'not found')
      assert.match(j.message, /不支持 OAuth.*Bearer/, p)
    }
  })
})

test('b. 没带凭据的探测请求不算失败：连发远超阈值也不触发 429，也不会让带正确令牌的同机客户端被挡', async () => {
  await withHub(async (h) => {
    const good = h.token('ok-agent', ['read'])
    for (let i = 0; i < AUTH_FAIL_LIMIT * 3; i++) assert.equal((await post(h.url)).status, 401)
    for (let i = 0; i < AUTH_FAIL_LIMIT * 2; i++) assert.equal((await post(h.url, {}, 'GET')).status, 401)
    assert.equal((await rpc(h.url, good, 'tools/list')).status, 200)
  })
})

test('b. 一次错误令牌只计一次失败：阈值-1 次后仍可用，第 阈值 次后才被限流；限流期间同机其它来源规则不变', async () => {
  await withHub(async (h) => {
    const good = h.token('ok-agent', ['read'])
    for (let i = 0; i < AUTH_FAIL_LIMIT - 1; i++) assert.equal((await rpc(h.url, 'mh_bad_token', 'tools/list')).status, 401, `第 ${i + 1} 次`)
    assert.equal((await rpc(h.url, good, 'tools/list')).status, 200, '阈值-1 次失败后正确令牌仍可用')
    assert.equal((await rpc(h.url, 'mh_bad_token', 'tools/list')).status, 401, '第 阈值 次失败仍返回 401')
    assert.equal((await rpc(h.url, 'mh_bad_token', 'tools/list')).status, 429, '之后被限流')
    // 日志：每个失败请求只有一条鉴权失败日志
    const fails = h.logs.lines().filter((l) => l.includes('鉴权失败') && !l.includes('过多'))
    assert.equal(fails.length, AUTH_FAIL_LIMIT)
  })
})

test('c. HTTP 下 memory_stats / memory_audit_list 不泄露服务器绝对路径；数据本身不变', async () => {
  await withHub(async (h) => {
    await writeCard(h.home, { kind: 'knowledge', title: '数据库选型决策', body: '选择 SQLite 作为本地存储，原因是零依赖。', status: 'approved', submittedBy: 'fx' }, { dedup: false })
    await writeCard(h.home, { kind: 'knowledge', title: '待审的卡', body: '这张卡还没有被批准的正文内容', status: 'pending', submittedBy: 'fx' }, { dedup: false })
    const tok = h.token('http-agent', ['read'])
    const c = new Client({ name: 'http-test', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(h.url + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }))
    try {
      const stats = (await c.callTool({ name: 'memory_stats', arguments: {} })).content.map((x) => x.text).join('')
      const audit = (await c.callTool({ name: 'memory_audit_list', arguments: {} })).content.map((x) => x.text).join('')
      for (const t of [stats, audit]) {
        assert.ok(!t.includes(h.home), '不得含数据目录绝对路径')
        assert.ok(!t.includes(h.config.dbRoot))
        assert.ok(!/\/(?:private|tmp|var|Users|home)\//.test(t), '不得含任何绝对路径片段：' + t.slice(0, 200))
      }
      const s = JSON.parse(stats)
      assert.equal(s.total, 1)
      assert.equal(s.vaultDir, '<data-dir>')
      assert.match(audit, /vault: <data-dir>/)
    } finally { await c.close() }
  })
})

test('d. recall 空结果也写 write_log（设计选择：审计所有读）', async () => {
  await withHub(async (h) => {
    const tok = h.token('reader', ['read'])
    const r = await rpc(h.url, tok, 'tools/call', { name: 'memory_recall', arguments: { query: '完全不存在的词xyz' } })
    assert.match(toolText(r), /没有与/)
    const rows = h.db().prepare("SELECT * FROM write_log WHERE tool = 'memory_recall'").all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'read')
    assert.equal(rows[0].outcome, 'ok')
  })
})
