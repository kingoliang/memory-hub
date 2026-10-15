// 启动护栏 + 默认监听 + 备份
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { tmpHome, rmrf } from './helpers.mjs'
import { withHub } from './hub-helpers.mjs'
import { writeCard } from '../src/core/vault.js'
import { closeAllDb } from '../src/core/db.js'
import { backupDb } from '../src/core/db.js'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/memory-hub.mjs')
const run = (env, args = ['serve']) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, ...env } })

test('HOST=0.0.0.0 且无 ALLOW_REMOTE：退出码非 0，stderr 有 ERROR', () => {
  const home = tmpHome()
  try {
    const r = run({ MEMORY_HUB_HOME: home, MEMORY_HUB_HOST: '0.0.0.0', MEMORY_HUB_PORT: '0' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /"level":"ERROR"/)
    assert.match(r.stderr, /ALLOW_REMOTE/)
  } finally { rmrf(home) }
})

test('ALLOW_REMOTE=1 但未配置 Origin / Host 白名单：同样拒绝启动', () => {
  const home = tmpHome()
  try {
    const r = run({ MEMORY_HUB_HOME: home, MEMORY_HUB_HOST: '0.0.0.0', MEMORY_HUB_ALLOW_REMOTE: '1', MEMORY_HUB_PORT: '0' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /"level":"ERROR"/)
  } finally { rmrf(home) }
})

test('默认只监听 127.0.0.1', async () => {
  await withHub(async (h) => {
    assert.equal(h.config.host, '127.0.0.1')
    const { execFileSync } = await import('node:child_process')
    // 外部可见性：能通过回环地址连接，/healthz 报告绑定地址
    const j = await (await fetch(h.url + '/healthz')).json()
    assert.equal(j.ok, true)
    assert.equal(j.bind, '127.0.0.1')
  })
})

test('serve 子进程：真实起进程，/healthz 200，无令牌 POST /mcp 401，SIGTERM 干净退出', async () => {
  const home = tmpHome()
  const p = spawn(process.execPath, [CLI, 'serve'], { env: { PATH: process.env.PATH, MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  p.stderr.on('data', (d) => { err += d })
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('启动超时：' + err)), 15000)
      p.stderr.on('data', () => { const m = /"port":(\d+)/.exec(err); if (m && /listening/.test(err)) { clearTimeout(t); resolve(Number(m[1])) } })
    })
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200)
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 401)
    const code = await new Promise((res) => { p.on('exit', (c, s) => res(c ?? s)); p.kill('SIGTERM') })
    assert.ok(code === 0 || code === 'SIGTERM', String(code))
  } finally { p.kill('SIGKILL'); rmrf(home) }
})

test('备份：sqlite backup API 生成副本，integrity_check=ok，权限 0600，只保留最近 N 份', async () => {
  const home = tmpHome()
  try {
    await writeCard(home, { kind: 'knowledge', title: '备份测试', body: '备份用的正文', status: 'approved', submittedBy: 'x' }, { dedup: false })
    const r = await backupDb(home, { maxKeep: 2 })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(fs.existsSync(r.path))
    assert.equal(fs.statSync(r.path).mode & 0o777, 0o600)
    const copy = new DatabaseSync(r.path, { readOnly: true })
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM cards').get().n, 1)
    copy.close()
    // 造出多份旧备份，验证保留策略
    const dir = path.join(home, 'backups')
    for (const d of ['2020-01-01_0300', '2020-01-02_0300', '2020-01-03_0300']) fs.writeFileSync(path.join(dir, `memory-eternal-${d}.db`), 'x')
    const r2 = await backupDb(home, { maxKeep: 2 })
    assert.equal(r2.ok, true)
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('memory-eternal-')).length, 2)
  } finally { closeAllDb(); rmrf(home) }
})
