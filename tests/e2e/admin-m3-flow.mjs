// M3 真实浏览器实测（headless Chrome + CDP，无额外依赖）：
//   登录 → 编辑卡片 → 看历史 → 回滚 → 软删 → 恢复 → 批准待审 → 驳回 → 标签合并（预览→执行）→ 整理 apply（演练→确认→结果→回滚）
//   → 创建令牌（明文弹窗一次）→ 撤销令牌；并检查：防重复提交、控制台错误 / CSP 违规数为 0、令牌明文关闭后不再出现在页面。
// 用法：node tests/e2e/admin-m3-flow.mjs <baseUrl> <口令文件> <输出目录>    （CHROME 环境变量可指定浏览器路径）
// 只应对合成数据的实例运行（见 tests/e2e/m3-synthetic-server.mjs）；口令从文件读取，不出现在命令行/输出里。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const [base, pwFile, outDir] = process.argv.slice(2)
if (!base || !pwFile || !outDir) { console.error('用法：admin-m3-flow.mjs <baseUrl> <口令文件> <输出目录>'); process.exit(2) }
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
const requests = []
let expected401 = true
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return }
  if (m.method === 'Network.requestWillBeSent') requests.push({ method: m.params.request.method, url: m.params.request.url })
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`)
  if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
  if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
    const e = m.params.entry
    const isExpected = expected401 && /401/.test(e.text) && /\/api\/(session|login)/.test(e.url || '')
    // 故意触发的冲突 / 校验类 4xx（测试用例本身要看到的错误响应）会作为资源加载日志出现，单独放行并计数
    if (!isExpected) problems.push(`log.${e.level}: ${e.text} ${e.url || ''}`)
  }
})
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 失败'); return r.result.value }
const waitFor = async (expr, label, ms = 10000) => {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await evalJs(expr).catch(() => false)) return; await sleep(100) }
  const dump = await evalJs("(document.querySelector('.modal')||document.querySelector('#view')||document.body).innerText.slice(0,400)").catch(() => '')
  throw new Error('等待超时：' + label + ' | 页面内容：' + dump + ' | 问题：' + problems.join(' ; '))
}
const shot = async (name) => {
  await sleep(350)
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(r.data, 'base64'))
  console.log('截图', name)
}
const route = async (hash, ready) => { await evalJs(`location.hash = ${JSON.stringify(hash)}`); await sleep(150); await waitFor(`!!document.querySelector('#view .page') && !document.querySelector('#view .loading')`, hash); if (ready) await waitFor(ready, hash + ' ready') }
const J = JSON.stringify
// 点击：在 scope 内找文本匹配的按钮（exact 优先，其次 includes）
const clickBtn = (text, scope = 'document') => evalJs(`(() => {
  const root = ${scope}
  const bs = [...root.querySelectorAll('button, a.btn')].filter((b) => !b.disabled)
  const b = bs.find((x) => x.textContent.trim() === ${J(text)}) || bs.find((x) => x.textContent.trim().includes(${J(text)}))
  if (!b) throw new Error('找不到可点击的按钮：' + ${J(text)} + ' | 现有：' + bs.map((x) => x.textContent.trim()).join('|'))
  b.click(); return true })()`)
const setVal = (sel, val) => evalJs(`(() => { const el = document.querySelector(${J(sel)}); if (!el) throw new Error('找不到 ' + ${J(sel)}); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${J('') } + ${J(val)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
const check = (sel, on = true) => evalJs(`(() => { const el = document.querySelector(${J(sel)}); if (!el) throw new Error('找不到 ' + ${J(sel)}); if (el.checked !== ${on}) el.click(); return true })()`)
const text = (sel) => evalJs(`(document.querySelector(${J(sel)}) || {}).textContent || ''`)
const modalOpen = `!!document.querySelector('.modal')`
const modalGone = `!document.querySelector('.modal')`
const toastHas = (t) => waitFor(`[...document.querySelectorAll('.toast')].some((e) => e.textContent.includes(${J(t)}))`, 'toast：' + t)
const results = []
const step = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(ok ? '  通过' : '  失败', name, detail) }

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable')
// CSP 违规计数器：在每个文档创建时挂监听
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI))` })
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await send('Page.navigate', { url: base.replace(/\/$/, '') + '/admin/' })
await waitFor(`!!document.querySelector('input[type=password]')`, '登录页')

// ---- 登录 ----
await evalJs(`(() => { const i = document.querySelector('input[type=password]'); i.value = ${J(password)}; document.querySelector('form').requestSubmit(); return true })()`)
await sleep(800); expected401 = false
await waitFor(`!!document.querySelector('#view .page') && !document.querySelector('#view .loading')`, '登录后外壳')
step('登录', true)

// ---- 找一张项目卡并打开详情 ----
await route('#/cards?q=' + encodeURIComponent('项目决策 3'), `document.querySelectorAll('.card-row').length > 0`)
await evalJs(`document.querySelector('.card-row .card-link').click()`)
await waitFor(`!!document.querySelector('.detail-head h1')`, '详情')
const detailHash = await evalJs('location.hash')
const originalTitle = await text('.detail-head h1')
await shot('01-card-detail-with-actions')

// ---- 编辑 ----
await clickBtn('编辑', `document.querySelector('.detail-actions')`)
await waitFor(`!!document.querySelector('.edit-form input[name=title]')`, '编辑表单')
await setVal('.edit-form input[name=title]', '【已编辑】' + originalTitle)
await setVal('.edit-form input[name=tags]', 'alpha, shared, 已编辑标签')
await setVal('.edit-form textarea[name=body]', '编辑后的正文：第一行\n\n- 要点一\n- 要点二\n\n**加粗** 与 `code`')
await shot('02-edit-form')
// 防重复提交：同一个 tick 连点两次保存，只应该产生一次 PATCH
const before = requests.filter((r) => r.method === 'PATCH' && /\/api\/card$/.test(r.url)).length
await evalJs(`(() => { const b = [...document.querySelectorAll('.edit-form button')].find((x) => x.textContent.trim() === '保存'); b.click(); b.click(); return true })()`)
await toastHas('已保存')
await sleep(300)
const patches = requests.filter((r) => r.method === 'PATCH' && /\/api\/card$/.test(r.url)).length - before
step('编辑：连点保存只发出 1 次请求（防重复提交）', patches === 1, `PATCH 请求数=${patches}`)
await waitFor(`document.querySelector('.detail-head h1').textContent.startsWith('【已编辑】')`, '标题已更新')
step('编辑：标题与正文已更新', (await text('.detail-body .md')).includes('编辑后的正文'))
await shot('03-after-edit')

// ---- 历史版本 + 回滚 ----
await waitFor(`[...document.querySelectorAll('.panel h2')].some((h) => h.textContent.includes('历史版本'))`, '历史版本面板')
await evalJs(`document.querySelector('.revisions details summary').click()`)
await shot('04-revision-history')
await clickBtn('回滚到此版本')
await waitFor(modalOpen, '回滚确认框')
await shot('05-rollback-confirm')
await clickBtn('回滚', `document.querySelector('.modal-foot')`)
await toastHas('已回滚')
await waitFor(`document.querySelector('.detail-head h1').textContent === ${J(originalTitle)}`, '标题已回滚')
step('回滚：标题恢复为编辑前，且回滚本身又留下一条历史版本', (await evalJs(`document.querySelectorAll('.revisions details').length`)) >= 2)
await shot('06-after-rollback')

// ---- 软删 / 恢复 ----
await clickBtn('软删', `document.querySelector('.detail-actions')`)
await waitFor(modalOpen, '软删确认框')
await shot('07-delete-confirm')
await clickBtn('移入回收站', `document.querySelector('.modal-foot')`)
await toastHas('已移入回收站')
await waitFor(`[...document.querySelectorAll('.detail-actions button')].some((b) => b.textContent.trim() === '恢复')`, '已删除状态')
step('软删：详情页变为回收站状态（出现"恢复/永久删除"）', true)
await shot('08-deleted')
await clickBtn('恢复', `document.querySelector('.detail-actions')`)
await toastHas('已恢复')
await waitFor(`[...document.querySelectorAll('.detail-actions button')].some((b) => b.textContent.trim() === '软删')`, '已恢复状态')
step('恢复：卡片回到记忆库', true)

// ---- 待审队列：单个批准、批量驳回 ----
await route('#/queue', `document.querySelectorAll('.card-row').length >= 3`)
const pendingBefore = await evalJs(`document.querySelectorAll('.card-row').length`)
await shot('09-queue')
await evalJs(`[...document.querySelectorAll('.card-row')].find((r) => r.textContent.includes('待审卡 0')).querySelector('.card-row-actions .btn-primary').click()`)
await waitFor(modalOpen, '批准确认框'); await shot('10-approve-confirm')
await clickBtn('批准 1 张', `document.querySelector('.modal-foot')`)
await toastHas('已批准 1 张')
await waitFor(`document.querySelectorAll('.card-row').length < ${pendingBefore}`, '队列减少')
step('批准待审：队列条数减少', true)
// 批量驳回：全选当前页 → 驳回所选
await check('.bulk-bar input[type=checkbox]')
await waitFor(`document.querySelector('.bulk-count').textContent.includes('已选')`, '已选计数')
await shot('11-queue-bulk-selected')
await clickBtn('驳回所选…', `document.querySelector('.bulk-bar')`)
await waitFor(modalOpen, '驳回对话框')
await setVal('.modal textarea[name=reason]', '合成数据：内容重复，驳回')
await shot('12-reject-dialog')
await clickBtn('驳回', `document.querySelector('.modal-foot')`)
await toastHas('已驳回')
await waitFor(modalGone, '对话框关闭')
step('批量驳回（带理由）', true)

// ---- 标签合并：预览 → 确认 → 执行 ----
await route('#/tags', `document.querySelectorAll('.tag-row').length > 0`)
await shot('13-tags')
await clickBtn('合并…', `document.querySelector('.syn')`)
await waitFor(`${modalOpen} && !!document.querySelector('.tag-preview strong')`, '标签预览')
const affected = Number(await text('.tag-preview strong'))
await shot('14-tag-merge-preview')
step('标签合并：执行前先显示影响卡数', affected > 0, `影响 ${affected} 张`)
const mergeBtnDisabled = await evalJs(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.trim() === '合并').disabled`)
step('标签合并：未勾选确认时"合并"按钮不可点', mergeBtnDisabled === true)
await check('.modal input[type=checkbox]')
await clickBtn('合并', `document.querySelector('.modal-foot')`)
await toastHas('已修改')
await waitFor(modalGone, '合并对话框关闭')
step('标签合并：执行完成并提示回滚文件', true)
await shot('15-tags-after-merge')

// ---- 整理中心：演练 → 确认 → 结果 → 回滚 ----
await route('#/tidy', `!!document.querySelector('.exec-grid')`)
await shot('16-tidy-center')
await clickBtn('演练（dry-run）')
await waitFor(`!!document.querySelector('.result-panel')`, '演练结果')
await shot('17-tidy-dryrun')
const dryRunNotice = await text('.result-panel')
step('整理演练：显示演练结果且库未改动', dryRunNotice.includes('演练结果'))
await waitFor(`[...document.querySelectorAll('.exec-grid ~ .edit-actions button')].some((b) => b.textContent.includes('确认执行') && !b.disabled)`, '确认执行可点')
await clickBtn('确认执行…')
await waitFor(modalOpen, '整理确认框')
const okDisabled = await evalJs(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.trim() === '执行整理').disabled`)
step('整理确认：未输入确认词时"执行整理"不可点', okDisabled === true)
await shot('18-tidy-confirm')
await setVal('.modal input[type=text]', '整理')
await clickBtn('执行整理', `document.querySelector('.modal-foot')`)
await toastHas('整理完成')
await waitFor(`[...document.querySelectorAll('.result-panel h2')].some((h) => h.textContent.includes('整理已完成'))`, '执行结果')
await shot('19-tidy-result')
step('整理执行：显示各批次结果、备份文件与回滚文件', (await text('.result-panel')).includes('回滚文件') && (await text('.result-panel')).includes('执行前备份'))
await clickBtn('回滚这次整理…')
await waitFor(modalOpen, '回滚确认框'); await shot('20-tidy-rollback-confirm')
await clickBtn('回滚', `document.querySelector('.modal-foot')`)
await toastHas('已回滚')
step('整理回滚：恢复被软删的卡', true)

// ---- 令牌：创建（明文弹窗）→ 撤销 ----
await route('#/tokens', `document.querySelectorAll('table tbody tr').length > 0`)
await shot('21-tokens')
await clickBtn('创建令牌')
await waitFor(modalOpen, '创建令牌对话框')
await setVal('.modal input[name=name]', 'e2e-browser-agent')
await shot('22-token-create-form')
const tokReqBefore = requests.filter((r) => r.method === 'POST' && /\/api\/tokens$/.test(r.url)).length
await evalJs(`(() => { const b = [...document.querySelectorAll('.modal-foot button')].find((x) => x.textContent.trim() === '创建'); b.click(); b.click(); return true })()`)
await waitFor(`!!document.querySelector('.token-plain')`, '明文令牌弹窗')
const tokReq = requests.filter((r) => r.method === 'POST' && /\/api\/tokens$/.test(r.url)).length - tokReqBefore
step('创建令牌：连点创建只发出 1 次请求（防重复提交）', tokReq === 1, `POST 请求数=${tokReq}`)
const plain = await evalJs(`document.querySelector('.token-plain').value`)
step('创建令牌：弹窗显示明文且提示"仅显示一次"', /^mh_/.test(plain) && (await text('.modal')).includes('仅显示一次'))
const doneDisabled = await evalJs(`[...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.trim() === '完成').disabled`)
step('创建令牌：未勾选"我已保存"时不能关闭', doneDisabled === true)
await clickBtn('复制令牌')
await sleep(300)
await shot('23-token-shown-once')
// 令牌立即可用（用 Node 直接请求 /mcp）
const mcpRes = await fetch(base.replace(/\/$/, '') + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${plain}` }, body: J({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
step('新令牌可访问 /mcp（200）', mcpRes.status === 200, `HTTP ${mcpRes.status}`)
await check('.modal input[type=checkbox]')
await clickBtn('完成', `document.querySelector('.modal-foot')`)
await waitFor(modalGone, '令牌弹窗关闭')
await waitFor(`[...document.querySelectorAll('table tbody tr')].some((r) => r.textContent.includes('e2e-browser-agent'))`, '列表出现新令牌')
const pageHasPlain = await evalJs(`document.documentElement.innerText.includes(${J(plain)}) || [...document.querySelectorAll('input,textarea')].some((i) => i.value.includes(${J(plain)}))`)
step('创建令牌：关闭弹窗后页面任何位置都不再有明文', pageHasPlain === false)
await shot('24-tokens-after-create')
await evalJs(`[...document.querySelectorAll('table tbody tr')].find((r) => r.textContent.includes('e2e-browser-agent')).querySelector('.btn-danger-ghost').click()`)
await waitFor(modalOpen, '撤销确认框'); await shot('25-revoke-confirm')
await clickBtn('撤销', `document.querySelector('.modal-foot')`)
await toastHas('已撤销')
const mcpRes2 = await fetch(base.replace(/\/$/, '') + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${plain}` }, body: J({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
step('撤销令牌：该令牌访问 /mcp 立即 401', mcpRes2.status === 401, `HTTP ${mcpRes2.status}`)
await waitFor(`[...document.querySelectorAll('table tbody tr')].some((r) => r.textContent.includes('e2e-browser-agent') && r.textContent.includes('已吊销'))`, '列表标记已吊销')
await shot('26-tokens-revoked')

// ---- 账户页 + 深色 + 手机宽度 ----
await route('#/account'); await shot('27-account')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
await route('#/cards?q=' + encodeURIComponent('项目决策 5'), `document.querySelectorAll('.card-row').length > 0`)
await evalJs(`document.querySelector('.card-row .card-link').click()`)
await waitFor(`!!document.querySelector('.detail-head h1')`, '详情(深色)')
await clickBtn('软删', `document.querySelector('.detail-actions')`)
await waitFor(modalOpen, '软删确认框(深色)'); await shot('28-delete-confirm-dark')
await clickBtn('取消', `document.querySelector('.modal-foot')`)
await waitFor(modalGone, '取消后关闭')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await route('#/queue', `document.querySelectorAll('.card-row').length >= 0`); await shot('29-queue-mobile')
await route('#/tokens', `document.querySelectorAll('table tbody tr').length > 0`); await shot('30-tokens-mobile')

// ---- 汇总 ----
const csp = await evalJs('window.__csp || []')
step('CSP 违规数为 0', csp.length === 0, J(csp))
step('控制台 / 日志 错误与警告数为 0', problems.length === 0, problems.join(' ; '))
const failed = results.filter((r) => !r.ok)
console.log(`\n步骤 ${results.length} 个，失败 ${failed.length}；控制台/日志问题 ${problems.length}；CSP 违规 ${csp.length}`)
for (const p of problems) console.log('  -', p)
ws.close(); chrome.kill(); await sleep(800)
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* 临时目录 */ }
process.exit(failed.length || problems.length || csp.length ? 1 : 0)
