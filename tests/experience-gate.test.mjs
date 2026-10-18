// memory-hub · 经验闸门（只让「提炼过的、经验性质」的内容入库）
//
// 断言风格：期望 verdict / score / signals 全是字面量；signals 用 deepEqual 整值比
// （子串断言对「包裹型」变异体免疫，见 playbook 坑八）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHub } from './hub-helpers.mjs'
import { durableText } from './helpers.mjs'
import { GATE_MODES, VERDICTS, EXPERIENCE_SIGNALS, ROUTINE_SIGNALS, ROUTINE_REASON, KEEP_SCORE, DROP_SCORE, heuristicGate, llmGate, gateText } from '../src/core/gate.js'

/** 纯工具输出（全行都是命令 / 用例结果）。 */
const TOOL_LOG = [
  '$ npm test', 'PASS 12 tests',
  'ok 1 - 启动服务', 'ok 2 - 校验令牌', 'ok 3 - 剥离噪声', 'ok 4 - 写入卡片',
  'ok 5 - 幂等重放', 'ok 6 - 冷却窗口', 'ok 7 - 每日配额', 'ok 8 - 大 body 拒绝',
  'ok 9 - 去重命中', 'ok 10 - 审核闸门',
].join('\n')

/** 不得少于 300 字符的纯工具输出（过得了 ingest 的 minChars 闸）。 */
const LONG_TOOL_LOG = [
  '$ npm test', 'PASS 368 tests',
  ...Array.from({ length: 24 }, (_, i) => `ok ${i + 1} - 用例名称编号${i + 1}`),
].join('\n')

const DECISION = '结论：busy_timeout 必须用 PRAGMA 设，因为构造参数在 Node 22 上不存在，会导致并发写直接 SQLITE_BUSY。'
const LESSON = '踩坑：Stryker 只在结束时写报告，被超时杀掉就一无所得；对策是分批串行跑，每批控制在 10 分钟内。'
const PROCEDURE = '部署流程：先把 MEMORY_LLM_BASE_URL 写进 deploy/env，再重启服务；注意不要启动两次，否则会抢锁。'
const NEUTRAL = 'Memory hub 用了 SQLite。'

// 片段用字面量拼出来，避免手写长串时看不出断句
const STATUS_REPORT = ['跑了一遍', ' npm test，全绿。又看了一下', ' src 目录，文件都在。'].join('')
const CHATTER = '好的，收到。'

// ─────────────────────────────────────────────────────────── 常量

test('闸门常量是完整集合', () => {
  assert.deepEqual(GATE_MODES, ['off', 'heuristic', 'strict'])
  assert.deepEqual(VERDICTS, ['routine', 'unknown', 'experience'])
  assert.deepEqual(EXPERIENCE_SIGNALS, ['marker', 'causal', 'decision', 'lesson', 'reusable', 'artifact', 'quantity'])
  assert.deepEqual(ROUTINE_SIGNALS, ['tool-log', 'status-only', 'chatter'])
  assert.equal(KEEP_SCORE, 2)
  assert.equal(DROP_SCORE, -2)
  assert.equal(ROUTINE_REASON, 'gate:routine')
})

// ─────────────────────────────────────────────────────────── 启发式分类（字面量表）

const CASES = [
  ['纯工具输出 → routine', TOOL_LOG, 'routine', ['tool-log'], -2],
  ['纯状态汇报 → routine', STATUS_REPORT, 'routine', ['status-only'], -2],
  ['寒暄 → routine', CHATTER, 'routine', ['chatter'], -2],
  ['决策 + 因果 + 约束 → experience', DECISION, 'experience', ['causal', 'lesson', 'marker', 'reusable'], 6],
  ['踩坑 + 对策 + 数值 → experience', LESSON, 'experience', ['decision', 'lesson', 'quantity'], 5],
  ['流程 + 注意 + 路径 → experience', PROCEDURE, 'experience', ['artifact', 'causal', 'lesson', 'reusable'], 5],
  ['无信号 → unknown', NEUTRAL, 'unknown', [], 0],
]

test('heuristicGate：verdict / signals / score 全部写死比对', () => {
  assert.deepEqual(
    CASES.map(([, text]) => {
      const r = heuristicGate(text)
      return `${r.verdict}|${r.score}|${r.signals.join(',')}`
    }),
    CASES.map(([, , verdict, signals, score]) => `${verdict}|${score}|${signals.join(',')}`),
  )
})

test('heuristicGate：畸形输入不抛异常', () => {
  assert.deepEqual(
    [undefined, null, '', 0, {}, [], '   '].map((x) => heuristicGate(x).verdict),
    ['routine', 'routine', 'routine', 'routine', 'routine', 'routine', 'routine'],
  )
})

test('heuristicGate：signals 按字面量字典序返回，且不与文本顺序相关', () => {
  assert.deepEqual(heuristicGate(`${LESSON}\n${DECISION}`).signals, ['causal', 'decision', 'lesson', 'marker', 'quantity', 'reusable'])
})

// ─────────────────────────────────────────────────────────── 假 LLM

const fakeLlm = (payload, { throws = false, raw = null } = {}) => ({
  purpose: 'gate', timeoutMs: 5000,
  listProviders() { return [{ id: 'fake' }] },
  async listModels() { return [{ id: 'fake' }] },
  async *stream() {
    if (throws) throw new Error('boom')
    yield raw ?? JSON.stringify(payload)
    yield { type: 'finish', reason: { kind: 'stop' }, finishReason: 'stop', usage: null }
  },
})

// ─────────────────────────────────────────────────────────── gateText 各模式

test('mode=off：不过闸，一切放行', async () => {
  assert.deepEqual(
    (({ verdict, via, score, signals }) => ({ verdict, via, score, signals }))(await gateText(TOOL_LOG, { mode: 'off' })),
    { verdict: 'experience', via: 'off', score: 0, signals: [] },
  )
})

test('mode=heuristic：明确 routine 丢掉，unknown 放行（capture 是显式意图）', async () => {
  assert.deepEqual(
    (({ verdict, via }) => ({ verdict, via }))(await gateText(TOOL_LOG, { mode: 'heuristic' })),
    { verdict: 'routine', via: 'heuristic' },
  )
  assert.deepEqual(
    (({ verdict, via }) => ({ verdict, via }))(await gateText(NEUTRAL, { mode: 'heuristic' })),
    { verdict: 'experience', via: 'heuristic' },
  )
})

test('mode=strict：unknown 交给 LLM 判，keep:false → routine，keep:true → experience', async () => {
  assert.deepEqual(
    (({ verdict, via, reason }) => ({ verdict, via, reason }))(await gateText(NEUTRAL, { mode: 'strict', llm: fakeLlm({ keep: false, reason: '只是名词解释' }) })),
    { verdict: 'routine', via: 'llm', reason: '只是名词解释' },
  )
  assert.deepEqual(
    (({ verdict, via }) => ({ verdict, via }))(await gateText(NEUTRAL, { mode: 'strict', llm: fakeLlm({ keep: true, reason: '含结论' }) })),
    { verdict: 'experience', via: 'llm' },
  )
})

test('mode=strict：明确 routine 时根本不调 LLM', async () => {
  const llm = fakeLlm({ keep: true })
  let calls = 0
  const spy = { ...llm, async *stream(o) { calls++; yield* llm.stream(o) } }
  assert.equal((await gateText(TOOL_LOG, { mode: 'strict', llm: spy })).via, 'heuristic')
  assert.equal(calls, 0)
})

test('mode=strict：LLM 缺失或抛错时降级为启发式（不因 LLM 抖动丢内容）', async () => {
  assert.deepEqual(
    (({ verdict, via }) => ({ verdict, via }))(await gateText(NEUTRAL, { mode: 'strict', llm: null })),
    { verdict: 'experience', via: 'heuristic' },
  )
  assert.deepEqual(
    (({ verdict, via }) => ({ verdict, via }))(await gateText(NEUTRAL, { mode: 'strict', llm: fakeLlm(null, { throws: true }) })),
    { verdict: 'experience', via: 'heuristic' },
  )
})

test('llmGate：解析裸 JSON、```json 围栏、中文键；不可解析返回 null', async () => {
  assert.deepEqual(await llmGate(fakeLlm({ keep: false, reason: 'r' }), NEUTRAL), { keep: false, reason: 'r' })
  assert.deepEqual(await llmGate(fakeLlm(null, { raw: '```json\n{"keep": true, "reason": "ok"}\n```' }), NEUTRAL), { keep: true, reason: 'ok' })
  assert.deepEqual(await llmGate(fakeLlm(null, { raw: '{"keep": false, "reason": ""}' }), NEUTRAL), { keep: false, reason: '' })
  assert.equal(await llmGate(fakeLlm(null, { raw: '不是 JSON' }), NEUTRAL), null)
  assert.equal(await llmGate(null, NEUTRAL), null)
})

// ─────────────────────────────────────────────────────────── ingest 接线

const post = async (h, tok, body, path = '/api/ingest') => {
  const res = await fetch(h.url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const REQ = (text, session = 's-gate') => ({ source: 'dsh', session_id: session, text })

/** 一段足够长（>300，过 ingest 的 minChars）且启发式判为 experience 的文本。 */
const EXPERIENCE_TEXT = [
  durableText('闸门接线'),
  '另外：结论是采用「启发式 + LLM」双闸，因为单靠正则拦不住日常操作；',
  '需要注意 LLM 不可用时应当降级为启发式而不是全放行，否则一次网络抖动就会把日常操作全放进来；',
  '步骤是先跑启发式，只有 unknown 才问模型，模型判 routine 就直接丢，且不消耗冷却窗口。',
  '另外要把判定的 via / score / signals 写进响应，否则事后无法判断闸门是不是卡太严。',
].join('\n')

test('ingest：日常操作被闸门丢弃（skipped/routine 且不建卡），经验文本照常建卡', async () => {
  await withHub(async (h) => {
    h.db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','none')").run()
    const tok = h.token('gate-agent', 'write')
    assert.equal(LONG_TOOL_LOG.length > 300, true)

    const routine = await post(h, tok, REQ(LONG_TOOL_LOG))
    assert.deepEqual({ http: routine.status, body: routine.json }, { http: 200, body: { status: 'skipped', reason: 'routine', gate: { verdict: 'routine', via: 'heuristic', score: -2, signals: ['tool-log'] } } })
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM cards').get().n, 0)
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM quarantine').get().n, 0)

    const exp = await post(h, tok, REQ(EXPERIENCE_TEXT, 's-gate-2'))
    assert.equal(exp.json.status, 'captured')
    assert.equal(h.db().prepare('SELECT COUNT(*) n FROM cards').get().n, 1)
  }, { env: { MEMORY_HUB_GATE_INGEST: 'heuristic', MEMORY_HUB_INGEST_COOLDOWN_S: '0' } })
})

test('ingest：闸门丢弃不消耗冷却（下一条经验文本立刻能过）', async () => {
  await withHub(async (h) => {
    h.db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','none')").run()
    const tok = h.token('gate-agent2', 'write')
    const counts = () => h.db().prepare('SELECT counted FROM ingest_log ORDER BY id').all().map((r) => r.counted)

    await post(h, tok, REQ(LONG_TOOL_LOG, 's-cd'))
    assert.deepEqual(counts(), [0])
    const exp = await post(h, tok, REQ(EXPERIENCE_TEXT, 's-cd'))
    assert.equal(exp.json.status, 'captured')
    assert.deepEqual(counts(), [0, 1])
  }, { env: { MEMORY_HUB_GATE_INGEST: 'heuristic', MEMORY_HUB_INGEST_COOLDOWN_S: '60' } })
})
