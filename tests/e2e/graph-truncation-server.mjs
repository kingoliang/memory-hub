// 图谱「截断时过滤回服务器」验证用的合成实例：造 N 张卡，其中最早写入的 cohortSize 张额外带 COHORT_TAG。
// 卡片按 updated_at DESC 排（旧的靠后 → 默认视图截断时会被藏掉），所以这个标签只在被藏掉的卡上出现。
// 只含合成数据，不连真实库/生产。用法：
//   node tests/e2e/graph-truncation-server.mjs <端口> <卡数> <cohortSize> <口令输出文件>   → 打印 READY <url> <data-dir> <cohort>
import fs from 'node:fs'
import crypto from 'node:crypto'
import { tmpHome } from '../helpers.mjs'
import { loadConfig } from '../../src/config.js'
import { startServer } from '../../src/server.js'
import { createLogger } from '../../src/logger.js'
import { setAdminPassword } from '../../src/admin/auth.js'
import { closeAllDb } from '../../src/core/db.js'
import { seedCards } from './graph-perf-seed.mjs'

const [portArg, countArg, cohortArg, pwFile] = process.argv.slice(2)
const n = Number(countArg)
const cohortSize = Number(cohortArg)
if (!portArg || !pwFile || !Number.isInteger(n) || n < 1 || !Number.isInteger(cohortSize) || cohortSize < 1) {
  console.error('用法：graph-truncation-server.mjs <端口> <卡数> <cohortSize> <口令输出文件>')
  process.exit(2)
}

const home = tmpHome('mh-graph-trunc-')
const password = crypto.randomBytes(18).toString('base64url')
fs.writeFileSync(pwFile, password, { mode: 0o600 })
setAdminPassword(home, password)

const { ms: seedMs, cohort } = await seedCards(home, n, { cohortSize })
closeAllDb()

const config = loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: portArg })
const srv = await startServer(config, { logger: createLogger({ level: 'warn' }), scheduler: false })
console.log(`READY http://127.0.0.1:${srv.port} ${home} cohort=${cohort} seedMs=${seedMs}`)
process.on('SIGTERM', async () => { await srv.close(); closeAllDb(); fs.rmSync(home, { recursive: true, force: true }); process.exit(0) })
