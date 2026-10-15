import { tmpHome, rmrf, logSink } from './helpers.mjs'

// 需要 hub 服务模块的测试工具（与 helpers.mjs 分开，避免纯数据层测试被服务模块拖累）
import { loadConfig } from '../src/config.js'
import { startServer } from '../src/server.js'
import { closeAllDb, getDb } from '../src/core/db.js'
import { createToken } from '../src/auth/tokens.js'
import { createLogger } from '../src/logger.js'

/** 起一个临时 home 的服务（端口 0、127.0.0.1），返回 { url, home, db, token(name, scopes), logs, close }。 */
export async function withHub(fn, { env = {} } = {}) {
  const home = tmpHome()
  const logs = logSink()
  const config = loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: '0', ...env })
  const srv = await startServer(config, { logger: createLogger({ level: 'debug', stream: logs.stream }), scheduler: false })
  const ctx = {
    home, config, logs, port: srv.port, url: `http://127.0.0.1:${srv.port}`,
    db: () => getDb(home),
    token: (name, scopes, extra = {}) => createToken(home, { name, scopes, ...extra }).token,
  }
  try { return await fn(ctx) } finally { await srv.close(); closeAllDb(); rmrf(home) }
}
