// 并发「首次打开同一个新库」：N 个进程同时 getDb(root)，必须 0 个 database is locked。
//
// 为什么单独有这个测试：writeCard 的并发（tests/concurrency.test.mjs）已经覆盖了写入路径，
// 但**初始化路径**是另一回事 —— getDb 会做 journal_mode=WAL 切换 + 建表 + schema 迁移，
// 这几步都要求写锁，而 `PRAGMA journal_mode=WAL` 在抢不到锁时**不会**被 busy_timeout 兜住，
// 于是直接抛 "database is locked"。实测未修时 6-8 轮里 5 轮会挂（旧实现 8/8 全挂），
// 表现为 tests/concurrency.test.mjs 间歇性失败 —— 一个会被误读成"机器慢"的真 bug。
//
// 判定标准写死为「busy 条数 === 0」，不用"大部分通过"。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.resolve(here, '../e2e/open-once.mjs')
const LEGACY_CORE = path.resolve(here, '../fixtures/legacy')
const PROCS = 8
const ROUNDS = 6

/** 跑一轮：新建空目录 → 同时喂给 PROCS 个进程 → 返回非 'ok' 的输出。 */
async function round(core) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-open-'))
  try {
    const outs = await Promise.all(Array.from({ length: PROCS }, () => new Promise((resolve) => {
      const args = [SCRIPT, root, ...(core ? ['--core', core] : [])]
      const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => { out += d })
      p.stderr.on('data', (d) => { err += d })
      // 拿不到 stdout 时把 stderr 一并带出来，免得"子进程静默崩掉"被误读成超时
      p.on('close', () => resolve(out || `no-output(stderr: ${err.replace(/ExperimentalWarning[^\n]*\n?/g, '').trim().slice(0, 200)})`))
    })))
    return outs.filter((o) => o !== 'ok')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test(`并发首次打开同一新库：${PROCS} 进程 × ${ROUNDS} 轮，0 个 database is locked`, async () => {
  const failures = []
  for (let r = 0; r < ROUNDS; r++) for (const o of await round()) failures.push(`round${r} ${o}`)
  assert.deepEqual(failures, [])
})

test('测试有效性：同一脚本跑在旧实现上必败（旧实现没有 busy_timeout + 重试）', async () => {
  const failures = []
  for (let r = 0; r < ROUNDS; r++) failures.push(...await round(LEGACY_CORE))
  const locked = failures.filter((f) => /^BUSY:.*locked/i.test(f))
  assert.ok(locked.length > 0, `旧实现竟然没锁冲突，说明这个测试没有区分力：${JSON.stringify(failures.slice(0, 3))}`)
})
