// DSH 会话事件读取与增量提取。形态依据（58 上 @deepseek-ai/dsh 0.2.0-rc.2 的类型声明）：
//   - session.ownEvents() / snapshotEvents() 返回 {seq, type, data}[]（dsh-session/lib/types/index.d.ts:193,200）
//   - 'user/message' 的 data 本身就是 UserMessage {role:'user', content:ContentBlock[], source:{kind}}
//   - 'assistant/message' 的 data 是 {turn, step, message: AssistantMessage, stream, ...}（dsh-session types.d.ts:330）
//   - 'turn/start' 的 data 是 {turn}（types.d.ts:262）
import { stripNoise } from './noise.js'

const ROLE_PREFIX = { user: '用户：', assistant: '助手：' }

/** 读事件快照：ownEvents（不含 fork 继承前缀）→ snapshotEvents → events 数组；全部失败返回空数组。 */
export function readEvents(session) {
  if (!session) return []
  for (const pick of ['ownEvents', 'snapshotEvents']) {
    if (typeof session[pick] === 'function') {
      try {
        const out = session[pick]()
        if (Array.isArray(out)) return out
      } catch { /* 换下一个取法 */ }
    }
  }
  return Array.isArray(session.events) ? session.events : []
}

/**
 * 是否子 agent 会话。依据 session.header（dsh-subagent/lib/index.js:476-479 创建子会话时写入
 * origin:'subagent' 与 delegationDepth）。用户手动 fork 只有 parentSession，不算子 agent。
 */
export function isSubagentSession(session) {
  const h = session?.header
  if (!h) return false
  return h.origin === 'subagent' || (Number(h.delegationDepth) || 0) > 0
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * 首次见到某会话时的水位基线：取"当前轮 turn/start 之前的最大 seq"，当前轮内容纳入、历史不重灌。
 * 找不到 turn/start 时退到"当前最大 seq"（宁可漏当前轮也不重灌历史）。
 */
export function baselineSeq(events, turn) {
  let startSeq
  let lastStart
  for (const e of events) {
    if (e?.type !== 'turn/start' || !isNum(e.seq)) continue
    lastStart = e.seq
    if (e.data?.turn === turn) startSeq = e.seq
  }
  const at = startSeq ?? lastStart
  if (isNum(at)) return at - 1
  let max = -1
  for (const e of events) if (isNum(e?.seq) && e.seq > max) max = e.seq
  return max
}

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text).map((b) => b.text).join('\n')
}

/**
 * 取 seq > ack 的增量。
 * @returns {null | {fromSeq:number, toSeq:number, text:string, hadMessages:boolean}}
 *   null = 没有任何新事件；text 为空串 = 有新事件但没有可用对话文本。
 */
export function extractIncrement(events, ack, { userSourceKinds = ['user'], maxChars = 20000 } = {}) {
  let fromSeq = Infinity
  let toSeq = -Infinity
  const lines = []
  let hadMessages = false
  for (const e of events) {
    if (!e || !isNum(e.seq) || e.seq <= ack) continue
    fromSeq = Math.min(fromSeq, e.seq)
    toSeq = Math.max(toSeq, e.seq)
    let role
    let content
    if (e.type === 'user/message') {
      const m = e.data?.message ?? e.data
      if (!m || m.role !== 'user') continue
      const kind = m.source?.kind
      if (kind !== undefined && !userSourceKinds.includes(kind)) continue // 注入的合成 user 消息
      role = 'user'; content = m.content
    } else if (e.type === 'assistant/message') {
      const m = e.data?.message
      if (!m || m.role !== 'assistant') continue
      role = 'assistant'; content = m.content
    } else continue
    hadMessages = true
    const text = stripNoise(blockText(content))
    if (text) lines.push(ROLE_PREFIX[role] + text)
  }
  if (toSeq === -Infinity) return null
  let text = lines.join('\n')
  if (text.length > maxChars) text = text.slice(-maxChars)
  return { fromSeq, toSeq, text, hadMessages }
}
