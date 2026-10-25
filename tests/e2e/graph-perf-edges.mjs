// 建图规模对比：用与 graph-perf-server.mjs 相同的合成生成器造 N 张卡，然后直接调 graphQuery（limit 巨大、不截断）
// 量全量边数 / tag 边数 / 孤立点数。用于对比「改动前 vs 改动后」的边覆盖率（在基线分支上跑同一个脚本即可）。
// 用法：node tests/e2e/graph-perf-edges.mjs <卡数>    （卡数建议 10000）
import fs from 'node:fs'
import { tmpHome } from '../helpers.mjs'
import { seedCards } from './graph-perf-seed.mjs'
import { graphQuery } from '../../src/admin/graph.js'
import { closeAllDb } from '../../src/core/db.js'

const n = Number(process.argv[2])
if (!Number.isInteger(n) || n < 1) { console.error('用法：graph-perf-edges.mjs <卡数>'); process.exit(2) }
const home = tmpHome('mh-graph-edges-')
const { ms: seedMs } = await seedCards(home, n)
const t0 = performance.now()
const g = graphQuery(home, { limit: 1_000_000 })
const ms = performance.now() - t0
const byType = { link: 0, tag: 0, similar: 0 }
for (const e of g.edges) byType[e.type]++
console.log(JSON.stringify({ n, seedMs, ms: Number(ms.toFixed(1)), nodes: g.nodes.length, edges: g.edges.length, byType, isolated: g.stats.isolated, isolatedPct: Number(((g.stats.isolated / g.nodes.length) * 100).toFixed(2)) }))
closeAllDb()
fs.rmSync(home, { recursive: true, force: true })
