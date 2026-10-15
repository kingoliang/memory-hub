// 客户端噪声预剥离。仅用于"够不够 60 字"的预检与减少无谓流量；权威剥离在 hub 侧
// （src/core/ingest.js 的 stripIngestNoise），这里与之保持同一口径的子集，漏剥无害（hub 会再剥）。

const NOISE_BLOCKS = [
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<team-[a-z-]+>[\s\S]*?<\/team-[a-z-]+>/gi,
  /<teammate[^>]*>[\s\S]*?<\/teammate>/gi,
  /<agent-message[^>]*>[\s\S]*?<\/agent-message>/gi,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/gi,
  /<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/gi,
]
const SCHEDULE_BLOCK = /^[^\n]*\[(?:SCHEDULE REMINDER|定时提醒)[^\]]*\][^\n]*(?:\n[ \t]*(?:[-*•]|\d)[^\n]*)*/gim
const TOOL_USE_LINE = /\[Tool use:[^\n]*/gi
const NOISE_LINE = /^\s*(相关上下文|Current runtime context|Runtime context|Approval prompts are disabled|DSH file policy|Current DSH file policy|You are a teammate|Team Lead|Teammate |Subagent |Note: the user|系统提示|环境快照)[：:]?/i

/** 剥掉运行时注入块 / 注入行 / 工具调用行，返回 trim 后的文本（可能为空串）。 */
export function stripNoise(text) {
  let out = String(text ?? '')
  out = out.replace(SCHEDULE_BLOCK, '').replace(TOOL_USE_LINE, '')
  for (const re of NOISE_BLOCKS) out = out.replace(re, '')
  return out.split('\n').filter((l) => !NOISE_LINE.test(l)).join('\n').trim()
}
