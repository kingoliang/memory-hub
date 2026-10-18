// memory-hub · 沉淀管线（MCP memory_capture / CLI 共用）。
//
// 判定链：降噪 → 长度闸 → 疑似明文密钥拒绝 → LLM 蒸馏（配置了 OpenAI 兼容端点时）→ 新建/追加/跳过
//         → 失败或未配置时降级为原文卡（kind=content, tags=['raw']）。
//
// 与上游 memory-eternal 的差异：
//   - 署名 submittedBy 由调用方（令牌名 / stdio 身份）传入，`source` 只是自由文本标签，**不参与审核豁免判定**；
//   - 审核状态只由 DB config 表（auditMode / auditExemptAgents / auditExemptKinds）+ submittedBy 决定，
//     不再读取 DSH 共享配置文件，也不读 MEMORY_AUDIT_* 环境变量；
//   - 蒸馏 LLM 由调用方注入（通用 OpenAI 兼容端点），未配置则降级。

import { captureCard, captureUpdate, pickNeighbors, summarizeTurnDetailed, routeCandidates, maxTokenLadder, DEFAULT_CAPTURE_MAX_TOKENS, DISTILL_RETRY_CEILING, stripRuntimeNoise, hasUsableContent, deriveTitle, isUsableTitle } from './capture.js'
import { gateText, ROUTINE_REASON } from './gate.js'
import { createLlmFromEnv } from './llm-openai.js'
import { DEFAULT_LLM_TIMEOUT_MS } from '../config.js'
import { resolveDedupConfig } from './dedup-config.js'
import { enforceAudit, getDb } from './db.js'
import { detectSecrets } from './tidy.js'
import { truncateAtBoundary, normalizeLiteralEscapes } from './vault.js'
import { getLogger } from '../logger.js'

/**
 * 沉淀一段文本到库。
 * @param {string} vaultRoot 数据目录（含 memory-eternal.db）
 * @param {string} text
 * @param {{source?: string, submittedBy?: string, llm?: object|null, env?: object, minChars?: number, log?: object}} [opts]
 *   submittedBy 缺省时回落为 source || 'agent'（兼容旧调用方；hub 的 MCP 路径总是显式传令牌名）
 * @returns {Promise<{ok:boolean, action:'created'|'appended'|'skipped'|'failed', path?:string, reason?:string, degraded?:boolean, secretTypes?:string[]}>}
 */
export async function runStandaloneCapture(vaultRoot, text, { source = '', submittedBy, llm, env = process.env, minChars = 120, log = getLogger(), gateMode = 'heuristic', owner = '', team = '', visibility = '' } = {}) {
  const author = String(submittedBy || source || 'agent')
  const llmClient = llm === undefined ? createLlmFromEnv(env) : llm
  // 归属三元组随卡落库（团队可见性语义，见 docs/decisions/2026-10-18-team-scope-own-first-recall.md）
  const scope = { owner: String(owner || ''), team: String(team || ''), visibility: String(visibility || '') }
  // 入料噪声闸门（P0）：先剥运行时注入，再判断是否还有真实内容。
  const clean = stripRuntimeNoise(text)
  if (clean.length < minChars) return { ok: false, action: 'skipped', reason: 'text too short' }
  if (!hasUsableContent(clean)) return { ok: false, action: 'skipped', reason: 'text is runtime noise' }

  // 经验闸门：只让「提炼过的、经验性质」的内容进蒸馏。明确是日常操作 → 直接丢，连模型都不调。
  if (gateMode !== 'off') {
    const gate = await gateText(clean, { mode: gateMode, llm: llmClient })
    if (gate.verdict === 'routine') {
      log.info('capture 跳过：闸门判定为日常操作', { actor: author, via: gate.via, score: gate.score, signals: gate.signals, inputChars: clean.length })
      return { ok: true, action: 'skipped', reason: ROUTINE_REASON, gate: { verdict: gate.verdict, via: gate.via, score: gate.score, signals: gate.signals } }
    }
  }

  const title = deriveTitle(clean)
  if (!isUsableTitle(title)) return { ok: false, action: 'skipped', reason: 'cannot derive a usable title' }

  // 疑似明文密钥：拒绝写入。只报命中的类型，绝不回显、不记录值（密钥一旦入库就会经 recall 扩散给所有 Agent）。
  const secretTypes = detectSecrets(clean)
  if (secretTypes.length) {
    log.warn('capture 拒绝：疑似明文密钥', { actor: author, secretTypes })
    return {
      ok: false,
      action: 'skipped',
      reason: `疑似明文密钥（类型：${secretTypes.join(', ')}），已拒绝写入。请只记录密钥的存放位置与取用方式，不要写入值。`,
      secretTypes,
    }
  }

  const dd = resolveDedupConfig(env)
  const dupOpts = { threshold: dd.threshold, env }
  const routes = llmClient ? await routeCandidates(llmClient, {}) : []
  const route = routes[0] ?? null

  // 有 LLM：蒸馏判定链
  if (llmClient && route) {
    try {
      const neighbors = await pickNeighbors(vaultRoot, { title: '', body: clean.slice(0, 400) }, 8)
      const { detailed, attempts, outBudget } = await distillWithRetry(llmClient, route, clean, neighbors, log)
      let result = detailed.card
      if (detailed.failure) {
        const f = detailed.failure
        log.warn(f.category === 'invalid_card' ? '蒸馏结果不合格，降级为原文卡' : '蒸馏失败，降级为原文卡', {
          provider: route.provider, model: route.model, code: f.code, category: f.category, message: f.message,
          inputChars: f.inputChars, attempts, outBudget, finishReason: f.finishReason,
          usageIn: f.usage?.prompt, usageOut: f.usage?.completion, usageReasoning: f.usage?.reasoning,
        })
      } else if (detailed.skip) {
        // 预筛跳过（太短 / 噪声 / 无复用信号）：没调模型，直接落原文卡。留一条决策日志，别让它静默。
        log.info('蒸馏跳过，降级为原文卡', { reason: detailed.skip, inputChars: clean.length })
      }
      // 模型判定「属于已有卡」：输出形如 {append_to, update}，**没有 save 字段**（见 cardFromParsedJson），
      // 所以必须在 save===true 分支之前处理——此前它两个分支都不命中，被无声落成原文卡。
      if (result && result.append_to) {
        const applied = await applyModelAppend(vaultRoot, result, { dd, author, clean, log })
        if (applied.done) return applied.done
        result = applied.result // 新建卡 {save:true,…}，或 null（密钥 → 落原文卡）
      }
      if (result && result.save === true) {
        const card = { kind: result.kind, title: result.title, tags: result.tags, body: result.body, source, status: 'pending', submittedBy: author, severity: 'info', reason: 'AI 自动沉淀（蒸馏卡）', ...scope }
        const out = await captureCard(vaultRoot, card, dupOpts)
        if (out.ok) return { ok: true, action: 'created', path: out.path ?? out.rel }
        if (out.duplicate) return handleDuplicate(vaultRoot, out.duplicate, `${result.title}\n${result.body}`, dd, undefined, card, log)
        return { ok: false, action: 'failed', reason: String(out.reason || 'write failed') }
      }
      if (result && result.save === false) return { ok: true, action: 'skipped', reason: 'model judged not durable' }
      // 第三条静默降级：模型给出 append_to 追加指令时，cardFromParsedJson 返回的对象没有 save 字段，
      // 上面两个分支都不命中，会无声落入原文卡。本次只补可见性日志，不改行为（是否真正执行追加需另行决策）。
      if (result) log.warn('蒸馏结果未被处理（无 save 字段，如 append_to 追加指令），降级为原文卡', { keys: Object.keys(result), hasAppendTo: !!result.append_to, inputChars: clean.length })
    } catch (error) {
      // LLM 失败 → 落入降级路径，不能让一次网络抖动丢掉沉淀
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      log.warn('蒸馏调用异常，降级为原文卡', { provider: route.provider, model: route.model, category: timedOut ? 'timeout' : 'error', inputChars: clean.length, error: String(error?.message || error).slice(0, 200) })
    }
  }

  // 降级：无 LLM（或 LLM 调用失败）→ 原文卡
  const rawCard = {
    kind: 'content',
    title,
    tags: ['raw'],
    body: clean,
    source: source || 'manual',
    status: 'pending',
    submittedBy: author,
    severity: 'info',
    reason: 'AI 自动沉淀（原文卡）',
    ...scope,
  }
  const out = await captureCard(vaultRoot, rawCard, dupOpts)
  if (out.ok) return { ok: true, action: 'created', path: out.path ?? out.rel, degraded: true }
  if (out.duplicate) return { ...(await handleDuplicate(vaultRoot, out.duplicate, clean, dd, truncateAtBoundary(clean, 400), rawCard, log)), degraded: true }
  return { ok: false, action: 'failed', reason: String(out.reason || 'write failed') }
}

/**
 * 处理模型的 {append_to, update} 指令（语义同上游 memory-eternal：追加到已有卡，而不是新建）。
 *  - 目标必须是主库（cards）里未删除的卡；否则 WARN 并改为「新建」一张知识卡（正文取 update），不落 raw；
 *  - update 是模型产出的文本，同样过密钥检测；命中则拒绝追加并落原文卡（clean 已在入口过检测）；
 *  - 实际追加复用 handleDuplicate（与去重命中同一条路径）：auditMode 允许免审且开了 merge → 合并进正文
 *    （受 mergeIntoCard 的行数 / 行长上限保护）；否则只追加 card_updates 更新记录，不改已批准卡正文。
 * @returns {Promise<{done?:object, result?:object|null}>}
 */
async function applyModelAppend(vaultRoot, result, { dd, author, clean, log }) {
  const target = String(result.append_to || '').trim()
  const update = String(result.update || '').trim()
  const secretTypes = detectSecrets(update)
  if (secretTypes.length) {
    log.warn('蒸馏追加内容含疑似明文密钥，拒绝追加，降级为原文卡', { actor: author, target, secretTypes })
    return { result: null }
  }
  const row = target ? getDb(vaultRoot).prepare('SELECT kind FROM cards WHERE path = ? AND deleted_at IS NULL').get(target) : null
  if (!row) {
    log.warn('蒸馏追加目标无效（不在主库或已删除），改为新建卡', { actor: author, target })
    const title = [deriveTitle(update), deriveTitle(clean)].find((t) => isUsableTitle(t))
    if (!title) return { result: null }
    return { result: { save: true, kind: 'knowledge', title, tags: [], body: `# ${title}\n\n${update}` } }
  }
  const out = await handleDuplicate(vaultRoot, { store: 'main', path: target, via: 'model-append', score: 1 }, update, dd, undefined, { kind: row.kind, submittedBy: author, status: 'pending' }, log)
  log.info('蒸馏追加到已有卡', { actor: author, path: target, merged: out.merged })
  return { done: out }
}

/** 这些失败类别是「输出预算不够 / 输出残缺」，加大 max_tokens 重试有意义。 */
const RETRYABLE_CATEGORIES = new Set(['empty', 'length', 'truncated'])

/**
 * 蒸馏 + 阶梯重试：max_tokens 2000→4000→8000，总共最多 3 次调用。
 *  - 只对 empty / length / truncated 重试；invalid_json / invalid_card / error 重试也大概率同样失败，直接降级。
 *  - timeout（调用抛 TimeoutError/AbortError）**不重试**：单次已等了 timeoutMs（默认 90s），再试一次只会让
 *    摄入请求的尾延迟翻倍，而超时通常是上游整体慢 / 不可用，重试收益低。异常向上抛，由调用方降级。
 *  - 重试发生在任何建卡动作之前（本函数只调模型），所以不会重复建卡；幂等 / 去重 / 冷却都在其外层，不受影响。
 */
async function distillWithRetry(llmClient, route, clean, neighbors, log) {
  const timeoutMs = Number(llmClient.timeoutMs) > 0 ? Number(llmClient.timeoutMs) : DEFAULT_LLM_TIMEOUT_MS
  const budgets = [DEFAULT_CAPTURE_MAX_TOKENS, ...maxTokenLadder(DEFAULT_CAPTURE_MAX_TOKENS, DISTILL_RETRY_CEILING)]
  let detailed
  let attempts = 0
  for (const maxTokens of budgets) {
    attempts++
    detailed = await summarizeTurnDetailed(llmClient, route, clean, { existing: neighbors, maxTokens, signal: AbortSignal.timeout(timeoutMs) })
    const f = detailed.failure
    if (!f || !RETRYABLE_CATEGORIES.has(f.category)) return { detailed, attempts, outBudget: maxTokens }
    if (attempts < budgets.length) {
      log.info('蒸馏重试：加大输出预算', { category: f.category, finishReason: f.finishReason, usageOut: f.usage?.completion, usageReasoning: f.usage?.reasoning, inputChars: f.inputChars, outBudget: maxTokens, nextOutBudget: budgets[attempts] })
    }
  }
  return { detailed, attempts, outBudget: budgets[budgets.length - 1] }
}

/**
 * 去重命中后的统一处理：
 *  - 命中的是待审队列里的卡 → 跳过（不往未审核卡里灌内容，也不再堆新的待审卡）；
 *  - 命中主库卡 → merge 开：并入独特行（返回 merged 条数）；merge 关：旧行为，追加更新记录。
 * action 仍是 'appended'（与 v0.10.8 对调用方的约定兼容），新增字段 merged / via 仅供参考。
 */
async function handleDuplicate(vaultRoot, dup, text, dd, legacyText = truncateAtBoundary(normalizeLiteralEscapes(text), 400), card = {}, log = getLogger()) {
  if (dup.store === 'quarantine') {
    log.info('capture 跳过：待审队列已有近似卡', { path: dup.path, similarity: Number(dup.score.toFixed(2)) })
    return { ok: true, action: 'skipped', reason: `待审队列已有近似卡：${dup.path}`, path: dup.path }
  }
  // 合并写进卡片正文，只在这次沉淀本身免审（会直接入主库）时才做；需要审核的沉淀不得改动已批准卡的正文，
  // 退回旧行为「追加更新记录」（侧边记录，仍不新建卡）。审核判定与 writeCard 一致（DB 里的 auditMode）。
  const effective = enforceAudit(vaultRoot, card.kind, card.submittedBy, card.status || 'pending')
  if (dd.merge && effective === 'approved') {
    const r = await captureUpdate(vaultRoot, dup.path, text, { merge: true })
    log.info('capture 去重合并', { path: dup.path, via: dup.via, similarity: Number(dup.score.toFixed(2)), threshold: dd.threshold, merged: r.merged })
    return { ok: true, action: 'appended', path: dup.path, merged: r.merged, via: dup.via }
  }
  await captureUpdate(vaultRoot, dup.path, legacyText, { threshold: dd.threshold })
  log.info('capture 去重命中，追加更新记录', { path: dup.path, via: dup.via })
  return { ok: true, action: 'appended', path: dup.path, via: dup.via }
}
