// memory-hub · 部署修订信息：读取代码目录根部的 REVISION 文件（由 scripts/deploy-remote.sh 在部署时写入）。
// 文件格式（每行 key=value）：
//   sha=<完整 40 位提交号>
//   time=<提交时间，ISO 8601>
//   describe=<git describe --tags --always 的输出>
// 兼容旧格式：整个文件只有一行短 sha。文件不存在（开发环境、非脚本部署）→ 返回 null。
// /healthz 用它回报"线上跑的是哪个提交"，部署脚本据此核对重启是否生效。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 解析 REVISION 文本；无法识别返回 null。 */
export function parseRevision(text) {
  const out = { sha: '', time: '', describe: '' }
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  for (const l of lines) {
    const m = /^(sha|time|describe)=(.*)$/.exec(l)
    if (m) out[m[1]] = m[2].trim()
  }
  if (!out.sha && lines.length === 1 && /^[0-9a-f]{7,40}$/i.test(lines[0])) out.sha = lines[0]
  if (!/^[0-9a-f]{7,40}$/i.test(out.sha)) return null
  return { sha: out.sha.toLowerCase(), time: out.time || null, describe: out.describe || null }
}

/** 读取 REVISION；读不到或格式不对返回 null（不抛错：缺失不应影响服务启动）。 */
export function readRevision(codeRoot = CODE_ROOT) {
  try { return parseRevision(fs.readFileSync(path.join(codeRoot, 'REVISION'), 'utf8')) } catch { return null }
}
