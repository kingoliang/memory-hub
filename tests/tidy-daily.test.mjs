// scripts/tidy-daily.mjs：参数解析、dry-run 不改库、--apply 先备份再应用并写报告、缺参数/非法批次拒绝。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildFixture, fingerprint, closeAllDb } from './core/tidy-fixture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(here, '../scripts/tidy-daily.mjs')
const { parseArgs, runTidyDaily } = await import(pathToFileURL(SCRIPT).href)
after(() => closeAllDb())

const quietIo = () => { const buf = []; return { buf, io: { stderr: (s) => buf.push(s) } } }

test('parseArgs：默认值、环境变量、命令行覆盖、非法值', () => {
  const d = parseArgs([], {})
  assert.deepEqual({ apply: d.apply, threshold: d.threshold, maxDelete: d.maxDelete, batches: d.batches }, { apply: false, threshold: 0.85, maxDelete: 10, batches: ['merge', 'tags'] })
  const e = parseArgs([], { MEMORY_HUB_HOME: '/h', TIDY_THRESHOLD: '0.9', TIDY_MAX_DELETE: '3', TIDY_AUTO_BATCHES: 'tags' })
  assert.equal(e.home, '/h'); assert.equal(e.threshold, 0.9); assert.equal(e.maxDelete, 3); assert.deepEqual(e.batches, ['tags'])
  const c = parseArgs(['--apply', '--home', '/x', '--report-dir', '/r', '--threshold', '0.7', '--max-delete', '5', '--batches', 'merge'], { MEMORY_HUB_HOME: '/h' })
  assert.deepEqual([c.apply, c.home, c.reportDir, c.threshold, c.maxDelete, c.batches], [true, '/x', '/r', 0.7, 5, ['merge']])
  assert.match(parseArgs(['--bogus']).error, /未知参数/)
  assert.match(parseArgs(['--threshold', '2'], {}).error, /threshold/)
  assert.match(parseArgs(['--max-delete', '-1'], {}).error, /max-delete/)
  assert.throws(() => parseArgs(['--home']), /需要参数/)
})

test('缺数据目录 / 含 noise 的自动批次 → 退出码 2，且不动任何文件', async () => {
  const { io } = quietIo()
  assert.equal(await runTidyDaily(parseArgs([], {}), io), 2)
  const { root } = await buildFixture()
  assert.equal(await runTidyDaily(parseArgs(['--home', root, '--batches', 'merge,noise'], {}), io), 2)
  assert.equal(fs.existsSync(path.join(root, 'tidy-reports')), false)
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

test('CLI：--help 退出 0；未知参数退出 2；无 --home 退出 2', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
  const h = run(['--help']); assert.equal(h.status, 0); assert.match(h.stdout, /--apply/)
  assert.equal(run(['--nope']).status, 2)
  assert.equal(run([]).status, 2)
})
