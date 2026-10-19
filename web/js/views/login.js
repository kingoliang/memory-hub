// 登录页：用户名 + 口令。用户名留空 = 应急入口（原管理员口令，身份为超级管理员）。
// 应急口令未设置时仍可用具名账号登录，只在用户名为空时给出 CLI 指引（服务端同样会以 503 拒绝）。

import { h } from '../dom.js'
import { post, setCsrf } from '../api.js'
import { notice, icon } from '../ui.js'

export function renderLogin({ passwordSet, onSuccess, message }) {
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
  const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', maxlength: '64', 'aria-label': '用户名', placeholder: '留空 = 管理员应急入口', autofocus: true })
  const pw = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: '1024', 'aria-label': '口令' })
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '登录')
  const show = (m) => { err.textContent = m; err.removeAttribute('hidden') }
  // 显示 / 隐藏口令（便于核对输入；默认隐藏）
  const toggle = h('button', { type: 'button', class: 'btn btn-ghost btn-sm pw-toggle', 'aria-pressed': 'false', on: { click: () => {
    const reveal = pw.getAttribute('type') === 'password'
    pw.setAttribute('type', reveal ? 'text' : 'password')
    toggle.setAttribute('aria-pressed', String(reveal))
    toggle.textContent = reveal ? '隐藏' : '显示'
  } } }, '显示')
  const form = h('form', { class: 'login-form', on: { submit: async (e) => {
    e.preventDefault()
    err.setAttribute('hidden', '')
    btn.setAttribute('disabled', '')
    const username = user.value.trim()
    try {
      const r = await post('login', username ? { username, password: pw.value } : { password: pw.value })
      pw.value = ''
      setCsrf(r.csrfToken)
      onSuccess()
    } catch (ex) {
      show(ex.status === 429 || ex.status === 503 ? ex.message : ex.status === 401 ? (username ? '用户名或口令不正确' : '口令不正确') : ex.message || '登录失败')
      btn.removeAttribute('disabled')
    }
  } } }, [
    h('label', null, ['用户名', user]),
    h('label', null, ['口令', h('span', { class: 'pw-field' }, [pw, toggle])]),
    err,
    btn,
  ])
  return h('main', { class: 'login' }, [
    h('div', { class: 'login-card' }, [
      h('div', { class: 'brand brand-lg' }, [h('span', { class: 'brand-mark' }, 'M'), h('div', null, [h('strong', null, '记忆中枢'), h('span', null, 'Memory Hub · 管理')])]),
      message ? notice('warn', null, message) : null,
      form,
      passwordSet ? null : notice('info', '应急入口未启用', '还没有设置管理员应急口令：具名账号可以正常登录；需要应急入口时在服务器上运行 memory-hub admin set-password。'),
      h('p', { class: 'login-foot' }, [icon('lock', 'icon-sm'), '会话仅保存在 HttpOnly cookie 中，口令不会写入浏览器存储']),
    ]),
  ])
}
