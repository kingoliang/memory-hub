// 前端 · 令牌：归属人从账号下拉里选（不再手填）；创建成功后在同一个弹窗里给出接入命令（地址与令牌已填好）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDocument, walkNodes, textOf } from './fake-dom.mjs'

async function withFakeDom(fn) {
  const prev = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch }
  globalThis.document = new FakeDocument()
  globalThis.location = { href: 'https://memory-hub-x.example.test/admin/#/tokens', origin: 'https://memory-hub-x.example.test', pathname: '/admin/' }
  try { return await fn() } finally { Object.assign(globalThis, prev) }
}

test('mcpEndpoint：由管理界面地址推出 MCP 端点（含反代前缀）', async () => {
  await withFakeDom(async () => {
    const { mcpEndpoint } = await import('../../web/js/views/token-howto.js')
    assert.equal(mcpEndpoint({ origin: 'https://h.example', pathname: '/admin/' }), 'https://h.example/mcp')
    assert.equal(mcpEndpoint({ origin: 'https://h.example', pathname: '/memory/admin/' }), 'https://h.example/memory/mcp')
    assert.equal(mcpEndpoint({ origin: 'http://127.0.0.1:7990', pathname: '/admin' }), 'http://127.0.0.1:7990/mcp')
  })
})

test('howtoSnippets：三种客户端的命令都带上真实地址与令牌；没有令牌时用占位符', async () => {
  await withFakeDom(async () => {
    const { howtoSnippets } = await import('../../web/js/views/token-howto.js')
    const url = 'https://h.example/mcp'
    const withTok = howtoSnippets({ url, token: 'mh_abc_SECRET', name: 'mia-claude' })
    assert.deepEqual(withTok.map((s) => s.id), ['claude', 'codex', 'pi', 'verify'])
    assert.equal(withTok[0].code, `claude mcp add --transport http -s user memory-hub \\\n  ${url} \\\n  --header "Authorization: Bearer mh_abc_SECRET"`)
    assert.equal(withTok[1].code.includes('export MEMORY_HUB_TOKEN=mh_abc_SECRET'), true)
    assert.equal(withTok[1].code.includes(`url = "${url}"`), true)
    assert.equal(withTok[2].code.includes(`pi mcp add memory-hub --url ${url} --bearer-token-env-var MEMORY_HUB_TOKEN`), true)
    const noTok = howtoSnippets({ url })
    assert.equal(noTok.every((s) => !s.code.includes('mh_')), true)
    assert.equal(noTok[0].code.includes('Bearer <你的令牌>'), true)
  })
})

test('创建令牌后的弹窗：同时有令牌明文与接入命令（命令里的令牌就是这枚）', async () => {
  await withFakeDom(async () => {
    const { showTokenOnce } = await import('../../web/js/views/tokens.js')
    let modalBody = null
    const dialogs = await import('../../web/js/dialogs.js')
    // 不真的弹窗：拦截 openModal 拿到 body 检查
    const p = showTokenOnce({ name: 'mia-claude', token: 'mh_abc_SECRET', scopes: ['read', 'write'], expiresAt: null, owner: 'mia', team: 'remittance' }, {
      openModal: (o) => { modalBody = o.body; return { close() {} } },
    })
    assert.ok(modalBody, '应打开弹窗')
    const root = document.createElement('div'); for (const n of [].concat(modalBody)) if (n) root.appendChild(n)
    const t = textOf(root)
    assert.equal(t.includes('claude mcp add --transport http'), true)
    assert.equal(t.includes('Bearer mh_abc_SECRET'), true)
    assert.equal(t.includes('memory_whoami'), true)
    assert.match(t, /归属：mia · 团队 remittance/)
    void p; void dialogs
  })
})

test('管理员建令牌：归属人是账号下拉（不是文本框）；成员看不到归属人一栏', async () => {
  await withFakeDom(async () => {
    const { tokenFields } = await import('../../web/js/views/tokens.js')
    const users = [{ username: 'guoyouma', team: 'PayTool', role: 'lead' }, { username: 'mia', team: 'remittance', role: 'member' }]
    const admin = tokenFields({ isAdmin: true, users })
    const owner = admin.find((f) => f.name === 'owner')
    assert.equal(owner.type, 'select')
    assert.deepEqual(owner.options, [['', '（无主令牌：给自动化脚本用）'], ['guoyouma', 'guoyouma · PayTool · 团队管理员'], ['mia', 'mia · remittance · 成员']])
    assert.equal(admin.some((f) => f.name === 'team'), false, '团队跟着账号走，不再单独填')
    const member = tokenFields({ isAdmin: false, users: [] })
    assert.deepEqual(member.map((f) => f.name).includes('owner'), false)
  })
})
