// 依赖环门禁：src / web / bin 之间出现循环依赖就是真实缺陷（不是风格问题），退出码非零。

import { run, verdict, paint, ROOT } from './lib.mjs'

let parsed = null
let raw = ''
try {
  raw = run('npx', ['--no-install', 'madge', '--circular', '--json', '--extensions', 'js,mjs', 'src', 'web/js', 'bin'], { cwd: ROOT })
} catch (e) {
  raw = String(e.stdout || '')
  process.stdout.write(String(e.stderr || '').split('\n').slice(-5).join('\n') + '\n')
}
try { parsed = JSON.parse(raw) } catch { /* 解析不出就把原文打出来，别静默通过 */ }

if (parsed === null) {
  process.stdout.write(paint.dim('\nmadge 输出无法解析，原始输出：\n') + raw.slice(0, 2000) + '\n')
  process.exit(verdict('cycles', false, 'madge 输出无法解析'))
}
// --circular --json 直接给"环的列表"；不同版本也可能是 {circular: []}
const cycles = Array.isArray(parsed) ? parsed : (parsed.circular || [])
process.stdout.write(`发现 ${cycles.length} 个依赖环：\n`)
for (const c of cycles) process.stdout.write('  ' + c.join(' → ') + '\n')
process.exit(verdict('cycles', cycles.length === 0, cycles.length ? `${cycles.length} 个依赖环` : '无依赖环'))
