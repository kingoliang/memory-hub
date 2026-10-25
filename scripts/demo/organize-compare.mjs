// 内容组织前后对比（GH #4 / #5）：在演示库上叠一层「改写卡 / 周期性快照 / 大小写变体标签」合成数据，
// 对比旧规则（只看正文 bigram Jaccard、规范写法按当天计数）与新规则（多信号同主题组、快照序列、持久化规范表）。
// 全部合成数据、确定性；不改任何已有库。
//
// 用法：node scripts/demo/organize-compare.mjs <空的临时目录>

import { seedDemoLibrary } from './seed-demo.mjs'
import { getDb, closeDb } from '../../src/core/db.js'
import { writeCard } from '../../src/core/vault.js'
import { tidyPlan, tidyApply, planTagNormalize } from '../../src/core/tidy.js'
import { tagKey } from '../../src/core/tags.js'
import { titleStem } from '../../src/core/topics.js'

const quiet = { logger: () => {} }

/** 叠加「乱」的一层：同主题改写卡、周期性快照、大小写变体标签（直接 writeCard，绕过写入归一，模拟旧数据）。 */
async function addMessyLayer(root) {
  const rewrites = [
    'ModelX-7B 在 GPU-A100 机器上的部署实测', 'ModelX-7B 在 GPU-A100 机器上部署实测（补充）', 'ModelX-7B GPU-A100 部署实测记录',
    'ModelX-7B 在 GPU-A100 上的部署与吞吐实测', 'ModelX-7B 部署实测：GPU-A100 机器', 'ModelX-7B 在 GPU-A100 机器上的部署实测 v2',
  ]
  const phr = ['用 vLLM 0.6 起服务，显存占用约七成。', '首包延迟在两秒内，长上下文时吞吐下降明显。', '量化到 int8 后吞吐提升，精度损失可接受。', '并发四路时最稳，再高会排队。', '需要关掉自动更新避免驱动被换。', '启动脚本里固定了端口与日志目录。']
  const paths = []
  for (let i = 0; i < rewrites.length; i++) {
    const r = await writeCard(root, { kind: 'project', title: rewrites[i], tags: [i % 2 ? 'modelx' : 'ModelX', '部署'], body: `# ${rewrites[i]}\n\nModelX-7B 在 GPU-A100 上的第 ${i + 1} 次整理。\n${phr[i % phr.length]}\n${phr[(i + 2) % phr.length]}`, source: 'demo', submittedBy: 'demo', status: 'approved' }, { dedup: false })
    paths.push(r.path)
  }
  // 班次快照：一天几张、标题前缀相同而尾巴不同（真实库的形态）；只用前缀 + 日期才归得出来
  for (let d = 1; d <= 5; d++) {
    const day = `2026-10-${String(d).padStart(2, '0')}`
    for (const [h, tail] of [[1, '成本线下穿，仓位减半'], [9, '横盘，网格补回'], [17, '回撤，子仓止损'], [23, '收工，网格全平']]) {
      await writeCard(root, {
        kind: 'project', title: `值班巡检快照 ${day} ${String(h).padStart(2, '0')}:00 UTC: ${tail}，负载 ${d}${h}`,
        tags: [d % 3 ? 'oncall' : 'OnCall'], body: `# 值班巡检快照\n\n队列积压 ${d * h} 条，错误率 0.${d}%，磁盘 ${40 + d}%。`, source: 'demo', submittedBy: 'demo', status: 'approved',
      }, { dedup: false })
    }
  }
  return paths
}

function tagRows(db) { return db.prepare('SELECT id, path, title, tags FROM cards ORDER BY id').all() }

async function main() {
  const root = process.argv[2]
  if (!root) { console.error('用法：node scripts/demo/organize-compare.mjs <空的临时目录>'); process.exit(2) }
  await seedDemoLibrary(root, { cards: 360 })
  const rewritePaths = new Set(await addMessyLayer(root))
  const db = getDb(root)
  const total = db.prepare('SELECT COUNT(*) n FROM cards').get().n

  // demo 里的卡都是「刚刚」写的，关掉 24 小时新鲜度门槛才能看到快照序列
  const planOpts = { ...quiet, snapshotMinAgeHours: 0 }
  const plan = await tidyPlan(root, planOpts)
  const plan2 = await tidyPlan(root, planOpts)
  // 6 张同主题改写卡里，各规则能归到一组的张数
  const inDup = new Set(plan.duplicates.flatMap((g) => [g.canonical.path, ...g.absorbs.map((a) => a.path)]).filter((p) => rewritePaths.has(p)))
  const inTopic = new Set(plan.topics.flatMap((g) => [g.canonical.path, ...g.members.map((m) => m.path)]).filter((p) => rewritePaths.has(p)))
  const snapCards = plan.snapshots.reduce((n, g) => n + g.count, 0)
  // 旧算法在同样的班次快照上按「kind + 完整标题主干」分组：正是 GH #11 的 0 命中
  const snapRows = db.prepare("SELECT kind, title FROM cards WHERE title LIKE '值班巡检快照 %'").all()
  const oldSnapGroups = new Map()
  for (const r of snapRows) {
    const k = `${r.kind}\u0000${titleStem(r.title)}`
    oldSnapGroups.set(k, (oldSnapGroups.get(k) || 0) + 1)
  }
  const oldHits = [...oldSnapGroups.values()].filter((n) => n >= 3)

  // 标签翻转：旧规则（无规范表）在「小写写法计数反超」后会改选规范写法；新规则钉住第一次的选择
  const before = planTagNormalize(tagRows(db), { maxTags: 6 })
  const k = tagKey('ModelX')
  const firstOld = before.decided[k]
  const flipTo = firstOld === 'ModelX' ? 'modelx' : 'ModelX'
  await tidyApply(root, { ...quiet, confirm: true, planId: plan.planId, batches: ['tags'] })
  for (let i = 0; i < 12; i++) await writeCard(root, { kind: 'project', title: `补充 ${i}`, tags: [flipTo], body: `# 补充 ${i}\n\nModelX 补充说明第 ${i} 条，内容各不相同 ${i * 13}。`, source: 'demo', submittedBy: 'demo', status: 'approved' }, { dedup: false })
  const oldAfter = planTagNormalize(tagRows(db), { maxTags: 6 }).map[firstOld] ?? firstOld
  const after = await tidyPlan(root, { ...quiet, sections: ['tags'] })
  const newAfter = after.tags.map[flipTo] ?? flipTo

  const rows = [
    ['卡片总数（合成）', total, total],
    [`同主题改写卡（共 ${rewritePaths.size} 张）被归组的张数`, `${inDup.size}（只看正文 Jaccard）`, `${new Set([...inDup, ...inTopic]).size}（近重复 + 多信号同主题组）`],
    [`班次快照共 ${snapRows.length} 张，被识别出的序列 / 张数`, `${oldHits.length} 组 / ${oldHits.reduce((a, b) => a + b, 0)} 张（要求整条标题主干相等）`, `${plan.snapshots.length} 组 / ${snapCards} 张（前缀 + 日期 + 证据）`],
    ['标签种类（归一前 → 后）', `${before.distinctBefore}`, `${before.distinctBefore} → ${before.distinctAfter}`],
    ['「ModelX」小写写法计数反超后的规范写法', `${firstOld} → ${oldAfter}${oldAfter !== firstOld ? '（翻转）' : ''}`, `${firstOld} → ${newAfter === flipTo ? firstOld : newAfter}（规范表钉住）`],
    ['连续两次 tidy plan 的 planId', '—', plan.planId === plan2.planId ? `一致（${plan.planId}）` : '不一致'],
  ]
  console.log('| 指标 | 旧规则 | 新规则 |\n|---|---|---|')
  for (const [a, b, c] of rows) console.log(`| ${a} | ${b} | ${c} |`)
  closeDb(root)
}

await main()
