// 变异加固：把靶区里"改掉却不被发现"的地方钉住。
//
// 来源是 scripts/quality/mutate.mjs 的一次全量跑：151 个变异体、36 个存活。
// 逐条triage 之后分两类：
//   A. 真缺口 → 这里补断言（边界值、分支、常量本身、传给模型的参数）
//   B. 等价变异体 → 在这里以注释写明为什么不需要补测试（不许硬凑）
//
// 断言风格照旧：期望值写死为字面量，整值比对。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_VISIBILITY, visibleTiers, tierOf, rankHits, tierLabel } from '../src/core/scope.js'
import { GATE_SYSTEM, heuristicGate, gateText, llmGate, KEEP_SCORE, DROP_SCORE } from '../src/core/gate.js'

const KINGO = { owner: 'kingo', team: 'remittance' }
const HIT = (over) => ({ path: 'p', score: 1, mtime: 1, owner: 'alice', team: 'remittance', visibility: 'team', ...over })

// ───────────────────────────────────────────── scope：常量与兜底
// （scope.js 里两处 "非法值兜底" 是冗余的：非法 scope 在 rankHits 与 visibleTiers 各兜一次，
//   所以只改一处不会改变行为 —— 归为等价变异体，这里锁住"非法 = auto"这个契约即可。）

test('DEFAULT_VISIBILITY 是 team（tierOf 的缺省可见性来源）', () => {
  assert.equal(DEFAULT_VISIBILITY, 'team')
})

test('非法 scope 按 auto 处理（不是按 mine，也不是丢空）', () => {
  assert.deepEqual(visibleTiers('bogus'), ['self', 'team', 'public'])
  assert.deepEqual(rankHits([HIT({ path: 'x' })], KINGO, 'bogus').map((h) => h.path), ['x'])
})

test('rankHits 省略 scope 等同于 auto', () => {
  const hits = [HIT({ path: 'own', owner: 'kingo' }), HIT({ path: 'other', owner: 'bob', team: 'payments', visibility: 'public' })]
  assert.deepEqual(rankHits(hits, KINGO).map((h) => h.path), rankHits(hits, KINGO, 'auto').map((h) => h.path))
  assert.deepEqual(rankHits(hits, KINGO).map((h) => h.tier), ['self', 'public'])
})

test('卡片没写 visibility 时按 team 兜底：同团队可见、跨团队不可见', () => {
  assert.deepEqual(
    [tierOf({ owner: 'alice', team: 'remittance' }, KINGO), tierOf({ owner: 'alice', team: 'payments' }, KINGO)],
    ['team', null],
  )
})

test('score 缺失按 0 参与比较（不是按 1，否则无分会莫名排前面）', () => {
  const hits = [HIT({ path: 'no-score', score: undefined, mtime: 1 }), HIT({ path: 'zero', score: 0, mtime: 2 })]
  // 两者都视作 0 → 退化到 mtime 降序 → mtime 更大的 zero 在前
  assert.deepEqual(rankHits(hits, KINGO, 'team').map((h) => h.path), ['zero', 'no-score'])
})

test('tierLabel 对未知 owner 与未知 tier 都有话可说', () => {
  assert.deepEqual(
    [tierLabel('team', {}), tierLabel('public', { owner: 'bob' }), tierLabel('zzz', {})],
    ['本团队 · 未知', '其它团队 · bob', '其它'],
  )
})

// ───────────────────────────────────────────── gate：阈值边界

test('打分恰好等于阈值时就走对应分支（>= / <= 的等号不是装饰）', () => {
  // marker 单独命中 = +2 = KEEP_SCORE → experience（不是 unknown）
  const keep = '结论：这条只有标记信号。'
  assert.deepEqual(heuristicGate(keep), { verdict: 'experience', score: KEEP_SCORE, signals: ['marker'] })
  // status-only 单独命中 = -2 = DROP_SCORE → routine（不是 unknown）
  const drop = '跑了一遍，全绿。'
  assert.deepEqual(heuristicGate(drop), { verdict: 'routine', score: DROP_SCORE, signals: ['status-only'] })
})

test('工具输出占比：必须同时满足"至少 3 行"和"占比 ≥ 一半"', () => {
  // 只有 2 行：即使全是工具输出也不算（行数太少，看不出是"一段日志"）
  assert.deepEqual(heuristicGate(['$ npm test', 'PASS 1 test'].join('\n')).signals, [])
  // 4 行里 2 行工具输出 = 恰好一半 → 命中
  assert.deepEqual(heuristicGate(['$ npm test', 'PASS 1 test', '这是说明行', '另一行说明'].join('\n')).signals, ['tool-log'])
  // diff 三连（+++ / --- / @@）也要被认出来
  assert.deepEqual(
    heuristicGate(['+++ b/file.js', '--- a/file.js', '@@ -1,2 +1,2 @@', '+ 新增一行', '- 删掉一行'].join('\n')).signals,
    ['artifact', 'tool-log'],
  )
})

test('畸形输入：不抛、按 routine、score 与 signals 都是空', () => {
  assert.deepEqual([heuristicGate(0), heuristicGate({})], [
    { verdict: 'routine', score: 0, signals: [] },
    { verdict: 'routine', score: 0, signals: [] },
  ])
})

// ───────────────────────────────────────────── gate：与模型之间的契约

test('闸门提示词每行都非空，并写明输出格式与字数上限', () => {
  const lines = GATE_SYSTEM.split('\n')
  assert.deepEqual(lines.map((l) => l.length > 0), [true, true, true, true, true])
  assert.equal(lines[0].startsWith('你在做「记忆入库闸门」判定'), true)
  assert.equal(lines.some((l) => l.includes('不超过 20 字')), true)
  assert.equal(lines.some((l) => l.includes('不算经验')), true)
})

/** 记录 llmGate 实际发出去的请求，并让测试决定流什么内容回去。 */
const spyLlm = (yielded) => {
  const seen = {}
  return {
    seen,
    timeoutMs: 5000,
    async *stream(options) {
      seen.system = options.system
      seen.messages = options.messages
      seen.maxTokens = options.maxTokens
      for (const y of yielded) { yield y }
    },
  }
}

test('llmGate 把提示词、user 角色、maxTokens 原样发给模型', async () => {
  const llm = spyLlm(['{"keep":true,"reason":"ok"}'])
  assert.deepEqual(await llmGate(llm, '待判文本'), { keep: true, reason: 'ok' })
  assert.equal(llm.seen.system, GATE_SYSTEM)
  assert.deepEqual(llm.seen.messages.map((m) => [m.role, m.content]), [['user', '待判文本']])
  assert.equal(llm.seen.maxTokens, 120)
})

test('llmGate 认得 {type:"text"} 形式的流式块（不只是裸字符串）', async () => {
  const llm = spyLlm([{ type: 'text', text: '```json\n{"keep": false, "reason": "只是名词解释"}\n```' }, { type: 'finish' }])
  assert.deepEqual(await llmGate(llm, '待判文本'), { keep: false, reason: '只是名词解释' })
})

test('gateText 的 mode 缺省与非法值都落到 heuristic', async () => {
  assert.equal((await gateText('跑了一遍，全绿。')).via, 'heuristic')
  assert.deepEqual(
    (({ verdict, via }) => ({ verdict, via }))(await gateText(['$ npm test', 'PASS 1 test', 'ok 1 - a'].join('\n'), { mode: 'bogus' })),
    { verdict: 'routine', via: 'heuristic' },
  )
})
