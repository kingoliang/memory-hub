import http from 'node:http'

/** 假 hub：记录请求；responder(i, req) 返回 {http, body}（默认 captured）。 */
export async function fakeHub(responder) {
  const reqs = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const i = reqs.length
      let body = null
      try { body = JSON.parse(raw) } catch { /* ignore */ }
      reqs.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      const r = (responder ? await responder(i, body) : null) || { http: 200, body: { status: 'captured', cards: [{ id: 1, action: 'created', pending: true }] } }
      if (r.hang) return // 不响应，测超时
      res.writeHead(r.http, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.body))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { reqs, url: `http://127.0.0.1:${srv.address().port}/memory/api/ingest`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) }) }
}

export const silentLog = () => {
  const calls = []
  const mk = (level) => (...a) => { calls.push({ level, text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }) }
  return { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), calls }
}

let ts = 1_700_000_000_000
export const u = (text) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: ++ts })
export const a = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: ++ts, ...extra })

/** 模拟 ExtensionContext：branch 为会话里"已持久化"的消息数组（可变）。 */
export function mkCtx({ sid = 'sess-1', cwd = '/work/my-proj', branch = [], header = { type: 'session' } } = {}) {
  return {
    cwd,
    branch,
    sessionManager: {
      getSessionId: () => sid,
      getBranch: () => branch.map((message, i) => ({ type: 'message', id: String(i), message })),
      getHeader: () => header,
    },
  }
}

export const long = (tag, n = 120) => `${tag}：` + '这是一段足够长的有效对话内容，用于越过去噪后的最小长度。'.repeat(Math.ceil(n / 25))

/** 模拟 pi：pi.on 收集 handler。 */
export function mkPi() {
  const handlers = {}
  return { handlers, on: (ev, h) => { (handlers[ev] ||= []).push(h); return () => {} } }
}
