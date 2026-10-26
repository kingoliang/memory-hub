// scripts/tidy-daily.mjs：参数解析、dry-run 不改库、--apply 先备份再应用并写报告、缺参数/非法批次拒绝。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildFixture, fingerprint, closeAllDb, insertCard } from './core/tidy-fixture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(here, '../scripts/tidy-daily.mjs')
const { parseArgs, runTidyDaily } = await import(pathToFileURL(SCRIPT).href)
after(() => closeAllDb())

const quietIo = () => { const buf = []; return { buf, io: { stderr: (s) => buf.push(s) } } }

test('parseArgs：默认值、环境变量、命令行覆盖、非法值', () => {
  const d = parseArgs([], {})
  assert.deepEqual({ apply: d.apply, threshold: d.threshold, maxDelete: d.maxDelete, maxSnapshots: d.maxSnapshots, batches: d.batches }, { apply: false, threshold: 0.85, maxDelete: 10, maxSnapshots: 20, batches: ['merge', 'tags', 'snapshots'] })
  const e = parseArgs([], { MEMORY_HUB_HOME: '/h', TIDY_THRESHOLD: '0.9', TIDY_MAX_DELETE: '3', TIDY_MAX_SNAPSHOTS: '4', TIDY_AUTO_BATCHES: 'tags' })
  assert.equal(e.home, '/h'); assert.equal(e.threshold, 0.9); assert.equal(e.maxDelete, 3); assert.equal(e.maxSnapshots, 4); assert.deepEqual(e.batches, ['tags'])
  const c = parseArgs(['--apply', '--home', '/x', '--report-dir', '/r', '--threshold', '0.7', '--max-delete', '5', '--max-snapshots', '2', '--batches', 'merge'], { MEMORY_HUB_HOME: '/h' })
  assert.deepEqual([c.apply, c.home, c.reportDir, c.threshold, c.maxDelete, c.maxSnapshots, c.batches], [true, '/x', '/r', 0.7, 5, 2, ['merge']])
  assert.match(parseArgs(['--bogus']).error, /未知参数/)
  assert.match(parseArgs(['--threshold', '2'], {}).error, /threshold/)
  assert.match(parseArgs(['--max-delete', '-1'], {}).error, /max-delete/)
  assert.match(parseArgs(['--max-snapshots', '-2'], {}).error, /max-snapshots/)
  assert.throws(() => parseArgs(['--home']), /需要参数/)
})

test('缺数据目录 / 含 noise 的自动批次 → 退出码 2，且不动任何文件', async () => {
  const { io } = quietIo()
  assert.equal(await runTidyDaily(parseArgs([], {}), io), 2)
  const { root } = await buildFixture()
  assert.equal(await runTidyDaily(parseArgs(['--home', root, '--batches', 'merge,noise'], {}), io), 2)
  assert.equal(await runTidyDaily(parseArgs(['--home', root, '--batches', 'bogus'], {}), io), 2)
  assert.equal(fs.existsSync(path.join(root, 'tidy-reports')), false)
  // 可选批次（topics / snapshots）由 tidy 侧决定：有 ALL_TIDY_BATCHES 就该接受
  const tidy = await import('../src/core/tidy.js')
  if (tidy.ALL_TIDY_BATCHES) assert.equal(await runTidyDaily(parseArgs(['--home', root, '--batches', 'tags,topics,snapshots'], {}), io), 0)
})

test('dry-run：库不变、不备份，写出报告（含"只进报告"各节）', async () => {
  const { root, db } = await buildFixture()
  const before = fingerprint(db)
  const { io } = quietIo()
  const code = await runTidyDaily(parseArgs(['--home', root], {}), io)
  assert.equal(code, 0)
  const { getDb } = await import('../src/core/db.js')
  assert.equal(fingerprint(getDb(root)), before)
  assert.equal(fs.existsSync(path.join(root, 'backups')), false, 'dry-run 不应产生备份')
  const files = fs.readdirSync(path.join(root, 'tidy-reports'))
  assert.equal(files.length, 1)
  const md = fs.readFileSync(path.join(root, 'tidy-reports', files[0]), 'utf8')
  assert.match(md, /DRY-RUN（未改库）/)
  assert.match(md, /近重复合并/); assert.match(md, /噪声卡候选/); assert.match(md, /密钥疑似/)
  assert.ok(!md.includes('ghp_'), '报告里不得出现密钥原文')
})

test('--apply：先备份，再应用 merge+tags；报告写到 --report-dir；回滚文件存在', async () => {
  const { root, db } = await buildFixture()
  const before = db.prepare("SELECT COUNT(*) n FROM cards").get().n
  const reportDir = path.join(root, 'out-reports')
  const { io, buf } = quietIo()
  const code = await runTidyDaily(parseArgs(['--home', root, '--apply', '--threshold', '0.7', '--report-dir', reportDir], {}), io)
  assert.equal(code, 0, buf.join(''))
  assert.ok(fs.readdirSync(path.join(root, 'backups')).some((f) => f.startsWith('memory-eternal-')), '应有 backupDb 产出的备份')
  const md = fs.readFileSync(path.join(reportDir, fs.readdirSync(reportDir)[0]), 'utf8')
  assert.match(md, /APPLY（已应用自动批次）/); assert.match(md, /应用结果/); assert.match(md, /备份：/)
  const { getDb } = await import('../src/core/db.js')
  const after2 = getDb(root).prepare("SELECT COUNT(*) n FROM cards").get().n
  assert.ok(after2 < before, `合并应减少主库卡数：${before} → ${after2}`)
  // 噪声卡不在自动批次里：仍在主库
  assert.ok(getDb(root).prepare("SELECT 1 FROM cards WHERE path = '04-Content/n3.md'").get(), 'noise 卡不得被自动删除')
})

test('--apply：snapshots 在默认批次里，按天归入时间线卡且连跑两次幂等', async () => {
  const { root, db } = await buildFixture()
  // 生产形态的班次快照（时间往前放，避开 24 小时新鲜度门槛）
  const tails = ['成本线下穿，仓位减半', '横盘，网格补回', '回撤，子仓止损', '收工，网格全平']
  for (const [i, tail] of tails.entries()) {
    insertCard(db, { path: `02-Projects/oncall-${i}.md`, kind: 'project', title: `COMBO 值班 10-16 0${i}:10 UAE：${tail}`, tags: ['combo'], body: `# COMBO 值班快照\n\n${tail}，队列 ${i * 7} 条。`, updatedAt: `2026-10-16T0${i}:10:00.000Z` })
  }
  const reportDir = path.join(root, 'out-reports')
  const { io, buf } = quietIo()
  const code = await runTidyDaily(parseArgs(['--home', root, '--apply', '--report-dir', reportDir, '--batches', 'snapshots'], {}), io)
  assert.equal(code, 0, buf.join(''))
  const md = fs.readFileSync(path.join(reportDir, fs.readdirSync(reportDir)[0]), 'utf8')
  assert.match(md, /周期性快照归入时间线卡/, '报告保留快照段落与规模')
  assert.match(md, /1 个序列/)
  assert.match(md, /批次 snapshots：applied \{"series":1,"removed":3\}/)
  // runTidyDaily 结束会关库，断言要重新取连接
  const { getDb } = await import('../src/core/db.js')
  const keep = getDb(root).prepare('SELECT path, title FROM cards WHERE title LIKE ?').get('%（时间线）')
  assert.ok(keep, '应有时间线卡')
  assert.equal(keep.title, 'COMBO 值班 UAE 10-16（时间线）')
  const rolled = fs.readdirSync(path.join(root, 'backups')).filter((f) => f.endsWith('.rollback.json'))
  assert.equal(rolled.length, 1, '应写回滚文件')

  // 再跑一次：没有新快照 → 不再改动（幂等），也不报错
  const before2 = getDb(root).prepare('SELECT COUNT(*) n FROM cards').get().n
  const code2 = await runTidyDaily(parseArgs(['--home', root, '--apply', '--report-dir', reportDir, '--batches', 'snapshots'], {}), io)
  assert.equal(code2, 0, buf.join(''))
  const db2 = getDb(root)
  assert.equal(db2.prepare('SELECT COUNT(*) n FROM cards').get().n, before2)
  assert.equal(db2.prepare('SELECT title FROM cards WHERE path = ?').get(keep.path).title, keep.title)
})

test('--apply：显式跑 snapshots,topics 时两者不互相打架（时间线卡按天保留）', async () => {
  const { root, db } = await buildFixture()
  // 3 天 x 2 张同前缀快照：应为 3 张按天的时间线卡，且 topics 不再把它们并成 1 张
  for (const d of ['10-16', '10-17', '10-18']) {
    for (let i = 0; i < 2; i++) {
      insertCard(db, { path: `02-Projects/combo-${d}-${i}.md`, kind: 'project', title: `COMBO 值班 ${d} 0${i}:10 UAE：第 ${i} 班`, tags: ['combo'], body: `# COMBO 值班快照\n\n第 ${i} 班记录，队列 ${i * 7} 条。`, updatedAt: `2026-${d}T0${i}:10:00.000Z` })
    }
  }
  const reportDir = path.join(root, 'out-reports')
  const { io, buf } = quietIo()
  const code = await runTidyDaily(parseArgs(['--home', root, '--apply', '--report-dir', reportDir, '--batches', 'snapshots,topics', '--max-delete', '50'], {}), io)
  assert.equal(code, 0, buf.join(''))
  const { getDb } = await import('../src/core/db.js')
  const timelines = getDb(root).prepare("SELECT path, title FROM cards WHERE title LIKE '%（时间线）' ORDER BY path").all()
  assert.equal(timelines.length, 3, '一天一张：topics 不再把时间线卡并成 1 张')
  for (const t of timelines) assert.match(t.path, /combo-10-1[678]-/, '每张时间线卡对应各自那天')
  // 再跑一次：snapshots 判 0 个序列、topics 也无可并，天数不变
  const code2 = await runTidyDaily(parseArgs(['--home', root, '--apply', '--report-dir', reportDir, '--batches', 'snapshots,topics', '--max-delete', '50'], {}), io)
  assert.equal(code2, 0, buf.join(''))
  assert.equal(getDb(root).prepare("SELECT COUNT(*) n FROM cards WHERE title LIKE '%（时间线）'").get().n, 3, '连跑幂等')
})

test('--apply：快照计划超过 maxDelete 时抬高上限并在报告里写明', async () => {
  const { root, db } = await buildFixture()
  for (let i = 0; i < 6; i++) {
    insertCard(db, { path: `02-Projects/oncall-${i}.md`, kind: 'project', title: `COMBO 值班 10-16 0${i}:10 UAE：第 ${i} 班`, tags: ['combo'], body: `# COMBO 值班快照\n\n第 ${i} 班记录，队列 ${i * 7} 条。`, updatedAt: `2026-10-16T0${i}:10:00.000Z` })
  }
  const { io, buf } = quietIo()
  const code = await runTidyDaily(parseArgs(['--home', root, '--apply', '--batches', 'snapshots', '--max-delete', '2'], {}), io)
  assert.equal(code, 0, buf.join(''))
  assert.match(buf.join(''), /maxDelete=2，本次把上限抬到 5/)
  const md = fs.readFileSync(path.join(root, 'tidy-reports', fs.readdirSync(path.join(root, 'tidy-reports'))[0]), 'utf8')
  assert.match(md, /maxDelete=5（已从 2 抬高）/, '抬高要在报告里可见')
  const { getDb } = await import('../src/core/db.js')
  assert.equal(getDb(root).prepare('SELECT COUNT(*) n FROM cards WHERE title LIKE ?').get('%（时间线）').n, 1)
})

test('CLI：--help 退出 0；未知参数退出 2；无 --home 退出 2', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
  const h = run(['--help']); assert.equal(h.status, 0); assert.match(h.stdout, /--apply/)
  assert.equal(run(['--nope']).status, 2)
  assert.equal(run([]).status, 2)
})
