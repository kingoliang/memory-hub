// memory-hub · 管理界面配置蒸馏 LLM（docs/decisions/2026-10-19-llm-settings-in-admin.md）
//   GET  /admin/api/settings/llm       当前生效值（key 只给「已设置 / 未设置」）
//   PUT  /admin/api/settings/llm       保存到 <home>/llm-settings.json（0600，原子写），立即生效
//   POST /admin/api/settings/llm/test  用表单值连一次（key 留空用已保存的），返回成败与耗时
// key 永远不出现在响应、日志、审计里。环境变量 MEMORY_LLM_* 优先，设置了就锁定（409）。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DEFAULT_LLM_TIMEOUT_MS, LLM_SETTINGS_FILE, readLlmSettingsFile } from '../config.js'
import { createOpenAiLlm, scrubUpstream } from '../core/llm-openai.js'
import { writeLog } from '../core/writelog.js'
import { HttpError } from './errors.js'

const EFFORTS = ['none', 'low', 'medium', 'high']
const FIELDS = ['baseUrl', 'model', 'key', 'clearKey', 'reasoningEffort', 'timeoutMs']
const CTRL = /[\u0000-\u001f\u007f]/
const TEST_TIMEOUT_MS = 20000

const bad = (msg) => new HttpError(400, 'bad_request', msg)

/** 回显用：去掉查询串与 # 片段（有的网关把 key 放在查询串里）。 */
const displayUrl = (u) => { try { const x = new URL(u); x.search = ''; x.hash = ''; return x.toString().replace(/\/$/, '') } catch { return '' } }

/** 当前生效值的对外视图（不含 key）。 */
export function llmView(config) {
  const l = config.llm
  const r = config.llmRequest || {}
  return {
    source: config.llmSource || (l ? 'file' : 'none'),
    envLocked: !!config.llmEnvLocked,
    baseUrl: l ? displayUrl(l.baseUrl) : '',
    model: l ? l.model : '',
    keySet: !!l?.apiKey,
    reasoningEffort: l ? r.reasoningEffort || '' : '',
    timeoutMs: l ? r.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS : DEFAULT_LLM_TIMEOUT_MS,
  }
}

function checkUrl(u) {
  let x
  try { x = new URL(u) } catch { throw bad('baseUrl 必须是 http:// 或 https:// 地址') }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') throw bad('baseUrl 必须是 http:// 或 https:// 地址')
  if (x.username || x.password) throw bad('baseUrl 不能包含用户名或口令（凭据请填在 API Key）')
}

/** 校验请求体（PUT 与 test 共用）。返回规范化后的值；key 为 undefined 表示「沿用已保存的」。 */
export function parseLlmInput(input, { requireModelPair = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('请求体必须是 JSON 对象')
  const unknown = Object.keys(input).filter((k) => !FIELDS.includes(k))
  if (unknown.length) throw bad(`不支持的字段：${unknown.join('、')}`)
  const s = (k) => {
    if (input[k] === undefined || input[k] === null) return ''
    if (typeof input[k] !== 'string') throw bad(`${k} 必须是字符串`)
    return input[k].trim()
  }
  const baseUrl = s('baseUrl')
  const model = s('model')
  if (requireModelPair) {
    if (baseUrl && !model) throw bad('填了 baseUrl 就必须填 model（两者都留空 = 关闭 LLM）')
    if (model && !baseUrl) throw bad('填了 model 就必须填 baseUrl（两者都留空 = 关闭 LLM）')
  }
  if (baseUrl) checkUrl(baseUrl)
  if (model.length > 200 || CTRL.test(model)) throw bad('model 最长 200 字符，且不能含控制字符')
  let key
  if (input.key !== undefined && input.key !== null && input.key !== '') {
    if (typeof input.key !== 'string') throw bad('key 必须是字符串')
    if (CTRL.test(input.key)) throw bad('key 不能包含换行或控制字符')
    if (input.key.length > 4096) throw bad('key 最长 4096 字符')
    key = input.key.trim()
  }
  const clearKey = input.clearKey === true
  const reasoningEffort = s('reasoningEffort').toLowerCase()
  if (reasoningEffort && !EFFORTS.includes(reasoningEffort)) throw bad('reasoningEffort 只能是 none / low / medium / high 或留空')
  let timeoutMs = DEFAULT_LLM_TIMEOUT_MS
  if (input.timeoutMs !== undefined && input.timeoutMs !== null && input.timeoutMs !== '') {
    const n = Number(input.timeoutMs)
    if (!Number.isInteger(n) || n < 1000 || n > 600000) throw bad('timeoutMs 必须是 1000~600000 的整数（毫秒）')
    timeoutMs = n
  }
  return { baseUrl, model, key, clearKey, reasoningEffort, timeoutMs }
}

/** 原子写 0600：先写临时文件（0600）再 rename，不会出现「半个文件」或「短暂 0644」。 */
function writeSecretJson(file, obj) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
}

/**
 * 管理界面的 LLM 设置。config 是服务进程共享的配置对象：保存后原地更新 config.llm / llmRequest / llmSource，
 * 各处按 config 现建适配器，于是下一次请求就生效。
 */
export function createLlmSettings({ config, log }) {
  const home = config.home
  const file = path.join(home, LLM_SETTINGS_FILE)

  function apply(saved) {
    const on = !!(saved.baseUrl && saved.model)
    config.llm = on ? { baseUrl: saved.baseUrl, model: saved.model, apiKey: saved.key || '' } : null
    config.llmRequest = { ...(config.llmRequest || {}), reasoningEffort: on ? saved.reasoningEffort || '' : '', timeoutMs: on ? saved.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS : DEFAULT_LLM_TIMEOUT_MS }
    config.llmSource = on ? 'admin' : 'none'
  }

  function get() { return llmView(config) }

  function put(actor, input) {
    if (config.llmEnvLocked) throw new HttpError(409, 'llm_env_locked', 'LLM 由环境变量 MEMORY_LLM_* 配置，界面不能修改；要在界面里配置，请先去掉这些环境变量并重启')
    const v = parseLlmInput(input)
    const prev = readLlmSettingsFile(home) || { baseUrl: '', model: '', key: '', reasoningEffort: '', timeoutMs: DEFAULT_LLM_TIMEOUT_MS }
    const prevTimeout = prev.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
    const next = {
      baseUrl: v.baseUrl, model: v.model,
      key: v.clearKey ? '' : v.key !== undefined ? v.key : prev.key || '',
      reasoningEffort: v.reasoningEffort, timeoutMs: v.timeoutMs,
    }
    const changed = []
    if (next.baseUrl !== prev.baseUrl) changed.push('baseUrl')
    if (next.model !== prev.model) changed.push('model')
    if (next.key !== (prev.key || '')) changed.push('key')
    if (next.reasoningEffort !== (prev.reasoningEffort || '')) changed.push('reasoningEffort')
    if (next.timeoutMs !== prevTimeout) changed.push('timeoutMs')
    if (changed.length) {
      writeSecretJson(file, { ...next, updatedAt: new Date().toISOString(), updatedBy: actor.name })
      apply(next)
      try {
        writeLog(config.dbRoot, { actorType: 'admin', actorId: actor.id, actorName: actor.name, ip: actor.ip, outcome: 'ok', tool: 'PUT /settings/llm', action: 'llm_settings_update', args: { changed, model: next.model, host: next.baseUrl ? new URL(next.baseUrl).host : '' } })
      } catch (e) { log.error('write_log 写入失败', { action: 'llm_settings_update', error: String(e?.message || e).slice(0, 200) }) }
      log.info('管理员修改 LLM 设置', { changed, model: next.model, keySet: !!next.key, actor: actor.id })
    }
    return { ok: true, changed, llm: llmView(config) }
  }

  /** 用表单值连一次。表单 key 留空：沿用当前生效的 key（不论来自界面还是环境变量）。 */
  async function test(input) {
    const v = parseLlmInput(input || {}, { requireModelPair: false })
    const baseUrl = v.baseUrl || config.llm?.baseUrl || ''
    const model = v.model || config.llm?.model || ''
    if (!baseUrl || !model) throw bad('请先填写 baseUrl 与 model')
    const apiKey = v.clearKey ? '' : v.key !== undefined ? v.key : config.llm?.apiKey || ''
    const reasoningEffort = v.reasoningEffort || (v.baseUrl ? '' : config.llmRequest?.reasoningEffort || '')
    const llm = createOpenAiLlm({ baseUrl, model, apiKey, reasoningEffort, timeoutMs: TEST_TIMEOUT_MS })
    const t0 = Date.now()
    try {
      let text = ''
      for await (const chunk of llm.stream({ system: '只回复 pong', messages: [{ role: 'user', content: 'ping' }], maxTokens: 16, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) })) {
        if (typeof chunk === 'string') text += chunk
      }
      return { ok: true, model, ms: Date.now() - t0, reply: text.slice(0, 80) }
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      const msg = timedOut ? `连接超时（${TEST_TIMEOUT_MS / 1000} 秒）` : scrubUpstream(String(e?.cause?.code || e?.message || e), apiKey).slice(0, 300)
      return { ok: false, model, ms: Date.now() - t0, error: msg }
    }
  }

  return { get, put, test }
}
