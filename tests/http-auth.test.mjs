// HTTP MCP 鉴权 / scope / Origin / 署名 / 审计 / 开关
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rpc, toolText, durableText } from './helpers.mjs'
import { withHub } from './hub-helpers.mjs'
import { writeCard } from '../src/core/vault.js'
import { revokeToken, createToken } from '../src/auth/tokens.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const call = (url, tok, name, args, opts) => rpc(url, tok, 'tools/call', { name, arguments: args }, opts)

test('无令牌 → 401 + WWW-Authenticate: Bearer；/healthz 无需鉴权', async () => {
  await withHub(async (h) => {
    const r = await rpc(h.url, null, 'tools/list')
    assert.equal(r.status, 401)
    assert.match(r.headers.get('www-authenticate') || '', /^Bearer/)
    const hz = await fetch(h.url + '/healthz')
    assert.equal(hz.status, 200)
    assert.equal((await hz.json()).ok, true)
  })
})

test('错令牌 / 乱格式 / 吊销 / 过期 → 401，且响应不泄露原因细节', async () => {
  await withHub(async (h) => {
    const good = h.token('a', ['read'])
    assert.equal((await rpc(h.url, good, 'tools/list')).status, 200)
    for (const bad of ['mh_x_y', 'garbage', good.slice(0, -3) + 'abc']) {
      const r = await rpc(h.url, bad, 'tools/list')
      assert.equal(r.status, 401, bad)
      assert.ok(!r.raw.includes(good))
    }
    revokeToken(h.home, 'a')
    assert.equal((await rpc(h.url, good, 'tools/list')).status, 401)
    const expired = h.token('b', ['read'], { expiresAt: new Date(Date.now() - 5000).toISOString() })
    assert.equal((await rpc(h.url, expired, 'tools/list')).status, 401)
  })
})

test('令牌放 query string 无效（规范禁止）', async () => {
  await withHub(async (h) => {
    const good = h.token('a', ['read'])
    const res = await fetch(`${h.url}/mcp?token=${good}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    assert.equal(res.status, 401)
  })
})

test('认证失败按来源限流：连续失败超过阈值 → 429；正确令牌不受已失败次数以外影响前仍可用', async () => {
  await withHub(async (h) => {
    let last = 0
    for (let i = 0; i < 15; i++) last = (await rpc(h.url, 'mh_bad_token', 'tools/list')).status
    assert.equal(last, 429)
  })
})

test('只读令牌：tools/list 看不到 memory_capture；调用 memory_capture → 403 且未写入', async () => {
  await withHub(async (h) => {
    const ro = h.token('reader', ['read'])
    const rw = h.token('writer', ['read', 'write'])
    const names = (r) => r.body.result.tools.map((t) => t.name)
    assert.ok(!names(await rpc(h.url, ro, 'tools/list')).includes('memory_capture'))
    assert.ok(names(await rpc(h.url, rw, 'tools/list')).includes('memory_capture'))
    const r = await call(h.url, ro, 'memory_capture', { text: durableText('只读令牌') })
    assert.equal(r.status, 403)
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM cards').get().n + h.db().prepare('SELECT COUNT(*) n FROM quarantine').get().n, 0)
    const denied = h.db().prepare("SELECT * FROM write_log WHERE outcome = 'denied'").all()
    assert.equal(denied.length, 1)
    assert.equal(denied[0].actor_name, 'reader')
    assert.equal(denied[0].tool, 'memory_capture')
  })
})

test('Origin 非法 → 403；Host 非法 → 403；本机 Origin 放行', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    assert.equal((await rpc(h.url, tok, 'tools/list', {}, { headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal((await rpc(h.url, tok, 'tools/list', {}, { headers: { origin: 'http://localhost:3000' } })).status, 200)
    // fetch 不允许改 Host 头，用原生 http 请求
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: h.port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}`, host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode) })
      req.on('error', reject)
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    })
    assert.equal(status, 403)
  })
})

test('请求体过大 → 413；非 JSON → 400', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['write'])
    const big = await fetch(h.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_capture', arguments: { text: 'x'.repeat(3 * 1024 * 1024) } } }) })
    assert.equal(big.status, 413)
    const bad = await fetch(h.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}` }, body: '{not json' })
    assert.equal(bad.status, 400)
  })
})

test('署名只认令牌名：自报 source 不能冒充；source 仅作标签写入 source 列', async () => {
  await withHub(async (h) => {
    const tok = h.token('agent-a', ['write'])
    const r = await call(h.url, tok, 'memory_capture', { text: durableText('署名测试'), source: 'deepseek-harness' })
    assert.equal(r.status, 200, r.raw)
    const out = JSON.parse(toolText(r))
    assert.equal(out.ok, true)
    const row = h.db().prepare('SELECT submitted_by, source FROM quarantine WHERE path = ?').get(out.path)
    assert.equal(row.submitted_by, 'agent-a')
    assert.equal(row.source, 'deepseek-harness')
  })
})

test('自报 source 为免审 Agent 名时仍进待审队列；免审只绑令牌名', async () => {
  await withHub(async (h) => {
    h.db().prepare("INSERT INTO config (key, value) VALUES ('auditMode','all'), ('auditExemptAgents', ?)").run(JSON.stringify(['trusted-agent']))
    const imposter = h.token('agent-a', ['write'])
    const r1 = JSON.parse(toolText(await call(h.url, imposter, 'memory_capture', { text: durableText('冒充免审'), source: 'trusted-agent' })))
    assert.equal(r1.ok, true)
    assert.equal(r1.status ?? 'pending', 'pending')
    assert.ok(h.db().prepare('SELECT 1 FROM quarantine WHERE path = ? AND status = ?').get(r1.path, 'pending'), '冒充者的卡必须在待审队列')
    assert.ok(!h.db().prepare('SELECT 1 FROM cards WHERE path = ?').get(r1.path))

    const real = h.token('trusted-agent', ['write'])
    const r2 = JSON.parse(toolText(await call(h.url, real, 'memory_capture', { text: durableText('真免审令牌'), source: 'whatever' })))
    assert.equal(r2.ok, true)
    assert.ok(h.db().prepare('SELECT 1 FROM cards WHERE path = ?').get(r2.path), '免审令牌的卡直接入主库')
  })
})

test('默认 auditMode=all：未配置审核规则时新卡进待审', async () => {
  await withHub(async (h) => {
    const tok = h.token('agent-a', ['write'])
    const out = JSON.parse(toolText(await call(h.url, tok, 'memory_capture', { text: durableText('默认待审') })))
    assert.ok(h.db().prepare('SELECT 1 FROM quarantine WHERE path = ? AND status = ?').get(out.path, 'pending'))
  })
})

test('write_log：成功写入有记录（不含正文与令牌），含 actor / tool / action / outcome / args_digest', async () => {
  await withHub(async (h) => {
    const tok = h.token('agent-a', ['read', 'write'])
    const text = durableText('审计记录')
    const out = JSON.parse(toolText(await call(h.url, tok, 'memory_capture', { text })))
    await call(h.url, tok, 'memory_recall', { query: '审计记录' })
    const rows = h.db().prepare('SELECT * FROM write_log ORDER BY id').all()
    const cap = rows.find((r) => r.tool === 'memory_capture')
    assert.ok(cap)
    assert.equal(cap.actor_type, 'agent')
    assert.equal(cap.actor_name, 'agent-a')
    assert.equal(cap.outcome, 'ok')
    assert.equal(cap.action, 'create')
    assert.equal(cap.card_path, out.path)
    assert.match(cap.ts, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(cap.args_digest, /^[0-9a-f]{16,}$/)
    assert.ok(rows.some((r) => r.tool === 'memory_recall'))
    const dump = JSON.stringify(rows)
    assert.ok(!dump.includes(text.slice(0, 40)) && !dump.includes(tok))
  })
})

test('capture 遇疑似明文密钥：拒绝写入，只报类型不报值（响应 / 库 / write_log / 日志均无值）', async () => {
  await withHub(async (h) => {
    const tok = h.token('agent-a', ['write'])
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    const text = durableText('含密钥文本') + `\n这里不小心贴了 token: ${secret}\n`
    const r = await call(h.url, tok, 'memory_capture', { text })
    assert.equal(r.status, 200)
    const out = JSON.parse(toolText(r))
    assert.equal(out.ok, false)
    assert.equal(out.action, 'skipped')
    assert.match(out.reason, /github-token/)
    assert.ok(!r.raw.includes(secret))
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM cards').get().n + h.db().prepare('SELECT COUNT(*) n FROM quarantine').get().n, 0)
    assert.ok(!JSON.stringify(h.db().prepare('SELECT * FROM write_log').all()).includes(secret))
    assert.ok(!h.logs.text().includes(secret))
    const row = h.db().prepare('SELECT outcome FROM write_log WHERE tool = ?').get('memory_capture')
    assert.equal(row.outcome, 'denied')
  })
})

test('日志不得出现令牌明文；鉴权失败为 WARN，启动为 INFO', async () => {
  await withHub(async (h) => {
    const tok = h.token('agent-a', ['read'])
    await rpc(h.url, tok, 'tools/list')
    await rpc(h.url, 'mh_bad_secretvalue123', 'tools/list')
    const text = h.logs.text()
    assert.ok(!text.includes(tok) && !text.includes('secretvalue123'))
    const lv = h.logs.lines().map((l) => JSON.parse(l))
    assert.ok(lv.some((l) => l.level === 'INFO'))
    assert.ok(lv.some((l) => l.level === 'WARN' && /auth|鉴权/i.test(l.msg)))
  })
})

test('输入校验（zod）：capture.text 超 64K 字符、类型错误、缺必填 → 拒绝且不写入', async () => {
  await withHub(async (h) => {
    const tok = h.token('agent-a', ['read', 'write'])
    const isErr = (r) => r.body?.error || r.body?.result?.isError
    assert.ok(isErr(await call(h.url, tok, 'memory_capture', { text: 'x'.repeat(64 * 1024 + 1) })))
    assert.ok(isErr(await call(h.url, tok, 'memory_capture', { text: 123 })))
    assert.ok(isErr(await call(h.url, tok, 'memory_capture', {})))
    assert.ok(isErr(await call(h.url, tok, 'memory_recall', { query: { a: 1 } })))
    assert.ok(isErr(await call(h.url, tok, 'memory_recall', { query: 'ok', limit: 'many' })))
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM cards').get().n + h.db().prepare('SELECT COUNT(*) n FROM quarantine').get().n, 0)
  })
})

test('tidy apply 开关：默认 tools/list 不含 apply / tag_normalize，即便令牌有 tidy:apply；调用等同未知工具', async () => {
  await withHub(async (h) => {
    const tok = h.token('admin-ish', ['tidy:apply'])
    const names = (await rpc(h.url, tok, 'tools/list')).body.result.tools.map((t) => t.name)
    assert.ok(!names.includes('memory_tidy_apply') && !names.includes('memory_tag_normalize'))
    for (const n of ['memory_tidy_plan', 'memory_lint', 'memory_recall', 'memory_capture']) assert.ok(names.includes(n), n)
    await writeCard(h.home, { kind: 'knowledge', title: '[SCHEDULE REMINDER BATCH]', tags: ['raw'], body: '提醒内容很短', status: 'approved', submittedBy: 'x' }, { dedup: false })
    const r = await call(h.url, tok, 'memory_tidy_apply', { confirm: true })
    assert.ok(r.body?.error || r.body?.result?.isError, '未暴露时必须报错')
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM cards').get().n, 1, '不得执行')
  })
})

test('exposeTidyApply=true：需同时具备 tidy:apply scope 才出现；调用仍须 confirm===true', async () => {
  await withHub(async (h) => {
    const full = h.token('tidy-agent', ['tidy:apply'])
    const writer = h.token('writer', ['write'])
    const nm = async (t) => (await rpc(h.url, t, 'tools/list')).body.result.tools.map((x) => x.name)
    const fullNames = await nm(full)
    assert.ok(fullNames.includes('memory_tidy_apply') && fullNames.includes('memory_tag_normalize'))
    const wNames = await nm(writer)
    assert.ok(!wNames.includes('memory_tidy_apply'))
    assert.equal((await call(h.url, writer, 'memory_tidy_apply', { confirm: true })).status, 403)

    await writeCard(h.home, { kind: 'knowledge', title: '[SCHEDULE REMINDER BATCH]', tags: ['raw'], body: '提醒内容很短', status: 'approved', submittedBy: 'x' }, { dedup: false })
    for (const args of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }]) {
      await call(h.url, full, 'memory_tidy_apply', args)
      assert.equal(h.db().prepare('SELECT COUNT(*) n FROM cards').get().n, 1, `args=${JSON.stringify(args)} 不得真正执行`)
    }
    const ok = await call(h.url, full, 'memory_tidy_apply', { confirm: true })
    assert.equal(ok.status, 200, ok.raw)
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM cards').get().n, 0, 'confirm===true 才软删')
    assert.ok(h.db().prepare("SELECT 1 FROM write_log WHERE tool = 'memory_tidy_apply' AND outcome = 'ok'").get())
  }, { env: { MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY: '1' } })
})

test('基线兼容：v0.10.8 基线的 4 个原有工具名 / 必填参数 / 属性不变，另含 memory_read 与 4 个整理工具（共 9 个，全权限 + 开关开）', async () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/mcp-tools-baseline-v0.10.8.json'), 'utf8'))
  const baseTools = Array.isArray(baseline) ? baseline : baseline.tools
  await withHub(async (h) => {
    const tok = h.token('all', ['read', 'write', 'tidy:apply'])
    const tools = (await rpc(h.url, tok, 'tools/list')).body.result.tools
    // 注：PLAN 第 7 节写作"基线 8 个工具"，实际 v0.10.8 基线 fixture 只有 4 个，另 4 个整理工具来自 fork（tidy）
    assert.equal(baseTools.length, 4)
    const extra = ['memory_read', 'memory_tidy_plan', 'memory_tidy_apply', 'memory_lint', 'memory_tag_normalize']
    assert.deepEqual(tools.map((t) => t.name).sort(), [...baseTools.map((t) => t.name), ...extra].sort())
    for (const bt of baseTools) {
      const t = tools.find((x) => x.name === bt.name)
      assert.deepEqual([...(t.inputSchema.required || [])].sort(), [...(bt.inputSchema.required || [])].sort(), bt.name)
      for (const p of Object.keys(bt.inputSchema.properties || {})) assert.ok(t.inputSchema.properties?.[p], `${bt.name}.${p} 缺失`)
    }
  }, { env: { MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY: '1' } })
})

test('server instructions 与 capture / recall 工具描述存在且给出何时调用的指引', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
  await withHub(async (h) => {
    const tok = h.token('a', ['read', 'write'])
    const c = new Client({ name: 't', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(h.url + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }))
    const ins = c.getInstructions()
    assert.ok(ins && ins.length > 50)
    assert.match(ins, /memory_recall/)
    assert.match(ins, /memory_capture/)
    assert.match(ins, /密钥|口令/)
    const tools = (await c.listTools()).tools
    const cap = tools.find((t) => t.name === 'memory_capture')
    const rec = tools.find((t) => t.name === 'memory_recall')
    assert.match(cap.description, /主动|立即|及时/)
    assert.match(rec.description, /开始|先/)
    await c.close()
  })
})

test('管理员 / Agent 令牌隔离：Agent 令牌访问管理 API 一律 401（M2 起 /admin/api 存在，认证独立于 /mcp；M1 时这里是 404）；未知非 MCP 路径仍是 404', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    const res = await fetch(h.url + '/admin/api/cards', { headers: { authorization: `Bearer ${tok}` } })
    assert.equal(res.status, 401)
    assert.equal((await fetch(h.url + '/nope', { headers: { authorization: `Bearer ${tok}` } })).status, 404)
  })
})

test('basePath：MEMORY_HUB_BASE_PATH=/memory 时 MCP 在 /memory/mcp，/mcp 为 404', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    assert.equal((await rpc(h.url, tok, 'tools/list', {}, { path: '/memory/mcp' })).status, 200)
    assert.equal((await rpc(h.url, tok, 'tools/list', {}, { path: '/mcp' })).status, 404)
    assert.equal((await fetch(h.url + '/memory/healthz')).status, 200)
  }, { env: { MEMORY_HUB_BASE_PATH: '/memory' } })
})
