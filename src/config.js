// memory-hub · 配置：环境变量 > 配置文件（$MEMORY_HUB_HOME/memory-hub.json）> 默认值。
// 秘密（LLM key）只从环境变量或权限为 0600 的配置文件读取；绝不写入日志。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GATE_MODES } from './core/gate.js'

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError' }
}

export const DEFAULT_PORT = 7990
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']
const LOOPBACK_BIND = new Set(['127.0.0.1', '::1', 'localhost'])
const DB_BASENAME = 'memory-eternal.db'

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase())
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean)

function parsePort(v, from) {
  const s = String(v).trim()
  if (!/^\d+$/.test(s)) throw new ConfigError(`${from} 不是合法端口：${s}`)
  const n = Number(s)
  if (n < 0 || n > 65535) throw new ConfigError(`${from} 超出范围 0-65535：${s}`)
  return n
}

function parseBasePath(v) {
  const s = String(v ?? '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(s)) throw new ConfigError(`MEMORY_HUB_BASE_PATH 必须以 / 开头且只含 URL 安全字符：${s}`)
  return s
}

export const DEFAULT_LLM_TIMEOUT_MS = 90000
const LLM_EFFORTS = ['none', 'low', 'medium', 'high']
/** extra_body 不得覆盖的请求体字段：model/messages/stream 由代码控制；max_tokens 由重试阶梯控制。 */
const LLM_RESERVED_BODY_KEYS = ['model', 'messages', 'stream', 'max_tokens']

/**
 * 蒸馏请求的可选参数（环境变量优先于配置文件 llm.*）。全部可空：空 = 不传，不破坏不支持这些参数的网关。
 *   MEMORY_LLM_REASONING_EFFORT  none|low|medium|high，写入请求体 reasoning_effort
 *   MEMORY_LLM_EXTRA_BODY        JSON 对象字符串，合并进请求体（如 chat_template_kwargs）；不得含保留字段
 *   MEMORY_LLM_TIMEOUT_MS        单次调用超时，默认 90000
 * 非法值抛 ConfigError（启动即报错，绝不静默忽略）。
 */
export function parseLlmRequestOptions(env = {}, fileLlm = {}) {
  const effortRaw = String(env.MEMORY_LLM_REASONING_EFFORT ?? fileLlm?.reasoningEffort ?? '').trim().toLowerCase()
  if (effortRaw && !LLM_EFFORTS.includes(effortRaw)) throw new ConfigError(`MEMORY_LLM_REASONING_EFFORT 必须是 ${LLM_EFFORTS.join('/')} 之一或留空：${effortRaw}`)

  let extra = env.MEMORY_LLM_EXTRA_BODY ?? fileLlm?.extraBody ?? null
  if (typeof extra === 'string') {
    if (!extra.trim()) extra = null
    else {
      try { extra = JSON.parse(extra) } catch (e) { throw new ConfigError(`MEMORY_LLM_EXTRA_BODY 不是合法 JSON：${e.message}`) }
    }
  }
  if (extra !== null) {
    if (typeof extra !== 'object' || Array.isArray(extra)) throw new ConfigError('MEMORY_LLM_EXTRA_BODY 必须是 JSON 对象')
    const bad = LLM_RESERVED_BODY_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(extra, k))
    if (bad.length) throw new ConfigError(`MEMORY_LLM_EXTRA_BODY 不得覆盖保留字段：${bad.join(', ')}`)
    if (!Object.keys(extra).length) extra = null
  }

  const tRaw = String(env.MEMORY_LLM_TIMEOUT_MS ?? fileLlm?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS).trim()
  const timeoutMs = Number(tRaw)
  if (!/^\d+$/.test(tRaw) || timeoutMs < 1000 || timeoutMs > 600000) throw new ConfigError(`MEMORY_LLM_TIMEOUT_MS 必须是 1000~600000 的整数（毫秒）：${tRaw}`)

  return { reasoningEffort: effortRaw, extraBody: extra, timeoutMs }
}

/**
 * @param {NodeJS.ProcessEnv|object} env
 * @param {{warn?: (msg: string) => void}} [hooks]
 */
export function loadConfig(env = process.env, { warn = () => {} } = {}) {
  const home = path.resolve(env.MEMORY_HUB_HOME || path.join(os.homedir(), '.memory-hub'))

  // 数据库位置：默认在 home 下；MEMORY_HUB_DB 可直接指向既有的 memory-eternal.db（零迁移接管）
  let dbRoot = home
  if (env.MEMORY_HUB_DB) {
    const p = path.resolve(env.MEMORY_HUB_DB)
    if (path.basename(p) !== DB_BASENAME) throw new ConfigError(`MEMORY_HUB_DB 的文件名必须是 ${DB_BASENAME}（库文件名是 schema 约定）：${p}`)
    dbRoot = path.dirname(p)
  }

  // 配置文件
  const filePath = env.MEMORY_HUB_CONFIG ? path.resolve(env.MEMORY_HUB_CONFIG) : path.join(home, 'memory-hub.json')
  let file = {}
  let fileKeyAllowed = false
  if (fs.existsSync(filePath)) {
    try { file = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch (e) { throw new ConfigError(`配置文件不是合法 JSON：${filePath}（${e.message}）`) }
    if (file === null || typeof file !== 'object' || Array.isArray(file)) throw new ConfigError(`配置文件顶层必须是对象：${filePath}`)
    const mode = fs.statSync(filePath).mode & 0o777
    fileKeyAllowed = (mode & 0o077) === 0
    if (!fileKeyAllowed && file.llm?.key) warn(`配置文件 ${filePath} 权限为 ${mode.toString(8)}，应为 0600；已忽略其中的 llm.key（请 chmod 600）`)
  }

  const host = String(env.MEMORY_HUB_HOST ?? file.host ?? '127.0.0.1').trim()
  const port = env.MEMORY_HUB_PORT !== undefined ? parsePort(env.MEMORY_HUB_PORT, 'MEMORY_HUB_PORT') : file.port !== undefined ? parsePort(file.port, 'config.port') : DEFAULT_PORT
  const basePath = parseBasePath(env.MEMORY_HUB_BASE_PATH ?? file.basePath ?? '')
  const allowRemote = env.MEMORY_HUB_ALLOW_REMOTE !== undefined ? truthy(env.MEMORY_HUB_ALLOW_REMOTE) : truthy(file.allowRemote)
  const extraOrigins = list(env.MEMORY_HUB_ALLOWED_ORIGINS ?? file.allowedOrigins)
  const extraHosts = list(env.MEMORY_HUB_ALLOWED_HOSTS ?? file.allowedHosts)
  const trustProxy = env.MEMORY_HUB_TRUST_PROXY !== undefined ? truthy(env.MEMORY_HUB_TRUST_PROXY) : truthy(file.trustProxy)
  const exposeTidyApply = env.MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY !== undefined ? truthy(env.MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY) : truthy(file.exposeTidyApply ?? file.mcp?.exposeTidyApply)

  // 管理界面批量操作（批量软删/恢复/审批）单次上限；超限整批拒绝
  const maxBatchRaw = env.MEMORY_HUB_ADMIN_MAX_BATCH ?? file.admin?.maxBatch ?? file.adminMaxBatch ?? 50
  const adminMaxBatch = Number(maxBatchRaw)
  if (!Number.isInteger(adminMaxBatch) || adminMaxBatch < 1 || adminMaxBatch > 1000) throw new ConfigError(`MEMORY_HUB_ADMIN_MAX_BATCH 必须是 1~1000 的整数：${maxBatchRaw}`)

  // 管理界面只读保护：开启后所有写接口（登出除外）返回 403 read_only。用于"用真实数据快照看界面"的本机环境，防止误点危险按钮。
  const adminReadOnly = env.MEMORY_HUB_ADMIN_READONLY !== undefined ? truthy(env.MEMORY_HUB_ADMIN_READONLY) : truthy(file.admin?.readOnly ?? file.adminReadOnly)

  // 蒸馏 LLM：通用 OpenAI 兼容端点。BASE_URL 与 MODEL 缺一即视为未配置（降级为原文卡）；不回退到 OPENAI_* 变量。
  const baseUrl = String(env.MEMORY_LLM_BASE_URL ?? file.llm?.baseUrl ?? '').trim()
  const model = String(env.MEMORY_LLM_MODEL ?? file.llm?.model ?? '').trim()
  const apiKey = String(env.MEMORY_LLM_KEY ?? (fileKeyAllowed ? file.llm?.key : '') ?? '')
  const llmOpts = parseLlmRequestOptions(env, file.llm) // 即使未配置端点也校验，写错的值启动即报
  const llm = baseUrl && model ? { baseUrl, model, apiKey } : null

  // 会话文本摄入（POST {base}/api/ingest）闸门。均为非负整数；cooldownS=0 表示不设冷却。
  const intOpt = (envName, fileVal, def, lo, hi) => {
    const raw = env[envName] ?? fileVal ?? def
    const n = Number(String(raw).trim())
    if (!/^\d+$/.test(String(raw).trim()) || n < lo || n > hi) throw new ConfigError(`${envName} 必须是 ${lo}~${hi} 的整数：${raw}`)
    return n
  }
  const ingest = {
    minChars: intOpt('MEMORY_HUB_INGEST_MIN_CHARS', file.ingest?.minChars, 300, 60, 65536),
    cooldownS: intOpt('MEMORY_HUB_INGEST_COOLDOWN_S', file.ingest?.cooldownS, 120, 0, 86400),
    dailyQuota: intOpt('MEMORY_HUB_INGEST_DAILY_QUOTA', file.ingest?.dailyQuota, 200, 0, 100000),
    maxBodyBytes: intOpt('MEMORY_HUB_INGEST_MAX_BODY_BYTES', file.ingest?.maxBodyBytes, 256 * 1024, 1024, 1024 * 1024),
  }

  // 图谱蜘蛛搜索（POST /admin/api/graph/search|summarize）：召回条数默认值与每会话最小调用间隔（毫秒，0=不限）。
  const graphSearch = {
    topN: intOpt('MEMORY_HUB_GRAPH_SEARCH_TOPN', file.graphSearch?.topN, 12, 1, 30),
    searchMinIntervalMs: intOpt('MEMORY_HUB_GRAPH_SEARCH_MIN_INTERVAL_MS', file.graphSearch?.searchMinIntervalMs, 400, 0, 60000),
    summarizeMinIntervalMs: intOpt('MEMORY_HUB_GRAPH_SUMMARIZE_MIN_INTERVAL_MS', file.graphSearch?.summarizeMinIntervalMs, 3000, 0, 600000),
  }

  const gatePick = (envName, fileVal, def) => {
    const raw = String(env[envName] ?? fileVal ?? def).trim().toLowerCase()
    if (!GATE_MODES.includes(raw)) throw new ConfigError(`${envName} 必须是 ${GATE_MODES.join(' / ')} 之一：${raw}`)
    return raw
  }
  // 经验闸门默认值：自动推送（ingest）最松不得 → strict；MCP 显式 capture 尊重意图 → heuristic。
  const gate = {
    ingest: gatePick('MEMORY_HUB_GATE_INGEST', file.gate?.ingest, 'strict'),
    capture: gatePick('MEMORY_HUB_GATE_CAPTURE', file.gate?.capture, 'heuristic'),
  }

  const instructions = typeof file.instructions === 'string' && file.instructions.trim() ? file.instructions : null

  return {
    home,
    dbRoot,
    configFile: filePath,
    host,
    port,
    basePath,
    allowRemote,
    allowedHosts: [...new Set([...LOOPBACK_HOSTS, ...extraHosts.map((h) => h.toLowerCase())])],
    allowedOrigins: extraOrigins.map((o) => o.replace(/\/+$/, '').toLowerCase()),
    extraHosts,
    extraOrigins,
    exposeTidyApply,
    adminMaxBatch,
    adminReadOnly,
    trustProxy,
    ingest,
    graphSearch,
    gate,
    llm,
    llmRequest: llmOpts, // { reasoningEffort, extraBody, timeoutMs }：蒸馏请求的可选参数
    instructions,
    logLevel: String(env.MEMORY_HUB_LOG_LEVEL ?? file.logLevel ?? 'info').toLowerCase(),
  }
}

export const isLoopbackBind = (host) => LOOPBACK_BIND.has(String(host).toLowerCase())

/** 启动护栏：非回环监听必须显式 ALLOW_REMOTE，且配置 Origin / Host 白名单，否则拒绝启动。 */
export function validateBind(config) {
  if (isLoopbackBind(config.host)) return
  if (!config.allowRemote) {
    throw new ConfigError(`MEMORY_HUB_HOST=${config.host} 不是回环地址：必须同时设置 MEMORY_HUB_ALLOW_REMOTE=1，并配置 MEMORY_HUB_ALLOWED_ORIGINS 与 MEMORY_HUB_ALLOWED_HOSTS，否则拒绝启动`)
  }
  if (!config.extraOrigins.length || !config.extraHosts.length) {
    throw new ConfigError('MEMORY_HUB_ALLOW_REMOTE=1 时必须同时配置 MEMORY_HUB_ALLOWED_ORIGINS 与 MEMORY_HUB_ALLOWED_HOSTS（防 DNS rebinding），否则拒绝启动')
  }
}
