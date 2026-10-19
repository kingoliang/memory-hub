// 设置 · 蒸馏 LLM（可写）：OpenAI 兼容端点、模型、API Key（只写不读）、reasoning_effort、超时；「测试连接」与「保存」。
// 保存后立即生效（无需重启）。环境变量 MEMORY_LLM_* 已配置时整块只读并说明原因。

import { h } from '../dom.js'
import { get, put, post } from '../api.js'
import { guard, toast, errText } from '../dialogs.js'

const SOURCE_LABEL = { none: '未配置（memory_capture 降级为原文卡；经验闸门 strict 回退到启发式；图谱 AI 汇总不可用）', admin: '管理界面配置', env: '环境变量 MEMORY_LLM_*（只读）', file: '配置文件 memory-hub.json' }
const EFFORTS = [['', '（不传）'], ['none', 'none'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']]

const field = (label, ctl, help) => h('label', { class: 'set-field' }, [h('span', { class: 'set-field-label' }, label), ctl, help ? h('small', { class: 'sub' }, help) : null])

/** 由当前值构造表单（纯函数，便于测试）。 */
export function llmForm(cur) {
  const locked = !!cur.envLocked
  const dis = locked ? { disabled: true } : {}
  const baseUrl = h('input', { type: 'text', name: 'baseUrl', value: cur.baseUrl, placeholder: 'OpenAI 兼容地址，以 /v1 结尾（不含 /chat/completions）', autocomplete: 'off', maxlength: 500, ...dis })
  const model = h('input', { type: 'text', name: 'model', value: cur.model, placeholder: '如 deepseek-chat', autocomplete: 'off', maxlength: 200, ...dis })
  const key = h('input', { type: 'password', name: 'key', value: '', placeholder: cur.keySet ? '已设置（不显示）· 留空 = 保持不变' : '未设置 · 网关不需要可留空', autocomplete: 'new-password', ...dis })
  const clearKey = h('input', { type: 'checkbox', name: 'clearKey', ...dis })
  const effort = h('select', { name: 'reasoningEffort', ...dis }, EFFORTS.map(([v, l]) => h('option', { value: v, selected: v === (cur.reasoningEffort || '') }, l)))
  effort.value = cur.reasoningEffort || '' // 显式赋值：不依赖 option[selected] 的反射
  const timeout = h('input', { type: 'number', name: 'timeoutMs', value: String(cur.timeoutMs), min: 1000, max: 600000, step: 1000, ...dis })
  const rows = [
    field('接口地址 baseUrl', baseUrl, '与 model 都留空 = 关闭 LLM'),
    field('模型 model', model),
    field('API Key', key, '只写不读：保存后不会再显示。'),
    cur.keySet ? h('label', { class: 'check' }, [clearKey, h('span', null, '清除已保存的 API Key')]) : null,
    field('reasoning_effort', effort, '推理模型可设 none / low 省 token；不支持该参数的网关请留「不传」'),
    field('单次调用超时（毫秒）', timeout, '1000~600000，默认 90000'),
  ]
  const read = () => ({
    baseUrl: baseUrl.value.trim(), model: model.value.trim(),
    ...(key.value ? { key: key.value } : {}),
    ...(clearKey.checked ? { clearKey: true } : {}),
    reasoningEffort: effort.value, timeoutMs: Number(timeout.value),
  })
  return { rows, read, locked, controls: { baseUrl, model, key, clearKey, effort, timeout } }
}

export async function llmSection(ctx) {
  const cur = await get('settings/llm')
  const f = llmForm(cur)
  const status = h('p', { class: 'sub', role: 'status' }, [h('strong', null, '当前：'), SOURCE_LABEL[cur.source] || cur.source, cur.model ? ` · ${cur.model}` : '', cur.keySet ? ' · Key 已设置' : ''])
  const result = h('div', { class: 'set-llm-result', role: 'status', hidden: true })
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
  const showResult = (r) => {
    result.removeAttribute('hidden')
    result.className = 'set-llm-result ' + (r.ok ? 'ok' : 'bad')
    result.textContent = r.ok ? `连接成功 · ${r.model} · ${r.ms} ms${r.reply ? ` · 回复「${r.reply}」` : ''}` : `连接失败 · ${r.error}`
  }
  const testBtn = h('button', { type: 'button', class: 'btn' }, '测试连接')
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary' }, '保存 LLM 设置')
  if (f.locked) { testBtn.disabled = false; saveBtn.disabled = true }
  testBtn.addEventListener('click', guard([testBtn, saveBtn], async () => {
    err.setAttribute('hidden', '')
    result.removeAttribute('hidden'); result.className = 'set-llm-result'; result.textContent = '连接中…'
    try { showResult(await post('settings/llm/test', f.locked ? {} : f.read())) } catch (e) { result.setAttribute('hidden', ''); err.textContent = errText(e); err.removeAttribute('hidden') }
  }))
  saveBtn.addEventListener('click', guard([testBtn, saveBtn], async () => {
    err.setAttribute('hidden', '')
    try {
      const r = await put('settings/llm', f.read())
      toast('ok', r.changed.length ? `已保存（${r.changed.join('、')}），立即生效` : '没有改动')
      ctx.reload()
    } catch (e) { err.textContent = errText(e); err.removeAttribute('hidden') }
  }))
  return [
    status,
    f.locked ? h('p', { class: 'sub' }, 'LLM 由服务器环境变量 MEMORY_LLM_* 配置，界面只读；要在这里配置，请先去掉这些环境变量并重启服务。') : null,
    h('form', { class: 'set-form set-llm', 'aria-label': 'LLM 设置' }, f.rows),
    result, err,
    h('div', { class: 'set-save' }, [saveBtn, testBtn, h('span', { class: 'sub' }, '保存后立即生效，无需重启；记入审计日志（不含 Key）。')]),
  ]
}
