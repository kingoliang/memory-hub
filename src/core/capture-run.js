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

import { captureCard, captureUpdate, pickNeighbors, summarizeTurnDetailed, routeCandidates, stripRuntimeNoise, hasUsableContent, deriveTitle, isUsableTitle } from './capture.js'
import { createLlmFromEnv } from './llm-openai.js'
import { resolveDedupConfig } from './dedup-config.js'
import { enforceAudit } from './db.js'
import { detectSecrets } from './tidy.js'
import { getLogger } from '../logger.js'

/**
 * 沉淀一段文本到库。
 * @param {string} vaultRoot 数据目录（含 memory-eternal.db）
 * @param {string} text
 * @param {{source?: string, submittedBy?: string, llm?: object|null, env?: object, minChars?: number, log?: object}} [opts]
 *   submittedBy 缺省时回落为 source || 'agent'（兼容旧调用方；hub 的 MCP 路径总是显式传令牌名）
 * @returns {Promise<{ok:boolean, action:'created'|'appended'|'skipped'|'failed', path?:string, reason?:string, degraded?:boolean, secretTypes?:string[]}>}
 */
export async function runStandaloneCapture(vaultRoot, text, { source = '', submittedBy, llm, env = process.env, minChars = 120, log = getLogger() } = {}) {
  const author = String(submittedBy || source || 'agent')
  // 入料噪声闸门（P0）：先剥运行时注入，再判断是否还有真实内容。
  const clean = stripRuntimeNoise(text)
  if (clean.length < minChars) return { ok: false, action: 'skipped', reason: 'text too short' }
  if (!hasUsableContent(clean)) return { ok: false, action: 'skipped', reason: 'text is runtime noise' }
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
  const llmClient = llm === undefined ? createLlmFromEnv(env) : llm
  const routes = llmClient ? await routeCandidates(llmClient, {}) : []
  const route = routes[0] ?? null

  // 有 LLM：蒸馏判定链
  if (llmClient && route) {
    try {
      const neighbors = await pickNeighbors(vaultRoot, { title: '', body: clean.slice(0, 400) }, 8)
      const detailed = await summarizeTurnDetailed(llmClient, route, clean, { existing: neighbors, signal: AbortSignal.timeout(45000) })
      const result = detailed.card
      if (detailed.failure) {
        log.warn('蒸馏失败，降级为原文卡', { provider: route.provider, model: route.model, code: detailed.failure.code, message: detailed.failure.message })
      }
      if (result && result.save === true) {
        if (result.append_to) {
          await captureUpdate(vaultRoot, result.append_to, result.update, { threshold: 0.62 })
          return { ok: true, action: 'appended', path: result.append_to }
        }
        const card = { kind: result.kind, title: result.title, tags: result.tags, body: result.body, source, status: 'pending', submittedBy: author, severity: 'info', reason: 'AI 自动沉淀（蒸馏卡）' }
        const out = await captureCard(vaultRoot, card, dupOpts)
        if (out.ok) return { ok: true, action: 'created', path: out.path ?? out.rel }
        if (out.duplicate) return handleDuplicate(vaultRoot, out.duplicate, `${result.title}\n${result.body}`, dd, undefined, card, log)
        return { ok: false, action: 'failed', reason: String(out.reason || 'write failed') }
      }
      if (result && result.save === false) return { ok: true, action: 'skipped', reason: 'model judged not durable' }
    } catch (error) {
      // LLM 失败 → 落入降级路径，不能让一次网络抖动丢掉沉淀
      log.warn('蒸馏调用异常，降级为原文卡', { provider: route.provider, model: route.model, error: String(error?.message || error).slice(0, 200) })
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
  }
  const out = await captureCard(vaultRoot, rawCard, dupOpts)
  if (out.ok) return { ok: true, action: 'created', path: out.path ?? out.rel, degraded: true }
  if (out.duplicate) return { ...(await handleDuplicate(vaultRoot, out.duplicate, clean, dd, clean.slice(0, 400), rawCard, log)), degraded: true }
  return { ok: false, action: 'failed', reason: String(out.reason || 'write failed') }
}

/**
 * 去重命中后的统一处理：
 *  - 命中的是待审队列里的卡 → 跳过（不往未审核卡里灌内容，也不再堆新的待审卡）；
 *  - 命中主库卡 → merge 开：并入独特行（返回 merged 条数）；merge 关：旧行为，追加更新记录。
 * action 仍是 'appended'（与 v0.10.8 对调用方的约定兼容），新增字段 merged / via 仅供参考。
 */
async function handleDuplicate(vaultRoot, dup, text, dd, legacyText = text.slice(0, 400), card = {}, log = getLogger()) {
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
