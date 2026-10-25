#!/usr/bin/env node
// 召回对账（PLAN 6.3.2）：
//  (i)  旧实现 search()（tests/fixtures/legacy 逐字副本）vs 新实现 search()：同一份旧库快照的两份拷贝。
//       打分已换成 BM25（GH #3），分数与顺序有意不同；这里检查宽松模式下新命中 ⊇ 旧命中（换打分不丢召回），
//       并统计「前 5 条全部同分」的查询数（旧打分的典型失效）在新旧实现下各有多少；
//  (ii) 可选：线上旧 MCP 服务 vs 新服务的 memory_recall 文本输出（含路径与顺序；MCP 输出不含分数）。旧服务读的是"活库"，
//       快照之后的新写入会造成差异——脚本会把差异路径标出"是否创建/更新于快照之后"。
// 输出只含计数、查询序号和类别，不打印查询词、标题或正文。令牌只从文件读，不打印。
//
//   recall-parity.mjs --snapshot <快照.db> [--new-url http://127.0.0.1:7991 --new-token-file F] [--old-url http://127.0.0.1:7990/memory --old-token-file F --old-db <旧活库>]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '../..')
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d }
const snapshot = arg('snapshot')
if (!snapshot) { console.error('缺 --snapshot'); process.exit(2) }

const legacyDb = await import(pathToFileURL(path.join(repo, 'tests/fixtures/legacy/db.js')))
const legacyVault = await import(pathToFileURL(path.join(repo, 'tests/fixtures/legacy/vault.js')))
const newDb = await import(pathToFileURL(path.join(repo, 'src/core/db.js')))
const newVault = await import(pathToFileURL(path.join(repo, 'src/core/vault.js')))

// ── 查询集：30 条取自标题（前缀 / 中段片段 / 英文词）+ 手写若干 ──
const ro = new DatabaseSync(snapshot, { readOnly: true })
const titles = ro.prepare('SELECT title FROM cards ORDER BY id').all().map((r) => String(r.title).trim()).filter((t) => t.length >= 4)
ro.close()
const pick = (n) => { const step = Math.max(1, Math.floor(titles.length / n)); const out = []; for (let i = 0; i < titles.length && out.length < n; i += step) out.push(titles[i]); return out }
const queries = []
for (const [i, t] of pick(30).entries()) {
  const cps = [...t]
  const kind = i % 3
  if (kind === 0) queries.push({ q: cps.slice(0, Math.min(6, cps.length)).join(''), cat: 'title-prefix' })
  else if (kind === 1) queries.push({ q: cps.slice(Math.floor(cps.length / 2) - 1, Math.floor(cps.length / 2) + 3).join('').trim(), cat: 'title-mid' })
  else queries.push({ q: (t.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) || [cps.slice(0, 4).join('')])[0], cat: 'title-word' })
}
for (const q of ['数据库', '部署', '缓存', '配置', '用户偏好', '项目', '记忆', '令牌', '日志', '备份']) queries.push({ q, cat: 'hand-zh' })
for (const q of ['sqlite', 'deploy', 'nginx', 'docker', 'api key', 'git rebase', 'node']) queries.push({ q, cat: 'hand-en' })
for (const q of ['部署 nginx', '配置 token', 'MCP 服务']) queries.push({ q, cat: 'hand-mixed' })
for (const q of ['库选', '乂', 'zzqxv不存在的词汇', '']) queries.push({ q, cat: 'edge' })
const qs = queries.filter((x) => x.q !== undefined)
console.log(`[recall-parity] 查询数 ${qs.length}（title-prefix/mid/word=${qs.filter((x) => x.cat.startsWith('title')).length}，手写 ${qs.filter((x) => !x.cat.startsWith('title')).length}）`)

// ── (i) 旧 search() vs 新 search()：各用一份快照拷贝（旧实现不会升级 schema，新实现会）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-hub-parity-'))
const dOld = path.join(tmp, 'old'), dNew = path.join(tmp, 'new')
fs.mkdirSync(dOld); fs.mkdirSync(dNew)
for (const d of [dOld, dNew]) fs.copyFileSync(snapshot, path.join(d, 'memory-eternal.db'))
let lost = 0, hitsTotal = 0, nonEmpty = 0, tiedOld = 0, tiedNew = 0
const allTied = (hits) => hits.length >= 3 && new Set(hits.map((h) => h.score)).size === 1
try {
  for (const [i, { q, cat }] of qs.entries()) {
    const o = await legacyVault.search(dOld, q, { limit: 1e9 }).catch(() => [])
    const n = await newVault.search(dNew, q, { limit: 1e9 }).catch(() => [])
    hitsTotal += n.length
    if (n.length) nonEmpty++
    const np = new Set(n.map((h) => h.path))
    const missing = o.filter((h) => !np.has(h.path)).length
    if (missing) { lost++; console.log(`  (i) 新实现丢了旧命中：查询#${i} [${cat}] ${missing} 张`) }
    const o5 = await legacyVault.search(dOld, q, { limit: 5, minScore: 2 }).catch(() => [])
    const n5 = await newVault.search(dNew, q, { limit: 5, strict: true }).catch(() => [])
    if (allTied(o5)) tiedOld++
    if (allTied(n5)) tiedNew++
  }
} finally { legacyDb.closeAllDb(); newDb.closeAllDb(); fs.rmSync(tmp, { recursive: true, force: true }) }
console.log(`[recall-parity] (i) 旧 search() vs 新 search()：${qs.length} 条查询，新实现丢失旧命中的查询 ${lost}；有命中的查询 ${nonEmpty}，命中总数 ${hitsTotal}`)
console.log(`[recall-parity] (i) 前 5 条全部同分的查询：旧打分 ${tiedOld}，新打分 ${tiedNew}`)
if (lost) process.exitCode = 1

// ── (ii) 线上旧 MCP 服务 vs 新服务（HTTP，memory_recall 文本）──
const newUrl = arg('new-url'), oldUrl = arg('old-url')
if (newUrl && oldUrl) {
  const tokenOf = (f) => fs.readFileSync(f, 'utf8').trim()
  const callRecall = async (base, tokFile, query) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokenOf(tokFile)}`, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_recall', arguments: { query: query || ' ', limit: 5 } } }),
    })
    const raw = await r.text()
    let j; try { j = JSON.parse(raw) } catch { const m = /^data: (.+)$/m.exec(raw); j = m ? JSON.parse(m[1]) : null }
    return { status: r.status, text: j?.result?.content?.map((c) => c.text).join('') ?? raw.slice(0, 80) }
  }
  const oldDbPath = arg('old-db')
  const snapAt = fs.statSync(snapshot).mtimeMs
  let diffs = 0, same = 0, errs = 0
  const live = oldDbPath ? new DatabaseSync(oldDbPath, { readOnly: true }) : null
  for (const [i, { q, cat }] of qs.entries()) {
    const a = await callRecall(oldUrl, arg('old-token-file'), q)
    const b = await callRecall(newUrl, arg('new-token-file'), q)
    if (a.status !== 200 || b.status !== 200) { errs++; console.log(`  (ii) HTTP 异常：查询#${i} [${cat}] old=${a.status} new=${b.status}`); continue }
    if (a.text === b.text) { same++; continue }
    diffs++
    const pa = [...a.text.matchAll(/路径：(\S+)/g)].map((m) => m[1]), pb = [...b.text.matchAll(/路径：(\S+)/g)].map((m) => m[1])
    const onlyOld = pa.filter((p) => !pb.includes(p)), onlyNew = pb.filter((p) => !pa.includes(p))
    let note = ''
    if (live) {
      const newer = [...new Set([...pa, ...pb])].filter((p) => {
        const r = live.prepare('SELECT created_at, updated_at FROM cards WHERE path = ?').get(p)
        return r && Math.max(Date.parse(r.created_at) || 0, Date.parse(r.updated_at) || 0) > snapAt
      })
      note = `；活库中快照之后创建/更新的卡 ${newer.length} 张（出现在两边结果里）`
    }
    console.log(`  (ii) 差异：查询#${i} [${cat}] 路径序列相同=${JSON.stringify(pa) === JSON.stringify(pb)}；仅旧有 ${onlyOld.length}、仅新有 ${onlyNew.length}${note}`)
  }
  live?.close()
  console.log(`[recall-parity] (ii) 线上旧服务 vs 新服务 memory_recall 文本：相同 ${same}，不同 ${diffs}，HTTP 异常 ${errs}（共 ${qs.length}）`)
}
