// 并发写：8 进程 × 50 次 writeCard 同库
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'e2e/concurrency.mjs')
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 180000 })

test('8 进程 × 50 次 writeCard：0 BUSY、id 全唯一、400 行落库', () => {
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /CONCURRENCY PASS/)
})

test('测试有效性：同一脚本跑在旧实现（无 busy_timeout）上必败', () => {
  const r = run('--core', path.join(here, 'fixtures/legacy'))
  assert.notEqual(r.status, 0, '旧实现竟然通过了并发测试，说明测试没有区分力')
  assert.match(r.stdout, /CONCURRENCY FAIL/)
})
