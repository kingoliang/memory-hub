// 沉淀活跃度：按署名统计 capture / recall，“只读不写”告警。数据来自 write_log，缺口如实列出。

import { h } from '../dom.js'
import { get } from '../api.js'
import { panel, stat, notice, badge, table, dualBars, barRow, timeEl, empty, icon } from '../ui.js'
import { fmtNum } from '../format.js'

export default async function render(ctx) {
  const days = [7, 30, 90].includes(Number(ctx.params.get('days'))) ? Number(ctx.params.get('days')) : 30
  const a = await get('activity', { days })
  ctx.setTitle('沉淀活跃度')
  const alerts = a.alerts
  const maxLegacy = Math.max(1, ...a.legacy.byCardSubmitter.map((x) => x.cards))
  const tabs = h('nav', { class: 'tabs' }, [7, 30, 90].map((d) => h('a', { class: 'tab' + (d === days ? ' active' : ''), href: `#/activity?days=${d}` }, `近 ${d} 天`)))
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '沉淀活跃度'), h('p', { class: 'sub' }, '没有会话结束兜底，沉淀完全依赖 Agent 主动调用 memory_capture——这里看谁在写、谁只读不写')]),
    tabs,
    h('div', { class: 'stats' }, [
      stat('沉淀次数', a.totals.captures, { hint: `近 ${days} 天，含重复/拒绝` }),
      stat('召回次数', a.totals.recalls, { hint: `近 ${days} 天` }),
      stat('待审积压', a.pendingBacklog, { tone: a.pendingBacklog ? 'tone-warn' : '', hint: a.oldestPendingAt ? `最早 ${a.oldestPendingAt.slice(0, 10)}` : '无积压', href: '#/queue' }),
      stat('平均审批时延', a.avgApprovalHours === null ? '—' : `${a.avgApprovalHours} 小时`, { hint: 'audit_log 的 pending→approved' }),
    ]),
    alerts.length ? h('div', { class: 'alerts' }, alerts.map((x) => notice(x.level === 'warn' ? 'warn' : 'info', x.type === 'read-only' ? `只读不写：${x.agent}` : x.type === 'idle-token' ? `令牌闲置：${x.token}` : '待审积压', x.message))) : notice('ok', '没有告警', null),
    panel(`每日趋势（近 ${days} 天）`, dualBars(a.daily.map((d) => ({ label: d.date.slice(5), a: d.capture, b: d.recall })), { aLabel: '沉淀', bLabel: '召回' }), { sub: '来自 write_log（actor_type=agent）' }),
    panel('按署名统计', table([
      { label: '署名', render: (r) => h('span', { class: 'inline' }, [h('strong', null, r.name), r.tokenRevoked ? badge('已吊销', 'bad') : r.tokenExpired ? badge('已过期', 'warn') : !r.tokenKnown ? badge('无对应令牌', 'mute') : null, r.readOnlyAlert ? badge('只读不写', 'bad') : null]) },
      { label: '沉淀', cls: 'num', render: (r) => fmtNum(r.captures) },
      { label: '召回', cls: 'num', render: (r) => fmtNum(r.recalls) },
      { label: '沉淀/召回', cls: 'num', render: (r) => (r.captureRecallRatio === null ? '—' : r.captureRecallRatio) },
      { label: '结果分布（沉淀）', render: (r) => h('span', { class: 'inline' }, [r.captureOutcomes.ok ? badge(`成功 ${r.captureOutcomes.ok}`, 'ok') : null, r.captureOutcomes.dup ? badge(`重复 ${r.captureOutcomes.dup}`, 'neutral') : null, r.captureOutcomes.denied ? badge(`拒绝 ${r.captureOutcomes.denied}`, 'bad') : null, r.captureOutcomes.error ? badge(`错误 ${r.captureOutcomes.error}`, 'bad') : null, r.captures ? null : '—']) },
      { label: '最近沉淀', render: (r) => (r.lastCaptureAt ? timeEl(r.lastCaptureAt) : '从未') },
      { label: '最近召回', render: (r) => (r.lastRecallAt ? timeEl(r.lastRecallAt) : '从未') },
    ], a.agents, { emptyText: '窗口内没有 Agent 调用记录' })),
    h('div', { class: 'grid-2' }, [
      panel('历史卡片署名（含 M1 之前）', h('div', { class: 'bars' }, a.legacy.byCardSubmitter.slice(0, 10).map((x) => barRow(x.name, x.cards, maxLegacy, { tone: 'teal' }))), { sub: '按卡片 submitted_by 反推，弥补 write_log 起始较晚' }),
      panel('数据说明与缺口', h('ul', { class: 'notes' }, a.dataNotes.map((n) => h('li', null, n)))),
    ]),
  ])
}
