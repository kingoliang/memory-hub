// M3 整理 apply / 回滚：默认 dry-run；confirm + planId；备份；自检失败回滚；maxDelete；回滚入口
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withHubW, loggedIn, rowOf, countAll } from './write-helpers.mjs'
import { writeCard } from '../../src/core/vault.js'

const fingerprint = (h) => JSON.stringify([h.db().prepare('SELECT path, kind, tags, title, body FROM cards ORDER BY path').all(), h.db().prepare('SELECT path, status, tags, body FROM quarantine ORDER BY path').all()])
const NOISE = (n) => ({ kind: 'content', title: `[SCHEDULE REMINDER BATCH] 提醒${n}`, tags: ['raw'], body: `[SCHEDULE REMINDER BATCH] 定时提醒 ${n}`, status: 'approved', submittedBy: 'a' })
async function addNoise(h, n) { for (let i = 0; i < n; i++) await writeCard(h.home, NOISE(i), { dedup: false }) }
const preview = async (c) => (await c.get('/admin/api/tidy/preview')).json

test('apply 默认 dry-run：不传 confirm 不改库，返回计划摘要、批次预览与差异计数', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const fp = fingerprint(h)
    const pv = await preview(c)
    const r = await c.wpost('/admin/api/tidy/apply', { planId: pv.planId })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.dryRun, true)
    assert.equal(r.json.planId, pv.planId)
    assert.ok(r.json.plannedDeletes >= 1)
    assert.ok(Array.isArray(r.json.batches) && r.json.batches.every((b) => b.status === 'dry-run'))
    assert.equal(fingerprint(h), fp)
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='tidy_dry_run'").get().n, 1)
  })
})

test('confirm=true 必须带 planId；planId 不匹配（库已变化）→ 409 且不执行', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const fp = fingerprint(h)
    const noId = await c.wpost('/admin/api/tidy/apply', { confirm: true })
    assert.equal(noId.status, 400)
    assert.equal(noId.json.error, 'plan_id_required')
    const stale = await c.wpost('/admin/api/tidy/apply', { confirm: true, planId: 'deadbeef0000' })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error, 'plan_stale')
    assert.equal((await c.wpost('/admin/api/tidy/apply', { confirm: 'true', planId: 'x' })).status, 400, 'confirm 必须是布尔 true')
    assert.equal(fingerprint(h), fp)
    // 预览之后库变化 → 旧 planId 失效
    const pv = await preview(c)
    await addNoise(h, 1)
    const r = await c.wpost('/admin/api/tidy/apply', { confirm: true, planId: pv.planId })
    assert.equal(r.status, 409)
  })
})

test('执行：先备份（备份文件存在且 integrity_check=ok）→ 软删噪声 → 自检 → 返回结果；之后可用回滚文件还原到逐行一致', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const fp = fingerprint(h)
    const before = countAll(h)
    const pv = await preview(c)
    const r = await c.wpost('/admin/api/tidy/apply', { confirm: true, planId: pv.planId, batches: ['noise'] })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.dryRun, false)
    const noise = r.json.batches.find((b) => b.name === 'noise')
    assert.equal(noise.status, 'applied')
    assert.equal(noise.counts.removed, 1)
    assert.equal(r.json.after.cards, before.cards - 1)
    assert.match(r.json.backup.file, /^pre-tidy-.*\.db$/)
    assert.equal(r.json.backup.verified, true)
    assert.ok(!JSON.stringify(r.json).includes(h.home), '响应里没有服务器绝对路径')
    const bk = new DatabaseSync(path.join(h.home, 'backups', r.json.backup.file), { readOnly: true })
    assert.equal(bk.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(bk.prepare('SELECT COUNT(*) n FROM cards').get().n, before.cards)
    bk.close()
    assert.equal(countAll(h).cards, before.cards - 1)
    assert.match(r.json.rollbackFile, /^tidy-.*\.rollback\.json$/)
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='tidy_apply' AND outcome='ok'").get().n, 1)
    // 回滚入口
    const list = await c.get('/admin/api/tidy/rollbacks')
    assert.ok(list.json.items.some((i) => i.file === r.json.rollbackFile))
    const need = await c.wpost('/admin/api/tidy/rollback', { rollbackFile: r.json.rollbackFile })
    assert.equal(need.status, 400)
    assert.equal(need.json.error, 'confirm_required')
    const rb = await c.wpost('/admin/api/tidy/rollback', { rollbackFile: r.json.rollbackFile, confirm: true })
    assert.equal(rb.status, 200, rb.text)
    assert.equal(rb.json.restored, 1)
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='tidy_rollback' AND outcome='ok'").get().n, 1)
    // 逐行指纹一致（updated_at 因恢复会变，故指纹不含时间戳字段）
    assert.equal(fingerprint(h), fp)
  })
})

test('maxDelete：计划软删数超过上限 → 400 拒绝执行，库不变；调大后可执行', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    await addNoise(h, 3) // 现有 1 + 3 = 4 张噪声
    const fp = fingerprint(h)
    const pv = await preview(c)
    const r = await c.wpost('/admin/api/tidy/apply', { confirm: true, planId: pv.planId, batches: ['noise'], maxDelete: 2 })
    assert.equal(r.status, 400, r.text)
    assert.equal(r.json.error, 'max_delete_exceeded')
    assert.match(r.json.message, /maxDelete/)
    assert.equal(fingerprint(h), fp)
    const ok = await c.wpost('/admin/api/tidy/apply', { confirm: true, planId: pv.planId, batches: ['noise'], maxDelete: 10 })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.batches[0].counts.removed, 4)
    assert.equal((await c.wpost('/admin/api/tidy/apply', { planId: pv.planId, maxDelete: -1 })).status, 400)
    assert.equal((await c.wpost('/admin/api/tidy/apply', { planId: pv.planId, batches: ['bogus'] })).status, 400)
  })
})

test('批后自检失败 → 该批自动回滚、库不变、响应 ok=false 且 write_log 记 error（触发器注入）', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const fp = fingerprint(h)
    const pv = await preview(c)
    h.db().exec("CREATE TRIGGER sabotage AFTER INSERT ON audit_log BEGIN UPDATE cards SET tags = 'not-json' WHERE id = (SELECT MIN(id) FROM cards); END")
    const r = await c.wpost('/admin/api/tidy/apply', { confirm: true, planId: pv.planId, batches: ['noise'] })
    h.db().exec('DROP TRIGGER sabotage')
    assert.equal(r.status, 500, r.text)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.error, 'self_check_failed')
    assert.equal(r.json.batches[0].status, 'rolled_back')
    assert.equal(fingerprint(h), fp, '自动回滚后与执行前逐行一致')
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='tidy_apply' AND outcome='error'").get().n, 1)
  })
})

test('回滚入口只接受 backups 目录里的 tidy-*/tags-* 回滚文件：路径穿越 / 任意文件名 / 不存在 → 400/404', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    fs.mkdirSync(path.join(h.home, 'backups'), { recursive: true })
    fs.writeFileSync(path.join(h.home, 'outside.rollback.json'), '{}')
    for (const f of ['../outside.rollback.json', '/etc/passwd', 'tidy-x/../../outside.rollback.json', 'evil.json', '', 'tidy-..%2f.rollback.json']) {
      const r = await c.wpost('/admin/api/tidy/rollback', { rollbackFile: f, confirm: true })
      assert.equal(r.status, 400, f)
    }
    assert.equal((await c.wpost('/admin/api/tidy/rollback', { rollbackFile: 'tidy-nonexistent.rollback.json', confirm: true })).status, 404)
    fs.writeFileSync(path.join(h.home, 'backups', 'tidy-bogus.rollback.json'), '{"tool":"other"}')
    assert.equal((await c.wpost('/admin/api/tidy/rollback', { rollbackFile: 'tidy-bogus.rollback.json', confirm: true })).status, 400)
  })
})

test('合并批次：保留卡并入独特行、被吸收卡进回收站；回滚后保留卡正文还原', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const fx = await import('../core/tidy-fixture.mjs')
    const db = h.db()
    const L = Array.from({ length: 8 }, fx.line)
    const mk = (p, title, body) => fx.insertCard(db, { path: p, kind: 'project', title, tags: ['sop'], body })
    mk('02-Projects/sop-canon.md', 'SOP 主', '# SOP\n\n' + L.slice(0, 7).join('\n'))
    mk('02-Projects/sop-dup1.md', 'SOP 副', '# SOP\n\n' + L.slice(0, 6).join('\n') + '\n独特补充一：' + fx.cjk(30))
    const fp = fingerprint(h)
    const pv = await preview(c)
    assert.ok(pv.counts.duplicateGroups >= 1)
    const r = await c.wpost('/admin/api/tidy/apply', { confirm: true, planId: pv.planId, batches: ['merge'] })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.batches[0].counts.removed >= 1, true)
    assert.equal(rowOf(h, '02-Projects/sop-dup1.md').status, 'deleted')
    assert.match(rowOf(h, '02-Projects/sop-canon.md').body, /合并补充/)
    const rb = await c.wpost('/admin/api/tidy/rollback', { rollbackFile: r.json.rollbackFile, confirm: true })
    assert.equal(rb.status, 200, rb.text)
    assert.equal(fingerprint(h), fp)
  })
})
