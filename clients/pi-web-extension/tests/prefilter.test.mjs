// 本地预筛：纯工具输出的那一轮不发请求。
//
// 判定权在服务端（src/core/gate.js），客户端只是省钱；所以这里额外做一次**对拍**：
// 客户端判"不推"的样本，服务端必须也判 routine，否则客户端就在丢服务端想留的内容。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryHubIngest, shouldPushLocally, LIMITS } from '../memory-hub-ingest/core.mjs'
import { heuristicGate } from '../../../src/core/gate.js'
import { fakeHub, silentLog, u, a, mkCtx, mkPi } from './helpers.mjs'

const TOKEN = 'mh_test_token_for_unit_tests'

/** 与服务端测试同一形状的纯工具输出（够长、全是工具行）。 */
const TOOL_LOG = ['$ npm test', 'PASS 12 tests']
  .concat(Array.from({ length: 12 }, (_, i) => `ok ${i + 1} - 用例名称编号${i + 1}`)).join('\n')

// 必须 > LIMITS.minChars（60），否则客户端只会继续累积、不发请求 —— 测的就不是预筛了
const EXPERIENCE = '结论：本团队优先靠 tier 排序，因为「空了才搜别的团队」会在 limit 下浪费位置；注意其它团队的公开卡仍可能出现在结果末尾，用 scope=team 才能排除。'

const mk = async (responder, { env = {}, limits } = {}) => {
  const hub = await fakeHub(responder)
  const log = silentLog()
  const ing = createMemoryHubIngest({ env: { MEMORY_HUB_PI_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: hub.url, ...env }, log, limits, io: { readFile: () => { throw new Error('no file') } } })
  return { hub, ing, log }
}
const end = async (ing, ctx, messages) => { ing.onAgentEnd({ type: 'agent_end', messages }, ctx); await ing.idle() }

// ---------------------------------------------------------------- 纯函数

test('shouldPushLocally：纯工具输出 → 不推；有经验信号 / 行太少 / 工具行不够 → 推', () => {
  assert.deepEqual(shouldPushLocally(TOOL_LOG), { push: false, reason: 'tool-log' })
  assert.deepEqual(shouldPushLocally(EXPERIENCE), { push: true, reason: 'has-signal' })
  // 工具行但带一个经验词 → 交给服务端判（宁可漏丢不可错丢）
  assert.deepEqual(shouldPushLocally(`${TOOL_LOG}\n结论：这就是经验。`), { push: true, reason: 'has-signal' })
  // 行数不够（单行命令）
  assert.deepEqual(shouldPushLocally(['$ npm test', 'PASS 1 test'].join('\n')), { push: true, reason: 'too-few-lines' })
  // 行数够但不是"几乎全是工具行"
  assert.deepEqual(shouldPushLocally(['$ npm test', 'PASS 1 test', '第一行说明', '第二行说明', '第三行说明'].join('\n')), { push: true, reason: 'not-all-tool-lines' })
})

test('对拍服务端：客户端判"不推"的样本，服务端也必须是 routine', () => {
  assert.deepEqual(heuristicGate(TOOL_LOG), { verdict: 'routine', score: -2, signals: ['tool-log'] })
  assert.equal(heuristicGate(EXPERIENCE).verdict, 'experience')
  // 阈值方向也要一致：客户端的"工具行比例"门槛不能比服务端松，否则会丢服务端想留的
  assert.ok(LIMITS.prefilterToolRatio >= 0.5)
})

// ---------------------------------------------------------------- 接线

/** 断言失败也要关掉假 hub，否则进程挂住（上一次整个测试进程就是这么卡死的）。 */
const withIngest = async (responder, opts, fn) => {
  const { hub, ing } = await mk(responder, opts)
  try { await fn(hub, ing) } finally { await hub.close() }
}

test('样本前提：经验样本长度越过客户端 minChars（否则测的是累积，不是预筛）', () => {
  assert.equal(EXPERIENCE.length > LIMITS.minChars, true)
})

test('纯工具输出的一轮：0 个请求，且水位推进（下一轮不带上它）', async () => {
  await withIngest(undefined, {}, async (hub, ing) => {
    const ctx = mkCtx()
    await end(ing, ctx, [u(TOOL_LOG)])
    assert.equal(hub.reqs.length, 0)
    assert.equal(ing._states.get('sess-1').pending.length, 0)

    await end(ing, ctx, [u(EXPERIENCE)])
    assert.equal(hub.reqs.length, 1)
    assert.equal(hub.reqs[0].body.text.includes('npm test'), false)
    assert.equal(hub.reqs[0].body.text.includes('本团队优先'), true)
  })
})

test('MEMORY_HUB_PI_PREFILTER=off：每一轮都交给服务端判', async () => {
  await withIngest(undefined, { env: { MEMORY_HUB_PI_PREFILTER: 'off' } }, async (hub, ing) => {
    await end(ing, mkCtx(), [u(TOOL_LOG)])
    assert.equal(hub.reqs.length, 1)
    assert.equal(hub.reqs[0].body.text.includes('npm test'), true)
  })
})

test('deferred 后照常累积重发：预筛不会把已累积的经验文本丢掉', async () => {
  let n = 0
  const responder = () => (++n === 1 ? { http: 200, body: { status: 'deferred', reason: 'too_short' } } : { http: 200, body: { status: 'captured' } })
  await withIngest(responder, {}, async (hub, ing) => {
    const ctx = mkCtx()
    await end(ing, ctx, [u(EXPERIENCE)])
    await end(ing, ctx, [a(EXPERIENCE)])
    assert.equal(hub.reqs.length, 2)
    // 第二次请求带着第一轮（被 deferred）的文本一起发
    assert.equal(hub.reqs[1].body.text.split('本团队优先').length - 1, 2)
  })
})
