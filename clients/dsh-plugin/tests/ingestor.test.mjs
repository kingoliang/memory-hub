// 核心逻辑：增量水位 / 噪声 / 响应语义 / 队列 / 子 agent。用真实 HTTP 假 hub，不 mock fetch。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIngestor } from '../lib/ingestor.js'
import { makeSession, makeAgent, startFakeHub, LONG, silentLog } from './helpers.mjs'

const TOKEN = 'mh_test_token_should_never_be_logged_0123456789'
const CAPTURED = { code: 200, body: { status: 'captured', cards: [{ id: 1, action: 'created', pending: true }] } }

async function withIngestor(opts, fn) {
  const hub = await startFakeHub(opts.hub || {})
  const log = silentLog()
  let t = 1_000_000
  const clock = { now: () => t, advance: (ms) => { t += ms } }
  const ing = createIngestor({ url: hub.url, token: TOKEN, log, now: clock.now, ...(opts.ing || {}) })
  try { await fn({ hub, ing, log, clock }) } finally { ing.dispose(); await hub.close() }
}
/** 触发一轮并等后台队列排空。 */
const turn = async (ing, session, n = 0) => { ing.onTurnStopping({ agent: makeAgent(session), turn: n }); await ing.idle() }

test('请求形态：Bearer 令牌 / source=dsh / project=cwd 末段 / 文本带角色前缀 / seq 范围', async () => {
  await withIngestor({ hub: { script: [CAPTURED] } }, async ({ hub, ing }) => {
    const s = makeSession({ id: 'sA', cwd: '/work/proj-a' })
    s.turnStart(0); s.user(LONG('配置')); s.assistant(LONG('回答'))
    await turn(ing, s, 0)
    assert.equal(hub.requests.length, 1)
    const r = hub.requests[0]
    assert.equal(r.method, 'POST')
    assert.equal(r.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(r.body.source, 'dsh')
    assert.equal(r.body.session_id, 'sA')
    assert.equal(r.body.project, 'proj-a')
    assert.equal(r.body.cwd, '/work/proj-a')
    assert.match(r.body.text, /^用户：这是关于配置/)
    assert.match(r.body.text, /\n助手：这是关于回答/)
    assert.equal(r.body.from_seq, 0)
    assert.equal(r.body.to_seq, 2)
  })
})

test('只采 user/assistant 的 text 块：工具输出、reasoning 块、非 user 来源的注入消息都不进文本', async () => {
  await withIngestor({ hub: { script: [CAPTURED] } }, async ({ hub, ing }) => {
    const s = makeSession()
    s.turnStart(0)
    s.user(LONG('真实提问'))
    s.user('文件变更通知：不应出现' + LONG('注入'), { kind: 'file-change' })
    s.tool('TOOLSECRET 工具输出')
    s.assistant(LONG('真实回答'), [{ type: 'reasoning', text: 'THINKSECRET' }, { type: 'tool-call', name: 'bash' }])
    await turn(ing, s)
    const t = hub.requests[0].body.text
    assert.match(t, /真实提问/); assert.match(t, /真实回答/)
    assert.doesNotMatch(t, /TOOLSECRET|THINKSECRET|文件变更通知/)
  })
})

test('噪声剥离：system-reminder / team 广播 / [Tool use:] 行不进文本；剥完不足 60 字则不发请求', async () => {
  await withIngestor({ hub: { script: [CAPTURED] } }, async ({ hub, ing }) => {
    const s = makeSession()
    s.turnStart(0)
    s.user('<system-reminder>REMINDERBODY 很长的运行时注入' + 'x'.repeat(200) + '</system-reminder>')
    s.assistant('[Tool use: bash {"cmd":"ls"}]')
    await turn(ing, s)
    assert.equal(hub.requests.length, 0, '纯噪声不发请求')
    s.user('<teammate id="t">TEAMBODY</teammate>' + LONG('正文'))
    await turn(ing, s)
    assert.equal(hub.requests.length, 1)
    assert.match(hub.requests[0].body.text, /正文/)
    assert.doesNotMatch(hub.requests[0].body.text, /REMINDERBODY|TEAMBODY|Tool use/)
  })
})

test('不足 60 字不发；水位不动，下一轮累积后一并发送', async () => {
  await withIngestor({ hub: { script: [CAPTURED] } }, async ({ hub, ing }) => {
    const s = makeSession()
    s.turnStart(0); s.user('你好'); s.assistant('嗨')
    await turn(ing, s)
    assert.equal(hub.requests.length, 0)
    s.turnStart(1); s.user(LONG('第二轮')); s.assistant(LONG('第二轮回答'))
    await turn(ing, s, 1)
    assert.equal(hub.requests.length, 1)
    assert.match(hub.requests[0].body.text, /你好/)
    assert.match(hub.requests[0].body.text, /第二轮回答/)
    assert.equal(hub.requests[0].body.from_seq, 0)
  })
})

test('增量水位：captured 推进，下一轮只发新增内容', async () => {
  await withIngestor({ hub: { script: [CAPTURED, CAPTURED] } }, async ({ hub, ing }) => {
    const s = makeSession()
    s.turnStart(0); s.user(LONG('第一轮')); s.assistant(LONG('第一轮答'))
    await turn(ing, s, 0)
    s.turnStart(1); s.user(LONG('第二轮')); s.assistant(LONG('第二轮答'))
    await turn(ing, s, 1)
    assert.equal(hub.requests.length, 2)
    const [a, b] = hub.requests.map((r) => r.body)
    assert.ok(b.from_seq > a.to_seq, `第二批 from_seq(${b.from_seq}) 必须大于第一批 to_seq(${a.to_seq})`)
    assert.doesNotMatch(b.text, /第一轮/)
    assert.match(b.text, /第二轮/)
  })
})

test('没有新增内容的轮次（水位已到末尾）不再发请求', async () => {
  await withIngestor({ hub: { script: [CAPTURED] } }, async ({ hub, ing }) => {
    const s = makeSession()
    s.turnStart(0); s.user(LONG('a')); s.assistant(LONG('b'))
    await turn(ing, s); await turn(ing, s)
    assert.equal(hub.requests.length, 1)
  })
})

test('skipped / rejected 同样推进水位', async () => {
  for (const body of [{ status: 'skipped', reason: 'not_durable' }, { status: 'rejected', reason: '疑似明文密钥（类型：x）' }]) {
    await withIngestor({ hub: { script: [{ code: 200, body }, CAPTURED] } }, async ({ hub, ing }) => {
      const s = makeSession()
      s.turnStart(0); s.user(LONG('一')); s.assistant(LONG('一答'))
      await turn(ing, s, 0)
      s.turnStart(1); s.user(LONG('二')); s.assistant(LONG('二答'))
      await turn(ing, s, 1)
      assert.doesNotMatch(hub.requests[1].body.text, /关于一/, body.status)
    })
  }
})

test('deferred：不推进；retry_after_s 内不再请求；到期后累积文本一并重发', async () => {
  const D = { code: 200, body: { status: 'deferred', reason: 'cooldown', retry_after_s: 90 } }
  await withIngestor({ hub: { script: [D, CAPTURED] } }, async ({ hub, ing, clock, log }) => {
    const s = makeSession()
    s.turnStart(0); s.user(LONG('第一轮')); s.assistant(LONG('第一轮答'))
    await turn(ing, s, 0)
    assert.equal(hub.requests.length, 1)
    // 冷却窗口内的下一轮：不请求
    clock.advance(30_000)
    s.turnStart(1); s.user(LONG('第二轮')); s.assistant(LONG('第二轮答'))
    await turn(ing, s, 1)
    assert.equal(hub.requests.length, 1, 'retry_after_s 内不空打')
    // 窗口过后：累积重发，from_seq 仍从未推进的水位起
    clock.advance(61_000)
    s.turnStart(2); s.user(LONG('第三轮')); s.assistant(LONG('第三轮答'))
    await turn(ing, s, 2)
    assert.equal(hub.requests.length, 2)
    const b = hub.requests[1].body
    assert.equal(b.from_seq, hub.requests[0].body.from_seq)
    for (const k of ['第一轮', '第二轮', '第三轮']) assert.match(b.text, new RegExp(k))
    assert.ok(log.logs.some((l) => /延后|deferred/.test(l.msg)))
  })
})

test('deferred too_short（无 retry_after_s）：不推进，下一轮立即累积重发', async () => {
  const D = { code: 200, body: { status: 'deferred', reason: 'too_short' } }
  await withIngestor({ hub: { script: [D, CAPTURED] } }, async ({ hub, ing }) => {
    const s = makeSession()
    s.turnStart(0); s.user(LONG('第一轮')); s.assistant(LONG('第一轮答'))
    await turn(ing, s, 0)
    s.turnStart(1); s.user(LONG('第二轮')); s.assistant(LONG('第二轮答'))
    await turn(ing, s, 1)
    assert.equal(hub.requests.length, 2)
    assert.match(hub.requests[1].body.text, /第一轮/)
  })
})

test('5xx / 网络错误：不推进，下一轮重发（含旧内容）', async () => {
  await withIngestor({ hub: { script: [{ code: 502, body: { status: 'error', reason: 'write_failed' } }, { destroy: true }, CAPTURED] } }, async ({ hub, ing, log }) => {
    const s = makeSession()
    s.turnStart(0); s.user(LONG('第一轮')); s.assistant(LONG('第一轮答'))
    await turn(ing, s, 0)                       // 502
    s.turnStart(1); s.user(LONG('第二轮')); s.assistant(LONG('第二轮答'))
    await turn(ing, s, 1)                       // 连接被掐
    s.turnStart(2); s.user(LONG('第三轮')); s.assistant(LONG('第三轮答'))
    await turn(ing, s, 2)                       // captured
    assert.equal(hub.requests.length, 3)
    assert.match(hub.requests[2].body.text, /第一轮/)
    assert.match(hub.requests[2].body.text, /第三轮/)
    assert.ok(log.logs.filter((l) => l.level === 'warn').length >= 2)
  })
})

test('400 不原样重试（丢弃该批并推进）；401 停用插件并告警', async () => {
  await withIngestor({ hub: { script: [{ code: 400, body: { status: 'invalid', reason: 'x' } }, CAPTURED] } }, async ({ hub, ing, log }) => {
    const s = makeSession()
    s.turnStart(0); s.user(LONG('坏批')); s.assistant(LONG('坏批答'))
    await turn(ing, s, 0)
    s.turnStart(1); s.user(LONG('好批')); s.assistant(LONG('好批答'))
    await turn(ing, s, 1)
    assert.doesNotMatch(hub.requests[1].body.text, /坏批/)
    assert.ok(log.logs.some((l) => l.level === 'error'))
  })
  await withIngestor({ hub: { script: [{ code: 401, body: {} }] } }, async ({ hub, ing, log }) => {
    const s = makeSession()
    s.turnStart(0); s.user(LONG('一')); s.assistant(LONG('一答'))
    await turn(ing, s, 0)
    s.turnStart(1); s.user(LONG('二')); s.assistant(LONG('二答'))
    await turn(ing, s, 1)
    assert.equal(hub.requests.length, 1, '401 之后停止发送')
    assert.equal(ing.enabled, false)
    assert.ok(log.logs.some((l) => l.level === 'warn' && /401|令牌/.test(l.msg)))
  })
})

test('令牌缺失：禁用 + 一条 WARN，不抛错，不发请求', async () => {
  const hub = await startFakeHub()
  const log = silentLog()
  const ing = createIngestor({ url: hub.url, token: '', log })
  assert.equal(ing.enabled, false)
  assert.equal(log.logs.filter((l) => l.level === 'warn').length, 1)
  const s = makeSession(); s.turnStart(0); s.user(LONG('x')); s.assistant(LONG('y'))
  assert.doesNotThrow(() => ing.onTurnStopping({ agent: makeAgent(s), turn: 0 }))
  await ing.idle()
  assert.equal(hub.requests.length, 0)
  await hub.close()
})

test('令牌绝不出现在任何日志里（成功 / 失败 / 网络错误路径）', async () => {
  await withIngestor({ hub: { script: [CAPTURED, { code: 500, body: {} }, { destroy: true }] } }, async ({ ing, log }) => {
    const s = makeSession()
    for (let i = 0; i < 3; i++) { s.turnStart(i); s.user(LONG('t' + i)); s.assistant(LONG('u' + i)); await turn(ing, s, i) }
    assert.ok(log.logs.length > 0)
    assert.ok(log.logs.every((l) => !l.msg.includes(TOKEN)))
  })
})

test('超长文本只留尾部（默认 20000 字符）', async () => {
  await withIngestor({ hub: { script: [CAPTURED] } }, async ({ hub, ing }) => {
    const s = makeSession()
    s.turnStart(0); s.user('HEADMARK' + 'a'.repeat(30000)); s.assistant('b'.repeat(100) + 'TAILMARK')
    await turn(ing, s)
    const t = hub.requests[0].body.text
    assert.equal(t.length, 20000)
    assert.ok(t.endsWith('TAILMARK'))
    assert.ok(!t.includes('HEADMARK'))
  })
})

test('重启基线：第一次见到会话只取"当前轮"，不重灌历史；全新会话第 0 轮完整采集', async () => {
  await withIngestor({ hub: { script: [CAPTURED, CAPTURED] } }, async ({ hub, ing }) => {
    const old = makeSession({ id: 'resumed' })
    old.turnStart(0); old.user(LONG('历史提问')); old.assistant(LONG('历史回答'))
    old.turnStart(1); old.user(LONG('历史提问二')); old.assistant(LONG('历史回答二'))
    old.turnStart(2); old.user(LONG('当前提问')); old.assistant(LONG('当前回答'))
    await turn(ing, old, 2)
    assert.equal(hub.requests.length, 1)
    assert.doesNotMatch(hub.requests[0].body.text, /历史/)
    assert.match(hub.requests[0].body.text, /当前提问/)

    const fresh = makeSession({ id: 'fresh' })
    fresh.turnStart(0); fresh.user(LONG('首轮提问')); fresh.assistant(LONG('首轮回答'))
    await turn(ing, fresh, 0)
    assert.match(hub.requests[1].body.text, /首轮提问/)
    assert.equal(hub.requests[1].body.from_seq, 0)
  })
})

test('子 agent（header.origin=subagent / delegationDepth>0）不推；用户 fork（仅有 parentSession）照推', async () => {
  await withIngestor({ hub: { script: [CAPTURED] } }, async ({ hub, ing, log }) => {
    const sub = makeSession({ id: 'child', header: { origin: 'subagent', parentSession: 'root', delegationDepth: 1 } })
    sub.turnStart(0); sub.user(LONG('子任务')); sub.assistant(LONG('子回答'))
    await turn(ing, sub)
    const depthOnly = makeSession({ id: 'child2', header: { delegationDepth: 2 } })
    depthOnly.turnStart(0); depthOnly.user(LONG('x')); depthOnly.assistant(LONG('y'))
    await turn(ing, depthOnly)
    assert.equal(hub.requests.length, 0)
    const fork = makeSession({ id: 'forked', header: { parentSession: 'root' } })
    fork.turnStart(0); fork.user(LONG('分叉会话')); fork.assistant(LONG('分叉回答'))
    await turn(ing, fork)
    assert.equal(hub.requests.length, 1)
    assert.equal(hub.requests[0].body.session_id, 'forked')
    assert.ok(!log.logs.some((l) => l.level === 'warn'))
  })
})

test('队列上限：满则丢最旧并记 WARN；丢掉的会话水位未动，下一轮可补发', async () => {
  const hub = await startFakeHub()
  const log = silentLog()
  const ing = createIngestor({ url: hub.url, token: TOKEN, log, maxQueue: 2, concurrency: 1 })
  const release = hub.holdAll()
  const sessions = ['q1', 'q2', 'q3', 'q4', 'q5'].map((id) => {
    const s = makeSession({ id }); s.turnStart(0); s.user(LONG(id)); s.assistant(LONG(id + '答')); return s
  })
  // q1 立即被取走并挂起在 hub；q2..q5 排队，容量 2 → 丢 q2、q3
  ing.onTurnStopping({ agent: makeAgent(sessions[0]), turn: 0 })
  await new Promise((r) => setTimeout(r, 50))
  for (const s of sessions.slice(1)) ing.onTurnStopping({ agent: makeAgent(s), turn: 0 })
  assert.ok(log.logs.some((l) => l.level === 'warn' && /队列已满|丢弃/.test(l.msg)), '应记丢弃日志')
  release()
  await ing.idle()
  const sent = hub.requests.map((r) => r.body.session_id)
  assert.deepEqual(sent.sort(), ['q1', 'q4', 'q5'])
  // 被丢的会话下一轮补发
  const q2 = sessions[1]; q2.turnStart(1); q2.user(LONG('q2b')); q2.assistant(LONG('q2c'))
  await turn(ing, q2, 1)
  const last = hub.requests.at(-1).body
  assert.equal(last.session_id, 'q2')
  assert.match(last.text, /q2答/)
  ing.dispose(); await hub.close()
})

test('同一会话串行：不会并发两个请求', async () => {
  const hub = await startFakeHub({ delayMs: 40 })
  const ing = createIngestor({ url: hub.url, token: TOKEN, log: silentLog(), concurrency: 4 })
  const s = makeSession()
  s.turnStart(0); s.user(LONG('一')); s.assistant(LONG('一答'))
  ing.onTurnStopping({ agent: makeAgent(s), turn: 0 })
  await new Promise((r) => setTimeout(r, 10))
  s.turnStart(1); s.user(LONG('二')); s.assistant(LONG('二答'))
  ing.onTurnStopping({ agent: makeAgent(s), turn: 1 })
  s.turnStart(2); s.user(LONG('三')); s.assistant(LONG('三答'))
  ing.onTurnStopping({ agent: makeAgent(s), turn: 2 })
  await ing.idle()
  assert.equal(hub.maxInflight(), 1)
  assert.equal(hub.requests.length, 2, '运行期间的两轮合并成一次后续请求')
  assert.match(hub.requests[1].body.text, /二/); assert.match(hub.requests[1].body.text, /三/)
  ing.dispose(); await hub.close()
})

test('fetch 超时（默认 5s，可配）→ 视为网络错误，不推进', async () => {
  const hub = await startFakeHub({ delayMs: 300, script: [CAPTURED, CAPTURED] })
  const log = silentLog()
  const ing = createIngestor({ url: hub.url, token: TOKEN, log, timeoutMs: 80 })
  const s = makeSession(); s.turnStart(0); s.user(LONG('超时')); s.assistant(LONG('超时答'))
  await turn(ing, s)
  assert.ok(log.logs.some((l) => l.level === 'warn' && /超时|timeout|网络/i.test(l.msg)))
  await turn(ing, s) // 水位没推进 → 会重发同一批
  assert.equal(hub.requests.length, 2)
  assert.equal(hub.requests[1].body.to_seq, hub.requests[0].body.to_seq)
  ing.dispose(); await hub.close()
})

test('onTurnStopping 同步返回（不返回 Promise）且不等待网络；会话取数异常不外泄', async () => {
  const hub = await startFakeHub()
  const release = hub.holdAll()
  const ing = createIngestor({ url: hub.url, token: TOKEN, log: silentLog() })
  const s = makeSession(); s.turnStart(0); s.user(LONG('阻塞')); s.assistant(LONG('阻塞答'))
  const t0 = Date.now()
  const ret = ing.onTurnStopping({ agent: makeAgent(s), turn: 0 })
  assert.equal(ret, undefined)
  assert.ok(Date.now() - t0 < 20)
  const boom = { id: 'x', session: { id: 'x', header: {}, ownEvents() { throw new Error('boom') }, snapshotEvents() { throw new Error('boom2') } } }
  assert.doesNotThrow(() => ing.onTurnStopping({ agent: boom, turn: 0 }))
  assert.doesNotThrow(() => ing.onTurnStopping({ agent: null, turn: 0 }))
  assert.doesNotThrow(() => ing.onTurnStopping(undefined))
  release(); await ing.idle(); ing.dispose(); await hub.close()
})

test('取事件接口回退：ownEvents 缺失时用 snapshotEvents，再不行用 events 数组', async () => {
  await withIngestor({ hub: { script: [CAPTURED, CAPTURED] } }, async ({ hub, ing }) => {
    const s = makeSession({ id: 'fb1' }); s.turnStart(0); s.user(LONG('回退一')); s.assistant(LONG('回退一答'))
    delete s.ownEvents
    await turn(ing, s)
    const s2 = makeSession({ id: 'fb2' }); s2.turnStart(0); s2.user(LONG('回退二')); s2.assistant(LONG('回退二答'))
    delete s2.ownEvents; delete s2.snapshotEvents
    await turn(ing, s2)
    assert.equal(hub.requests.length, 2)
  })
})
