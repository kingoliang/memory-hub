// 图谱默认视图性能实测（playwright）：进入页面 → canvas 首帧耗时、稳定后平均帧耗时、默认视图无警告/无截断提示，并截图。
// 用法：BASE=http://127.0.0.1:7998 ADMIN_PW=... OUT=/tmp/out PW_ROOT=/tmp/pw node tests/e2e/graph-perf-e2e.mjs
// 需要先起一个合成实例（tests/e2e/graph-perf-server.mjs），不连生产、不调真实模型。
import { createRequire } from 'node:module'
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://127.0.0.1:7998'
const PW = process.env.ADMIN_PW
const OUT = process.env.OUT
const RUNS = Number(process.env.RUNS || 3) // 页面加载计时重复次数（取中位数）
const SETTLE_MS = Number(process.env.SETTLE_MS || 5000)
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 5000)
const EXPECT_TRUNC = process.env.EXPECT_TRUNC === '1' // 卡数超过自动上限（>5000）时设为 1
if (!PW || !OUT) { console.error('需要环境变量 ADMIN_PW 与 OUT'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })
const require = createRequire((process.env.PW_ROOT || '.') + '/package.json')
const { chromium } = require('playwright')

const fails = []
const check = (name, ok, info) => { console.log(ok ? 'PASS' : 'FAIL', name, info ?? ''); if (!ok) fails.push(name) }
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

// 在页面脚本之前埋点：记录导航起点、canvas 出现、首帧绘制。
const INIT = () => {
  window.__t0 = performance.now()
  const tick = () => {
    const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
    if (c) {
      if (!window.__canvasAt) window.__canvasAt = performance.now()
      if (c.__mhGraph.perf.frames > 0 && !window.__firstFrameAt) window.__firstFrameAt = performance.now()
    }
    window.__raf = requestAnimationFrame(tick)
  }
  window.__raf = requestAnimationFrame(tick)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript(INIT)
const page = await ctx.newPage()
page.on('pageerror', (e) => { fails.push('pageerror ' + e); console.log('PAGEERROR', e) })
await page.goto(BASE + '/admin/#/graph')
await page.waitForSelector('input[type=password]')
await page.fill('input[type=password]', PW)
await page.keyboard.press('Enter')
await page.waitForSelector('canvas', { timeout: 30000 })

// 1) 进入页面 → canvas 首帧
const ttff = []
for (let i = 0; i < RUNS; i++) {
  const p = await ctx.newPage()
  p.on('pageerror', (e) => { fails.push('pageerror ' + e); console.log('PAGEERROR', e) })
  await p.goto(BASE + '/admin/#/graph')
  await p.waitForFunction(() => window.__firstFrameAt > 0, null, { timeout: 30000 })
  ttff.push(await p.evaluate(() => window.__firstFrameAt - window.__t0))
  await p.close()
}

// 2) 默认视图：状态、提示、稳定后帧耗时、截图
await page.goto(BASE + '/admin/#/graph')
await page.waitForFunction(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  return c && c.__mhGraph.perf.frames > 30
}, null, { timeout: 30000 })
await page.waitForTimeout(SETTLE_MS)
const state = await page.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  return {
    hash: location.hash,
    nodes: c.__mhGraph.perf.frames >= 0 ? document.querySelector('.graph-count')?.textContent || '' : '',
    limitValue: document.querySelector('select[aria-label="最多节点数"]')?.value,
    warnNotices: document.querySelectorAll('.notice-warn').length,
    infoNotices: [...document.querySelectorAll('.notice-info')].map((n) => n.textContent.trim()),
    perf: { ...c.__mhGraph.perf },
  }
})
const f0 = state.perf.frames
const s0 = state.perf.sum
await page.waitForTimeout(SAMPLE_MS)
const after = await page.evaluate(() => { const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); return { ...c.__mhGraph.perf } })
const frames = after.frames - f0
const avgFrameMs = frames > 0 ? (after.sum - s0) / frames : NaN
await page.screenshot({ path: `${OUT}/default.png` })

const truncRe = /仅显示关联度最高|已按所选上限/
check('默认 limit 下拉 = 自动', state.limitValue === 'auto', state.limitValue)
check('默认 URL 不带 limit', !/limit=/.test(state.hash), state.hash)
if (EXPECT_TRUNC) {
  check('默认视图仍无 .notice-warn', state.warnNotices === 0, String(state.warnNotices))
  check('默认视图有信息级自动截断提示', state.infoNotices.some((t) => /卡片数超过/.test(t)), state.infoNotices.join(' | '))
} else {
  check('默认视图无截断提示', !state.infoNotices.some((t) => truncRe.test(t)), state.infoNotices.join(' | '))
}
check('进入页面 → canvas 首帧 ≤1000ms', median(ttff) <= 1000, `median=${median(ttff).toFixed(1)}ms runs=${ttff.map((x) => x.toFixed(1)).join(',')}`)
check('稳定后平均帧耗时 ≤16ms', avgFrameMs <= 16, `avg=${avgFrameMs.toFixed(2)}ms frames=${frames}`)

// 3) 手动压小上限：只出信息级截断提示，不出 warn
await page.goto(BASE + '/admin/#/graph?limit=200')
await page.waitForFunction(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  return c && c.__mhGraph.perf.frames > 5
}, null, { timeout: 30000 })
const manual = await page.evaluate(() => ({
  warnNotices: document.querySelectorAll('.notice-warn').length,
  infoNotices: [...document.querySelectorAll('.notice-info')].map((n) => n.textContent.trim()),
  limitValue: document.querySelector('select[aria-label="最多节点数"]')?.value,
  hash: location.hash,
}))
await page.screenshot({ path: `${OUT}/manual-limit-200.png` })
check('手动上限：下拉值 = 200', manual.limitValue === '200', manual.limitValue)
check('手动上限：仍无 .notice-warn', manual.warnNotices === 0, String(manual.warnNotices))
check('手动上限：info 提示写明所选上限', manual.infoNotices.some((t) => /已按所选上限/.test(t)), manual.infoNotices.join(' | '))

const report = { runs: RUNS, ttffMs: ttff, firstFrameMedianMs: median(ttff), avgFrameMs, frames, state, manual }
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log('REPORT', JSON.stringify({ firstFrameMedianMs: report.firstFrameMedianMs, avgFrameMs, nodes: state.nodes }))
console.log(fails.length ? `FAILED ${fails.length}: ${fails.join(' / ')}` : 'ALL PASS')
await browser.close()
process.exit(fails.length ? 1 : 0)
