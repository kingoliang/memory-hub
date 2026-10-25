// 图谱性能 / 截断实测的共用合成数据生成器（只含合成数据，不连真实库）。
// 被 tests/e2e/graph-perf-server.mjs 与 graph-truncation-server.mjs 共用，保证两份数据的形状一致。
import { writeCard } from '../../src/core/vault.js'

export const KINDS = ['project', 'knowledge', 'content', 'prompt', 'business', 'tool', 'mistake']
export const TOPICS = ['release', 'oncall', 'sqlite', 'canvas', 'cache', 'review', 'deploy', 'search', 'layout', 'auth', 'render', 'tidy']
/** 只在最早写入（= updated_at 最旧、会被 limit 截断藏掉）的一批卡上出现的标签，用于验证「截断时过滤回服务器」。 */
export const COHORT_TAG = 'legacy-cohort'

export const cardTitle = (i) => `合成性能卡 ${i} ${KINDS[i % KINDS.length]}`
/** 正文：同一话题的段落在话题内共享，制造相似边；wikilink 指向相邻的几张卡制造链接边。 */
export const cardBody = (i, n) => {
  const topic = TOPICS[i % TOPICS.length]
  const para = `关于 ${topic} 的合成说明，描述${topic}相关的流程、边界与回滚办法。`.repeat(6)
  const links = [i + 1, i + 7, i + 31].map((j) => `[[${cardTitle(j % n)}]]`).join(' ')
  const priv = `第 ${i} 张卡的独有补充：序号 ${i}，编号 ${i * 7}，话题 ${topic}。`
  return `${para}\n\n相关卡片：${links}\n\n${priv}\n`
}

/**
 * 写 n 张卡。cohortSize > 0 时，最前面的 cohortSize 张（最先写入 → 最旧）多带一个 COHORT_TAG。
 * 返回 { ms, cohort }
 */
export async function seedCards(home, n, { cohortSize = 0 } = {}) {
  const t0 = Date.now()
  let cohort = 0
  for (let i = 0; i < n; i++) {
    const tags = [TOPICS[i % TOPICS.length], TOPICS[(i * 3) % TOPICS.length], `batch-${i % 5}`]
    const isCohort = i < cohortSize
    if (isCohort) { tags.push(COHORT_TAG); cohort++ }
    const r = await writeCard(home, { kind: KINDS[i % KINDS.length], title: cardTitle(i), tags, body: cardBody(i, n), status: 'approved', submittedBy: 'perf-seed' }, { dedup: false })
    if (!r.ok) throw new Error('seed 失败：' + JSON.stringify(r))
  }
  return { ms: Date.now() - t0, cohort }
}
