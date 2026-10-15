// 蒸馏 LLM：通用 OpenAI 兼容端点（本地 mock），未配置 / 失败时降级为原文卡；key 不泄露
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rpc, toolText, durableText, startMockLlm } from './helpers.mjs'
import { withHub } from './hub-helpers.mjs'

const KEY = 'mock-key-xyz-0123456789'
const capture = (h, tok, text, args = {}) => rpc(h.url, tok, 'tools/call', { name: 'memory_capture', arguments: { text, ...args } })

function assertNoKeyLeak(h, resp) {
  const dump = [resp?.raw ?? '', h.logs.text(), JSON.stringify(h.db().prepare('SELECT * FROM write_log').all()), JSON.stringify(h.db().prepare('SELECT * FROM quarantine').all()), JSON.stringify(h.db().prepare('SELECT * FROM cards').all())].join('\n')
  assert.ok(!dump.includes(KEY), 'LLM key 泄露到了响应 / 日志 / 库')
}

test('未配置 LLM：降级为原文卡（content / raw），结果标记 degraded', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['write'])
    const out = JSON.parse(toolText(await capture(h, tok, durableText('降级路径'))))
    assert.equal(out.ok, true)
    assert.equal(out.action, 'created')
    assert.equal(out.degraded, true)
    const row = h.db().prepare('SELECT kind, tags FROM quarantine WHERE path = ?').get(out.path)
    assert.equal(row.kind, 'content')
    assert.deepEqual(JSON.parse(row.tags), ['raw'])
  })
})

test('配置 mock LLM：走蒸馏，卡片来自模型输出；请求带 Bearer key 与配置的模型名', async () => {
  const llm = await startMockLlm(JSON.stringify({ save: true, title: '配置方案决策', kind: 'tool', tags: ['config'], body: '# 配置方案决策\n\n- 采用环境变量加配置文件\n- 原因：部署时无需改代码' }))
  try {
    await withHub(async (h) => {
      const tok = h.token('a', ['write'])
      const r = await capture(h, tok, durableText('蒸馏路径'))
      const out = JSON.parse(toolText(r))
      assert.equal(out.ok, true)
      assert.equal(out.action, 'created')
      assert.ok(!out.degraded)
      const row = h.db().prepare('SELECT kind, title, submitted_by FROM quarantine WHERE path = ?').get(out.path)
      assert.equal(row.kind, 'tool')
      assert.equal(row.title, '配置方案决策')
      assert.equal(row.submitted_by, 'a')
      assert.equal(llm.seen.length, 1)
      assert.equal(llm.seen[0].url, '/v1/chat/completions')
      assert.equal(llm.seen[0].auth, `Bearer ${KEY}`)
      assert.equal(llm.seen[0].body.model, 'mock-model')
      assertNoKeyLeak(h, r)
    }, { env: { MEMORY_LLM_BASE_URL: llm.baseUrl, MEMORY_LLM_MODEL: 'mock-model', MEMORY_LLM_KEY: KEY } })
  } finally { await llm.close() }
})

test('模型判定不值得保存 → skipped（带原因），不落库', async () => {
  const llm = await startMockLlm('{"save": false}')
  try {
    await withHub(async (h) => {
      const tok = h.token('a', ['write'])
      const out = JSON.parse(toolText(await capture(h, tok, durableText('不值得'))))
      assert.equal(out.ok, true)
      assert.equal(out.action, 'skipped')
      assert.ok(out.reason)
      assert.equal(h.db().prepare('SELECT COUNT(*) n FROM quarantine').get().n, 0)
    }, { env: { MEMORY_LLM_BASE_URL: llm.baseUrl, MEMORY_LLM_MODEL: 'mock-model', MEMORY_LLM_KEY: KEY } })
  } finally { await llm.close() }
})

test('模型输出无法解析 / 端点不可达：降级为原文卡，不丢沉淀；日志有 WARN 且不含 key', async () => {
  const bad = await startMockLlm('这不是 JSON')
  try {
    await withHub(async (h) => {
      const tok = h.token('a', ['write'])
      const r = await capture(h, tok, durableText('模型乱输出'))
      const out = JSON.parse(toolText(r))
      assert.equal(out.action, 'created')
      assert.equal(out.degraded, true)
      assert.ok(h.logs.lines().map((l) => JSON.parse(l)).some((l) => l.level === 'WARN' && /蒸馏|distill/i.test(l.msg)))
      assertNoKeyLeak(h, r)
    }, { env: { MEMORY_LLM_BASE_URL: bad.baseUrl, MEMORY_LLM_MODEL: 'mock-model', MEMORY_LLM_KEY: KEY } })
  } finally { await bad.close() }

  await withHub(async (h) => {
    const tok = h.token('a', ['write'])
    const r = await capture(h, tok, durableText('端点不可达'))
    const out = JSON.parse(toolText(r))
    assert.equal(out.action, 'created')
    assert.equal(out.degraded, true)
    assertNoKeyLeak(h, r)
  }, { env: { MEMORY_LLM_BASE_URL: 'http://127.0.0.1:9/v1', MEMORY_LLM_MODEL: 'mock-model', MEMORY_LLM_KEY: KEY } })
})

test('上游 401 的错误体带有掩码/回显的 key 片段 → 降级为原文卡，且日志 / 响应 / 库里不得出现这些片段', async () => {
  const http = await import('node:http')
  const MASKED = '****ZQ9d'
  const srv = http.createServer((req, res) => {
    req.resume()
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: { message: `Authentication Fails, Your api key: ${MASKED} is invalid; got ${KEY}`, type: 'authentication_error' } }))
  }).listen(0, '127.0.0.1')
  await new Promise((r) => srv.on('listening', r))
  try {
    await withHub(async (h) => {
      const tok = h.token('a', ['write'])
      const r = await capture(h, tok, durableText('上游401'))
      const out = JSON.parse(toolText(r))
      assert.equal(out.degraded, true)
      const dump = [r.raw, h.logs.text(), JSON.stringify(h.db().prepare('SELECT * FROM write_log').all())].join('\n')
      assert.ok(h.logs.text().includes('蒸馏调用异常'), '应有降级告警日志')
      assert.ok(!dump.includes(MASKED), '上游掩码 key 片段不得进日志 / 响应')
      assert.ok(!dump.includes(KEY), '回显的 key 不得进日志 / 响应')
    }, { env: { MEMORY_LLM_BASE_URL: `http://127.0.0.1:${srv.address().port}/v1`, MEMORY_LLM_MODEL: 'm', MEMORY_LLM_KEY: KEY } })
  } finally { await new Promise((r) => srv.close(r)) }
})
