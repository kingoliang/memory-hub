// 聚合视图（mode=clusters）的浏览器验证：默认落在聚合视图、簇数 ≤ 上限、无截断提示、首帧与帧耗时、点簇展开成卡片视图。
// 用法：BASE=http://127.0.0.1:7998 ADMIN_PW=... OUT=/tmp/out PW_ROOT=/tmp/pw node tests/e2e/graph-cluster-e2e.mjs
// 需要先起一个合成实例（tests/e2e/graph-perf-server.mjs），不连生产、不调真实模型。
import { createRequire } from 'node:module'
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://127.0.0.1:7998'
const PW = process.env.ADMIN_PW
const OUT = process.env.OUT
const RUNS = Number(process.env.RUNS || 3)
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 5000)
const MAX_CLUSTERS = Number(process.env.MAX_CLUSTERS || 60)
const MAX_FIRST_FRAME_MS = Number(process.env.MAX_FIRST_FRAME_MS || 1000)
const MAX_FRAME_MS = Number(process.env.MAX_FRAME_MS || 20) // ≥50fps
if (!PW || !OUT) { console.error('需要环境变量 ADMIN_PW 与 OUT'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })
const require = createRequire((process.env.PW_ROOT || '.') + '/package.json')
const { chromium } = require('playwright')

const fails = []
const check = (name, ok, info) => { console.log(ok ? 'PASS' : 'FAIL', name, info ?? ''); if (!ok) fails.push(name) }
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

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
await page.waitForSelector('canvas', { timeout: 60000 })

// 1) 默认视图 = 聚合视图；首帧
const ttff = []
for (let i = 0; i < RUNS; i++) {
  const p = await ctx.newPage()
  p.on('pageerror', (e) => { fails.push('pageerror ' + e); console.log('PAGEERROR', e) })
  await p.goto(BASE + '/admin/#/graph')
  await p.waitForFunction(() => window.__firstFrameAt > 0, null, { timeout: 60000 })
  ttff.push(await p.evaluate(() => window.__firstFrameAt - window.__t0))
  await p.close()
}

await page.goto(BASE + '/admin/#/graph')
await page.waitForFunction(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  return c && c.__mhGraph.perf.frames > 30
}, null, { timeout: 60000 })
const state = await page.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  return {
    hash: location.hash,
    clusterNodes: c.__mhGraph.nodePoints().length,
    modePressed: document.querySelector('.graph-mode-btn[aria-pressed="true"]')?.textContent || '',
    count: document.querySelector('.graph-count')?.textContent || '',
    warnNotices: document.querySelectorAll('.notice-warn').length,
    infoNotices: [...document.querySelectorAll('.notice-info')].map((n) => n.textContent.trim()),
    limitDisabled: document.querySelector('select[aria-label="最多节点数"]')?.disabled,
    perf: { ...c.__mhGraph.perf },
  }
})
const f0 = state.perf.frames
const s0 = state.perf.sum
await page.waitForTimeout(SAMPLE_MS)
const after = await page.evaluate(() => { const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); return { ...c.__mhGraph.perf } })
const frames = after.frames - f0
const avgFrameMs = frames > 0 ? (after.sum - s0) / frames : NaN
await page.screenshot({ path: `${OUT}/cluster-default.png` })

const truncRe = /仅显示关联度最高|已按所选上限/
check('默认视图是聚合视图', state.modePressed.includes('聚合'), state.modePressed)
check('默认 URL 不带 mode（自动选择）', !/mode=/.test(state.hash), state.hash)
check(`簇节点数 ≤ ${MAX_CLUSTERS}`, state.clusterNodes > 0 && state.clusterNodes <= MAX_CLUSTERS, String(state.clusterNodes))
check('聚合视图无截断提示、无 warn', state.warnNotices === 0 && !state.infoNotices.some((t) => truncRe.test(t)), state.infoNotices.join(' | '))
check('聚合视图下限下拉被禁用', state.limitDisabled === true, String(state.limitDisabled))
check('进入页面 → canvas 首帧 ≤ ' + MAX_FIRST_FRAME_MS + 'ms', median(ttff) <= MAX_FIRST_FRAME_MS, `median=${median(ttff).toFixed(1)}ms runs=${ttff.map((x) => x.toFixed(1)).join(',')}`)
check('稳定后平均帧耗时 ≤ ' + MAX_FRAME_MS + 'ms（≥50fps）', avgFrameMs <= MAX_FRAME_MS, `avg=${avgFrameMs.toFixed(2)}ms frames=${frames}`)

// 2) 点簇 → 右侧面板列出簇内卡片 + 「展开这一簇」 → 卡片视图（带 kind / tag 过滤）
const pick = await page.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  const r = c.getBoundingClientRect()
  // 视口内、避开右上缩放栏的一个簇（画布比视口高时底部的点会被挡住）
  const cand = c.__mhGraph.nodePoints().filter((q) => q.x > 80 && q.x < r.width - 120 && q.y > 40 && q.y < Math.min(r.height, window.innerHeight - r.top) - 40)
  const p = (cand.length ? cand : c.__mhGraph.nodePoints()).sort((a, b) => a.y - b.y)[0]
  return { x: r.left + p.x, y: r.top + p.y }
})
await page.mouse.click(pick.x, pick.y)
await page.waitForSelector('.graph-side-actions .btn-primary', { timeout: 10000 })
const panel = await page.evaluate(() => ({
  head: document.querySelector('.graph-side-head h3')?.textContent || '',
  cards: document.querySelectorAll('.graph-side .graph-nbrs li').length,
  btn: document.querySelector('.graph-side-actions .btn-primary')?.textContent || '',
}))
await page.screenshot({ path: `${OUT}/cluster-panel.png` })
check('点簇后右侧面板有簇名与「展开这一簇」', !!panel.head && panel.btn.includes('展开'), `${panel.head} / ${panel.btn}`)
check('面板列出簇内卡片（≤50）', panel.cards > 0 && panel.cards <= 50, String(panel.cards))

await page.click('.graph-side-actions .btn-primary')
const expanded = await (await page.waitForFunction(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  const count = document.querySelector('.graph-count')?.textContent || ''
  if (!c || !/显示/.test(count) || c.__mhGraph.perf.frames < 10) return null
  return { hash: location.hash, modePressed: document.querySelector('.graph-mode-btn[aria-pressed="true"]')?.textContent || '', nodes: c.__mhGraph.nodePoints().length, count }
}, null, { timeout: 60000 })).jsonValue()
await page.screenshot({ path: `${OUT}/cluster-expanded-cards.png` })
check('展开后进卡片视图', expanded.modePressed.includes('卡片'), expanded.modePressed)
check('展开的 URL 带 kind 或 tag 过滤', /[?&](kind|tag)=/.test(expanded.hash), expanded.hash)
check('展开后画布是卡片（节点数 > 簇数）', expanded.nodes > state.clusterNodes, `${expanded.nodes} vs ${state.clusterNodes}`)

// 3) 再点「聚合视图」按钮回到聚合视图
await page.click('.graph-mode-btn:nth-child(1)')
const back = await (await page.waitForFunction(() => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  const count = document.querySelector('.graph-count')?.textContent || ''
  if (!c || !/覆盖/.test(count) || c.__mhGraph.perf.frames < 10) return null
  return { modePressed: document.querySelector('.graph-mode-btn[aria-pressed="true"]')?.textContent || '', nodes: c.__mhGraph.nodePoints().length, count }
}, null, { timeout: 60000 })).jsonValue()
check('「聚合视图」按钮能回到聚合视图', back.modePressed.includes('聚合') && back.nodes <= MAX_CLUSTERS, `${back.modePressed} / ${back.nodes}`)

// 4) 聚合视图里搜索走全库：回车 → 卡片视图并 focus 命中卡
await page.fill('#graph-search-input', 'sqlite 回滚')
await page.press('#graph-search-input', 'Enter')
const searched = await (await page.waitForFunction(() => {
  if (!/mode=cards/.test(location.hash)) return null
  if (!/focus=/.test(location.hash)) return null
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  const count = document.querySelector('.graph-count')?.textContent || ''
  if (!c || !/显示/.test(count) || c.__mhGraph.perf.frames < 5) return null
  return { hash: location.hash, selected: c.__mhGraph.state().selected }
}, null, { timeout: 60000 })).jsonValue()
check('聚合视图搜索回车 → 卡片视图并聚焦命中卡', !!searched.selected, searched.hash)
await page.screenshot({ path: `${OUT}/cluster-search-jump.png` })

const report = { runs: RUNS, ttffMs: ttff, firstFrameMedianMs: median(ttff), avgFrameMs, frames, state, panel, expanded }
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log('REPORT', JSON.stringify({ firstFrameMedianMs: report.firstFrameMedianMs, avgFrameMs, clusters: state.clusterNodes, expandedNodes: expanded.nodes }))
console.log(fails.length ? `FAILED ${fails.length}: ${fails.join(' / ')}` : 'ALL PASS')
await browser.close()
process.exit(fails.length ? 1 : 0)
