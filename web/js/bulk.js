// 列表多选 + 批量操作条。选择状态在内存里，不写 DOM 之外的任何地方。

import { h } from './dom.js'
import { guard, toast, errText } from './dialogs.js'

export function createSelection() {
  const set = new Set()
  const listeners = []
  const boxes = new Map()
  const notify = () => listeners.forEach((fn) => fn(set.size))
  return {
    set,
    onChange: (fn) => listeners.push(fn),
    checkbox(path, label) {
      const cb = h('input', { type: 'checkbox', 'aria-label': `选择 ${label || path}` })
      cb.addEventListener('change', () => { if (cb.checked) set.add(path); else set.delete(path); notify() })
      boxes.set(path, cb)
      return cb
    },
    selectAll(on) {
      for (const [p, cb] of boxes) { cb.checked = on; if (on) set.add(p); else set.delete(p) }
      notify()
    },
    paths: () => [...set],
    get size() { return set.size },
    total: () => boxes.size,
  }
}

/**
 * 批量操作条。actions: [{label, tone:'primary'|'danger'|'', run:(paths)=>Promise}]
 * run 内部自己负责确认对话框与 API；返回 false 表示用户取消（不提示、不刷新）。
 * 点击期间整条操作条的按钮全部禁用（防重复提交）。
 */
export function bulkBar(sel, actions, { reload } = {}) {
  const count = h('span', { class: 'bulk-count' }, '未选择')
  const all = h('input', { type: 'checkbox', 'aria-label': '全选本页' })
  const btns = actions.map((a) => h('button', { type: 'button', class: 'btn ' + (a.tone === 'danger' ? 'btn-danger' : a.tone === 'primary' ? 'btn-primary' : 'btn-ghost'), disabled: true }, a.label))
  const refresh = (n) => {
    count.textContent = n ? `已选 ${n} / ${sel.total()} 项` : '未选择'
    for (const b of btns) b.disabled = n === 0
    all.checked = n > 0 && n === sel.total()
  }
  sel.onChange(refresh)
  all.addEventListener('change', () => sel.selectAll(all.checked))
  btns.forEach((b, i) => {
    const run = guard(btns, async () => {
      const paths = sel.paths()
      if (!paths.length) return
      try {
        const r = await actions[i].run(paths)
        if (r === false) return
        reload?.()
      } catch (e) { toast('bad', errText(e)) }
    })
    b.addEventListener('click', run)
  })
  return h('div', { class: 'bulk-bar', role: 'toolbar', 'aria-label': '批量操作' }, [h('label', { class: 'check' }, [all, h('span', null, '全选')]), count, h('div', { class: 'bulk-actions' }, btns)])
}

/** 批量结果提示：已处理 N 张；跳过 M 张（原因）。 */
export function reportBatch(r, verb) {
  const skipped = r.skipped?.length || 0
  toast(skipped ? 'warn' : 'ok', `${verb} ${r.affected} 张${skipped ? `；跳过 ${skipped} 张（${[...new Set(r.skipped.map((s) => s.message))].join('、')}）` : ''}`)
}
