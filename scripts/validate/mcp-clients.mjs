#!/usr/bin/env node
// MCP 官方 SDK 客户端实测（v2 两种握手 + v1.32.1）：tools/list、recall、capture、只读令牌被拒、无令牌/吊销令牌 401。
// 用法：mcp-clients.mjs --url http://127.0.0.1:7991/mcp --rw-token-file F --ro-token-file F --revoked-token-file F [--created-out F.json]
// 需要 @modelcontextprotocol/client 与 @modelcontextprotocol/sdk@1.32.1 可被解析（在 /tmp 临时目录 npm i 后把本脚本拷进去运行）。
// 令牌只从文件读，不打印；capture 的内容是合成文本，产出卡的 path 写入 --created-out 供事后删除。
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Client as V2Client, StreamableHTTPClientTransport as V2Http } from '@modelcontextprotocol/client'
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as V1Http } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const arg = (n) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : undefined }
const url = new URL(arg('url'))
const tok = (f) => fs.readFileSync(arg(f), 'utf8').trim()
const rw = tok('rw-token-file'), ro = tok('ro-token-file'), revoked = tok('revoked-token-file')
const hdr = (t) => ({ authorization: `Bearer ${t}` })
const synthetic = (label) => `# 验证用合成条目 ${label}\n\n背景：这是部署验证脚本生成的合成文本（标记 ZZSYN-${crypto.randomBytes(5).toString('hex')}），不对应任何真实事项。结论：配置通过环境变量注入，原因是部署时不需要改代码，也便于多机保持一致。步骤：先备份数据库，再重启服务，最后检查日志与健康检查接口。注意：不要把密钥写进仓库。`

const results = []
const created = []
const rec = (label, ok, detail = '') => { results.push({ label, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' :: ' + detail : ''}`) }

async function exercise(era, make) {
  // 1) 读写令牌：list / recall / capture
  const c = make(rw)
  try {
    const tools = (await c.listTools()).tools.map((t) => t.name)
    rec(`${era} rw tools/list 含 recall+capture`, tools.includes('memory_recall') && tools.includes('memory_capture'), `${tools.length} 个工具`)
    const r = await c.callTool({ name: 'memory_recall', arguments: { query: '部署' } })
    rec(`${era} rw memory_recall 正常返回`, !r.isError && (r.content?.[0]?.text || '').length > 0)
    const w = await c.callTool({ name: 'memory_capture', arguments: { text: synthetic(era), source: 'staging-verify' } })
    const text = w.content?.map((x) => x.text).join('') ?? ''
    let out = null; try { out = JSON.parse(text) } catch { /* 非 JSON */ }
    rec(`${era} rw memory_capture 成功`, !w.isError && !!out, out ? `action=${out.action} kind=${out.kind ?? '-'} status=${out.status ?? '-'} degraded=${out.degraded ?? false}` : text.slice(0, 80))
    if (out?.path) created.push(out.path)
    rec(`${era} client.getInstructions() 非空`, !!c.getInstructions?.())
  } catch (e) { rec(`${era} rw 流程`, false, String(e?.message || e).slice(0, 200)) } finally { await c.close().catch(() => {}) }
  // 2) 只读令牌：list 不含写工具；调用写工具被拒
  const r = make(ro)
  try {
    const tools = (await r.listTools()).tools.map((t) => t.name)
    rec(`${era} ro tools/list 不含 memory_capture`, !tools.includes('memory_capture') && tools.includes('memory_recall'))
    let denied = false, why = ''
    try { const o = await r.callTool({ name: 'memory_capture', arguments: { text: synthetic(era + '-ro') } }); denied = !!o.isError; why = 'isError' } catch (e) { denied = true; why = String(e?.message || e).slice(0, 80) }
    rec(`${era} ro 调 memory_capture 被拒`, denied, why)
  } catch (e) { rec(`${era} ro 流程`, false, String(e?.message || e).slice(0, 200)) } finally { await r.close().catch(() => {}) }
  // 3) 无令牌 / 吊销令牌：连接必须失败
  for (const [name, t] of [['无令牌', null], ['吊销令牌', revoked]]) {
    const x = make(t)
    let failed = false, msg = ''
    try { await x.listTools() } catch (e) { failed = true; msg = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 100) }
    rec(`${era} ${name} 连接被拒`, failed, msg)
    await x.close().catch(() => {})
  }
}

// 每次 make 都新建 client + transport，并立刻 connect（listTools 之前）
const mk2 = (modern) => (t) => {
  const c = new V2Client({ name: modern ? 'v2-modern' : 'v2-legacy', version: '1' }, modern ? { versionNegotiation: { mode: 'auto' } } : {})
  const tr = new V2Http(url, { requestInit: { headers: t ? hdr(t) : {} } })
  const connect = c.connect(tr)
  const wrap = (fn) => async (...a) => { await connect; return fn(...a) }
  return { listTools: wrap(() => c.listTools()), callTool: wrap((p) => c.callTool(p)), getInstructions: () => c.getInstructions(), close: () => c.close() }
}
const mk1 = (t) => {
  const c = new V1Client({ name: 'v1', version: '1' })
  const connect = c.connect(new V1Http(url, { requestInit: { headers: t ? hdr(t) : {} } }))
  const wrap = (fn) => async (...a) => { await connect; return fn(...a) }
  return { listTools: wrap(() => c.listTools()), callTool: wrap((p) => c.callTool(p)), getInstructions: () => c.getInstructions(), close: () => c.close() }
}

await exercise('v2/2026-07-28(server/discover)', mk2(true))
await exercise('v2/2025(initialize)', mk2(false))
await exercise('v1.32.1', mk1)

// 4) 裸 HTTP：状态码（无令牌、吊销、只读调写 → 401/401/403）
const post = async (t, body) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(t ? hdr(t) : {}) }, body: JSON.stringify(body) })).status
const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
const scode = { none: await post(null, list), revoked: await post(revoked, list), roWrite: await post(ro, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_capture', arguments: { text: synthetic('raw') } } }) }
rec('裸 HTTP 无令牌=401 / 吊销=401 / 只读调写=403', scode.none === 401 && scode.revoked === 401 && scode.roWrite === 403, JSON.stringify(scode))

if (arg('created-out')) fs.writeFileSync(arg('created-out'), JSON.stringify(created), { mode: 0o600 })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? '，失败：' + failed.map((f) => f.label).join(' | ') : ''}`)
process.exit(failed.length ? 1 : 0)
