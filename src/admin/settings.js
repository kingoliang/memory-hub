// memory-hub · 管理界面「设置」：
//   - 运行时可改（存 DB config 表，enforceAudit 每次写卡时现读，无需重启）：auditMode / auditExemptAgents / auditExemptKinds
//   - 其余配置项只读展示“有效值”（脱敏）：来自环境变量 / 配置文件 / 源码常量，改动需改配置并重启。
// 绝不返回：密钥 / 令牌 / 服务器绝对路径（home、dbRoot、configFile）。

import { getDb, setAuditConfig } from '../core/db.js'
import { writeLog } from '../core/writelog.js'
import { CAPTURE_KINDS, RECYCLE_RETENTION_DAYS } from '../core/vault.js'
import { resolveDedupConfig } from '../core/dedup-config.js'
import { HttpError } from './errors.js'
import { backupInfo } from './queries.js'

const EDITABLE_KEYS = ['auditMode', 'auditExemptAgents', 'auditExemptKinds']
export const AUDIT_MODES = ['all', 'none']
export const MAX_EXEMPT_AGENTS = 50
const AGENT_RE = /^(?:__all__|[A-Za-z0-9._:@-]{1,64})$/

const bad = (msg) => new HttpError(400, 'bad_request', msg)

function readList(db, key) {
  const raw = db.prepare('SELECT value FROM config WHERE key = ?').get(key)?.value
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : [] } catch { return String(raw).split(',').map((s) => s.trim()).filter(Boolean) }
}

function currentAudit(root) {
  const db = getDb(root)
  const row = db.prepare('SELECT value, updated_at FROM config WHERE key = ?').get('auditMode')
  const mode = row?.value && AUDIT_MODES.includes(row.value) ? row.value : null
  return { mode, exemptAgents: readList(db, 'auditExemptAgents'), exemptKinds: readList(db, 'auditExemptKinds'), updatedAt: row?.updated_at || null }
}

const hostOf = (u) => { try { return new URL(u).host } catch { return '' } }

export function getSettings(root, { config }) {
  const db = getDb(root)
  const agents = db.prepare('SELECT DISTINCT name FROM agent_tokens WHERE revoked_at IS NULL ORDER BY name').all().map((r) => r.name)
  const dd = resolveDedupConfig(process.env)
  const b = backupInfo(root)
  return {
    audit: currentAudit(root),
    options: { auditModes: AUDIT_MODES, kinds: CAPTURE_KINDS, agents },
    limits: { maxExemptAgents: MAX_EXEMPT_AGENTS },
    readonly: {
      dedup: { threshold: dd.threshold, titleAware: dd.titleAware, titleSim: dd.titleSim, titleBodyMin: dd.titleBodyMin, merge: dd.merge, pendingGuard: dd.pendingGuard },
      recycle: { retentionDays: RECYCLE_RETENTION_DAYS },
      backup: { count: b.count, last: b.last },
      admin: { maxBatch: config.adminMaxBatch, readOnly: !!config.adminReadOnly },
      ingest: { ...config.ingest },
      llm: config.llm
        ? { configured: true, model: config.llm.model, baseHost: hostOf(config.llm.baseUrl), keySet: !!config.llm.apiKey, reasoningEffort: config.llmRequest.reasoningEffort || '', timeoutMs: config.llmRequest.timeoutMs }
        : { configured: false, model: '', baseHost: '', keySet: false, reasoningEffort: '', timeoutMs: config.llmRequest.timeoutMs },
      mcp: { exposeTidyApply: !!config.exposeTidyApply },
      network: { host: config.host, port: config.port, basePath: config.basePath, allowRemote: !!config.allowRemote, trustProxy: !!config.trustProxy },
      logLevel: config.logLevel,
    },
  }
}

/** 校验并规范化请求体；只接受白名单字段。 */
export function parseSettingsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('请求体必须是 JSON 对象')
  const unknown = Object.keys(input).filter((k) => !EDITABLE_KEYS.includes(k))
  if (unknown.length) throw bad(`不支持修改的字段：${unknown.join('、')}（仅可改 ${EDITABLE_KEYS.join(' / ')}）`)
  const out = {}
  if (input.auditMode !== undefined) {
    if (!AUDIT_MODES.includes(input.auditMode)) throw bad(`auditMode 只能是：${AUDIT_MODES.join(' / ')}`)
    out.auditMode = input.auditMode
  }
  if (input.auditExemptAgents !== undefined) {
    const a = input.auditExemptAgents
    if (!Array.isArray(a)) throw bad('auditExemptAgents 必须是数组')
    if (a.length > MAX_EXEMPT_AGENTS) throw bad(`免审署名最多 ${MAX_EXEMPT_AGENTS} 个`)
    for (const x of a) if (typeof x !== 'string' || !AGENT_RE.test(x)) throw bad('免审署名只能含字母数字与 . _ : @ -（最长 64），或 __all__')
    out.auditExemptAgents = [...new Set(a)]
  }
  if (input.auditExemptKinds !== undefined) {
    const k = input.auditExemptKinds
    if (!Array.isArray(k)) throw bad('auditExemptKinds 必须是数组')
    for (const x of k) if (typeof x !== 'string' || !(x === '__all__' || CAPTURE_KINDS.includes(x))) throw bad(`免审类型只能是：${CAPTURE_KINDS.join(' / ')} 或 __all__`)
    out.auditExemptKinds = [...new Set(k)]
  }
  if (!Object.keys(out).length) throw bad('没有要修改的字段')
  return out
}

export function updateSettings(root, actor, input, { log }) {
  const patch = parseSettingsInput(input)
  const before = currentAudit(root)
  const next = {
    auditMode: patch.auditMode ?? before.mode,
    auditExemptAgents: patch.auditExemptAgents ?? before.exemptAgents,
    auditExemptKinds: patch.auditExemptKinds ?? before.exemptKinds,
  }
  const changed = []
  if (patch.auditMode !== undefined && patch.auditMode !== before.mode) changed.push('auditMode')
  if (patch.auditExemptAgents && JSON.stringify(patch.auditExemptAgents) !== JSON.stringify(before.exemptAgents)) changed.push('auditExemptAgents')
  if (patch.auditExemptKinds && JSON.stringify(patch.auditExemptKinds) !== JSON.stringify(before.exemptKinds)) changed.push('auditExemptKinds')
  if (changed.length) {
    const db = getDb(root)
    db.exec('BEGIN IMMEDIATE')
    try { setAuditConfig(root, patch); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } throw e }
    try {
      writeLog(root, { actorType: 'admin', actorId: actor.id, actorName: 'admin', ip: actor.ip, outcome: 'ok', tool: 'PATCH /settings', action: 'settings_update', args: { changed, auditMode: next.auditMode, exemptAgents: next.auditExemptAgents.length, exemptKinds: next.auditExemptKinds } })
    } catch (e) { log.error('write_log 写入失败', { action: 'settings_update', error: String(e?.message || e).slice(0, 200) }) }
    log.info('管理员修改审核设置', { changed, auditMode: next.auditMode, exemptAgents: next.auditExemptAgents.length, exemptKinds: next.auditExemptKinds, actor: actor.id })
  }
  return { ok: true, changed, audit: currentAudit(root) }
}
