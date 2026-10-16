// 登录页。未设置口令时给出 CLI 指引（服务端同样会以 503 拒绝登录）。

import { h } from '../dom.js'
import { post, setCsrf } from '../api.js'
import { notice, icon } from '../ui.js'

export function renderLogin({ passwordSet, onSuccess, message }) {
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
  const pw = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: '1024', 'aria-label': '管理员口令', autofocus: true })
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit', disabled: !passwordSet }, '登录')
  const show = (m) => { err.textContent = m; err.removeAttribute('hidden') }
  // 显示 / 隐藏口令（便于核对输入；默认隐藏）
  const toggle = h('button', { type: 'button', class: 'btn btn-ghost btn-sm pw-toggle', 'aria-pressed': 'false', on: { click: () => {
    const show = pw.getAttribute('type') === 'password'
    pw.setAttribute('type', show ? 'text' : 'password')
    toggle.setAttribute('aria-pressed', String(show))
    toggle.textContent = show ? '隐藏' : '显示'
  } } }, '显示')
  const form = h('form', { class: 'login-form', on: { submit: async (e) => {
    e.preventDefault()
    err.setAttribute('hidden', '')
    btn.setAttribute('disabled', '')
    try {
      const r = await post('login', { password: pw.value })
      pw.value = ''
      setCsrf(r.csrfToken)
      onSuccess()
    } catch (ex) {
      show(ex.status === 429 ? ex.message : ex.status === 401 ? '口令不正确' : ex.message || '登录失败')
      if (passwordSet) btn.removeAttribute('disabled')
    }
  } } }, [
    h('label', null, ['管理员口令', h('span', { class: 'pw-field' }, [pw, toggle])]),
    err,
    btn,
  ])
  return h('main', { class: 'login' }, [
    h('div', { class: 'login-card' }, [
      h('div', { class: 'brand brand-lg' }, [h('span', { class: 'brand-mark' }, 'M'), h('div', null, [h('strong', null, '记忆中枢'), h('span', null, 'Memory Hub · 管理')])]),
      message ? notice('warn', null, message) : null,
      passwordSet
        ? form
        : notice('warn', '尚未设置管理员口令', '请在服务器上运行 memory-hub admin set-password（口令从 stdin 读取，不经命令行参数、不回显），完成后刷新本页。'),
      !passwordSet ? h('pre', { class: 'cmd' }, 'memory-hub admin set-password') : null,
      h('p', { class: 'login-foot' }, [icon('lock', 'icon-sm'), '会话仅保存在 HttpOnly cookie 中，口令不会写入浏览器存储']),
    ]),
  ])
}
