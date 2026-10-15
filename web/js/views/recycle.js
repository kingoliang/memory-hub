// 回收站（deleted，只读），显示剩余保留天数；快到期的在前。

import { h } from '../dom.js'
import { get } from '../api.js'
import { cardRow } from './cards.js'
import { notice, pager, empty } from '../ui.js'
import { fmtDate } from '../format.js'

export default async function render(ctx) {
  const offset = Number(ctx.params.get('offset')) || 0
  const limit = 20
  const d = await get('recycle', { limit, offset })
  ctx.setTitle('回收站')
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '回收站'), h('p', { class: 'sub' }, `共 ${d.total} 张 · 保留 ${d.retentionDays} 天后自动永久清除`)]),
    notice('info', '只读视图', '恢复与永久删除将在 M3 提供。'),
    d.items.length
      ? h('div', { class: 'card-list' }, d.items.map((it) => {
        const pct = Math.max(0, Math.min(100, Math.round((it.daysLeft / d.retentionDays) * 100)))
        const tone = it.daysLeft <= 3 ? 'bad' : it.daysLeft <= 10 ? 'warn' : 'ok'
        return cardRow(it, { extra: [
          h('span', { class: `retention retention-${tone}`, title: `到期 ${fmtDate(it.expiresAt)}` }, [
            h('span', { class: 'bar bar-' + tone }, h('i', { css: { '--w': pct + '%' } })),
            `剩余 ${it.daysLeft} 天`,
          ]),
        ] })
      }))
      : empty('回收站是空的'),
    d.total > limit ? pager(d, (o) => ctx.go(`#/recycle?offset=${o}`)) : null,
  ])
}
