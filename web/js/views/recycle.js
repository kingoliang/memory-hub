// 回收站：恢复（单个 / 批量）；显示剩余保留天数，快到期的在前。永久删除在卡片详情里（要输入标题确认）。

import { h } from '../dom.js'
import { get, post } from '../api.js'
import { cardRow } from './cards.js'
import { notice, pager, empty, pageHead, secHead } from '../ui.js'
import { fmtDate } from '../format.js'
import { createSelection, bulkBar, reportBatch } from '../bulk.js'
import { guard, toast, errText, confirmDialog } from '../dialogs.js'

export default async function render(ctx) {
  const offset = Number(ctx.params.get('offset')) || 0
  const limit = 20
  const d = await get('recycle', { limit, offset })
  ctx.setTitle('回收站')
  const sel = createSelection()

  const restore = async (paths) => {
    if (!(await confirmDialog({ title: `恢复 ${paths.length} 张卡？`, message: '恢复后卡片回到记忆库，会重新被检索到。', confirmText: `恢复 ${paths.length} 张` }))) return false
    const r = await post('cards/batch', { action: 'restore', paths, confirm: true })
    reportBatch(r, '已恢复')
  }
  const bar = bulkBar(sel, [{ label: '恢复所选', tone: 'primary', run: restore }], { reload: ctx.reload })
  const rowRestore = (it) => {
    const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, '恢复')
    b.addEventListener('click', guard(b, async () => {
      try { const r = await post('card/restore', { path: it.path }); void r; toast('ok', '已恢复'); ctx.reload() } catch (e) { toast('bad', errText(e)) }
    }))
    return b
  }

  return h('div', { class: 'page' }, [
    pageHead('04', 'Recycle', '回收站', `共 ${d.total} 张 · 保留 ${d.retentionDays} 天后自动永久清除`),
    h('div', { class: 'g12' }, [
      h('section', { class: 'c12' }, [secHead('A1', '保留规则'), notice('info', '软删的卡可以恢复', '永久删除需要进入卡片详情页，输入卡片标题确认。')]),
      h('section', { class: 'c12' }, [secHead('A2', '待恢复的卡片', `${d.total} 张`), d.items.length ? bar : null, d.items.length
      ? h('div', { class: 'card-list' }, d.items.map((it) => {
        const pct = Math.max(0, Math.min(100, Math.round((it.daysLeft / d.retentionDays) * 100)))
        const tone = it.daysLeft <= 3 ? 'bad' : it.daysLeft <= 10 ? 'warn' : 'ok'
        return cardRow(it, {
          select: sel.checkbox(it.path, it.title),
          actions: rowRestore(it),
          extra: [
            h('span', { class: `retention retention-${tone}`, title: `到期 ${fmtDate(it.expiresAt)}` }, [
              h('span', { class: 'bar bar-' + tone }, h('i', { css: { '--w': pct + '%' } })),
              `剩余 ${it.daysLeft} 天`,
            ]),
          ],
        })
      }))
      : empty('回收站是空的', '软删的卡会在这里保留一段时间，之后自动永久清除', h('a', { class: 'btn', href: '#/cards' }, '返回卡片'), 'trash'),
      d.total > limit ? pager(d, (o) => ctx.go(`#/recycle?offset=${o}`)) : null]),
    ]),
  ])
}
