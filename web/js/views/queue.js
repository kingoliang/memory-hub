// 待审队列：批准 / 驳回（单个与批量），驳回可填理由。auditMode=all 时未批准的卡搜不到，所以批准要快。

import { h } from '../dom.js'
import { get, post } from '../api.js'
import { cardRow } from './cards.js'
import { notice, pager, empty, badge } from '../ui.js'
import { fmtNum } from '../format.js'
import { createSelection, bulkBar, reportBatch } from '../bulk.js'
import { guard, toast, errText, confirmDialog, formDialog } from '../dialogs.js'

export default async function render(ctx) {
  const status = ['pending', 'rejected', 'all'].includes(ctx.params.get('status')) ? ctx.params.get('status') : 'all'
  const offset = Number(ctx.params.get('offset')) || 0
  const limit = 20
  const d = await get('queue', { status, limit, offset })
  ctx.setTitle('待审队列')
  const sel = createSelection()
  const tab = (key, label, n) => h('a', { class: 'tab' + (status === key ? ' active' : ''), href: `#/queue?status=${key}` }, [label, badge(fmtNum(n), key === 'pending' ? 'warn' : 'neutral')])

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

  const rowActions = (it) => {
    const a = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, '批准')
    const r = it.status === 'pending' ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, '驳回…') : null
    const both = [a, r].filter(Boolean)
    a.addEventListener('click', guard(both, async () => { try { if ((await approve([it.path])) !== false) ctx.reload() } catch (e) { toast('bad', errText(e)) } }))
    r?.addEventListener('click', guard(both, async () => { try { if ((await reject([it.path])) !== false) ctx.reload() } catch (e) { toast('bad', errText(e)) } }))
    return both
  }

  const bar = bulkBar(sel, [
    { label: '批准所选', tone: 'primary', run: approve },
    { label: '驳回所选…', tone: 'danger', run: reject },
  ], { reload: ctx.reload })

  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '待审队列'), h('p', { class: 'sub' }, '按等待时间排序，最久的在前')]),
    notice('info', '批准后才能被检索到', 'auditMode=all 时，未批准的卡不会被 memory_recall 搜到。可勾选多张批量批准 / 驳回。'),
    h('nav', { class: 'tabs' }, [tab('all', '全部', d.counts.pending + d.counts.rejected), tab('pending', '待审', d.counts.pending), tab('rejected', '已驳回', d.counts.rejected)]),
    d.items.length ? bar : null,
    d.items.length
      ? h('div', { class: 'card-list' }, d.items.map((it) => cardRow(it, {
        select: sel.checkbox(it.path, it.title),
        actions: rowActions(it),
        extra: [
          h('span', { class: 'meta-time' }, `已等待 ${it.ageDays} 天`),
          it.reason ? h('span', { class: 'meta-reason' }, `原因：${it.reason}`) : null,
        ],
      })))
      : empty('队列是空的', '没有待审或被驳回的卡片'),
    d.total > limit ? pager(d, (o) => ctx.go(`#/queue?status=${status}&offset=${o}`)) : null,
  ])
}
