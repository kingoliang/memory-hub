// 总览：先给"要不要我做点什么"（待审、告警），再给规模与趋势，最后是分布与最近写入。
// 信息层次：① 行动（待审 / 提醒）→ ② 核心指标（卡片总数+趋势）→ ③ 次要指标（回收站/标签/库/备份）→ ④ 分布 → ⑤ 最近写入。

import { h } from '../dom.js'
import { get } from '../api.js'
import { fmtBytes, fmtNum, kindLabel, OUTCOME_LABEL, relTime } from '../format.js'
import { panel, notice, barRow, sparkline, badge, table, timeEl, empty, icon } from '../ui.js'

/** 提醒列表：warn 在前；每条一行，左侧色条 + 图标 + 文本（颜色之外有图标与"需处理/提示"文字）。 */
function alertList(alerts) {
  const item = (a) => h('li', { class: 'alert-item alert-' + (a.level === 'warn' ? 'warn' : 'info') }, [
    icon(a.level === 'warn' ? 'warn' : 'info'),
    h('span', { class: 'alert-tag' }, a.level === 'warn' ? '需处理' : '提示'),
    h('span', { class: 'alert-msg' }, a.message),
  ])
  const warns = alerts.filter((a) => a.level === 'warn')
  const infos = alerts.filter((a) => a.level !== 'warn')
  // 需处理的常驻；提示类折叠（避免挤占首屏，仍可展开查看）
  return panel(`提醒（${alerts.length}）`, [
    warns.length ? h('ul', { class: 'alert-list' }, warns.map(item)) : null,
    infos.length ? h('details', { class: 'alert-fold', open: !warns.length }, [h('summary', null, `提示（${infos.length}）`), h('ul', { class: 'alert-list' }, infos.map(item))]) : null,
  ], { cls: 'panel-alerts', sub: warns.length ? `其中 ${warns.length} 条需要处理` : '都是提示，无需立即处理' })
}

export default async function render(ctx) {
  const o = await get('overview')
  ctx.setTitle('总览')
  const kinds = Object.entries(o.cards.byKind).sort((a, b) => b[1] - a[1])
  const maxKind = Math.max(1, ...kinds.map((k) => k[1]))
  const maxAgent = Math.max(1, ...o.agents.map((a) => a.cards))
  const last = o.vault.lastBackup
  const pending = o.quarantine.pending

  // ① 行动区：有待审时给出显眼的入口；一切正常时只给一行安心的状态
  const todo = pending
    ? h('a', { class: 'callout callout-warn', href: '#/queue' }, [
      h('span', { class: 'callout-icon' }, icon('queue')),
      h('div', { class: 'callout-text' }, [h('strong', null, `${fmtNum(pending)} 张卡等待审核`), h('span', null, `批准后其他 Agent 才能检索到${o.quarantine.rejected ? `；另有 ${fmtNum(o.quarantine.rejected)} 张已驳回` : ''}`)]),
      h('span', { class: 'callout-go' }, ['去审核', icon('arrow', 'icon-sm')]),
    ])
    : null
  const status = !o.alerts.length && !pending
    ? notice('ok', '一切正常', '没有待审卡，也没有需要处理的告警')
    : null

  const total = h('section', { class: 'kpi kpi-hero', 'aria-label': '卡片总数与近 30 天新增' }, [
    h('div', { class: 'kpi-main' }, [
      h('div', { class: 'stat-label' }, '卡片总数'),
      h('div', { class: 'kpi-value' }, fmtNum(o.cards.total)),
      h('div', { class: 'stat-hint' }, `近 7 天新增 ${fmtNum(o.cards.recent7d)}`),
      h('a', { class: 'kpi-link', href: '#/cards' }, ['浏览全部卡片', icon('arrow', 'icon-sm')]),
    ]),
    h('div', { class: 'kpi-chart' }, [h('div', { class: 'kpi-chart-title' }, ['近 30 天新增', h('span', { class: 'sub' }, '按创建日期（UTC）')]), sparkline(o.daily.map((d) => ({ label: d.date.slice(5), value: d.count })), { label: '每日新增卡片', height: 84 })]),
  ])

  const mini = (label, value, { hint, href, tone = '' } = {}) => h(href ? 'a' : 'div', { class: `kpi kpi-mini ${tone}`, ...(href ? { href } : {}) }, [
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'kpi-value kpi-value-sm' }, value),
    hint ? h('div', { class: 'stat-hint' }, hint) : null,
  ])

  return h('div', { class: 'page overview' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '总览'), h('p', { class: 'sub' }, '先看有没有要处理的事，再看规模与近期活动')]),
    todo,
    status,
    o.alerts.length ? alertList(o.alerts) : null,
    h('div', { class: 'kpi-grid' }, [
      total,
      mini('待审', fmtNum(pending), { tone: pending ? 'tone-warn' : '', hint: pending ? `已驳回 ${fmtNum(o.quarantine.rejected)}` : '队列已清空', href: '#/queue' }),
      mini('回收站', fmtNum(o.quarantine.deleted), { hint: '保留 30 天后清除', href: '#/recycle' }),
      mini('标签', fmtNum(o.cards.tags), { hint: '去重后的种类', href: '#/tags' }),
      mini('库大小', fmtBytes(o.vault.dbBytes), { hint: o.vault.walBytes ? `WAL ${fmtBytes(o.vault.walBytes)}` : '无 WAL 积压' }),
      mini('备份', last ? relTime(last.at) : '暂无', { tone: last ? '' : 'tone-warn', hint: last ? `${fmtBytes(last.bytes)} · 共 ${o.vault.backupCount} 份` : '服务运行后自动备份' }),
    ]),
    h('div', { class: 'grid-2' }, [
      panel('类型分布', kinds.length ? h('div', { class: 'bars' }, kinds.map(([k, n]) => barRow(kindLabel(k), n, maxKind, { href: `#/cards?kind=${encodeURIComponent(k)}` }))) : empty('还没有卡片', '让 Agent 调用 memory_capture 沉淀第一张卡'), { sub: '点击类型可筛选卡片' }),
      panel('署名分布', o.agents.length ? h('div', { class: 'bars' }, o.agents.slice(0, 10).map((a) => barRow(a.name, a.cards, maxAgent, { tone: 'teal', href: a.name === '(未署名)' ? '#/cards?agent=__none__' : `#/cards?agent=${encodeURIComponent(a.name)}` }))) : empty('没有署名数据'), { sub: '主库已批准卡片，按 submitted_by' }),
    ]),
    panel('最近写入记录', table([
      { label: '时间', render: (r) => timeEl(r.ts) },
      { label: '谁', render: (r) => r.actorName || r.actorType },
      { label: '动作', render: (r) => h('span', { class: 'mono-text' }, `${r.tool || '—'} · ${r.action}`) },
      { label: '结果', render: (r) => badge(OUTCOME_LABEL[r.outcome] || r.outcome, r.outcome === 'ok' ? 'ok' : r.outcome === 'dup' ? 'neutral' : 'bad') },
    ], o.recentLog, { emptyText: '还没有写入记录' }), { actions: [h('a', { class: 'btn btn-sm', href: '#/audit' }, '全部日志')], cls: 'panel-flush' }),
  ])
}
