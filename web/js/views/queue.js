// 待审队列：批准 / 驳回（单个与批量），驳回可填理由。auditMode=all 时未批准的卡搜不到，所以批准要快。

import { h, mount } from '../dom.js'
import { get, post } from '../api.js'
import { cardRow, isWide, rememberSel } from './cards.js'
import { pager, empty, badge, kbd, pageHead, kindBadge, tagChip } from '../ui.js'
import { renderMarkdown } from '../markdown.js'
import { fmtNum, plainExcerpt } from '../format.js'
import { createSelection, bulkBar, reportBatch } from '../bulk.js'
import { guard, toast, errText, confirmDialog, formDialog } from '../dialogs.js'

export default async function render(ctx) {
  const status = ['pending', 'rejected', 'all'].includes(ctx.params.get('status')) ? ctx.params.get('status') : 'all'
  const offset = Number(ctx.params.get('offset')) || 0
  const limit = 20
  const d = await get('queue', { status, limit, offset })
  ctx.setTitle('待审队列')
  const sel = createSelection()
  const tab = (key, label, n) => h('a', { class: 'tab' + (status === key ? ' active' : ''), href: `#/queue?status=${key}`, ...(status === key ? { 'aria-current': 'page' } : {}) }, [label, badge(fmtNum(n), key === 'pending' && n ? 'warn' : 'neutral')])
  // 等待时间分级：≥14 天红、≥7 天橙（文字里始终带天数，颜色只是辅助）
  const ageChip = (days) => h('span', { class: 'age ' + (days >= 14 ? 'age-bad' : days >= 7 ? 'age-warn' : '') }, `已等待 ${days} 天`)

  const approve = async (paths) => {
    const multi = paths.length > 1
    if (!(await confirmDialog({ title: `批准 ${paths.length} 张卡？`, message: '批准后卡片进入记忆库，其他 Agent 可以通过 memory_recall 检索到。', confirmText: `批准 ${paths.length} 张` }))) return false
    const r = await post('queue/approve', { paths, ...(multi ? { confirm: true } : {}) })
    reportBatch(r, '已批准')
  }
  const reject = async (paths) => {
    let ok = false
    await formDialog({
      title: `驳回 ${paths.length} 张卡`, intro: paths.length > 1 ? `将驳回所选的 ${paths.length} 张待审卡（已是"已驳回"的会被跳过）。` : '驳回后卡片留在隔离区，不会被检索到。', submitText: `驳回 ${paths.length} 张`, danger: true,
      fields: [{ name: 'reason', label: '驳回理由（可选，会记录在状态流转里）', type: 'textarea', rows: 3, maxlength: 500 }],
      onSubmit: async (v) => { const r = await post('queue/reject', { paths, reason: v.reason, ...(paths.length > 1 ? { confirm: true } : {}) }); reportBatch(r, '已驳回'); ok = true },
    })
    if (!ok) return false
  }

  // 单张的批准 / 驳回：行内按钮（窄屏）、审阅台按钮、键盘 a / r 都走这两个函数（即上面的 approve / reject）
  const items = d.items
  const rememberNext = (it) => { const i = items.indexOf(it); rememberSel((items[i + 1] || items[i - 1])?.path || '') }
  const runApprove = async (it) => { try { if ((await approve([it.path])) !== false) { rememberNext(it); ctx.reload() } } catch (e) { toast('bad', errText(e)) } }
  const runReject = async (it) => { try { if ((await reject([it.path])) !== false) { rememberNext(it); ctx.reload() } } catch (e) { toast('bad', errText(e)) } }

  const rowActions = (it) => {
    const a = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, '批准')
    const r = it.status === 'pending' ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, '驳回…') : null
    const both = [a, r].filter(Boolean)
    a.addEventListener('click', guard(both, () => runApprove(it)))
    r?.addEventListener('click', guard(both, () => runReject(it)))
    return both
  }

  const bar = bulkBar(sel, [
    { label: '批准所选', tone: 'primary', run: approve },
    { label: '驳回所选…', tone: 'danger', run: reject },
  ], { reload: ctx.reload })

  // ---- 审阅台（右栏）：显示选中的卡；批准 / 驳回按钮与快捷键 a / r 共用 runApprove / runReject ----
  const desk = h('article', { class: 'split-pane', 'aria-label': '审阅台', 'aria-live': 'polite' })
  const cache = new Map()
  let cur = null
  let approveBtn = null
  let rejectBtn = null
  let reasonInput = null
  const drafts = new Map() // 审阅台重绘（正文加载完成）时保留已输入的驳回理由
  const runRejectInline = async (it, reason) => {
    const r = await post('queue/reject', { paths: [it.path], reason })
    reportBatch(r, '已驳回')
    rememberNext(it)
    drafts.delete(it.path)
    ctx.reload()
  }
  const renderDesk = (it, card) => {
    const aBtn = h('button', { type: 'button', class: 'btn btn-primary', 'aria-keyshortcuts': 'a' }, ['批准 ', kbd('a')])
    const rBtn = it.status === 'pending' ? h('button', { type: 'button', class: 'btn btn-danger-ghost', 'aria-keyshortcuts': 'r' }, ['驳回 ', kbd('r')]) : null
    const reasonBox = it.status === 'pending'
      ? h('textarea', { class: 'desk-reason-input', id: 'desk-reason', rows: '2', maxlength: '500', placeholder: '按 r 键聚焦，Enter 提交驳回，Esc 取消' })
      : null
    if (reasonBox) { reasonBox.value = drafts.get(it.path) || ''; reasonBox.addEventListener('input', () => drafts.set(it.path, reasonBox.value)) }
    const both = [aBtn, rBtn, reasonBox].filter(Boolean)
    const doReject = guard(both, async () => { try { await runRejectInline(it, reasonBox.value) } catch (e) { toast('bad', errText(e)) } })
    aBtn.addEventListener('click', guard(both, () => runApprove(it)))
    rBtn?.addEventListener('click', doReject)
    reasonBox?.addEventListener('keydown', (e) => {
      if (e.isComposing) return // 输入法选词中的 Enter / Esc 不处理
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doReject() } else if (e.key === 'Escape') { e.preventDefault(); reasonBox.value = ''; drafts.delete(it.path); reasonBox.blur() }
    })
    approveBtn = aBtn
    rejectBtn = rBtn
    reasonInput = reasonBox
    const body = card ? h('div', { class: 'desk-body md' }, renderMarkdown(card.body || '')) : h('p', { class: 'desk-body' }, it.excerpt ? plainExcerpt(it.excerpt) : '加载正文…')
    mount(desk, h('div', { class: 'desk' }, [
      h('div', { class: 'desk-top' }, [h('span', { class: 'lab pane-no' }, [kindBadge(it.kind), ` · ${String(items.indexOf(it) + 1 + offset).padStart(2, '0')}`]), h('span', { class: 'lab' }, it.status === 'pending' ? `已等待 ${it.ageDays} 天` : '已驳回')]),
      h('h2', null, it.title || '（无标题）'),
      body,
      it.reason ? h('p', { class: 'meta-reason' }, `原因：${it.reason}`) : null,
      h('div', { class: 'desk-meta' }, `${it.agent}${it.tags.length ? ' · ' + it.tags.join(', ') : ''}`),
      it.tags.length ? h('div', { class: 'card-row-tags' }, it.tags.slice(0, 8).map((t) => tagChip(t, `#/cards?tag=${encodeURIComponent(t)}`))) : null,
      reasonBox ? h('label', { class: 'desk-reason', for: 'desk-reason' }, [h('span', { class: 'lab' }, '驳回理由（可选，会记录在状态流转里；Shift+Enter 换行）'), reasonBox]) : null,
      h('div', { class: 'desk-actions' }, [aBtn, rBtn, h('a', { class: 'desk-more', href: `#/card?path=${encodeURIComponent(it.path)}` }, '查看全文 →')]),
    ]))
  }
  const rows = new Map()
  const pick = async (it, { remember = true } = {}) => {
    cur = it
    for (const [pth, row] of rows) { row.classList.toggle('is-selected', pth === it.path); if (pth === it.path) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current') }
    if (remember) rememberSel(it.path)
    if (!isWide()) return
    renderDesk(it, cache.get(it.path))
    if (cache.has(it.path)) return
    try {
      const card = await get('card', { path: it.path })
      cache.set(it.path, card)
      if (cur === it) renderDesk(it, card)
    } catch { /* 正文拉取失败：保留摘要，批准 / 驳回仍可用 */ }
  }
  const move = (delta) => {
    if (!items.length) return
    const i = Math.max(0, Math.min(items.length - 1, items.indexOf(cur) + delta))
    pick(items[i])
    rows.get(items[i].path)?.scrollIntoView({ block: 'nearest' })
  }

  // 键盘：j / k 上下切换，a 批准，r 聚焦行内驳回理由框（Enter 提交 / Esc 取消）。输入框 / 对话框打开 / 带修饰键时不触发；页面被换掉后自动卸载监听。
  const root = h('div', { class: 'page' }, [])
  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey); return }
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || !isWide()) return
    const t = e.target
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
    if (document.querySelector('.modal-layer .modal')) return
    if (e.key === 'j') { e.preventDefault(); move(1) } else if (e.key === 'k') { e.preventDefault(); move(-1) } else if (e.key === 'a') { if (approveBtn) { e.preventDefault(); approveBtn.click() } } else if (e.key === 'r') { if (reasonInput) { e.preventDefault(); reasonInput.focus() } }
  }
  document.addEventListener('keydown', onKey)

  const list = h('div', { class: 'card-list' }, items.map((it, i) => {
    const row = cardRow(it, {
      select: sel.checkbox(it.path, it.title),
      actions: rowActions(it),
      cls: 'queue-row',
      no: String(offset + i + 1).padStart(2, '0'),
      pick,
      extra: [
        ageChip(it.ageDays),
        it.reason ? h('span', { class: 'meta-reason' }, `原因：${it.reason}`) : null,
      ],
    })
    rows.set(it.path, row)
    return row
  }))
  const initial = items.find((it) => it.path === ctx.params.get('sel')) || items[0]
  if (initial) pick(initial, { remember: false })
  const mq = globalThis.matchMedia?.('(min-width: 1101px)')
  mq?.addEventListener?.('change', (e) => { if (e.matches && desk.isConnected && cur) pick(cur, { remember: false }) })

  const subText = items.length ? `按等待时间排序，最久的在前（最久已等待 ${Math.max(...items.map((i) => i.ageDays))} 天）。批准后才能被 memory_recall 检索到。` : '按等待时间排序，最久的在前。批准后才能被 memory_recall 检索到。'
  const children = [
    pageHead('03', 'Review', '待审队列', subText),
    h('div', { class: 'queue-toolbar' }, [
      h('nav', { class: 'tabs', 'aria-label': '队列状态' }, [tab('all', '全部', d.counts.pending + d.counts.rejected), tab('pending', '待审', d.counts.pending), tab('rejected', '已驳回', d.counts.rejected)]),
      h('div', { class: 'kbd-hints', 'aria-label': '键盘快捷键' }, [
        h('span', null, [kbd('j'), kbd('k'), ' 上下切换']),
        h('span', null, [kbd('a'), ' 批准']),
        h('span', null, [kbd('r'), ' 驳回']),
      ]),
    ]),
    items.length
      ? h('section', { class: 'split split-queue' }, [h('div', { class: 'split-list' }, [bar, list]), desk])
      : empty('队列是空的', '没有待审或被驳回的卡片，Agent 新沉淀的卡会出现在这里', h('a', { class: 'btn', href: '#/cards' }, '去看已批准的卡片'), 'ok'),
    d.total > limit ? pager(d, (o) => ctx.go(`#/queue?status=${status}&offset=${o}`)) : null,
  ]
  for (const c of children) if (c) root.appendChild(c)
  return root
}
