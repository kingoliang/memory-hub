// 多客户端同时 memory_capture（HTTP 并发 + 两个 stdio 子进程，共用一个库）：不丢不坏，id / path 唯一
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { withHub } from './hub-helpers.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/memory-hub.mjs')
const uniqueText = (tag, i) => {
  // 每条文本用不同的随机"词表"，避免触发近似去重（本测试只关心并发写入，不测去重）
  const words = Array.from({ length: 40 }, () => Math.random().toString(36).slice(2, 8)).join(' ')
  return `# ${tag} 并发写入 ${i}\n\n结论：采用方案 ${tag}-${i}，原因是部署流程步骤简单。配置命令 ${words}。注意事项与版本依赖见 ${Math.random()}。`
}
const text = (r) => r.content.map((c) => c.text).join('')

test('3 个 HTTP 令牌 × 12 并发 + 2 个 stdio 进程 × 10 串行：全部落库，id / path 唯一，integrity_check=ok', async () => {
  const dedupOff = { MEMORY_DEDUP_THRESHOLD: '1', MEMORY_DEDUP_TITLE_AWARE: '0', MEMORY_DEDUP_PENDING: '0' }
  const saved = {}
  for (const [k, v] of Object.entries(dedupOff)) { saved[k] = process.env[k]; process.env[k] = v }
  try {
    await withHub(async (h) => {
      const httpClients = []
      for (const n of ['http-a', 'http-b', 'http-c']) {
        const c = new Client({ name: n, version: '1' })
        await c.connect(new StreamableHTTPClientTransport(new URL(h.url + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${h.token(n, ['write'])}` } } }))
        httpClients.push([n, c])
      }
      const stdioClients = []
      for (const n of ['stdio-a', 'stdio-b']) {
        const c = new Client({ name: n, version: '1' })
        await c.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, ...dedupOff, MEMORY_HUB_HOME: h.home, MEMORY_HUB_AGENT: n }, stderr: 'pipe' }))
        stdioClients.push([n, c])
      }
      const jobs = []
      for (const [n, c] of httpClients) for (let i = 0; i < 12; i++) jobs.push(c.callTool({ name: 'memory_capture', arguments: { text: uniqueText(n, i) } }))
      for (const [n, c] of stdioClients) jobs.push((async () => { const outs = []; for (let i = 0; i < 10; i++) outs.push(await c.callTool({ name: 'memory_capture', arguments: { text: uniqueText(n, i) } })); return outs })())
      const settled = await Promise.all(jobs)
      const outs = settled.flat().map((r) => JSON.parse(text(r)))
      assert.equal(outs.length, 3 * 12 + 2 * 10)
      for (const o of outs) assert.ok(o.ok === true && o.action === 'created', JSON.stringify(o))
      for (const [, c] of [...httpClients, ...stdioClients]) await c.close()

      const db = h.db()
      const rows = db.prepare('SELECT id, path, submitted_by FROM quarantine').all()
      assert.equal(rows.length, 56, '56 次 capture 必须全部落库（待审队列）')
      assert.equal(new Set(rows.map((r) => r.id)).size, 56)
      assert.equal(new Set(rows.map((r) => r.path)).size, 56)
      const by = Object.fromEntries(db.prepare('SELECT submitted_by s, COUNT(*) n FROM quarantine GROUP BY submitted_by').all().map((r) => [r.s, r.n]))
      assert.deepEqual(by, { 'http-a': 12, 'http-b': 12, 'http-c': 12, 'stdio-a': 10, 'stdio-b': 10 })
      assert.equal(db.prepare('SELECT COUNT(*) n FROM write_log WHERE tool = ? AND outcome = ?').get('memory_capture', 'ok').n, 56)
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    })
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})
