// 令牌 × 归属三元组（owner / team / default_visibility）。
//
// 这是「团队分层检索」的**接线层**：scope.js 的分层逻辑只认 identity.owner/team，
// 而 identity 由令牌决定。所以只要这三列没真正接上，线上一切都会退化成"全算自己"——
// 单元测试全是绿的，团队语义却完全不生效（典型的"测试通过 ≠ 功能存在"）。
//
// 断言风格：期望值写死为字面量；集合用 deepEqual 整值比。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { tmpHome, rmrf, durableText } from './helpers.mjs'
import { withHub } from './hub-helpers.mjs'
import { closeAllDb, getDb } from '../src/core/db.js'
import { ensureVault, writeCard } from '../src/core/vault.js'
import {
  createToken, updateToken, listTokens, verifyToken, importLegacyToken, validateVisibility,
  VISIBILITY_VALUES, DEFAULT_VISIBILITY, TokenError,
} from '../src/auth/tokens.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const CLI = path.join(root, 'bin/memory-hub.mjs')
const text = (r) => r.content.map((c) => c.text).join('')

// ─────────────────────────────────────────────────────────── 常量与校验

test('可见性常量是完整集合，默认值写死为 team', () => {
  assert.deepEqual(VISIBILITY_VALUES, ['private', 'team', 'public'])
  assert.equal(DEFAULT_VISIBILITY, 'team')
})

test('validateVisibility：只认三个字面量，其余抛 TokenError', () => {
  assert.deepEqual(
    ['private', 'team', 'public', undefined, null, '', 'team '].map(validateVisibility),
    ['private', 'team', 'public', 'team', 'team', 'team', 'team'],
  )
  for (const bad of ['PRIVATE', 'shared', 7]) {
    assert.throws(() => validateVisibility(bad), (e) => e instanceof TokenError && /visibility 只能是 private \/ team \/ public/.test(e.message), String(bad))
  }
})

// ─────────────────────────────────────────────────────────── 创建 / 读回 / 校验令牌

test('createToken：三元组落库、listTokens 原样读回，缺省为 team 可见性', () => {
  const home = tmpHome()
  try {
    const a = createToken(home, { name: 'claude-kingo', scopes: 'read,write', owner: 'kingo', team: 'remittance', defaultVisibility: 'private' })
    const b = createToken(home, { name: 'codex-nobody', scopes: 'read' })
    const rows = listTokens(home)
    // 用 name→三元组的映射断言，避免两条令牌 created_at 落在同一毫秒时受 token_id 随机序影响
    assert.deepEqual(
      Object.fromEntries(rows.map((r) => [r.name, [r.owner, r.team, r.defaultVisibility]])),
      { 'claude-kingo': ['kingo', 'remittance', 'private'], 'codex-nobody': ['', '', 'team'] },
    )
    assert.deepEqual([a.owner, a.team, a.defaultVisibility], ['kingo', 'remittance', 'private'])
    assert.deepEqual([b.owner, b.team, b.defaultVisibility], ['', '', 'team'])
    // 库里存的是列，不是 tags / JSON 之类的旁路
    assert.deepEqual(
      getDb(home).prepare('SELECT owner, team, default_visibility FROM agent_tokens ORDER BY name').all().map((r) => [r.owner, r.team, r.default_visibility]),
      [['kingo', 'remittance', 'private'], ['', '', 'team']],
    )
  } finally { closeAllDb(); rmrf(home) }
})

test('owner / team 校验：允许空串，非法字符与超长抛 TokenError', () => {
  const home = tmpHome()
  try {
    assert.equal(createToken(home, { name: 'n1', scopes: 'read', owner: '', team: '' }).owner, '')
    assert.throws(() => createToken(home, { name: 'n2', scopes: 'read', owner: 'kingo liang' }), (e) => e instanceof TokenError && /owner/.test(e.message))
    assert.throws(() => createToken(home, { name: 'n3', scopes: 'read', team: 'a'.repeat(65) }), (e) => e instanceof TokenError && /team/.test(e.message))
    assert.throws(() => createToken(home, { name: 'n4', scopes: 'read', defaultVisibility: 'shared' }), TokenError)
  } finally { closeAllDb(); rmrf(home) }
})

test('verifyToken 把三元组带出来（HTTP 身份的唯一来源）', () => {
  const home = tmpHome()
  try {
    const t = createToken(home, { name: 'claude-kingo', scopes: 'read,write', owner: 'kingo', team: 'remittance', defaultVisibility: 'public' })
    const v = verifyToken(home, t.token)
    assert.equal(v.ok, true)
    assert.deepEqual(
      { tokenId: v.token.tokenId, name: v.token.name, scopes: v.token.scopes, owner: v.token.owner, team: v.token.team, visibility: v.token.visibility },
      { tokenId: t.tokenId, name: 'claude-kingo', scopes: ['read', 'write'], owner: 'kingo', team: 'remittance', visibility: 'public' },
    )
  } finally { closeAllDb(); rmrf(home) }
})

test('updateToken 改 owner / team / defaultVisibility，未给的字段不动', () => {
  const home = tmpHome()
  try {
    createToken(home, { name: 'claude-kingo', scopes: 'read', owner: 'kingo' })
    const id = listTokens(home)[0].tokenId
    updateToken(home, id, { owner: 'liang', team: 'payments', defaultVisibility: 'private' })
    assert.deepEqual(listTokens(home).map((r) => [r.owner, r.team, r.defaultVisibility]), [['liang', 'payments', 'private']])
    updateToken(home, id, { team: 'remittance' })
    assert.deepEqual(listTokens(home).map((r) => [r.owner, r.team, r.defaultVisibility]), [['liang', 'remittance', 'private']])
  } finally { closeAllDb(); rmrf(home) }
})

test('importLegacyToken 同样接受三元组', () => {
  const home = tmpHome()
  try {
    importLegacyToken(home, { name: 'legacy-old', token: 'x'.repeat(40), scopes: 'read', owner: 'kingo', team: 'remittance', defaultVisibility: 'team' })
    assert.deepEqual(listTokens(home).map((r) => [r.owner, r.team, r.defaultVisibility]), [['kingo', 'remittance', 'team']])
  } finally { closeAllDb(); rmrf(home) }
})

// ─────────────────────────────────────────────────────────── HTTP 身份接线

const auditNone = (h) => h.db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','none')").run()
const put = (home, title, c) => writeCard(home, {
  kind: 'knowledge', title, body: `${title} 的正文：统一采用配置方案，原因是部署时不用改代码，步骤是先备份再重启。`,
  status: 'approved', submittedBy: c.owner || 'system', ...c,
}, { dedup: false })

async function httpClient(url, token) {
  const c = new Client({ name: 'scope-test', version: '1' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return c
}

test('HTTP 身份来自令牌：whoami 暴露 owner/team/可见性', async () => {
  await withHub(async (h) => {
    const tok = h.token('claude-alice', ['read', 'write'], { owner: 'alice', team: 'remittance', defaultVisibility: 'private' })
    const c = await httpClient(h.url, tok)
    try {
      assert.deepEqual(JSON.parse(text(await c.callTool({ name: 'memory_whoami', arguments: {} }))), {
        name: 'claude-alice', owner: 'alice', team: 'remittance', visibility: 'private', recall_scope: 'auto',
      })
    } finally { await c.close() }
  })
})

test('端到端：A 看得到自己的与同团队的，看不到同团队他人的 private、他人的卡只读', async () => {
  await withHub(async (h) => {
    auditNone(h)
    await ensureVault(h.home)
    await put(h.home, '部署流程自己的', { owner: 'kingo', team: 'remittance', visibility: 'team' })
    await put(h.home, '部署流程同团队', { owner: 'alice', team: 'remittance', visibility: 'team' })
    await put(h.home, '部署流程他人私卡', { owner: 'alice', team: 'remittance', visibility: 'private' })
    await put(h.home, '部署流程跨团队公开', { owner: 'bob', team: 'payments', visibility: 'public' })
    closeAllDb()

    const c = await httpClient(h.url, h.token('claude-kingo', ['read', 'write'], { owner: 'kingo', team: 'remittance' }))
    try {
      const body = text(await c.callTool({ name: 'memory_recall', arguments: { query: '部署流程' } }))
      assert.deepEqual(body.split('\n').filter((l) => /^### /.test(l)).map((l) => l.replace(/^### \d+\. /, '')), ['部署流程自己的', '部署流程同团队', '部署流程跨团队公开'])
      assert.deepEqual(body.split('\n').filter((l) => /^\[/.test(l)), ['[自己的记忆] 1 条', '[团队 · alice] 1 条', '[公开 · bob] 1 条'])
    } finally { await c.close() }
  })
})

test('HTTP 写入用的可见性取自令牌默认值，可被参数覆盖', async () => {
  await withHub(async (h) => {
    auditNone(h)
    // 两张卡正文必须真的不同，否则会被去重合并成一张，可见性就测不出来了
    const c = await httpClient(h.url, h.token('claude-kingo', ['read', 'write'], { owner: 'kingo', team: 'remittance', defaultVisibility: 'private' }))
    try {
      const t1 = durableText('可见性默认值')
      const t2 = '踩坑：并发写会撞 SQLITE_BUSY。结论是必须给连接设 busy_timeout，因为默认是 0；而且切成 journal_mode=WAL 时 busy_timeout 兜不住，必须自己重试。步骤是先设 pragma，再带退避重试，最后断言没有半途被杀掉的进程。这条经验来自 2026-10-18 的实测，值 5000 毫秒。'
      assert.equal(t1.length > 120, true)
      assert.equal(t2.length > 120, true)
      await c.callTool({ name: 'memory_capture', arguments: { text: t1 } })
      await c.callTool({ name: 'memory_capture', arguments: { text: t2, visibility: 'public' } })
    } finally { await c.close() }
    assert.deepEqual(
      h.db().prepare('SELECT owner, team, visibility FROM cards ORDER BY id').all().map((r) => [r.owner, r.team, r.visibility]),
      [['kingo', 'remittance', 'private'], ['kingo', 'remittance', 'public']],
    )
  })
})

// ─────────────────────────────────────────────────────────── stdio 身份接线

test('stdio 身份来自 MEMORY_HUB_OWNER / MEMORY_HUB_TEAM / MEMORY_HUB_VISIBILITY', async () => {
  const home = tmpHome()
  try {
    const c = new Client({ name: 'stdio-scope', version: '1' })
    await c.connect(new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp'],
      env: { ...process.env, MEMORY_HUB_HOME: home, MEMORY_HUB_AGENT: 'local-claude', MEMORY_HUB_OWNER: 'kingo', MEMORY_HUB_TEAM: 'remittance', MEMORY_HUB_VISIBILITY: 'private' },
      stderr: 'pipe',
    }))
    try {
      assert.deepEqual(JSON.parse(text(await c.callTool({ name: 'memory_whoami', arguments: {} }))), {
        name: 'local-claude', owner: 'kingo', team: 'remittance', visibility: 'private', recall_scope: 'auto',
      })
    } finally { await c.close() }
  } finally { closeAllDb(); rmrf(home) }
})

// ─────────────────────────────────────────────────────────── CLI

test('CLI token create 接受 --owner/--team/--visibility，list --json 读得回', () => {
  const home = tmpHome()
  try {
    const env = { ...process.env, MEMORY_HUB_HOME: home }
    const created = spawnSync(process.execPath, [CLI, 'token', 'create', '--name', 'claude-kingo', '--scope', 'read,write', '--owner', 'kingo', '--team', 'remittance', '--visibility', 'private'], { encoding: 'utf8', env })
    assert.equal(created.status, 0, created.stdout + created.stderr)
    const listed = spawnSync(process.execPath, [CLI, 'token', 'list', '--json'], { encoding: 'utf8', env })
    assert.equal(listed.status, 0, listed.stderr)
    assert.deepEqual(JSON.parse(listed.stdout).map((r) => [r.name, r.owner, r.team, r.defaultVisibility]), [['claude-kingo', 'kingo', 'remittance', 'private']])
    // 文本 list 也要带上归属，否则人肉核对时看不出这枚令牌是谁的
    const human = spawnSync(process.execPath, [CLI, 'token', 'list'], { encoding: 'utf8', env })
    assert.match(human.stdout, /kingo\tremittance\tprivate\t/)
  } finally { closeAllDb(); rmrf(home) }
})
