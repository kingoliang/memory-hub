// 门禁脚本公共工具。所有质量脚本都从这里取"哪些文件算生产代码"和阈值。
//
// 关键约定（playbook §0）：**覆盖率分母来自 git ls-files，不是工具输出**。
// 工具只统计"被加载过"的文件；没有任何测试 import 的模块不显示 0%，而是根本不出现。
// loganalysis 因此读作 72%，真实值 35.4%。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 生产代码口径（工具链自己不算）。改这里要同步 CLAUDE.md。 */
export const SOURCE_GLOBS = ['src/**/*.js', 'web/js/**/*.js', 'bin/*.mjs']

export function gitFiles(globs = SOURCE_GLOBS) {
  // 必须用 :(glob) 魔法：普通 pathspec 里 `**` 不匹配零层目录，'src/**/*.js' 会漏掉 src/server.js、web/js/*.js 这类顶层文件，
  // 分母悄悄缩水 —— 正是本脚本要防的那种覆盖率幻觉（2026-10-19 实测漏了 17 个生产文件）。
  const out = execFileSync('git', ['ls-files', ...globs.map((g) => `:(glob)${g}`)], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').map((s) => s.trim()).filter(Boolean).sort()
}

export function thresholds() {
  const file = path.join(ROOT, 'scripts/quality/thresholds.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    // 阈值文件坏掉时不能静默用 0（那等于门禁失效），直接报出来
    process.stderr.write(`[gate] 读不到阈值文件 ${file}：${e.message}\n`)
    throw e
  }
}

/** 源文件的有效行数（非空、非纯注释）——未被执行过时作为分母。 */
export function codeLines(abs) {
  const src = fs.readFileSync(abs, 'utf8')
  let inBlock = false
  let n = 0
  for (const raw of src.split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) continue
      line = line.slice(end + 2); inBlock = false
    }
    line = line.replace(/\/\*[\s\S]*$/, (m) => { inBlock = !m.includes('*/'); return '' })
    if (/^\s*(\/\/|$)/.test(line)) continue
    n++
  }
  return n
}

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

const RED = (s) => `\u001b[31m${s}\u001b[0m`
const GREEN = (s) => `\u001b[32m${s}\u001b[0m`
const DIM = (s) => `\u001b[2m${s}\u001b[0m`
export const paint = { red: RED, green: GREEN, dim: DIM }

/** 统一收尾：打印结论并设置退出码。门禁脚本必须靠退出码说话，不能只打印。 */
export function verdict(label, ok, detail) {
  process.stdout.write(`\n${ok ? GREEN('PASS') : RED('FAIL')} ${label}${detail ? ' · ' + detail : ''}\n`)
  return ok ? 0 : 1
}
