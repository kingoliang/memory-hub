// memory-hub · OpenAI 兼容 LLM 适配器（蒸馏用）。
//
// 为 capture.js 的 summarizeTurn 提供同形状的 llm 对象：
//   - listProviders() / listModels() → 供 routeCandidates 解析路由
//   - stream(options) → async iterable，yield 纯文本 chunk
//
// 配置（环境变量或 memory-hub.json，见 src/config.js）：
//   MEMORY_LLM_BASE_URL  OpenAI 兼容端点（不含 /chat/completions）
//   MEMORY_LLM_MODEL     模型名
//   MEMORY_LLM_KEY       API key（本地端点可留空；只从环境变量或 0600 配置文件读取，不写日志）
// 缺 BASE_URL 或 MODEL 时 createLlmFromEnv() 返回 null：capture 降级为存原文卡，recall 不受影响。

function flatContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
      .filter(Boolean)
      .join('\n')
  }
  return String(content ?? '')
}

/**
 * 上游错误体进日志前先脱敏：有的网关会回显/掩码 key（如 "Your api key: ****dLtw is invalid"），
 * 连尾号也不应进入我们的日志。去掉本 key 的原文、星号掩码片段、以及常见 key 形状（sk-…/mh_…）。
 */
export function scrubUpstream(text, apiKey = '') {
  let t = String(text ?? '')
  if (apiKey) t = t.split(apiKey).join('[key]')
  return t
    .replace(/\*{2,}[A-Za-z0-9_-]{2,}/g, '[masked]')
    .replace(/\b(?:sk|mh)[-_][A-Za-z0-9_-]{8,}/g, '[key]')
}

export function createOpenAiLlm({ baseUrl, apiKey = '', model, purpose = 'memory-capture' } = {}) {
  if (!baseUrl || !model) return null
  const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions'

  return {
    purpose,

    listProviders() {
      return [{ id: 'openai-compat' }]
    },

    async listModels() {
      return [{ id: model }]
    },

    /**
     * 非流式调用，整体作为单个 chunk yield（capture 的蒸馏一次性输出 JSON，
     * 无需逐 token 流式）。signal 超时/中断会向上抛出。
     */
    async *stream(options = {}) {
      const messages = []
      if (options.system) messages.push({ role: 'system', content: options.system })
      for (const m of options.messages ?? []) {
        messages.push({ role: m?.role ?? 'user', content: flatContent(m?.content) })
      }
      const body = {
        model: options.model || model,
        messages,
        max_tokens: options.maxTokens ?? 900,
        stream: false,
      }
      const headers = { 'Content-Type': 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal ?? undefined,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`LLM ${res.status}: ${scrubUpstream(detail, apiKey).slice(0, 300)}`)
      }
      const data = await res.json()
      const text = data?.choices?.[0]?.message?.content ?? ''
      if (text) yield text
    },
  }
}

export function createLlmFromEnv(env = process.env) {
  // 只认 MEMORY_LLM_*：不回退到 OPENAI_* 之类的通用变量，避免误把无关 key 发给不相干的端点
  const baseUrl = env.MEMORY_LLM_BASE_URL || ''
  const apiKey = env.MEMORY_LLM_KEY || ''
  const model = env.MEMORY_LLM_MODEL || ''
  if (!baseUrl || !model) return null
  return createOpenAiLlm({ baseUrl, apiKey, model })
}
