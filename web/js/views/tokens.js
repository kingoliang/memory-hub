// 令牌列表（只读）：绝不显示令牌明文或哈希。创建/吊销在 M3（目前用 CLI）。

import { h } from '../dom.js'
import { get } from '../api.js'
import { notice, table, badge, timeEl, tagChip } from '../ui.js'
import { fmtDate, fmtNum } from '../format.js'

export default async function render(ctx) {
  const d = await get('tokens')
  ctx.setTitle('令牌')
  const tone = { active: 'ok', revoked: 'bad', expired: 'warn' }
  const label = { active: '有效', revoked: '已吊销', expired: '已过期' }
  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head' }, [h('h1', null, '令牌'), h('p', { class: 'sub' }, `${d.total} 枚 · 每个 Agent 一枚，署名即令牌名`)]),
    notice('info', '只读视图 · 不显示令牌明文与哈希', '创建与吊销目前用命令行：memory-hub token create --name <名字> --scope read,write；memory-hub token revoke <名字>。界面里的创建/吊销在 M3。'),
    table([
      { label: '名称', render: (t) => h('strong', null, t.name) },
      { label: '范围', render: (t) => h('span', { class: 'inline' }, t.scopes.map((s) => tagChip(s))) },
      { label: '状态', render: (t) => badge(label[t.status], tone[t.status]) },
      { label: '创建', render: (t) => fmtDate(t.createdAt) },
      { label: '最后使用', render: (t) => (t.lastUsedAt ? timeEl(t.lastUsedAt) : '从未') },
      { label: '过期', render: (t) => (t.expiresAt ? fmtDate(t.expiresAt) : '不过期') },
      { label: '吊销', render: (t) => (t.revokedAt ? fmtDate(t.revokedAt) : '—') },
      { label: '近 30 天调用', cls: 'num', render: (t) => fmtNum(t.calls30d) },
    ], d.items, { emptyText: '还没有令牌' }),
  ])
}
