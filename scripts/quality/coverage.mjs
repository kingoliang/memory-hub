// 覆盖率门禁。**分母按 git ls-files 重算**（playbook §0 / §2.4 / 陷阱二）。
//
// 为什么不能直接用工具输出的 "all files"：
//   node --experimental-test-coverage（以及多数覆盖率工具）只统计"被加载过"的文件。
//   一个没有任何测试 import 的模块不会显示 0%，而是**整行不出现** —— 分母于是自己缩水，
//   数字虚高。loganalysis 实测：工具读 72.06%，真实值 35.4%（38 个源文件里 18 个完全缺席）。
//
// 所以这里：分母 = git ls-files 下每个源文件的有效行数；缺报告的文件按 0% 计入。
// 退出码：低于 thresholds.coverage 即失败。

import fs from 'node:fs'
import path from 'node:path'
import { gitFiles, codeLines, run, thresholds, verdict, paint, ROOT } from './lib.mjs'

/** 解析 node 覆盖率表：`#  <indent><file> | line % | ...`，目录行没有 `|`。 */
function parseCoverage(text) {
  const stack = []
  const out = new Map()
  let inside = false
  for (const line of text.split('\n')) {
    if (line.includes('start of coverage report')) { inside = true; continue }
    if (line.includes('end of coverage report')) break
    if (!inside || !line.startsWith('#')) continue
    const body = line.slice(1)
    const m = /^(\s+)(.*)$/.exec(body)
    if (!m) continue
    const [, spaces, rest] = m
    const depth = Math.max(0, spaces.length - 1)
    if (!rest.includes('|')) {
      stack[depth] = rest.trim()
      stack.length = depth + 1
      continue
    }
    const [namePart, linePct] = rest.split('|')
    const name = namePart.trim()
    if (!name || linePct === undefined) continue
    stack[depth] = name
    const rel = stack.slice(0, depth + 1).join('/')
    const pct = Number(String(linePct).trim())
    if (Number.isFinite(pct)) out.set(rel, pct)
  }
  return out
}

const files = gitFiles()
const report = parseCoverage(run(process.execPath, ['--test', '--test-concurrency=1', '--experimental-test-coverage', 'tests/**/*.test.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }))

let covered = 0
let total = 0
const missing = []
const rows = []
for (const rel of files) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) continue
  const lines = codeLines(abs)
  if (lines === 0) continue
  const pct = report.get(rel)
  if (pct === undefined) missing.push(rel)
  const hit = Math.round((lines * (pct ?? 0)) / 100)
  covered += hit
  total += lines
  rows.push({ rel, lines, pct: pct ?? 0, hit })
}

const ratio = total === 0 ? 0 : (covered / total) * 100
const threshold = Number(thresholds().coverage)

process.stdout.write(`生产代码 ${rows.length} 个文件 / ${total} 有效行；按 git ls-files 重算的真实行覆盖率：\n`)
process.stdout.write(`  有报告 ${rows.length - missing.length} 个，**完全没被执行到 ${missing.length} 个**\n`)
if (missing.length) {
  process.stdout.write(paint.dim('\n未被执行到的文件（工具输出里根本不会出现，这里按 0% 计入）：\n'))
  for (const rel of missing) process.stdout.write(`  ${rel}\n`)
}
const worst = rows.filter((r) => r.pct > 0).sort((a, b) => a.pct - b.pct).slice(0, 10)
if (worst.length) {
  process.stdout.write(paint.dim('\n覆盖最差的 10 个（有报告但低）：\n'))
  for (const r of worst) process.stdout.write(`  ${r.pct.toFixed(2).padStart(6)}%  ${r.rel}\n`)
}

process.stdout.write(`\n工具输出里的 all files: ${(report.get('all files') ?? NaN)}%\n`)
process.stdout.write(`重算后的真实覆盖率: ${ratio.toFixed(2)}%  (阈值 ${threshold}%)\n`)
process.exit(verdict('coverage', ratio >= threshold, `真实 ${ratio.toFixed(2)}% ≥ 阈值 ${threshold}%`))
