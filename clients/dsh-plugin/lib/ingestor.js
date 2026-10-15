// 核心：按 session 维护水位、后台串行队列、把 hub 的响应翻译成"推进 / 不推进 / 延后 / 停用"。
//
// 设计要点
//  - onTurnStopping 是同步的，只做：读事件快照（内存、同步）→ 入队 → 调度。绝不 await、绝不抛。
//  - 水位 ack = 已被 hub 确认处理（captured/skipped/rejected）的最后一个 seq；只存内存。
//    重启后第一次见到某会话，基线取"当前轮 turn/start 之前"，故不重灌历史；代价：重启瞬间
//    尚未送达的旧增量会丢（只丢一次，且 hub 本身也不保证持久化客户端水位）。
//  - 队列里每个 session 至多一个条目（合并：同一会话后到的快照覆盖先到的，水位语义保证内容不丢）；
//    队列满则丢最旧的条目——水位没动，下一轮自然补发。
import { baselineSeq, extractIncrement, isSubagentSession, readEvents } from './events.js'
import { postIngest } from './client.js'

export const DEFAULTS = Object.freeze({
  source: 'dsh',
  timeoutMs: 5000,
  minChars: 60,         // 与 hub MIN_CLEAN_CHARS 对齐的客户端预检
  maxChars: 20000,      // 只留尾部；hub 上限 64K
  maxQueue: 50,
  concurrency: 2,
  userSourceKinds: ['user'],
  maxSessions: 500,
})

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }
const TAG = '[dsh-memory-hub-ingest]'

export function createIngestor(options = {}) {
  const o = { ...DEFAULTS, ...options }
  const log = options.log ?? noopLog
  const now = options.now ?? Date.now
  const L = (level, msg) => { try { log[level](`${TAG} ${msg}`) } catch { /* 日志失败不影响主流程 */ } }

  const sessions = new Map() // sid -> state
  const queue = []           // sid[]，FIFO
  let active = 0
  let stopped = false
  let disabledReason = ''
  let scheduled = false
  const idleWaiters = []
  const abort = new AbortController()

  if (!o.token) {
    disabledReason = '缺少令牌'
    L('warn', '已禁用：未设置环境变量 MEMORY_HUB_DSH_TOKEN，不会向 hub 推送任何内容')
  }

  const state = {
    get enabled() { return !stopped && !disabledReason },
  }

  function stateOf(sid, events, turn) {
    let st = sessions.get(sid)
    if (!st) {
      if (sessions.size >= o.maxSessions) evictIdle()
      st = { ack: baselineSeq(events, turn), retryUntil: 0, running: false, queued: false, pending: null, touched: now() }
      sessions.set(sid, st)
      L('info', `接入会话 ${sid}，水位基线 seq=${st.ack}（重启/续会话不重灌历史）`)
    }
    st.touched = now()
    return st
  }

  function evictIdle() {
    const idle = [...sessions].filter(([, s]) => !s.running && !s.queued).sort((a, b) => a[1].touched - b[1].touched)
    for (const [sid] of idle.slice(0, Math.max(1, Math.floor(o.maxSessions / 4)))) sessions.delete(sid)
  }

  function onTurnStopping(payload) {
    try {
      if (!state.enabled) return
      const agent = payload?.agent
      const session = agent?.session
      if (!session) return
      if (isSubagentSession(session)) return // 子 agent 的 turn 不推（它的对话已经体现在主 agent 的转述里）
      const sid = String(session.id ?? agent.id ?? '')
      if (!sid) return
      const events = readEvents(session)
      if (!events.length) return
      const st = stateOf(sid, events, payload?.turn)
      st.pending = { events, cwd: typeof session.header?.cwd === 'string' ? session.header.cwd : undefined }
      enqueue(sid, st)
    } catch (e) {
      L('warn', `监听器内部异常（已吞掉，不影响 DSH）：${String(e?.message || e).slice(0, 160)}`)
    }
  }

  function enqueue(sid, st) {
    if (st.queued || st.running) return // 已在队列：pending 已更新；运行中：结束时会重新入队
    while (queue.length >= o.maxQueue) {
      const dropped = queue.shift()
      const ds = sessions.get(dropped)
      if (ds) { ds.queued = false; ds.pending = null }
      L('warn', `队列已满（上限 ${o.maxQueue}），丢弃最旧的待发会话 ${dropped}；其水位未动，下一轮会补发`)
    }
    st.queued = true
    queue.push(sid)
    L('debug', `入队 ${sid}（队列 ${queue.length}）`)
    schedule()
  }

  function schedule() {
    if (scheduled || stopped) return
    scheduled = true
    setImmediate(() => { scheduled = false; pump() })
  }

  function pump() {
    while (!stopped && active < o.concurrency && queue.length) {
      const sid = queue.shift()
      const st = sessions.get(sid)
      if (!st || !st.pending) { if (st) st.queued = false; continue }
      active++
      st.queued = false
      st.running = true
      runJob(sid, st).catch((e) => L('warn', `发送任务异常（已吞掉）：${String(e?.message || e).slice(0, 160)}`))
        .finally(() => {
          active--
          st.running = false
          if (st.pending && !stopped) enqueue(sid, st)
          pump()
          checkIdle()
        })
    }
    checkIdle()
  }

  function checkIdle() {
    if (active === 0 && queue.length === 0 && !scheduled) while (idleWaiters.length) idleWaiters.shift()()
  }

  async function runJob(sid, st) {
    const job = st.pending
    st.pending = null
    if (!state.enabled) return
    const t = now()
    if (t < st.retryUntil) {
      L('debug', `会话 ${sid} 仍在延后窗口内（剩 ${Math.ceil((st.retryUntil - t) / 1000)}s），本轮不发送，内容留待累积`)
      return
    }
    const inc = extractIncrement(job.events, st.ack, { userSourceKinds: o.userSourceKinds, maxChars: o.maxChars })
    if (!inc) return
    if (inc.text.length === 0) {
      // 有新事件但没有可用对话文本（纯工具/纯噪声）：安全推进，不占请求
      st.ack = Math.max(st.ack, inc.toSeq)
      L('debug', `会话 ${sid} 本批无可用对话文本，水位推进到 ${st.ack}`)
      return
    }
    if (inc.text.length < o.minChars) {
      L('debug', `会话 ${sid} 去噪后仅 ${inc.text.length} 字（<${o.minChars}），不发送，继续累积`)
      return
    }
    const payload = {
      source: o.source,
      session_id: sid,
      text: inc.text,
      from_seq: inc.fromSeq,
      to_seq: inc.toSeq,
      ...(job.cwd ? { cwd: job.cwd.slice(0, 1024), project: basename(job.cwd).slice(0, 200) } : {}),
    }
    const r = await postIngest({ url: o.url, token: o.token, payload, timeoutMs: o.timeoutMs, signal: abort.signal, fetchImpl: o.fetchImpl })
    if (stopped) return
    handleResult(sid, st, inc, r)
  }

  function advance(st, toSeq) { st.ack = Math.max(st.ack, toSeq) }

  function handleResult(sid, st, inc, r) {
    const range = `seq ${inc.fromSeq}-${inc.toSeq}，${inc.text.length} 字`
    if (r.kind === 'net') { L('warn', `会话 ${sid} 发送失败（${r.reason}），不推进水位，下一轮重发（${range}）`); return }
    if (r.kind === 'http') {
      const c = r.code
      if (c === 401 || c === 403) {
        disabledReason = `HTTP ${c}`
        L('warn', `hub 返回 ${c}（令牌无效或无 write 权限），插件停用直到重启；请检查 MEMORY_HUB_DSH_TOKEN`)
      } else if (c === 400 || c === 413) {
        advance(st, inc.toSeq)
        L('error', `hub 拒绝请求 HTTP ${c}（${String(r.body?.reason ?? '').slice(0, 120)}），该批丢弃并推进水位，避免卡死（${range}）`)
      } else if (c === 429) {
        st.retryUntil = now() + (r.retryAfterS ?? 60) * 1000
        L('warn', `hub 限流 429，${r.retryAfterS ?? 60}s 内不再发送；水位不动`)
      } else {
        L('warn', `会话 ${sid} hub 返回 HTTP ${c}，不推进水位，下一轮重发（${range}）`)
      }
      return
    }
    const b = r.body
    switch (b.status) {
      case 'captured':
        advance(st, inc.toSeq)
        L('info', `会话 ${sid} captured${b.degraded ? '（degraded 原文卡）' : ''}，卡 ${Array.isArray(b.cards) ? b.cards.map((c) => `${c.id}:${c.action}`).join(',') : '-'}，水位推进到 ${st.ack}（${range}）`)
        return
      case 'skipped':
        advance(st, inc.toSeq)
        L('info', `会话 ${sid} skipped(${String(b.reason).slice(0, 40)})，水位推进到 ${st.ack}`)
        return
      case 'rejected':
        advance(st, inc.toSeq)
        L('warn', `会话 ${sid} 被 hub 拒绝（${String(b.reason).slice(0, 80)}），该批已丢弃并推进水位`)
        return
      case 'deferred': {
        const ra = Number(b.retry_after_s)
        if (Number.isFinite(ra) && ra > 0) st.retryUntil = now() + ra * 1000
        L('info', `会话 ${sid} deferred(${String(b.reason).slice(0, 40)})${ra > 0 ? `，${ra}s 后再试` : ''}，水位不动，内容累积`)
        return
      }
      default:
        L('warn', `会话 ${sid} 收到未知状态 ${JSON.stringify(String(b.status)).slice(0, 40)}，不推进水位`)
    }
  }

  function dispose() {
    stopped = true
    queue.length = 0
    abort.abort()
    sessions.clear()
    checkIdleForce()
  }
  function checkIdleForce() { while (idleWaiters.length) idleWaiters.shift()() }

  return {
    get enabled() { return state.enabled },
    onTurnStopping,
    /** 测试/诊断用：等队列与在途请求排空。 */
    idle() { return new Promise((res) => { if (active === 0 && queue.length === 0 && !scheduled) res(); else idleWaiters.push(res) }) },
    dispose,
  }
}

function basename(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || ''
}
