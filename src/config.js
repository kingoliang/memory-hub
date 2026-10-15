// memory-hub · 配置：环境变量 > 配置文件（$MEMORY_HUB_HOME/memory-hub.json）> 默认值。
// 秘密（LLM key）只从环境变量或权限为 0600 的配置文件读取；绝不写入日志。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

  // 蒸馏 LLM：通用 OpenAI 兼容端点。BASE_URL 与 MODEL 缺一即视为未配置（降级为原文卡）；不回退到 OPENAI_* 变量。
  const baseUrl = String(env.MEMORY_LLM_BASE_URL ?? file.llm?.baseUrl ?? '').trim()
  const model = String(env.MEMORY_LLM_MODEL ?? file.llm?.model ?? '').trim()
  const apiKey = String(env.MEMORY_LLM_KEY ?? (fileKeyAllowed ? file.llm?.key : '') ?? '')
  const llm = baseUrl && model ? { baseUrl, model, apiKey } : null

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
    trustProxy,
    llm,
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
