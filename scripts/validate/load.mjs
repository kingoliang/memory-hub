#!/usr/bin/env node
// 并发压测（合成数据）：N 个并发 worker 持续 S 秒混合 recall / capture，报告错误率、p50/p95/max、服务 RSS；
// 同时对"旁观的旧服务"采样 recall 延迟（压测前 / 压测中 / 压测后），确认不受影响。
// 用法：load.mjs --url http://127.0.0.1:7991/mcp --token-file F --snapshot <旧库快照.db> --pid <新服务 PID>
//        [--workers 40] [--seconds 30] [--capture-ratio 0.08] [--max-captures 60]
//        [--old-url http://127.0.0.1:7990/memory/mcp --old-token-file F]
// capture 文本含 ZZSYN- 标记，事后用清理脚本按标记删除。只输出数字，不输出内容。
import fs from 'node:fs'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d }
const url = arg('url'), tokenFile = arg('token-file'), snapshot = arg('snapshot'), pid = arg('pid')
const workers = Number(arg('workers', 40)), seconds = Number(arg('seconds', 30)), ratio = Number(arg('capture-ratio', 0.08)), maxCaptures = Number(arg('max-captures', 60))
const token = fs.readFileSync(tokenFile, 'utf8').trim()
const H = (t) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t}`, 'mcp-protocol-version': '2025-06-18' })

const db = new DatabaseSync(snapshot, { readOnly: true })
const queries = db.prepare('SELECT title FROM cards ORDER BY id').all().map((r) => [...String(r.title).trim()].slice(0, 6).join('')).filter((q) => q.length >= 2)
db.close()
const rnd = (a) => a[Math.floor(Math.random() * a.length)]
const WORDS = ['网关', '限流', '熔断', '灰度', '对账', '幂等', '重试', '队列', '分片', '索引', '快照', '回放', '探针', '配额', '租约']
const synth = () => `# 压测合成条目\n\n背景：压测脚本生成的合成文本，标记 ZZSYN-${crypto.randomBytes(6).toString('hex')}，不对应真实事项。主题：${rnd(WORDS)}与${rnd(WORDS)}在${rnd(WORDS)}场景下的取舍。结论：采用${rnd(WORDS)}方案，原因是${rnd(WORDS)}成本更低且便于${rnd(WORDS)}。步骤：先评估${rnd(WORDS)}，再灰度${rnd(WORDS)}，最后复盘${rnd(WORDS)}。编号 ${crypto.randomBytes(8).toString('hex')}。`

async function call(u, t, name, args) {
  const t0 = performance.now()
  try {
    const r = await fetch(u, { method: 'POST', headers: H(t), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    const raw = await r.text()
    const ms = performance.now() - t0
    let j = null; try { j = JSON.parse(raw) } catch { const m = /^data: (.+)$/m.exec(raw); if (m) j = JSON.parse(m[1]) }
    const isErr = r.status !== 200 || !j || j.error || j.result?.isError
    let outcome = isErr ? `err-${r.status}` : 'ok'
    if (!isErr && name === 'memory_capture') { try { outcome = JSON.parse(j.result.content[0].text).action || 'ok' } catch { /* keep ok */ } }
    return { ms, err: !!isErr, outcome }
  } catch (e) { return { ms: performance.now() - t0, err: true, outcome: 'exc-' + String(e.cause?.code || e.code || e.name) } }
}
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] * 10) / 10 }
const stat = (rs) => ({ n: rs.length, err: rs.filter((x) => x.err).length, p50: pct(rs.map((x) => x.ms), 50), p95: pct(rs.map((x) => x.ms), 95), max: pct(rs.map((x) => x.ms), 100) })
const rssKb = () => { try { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) } catch { return null } }

// 旧服务采样
const oldUrl = arg('old-url'), oldTok = arg('old-token-file') && fs.readFileSync(arg('old-token-file'), 'utf8').trim()
const sampleOld = async (n, gap) => { const out = []; for (let i = 0; i < n; i++) { out.push(await call(oldUrl, oldTok, 'memory_recall', { query: rnd(queries), limit: 5 })); await new Promise((r) => setTimeout(r, gap)) } return out }
let oldBefore = null, oldDuring = [], oldAfter = null
if (oldUrl) oldBefore = await sampleOld(30, 100)

const rss0 = rssKb(); const rssSamples = [rss0]
const start = performance.now(); const deadline = start + seconds * 1000
const recalls = [], captures = []; const outcomes = {}
let capCount = 0
const rssTimer = setInterval(() => rssSamples.push(rssKb()), 1000)
let oldTimerRunning = !!oldUrl
const oldLoop = (async () => { while (oldTimerRunning) { oldDuring.push(await call(oldUrl, oldTok, 'memory_recall', { query: rnd(queries), limit: 5 })); await new Promise((r) => setTimeout(r, 250)) } })()
await Promise.all(Array.from({ length: workers }, async () => {
  while (performance.now() < deadline) {
    if (Math.random() < ratio && capCount < maxCaptures) {
      capCount++
      const r = await call(url, token, 'memory_capture', { text: synth(), source: 'load-test' }); captures.push(r); outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1
    } else {
      recalls.push(await call(url, token, 'memory_recall', { query: rnd(queries), limit: 5 }))
    }
  }
}))
const elapsed = (performance.now() - start) / 1000
clearInterval(rssTimer); oldTimerRunning = false; await oldLoop
if (oldUrl) oldAfter = await sampleOld(30, 100)
rssSamples.push(rssKb())
const rs = rssSamples.filter((x) => x != null)
const all = [...recalls, ...captures]
console.log(JSON.stringify({
  config: { workers, seconds, captureRatio: ratio, maxCaptures },
  elapsedSec: Math.round(elapsed * 10) / 10,
  total: { requests: all.length, errors: all.filter((x) => x.err).length, errorRatePct: Math.round(all.filter((x) => x.err).length / all.length * 10000) / 100, rps: Math.round(all.length / elapsed) },
  recall: stat(recalls), capture: stat(captures), captureOutcomes: outcomes,
  recallErrors: recalls.filter((x) => x.err).reduce((m, x) => { m[x.outcome] = (m[x.outcome] || 0) + 1; return m }, {}),
  rssMB: { before: rs[0] && Math.round(rs[0] / 1024), peak: Math.round(Math.max(...rs) / 1024), after: Math.round(rs[rs.length - 1] / 1024) },
  oldService: oldUrl ? { before: stat(oldBefore), during: stat(oldDuring), after: stat(oldAfter) } : null,
}, null, 1))
