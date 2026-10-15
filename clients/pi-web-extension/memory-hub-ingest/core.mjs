// memory-hub-ingest 核心逻辑（纯 ESM，零依赖，不 import pi 包，便于单测）。
// 薄入口见 ./index.ts；协议见 docs/ingest-api.md、src/core/ingest.js。
//
// 设计要点：
//  - agent_end 处理函数同步只做"取文本 + 入队"，网络请求在后台串行执行，handler 立即返回；任何异常都被吞掉并记日志。
//  - 去重不依赖 agent_end.messages 的语义（整段历史 / 仅本次运行均可）：按消息键（role+timestamp+文本哈希）去重。
//  - 水位 = 内存里的"待确认片段"：captured / skipped / rejected 才清掉；deferred / 5xx / 网络错误保留并累积到下一轮。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TAG = '[memory-hub-ingest]'
export const DEFAULT_URL = 'http://127.0.0.1:7990/memory/api/ingest'
export const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.config', 'memory-hub', 'pi-web-token')
export const LIMITS = Object.freeze({
  timeoutMs: 5000, // 单次 fetch 超时
  maxChars: 20000, // 单次发送保留的尾部字符数
  minChars: 60, // 去噪后不足则不发（继续累积）
  queueMax: 20, // 每 session 后台队列最多排队的批次数，满则丢最旧
  maxPendingChars: 80000, // 待确认累积文本上限（超出丢最旧片段）
  seenMax: 5000, // 每 session 去重键上限
  retryCapS: 3600, // 遵守 retry_after_s 的上限
  timerRetries: 3, // 连续由定时器触发的"收尾重试"次数上限
  maxSessions: 200, // 同时跟踪的 session 状态上限
})

// ---------------------------------------------------------------- 文本处理

const NOISE_PAIRED = [
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<(team-[\w-]+|teammate[\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi,
]
const NOISE_UNCLOSED = /<system-reminder\b[^>]*>[\s\S]*$/i
const NOISE_LINES = [
  /^[^\n]*\[(?:SCHEDULE REMINDER|定时提醒)[^\]]*\][^\n]*(?:\n[ \t]*(?:[-*•]|\d)[^\n]*)*/gim,
  /\[Tool use:[^\n]*/gi,
]

/** 剥掉运行时注入块（与 hub 侧同类；hub 仍会再剥一次，这里是为了不把噪声算进长度/不外发）。 */
export function stripNoise(text) {
  let t = String(text ?? '')
  for (const re of NOISE_PAIRED) t = t.replace(re, '')
  t = t.replace(NOISE_UNCLOSED, '')
  for (const re of NOISE_LINES) t = t.replace(re, '')
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

/** 只取 text 块；content 可能是字符串或块数组。thinking / toolCall / image 等一律丢。 */
export function blocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)

/** 消息键：不依赖位置，用于两种 messages 语义下的去重。 */
export function messageKey(m) {
  const blocks = Array.isArray(m?.content) ? m.content.length : typeof m?.content
  return `${m?.role}|${m?.timestamp ?? ''}|${blocks}|${sha1(blocksText(m?.content))}`
}

const ROLE_PREFIX = { user: '用户：', assistant: '助手：' }

/** 返回一条消息的带角色前缀文本（已去噪）；非 user/assistant、出错/中止的 assistant、无文本 → ''。 */
export function messageLine(m) {
  const prefix = ROLE_PREFIX[m?.role]
  if (!prefix) return ''
  if (m.role === 'assistant' && (m.stopReason === 'aborted' || m.stopReason === 'error')) return ''
  const t = stripNoise(blocksText(m.content))
  return t ? prefix + t : ''
}

// ---------------------------------------------------------------- 配置 / 令牌

/**
 * 解析配置。令牌优先级：环境变量 MEMORY_HUB_PI_TOKEN → 令牌文件（MEMORY_HUB_PI_TOKEN_FILE，默认 ~/.config/memory-hub/pi-web-token）。
 * 绝不返回/打印令牌之外的任何位置；tokenSource 只是 'env' | 'file' | 'none'。
 */
export function resolveConfig(env = process.env, io = {}) {
  const readFile = io.readFile ?? ((p) => fs.readFileSync(p, 'utf8'))
  const statFile = io.stat ?? ((p) => fs.statSync(p))
  const warnings = []
  let token = (env.MEMORY_HUB_PI_TOKEN || '').trim()
  let tokenSource = token ? 'env' : 'none'
  if (!token) {
    const file = env.MEMORY_HUB_PI_TOKEN_FILE || DEFAULT_TOKEN_FILE
    try {
      token = String(readFile(file)).trim()
      if (token) {
        tokenSource = 'file'
        try {
          const mode = statFile(file).mode & 0o777
          if (mode & 0o077) warnings.push(`令牌文件权限过宽（${mode.toString(8)}），建议 chmod 600`)
        } catch { /* 取不到权限不影响使用 */ }
      }
    } catch { /* 文件不存在 = 没配置 */ }
  }
  return {
    url: (env.MEMORY_HUB_INGEST_URL || DEFAULT_URL).trim(),
    source: 'pi-web',
    token,
    tokenSource,
    enabled: !!token,
    warnings,
  }
}

// ---------------------------------------------------------------- 日志

/**
 * 默认日志：全部落 stderr 并带级别标记（warn 用 console.warn，其余用 console.error）。原因：pi 的 --mode json / rpc 以 stdout 作协议通道，
 * console.info/debug 会写进 stdout 污染 JSONL（58 上实测）；stderr 在 sessiond 下同样进 journal。
 * debug 默认关闭，MEMORY_HUB_PI_DEBUG=1 打开。
 */
export function makeStderrLog(env = process.env) {
  const out = (lvl, fn) => (msg, ...rest) => fn(String(msg).replace(TAG, `${TAG}[${lvl}]`), ...rest)
  // console.warn / console.error 本就写 stderr；info/debug 写 stdout，所以改走 console.error
  return { debug: env.MEMORY_HUB_PI_DEBUG === '1' ? out('DEBUG', console.error) : () => {}, info: out('INFO', console.error), warn: out('WARN', console.warn), error: out('ERROR', console.error) }
}

// ---------------------------------------------------------------- 主体

/**
 * @typedef {{seq:number, line:string}} Segment
 * @typedef {object} SessionState
 * @property {Set<string>} seen
 * @property {number} seq              下一条新消息的序号（= 会话内消息位置）
 * @property {Segment[]} pending       已取出但未被 hub 确认的片段
 * @property {Segment[][]} queue       等待后台处理的批次
 * @property {boolean} running
 * @property {number} nextAllowedAt    deferred 的 retry_after 截止（ms 时间戳）
 * @property {any} timer
 * @property {number} timerRetries
 * @property {boolean} skip            子会话等：不摄入
 * @property {string} project
 * @property {string} cwd
 */

/**
 * @param {{env?:object, io?:object, fetchImpl?:Function, log?:{debug:Function,info:Function,warn:Function,error:Function}, now?:()=>number, limits?:Partial<typeof LIMITS>}} [opts]
 * @returns {null | {onSessionStart:Function, onAgentEnd:Function, onSessionShutdown:Function, idle:()=>Promise<void>, cfg:object, _states:Map<string,SessionState>}}
 */
export function createMemoryHubIngest(opts = {}) {
  const env = opts.env ?? process.env
  const log = opts.log ?? makeStderrLog(env)
  const now = opts.now ?? Date.now
  const L = { ...LIMITS, ...(opts.limits || {}) }
  const cfg = resolveConfig(env, opts.io)

  if (env.PI_SUBAGENT_CHILD === '1') {
    // pi-subagents 的后台 runner 子进程（会加载 ambient 扩展）：子会话不单独摄入，避免重复。
    log.info(`${TAG} 检测到 PI_SUBAGENT_CHILD=1（子 agent 进程），不摄入`)
    return null
  }
  if (!cfg.enabled) {
    log.warn(`${TAG} 未配置令牌（环境变量 MEMORY_HUB_PI_TOKEN 或令牌文件），扩展已禁用`)
    return null
  }
  for (const w of cfg.warnings) log.warn(`${TAG} ${w}`)

  /** @type {Map<string, SessionState>} */
  const states = new Map()
  let disabled = false
  const inflightRuns = new Set()
  const fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a))

  const disable = (why) => {
    if (disabled) return
    disabled = true
    cfg.enabled = false
    for (const s of states.values()) { s.pending = []; s.queue = []; clearTimeout(s.timer) }
    log.warn(`${TAG} ${why}；扩展已禁用，修正令牌后在会话里 /reload 恢复`)
  }

  function branchMessageEntries(ctx) {
    try {
      return (ctx.sessionManager.getBranch() || []).filter((e) => e && e.type === 'message' && e.message).map((e) => e.message)
    } catch { return [] }
  }

  /** 首次见到某 session：把已有历史记为已读，水位从当前末尾起算（不重灌历史）。exclude 里的键不算历史（当前这一轮）。 */
  function ensureState(sid, ctx, exclude = new Set()) {
    let s = states.get(sid)
    if (s) return s
    if (states.size >= L.maxSessions) {
      const oldest = states.keys().next().value
      clearTimeout(states.get(oldest)?.timer)
      states.delete(oldest)
    }
    const hist = branchMessageEntries(ctx).filter((m) => !exclude.has(messageKey(m)))
    let header = null
    try { header = ctx.sessionManager.getHeader?.() } catch { /* ignore */ }
    const cwd = String(ctx.cwd || '')
    s = {
      seen: new Set(hist.map(messageKey)),
      seq: hist.length,
      pending: [], queue: [], running: false, nextAllowedAt: 0, timer: null, timerRetries: 0,
      skip: !!header?.parentSession, // pi-subagents 前台/后台子会话带 parentSession
      project: path.basename(cwd).slice(0, 200),
      cwd: cwd.slice(0, 1024),
    }
    states.set(sid, s)
    if (s.skip) log.info(`${TAG} 子会话（parentSession）不摄入`, { session: sid })
    else log.debug(`${TAG} 会话基线`, { session: sid, baseline_messages: hist.length })
    return s
  }

  const sessionId = (ctx) => { try { return String(ctx.sessionManager.getSessionId() || '').slice(0, 200) } catch { return '' } }

  function onSessionStart(_event, ctx) {
    try {
      if (disabled) return
      const sid = sessionId(ctx)
      if (sid) ensureState(sid, ctx)
    } catch (e) { log.error(`${TAG} session_start 处理异常`, String(e?.message || e)) }
  }

  function onSessionShutdown(_event, ctx) {
    try {
      const sid = sessionId(ctx)
      const s = states.get(sid)
      if (s) { clearTimeout(s.timer); s.timer = null }
    } catch { /* ignore */ }
  }

  function remember(s, key) {
    s.seen.add(key)
    if (s.seen.size > L.seenMax) s.seen.delete(s.seen.values().next().value)
  }

  /** agent_end：同步、廉价、不抛。返回 void（pi 会 await 返回值，所以绝不能返回 pending 的 Promise）。 */
  function onAgentEnd(event, ctx) {
    try {
      if (disabled) return
      const sid = sessionId(ctx)
      if (!sid) return
      const msgs = Array.isArray(event?.messages) ? event.messages.filter(Boolean) : []
      const s = ensureState(sid, ctx, new Set(msgs.map(messageKey)))
      if (s.skip) return
      // 中止的一轮：助手内容是半截话，且用户已表明不要这个结果 → 整轮不推送（标记已读，不再累积）。
      const aborted = msgs.some((m) => m.role === 'assistant' && m.stopReason === 'aborted')
      const segs = []
      let fresh = 0
      for (const m of msgs) {
        const key = messageKey(m)
        if (s.seen.has(key)) continue
        remember(s, key)
        const seq = s.seq++
        fresh++
        if (aborted) continue
        const line = messageLine(m)
        if (line) segs.push({ seq, line })
      }
      if (aborted) log.info(`${TAG} 本轮被中止，不推送`, { session: sid, messages: fresh })
      if (!segs.length) return
      s.timerRetries = 0
      s.queue.push(segs)
      while (s.queue.length > L.queueMax) {
        const dropped = s.queue.shift()
        log.warn(`${TAG} 队列已满，丢弃最旧批次`, { session: sid, dropped_messages: dropped.length })
      }
      schedule(sid, s)
    } catch (e) { log.error(`${TAG} agent_end 处理异常（已忽略）`, String(e?.message || e)) }
  }

  function schedule(sid, s) {
    if (s.running || disabled) return
    s.running = true
    const p = new Promise((resolve) => setImmediate(resolve)).then(() => drain(sid, s)).catch((e) => log.error(`${TAG} 后台处理异常`, String(e?.message || e)))
    inflightRuns.add(p)
    p.finally(() => inflightRuns.delete(p))
  }

  function buildBatch(pending) {
    // 从尾部往前取，保留不超过 maxChars 的字符；超长单片段切尾部。
    const SEP = '\n\n'
    const picked = []
    let total = 0
    for (let i = pending.length - 1; i >= 0; i--) {
      const room = L.maxChars - total - (picked.length ? SEP.length : 0)
      if (room <= 0) break
      const line = pending[i].line
      if (line.length > room) { picked.unshift({ seq: pending[i].seq, line: line.slice(-room) }); break }
      picked.unshift(pending[i])
      total += line.length + (picked.length > 1 ? SEP.length : 0)
    }
    return { text: picked.map((x) => x.line).join(SEP), from: picked[0].seq, to: picked[picked.length - 1].seq }
  }

  async function post(sid, s, batch) {
    const body = { source: cfg.source, session_id: sid, text: batch.text, from_seq: batch.from, to_seq: batch.to }
    if (s.project) body.project = s.project
    if (s.cwd) body.cwd = s.cwd
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(L.timeoutMs),
    })
    let json = null
    try { json = await res.json() } catch { /* 非 JSON */ }
    return { http: res.status, json }
  }

  function armTimer(sid, s, retryS) {
    clearTimeout(s.timer)
    s.timer = null
    if (!retryS || s.timerRetries >= L.timerRetries) return
    s.timerRetries++
    const ms = Math.min(retryS, L.retryCapS) * 1000 + 500
    s.timer = setTimeout(() => { s.timer = null; schedule(sid, s) }, ms)
    s.timer.unref?.()
  }

  async function drain(sid, s) {
    try {
      for (;;) {
        if (disabled) break
        while (s.queue.length) s.pending.push(...s.queue.shift())
        // 累积上限：丢最旧片段
        let chars = s.pending.reduce((n, x) => n + x.line.length, 0)
        while (chars > L.maxPendingChars && s.pending.length > 1) { chars -= s.pending.shift().line.length; log.warn(`${TAG} 累积文本超限，丢弃最旧片段`, { session: sid }) }
        if (!s.pending.length) break
        const wait = s.nextAllowedAt - now()
        if (wait > 0) { log.debug(`${TAG} 遵守 retry_after，暂不发送`, { session: sid, wait_ms: wait }); break }
        const batch = buildBatch(s.pending)
        if (batch.text.length < L.minChars) { log.debug(`${TAG} 去噪后不足 ${L.minChars} 字，继续累积`, { session: sid, chars: batch.text.length }); break }
        const sent = s.pending.length
        let r
        try {
          r = await post(sid, s, batch)
        } catch (e) {
          log.warn(`${TAG} 请求失败，水位不推进`, { session: sid, error: String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || e).slice(0, 200) })
          break
        }
        const st = r.json?.status
        if (r.http === 200 && (st === 'captured' || st === 'skipped' || st === 'rejected')) {
          s.pending.splice(0, sent)
          s.nextAllowedAt = 0
          s.timerRetries = 0
          const lvl = st === 'rejected' ? 'warn' : 'info'
          log[lvl](`${TAG} 已摄入`, { session: sid, status: st, reason: r.json.reason ? String(r.json.reason).slice(0, 40) : undefined, cards: r.json.cards?.length, from_seq: batch.from, to_seq: batch.to, chars: batch.text.length })
          continue
        }
        if (r.http === 200 && st === 'deferred') {
          const retryS = Number.isFinite(r.json.retry_after_s) ? Math.max(0, r.json.retry_after_s) : 0
          s.nextAllowedAt = retryS ? now() + Math.min(retryS, L.retryCapS) * 1000 : 0
          log.info(`${TAG} hub 延后，保留累积`, { session: sid, reason: r.json.reason, retry_after_s: retryS || undefined })
          armTimer(sid, s, retryS)
          break
        }
        if (r.http === 401 || r.http === 403) { disable(`令牌被拒绝（HTTP ${r.http}）`); break }
        if (r.http === 400 || r.http === 413) {
          // 重试同样的内容也不会成功：丢弃本批，避免毒丸永远卡住
          s.pending.splice(0, sent)
          log.error(`${TAG} hub 拒绝请求格式，丢弃本批`, { session: sid, http: r.http, reason: String(r.json?.reason ?? '').slice(0, 100) })
          continue
        }
        log.warn(`${TAG} hub 返回非预期结果，水位不推进`, { session: sid, http: r.http, status: st })
        break
      }
    } finally {
      s.running = false
      if (s.queue.length && !disabled) schedule(sid, s)
    }
  }

  return {
    cfg: { url: cfg.url, source: cfg.source, tokenSource: cfg.tokenSource },
    onSessionStart,
    onAgentEnd,
    onSessionShutdown,
    /** 测试用：等后台任务全部结束 */
    async idle() { while (inflightRuns.size) await Promise.allSettled([...inflightRuns]) },
    _states: states,
  }
}
