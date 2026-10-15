// 真实浏览器实测（headless Chrome + CDP，无额外依赖）：登录 → 逐页截图 → 收集控制台错误 / CSP 违规 → XSS 卡检查。
// 用法：node tests/e2e/admin-screenshots.mjs <baseUrl> <口令文件> <输出目录>   （CHROME 环境变量可指定浏览器路径）
// 只应对合成数据的实例运行；口令从文件读取，不出现在命令行/输出里。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const [base, pwFile, outDir] = process.argv.slice(2)
if (!base || !pwFile || !outDir) { console.error('用法：admin-screenshots.mjs <baseUrl> <口令文件> <输出目录>'); process.exit(2) }
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333 + Math.floor(Math.random() * 500)
const password = fs.readFileSync(pwFile, 'utf8').trim()
fs.mkdirSync(outDir, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-chrome-'))
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('Chrome 未启动')
}

const ws = new WebSocket(await wsUrl())
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
const problems = []
let expected401 = true // 登录前探测 session 与故意输错口令产生的 401 是预期行为，不算问题
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`)
  if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
  if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level) && !(expected401 && /401/.test(m.params.entry.text) && /\/api\/(session|login)/.test(m.params.entry.url || ''))) problems.push(`log.${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url || ''}`)
})
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 失败'); return r.result.value }
const waitFor = async (expr, label, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await evalJs(expr).catch(() => false)) return; await sleep(100) } const dump = await evalJs("(document.querySelector('#view')||document.body).innerText.slice(0,300)").catch(() => ''); throw new Error('等待超时：' + label + ' | 页面内容：' + dump + ' | 问题：' + problems.join(' ; ')) }
const shot = async (name) => {
  await sleep(350)
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(r.data, 'base64'))
  console.log('截图', name)
}
const route = async (hash, ready) => { await evalJs(`location.hash = ${JSON.stringify(hash)}`); await waitFor(`!!document.querySelector('#view .page') && !document.querySelector('#view .loading')`, hash); if (ready) await waitFor(ready, hash + ' ready') }

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
const viewport = (w, h, dark = false, mobile = false) => Promise.all([
  send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }),
  send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }),
])
await viewport(1440, 900)
await send('Page.navigate', { url: base.replace(/\/$/, '') + '/admin/' })
await waitFor(`!!document.querySelector('input[type=password]')`, '登录页')
await shot('01-login')

// 错误口令一次，再正确登录（走真实表单）
const fill = (pw) => evalJs(`(() => { const i = document.querySelector('input[type=password]'); i.value = ${JSON.stringify(pw)}; document.querySelector('form').requestSubmit(); return true })()`)
await fill('definitely-wrong-password')
await waitFor(`document.querySelector('.form-error') && !document.querySelector('.form-error').hidden`, '错误提示')
await shot('02-login-wrong-password')
await fill(password)
await sleep(800); expected401 = false
await waitFor(`!!document.querySelector('#view .page')`, '登录后外壳')
await waitFor(`!document.querySelector('#view .loading')`, '总览加载')
await shot('03-overview')

await route('#/cards', `document.querySelectorAll('.card-row').length > 0`); await shot('04-cards-list')
await route('#/cards?q=' + encodeURIComponent('数据库选型') + '&kind=knowledge', `document.querySelectorAll('.card-row').length > 0`); await shot('05-cards-search')
const firstHref = await evalJs(`document.querySelector('.card-row .card-link').getAttribute('href')`)
await route(firstHref, `!!document.querySelector('.detail-head')`); await shot('06-card-detail')
await route('#/queue', `document.querySelectorAll('.card-row').length > 0`); await shot('07-queue')
await route('#/recycle', `document.querySelectorAll('.card-row').length > 0`); await shot('08-recycle')
await route('#/tags'); await shot('09-tags')
await route('#/tidy'); await shot('10-tidy-preview')
await route('#/lint'); await shot('11-lint')
await route('#/activity'); await shot('12-activity')
await route('#/tokens', `document.querySelectorAll('table tbody tr').length > 0`); await shot('13-tokens')
await route('#/audit', `document.querySelectorAll('table tbody tr').length > 0`); await shot('14-audit')

// XSS 卡：先在列表里找到它，再看详情
await route('#/cards?q=' + encodeURIComponent('恶意标题'), `document.querySelectorAll('.card-row').length > 0`); await shot('15-xss-in-list')
const xssHref = await evalJs(`document.querySelector('.card-row .card-link').getAttribute('href')`)
await route(xssHref, `!!document.querySelector('.detail-head')`)
const xss = await evalJs(`(() => ({
  fired: window.__xss ?? null,
  scriptsInView: document.querySelectorAll('#view script').length,
  imgsInView: document.querySelectorAll('#view img').length,
  onAttrs: [...document.querySelectorAll('#view *')].flatMap((e) => [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name)),
  titleText: document.querySelector('.detail-head h1').textContent,
  bodyHasLiteralScript: document.querySelector('.md').textContent.includes('<script>window.__xss=1</script>'),
  jsLinks: [...document.querySelectorAll('#view a')].filter((a) => /^\\s*javascript:/i.test(a.getAttribute('href') || '')).length,
}))()`)
console.log('XSS 检查', JSON.stringify(xss))
await shot('16-xss-card-detail')

// 深色 + 手机宽度
await viewport(1440, 900, true); await route('#/overview'); await shot('17-overview-dark')
await viewport(390, 844, false, true); await route('#/cards', `document.querySelectorAll('.card-row').length > 0`); await shot('18-cards-mobile')
await route('#/activity'); await shot('19-activity-mobile')

// 登出
await viewport(1440, 900)
await evalJs(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('退出')).click()`)
await waitFor(`!!document.querySelector('input[type=password]')`, '登出后回到登录页')

console.log('控制台/CSP 问题数：', problems.length)
for (const p of problems) console.log('  -', p)
ws.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* 临时目录，残留无害 */ }
const bad = xss.fired !== null || xss.scriptsInView || xss.imgsInView || xss.onAttrs.length || xss.jsLinks || !xss.bodyHasLiteralScript
process.exit(problems.length || bad ? 1 : 0)
