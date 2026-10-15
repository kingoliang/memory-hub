// 起一个带合成数据的临时实例，供 tests/e2e/admin-m3-flow.mjs 的真实浏览器实测使用（只含合成数据，不连任何真实库）。
// 用法：node tests/e2e/m3-synthetic-server.mjs <端口> <口令输出文件>   → 打印 READY <url> <data-dir>，之后常驻直到被 kill。
import fs from 'node:fs'
import crypto from 'node:crypto'
import { tmpHome } from '../helpers.mjs'
import { loadConfig } from '../../src/config.js'
import { startServer } from '../../src/server.js'
import { createLogger } from '../../src/logger.js'
import { setAdminPassword } from '../../src/admin/auth.js'
import { seedDataset } from '../admin/admin-helpers.mjs'
import { writeCard } from '../../src/core/vault.js'
import { closeAllDb } from '../../src/core/db.js'

const [portArg, pwFile] = process.argv.slice(2)
if (!portArg || !pwFile) { console.error('用法：m3-synthetic-server.mjs <端口> <口令输出文件>'); process.exit(2) }
const home = tmpHome('mh-m3-e2e-')
const password = crypto.randomBytes(18).toString('base64url')
fs.writeFileSync(pwFile, password, { mode: 0o600 })
setAdminPassword(home, password)
await seedDataset(home)
// 额外合成：一批近似重复（演示整理合并）与几张噪声卡
const rep = '这是一段用于演示近似重复的合成说明文字，描述发布流程、回滚步骤与值班约定。'.repeat(3)
await writeCard(home, { kind: 'project', title: '发布流程说明 A', tags: ['release', 'ops'], body: rep + '\n补充：A 版独有的一行内容用于演示。', status: 'approved', submittedBy: 'claude-code-a' }, { dedup: false })
await writeCard(home, { kind: 'project', title: '发布流程说明 B', tags: ['release'], body: rep + '\n补充：B 版独有的另一行内容用于演示。', status: 'approved', submittedBy: 'codex-b' }, { dedup: false })
for (let i = 0; i < 2; i++) await writeCard(home, { kind: 'content', title: `[SCHEDULE REMINDER BATCH] 演示噪声 ${i}`, tags: ['raw'], body: `[SCHEDULE REMINDER BATCH] 演示噪声 ${i}`, status: 'approved', submittedBy: 'claude-code-a' }, { dedup: false })
closeAllDb()
const config = loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: portArg })
const srv = await startServer(config, { logger: createLogger({ level: 'info' }), scheduler: false })
console.log(`READY http://127.0.0.1:${srv.port} ${home}`)
process.on('SIGTERM', async () => { await srv.close(); closeAllDb(); fs.rmSync(home, { recursive: true, force: true }); process.exit(0) })
