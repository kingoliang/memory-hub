// memory-hub · 会话文本摄入（POST {base}/api/ingest 的业务层）。
//
// 客户端（DSH / pi-web / Claude Code 的插件或 hook）把已拼好的对话增量文本推过来，hub 剥噪声 → 闸门 → 复用
// capture-run.js 的蒸馏 / 去重 / 入待审队列流程提炼成卡。
//
// 无状态协议：客户端自己持有"已确认水位"。被闸门挡住（deferred）或无内容（skipped noise_only）时服务端
// **不记账、不消耗冷却/配额**，客户端保持水位，下一轮把累积文本一并重发；只有真正处理过的请求
// （captured / not_durable / duplicate_pending / rejected）才写 ingest_log，用于冷却、配额与幂等重放。

import crypto from 'node:crypto'
import { getDb } from './db.js'
import { writeLog } from './writelog.js'
import { stripRuntimeNoise } from './capture.js'
import { detectSecrets } from './tidy.js'
import { runStandaloneCapture } from './capture-run.js'

export const MAX_TEXT_CHARS = 64 * 1024
/** 剥噪声后不足这个字数视为无内容（与 capture.hasUsableContent 的 60 字一致）。 */
export const MIN_CLEAN_CHARS = 60
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 3600e3
const QUOTA_WINDOW_MS = 24 * 3600e3
const IN_PROGRESS_RETRY_S = 5

const ROLE_ONLY_LINE = /^\s*(?:用户|助手|user|assistant|human|ai)\s*[:：]\s*$/i

/**
 * 摄入专用的噪声剥离：在 capture.stripRuntimeNoise（system-reminder / team / teammate 等成对标签与注入行）之上，
 * 补两类客户端拼文本时常带进来的内容——定时提醒批次块、`[Tool use: …]` 工具调用行（含嵌套方括号）。
 */
export function stripIngestNoise(text) {
  let t = String(text || '')
  // 定时提醒：标题行 + 紧随其后的列表项 / 缩进行
  t = t.replace(/^[^\n]*\[(?:SCHEDULE REMINDER|定时提醒)[^\]]*\][^\n]*(?:\n[ \t]*(?:[-*•]|\d)[^\n]*)*/gim, '')
  // 工具调用：从 [Tool use: 到行尾（行前的真实文字保留）
  t = t.replace(/\[Tool use:[^\n]*/gi, '')
  t = stripRuntimeNoise(t)
  return t.split('\n').filter((l) => !ROLE_ONLY_LINE.test(l)).join('\n').trim()
}

const isStr = (v) => typeof v === 'string'
const isSeq = (v) => Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER

/**
 * 校验请求体。返回 {ok:true, value} 或 {ok:false, reason}（reason 只描述字段，不回显内容）。
 */
export function validateIngestBody(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, reason: 'body 必须是 JSON 对象' }
  const bad = (m) => ({ ok: false, reason: m })
  if (!isStr(b.source) || !b.source.trim() || b.source.length > 64) return bad('source 必须是 1~64 字符的字符串')
  if (!isStr(b.session_id) || !b.session_id.trim() || b.session_id.length > 200) return bad('session_id 必须是 1~200 字符的字符串')
  if (!isStr(b.text)) return bad('text 必须是字符串')
  if (b.text.length > MAX_TEXT_CHARS) return bad(`text 超过 ${MAX_TEXT_CHARS} 字符，请分段发送`)
  if (b.project !== undefined && (!isStr(b.project) || b.project.length > 200)) return bad('project 必须是不超过 200 字符的字符串')
  if (b.cwd !== undefined && (!isStr(b.cwd) || b.cwd.length > 1024)) return bad('cwd 必须是不超过 1024 字符的字符串')
  for (const k of ['from_seq', 'to_seq']) if (b[k] !== undefined && !isSeq(b[k])) return bad(`${k} 必须是非负整数`)
  if (b.from_seq !== undefined && b.to_seq !== undefined && b.from_seq > b.to_seq) return bad('from_seq 不能大于 to_seq')
  return { ok: true, value: { source: b.source.trim(), sessionId: b.session_id, project: b.project, cwd: b.cwd, text: b.text, fromSeq: b.from_seq, toSeq: b.to_seq } }
}

// ingest_log：冷却 / 配额 / 幂等的唯一状态。惰性建表（不动 user_version，旧版本代码打开该库不受影响）。
const ready = new WeakSet()
function logDb(root) {
  const db = getDb(root)
  if (!ready.has(db)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingest_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        token_id TEXT NOT NULL,
        token_name TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        status TEXT NOT NULL,
        response TEXT NOT NULL,
        counted INTEGER NOT NULL DEFAULT 0,
        UNIQUE (token_id, session_id, idem_key)
      );
      CREATE INDEX IF NOT EXISTS idx_ingest_log_token_ts ON ingest_log(token_id, ts);
    `)
    ready.add(db)
  }
  return db
}

const inFlight = new Set()

function cardInfo(root, p, action) {
  const db = getDb(root)
  const main = db.prepare('SELECT id FROM cards WHERE path = ?').get(p)
  if (main) return { id: main.id, action, pending: false }
  const q = db.prepare('SELECT id, status FROM quarantine WHERE path = ?').get(p)
  return { id: q?.id ?? null, action, pending: q ? q.status === 'pending' : false }
}

/**
 * 处理一次摄入。调用方（server.js）已完成鉴权、scope 检查、body 读取与字段校验。
 * @param {{config: object, identity: {tokenId:string, name:string, ip?:string}, llm: object|null, log: object, input: ReturnType<typeof validateIngestBody>['value']}} p
 * @returns {Promise<{http:number, body:object}>}
 */
export async function runIngest({ config, identity, llm, log, input }) {
  const root = config.dbRoot
  const cfg = config.ingest
  const db = logDb(root)
  const { sessionId } = input
  const textHash = crypto.createHash('sha256').update(input.text).digest('hex').slice(0, 32)
  const idemKey = input.toSeq !== undefined ? `seq:${input.toSeq}` : `h:${textHash}`
  const now = Date.now()

  const audit = (action, outcome, cardPath = '') => {
    try {
      writeLog(root, {
        actorType: 'agent', actorId: identity.tokenId, actorName: identity.name, tool: 'ingest', action, cardPath, outcome, ip: identity.ip,
        args: { source: input.source, session_id: sessionId, from_seq: input.fromSeq, to_seq: input.toSeq, text_len: input.text.length, text_hash: textHash },
      })
    } catch (e) { log.error('write_log 写入失败', { tool: 'ingest', error: String(e?.message || e).slice(0, 200) }) }
  }
  const finish = (body, httpStatus, action, outcome, cardPath) => {
    audit(action, outcome, cardPath)
    return { http: httpStatus, body }
  }
  const deferred = (reason, retry) => {
    log.debug('ingest 延后', { actor: identity.name, session: sessionId, reason, retry_after_s: retry })
    return finish({ status: 'deferred', reason, ...(retry ? { retry_after_s: retry } : {}) }, 200, 'defer', 'ok')
  }

  // 1. 幂等重放：同 (令牌, session, to_seq 或文本哈希) 已处理过 → 原样返回，不重复建卡 / 调 LLM
  const prev = db.prepare('SELECT response FROM ingest_log WHERE token_id = ? AND session_id = ? AND idem_key = ?').get(identity.tokenId, sessionId, idemKey)
  if (prev) {
    log.info('ingest 幂等重放', { actor: identity.name, session: sessionId, key: idemKey })
    return finish({ ...JSON.parse(prev.response), idempotent_replay: true }, 200, 'replay', 'dup')
  }

  // 2. 噪声剥离
  const clean = stripIngestNoise(input.text)
  if (clean.length < MIN_CLEAN_CHARS) {
    // 有内容被剥掉 → 纯噪声，客户端可推进水位；本来就短 → 让客户端继续累积
    if (clean.length < input.text.trim().length) {
      log.debug('ingest 跳过：仅噪声', { actor: identity.name, session: sessionId, raw: input.text.length, clean: clean.length })
      return finish({ status: 'skipped', reason: 'noise_only' }, 200, 'skip', 'ok')
    }
    return deferred('too_short')
  }

  // 3. 长度闸
  if (clean.length < cfg.minChars) return deferred('too_short')

  // 4. 疑似明文密钥：拒绝（只报类型，不回显、不记录值；不消耗冷却/配额，但记账以便幂等）
  const secretTypes = detectSecrets(clean)
  if (secretTypes.length) {
    log.warn('ingest 拒绝：疑似明文密钥', { actor: identity.name, session: sessionId, secretTypes })
    const body = { status: 'rejected', reason: `疑似明文密钥（类型：${secretTypes.join(', ')}），已拒绝。请在客户端剔除后重发，或只记录密钥的存放位置而不是值。` }
    record(db, identity, sessionId, idemKey, 'rejected', body, now, false)
    return finish(body, 200, 'skip', 'denied')
  }

  // 5. 冷却 / 配额（只统计真正走过蒸馏的请求）
  if (inFlight.has(`${root}|${identity.tokenId}|${sessionId}`)) return deferred('in_progress', IN_PROGRESS_RETRY_S)
  if (cfg.cooldownS > 0) {
    const last = db.prepare('SELECT MAX(ts) t FROM ingest_log WHERE token_id = ? AND session_id = ? AND counted = 1').get(identity.tokenId, sessionId)?.t
    if (last && now - last < cfg.cooldownS * 1000) return deferred('cooldown', Math.ceil((cfg.cooldownS * 1000 - (now - last)) / 1000))
  }
  const used = db.prepare('SELECT COUNT(*) n, MIN(ts) oldest FROM ingest_log WHERE token_id = ? AND counted = 1 AND ts > ?').get(identity.tokenId, now - QUOTA_WINDOW_MS)
  if (used.n >= cfg.dailyQuota) return deferred('daily_quota', Math.max(1, Math.ceil((used.oldest + QUOTA_WINDOW_MS - now) / 1000)))

  // 6. 蒸馏 / 去重 / 入队（复用 runStandaloneCapture）。同步加锁：上面的检查与加锁之间没有 await。
  const lockKey = `${root}|${identity.tokenId}|${sessionId}`
  inFlight.add(lockKey)
  let out
  try {
    out = await runStandaloneCapture(root, clean, { source: `ingest:${input.source}`, submittedBy: identity.name, llm, minChars: MIN_CLEAN_CHARS, log })
  } catch (e) {
    log.error('ingest 处理异常', { actor: identity.name, session: sessionId, error: String(e?.message || e).slice(0, 200) })
    return finish({ status: 'error', reason: 'internal_error' }, 502, 'ingest', 'error')
  } finally { inFlight.delete(lockKey) }

  if (out.action === 'created' || out.action === 'appended') {
    const card = cardInfo(root, out.path, out.action)
    const body = { status: 'captured', cards: [card], ...(out.degraded ? { degraded: true } : {}) }
    record(db, identity, sessionId, idemKey, 'captured', body, now, true)
    log.info('ingest 沉淀完成', { actor: identity.name, source: input.source, session: sessionId, project: input.project, action: out.action, card: card.id, pending: card.pending, degraded: !!out.degraded })
    return finish(body, 200, out.action === 'created' ? 'create' : (out.merged ? 'merge' : 'append'), out.action === 'created' ? 'ok' : 'dup', out.path)
  }
  if (out.action === 'failed') {
    log.error('ingest 写入失败', { actor: identity.name, session: sessionId, reason: String(out.reason).slice(0, 200) })
    return finish({ status: 'error', reason: 'write_failed' }, 502, 'ingest', 'error')
  }
  // skipped
  let reason
  let counted = false
  if (out.reason === 'model judged not durable') { reason = 'not_durable'; counted = true }
  else if (String(out.reason).startsWith('待审队列已有近似卡')) { reason = 'duplicate_pending'; counted = true }
  else if (out.reason === 'text is runtime noise') reason = 'noise_only'
  else reason = 'unusable'
  const body = { status: 'skipped', reason, ...(out.path ? { path: out.path } : {}) }
  if (counted) record(db, identity, sessionId, idemKey, 'skipped', body, now, true)
  log.info('ingest 跳过', { actor: identity.name, session: sessionId, reason })
  return finish(body, 200, 'skip', reason === 'duplicate_pending' ? 'dup' : 'ok', out.path)
}

function record(db, identity, sessionId, idemKey, status, body, now, counted) {
  try {
    db.prepare('DELETE FROM ingest_log WHERE ts < ?').run(now - IDEMPOTENCY_RETENTION_MS)
    db.prepare('INSERT OR IGNORE INTO ingest_log (ts, token_id, token_name, session_id, idem_key, status, response, counted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now, identity.tokenId, identity.name, sessionId, idemKey, status, JSON.stringify(body), counted ? 1 : 0)
  } catch (e) { /* 记账失败不应让已完成的沉淀变成错误；最坏情况是一次重复处理 */ }
}
