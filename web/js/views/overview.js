// 总览：库规模、待审/回收站、近 30 天新增、kind 与署名分布、告警、最近写入、备份状态。

import { h } from '../dom.js'
import { get } from '../api.js'
import { fmtBytes, fmtNum, kindLabel, fmtDate, OUTCOME_LABEL, relTime } from '../format.js'
import { panel, stat, notice, barRow, sparkline, badge, table, timeEl, empty } from '../ui.js'

export default async function render(ctx) {
  const o = await get('overview')
  ctx.setTitle('总览')
  const kinds = Object.entries(o.cards.byKind).sort((a, b) => b[1] - a[1])
  const maxKind = Math.max(1, ...kinds.map((k) => k[1]))
  const maxAgent = Math.max(1, ...o.agents.map((a) => a.cards))
  const last = o.vault.lastBackup
  const alerts = o.alerts.length
    ? h('div', { class: 'alerts' }, o.alerts.map((a) => notice(a.level === 'warn' ? 'warn' : 'info', null, a.message)))
    : notice('ok', '一切正常', '没有需要处理的告警')

  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '总览'), h('p', { class: 'sub' }, '记忆库规模、审核积压与近期活动')]),
    h('div', { class: 'stats' }, [
      stat('卡片总数', o.cards.total, { hint: `近 7 天新增 ${fmtNum(o.cards.recent7d)}`, href: '#/cards' }),
      stat('待审', o.quarantine.pending, { tone: o.quarantine.pending ? 'tone-warn' : '', hint: `已驳回 ${o.quarantine.rejected}`, href: '#/queue' }),
      stat('回收站', o.quarantine.deleted, { hint: '保留 30 天后清除', href: '#/recycle' }),
      stat('标签', o.cards.tags, { hint: '去重后的种类', href: '#/tags' }),
      stat('库大小', fmtBytes(o.vault.dbBytes), { hint: o.vault.walBytes ? `WAL ${fmtBytes(o.vault.walBytes)}` : '无 WAL 积压' }),
      stat('备份', last ? relTime(last.at) : '暂无', { tone: last ? '' : 'tone-warn', hint: last ? `${fmtBytes(last.bytes)} · 共 ${o.vault.backupCount} 份` : '服务运行后自动备份' }),
    ]),
    alerts,
    h('div', { class: 'grid-2' }, [
      panel('近 30 天新增', sparkline(o.daily.map((d) => ({ label: d.date.slice(5), value: d.count })), { label: '每日新增卡片' }), { sub: '按创建日期（UTC）' }),
      panel('类型分布', kinds.length ? h('div', { class: 'bars' }, kinds.map(([k, n]) => barRow(kindLabel(k), n, maxKind, { href: `#/cards?kind=${encodeURIComponent(k)}` }))) : empty('还没有卡片')),
    ]),
    h('div', { class: 'grid-2' }, [
      panel('署名分布', o.agents.length ? h('div', { class: 'bars' }, o.agents.slice(0, 10).map((a) => barRow(a.name, a.cards, maxAgent, { tone: 'teal', href: a.name === '(未署名)' ? '#/cards?agent=__none__' : `#/cards?agent=${encodeURIComponent(a.name)}` }))) : empty('没有署名数据'), { sub: '主库已批准卡片，按 submitted_by' }),
      panel('最近写入记录', table([
        { label: '时间', render: (r) => timeEl(r.ts) },
        { label: '谁', render: (r) => r.actorName || r.actorType },
        { label: '动作', render: (r) => `${r.tool || '—'} · ${r.action}` },
        { label: '结果', render: (r) => badge(OUTCOME_LABEL[r.outcome] || r.outcome, r.outcome === 'ok' ? 'ok' : r.outcome === 'dup' ? 'neutral' : 'bad') },
      ], o.recentLog, { emptyText: '还没有写入记录' }), { actions: [h('a', { class: 'btn btn-ghost', href: '#/audit' }, '全部日志')] }),
    ]),
  ])
}
