// M2 管理员认证：口令哈希、登录/限流、会话、CSRF、与 /mcp 的隔离、CLI
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { withAdminHub, makeClient, PW, TEST_COST } from './admin-helpers.mjs'
import { withHub } from '../hub-helpers.mjs'
import { tmpHome, rmrf, rpc } from '../helpers.mjs'
import { hashPassword, verifyPassword, setAdminPassword, hasAdminPassword, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, LOGIN_FAIL_LIMIT } from '../../src/admin/auth.js'
import { closeAllDb, getDb } from '../../src/core/db.js'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../bin/memory-hub.mjs')

const READ_ENDPOINTS = ['session', 'overview', 'facets', 'cards', 'card?path=x', 'queue', 'recycle', 'tags', 'tidy/preview', 'lint', 'activity', 'tokens', 'write-log']

test('口令哈希：scrypt、带随机盐、不含明文，可校验；错误口令/畸形哈希一律 false', () => {
  const a = hashPassword('s3cret-passphrase', TEST_COST)
  const b = hashPassword('s3cret-passphrase', TEST_COST)
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$/)
  assert.notEqual(a, b, '盐必须随机')
  assert.ok(!a.includes('s3cret-passphrase'))
  assert.equal(verifyPassword('s3cret-passphrase', a), true)
  assert.equal(verifyPassword('s3cret-passphrasf', a), false)
  assert.equal(verifyPassword('x', 'garbage'), false)
  assert.equal(verifyPassword('x', ''), false)
  assert.equal(verifyPassword('x', 'scrypt$1$1$1$AA$AA'), false)
})

test('setAdminPassword：哈希存 config 表（不是明文）；过短口令拒绝', () => {
  const home = tmpHome()
  try {
    assert.equal(hasAdminPassword(home), false)
    assert.throws(() => setAdminPassword(home, 'short'), /至少/)
    setAdminPassword(home, PW, { cost: TEST_COST })
    assert.equal(hasAdminPassword(home), true)
    const rows = getDb(home).prepare('SELECT key, value FROM config').all()
    assert.ok(rows.length >= 1)
    assert.ok(!JSON.stringify(rows).includes(PW), '库里不得出现口令明文')
    assert.ok(rows.some((r) => r.value.startsWith('scrypt$')))
  } finally { closeAllDb(); rmrf(home) }
})

test('默认 scrypt 成本不低于 N=2^15（生产强度）', () => {
  const h = hashPassword('some-long-passphrase-1')
  const N = Number(h.split('$')[1])
  assert.ok(N >= 32768, `N=${N}`)
})

test('未登录访问 /admin/api/* 全部 401（含 session），且不泄露数据', async () => {
  await withAdminHub(async (h) => {
    const c = h.client()
    for (const e of READ_ENDPOINTS) {
      const r = await c.get('/admin/api/' + e)
      assert.equal(r.status, 401, e)
      assert.equal(r.json?.error, 'unauthorized', e)
      assert.ok(!r.text.includes('项目决策'), e)
    }
    assert.equal((await c.post('/admin/api/logout', {})).status, 401)
  })
})

test('401 响应带 passwordSet 提示，前端据此区分「未登录」与「尚未设置口令」', async () => {
  await withAdminHub(async (h) => {
    assert.equal((await h.client().get('/admin/api/session')).json.passwordSet, true)
  })
  await withAdminHub(async (h) => {
    assert.equal((await h.client().get('/admin/api/session')).json.passwordSet, false)
  }, { password: null, seed: false })
})

test('未设置口令：登录被拒（503）并提示用 CLI 设置，任何口令都不能进', async () => {
  await withAdminHub(async (h) => {
    const r = await h.client().post('/admin/api/login', { password: 'whatever-long-password' })
    assert.equal(r.status, 503)
    assert.match(r.json.message, /memory-hub admin set-password/)
    assert.ok(!(r.headers.get('set-cookie') || '').includes('mh_sid'))
  }, { password: null, seed: false })
})

test('登录成功：cookie HttpOnly + SameSite=Strict + Path，会话入 admin_sessions 且只存哈希', async () => {
  await withAdminHub(async (h) => {
    const c = h.client()
    const r = await c.login()
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.ok(r.json.csrfToken && r.json.csrfToken.length >= 32)
    const sc = r.headers.getSetCookie().find((s) => s.startsWith('mh_sid='))
    assert.ok(sc, '应下发 mh_sid')
    assert.match(sc, /HttpOnly/i)
    assert.match(sc, /SameSite=Strict/i)
    assert.match(sc, /Path=\//i)
    assert.match(sc, /Max-Age=\d+/i)
    assert.ok(!/;\s*Secure/i.test(sc), '纯 http 回环不带 Secure（否则 Safari 等不接受）；https 反代场景见另一用例')
    const sid = c.jar.mh_sid
    const rows = getDb(h.home).prepare('SELECT * FROM admin_sessions').all()
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0].sid_hash, sid)
    assert.ok(!JSON.stringify(rows).includes(sid), '库里不存会话明文')
    assert.ok(Date.parse(rows[0].expires_at) > Date.now())
    assert.equal((await c.get('/admin/api/session')).status, 200)
  })
})

test('经 https 反代（TRUST_PROXY + X-Forwarded-Proto=https）时 cookie 带 Secure', async () => {
  await withAdminHub(async (h) => {
    const r = await h.client().post('/admin/api/login', { password: PW }, { headers: { 'x-forwarded-proto': 'https' } })
    assert.match(r.headers.getSetCookie().find((s) => s.startsWith('mh_sid=')), /;\s*Secure/i)
  }, { env: { MEMORY_HUB_TRUST_PROXY: '1' } })
  await withAdminHub(async (h) => {
    const r = await h.client().post('/admin/api/login', { password: PW }, { headers: { 'x-forwarded-proto': 'https' } })
    assert.ok(!/;\s*Secure/i.test(r.headers.getSetCookie().find((s) => s.startsWith('mh_sid='))), '未信任代理时忽略 X-Forwarded-Proto')
  })
})

test('登录失败：401、不发 cookie、不区分原因；失败写 write_log(denied)', async () => {
  await withAdminHub(async (h) => {
    const c = h.client()
    const r = await c.post('/admin/api/login', { password: 'wrong-password-123' })
    assert.equal(r.status, 401)
    assert.equal(r.json.error, 'invalid_credentials')
    assert.ok(!(r.headers.get('set-cookie') || '').includes('mh_sid'))
    assert.equal((await c.post('/admin/api/login', {})).status, 400)
    assert.equal((await c.post('/admin/api/login', { password: 12345 })).status, 400)
    const wl = getDb(h.home).prepare("SELECT * FROM write_log WHERE actor_type = 'admin' AND action = 'login' AND outcome = 'denied'").all()
    assert.equal(wl.length, 1)
  })
})

test('登录必须是 application/json（强制 CORS 预检，挡掉跨站表单登录 CSRF）', async () => {
  await withAdminHub(async (h) => {
    const r = await h.client().req('POST', '/admin/api/login', { body: `password=${encodeURIComponent(PW)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    assert.equal(r.status, 415)
  })
})

test('登录失败限流：超过阈值 429 + Retry-After；限流期间正确口令也被拒；与 /mcp 的限流互不影响', async () => {
  await withAdminHub(async (h) => {
    const c = h.client()
    let last
    for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) last = await c.post('/admin/api/login', { password: 'wrong-password-' + i })
    assert.equal(last.status, 401)
    const blocked = await c.post('/admin/api/login', { password: 'wrong-again-xx' })
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
    assert.equal((await c.login()).status, 429, '限流期内正确口令同样拒绝')
    // MCP 侧不受管理登录失败影响
    const tok = h.token('a', ['read'])
    assert.equal((await rpc(h.url, tok, 'tools/list')).status, 200)
  })
})

test('会话空闲过期 → 401，并清理该行', async () => {
  await withAdminHub(async (h) => {
    const c = h.client(); await c.login()
    assert.equal((await c.get('/admin/api/overview')).status, 200)
    getDb(h.home).prepare('UPDATE admin_sessions SET last_seen = ?').run(new Date(Date.now() - SESSION_IDLE_MS - 60_000).toISOString())
    assert.equal((await c.get('/admin/api/overview')).status, 401)
    assert.equal(getDb(h.home).prepare('SELECT COUNT(*) n FROM admin_sessions').get().n, 0)
  })
})

test('会话绝对过期（expires_at 已过）→ 401，即使刚刚活跃', async () => {
  await withAdminHub(async (h) => {
    const c = h.client(); await c.login()
    getDb(h.home).prepare('UPDATE admin_sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString())
    assert.equal((await c.get('/admin/api/overview')).status, 401)
  })
  assert.ok(SESSION_ABSOLUTE_MS > SESSION_IDLE_MS)
})

test('活跃请求会续期 last_seen（滑动空闲窗口）', async () => {
  await withAdminHub(async (h) => {
    const c = h.client(); await c.login()
    getDb(h.home).prepare('UPDATE admin_sessions SET last_seen = ?').run(new Date(Date.now() - SESSION_IDLE_MS + 120_000).toISOString())
    assert.equal((await c.get('/admin/api/overview')).status, 200)
    const seen = Date.parse(getDb(h.home).prepare('SELECT last_seen FROM admin_sessions').get().last_seen)
    assert.ok(Date.now() - seen < 30_000)
  })
})

test('伪造 / 乱格式 cookie → 401', async () => {
  await withAdminHub(async (h) => {
    const c = h.client()
    for (const v of ['x', 'a'.repeat(43), '../../etc/passwd', '']) {
      const r = await c.get('/admin/api/overview', { headers: { cookie: `mh_sid=${v}` } })
      assert.equal(r.status, 401, v)
    }
  })
})

test('CSRF：登出等非 GET 接口缺 token / token 错误 → 403；正确 token → 200 且会话销毁', async () => {
  await withAdminHub(async (h) => {
    const c = h.client(); await c.login()
    assert.equal((await c.post('/admin/api/logout', {})).status, 403)
    assert.equal((await c.post('/admin/api/logout', {}, { headers: { 'x-csrf-token': 'bogus' } })).status, 403)
    assert.equal((await c.get('/admin/api/session')).status, 200, '失败的 CSRF 不应销毁会话')
    const ok = await c.post('/admin/api/logout', {}, { withCsrf: true })
    assert.equal(ok.status, 200)
    assert.equal((await c.get('/admin/api/overview')).status, 401)
    assert.equal(getDb(h.home).prepare('SELECT COUNT(*) n FROM admin_sessions').get().n, 0)
  })
})

test('CSRF token 绑定会话：A 会话的 token 对 B 会话无效', async () => {
  await withAdminHub(async (h) => {
    const a = h.client(); await a.login()
    const b = h.client(); await b.login()
    assert.notEqual(a.csrf, b.csrf)
    const r = await b.post('/admin/api/logout', {}, { headers: { 'x-csrf-token': a.csrf } })
    assert.equal(r.status, 403)
  })
})

test('非 GET 带非法 Origin → 403；同源 / 无 Origin 放行', async () => {
  await withAdminHub(async (h) => {
    const c = h.client(); await c.login()
    const bad = await c.post('/admin/api/logout', {}, { withCsrf: true, headers: { origin: 'https://evil.example' } })
    assert.equal(bad.status, 403)
    const bad2 = await c.post('/admin/api/login', { password: PW }, { headers: { origin: 'https://evil.example' } })
    assert.equal(bad2.status, 403)
    const good = await c.post('/admin/api/logout', {}, { withCsrf: true, headers: { origin: h.url } })
    assert.equal(good.status, 200)
  })
})

test('管理 API 无 CORS：不回 access-control-allow-*，OPTIONS 不放行', async () => {
  await withAdminHub(async (h) => {
    const c = h.client(); await c.login()
    const r = await c.get('/admin/api/overview', { headers: { origin: h.url } })
    assert.equal(r.headers.get('access-control-allow-origin'), null)
    const o = await c.req('OPTIONS', '/admin/api/overview', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })
    assert.ok([204, 403, 404, 405].includes(o.status))
    assert.equal(o.headers.get('access-control-allow-origin'), null)
  })
})

test('Agent 令牌访问管理 API → 401；管理会话 cookie 访问 /mcp → 401（互不通用）', async () => {
  await withAdminHub(async (h) => {
    const tok = h.token('zz', ['read', 'write', 'tidy:apply'])
    for (const e of ['overview', 'cards', 'tokens']) {
      const r = await fetch(h.url + '/admin/api/' + e, { headers: { authorization: `Bearer ${tok}` } })
      assert.equal(r.status, 401, e)
    }
    const c = h.client(); await c.login()
    const m = await fetch(h.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: `mh_sid=${c.jar.mh_sid}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    assert.equal(m.status, 401)
    assert.equal((await rpc(h.url, tok, 'tools/list')).status, 200, 'M1 的 /mcp 鉴权行为不变')
  })
})

test('改口令会使所有既有会话失效', async () => {
  await withAdminHub(async (h) => {
    const c = h.client(); await c.login()
    assert.equal((await c.get('/admin/api/overview')).status, 200)
    setAdminPassword(h.home, 'another very long passphrase', { cost: TEST_COST })
    assert.equal((await c.get('/admin/api/overview')).status, 401)
    assert.equal((await h.client().login(PW)).status, 401)
    assert.equal((await h.client().login('another very long passphrase')).status, 200)
  })
})

test('日志里不出现管理员口令（成功 / 失败 / 限流 / 畸形请求）', async () => {
  await withAdminHub(async (h) => {
    const c = h.client()
    const bad = 'wrong-password-SENTINEL-7781'
    await c.post('/admin/api/login', { password: bad })
    await c.post('/admin/api/login', { password: PW })
    await c.req('POST', '/admin/api/login', { body: '{"password": ' + JSON.stringify(PW) + ', oops', headers: { 'content-type': 'application/json' } })
    const text = h.logs.text()
    assert.ok(!text.includes(PW), '日志含管理员口令')
    assert.ok(!text.includes(bad), '日志含失败口令')
    assert.match(text, /管理员登录/)
    const dbText = JSON.stringify(getDb(h.home).prepare('SELECT * FROM write_log').all())
    assert.ok(!dbText.includes(PW) && !dbText.includes(bad), 'write_log 含口令')
  })
})

test('CLI admin set-password：从 stdin 读取，不打印，不接受命令行参数口令；之后可登录', async () => {
  const home = tmpHome()
  try {
    const env = { PATH: process.env.PATH, MEMORY_HUB_HOME: home }
    const pw = 'cli-set Passphrase 9981 zz'
    const r = spawnSync(process.execPath, [CLI, 'admin', 'set-password'], { input: pw + '\n', encoding: 'utf8', timeout: 30000, env })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.stdout.includes(pw) && !r.stderr.includes(pw), '口令不得出现在输出里')
    assert.match(r.stdout + r.stderr, /已设置/)
    closeAllDb()
    const stored = getDb(home).prepare("SELECT value FROM config WHERE value LIKE 'scrypt$%'").get()
    assert.ok(stored && verifyPassword(pw, stored.value))
    assert.ok(Number(stored.value.split('$')[1]) >= 32768, 'CLI 使用生产强度')
    closeAllDb()

    const viaArg = spawnSync(process.execPath, [CLI, 'admin', 'set-password', '--password', 'argpassword-1234'], { input: '', encoding: 'utf8', timeout: 20000, env })
    assert.notEqual(viaArg.status, 0)
    assert.ok(!(viaArg.stdout + viaArg.stderr).includes('argpassword-1234'))
    const short = spawnSync(process.execPath, [CLI, 'admin', 'set-password'], { input: 'abc\n', encoding: 'utf8', timeout: 20000, env })
    assert.notEqual(short.status, 0)
    const empty = spawnSync(process.execPath, [CLI, 'admin', 'set-password'], { input: '', encoding: 'utf8', timeout: 20000, env })
    assert.notEqual(empty.status, 0)
  } finally { closeAllDb(); rmrf(home) }
})

test('CLI 设置口令后，运行中的服务无需重启即可用新口令登录', async () => {
  await withHub(async (h) => {
    const r = spawnSync(process.execPath, [CLI, 'admin', 'set-password'], { input: 'live-reload passphrase 77\n', encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, MEMORY_HUB_HOME: h.home } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal((await makeClient(h).login('live-reload passphrase 77')).status, 200)
  })
})
