// 复杂度报告。**只报告，永不失败**（playbook §5 陷阱一）。
//
// 为什么不设 CCN 上限：
//   每个 if/catch 都是一条分支。某函数 CCN 29 里 18 个来自 catch 块，全删掉 CCN→11、CRAP 870→121，
//   指标大幅改善而代码更脆弱（那些 catch 是为了让一次 API 抖动不丢 10 分钟的分析）。
//   所以 CCN 只当"哪里需要测试"的指示器，不是一个要满足的阈值。
//
// 同理 CRAP：覆盖率 100% 时 CRAP 退化成 CCN 本身，"CRAP ≤ 8" 实质就是"CCN ≤ 8"。

import { run, paint, ROOT } from './lib.mjs'

const warnCc = process.argv.includes('--ccn') ? Number(process.argv[process.argv.indexOf('--ccn') + 1]) : 10

let out = ''
try {
  out = run('lizard', ['src', 'web/js', 'bin', '-C', String(warnCc), '--exclude', '*/node_modules/*', '--exclude', '*/vendor/*'], { cwd: ROOT })
} catch (e) {
  out = String(e.stdout || '') + String(e.stderr || '')
}
const tail = out.split('\n').filter(Boolean).slice(-12)
process.stdout.write(tail.join('\n') + '\n')

const rows = out.split('\n')
  // 函数行：NLOC CCN token PARAM length  location(name@起-止@文件)；汇总行带小数，会被跳过
  .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+@\S+)$/.exec(l))
  .filter(Boolean)
  .map((m) => ({ ccn: Number(m[2]), nloc: Number(m[1]), where: m[6] }))
// lizard 对多路径会把同一函数重复列出，按 location 去重
const seen = new Set()
const worst = rows.filter((r) => !seen.has(r.where) && seen.add(r.where)).sort((a, b) => b.ccn - a.ccn).slice(0, 10)

process.stdout.write(paint.dim(`\nCCN 最高的 10 个函数（只报告，不作为失败条件；--ccn N 可查超过 N 的）：\n`))
for (const w of worst) {
  const [fn, range, file] = w.where.split('@')
  process.stdout.write(`  CCN ${String(w.ccn).padStart(3)}  ${String(w.nloc).padStart(4)} 行  ${file} :: ${fn} (${range})\n`)
}
process.stdout.write('\n复杂度只看趋势；判据是行为等价 + 变异得分不降。\n')
process.exit(0)
