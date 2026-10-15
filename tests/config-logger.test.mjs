// 配置 / 日志 / 启动护栏（纯函数部分）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpHome, rmrf, logSink } from './helpers.mjs'
import { loadConfig, validateBind, ConfigError } from '../src/config.js'
import { createLogger } from '../src/logger.js'

test('默认配置：127.0.0.1、端口 7990、/mcp、不暴露 tidy apply、无 LLM', () => {
  const home = tmpHome()
  try {
    const c = loadConfig({ MEMORY_HUB_HOME: home })
    assert.equal(c.host, '127.0.0.1')
    assert.equal(c.port, 7990)
    assert.equal(c.basePath, '')
    assert.equal(c.exposeTidyApply, false)
    assert.equal(c.allowRemote, false)
    assert.equal(c.llm, null)
    assert.equal(c.dbRoot, home)
    assert.doesNotThrow(() => validateBind(c))
  } finally { rmrf(home) }
})

test('MEMORY_HUB_DB 指向旧库文件 → dbRoot 为其目录；文件名不对则报错', () => {
  const home = tmpHome()
  try {
    const c = loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_DB: path.join(home, 'x', 'memory-eternal.db') })
    assert.equal(c.dbRoot, path.join(home, 'x'))
    assert.throws(() => loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_DB: path.join(home, 'other.db') }), ConfigError)
  } finally { rmrf(home) }
})

test('非回环地址：无 ALLOW_REMOTE 拒绝；有 ALLOW_REMOTE 但无 Origin/Host 白名单仍拒绝', () => {
  const home = tmpHome()
  try {
    assert.throws(() => validateBind(loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_HOST: '0.0.0.0' })), ConfigError)
    assert.throws(() => validateBind(loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_HOST: '0.0.0.0', MEMORY_HUB_ALLOW_REMOTE: '1' })), ConfigError)
    const ok = loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_HOST: '0.0.0.0', MEMORY_HUB_ALLOW_REMOTE: '1', MEMORY_HUB_ALLOWED_ORIGINS: 'https://a.example', MEMORY_HUB_ALLOWED_HOSTS: 'a.example' })
    assert.doesNotThrow(() => validateBind(ok))
    assert.deepEqual(ok.allowedHosts.includes('a.example'), true)
  } finally { rmrf(home) }
})

test('端口 / 前缀 / 开关解析与校验', () => {
  const home = tmpHome()
  try {
    const c = loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: '0', MEMORY_HUB_BASE_PATH: '/memory/', MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY: 'true' })
    assert.equal(c.port, 0)
    assert.equal(c.basePath, '/memory')
    assert.equal(c.exposeTidyApply, true)
    assert.throws(() => loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: 'abc' }), ConfigError)
    assert.throws(() => loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: '70000' }), ConfigError)
    assert.throws(() => loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_BASE_PATH: 'no-slash' }), ConfigError)
  } finally { rmrf(home) }
})

test('LLM：环境变量三件套；缺任一项则视为未配置（降级）；不回退到 OPENAI_* 变量', () => {
  const home = tmpHome()
  try {
    const c = loadConfig({ MEMORY_HUB_HOME: home, MEMORY_LLM_BASE_URL: 'http://127.0.0.1:1/v1', MEMORY_LLM_MODEL: 'm1', MEMORY_LLM_KEY: 'k-env' })
    assert.deepEqual(c.llm, { baseUrl: 'http://127.0.0.1:1/v1', model: 'm1', apiKey: 'k-env' })
    assert.equal(loadConfig({ MEMORY_HUB_HOME: home, MEMORY_LLM_BASE_URL: 'http://127.0.0.1:1/v1' }).llm, null)
    assert.equal(loadConfig({ MEMORY_HUB_HOME: home, OPENAI_BASE_URL: 'http://x/v1', OPENAI_API_KEY: 'k', MEMORY_LLM_MODEL: 'm' }).llm, null)
    // 本地端点允许无 key
    assert.deepEqual(loadConfig({ MEMORY_HUB_HOME: home, MEMORY_LLM_BASE_URL: 'http://127.0.0.1:1/v1', MEMORY_LLM_MODEL: 'm1' }).llm, { baseUrl: 'http://127.0.0.1:1/v1', model: 'm1', apiKey: '' })
  } finally { rmrf(home) }
})

test('配置文件 memory-hub.json：0600 才读取其中的 key；权限过宽则忽略 key 并告警；环境变量优先', () => {
  const home = tmpHome()
  try {
    const file = path.join(home, 'memory-hub.json')
    fs.writeFileSync(file, JSON.stringify({ port: 7777, llm: { baseUrl: 'http://127.0.0.1:2/v1', model: 'mf', key: 'k-file' } }))
    fs.chmodSync(file, 0o644)
    const warns = []
    const loose = loadConfig({ MEMORY_HUB_HOME: home }, { warn: (m) => warns.push(m) })
    assert.equal(loose.llm?.apiKey ?? '', '', '权限过宽的文件里的 key 不得被读取')
    assert.ok(warns.some((w) => /0600|权限/.test(w)))
    assert.ok(!warns.join('\n').includes('k-file'))
    fs.chmodSync(file, 0o600)
    const tight = loadConfig({ MEMORY_HUB_HOME: home })
    assert.equal(tight.port, 7777)
    assert.deepEqual(tight.llm, { baseUrl: 'http://127.0.0.1:2/v1', model: 'mf', apiKey: 'k-file' })
    assert.equal(loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: '8888', MEMORY_LLM_KEY: 'k-env' }).port, 8888)
    assert.equal(loadConfig({ MEMORY_HUB_HOME: home, MEMORY_LLM_KEY: 'k-env' }).llm.apiKey, 'k-env')
  } finally { rmrf(home) }
})

test('日志：单行 JSON、分级、敏感字段脱敏', () => {
  const sink = logSink()
  const log = createLogger({ level: 'info', stream: sink.stream })
  log.debug('hidden')
  log.info('启动', { port: 1, token: 'mh_abc_secretsecret', apiKey: 'sk-live', authorization: 'Bearer zzz', nested: { password: 'pw', ok: 1 } })
  log.error('boom', { err: 'x' })
  const lines = sink.lines().map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].level, 'INFO')
  assert.equal(lines[1].level, 'ERROR')
  const all = sink.text()
  for (const secret of ['mh_abc_secretsecret', 'sk-live', 'Bearer zzz', '"pw"']) assert.ok(!all.includes(secret), secret)
  assert.equal(lines[0].port, 1)
  assert.equal(lines[0].nested.ok, 1)
})
