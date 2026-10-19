// 写操作的交互件：模态对话框 / 确认对话框 / 表单对话框 / 提示条 / 防重复提交。
// 全部经 dom.js 构造（文本只进文本节点），不使用 innerHTML，不需要放宽 CSP。

import { h, mount, clear } from './dom.js'
import { icon } from './ui.js'

let modalHost = null
let toastHost = null
const hostEl = (cls, attrs) => {
  const el = h('div', { class: cls, ...attrs })
  document.body.appendChild(el)
  return el
}

/** 提示条：右下角堆叠，自动消失（错误停留更久）；role=status/alert 供读屏。 */
export function toast(kind, text) {
  if (!toastHost) toastHost = hostEl('toast-layer', { 'aria-live': 'polite' })
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, [icon(kind === 'bad' || kind === 'warn' ? 'warn' : 'check'), h('span', null, text)])
  toastHost.appendChild(el)
  const t = setTimeout(() => el.remove(), kind === 'bad' ? 9000 : 4500)
  el.addEventListener('click', () => { clearTimeout(t); el.remove() })
  return el
}

export function errText(e) {
  if (!e) return '操作失败'
  if (e.status === 0) return e.message
  const extra = e.extra || {}
  if (e.code === 'conflict' && extra.currentUpdatedAt) return e.message
  return e.message || `请求失败（HTTP ${e.status}）`
}

/**
 * 防重复提交：执行期间禁用所有给定控件并标记 aria-busy；结束（无论成败）后恢复。
 * 同一 guard 在进行中再次触发会被直接忽略。
 */
export function guard(controls, fn) {
  let running = false
  const list = Array.isArray(controls) ? controls : [controls]
  return async (...args) => {
    if (running) return undefined
    running = true
    const src = args[0]?.currentTarget // 作为点击监听器时，被点的按钮显示加载转圈（纯视觉标记）
    for (const c of list) { c.disabled = true; c.setAttribute('aria-busy', 'true') }
    if (src && list.includes(src)) src.setAttribute('data-spin', '')
    try { return await fn(...args) } finally {
      running = false
      for (const c of list) { c.disabled = false; c.removeAttribute('aria-busy'); c.removeAttribute('data-spin') }
    }
  }
}

/**
 * 通用模态框。返回 { el, close, setBusy }。
 * @param {{title:string, body:any, actions?:any[], danger?:boolean, wide?:boolean, persistent?:boolean, onClose?:Function}} o
 */
export function openModal({ title, body, actions = [], danger = false, wide = false, persistent = false, onClose }) {
  if (!modalHost) modalHost = hostEl('modal-layer')
  const prevFocus = document.activeElement
  let busy = false
  let closed = false
  const titleId = 'dlg-' + Math.random().toString(36).slice(2, 8)
  const close = (result) => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey, true)
    wrap.remove()
    if (prevFocus && typeof prevFocus.focus === 'function') { try { prevFocus.focus() } catch { /* 元素可能已不在 */ } }
    onClose?.(result)
  }
  const dialog = h('div', { class: 'modal' + (wide ? ' modal-wide' : '') + (danger ? ' modal-danger' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
    h('header', { class: 'modal-head' }, [h('h2', { id: titleId }, title), h('button', { type: 'button', class: 'btn btn-ghost modal-x', 'aria-label': '关闭', on: { click: () => { if (!busy) close(false) } } }, '×')]),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('footer', { class: 'modal-foot' }, actions) : null,
  ])
  const wrap = h('div', { class: 'modal-wrap' }, [
    h('div', { class: 'modal-scrim', on: { click: () => { if (!busy && !persistent) close(false) } } }),
    dialog,
  ])
  const focusables = () => [...dialog.querySelectorAll('button, input, select, textarea, a[href]')].filter((e) => !e.disabled && !e.hasAttribute('hidden'))
  function onKey(e) {
    if (e.key === 'Escape' && !busy && !persistent) { e.stopPropagation(); close(false) }
    if (e.key === 'Tab') {
      const f = focusables()
      if (!f.length) return
      const first = f[0]; const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }
  document.addEventListener('keydown', onKey, true)
  modalHost.appendChild(wrap)
  const first = dialog.querySelector('input:not([type=checkbox]), textarea, select') || dialog.querySelector('.btn-primary, .btn-danger') || dialog
  setTimeout(() => first.focus(), 0)
  return { el: dialog, close, setBusy: (b) => { busy = b } }
}

/** 确认对话框 → Promise<boolean>。requireText：必须原样输入该文本才能点确认（永久删除等高危操作）。 */
export function confirmDialog({ title, message, lines = [], confirmText = '确认', cancelText = '取消', danger = false, requireText = null, requireLabel }) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const input = requireText ? h('input', { type: 'text', autocomplete: 'off', 'aria-label': requireLabel || '确认输入', placeholder: requireText }) : null
    const ok = h('button', { type: 'button', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), disabled: !!requireText }, confirmText)
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, cancelText)
    const m = openModal({
      title, danger,
      body: [
        message ? h('p', { class: 'modal-msg' }, message) : null,
        lines.length ? h('ul', { class: 'modal-lines' }, lines.map((l) => h('li', null, l))) : null,
        input ? h('label', { class: 'modal-field' }, [requireLabel || `请输入「${requireText}」以确认`, input]) : null,
      ],
      actions: [cancel, ok],
      onClose: () => done(false),
    })
    if (input) input.addEventListener('input', () => { ok.disabled = input.value !== requireText })
    cancel.addEventListener('click', () => m.close(false))
    ok.addEventListener('click', () => { done(true); m.close(true) })
  })
}

/**
 * 表单对话框。字段：{name,label,type:'text'|'textarea'|'select'|'number'|'checkboxes'|'datetime',value,options,placeholder,help,required,maxlength,rows}
 * onSubmit(values) 抛错 → 在对话框内显示错误并保持打开；提交期间所有控件禁用（防重复提交）。
 * 返回 Promise<result|null>：onSubmit 的返回值，取消则 null。
 */
export function formDialog({ title, intro, fields, submitText = '确定', danger = false, wide = false, onSubmit, extraBody }) {
  return new Promise((resolve) => {
    let result = null
    const controls = {}
    const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
    const rows = fields.map((f) => {
      let ctl
      if (f.type === 'textarea') ctl = h('textarea', { name: f.name, rows: f.rows || 5, maxlength: f.maxlength, placeholder: f.placeholder, autocomplete: 'off' }, f.value ?? '')
      else if (f.type === 'select') ctl = h('select', { name: f.name }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)))
      else if (f.type === 'checkboxes') {
        const boxes = f.options.map(([v, l]) => h('input', { type: 'checkbox', value: v, checked: (f.value || []).includes(v), 'aria-label': l }))
        controls[f.name] = { boxes, get: () => boxes.filter((b) => b.checked).map((b) => b.value) }
        return h('fieldset', { class: 'modal-field fieldset' }, [h('legend', null, f.label), h('div', { class: 'checks' }, f.options.map(([v, l], i) => h('label', { class: 'check' }, [boxes[i], h('span', null, l)]))), f.help ? h('span', { class: 'sub' }, f.help) : null])
      } else ctl = h('input', { type: f.type === 'number' ? 'number' : f.type === 'datetime' ? 'datetime-local' : f.type === 'password' ? 'password' : 'text', name: f.name, value: f.value ?? '', maxlength: f.maxlength, placeholder: f.placeholder, min: f.min, max: f.max, step: f.step, autocomplete: f.type === 'password' ? 'new-password' : 'off' })
      controls[f.name] = { el: ctl, get: () => ctl.value }
      return h('label', { class: 'modal-field' }, [f.label, ctl, f.help ? h('span', { class: 'sub' }, f.help) : null])
    })
    const submit = h('button', { type: 'submit', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary') }, submitText)
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, '取消')
    const form = h('form', { class: 'modal-form' }, [intro ? h('p', { class: 'modal-msg' }, intro) : null, ...rows, extraBody || null, err])
    const m = openModal({ title, danger, wide, body: form, actions: [cancel, submit], onClose: () => resolve(result) })
    const all = () => [submit, cancel, ...Object.values(controls).flatMap((c) => (c.boxes ? c.boxes : [c.el]))]
    cancel.addEventListener('click', () => m.close(false))
    const run = async () => {
      err.setAttribute('hidden', '')
      const values = Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, c.get()]))
      for (const f of fields) {
        if (f.required && (values[f.name] === '' || (Array.isArray(values[f.name]) && !values[f.name].length))) { err.textContent = `请填写：${f.label}`; err.removeAttribute('hidden'); return }
      }
      m.setBusy(true)
      for (const c of all()) c.disabled = true
      try {
        result = (await onSubmit(values)) ?? true
        m.setBusy(false)
        m.close(true)
      } catch (e) {
        m.setBusy(false)
        for (const c of all()) c.disabled = false
        err.textContent = errText(e)
        err.removeAttribute('hidden')
      }
    }
    submit.addEventListener('click', (e) => { e.preventDefault(); run() })
    form.addEventListener('submit', (e) => { e.preventDefault(); if (!submit.disabled) run() })
  })
}

export { mount, clear }
