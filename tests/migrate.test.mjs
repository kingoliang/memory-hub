// migrate verify（PLAN 6.3.2 对账）与 migrate reverse（反向增量：新库期间的新增/修改导回旧库，不丢卡）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { tmpHome, rmrf } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(here, '../bin/memory-hub.mjs')
const legacyDb = await import(pathToFileURL(path.join(here, 'fixtures/legacy/db.js')))
const legacyVault = await import(pathToFileURL(path.join(here, 'fixtures/legacy/vault.js')))
const newDb = await import('../src/core/db.js')
const newVault = await import('../src/core/vault.js')
const { verifyMigration, planReverse, applyReverse } = await import('../src/migrate.js')

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, MEMORY_HUB_HOME: tmpHome() } })
const BODY = (t) => `${t}：这是用于对账测试的合成正文，足够长以通过各种闸门。结论是使用环境变量，原因是部署时不改代码，步骤是先备份再重启。`

/** 用旧实现造一个"旧库"（user_version=0）：4 张 approved、1 张 pending、1 张软删、带更新记录。 */
async function makeOld() {
  const home = tmpHome('mh-old-')
  const w = (kind, title, status) => legacyVault.writeCard(home, { kind, title, tags: ['t', kind], body: BODY(title), status, submittedBy: 'fx' }, { dedup: false })
  const a = await w('knowledge', '甲 数据库选型', 'approved')
  const b = await w('project', '乙 缓存方案', 'approved')
  await w('mistake', '丙 部署踩坑', 'approved')
  await w('tool', '丁 常用命令', 'approved')
  await w('knowledge', '戊 待审卡', 'pending')
  const f = await w('prompt', '己 将被软删', 'approved')
  await legacyVault.deleteCard(home, f.path)
  await legacyVault.appendUpdate(home, a.path, '补充一条更新记录')
  legacyDb.closeAllDb()
  return { home, paths: { a: a.path, b: b.path } }
}
/** 把库目录拷成独立副本（旧库已关闭，单文件即可）。 */
function cloneDir(src) {
  const dst = tmpHome('mh-clone-')
  for (const f of fs.readdirSync(src)) if (f.startsWith('memory-eternal.db')) fs.copyFileSync(path.join(src, f), path.join(dst, f))
  return dst
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const count = (dir, sql) => { const d = new DatabaseSync(path.join(dir, 'memory-eternal.db'), { readOnly: true }); try { return d.prepare(sql).get() } finally { d.close() } }
const checkOf = (r, name) => r.checks.find((c) => c.name === name)

test('verify：旧库 vs 被新代码打开迁移过的副本 → 全部 PASS（新表不影响旧表对账）', async () => {
  const { home } = await makeOld()
  const copy = cloneDir(home)
  try {
    newDb.getDb(copy); newDb.closeAllDb() // 触发 user_version 0→2 迁移
    const r = verifyMigration({ source: home, target: copy })
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)))
    for (const n of ['integrity', 'counts', 'kinds', 'fingerprints', 'sequence', 'invariant', 'sidetables']) assert.ok(checkOf(r, n)?.ok, `缺检查项或未过：${n}`)
    // 退出码 0；输出不含卡片标题/正文
    const out = run('migrate', 'verify', '--source', home, '--target', copy)
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /PASS/)
    assert.ok(!out.stdout.includes('甲 数据库选型') && !out.stdout.includes('合成正文'))
  } finally { newDb.closeAllDb(); rmrf(home); rmrf(copy) }
})

test('verify：正文被改 / 卡被删 / 序号回退 / 非 approved 混进主库 → 各自 FAIL，退出码 1，且不泄漏正文', async () => {
  const { home } = await makeOld()
  try {
    const mutate = (sql) => { const c = cloneDir(home); const d = new DatabaseSync(path.join(c, 'memory-eternal.db')); d.exec(sql); d.close(); return c }
    const cases = [
      ['fingerprints', "UPDATE cards SET body = body || ' 改' WHERE id = (SELECT MIN(id) FROM cards)"],
      ['counts', 'DELETE FROM cards WHERE id = (SELECT MAX(id) FROM cards)'],
      ['sequence', "UPDATE card_sequence SET seq = 1 WHERE name = 'card'"],
      ['invariant', "UPDATE cards SET status = 'pending' WHERE id = (SELECT MIN(id) FROM cards)"],
      ['kinds', "UPDATE cards SET kind = 'tool' WHERE kind = 'knowledge'"],
    ]
    for (const [name, sql] of cases) {
      const c = mutate(sql)
      try {
        const r = verifyMigration({ source: home, target: c })
        assert.equal(r.ok, false, name)
        assert.equal(checkOf(r, name).ok, false, `${name} 应失败：${JSON.stringify(r.checks)}`)
        const out = run('migrate', 'verify', '--source', home, '--target', c)
        assert.equal(out.status, 1, name)
        assert.match(out.stdout, /FAIL/)
        assert.ok(!out.stdout.includes('合成正文'), '失败输出不得带正文')
      } finally { rmrf(c) }
    }
  } finally { rmrf(home) }
})

test('verify：目标多出卡 → 默认 FAIL；--allow-target-extra 时 PASS（切换后新增）；源有而目标缺仍 FAIL', async () => {
  const { home } = await makeOld()
  const copy = cloneDir(home)
  try {
    await newVault.writeCard(copy, { kind: 'knowledge', title: '新增卡', body: BODY('新增卡'), status: 'approved', submittedBy: 'n' }, { dedup: false })
    newDb.closeAllDb()
    assert.equal(verifyMigration({ source: home, target: copy }).ok, false)
    const r = verifyMigration({ source: home, target: copy, allowTargetExtra: true })
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)))
    const out = run('migrate', 'verify', '--source', home, '--target', copy, '--allow-target-extra')
    assert.equal(out.status, 0, out.stdout)
    // 反过来：源=带新增的，目标=旧库 → 目标缺卡，--allow-target-extra 也救不了
    assert.equal(verifyMigration({ source: copy, target: home, allowTargetExtra: true }).ok, false)
  } finally { newDb.closeAllDb(); rmrf(home); rmrf(copy) }
})

/** 在"新库副本"上制造增量：新增(approved+pending)、改标签/正文、审批、软删、追加更新。 */
async function makeDelta(newDir, paths) {
  const approved = await newVault.writeCard(newDir, { kind: 'project', title: '新库期间新增 approved', body: BODY('新增A'), status: 'approved', submittedBy: 'agent-x' }, { dedup: false })
  await newVault.writeCard(newDir, { kind: 'knowledge', title: '新库期间新增 pending', body: BODY('新增P'), status: 'pending', submittedBy: 'agent-y' }, { dedup: false })
  const db = newDb.getDb(newDir)
  db.prepare("UPDATE cards SET tags = ?, body = ?, updated_at = ? WHERE path = ?").run('["改过"]', BODY('乙已编辑'), new Date().toISOString(), paths.b)
  const pend = db.prepare("SELECT path FROM quarantine WHERE status = 'pending' AND title LIKE '戊%'").get()
  await newVault.setCardStatus(newDir, pend.path, 'approved', { changedBy: 'admin', reason: '审批' })
  await newVault.deleteCard(newDir, paths.a) // 软删：approved → 回收站（换表、换 id）
  await newVault.appendUpdate(newDir, approved.path, '新卡的更新记录')
  newDb.closeAllDb()
  return { approvedPath: approved.path, pendPath: pend.path }
}

test('reverse：dry-run 不动旧库（字节级不变）；--execute 先留底再写入，之后与新库逐项对账 PASS，旧库仍是旧 schema', async () => {
  const { home: oldDir, paths } = await makeOld()
  const newDir = cloneDir(oldDir)
  try {
    await makeDelta(newDir, paths)
    const before = sha(path.join(oldDir, 'memory-eternal.db'))
    const plan = planReverse({ from: newDir, target: oldDir })
    assert.ok(plan.add >= 2 && plan.change >= 3, JSON.stringify(plan))
    assert.equal(plan.missingInNew, 0)
    const dry = run('migrate', 'reverse', '--from', newDir, '--target', oldDir)
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /dry-run/i)
    assert.equal(sha(path.join(oldDir, 'memory-eternal.db')), before, 'dry-run 必须不改旧库')
    assert.ok(!fs.readdirSync(oldDir).some((f) => f.includes('pre-reverse')), 'dry-run 不留底')

    const res = await applyReverse({ from: newDir, target: oldDir, execute: true })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.ok(fs.existsSync(res.backup), '应有 pre-reverse 留底')
    assert.equal(fs.statSync(res.backup).mode & 0o077, 0, '留底权限 0600')
    // 对账：新库 == 回滚后的旧库
    const v = verifyMigration({ source: newDir, target: oldDir })
    assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)))
    // 旧库没被升级 schema（旧服务照常能跑）
    assert.equal(count(oldDir, 'PRAGMA user_version').user_version, 0)
    assert.equal(count(oldDir, "SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('agent_tokens','write_log','card_revisions','admin_sessions')").n, 0)
    // 旧实现能读到新增卡（旧服务视角）
    const list = await legacyVault.listCards(oldDir, {})
    assert.ok(list.some((c) => c.path.includes('新库期间新增') || /新库期间新增/.test(c.title || '')), '旧实现应能列出新增 approved 卡')
    const rd = await legacyVault.readCard(oldDir, paths.b)
    assert.match(rd.text, /乙已编辑/)
    legacyDb.closeAllDb()
    // 幂等：再跑一次 plan 无事可做
    const again = planReverse({ from: newDir, target: oldDir })
    assert.equal(again.add + again.change, 0, JSON.stringify(again))
  } finally { newDb.closeAllDb(); legacyDb.closeAllDb(); rmrf(oldDir); rmrf(newDir) }
})

test('往返演练：新库有增量 → 导回旧库 → 用回滚后的旧库重新接管（再次导入新库）→ 卡一张不少，内容一致', async () => {
  const { home: oldDir, paths } = await makeOld()
  const newDir = cloneDir(oldDir)
  const reimport = tmpHome('mh-reimport-')
  try {
    const d = await makeDelta(newDir, paths)
    const allPaths = (dir) => { const x = new DatabaseSync(path.join(dir, 'memory-eternal.db'), { readOnly: true }); try { return new Set([...x.prepare('SELECT path FROM cards').all(), ...x.prepare('SELECT path FROM quarantine').all()].map((r) => r.path)) } finally { x.close() } }
    const newPaths = allPaths(newDir)
    await applyReverse({ from: newDir, target: oldDir, execute: true })
    // 重新接管：旧库(已回滚) → 拷贝 → 新代码打开
    fs.copyFileSync(path.join(oldDir, 'memory-eternal.db'), path.join(reimport, 'memory-eternal.db'))
    newDb.getDb(reimport); newDb.closeAllDb()
    const reAll = allPaths(reimport)
    for (const p of newPaths) assert.ok(reAll.has(p), `丢卡：${p}`)
    assert.equal(reAll.size, newPaths.size)
    const v = verifyMigration({ source: newDir, target: reimport })
    assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)))
    // 卡 id 序号不倒退：再发号不会撞已有 id
    const seqOld = count(oldDir, "SELECT seq FROM card_sequence WHERE name='card'").seq
    assert.ok(seqOld >= count(newDir, "SELECT seq FROM card_sequence WHERE name='card'").seq)
    const w = await newVault.writeCard(reimport, { kind: 'tool', title: '重接管后新卡', body: BODY('重接管'), status: 'approved', submittedBy: 'z' }, { dedup: false })
    assert.ok(w.ok && d.approvedPath)
  } finally { newDb.closeAllDb(); rmrf(oldDir); rmrf(newDir); rmrf(reimport) }
})

test('reverse：新库里永久删除的卡 → 报告 missingInNew，默认不在旧库删除；--prune-purged 才删（含其更新记录）', async () => {
  const { home: oldDir, paths } = await makeOld()
  const newDir = cloneDir(oldDir)
  try {
    await newVault.deleteCard(newDir, paths.b, { permanent: true })
    newDb.closeAllDb()
    const plan = planReverse({ from: newDir, target: oldDir })
    assert.equal(plan.missingInNew, 1)
    await applyReverse({ from: newDir, target: oldDir, execute: true })
    assert.equal(count(oldDir, `SELECT COUNT(*) n FROM cards WHERE path = '${paths.b}'`).n, 1, '默认保守：旧库保留')
    const r = await applyReverse({ from: newDir, target: oldDir, execute: true, pruneMissing: true })
    assert.equal(r.ok, true)
    assert.equal(count(oldDir, `SELECT COUNT(*) n FROM cards WHERE path = '${paths.b}'`).n, 0)
    assert.equal(verifyMigration({ source: newDir, target: oldDir }).ok, true)
  } finally { newDb.closeAllDb(); rmrf(oldDir); rmrf(newDir) }
})

test('reverse：新行 id 恰与旧库另一张卡的 id 相同 → 改领旧库新号，不覆盖、不报错；序号取两边较大值', async () => {
  const { home: oldDir } = await makeOld()
  const newDir = cloneDir(oldDir)
  try {
    const oldMaxId = count(oldDir, 'SELECT MAX(id) m FROM cards').m
    const d = new DatabaseSync(path.join(newDir, 'memory-eternal.db'))
    d.prepare('DELETE FROM cards WHERE id = ?').run(oldMaxId) // 新库里那张卡已被永久删除（旧库仍有），新卡"恰好"占了同一个 id
    d.prepare("INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at) VALUES (?, 'knowledge/撞号.md', 'knowledge', '撞号', '[]', 'b', 's', 'approved', '', 'x', 'info', '', ?, ?)").run(oldMaxId, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z')
    d.close()
    const res = await applyReverse({ from: newDir, target: oldDir, execute: true })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(count(oldDir, "SELECT COUNT(*) n FROM cards WHERE path = 'knowledge/撞号.md'").n, 1)
    assert.equal(count(oldDir, `SELECT COUNT(*) n FROM cards WHERE id = ${oldMaxId}`).n, 1, '原卡仍在')
    assert.ok(count(oldDir, "SELECT seq FROM card_sequence WHERE name='card'").seq >= oldMaxId)
  } finally { newDb.closeAllDb(); rmrf(oldDir); rmrf(newDir) }
})

test('reverse --export：增量导出为 0600 JSON（含新增/修改的卡），CLI 默认 dry-run、--execute 才写', async () => {
  const { home: oldDir, paths } = await makeOld()
  const newDir = cloneDir(oldDir)
  const out = path.join(tmpHome('mh-exp-'), 'delta.json')
  try {
    await makeDelta(newDir, paths)
    const r = run('migrate', 'reverse', '--from', newDir, '--target', oldDir, '--export', out)
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.ok(j.cards.length >= 5)
    assert.equal(fs.statSync(out).mode & 0o077, 0)
    const e = run('migrate', 'reverse', '--from', newDir, '--target', oldDir, '--execute')
    assert.equal(e.status, 0, e.stderr + e.stdout)
    assert.equal(verifyMigration({ source: newDir, target: oldDir }).ok, true)
  } finally { newDb.closeAllDb(); rmrf(oldDir); rmrf(newDir); rmrf(path.dirname(out)) }
})
