// memory-hub · write_log 审计：谁（actor）、通过哪个工具、做了什么动作、结果如何。
// 不存正文与令牌，只存参数摘要（args_digest）。

import crypto from 'node:crypto'
import { getDb } from './db.js'

export const ACTOR_TYPES = ['agent', 'admin', 'cli', 'system']
export const OUTCOMES = ['ok', 'dup', 'denied', 'error']

/** 参数摘要：对规范化 JSON 取 sha256 前 32 位十六进制。不可逆，不含明文。 */
function stable(v) {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
  return v
}
export function argsDigest(args) {
  let json
  try { json = JSON.stringify(stable(args ?? {})) } catch { json = String(args) }
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 32)
}

/**
 * @param {string} root
 * @param {{actorType:string, actorId?:string, actorName?:string, tool?:string, action?:string, cardPath?:string, outcome:string, ip?:string, args?:unknown}} e
 */
export function writeLog(root, e) {
  if (!ACTOR_TYPES.includes(e.actorType)) throw new Error(`write_log: 非法 actor_type ${e.actorType}`)
  if (!OUTCOMES.includes(e.outcome)) throw new Error(`write_log: 非法 outcome ${e.outcome}`)
  getDb(root).prepare(`
    INSERT INTO write_log (ts, actor_type, actor_id, actor_name, tool, action, card_path, outcome, ip, args_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), e.actorType, e.actorId || '', e.actorName || '', e.tool || '', e.action || '', e.cardPath || '', e.outcome, e.ip || '', argsDigest(e.args))
}

export function listWriteLog(root, { limit = 100 } = {}) {
  return getDb(root).prepare('SELECT * FROM write_log ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 100, 1), 1000))
}
