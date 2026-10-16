// 卡片列表 + 全文检索 + 过滤 + 排序（过滤条件全部放在 URL 哈希里，可分享、可回退）。

import { h, mount } from '../dom.js'
import { get, post } from '../api.js'
import { kindLabel, statusLabel, fmtNum } from '../format.js'
import { createSelection, bulkBar, reportBatch } from '../bulk.js'
import { confirmDialog, formDialog } from '../dialogs.js'
import { panel, kindBadge, statusBadge, secretBadge, tagChip, pager, empty, badge, timeEl, cardLink, icon, segmented, filterChip } from '../ui.js'

const SORT_LABEL = { updated: '最近更新', created: '创建时间', title: '标题（拼音）', path: '路径', score: '匹配度' }

/** 一行卡片（列表/待审/回收站共用）。extra：额外的元信息节点数组；cls：附加类名；excerptLines：摘要显示行数（默认 2）。
 *  整行可点：.card-link 的 ::after 铺满整行（见 styles.css），勾选框 / 标签 / 按钮在其上方，互不抢点击。 */
export function cardRow(it, { extra = [], showScore = false, select = null, actions = null, cls = '', excerptLines = 2 } = {}) {
  return h('article', { class: `card-row k-${it.kind}` + (select ? ' has-select' : '') + (cls ? ' ' + cls : '') }, [
    select ? h('div', { class: 'card-row-select' }, select) : null,
    h('div', { class: 'card-row-main' }, [
      h('div', { class: 'card-row-title' }, [cardLink(it.path, it.title || '（无标题）'), showScore && it.score !== undefined ? badge(`匹配 ${it.score}`, 'accent') : null]),
      it.excerpt ? h('p', { class: 'card-row-excerpt' + (excerptLines > 2 ? ' clamp-' + Math.min(excerptLines, 5) : '') }, it.excerpt) : null,
      h('div', { class: 'card-row-meta' }, [
        kindBadge(it.kind),
        it.status !== 'approved' ? statusBadge(it.status) : null,
        secretBadge(it.secretTypes),
        h('span', { class: 'meta-agent', title: it.agentFromSource ? '无署名，显示来源 source' : '署名' }, [icon('key', 'icon-sm'), it.agent, it.agentFromSource ? h('em', null, '（来源）') : null]),
        h('span', { class: 'meta-time' }, ['更新 ', timeEl(it.updatedAt)]),
        ...extra,
      ]),
      it.tags.length ? h('div', { class: 'card-row-tags' }, it.tags.slice(0, 8).map((t) => tagChip(t, `#/cards?tag=${encodeURIComponent(t)}`))) : null,
    ]),
    actions ? h('div', { class: 'card-row-actions' }, actions) : null,
  ])
}

export default async function render(ctx) {
  const p = ctx.params
  const st = {
    q: p.get('q') || '', status: p.get('status') || 'approved', kind: p.get('kind') || '', tag: p.get('tag') || '', agent: p.get('agent') || '',
    createdFrom: p.get('createdFrom') || '', createdTo: p.get('createdTo') || '', sort: p.get('sort') || '', order: p.get('order') || 'desc',
    offset: Number(p.get('offset')) || 0,
  }
  const limit = 20
  const [facets, data] = await Promise.all([
    get('facets'),
    get('cards', { ...st, tag: st.tag, limit, offset: st.offset }),
  ])
  ctx.setTitle('卡片')

  const go = (patch) => {
    const next = { ...st, offset: 0, ...patch }
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(next)) if (v !== '' && v !== 0 && !(k === 'status' && v === 'approved') && !(k === 'order' && v === 'desc')) qs.set(k, String(v))
    ctx.go('#/cards' + (qs.toString() ? '?' + qs : ''))
  }

  const inp = (name, attrs = {}) => h('input', { name, value: st[name], autocomplete: 'off', ...attrs })
  const sel = (name, options, cur) => h('select', { name }, options.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)))
  const statusCount = Object.fromEntries((facets.statuses || []).map((x) => [x.status, x.count]))
  const hasMore = !!(st.agent || st.tag || st.createdFrom || st.createdTo)
  const moreCount = [st.agent, st.tag, st.createdFrom, st.createdTo].filter(Boolean).length
  const form = h('form', { class: 'filters', on: { submit: (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    go(Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v).trim()])))
  } } }, [
    h('div', { class: 'search-box' }, [icon('search'), inp('q', { type: 'search', placeholder: '检索 路径 / 标题 / 正文，例如：数据库选型', 'aria-label': '全文检索' }), h('button', { class: 'btn btn-primary', type: 'submit' }, '检索')]),
    h('div', { class: 'filter-bar' }, [
      // 状态是最常用的切换：做成分段按钮，选中即应用；其余筛选仍走"应用"
      segmented('status', [['approved', '已批准', statusCount.approved], ['pending', '待审', statusCount.pending], ['rejected', '已驳回', statusCount.rejected], ['deleted', '回收站', statusCount.deleted], ['all', '全部']], st.status, { label: '状态', onChange: () => form.requestSubmit() }),
    ]),
    h('div', { class: 'filter-grid' }, [
      h('label', null, ['类型', sel('kind', [['', '全部类型'], ...facets.kinds.map((k) => [k.kind, `${kindLabel(k.kind)}（${k.count}）`])], st.kind)]),
      h('label', null, ['排序', sel('sort', [['', '默认'], ...Object.entries(SORT_LABEL).filter(([k]) => k !== 'score' || st.q).map(([k, l]) => [k, l])], st.sort)]),
      h('label', null, ['顺序', sel('order', [['desc', '降序'], ['asc', '升序']], st.order)]),
    ]),
    h('details', { class: 'filters-more', open: hasMore }, [
      h('summary', null, [icon('sliders', 'icon-sm'), '更多筛选', moreCount ? badge(String(moreCount), 'accent') : null]),
      h('div', { class: 'filter-grid' }, [
        h('label', null, ['署名', sel('agent', [['', '全部署名'], ...facets.agents.map((a) => [a.value, `${a.name}（${a.count}）`])], st.agent)]),
        h('label', null, ['标签（逗号分隔，需同时包含）', inp('tag', { placeholder: '如 alpha, shared', list: 'tag-options' })]),
        h('label', null, ['创建自', inp('createdFrom', { type: 'date' })]),
        h('label', null, ['创建至', inp('createdTo', { type: 'date' })]),
      ]),
    ]),
    h('datalist', { id: 'tag-options' }, facets.tags.slice(0, 60).map((t) => h('option', { value: t.tag }))),
    h('div', { class: 'filter-actions' }, [
      h('button', { class: 'btn btn-primary', type: 'submit' }, '应用'),
      h('a', { class: 'btn btn-ghost', href: '#/cards' }, '重置'),
    ]),
  ])

  // 已生效的筛选：每个都是"移除该条件"的链接
  const hrefWith = (patch) => {
    const next = { ...st, offset: 0, ...patch }
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(next)) if (v !== '' && v !== 0 && !(k === 'status' && v === 'approved') && !(k === 'order' && v === 'desc')) qs.set(k, String(v))
    return '#/cards' + (qs.toString() ? '?' + qs : '')
  }
  const active = []
  if (st.q) active.push(filterChip(`检索「${st.q}」`, hrefWith({ q: '', sort: st.sort === 'score' ? '' : st.sort })))
  if (st.status !== 'approved') active.push(filterChip(statusLabel(st.status), hrefWith({ status: 'approved' })))
  if (st.kind) active.push(filterChip(kindLabel(st.kind), hrefWith({ kind: '' })))
  if (st.tag) active.push(filterChip(`标签 ${st.tag}`, hrefWith({ tag: '' })))
  if (st.agent) active.push(filterChip(`署名 ${facets.agents.find((a) => a.value === st.agent)?.name || st.agent}`, hrefWith({ agent: '' })))
  if (st.createdFrom) active.push(filterChip(`创建自 ${st.createdFrom}`, hrefWith({ createdFrom: '' })))
  if (st.createdTo) active.push(filterChip(`创建至 ${st.createdTo}`, hrefWith({ createdTo: '' })))

  // 批量操作：按当前状态过滤出合适的动作（软删 / 恢复 / 批准 / 驳回）；"全部"状态不提供批量
  const selection = createSelection()
  const bulkDefs = {
    approved: [{ label: '软删所选', tone: 'danger', run: async (paths) => {
      if (!(await confirmDialog({ title: `把 ${paths.length} 张卡移入回收站？`, message: '这些卡将不再被检索到，30 天内可在回收站恢复。', confirmText: `软删 ${paths.length} 张`, danger: true }))) return false
      reportBatch(await post('cards/batch', { action: 'delete', paths, confirm: true }), '已软删')
    } }],
    deleted: [{ label: '恢复所选', tone: 'primary', run: async (paths) => {
      if (!(await confirmDialog({ title: `恢复 ${paths.length} 张卡？`, confirmText: `恢复 ${paths.length} 张` }))) return false
      reportBatch(await post('cards/batch', { action: 'restore', paths, confirm: true }), '已恢复')
    } }],
    pending: [
      { label: '批准所选', tone: 'primary', run: async (paths) => {
        if (!(await confirmDialog({ title: `批准 ${paths.length} 张卡？`, message: '批准后其他 Agent 可以检索到。', confirmText: `批准 ${paths.length} 张` }))) return false
        reportBatch(await post('queue/approve', { paths, ...(paths.length > 1 ? { confirm: true } : {}) }), '已批准')
      } },
      { label: '驳回所选…', tone: 'danger', run: async (paths) => {
        let ok = false
        await formDialog({ title: `驳回 ${paths.length} 张卡`, submitText: `驳回 ${paths.length} 张`, danger: true, fields: [{ name: 'reason', label: '驳回理由（可选）', type: 'textarea', rows: 3, maxlength: 500 }],
          onSubmit: async (v) => { reportBatch(await post('queue/reject', { paths, reason: v.reason, ...(paths.length > 1 ? { confirm: true } : {}) }), '已驳回'); ok = true } })
        if (!ok) return false
      } },
    ],
  }
  const bulkActions = bulkDefs[st.status]
  const bar = bulkActions && data.items.length ? bulkBar(selection, bulkActions, { reload: ctx.reload }) : null
  const list = data.items.length
    ? h('div', { class: 'card-list' }, data.items.map((it) => cardRow(it, { showScore: !!st.q, select: bulkActions ? selection.checkbox(it.path, it.title) : null })))
    : empty('没有符合条件的卡片', '换个关键词，或放宽过滤条件', active.length ? h('a', { class: 'btn', href: '#/cards' }, '清除全部筛选') : null)

  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '卡片'), h('p', { class: 'sub' }, `共 ${fmtNum(data.total)} 张`)]),
    panel(null, form, { cls: 'panel-filters' }),
    active.length ? h('div', { class: 'active-filters', 'aria-label': '已生效的筛选' }, [h('span', { class: 'sub' }, '已筛选：'), ...active]) : null,
    bar,
    list,
    data.total > limit ? pager(data, (offset) => go({ offset })) : null,
  ])
}
