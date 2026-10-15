// M3 标签管理：预览影响卡数 → 确认执行（备份 + 自检 + 可回滚）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { withHubW, loggedIn, rowOf } from './write-helpers.mjs'

const tagsOf = (h, p) => JSON.parse(rowOf(h, p).tags)
const fingerprint = (h) => JSON.stringify([h.db().prepare('SELECT path, tags, title, body FROM cards ORDER BY path').all(), h.db().prepare('SELECT path, tags FROM quarantine ORDER BY path').all()])
const backups = (h) => { const d = path.join(h.home, 'backups'); return fs.existsSync(d) ? fs.readdirSync(d) : [] }

test('预览：重命名/合并/删除各自返回影响卡数与样例路径，不改数据', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const fp = fingerprint(h)
    const r = await c.get('/admin/api/tags/preview?op=rename&from=alpha&to=alpha2')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.affectedCards, 12)
    assert.ok(r.json.samples.length > 0 && r.json.samples.length <= 20)
    const m = await c.get('/admin/api/tags/preview?op=merge&from=' + encodeURIComponent('Node.js,nodejs,node-js') + '&to=nodejs')
    assert.equal(m.json.affectedCards, 5, 'Node.js 3 张 + nodejs 1 张 + node-js 1 张')
    assert.equal(m.json.merging, 3)
    const d = await c.get('/admin/api/tags/preview?op=delete&from=shared')
    assert.equal(d.json.affectedCards, 20)
    assert.equal((await c.get('/admin/api/tags/preview?op=delete&from=不存在的标签')).json.affectedCards, 0)
    assert.equal((await c.get('/admin/api/tags/preview?op=zzz&from=a')).status, 400)
    assert.equal(fingerprint(h), fp)
  })
})

test('重命名：所有卡生效、tags 仍是合法 JSON 数组；执行前备份；返回回滚文件；write_log', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const nc = await c.wpost('/admin/api/tags/rename', { from: 'alpha', to: 'alpha2' })
    assert.equal(nc.status, 400)
    assert.equal(nc.json.error, 'confirm_required')
    assert.equal(nc.json.affectedCards, 12, '缺 confirm 时告知影响卡数')
    const r = await c.wpost('/admin/api/tags/rename', { from: 'alpha', to: 'alpha2', confirm: true, expectedAffected: 12 })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.affectedCards, 12)
    assert.match(r.json.backup.file, /^pre-.*\.db$/)
    assert.match(r.json.rollbackFile, /^tags-.*\.rollback\.json$/)
    assert.ok(!JSON.stringify(r.json).includes(h.home), '不暴露服务器绝对路径')
    assert.ok(backups(h).includes(r.json.backup.file))
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM cards WHERE tags LIKE '%\"alpha\"%'").get().n, 0)
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM cards WHERE tags LIKE '%\"alpha2\"%'").get().n, 12)
    for (const row of h.db().prepare('SELECT tags FROM cards').all()) assert.ok(Array.isArray(JSON.parse(row.tags)))
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='tag_rename' AND actor_type='admin'").get().n, 1)
  })
})

test('expectedAffected 与实际不符 → 409，数据不变（预览后库变了）', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const fp = fingerprint(h)
    const r = await c.wpost('/admin/api/tags/rename', { from: 'alpha', to: 'alpha2', confirm: true, expectedAffected: 3 })
    assert.equal(r.status, 409)
    assert.equal(r.json.error, 'conflict')
    assert.equal(fingerprint(h), fp)
  })
})

test('合并：多个变体并入一个目标，去重且保留顺序；回滚后逐行指纹一致', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const fp = fingerprint(h)
    const r = await c.wpost('/admin/api/tags/merge', { from: ['Node.js', 'nodejs', 'node-js'], to: 'nodejs', confirm: true })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.affectedCards, 5)
    const withNode = h.db().prepare("SELECT path FROM cards WHERE tags LIKE '%\"nodejs\"%'").all()
    assert.equal(withNode.length, 5)
    for (const { path: p } of withNode) {
      const t = tagsOf(h, p)
      assert.equal(t.filter((x) => x === 'nodejs').length, 1)
      assert.ok(!t.includes('Node.js') && !t.includes('node-js'))
    }
    assert.notEqual(fingerprint(h), fp)
    const rb = await c.wpost('/admin/api/tidy/rollback', { rollbackFile: r.json.rollbackFile, confirm: true })
    assert.equal(rb.status, 200, rb.text)
    assert.equal(fingerprint(h), fp, '回滚后标签完全还原')
  })
})

test('删除标签：从所有卡（含待审卡）移除；回滚可还原', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const fp = fingerprint(h)
    const r = await c.wpost('/admin/api/tags/delete', { tag: 'pending-tag', confirm: true })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.affectedCards, 3, '待审卡也在影响范围内')
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM quarantine WHERE tags LIKE '%pending-tag%'").get().n, 0)
    const rb = await c.wpost('/admin/api/tidy/rollback', { rollbackFile: r.json.rollbackFile, confirm: true })
    assert.equal(rb.status, 200, rb.text)
    assert.equal(fingerprint(h), fp)
  })
})

test('校验：from/to 为空、相同、超长、含控制字符 → 400；不存在的标签 → 影响 0 张（200，不备份不写日志）', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    for (const body of [{ from: '', to: 'x' }, { from: 'alpha', to: '' }, { from: 'alpha', to: 'alpha' }, { from: 'alpha', to: 'x'.repeat(80) }, { from: 'alpha', to: 'a\u0000b' }]) {
      const r = await c.wpost('/admin/api/tags/rename', { ...body, confirm: true })
      assert.equal(r.status, 400, JSON.stringify(body))
    }
    assert.equal((await c.wpost('/admin/api/tags/merge', { from: [], to: 'x', confirm: true })).status, 400)
    assert.equal((await c.wpost('/admin/api/tags/merge', { from: 'alpha', to: 'x', confirm: true })).status, 400)
    const z = await c.wpost('/admin/api/tags/rename', { from: '压根没有', to: 'x', confirm: true })
    assert.equal(z.status, 200)
    assert.equal(z.json.affectedCards, 0)
    assert.equal(backups(h).length, 0)
  })
})

test('自检失败 → 整批回滚、数据不变、返回错误（用触发器注入"标签变成非法 JSON"）', async () => {
  await withHubW(async (h) => {
    const c = await loggedIn(h)
    const fp = fingerprint(h)
    h.db().exec("CREATE TRIGGER sabotage AFTER UPDATE OF tags ON cards BEGIN UPDATE cards SET tags = 'not-json' WHERE id = NEW.id; END")
    const r = await c.wpost('/admin/api/tags/rename', { from: 'alpha', to: 'alpha2', confirm: true })
    assert.equal(r.status, 500, r.text)
    assert.equal(r.json.error, 'self_check_failed')
    h.db().exec('DROP TRIGGER sabotage')
    assert.equal(fingerprint(h), fp, '自检失败后整批已回滚')
    assert.equal(h.db().prepare("SELECT COUNT(*) n FROM write_log WHERE action='tag_rename' AND outcome='error'").get().n, 1)
  })
})
