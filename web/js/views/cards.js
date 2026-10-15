// 卡片列表 + 全文检索 + 过滤 + 排序（过滤条件全部放在 URL 哈希里，可分享、可回退）。

import { h, mount } from '../dom.js'
import { get } from '../api.js'
import { kindLabel, statusLabel, fmtNum } from '../format.js'
import { panel, kindBadge, statusBadge, secretBadge, tagChip, pager, empty, badge, timeEl, cardLink, icon } from '../ui.js'

const SORT_LABEL = { updated: '最近更新', created: '创建时间', title: '标题（拼音）', path: '路径', score: '匹配度' }

/** 一行卡片（列表/待审/回收站共用）。extra：额外的元信息节点数组。 */
export function cardRow(it, { extra = [], showScore = false } = {}) {
  return h('article', { class: 'card-row' }, [
    h('div', { class: 'card-row-main' }, [
      h('div', { class: 'card-row-title' }, [cardLink(it.path, it.title || '（无标题）'), showScore && it.score !== undefined ? badge(`匹配 ${it.score}`, 'accent') : null]),
      h('div', { class: 'card-row-meta' }, [
        kindBadge(it.kind),
        it.status !== 'approved' ? statusBadge(it.status) : null,
        secretBadge(it.secretTypes),
        h('span', { class: 'meta-agent', title: it.agentFromSource ? '无署名，显示来源 source' : '署名' }, [icon('key', 'icon-sm'), it.agent, it.agentFromSource ? h('em', null, '（来源）') : null]),
        h('span', { class: 'meta-time' }, ['更新 ', timeEl(it.updatedAt)]),
        ...extra,
      ]),
      it.excerpt ? h('p', { class: 'card-row-excerpt' }, it.excerpt) : null,
      it.tags.length ? h('div', { class: 'card-row-tags' }, it.tags.slice(0, 8).map((t) => tagChip(t, `#/cards?tag=${encodeURIComponent(t)}`))) : null,
    ]),
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
  const form = h('form', { class: 'filters', on: { submit: (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    go(Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v).trim()])))
  } } }, [
    h('div', { class: 'search-box' }, [icon('search'), inp('q', { type: 'search', placeholder: '检索 路径 / 标题 / 正文，例如：数据库选型', 'aria-label': '全文检索' }), h('button', { class: 'btn btn-primary', type: 'submit' }, '检索')]),
    h('div', { class: 'filter-grid' }, [
      h('label', null, ['状态', sel('status', [['approved', '已批准'], ['pending', '待审'], ['rejected', '已驳回'], ['deleted', '回收站'], ['all', '全部']], st.status)]),
      h('label', null, ['类型', sel('kind', [['', '全部类型'], ...facets.kinds.map((k) => [k.kind, `${kindLabel(k.kind)}（${k.count}）`])], st.kind)]),
      h('label', null, ['署名', sel('agent', [['', '全部署名'], ...facets.agents.map((a) => [a.value, `${a.name}（${a.count}）`])], st.agent)]),
      h('label', null, ['标签（逗号分隔，需同时包含）', inp('tag', { placeholder: '如 alpha, shared', list: 'tag-options' })]),
      h('label', null, ['创建自', inp('createdFrom', { type: 'date' })]),
      h('label', null, ['创建至', inp('createdTo', { type: 'date' })]),
      h('label', null, ['排序', sel('sort', [['', '默认'], ...Object.entries(SORT_LABEL).filter(([k]) => k !== 'score' || st.q).map(([k, l]) => [k, l])], st.sort)]),
      h('label', null, ['顺序', sel('order', [['desc', '降序'], ['asc', '升序']], st.order)]),
    ]),
    h('datalist', { id: 'tag-options' }, facets.tags.slice(0, 60).map((t) => h('option', { value: t.tag }))),
    h('div', { class: 'filter-actions' }, [
      h('button', { class: 'btn btn-primary', type: 'submit' }, '应用'),
      h('a', { class: 'btn btn-ghost', href: '#/cards' }, '重置'),
    ]),
  ])

  const active = []
  if (st.q) active.push(`检索「${st.q}」`)
  if (st.status !== 'approved') active.push(statusLabel(st.status))
  if (st.kind) active.push(kindLabel(st.kind))
  if (st.tag) active.push(`标签 ${st.tag}`)
  if (st.agent) active.push(`署名 ${facets.agents.find((a) => a.value === st.agent)?.name || st.agent}`)

  const list = data.items.length
    ? h('div', { class: 'card-list' }, data.items.map((it) => cardRow(it, { showScore: !!st.q })))
    : empty('没有符合条件的卡片', '换个关键词，或放宽过滤条件')

  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '卡片'), h('p', { class: 'sub' }, `共 ${fmtNum(data.total)} 张${active.length ? ' · ' + active.join(' · ') : ''}`)]),
    panel(null, form, { cls: 'panel-filters' }),
    list,
    data.total > limit ? pager(data, (offset) => go({ offset })) : null,
  ])
}
