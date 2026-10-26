// 图谱 API 性能实测：冷建图（未命中缓存）与命中缓存的响应时间。只打本地合成实例。
// 用法：node tests/e2e/graph-perf-api.mjs <base> <口令文件> [预热次数]
// 环境变量：MODE=clusters 打聚合视图（默认 cards）；CLUSTER_BY=tag 换聚合维度。
// 输出一行 JSON：{ mode, coldMs, warmMs:[...], truncated, limitAuto, nodes, edges, limit, clusters, aggregateMs }
import fs from 'node:fs'

const [base, pwFile, warmArg] = process.argv.slice(2)
const warmN = Number(warmArg || 5)
if (!base || !pwFile) { console.error('用法：graph-perf-api.mjs <base> <口令文件> [预热次数]'); process.exit(2) }
const password = fs.readFileSync(pwFile, 'utf8').trim()
const mode = process.env.MODE === 'clusters' ? 'clusters' : 'cards'
const qs = `?mode=${mode}` + (process.env.CLUSTER_BY ? `&cluster_by=${encodeURIComponent(process.env.CLUSTER_BY)}` : '')
const URL_GRAPH = '/admin/api/graph' + qs

const jar = new Map()
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
async function req(method, path, body, { allow401 = false } = {}) {
  const headers = { accept: 'application/json', cookie: cookieHeader() }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (jar.get('mh_csrf')) headers['x-csrf-token'] = jar.get('mh_csrf')
  const t0 = performance.now()
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  const ms = performance.now() - t0
  for (const sc of res.headers.getSetCookie?.() || []) {
    const [pair] = sc.split(';')
    const i = pair.indexOf('=')
    const k = pair.slice(0, i).trim()
    const v = pair.slice(i + 1).trim()
    if (/max-age=0/i.test(sc) || v === '') jar.delete(k); else jar.set(k, v)
  }
  if (!res.ok && !allow401) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`)
  return { ms, json: text ? JSON.parse(text) : null }
}

await req('GET', '/admin/api/session', undefined, { allow401: true })
const login = await req('POST', '/admin/api/login', { password })
if (login.json?.csrfToken) jar.set('mh_csrf', login.json.csrfToken)

// 冷：立即第一次请求（进程内图谱缓存为空 → 必须全量建图）
const cold = await req('GET', URL_GRAPH)
const warmMs = []
let last = cold
for (let i = 0; i < warmN; i++) { last = await req('GET', URL_GRAPH); warmMs.push(Number(last.ms.toFixed(2))) }
const s = last.json.stats
console.log(JSON.stringify({ mode, coldMs: Number(cold.ms.toFixed(2)), warmMs, truncated: last.json.truncated, limitAuto: s.limitAuto, nodes: s.nodes, edges: s.edges, limit: s.limit, buildMs: s.buildMs, cached: s.cached, clusters: s.clusters, aggregateMs: s.aggregateMs }))
