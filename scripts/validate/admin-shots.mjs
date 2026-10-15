#!/usr/bin/env node
// 真实数据实例的管理界面截图（headless Chrome + CDP，沿用 tests/e2e/admin-screenshots.mjs 的写法）：
// 登录 → 总览 / 卡片列表 / 卡片详情 / 待审队列（+ 回收站、令牌、活跃度）截图，收集控制台/CSP 问题。
// 用法：admin-shots.mjs <baseUrl> <口令文件> <输出目录>    截图含真实数据：输出目录只能放仓库之外，且不要把图贴出去。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const [base, pwFile, outDir] = process.argv.slice(2)
if (!base || !pwFile || !outDir) { console.error('用法：admin-shots.mjs <baseUrl> <口令文件> <输出目录>'); process.exit(2) }
if (path.resolve(outDir).startsWith(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'))) { console.error('输出目录不能在仓库内（截图含真实数据）'); process.exit(2) }
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333 + Math.floor(Math.random() * 500)
const password = fs.readFileSync(pwFile, 'utf8').trim()
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-chrome-'))
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }); if (r.ok) return (await r.json()).webSocketDebuggerUrl } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('Chrome 未启动')
}
const ws = new WebSocket(await wsUrl())
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
const problems = []
let expected401 = true
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`console.${m.params.type}`)
  if (m.method === 'Runtime.exceptionThrown') problems.push('exception')
  if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level) && !(expected401 && /401/.test(m.params.entry.text) && /\/api\/(session|login)/.test(m.params.entry.url || ''))) problems.push(`log.${m.params.entry.level}: ${m.params.entry.text.slice(0, 80)}`)
})
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval 失败'); return r.result.value }
const waitFor = async (expr, label, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await evalJs(expr).catch(() => false)) return; await sleep(100) } throw new Error('等待超时：' + label) }
const shots = []
const shot = async (name) => {
  await sleep(500)
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const f = path.join(outDir, name + '.png')
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'), { mode: 0o600 })
  shots.push(`${name}.png ${fs.statSync(f).size}B`)
}
const route = async (hash, ready) => { await evalJs(`location.hash = ${JSON.stringify(hash)}`); await waitFor(`!!document.querySelector('#view .page') && !document.querySelector('#view .loading')`, hash); if (ready) await waitFor(ready, hash + ' ready') }

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: base.replace(/\/$/, '') + '/admin/' })
await waitFor(`!!document.querySelector('input[type=password]')`, '登录页')
await evalJs(`(() => { const i = document.querySelector('input[type=password]'); i.value = ${JSON.stringify(password)}; document.querySelector('form').requestSubmit(); return true })()`)
await sleep(800); expected401 = false
await waitFor(`!!document.querySelector('#view .page')`, '登录后外壳')
await waitFor(`!document.querySelector('#view .loading')`, '总览加载')
await shot('01-overview')
await route('#/cards', `document.querySelectorAll('.card-row').length > 0`); await shot('02-cards-list')
const nCards = await evalJs(`document.querySelectorAll('.card-row').length`)
const href = await evalJs(`document.querySelector('.card-row .card-link').getAttribute('href')`)
await route(href, `!!document.querySelector('.detail-head')`); await shot('03-card-detail')
await route('#/queue', `!!document.querySelector('#view .page')`); await shot('04-queue')
const nQueue = await evalJs(`document.querySelectorAll('.card-row').length`)
await route('#/recycle'); await shot('05-recycle')
await route('#/tokens'); await shot('06-tokens')
await route('#/activity'); await shot('07-activity')
console.log(JSON.stringify({ shots, listRows: nCards, queueRows: nQueue, consoleProblems: problems.length, problems }, null, 1))
ws.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* 临时目录 */ }
process.exit(problems.length ? 1 : 0)
