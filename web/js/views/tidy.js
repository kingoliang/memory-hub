// 整理预览（纯预览：只调用 tidyPlan，不执行任何改动）。

import { h } from '../dom.js'
import { get } from '../api.js'
import { panel, stat, notice, empty, badge, cardLink, icon } from '../ui.js'
import { fmtNum, secretLabel } from '../format.js'

const section = (title, count, body, { open = false, tone = 'neutral', sub } = {}) => h('details', { class: 'fold', open }, [
  h('summary', null, [h('span', { class: 'fold-title' }, title), badge(fmtNum(count), count ? tone : 'mute'), sub ? h('span', { class: 'sub' }, sub) : null]),
  h('div', { class: 'fold-body' }, count ? body : empty('没有需要处理的项')),
])

export default async function render(ctx) {
  const threshold = ctx.params.get('threshold') || ''
  const d = await get('tidy/preview', { threshold, limit: 50 })
  ctx.setTitle('整理预览')
  const c = d.counts
  const form = h('form', { class: 'inline-form', on: { submit: (e) => {
    e.preventDefault()
    const v = String(new FormData(e.target).get('threshold') || '').trim()
    ctx.go('#/tidy' + (v ? `?threshold=${encodeURIComponent(v)}` : ''))
  } } }, [
    h('label', null, ['近似重复阈值（0.05–1）', h('input', { type: 'number', name: 'threshold', step: '0.01', min: '0.05', max: '1', value: threshold || String(d.options.threshold) })]),
    h('button', { class: 'btn btn-primary', type: 'submit' }, '重新生成预览'),
  ])
  const more = (k, n) => (d.truncated[k] ? h('p', { class: 'sub' }, `仅显示前 ${n} 项，共 ${c[{ noise: 'noise', duplicates: 'duplicateGroups', tags: 'tagChanges', kindMisplaced: 'kindMisplaced', secrets: 'secrets', oversizeRaw: 'oversizeRaw' }[k]]} 项`) : null)
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '整理预览'), h('p', { class: 'sub' }, ['planId ', h('code', null, d.planId), ` · ${fmtNum(d.totals.cards)} 张卡`])]),
    notice('ok', '纯预览，不会修改任何数据', '本页只调用与 memory_tidy_plan 相同的计划逻辑。执行（软删 / 合并 / 标签归一）、确认与回滚在 M3 整理中心提供。'),
    panel('参数', form),
    h('div', { class: 'stats' }, [
      stat('噪声卡', c.noise, { tone: c.noise ? 'tone-warn' : '' }),
      stat('近似重复组', c.duplicateGroups, { hint: `可吸收 ${c.duplicateAbsorbable} 张` }),
      stat('标签变更', c.tagChanges, { hint: `${d.tags.distinctBefore} → ${d.tags.distinctAfter} 种` }),
      stat('kind 错放', c.kindMisplaced),
      stat('密钥疑似', c.secrets, { tone: c.secrets ? 'tone-bad' : '', hint: '只显示路径与类型' }),
      stat('超大 raw 卡', c.oversizeRaw),
    ]),
    section('噪声卡（仅 raw 原文卡）', c.noise, [h('ul', { class: 'plain-list' }, d.noise.map((n) => h('li', null, [cardLink(n.path, n.path), ' ', badge(n.reason, 'warn')]))), more('noise', d.noise.length)], { open: c.noise > 0, tone: 'warn', sub: '执行时软删进回收站' }),
    section('近似重复', c.duplicateGroups, [d.duplicates.map((g) => h('div', { class: 'dup-group' }, [
      h('div', { class: 'dup-keep' }, [badge('保留', 'ok'), cardLink(g.canonical.path, g.canonical.title || g.canonical.path)]),
      h('ul', null, g.absorbs.map((a) => h('li', null, [badge('吸收', 'warn'), cardLink(a.path, a.title || a.path), h('span', { class: 'sub' }, ` 相似 ${a.sim} · 独特行 ${a.uniqueLines}`)]))),
    ])), more('duplicates', d.duplicates.length)], { open: c.duplicateGroups > 0, tone: 'warn', sub: '保留最长卡，独特行并入' }),
    section('标签归一', c.tagChanges, [
      Object.keys(d.tags.map).length ? h('div', { class: 'tag-map' }, Object.entries(d.tags.map).map(([from, to]) => h('span', { class: 'map-pair' }, [h('span', { class: 'tag' }, from), '→', h('span', { class: 'tag tag-strong' }, to)]))) : null,
      h('ul', { class: 'plain-list' }, d.tags.changes.map((x) => h('li', null, [cardLink(x.path, x.path), h('span', { class: 'sub' }, ` ${x.old.join(', ') || '∅'} → ${x.new.join(', ') || '∅'}`), x.malformed ? badge('tags 非法 JSON', 'bad') : null]))),
      more('tags', d.tags.changes.length),
    ], { tone: 'accent' }),
    section('kind 与路径前缀不一致', c.kindMisplaced, [h('ul', { class: 'plain-list' }, d.kindMisplaced.map((k) => h('li', null, [cardLink(k.path, k.path), h('span', { class: 'sub' }, ` kind=${k.kind}，路径暗示 ${k.expectedKind}`)]))), more('kindMisplaced', d.kindMisplaced.length)], { sub: '只报告，不自动改' }),
    section('明文密钥疑似', c.secrets, [h('ul', { class: 'plain-list' }, d.secrets.map((x) => h('li', null, [icon('lock', 'icon-sm'), cardLink(x.path, x.path), ' ', x.types.map((t) => badge(secretLabel(t), 'bad'))]))), more('secrets', d.secrets.length)], { open: c.secrets > 0, tone: 'bad', sub: '只显示卡路径与类型，从不显示值' }),
    section('超大 raw 卡', c.oversizeRaw, [h('ul', { class: 'plain-list' }, d.oversizeRaw.map((r) => h('li', null, [cardLink(r.path, r.path), h('span', { class: 'sub' }, ` ${fmtNum(r.chars)} 字`)]))), more('oversizeRaw', d.oversizeRaw.length)], { sub: '长会话原文未蒸馏' }),
  ])
}
