// GH #11：快照序列检测按「标题前缀 + 日期段 + 证据 + 时间门槛」聚合，不再要求整条标题主干全等。
// fixture 用生产真实班次快照标题（脱敏，均无主机名 / IP / 内部路径 / 卡片正文）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { closeAllDb, insertCard, cjk, tmpDir, fingerprint } from './tidy-fixture.mjs'
import { ensureVault } from '../../src/core/vault.js'
import { getDb } from '../../src/core/db.js'
import { tidyPlan, tidyApply, tidyRollback } from '../../src/core/tidy.js'
import {
  titleStem, hasTimestamp, snapshotPrefix, snapshotSeriesKey, snapshotDay, snapshotTimelineTitle, planSnapshotSeries,
} from '../../src/core/topics.js'

after(() => closeAllDb())
const quiet = { logger: () => {} }
const NOW = '2026-10-25T12:00:00.000Z'

async function freshVault() {
  const root = await tmpDir('mc-snap-')
  await ensureVault(root)
  return { root, db: getDb(root) }
}

// 生产标题的形态：前缀固定、日期时间在前、尾巴每次不同的描述
const TITLES = [
  ['2026-10-16', 'COMBO 值班 10-16 09:12 UAE：成本线下穿，NEAR 减半'],
  ['2026-10-16', 'COMBO 值班 10-16 13:40 UAE：横盘，NEAR 补回'],
  ['2026-10-16', 'COMBO 值班 10-16 22:05 UAE：本班收平，SUI 触线'],
  ['2026-10-17', 'COMBO 值班 10-17 01:38 UAE：微正、NEAR 回 5.0 上方、焦点 SUI 场线 -2.9%'],
  ['2026-10-17', 'COMBO 值班 10-17 01:45 UAE：网格翻回成本上方、NEAR 回 5.0 上方'],
  ['2026-10-17', 'COMBO 值班 10-17 22:45 UAE：本班回正、SUI 破线待清仓'],
  ['2026-10-18', 'COMBO 值班 10-18 02:10 UAE：换手放大，NEAR 追高'],
  ['2026-10-18', 'COMBO 值班 10-18 06:30 UAE：回撤，SUI 子仓止损'],
  ['2026-10-18', 'COMBO 值班 10-18 23:50 UAE：收工，网格全平'],
]

const mk = (id, title, { kind = 'project', tags = ['combo', '值班'], body, at } = {}) => ({
  id,
  path: `02-Projects/snap-${id}.md`,
  kind,
  title,
  tags,
  body: body ?? `# 快照\n\nCOMBO 值班 UAE NEAR SUI 记录：${cjk(80)}`,
  createdAt: at || `${title.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '2026-10-16'}T00:00:00.000Z`,
  updatedAt: at || `${title.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '2026-10-16'}T00:00:00.000Z`,
})

const cardsOf = (list, extra = {}) => list.map(([day, title], i) => mk(i + 1, title, { at: `${day}T00:00:00.000Z`, ...extra }))

// ---------------------------------------------------------------------------
// 前缀抽取 / 日期段
// ---------------------------------------------------------------------------

test('snapshotPrefix：剥时间戳后取第一个分隔符之前，且前缀必须含非数字词', () => {
  assert.equal(snapshotPrefix('COMBO 值班 10-17 01:45 UAE：网格翻回成本上方、NEAR 回 5.0 上方'), 'COMBO 值班 UAE')
  assert.equal(snapshotPrefix('COMBO 值班 10-17 01:38 UAE: 微正、NEAR 回 5.0 上方'), 'COMBO 值班 UAE', 'NFKC 归一后的半角冒号同样算分隔符')
  assert.equal(snapshotPrefix('值班巡检快照 2026-10-12 09:00｜状态正常'), '值班巡检快照')
  assert.equal(snapshotPrefix('批次回溯 2026-10-12 — 第一段'), '批次回溯')
  assert.equal(snapshotPrefix('ModelX-7B 部署 2026-10-12'), 'ModelX', '没有空格保护的连字符也是分隔符')
  assert.equal(snapshotPrefix('巡检 2026-10-12'), '巡检', '没有分隔符就整段做前缀')
  assert.equal(snapshotPrefix('2026-10-12'), '', '纯日期不算前缀')
  assert.equal(snapshotPrefix('2026-10-12 09:00'), '', '纯日期时间不算')
  assert.equal(snapshotPrefix(''), '')
})

test('snapshotDay：YYYY-MM-DD / YYYYMMDD / MM-DD 归一；无日期返回空', () => {
  assert.equal(snapshotDay('COMBO 值班 2026-10-17 01:38 UAE：微正'), '2026-10-17')
  assert.equal(snapshotDay('COMBO 值班 10-17 01:38 UAE：微正'), '10-17')
  assert.equal(snapshotDay('日报 20261025 收尾'), '2026-10-25')
  assert.equal(snapshotDay('日报 2026/10/5'), '2026-10-05')
  assert.equal(snapshotDay('巡检 #12'), '')
  assert.equal(snapshotDay('巡检 回 5.0 上方'), '')
  assert.equal(snapshotTimelineTitle('COMBO 值班 UAE', '2026-10-17'), 'COMBO 值班 UAE 2026-10-17（时间线）')
  assert.equal(snapshotTimelineTitle('巡检', ''), '巡检（时间线）')
})

test('snapshotSeriesKey：分隔符残渣（– / ~ / /）归一到同一个 key，纯数字词跳过', () => {
  // stripStamps() 剥时间后残留的分隔符写法：同一批次里三种都可能出现
  assert.equal(snapshotSeriesKey('COMBO 值班 – UAE'), 'combo 值班')
  assert.equal(snapshotSeriesKey('COMBO 值班 ~ UAE'), 'combo 值班')
  assert.equal(snapshotSeriesKey('COMBO 值班/UAE'), 'combo 值班')
  assert.equal(snapshotSeriesKey('COMBO 值班 UAE'), 'combo 值班', '没有残渣的写法同键')
  assert.equal(snapshotSeriesKey('Combo  值班\u3000UAE extra'), 'combo 值班', 'NFKC + 小写 + 折叠空白 + 只取前 2 个词')
  assert.equal(snapshotSeriesKey('3.5 巡检 记录'), '巡检 记录', '纯数字词不算，避免落到「3 5」')
  assert.equal(snapshotSeriesKey(''), '')
  // 前 2 个词不同就是两个序列
  assert.notEqual(snapshotSeriesKey('COMBO 网格 UAE'), snapshotSeriesKey('COMBO 值班 UAE'))
})

// ---------------------------------------------------------------------------
// 生产形态 fixture：修好前 0 组，修好后按天稳定分组
// ---------------------------------------------------------------------------

test('生产真实标题：旧的「整条主干相等」分组恒 0，新逻辑按天稳定分组且不串主题', () => {
  const cards = cardsOf(TITLES)
  // 旧 key（kind + 完整主干）在真实标题上全不相等 —— 这就是生产库 0 命中的原因
  const oldKeys = new Set(cards.map((c) => `${c.kind}\u0000${titleStem(c.title)}`))
  assert.equal(oldKeys.size, cards.length, '剥掉时间戳后主干仍然两两不同')

  const withDistractor = cards.concat(cardsOf([
    ['2026-10-17', 'copy 复盘 2026-10-17 04:00：文案 A/B 结果'],
    ['2026-10-17', 'copy 复盘 2026-10-17 05:00：二次复盘'],
    ['2026-10-17', 'copy 复盘 2026-10-17 06:00：定稿'],
  ]).map((c) => ({ ...c, tags: ['copy'], body: `文案复盘：${cjk(120)}` })))
  const series = planSnapshotSeries(withDistractor, { now: NOW })
  assert.deepEqual(series.map((s) => [s.stem, s.day, s.count]), [
    ['COMBO 值班 UAE', '10-16', 3],
    ['COMBO 值班 UAE', '10-17', 3],
    ['COMBO 值班 UAE', '10-18', 3],
    ['copy 复盘', '2026-10-17', 3],
  ], '按天稳定分组，一天一个序列（没写年份的标题就按 MM-DD 分段）')
  assert.equal(series[0].timeline.newTitle, 'COMBO 值班 UAE 10-16（时间线）')
  assert.deepEqual(series[0].members.map((m) => m.title), TITLES.filter((t) => t[0] === '2026-10-16').map((t) => t[1]))
  assert.ok(!series[0].members.some((m) => m.title.startsWith('copy 复盘')), '不同前缀的卡不并进来')
  // 输入顺序不影响结果
  assert.deepEqual(planSnapshotSeries([...withDistractor].reverse(), { now: NOW }).map((s) => [s.stem, s.day]), [
    ['COMBO 值班 UAE', '10-16'], ['COMBO 值班 UAE', '10-17'], ['COMBO 值班 UAE', '10-18'], ['copy 复盘', '2026-10-17'],
  ])
})

test('同一个前缀内也要证据：标签 / 实体都不共享时按正文相似度分开', () => {
  const bodyA = `# 巡检\n\n${cjk(300)}`
  const bodyB = `# 巡检\n\n${cjk(300)}`
  const cards = [
    mk(1, '巡检 2026-10-16 09:00', { tags: ['库存'], body: bodyA }),
    mk(2, '巡检 2026-10-16 10:00', { tags: ['库存'], body: bodyA + cjk(30) }),
    mk(3, '巡检 2026-10-16 11:00', { tags: ['库存'], body: bodyA + cjk(30) }),
    mk(4, '巡检 2026-10-16 12:00', { tags: ['文案'], body: bodyB }),
    mk(5, '巡检 2026-10-16 13:00', { tags: ['文案'], body: bodyB + cjk(30) }),
    mk(6, '巡检 2026-10-16 14:00', { tags: ['文案'], body: bodyB + cjk(30) }),
  ]
  const series = planSnapshotSeries(cards, { now: NOW })
  assert.equal(series.length, 2, '前缀相同但无共享标签、正文又不相似 → 两个序列')
  assert.deepEqual(series.map((s) => s.count), [3, 3])

  // 只靠正文相似度也能佐证（标签为空、实体为空时）
  const plain = [
    mk(1, '巡检 2026-10-16 09:00', { tags: [], body: bodyA }),
    mk(2, '巡检 2026-10-16 10:00', { tags: [], body: bodyA + cjk(20) }),
    mk(3, '巡检 2026-10-16 11:00', { tags: [], body: bodyA + cjk(20) }),
  ]
  assert.equal(planSnapshotSeries(plain, { now: NOW }).length, 1)
  // 正文也完全不同 → 一组都成不了
  const disjoint = plain.map((c, i) => ({ ...c, body: `# 巡检\n\n${'别的内容'.repeat(20)}${cjk(200)}${i}` }))
  assert.equal(planSnapshotSeries(disjoint, { now: NOW }).length, 0)
})

test('没有日期退化成单段；一天不到 minSeries 张的稀疏日并进不带日期的段', () => {
  const cards = [mk(1, '巡检 #1', { tags: ['oncall'] }), mk(2, '巡检 #2', { tags: ['oncall'] }), mk(3, '巡检 #3', { tags: ['oncall'] })]
  const s = planSnapshotSeries(cards, { now: NOW })
  assert.equal(s.length, 1)
  assert.equal(s[0].day, '')
  assert.equal(s[0].timeline.newTitle, '巡检（时间线）')

  // 一天一张：4 天各 1 张 → 归成一段，否则一天一张的日常快照会被拆成每张一卡
  const daily = [1, 2, 3, 4].map((i) => mk(i, `值班巡检快照 2026-10-${10 + i} 09:00`, { tags: ['oncall'] }))
  const d = planSnapshotSeries(daily, { now: NOW })
  assert.equal(d.length, 1)
  assert.equal(d[0].day, '')
  assert.equal(d[0].count, 4)

  // 够 minSeries 张的日期单独成段；不够的稀疏日归到不带日期的段
  const mixed = [
    ...[1, 2, 3, 4].map((i) => mk(i, `值班巡检快照 2026-10-16 0${i}:00`, { tags: ['oncall'] })),
    mk(5, '值班巡检快照 2026-10-17 09:00', { tags: ['oncall'] }),
  ]
  assert.deepEqual(planSnapshotSeries(mixed, { now: NOW }).map((s) => s.day), ['2026-10-16'], '另 1 张单独成不了段的先不动')
  const mixed2 = mixed.concat([2, 3].map((i) => mk(5 + i, `值班巡检快照 2026-10-17 1${i}:00`, { tags: ['oncall'] })))
  assert.deepEqual(planSnapshotSeries(mixed2, { now: NOW }).map((s) => s.day), ['2026-10-16', '2026-10-17'])
})

test('同一批次出现三种分隔符残渣写法 → 只出 1 个序列、1 张时间线卡', () => {
  const body = `# 快照\n\nCOMBO 值班 UAE NEAR 记录：${cjk(80)}`
  const cards = [
    mk(1, 'COMBO 值班 10-21 09:00 – UAE | 成本线下穿，NEAR 减半', { tags: ['combo'], body }),
    mk(2, 'COMBO 值班 10-21 12:00 ~ UAE | 横盘，NEAR 补回', { tags: ['combo'], body }),
    mk(3, 'COMBO 值班 10-21 22:00 UAE | 本班收平，SUI 触线', { tags: ['combo'], body }),
    mk(4, 'COMBO 值班 10-21 23:30 – UAE | 本班补记，焦点 SUI', { tags: ['combo'], body }),
  ]
  const s = planSnapshotSeries(cards, { now: NOW })
  assert.equal(s.length, 1, '同一天只出 1 个序列，不再按残渣劈成 3 个')
  assert.equal(s[0].count, 4)
  assert.equal(s[0].day, '10-21')
  assert.equal(s[0].stem, 'COMBO 值班 – UAE', '展示前缀取桶内最常见写法')
  assert.equal(s[0].timeline.newTitle, 'COMBO 值班 – UAE 10-21（时间线）')
  assert.equal(s[0].timeline.existing, false)
})

test('前 2 个词不同就不并：COMBO 值班 与 COMBO 网格 同一天也各自成序列', () => {
  const body = `# 快照\n\n同一批记录 ${cjk(60)}`
  const cards = [
    mk(1, 'COMBO 值班 10-21 09:00 – UAE | 成本线下穿', { tags: ['combo'], body }),
    mk(2, 'COMBO 值班 10-21 12:00 – UAE | 横盘', { tags: ['combo'], body }),
    mk(3, 'COMBO 值班 10-21 22:00 – UAE | 收工', { tags: ['combo'], body }),
    mk(4, 'COMBO 网格 10-21 09:30 – UAE | 网格下调', { tags: ['combo'], body }),
    mk(5, 'COMBO 网格 10-21 13:30 – UAE | 网格回调', { tags: ['combo'], body }),
    mk(6, 'COMBO 网格 10-21 21:30 – UAE | 网格收工', { tags: ['combo'], body }),
  ]
  const s = planSnapshotSeries(cards, { now: NOW })
  assert.deepEqual(s.map((x) => [x.stem, x.count]), [['COMBO 值班 – UAE', 3], ['COMBO 网格 – UAE', 3]])
})

test('已有时间线卡是别的残渣写法时照样追加，不新建重复时间线卡', () => {
  const body = `# 快照\n\nCOMBO 值班 UAE 记录：${cjk(80)}`
  const timeline = {
    ...mk(1, 'COMBO 值班 ~ UAE 10-16（时间线）', { tags: ['combo'], body, at: '2026-10-16T23:00:00.000Z' }),
  }
  const extra = mk(2, 'COMBO 值班 10-16 21:00 – UAE | 本班补记', { tags: ['combo'], body, at: '2026-10-16T21:00:00.000Z' })
  const s = planSnapshotSeries([timeline, extra], { now: NOW })
  assert.equal(s.length, 1)
  assert.equal(s[0].timeline.existing, true, '跨残渣写法认得出同一条时间线')
  assert.equal(s[0].timeline.path, timeline.path)
  assert.equal(s[0].timeline.newTitle, 'COMBO 值班 ~ UAE 10-16（时间线）', '已有卡标题不动')
  assert.deepEqual(s[0].members.map((m) => m.id), [2])
})

// ---------------------------------------------------------------------------
// 上限 / 时间门槛 / 序列数上限
// ---------------------------------------------------------------------------

test('单序列上限：默认 40，多出的旧卡留在原处不并入', () => {
  const at = (i) => `2026-10-16T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`
  const cards = Array.from({ length: 45 }, (_, i) => mk(i + 1, `巡检 2026-10-16 交接 #${i}`, { tags: ['oncall'], at: at(i) }))
  const s = planSnapshotSeries(cards, { now: NOW })
  assert.equal(s.length, 1)
  assert.equal(s[0].count, 40)
  assert.equal(s[0].timeline.id, 45, '时间线卡是最新一张')
  assert.ok(!s[0].members.some((m) => m.id <= 5), '最旧的 5 张不并入')
  assert.equal(planSnapshotSeries(cards, { now: NOW, maxPoints: 3 })[0].count, 3)
})

test('时间门槛：最新一张不到 24 小时不出建议；minAgeHours=0 时不卡', () => {
  const fresh = [1, 2, 3].map((i) => mk(i, `巡检 #${i}`, { tags: ['oncall'], at: '2026-10-25T10:00:00.000Z' }))
  assert.equal(planSnapshotSeries(fresh, { now: NOW }).length, 0, '2 小时前的序列先不动，免得每轮改写')
  assert.equal(planSnapshotSeries(fresh, { now: NOW, minAgeHours: 0 }).length, 1)
  assert.equal(planSnapshotSeries(fresh, { now: '2026-10-26T11:00:00.000Z' }).length, 1, '超过 24 小时才出建议')
})

test('maxSeries：只取最前面 N 个序列（按张数降序）', () => {
  const cards = [
    mk(1, '巡检 A 2026-10-16 01:00', { tags: ['a'] }), mk(2, '巡检 A 2026-10-16 02:00', { tags: ['a'] }), mk(3, '巡检 A 2026-10-16 03:00', { tags: ['a'] }),
    mk(4, '巡检 B 2026-10-16 01:00', { tags: ['b'] }), mk(5, '巡检 B 2026-10-16 02:00', { tags: ['b'] }), mk(6, '巡检 B 2026-10-16 03:00', { tags: ['b'] }),
    mk(7, '巡检 B 2026-10-16 04:00', { tags: ['b'] }),
  ]
  assert.equal(planSnapshotSeries(cards, { now: NOW }).length, 2)
  const one = planSnapshotSeries(cards, { now: NOW, maxSeries: 1 })
  assert.equal(one.length, 1)
  assert.equal(one[0].count, 4, '张数多的序列优先')
})

// ---------------------------------------------------------------------------
// 批次：幂等、追加、回滚
// ---------------------------------------------------------------------------

test('snapshots 批次：连跑两次幂等，已有时间线卡时新卡追加，回滚能逐字还原', async () => {
  const { root, db } = await freshVault()
  const paths = []
  for (const [i, [day, title]] of TITLES.entries()) {
    const p = `02-Projects/oncall-${i}.md`
    insertCard(db, { path: p, kind: 'project', title, tags: ['combo'], body: `# 快照\n\n${cjk(60)}`, updatedAt: `${day}T00:00:00.000Z` })
    paths.push(p)
  }
  const plan = await tidyPlan(root, quiet)
  assert.ok(plan.snapshots.length >= 1, '修好后能识别出序列')
  const first = await tidyApply(root, { ...quiet, confirm: true, planId: plan.planId, batches: ['snapshots'] })
  assert.equal(first.ok, true, JSON.stringify(first.batches))
  const timelines = db.prepare("SELECT path, title FROM cards WHERE title LIKE '%（时间线）'").all()
  assert.ok(timelines.length >= 1)
  for (const t of timelines) assert.match(t.title, /（时间线）$/)
  const afterFirst = fingerprint(db)

  // 连跑第二次：没有新卡 → 不再改动（幂等）
  const plan2 = await tidyPlan(root, quiet)
  assert.equal(plan2.snapshots.length, 0)
  const second = await tidyApply(root, { ...quiet, confirm: true, planId: plan2.planId, batches: ['snapshots'] })
  assert.equal(second.ok, true)
  assert.equal(second.batches[0].counts.removed, 0)
  assert.deepEqual(fingerprint(db), afterFirst)

  // 新快照插进已有序列（时间往前放到 24 小时以前）→ 直接追加到已有时间线卡
  const fresh = '02-Projects/oncall-new.md'
  const freshBody = '# 快照\n\n补记：本条是新增的补充说明文字，长度够了不会被行过滤掉。'
  insertCard(db, { path: fresh, kind: 'project', title: 'COMBO 值班 10-19 03:00 UAE：补记', tags: ['combo'], body: freshBody, updatedAt: '2026-10-19T03:00:00.000Z' })
  const beforeThird = fingerprint(db)
  const plan3 = await tidyPlan(root, quiet)
  assert.ok(plan3.snapshots.length >= 1)
  const appending = plan3.snapshots.find((s) => s.timeline.existing)
  assert.ok(appending, '已有时间线卡 → 追加，不新建')
  const keeperPath = appending.timeline.path
  const third = await tidyApply(root, { ...quiet, confirm: true, planId: plan3.planId, batches: ['snapshots'] })
  assert.equal(third.ok, true, JSON.stringify(third.batches))
  assert.ok(existsSync(third.rollbackFile))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cards WHERE path = ?').get(fresh).n, 0, '被归入的快照已软删')
  assert.ok(db.prepare('SELECT body FROM cards WHERE path = ?').get(keeperPath).body.includes('补记：本条是新增'), '新卡内容进了时间线卡')

  // 回滚最后一批：新卡回到 cards，时间线卡正文还原
  const rb = await tidyRollback(root, third.rollbackFile, quiet)
  assert.equal(rb.ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cards WHERE path = ?').get(fresh).n, 1)
  const strip = (s) => JSON.parse(s).cards.map(({ updated_at: _u, id: _i, ...r }) => r) // 回收站恢复会重新发 id（既有行为）
  const restored = strip(fingerprint(db)).find((c) => c.path === fresh)
  assert.equal(restored?.body, freshBody)
  assert.ok(!db.prepare('SELECT body FROM cards WHERE path = ?').get(keeperPath).body.includes('补记：本条是新增'), '时间线卡正文还原')
  assert.deepEqual(strip(fingerprint(db)), strip(beforeThird), '回滚后与追加前完全一致')
})

// ---------------------------------------------------------------------------
// 同一天多张时间线卡 + 摘录预算（GH #16）
// ---------------------------------------------------------------------------

const tlCard = (id, title, { day = '2026-10-16', tags = ['combo'], at, body } = {}) => {
  const segTitle = `原始快照 ${id}`
  return {
    ...mk(id, title, {
      tags,
      body: body ?? `# 快照\n\n公共记录 ${cjk(40)}\n## 时间线（周期性快照，按时间排列）\n\n### ${segTitle}\n第 ${id} 段独有内容：${cjk(40)}`,
      at: at || `${day}T23:00:00.000Z`,
    }),
  }
}

test('同一天多张时间线卡（日期写法不同也算同一天）：只出一组，其余作附加成员一起合回', () => {
  const cards = [
    tlCard(1, 'COMBO 值班 UAE 2026-10-16（时间线）'),
    tlCard(2, 'COMBO 值班 ~ UAE 10-16（时间线）'),
    tlCard(3, 'COMBO 值班 UAE 2026-10-17（时间线）', { day: '2026-10-17' }),
  ]
  const s = planSnapshotSeries(cards, { now: NOW })
  assert.equal(s.length, 1, '同一天只出一组，不再各留一张')
  assert.equal(s[0].timeline.path, '02-Projects/snap-1.md', '保留 id 最小的那张做时间线卡')
  assert.deepEqual(s[0].members.map((m) => m.id), [2], '同一天的另一张时间线卡进 members（会被合过去）')
  assert.equal(s[0].count, 1, 'count 只数被归入的卡（保留卡本身不算）')
})

test('同一天多张时间线卡合并：每段都保留 ### 原标题，可逐字回滚', async () => {
  const { root, db } = await freshVault()
  const cards = [
    tlCard(1, 'COMBO 值班 UAE 2026-10-16（时间线）'),
    tlCard(2, 'COMBO 值班 ~ UAE 10-16（时间线）'),
  ]
  for (const c of cards) insertCard(db, { path: c.path, kind: c.kind, title: c.title, tags: c.tags, body: c.body, updatedAt: c.updatedAt })
  const before = fingerprint(db)
  const plan = await tidyPlan(root, quiet)
  assert.equal(plan.snapshots.length, 1)
  const res = await tidyApply(root, { ...quiet, confirm: true, planId: plan.planId, batches: ['snapshots'] })
  assert.equal(res.ok, true, JSON.stringify(res.batches))
  const left = db.prepare("SELECT path, body FROM cards WHERE title LIKE '%（时间线）'").all()
  assert.equal(left.length, 1, '合回一张')
  assert.equal(left[0].path, '02-Projects/snap-1.md')
  assert.ok(left[0].body.includes('### COMBO 值班 ~ UAE 10-16（时间线）'), '被吸收的时间线卡标题保留')
  assert.ok(left[0].body.includes('### 原始快照 1') && left[0].body.includes('### 原始快照 2'), '两边的段标题都在')
  assert.ok(left[0].body.includes('第 2 段独有内容'), '被吸收卡的段内容并了进来')
  const rb = await tidyRollback(root, res.rollbackFile, quiet)
  assert.equal(rb.ok, true)
  const strip = (s) => JSON.parse(s).cards.map(({ updated_at: _u, id: _i, ...r }) => r)
  assert.deepEqual(strip(fingerprint(db)), strip(before), '回滚后逐字还原')
})

test('时间线摘录预算：默认下限 600 行 / 每张 3 行，张数多时按张数抬总量，单卡另设上限', async () => {
  const { root, db } = await freshVault()
  // 一张保留 + 9 张同一天快照，每张 30 条独特行
  const body = (tag) => `# 快照\n\n${Array.from({ length: 30 }, () => `${tag}：${cjk(30)}`).join('\n')}`
  for (let i = 0; i < 10; i++) {
    insertCard(db, { path: `02-Projects/bud-${i}.md`, kind: 'project', title: `COMBO 值班 2026-10-16 1${i}:00 UAE：记录 ${i}`, tags: ['combo'], body: body(`卡${i}`), updatedAt: `2026-10-16T1${i}:00:00.000Z` })
  }
  const plan = await tidyPlan(root, quiet)
  assert.ok(plan.options.timelineLines >= 600, '默认预算提高到 600 行量级')
  assert.equal(plan.options.timelineLinesPerCard, 3)
  // 预算 6 行 / 每张 1 行：9 张来源各最多 1 行，总量不超预算
  const res = await tidyApply(root, { ...quiet, confirm: true, planId: plan.planId, batches: ['snapshots'], timelineLines: 6, timelineLinesPerCard: 1 })
  assert.equal(res.ok, true, JSON.stringify(res.batches))
  const kept = db.prepare("SELECT body FROM cards WHERE title LIKE '%（时间线）'").get().body
  const blocks = kept.slice(kept.indexOf('## 时间线（周期性快照，按时间排列）')).split(/\n### /).slice(1) // 去掉保留卡自己那段
  const added = blocks.flatMap((b) => b.split('\n').slice(1).filter((l) => l && !l.startsWith('(')))
  assert.equal(added.length, 9, '按张数均分：9 张来源各留 1 行，共 9 行')
  assert.equal(blocks.filter((b) => b.includes('(与时间线已有内容一致，无新增)')).length, 0, '预算够时不出现占位')
})

test('时间线摘录预算：预算耗尽后保留占位行，单卡行数受上限约束', async () => {
  const { root, db } = await freshVault()
  const lines = (tag) => `# 快照\n\n${Array.from({ length: 30 }, () => `${tag}：${cjk(30)}`).join('\n')}`
  for (let i = 0; i < 10; i++) {
    insertCard(db, { path: `02-Projects/pb-${i}.md`, kind: 'project', title: `COMBO 值班 2026-10-16 1${i}:00 UAE：记录 ${i}`, tags: ['combo'], body: lines(`卡${i}`), updatedAt: `2026-10-16T1${i}:00:00.000Z` })
  }
  const plan = await tidyPlan(root, quiet)
  const res = await tidyApply(root, { ...quiet, confirm: true, planId: plan.planId, batches: ['snapshots'], timelineLines: 2, timelineLinesPerCard: 0 })
  assert.equal(res.ok, true, JSON.stringify(res.batches))
  const kept = db.prepare("SELECT body FROM cards WHERE title LIKE '%（时间线）'").get().body
  const sec = kept.slice(kept.indexOf('## 时间线（周期性快照，按时间排列）'))
  const blocks = sec.split(/\n### /).slice(2) // 去掉小节标题 + 保留卡自己那段
  assert.equal(blocks.flatMap((b) => b.split('\n').slice(1).filter((l) => l && !l.startsWith('('))).length, 2, '只留预算允许的 2 行')
  assert.equal(blocks.filter((b) => b.includes('(与时间线已有内容一致，无新增)')).length, 7, '其余段保留占位行')
  assert.equal(blocks.length, 9, '每段标题都还在')

  // 单卡上限：预算很大时单张来源也只摘 timelineMaxLinesPerCard 行
  const { root: r2, db: d2 } = await freshVault()
  for (let i = 0; i < 3; i++) {
    insertCard(d2, { path: `02-Projects/cap-${i}.md`, kind: 'project', title: `COMBO 值班 2026-10-16 1${i}:00 UAE：记录 ${i}`, tags: ['combo'], body: lines(`卡${i}`), updatedAt: `2026-10-16T1${i}:00:00.000Z` })
  }
  const p2 = await tidyPlan(r2, quiet)
  const r2res = await tidyApply(r2, { ...quiet, confirm: true, planId: p2.planId, batches: ['snapshots'], timelineMaxLinesPerCard: 5 })
  assert.equal(r2res.ok, true, JSON.stringify(r2res.batches))
  const b2 = d2.prepare("SELECT body FROM cards WHERE title LIKE '%（时间线）'").get().body
  const blocks2 = b2.slice(b2.indexOf('## 时间线（周期性快照，按时间排列）')).split(/\n### /).slice(2)
  const perCard = blocks2.map((b) => b.split('\n').slice(1).filter((l) => l && !l.startsWith('(')).length)
  assert.deepEqual(perCard, [5, 5], '每张来源最多 5 行（上限生效，预算没被吃光）')
})

test('hasTimestamp：前缀抽取用的时间戳判定仍只认日期 / 时间 / 序号', () => {
  assert.ok(hasTimestamp('COMBO 值班 10-17 01:45 UAE：微正'))
  assert.ok(!hasTimestamp('COMBO 值班 SOP'))
  assert.ok(!hasTimestamp('Redis 缓存策略'))
})
