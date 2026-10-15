// 待审队列（pending / rejected，只读）。批准/驳回在 M3。

import { h } from '../dom.js'
import { get } from '../api.js'
import { cardRow } from './cards.js'
import { notice, pager, empty, badge } from '../ui.js'
import { fmtNum } from '../format.js'

export default async function render(ctx) {
  const status = ['pending', 'rejected', 'all'].includes(ctx.params.get('status')) ? ctx.params.get('status') : 'all'
  const offset = Number(ctx.params.get('offset')) || 0
  const limit = 20
  const d = await get('queue', { status, limit, offset })
  ctx.setTitle('待审队列')
  const tab = (key, label, n) => h('a', { class: 'tab' + (status === key ? ' active' : ''), href: `#/queue?status=${key}` }, [label, badge(fmtNum(n), key === 'pending' ? 'warn' : 'neutral')])
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '待审队列'), h('p', { class: 'sub' }, '按等待时间排序，最久的在前')]),
    notice('info', '只读视图', 'auditMode=all 时，未批准的卡不会被 memory_recall 搜到。批准 / 驳回操作将在 M3 提供；目前可用 CLI 或数据库流程处理。'),
    h('nav', { class: 'tabs' }, [tab('all', '全部', d.counts.pending + d.counts.rejected), tab('pending', '待审', d.counts.pending), tab('rejected', '已驳回', d.counts.rejected)]),
    d.items.length
      ? h('div', { class: 'card-list' }, d.items.map((it) => cardRow(it, { extra: [
        h('span', { class: 'meta-time' }, `已等待 ${it.ageDays} 天`),
        it.reason ? h('span', { class: 'meta-reason' }, `原因：${it.reason}`) : null,
      ] })))
      : empty('队列是空的', '没有待审或被驳回的卡片'),
    d.total > limit ? pager(d, (o) => ctx.go(`#/queue?status=${status}&offset=${o}`)) : null,
  ])
}
