#!/usr/bin/env node
// memory-hub CLI
//   memory-hub serve                         起 HTTP 服务（默认 127.0.0.1:7990）
//   memory-hub mcp                           stdio MCP（本地单 Agent，身份取 MEMORY_HUB_AGENT）
//   memory-hub token create --name N --scope read,write [--expires 14d|ISO时间]   明文只显示这一次（stdout）
//   memory-hub token list [--json]
//   memory-hub token revoke <name|tokenId>
//   memory-hub backup now

import { loadConfig, validateBind, ConfigError } from '../src/config.js'
import { createLogger, setDefaultLogger } from '../src/logger.js'
import { createToken, listTokens, revokeToken, TokenError } from '../src/auth/tokens.js'
import { backupDb, closeAllDb } from '../src/core/db.js'

const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const flag = (name) => argv.includes('--' + name)

const bootLog = createLogger({ level: process.env.MEMORY_HUB_LOG_LEVEL || 'info' })

function parseExpires(v) {
  if (!v) return null
  const m = /^(\d+)([mhd])$/.exec(v)
  if (m) return new Date(Date.now() + Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]]).toISOString()
  if (Number.isNaN(Date.parse(v))) throw new TokenError(`--expires 需要形如 30m / 12h / 14d 或 ISO 时间：${v}`)
  return new Date(v).toISOString()
}

function usage() {
  process.stderr.write(`用法：
  memory-hub serve
  memory-hub mcp
  memory-hub token create --name <名字> --scope read,write[,tidy:apply] [--expires 14d]
  memory-hub token list [--json]
  memory-hub token revoke <名字|tokenId>
  memory-hub backup now
环境变量：MEMORY_HUB_HOME MEMORY_HUB_DB MEMORY_HUB_HOST MEMORY_HUB_PORT MEMORY_HUB_BASE_PATH MEMORY_HUB_ALLOW_REMOTE
  MEMORY_HUB_ALLOWED_ORIGINS MEMORY_HUB_ALLOWED_HOSTS MEMORY_HUB_TRUST_PROXY MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY MEMORY_HUB_AGENT
  MEMORY_LLM_BASE_URL MEMORY_LLM_MODEL MEMORY_LLM_KEY
`)
}

async function main() {
  const [cmd, sub] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return cmd ? 0 : 1 }
  const config = loadConfig(process.env, { warn: (m) => bootLog.warn(m) })
  const log = createLogger({ level: config.logLevel })
  setDefaultLogger(log)

  if (cmd === 'serve') {
    validateBind(config)
    const { startServer } = await import('../src/server.js')
    const srv = await startServer(config, { logger: log })
    const stop = async (sig) => {
      log.info('收到退出信号，正在关闭', { signal: sig })
      await srv.close().catch(() => {})
      closeAllDb()
      process.exit(0)
    }
    process.on('SIGTERM', () => stop('SIGTERM'))
    process.on('SIGINT', () => stop('SIGINT'))
    return null // 保持运行
  }

  if (cmd === 'mcp') {
    const { runStdio } = await import('../src/transport/stdio.js')
    const handle = runStdio(config, { log })
    const stop = async () => { try { await handle.close() } catch { /* ignore */ } closeAllDb(); process.exit(0) }
    process.stdin.on('end', stop)
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
    return null
  }

  if (cmd === 'token') {
    if (sub === 'create') {
      const t = createToken(config.dbRoot, { name: opt('name'), scopes: opt('scope'), expiresAt: parseExpires(opt('expires')) })
      log.info('令牌已创建', { name: t.name, id: t.tokenId, scopes: t.scopes, expiresAt: t.expiresAt })
      process.stderr.write(`令牌名：${t.name}\nscope：${t.scopes.join(',')}\n过期：${t.expiresAt || '不过期'}\n以下为令牌明文，只显示这一次，请立即保存（库里只存哈希）：\n`)
      process.stdout.write(t.token + '\n')
      return 0
    }
    if (sub === 'list') {
      const rows = listTokens(config.dbRoot)
      if (flag('json')) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return 0 }
      if (!rows.length) { process.stdout.write('（没有令牌）\n'); return 0 }
      for (const r of rows) {
        const state = r.revokedAt ? '已撤销' : r.expiresAt && Date.parse(r.expiresAt) <= Date.now() ? '已过期' : '有效'
        process.stdout.write(`${r.name}\t${r.tokenId}\t${r.scopes.join(',')}\t${state}\t创建 ${r.createdAt}\t最近使用 ${r.lastUsedAt || '-'}\t过期 ${r.expiresAt || '-'}\n`)
      }
      return 0
    }
    if (sub === 'revoke') {
      const target = argv[2]
      if (!target) throw new TokenError('用法：memory-hub token revoke <名字|tokenId>')
      const r = revokeToken(config.dbRoot, target)
      log.info('令牌已撤销', { name: r.name, id: r.tokenId })
      process.stdout.write(`已撤销：${r.name}（${r.tokenId}）\n`)
      return 0
    }
    usage(); return 1
  }

  if (cmd === 'backup' && sub === 'now') {
    const r = await backupDb(config.dbRoot)
    if (!r.ok) throw new Error(`备份失败：${r.error}`)
    log.info('备份完成', { file: r.path, bytes: r.bytes })
    process.stdout.write(r.path + '\n')
    return 0
  }

  usage(); return 1
}

main().then((code) => { if (code !== null) { closeAllDb(); process.exit(code) } }).catch((e) => {
  const known = e instanceof ConfigError || e instanceof TokenError
  bootLog.error(known ? e.message : '未预期的错误', known ? undefined : { error: String(e?.stack || e).slice(0, 800) })
  process.exit(1)
})
