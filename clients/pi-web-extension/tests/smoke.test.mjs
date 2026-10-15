// 烟测：起本仓库真实 memory-hub server（临时数据目录 + stub LLM），喂模拟的 agent_end 事件，应在待审队列看到卡。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMockLlm, durableText } from '../../../tests/helpers.mjs'
import { withHub } from '../../../tests/hub-helpers.mjs'
import { createMemoryHubIngest } from '../memory-hub-ingest/core.mjs'
import { u, a, mkCtx, silentLog } from './helpers.mjs'

const CARD = JSON.stringify({ save: true, title: 'pi-web 摄入烟测卡', kind: 'tool', tags: ['smoke'], body: '# 烟测\n\n- 环境变量优先，其次配置文件\n- 原因：部署无需改代码' })

test('烟测：模拟 agent_end → 真 hub /memory/api/ingest → 待审队列出现 source=ingest:pi-web 的卡（先 deferred 后累积 captured）', async () => {
  const llm = await startMockLlm(CARD)
  try {
    await withHub(async (h) => {
      h.db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','all')").run()
      const tok = h.token('pi-web-smoke', ['write'])
      const log = silentLog()
      const ing = createMemoryHubIngest({
        env: { MEMORY_HUB_PI_TOKEN: tok, MEMORY_HUB_INGEST_URL: `${h.url}/memory/api/ingest` },
        log, io: { readFile: () => { throw new Error('x') } },
      })
      const ctx = mkCtx({ sid: 'smoke-session', cwd: '/srv/demo-project' })
      ing.onSessionStart({ reason: 'startup' }, ctx)

      // 第 1 轮：>60 字但 <300 字 → 客户端发出，hub 回 deferred too_short，不建卡
      const t1 = [u('这个服务的配置到底该怎么管理比较合适，请给个明确的结论和理由，我想统一部署方式。'), a('结论：环境变量优先，其次配置文件，原因是部署时无需改代码，也方便多机一致。')]
      ing.onAgentEnd({ type: 'agent_end', messages: t1 }, ctx); await ing.idle()
      assert.equal(h.db().prepare('SELECT COUNT(*) n FROM quarantine').get().n, 0)
      assert.equal(ing._states.get('smoke-session').pending.length, 2, 'deferred 不推进水位')
      assert.ok(log.calls.some((c) => c.text.includes('hub 延后')))

      // 第 2 轮：累积文本越过 300 字 → captured，进待审
      const t2 = [u('好的，那密钥放哪里？'), a(durableText('密钥存放', 1) + '\n' + durableText('密钥轮换', 2))]
      ing.onAgentEnd({ type: 'agent_end', messages: t2 }, ctx); await ing.idle()
      assert.equal(ing._states.get('smoke-session').pending.length, 0, 'captured 推进水位 ')
      const rows = h.db().prepare('SELECT status, source, submitted_by FROM quarantine').all()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].status, 'pending')
      assert.equal(rows[0].source, 'ingest:pi-web')
      assert.equal(rows[0].submitted_by, 'pi-web-smoke')
      // 蒸馏 LLM 看到的是带角色前缀、两轮累积的文本
      const seen = JSON.stringify(llm.seen)
      assert.ok(seen.includes('配置到底该怎么管理') && seen.includes('密钥存放'))
      assert.ok(!log.calls.some((c) => c.text.includes(tok)), '日志不含令牌')

      // 第 3 轮：新内容太短 → 不外发
      const before = llm.seen.length
      ing.onAgentEnd({ type: 'agent_end', messages: [u('谢谢'), a('不客气')] }, ctx); await ing.idle()
      assert.equal(llm.seen.length, before)
    }, { env: { MEMORY_HUB_BASE_PATH: '/memory', MEMORY_LLM_BASE_URL: llm.baseUrl, MEMORY_LLM_MODEL: 'mock-model', MEMORY_LLM_KEY: 'mock-key-smoke-0123456789' } })
  } finally { await llm.close() }
})
