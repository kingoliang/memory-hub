// dsh-memory-hub-ingest —— DSH 插件入口。
// 每轮对话结束（agent/turn-stopping）把增量对话文本推给 memory-hub 的 POST /api/ingest。
// 加载形态与 memory-eternal 相同：具名导出 name + apply(ctx, config)（cordis 约定）。
// 不导出 Config schema（零依赖：不引入 @deepseek-ai/schemastery）；配置在此手工校验。
import { createIngestor, DEFAULTS } from './lib/ingestor.js'

export const name = 'dsh-memory-hub-ingest'

export const DEFAULT_URL = 'http://127.0.0.1:7990/memory/api/ingest'
const TOKEN_ENV = 'MEMORY_HUB_DSH_TOKEN'
const URL_ENV = 'MEMORY_HUB_INGEST_URL'

const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d)

/** 把 profile 里的 config 与环境变量合并成 createIngestor 的参数。令牌只读环境变量，不接受写在 config 里。 */
export function resolveOptions(config = {}, env = process.env) {
  const c = config && typeof config === 'object' ? config : {}
  const tokenEnv = typeof c.tokenEnv === 'string' && c.tokenEnv ? c.tokenEnv : TOKEN_ENV
  return {
    enabled: c.enabled !== false,
    token: String(env[tokenEnv] ?? '').trim(),
    url: (typeof c.url === 'string' && c.url) || String(env[URL_ENV] ?? '').trim() || DEFAULT_URL,
    source: typeof c.source === 'string' && c.source ? c.source.slice(0, 64) : DEFAULTS.source,
    timeoutMs: posInt(c.timeoutMs, DEFAULTS.timeoutMs),
    minChars: posInt(c.minChars, DEFAULTS.minChars),
    maxChars: Math.min(posInt(c.maxChars, DEFAULTS.maxChars), 60000),
    maxQueue: posInt(c.maxQueue, DEFAULTS.maxQueue),
    concurrency: posInt(c.concurrency, DEFAULTS.concurrency),
    userSourceKinds: Array.isArray(c.userSourceKinds) && c.userSourceKinds.length ? c.userSourceKinds.map(String) : DEFAULTS.userSourceKinds,
  }
}

export function apply(ctx, config) {
  const { enabled, ...opts } = resolveOptions(config)
  const log = ctx.logger ?? console
  if (!enabled) {
    try { log.info('[dsh-memory-hub-ingest] config.enabled=false，未注册监听器') } catch { /* ignore */ }
    return
  }
  const ingestor = createIngestor({ ...opts, log })
  if (ingestor.enabled) {
    let host = opts.url
    try { const u = new URL(opts.url); host = `${u.origin}${u.pathname}` } catch { /* 保持原样 */ }
    try { log.info(`[dsh-memory-hub-ingest] 已启用 → ${host}（source=${opts.source}）`) } catch { /* ignore */ }
  }
  // 监听器：同步、绝不 await、绝不抛。DSH 以 serial 方式派发该事件（dsh-agent-loop/lib/index.js:999），
  // 任何 await 或异常都会直接拖慢/打断对话收尾。
  ctx.on('agent/turn-stopping', (payload) => {
    try { ingestor.onTurnStopping(payload) } catch { /* createIngestor 内部已兜底，这里是双保险 */ }
  })
  ctx.effect(() => () => ingestor.dispose(), 'dsh-memory-hub-ingest: dispose')
}
