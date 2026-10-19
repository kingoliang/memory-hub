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
const NEW_TABLES = ['agent_tokens', 'write_log', 'card_revisions', 'admin_sessions', 'admin_users']
/** schema v3 在旧表尾部追加的归属列（字面量，防止「新列被改动」被漏掉）。 */
const ADDED_COLUMNS = {
  cards: ["owner:TEXT:1:'':0", "team:TEXT:1:'default':0", "visibility:TEXT:1:'team':0"],
  quarantine: ["owner:TEXT:1:'':0", "team:TEXT:1:'default':0", "visibility:TEXT:1:'team':0"],
}
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`)

test('新库：WAL + busy_timeout=5000 + foreign_keys + user_version=4', () => {
  const home = tmpHome()
  try {
    const db = newDb.getDb(home)
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
  } finally { newDb.closeAllDb(); rmrf(home) }
})

test('旧 7 张表的旧列定义逐列未被改动（v3 只在尾部追加归属列），新增 4 张表存在', () => {
  const a = tmpHome(), b = tmpHome()
  try {
    const dn = newDb.getDb(a), dl = legacyDb.getDb(b)
    for (const t of OLD_TABLES) {
      const legacy = cols(dl, t)
      const now = cols(dn, t)
      // 前缀必须是旧列原样：旧代码/旧实现回退打开新库时不会错位
      assert.deepEqual(now.slice(0, legacy.length), legacy, `表 ${t} 的旧列被改动`)
      // 尾部只能是已知追加列，且顺序与默认值固定
      assert.deepEqual(now.slice(legacy.length), ADDED_COLUMNS[t] ?? [], `表 ${t} 追加了非预期列`)
    }
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
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM cards').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM quarantine').get().n, 1)
    assert.equal(db.prepare("SELECT seq FROM card_sequence WHERE name='card'").get().seq, seqBefore)
    // v3 回填：老行 owner 从署名推断，team/visibility 取默认（升级前后可见性语义不变）
    assert.deepEqual(db.prepare('SELECT owner, team, visibility FROM cards').all().map((r) => [r.owner, r.team, r.visibility]), [['x', 'default', 'team']])
    assert.deepEqual(db.prepare('SELECT owner, team, visibility FROM quarantine').all().map((r) => [r.owner, r.team, r.visibility]), [['y', 'default', 'team']])
    newDb.closeAllDb()
    const db2 = newDb.getDb(home) // 再开一次：幂等
    assert.equal(db2.prepare('PRAGMA user_version').get().user_version, 4)
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

test('v1 → v4 迁移（v2 令牌名部分唯一 + v3 归属列 + v4 管理账号表）：数据与哈希原样保留、幂等、旧代码仍可打开', async () => {
  const home = tmpHome()
  try {
    // 构造一个 v1 库：用 v1 形态建表并写入令牌行
    const { mkdirSync } = await import('node:fs')
    mkdirSync(home, { recursive: true })
    const raw = new DatabaseSync(path.join(home, 'memory-eternal.db'))
    raw.exec(`CREATE TABLE agent_tokens (token_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, secret_hash TEXT NOT NULL, scopes TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT, revoked_at TEXT);
      INSERT INTO agent_tokens VALUES ('t1','alpha','h1','["read"]','2026-01-01T00:00:00.000Z',NULL,NULL,NULL);
      INSERT INTO agent_tokens VALUES ('t2','beta','h2','["read","write"]','2026-01-02T00:00:00.000Z','2026-02-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','2026-03-01T00:00:00.000Z');
      PRAGMA user_version = 1;`)
    raw.close()
    const db = newDb.getDb(home)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
    const rows = db.prepare('SELECT * FROM agent_tokens ORDER BY token_id').all()
    assert.deepEqual(rows.map((r) => [r.token_id, r.name, r.secret_hash, r.scopes, r.last_used_at, r.expires_at, r.revoked_at]), [
      ['t1', 'alpha', 'h1', '["read"]', null, null, null],
      ['t2', 'beta', 'h2', '["read","write"]', '2026-02-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
    ])
    // 已撤销的 beta 可被复用；活跃的 alpha 不可重名
    db.prepare("INSERT INTO agent_tokens (token_id, name, secret_hash, scopes, created_at) VALUES ('t3','beta','h3','[\"read\"]','2026-04-01T00:00:00.000Z')").run()
    assert.throws(() => db.prepare("INSERT INTO agent_tokens (token_id, name, secret_hash, scopes, created_at) VALUES ('t4','alpha','h4','[\"read\"]','2026-04-01T00:00:00.000Z')").run(), /UNIQUE/)
    newDb.closeAllDb()
    const again = newDb.getDb(home) // 幂等
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 4)
    assert.equal(again.prepare('SELECT COUNT(*) n FROM agent_tokens').get().n, 3)
    newDb.closeAllDb()
    // 旧代码（fixtures/legacy，v1 形态）能打开 v2 库并读写令牌表之外的数据
    const legacyVault = await import(pathToFileURL(path.join(here, 'fixtures/legacy/vault.js')))
    await legacyVault.writeCard(home, { kind: 'knowledge', title: '旧代码写的卡', body: '旧代码在 v2 库上写入', status: 'approved', submittedBy: 'x' }, { dedup: false })
    assert.equal((await legacyVault.listCards(home, {})).length, 1)
  } finally { newDb.closeAllDb(); legacyDb.closeAllDb(); rmrf(home) }
})
