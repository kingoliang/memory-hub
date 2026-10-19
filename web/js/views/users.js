// 用户管理（仅超级管理员）：建账号、改团队 / 角色、重置口令、停用 / 启用。
// 用户名同时是 owner：与该人 Agent 令牌的 --owner 对齐，网页与 MCP 是同一个人、同一套可见性规则。

import { h } from '../dom.js'
import { get, post, patch } from '../api.js'
import { notice, table, badge, timeEl, pageHead, secHead } from '../ui.js'
import { fmtDate } from '../format.js'
import { guard, toast, errText, confirmDialog, formDialog } from '../dialogs.js'

const ROLE_OPTIONS = [['member', '成员 · 看自己 + 本团队 + 其它团队公开卡，只能改自己的'], ['lead', '团队管理员 · 另可改 / 审批本团队的卡'], ['admin', '超级管理员 · 全部权限']]
const ROLE_LABEL = { member: '成员', lead: '团队管理员', admin: '超级管理员' }
const ROLE_TONE = { member: 'neutral', lead: 'accent', admin: 'warn' }

export default async function render(ctx) {
  const d = await get('users')
  ctx.setTitle('用户')

  const create = h('button', { type: 'button', class: 'btn btn-primary' }, '新建用户')
  create.addEventListener('click', guard(create, async () => {
    let made = null
    await formDialog({
      title: '新建用户', submitText: '创建',
      intro: '用户名同时是 owner：请与这个人的 Agent 令牌 --owner 保持一致。只能含字母数字与 . _ -，统一转小写。',
      fields: [
        { name: 'username', label: '用户名', type: 'text', required: true, maxlength: 64, placeholder: '如 kingo' },
        { name: 'team', label: '团队', type: 'text', maxlength: 64, placeholder: '如 remittance' },
        { name: 'role', label: '角色', type: 'select', value: 'member', options: ROLE_OPTIONS },
        { name: 'password', label: '初始口令（至少 10 个字符，请让对方登录后在「账户」页修改）', type: 'password', required: true, maxlength: 1024 },
      ],
      onSubmit: async (v) => { made = await post('users', { username: v.username.trim(), team: v.team.trim(), role: v.role, password: v.password }) },
    })
    if (made) { toast('ok', `已创建 ${made.user.username}`); ctx.reload() }
  }))

  const edit = (u) => {
    const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, '团队 / 角色')
    b.addEventListener('click', guard(b, async () => {
      await formDialog({
        title: `修改「${u.username}」`, submitText: '保存',
        intro: '修改立即生效：这个人下一次请求就按新团队 / 新角色判定权限。',
        fields: [
          { name: 'team', label: '团队', type: 'text', value: u.team, maxlength: 64 },
          { name: 'role', label: '角色', type: 'select', value: u.role, options: ROLE_OPTIONS },
        ],
        onSubmit: async (v) => {
          const body = { username: u.username }
          if (v.team.trim() !== u.team) body.team = v.team.trim()
          if (v.role !== u.role) body.role = v.role
          if (Object.keys(body).length === 1) return
          await patch('users', body)
          toast('ok', '已保存'); ctx.reload()
        },
      })
    }))
    return b
  }

  const reset = (u) => {
    const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, '重置口令')
    b.addEventListener('click', guard(b, async () => {
      await formDialog({
        title: `重置「${u.username}」的口令`, submitText: '重置', danger: true,
        intro: '重置后这个人的所有会话立即失效，需要用新口令重新登录。',
        fields: [{ name: 'password', label: '新口令（至少 10 个字符）', type: 'password', required: true, maxlength: 1024 }],
        onSubmit: async (v) => { await post('users/password', { username: u.username, password: v.password }); toast('ok', '已重置') },
      })
    }))
    return b
  }

  const toggle = (u) => {
    const b = h('button', { type: 'button', class: u.disabled ? 'btn btn-ghost btn-sm' : 'btn btn-danger-ghost btn-sm' }, u.disabled ? '启用' : '停用')
    b.addEventListener('click', guard(b, async () => {
      if (!u.disabled && !(await confirmDialog({ title: `停用「${u.username}」？`, danger: true, confirmText: '停用', message: '停用立即生效：这个人会被踢下线且无法再登录。他的卡片与令牌不受影响（令牌请到「令牌」页单独撤销）。' }))) return
      try { await patch('users', { username: u.username, disabled: !u.disabled }); toast('ok', u.disabled ? '已启用' : '已停用'); ctx.reload() } catch (e) { toast('bad', errText(e)) }
    }))
    return b
  }

  return h('div', { class: 'page' }, [
    pageHead('14', 'Users', '用户', `${d.items.length} 个账号 · 用户名即 owner`, create),
    h('div', { class: 'g12' }, [
      h('section', { class: 'c12' }, [secHead('A1', '说明'), notice('info', '应急入口不在这里', '登录页用户名留空 + 管理员口令 = 应急入口（超级管理员），用于账号体系出问题时。它的口令在「账户」页或 CLI memory-hub admin set-password 修改。')]),
      h('section', { class: 'c12' }, [secHead('B1', '账号列表', `${d.items.length} 个`), table([
        { label: '用户名', render: (u) => h('strong', null, u.username) },
        { label: '团队', render: (u) => u.team || '—' },
        { label: '角色', render: (u) => badge(ROLE_LABEL[u.role] || u.role, ROLE_TONE[u.role]) },
        { label: '状态', render: (u) => (u.disabled ? badge('已停用', 'bad') : badge('正常', 'ok')) },
        { label: '最近登录', render: (u) => (u.lastLoginAt ? timeEl(u.lastLoginAt) : '从未') },
        { label: '创建', render: (u) => fmtDate(u.createdAt) },
        { label: '操作', render: (u) => h('span', { class: 'inline' }, [edit(u), reset(u), toggle(u)]) },
      ], d.items, { emptyText: '还没有账号：点右上角「新建用户」' })]),
    ]),
  ])
}
