// 卡片详情 + 编辑 / 历史版本回滚 / 软删 / 恢复 / 永久删 / 批准 / 驳回。
// renderCardDetail 是纯渲染函数（便于在假 DOM 里测试转义行为）；ctx（reload/go）可省略，省略时按钮只渲染不工作。

import { h } from '../dom.js'
import { get, post, patch, del } from '../api.js'
import { renderMarkdown } from '../markdown.js'
import { fmtDate, fmtNum, statusLabel, secretLabel, KIND_LABEL } from '../format.js'
import { kindBadge, statusBadge, tagChip, panel, badge, notice, icon, timeEl, empty } from '../ui.js'
import { guard, toast, errText, confirmDialog, formDialog } from '../dialogs.js'

const kv = (k, v) => [h('dt', null, k), h('dd', null, v ?? '—')]
const KIND_OPTIONS = Object.entries(KIND_LABEL)

/** 解析标签输入：逗号 / 顿号 / 换行分隔，去空去重。 */
export const parseTagInput = (s) => [...new Set(String(s || '').split(/[,，、\n]/).map((t) => t.trim()).filter(Boolean))]

function actionButton(label, cls, handler, ctx) {
  const b = h('button', { type: 'button', class: 'btn ' + cls }, label)
  if (ctx?.reload || ctx?.go) b.addEventListener('click', guard(b, handler))
  else b.disabled = true
  return b
}

export function renderCardDetail(card, ctx = {}) {
  const rawMode = { v: false }
  const bodyHost = h('div', { class: 'body-host' }, renderMarkdown(card.body || ''))
  const toggle = h('button', { type: 'button', class: 'btn btn-sm' }, '查看原文')
  toggle.addEventListener('click', () => {
    rawMode.v = !rawMode.v
    while (bodyHost.firstChild) bodyHost.removeChild(bodyHost.firstChild)
    bodyHost.appendChild(rawMode.v ? h('pre', { class: 'raw' }, card.body || '') : renderMarkdown(card.body || ''))
    toggle.textContent = rawMode.v ? '渲染视图' : '查看原文'
  })

  const tok = card.signedByToken
  const signed = card.submittedBy
    ? [card.submittedBy, tok ? (tok.exists ? badge(tok.revoked ? '令牌已吊销' : tok.expired ? '令牌已过期' : '令牌有效', tok.revoked || tok.expired ? 'bad' : 'ok') : badge('无对应令牌（历史署名）', 'mute')) : null]
    : [card.agentFromSource ? `（未署名，来源 ${card.agent}）` : '（未署名）']

  const failed = (e) => {
    if (e?.status === 409 && e.extra?.currentUpdatedAt) {
      toast('bad', '卡片在你打开之后被修改过，已为你刷新到最新内容')
      ctx.reload?.()
      return
    }
    toast('bad', errText(e))
  }
  const done = (msg) => { toast('ok', msg); ctx.reload?.() }

  // ---- 编辑 ----
  const editBody = h('div', { class: 'edit-slot' })
  const startEdit = () => {
    const title = h('input', { type: 'text', name: 'title', value: card.title || '', maxlength: 200, autocomplete: 'off' })
    const kind = h('select', { name: 'kind' }, KIND_OPTIONS.map(([v, l]) => h('option', { value: v, selected: v === card.kind }, l)))
    const tags = h('input', { type: 'text', name: 'tags', value: (card.tags || []).join(', '), placeholder: '用逗号分隔，如：数据库, 选型', autocomplete: 'off' })
    const body = h('textarea', { name: 'body', rows: 20, autocomplete: 'off', class: 'mono' }, card.body || '')
    const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
    const save = h('button', { type: 'submit', class: 'btn btn-primary' }, '保存')
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, '取消')
    const form = h('form', { class: 'edit-form' }, [
      card.redacted ? notice('warn', '这张卡含疑似明文密钥', '下面显示的是界面遮蔽后的文本（[已遮蔽:类型]）。保存会被拒绝，除非你先把遮蔽标记所在行删掉；真正的密钥请到源头吊销。') : null,
      h('div', { class: 'edit-grid' }, [h('label', null, ['标题', title]), h('label', null, ['类型（改类型会同步调整路径前缀）', kind]), h('label', { class: 'edit-wide' }, ['标签', tags])]),
      h('label', null, [h('span', null, ['正文 ', h('span', { class: 'sub' }, '（Markdown 文本，按原文保存）')]), body]),
      err,
      h('div', { class: 'edit-actions' }, [cancel, save]),
    ])
    const run = guard([save, cancel, title, kind, tags, body], async () => {
      err.setAttribute('hidden', '')
      const patchBody = { path: card.path, expectedUpdatedAt: card.updatedAt }
      if (title.value.trim() !== (card.title || '')) patchBody.title = title.value
      if (kind.value !== card.kind) patchBody.kind = kind.value
      const tagList = parseTagInput(tags.value)
      if (JSON.stringify(tagList) !== JSON.stringify(card.tags || [])) patchBody.tags = tagList
      if (body.value.trim() !== (card.body || '').trim()) patchBody.body = body.value
      if (Object.keys(patchBody).length === 2) { err.textContent = '没有任何改动'; err.removeAttribute('hidden'); return }
      try {
        const r = await patch('card', patchBody)
        toast('ok', r.changed.length ? `已保存（修改：${r.changed.join('、')}）；旧版本已存入历史版本` : '没有变化')
        if (r.path !== card.path) ctx.go?.(`#/card?path=${encodeURIComponent(r.path)}`); else ctx.reload?.()
      } catch (e) {
        if (e.status === 409 && e.extra?.currentUpdatedAt) {
          err.textContent = '保存失败：这张卡在你打开之后被修改过（可能是 Agent 追加了内容，或另一个管理会话保存了）。你的输入还在上面，请先复制备份，再点"重新载入最新版本"。'
          err.removeAttribute('hidden')
          err.appendChild(h('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => ctx.reload?.() } }, '重新载入最新版本'))
        } else { err.textContent = errText(e); err.removeAttribute('hidden') }
      }
    })
    form.addEventListener('submit', (e) => { e.preventDefault(); run() })
    cancel.addEventListener('click', () => { while (editBody.firstChild) editBody.removeChild(editBody.firstChild); editBody.classList.remove('open'); editBtn.disabled = false })
    while (editBody.firstChild) editBody.removeChild(editBody.firstChild)
    editBody.appendChild(panel('编辑卡片', form, { cls: 'edit-panel', sub: `基于 ${fmtDate(card.updatedAt)} 的版本；保存时若卡片已被别人改过会提示冲突，不会覆盖` }))
    editBody.classList.add('open')
    editBtn.disabled = true
    title.focus()
  }
  const editBtn = h('button', { type: 'button', class: 'btn btn-primary' }, [icon('cards', 'icon-sm'), '编辑'])
  if (ctx.reload || ctx.go) editBtn.addEventListener('click', startEdit); else editBtn.disabled = true

  // ---- 状态操作 ----
  // 按钮按服务端下发的 can 显示（老接口没有 can 字段时按全部允许，保持原行为）
  const can = card.can || { edit: true, moderate: true, purge: true }
  const actions = []
  if (card.status !== 'deleted' && can.edit) actions.push(editBtn)
  if ((card.status === 'pending' || card.status === 'rejected') && can.moderate) {
    actions.push(actionButton('批准', 'btn-primary', async () => {
      if (!(await confirmDialog({ title: '批准这张卡？', message: '批准后卡片进入记忆库，其他 Agent 可以通过 memory_recall 检索到它。', confirmText: '批准' }))) return
      try { await post('queue/approve', { paths: [card.path] }); done('已批准，卡片已进入记忆库') } catch (e) { failed(e) }
    }, ctx))
    if (card.status === 'pending') {
      actions.push(actionButton('驳回…', 'btn-ghost', async () => {
        await formDialog({
          title: '驳回这张卡', intro: '驳回后卡片留在隔离区，不会被检索到；理由会记录在状态流转里。', submitText: '驳回', danger: true,
          fields: [{ name: 'reason', label: '驳回理由（可选）', type: 'textarea', rows: 3, maxlength: 500 }],
          onSubmit: async (v) => { await post('queue/reject', { paths: [card.path], reason: v.reason }); done('已驳回') },
        })
      }, ctx))
    }
  }
  if (card.status !== 'deleted') {
    if (can.edit) actions.push(actionButton('软删', 'btn-danger-ghost', async () => {
      if (!(await confirmDialog({ title: '把这张卡移入回收站？', message: `「${card.title}」将不再被检索到，${card.retention?.days ?? 30} 天内可以在回收站恢复，之后自动永久清除。`, confirmText: '移入回收站', danger: true }))) return
      try { await del('card', { path: card.path }); done('已移入回收站') } catch (e) { failed(e) }
    }, ctx))
  } else if (can.purge) {
    actions.push(actionButton('恢复', 'btn-primary', async () => {
      try { await post('card/restore', { path: card.path }); done('已恢复到记忆库') } catch (e) { failed(e) }
    }, ctx))
    actions.push(actionButton('永久删除…', 'btn-danger', async () => {
      if (!(await confirmDialog({ title: '永久删除（不可恢复）', message: '这会彻底删除这张卡及其更新记录、历史版本，无法撤销。', danger: true, confirmText: '永久删除', requireText: card.title, requireLabel: '请原样输入这张卡的标题以确认' }))) return
      try { await post('card/purge', { path: card.path, confirmTitle: card.title }); toast('ok', '已永久删除'); ctx.go?.('#/recycle') } catch (e) { failed(e) }
    }, ctx))
  }

  const rollbackBtn = (r) => actionButton('回滚到此版本', 'btn-ghost', async () => {
    if (!(await confirmDialog({
      title: '回滚到这个版本？', confirmText: '回滚',
      message: '会把标题、正文、标签、类型恢复为该版本。回滚本身也会作为一次编辑保存，所以当前内容不会丢——可以再回滚回来。',
      lines: [`版本：${fmtDate(r.editedAt)} · ${r.editedBy || '—'}`, `标题：${r.title || '（无标题）'}`],
    }))) return
    try { await post('card/rollback', { path: card.path, revisionId: r.id, expectedUpdatedAt: card.updatedAt }); done('已回滚到所选版本') } catch (e) { failed(e) }
  }, ctx)

  return h('div', { class: 'page card-detail' }, [
    h('a', { class: 'back', href: '#/cards' }, [icon('back', 'icon-sm'), '返回列表']),
    h('header', { class: 'detail-head' }, [
      h('div', { class: 'detail-badges' }, [kindBadge(card.kind), statusBadge(card.status)]),
      h('h1', null, card.title || '（无标题）'),
      h('code', { class: 'path' }, card.path),
      h('p', { class: 'detail-meta sub' }, ['创建 ', timeEl(card.createdAt), ' · 更新 ', timeEl(card.updatedAt), ` · ${fmtNum((card.body || '').length)} 字符`]),
      h('div', { class: 'detail-actions', role: 'group', 'aria-label': '卡片操作' }, actions),
    ]),
    card.redacted ? notice('warn', '检测到疑似明文密钥', `界面已把命中内容遮蔽为 [已遮蔽:类型]（类型：${card.secretTypes.map(secretLabel).join('、')}）。请到源头吊销该密钥并改写这张卡。`) : null,
    card.status === 'deleted' && card.retention ? notice('info', `回收站 · 还剩 ${card.retention.daysLeft} 天`, `将于 ${fmtDate(card.retention.expiresAt)} 自动永久清除（保留 ${card.retention.days} 天）。`) : null,
    card.status === 'pending' || card.status === 'rejected' ? notice('info', card.status === 'pending' ? '待审核' : '已驳回', `${card.reason || card.quarantine?.reason || '无附加说明'}`) : null,
    editBody,
    h('div', { class: 'detail-grid' }, [
      panel('正文', [h('div', { class: 'body-tools' }, [h('span', { class: 'sub' }, `${fmtNum((card.body || '').length)} 字符`), toggle]), bodyHost], { cls: 'detail-body' }),
      h('div', { class: 'detail-side' }, [
        panel('元信息', h('dl', { class: 'kv' }, [
          ...kv('署名', h('span', { class: 'inline' }, signed)),
          ...kv('来源 source', card.source || '—'),
          ...kv('创建', [fmtDate(card.createdAt), ' · ', timeEl(card.createdAt)]),
          ...kv('更新', [fmtDate(card.updatedAt), ' · ', timeEl(card.updatedAt)]),
          ...(card.deletedAt ? kv('删除于', fmtDate(card.deletedAt)) : []),
          ...(card.severity && card.severity !== 'info' ? kv('严重度', card.severity) : []),
        ])),
        panel('标签', card.tags.length ? h('div', { class: 'tags' }, card.tags.map((t) => tagChip(t, `#/cards?tag=${encodeURIComponent(t)}`))) : h('span', { class: 'sub' }, '无标签')),
      ]),
    ]),
    card.updates?.length ? panel(`更新记录（${card.updates.length}）`, h('ol', { class: 'timeline' }, card.updates.map((u) => h('li', null, [h('time', null, fmtDate(u.createdAt)), h('p', null, u.content)])))) : null,
    card.revisions?.length ? panel(`历史版本（${card.revisions.length}）`, h('div', { class: 'revisions' }, card.revisions.map((r) => h('details', { class: 'rev' }, [
      h('summary', null, [h('strong', null, r.title || '（无标题）'), ` · ${r.editedBy || '—'} · ${fmtDate(r.editedAt)}`]),
      h('div', { class: 'rev-meta' }, [kindBadge(r.kind), ...(r.tags || []).map((t) => tagChip(t))]),
      h('pre', { class: 'raw' }, r.body || ''),
      card.status !== 'deleted' && can.edit && r.id !== undefined ? h('div', { class: 'rev-actions' }, rollbackBtn(r)) : null,
    ]))), { sub: '每次保存前的旧版本；回滚本身也会留下一个版本' }) : null,
    card.history?.length ? panel('状态流转', h('ol', { class: 'timeline' }, card.history.map((x) => h('li', null, [h('time', null, fmtDate(x.createdAt)), h('p', null, [statusLabel(x.oldStatus), ' → ', statusLabel(x.newStatus), ` · ${x.changedBy || '—'}`, x.reason ? ` · ${x.reason}` : ''])])))) : null,
    card.writes?.length ? panel('写入审计', h('ol', { class: 'timeline' }, card.writes.map((w) => h('li', null, [h('time', null, fmtDate(w.ts)), h('p', null, `${w.actorName || w.actorType} · ${w.tool || '—'} · ${w.action} · ${w.outcome}`)])))) : null,
  ])
}

export default async function render(ctx) {
  const path = ctx.params.get('path') || ''
  if (!path) return empty('缺少 path 参数')
  const card = await get('card', { path })
  ctx.setTitle(card.title || '卡片详情')
  return renderCardDetail(card, ctx)
}
