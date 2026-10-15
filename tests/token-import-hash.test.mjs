// token import-hash：把旧共享令牌（任意格式的长字符串，旧服务只存明文）导入为 legacy 令牌，
// 库里只存 sha256，使现有客户端不改配置即可连上；明文绝不出现在输出 / 日志 / 库文件里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpHome, rmrf, rpc, toolText, durableText } from './helpers.mjs'
import { withHub } from './hub-helpers.mjs'
import { verifyToken, createToken, importLegacyToken, listTokens, revokeToken } from '../src/auth/tokens.js'
import { closeAllDb } from '../src/core/db.js'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/memory-hub.mjs')
const run = (home, args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20000, input, env: { PATH: process.env.PATH, MEMORY_HUB_HOME: home } })
// 旧令牌样子：不是 mh_ 格式，随机长串（旧服务只要求 >=32 字符）
const legacyPlain = () => crypto.randomBytes(24).toString('base64url') + 'LEGACY' + crypto.randomBytes(8).toString('hex')

test('importLegacyToken：旧明文令牌可通过校验，scope/过期/名字按参数；错误令牌不通过', () => {
  const home = tmpHome()
  try {
    const plain = legacyPlain()
    const r = importLegacyToken(home, { name: 'legacy-shared', token: plain, scopes: 'read,write', expiresAt: new Date(Date.now() + 14 * 864e5).toISOString() })
    assert.equal(r.name, 'legacy-shared')
    assert.deepEqual(r.scopes, ['read', 'write'])
    assert.ok(!JSON.stringify(r).includes(plain), '返回值不得含明文')
    const v = verifyToken(home, plain)
    assert.equal(v.ok, true)
    assert.equal(v.token.name, 'legacy-shared')
    assert.deepEqual(v.token.scopes, ['read', 'write'])
    assert.equal(verifyToken(home, plain + 'x').ok, false)
    assert.equal(verifyToken(home, plain.slice(0, -1)).ok, false)
    // 同一个库里普通 mh_ 令牌不受影响
    const n = createToken(home, { name: 'normal', scopes: 'read' })
    assert.equal(verifyToken(home, n.token).ok, true)
    // list 不暴露任何密钥材料
    assert.ok(!JSON.stringify(listTokens(home)).includes(plain))
  } finally { closeAllDb(); rmrf(home) }
})

test('importLegacyToken：库文件里没有明文；过短(<32)拒绝；--hash 形式只接受 64 位十六进制', () => {
  const home = tmpHome()
  try {
    const plain = legacyPlain()
    importLegacyToken(home, { name: 'legacy-shared', token: plain, scopes: 'read,write' })
    closeAllDb()
    const bytes = fs.readdirSync(home).filter((f) => f.startsWith('memory-eternal.db')).map((f) => fs.readFileSync(path.join(home, f))).map((b) => b.toString('latin1')).join('')
    assert.ok(!bytes.includes(plain), '库文件（含 WAL）里不得出现明文')
    assert.throws(() => importLegacyToken(home, { name: 'short', token: 'a'.repeat(31), scopes: 'read' }), /32/)
    assert.throws(() => importLegacyToken(home, { name: 'badhash', hash: 'zz', scopes: 'read' }), /64/)
    const p2 = legacyPlain()
    importLegacyToken(home, { name: 'by-hash', hash: crypto.createHash('sha256').update(p2).digest('hex'), scopes: 'read' })
    assert.equal(verifyToken(home, p2).ok, true)
    assert.throws(() => importLegacyToken(home, { name: 'by-hash', token: legacyPlain(), scopes: 'read' }), /已存在/)
  } finally { closeAllDb(); rmrf(home) }
})

test('legacy 令牌：过期 / 撤销后立即失效；mh_ 格式的伪造串不会命中 legacy 通道', () => {
  const home = tmpHome()
  try {
    const exp = legacyPlain(), rev = legacyPlain()
    importLegacyToken(home, { name: 'exp', token: exp, scopes: 'read', expiresAt: new Date(Date.now() - 1000).toISOString() })
    importLegacyToken(home, { name: 'rev', token: rev, scopes: 'read' })
    assert.equal(verifyToken(home, exp).ok, false)
    assert.equal(verifyToken(home, rev).ok, true)
    revokeToken(home, 'rev')
    assert.equal(verifyToken(home, rev).ok, false)
    // 对一个 legacy 令牌的哈希构造 mh_ 外形：普通通道只认 tokenId+secret，不能借 legacy 行通过
    const row = listTokens(home).find((t) => t.name === 'rev')
    assert.equal(verifyToken(home, `mh_${row.tokenId}_${'A'.repeat(43)}`).ok, false)
  } finally { closeAllDb(); rmrf(home) }
})

test('CLI token import-hash --from-file：不打印明文，--expires 14d，--scope read,write；随后 HTTP 用旧令牌可调用 tools/list 与 recall', async () => {
  await withHub(async (ctx) => {
    const plain = legacyPlain()
    const f = path.join(ctx.home, 'old-token')
    fs.writeFileSync(f, plain + '\n', { mode: 0o600 })
    // 服务进程已持有连接；CLI 另起进程写同一个库（WAL 多进程）
    const r = run(ctx.home, ['token', 'import-hash', '--name', 'legacy-shared', '--scope', 'read,write', '--expires', '14d', '--from-file', f])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.stdout.includes(plain) && !r.stderr.includes(plain), 'CLI 输出不得含明文')
    const rows = JSON.parse(run(ctx.home, ['token', 'list', '--json']).stdout)
    const row = rows.find((t) => t.name === 'legacy-shared')
    assert.deepEqual(row.scopes, ['read', 'write'])
    const days = (Date.parse(row.expiresAt) - Date.now()) / 864e5
    assert.ok(days > 13.9 && days < 14.1, String(days))

    const list = await rpc(ctx.url, plain, 'tools/list')
    assert.equal(list.status, 200)
    const names = list.body.result.tools.map((t) => t.name)
    assert.ok(names.includes('memory_recall') && names.includes('memory_capture'))
    const rec = await rpc(ctx.url, plain, 'tools/call', { name: 'memory_recall', arguments: { query: '任意' } })
    assert.equal(rec.status, 200)
    assert.ok(!ctx.logs.text().includes(plain), '服务日志不得含旧令牌明文')
    // 署名 = 令牌名
    const cap = await rpc(ctx.url, plain, 'tools/call', { name: 'memory_capture', arguments: { text: durableText('旧令牌署名验证', 7) } })
    assert.equal(cap.status, 200, toolText(cap))
    const sub = ctx.db().prepare('SELECT submitted_by FROM quarantine UNION ALL SELECT submitted_by FROM cards').all()
    assert.ok(sub.length >= 1 && sub.every((s) => s.submitted_by === 'legacy-shared'), JSON.stringify(sub) + toolText(cap))
    // 撤销后立即 401
    assert.equal(run(ctx.home, ['token', 'revoke', 'legacy-shared']).status, 0)
    assert.equal((await rpc(ctx.url, plain, 'tools/list')).status, 401)
  })
})

test('CLI token import-hash：文件不存在 / 过短 / 参数缺失 → 非 0 且不泄密；--from-file 与 --hash 互斥', () => {
  const home = tmpHome()
  try {
    assert.notEqual(run(home, ['token', 'import-hash', '--name', 'x', '--scope', 'read', '--from-file', '/nonexistent/zzz']).status, 0)
    const f = path.join(home, 'short'); fs.writeFileSync(f, 'tooshort\n', { mode: 0o600 })
    const s = run(home, ['token', 'import-hash', '--name', 'x', '--scope', 'read', '--from-file', f])
    assert.notEqual(s.status, 0)
    assert.ok(!s.stderr.includes('tooshort') && !s.stdout.includes('tooshort'))
    assert.notEqual(run(home, ['token', 'import-hash', '--scope', 'read', '--from-file', f]).status, 0)
    assert.notEqual(run(home, ['token', 'import-hash', '--name', 'x', '--scope', 'read', '--from-file', f, '--hash', 'a'.repeat(64)]).status, 0)
    assert.equal(run(home, ['token', 'import-hash', '--name', 'ok', '--scope', 'read', '--hash', 'a'.repeat(64)]).status, 0)
  } finally { closeAllDb(); rmrf(home) }
})
