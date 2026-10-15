// 传输：双代协议 e2e + stdio 与 HTTP 行为一致
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { tmpHome, rmrf, durableText } from './helpers.mjs'
import { withHub } from './hub-helpers.mjs'
import { writeCard } from '../src/core/vault.js'
import { closeAllDb } from '../src/core/db.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const CLI = path.join(root, 'bin/memory-hub.mjs')

test('e2e：v1 与 v2 客户端（两代协议）都能 tools/list + memory_recall', () => {
  const r = spawnSync(process.execPath, [path.join(here, 'e2e/mcp-both-eras.mjs')], { encoding: 'utf8', timeout: 120000, cwd: root })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /BOTH-ERAS PASS/)
})

async function seed(home) {
  const cards = [
    ['knowledge', '数据库选型决策', '选择 SQLite 作为本地存储，原因是零依赖与单文件备份。'],
    ['project', 'Redis 缓存方案', 'Redis cache for sessions with ttl; 缓存穿透使用布隆过滤器。'],
  ]
  for (const [kind, title, body] of cards) await writeCard(home, { kind, title, body, status: 'approved', submittedBy: 'fx' }, { dedup: false })
  await writeCard(home, { kind: 'knowledge', title: '待审的卡', body: '这张卡还没有被批准的正文内容', status: 'pending', submittedBy: 'fx' }, { dedup: false })
  closeAllDb()
}

async function stdioClient(home, agent = 'stdio-agent') {
  const c = new Client({ name: 'stdio-test', version: '1' })
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, MEMORY_HUB_HOME: home, MEMORY_HUB_AGENT: agent }, stderr: 'pipe' }))
  return c
}
const text = (r) => r.content.map((c) => c.text).join('')

test('stdio 与 HTTP 下 recall / stats / audit_list 输出逐字一致，且格式与原版一致', async () => {
  await withHub(async (h) => {
    await seed(h.home)
    const tok = h.token('http-agent', ['read', 'write'])
    const http = new Client({ name: 'http-test', version: '1' })
    await http.connect(new StreamableHTTPClientTransport(new URL(h.url + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }))
    const stdio = await stdioClient(h.home)
    try {
      for (const [name, args] of [
        ['memory_recall', { query: '数据库选型' }],
        ['memory_recall', { query: '缓存', limit: 1 }],
        ['memory_recall', { query: '完全不存在的词xyz' }],
        ['memory_recall', { query: '   ' }],
        ['memory_stats', {}],
        ['memory_audit_list', {}],
        ['memory_audit_list', { status: 'all', limit: 1 }],
        ['memory_lint', {}],
      ]) {
        const a = text(await http.callTool({ name, arguments: args }))
        const b = text(await stdio.callTool({ name, arguments: args }))
        assert.equal(a, b, `${name} ${JSON.stringify(args)}`)
      }
      // 与原版 mcp.js 的输出格式一致（见 memory-eternal-fork/lib/mcp.js callTool）
      const recall = text(await stdio.callTool({ name: 'memory_recall', arguments: { query: '数据库选型' } }))
      assert.match(recall, /^从记忆核心检索到 1 条相关卡片：\n\n### 1\. 数据库选型决策\n路径：03-Knowledge\/数据库选型决策\.md\n/)
      assert.equal(text(await stdio.callTool({ name: 'memory_recall', arguments: { query: '完全不存在的词xyz' } })), '记忆库中没有与「完全不存在的词xyz」相关的内容。')
      assert.equal(text(await stdio.callTool({ name: 'memory_recall', arguments: { query: '  ' } })), '（未提供检索词）')
      const stats = JSON.parse(text(await stdio.callTool({ name: 'memory_stats', arguments: {} })))
      assert.deepEqual(Object.keys(stats).sort(), ['byKind', 'tags', 'total', 'vaultDir', 'week'])
      assert.equal(stats.total, 2)
      assert.deepEqual(stats.byKind, { knowledge: 1, project: 1 })
      assert.match(text(await stdio.callTool({ name: 'memory_audit_list', arguments: {} })), /^待处理 1 张（status=pending，vault: .+）：\n\n1\. \[pending\] knowledge · 待审的卡\n   路径：.+\n\n（只读列表。批准\/驳回请由用户/)
    } finally { await http.close(); await stdio.close() }
  })
})

test('stdio 与 HTTP 下 memory_capture 行为一致（同输入 → 同 action / 路径 / 降级标记）', async () => {
  const homeA = tmpHome(), homeB = tmpHome()
  try {
    const body = durableText('传输一致性', 1)
    const stdio = await stdioClient(homeA)
    const outStdio = JSON.parse(text(await stdio.callTool({ name: 'memory_capture', arguments: { text: body } })))
    const again = JSON.parse(text(await stdio.callTool({ name: 'memory_capture', arguments: { text: body } })))
    await stdio.close()
    await withHub(async (h) => {
      const tok = h.token('http-agent', ['write'])
      const http = new Client({ name: 'http-test', version: '1' })
      await http.connect(new StreamableHTTPClientTransport(new URL(h.url + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }))
      const outHttp = JSON.parse(text(await http.callTool({ name: 'memory_capture', arguments: { text: body } })))
      const againHttp = JSON.parse(text(await http.callTool({ name: 'memory_capture', arguments: { text: body } })))
      await http.close()
      assert.deepEqual(outHttp, outStdio)
      assert.deepEqual(againHttp, again)
    }, {})
    assert.equal(outStdio.ok, true)
    assert.equal(outStdio.action, 'created')
    assert.equal(outStdio.degraded, true)
    assert.equal(again.ok, true)
    assert.notEqual(again.action, 'created', '同文再次沉淀不得新建重复卡')
  } finally { closeAllDb(); rmrf(homeA); rmrf(homeB) }
})

test('stdio 署名：来自 MEMORY_HUB_AGENT，不被 source 参数冒充；write_log 标记 self-asserted', async () => {
  const home = tmpHome()
  try {
    const stdio = await stdioClient(home, 'claude-stdio')
    const out = JSON.parse(text(await stdio.callTool({ name: 'memory_capture', arguments: { text: durableText('stdio 署名'), source: 'trusted' } })))
    await stdio.close()
    const { getDb } = await import('../src/core/db.js')
    const db = getDb(home)
    const row = db.prepare('SELECT submitted_by, source FROM quarantine WHERE path = ?').get(out.path)
    assert.equal(row.submitted_by, 'claude-stdio')
    assert.equal(row.source, 'trusted')
    const log = db.prepare("SELECT * FROM write_log WHERE tool = 'memory_capture'").get()
    assert.equal(log.actor_name, 'claude-stdio')
    assert.match(log.actor_id, /self-asserted/)
  } finally { closeAllDb(); rmrf(home) }
})

test('stdio 同样带 instructions，并且 stdout 只输出协议（日志走 stderr）', async () => {
  const home = tmpHome()
  try {
    const stdio = await stdioClient(home)
    assert.match(stdio.getInstructions() || '', /memory_capture/)
    const tools = (await stdio.listTools()).tools.map((t) => t.name)
    assert.ok(tools.includes('memory_recall') && !tools.includes('memory_tidy_apply'))
    await stdio.close()
  } finally { closeAllDb(); rmrf(home) }
})
