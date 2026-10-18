// 录制 README 用的「图谱蜘蛛」动画（GIF）。
// 全程合成数据 + 本地 LLM 测试桩：临时目录造库 → 起 hub → headless Chrome 打开图谱 → 先录装饰游走，再录一次蜘蛛搜索巡游 → ffmpeg 调色板编码。
// 不连生产库、不调真实模型；零 npm 依赖（Chrome DevTools Protocol 直连）。
//
// 用法：node scripts/demo/record-spider-gif.mjs <输出.gif> [--width 860] [--fps 12] [--keep-frames <目录>]
// 需要本机 Chrome（CHROME 环境变量可指定路径）与 ffmpeg。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const outGif = argv[0]
if (!outGif || outGif.startsWith('--')) { console.error('用法：record-spider-gif.mjs <输出.gif> [--width N] [--fps N] [--keep-frames 目录]'); process.exit(2) }
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const WIDTH = Number(opt('width', 640))
const FPS = Number(opt('fps', 12))
const COLORS = Number(opt('colors', 64))
const KEEP = opt('keep-frames', '')
const VIEW_W = 1440; const VIEW_H = 900; const DSF = 2
const QUERY = '缓存'
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-spider-gif-'))
const framesDir = KEEP || path.join(home, 'frames')
fs.mkdirSync(framesDir, { recursive: true })
const profile = path.join(home, 'chrome'); fs.mkdirSync(profile)
let stub = null; let srv = null; let chrome = null

try {
  // ---- LLM 测试桩：OpenAI 兼容接口，返回固定的汇总 JSON（不出网）----
  stub = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => {
      const content = JSON.stringify({ summary: '缓存方面的结论集中在三点：先更新数据库再删缓存；空值与过期时间要配合使用；热键需要打散。', points: [{ text: '先更库再删缓存，删失败靠过期兜底', refs: [1] }, { text: '空值缓存过期要短，避免挡住新数据', refs: [2] }, { text: '热键加随机后缀拆分，读时聚合', refs: [3] }] })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'demo', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise((r) => stub.listen(0, '127.0.0.1', r))

  // ---- 合成数据 + hub ----
  const { loadConfig } = await import('../../src/config.js')
  const { startServer } = await import('../../src/server.js')
  const { createLogger } = await import('../../src/logger.js')
  const { setAdminPassword } = await import('../../src/admin/auth.js')
  const { seedDemoLibrary } = await import('./seed-demo.mjs')
  const config = loadConfig({
    MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: '0', MEMORY_HUB_LOG_LEVEL: 'warn',
    MEMORY_LLM_BASE_URL: `http://127.0.0.1:${stub.address().port}/v1`, MEMORY_LLM_MODEL: 'demo-stub', MEMORY_LLM_KEY: 'demo',
    MEMORY_HUB_GRAPH_SEARCH_MIN_INTERVAL_MS: '0', MEMORY_HUB_GRAPH_SUMMARIZE_MIN_INTERVAL_MS: '0',
  })
  const cards = await seedDemoLibrary(config.dbRoot, { cards: 360 })
  const password = 'demo-password-only'
  setAdminPassword(config.dbRoot, password, { cost: { N: 1024, r: 8, p: 1 } })
  srv = await startServer(config, { logger: createLogger({ level: 'warn' }), scheduler: false })
  const base = `http://127.0.0.1:${srv.port}`
  console.log(`[gif] 合成数据 ${cards} 张卡 → ${base}`)

  // ---- Chrome（CDP）----
  const port = 9700 + Math.floor(Math.random() * 200)
  chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' })
  let wsUrl = ''
  for (let i = 0; i < 60 && !wsUrl; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }); if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl } catch { /* 未就绪 */ } if (!wsUrl) await sleep(200) }
  if (!wsUrl) throw new Error('Chrome 未启动')
  const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r))
  let id = 0; const pending = new Map(); const problems = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return }
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 失败'); return r.result.value }
  const waitFor = async (expr, label, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(expr).catch(() => false)) return; await sleep(120) } throw new Error('等待超时：' + label + (problems.length ? ' | ' + problems.join(' ; ') : '')) }

  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: DSF, mobile: false })
  await send('Page.navigate', { url: base + '/admin/#/graph' })
  await waitFor("!!document.querySelector('input[type=password]')", '登录页')
  await js(`(() => { const i = document.querySelector('input[type=password]'); i.value = ${JSON.stringify(password)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.form ? i.form.requestSubmit() : null })()`)
  await waitFor("[...document.querySelectorAll('canvas')].some((c) => c.__mhGraph)", '图谱画布')
  await waitFor("(() => { const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); const s = c.__mhGraph.spider(); return s && s.enabled && s.legs > 2 })()", '蜘蛛就位')
  await sleep(2500) // 布局收敛

  // 裁剪区 = 画布舞台 ∩ 视口（CSS 像素）
  const rect = await js(`(() => { const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); const r = (c.closest('.graph-stage') || c).getBoundingClientRect(); const x = Math.max(0, r.x); const y = Math.max(0, r.y); return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.min(innerWidth, r.right) - x), height: Math.round(Math.min(innerHeight, r.bottom) - y) } })()`)

  // ---- 采集：CDP screencast 推送合成器帧（带真实时间戳，编码时按实际时长还原速度）----
  const frames = [] // { file, ts }
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method !== 'Page.screencastFrame') return
    const file = path.join(framesDir, 'f' + String(frames.length).padStart(5, '0') + '.jpg')
    fs.writeFileSync(file, Buffer.from(m.params.data, 'base64'))
    frames.push({ file, ts: m.params.metadata.timestamp })
    send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {})
  })
  // 并行校验：持续抽查每帧画出的触手末端都在节点上
  let checking = true; let tipFrames = 0; let tipOff = 0
  const checker = (async () => {
    while (checking) {
      const chk = await js(`(() => { const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); const g = c.__mhGraph; const s = g.spider(); const v = g.view; const np = g.nodePoints(); let off = 0; for (const t of (s.tips || [])) { const fx = t.x * v.zoom + v.panX; const fy = t.y * v.zoom + v.panY; let bd = 1e9; for (const p of np) bd = Math.min(bd, Math.hypot(p.x - fx, p.y - fy)); if (bd > 0.5) off++ } return { tips: (s.tips || []).length, off } })()`).catch(() => ({ tips: 0, off: 0 }))
      tipFrames += chk.tips; tipOff += chk.off
      await sleep(40)
    }
  })()
  // 显式要求设备像素尺寸的帧（默认会按 CSS 像素下采样）
  await send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: VIEW_W * DSF, maxHeight: VIEW_H * DSF })

  await sleep(3000) // 装饰游走：簇间爬行、触手踩点
  await js(`(() => { const i = document.querySelector('#graph-search-input'); i.focus(); i.value = ${JSON.stringify(QUERY)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
  await waitFor("(() => { const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); return c.__mhGraph.spider().mode === 'think' || c.__mhGraph.spiderUi().phase === 'done' })()", '巡游结束', 15000).catch(() => {})
  await sleep(2200) // 汇总面板出现
  await send('Page.stopScreencast'); checking = false; await checker
  await sleep(200)
  ws.close()
  const span = frames.length > 1 ? frames[frames.length - 1].ts - frames[0].ts : 0
  console.log(`[gif] 采集 ${frames.length} 帧 / ${span.toFixed(1)}s（≈${(frames.length / Math.max(span, 1e-3)).toFixed(0)} fps）；触手末端检查：${tipFrames} 条中 ${tipOff} 条不在节点上`, problems.length ? '| 页面异常：' + problems.join(' ; ') : '')
  if (frames.length < 10) throw new Error('采集帧数过少')

  // ---- 编码：concat 按真实帧时长 → 重采样到 FPS → 裁剪舞台 → 调色板 ----
  const list = path.join(framesDir, 'frames.txt')
  fs.writeFileSync(list, frames.map((f, i) => `file '${f.file}'\nduration ${(i + 1 < frames.length ? frames[i + 1].ts - f.ts : 1 / FPS).toFixed(4)}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`)
  // 按帧的实际宽度换算裁剪比例（screencast 可能不给满设备像素）
  const fw = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', frames[0].file]).stdout.toString().trim()) || VIEW_W
  const k = fw / VIEW_W
  const crop = `crop=${Math.floor(rect.width * k)}:${Math.floor(rect.height * k)}:${Math.floor(rect.x * k)}:${Math.floor(rect.y * k)}`
  const vf = `fps=${FPS},${crop},scale=${WIDTH}:-1:flags=lanczos`
  const palette = path.join(framesDir, 'palette.png')
  const ff = (args) => { const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }); if (r.status !== 0) throw new Error('ffmpeg 失败：' + r.stderr.toString().slice(-600)) }
  const input = ['-f', 'concat', '-safe', '0', '-i', list]
  // 暗色底 + 细点线：不抖动（抖动会把黑底变噪点、体积翻倍）
  ff(['-y', '-loglevel', 'error', ...input, '-vf', `${vf},palettegen=max_colors=${COLORS}:stats_mode=diff`, palette])
  ff(['-y', '-loglevel', 'error', ...input, '-i', palette, '-lavfi', `${vf}[v];[v][1:v]paletteuse=dither=none:diff_mode=rectangle`, '-loop', '0', outGif])
  console.log(`[gif] 已写出 ${outGif}（${(fs.statSync(outGif).size / 1048576).toFixed(2)} MB）`)
  if (tipOff) process.exitCode = 1
} finally {
  chrome?.kill()
  await srv?.close().catch(() => {})
  stub?.close()
  const { closeAllDb } = await import('../../src/core/db.js'); closeAllDb()
  if (!KEEP) fs.rmSync(home, { recursive: true, force: true })
}
