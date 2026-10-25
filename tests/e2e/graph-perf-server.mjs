// 图谱性能实测用的合成实例：造 N 张卡（7 种 kind、带标签与正文、含 wikilink 与相似正文），起一个临时服务。
// 只含合成数据，不连任何真实库/生产。用法：
//   node tests/e2e/graph-perf-server.mjs <端口> <卡数> <口令输出文件>   → 打印 READY <url> <data-dir>，常驻直到被 kill。
import fs from 'node:fs'
import crypto from 'node:crypto'
import { tmpHome } from '../helpers.mjs'
import { loadConfig } from '../../src/config.js'
import { startServer } from '../../src/server.js'
import { createLogger } from '../../src/logger.js'
import { setAdminPassword } from '../../src/admin/auth.js'
import { writeCard } from '../../src/core/vault.js'
import { closeAllDb } from '../../src/core/db.js'

const [portArg, countArg, pwFile] = process.argv.slice(2)
const n = Number(countArg)
if (!portArg || !pwFile || !Number.isInteger(n) || n < 1) { console.error('用法：graph-perf-server.mjs <端口> <卡数> <口令输出文件>'); process.exit(2) }

const KINDS = ['project', 'knowledge', 'content', 'prompt', 'business', 'tool', 'mistake']
const TOPICS = ['release', 'oncall', 'sqlite', 'canvas', 'cache', 'review', 'deploy', 'search', 'layout', 'auth', 'render', 'tidy']
const home = tmpHome('mh-graph-perf-')
const password = crypto.randomBytes(18).toString('base64url')
fs.writeFileSync(pwFile, password, { mode: 0o600 })
setAdminPassword(home, password)

const title = (i) => `合成性能卡 ${i} ${KINDS[i % KINDS.length]}`
/** 正文：每个话题段落在同一话题内共享，制造相似边；wikilink 指向相邻的几张卡制造链接边。 */
const body = (i) => {
  const topic = TOPICS[i % TOPICS.length]
  const para = `关于 ${topic} 的合成说明，描述${topic}相关的流程、边界与回滚办法。`.repeat(6)
  const links = [i + 1, i + 7, i + 31].map((j) => `[[${title(j % n)}]]`).join(' ')
  const priv = `第 ${i} 张卡的独有补充：序号 ${i}，编号 ${i * 7}，话题 ${topic}。`
  return `${para}\n\n相关卡片：${links}\n\n${priv}\n`
}

const t0 = Date.now()
for (let i = 0; i < n; i++) {
  const tags = [TOPICS[i % TOPICS.length], TOPICS[(i * 3) % TOPICS.length], `batch-${i % 5}`]
  const r = await writeCard(home, { kind: KINDS[i % KINDS.length], title: title(i), tags, body: body(i), status: 'approved', submittedBy: 'perf-seed' }, { dedup: false })
  if (!r.ok) throw new Error('seed 失败：' + JSON.stringify(r))
}
const seedMs = Date.now() - t0
closeAllDb()

const config = loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: portArg })
const srv = await startServer(config, { logger: createLogger({ level: 'warn' }), scheduler: false })
console.log(`READY http://127.0.0.1:${srv.port} ${home} seedMs=${seedMs}`)
process.on('SIGTERM', async () => { await srv.close(); closeAllDb(); fs.rmSync(home, { recursive: true, force: true }); process.exit(0) })
