// 蒸馏失败修复：请求参数可配置（reasoning_effort / extra_body / 超时）、finish_reason 透出、
// 撞上限阶梯重试、失败诊断日志、多对象并排解析、重试不重复建卡。全部用本地假 OpenAI 端点，不连外网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { withHub } from './hub-helpers.mjs'
import { durableText, logSink } from './helpers.mjs'
import { loadConfig, ConfigError } from '../src/config.js'
import { createOpenAiLlm, createLlmFromEnv } from '../src/core/llm-openai.js'
import { runStandaloneCapture } from '../src/core/capture-run.js'
import { createLogger } from '../src/logger.js'
import { summarizeTurnDetailed, parseCaptureJsonDetailed } from '../src/core/capture.js'

const GOOD = JSON.stringify({ save: true, title: '蒸馏重试方案', kind: 'tool', tags: ['llm'], body: '# 蒸馏重试方案\n\n- 撞上限时按 2000→4000→8000 重试\n- 原因：推理模型的思考会吃掉输出预算' })

/** 假 OpenAI 端点：handler(body, n) → { content, finish_reason?, usage?, delayMs? } */
async function fakeServer(handler) {
  const seen = []
  const srv = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    seen.push(body)
    const r = handler(body, seen.length)
    if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: r.content }, finish_reason: r.finish_reason ?? 'stop' }], usage: r.usage }))
  }).listen(0, '127.0.0.1')
  await new Promise((r) => srv.on('listening', r))
  return { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, seen, close: () => new Promise((r) => srv.close(r)) }
}

const ROUTE = { provider: 'openai-compat', model: 'm' }
const drain = async (llm, opts) => { const out = []; for await (const c of llm.stream(opts)) out.push(c); return out }

// -- 1. 请求体 ---------------------------------------------------------------
test('请求体：默认不带 reasoning_effort / 额外字段；配置后带上并合并 extra_body', async () => {
  const srv = await fakeServer(() => ({ content: 'ok' }))
  try {
    await drain(createOpenAiLlm({ baseUrl: srv.baseUrl, model: 'm' }), { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })
    assert.equal('reasoning_effort' in srv.seen[0], false)
    assert.deepEqual(Object.keys(srv.seen[0]).sort(), ['max_tokens', 'messages', 'model', 'stream'])

    const llm = createOpenAiLlm({ baseUrl: srv.baseUrl, model: 'm', reasoningEffort: 'none', extraBody: { chat_template_kwargs: { enable_thinking: false } } })
    await drain(llm, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })
    assert.equal(srv.seen[1].reasoning_effort, 'none')
    assert.deepEqual(srv.seen[1].chat_template_kwargs, { enable_thinking: false })
    assert.equal(srv.seen[1].stream, false)
    assert.equal(srv.seen[1].max_tokens, 100)
  } finally { await srv.close() }
})

test('配置解析：MEMORY_LLM_REASONING_EFFORT / EXTRA_BODY / TIMEOUT_MS；空值=不传；非法值启动即报明确错误', () => {
  const base = { MEMORY_HUB_HOME: '/tmp/mh-cfg-none', MEMORY_LLM_BASE_URL: 'http://x/v1', MEMORY_LLM_MODEL: 'm' }
  const dflt = loadConfig(base).llmRequest
  assert.equal(dflt.reasoningEffort, '')
  assert.equal(dflt.extraBody, null)
  assert.equal(dflt.timeoutMs, 90000)
  const c = loadConfig({ ...base, MEMORY_LLM_REASONING_EFFORT: 'none', MEMORY_LLM_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}', MEMORY_LLM_TIMEOUT_MS: '120000' }).llmRequest
  assert.equal(c.reasoningEffort, 'none')
  assert.deepEqual(c.extraBody, { chat_template_kwargs: { enable_thinking: false } })
  assert.equal(c.timeoutMs, 120000)

  assert.throws(() => loadConfig({ ...base, MEMORY_LLM_EXTRA_BODY: '{bad json' }), (e) => e instanceof ConfigError && /MEMORY_LLM_EXTRA_BODY/.test(e.message))
  assert.throws(() => loadConfig({ ...base, MEMORY_LLM_EXTRA_BODY: '[1,2]' }), (e) => e instanceof ConfigError && /对象/.test(e.message))
  for (const k of ['model', 'messages', 'stream']) {
    assert.throws(() => loadConfig({ ...base, MEMORY_LLM_EXTRA_BODY: JSON.stringify({ [k]: 1 }) }), (e) => e instanceof ConfigError && e.message.includes(k), `不得覆盖 ${k}`)
  }
  assert.throws(() => loadConfig({ ...base, MEMORY_LLM_REASONING_EFFORT: 'turbo' }), (e) => e instanceof ConfigError && /MEMORY_LLM_REASONING_EFFORT/.test(e.message))
  assert.throws(() => loadConfig({ ...base, MEMORY_LLM_TIMEOUT_MS: 'abc' }), (e) => e instanceof ConfigError && /MEMORY_LLM_TIMEOUT_MS/.test(e.message))
})

test('createLlmFromEnv 同样读取新变量，非法 extra_body 同样直接报错', async () => {
  const srv = await fakeServer(() => ({ content: 'ok' }))
  try {
    const env = { MEMORY_LLM_BASE_URL: srv.baseUrl, MEMORY_LLM_MODEL: 'm', MEMORY_LLM_REASONING_EFFORT: 'none' }
    await drain(createLlmFromEnv(env), { messages: [{ role: 'user', content: 'x' }] })
    assert.equal(srv.seen[0].reasoning_effort, 'none')
    assert.throws(() => createLlmFromEnv({ ...env, MEMORY_LLM_EXTRA_BODY: '{"model":"evil"}' }), ConfigError)
  } finally { await srv.close() }
})

// -- 2. finish_reason / usage 透出 -------------------------------------------
test('适配器透出 finish_reason 与 usage（含 reasoning_tokens）；length 在 summarizeTurnDetailed 里归为 MAX_TOKENS/length', async () => {
  const srv = await fakeServer(() => ({ content: '', finish_reason: 'length', usage: { prompt_tokens: 10, completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 2000 } } }))
  try {
    const llm = createOpenAiLlm({ baseUrl: srv.baseUrl, model: 'm' })
    const chunks = await drain(llm, { messages: [{ role: 'user', content: 'x' }] })
    const fin = chunks.find((c) => c && c.type === 'finish')
    assert.ok(fin, '应有 finish 块')
    assert.equal(fin.reason.kind, 'max-tokens')
    assert.equal(fin.finishReason, 'length')
    assert.equal(fin.usage.completion_tokens_details.reasoning_tokens, 2000)

    const r = await summarizeTurnDetailed(llm, ROUTE, durableText('length'))
    assert.equal(r.failure.code, 'MAX_TOKENS')
    assert.equal(r.failure.category, 'length')
    assert.equal(r.failure.finishReason, 'length')
    assert.equal(r.failure.usage.reasoning, 2000)
    assert.ok(r.failure.inputChars > 100)
    assert.equal(r.failure.maxTokens, 2000)
  } finally { await srv.close() }
})

// -- 3. 阶梯重试 -------------------------------------------------------------
test('length 触发 2000→4000→8000 阶梯重试，第三次成功：只建一张蒸馏卡，不降级', async () => {
  const srv = await fakeServer((body, n) => (n < 3
    ? { content: '', finish_reason: 'length', usage: { completion_tokens: body.max_tokens } }
    : { content: GOOD, usage: { completion_tokens: 300 } }))
  const sink = logSink()
  try {
    await withHub(async (h) => {
      const llm = createOpenAiLlm({ baseUrl: srv.baseUrl, model: 'm' })
      const out = await runStandaloneCapture(h.home, durableText('阶梯重试'), { llm, source: 't', submittedBy: 'a', log: createLogger({ level: 'debug', stream: sink.stream }) })
      assert.equal(out.ok, true)
      assert.equal(out.action, 'created')
      assert.ok(!out.degraded)
      assert.deepEqual(srv.seen.map((b) => b.max_tokens), [2000, 4000, 8000])
      const rows = h.db().prepare('SELECT title, tags FROM quarantine').all()
      assert.equal(rows.length, 1, '重试不得重复建卡')
      assert.equal(rows[0].title, '蒸馏重试方案')
      assert.match(sink.text(), /蒸馏重试/, '重试应有日志')
    })
  } finally { await srv.close() }
})

test('空输出（stop）与截断 JSON 同样重试；重试后成功', async () => {
  const srv = await fakeServer((body, n) => (n === 1 ? { content: '' } : n === 2 ? { content: '{"save": true, "title": "半截' } : { content: GOOD }))
  try {
    await withHub(async (h) => {
      const out = await runStandaloneCapture(h.home, durableText('空与截断'), { llm: createOpenAiLlm({ baseUrl: srv.baseUrl, model: 'm' }), submittedBy: 'a', log: createLogger({ level: 'error', stream: logSink().stream }) })
      assert.equal(out.action, 'created')
      assert.ok(!out.degraded)
      assert.equal(srv.seen.length, 3)
      assert.equal(h.db().prepare('SELECT COUNT(*) n FROM quarantine').get().n, 1)
    })
  } finally { await srv.close() }
})

test('3 次都失败：恰好 3 次调用，降级为一张 raw 卡，WARN 日志含诊断字段且不含正文 / key', async () => {
  const srv = await fakeServer((body) => ({ content: '', finish_reason: 'length', usage: { prompt_tokens: 50, completion_tokens: body.max_tokens, completion_tokens_details: { reasoning_tokens: body.max_tokens } } }))
  const sink = logSink()
  const text = durableText('全部失败')
  try {
    await withHub(async (h) => {
      const llm = createOpenAiLlm({ baseUrl: srv.baseUrl, model: 'm', apiKey: 'sk-secret-key-123456789' })
      const out = await runStandaloneCapture(h.home, text, { llm, submittedBy: 'a', log: createLogger({ level: 'debug', stream: sink.stream }) })
      assert.equal(out.action, 'created')
      assert.equal(out.degraded, true)
      assert.equal(srv.seen.length, 3)
      assert.equal(h.db().prepare('SELECT COUNT(*) n FROM quarantine').get().n, 1)
      const warn = sink.lines().map((l) => JSON.parse(l)).filter((r) => r.level === 'WARN' && /降级/.test(r.msg))
      assert.equal(warn.length, 1)
      const w = warn[0]
      assert.equal(w.category, 'length')
      assert.equal(w.finishReason, 'length')
      assert.equal(w.attempts, 3)
      assert.equal(w.outBudget, 8000)
      assert.ok(w.inputChars > 100)
      assert.equal(w.usageReasoning, 8000)
      assert.ok(!sink.text().includes('sk-secret-key-123456789'))
      assert.ok(!sink.text().includes('背景：全部失败在项目里'), '日志不得含原文正文')
    })
  } finally { await srv.close() }
})

test('超时：不重试（只调一次），降级为 raw 卡，日志类别 timeout', async () => {
  const srv = await fakeServer(() => ({ content: GOOD, delayMs: 600 }))
  const sink = logSink()
  try {
    await withHub(async (h) => {
      const llm = createOpenAiLlm({ baseUrl: srv.baseUrl, model: 'm', timeoutMs: 150 })
      const out = await runStandaloneCapture(h.home, durableText('超时'), { llm, submittedBy: 'a', log: createLogger({ level: 'debug', stream: sink.stream }) })
      assert.equal(out.degraded, true)
      assert.equal(srv.seen.length, 1)
      const w = sink.lines().map((l) => JSON.parse(l)).find((r) => r.level === 'WARN' && /降级/.test(r.msg))
      assert.equal(w.category, 'timeout')
    })
  } finally { await srv.close() }
})

// -- 4. 静默降级补日志 -------------------------------------------------------
test('JSON 可解析但内容不合格（cardFromParsedJson=null）→ 降级并留 WARN 决策日志', async () => {
  const srv = await fakeServer(() => ({ content: '{"save": true, "title": "", "body": ""}' }))
  const sink = logSink()
  try {
    await withHub(async (h) => {
      const llm = createOpenAiLlm({ baseUrl: srv.baseUrl, model: 'm' })
      const out = await runStandaloneCapture(h.home, durableText('不合格'), { llm, submittedBy: 'a', log: createLogger({ level: 'debug', stream: sink.stream }) })
      assert.equal(out.degraded, true)
      assert.equal(srv.seen.length, 1, '内容不合格不属于可重试类别')
      const recs = sink.lines().map((l) => JSON.parse(l))
      assert.ok(recs.some((r) => r.level === 'WARN' && /蒸馏结果不合格/.test(r.msg)), sink.text())
    })
  } finally { await srv.close() }
})

test('蒸馏 skip（预筛判定无复用信号）→ 降级并留 INFO 决策日志', async () => {
  const sink = logSink()
  const srv = await fakeServer(() => ({ content: GOOD }))
  try {
    await withHub(async (h) => {
      const llm = createOpenAiLlm({ baseUrl: srv.baseUrl, model: 'm' })
      // 够长、非噪声，但没有任何「可复用」信号词
      const chatty = '你好呀，今天天气真不错，我们随便聊聊吧。'.repeat(12)
      const out = await runStandaloneCapture(h.home, chatty, { llm, submittedBy: 'a', log: createLogger({ level: 'debug', stream: sink.stream }) })
      assert.equal(out.degraded, true)
      assert.equal(srv.seen.length, 0)
      const recs = sink.lines().map((l) => JSON.parse(l))
      assert.ok(recs.some((r) => r.level === 'INFO' && /蒸馏跳过/.test(r.msg) && r.reason === 'not-durable'), sink.text())
    })
  } finally { await srv.close() }
})

// -- 5. 解析兜底 -------------------------------------------------------------
test('解析：多对象并排取第一个有效对象；尾部多余字符忽略；围栏与单对象不受影响', () => {
  const a = JSON.stringify({ save: true, title: '第一个对象标题', kind: 'knowledge', tags: [], body: '# 第一个对象标题\n\n正文内容一二三四五' })
  const b = JSON.stringify({ save: false })
  assert.equal(parseCaptureJsonDetailed(`${a}\n${b}`).card?.title, '第一个对象标题')
  assert.equal(parseCaptureJsonDetailed(`${a}${b}`).card?.title, '第一个对象标题')
  assert.equal(parseCaptureJsonDetailed(`${a}\n\n以上是结果。`).card?.title, '第一个对象标题')
  assert.equal(parseCaptureJsonDetailed(`说明如下：${a} 完毕}`).card?.title, '第一个对象标题')
  assert.equal(parseCaptureJsonDetailed('```json\n' + a + '\n```').card?.title, '第一个对象标题')
  assert.equal(parseCaptureJsonDetailed(b).card?.save, false)
  assert.equal(parseCaptureJsonDetailed('{"save": true, "title": "半截').parsed, false)
  // 第一个对象无效（不可解析）时仍取后面的有效对象
  assert.equal(parseCaptureJsonDetailed(`{坏的} ${a}`).card?.title, '第一个对象标题')
})
