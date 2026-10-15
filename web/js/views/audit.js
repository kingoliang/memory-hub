// 审计日志（write_log）：按署名 / 工具 / 结果过滤。

import { h } from '../dom.js'
import { get } from '../api.js'
import { panel, table, badge, pager, icon } from '../ui.js'
import { fmtDate, OUTCOME_LABEL } from '../format.js'

export default async function render(ctx) {
  const p = ctx.params
  const st = { actor: p.get('actor') || '', tool: p.get('tool') || '', outcome: p.get('outcome') || '', actorType: p.get('actorType') || '', offset: Number(p.get('offset')) || 0 }
  const limit = 50
  const d = await get('write-log', { ...st, limit })
  ctx.setTitle('审计日志')
  const go = (patch) => {
    const next = { ...st, offset: 0, ...patch }
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(next)) if (v) qs.set(k, String(v))
    ctx.go('#/audit' + (qs.toString() ? '?' + qs : ''))
  }
  const sel = (name, opts) => h('select', { name }, opts.map(([v, l]) => h('option', { value: v, selected: v === st[name] }, l)))
  const form = h('form', { class: 'filters filters-row', on: { submit: (e) => { e.preventDefault(); go(Object.fromEntries([...new FormData(e.target).entries()].map(([k, v]) => [k, String(v).trim()]))) } } }, [
    h('label', null, ['署名', h('input', { name: 'actor', value: st.actor, placeholder: '令牌名' })]),
    h('label', null, ['工具', h('input', { name: 'tool', value: st.tool, placeholder: 'memory_capture' })]),
    h('label', null, ['类型', sel('actorType', [['', '全部'], ['agent', 'Agent'], ['admin', '管理员'], ['cli', 'CLI'], ['system', '系统']])]),
    h('label', null, ['结果', sel('outcome', [['', '全部'], ['ok', '成功'], ['dup', '重复'], ['denied', '拒绝'], ['error', '错误']])]),
    h('button', { class: 'btn btn-primary', type: 'submit' }, '过滤'),
    h('a', { class: 'btn btn-ghost', href: '#/audit' }, '重置'),
  ])
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '审计日志'), h('p', { class: 'sub' }, `共 ${d.total} 条 · 不记录正文与令牌`)]),
    panel(null, form, { cls: 'panel-filters' }),
    table([
      { label: '时间', render: (r) => fmtDate(r.ts) },
      { label: '类型', render: (r) => r.actorType },
      { label: '谁', render: (r) => r.actorName || '—' },
      { label: '工具', render: (r) => r.tool || '—' },
      { label: '动作', render: (r) => r.action || '—' },
      { label: '卡片', render: (r) => (r.cardPath ? h('a', { class: 'card-link', href: `#/card?path=${encodeURIComponent(r.cardPath)}` }, r.cardPath) : '—') },
      { label: '结果', render: (r) => badge(OUTCOME_LABEL[r.outcome] || r.outcome, r.outcome === 'ok' ? 'ok' : r.outcome === 'dup' ? 'neutral' : 'bad') },
      { label: 'IP', render: (r) => r.ip || '—' },
    ], d.items, { emptyText: '没有符合条件的日志' }),
    d.total > limit ? pager(d, (offset) => go({ offset })) : null,
  ])
}
