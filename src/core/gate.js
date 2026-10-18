// memory-hub · 经验闸门：只让「提炼过的、经验性质」的内容入库。
//
// 设计见 docs/decisions/2026-10-18-experience-gate.md。
//
// 为什么需要它：上游只靠 MIN_CLEAN_CHARS + DURABLE_SIGNALS + 模型自觉，拦不住日常操作
// ——"跑了一遍 npm test，全绿"字数够、也含"完成"类词，会被存成没有复用价值的卡。
//
// 三道防线，越靠前越便宜：
//   1. heuristicGate  纯函数打分（经验信号 − 日常信号）。明确 routine 直接丢，连模型都不调。
//   2. llmGate        只在 heuristic 判 unknown 且 mode=strict 时问一次二元问题。
//   3. 蒸馏          闸门放行的内容仍走原有蒸馏，日常部分由它压缩掉。
//
// 判定原则：**一个 turn 里只要有一处经验就算经验**，不要求整段都是经验。
// 因此闸门看的是"有没有经验句"，不是"这段是不是经验"。

/** 闸门模式。off 全放行；heuristic 只跑纯函数；strict 允许在 unknown 时问模型。 */
export const GATE_MODES = ['off', 'heuristic', 'strict']
/** 判定结果，数组顺序 = 分值升序。 */
export const VERDICTS = ['routine', 'unknown', 'experience']
export const EXPERIENCE_SIGNALS = ['marker', 'causal', 'decision', 'lesson', 'reusable', 'artifact', 'quantity']
export const ROUTINE_SIGNALS = ['tool-log', 'status-only', 'chatter']
export const KEEP_SCORE = 2
export const DROP_SCORE = -2
/** capture/ingest 被闸门挡下时统一的 reason 字面量（对外契约，别改字）。 */
export const ROUTINE_REASON = 'gate:routine'

const WEIGHTS = {
  marker: 2, causal: 1, decision: 2, lesson: 2, reusable: 1, artifact: 1, quantity: 1,
  'tool-log': -2, 'status-only': -2, chatter: -2,
}

// 「经验」信号：出现即加分。写成字面量正则，便于逐条 review 与变异测试。
const EXPERIENCE_PATTERNS = {
  // 显式经验标记行（"结论："、"教训："…）
  marker: /(?:^|[\s\n])(?:经验|结论|决定|判断|教训|注意|约定|偏好|原则|规则|建议|推荐|要点|总结|对策)\s*[:：]/,
  // 因果 / 理由
  causal: /因为|所以|因此|由于|原因|根因|导致|是为了|否则|后果/,
  // 取舍与方案
  decision: /决定|选定|采用|方案|取舍|权衡|不采用|改为|换成|替代|对策|做法/,
  // 约束 / 教训（"必须"、"不要"、"踩坑"…）
  lesson: /踩坑|教训|坑\b|报错|异常|失败|修复|解决|绕过|反模式|不要用|别再|必须|不要|否则|注意/,
  // 可复用的名词
  reusable: /流程|步骤|命令|脚本|配置|参数|接口|字段|表结构|架构|机制|原理|算法|协议|规范|依赖|版本/,
  // 代码块 / 代码片段 / 文件路径 / 带扩展名的文件
  artifact: /```|`[^`]+`|\b[\w./-]+\.(?:js|mjs|cjs|ts|tsx|py|java|md|json|ya?ml|sql|sh|toml)\b|(?:^|\s)[\w.@-]+(?:\/[\w.@-]+)+/,
  // 带单位的数值 / 语义化版本（裸"368"不算，"10 分钟"、"1.2.3" 算）
  quantity: /\bv?\d+\.\d+(?:\.\d+)?\b|\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒|分钟|小时|MB|GB|KB|%|次|个|行|张|条|倍|分)/,
}

// 「日常」信号：出现即减分。
/** 单行像工具输出 / 命令 / 用例结果。 */
const TOOL_LINE = /^\s*(?:\$\s|>\s|→|\+{3}|-{3}|@@|(?:PASS|FAIL)\b|ok\s+\d+|not ok\b|\d+\s+(?:passing|failing)\b|(?:npm|pnpm|yarn|mvn|gradle|git|node|npx|ls|cd|cat|curl|docker|kubectl|brew|uv|pip)\b|(?:M|A|D|R|\?\?)\s+\S)/i
/** 纯状态汇报的口气（不看内容细节，只报了"做了什么 / 结果如何"）。 */
const STATUS_ONLY = /跑了一遍|跑完了|执行完|全部通过|全绿|都正常|没问题|没报错|已经(?:改|做|跑|看|检查)了|看了一下|看了一遍|检查了一遍|都在|就这些/
/** 纯寒暄行。 */
const CHATTER_LINE = /^(?:好的|收到|明白|嗯+|ok|okay|行|好)[。！？~,.、，；:：\s]*(?:收到|明白|好的|嗯+)?[。！？~,\s]*$/i

const linesOf = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean)

/**
 * 纯函数启发式判定。不调模型、不碰 IO，可安全用于客户端预筛。
 * @param {unknown} text
 * @returns {{verdict:'routine'|'unknown'|'experience', score:number, signals:string[]}}
 */
export function heuristicGate(text) {
  // 非字符串 / 空白 = 没法判 → 按 routine（默认丢，宁缺勿滥）
  if (typeof text !== 'string' || !text.trim()) return { verdict: 'routine', score: 0, signals: [] }

  const lines = linesOf(text)
  const signals = []
  for (const [name, re] of Object.entries(EXPERIENCE_PATTERNS)) if (re.test(text)) signals.push(name)

  // 日常侧：工具输出行占比高（且行数够多，免得单行命令被当成"全是工具输出"）
  const toolLines = lines.filter((l) => TOOL_LINE.test(l)).length
  if (lines.length >= 3 && toolLines / lines.length >= 0.5) signals.push('tool-log')
  if (STATUS_ONLY.test(text)) signals.push('status-only')
  if (lines.length > 0 && lines.every((l) => CHATTER_LINE.test(l))) signals.push('chatter')

  signals.sort()
  const score = signals.reduce((sum, s) => sum + WEIGHTS[s], 0)
  const verdict = score >= KEEP_SCORE ? 'experience' : score <= DROP_SCORE ? 'routine' : 'unknown'
  return { verdict, score, signals }
}

const GATE_SYSTEM = [
  '你在做「记忆入库闸门」判定：判断这段对话增量里有没有值得长期留存的**经验**。',
  '算经验：决策与理由、方案取舍、踩坑与根因、可复用的流程/命令/配置、用户偏好与项目约定、具体参数或版本。',
  '不算经验：跑命令、看文件、列清单、状态汇报（"跑了一遍，全绿"）、打招呼、只有工具输出。',
  '只要任意一处算经验就 keep=true（日常部分后面会被压缩掉）。',
  '只输出 JSON，不要解释：{"keep":true|false,"reason":"不超过 20 字"}',
].join('\n')

/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 围栏与前后废话）。 */
export function parseGateReply(text) {
  const s = String(text ?? '')
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const body = fence ? fence[1] : s
  const m = /\{[\s\S]*?\}/.exec(body)
  if (!m) return null
  let parsed
  try { parsed = JSON.parse(m[0]) } catch { return null }
  if (typeof parsed?.keep !== 'boolean') return null
  return { keep: parsed.keep, reason: String(parsed.reason ?? '') }
}

/**
 * 问模型一次二元问题。任何异常（无 llm / 网络 / 超时 / 不可解析）都返回 null，
 * 由调用方决定降级 —— 绝不因为模型抖动丢内容。
 */
export async function llmGate(llm, text, { signal } = {}) {
  if (!llm?.stream) return null
  const timeoutMs = Number(llm.timeoutMs) > 0 ? Number(llm.timeoutMs) : 30_000
  try {
    let out = ''
    const stream = llm.stream({ system: GATE_SYSTEM, messages: [{ role: 'user', content: String(text) }], maxTokens: 120, signal: signal ?? AbortSignal.timeout(timeoutMs) })
    for await (const chunk of stream) {
      if (typeof chunk === 'string') out += chunk
      else if (chunk?.type === 'text') out += chunk.text ?? ''
    }
    return parseGateReply(out)
  } catch { return null }
}

/**
 * 按模式判定。
 * @returns {Promise<{verdict:'routine'|'unknown'|'experience', via:'off'|'heuristic'|'llm', score:number, signals:string[], reason?:string}>}
 */
export async function gateText(text, { mode = 'heuristic', llm = null, signal } = {}) {
  const m = GATE_MODES.includes(mode) ? mode : 'heuristic'
  if (m === 'off') return { verdict: 'experience', via: 'off', score: 0, signals: [] }

  const h = heuristicGate(text)
  if (h.verdict !== 'unknown') return { ...h, via: 'heuristic' }

  // unknown：strict 且有模型时问模型；否则放行（capture 是显式意图，ingest 的 unknown 也倾向保留）
  if (m === 'strict' && llm) {
    const judged = await llmGate(llm, text, { signal })
    if (judged) {
      return { verdict: judged.keep ? 'experience' : 'routine', via: 'llm', score: h.score, signals: h.signals, reason: judged.reason }
    }
  }
  return { ...h, verdict: 'experience', via: 'heuristic' }
}
