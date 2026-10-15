// 卡片详情（只读）。renderCardDetail 是纯渲染函数（便于在假 DOM 里测试转义行为）。

import { h } from '../dom.js'
import { get } from '../api.js'
import { renderMarkdown } from '../markdown.js'
import { fmtDate, fmtNum, statusLabel, secretLabel } from '../format.js'
import { kindBadge, statusBadge, tagChip, panel, badge, notice, icon, timeEl, empty } from '../ui.js'

const kv = (k, v) => [h('dt', null, k), h('dd', null, v ?? '—')]

export function renderCardDetail(card) {
  const rawMode = { v: false }
  const bodyHost = h('div', { class: 'body-host' }, renderMarkdown(card.body || ''))
  const toggle = h('button', { type: 'button', class: 'btn btn-ghost' }, '查看原文')
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

  return h('div', { class: 'page card-detail' }, [
    h('a', { class: 'back', href: '#/cards' }, [icon('back', 'icon-sm'), '返回列表']),
    h('header', { class: 'detail-head' }, [
      h('div', { class: 'detail-badges' }, [kindBadge(card.kind), statusBadge(card.status)]),
      h('h1', null, card.title || '（无标题）'),
      h('code', { class: 'path' }, card.path),
    ]),
    card.redacted ? notice('warn', '检测到疑似明文密钥', `界面已把命中内容遮蔽为 [已遮蔽:类型]（类型：${card.secretTypes.map(secretLabel).join('、')}）。请到源头吊销该密钥并改写这张卡。`) : null,
    card.status === 'deleted' && card.retention ? notice('info', `回收站 · 还剩 ${card.retention.daysLeft} 天`, `将于 ${fmtDate(card.retention.expiresAt)} 自动永久清除（保留 ${card.retention.days} 天）。`) : null,
    card.status === 'pending' || card.status === 'rejected' ? notice('info', card.status === 'pending' ? '待审核' : '已驳回', `${card.reason || card.quarantine?.reason || '无附加说明'}（批准/驳回将在 M3 提供）`) : null,
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
    card.revisions?.length ? panel(`修订历史（${card.revisions.length}）`, h('div', { class: 'revisions' }, card.revisions.map((r) => h('details', { class: 'rev' }, [
      h('summary', null, [h('strong', null, r.title || '（无标题）'), ` · ${r.editedBy || '—'} · ${fmtDate(r.editedAt)}`]),
      h('pre', { class: 'raw' }, r.body || ''),
    ])))) : null,
    card.history?.length ? panel('状态流转', h('ol', { class: 'timeline' }, card.history.map((x) => h('li', null, [h('time', null, fmtDate(x.createdAt)), h('p', null, [statusLabel(x.oldStatus), ' → ', statusLabel(x.newStatus), ` · ${x.changedBy || '—'}`, x.reason ? ` · ${x.reason}` : ''])])))) : null,
    card.writes?.length ? panel('写入审计', h('ol', { class: 'timeline' }, card.writes.map((w) => h('li', null, [h('time', null, fmtDate(w.ts)), h('p', null, `${w.actorName || w.actorType} · ${w.tool || '—'} · ${w.action} · ${w.outcome}`)])))) : null,
  ])
}

export default async function render(ctx) {
  const path = ctx.params.get('path') || ''
  if (!path) return empty('缺少 path 参数')
  const card = await get('card', { path })
  ctx.setTitle(card.title || '卡片详情')
  return renderCardDetail(card)
}
