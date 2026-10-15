// memory-hub · 结构化日志：stderr 单行 JSON，分级 ERROR/WARN/INFO/DEBUG，敏感字段自动脱敏。
// stdout 是 stdio MCP 的协议通道，日志永远不写 stdout。

const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 }
const SENSITIVE_KEY = /token|secret|password|passwd|authorization|api[_-]?key|^key$|credential|cookie|bearer/i
const MAX_DEPTH = 4

function redact(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[深层省略]'
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: value.message }
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[已脱敏]' : redact(v, depth + 1)
    return out
  }
  if (typeof value === 'string' && value.length > 500) return value.slice(0, 500) + '…'
  return value
}

/**
 * @param {{level?: 'error'|'warn'|'info'|'debug', stream?: {write: Function}}} [opts]
 */
export function createLogger({ level = 'info', stream = process.stderr } = {}) {
  const threshold = LEVELS[String(level).toUpperCase()] ?? LEVELS.INFO
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] > threshold) return
    const rec = { ts: new Date().toISOString(), level: lvl, msg: String(msg), ...(fields ? redact(fields) : {}) }
    try { stream.write(JSON.stringify(rec) + '\n') } catch { /* 日志不能影响业务 */ }
  }
  return {
    error: (m, f) => emit('ERROR', m, f),
    warn: (m, f) => emit('WARN', m, f),
    info: (m, f) => emit('INFO', m, f),
    debug: (m, f) => emit('DEBUG', m, f),
  }
}

/** 进程级默认 logger（core 模块没有显式传入 logger 时使用）。 */
let defaultLogger = null
export function getLogger() {
  if (!defaultLogger) defaultLogger = createLogger({ level: process.env.MEMORY_HUB_LOG_LEVEL || 'info' })
  return defaultLogger
}
export function setDefaultLogger(l) { defaultLogger = l }
