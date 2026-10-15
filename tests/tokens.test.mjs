// 令牌：创建 / 哈希存储 / 撤销 / 过期 / 范围 / last_used 节流
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { tmpHome, rmrf } from './helpers.mjs'
import { getDb, closeAllDb } from '../src/core/db.js'
import { createToken, listTokens, revokeToken, verifyToken, parseScopes, SCOPES, scopeAllows } from '../src/auth/tokens.js'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

test('创建：明文形如 mh_<id>_<secret>，库里只有 sha256，明文不落盘（含 WAL）', () => {
  const home = tmpHome()
  try {
    const t = createToken(home, { name: 'claude-code-kingo', scopes: ['read', 'write'] })
    assert.match(t.token, /^mh_[A-Za-z0-9]+_[A-Za-z0-9_-]{40,}$/)
    const [, id, secret] = /^mh_([A-Za-z0-9]+)_(.+)$/.exec(t.token)
    assert.equal(t.tokenId, id)
    const row = getDb(home).prepare('SELECT * FROM agent_tokens WHERE token_id = ?').get(id)
    assert.equal(row.name, 'claude-code-kingo')
    assert.equal(row.secret_hash, sha(secret))
    assert.deepEqual(JSON.parse(row.scopes), ['read', 'write'])
    assert.ok(!JSON.stringify(row).includes(secret))
    closeAllDb()
    for (const f of fs.readdirSync(home)) {
      const buf = fs.readFileSync(path.join(home, f))
      assert.ok(!buf.includes(secret), `${f} 中出现了令牌明文`)
    }
  } finally { closeAllDb(); rmrf(home) }
})

test('列表不含任何密钥材料', () => {
  const home = tmpHome()
  try {
    createToken(home, { name: 'a', scopes: ['read'] })
    const list = listTokens(home)
    assert.equal(list.length, 1)
    assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'expiresAt', 'lastUsedAt', 'name', 'revokedAt', 'scopes', 'tokenId'])
  } finally { closeAllDb(); rmrf(home) }
})

test('校验：正确通过；错密钥 / 错 id / 乱格式 / 空 一律失败', () => {
  const home = tmpHome()
  try {
    const t = createToken(home, { name: 'a', scopes: ['read'] })
    const ok = verifyToken(home, t.token)
    assert.equal(ok.ok, true)
    assert.equal(ok.token.name, 'a')
    assert.deepEqual(ok.token.scopes, ['read'])
    const [, id] = /^mh_([A-Za-z0-9]+)_/.exec(t.token)
    for (const bad of [`mh_${id}_wrongsecretwrongsecretwrongsecretwrongsecret`, 'mh_nope_xxxxxxxx', 'garbage', '', undefined, `Bearer ${t.token}`]) {
      assert.equal(verifyToken(home, bad).ok, false, String(bad))
    }
  } finally { closeAllDb(); rmrf(home) }
})

test('撤销后立即失效；按名字或 id 都能撤销；重复撤销与不存在报错', () => {
  const home = tmpHome()
  try {
    const t = createToken(home, { name: 'a', scopes: ['read'] })
    const t2 = createToken(home, { name: 'b', scopes: ['read'] })
    revokeToken(home, 'a')
    assert.equal(verifyToken(home, t.token).ok, false)
    assert.equal(verifyToken(home, t2.token).ok, true)
    revokeToken(home, t2.tokenId)
    assert.equal(verifyToken(home, t2.token).ok, false)
    assert.throws(() => revokeToken(home, 'a'), /已撤销|revoked/i)
    assert.throws(() => revokeToken(home, 'nope'), /不存在|not found/i)
    assert.ok(listTokens(home).every((x) => x.revokedAt))
  } finally { closeAllDb(); rmrf(home) }
})

test('过期令牌失败', () => {
  const home = tmpHome()
  try {
    const t = createToken(home, { name: 'a', scopes: ['read'], expiresAt: new Date(Date.now() - 1000).toISOString() })
    assert.equal(verifyToken(home, t.token).ok, false)
    const t2 = createToken(home, { name: 'b', scopes: ['read'], expiresAt: new Date(Date.now() + 3600e3).toISOString() })
    assert.equal(verifyToken(home, t2.token).ok, true)
  } finally { closeAllDb(); rmrf(home) }
})

test('范围校验：只认 read / write / tidy:apply；非法、空、重复名拒绝', () => {
  const home = tmpHome()
  try {
    assert.deepEqual(SCOPES, ['read', 'write', 'tidy:apply'])
    assert.deepEqual(parseScopes('read,write'), ['read', 'write'])
    assert.deepEqual(parseScopes(' write , read ,read'), ['read', 'write'])
    assert.throws(() => parseScopes('admin'), /scope/i)
    assert.throws(() => parseScopes(''), /scope/i)
    assert.throws(() => createToken(home, { name: 'a', scopes: [] }), /scope/i)
    assert.throws(() => createToken(home, { name: '', scopes: ['read'] }), /name|名/i)
    assert.throws(() => createToken(home, { name: 'bad name!', scopes: ['read'] }), /name|名/i)
    createToken(home, { name: 'dup', scopes: ['read'] })
    assert.throws(() => createToken(home, { name: 'dup', scopes: ['read'] }), /已存在|exists|UNIQUE/i)
  } finally { closeAllDb(); rmrf(home) }
})

test('范围矩阵（PLAN 第 4 节）：读工具三者皆可，capture 需 write 或 tidy:apply，apply 类仅 tidy:apply', () => {
  assert.equal(scopeAllows(['read'], 'read'), true)
  assert.equal(scopeAllows(['read'], 'write'), false)
  assert.equal(scopeAllows(['write'], 'read'), true)
  assert.equal(scopeAllows(['write'], 'write'), true)
  assert.equal(scopeAllows(['write'], 'tidy:apply'), false)
  assert.equal(scopeAllows(['tidy:apply'], 'read'), true)
  assert.equal(scopeAllows(['tidy:apply'], 'write'), true)
  assert.equal(scopeAllows(['tidy:apply'], 'tidy:apply'), true)
})

test('last_used_at 节流：首次写入，1 分钟内不重复写', () => {
  const home = tmpHome()
  try {
    const t = createToken(home, { name: 'a', scopes: ['read'] })
    assert.equal(listTokens(home)[0].lastUsedAt, null)
    verifyToken(home, t.token)
    const first = listTokens(home)[0].lastUsedAt
    assert.ok(first)
    verifyToken(home, t.token)
    assert.equal(listTokens(home)[0].lastUsedAt, first)
  } finally { closeAllDb(); rmrf(home) }
})
