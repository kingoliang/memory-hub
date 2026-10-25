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
import { closeAllDb } from '../../src/core/db.js'
import { seedCards } from './graph-perf-seed.mjs'

const [portArg, countArg, pwFile] = process.argv.slice(2)
const n = Number(countArg)
if (!portArg || !pwFile || !Number.isInteger(n) || n < 1) { console.error('用法：graph-perf-server.mjs <端口> <卡数> <口令输出文件>'); process.exit(2) }

const home = tmpHome('mh-graph-perf-')
const password = crypto.randomBytes(18).toString('base64url')
fs.writeFileSync(pwFile, password, { mode: 0o600 })
setAdminPassword(home, password)

const { ms: seedMs } = await seedCards(home, n)
closeAllDb()

const config = loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: portArg })
const srv = await startServer(config, { logger: createLogger({ level: 'warn' }), scheduler: false })
console.log(`READY http://127.0.0.1:${srv.port} ${home} seedMs=${seedMs}`)
process.on('SIGTERM', async () => { await srv.close(); closeAllDb(); fs.rmSync(home, { recursive: true, force: true }); process.exit(0) })
