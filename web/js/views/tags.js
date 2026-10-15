// 标签统计：按频次，疑似同义（大小写/空格/连字符变体）与一次性标签提示。只读。

import { h } from '../dom.js'
import { get } from '../api.js'
import { panel, notice, empty, badge, icon } from '../ui.js'
import { fmtNum } from '../format.js'

export default async function render(ctx) {
  const q = ctx.params.get('q') || ''
  const only = ctx.params.get('only') || ''
  const d = await get('tags', { q, limit: 400 })
  ctx.setTitle('标签')
  const max = Math.max(1, ...d.items.map((t) => t.count))
  const items = only === 'singleton' ? d.items.filter((t) => t.singleton) : d.items
  const form = h('form', { class: 'inline-form', on: { submit: (e) => { e.preventDefault(); ctx.go(`#/tags?q=${encodeURIComponent(new FormData(e.target).get('q') || '')}${only ? '&only=' + only : ''}`) } } }, [
    h('div', { class: 'search-box' }, [icon('search'), h('input', { type: 'search', name: 'q', value: q, placeholder: '搜索标签', 'aria-label': '搜索标签' }), h('button', { class: 'btn btn-primary', type: 'submit' }, '搜索')]),
  ])
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '标签'), h('p', { class: 'sub' }, `${fmtNum(d.distinct)} 种 · 仅出现一次的 ${fmtNum(d.singletonCount)} 种 · 疑似同义组 ${d.synonymGroups.length} 个`)]),
    panel(null, form, { cls: 'panel-filters' }),
    d.synonymGroups.length
      ? panel('疑似同义标签', h('div', { class: 'syn-groups' }, d.synonymGroups.map((g) => h('div', { class: 'syn' }, [
        h('div', { class: 'syn-variants' }, g.variants.map((v) => h('a', { class: 'tag', href: `#/cards?tag=${encodeURIComponent(v.tag)}` }, [v.tag, h('b', null, fmtNum(v.count))]))),
        h('div', { class: 'sub' }, ['建议统一为 ', h('strong', null, g.suggested), `（共影响 ${g.cards} 张卡）`]),
      ]))), { sub: '大小写 / 空格 / 连字符差异的变体；合并操作在 M3，目前也可用 memory_lint / tidy 计划预览' })
      : null,
    h('nav', { class: 'tabs' }, [
      h('a', { class: 'tab' + (only ? '' : ' active'), href: `#/tags${q ? '?q=' + encodeURIComponent(q) : ''}` }, '全部'),
      h('a', { class: 'tab' + (only === 'singleton' ? ' active' : ''), href: `#/tags?only=singleton${q ? '&q=' + encodeURIComponent(q) : ''}` }, ['仅出现一次', badge(fmtNum(d.singletonCount), 'warn')]),
    ]),
    items.length
      ? h('div', { class: 'tag-list' }, items.map((t) => h('a', { class: 'tag-row', href: `#/cards?tag=${encodeURIComponent(t.tag)}` }, [
        h('span', { class: 'tag-name' }, t.tag),
        h('span', { class: 'bar bar-accent' }, h('i', { css: { '--w': Math.max(2, Math.round((t.count / max) * 100)) + '%' } })),
        h('span', { class: 'tag-count' }, fmtNum(t.count)),
        t.singleton ? badge('一次性', 'warn') : null,
      ])))
      : empty('没有匹配的标签'),
    d.total > d.items.length ? notice('info', null, `仅显示前 ${d.items.length} 个，共 ${d.total} 个；用搜索缩小范围。`) : null,
  ])
}
