// v1 + v2 客户端（2025 年代 initialize 握手 / 2026-07-28 server/discover）各连一次 POST /mcp：tools/list + memory_recall。
// 用法：node tests/e2e/mcp-both-eras.mjs   退出码 0 = 通过
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client as V2Client, StreamableHTTPClientTransport as V2Http } from '@modelcontextprotocol/client'
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as V1Http } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadConfig } from '../../src/config.js'
import { startServer } from '../../src/server.js'
import { createToken } from '../../src/auth/tokens.js'
import { writeCard } from '../../src/core/vault.js'
import { closeAllDb } from '../../src/core/db.js'
import { createLogger } from '../../src/logger.js'
import { Writable } from 'node:stream'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-eras-'))
const quiet = new Writable({ write(_c, _e, cb) { cb() } })
const config = loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: '0' })
const srv = await startServer(config, { logger: createLogger({ level: 'error', stream: quiet }), scheduler: false })
const url = new URL(`http://127.0.0.1:${srv.port}/mcp`)
await writeCard(home, { kind: 'knowledge', title: '数据库选型决策', body: '选择 SQLite 作为存储，零依赖。', status: 'approved', submittedBy: 'fx' }, { dedup: false })
const token = createToken(home, { name: 'eras-test', scopes: ['read', 'write'] }).token
const headers = { authorization: `Bearer ${token}` }

const results = []
async function exercise(label, client, connect) {
  try {
    await connect()
    const tools = (await client.listTools()).tools.map((t) => t.name)
    const out = await client.callTool({ name: 'memory_recall', arguments: { query: '数据库选型' } })
    const text = out.content?.map((c) => c.text).join('') ?? ''
    const ok = tools.includes('memory_recall') && tools.includes('memory_capture') && /数据库选型决策/.test(text) && !out.isError && !!client.getInstructions()
    results.push({ label, ok, tools: tools.length })
    await client.close()
  } catch (e) {
    results.push({ label, ok: false, error: String(e?.message || e) })
  }
}

const c2m = new V2Client({ name: 'v2-modern', version: '1' }, { versionNegotiation: { mode: 'auto' } })
await exercise('v2 客户端 / 2026-07-28 (server/discover)', c2m, () => c2m.connect(new V2Http(url, { requestInit: { headers } })))
const c2l = new V2Client({ name: 'v2-legacy', version: '1' })
await exercise('v2 客户端 / 2025 年代 (initialize)', c2l, () => c2l.connect(new V2Http(url, { requestInit: { headers } })))
const c1 = new V1Client({ name: 'v1', version: '1' })
await exercise('v1 客户端 (@modelcontextprotocol/sdk 1.32.1)', c1, () => c1.connect(new V1Http(url, { requestInit: { headers } })))

await srv.close(); closeAllDb(); fs.rmSync(home, { recursive: true, force: true })
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.label}${r.error ? ' :: ' + r.error : ''}`)
const pass = results.length === 3 && results.every((r) => r.ok)
console.log(pass ? 'BOTH-ERAS PASS' : 'BOTH-ERAS FAIL')
process.exit(pass ? 0 : 1)
