// memory-hub · 把工具注册表挂到 SDK 的 McpServer 上（HTTP 与 stdio 共用）。
// 每次调用工厂都会按调用者身份新建实例（无状态），tools/list 因此天然按 scope 过滤。

import { McpServer } from '@modelcontextprotocol/server'
import { schemaOf, toolsForScopes, callTool } from '../tools/registry.js'
import { DEFAULT_INSTRUCTIONS } from '../instructions.js'
import { createOpenAiLlm } from '../core/llm-openai.js'

export const SERVER_NAME = 'memory-hub'
export const SERVER_VERSION = '0.1.0'

/** 由配置构造蒸馏 LLM 适配器（通用 OpenAI 兼容端点）；未配置返回 null → capture 降级为原文卡。 */
export function llmFromConfig(config) {
  if (!config.llm) return null
  return createOpenAiLlm({ baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey, model: config.llm.model })
}

/**
 * @param {{ transport?: 'http'|'stdio', identity: {type:string,id:string,name:string,ip?:string}, scopes: string[], config: object, log: object, llm?: object|null, resolveName?: () => string }} p
 */
export function buildMcpServer({ identity, scopes, config, log, llm = null, resolveName, transport = 'http' }) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: config.instructions || DEFAULT_INSTRUCTIONS, capabilities: { tools: {} } },
  )
  for (const def of toolsForScopes(scopes, config)) {
    server.registerTool(def.name, { description: def.description, inputSchema: schemaOf(def) }, async (args) => {
      const id = resolveName ? { ...identity, name: resolveName() } : identity
      return callTool(def, args ?? {}, { root: config.dbRoot, identity: id, config, llm, log, transport })
    })
  }
  return server
}
