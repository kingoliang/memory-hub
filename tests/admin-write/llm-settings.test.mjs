// 管理界面配置蒸馏 LLM：保存即生效、key 只写不读、0600 单独文件、环境变量锁定、测试连接。
// 决策见 docs/decisions/2026-10-19-llm-settings-in-admin.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { withHubW, loggedIn, lastLog } from './write-helpers.mjs'
import { startMockLlm, rpc, toolText, durableText } from '../helpers.mjs'
import { loadConfig } from '../../src/config.js'

const KEY = 'sk-' + 'UIkeyNOTREAL0123456789abcdefXYZ'
const FILE = (h) => path.join(h.home, 'llm-settings.json')

test('GET /settings/llm：未配置时的字面量形状；不含 key', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const r = await c.get('/admin/api/settings/llm')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json, { source: 'none', envLocked: false, baseUrl: '', model: '', keySet: false, reasoningEffort: '', timeoutMs: 90000 })
  }, { seed: false })
})

test('PUT /settings/llm：保存后立即生效（下一次 AI 汇总就打到新端点、带新 key），文件 0600，响应与审计不含 key', async () => {
  const mock = await startMockLlm('{"summary":"ok"}')
  try {
    await withHubW(async (h) => {
      const c = await loggedIn(h)
      // 保存前：AI 汇总不可用
      const before = await c.wpost('/admin/api/graph/summarize', { q: '部署', paths: ['x.md'] })
      assert.equal(before.json?.error, 'llm_not_configured')

      const r = await c.req('PUT', '/admin/api/settings/llm', { body: { baseUrl: mock.baseUrl, model: 'ui-model', key: KEY, reasoningEffort: 'low', timeoutMs: 30000 }, withCsrf: true })
      assert.equal(r.status, 200, r.text)
      assert.deepEqual(r.json, { ok: true, changed: ['baseUrl', 'model', 'key', 'reasoningEffort', 'timeoutMs'], llm: { source: 'admin', envLocked: false, baseUrl: mock.baseUrl, model: 'ui-model', keySet: true, reasoningEffort: 'low', timeoutMs: 30000 } })
      assert.equal(r.text.includes(KEY), false)

      assert.equal(fs.statSync(FILE(h)).mode & 0o777, 0o600)
      const wl = lastLog(h, 'llm_settings_update')
      assert.deepEqual([wl.outcome, wl.tool], ['ok', 'PUT /settings/llm'])
      assert.equal(JSON.stringify(wl).includes(KEY), false)
      assert.equal(h.logs.text().includes(KEY), false)

      // 不重启：/settings 与 /overview 立即显示已配置
      assert.deepEqual((await c.get('/admin/api/settings')).json.readonly.llm.configured, true)
      assert.deepEqual((await c.get('/admin/api/overview')).json.llm, { configured: true, model: 'ui-model' })

      // 不重启：AI 汇总不再报「未配置」（paths 不存在 → 404，说明已越过 LLM 检查）
      const after = await c.wpost('/admin/api/graph/summarize', { q: '部署', paths: ['x.md'] })
      assert.deepEqual([after.status, after.json?.error], [404, 'not_found'])
      // 不重启：MCP / ingest 用的适配器也是现建的：直接取当前适配器打一次 mock，确认带的是新 key 与 reasoning_effort
      const t = await c.wpost('/admin/api/settings/llm/test', {})
      assert.equal(t.json.ok, true, t.text)
      assert.deepEqual([mock.seen.at(-1).auth, mock.seen.at(-1).body.model, mock.seen.at(-1).body.reasoning_effort], [`Bearer ${KEY}`, 'ui-model', 'low'])
    }, { seed: false })
  } finally { await mock.close() }
})

test('PUT：key 留空 = 保留原 key；clearKey=true 才清除；同值再存 changed 为空', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const put = (body) => c.req('PUT', '/admin/api/settings/llm', { body, withCsrf: true })
    await put({ baseUrl: 'https://llm.example.test/v1', model: 'm1', key: KEY })
    const keep = await put({ baseUrl: 'https://llm.example.test/v1', model: 'm2' })
    assert.deepEqual([keep.json.changed, keep.json.llm.keySet], [['model'], true])
    assert.equal(JSON.parse(fs.readFileSync(FILE(h), 'utf8')).key, KEY)
    const same = await put({ baseUrl: 'https://llm.example.test/v1', model: 'm2' })
    assert.deepEqual(same.json.changed, [])
    const clear = await put({ baseUrl: 'https://llm.example.test/v1', model: 'm2', clearKey: true })
    assert.deepEqual([clear.json.changed, clear.json.llm.keySet], [['key'], false])
  }, { seed: false })
})

test('PUT 校验：字面量错误信息；库与文件都不变', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const put = (body) => c.req('PUT', '/admin/api/settings/llm', { body, withCsrf: true })
    const cases = [
      [{ baseUrl: 'ftp://x/v1', model: 'm' }, 'baseUrl 必须是 http:// 或 https:// 地址'],
      [{ baseUrl: 'https://user:pw@x.test/v1', model: 'm' }, 'baseUrl 不能包含用户名或口令（凭据请填在 API Key）'],
      [{ baseUrl: 'https://x.test/v1', model: '' }, '填了 baseUrl 就必须填 model（两者都留空 = 关闭 LLM）'],
      [{ baseUrl: '', model: 'm' }, '填了 model 就必须填 baseUrl（两者都留空 = 关闭 LLM）'],
      [{ baseUrl: 'https://x.test/v1', model: 'm', reasoningEffort: 'max' }, 'reasoningEffort 只能是 none / low / medium / high 或留空'],
      [{ baseUrl: 'https://x.test/v1', model: 'm', timeoutMs: 500 }, 'timeoutMs 必须是 1000~600000 的整数（毫秒）'],
      [{ baseUrl: 'https://x.test/v1', model: 'm', key: 'a\nb' }, 'key 不能包含换行或控制字符'],
      [{ baseUrl: 'https://x.test/v1', model: 'm', extra: 1 }, '不支持的字段：extra'],
    ]
    for (const [body, msg] of cases) {
      const r = await put(body)
      assert.deepEqual({ status: r.status, message: r.json?.message }, { status: 400, message: msg }, JSON.stringify(body))
    }
    assert.equal(fs.existsSync(FILE(h)), false)
  }, { seed: false })
})

test('两者都留空 = 关闭 LLM：保存后 AI 汇总回到「未配置」', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const put = (body) => c.req('PUT', '/admin/api/settings/llm', { body, withCsrf: true })
    await put({ baseUrl: 'https://llm.example.test/v1', model: 'm1', key: KEY })
    const off = await put({ baseUrl: '', model: '', clearKey: true })
    assert.equal(off.status, 200, off.text)
    assert.deepEqual(off.json.llm, { source: 'none', envLocked: false, baseUrl: '', model: '', keySet: false, reasoningEffort: '', timeoutMs: 90000 })
    assert.equal((await c.wpost('/admin/api/graph/summarize', { q: 'x', paths: ['x.md'] })).json?.error, 'llm_not_configured')
  }, { seed: false })
})

test('环境变量已配置 LLM：界面只读，PUT 返回 409 llm_env_locked', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const g = await c.get('/admin/api/settings/llm')
    assert.deepEqual([g.json.source, g.json.envLocked, g.json.model, g.json.keySet], ['env', true, 'env-model', true])
    const r = await c.req('PUT', '/admin/api/settings/llm', { body: { baseUrl: 'https://x.test/v1', model: 'm' }, withCsrf: true })
    assert.deepEqual({ status: r.status, error: r.json.error, message: r.json.message }, { status: 409, error: 'llm_env_locked', message: 'LLM 由环境变量 MEMORY_LLM_* 配置，界面不能修改；要在界面里配置，请先去掉这些环境变量并重启' })
  }, { seed: false, env: { MEMORY_LLM_BASE_URL: 'https://env.example.test/v1', MEMORY_LLM_MODEL: 'env-model', MEMORY_LLM_KEY: KEY } })
})

test('MCP memory_capture 在界面保存后、不重启就走蒸馏（不再 degraded），请求带新 key 与模型', async () => {
  const card = JSON.stringify({ save: true, title: '配置方案决策', kind: 'tool', tags: ['config'], body: '# 配置方案决策\n\n- 采用环境变量加配置文件\n- 原因：部署时无需改代码' })
  const mock = await startMockLlm(card)
  try {
    await withHubW(async (h) => {
      const c = await loggedIn(h)
      const tok = h.token('mcp-agent', ['write'])
      const capture = async (topic) => JSON.parse(toolText(await rpc(h.url, tok, 'tools/call', { name: 'memory_capture', arguments: { text: durableText(topic) } })))
      assert.equal((await capture('缓存淘汰策略')).degraded, true)
      await c.req('PUT', '/admin/api/settings/llm', { body: { baseUrl: mock.baseUrl, model: 'ui-model', key: KEY }, withCsrf: true })
      const out = await capture('日志轮转周期')
      assert.deepEqual([out.ok, out.degraded ?? false], [true, false], JSON.stringify({ out, seen: mock.seen.length, log: h.logs.text().split('\n').filter((l) => /LLM|蒸馏|distill/i.test(l)).slice(-3) }))
      assert.deepEqual([mock.seen.at(-1).auth, mock.seen.at(-1).body.model], [`Bearer ${KEY}`, 'ui-model'])
    }, { seed: false })
  } finally { await mock.close() }
})

test('环境变量锁定时，界面残留的 llm-settings.json 不生效（不会把 key 发到旧端点）', async () => {
  await withHubW(async (h) => {
    fs.writeFileSync(FILE(h), JSON.stringify({ baseUrl: 'https://stale.example.test/v1', model: 'stale', key: 'stale-key' }), { mode: 0o600 })
    const cfg = loadConfig({ MEMORY_HUB_HOME: h.home, MEMORY_LLM_BASE_URL: 'https://env.example.test/v1', MEMORY_LLM_MODEL: 'env-model' })
    assert.deepEqual([cfg.llm.baseUrl, cfg.llm.model, cfg.llm.apiKey, cfg.llmSource], ['https://env.example.test/v1', 'env-model', '', 'env'])
  }, { seed: false })
})

test('重启后仍生效（loadConfig 读 llm-settings.json）；文件不是 0600 时忽略 key 并告警', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    await c.req('PUT', '/admin/api/settings/llm', { body: { baseUrl: 'https://llm.example.test/v1', model: 'm1', key: KEY }, withCsrf: true })
    const cfg = loadConfig({ MEMORY_HUB_HOME: h.home })
    assert.deepEqual([cfg.llm.baseUrl, cfg.llm.model, cfg.llm.apiKey, cfg.llmSource], ['https://llm.example.test/v1', 'm1', KEY, 'admin'])
    fs.chmodSync(FILE(h), 0o644)
    const warns = []
    const loose = loadConfig({ MEMORY_HUB_HOME: h.home }, { warn: (m) => warns.push(m) })
    assert.deepEqual([loose.llm.model, loose.llm.apiKey], ['m1', ''])
    assert.deepEqual(warns, ['llm-settings.json 权限为 644，应为 0600；已忽略其中的 key（请 chmod 600）'])
  }, { seed: false })
})

test('POST /settings/llm/test：用表单值连一次 mock，返回 ok + 模型；key 留空用已保存的；失败信息不含 key', async () => {
  const mock = await startMockLlm('pong')
  try {
    await withHubW(async (h) => {
      const c = await loggedIn(h)
      const t1 = await c.wpost('/admin/api/settings/llm/test', { baseUrl: mock.baseUrl, model: 'probe-model', key: KEY })
      assert.equal(t1.status, 200, t1.text)
      assert.deepEqual([t1.json.ok, t1.json.model, typeof t1.json.ms], [true, 'probe-model', 'number'])
      assert.equal(mock.seen.at(-1).auth, `Bearer ${KEY}`)
      // 保存后，测试时 key 留空 → 用已保存的
      await c.req('PUT', '/admin/api/settings/llm', { body: { baseUrl: mock.baseUrl, model: 'probe-model', key: KEY }, withCsrf: true })
      await c.wpost('/admin/api/settings/llm/test', { baseUrl: mock.baseUrl, model: 'probe-model' })
      assert.equal(mock.seen.at(-1).auth, `Bearer ${KEY}`)
      // 连不上：ok=false，错误里不含 key
      const bad = await c.wpost('/admin/api/settings/llm/test', { baseUrl: 'http://127.0.0.1:9/v1', model: 'm', key: KEY })
      assert.deepEqual([bad.status, bad.json.ok], [200, false])
      assert.equal(bad.text.includes(KEY), false)
    }, { seed: false })
  } finally { await mock.close() }
})

test('Agent 路径（/api/ingest）在界面保存后、不重启就用上 LLM：蒸馏请求打到新端点', async () => {
  const card = JSON.stringify({ save: true, title: '界面配置的蒸馏', kind: 'knowledge', tags: ['ui'], body: '# 界面配置的蒸馏\n\n结论：在管理界面保存 LLM 后无需重启即可蒸馏。原因与步骤略。' + 'x'.repeat(80) })
  const mock = await startMockLlm((body) => (String(body.messages?.[0]?.content || '').includes('经验') ? '{"keep":true,"reason":"经验"}' : card))
  try {
    await withHubW(async (h) => {
      const c = await loggedIn(h)
      const tok = h.token('agent-x', ['write'])
      const text = `用户：帮我定一下部署的做法\n助手：${'背景：需要统一做法。结论：采用配置文件加环境变量，原因是部署时不需要改代码。步骤：确认依赖、写配置、重启并检查日志。'.repeat(10)}`
      const ingest = () => fetch(h.url + '/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ source: 'dsh', session_id: 's1', text }) })
      await c.req('PUT', '/admin/api/settings/llm', { body: { baseUrl: mock.baseUrl, model: 'ui-model', key: KEY }, withCsrf: true })
      const n0 = mock.seen.length
      const r = await ingest()
      const body = await r.json()
      assert.equal(r.status, 200, JSON.stringify(body))
      assert.ok(mock.seen.length > n0, '保存后的第一条 ingest 就应调用新 LLM：' + JSON.stringify(body))
      assert.deepEqual([mock.seen.at(-1).auth, mock.seen.at(-1).body.model], [`Bearer ${KEY}`, 'ui-model'])
    }, { seed: false, env: { MEMORY_HUB_INGEST_COOLDOWN_S: '0', MEMORY_HUB_GATE_INGEST: 'heuristic' } })
  } finally { await mock.close() }
})
