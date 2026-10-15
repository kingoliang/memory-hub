// 令牌管理 CLI：create 仅此一次显示明文；list 不含密钥；revoke 生效
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpHome, rmrf } from './helpers.mjs'
import { verifyToken } from '../src/auth/tokens.js'
import { closeAllDb } from '../src/core/db.js'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/memory-hub.mjs')
const run = (home, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, MEMORY_HUB_HOME: home } })

test('token create / list / revoke 全流程', () => {
  const home = tmpHome()
  try {
    const c = run(home, 'token', 'create', '--name', 't1', '--scope', 'read,write')
    assert.equal(c.status, 0, c.stderr)
    const m = /(mh_[A-Za-z0-9]+_[A-Za-z0-9_-]+)/.exec(c.stdout)
    assert.ok(m, c.stdout)
    const token = m[1]
    assert.equal(verifyToken(home, token).ok, true)
    closeAllDb()

    const l = run(home, 'token', 'list')
    assert.equal(l.status, 0)
    assert.match(l.stdout, /t1/)
    assert.ok(!l.stdout.includes(token) && !l.stderr.includes(token), 'list 不得再显示明文')
    assert.ok(!c.stderr.includes(token), '明文只在 stdout 出现一次')

    const dup = run(home, 'token', 'create', '--name', 't1', '--scope', 'read')
    assert.notEqual(dup.status, 0)
    const bad = run(home, 'token', 'create', '--name', 't2', '--scope', 'root')
    assert.notEqual(bad.status, 0)

    const rv = run(home, 'token', 'revoke', 't1')
    assert.equal(rv.status, 0, rv.stderr)
    assert.equal(verifyToken(home, token).ok, false)
    assert.notEqual(run(home, 'token', 'revoke', 'nope').status, 0)
  } finally { closeAllDb(); rmrf(home) }
})

test('token create --expires 支持相对时长（如 14d），写入 expires_at', () => {
  const home = tmpHome()
  try {
    const c = run(home, 'token', 'create', '--name', 't1', '--scope', 'read', '--expires', '14d')
    assert.equal(c.status, 0, c.stderr)
    const l = run(home, 'token', 'list', '--json')
    const rows = JSON.parse(l.stdout)
    const days = (Date.parse(rows[0].expiresAt) - Date.now()) / 86400e3
    assert.ok(days > 13.9 && days < 14.1, String(days))
  } finally { closeAllDb(); rmrf(home) }
})
