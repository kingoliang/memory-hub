// 截断时「标签 / 类型过滤回服务器」的浏览器验证（playwright）：
// 默认视图截断 → 选一个只在被藏掉卡片上出现的标签 → 服务器重新取图，那批卡必须被筛出来（标签下拉里也能选到它）。
// 用法（先起 tests/e2e/graph-truncation-server.mjs，例如 6000 张卡 + 1200 张 cohort）：
//   BASE=http://127.0.0.1:7998 ADMIN_PW=... OUT=/tmp/out SHOTS=docs/screenshots/m4 PW_ROOT=/tmp/pw node tests/e2e/graph-truncation-filter-e2e.mjs
import { createRequire } from 'node:module'
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://127.0.0.1:7998'
const PW = process.env.ADMIN_PW
const OUT = process.env.OUT
const SHOTS = process.env.SHOTS || ''
const TAG = process.env.TAG || 'legacy-cohort'
if (!PW || !OUT) { console.error('需要环境变量 ADMIN_PW 与 OUT'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const require = createRequire((process.env.PW_ROOT || '.') + '/package.json')
const { chromium } = require('playwright')

const fails = []
const check = (name, ok, info) => { console.log(ok ? 'PASS' : 'FAIL', name, info ?? ''); if (!ok) fails.push(name) }
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}
/** `.graph-count` 里的「显示 N 个节点」 */
const shownNodes = (page) => page.evaluate(() => {
  const t = document.querySelector('.graph-count')?.textContent || ''
  const m = t.match(/显示\s*([\d,]+)\s*个节点/)
  return m ? Number(m[1].replace(/,/g, '')) : NaN
})
const waitFrames = (page, n = 5) => page.waitForFunction((k) => {
  const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
  return c && c.__mhGraph.perf.frames > k
}, n, { timeout: 30000 })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => { fails.push('pageerror ' + e); console.log('PAGEERROR', e) })

// 登录
await page.goto(BASE + '/admin/#/graph')
await page.waitForSelector('input[type=password]')
await page.fill('input[type=password]', PW)
await page.keyboard.press('Enter')
await page.waitForSelector('canvas', { timeout: 30000 })
await waitFrames(page, 10)

// 1) 默认视图必须处于截断状态，并且提示是信息级
const initial = await page.evaluate(() => ({
  info: [...document.querySelectorAll('.notice-info')].map((n) => n.textContent.trim()),
  warn: document.querySelectorAll('.notice-warn').length,
  count: document.querySelector('.graph-count')?.textContent || '',
}))
check('默认视图有信息级自动截断提示', initial.info.some((t) => /卡片数超过/.test(t)), initial.info.join(' | '))
check('默认视图无 .notice-warn', initial.warn === 0, String(initial.warn))
const before = await shownNodes(page)
check('默认视图按自动上限截断到 5000', before === 5000, String(before))
await shot(page, '12-truncation-before-tag-filter')

// 2) 标签下拉里必须能选到只存在于被藏卡片上的标签（来自 GET /admin/api/tags，而不是眼下的 5000 张卡）
const optCount = await page.evaluate((tag) => {
  const sel = document.querySelector('select[aria-label="按标签过滤"]')
  const opt = [...(sel?.options || [])].find((o) => o.value === tag)
  return opt ? Number((opt.textContent.match(/（(\d+)）/) || [])[1] || 0) : -1
}, TAG)
check(`标签下拉能选到被藏卡片的标签 ${TAG}`, optCount > 0, String(optCount))

// 3) 选它 → 服务器重新取图，被藏的那批卡必须回来，且渲染 / 列表 / 提示都跟着刷新
await page.selectOption('select[aria-label="按标签过滤"]', TAG)
await page.waitForFunction((tag) => {
  const sel = document.querySelector('select[aria-label="按标签过滤"]')
  const count = document.querySelector('.graph-count')?.textContent || ''
  const n = Number((count.match(/显示\s*([\d,]+)\s*个节点/) || [])[1]?.replace(/,/g, ''))
  return sel?.value === tag && Number.isFinite(n) && n < 5000
}, TAG, { timeout: 30000 })
await waitFrames(page, 10)
const after = await shownNodes(page)
check('筛选后节点数 = cohort 数（被藏卡片全部筛出）', after === optCount, `shown=${after} cohort=${optCount}`)
const afterState = await page.evaluate(() => ({
  count: document.querySelector('.graph-count')?.textContent || '',
  list: document.querySelectorAll('.graph-nodelist li').length,
  info: [...document.querySelectorAll('.notice-info')].map((n) => n.textContent.trim()),
  canvasNodes: [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)?.__mhGraph.nodePoints().length,
}))
check('画布上的节点数与计数一致', afterState.canvasNodes === after, `${afterState.canvasNodes} vs ${after}`)
check('节点列表跟着刷新', afterState.list > 0, String(afterState.list))
check('筛选后不再截断，提示消失', afterState.info.length === 0, afterState.info.join(' | '))
await shot(page, '13-truncation-tag-filter-server-side')

// 4) 清空标签：仍走服务器，回到全部节点（不会只剩子集），并重新出现截断提示
await page.selectOption('select[aria-label="按标签过滤"]', '')
await page.waitForFunction(() => {
  const count = document.querySelector('.graph-count')?.textContent || ''
  const n = Number((count.match(/显示\s*([\d,]+)\s*个节点/) || [])[1]?.replace(/,/g, ''))
  const info = [...document.querySelectorAll('.notice-info')].map((x) => x.textContent).join('')
  return n >= 5000 && /卡片数超过/.test(info)
}, null, { timeout: 30000 })
check('清空标签后回到全量并重新截断', (await shownNodes(page)) === 5000, String(await shownNodes(page)))

// 5) 图例类型过滤在截断状态下也走服务器（不再被本地筛没）
const kindBtn = await page.$('.graph-legend .graph-lg')
if (kindBtn) {
  const label = (await kindBtn.textContent() || '').trim()
  await kindBtn.click()
  await waitFrames(page, 10)
  const oneKind = await page.evaluate(() => {
    const c = [...document.querySelectorAll('canvas')].find((x) => x.__mhGraph)
    return c.__mhGraph.nodePoints().length
  })
  check('截断状态下点图例只留该类型且节点数非 0', oneKind > 0 && oneKind < 5000, `${label} → ${oneKind}`)
} else check('图例按钮存在', false)

console.log(fails.length ? `FAILED ${fails.length}: ${fails.join(' / ')}` : 'ALL PASS')
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ before, optCount, after }, null, 2))
await browser.close()
process.exit(fails.length ? 1 : 0)
