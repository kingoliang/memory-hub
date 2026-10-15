// 标签管理：频次 / 疑似同义 / 重命名 / 合并 / 删除。
// 流程：打开对话框 → 先调预览接口显示"影响 N 张卡 + 样例" → 勾选确认 → 执行（服务端先备份、批后自检、失败整批回滚，并给出可用的回滚文件）。

import { h } from '../dom.js'
import { get, post } from '../api.js'
import { panel, notice, empty, badge, icon } from '../ui.js'
import { fmtNum } from '../format.js'
import { guard, toast, errText, openModal } from '../dialogs.js'

/**
 * 标签操作对话框（重命名 / 合并 / 删除共用）。
 * spec: { op, from:[...], to?:string, lockFrom?:boolean }
 */
export function tagOpDialog(spec, ctx) {
  const { op } = spec
  const titles = { rename: '重命名标签', merge: '合并标签', delete: '删除标签' }
  const fromInput = h('input', { type: 'text', value: spec.from.join(', '), autocomplete: 'off', 'aria-label': op === 'merge' ? '要合并的标签（逗号分隔）' : '标签', readonly: !!spec.lockFrom, placeholder: '用逗号分隔' })
  const toInput = op === 'delete' ? null : h('input', { type: 'text', value: spec.to || '', autocomplete: 'off', 'aria-label': '新标签名', maxlength: 50, placeholder: '新标签名' })
  const previewBox = h('div', { class: 'tag-preview', 'aria-live': 'polite' }, h('span', { class: 'sub' }, '正在计算影响范围…'))
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
  const ok = h('button', { type: 'button', class: 'btn ' + (op === 'rename' ? 'btn-primary' : 'btn-danger'), disabled: true }, op === 'delete' ? '删除标签' : op === 'merge' ? '合并' : '重命名')
  const previewBtn = h('button', { type: 'button', class: 'btn btn-ghost' }, '重新预览')
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, '取消')
  const sure = h('input', { type: 'checkbox', 'aria-label': '我已确认影响范围' })
  let last = null
  const params = () => {
    const from = fromInput.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    return op === 'merge' ? { from, to: toInput.value.trim() } : op === 'rename' ? { from: from[0] || '', to: toInput.value.trim() } : { from: from[0] || '' }
  }
  const m = openModal({
    title: titles[op], danger: op !== 'rename',
    body: h('div', { class: 'modal-form' }, [
      h('p', { class: 'modal-msg' }, op === 'delete' ? '会从所有卡（含待审、回收站里的卡）移除这个标签。' : op === 'merge' ? '把多个标签统一成一个；同时带有多个源标签的卡只保留一个目标标签。' : '把标签改名；若卡片已经有新名字，则自动去重。'),
      h('label', { class: 'modal-field' }, [op === 'merge' ? '源标签（逗号分隔）' : '标签', fromInput]),
      toInput ? h('label', { class: 'modal-field' }, [op === 'merge' ? '合并为' : '新名字', toInput]) : null,
      previewBox,
      h('label', { class: 'check modal-field' }, [sure, h('span', null, '我已确认上述影响范围；执行前服务端会自动备份，并在批后自检，失败自动回滚。')]),
      err,
    ]),
    actions: [cancel, previewBtn, ok],
  })
  const renderPreview = (p) => {
    last = p
    previewBox.replaceChildren?.()
    while (previewBox.firstChild) previewBox.removeChild(previewBox.firstChild)
    previewBox.appendChild(h('div', null, [
      h('strong', { class: 'big' }, fmtNum(p.affectedCards)), ' 张卡将被修改',
      h('span', { class: 'sub' }, `（记忆库 ${p.byStore.cards} · 隔离区 ${p.byStore.quarantine}${op === 'merge' ? ` · 实际存在的源标签 ${p.fromPresent} 个` : ''}）`),
    ]))
    if (p.samples.length) previewBox.appendChild(h('ul', { class: 'plain-list' }, p.samples.slice(0, 8).map((s) => h('li', null, [h('code', null, s.path), ' ', h('span', { class: 'sub' }, s.title)]))))
    if (p.affectedCards === 0) previewBox.appendChild(notice('info', null, '没有任何卡会被修改。'))
  }
  const refresh = guard([previewBtn, ok], async () => {
    err.setAttribute('hidden', ''); ok.disabled = true; sure.checked = false; last = null
    const q = params()
    try {
      const p = await get('tags/preview', { op, from: q.from instanceof Array ? q.from.join(',') : q.from, to: q.to })
      renderPreview(p)
    } catch (e) { err.textContent = errText(e); err.removeAttribute('hidden') }
  })
  const syncOk = () => { ok.disabled = !(last && last.affectedCards > 0 && sure.checked) }
  sure.addEventListener('change', syncOk)
  previewBtn.addEventListener('click', async () => { await refresh(); syncOk() })
  cancel.addEventListener('click', () => m.close(false))
  ok.addEventListener('click', guard([ok, previewBtn, cancel, sure], async () => {
    const q = params()
    const body = op === 'merge' ? { from: q.from, to: q.to } : op === 'rename' ? { from: q.from, to: q.to } : { tag: q.from }
    m.setBusy(true)
    try {
      const r = await post(`tags/${op}`, { ...body, confirm: true, expectedAffected: last.affectedCards })
      m.setBusy(false); m.close(true)
      toast('ok', `已修改 ${r.affectedCards} 张卡的标签（已备份；回滚文件 ${r.rollbackFile}，可在"整理预览"页回滚）`)
      ctx.reload()
    } catch (e) {
      m.setBusy(false)
      err.textContent = errText(e); err.removeAttribute('hidden')
      if (e.status === 409) { await refresh(); syncOk() }
    }
  }))
  refresh().then(syncOk)
  return m
}

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
  const btn = (label, fn, cls = 'btn-ghost') => { const b = h('button', { type: 'button', class: `btn btn-sm ${cls}` }, label); b.addEventListener('click', fn); return b }
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '标签'), h('p', { class: 'sub' }, `${fmtNum(d.distinct)} 种 · 仅出现一次的 ${fmtNum(d.singletonCount)} 种 · 疑似同义组 ${d.synonymGroups.length} 个`)]),
    panel(null, form, { cls: 'panel-filters' }),
    d.synonymGroups.length
      ? panel('疑似同义标签', h('div', { class: 'syn-groups' }, d.synonymGroups.map((g) => h('div', { class: 'syn' }, [
        h('div', { class: 'syn-variants' }, g.variants.map((v) => h('a', { class: 'tag', href: `#/cards?tag=${encodeURIComponent(v.tag)}` }, [v.tag, h('b', null, fmtNum(v.count))]))),
        h('div', { class: 'syn-foot' }, [
          h('div', { class: 'sub' }, ['建议统一为 ', h('strong', null, g.suggested), `（共影响 ${g.cards} 张卡）`]),
          btn('合并…', () => tagOpDialog({ op: 'merge', from: g.variants.map((v) => v.tag), to: g.suggested }, ctx), 'btn-primary'),
        ]),
      ]))), { sub: '大小写 / 空格 / 连字符差异的变体；合并前会预览影响的卡数，确认后才执行' })
      : null,
    h('nav', { class: 'tabs' }, [
      h('a', { class: 'tab' + (only ? '' : ' active'), href: `#/tags${q ? '?q=' + encodeURIComponent(q) : ''}` }, '全部'),
      h('a', { class: 'tab' + (only === 'singleton' ? ' active' : ''), href: `#/tags?only=singleton${q ? '&q=' + encodeURIComponent(q) : ''}` }, ['仅出现一次', badge(fmtNum(d.singletonCount), 'warn')]),
    ]),
    items.length
      ? h('div', { class: 'tag-list' }, items.map((t) => h('div', { class: 'tag-row' }, [
        h('a', { class: 'tag-name', href: `#/cards?tag=${encodeURIComponent(t.tag)}` }, t.tag),
        h('span', { class: 'bar bar-accent' }, h('i', { css: { '--w': Math.max(2, Math.round((t.count / max) * 100)) + '%' } })),
        h('span', { class: 'tag-count' }, fmtNum(t.count)),
        t.singleton ? badge('一次性', 'warn') : h('span'),
        h('span', { class: 'tag-actions' }, [
          btn('重命名', () => tagOpDialog({ op: 'rename', from: [t.tag], to: t.tag, lockFrom: true }, ctx)),
          btn('合并到…', () => tagOpDialog({ op: 'merge', from: [t.tag], to: '' }, ctx)),
          btn('删除', () => tagOpDialog({ op: 'delete', from: [t.tag], lockFrom: true }, ctx), 'btn-danger-ghost'),
        ]),
      ])))
      : empty('没有匹配的标签'),
    d.total > d.items.length ? notice('info', null, `仅显示前 ${d.items.length} 个，共 ${d.total} 个；用搜索缩小范围。`) : null,
  ])
}
