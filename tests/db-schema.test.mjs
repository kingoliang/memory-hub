// 数据层：busy_timeout / WAL / user_version 迁移 / 旧 7 张表一列不改 / 只追加新表
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpHome, rmrf } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const newDb = await import('../src/core/db.js')
const legacyDb = await import(pathToFileURL(path.join(here, 'fixtures/legacy/db.js')))

const OLD_TABLES = ['config', 'cards', 'quarantine', 'card_updates', 'feedback', 'audit_log', 'card_sequence']
const NEW_TABLES = ['agent_tokens', 'write_log', 'card_revisions', 'admin_sessions']
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`)

test('新库：WAL + busy_timeout=5000 + foreign_keys + user_version=1', () => {
  const home = tmpHome()
  try {
    const db = newDb.getDb(home)
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
  } finally { newDb.closeAllDb(); rmrf(home) }
})

test('旧 7 张表的列定义与旧实现逐列一致，新增 4 张表存在', () => {
  const a = tmpHome(), b = tmpHome()
  try {
    const dn = newDb.getDb(a), dl = legacyDb.getDb(b)
    for (const t of OLD_TABLES) assert.deepEqual(cols(dn, t), cols(dl, t), `表 ${t} 列定义被改动`)
    const names = new Set(dn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
    for (const t of [...OLD_TABLES, ...NEW_TABLES]) assert.ok(names.has(t), `缺表 ${t}`)
    for (const t of NEW_TABLES) assert.ok(!dl.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(t), '旧实现不应有新表（测试前提）')
  } finally { newDb.closeAllDb(); legacyDb.closeAllDb(); rmrf(a); rmrf(b) }
})

test('旧版库（user_version=0）升级：数据与发号器原样保留，且幂等', async () => {
  const home = tmpHome()
  try {
    const legacyVault = await import(pathToFileURL(path.join(here, 'fixtures/legacy/vault.js')))
    const ldb = legacyDb.getDb(home)
    await legacyVault.writeCard(home, { kind: 'knowledge', title: '旧卡', body: '旧正文内容', status: 'approved', submittedBy: 'x' }, { dedup: false })
    await legacyVault.writeCard(home, { kind: 'project', title: '待审旧卡', body: '另一个旧正文', status: 'pending', submittedBy: 'y' }, { dedup: false })
    const seqBefore = ldb.prepare("SELECT seq FROM card_sequence WHERE name='card'").get().seq
    assert.equal(ldb.prepare('PRAGMA user_version').get().user_version, 0)
    legacyDb.closeAllDb()

    const db = newDb.getDb(home)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM cards').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM quarantine').get().n, 1)
    assert.equal(db.prepare("SELECT seq FROM card_sequence WHERE name='card'").get().seq, seqBefore)
    newDb.closeAllDb()
    const db2 = newDb.getDb(home) // 再开一次：幂等
    assert.equal(db2.prepare('PRAGMA user_version').get().user_version, 1)
    assert.equal(db2.prepare('SELECT COUNT(*) n FROM cards').get().n, 1)
  } finally { newDb.closeAllDb(); legacyDb.closeAllDb(); rmrf(home) }
})

test('旧库对新库的兼容：新库文件可被旧代码打开并读卡（切换期可回退）', async () => {
  const home = tmpHome()
  try {
    const vault = await import('../src/core/vault.js')
    await vault.writeCard(home, { kind: 'knowledge', title: '新库卡', body: '新库里写的正文', status: 'approved', submittedBy: 'a' }, { dedup: false })
    newDb.closeAllDb()
    const legacyVault = await import(pathToFileURL(path.join(here, 'fixtures/legacy/vault.js')))
    const cards = await legacyVault.listCards(home, {})
    assert.equal(cards.length, 1)
  } finally { newDb.closeAllDb(); legacyDb.closeAllDb(); rmrf(home) }
})

test('nextCardId 单语句原子发号：连续发号严格递增且唯一', () => {
  const home = tmpHome()
  try {
    const db = newDb.getDb(home)
    const ids = Array.from({ length: 100 }, () => newDb.nextCardId(db))
    assert.equal(new Set(ids).size, 100)
    for (let i = 1; i < ids.length; i++) assert.equal(ids[i], ids[i - 1] + 1)
  } finally { newDb.closeAllDb(); rmrf(home) }
})
