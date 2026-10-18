// 死代码报告（knip）。**默认只报告，不失败**；--strict 才用退出码说话。
//
// 为什么不默认失败（playbook 坑一、坑二）：knip 在子目录下运行时看不到兄弟目录的反向 import、
// HTML 的 <script src>、二进制 spawn。loganalysis 实测：它报的"3 个死导出 + 2 个孤儿文件"**全错**，
// 照做会破坏 evals/self-evolve.mjs。而且它说的是"没有外部按名 import"，不是"零引用"。
//
// 删任何东西之前走三项全空的核实程序：
//   grep -rn '\bSYM\b' <整个仓库> | grep -v node_modules   # 含定义文件本身
//   grep -rn 'SYM' *.html
//   grep -rn 'SYM|<bin-name>' --include='*.json' .

import { run, verdict, paint, ROOT } from './lib.mjs'

const strict = process.argv.includes('--strict')
let out = ''
let failed = false
try {
  out = run('npx', ['--no-install', 'knip', '--no-progress', '--reporter', 'compact'], { cwd: ROOT })
} catch (e) {
  out = String(e.stdout || '') + String(e.stderr || '')
  failed = true
}
process.stdout.write(out.split('\n').slice(-60).join('\n') + '\n')

const count = (label) => {
  const m = new RegExp(`(\\d+)\\s+${label}`, 'i').exec(out)
  return m ? Number(m[1]) : 0
}
const unusedFiles = count('unused files')
const unusedExports = count('unused exports')
process.stdout.write(`\n未使用文件 ${unusedFiles} · 未使用导出 ${unusedExports}`)
process.stdout.write(paint.dim('（"未使用导出"多半不是死代码；删前必须三项全空核实）\n'))

if (!strict && !failed) process.exit(0)
process.exit(verdict('deadcode', !failed && (!strict || (unusedFiles === 0 && unusedExports === 0)), failed ? 'knip 自身失败' : 'strict'))
