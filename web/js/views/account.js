// 账户：修改管理员口令（需要旧口令）。成功后所有会话失效，回到登录页。

import { h } from '../dom.js'
import * as api from '../api.js'
import { panel, notice, pageHead, secHead } from '../ui.js'
import { guard, toast, errText } from '../dialogs.js'

export default async function render(ctx) {
  ctx.setTitle('账户')
  const old = h('input', { type: 'password', name: 'old', autocomplete: 'current-password', 'aria-label': '旧口令' })
  const nw = h('input', { type: 'password', name: 'new', autocomplete: 'new-password', 'aria-label': '新口令' })
  const again = h('input', { type: 'password', name: 'again', autocomplete: 'new-password', 'aria-label': '再输一次新口令' })
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, '修改口令')
  const show = (m) => { err.textContent = m; err.removeAttribute('hidden') }
  const run = guard([submit, old, nw, again], async () => {
    err.setAttribute('hidden', '')
    if (!old.value || !nw.value) return show('请填写旧口令和新口令')
    if (nw.value !== again.value) return show('两次输入的新口令不一致')
    try {
      await api.post('password', { oldPassword: old.value, newPassword: nw.value })
      old.value = nw.value = again.value = ''
      toast('ok', '口令已修改，所有会话已失效，请重新登录')
      api.setCsrf(null)
      setTimeout(() => { location.hash = '#/overview'; location.reload() }, 900)
    } catch (e) { show(errText(e)) }
  })
  const form = h('form', { class: 'edit-form narrow', on: { submit: (e) => { e.preventDefault(); run() } } }, [
    h('label', null, ['旧口令', old]), h('label', null, ['新口令（至少 10 个字符）', nw]), h('label', null, ['再输一次新口令', again]), err,
    h('div', { class: 'edit-actions' }, submit),
  ])
  return h('div', { class: 'page' }, [
    pageHead('09', 'Account', '账户', '单管理员口令'),
    h('div', { class: 'g12' }, [
      panel('修改管理员口令', form, { no: 'A1', cls: 'c6' }),
      h('section', { class: 'c6' }, [secHead('A2', '须知'), notice('warn', '修改后所有会话立即失效', '包括当前这个：修改成功后会回到登录页，用新口令重新登录。连续输错旧口令会被限流。')]),
    ]),
  ])
}
