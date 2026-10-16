// 图谱蜘蛛真实浏览器实测（playwright）：命中节点都在可见舞台区内、跳过动画后飞行卡清零、脚尖贴合节点、腿数随密度变化、相机跟随。
// 用法：node tests/e2e/graph-spider-e2e.mjs   环境变量：BASE（默认 http://127.0.0.1:7998）、ADMIN_PW、OUT（截图/数据目录）、PW_ROOT（含 playwright 的项目目录）
// 需要先起一个带合成数据（~480 卡、7 簇、其中 11 张含 “zxqtour”）+ LLM 测试桩的实例；不连生产、不调真实模型。
import { createRequire } from 'node:module'
import fs from 'node:fs'
const BASE = process.env.BASE || 'http://127.0.0.1:7998'
const PW = process.env.ADMIN_PW
const OUT = process.env.OUT
if (!PW || !OUT) { console.error('需要环境变量 ADMIN_PW 与 OUT'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })
const require = createRequire((process.env.PW_ROOT || '.') + '/package.json')
const { chromium } = require('playwright')
const results = {}
const fails = []
const check = (name, ok, info) => { console.log(ok ? 'PASS' : 'FAIL', name, info ?? ''); if (!ok) fails.push(name) }

async function open(browser, vp, { reduced = false, dsf = 1 } = {}) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, reducedMotion: reduced ? 'reduce' : 'no-preference' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => { fails.push('pageerror ' + e); console.log('PAGEERROR', e) })
  await page.goto(BASE + '/admin/#/graph')
  await page.waitForSelector('input[type=password]'); await page.fill('input[type=password]', PW); await page.keyboard.press('Enter')
  await page.waitForSelector('canvas', { timeout: 20000 })
  await page.waitForTimeout(5000)
  return { ctx, page }
}

const RECORDER = () => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  const g = c.__mhGraph
  const R = window.__R = { frames: [], on: false, t0: 0, plan: null, flags: {}, feetTot: 0, feetOk: 0, frameTot: 0, frameOk: 0, inspTot: 0, inspOk: 0, inBoxTot: 0, inBoxOk: 0, nodeBoxTot: 0, nodeBoxOk: 0 }
  const sp = g.spiderObj
  if (!sp.__patched) { const o = sp.startTour.bind(sp); sp.startTour = (pts, op) => { const p = o(pts, op); R.plan = window.__R.plan = p; R.t0 = performance.now(); R.on = true; return p }; sp.__patched = true }
  const loop = () => {
    const now = performance.now()
    const s = g.spider(); const v = g.view; const b = g.box
    const np = g.nodePoints()
    const bx = s.x * v.zoom + v.panX; const by = s.y * v.zoom + v.panY
    // 附近节点数（屏幕 140px 内）
    let near = 0; for (const n of np) if (Math.hypot(n.x - bx, n.y - by) <= 140) near++
    // 落地腿脚尖到最近节点中心的距离
    let ok = true; let nf = 0
    for (const f of s.feet) {
      if (f.air) continue
      const fx = f.x * v.zoom + v.panX; const fy = f.y * v.zoom + v.panY
      let bd = 1e9; for (const n of np) { const d = Math.hypot(n.x - fx, n.y - fy); if (d < bd) bd = d }
      nf++; R.feetTot++
      if (bd <= 4.5) R.feetOk++; else ok = false
    }
    if (nf) { R.frameTot++; if (ok) R.frameOk++ }
    let insp = null
    if (s.inspect) {
      const ns = g.nodeScreen(s.inspect)
      const pin = s.feet.find((f) => f.pin && !f.air)
      if (pin && ns) { const fx = pin.x * v.zoom + v.panX; const fy = pin.y * v.zoom + v.panY; const d = Math.hypot(fx - ns.x, fy - ns.y); R.inspTot++; if (d <= 3) R.inspOk++; insp = d }
      if (R.on && ns) { R.nodeBoxTot++; if (ns.x >= b.x && ns.x <= b.x + b.w && ns.y >= b.y && ns.y <= b.y + b.h) R.nodeBoxOk++ }
    }
    if (R.on) { R.inBoxTot++; if (bx >= b.x && bx <= b.x + b.w && by >= b.y && by <= b.y + b.h) R.inBoxOk++ }
    if (R.on && R.frames.length < 4000) R.frames.push({ t: now - R.t0, zoom: v.zoom, px: v.panX, py: v.panY, bx, by, mode: s.mode, legs: s.legs, near, insp, inspId: s.inspect })
    if (!R.on) { R.idle = R.idle || []; if (R.idle.length < 6000) R.idle.push({ legs: s.legs, near, bx, by, air: s.feet.filter((f) => f.air).length }) }
    if (s.legs >= 11 && near >= 40 && !R.flags.dense) R.flags.dense = { bx, by }
    if (s.legs <= 5 && near <= 6 && !R.flags.sparse) R.flags.sparse = { bx, by }
    window.__raf = requestAnimationFrame(loop)
  }
  cancelAnimationFrame(window.__raf); loop()
}
const resetRec = (page) => page.evaluate(() => { const R = window.__R; R.frames = []; R.on = false; R.plan = null; R.feetTot = R.feetOk = R.frameTot = R.frameOk = R.inspTot = R.inspOk = R.inBoxTot = R.inBoxOk = R.nodeBoxTot = R.nodeBoxOk = 0; R.idle = [] })
const flyCount = (page) => page.evaluate(() => document.querySelectorAll('.sp-fly').length)

async function search(page, tag, { shotEvery = 300, skipAt = 0, vp, clean = false }) {
  await resetRec(page)
  await page.fill('#graph-search-input', 'zxqtour')
  const t0 = Date.now()
  await page.keyboard.press('Enter')
  const shots = []; let i = 0; let skipped = false; let flyAfterSkip = null
  if (clean) await page.waitForSelector('.sp-sum-title', { timeout: 20000 })
  while (!clean && Date.now() - t0 < 14000) {
    const done = await page.evaluate(() => !!document.querySelector('.sp-sum-title'))
    const name = `${tag}-${String(i).padStart(2, '0')}.png`
    await page.screenshot({ path: `${OUT}/${name}` }); shots.push({ name, wall: Date.now() - t0 }); i++
    if (skipAt && !skipped && Date.now() - t0 > skipAt) {
      skipped = true
      await page.click('.sp-skip')
      flyAfterSkip = [await flyCount(page)]
      await page.waitForTimeout(60); flyAfterSkip.push(await flyCount(page))
      await page.waitForTimeout(300); flyAfterSkip.push(await flyCount(page))
      await page.waitForTimeout(1300); flyAfterSkip.push(await flyCount(page))
      await page.screenshot({ path: `${OUT}/${tag}-afterskip.png` })
      break
    }
    if (done) break
    await page.waitForTimeout(Math.max(0, shotEvery - 120))
  }
  await page.waitForTimeout(1800)
  await page.screenshot({ path: `${OUT}/${tag}-final.png` })
  const hitsNow = await page.evaluate(() => [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph).__mhGraph.spider().collected)
  const rec = await page.evaluate(() => {
    const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); const g = c.__mhGraph; const R = window.__R
    const plan = R.plan
    const hitIds = g.spider().collected
    const stage = c.parentElement.getBoundingClientRect(); const pr = document.querySelector('.spider-panel')?.getBoundingClientRect()
    return {
      frames: R.frames, plan: plan ? { total: plan.totalMs, scan: plan.scanMs, scaled: plan.scaled, stops: plan.stops.map((s) => ({ id: s.id, kind: s.kind, hop: s.hop, pathPx: s.pathPx, distPx: s.distPx, travelMs: s.travelMs, dwellMs: s.dwellMs, arriveMs: s.arriveMs })) } : null,
      hits: hitIds.map((id) => ({ id, scr: g.nodeScreen(id) })), box: g.box, panel: pr ? { x: pr.left - stage.left, y: pr.top - stage.top, w: pr.width, h: pr.height } : null, stage: { w: stage.width, h: stage.height },
      cam: g.camera(), view: g.view, stat: { feetTot: R.feetTot, feetOk: R.feetOk, frameTot: R.frameTot, frameOk: R.frameOk, inspTot: R.inspTot, inspOk: R.inspOk, inBoxTot: R.inBoxTot, inBoxOk: R.inBoxOk, nodeBoxTot: R.nodeBoxTot, nodeBoxOk: R.nodeBoxOk },
      hitsNow: undefined, cards: document.querySelectorAll('.sp-card').length, fly: document.querySelectorAll('.sp-fly').length, sum: !!document.querySelector('.sp-sum-title'),
    }
  })
  return { ...rec, shots, flyAfterSkip, vp }
}

function analyze(tag, r) {
  const vp = r.vp
  const underPanel = r.hits.filter((h) => h.scr && r.panel && h.scr.x >= r.panel.x && h.scr.x <= r.panel.x + r.panel.w && h.scr.y >= r.panel.y && h.scr.y <= r.panel.y + r.panel.h).length
  const outBox = r.hits.filter((h) => !h.scr || h.scr.x < r.box.x || h.scr.x > r.box.x + r.box.w || h.scr.y < r.box.y || h.scr.y > r.box.y + r.box.h).length
  check(`[${tag}] 命中节点全部在可见舞台区内（${r.hits.length} 个，面板下 ${underPanel}，区外 ${outBox}）`, r.hits.length >= 11 && outBox === 0 && underPanel === 0, JSON.stringify({ box: r.box, panel: r.panel }))
  const plan = r.plan
  const hops = plan.stops.filter((s) => s.hop); const steps = plan.stops.filter((s) => !s.hop)
  const avg = (a) => a.reduce((x, s) => x + s.pathPx, 0) / (a.reduce((x, s) => x + s.travelMs, 0) / 1000)
  // 实际总时长：第一帧到第一次进入 think
  const th = r.frames.find((f) => f.mode === 'think'); const total = th ? th.t : null
  // 转角：用世界坐标里的蜘蛛轨迹（屏幕坐标会混入相机运动：停顿时身体相对屏幕的微小漂移方向无意义）；只看位移 ≥ 0.25 屏幕像素且帧间隔 10–25ms 的相邻帧
  let worst = 0; let la = null
  for (let i = 1; i < r.frames.length && r.frames[i].t < (total || 1e9); i++) {
    const ft = r.frames[i].t - r.frames[i - 1].t; if (ft < 10 || ft > 25) continue
    const a0 = r.frames[i - 1]; const a1 = r.frames[i]
    const dx = (a1.bx - a1.px) / a1.zoom - (a0.bx - a0.px) / a0.zoom; const dy = (a1.by - a1.py) / a1.zoom - (a0.by - a0.py) / a0.zoom
    if (Math.hypot(dx, dy) * a1.zoom < 0.25) continue
    const a = Math.atan2(dy, dx); if (la !== null) { let d = Math.abs(a - la); if (d > Math.PI) d = 2 * Math.PI - d; worst = Math.max(worst, d) } la = a
  }
  const zooms = r.frames.filter((f) => f.t < (total || 1e9)).map((f) => f.zoom)
  const s = r.stat
  const sum = {
    vp, planTotalMs: Math.round(plan.total), actualTourMs: total && Math.round(total), scanMs: plan.scan, scaled: plan.scaled,
    hopMinMs: Math.round(Math.min(...hops.map((x) => x.travelMs))), hopAvgPxS: Math.round(avg(hops)), stepAvgPxS: Math.round(avg(steps)), hops: hops.length, steps: steps.length,
    dwellMs: [Math.round(Math.min(...plan.stops.map((x) => x.dwellMs))), Math.round(Math.max(...plan.stops.map((x) => x.dwellMs)))],
    maxTurnDegPerFrame_world: +(worst * 180 / Math.PI).toFixed(1),
    feetOnNodePct: +(100 * s.feetOk / Math.max(1, s.feetTot)).toFixed(2), framesAllFeetOkPct: +(100 * s.frameOk / Math.max(1, s.frameTot)).toFixed(2),
    inspectLegWithin3pxPct: +(100 * s.inspOk / Math.max(1, s.inspTot)).toFixed(2), inspectFrames: s.inspTot,
    spiderInBoxPct: +(100 * s.inBoxOk / Math.max(1, s.inBoxTot)).toFixed(2), inspectNodeInBoxPct: +(100 * s.nodeBoxOk / Math.max(1, s.nodeBoxTot)).toFixed(2),
    zoomMin: +Math.min(...zooms).toFixed(2), zoomMax: +Math.max(...zooms).toFixed(2), flyAtEnd: r.fly, cards: r.cards, summaryShown: r.sum,
  }
  results[tag] = sum
  console.log(JSON.stringify(sum))
  check(`[${tag}] 总时长 ≤ 6.5s`, total !== null && total <= 6500, `${total}`)
  check(`[${tag}] 脚尖贴合：≥95% 的帧里每个落地腿脚尖都在节点上`, sum.framesAllFeetOkPct >= 95, `${sum.framesAllFeetOkPct}%`)
  check(`[${tag}] 检查命中节点时检查腿脚尖距节点中心 ≤ 3px`, sum.inspectLegWithin3pxPct >= 95 && sum.inspectFrames > 30, `${sum.inspectLegWithin3pxPct}% / ${sum.inspectFrames}`)
  check(`[${tag}] 巡游中蜘蛛 / 检查节点在可见区内 ≥ 98%`, sum.spiderInBoxPct >= 98 && sum.inspectNodeInBoxPct >= 98, `${sum.spiderInBoxPct}% / ${sum.inspectNodeInBoxPct}%`)
  check(`[${tag}] 转角变化（世界坐标轨迹）≤ 25°/帧`, sum.maxTurnDegPerFrame_world <= 25, `${sum.maxTurnDegPerFrame_world}`)
  return sum
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const VPS = [{ width: 1500, height: 1250 }, { width: 1280, height: 800 }]
for (const vp of VPS) {
  const tag = `${vp.width}x${vp.height}`
  const { ctx, page } = await open(browser, vp)
  await page.evaluate(RECORDER)
  // 0) 装饰游走 8 秒：腿数随密度、脚尖贴合；稠密 / 稀疏处截近景
  await resetRec(page)
  await page.evaluate(() => { window.__R.flags = {} })
  const shotFlags = {}
  for (let k = 0; k < 90; k++) {
    await page.waitForTimeout(150)
    const fl = await page.evaluate(() => window.__R.flags)
    for (const key of ['dense', 'sparse']) if (fl[key] && !shotFlags[key]) {
      shotFlags[key] = true
      const p = await page.evaluate(() => { const g = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); const r = g.getBoundingClientRect(); const s = g.__mhGraph.spider(); const v = g.__mhGraph.view; return { x: r.left + s.x * v.zoom + v.panX, y: r.top + s.y * v.zoom + v.panY, legs: s.legs } })
      await page.screenshot({ path: `${OUT}/legs-${key}-${tag}.png`, clip: { x: Math.max(0, p.x - 170), y: Math.max(0, p.y - 170), width: 340, height: 340 } })
      results[`legs-${key}-${tag}`] = p
    }
  }
  const idle = await page.evaluate(() => ({ idle: window.__R.idle, stat: { feetTot: window.__R.feetTot, feetOk: window.__R.feetOk, frameTot: window.__R.frameTot, frameOk: window.__R.frameOk } }))
  const hi = idle.idle.filter((f) => f.near >= 40); const lo = idle.idle.filter((f) => f.near <= 8)
  const mean = (a) => (a.length ? +(a.reduce((x, f) => x + f.legs, 0) / a.length).toFixed(1) : null)
  results[`wander-${tag}`] = { frames: idle.idle.length, legsDense: mean(hi), nDense: hi.length, legsSparse: mean(lo), nSparse: lo.length, legsMin: Math.min(...idle.idle.map((f) => f.legs)), legsMax: Math.max(...idle.idle.map((f) => f.legs)), framesAllFeetOkPct: +(100 * idle.stat.frameOk / Math.max(1, idle.stat.frameTot)).toFixed(2) }
  console.log('wander', JSON.stringify(results[`wander-${tag}`]))
  check(`[${tag}] 游走：脚尖贴合 ≥95% 帧`, results[`wander-${tag}`].framesAllFeetOkPct >= 95)
  // 稀疏：把“最多节点数”调到 200（节点间距变大），同一位置附近的节点数随之下降
  await page.selectOption('select[aria-label="最多节点数"]', '200')
  await page.waitForTimeout(5000)
  await page.evaluate(RECORDER); await resetRec(page); await page.evaluate(() => { window.__R.flags = {} })
  let sparseShot = false
  for (let k = 0; k < 60; k++) {
    await page.waitForTimeout(150)
    if (!sparseShot) { const p = await page.evaluate(() => { const g = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); const s = g.__mhGraph.spider(); const v = g.__mhGraph.view; const r = g.getBoundingClientRect(); return { x: r.left + s.x * v.zoom + v.panX, y: r.top + s.y * v.zoom + v.panY, legs: s.legs } }); if (p.legs <= 7) { sparseShot = true; await page.screenshot({ path: `${OUT}/legs-sparse-${tag}.png`, clip: { x: Math.max(0, p.x - 170), y: Math.max(0, p.y - 170), width: 340, height: 340 } }); results[`legs-sparse-${tag}`] = p } }
  }
  const idle2 = await page.evaluate(() => window.__R.idle)
  results[`wander-sparse-${tag}`] = { legsMean: mean(idle2), legsMin: Math.min(...idle2.map((f) => f.legs)), legsMax: Math.max(...idle2.map((f) => f.legs)), nearMean: +(idle2.reduce((a, f) => a + f.near, 0) / idle2.length).toFixed(1) }
  console.log('wander-sparse', JSON.stringify(results[`wander-sparse-${tag}`]))
  check(`[${tag}] 游走：稠密图腿数 > 稀疏图（200 节点）腿数`, mean(idle.idle) > results[`wander-sparse-${tag}`].legsMean + 2, JSON.stringify({ dense: mean(idle.idle), sparse: results[`wander-sparse-${tag}`].legsMean }))
  await page.selectOption('select[aria-label="最多节点数"]', '800')
  await page.waitForTimeout(5000)
  await page.evaluate(RECORDER)
  // 1) 正常搜索：先“干净”跑一遍统计（不截图，帧间隔稳定），再带截图跑一遍（出图 / 联系表）
  const r = await search(page, `clean-${tag}`, { vp: tag, clean: true })
  analyze(tag, r)
  fs.writeFileSync(`${OUT}/data-${tag}.json`, JSON.stringify(r))
  await page.keyboard.press('Escape'); await page.waitForTimeout(1200)
  const r2 = await search(page, `s-${tag}`, { vp: tag })
  const out2 = r2.hits.filter((h) => !h.scr || h.scr.x < r2.box.x || h.scr.x > r2.box.x + r2.box.w || h.scr.y < r2.box.y || h.scr.y > r2.box.y + r2.box.h).length
  check(`[${tag}] 带截图的一遍：命中节点也全部在可见区内`, r2.hits.length >= 11 && out2 === 0)
  fs.writeFileSync(`${OUT}/data-shots-${tag}.json`, JSON.stringify(r2))
  await ctx.close()
}

// 2) 跳过动画 / 清除 / 再次搜索 / 减少动画：飞行卡不残留
{
  const { ctx, page } = await open(browser, VPS[0])
  await page.evaluate(RECORDER)
  const r = await search(page, 'skip', { vp: 'skip', skipAt: 1400, shotEvery: 200 })
  console.log('skip fly counts [即时, +60ms, +360ms, +1.6s]', r.flyAfterSkip)
  check('跳过动画后飞行卡立即清零并保持', r.flyAfterSkip && r.flyAfterSkip.every((n) => n === 0), JSON.stringify(r.flyAfterSkip))
  check('跳过后 11 张卡都在面板里且可点（可见性已还原）', r.cards >= 11)
  const hidden = await page.evaluate(() => [...document.querySelectorAll('.sp-item')].filter((li) => getComputedStyle(li).visibility === 'hidden').length)
  check('跳过后面板里没有残留 visibility:hidden 的卡', hidden === 0, String(hidden))
  results.skip = { flyAfterSkip: r.flyAfterSkip, cards: r.cards, hidden }
  // 清除：搜索中途点 ×
  await page.fill('#graph-search-input', 'zxqtour'); await page.keyboard.press('Enter'); await page.waitForTimeout(1700)
  const before = await flyCount(page)
  await page.click('button[aria-label="清除搜索"]')
  const afterClear = [await flyCount(page)]; await page.waitForTimeout(1300); afterClear.push(await flyCount(page))
  check('清除搜索后飞行卡为 0', afterClear.every((n) => n === 0), `清除前 ${before}，后 ${afterClear}`)
  // 再次搜索：飞行中再回车
  await page.fill('#graph-search-input', 'zxqtour'); await page.keyboard.press('Enter'); await page.waitForTimeout(1700)
  const b2 = await flyCount(page)
  await page.fill('#graph-search-input', 'zxqtour'); await page.keyboard.press('Enter'); await page.waitForTimeout(150)
  const a2 = await flyCount(page)
  await page.waitForTimeout(500)
  check('飞行中再次搜索不残留旧飞行卡', a2 <= 1, `之前 ${b2}，之后 ${a2}`)
  results.clear = { before, afterClear, rerun: [b2, a2] }
  // 手动操作打断跟随：巡游中滚轮缩放 → 跟随关闭、相机不再自动变化；再点按钮恢复
  await page.keyboard.press('Escape'); await page.waitForTimeout(800)
  await resetRec(page)
  await page.fill('#graph-search-input', 'zxqtour'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500)
  const cb = await page.evaluate(() => [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph).__mhGraph.camera())
  const box = await page.locator('canvas.graph-canvas').boundingBox()
  await page.mouse.move(box.x + 200, box.y + 300); await page.mouse.wheel(0, -200); await page.waitForTimeout(250)
  const c1 = await page.evaluate(() => { const g = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph).__mhGraph; return { cam: g.camera(), view: { ...g.view } } })
  await page.waitForTimeout(1500)
  const c2 = await page.evaluate(() => { const g = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph).__mhGraph; return { cam: g.camera(), view: { ...g.view } } })
  check('巡游中手动缩放 → 跟随自动关闭，之后相机不再自动改变', cb.follow === true && c1.cam.follow === false && JSON.stringify(c1.view) === JSON.stringify(c2.view), JSON.stringify({ before: cb.follow, after: c1.cam.follow, same: JSON.stringify(c1.view) === JSON.stringify(c2.view) }))
  await page.click('button[aria-label="跟随蜘蛛"]')
  const c3 = await page.evaluate(() => [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph).__mhGraph.camera())
  check('点“跟随蜘蛛”按钮可恢复跟随', c3.follow === true)
  await ctx.close()
}
{
  const { ctx, page } = await open(browser, VPS[0], { reduced: true })
  await page.evaluate(RECORDER)
  const r = await search(page, 'reduced', { vp: 'reduced', shotEvery: 400 })
  const maxFly = Math.max(...r.shots.map(() => 0), r.fly)
  const outBox = r.hits.filter((h) => h.scr && (h.scr.x < r.box.x || h.scr.x > r.box.x + r.box.w || h.scr.y < r.box.y || h.scr.y > r.box.y + r.box.h)).length
  check('减少动画：无飞行卡残留；命中节点一次性定位在可见区内', maxFly === 0 && r.cards >= 11 && r.hits.length >= 11 && outBox === 0, JSON.stringify({ fly: r.fly, cards: r.cards, hits: r.hits.length, outBox }))
  await ctx.close()
}
// 3) 近景截图（dsf=2）：脚踩节点
{
  const { ctx, page } = await open(browser, VPS[0], { dsf: 2 })
  await page.evaluate(RECORDER)
  await resetRec(page)
  await page.fill('#graph-search-input', 'zxqtour'); await page.keyboard.press('Enter')
  let n = 0
  for (let k = 0; k < 80 && n < 4; k++) {
    await page.waitForTimeout(120)
    const p = await page.evaluate(() => { const g = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); const r = g.getBoundingClientRect(); const G = g.__mhGraph; const s = G.spider(); if (!s.inspect) return null; const ns = G.nodeScreen(s.inspect); return { x: r.left + ns.x, y: r.top + ns.y, id: s.inspect } })
    if (p) { await page.waitForTimeout(90); const q = await page.evaluate((id) => { const g = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph); const r = g.getBoundingClientRect(); const ns = g.__mhGraph.nodeScreen(id); return { x: r.left + ns.x, y: r.top + ns.y } }, p.id); await page.screenshot({ path: `${OUT}/closeup-inspect-${n}.png`, clip: { x: Math.max(0, q.x - 130), y: Math.max(0, q.y - 130), width: 260, height: 260 } }); n++; await page.waitForTimeout(500) }
  }
  await ctx.close()
}
await browser.close()
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1))
console.log(fails.length ? `FAILED: ${fails.length}\n${fails.join('\n')}` : 'ALL PASS')
process.exit(fails.length ? 1 : 0)
