// 在"数据库副本"上跑一次完整的 整理预览 → dry-run → apply → rollback，前后逐行指纹对比（PLAN 第 7 节 M3 验收）。
// 用法：node tests/e2e/tidy-roundtrip-on-copy.mjs <源 memory-eternal.db>
// 源库只被只读打开并用 backup API 拷到临时目录；写操作全部发生在临时副本上，结束后删除副本。
// 只输出计数、类型与 IDENTICAL/DIFFERENT，不输出卡片标题/正文。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as sqlite from 'node:sqlite'
import { loadConfig } from '../../src/config.js'
import { startServer } from '../../src/server.js'
import { createLogger } from '../../src/logger.js'
import { setAdminPassword } from '../../src/admin/auth.js'
import { closeAllDb, getDb } from '../../src/core/db.js'

const src = process.argv[2]
if (!src) { console.error('用法：tidy-roundtrip-on-copy.mjs <源 memory-eternal.db>'); process.exit(2) }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-copy-'))
const quiet = createLogger({ level: 'error', stream: { write() {} } })
let srv
try {
  const from = new sqlite.DatabaseSync(src, { readOnly: true })
  await sqlite.backup(from, path.join(home, 'memory-eternal.db'))
  from.close()
  const pw = crypto.randomBytes(18).toString('base64url')
  setAdminPassword(home, pw, { cost: { N: 1024, r: 8, p: 1 } })
  srv = await startServer(loadConfig({ MEMORY_HUB_HOME: home, MEMORY_HUB_PORT: '0' }), { logger: quiet, scheduler: false })
  const base = `http://127.0.0.1:${srv.port}`
  const lr = await fetch(base + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: pw }) })
  const login = await lr.json()
  const cookie = lr.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  const call = async (method, p, body) => {
    const r = await fetch(base + '/admin/api/' + p, { method, headers: { cookie, origin: base, 'x-csrf-token': login.csrfToken, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, json: await r.json() }
  }
  const db = getDb(home)
  const fingerprint = () => {
    const h = crypto.createHash('sha256')
    for (const t of ['cards', 'quarantine']) for (const r of db.prepare(`SELECT path, kind, title, tags, body, status FROM ${t} ORDER BY path`).all()) h.update(JSON.stringify(r))
    return h.digest('hex').slice(0, 16)
  }
  const counts = () => ({ cards: db.prepare('SELECT COUNT(*) n FROM cards').get().n, quarantine: db.prepare('SELECT COUNT(*) n FROM quarantine').get().n })
  const fp0 = fingerprint(); const c0 = counts()
  console.log(`副本：cards=${c0.cards} quarantine=${c0.quarantine} 指纹=${fp0}`)
  const pv = await call('GET', 'tidy/preview?limit=1')
  console.log(`预览 planId=${pv.json.planId} 计数=${JSON.stringify(pv.json.counts)}`)
  const dry = await call('POST', 'tidy/apply', { planId: pv.json.planId })
  console.log(`dry-run: HTTP ${dry.status} dryRun=${dry.json.dryRun} plannedDeletes=${dry.json.plannedDeletes} 摘要=${JSON.stringify(dry.json.summary)}；dry-run 后指纹${fingerprint() === fp0 ? '不变' : '变了(!)'}`)
  const noPlan = await call('POST', 'tidy/apply', { confirm: true })
  console.log(`confirm 不带 planId: HTTP ${noPlan.status} ${noPlan.json.error}`)
  const run = await call('POST', 'tidy/apply', { planId: pv.json.planId, confirm: true })
  const c1 = counts()
  console.log(`apply: HTTP ${run.status} ok=${run.json.ok} 批次=${JSON.stringify((run.json.batches || []).map((b) => [b.name, b.status, b.counts]))} 备份=${run.json.backup?.file} verified=${run.json.backup?.verified} 回滚文件=${run.json.rollbackFile}`)
  console.log(`apply 后：cards=${c1.cards} quarantine=${c1.quarantine} 指纹=${fingerprint()}`)
  const bak = new sqlite.DatabaseSync(path.join(home, 'backups', run.json.backup.file), { readOnly: true })
  console.log(`备份 integrity_check=${bak.prepare('PRAGMA integrity_check').get().integrity_check}`); bak.close()
  const rb = await call('POST', 'tidy/rollback', { rollbackFile: run.json.rollbackFile, confirm: true })
  const fp1 = fingerprint(); const c2 = counts()
  console.log(`rollback: HTTP ${rb.status} restored=${rb.json.restored} reverted=${rb.json.reverted}；回滚后：cards=${c2.cards} quarantine=${c2.quarantine} 指纹=${fp1}`)
  const same = fp0 === fp1 && c0.cards === c2.cards && c0.quarantine === c2.quarantine
  console.log(same ? 'IDENTICAL' : 'DIFFERENT')
  process.exitCode = same ? 0 : 1
} finally {
  if (srv) await srv.close()
  closeAllDb()
  fs.rmSync(home, { recursive: true, force: true })
}
