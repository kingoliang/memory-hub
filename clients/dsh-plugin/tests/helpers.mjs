// 测试公共工具：假 DSH 会话 / 事件构造器 / 可编排响应的假 hub / 假 cordis ctx
import http from 'node:http'

export function makeSession({ id = 'sess-1', cwd = '/work/proj-a', header = {} } = {}) {
  const events = []
  let seq = 0
  const s = {
    id,
    header: { id, cwd, ...header },
    events,
    ownEvents() { return events.slice() },
    snapshotEvents() { return events.slice() },
    add(type, data) { const e = { seq: seq++, type, data }; events.push(e); return e },
    turnStart(turn) { return s.add('turn/start', { turn }) },
    user(text, source = { kind: 'user' }) {
      return s.add('user/message', { id: 'm' + seq, role: 'user', content: [{ type: 'text', text }], source })
    },
    assistant(text, extraBlocks = []) {
      return s.add('assistant/message', {
        turn: 0, step: 0, stream: [],
        message: { id: 'a' + seq, role: 'assistant', source: { kind: 'model' }, content: [...extraBlocks, { type: 'text', text }] },
      })
    },
    tool(text = '工具输出：不应被采集') {
      return s.add('tool/result', { turn: 0, step: 0, message: { role: 'tool', content: [{ type: 'text', text }] } })
    },
  }
  return s
}

export const makeAgent = (session) => ({ id: session.id, session })

/** 足够长（> 60 字）的对话文本片段。 */
export const LONG = (tag) => `这是关于${tag}的一段足够长的讨论内容，包含了结论、原因和后续的操作步骤，用来保证去噪之后仍然超过客户端的最小长度闸门。`

/** 假 hub：按脚本依次返回；脚本耗尽后回退到 fallback。记录每次请求。 */
export async function startFakeHub({ script = [], fallback = { code: 200, body: { status: 'captured', cards: [] } }, delayMs = 0 } = {}) {
  const requests = []
  let inflight = 0
  let maxInflight = 0
  let hold = null // 设为 Promise 时，所有请求挂起直到其 resolve
  const srv = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let body = null
    try { body = JSON.parse(Buffer.concat(chunks).toString() || 'null') } catch { /* 非 JSON */ }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body })
    inflight++; maxInflight = Math.max(maxInflight, inflight)
    if (hold) await hold
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const r = script.length ? script.shift() : fallback
    inflight--
    if (r.destroy) { req.socket.destroy(); return }
    res.statusCode = r.code ?? 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(r.body ?? {}))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  return {
    url: `http://127.0.0.1:${port}/memory/api/ingest`,
    requests,
    script,
    maxInflight: () => maxInflight,
    holdAll() { let release; hold = new Promise((r) => { release = r }); return () => { hold = null; release() } },
    async close() { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)) },
  }
}

/** 假 cordis ctx：记录监听器与 effect，logger 记入数组。 */
export function makeCtx() {
  const handlers = new Map()
  const effects = []
  const logs = []
  const lg = (level) => (...a) => { logs.push({ level, msg: a.map(String).join(' ') }) }
  return {
    logs,
    handlers,
    effects,
    on(ev, fn) { handlers.set(ev, fn); return () => handlers.delete(ev) },
    effect(fn, label) { effects.push({ fn, label }); },
    logger: { debug: lg('debug'), info: lg('info'), warn: lg('warn'), error: lg('error') },
    emitTurnStopping(agent, turn = 0) { return handlers.get('agent/turn-stopping')({ agent, turn, signal: new AbortController().signal }) },
    dispose() { for (const e of effects) { const d = e.fn(); if (typeof d === 'function') d() } },
  }
}

export const silentLog = () => { const logs = []; const f = (level) => (...a) => logs.push({ level, msg: a.join(' ') }); return { logs, debug: f('debug'), info: f('info'), warn: f('warn'), error: f('error') } }
