// 端到端：三枚不同 owner/team 的令牌，走真实 HTTP —— 团队分层检索 + 经验闸门一起验。
//
// 为什么不是又一批单元测试：scope.js 与 gate.js 各自绿，接不上传输层照样白搭
// （identity 没带 owner/team 时，线上一切都会退化成"全算自己"，而单测看不出来）。
// 这里只走 HTTP：发令牌 → 连 MCP → 召回 → 推送 ingest，断言全部是字面量。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHub } from '../hub-helpers.mjs'
import { durableText } from '../helpers.mjs'
import { ensureVault, writeCard } from '../../src/core/vault.js'
import { closeAllDb, getDb } from '../../src/core/db.js'
import { rpc, toolText } from '../helpers.mjs'

/** 三个团队里的人：两个同团队（alice/bob）+ 一个别的团队（carol）。 */
const TOKENS = {
  alice: { owner: 'alice', team: 'remittance' },
  bob: { owner: 'bob', team: 'remittance' },
  carol: { owner: 'carol', team: 'payments' },
}

const put = (home, title, owner, team, visibility) => writeCard(home, {
  kind: 'knowledge', title,
  body: `${title} 的正文：这里写足够长的说明，让相似度去重不会把不同团队的同名卡吞掉。`,
  status: 'approved', submittedBy: owner, owner, team, visibility,
}, { dedup: false })

const ROUTINE = ['$ npm test', 'PASS 12 tests'].concat(Array.from({ length: 24 }, (_, i) => `ok ${i + 1} - 用例名称编号${i + 1}`)).join('\n')
const EXPERIENCE = [
  durableText('端到端闸门'),
  '结论：本团队优先是靠 tier 排序实现的，因为「空了才搜别的团队」在 limit 下会把位置白白浪费掉；',
  '其它团队的卡永远排在本团队后面，注意这不等于看不到它们 —— 用 scope=mine 或 scope=team 才能收窄；',
  '踩坑：正文太短会被 ingest 的 minChars 挡成 deferred，所以造案例时必须先断言长度够，否则测的是别的东西。',
].join('\n')

const post = async (h, tok, body) => {
  const res = await fetch(h.url + '/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  })
  return { http: res.status, body: await res.json().catch(() => null) }
}

test('端到端：多团队多人下的召回分层、跨团队私卡不可见、闸门丢日常操作', async () => {
  await withHub(async (h) => {
    getDb(h.home).prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','none')").run()
    await ensureVault(h.home)
    await put(h.home, '部署流程-alice自己的', 'alice', 'remittance', 'private')
    await put(h.home, '部署流程-alice团队卡', 'alice', 'remittance', 'team')
    await put(h.home, '部署流程-bob团队卡', 'bob', 'remittance', 'team')
    await put(h.home, '部署流程-carol公开卡', 'carol', 'payments', 'public')
    await put(h.home, '部署流程-carol私卡', 'carol', 'payments', 'private')
    closeAllDb()

    const tok = (who) => h.token(`claude-${who}`, ['read', 'write'], TOKENS[who])
    const tokens = { alice: tok('alice'), bob: tok('bob'), carol: tok('carol') }

    // 1) 身份来自令牌：三枚令牌各自的 whoami
    for (const who of ['alice', 'bob', 'carol']) {
      const r = await rpc(h.url, tokens[who], 'tools/call', { name: 'memory_whoami', arguments: {} })
      assert.deepEqual(JSON.parse(toolText(r)), {
        name: `claude-${who}`, owner: TOKENS[who].owner, team: TOKENS[who].team, visibility: 'team', recall_scope: 'auto',
      })
    }

    // 2) alice 召回：自己的（含私卡）→ 本团队 bob → 其它团队 carol 的公开卡；carol 的私卡不出现
    const recall = toolText(await rpc(h.url, tokens.alice, 'tools/call', { name: 'memory_recall', arguments: { query: '部署流程' } }))
    assert.deepEqual(
      recall.split('\n').filter((l) => /^### /.test(l)).map((l) => l.replace(/^### \d+\. /, '')),
      ['部署流程-alice自己的', '部署流程-alice团队卡', '部署流程-bob团队卡', '部署流程-carol公开卡'],
    )
    assert.deepEqual(recall.split('\n').filter((l) => /^\[/.test(l)), ['[自己的记忆] 2 条', '[本团队 · bob] 1 条', '[其它团队 · carol] 1 条'])

    // 3) scope 能收窄：只看自己 / 只看自己+本团队（跨团队公开卡被排除）
    const mine = toolText(await rpc(h.url, tokens.alice, 'tools/call', { name: 'memory_recall', arguments: { query: '部署流程', scope: 'mine' } }))
    assert.deepEqual(mine.split('\n').filter((l) => /^### /.test(l)).length, 2)
    const team = toolText(await rpc(h.url, tokens.alice, 'tools/call', { name: 'memory_recall', arguments: { query: '部署流程', scope: 'team' } }))
    assert.equal(team.includes('carol公开卡'), false)
    assert.equal(team.includes('bob团队卡'), true)

    // 4) bob（同团队）看得到 alice 的团队卡，看不到 alice 的私卡
    const asBob = toolText(await rpc(h.url, tokens.bob, 'tools/call', { name: 'memory_recall', arguments: { query: '部署流程' } }))
    assert.equal(asBob.includes('alice团队卡'), true)
    assert.equal(asBob.includes('alice自己的'), false)

    // 5) 闸门：alice 推纯工具输出 → skipped/routine 且两张表都不建卡；推经验 → captured
    assert.equal(EXPERIENCE.length > 300, true)
    const before = { cards: getDb(h.home).prepare('SELECT COUNT(*) n FROM cards').get().n, q: getDb(h.home).prepare('SELECT COUNT(*) n FROM quarantine').get().n }
    const skip = await post(h, tokens.alice, { source: 'dsh', session_id: 's-routine', text: ROUTINE })
    assert.deepEqual(skip, { http: 200, body: { status: 'skipped', reason: 'routine', gate: { verdict: 'routine', via: 'heuristic', score: -2, signals: ['tool-log'] } } })
    assert.deepEqual(
      { cards: getDb(h.home).prepare('SELECT COUNT(*) n FROM cards').get().n, q: getDb(h.home).prepare('SELECT COUNT(*) n FROM quarantine').get().n },
      before,
    )
    const got = await post(h, tokens.alice, { source: 'dsh', session_id: 's-exp', text: EXPERIENCE })
    assert.equal(got.body.status, 'captured')
    assert.deepEqual(
      getDb(h.home).prepare('SELECT owner, team, visibility FROM cards ORDER BY id DESC LIMIT 1').all().map((r) => [r.owner, r.team, r.visibility]),
      [['alice', 'remittance', 'team']],
    )
  }, { env: { MEMORY_HUB_GATE_INGEST: 'heuristic', MEMORY_HUB_INGEST_COOLDOWN_S: '0' } })
})
