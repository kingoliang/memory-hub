// 死代码报告（knip）。**默认只报告，不失败**；--strict 才用退出码说话。
//
// 为什么不默认失败（playbook 坑一、坑二）：knip 只做静态可达性分析，看不到
// HTML 的 <script src>、二进制 spawn、`node scripts/x.mjs` 这种字符串调用。
// loganalysis 实测：它报的"3 个死导出 + 2 个孤儿文件"**全错**，照做会破坏 evals/self-evolve.mjs。
// 而且它说的是"没有外部按名 import"，不是"零引用"—— 两回事。
//
// 退出码语义：knip 自己就是"有发现 → 退出 1"，所以 >1 才算它自身失败。
//
// 删任何东西之前走三项全空的核实程序：
//   grep -rn '\bSYM\b' <整个仓库> | grep -v node_modules   # 含定义文件本身
//   grep -rn 'SYM' *.html
//   grep -rn 'SYM|<bin-name>' --include='*.json' .

import { spawnSync } from 'node:child_process'
import { verdict, paint, ROOT } from './lib.mjs'

const strict = process.argv.includes('--strict')
const r = spawnSync('npx', ['--no-install', 'knip', '--no-progress', '--reporter', 'compact'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const out = `${r.stdout || ''}${r.stderr || ''}`
process.stdout.write(out.split('\n').slice(-40).join('\n') + '\n')

const broke = r.status === null || r.status > 1 || out.trim() === ''
const count = (label) => {
  const m = new RegExp(`(\\d+)\\s+${label}`, 'i').exec(out)
  return m ? Number(m[1]) : 0
}
const unusedFiles = count('unused files')
const unusedExports = count('unused exports')
process.stdout.write(`\n未使用文件 ${unusedFiles} · 未使用导出 ${unusedExports} · 未使用依赖 ${count('unused dependencies')}`)
process.stdout.write(paint.dim('（"未使用导出"多半不是死代码；删前必须三项全空核实）\n'))

if (broke) process.exit(verdict('deadcode', false, `knip 自身失败（exit ${r.status}）`))
if (!strict) {
  process.stdout.write(paint.dim('默认只报告：knip 静态分析看不到字符串形式的调用，误报率高。--strict 才当门禁。\n'))
  process.exit(0)
}
process.exit(verdict('deadcode', unusedFiles === 0 && unusedExports === 0, `strict：未使用文件 ${unusedFiles} / 导出 ${unusedExports}`))
