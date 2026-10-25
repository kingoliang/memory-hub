#!/usr/bin/env node
// memory-hub 每日整理（保守版）：备份 → lint/plan → 应用高置信可逆批次（merge + tags）→ 写报告。
// 直接调用同一代码目录里的 src/core/tidy.js（与管理台"整理中心"同一份实现：先 VACUUM INTO 备份、
// 批次事务 + 自检、只软删、写回滚文件），不经 MCP，因此不需要 exposeTidyApply，也不需要令牌。
// 代码与脚本同属一个目录树（按本文件位置解析 ../src/core），部署时随代码一起升级，接口不会错配。
//
// 用法：node scripts/tidy-daily.mjs [--apply] [选项]     缺省 = dry-run（只出 plan 与报告，不改库）
//   --home DIR          数据目录（含 memory-eternal.db）。缺省取 MEMORY_HUB_HOME
//   --report-dir DIR    报告目录，缺省 <home>/tidy-reports
//   --threshold N       近重复合并阈值，缺省 0.85（TIDY_THRESHOLD）
//   --max-delete N      单次最多软删张数，缺省 10（TIDY_MAX_DELETE）
//   --batches a,b       自动应用的批次，缺省 merge,tags（TIDY_AUTO_BATCHES）；可选 merge/tags/topics/snapshots，noise 永远只进报告
//   --help
// 退出码：0 正常；1 整理失败/应用失败；2 参数错误。
//
// 自动应用：merge（近重复合并，高阈值，保留卡并入独特行，被吸收卡软删）、tags（标签规整，写回滚文件）
// 只进报告：noise（启发式噪声卡）、kind 错放、密钥疑似、超大 raw 卡、低于自动阈值的重复组
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const imp = (f) => import(pathToFileURL(path.join(CODE_ROOT, 'src/core', f)).href)

const HELP = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')

const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : d }

/** 解析参数 + 环境变量。出错返回 { error }。 */
export function parseArgs(argv, env = process.env) {
  const o = { apply: false, home: env.MEMORY_HUB_HOME, reportDir: '', threshold: num(env.TIDY_THRESHOLD, 0.85), maxDelete: Math.floor(num(env.TIDY_MAX_DELETE, 10)), batches: (env.TIDY_AUTO_BATCHES || 'merge,tags'), help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} 需要参数`); return v }
    if (a === '--apply') o.apply = true
    else if (a === '--dry-run') o.apply = false
    else if (a === '--home') o.home = val()
    else if (a === '--report-dir') o.reportDir = val()
    else if (a === '--threshold') o.threshold = num(val(), NaN)
    else if (a === '--max-delete') o.maxDelete = Math.floor(num(val(), NaN))
    else if (a === '--batches') o.batches = val()
    else if (a === '--help' || a === '-h') o.help = true
    else return { error: `未知参数：${a}` }
  }
  if (!Number.isFinite(o.threshold) || o.threshold <= 0 || o.threshold > 1) return { error: `--threshold 必须在 (0,1]：${o.threshold}` }
  if (!Number.isFinite(o.maxDelete) || o.maxDelete < 0) return { error: `--max-delete 必须是非负整数` }
  o.batches = String(o.batches).split(',').map((s) => s.trim()).filter(Boolean)
  return o
}

/**
 * 跑一次整理，返回退出码（不调 process.exit，便于测试）。
 * @param {ReturnType<typeof parseArgs>} o
 * @param {{stderr?: (s:string)=>void, now?: Date}} [io]
 */
export async function runTidyDaily(o, { stderr = (s) => process.stderr.write(s), now = new Date() } = {}) {
  const apply = o.apply
  const root = o.home
  if (!root) { stderr('未指定数据目录：请传 --home 或设置 MEMORY_HUB_HOME\n'); return 2 }
  const { getDb, backupDb, closeAllDb } = await imp('db.js')
  const T = await imp('tidy.js')
  const { writeLog } = await imp('writelog.js')
  const THRESHOLD = o.threshold
  const MAX_DELETE = o.maxDelete
  const AUTO = o.batches
  const allowed = T.ALL_TIDY_BATCHES || T.TIDY_BATCHES // topics / snapshots 属可选批次，显式传入才跑
  for (const b of AUTO) if (!allowed.includes(b) || b === 'noise') { stderr(`不允许自动批次：${b}（可选 ${allowed.filter((x) => x !== 'noise').join('/')}；noise 只进报告）\n`); return 2 }
  const day = now.toISOString().slice(0, 10)
  const reportDir = o.reportDir ? path.resolve(o.reportDir) : path.join(root, 'tidy-reports')
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 })
  let reportFile = path.join(reportDir, `${day}.md`)
  if (fs.existsSync(reportFile)) reportFile = path.join(reportDir, `${day}-${now.toISOString().slice(11, 19).replace(/:/g, '')}.md`)

  // 标题只截 40 字，并过一遍密钥脱敏；正文永不进报告
  const t40 = (s) => { const x = T.redactSecrets(String(s || '')).text.replace(/[\r\n|]+/g, ' '); return [...x].slice(0, 40).join('') }
  const lines = []
  const L = (s = '') => lines.push(s)
  const log = (lvl, m) => stderr(`[tidy-daily] ${new Date().toISOString()} ${lvl} ${m}\n`)

  let exitCode = 0
  let backupFile = null
  let applied = null
  try {
    const db = getDb(root)
    try { db.exec('PRAGMA busy_timeout = 20000') } catch { /* ignore */ }

    // 1. 先备份（dry-run 不改库，只在 apply 时备份；备份失败即中止，不做任何改动）
    if (apply) {
      const b = await backupDb(root)
      if (!b?.ok) throw new Error(`备份失败，已中止（未改库）：${b?.error || JSON.stringify(b)}`)
      backupFile = b.path
      log('INFO', `备份完成 ${backupFile}`)
    }

    // 2. lint + plan
    const opts = { threshold: THRESHOLD, maxDelete: MAX_DELETE, logger: () => {} }
    const lint = await T.tidyLint(root, opts)
    const plan = await T.tidyPlan(root, opts)
    const lowPlan = THRESHOLD > 0.62 ? await T.tidyPlan(root, { ...opts, threshold: 0.62, sections: ['duplicates'] }) : plan
    const autoDup = plan.duplicates
    const autoDupAbsorb = autoDup.reduce((n, g) => n + g.absorbs.length, 0)

    // 3. dry-run 预览（取 planId）
    const preview = await T.tidyApply(root, { ...opts, batches: AUTO })
    log('INFO', `plan=${preview.planId} 自动批次=${AUTO.join(',')} 预计软删=${preview.plannedDeletes} ok=${preview.ok} code=${preview.code || ''}`)

    // 4. 真正应用（仅 --apply 且预览 ok）
    if (apply) {
      if (!preview.ok) {
        applied = { skipped: true, reason: `${preview.code}: ${preview.error}` }
      } else {
        const res = await T.tidyApply(root, { ...opts, batches: AUTO, confirm: true, planId: preview.planId })
        applied = res
        if (!res.ok) exitCode = 1
      }
      try {
        writeLog(root, { actorType: 'system', actorId: 'tidy-daily', actorName: 'tidy-daily', tool: 'tidy-daily.mjs', action: 'tidy_apply', outcome: applied?.ok ? 'ok' : 'error', args: { planId: preview.planId, batches: AUTO, threshold: THRESHOLD } })
      } catch (e) { log('WARN', `write_log 失败：${e.message}`) }
    }

    // 5. 报告
    L(`# memory-hub 每日整理报告 ${day}`)
    L()
    L(`- 生成时间：${now.toISOString()}（服务器时区 UTC）`)
    L(`- 模式：**${apply ? 'APPLY（已应用自动批次）' : 'DRY-RUN（未改库）'}**`)
    L(`- 库：${root}（卡片 ${lint.total} 张，回收站 ${lint.quarantine.deleted}，待审 ${lint.quarantine.pending}，integrity=${lint.integrity}）`)
    L(`- 参数：自动批次=${AUTO.join('+')}，合并阈值=${THRESHOLD}，maxDelete=${MAX_DELETE}，planId=${preview.planId}`)
    if (backupFile) L(`- 备份：${backupFile}`)
    L()
    L('## 一、自动批次（高置信、可逆）')
    L()
    L(`### 近重复合并（阈值 ${THRESHOLD}）：${autoDup.length} 组 / 将软删 ${autoDupAbsorb} 张`)
    for (const g of autoDup.slice(0, 30)) {
      L(`- 保留「${t40(g.canonical.title)}」 ← 吸收 ${g.absorbs.map((a) => `「${t40(a.title)}」(sim ${a.sim}, 独特行 ${a.uniqueLines})`).join('、')}`)
    }
    if (autoDup.length > 30) L(`- … 另有 ${autoDup.length - 30} 组`)
    L()
    L(`### 标签规整：${plan.tags.changes.length} 张卡将改动；标签种类 ${plan.tags.distinctBefore} → ${plan.tags.distinctAfter}`)
    for (const [k, v] of Object.entries(plan.tags.map || {}).slice(0, 20)) L(`- ${t40(k)} → ${t40(Array.isArray(v) ? v.join(',') : v)}`)
    L()
    if (apply) {
      L('### 应用结果')
      if (!applied) L('- 无')
      else if (applied.skipped) L(`- 跳过：${applied.reason}`)
      else {
        L(`- 总体 ok=${applied.ok}`)
        for (const b of applied.batches || []) L(`- 批次 ${b.name}：${b.status} ${JSON.stringify(b.counts || {})}${b.error ? ' 错误=' + t40(b.error) : ''}`)
        if (applied.backup?.path) L(`- 整理前备份：${applied.backup.path}`)
        if (applied.rollbackFile) L(`- 回滚文件：${applied.rollbackFile}`)
        if (applied.after) L(`- 整理后：cards=${applied.after.cards} 回收站=${applied.after.deleted}`)
      }
      L()
    }
    L('## 二、只进报告（需人判断，本任务不会自动执行）')
    L()
    const lowAbsorb = lowPlan.duplicates.reduce((n, g) => n + g.absorbs.length, 0)
    const autoPaths = new Set(autoDup.flatMap((g) => [g.canonical.path, ...g.absorbs.map((a) => a.path)]))
    const extraGroups = lowPlan.duplicates.filter((g) => ![g.canonical.path, ...g.absorbs.map((a) => a.path)].some((p) => autoPaths.has(p)))
    L(`### 较低相似度重复组（阈值 0.62~${THRESHOLD}）：${extraGroups.length} 组（全阈值 0.62 下共 ${lowPlan.duplicates.length} 组 / ${lowAbsorb} 张可吸收）`)
    for (const g of extraGroups.slice(0, 20)) L(`- 「${t40(g.canonical.title)}」 ~ ${g.absorbs.map((a) => `「${t40(a.title)}」(sim ${a.sim})`).join('、')}`)
    if (extraGroups.length > 20) L(`- … 另有 ${extraGroups.length - 20} 组`)
    L()
    L(`### 噪声卡候选（启发式，不自动删）：${plan.noise.length} 张`)
    for (const n of plan.noise.slice(0, 30)) L(`- [${n.category}] 「${t40(n.title)}」`)
    if (plan.noise.length > 30) L(`- … 另有 ${plan.noise.length - 30} 张`)
    L()
    L(`### 密钥疑似（只列路径+类型，值不出现）：${plan.secrets.length} 张`)
    for (const s of plan.secrets.slice(0, 30)) L(`- ${t40(s.path)} : ${s.types.join(',')}`)
    L()
    L(`### kind 错放：${plan.kindMisplaced.length} 张`)
    for (const k of plan.kindMisplaced.slice(0, 20)) L(`- ${t40(k.path)} : ${k.kind} → ${k.expectedKind}`)
    L()
    L(`### 超大 raw 卡（>${plan.options.rawMaxChars} 字）：${plan.oversizeRaw.length} 张`)
    for (const r of plan.oversizeRaw.slice(0, 20)) L(`- 「${t40(r.title)}」 ${r.chars} 字`)
    L()
    L('## 三、Lint 指标')
    L()
    L(`- 总卡 ${lint.total}；噪声候选 ${lint.noise}；重复组 ${lint.duplicateGroups}（可吸收 ${lint.duplicateAbsorbable}）；标签种类 ${lint.tagsDistinct}（单次出现 ${lint.tagsSingleton}，变体组 ${lint.tagVariantGroups}，超 ${plan.options.maxTags} 个 ${lint.tagsOver4}，损坏 ${lint.tagsMalformed}）`)
    L(`- 回收站：待审 ${lint.quarantine.pending} / 驳回 ${lint.quarantine.rejected} / 已删 ${lint.quarantine.deleted}；最旧已删 ${lint.recycleOldest || '无'}`)
    L(`- integrity_check=${lint.integrity}`)
  } catch (e) {
    // 失败也要落一份报告（finally 里写）
    exitCode = 1
    log('ERROR', `整理失败：${e?.message || e}`)
    L(`# memory-hub 每日整理报告 ${day}（失败）`)
    L()
    L(`- 模式：${apply ? 'APPLY' : 'DRY-RUN'}；错误：${T.redactSecrets(String(e?.message || e)).text.slice(0, 300)}`)
    if (backupFile) L(`- 备份：${backupFile}`)
  } finally {
    fs.writeFileSync(reportFile, lines.join('\n') + '\n', { mode: 0o600 })
    log('INFO', `报告 ${reportFile} (${fs.statSync(reportFile).size} 字节) exit=${exitCode}`)
    try { closeAllDb() } catch { /* ignore */ }
  }
  return exitCode
}

// 作为脚本直接运行时才执行（测试里 import 本文件不会触发）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2))
  if (o.error) { process.stderr.write(`${o.error}\n`); process.exit(2) }
  if (o.help) { process.stdout.write(HELP + '\n'); process.exit(0) }
  runTidyDaily(o).then((code) => process.exit(code), (e) => { process.stderr.write(`[tidy-daily] 未预期错误：${e?.stack || e}\n`); process.exit(1) })
}
