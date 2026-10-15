// 插件入口：模块形态 / 配置解析 / 监听器注册 / 禁用态 / 销毁
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../index.js'
import { makeSession, makeAgent, makeCtx, startFakeHub, LONG } from './helpers.mjs'

const TOKEN = 'mh_plugin_token_never_logged_abcdef'
const withEnv = async (env, fn) => {
  const keys = ['MEMORY_HUB_DSH_TOKEN', 'MEMORY_HUB_INGEST_URL']
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  for (const k of keys) delete process.env[k]
  Object.assign(process.env, env)
  try { return await fn() } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
}
const CAPTURED = { code: 200, body: { status: 'captured', cards: [] } }

test('模块形态：导出 name 与 apply（cordis 插件约定）', () => {
  assert.equal(plugin.name, 'dsh-memory-hub-ingest')
  assert.equal(typeof plugin.apply, 'function')
})

test('令牌缺失：apply 不抛错、打一条 WARN、监听器不发请求', async () => {
  await withEnv({}, async () => {
    const hub = await startFakeHub()
    const ctx = makeCtx()
    assert.doesNotThrow(() => plugin.apply(ctx, { url: hub.url }))
    const warns = ctx.logs.filter((l) => l.level === 'warn')
    assert.equal(warns.length, 1)
    assert.match(warns[0].msg, /MEMORY_HUB_DSH_TOKEN/)
    const s = makeSession(); s.turnStart(0); s.user(LONG('a')); s.assistant(LONG('b'))
    await ctx.emitTurnStopping(makeAgent(s))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(hub.requests.length, 0)
    await hub.close()
  })
})

test('令牌来自环境变量；地址优先 config.url，其次 MEMORY_HUB_INGEST_URL；令牌不入日志', async () => {
  const hub = await startFakeHub({ script: [CAPTURED, CAPTURED] })
  await withEnv({ MEMORY_HUB_DSH_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: hub.url }, async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession(); s.turnStart(0); s.user(LONG('a')); s.assistant(LONG('b'))
    const ret = ctx.emitTurnStopping(makeAgent(s))
    assert.equal(ret, undefined, '监听器同步返回')
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(hub.requests.length, 1)
    assert.equal(hub.requests[0].headers.authorization, `Bearer ${TOKEN}`)
    assert.ok(ctx.logs.every((l) => !l.msg.includes(TOKEN)))
    ctx.dispose()
  })
  // config.url 覆盖环境变量
  const hub2 = await startFakeHub({ script: [CAPTURED] })
  await withEnv({ MEMORY_HUB_DSH_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: 'http://127.0.0.1:1/never' }, async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { url: hub2.url })
    const s = makeSession({ id: 'z' }); s.turnStart(0); s.user(LONG('a')); s.assistant(LONG('b'))
    ctx.emitTurnStopping(makeAgent(s))
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(hub2.requests.length, 1)
    ctx.dispose()
  })
  await hub.close(); await hub2.close()
})

test('enabled=false：不注册监听器', async () => {
  await withEnv({ MEMORY_HUB_DSH_TOKEN: TOKEN }, async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { enabled: false })
    assert.equal(ctx.handlers.has('agent/turn-stopping'), false)
  })
})

test('监听器吞掉一切异常：payload 异常 / 会话取数异常都不外泄', async () => {
  await withEnv({ MEMORY_HUB_DSH_TOKEN: TOKEN, MEMORY_HUB_INGEST_URL: 'http://127.0.0.1:1/x' }, async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const h = ctx.handlers.get('agent/turn-stopping')
    assert.doesNotThrow(() => h(undefined))
    assert.doesNotThrow(() => h({ agent: { session: { get id() { throw new Error('x') } } } }))
    ctx.dispose()
  })
})

test('销毁：dispose 后监听器不再产生请求', async () => {
  const hub = await startFakeHub({ script: [CAPTURED] })
  await withEnv({ MEMORY_HUB_DSH_TOKEN: TOKEN }, async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { url: hub.url })
    const h = ctx.handlers.get('agent/turn-stopping')
    ctx.dispose()
    const s = makeSession(); s.turnStart(0); s.user(LONG('a')); s.assistant(LONG('b'))
    h({ agent: makeAgent(s), turn: 0 })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(hub.requests.length, 0)
  })
  await hub.close()
})
