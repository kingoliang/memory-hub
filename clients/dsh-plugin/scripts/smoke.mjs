#!/usr/bin/env node
// 脚本级烟测：本机起一个真实 memory-hub（临时数据目录、stub LLM、auditMode=all），
// 用插件的 apply() 接上假 cordis ctx，喂模拟的 DSH 会话事件，期望在 hub 待审队列里看到卡。
// 不碰 58，不碰任何真实数据目录；结束后自动清理。用法：node scripts/smoke.mjs
import assert from 'node:assert/strict'
import { withHub } from '../../../tests/hub-helpers.mjs'
import { startMockLlm } from '../../../tests/helpers.mjs'
import * as plugin from '../index.js'
import { makeSession, makeAgent, makeCtx } from '../tests/helpers.mjs'

const CARD = JSON.stringify({ save: true, title: '烟测：配置方案决策', kind: 'tool', tags: ['smoke'], body: '# 烟测：配置方案决策\n\n- 采用环境变量加配置文件\n- 原因：部署时无需改代码' })
const LONG = '关于配置管理的结论：采用环境变量优先、配置文件兜底的方案，原因是部署时无需改代码，并且便于多台机器保持一致。步骤：先确认依赖版本，再写入配置，最后重启服务并检查日志。命令执行前先备份数据库。'

const llm = await startMockLlm(CARD)
try {
  await withHub(async (h) => {
    h.db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','all')").run()
    const token = h.token('dsh-smoke', ['write'])
    process.env.MEMORY_HUB_DSH_TOKEN = token // 仅进程内环境变量，不打印
    process.env.MEMORY_HUB_INGEST_URL = `${h.url}/memory/api/ingest`

    const ctx = makeCtx()
    plugin.apply(ctx, {})

    // 第 0 轮：不足 60 字 → 客户端预检不发
    const s = makeSession({ id: 'smoke-session', cwd: '/work/smoke-proj' })
    s.turnStart(0); s.user('你好'); s.assistant('嗨')
    ctx.emitTurnStopping(makeAgent(s), 0)
    await wait(200)
    assert.equal(count(h), 0, '短对话不应建卡')

    // 第 1 轮：累积后超过阈值 → 发送 → hub 蒸馏 → 待审卡
    s.turnStart(1)
    s.user(`请把配置管理的做法定下来。${LONG}${LONG}`)
    s.assistant(`好的，已确认：${LONG}`)
    s.tool('TOOL-OUTPUT-MUST-NOT-LEAK')
    ctx.emitTurnStopping(makeAgent(s), 1)
    try { await waitFor(() => count(h) > 0, 5000) } catch (e) { for (const l of ctx.logs) console.error(`  [${l.level}] ${l.msg}`); console.error(h.logs.text().slice(-1500)); throw e }

    const row = h.db().prepare('SELECT id, status, title, source, submitted_by FROM quarantine ORDER BY id DESC LIMIT 1').get()
    assert.equal(row.status, 'pending')
    assert.equal(row.source, 'ingest:dsh')
    assert.equal(row.submitted_by, 'dsh-smoke')
    const prompt = JSON.stringify(llm.seen)
    assert.ok(!prompt.includes('TOOL-OUTPUT-MUST-NOT-LEAK'), '工具输出不应到达 hub')
    assert.ok(!ctx.logs.some((l) => l.msg.includes(token)), '日志里不应出现令牌')
    console.log(`SMOKE OK：待审卡 #${row.id}「${row.title}」source=${row.source} submitted_by=${row.submitted_by}`)
    console.log('插件日志：'); for (const l of ctx.logs) console.log(`  [${l.level}] ${l.msg}`)
    ctx.dispose()
  }, { env: { MEMORY_HUB_BASE_PATH: '/memory', MEMORY_HUB_INGEST_COOLDOWN_S: '0', MEMORY_LLM_BASE_URL: llm.baseUrl, MEMORY_LLM_MODEL: 'mock-model', MEMORY_LLM_KEY: 'mock-key-smoke-0123456789' } })
} finally { await llm.close() }

function count(h) { return h.db().prepare('SELECT COUNT(*) n FROM quarantine').get().n }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }
async function waitFor(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await wait(50) } throw new Error('等待超时：hub 待审队列里没有出现卡') }
