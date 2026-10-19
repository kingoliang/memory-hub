// 前端 · 多用户：登录带用户名、口令框不明文、用户页渲染。
// 导航裁剪只是体验（真正的权限在服务端），这里锁「成员看不到管理员入口」这条体验契约。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDocument, walkNodes, textOf } from './fake-dom.mjs'

async function withFakeDom(fn) {
  const prev = { document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch }
  globalThis.document = new FakeDocument()
  globalThis.location = { href: 'http://localhost/admin/', hash: '' }
  try { return await fn() } finally { Object.assign(globalThis, prev) }
}
const inputs = (root) => [...walkNodes(root)].filter((n) => n.tagName === 'INPUT')

test('登录页：有用户名框与口令框，口令框是 password 类型；提交时带上用户名', async () => {
  await withFakeDom(async () => {
    const sent = []
    globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, csrfToken: 'x' }) } }
    const { renderLogin } = await import('../../web/js/views/login.js')
    let done = 0
    const root = renderLogin({ passwordSet: true, onSuccess: () => { done++ } })
    const [user, pw] = inputs(root)
    assert.deepEqual([user.attributes.name, user.attributes.type, pw.attributes.name, pw.attributes.type], ['username', 'text', 'password', 'password'])
    user.value = ' Mia '
    pw.value = 'secret-pass-1234'
    const form = [...walkNodes(root)].find((n) => n.tagName === 'FORM')
    await form.listeners.submit[0]({ preventDefault() {} })
    assert.deepEqual(sent, [{ username: 'Mia', password: 'secret-pass-1234' }])
    assert.equal(done, 1)
    assert.equal(pw.value, '', '提交后清空口令框')
  })
})

test('登录页：用户名留空 = 应急入口，请求里不带 username 字段', async () => {
  await withFakeDom(async () => {
    const sent = []
    globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, csrfToken: 'x' }) } }
    const { renderLogin } = await import('../../web/js/views/login.js')
    const root = renderLogin({ passwordSet: true, onSuccess: () => {} })
    inputs(root)[1].value = 'break-glass-pass-1'
    await [...walkNodes(root)].find((n) => n.tagName === 'FORM').listeners.submit[0]({ preventDefault() {} })
    assert.deepEqual(sent, [{ password: 'break-glass-pass-1' }])
  })
})

test('登录页：应急口令未设置时表单仍可用（具名账号能登录），并给出说明', async () => {
  await withFakeDom(async () => {
    const { renderLogin } = await import('../../web/js/views/login.js')
    const root = renderLogin({ passwordSet: false, onSuccess: () => {} })
    const btn = [...walkNodes(root)].find((n) => n.tagName === 'BUTTON' && n.attributes.type === 'submit')
    assert.equal(btn.attributes.disabled, undefined)
    assert.match(textOf(root), /应急入口未启用/)
  })
})

test('用户页：列表渲染，用户名等字段只作为文本（不解析 HTML）', async () => {
  await withFakeDom(async () => {
    const evil = '<img src=x onerror=alert(1)>'
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 1, username: 'mia', team: evil, role: 'member', disabled: false, createdAt: '2026-10-19T00:00:00Z', lastLoginAt: null }] }) })
    const { default: render } = await import('../../web/js/views/users.js')
    const root = await render({ setTitle() {}, reload() {}, go() {} })
    const t = textOf(root)
    assert.equal(t.includes('mia'), true)
    assert.equal(t.includes(evil), true)
    assert.equal([...walkNodes(root)].some((n) => n.tagName === 'IMG'), false)
  })
})

test('总览页：成员视角（服务端 vault=null、无写日志）也能渲染，不出现回收站 / 库大小 / 写入记录', async () => {
  await withFakeDom(async () => {
    const memberOverview = {
      cards: { total: 3, byKind: { knowledge: 3 }, tags: 1, recent7d: 3 },
      quarantine: { pending: 0, rejected: 0, deleted: 0 },
      daily: [{ date: '2026-10-19', count: 3 }], vault: null, agents: [{ name: 'mia', cards: 3 }], recentLog: [],
      llm: { configured: false, model: null }, alerts: [],
    }
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => memberOverview })
    const { default: render } = await import('../../web/js/views/overview.js')
    const root = await render({ setTitle() {}, me: { username: 'mia', team: 'remittance', role: 'member' } })
    const t = textOf(root)
    assert.deepEqual([t.includes('回收站'), t.includes('库大小'), t.includes('最近写入记录'), t.includes('卡片总数')], [false, false, false, true])
  })
})

test('卡片详情：按服务端下发的 can 显示写按钮（看得见但不能改的卡没有编辑 / 软删 / 回滚）', async () => {
  await withFakeDom(async () => {
    const { renderCardDetail } = await import('../../web/js/views/card.js')
    const base = {
      path: '03-Knowledge/x.md', title: '别人的团队卡', kind: 'knowledge', tags: [], status: 'approved', body: '正文',
      submittedBy: 'bob', agent: 'bob', source: '', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z', deletedAt: null,
      signedByToken: null, updates: [], revisions: [{ id: 1, title: 't', body: 'b', tags: [], kind: 'knowledge', editedBy: 'x', editedAt: '2026-10-19' }],
      history: [], redacted: false, secretTypes: [], quarantine: null, retention: null, writes: [],
    }
    const buttons = (card) => [...walkNodes(renderCardDetail(card, { reload() {}, go() {} }))].filter((n) => n.tagName === 'BUTTON').map((n) => textOf(n).trim())
    const ro = buttons({ ...base, can: { edit: false, moderate: false, purge: false } })
    assert.deepEqual([ro.includes('编辑'), ro.includes('软删'), ro.includes('回滚到此版本')], [false, false, false])
    const rw = buttons({ ...base, can: { edit: true, moderate: false, purge: false } })
    assert.deepEqual([rw.includes('编辑'), rw.includes('软删'), rw.includes('回滚到此版本')], [true, true, true])
  })
})
