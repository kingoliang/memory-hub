// M2 安全：响应不泄密（假密钥 / 令牌哈希 / 令牌明文）、安全响应头、静态文件服务、basePath
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withAdminHub, SECRET_NEEDLES, FAKE_SK, PW } from './admin-helpers.mjs'
import { getDb } from '../../src/core/db.js'
import { createToken } from '../../src/auth/tokens.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const qs = (o) => '?' + new URLSearchParams(o).toString()

test('所有管理 API 响应都不含：假密钥值、令牌哈希、令牌明文、口令哈希', async () => {
  await withAdminHub(async (h) => {
    const plain = createToken(h.home, { name: 'plain-probe', scopes: ['read', 'write'] }).token
    const c = h.client(); await c.login()
    const db = getDb(h.home)
    const hashes = db.prepare('SELECT secret_hash FROM agent_tokens').all().map((r) => r.secret_hash)
    const pwHash = db.prepare("SELECT value FROM config WHERE value LIKE 'scrypt$%'").get().value
    const secretPath = db.prepare("SELECT path FROM cards WHERE title = '部署凭据备忘'").get().path
    const sessionSid = c.jar.mh_sid
    const urls = [
      'session', 'overview', 'facets', 'queue', 'recycle', 'tags', 'tidy/preview', 'tidy/preview?limit=100', 'lint', 'activity', 'tokens', 'write-log?limit=200',
      'cards?limit=200&status=all', 'cards' + qs({ q: 'password', limit: 200 }), 'cards' + qs({ q: 'sk-', status: 'all' }), 'cards' + qs({ q: FAKE_SK }), 'cards' + qs({ q: 'RSA PRIVATE KEY' }),
      'card' + qs({ path: secretPath }), 'tags?q=once',
    ]
    const bodies = []
    for (const u of urls) {
      const r = await c.get('/admin/api/' + u)
      assert.equal(r.status, 200, u)
      bodies.push([u, r.text])
    }
    // 同时覆盖：详情页（所有卡）+ 修订历史里的密钥
    db.prepare('INSERT INTO card_revisions (card_path, title, body, tags, kind, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(secretPath, 't', `旧版本 ${FAKE_SK} 与 password = "${SECRET_NEEDLES[1]}"`, '[]', 'tool', 'admin', '2026-09-20T00:00:00.000Z')
    db.prepare('INSERT INTO card_updates (card_id, content) VALUES ((SELECT id FROM cards WHERE path = ?), ?)').run(secretPath, `追加：${FAKE_SK}`)
    bodies.push(['card+revisions', (await c.get('/admin/api/card' + qs({ path: secretPath }))).text])
    for (const row of db.prepare('SELECT path FROM cards UNION ALL SELECT path FROM quarantine').all()) {
      bodies.push([row.path, (await c.get('/admin/api/card' + qs({ path: row.path }))).text])
    }
    for (const [u, text] of bodies) {
      for (const n of SECRET_NEEDLES) assert.ok(!text.includes(n), `${u} 泄露了假密钥 ${n.slice(0, 6)}…`)
      for (const hs of hashes) assert.ok(!text.includes(hs), `${u} 泄露令牌哈希`)
      assert.ok(!text.includes(plain), `${u} 泄露令牌明文`)
      assert.ok(!text.includes(pwHash), `${u} 泄露口令哈希`)
      assert.ok(!text.includes(sessionSid), `${u} 泄露会话 id`)
      assert.ok(!/BEGIN RSA PRIVATE KEY-----\s*MIIFAKE/.test(text), `${u} 泄露私钥块`)
    }
  })
})

test('密钥疑似卡：详情里正文被遮蔽、标明类型、其余正文保留；列表摘要同样遮蔽', async () => {
  await withAdminHub(async (h) => {
    const c = h.client(); await c.login()
    const p = getDb(h.home).prepare("SELECT path FROM cards WHERE title = '部署凭据备忘'").get().path
    const d = (await c.get('/admin/api/card' + qs({ path: p }))).json
    assert.equal(d.redacted, true)
    assert.ok(d.secretTypes.includes('openai-style-key'))
    assert.ok(d.secretTypes.includes('private-key'))
    assert.match(d.body, /部署说明/)
    assert.match(d.body, /已遮蔽/)
    const l = (await c.get('/admin/api/cards' + qs({ q: '部署凭据' }))).json.items.find((i) => i.path === p)
    assert.ok(l.secretTypes.length >= 2)
    assert.ok(!SECRET_NEEDLES.some((n) => l.excerpt.includes(n)))
    const normal = getDb(h.home).prepare("SELECT path FROM cards WHERE title = '项目决策 1'").get().path
    assert.equal((await c.get('/admin/api/card' + qs({ path: normal }))).json.redacted, false)
  })
})

const REQUIRED = [
  ['x-content-type-options', /nosniff/i],
  ['referrer-policy', /no-referrer|same-origin|strict-origin/i],
  ['x-frame-options', /deny/i],
  ['content-security-policy', /default-src 'self'/],
  ['content-security-policy', /frame-ancestors 'none'/],
  ['content-security-policy', /script-src 'self'/],
  ['content-security-policy', /object-src 'none'/],
  ['content-security-policy', /base-uri 'none'/],
]

test('安全响应头：静态页 / 静态资源 / 管理 API（含 401、404、错误）都带 CSP 等头；CSP 不允许 unsafe-inline / unsafe-eval', async () => {
  await withAdminHub(async (h) => {
    const c = h.client()
    const responses = [
      await c.get('/admin/', { raw: true }),
      await c.get('/admin/app.js', { raw: true }),
      await c.get('/admin/styles.css', { raw: true }),
      await c.get('/admin/api/overview'),
      await c.get('/admin/api/nope'),
      await c.get('/admin/nope.js', { raw: true }),
      await c.post('/admin/api/login', { password: 'x'.repeat(12) }),
    ]
    await c.login()
    responses.push(await c.get('/admin/api/overview'), await c.get('/admin/api/cards?limit=abc'))
    for (const r of responses) {
      for (const [hname, re] of REQUIRED) assert.match(r.headers.get(hname) || '', re, `${r.status} 缺 ${hname}`)
      const csp = r.headers.get('content-security-policy')
      assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp), csp)
    }
    const api = await c.get('/admin/api/overview')
    assert.match(api.headers.get('cache-control') || '', /no-store/)
    assert.match(api.headers.get('content-type') || '', /application\/json/)
  })
})

test('/mcp 与 /healthz 的响应不被管理界面的头改变（M1 行为不变）', async () => {
  await withAdminHub(async (h) => {
    const r = await fetch(h.url + '/healthz')
    assert.equal(r.status, 200)
    assert.equal((await r.json()).ok, true)
    const m = await fetch(h.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(m.status, 401)
    assert.match(m.headers.get('www-authenticate') || '', /^Bearer/)
  })
})

test('静态文件：/ 与 /admin 重定向到 /admin/；index.html 无内联脚本 / 样式 / 事件属性，资源均为相对路径', async () => {
  await withAdminHub(async (h) => {
    const c = h.client()
    for (const p of ['/', '/admin']) {
      const r = await c.get(p, { raw: true })
      assert.equal(r.status, 302, p)
      assert.equal(r.headers.get('location'), '/admin/')
    }
    const idx = await c.get('/admin/', { raw: true })
    assert.equal(idx.status, 200)
    assert.match(idx.headers.get('content-type'), /text\/html; charset=utf-8/)
    const html = idx.text
    assert.match(html, /lang="zh/)
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), '不得有内联脚本')
    assert.ok(!/<style[\s>]/i.test(html), '不得有内联样式块')
    assert.ok(!/\sstyle\s*=/i.test(html), '不得有 style 属性')
    assert.ok(!/\son[a-z]+\s*=/i.test(html), '不得有事件属性')
    assert.ok(!/(?:src|href)\s*=\s*["']\/(?!\/)/i.test(html), '资源必须是相对路径，才能在 basePath 下工作')
    assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]+"/g, '')), '不引用外部资源')
    assert.match(html, /<script[^>]+type="module"[^>]+src="\.\/app\.js"/)
    const js = await c.get('/admin/app.js', { raw: true })
    assert.match(js.headers.get('content-type'), /javascript/)
    const css = await c.get('/admin/styles.css', { raw: true })
    assert.match(css.headers.get('content-type'), /text\/css/)
  })
})

test('静态文件：路径穿越 / 编码穿越 / 空字节 / 目录 / 隐藏文件 / 非 GET 全部拒绝', async () => {
  await withAdminHub(async (h) => {
    const c = h.client()
    for (const p of ['/admin/..%2f..%2fpackage.json', '/admin/%2e%2e/package.json', '/admin/../package.json', '/admin/%2e%2e%2f%2e%2e%2fsrc%2fserver.js', '/admin/js%00.js', '/admin/js/', '/admin/js', '/admin/.hidden', '/admin//etc/passwd', '/admin/..\\package.json']) {
      const r = await c.get(p, { raw: true })
      assert.ok([301, 302, 400, 403, 404].includes(r.status), `${p} → ${r.status}`)
      assert.ok(!r.text.includes('"name": "memory-hub"') && !r.text.includes('startServer'), p)
    }
    assert.equal((await c.req('POST', '/admin/app.js', { body: {} })).status, 405)
  })
})

test('basePath：UI 与 API 都在前缀下工作，cookie Path 限定在 /memory/admin', async () => {
  await withAdminHub(async (h) => {
    const c = h.client()
    assert.equal((await c.get('/admin/', { raw: true })).status, 404, '无前缀路径不应存在')
    const r = await c.get('/memory/admin/', { raw: true })
    assert.equal(r.status, 200)
    assert.equal((await c.get('/memory/', { raw: true })).headers.get('location'), '/memory/admin/')
    const l = await c.post('/memory/admin/api/login', { password: PW })
    assert.equal(l.status, 200)
    assert.match(l.headers.getSetCookie().find((s) => s.startsWith('mh_sid=')), /Path=\/memory\/admin/)
    assert.equal((await c.get('/memory/admin/api/overview')).status, 200)
  }, { env: { MEMORY_HUB_BASE_PATH: '/memory' } })
})

test('Host 校验同样适用于管理界面（DNS rebinding 防护）', async () => {
  await withAdminHub(async (h) => {
    const http = await import('node:http')
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: h.port, path: '/admin/', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(status, 403)
  })
})

test('web/ 目录不含任何真实/合成之外的东西：无 sourcemap、无 .env、无 node_modules', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  const files = walk(path.join(ROOT, 'web'))
  assert.ok(files.length >= 5)
  for (const f of files) assert.ok(!/\.map$|\.env|node_modules/.test(f), f)
})
