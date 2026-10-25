// REVISION 解析与 /healthz 回报（部署可追溯性）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseRevision, readRevision } from '../src/revision.js'
import { tmpHome, rmrf } from './helpers.mjs'

const SHA = '0123456789abcdef0123456789abcdef01234567'

test('parseRevision：新格式 / 旧格式（单行短 sha）/ 非法输入', () => {
  assert.deepEqual(parseRevision(`sha=${SHA}\ntime=2026-01-02T03:04:05+00:00\ndescribe=v0.1.0-3-g0123456\n`), { sha: SHA, time: '2026-01-02T03:04:05+00:00', describe: 'v0.1.0-3-g0123456' })
  assert.deepEqual(parseRevision('02979b1\n'), { sha: '02979b1', time: null, describe: null })
  assert.equal(parseRevision(''), null)
  assert.equal(parseRevision('sha=not-a-sha\n'), null)
  assert.equal(parseRevision(null), null)
})

test('readRevision：缺文件返回 null，不抛错', () => {
  const dir = tmpHome()
  try {
    assert.equal(readRevision(dir), null)
    fs.writeFileSync(path.join(dir, 'REVISION'), `sha=${SHA}\n`)
    assert.equal(readRevision(dir).sha, SHA)
  } finally { rmrf(dir) }
})

test('/healthz：无 REVISION → revision 为 null；有 REVISION → 返回 sha / 提交时间 / describe', async () => {
  const { loadConfig } = await import('../src/config.js')
  const { startServer } = await import('../src/server.js')
  const { closeAllDb } = await import('../src/core/db.js')
  const { createLogger } = await import('../src/logger.js')
  const { logSink } = await import('./helpers.mjs')
  const run = async (codeRoot) => {
    const home = tmpHome()
    const srv = await startServer(loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: '0' }), { logger: createLogger({ level: 'error', stream: logSink().stream }), scheduler: false, codeRoot })
    try { return await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json() } finally { await srv.close(); closeAllDb(); rmrf(home) }
  }
  const empty = tmpHome(); const withRev = tmpHome()
  try {
    fs.writeFileSync(path.join(withRev, 'REVISION'), `sha=${SHA}\ntime=2026-01-02T03:04:05+00:00\ndescribe=v0.1.0-3-g0123456\n`)
    const a = await run(empty)
    assert.equal(a.ok, true); assert.equal(a.revision, null)
    const b = await run(withRev)
    assert.equal(b.revision, SHA); assert.equal(b.revisionTime, '2026-01-02T03:04:05+00:00'); assert.equal(b.describe, 'v0.1.0-3-g0123456')
  } finally { rmrf(empty); rmrf(withRev) }
})
