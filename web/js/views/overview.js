// 总览：先给"要不要我做点什么"（待审、告警），再给规模与趋势，最后是分布与最近写入。
// 信息层次：① 行动（待审 / 提醒）→ ② 核心指标（卡片总数+趋势）→ ③ 次要指标（回收站/标签/库/备份）→ ④ 分布 → ⑤ 最近写入。

import { h } from '../dom.js'
import { get } from '../api.js'
import { fmtBytes, fmtNum, kindLabel, OUTCOME_LABEL, relTime } from '../format.js'
import { panel, notice, barRow, badge, table, timeEl, empty, icon, kbd, pageHead } from '../ui.js'

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
  // 非超级管理员：服务端不下发库大小 / 备份 / 全站写日志（vault=null），回收站、审计也没有入口
  const isAdmin = (ctx.me?.role || 'admin') === 'admin'
  const vault = o.vault
  const last = vault?.lastBackup
  const pending = o.quarantine.pending

  // ① 行动区（A1 待审大数字 + A2 提醒）：有待审时给出显眼入口；一切正常时只给一行安心的状态
  const pendingBlock = h('div', { class: 'ov-pending' }, [
    h('div', { class: 'lab' }, 'A1 · 待审 Quarantine'),
    h('div', { class: 'big-row' }, [
      h('span', { class: 'big-num' + (pending ? '' : ' zero'), 'aria-label': `${fmtNum(pending)} 张卡等待审核` }, fmtNum(pending)),
      h('span', { class: 'big-cap' }, pending ? ['张卡', h('br'), '等待审核'] : ['队列', h('br'), '已清空']),
    ]),
    h('p', { class: 'sub' }, pending ? `批准后其他 Agent 才能检索到${o.quarantine.rejected ? `；另有 ${fmtNum(o.quarantine.rejected)} 张已驳回` : ''}。` : `没有待审卡${o.quarantine.rejected ? `；另有 ${fmtNum(o.quarantine.rejected)} 张已驳回` : ''}。`),
    h('div', { class: 'ov-actions' }, [
      h('a', { class: 'btn btn-primary', href: '#/queue' }, [pending ? '去审核' : '查看队列', h('span', { 'aria-hidden': 'true' }, '→')]),
      pending ? h('span', { class: 'ov-hint' }, ['进入后 ', kbd('j'), kbd('k'), ' 切换 ', kbd('a'), ' 批准']) : null,
    ]),
  ])
  // 待审为 0：压缩成一行状态条（小号数字 + 一句说明 + 次要按钮；无告警时把"一切正常"并进同一行）。有待审 / 有告警仍走醒目样式。
  const rejectedNote = o.quarantine.rejected ? `；另有 ${fmtNum(o.quarantine.rejected)} 张已驳回` : ''
  const calmBlock = h('div', { class: 'ov-calm' + (o.alerts.length ? '' : ' ok'), role: 'status' }, [
    h('span', { class: 'lab' }, 'A1 · 待审 Quarantine'),
    h('span', { class: 'calm-num', 'aria-label': '0 张卡等待审核' }, '0'),
    h('span', { class: 'calm-text' }, [
      o.alerts.length ? '队列已清空' : [icon('ok'), h('strong', null, '一切正常 · 队列已清空')],
      h('span', { class: 'calm-sub' }, o.alerts.length ? `没有待审卡${rejectedNote}。` : `没有待审卡，也没有需要处理的告警${rejectedNote}。`),
    ]),
    h('a', { class: 'btn btn-sm', href: '#/queue' }, ['查看队列', h('span', { 'aria-hidden': 'true' }, '→')]),
  ])

  // ② 规模：编号指标格（B1…B5）
  const metric = (no, label, value, { hint, href, tone = '', unit } = {}) => h(href ? 'a' : 'div', { class: `metric ${tone}`, ...(href ? { href } : {}) }, [
    h('span', { class: 'lab' }, `${no} · ${label}`),
    h('span', { class: 'metric-value' }, unit ? [value, h('small', null, ` ${unit}`)] : value),
    hint ? h('span', { class: 'metric-hint' }, hint) : null,
  ])
  const size = vault ? fmtBytes(vault.dbBytes).split(' ') : ['—']
  const bytesParts = size.length === 2 ? size : [size[0], '']

  // ③ 近 30 天新增：柱状列（高度走 CSSOM 变量）
  const dailyMax = Math.max(1, ...o.daily.map((d) => d.count))
  const cols = h('div', { class: 'cols', role: 'img', 'aria-label': `近 30 天每日新增卡片柱状图，峰值 ${dailyMax}` }, o.daily.map((d) => h('i', { class: d.count ? '' : 'zero', title: `${d.date}：${d.count}`, css: { '--h': Math.round((d.count / dailyMax) * 100) + '%' } })))

  return h('div', { class: 'page overview' }, [
    pageHead('01', 'Overview', '总览', isAdmin ? '先看有没有要处理的事，再看规模与近期活动。' : '你能看到的范围：自己的全部卡片 + 本团队的团队卡 + 其它团队公开的卡。'),
    pending
      ? h('section', { class: 'ov-a', 'aria-label': '待办' }, [pendingBlock, o.alerts.length ? alertList(o.alerts) : null])
      : h('section', { class: 'ov-a ov-a-compact', 'aria-label': '待办' }, [calmBlock, o.alerts.length ? alertList(o.alerts) : null]),
    h('section', { class: 'metrics', 'aria-label': '规模' }, [
      metric('B1', '卡片总数', fmtNum(o.cards.total), { hint: `近 7 天新增 ${fmtNum(o.cards.recent7d)}`, href: '#/cards' }),
      isAdmin ? metric('B2', '回收站', fmtNum(o.quarantine.deleted), { hint: '保留 30 天后清除', href: '#/recycle' }) : null,
      metric('B3', '标签', fmtNum(o.cards.tags), { hint: '去重后的种类', href: '#/tags' }),
      vault ? metric('B4', '库大小', bytesParts[0], { unit: bytesParts[1], hint: vault.walBytes ? `WAL ${fmtBytes(vault.walBytes)}` : '无 WAL 积压' }) : null,
      vault ? metric('B5', '备份', last ? relTime(last.at) : '暂无', { tone: last ? '' : 'tone-warn', hint: last ? `${fmtBytes(last.bytes)} · 共 ${vault.backupCount} 份` : '服务运行后自动备份' }) : null,
    ]),
    h('section', { class: 'ov-cols' }, [
      h('div', null, [
        h('div', { class: 'sh' }, [h('h2', null, '近 30 天新增'), h('span', { class: 'lab' }, 'C1 · 按创建日期 UTC')]),
        cols,
        h('div', { class: 'lab cols-cap' }, [h('span', null, o.daily[0]?.date.slice(5) || ''), h('span', null, `峰值 ${dailyMax}`), h('span', null, o.daily[o.daily.length - 1]?.date.slice(5) || '')]),
      ]),
      h('div', null, [
        h('div', { class: 'sh' }, [h('h2', null, '类型分布'), h('span', { class: 'lab' }, 'C2 · 点击筛选卡片')]),
        kinds.length ? h('div', { class: 'bars' }, kinds.map(([k, n]) => barRow(kindLabel(k), n, maxKind, { href: `#/cards?kind=${encodeURIComponent(k)}` }))) : empty('还没有卡片', '让 Agent 调用 memory_capture 沉淀第一张卡'),
      ]),
    ]),
    h('section', { class: 'ov-cols' }, [
      h('div', null, [
        h('div', { class: 'sh' }, [h('h2', null, '署名分布'), h('span', { class: 'lab' }, 'D1 · submitted_by')]),
        o.agents.length ? h('div', { class: 'bars' }, o.agents.slice(0, 10).map((a) => barRow(a.name, a.cards, maxAgent, { href: a.name === '(未署名)' ? '#/cards?agent=__none__' : `#/cards?agent=${encodeURIComponent(a.name)}` }))) : empty('没有署名数据'),
      ]),
    ]),
    !isAdmin ? null : panel('最近写入记录', table([
      { label: '时间', render: (r) => timeEl(r.ts) },
      { label: '谁', render: (r) => r.actorName || r.actorType },
      { label: '动作', render: (r) => h('span', { class: 'mono-text' }, `${r.tool || '—'} · ${r.action}`) },
      { label: '结果', render: (r) => badge(OUTCOME_LABEL[r.outcome] || r.outcome, r.outcome === 'ok' ? 'ok' : r.outcome === 'dup' ? 'neutral' : 'bad') },
    ], o.recentLog, { emptyText: '还没有写入记录' }), { actions: [h('a', { class: 'btn btn-sm', href: '#/audit' }, '全部日志')], cls: 'panel-flush' }),
  ])
}
