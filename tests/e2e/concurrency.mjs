// 8 个进程 × 50 次 writeCard 同库：0 个 BUSY、id 全唯一。
// 用法：node tests/e2e/concurrency.mjs [--core <含 db.js/vault.js 的目录>] [--procs 8] [--per 50]
// 退出码 0 = 通过。--core 可指向 tests/fixtures/legacy 以证明旧实现会失败。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d }
const core = path.resolve(arg('core', path.join(here, '../../src/core')))
const PROCS = Number(arg('procs', 8))
const PER = Number(arg('per', 50))

if (process.argv.includes('--child')) {
  const idx = Number(arg('idx', 0))
  const root = arg('root')
  const { getDb } = await import(pathToFileURL(path.join(core, 'db.js')))
  const { writeCard } = await import(pathToFileURL(path.join(core, 'vault.js')))
  let busy = 0, other = 0, ok = 0
  const errors = []
  try { getDb(root) } catch (e) { errors.push('open: ' + e.message); busy++ }
  for (let i = 0; i < PER; i++) {
    try {
      const r = await writeCard(root, { kind: 'knowledge', title: `并发卡 p${idx} n${i}`, body: `正文 ${idx}-${i} ${Math.random()}`, status: 'approved', submittedBy: `p${idx}` }, { dedup: false })
      if (r.ok) ok++; else other++
    } catch (e) {
      const m = String(e?.message || e)
      if (/busy|locked/i.test(m)) busy++; else other++
      if (errors.length < 3) errors.push(m)
    }
  }
  process.stdout.write(JSON.stringify({ idx, ok, busy, other, errors }) + '\n')
  process.exit(0)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-conc-'))
const runs = Array.from({ length: PROCS }, (_, i) => new Promise((resolve) => {
  const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', '--idx', String(i), '--root', root, '--core', core, '--per', String(PER)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', () => {})
  p.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())) } catch { resolve({ idx: i, ok: 0, busy: 0, other: PER, errors: ['child crashed'] }) } })
}))
const results = await Promise.all(runs)
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(path.join(root, 'memory-eternal.db'), { readOnly: true })
const rows = db.prepare('SELECT id FROM cards').all()
const ids = new Set(rows.map((r) => r.id))
const summary = {
  expected: PROCS * PER, rows: rows.length, uniqueIds: ids.size,
  ok: results.reduce((a, r) => a + r.ok, 0), busy: results.reduce((a, r) => a + r.busy, 0), other: results.reduce((a, r) => a + r.other, 0),
  sampleErrors: results.flatMap((r) => r.errors).slice(0, 3),
}
db.close()
fs.rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify(summary))
const pass = summary.busy === 0 && summary.other === 0 && summary.rows === summary.expected && summary.uniqueIds === summary.expected
console.log(pass ? 'CONCURRENCY PASS' : 'CONCURRENCY FAIL')
process.exit(pass ? 0 : 1)
