// 测试公共工具：临时目录、日志捕获、服务启动、JSON-RPC 请求、mock OpenAI 兼容服务
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Writable } from 'node:stream'

export function tmpHome(prefix = 'mh-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
export function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/** 捕获日志输出的 Writable。 */
export function logSink() {
  const chunks = []
  const stream = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb() } })
  return { stream, text: () => chunks.join(''), lines: () => chunks.join('').split('\n').filter(Boolean) }
}

export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

/** 发一条 JSON-RPC（2025 年代无状态形态：直接 tools/list / tools/call，不握手）。 */
export async function rpc(baseUrl, token, method, params = {}, { headers = {}, id = 1, path: p = '/mcp' } = {}) {
  const h = { ...MCP_HEADERS, 'mcp-protocol-version': '2025-06-18', ...headers }
  if (token) h.authorization = `Bearer ${token}`
  const res = await fetch(baseUrl + p, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
  const raw = await res.text()
  let body = null
  try { body = JSON.parse(raw) } catch {
    // SSE 响应：取 data: 行
    const m = /^data: (.+)$/m.exec(raw)
    if (m) { try { body = JSON.parse(m[1]) } catch { /* ignore */ } }
  }
  return { status: res.status, headers: res.headers, body, raw }
}

export const toolText = (r) => r.body?.result?.content?.map((c) => c.text).join('') ?? ''

/** 长度足够、含可复用信号的沉淀文本（过得了 120 字符闸与 looksDurable）。 */
export function durableText(topic, n = 0) {
  return `# ${topic} 方案决策 ${n}\n\n背景：${topic}在项目里需要统一做法。结论：采用配置文件加环境变量的方案，原因是部署时不需要改代码，` +
    `并且便于在多台机器上保持一致。步骤：第一步确认依赖版本，第二步写入配置，第三步重启服务并检查日志。注意事项：不要把密钥写进仓库，` +
    `命令执行前先备份数据库。编号 ${n} ${Math.random().toString(36).slice(2)}。`
}

/** 本地 mock 的 OpenAI 兼容服务（记录请求，不依赖任何外部网关）。 */
export async function startMockLlm(reply) {
  const seen = []
  const srv = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    seen.push({ url: req.url, auth: req.headers.authorization || '', body })
    const content = typeof reply === 'function' ? reply(body) : reply
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
  }).listen(0, '127.0.0.1')
  await new Promise((r) => srv.on('listening', r))
  return { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, seen, close: () => new Promise((r) => srv.close(r)) }
}

