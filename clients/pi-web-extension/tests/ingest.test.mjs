import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStderrLog, createMemoryHubIngest, stripNoise, messageLine, blocksText, resolveConfig, LIMITS } from '../memory-hub-ingest/core.mjs'
import { fakeHub, silentLog, u, a, mkCtx, long, mkPi } from './helpers.mjs'

const TOKEN = 'mh_test_token_for_unit_tests'
const mk = async (responder, { env = {}, limits, log = silentLog(), fetchImpl } = {}) => {
  const hub = await fakeHub(responder)
  const ing = createMemoryHubIngest({ env: { MEMORY_HUB_PI_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: hub.url, ...env }, log, limits, fetchImpl, io: { readFile: () => { throw new Error('no file') } } })
  return { hub, ing, log }
}
const end = async (ing, ctx, messages) => { const r = ing.onAgentEnd({ type: 'agent_end', messages }, ctx); await ing.idle(); return r }

// ---------------------------------------------------------------- 纯函数
test('stripNoise：剥 system-reminder / team / SCHEDULE REMINDER / Tool use 行，保留正文', () => {
  const t = stripNoise('前文<system-reminder>\n注入内容\n</system-reminder>后文\n<teammate-message x="1">广播</teammate-message>\n[SCHEDULE REMINDER 3 items]\n- a\n- b\n正文[Tool use: bash ls]\n结尾<system-reminder>没闭合')
  assert.ok(t.includes('前文') && t.includes('后文') && t.includes('正文') && t.includes('结尾'))
  for (const bad of ['注入内容', '广播', 'SCHEDULE', '- a', 'Tool use', '没闭合', 'system-reminder']) assert.ok(!t.includes(bad), bad)
})

test('messageLine：只取 text 块；丢 thinking/toolCall/image；非 user/assistant 与 aborted/error 助手消息为空', () => {
  const m = { role: 'assistant', content: [{ type: 'thinking', thinking: '内心戏' }, { type: 'text', text: '答案甲' }, { type: 'toolCall', name: 'bash', arguments: {} }, { type: 'image', data: 'xx' }, { type: 'text', text: '答案乙' }], stopReason: 'stop' }
  assert.equal(messageLine(m), '助手：答案甲\n答案乙')
  assert.equal(messageLine({ role: 'user', content: '字符串内容' }), '用户：字符串内容')
  assert.equal(messageLine({ role: 'toolResult', content: [{ type: 'text', text: 'x' }] }), '')
  assert.equal(messageLine({ role: 'custom', content: 'x' }), '')
  assert.equal(messageLine(a('半截话', { stopReason: 'aborted' })), '')
  assert.equal(messageLine(a('', { stopReason: 'error' })), '')
  assert.equal(blocksText(undefined), '')
})

test('resolveConfig：env 优先，其次令牌文件；文件权限过宽给 warning；都没有则不启用', () => {
  const io = { readFile: () => ' filetok \n', stat: () => ({ mode: 0o100644 }) }
  let c = resolveConfig({}, io)
  assert.deepEqual([c.enabled, c.token, c.tokenSource], [true, 'filetok', 'file'])
  assert.equal(c.warnings.length, 1)
  assert.ok(!c.warnings[0].includes('filetok'))
  c = resolveConfig({ MEMORY_HUB_PI_TOKEN: 'envtok' }, io)
  assert.deepEqual([c.token, c.tokenSource], ['envtok', 'env'])
  c = resolveConfig({}, { readFile: () => { throw new Error('ENOENT') } })
  assert.equal(c.enabled, false)
  assert.equal(c.url, 'http://127.0.0.1:7990/memory/api/ingest')
  assert.equal(resolveConfig({ MEMORY_HUB_PI_TOKEN: 'x', MEMORY_HUB_INGEST_URL: 'http://h/x' }).url, 'http://h/x')
})

// ---------------------------------------------------------------- 令牌缺失 / 子进程
test('令牌缺失：禁用 + console.warn 一次 + 不注册钩子 + 日志不含令牌', () => {
  const log = silentLog()
  const ing = createMemoryHubIngest({ env: {}, log, io: { readFile: () => { throw new Error('x') } } })
  assert.equal(ing, null)
  assert.equal(log.calls.filter((c) => c.level === 'warn').length, 1)
})

test('PI_SUBAGENT_CHILD=1：不摄入（避免子 agent 进程重复推送）', () => {
  const log = silentLog()
  assert.equal(createMemoryHubIngest({ env: { MEMORY_HUB_PI_TOKEN: TOKEN, PI_SUBAGENT_CHILD: '1' }, log }), null)
})

test('入口 index.ts：未配令牌时不注册钩子；配了令牌注册 3 个钩子且 handler 同步返回 undefined', async () => {
  const mod = await import('../memory-hub-ingest/index.ts')
  const saved = { ...process.env }
  try {
    delete process.env.MEMORY_HUB_PI_TOKEN; process.env.MEMORY_HUB_PI_TOKEN_FILE = '/nonexistent/token-file'
    const origWarn = console.warn; console.warn = () => {}
    const pi0 = mkPi(); mod.default(pi0); console.warn = origWarn
    assert.deepEqual(Object.keys(pi0.handlers), [])
    process.env.MEMORY_HUB_PI_TOKEN = TOKEN
    const pi1 = mkPi(); mod.default(pi1)
    assert.deepEqual(Object.keys(pi1.handlers).sort(), ['agent_end', 'session_shutdown', 'session_start'])
    const ret = pi1.handlers.agent_end[0]({ type: 'agent_end', messages: [] }, mkCtx())
    assert.equal(ret, undefined)
  } finally { process.env = saved }
})

// ---------------------------------------------------------------- 发送内容与协议
test('captured：发送带角色前缀的文本、project=basename(cwd)、source/session_id/seq，Bearer 令牌；成功后清空', async () => {
  const { hub, ing } = await mk()
  const ctx = mkCtx({ branch: [u('旧历史很长'.repeat(30))] })
  ing.onSessionStart({ reason: 'startup' }, ctx)
  const msgs = [u(long('问')), a(long('答'))]
  ctx.branch.push(...msgs)
  await end(ing, ctx, msgs)
  assert.equal(hub.reqs.length, 1)
  const r = hub.reqs[0]
  assert.equal(r.method, 'POST'); assert.equal(r.url, '/memory/api/ingest'); assert.equal(r.auth, `Bearer ${TOKEN}`)
  assert.equal(r.body.source, 'pi-web'); assert.equal(r.body.session_id, 'sess-1'); assert.equal(r.body.project, 'my-proj'); assert.equal(r.body.cwd, '/work/my-proj')
  assert.deepEqual([r.body.from_seq, r.body.to_seq], [1, 2]) // 基线 1 条历史 → 新消息序号 1、2
  assert.ok(r.body.text.startsWith('用户：问：') && r.body.text.includes('\n\n助手：答：'))
  assert.ok(!r.body.text.includes('旧历史'))
  assert.equal(ing._states.get('sess-1').pending.length, 0)
  await hub.close()
})

test('skipped / rejected 同样推进水位（不重发）', async () => {
  for (const body of [{ status: 'skipped', reason: 'noise_only' }, { status: 'rejected', reason: '疑似明文密钥' }]) {
    const { hub, ing } = await mk(() => ({ http: 200, body }))
    const ctx = mkCtx()
    await end(ing, ctx, [u(long('一')), a(long('二'))])
    await end(ing, ctx, [u(long('三')), a(long('四'))])
    assert.equal(hub.reqs.length, 2)
    assert.ok(!hub.reqs[1].body.text.includes('一：'), '第二次不应带上第一批')
    await hub.close()
  }
})

test('deferred：不推进，下一轮累积重发（to_seq 变大，包含两轮文本）', async () => {
  const { hub, ing } = await mk((i) => i === 0 ? { http: 200, body: { status: 'deferred', reason: 'too_short' } } : null)
  const ctx = mkCtx()
  await end(ing, ctx, [u(long('第一轮问')), a(long('第一轮答'))])
  assert.equal(ing._states.get('sess-1').pending.length, 2)
  await end(ing, ctx, [u(long('第二轮问')), a(long('第二轮答'))])
  assert.equal(hub.reqs.length, 2)
  const t = hub.reqs[1].body.text
  assert.ok(t.includes('第一轮问') && t.includes('第二轮答'))
  assert.deepEqual([hub.reqs[1].body.from_seq, hub.reqs[1].body.to_seq], [0, 3])
  assert.equal(ing._states.get('sess-1').pending.length, 0)
  await hub.close()
})

test('deferred + retry_after_s：期间的新一轮只累积不发送；到期后（定时器收尾重试）发出累积文本', async () => {
  let t = 1_000_000
  const hub = await fakeHub((i) => i === 0 ? { http: 200, body: { status: 'deferred', reason: 'cooldown', retry_after_s: 90 } } : null)
  const ing = createMemoryHubIngest({ env: { MEMORY_HUB_PI_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: hub.url }, log: silentLog(), now: () => t, io: { readFile: () => { throw new Error('x') } } })
  const ctx = mkCtx()
  await end(ing, ctx, [u(long('甲')), a(long('乙'))])
  assert.equal(hub.reqs.length, 1)
  t += 30_000
  await end(ing, ctx, [u(long('丙')), a(long('丁'))])
  assert.equal(hub.reqs.length, 1, 'retry_after 内不应再请求')
  assert.equal(ing._states.get('sess-1').pending.length, 4)
  t += 61_000
  await end(ing, ctx, [u(long('戊')), a(long('己'))])
  assert.equal(hub.reqs.length, 2)
  assert.ok(['甲：', '丁：', '己：'].every((k) => hub.reqs[1].body.text.includes(k)))
  clearTimeout(ing._states.get('sess-1').timer)
  await hub.close()
})

test('5xx：不推进；下一轮重发包含上次内容', async () => {
  const { hub, ing } = await mk((i) => i === 0 ? { http: 502, body: { status: 'error', reason: 'write_failed' } } : null)
  const ctx = mkCtx()
  await end(ing, ctx, [u(long('先')), a(long('后'))])
  assert.equal(ing._states.get('sess-1').pending.length, 2)
  await end(ing, ctx, [u(long('再')), a(long('又'))])
  assert.ok(hub.reqs[1].body.text.includes('先：'))
  assert.equal(ing._states.get('sess-1').pending.length, 0)
  await hub.close()
})

test('网络错误 / 5s 超时：不推进且不外泄异常', async () => {
  const m0 = await mk(null, { fetchImpl: async () => { throw new TypeError('fetch failed') } })
  await end(m0.ing, mkCtx(), [u(long('x')), a(long('y'))])
  assert.equal(m0.ing._states.get('sess-1').pending.length, 2)
  await m0.hub.close()
  // 超时：假 hub 不响应，缩短超时
  const hub = await fakeHub(() => ({ hang: true }))
  const ing2 = createMemoryHubIngest({ env: { MEMORY_HUB_PI_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: hub.url }, log: silentLog(), limits: { timeoutMs: 150 }, io: { readFile: () => { throw new Error('x') } } })
  const t0 = Date.now()
  await end(ing2, mkCtx(), [u(long('x')), a(long('y'))])
  assert.ok(Date.now() - t0 < 3000)
  assert.equal(ing2._states.get('sess-1').pending.length, 2)
  await hub.close()
})

test('401/403：扩展整体禁用（之后不再发请求），日志不含令牌；400 丢弃本批不卡死', async () => {
  const log = silentLog()
  const { hub, ing } = await mk(() => ({ http: 401, body: { error: 'bad' } }), { log })
  const ctx = mkCtx()
  await end(ing, ctx, [u(long('x')), a(long('y'))])
  await end(ing, ctx, [u(long('x2')), a(long('y2'))])
  assert.equal(hub.reqs.length, 1)
  assert.ok(log.calls.every((c) => !c.text.includes(TOKEN)))
  await hub.close()
  const m2 = await mk(() => ({ http: 400, body: { status: 'invalid', reason: 'x' } }))
  await end(m2.ing, mkCtx(), [u(long('x')), a(long('y'))])
  assert.equal(m2.ing._states.get('sess-1').pending.length, 0)
  await m2.hub.close()
})

// ---------------------------------------------------------------- 去重：两种 messages 语义
test('语义 A（agent_end.messages 只含本次运行）：连续两轮各发一次，不重复', async () => {
  const { hub, ing } = await mk()
  const ctx = mkCtx()
  const r1 = [u(long('一问')), a(long('一答'))]; ctx.branch.push(...r1); await end(ing, ctx, r1)
  const r2 = [u(long('二问')), a(long('二答'))]; ctx.branch.push(...r2); await end(ing, ctx, r2)
  assert.equal(hub.reqs.length, 2)
  assert.ok(!hub.reqs[1].body.text.includes('一问'))
  await hub.close()
})

test('语义 B（agent_end.messages 是整段历史）：只发新增部分；重启/reload 后不重灌历史', async () => {
  const { hub, ing } = await mk()
  const ctx = mkCtx()
  const hist = []
  const r1 = [u(long('一问')), a(long('一答'))]; hist.push(...r1); ctx.branch.push(...r1); await end(ing, ctx, hist.slice())
  const r2 = [u(long('二问')), a(long('二答'))]; hist.push(...r2); ctx.branch.push(...r2); await end(ing, ctx, hist.slice())
  assert.equal(hub.reqs.length, 2)
  assert.ok(!hub.reqs[1].body.text.includes('一问'))
  assert.deepEqual([hub.reqs[1].body.from_seq, hub.reqs[1].body.to_seq], [2, 3])
  // 模拟 /reload：全新实例，会话里已有 4 条
  const ing2 = createMemoryHubIngest({ env: { MEMORY_HUB_PI_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: hub.url }, log: silentLog(), io: { readFile: () => { throw new Error('x') } } })
  ing2.onSessionStart({ reason: 'reload' }, ctx)
  const r3 = [u(long('三问')), a(long('三答'))]; hist.push(...r3); ctx.branch.push(...r3)
  await end(ing2, ctx, hist.slice()) // 语义 B：整段历史
  assert.equal(hub.reqs.length, 3)
  assert.ok(!hub.reqs[2].body.text.includes('一问') && !hub.reqs[2].body.text.includes('二答') && hub.reqs[2].body.text.includes('三问'))
  assert.deepEqual([hub.reqs[2].body.from_seq, hub.reqs[2].body.to_seq], [4, 5])
  await hub.close()
})

test('reload 后没收到 session_start 的首个 agent_end：本轮消息仍会被推送，更早历史不会', async () => {
  const { hub, ing } = await mk()
  const old = [u(long('历史问')), a(long('历史答'))]
  const cur = [u(long('当前问')), a(long('当前答'))]
  const ctx = mkCtx({ branch: [...old, ...cur] })
  await end(ing, ctx, cur)
  assert.equal(hub.reqs.length, 1)
  assert.ok(hub.reqs[0].body.text.includes('当前问') && !hub.reqs[0].body.text.includes('历史问'))
  assert.equal(hub.reqs[0].body.from_seq, 2)
  await hub.close()
})

test('重复触发同一批消息（重放）不重复推送', async () => {
  const { hub, ing } = await mk()
  const ctx = mkCtx(); const r = [u(long('问')), a(long('答'))]
  await end(ing, ctx, r); await end(ing, ctx, r)
  assert.equal(hub.reqs.length, 1)
  await hub.close()
})

// ---------------------------------------------------------------- 去噪 / 截断 / 最小长度
test('system-reminder 等注入块在外发文本里不存在；toolResult/thinking/toolCall 不外发', async () => {
  const { hub, ing } = await mk()
  const msgs = [
    u(`<system-reminder>机密注入SECRET-INJECT</system-reminder>${long('真问题')}`),
    { role: 'assistant', stopReason: 'toolUse', timestamp: 1, content: [{ type: 'thinking', thinking: 'THINK-LEAK' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { cmd: 'TOOLARG-LEAK' } }] },
    { role: 'toolResult', toolCallId: 'c1', timestamp: 2, content: [{ type: 'text', text: 'TOOLRESULT-LEAK' }] },
    a(long('真回答')),
  ]
  await end(ing, mkCtx(), msgs)
  const t = hub.reqs[0].body.text
  for (const bad of ['SECRET-INJECT', 'THINK-LEAK', 'TOOLARG-LEAK', 'TOOLRESULT-LEAK', 'system-reminder']) assert.ok(!t.includes(bad), bad)
  assert.ok(t.includes('真问题') && t.includes('真回答'))
  await hub.close()
})

test('超长只留尾部 20000 字符；去噪后不足 60 字不发，但继续累积', async () => {
  const { hub, ing } = await mk()
  const ctx = mkCtx()
  await end(ing, ctx, [u('x'.repeat(30000) + 'TAIL-MARK')])
  assert.equal(hub.reqs.length, 1)
  assert.ok(hub.reqs[0].body.text.length <= LIMITS.maxChars)
  assert.ok(hub.reqs[0].body.text.endsWith('TAIL-MARK'))
  await hub.close()
  const m = await mk()
  const c2 = mkCtx()
  await end(m.ing, c2, [u('嗯'), a('好的')])
  assert.equal(m.hub.reqs.length, 0)
  await end(m.ing, c2, [u('<system-reminder>' + '噪'.repeat(500) + '</system-reminder>')])
  assert.equal(m.hub.reqs.length, 0)
  await end(m.ing, c2, [u(long('够长了')), a(long('是的'))])
  assert.equal(m.hub.reqs.length, 1)
  assert.ok(m.hub.reqs[0].body.text.includes('嗯') && m.hub.reqs[0].body.text.includes('好的'), '短句被累积带出')
  await m.hub.close()
})

// ---------------------------------------------------------------- 中止 / 出错
test('aborted：整轮不推送且不再累积；error 助手消息被丢但用户文本照常', async () => {
  const { hub, ing } = await mk()
  const ctx = mkCtx()
  await end(ing, ctx, [u(long('被中止的问')), a(long('半截答'), { stopReason: 'aborted' })])
  assert.equal(hub.reqs.length, 0)
  assert.equal(ing._states.get('sess-1').pending.length, 0)
  await end(ing, ctx, [u(long('出错的问')), a('', { stopReason: 'error', errorMessage: 'boom' })])
  assert.equal(hub.reqs.length, 1)
  assert.ok(hub.reqs[0].body.text.includes('出错的问') && !hub.reqs[0].body.text.includes('助手：'))
  await end(ing, ctx, [u(long('后续问')), a(long('后续答'))])
  assert.ok(!hub.reqs[1].body.text.includes('被中止的问'))
  await hub.close()
})

// ---------------------------------------------------------------- 队列 / 不阻塞 / 异常
test('队列上限：飞行中堆积超过上限，丢最旧批次并记 warn；其余批次合并发出', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const hub = await fakeHub(async (i) => { if (i === 0) await gate; return null })
  const log = silentLog()
  const ing = createMemoryHubIngest({ env: { MEMORY_HUB_PI_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: hub.url }, log, limits: { queueMax: 3 }, io: { readFile: () => { throw new Error('x') } } })
  const ctx = mkCtx()
  ing.onAgentEnd({ messages: [u(long('批0'))] }, ctx)
  await new Promise((r) => setTimeout(r, 100)) // 批0 已在飞行中（被 gate 卡住）
  for (let i = 1; i <= 6; i++) ing.onAgentEnd({ messages: [u(long(`批${i}`))] }, ctx)
  assert.equal(ing._states.get('sess-1').queue.length, 3)
  assert.ok(log.calls.some((c) => c.level === 'warn' && c.text.includes('队列已满')))
  release(); await ing.idle()
  assert.equal(hub.reqs.length, 2)
  const t = hub.reqs[1].body.text
  assert.ok(!t.includes('批1：') && !t.includes('批2：') && !t.includes('批3：') && t.includes('批4：') && t.includes('批6：'))
  await hub.close()
})

test('agent_end handler 不阻塞：hub 卡死时同步返回 undefined 且耗时极短；坏输入不抛', async () => {
  const hub = await fakeHub(() => ({ hang: true }))
  const ing = createMemoryHubIngest({ env: { MEMORY_HUB_PI_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: hub.url }, log: silentLog(), limits: { timeoutMs: 300 }, io: { readFile: () => { throw new Error('x') } } })
  const t0 = process.hrtime.bigint()
  const ret = ing.onAgentEnd({ messages: [u(long('x')), a(long('y'))] }, mkCtx())
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.equal(ret, undefined); assert.ok(ms < 50, `handler took ${ms}ms`)
  const badCtx = { cwd: 1, sessionManager: { getSessionId() { throw new Error('boom') } } }
  for (const [ev, c] of [[undefined, undefined], [null, null], [{ messages: 'x' }, mkCtx()], [{ messages: [null, 1, {}] }, mkCtx()], [{ messages: [u(long('x'))] }, badCtx], [{ messages: [u(long('x'))] }, { sessionManager: { getSessionId: () => 's', getBranch() { throw new Error('b') } } }]]) {
    assert.doesNotThrow(() => ing.onAgentEnd(ev, c))
    assert.doesNotThrow(() => ing.onSessionStart(ev, c))
    assert.doesNotThrow(() => ing.onSessionShutdown(ev, c))
  }
  await ing.idle(); await hub.close()
})

test('子会话（header.parentSession）不摄入', async () => {
  const { hub, ing } = await mk()
  await end(ing, mkCtx({ header: { type: 'session', parentSession: '/p/x.jsonl' } }), [u(long('x')), a(long('y'))])
  assert.equal(hub.reqs.length, 0)
  await hub.close()
})

test('不同 session 互不影响；同 session 串行（同一时刻最多 1 个在途请求）', async () => {
  let cur = 0, max = 0
  const hub = await fakeHub(async () => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 50)); cur--; return null })
  const ing = createMemoryHubIngest({ env: { MEMORY_HUB_PI_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: hub.url }, log: silentLog(), io: { readFile: () => { throw new Error('x') } } })
  const c1 = mkCtx({ sid: 'A' })
  for (let i = 0; i < 4; i++) ing.onAgentEnd({ messages: [u(long(`A${i}`))] }, c1)
  await ing.idle()
  assert.equal(max, 1)
  assert.equal(new Set(hub.reqs.map((r) => r.body.session_id)).size, 1)
  await hub.close()
})

test('默认日志只写 stderr、带级别、debug 默认关；不污染 stdout（json/rpc 模式的协议通道）', () => {
  const origErr = console.error, origLog = console.log, origInfo = console.info, origWarn = console.warn, origDebug = console.debug
  const err = [], other = []
  console.error = console.warn = (...x) => err.push(x.join(' ')); console.log = console.info = console.debug = (...x) => other.push(x.join(' '))
  // makeStderrLog 在创建时捕获 console.*，所以必须在替换之后创建
  try {
    const l = makeStderrLog({})
    l.debug('[memory-hub-ingest] d'); l.info('[memory-hub-ingest] i'); l.warn('[memory-hub-ingest] w'); l.error('[memory-hub-ingest] e')
    makeStderrLog({ MEMORY_HUB_PI_DEBUG: '1' }).debug('[memory-hub-ingest] d2')
  } finally { console.error = origErr; console.log = origLog; console.info = origInfo; console.warn = origWarn; console.debug = origDebug }
  assert.deepEqual(other, [])
  assert.deepEqual(err, ['[memory-hub-ingest][INFO] i', '[memory-hub-ingest][WARN] w', '[memory-hub-ingest][ERROR] e', '[memory-hub-ingest][DEBUG] d2'])
})
