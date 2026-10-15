// 令牌管理：创建（明文只在创建响应里出现一次，弹窗带复制按钮）、撤销、改名 / 改过期时间。
// 界面与库里都不会再出现令牌明文或哈希。

import { h } from '../dom.js'
import { get, post, patch, del } from '../api.js'
import { notice, table, badge, timeEl, tagChip, icon } from '../ui.js'
import { fmtDate, fmtNum } from '../format.js'
import { guard, toast, errText, confirmDialog, formDialog, openModal } from '../dialogs.js'

const SCOPE_OPTIONS = [['read', 'read · 检索 / 统计 / 待审列表 / 整理计划 / lint'], ['write', 'write · 沉淀 memory_capture'], ['tidy:apply', 'tidy:apply · 整理执行类工具（默认不对 Agent 暴露，谨慎授予）']]
const EXPIRY_OPTIONS = [['7', '7 天'], ['30', '30 天'], ['90', '90 天'], ['365', '1 年'], ['0', '不过期']]
const iso = (days) => (Number(days) > 0 ? new Date(Date.now() + Number(days) * 86400e3).toISOString() : null)

/** 明文令牌弹窗：持久（点背景/Esc 不会关），必须点"我已保存"；带复制按钮。 */
export function showTokenOnce(made) {
  return new Promise((resolve) => {
    const field = h('input', { type: 'text', readonly: true, value: made.token, class: 'token-plain mono', 'aria-label': '令牌明文', autocomplete: 'off' })
    const copyMsg = h('span', { class: 'sub', role: 'status' }, '')
    const copy = h('button', { type: 'button', class: 'btn btn-primary' }, [icon('check', 'icon-sm'), '复制令牌'])
    const saved = h('input', { type: 'checkbox', 'aria-label': '我已保存令牌' })
    const done = h('button', { type: 'button', class: 'btn btn-ghost', disabled: true }, '完成')
    const m = openModal({
      title: `令牌「${made.name}」已创建`, persistent: true, wide: true,
      body: [
        notice('warn', '仅显示一次', '这是该令牌唯一一次显示明文：关闭窗口后无法再次查看，服务器只保存哈希。请立即复制并保存到安全的地方（比如目标客户端的配置里）。'),
        h('div', { class: 'token-row' }, [field, copy]),
        copyMsg,
        h('p', { class: 'sub' }, ['范围：', ...made.scopes.map((s) => tagChip(s)), made.expiresAt ? `  ·  过期：${fmtDate(made.expiresAt)}` : '  ·  不过期']),
        h('label', { class: 'check modal-field' }, [saved, h('span', null, '我已复制并保存了这个令牌')]),
      ],
      actions: [done],
      onClose: () => resolve(true),
    })
    field.addEventListener('focus', () => field.select())
    saved.addEventListener('change', () => { done.disabled = !saved.checked })
    done.addEventListener('click', () => m.close(true))
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(made.token)
        copyMsg.textContent = '已复制到剪贴板'
      } catch {
        field.focus(); field.select()
        copyMsg.textContent = '浏览器不允许自动复制：令牌已选中，请按 Ctrl/⌘+C 手动复制'
      }
    })
    setTimeout(() => field.select(), 0)
  })
}

export default async function render(ctx) {
  const d = await get('tokens')
  ctx.setTitle('令牌')
  const tone = { active: 'ok', revoked: 'bad', expired: 'warn' }
  const label = { active: '有效', revoked: '已吊销', expired: '已过期' }

  const create = h('button', { type: 'button', class: 'btn btn-primary' }, [icon('key', 'icon-sm'), '创建令牌'])
  create.addEventListener('click', guard(create, async () => {
    let made = null
    await formDialog({
      title: '创建 Agent 令牌', submitText: '创建',
      intro: '每个 Agent 一枚；写入的卡会以令牌名署名。名字只能含字母数字与 . _ : @ -，且不能与未撤销的令牌重名（已撤销的名字可复用）。',
      fields: [
        { name: 'name', label: '令牌名', type: 'text', required: true, maxlength: 64, placeholder: '如 claude-code-kingo' },
        { name: 'scopes', label: '范围', type: 'checkboxes', options: SCOPE_OPTIONS, value: ['read', 'write'], required: true },
        { name: 'days', label: '有效期', type: 'select', options: EXPIRY_OPTIONS, value: '90' },
      ],
      onSubmit: async (v) => { made = await post('tokens', { name: v.name.trim(), scopes: v.scopes, expiresAt: iso(v.days) }) },
    })
    if (made) { await showTokenOnce(made); ctx.reload() }
  }))

  const revoke = (t) => {
    const b = h('button', { type: 'button', class: 'btn btn-danger-ghost btn-sm' }, '撤销')
    b.addEventListener('click', guard(b, async () => {
      if (!(await confirmDialog({ title: `撤销令牌「${t.name}」？`, danger: true, confirmText: '撤销', message: '撤销立即生效：使用这枚令牌的 Agent 下一次请求就会收到 401。无法恢复，需要的话请另建新令牌。' }))) return
      try { await del('tokens', { tokenId: t.tokenId }); toast('ok', `已撤销 ${t.name}`); ctx.reload() } catch (e) { toast('bad', errText(e)) }
    }))
    return b
  }
  const edit = (t) => {
    const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, '改名 / 过期')
    b.addEventListener('click', guard(b, async () => {
      await formDialog({
        title: `修改令牌「${t.name}」`, submitText: '保存',
        intro: '改名只影响以后的署名（已写入的卡保留旧名字）；令牌明文不变。',
        fields: [
          { name: 'name', label: '令牌名', type: 'text', value: t.name, maxlength: 64, required: true },
          { name: 'days', label: '过期时间', type: 'select', value: 'keep', options: [['keep', t.expiresAt ? `保持不变（${fmtDate(t.expiresAt)}）` : '保持不变（不过期）'], ...EXPIRY_OPTIONS.map(([v, l]) => [v, v === '0' ? '改为不过期' : `改为从现在起 ${l}`])] },
        ],
        onSubmit: async (v) => {
          const body = { tokenId: t.tokenId }
          if (v.name.trim() !== t.name) body.name = v.name.trim()
          if (v.days !== 'keep') body.expiresAt = iso(v.days)
          if (Object.keys(body).length === 1) return
          await patch('tokens', body)
          toast('ok', '已保存'); ctx.reload()
        },
      })
    }))
    return b
  }

  return h('div', { class: 'page' }, [
    h('div', { class: 'page-head page-head-row' }, [h('div', null, [h('h1', null, '令牌'), h('p', { class: 'sub' }, `${d.total} 枚 · 每个 Agent 一枚，署名即令牌名`)]), create]),
    notice('info', '不显示令牌明文与哈希', '明文只在创建时显示一次。丢了请撤销后重建。撤销立即生效。'),
    table([
      { label: '名称', render: (t) => h('strong', null, t.name) },
      { label: '范围', render: (t) => h('span', { class: 'inline' }, t.scopes.map((s) => tagChip(s))) },
      { label: '状态', render: (t) => badge(label[t.status], tone[t.status]) },
      { label: '创建', render: (t) => fmtDate(t.createdAt) },
      { label: '最后使用', render: (t) => (t.lastUsedAt ? timeEl(t.lastUsedAt) : '从未') },
      { label: '过期', render: (t) => (t.expiresAt ? fmtDate(t.expiresAt) : '不过期') },
      { label: '吊销', render: (t) => (t.revokedAt ? fmtDate(t.revokedAt) : '—') },
      { label: '近 30 天调用', cls: 'num', render: (t) => fmtNum(t.calls30d) },
      { label: '操作', render: (t) => (t.status === 'revoked' ? '—' : h('span', { class: 'inline' }, [edit(t), revoke(t)])) },
    ], d.items, { emptyText: '还没有令牌' }),
  ])
}
