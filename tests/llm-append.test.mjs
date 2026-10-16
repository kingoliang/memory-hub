// 蒸馏返回 {append_to, update}（无 save 字段）：真正追加到已有主库卡，而不是静默落 raw。
// 目标无效 → 新建（非 raw）并 WARN；密钥内容拒绝；审核模式 none/all；ingest 幂等重放不重复追加。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { withHub } from './hub-helpers.mjs'
import { durableText, logSink } from './helpers.mjs'
import { createOpenAiLlm } from '../src/core/llm-openai.js'
import { runStandaloneCapture } from '../src/core/capture-run.js'
import { writeCard, softDeleteCardSync } from '../src/core/vault.js'
import { detectSecrets } from '../src/core/tidy.js'
import { createLogger } from '../src/logger.js'

const UPDATE = '补充结论：阶梯重试后仍失败的请求需要记录诊断字段，便于事后排查。'
const appendReply = (path, update = UPDATE) => JSON.stringify({ append_to: path, update })

async function fakeServer(reply) {
  const seen = []
  const srv = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    seen.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof reply === 'function' ? reply() : reply }, finish_reason: 'stop' }] }))
  }).listen(0, '127.0.0.1')
  await new Promise((r) => srv.on('listening', r))
  return { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, seen, close: () => new Promise((r) => srv.close(r)) }
}
const setAudit = (h, mode) => h.db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode', ?)").run(mode)
const mkTarget = (h) => writeCard(h.home, { kind: 'knowledge', title: '蒸馏重试方案总览', body: '# 蒸馏重试方案总览\n\n- 推理模型的思考会吃掉输出预算，导致空输出。\n- 重试阶梯按两倍递增直到上限。', status: 'approved', submittedBy: 'seed' }, { dedup: false }).then((r) => r.path)
const run = (h, srv, sink, text = durableText('追加路径')) => runStandaloneCapture(h.home, text, { llm: createOpenAiLlm({ baseUrl: srv.baseUrl, model: 'm' }), submittedBy: 'a', log: createLogger({ level: 'debug', stream: sink.stream }) })
const rows = (h, sql, ...a) => h.db().prepare(sql).all(...a)

test('append_to 指向主库已有卡：真实追加（auditMode=none → 合并进正文），不新建、不落 raw', async () => {
  const sink = logSink()
  const srv = await fakeServer(() => appendReply(target))
  let target
  try {
    await withHub(async (h) => {
      target = await mkTarget(h)
      setAudit(h, 'none')
      const out = await run(h, srv, sink)
      assert.equal(out.ok, true)
      assert.equal(out.action, 'appended')
      assert.equal(out.path, target)
      assert.ok(!out.degraded, JSON.stringify(out))
      assert.equal(out.merged, 1)
      const card = rows(h, 'SELECT body FROM cards WHERE path = ?', target)[0]
      assert.ok(card.body.includes('补充结论：阶梯重试后仍失败'))
      assert.equal(rows(h, 'SELECT COUNT(*) n FROM quarantine')[0].n, 0, '不得新建 raw / 待审卡')
      assert.equal(rows(h, 'SELECT COUNT(*) n FROM cards')[0].n, 1)
    })
  } finally { await srv.close() }
})

test('auditMode=all：不改已批准卡正文，追加为更新记录（card_updates），仍不新建卡', async () => {
  const sink = logSink()
  let target
  const srv = await fakeServer(() => appendReply(target))
  try {
    await withHub(async (h) => {
      target = await mkTarget(h)
      setAudit(h, 'all')
      const before = rows(h, 'SELECT id, body FROM cards WHERE path = ?', target)[0]
      const out = await run(h, srv, sink)
      assert.equal(out.action, 'appended')
      assert.ok(!out.degraded)
      assert.equal(rows(h, 'SELECT body FROM cards WHERE path = ?', target)[0].body, before.body)
      const ups = rows(h, 'SELECT content FROM card_updates WHERE card_id = ?', before.id)
      assert.equal(ups.length, 1)
      assert.ok(ups[0].content.includes('补充结论'))
      assert.equal(rows(h, 'SELECT COUNT(*) n FROM quarantine')[0].n, 0)
    })
  } finally { await srv.close() }
})

test('append_to 指向不存在 / 已删除 / 待审卡：降级为「新建」（非 raw）并 WARN，不追加到那张卡', async () => {
  for (const kind of ['missing', 'deleted', 'pending']) {
    const sink = logSink()
    let target
    const srv = await fakeServer(() => appendReply(target))
    try {
      await withHub(async (h) => {
        if (kind === 'missing') target = '03-Knowledge/不存在的卡.md'
        else if (kind === 'deleted') { target = await mkTarget(h); softDeleteCardSync(h.db(), target) }
        else target = (await writeCard(h.home, { kind: 'knowledge', title: '待审中的卡标题', body: '# 待审中的卡标题\n\n正文内容足够长的一段话。', status: 'pending', submittedBy: 'x' }, { dedup: false })).path
        setAudit(h, 'all')
        const out = await run(h, srv, sink)
        assert.equal(out.action, 'created', kind)
        assert.ok(!out.degraded, `${kind}: 应是新建而不是 raw`)
        const created = rows(h, 'SELECT tags, body FROM quarantine WHERE path = ?', out.path)[0]
        assert.ok(!JSON.parse(created.tags).includes('raw'), kind)
        assert.ok(created.body.includes('补充结论'))
        assert.equal(rows(h, 'SELECT COUNT(*) n FROM card_updates')[0].n, 0, '不得往无效目标追加')
        const w = sink.lines().map((l) => JSON.parse(l)).find((r) => r.level === 'WARN' && /追加目标无效/.test(r.msg))
        assert.ok(w, `${kind}: ${sink.text()}`)
      })
    } finally { await srv.close() }
  }
})

test('update 含疑似明文密钥：拒绝追加（目标卡不变），降级落原文卡并 WARN，日志不含密钥', async () => {
  const secretUpdate = '补充：接入时配置 api_key = "Ab12Cd34Ef56Gh78Ij90" 即可使用。'
  assert.ok(detectSecrets(secretUpdate).length > 0, '测试前提：该文本必须被密钥检测命中')
  const sink = logSink()
  let target
  const srv = await fakeServer(() => appendReply(target, secretUpdate))
  try {
    await withHub(async (h) => {
      target = await mkTarget(h)
      setAudit(h, 'none')
      const before = rows(h, 'SELECT body FROM cards WHERE path = ?', target)[0].body
      const out = await run(h, srv, sink)
      assert.equal(out.degraded, true)
      assert.equal(rows(h, 'SELECT body FROM cards WHERE path = ?', target)[0].body, before)
      assert.equal(rows(h, 'SELECT COUNT(*) n FROM card_updates')[0].n, 0)
      assert.ok(sink.lines().map((l) => JSON.parse(l)).some((r) => r.level === 'WARN' && /密钥/.test(r.msg)))
      assert.ok(!sink.text().includes('Ab12Cd34Ef56Gh78Ij90'))
      assert.ok(!JSON.stringify(rows(h, 'SELECT * FROM quarantine')).includes('Ab12Cd34Ef56Gh78Ij90'))
    })
  } finally { await srv.close() }
})

// -- ingest：幂等 + write_log -------------------------------------------------
const post = async (h, tok, body) => {
  const res = await fetch(h.url + '/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}
const convo = (t) => `用户：帮我定一下${t}的做法\n助手：${durableText(t, 1)}\n用户：好的，就按这个来\n助手：已记录，${durableText(t + '补充', 1)}`

for (const [mode, action] of [['all', 'append'], ['none', 'merge']]) {
  test(`ingest 追加：同 (令牌, session, to_seq) 重放不重复追加；write_log action=${action}（auditMode=${mode}）`, async () => {
    let target
    const srv = await fakeServer(() => appendReply(target))
    try {
      await withHub(async (h) => {
        target = await mkTarget(h)
        setAudit(h, mode)
        const tok = h.token('w', ['write'])
        const a = await post(h, tok, { source: 'dsh', session_id: 's1', to_seq: 9, text: convo('幂等追加') })
        assert.equal(a.json.status, 'captured')
        assert.ok(!a.json.degraded)
        assert.equal(a.json.cards[0].action, 'appended')
        const snapshot = () => JSON.stringify([rows(h, 'SELECT body FROM cards'), rows(h, 'SELECT content FROM card_updates')])
        const s1 = snapshot()
        const b = await post(h, tok, { source: 'dsh', session_id: 's1', to_seq: 9, text: convo('幂等追加换文本') })
        assert.equal(b.json.idempotent_replay, true)
        assert.equal(snapshot(), s1, '重放不得再次追加')
        assert.equal(srv.seen.length, 1)
        assert.equal(rows(h, 'SELECT COUNT(*) n FROM quarantine')[0].n, 0)
        assert.equal(rows(h, "SELECT action FROM write_log WHERE tool = 'ingest' AND action = ?", action).length, 1)
      }, { env: { MEMORY_LLM_BASE_URL: srv.baseUrl, MEMORY_LLM_MODEL: 'm', MEMORY_HUB_INGEST_COOLDOWN_S: '0' } })
    } finally { await srv.close() }
  })
}
