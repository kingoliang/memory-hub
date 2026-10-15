// memory-hub · stdio 传输：本地单 Agent，进程内直连 DB。
// 身份 = MEMORY_HUB_AGENT 环境变量（自报，进程边界即信任边界）；未设置时用 stdio:<clientInfo.name>。
// write_log 里 actor_id 标记为 stdio:self-asserted。日志只走 stderr（stdout 是协议通道）。

import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { buildMcpServer, llmFromConfig } from './mcp-server.js'
import { getDb } from '../core/db.js'
import { validateName } from '../auth/tokens.js'

/**
 * @param {object} config loadConfig 的结果
 * @param {{log: object, env?: object}} deps
 */
export function runStdio(config, { log, env = process.env }) {
  getDb(config.dbRoot) // 提前打开/迁移，失败就在启动时报
  const agent = String(env.MEMORY_HUB_AGENT || '').trim()
  if (agent) validateName(agent) // 非法名字直接抛，避免写进 submitted_by
  const scopes = ['read', 'write', ...(config.exposeTidyApply ? ['tidy:apply'] : [])]
  const llm = llmFromConfig(config)
  let currentServer = null
  const handle = serveStdio((_ctx) => {
    const identity = { type: 'agent', id: 'stdio:self-asserted', name: agent || 'stdio', ip: '' }
    const resolveName = agent ? undefined : () => {
      const cv = currentServer?.server?.getClientVersion?.()
      const n = String(cv?.name || '').replace(/[^A-Za-z0-9._:@-]/g, '-').slice(0, 50)
      return n ? `stdio:${n}` : 'stdio'
    }
    currentServer = buildMcpServer({ identity, scopes, config, log, llm, resolveName, transport: 'stdio' })
    return currentServer
  }, { legacy: 'serve', onerror: (e) => log.error('stdio 传输错误', { error: String(e?.message || e) }) })
  log.info('MCP stdio 已启动', { agent: agent || '(clientInfo)', identity: 'self-asserted', exposeTidyApply: config.exposeTidyApply, llmConfigured: !!llm })
  return handle
}
