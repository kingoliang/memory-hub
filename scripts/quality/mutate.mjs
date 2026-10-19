// 变异测试运行器（自建，零依赖）。playbook §3 / §7 的执行卫生都落在这里：
//
//   1. **在副本上跑**，绝不在生产在用的目录树上跑（§7.4）；
//   2. 每个变异体跑完断言源文件已还原（§7.2）—— 被打断的运行会把源码留在变异态，
//      下一批就会在坏版本上报出毫无意义的 KILLED；
//   3. 存活的变异体重跑 --repeat 次，两次一致才算存活（§7.3，防不稳定测试伪装成 KILLED）；
//   4. 有界：--max 个变异体、--timeout 秒/个，到点就停并如实报"部分"。
//
// 变异算子刻意保守（比较/布尔/逻辑/字符串字面量/数字），因为期望值都是写死的字面量：
// 这类变异体逮不到，说明断言在复述而不是在检查。
// 注释里的命中先被 mask 掉，避免生成"等价变异体"（改了注释当然没行为差异）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { thresholds, verdict, paint, ROOT } from './lib.mjs'

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 ? process.argv[i + 1] : def
}
const FILES = String(arg('files', 'src/core/scope.js,src/core/gate.js,src/admin/rbac.js')).split(',').map((s) => s.trim()).filter(Boolean)
const TESTS = String(arg('tests', 'tests/team-scope.test.mjs,tests/experience-gate.test.mjs,tests/gate-scope-hardening.test.mjs,tests/admin/rbac.test.mjs')).split(',').map((s) => s.trim()).filter(Boolean)
const MAX = Number(arg('max', 60))
const TIMEOUT_MS = Number(arg('timeout', 90)) * 1000
const REPEAT = Number(arg('repeat', 2))

const OPERATORS = [
  { name: 'eq', re: /===|!==/g, flip: (m) => (m === '===' ? '!==' : '===') },
  { name: 'bool', re: /\b(?:true|false)\b/g, flip: (m) => (m === 'true' ? 'false' : 'true') },
  { name: 'logical', re: /&&|\|\|/g, flip: (m) => (m === '&&' ? '||' : '&&') },
  { name: 'rel', re: />=|<=/g, flip: (m) => (m === '>=' ? '>' : '<') },
  { name: 'str', re: /'[^'\n]*'/g, flip: () => "''", skip: (m) => m === "''" },
  { name: 'num', re: /(?<![\w.$])\d+(?![\w.])/g, flip: (m) => String(Number(m) + 1) },
]

/** 把注释替换成等长空格：在 mask 上找命中，回原文切片，位置不会错。 */
function maskComments(src) {
  const out = src.split('')
  let i = 0
  let inLine = false
  let inBlock = false
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (inLine) {
      if (src[i] === '\n') inLine = false
      else out[i] = ' '
    } else if (inBlock) {
      if (two === '*/') { out[i] = ' '; out[i + 1] = ' '; i += 2; inBlock = false; continue }
      if (src[i] !== '\n') out[i] = ' '
    } else if (two === '//') { out[i] = ' '; out[i + 1] = ' '; i += 2; inLine = true; continue } else if (two === '/*') { out[i] = ' '; out[i + 1] = ' '; i += 2; inBlock = true; continue }
    i++
  }
  return out.join('')
}

const lineOf = (src, offset) => src.slice(0, offset).split('\n').length

function prepareWorkdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-mutate-'))
  for (const entry of ['src', 'tests', 'bin', 'web']) {
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true })
  }
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'))
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'))
  return dir
}

function plannedMutants() {
  const list = []
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const mask = maskComments(src)
    for (const op of OPERATORS) {
      op.re.lastIndex = 0
      let m
      while ((m = op.re.exec(mask))) {
        const orig = src.slice(m.index, m.index + m[0].length)
        if (op.skip?.(orig)) continue
        const mutated = op.flip(orig)
        if (mutated === orig) continue
        list.push({ rel, op: op.name, offset: m.index, length: m[0].length, from: orig, to: mutated, line: lineOf(src, m.index) })
      }
    }
  }
  return list
}

const work = prepareWorkdir()
const targets = FILES.map((rel) => ({ rel, abs: path.join(work, rel), original: fs.readFileSync(path.join(work, rel), 'utf8') }))
const all = plannedMutants()
const mutants = all.slice(0, MAX)

process.stdout.write(`副本：${work}\n目标：${FILES.join(', ')}\n算子命中 ${all.length} 个，本轮跑 ${mutants.length} 个（--max ${MAX}）\n\n`)

function assertFile(t, expected, where) {
  const now = fs.readFileSync(t.abs, 'utf8')
  // 差异用字节数报：被打断的运行会把源文件留在变异态，下一批就会在坏版本上报出毫无意义的 KILLED
  if (now !== expected) throw new Error(`${where}：${t.rel} 内容不符（期望 ${expected.length} 字节，实际 ${now.length}）`)
}
function assertRestored(where) { for (const t of targets) assertFile(t, t.original, where) }
const restoreAll = () => { for (const t of targets) fs.writeFileSync(t.abs, t.original) }

/** 写入变异体，返回 { 目标, 变异后的全文 }，供“运行器没动源文件”的断言使用。 */
function applyMutant(mu) {
  const t = targets.find((x) => x.rel === mu.rel)
  const src = t.original.slice(0, mu.offset) + mu.to + t.original.slice(mu.offset + mu.length)
  fs.writeFileSync(t.abs, src)
  return { t, src }
}

function runTests() {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...TESTS], { cwd: work, encoding: 'utf8', timeout: TIMEOUT_MS })
  return { status: r.status, signal: r.signal }
}

restoreAll()
const baseline = runTests()
if (baseline.status !== 0) {
  process.stdout.write(paint.red(`基线就不过（status=${baseline.status}）：先修基线再谈变异\n`))
  process.exit(1)
}

const survivors = []
let killed = 0
let n = 0
for (const mu of mutants) {
  n++
  assertRestored('变异前')
  const { t, src } = applyMutant(mu)
  const r = runTests()
  assertFile(t, src, '变异后（测试运行器改动了源文件）')
  fs.writeFileSync(t.abs, t.original)
  assertFile(t, t.original, '还原后')
  const died = r.status !== 0
  if (died) { killed++; process.stdout.write(`  KILLED  ${mu.rel}:${mu.line} ${mu.op} ${mu.from} → ${mu.to}\n`); continue }

  // 存活：重跑 REPEAT 次，任何一次死掉就说明是不稳定测试（§7.3），不算真存活
  let flaky = false
  for (let k = 0; k < REPEAT; k++) {
    fs.writeFileSync(t.abs, src)
    const rr = runTests()
    fs.writeFileSync(t.abs, t.original)
    if (rr.status !== 0) { flaky = true; break }
  }
  assertRestored('存活重跑后')
  if (flaky) { killed++; process.stdout.write(`  KILLED* ${mu.rel}:${mu.line} ${mu.op} ${mu.from} → ${mu.to}（重跑才死：不稳定）\n`); continue }
  survivors.push(mu)
  process.stdout.write(`  ${paint.dim('SURVIVED')} ${mu.rel}:${mu.line} ${mu.op} ${mu.from} → ${mu.to}\n`)
}
restoreAll()
assertRestored('收尾')
fs.rmSync(work, { recursive: true, force: true })

const score = mutants.length === 0 ? 0 : (killed / mutants.length) * 100
const threshold = Number(thresholds().mutation)
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'reports/mutation.json'), JSON.stringify({ at: new Date().toISOString(), files: FILES, tests: TESTS, planned: all.length, ran: mutants.length, killed, score, survivors }, null, 2) + '\n')

process.stdout.write(`\n本轮 ${mutants.length} 个变异体：KILLED ${killed}，存活 ${survivors.length}\n`)
process.stdout.write(`变异得分 ${score.toFixed(2)}%（阈值 ${threshold}%） · 完整结果 reports/mutation.json\n`)
if (survivors.length) {
  process.stdout.write(paint.dim(`\n存活清单（每个都要给结论：补测试，或证明是等价变异体）：\n`))
  for (const s of survivors) process.stdout.write(`  ${s.rel}:${s.line}  ${s.op}  ${s.from} → ${s.to}\n`)
}
if (mutants.length < all.length) process.stdout.write(paint.dim(`\n注意：还有 ${all.length - mutants.length} 个没跑（--max 截断），别当全量得分。\n`))
process.exit(verdict('mutation', score >= threshold, `${score.toFixed(2)}% ≥ 阈值 ${threshold}%`))
