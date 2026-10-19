// memory-hub · SQLite 存储层（node:sqlite 内置，零依赖）
//
// 旧 7 张表（config / cards / quarantine / card_updates / feedback / audit_log / card_sequence）一列不改；
// 新表走 PRAGMA user_version 增量迁移（只增不删，旧版本代码打开新库不会坏）。
// 并发：busy_timeout（PRAGMA，兼容 Node 22）+ 写事务 BEGIN IMMEDIATE + 单语句原子发号。

import * as sqlite from 'node:sqlite'
import { promises as fs, mkdirSync, chmodSync, statSync } from 'node:fs'
import path from 'node:path'

const { DatabaseSync } = sqlite
const DB_FILE = 'memory-eternal.db'
export const DB_FILENAME = DB_FILE
/** 当前 schema 版本（PRAGMA user_version）。0 = 旧版 memory-eternal 库。 */
export const SCHEMA_VERSION = 5
/** 归属列：新增列名+建表默认值，迁移与建表共用一份，避免两边漂移。 */
export const SCOPE_COLUMNS = { owner: "TEXT NOT NULL DEFAULT ''", team: "TEXT NOT NULL DEFAULT 'default'", visibility: "TEXT NOT NULL DEFAULT 'team'" }
export const BUSY_TIMEOUT_MS = 5000

/** 获取或创建 SQLite 数据库连接（单例 per root）。 */
const instances = new Map()
export function getDb(root) {
  const resolved = path.resolve(root)
  if (instances.has(resolved)) return instances.get(resolved)
  // 确保目录存在（SQLite 需要目录才能创建 .db 文件）
  mkdirSync(resolved, { recursive: true })
  const dbPath = path.join(resolved, DB_FILE)
  const db = new DatabaseSync(dbPath)
  // 必须最先设置：后面的 journal_mode / 建表在多进程并发启动时都可能遇到写锁
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
  // 为什么还要重试：`PRAGMA journal_mode=WAL`（以及并发 DDL）抢不到写锁时**不会**被
  // busy_timeout 兜住 —— 实测 8 进程同时首次打开同一个新库，6 轮里 5 轮有进程直接抛
  // "database is locked"。表现为 tests/concurrency.test.mjs 间歇失败，很容易被误读成"机器慢"。
  // 每一步都幂等，所以整段重试是安全的。回归见 tests/core/db-concurrent-open.test.mjs。
  try {
    withBusyRetry(() => {
      db.exec('PRAGMA journal_mode=WAL')
      db.exec('PRAGMA synchronous=NORMAL')
      db.exec('PRAGMA foreign_keys=ON')
      initTables(db)
      migrateSchema(db)
      migrateToQuarantine(db)
    })
  } catch (e) {
    try { db.close() } catch { /* 关不掉也无所谓，下面重新抛 */ }
    throw e
  }
  try { chmodSync(dbPath, 0o600) } catch { /* 非 POSIX 文件系统 */ }
  instances.set(resolved, db)
  return db
}

/** 同步睡眠（getDb 不能 await，所以只能阻塞式等待）。 */
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
const isBusyError = (e) => /busy|locked/i.test(String(e?.message ?? e))

/** 对锁冲突做有界重试：延迟线性递增（20ms 起），总预算约 2.4s，超过就把原错误抛回去。 */
function withBusyRetry(fn, { attempts = 15, delayMs = 20 } = {}) {
  let last
  for (let i = 0; i < attempts; i++) {
    try { return fn() } catch (e) {
      if (!isBusyError(e)) throw e
      last = e
      sleepSync(delayMs * (i + 1))
    }
  }
  throw last
}

/**
 * 建表。
 *
 * 存储模型（v0.10「两套存储体系」）：
 *   cards       = **主库 / 正常区**：物理上只存 approved。召回、检索、图谱、去重、
 *                 导出这些读路径**不再需要写 `WHERE status='approved'`** —— 查主库即安全。
 *   quarantine  = **隔离区 / 异常区**：pending（待审）/ rejected（驳回）/ deleted（回收站）。
 *                 审核中心与回收站的唯一数据源；除审核操作外无人读它。
 *
 * 这样做的原因：v0.9 及以前是「一张表 + status 列」，安全性依赖每一处 SQL 都记得加
 * 状态条件。审计发现三处漏了（去重池把新知识追加进待审卡、readCard 直读未审核正文、
 * /card 接口无状态校验）—— 只要有人再漏一处就会重演。物理分表后，漏写 `WHERE` 也不泄漏。
 */
function initTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL DEFAULT 'knowledge',
      title TEXT NOT NULL DEFAULT '',
      tags TEXT DEFAULT '[]',
      body TEXT NOT NULL DEFAULT '',
      summary TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'approved',
      source TEXT DEFAULT '',
      submitted_by TEXT DEFAULT '',
      severity TEXT DEFAULT 'info',
      reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
    CREATE INDEX IF NOT EXISTS idx_cards_kind ON cards(kind);
    CREATE INDEX IF NOT EXISTS idx_cards_deleted ON cards(deleted_at);

    -- 隔离区：结构与主库一致，另加 quarantined_at（进隔离区的时间）与 quarantine_reason
    CREATE TABLE IF NOT EXISTS quarantine (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL DEFAULT 'knowledge',
      title TEXT NOT NULL DEFAULT '',
      tags TEXT DEFAULT '[]',
      body TEXT NOT NULL DEFAULT '',
      summary TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT DEFAULT '',
      submitted_by TEXT DEFAULT '',
      severity TEXT DEFAULT 'info',
      reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT,
      quarantined_at TEXT DEFAULT (datetime('now')),
      quarantine_reason TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_quarantine_status ON quarantine(status);
    CREATE INDEX IF NOT EXISTS idx_quarantine_kind ON quarantine(kind);
    CREATE INDEX IF NOT EXISTS idx_quarantine_deleted ON quarantine(deleted_at);

    -- 更新记录：card_id 指向 cards.id **或** quarantine.id（两表共享 id 空间）。
    -- 因此这里**不能**建外键：SQLite 的外键只认一张父表，卡被搬进隔离区时 FK 校验会直接失败
    -- （实测 FOREIGN KEY constraint failed）。永久删除卡片时由 deleteCard 手工清理更新记录。
    CREATE TABLE IF NOT EXISTS card_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_card_updates_card ON card_updates(card_id);

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      card_path TEXT NOT NULL,
      useful INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 审核日志：记录所有 status 变更，不可篡改
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_path TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT NOT NULL,
      changed_by TEXT DEFAULT 'system',
      reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 卡片 id 发号器（两张表**共用**）。
    --
    -- 为什么不用 AUTOINCREMENT：cards 与 quarantine 是两张 AUTOINCREMENT 表，各有一份
    -- sqlite_sequence 计数器，且都从 1 开始 —— 于是两张表会同时出现 id=1，而卡需要在
    -- 两表间搬家并保留 id，必然撞 UNIQUE constraint failed。实测确认：
    -- 共享 id 空间 + 双 AUTOINCREMENT 在 SQLite 里无法自洽。
    -- 改为「显式发号 + 单一持久计数器」：id 全库唯一、单调递增、删除后也不复用，
    -- 而且任何一次 renumber 都是显式 error，不会静默串记录。
    CREATE TABLE IF NOT EXISTS card_sequence (
      name TEXT PRIMARY KEY,
      seq INTEGER NOT NULL
    );
  `)
  // 种子：取两表最大 id（老库升级时把已有卡都覆盖进去）；没有则从 0 起
  db.prepare(`INSERT INTO card_sequence (name, seq) VALUES ('card', 0) ON CONFLICT(name) DO NOTHING`).run()
  db.prepare(`UPDATE card_sequence SET seq = (
      SELECT MAX(m) FROM (SELECT MAX(id) m FROM cards UNION ALL SELECT MAX(id) FROM quarantine)
    ) WHERE name = 'card' AND seq < (
      SELECT MAX(m) FROM (SELECT MAX(id) m FROM cards UNION ALL SELECT MAX(id) FROM quarantine)
    )`).run()
  migrateToQuarantine(db)
}

const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)

/** 幂等加列（老库升级用）。新鲜库也走同一路径（见 migrateSchema 2 → 3），所以列定义只维护一份。 */
function addColumnIfMissing(db, table, name, ddl) {
  if (hasColumn(db, table, name)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`)
  return true
}

/**
 * schema 迁移（PRAGMA user_version）。幂等、只增不删。
 *   0 → 1：追加 agent_tokens / write_log / card_revisions / admin_sessions（旧 7 张表一列不改）。
 *   1 → 2：agent_tokens 去掉 name 列的整列 UNIQUE，改成「仅未撤销令牌名唯一」的部分唯一索引（已撤销的名字可复用）。
 *          重建表（SQLite 无法直接删列约束）：同一事务内建新表 → 拷贝全部行 → 删旧表 → 改名 → 建索引；数据与哈希原样保留。
 *          旧代码（SCHEMA_VERSION=1）打开 v2 库时 user_version 已 ≥1 不再迁移，照常读写（它的"令牌名已存在"检查只是少了一道约束，不会坏）。
 *          回滚代码版本无需回滚库；真要还原库用升级前的备份。
 *   2 → 3：团队归属 + 可见性（docs/decisions/2026-10-18-team-scope-own-first-recall.md）。
 *          cards / quarantine 增 owner / team / visibility；agent_tokens 增 owner / team / default_visibility。
 *          老行 owner 回填为 submitted_by（之后所有行都有归属），team 默认 'default'（全员同一团队 = 升级前语义），
 *          visibility 默认 'team'（人人可见 = 升级前语义）。**只加列，不重写行**。
 *          新增列不进 migrate 指纹（指纹用显式列 path|kind|title|tags|body|status），对账不受影响。
 * 多进程同时启动时：BEGIN IMMEDIATE 串行化，拿到锁后重新读一次 user_version，已迁移则直接返回。
 */
export function migrateSchema(db) {
  const current = () => db.prepare('PRAGMA user_version').get().user_version
  if (current() >= SCHEMA_VERSION) return
  db.exec('BEGIN IMMEDIATE')
  try {
    if (current() < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_tokens (
          token_id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          secret_hash TEXT NOT NULL,
          scopes TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          expires_at TEXT,
          revoked_at TEXT
        );

        CREATE TABLE IF NOT EXISTS write_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL DEFAULT '',
          actor_name TEXT NOT NULL DEFAULT '',
          tool TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL DEFAULT '',
          card_path TEXT NOT NULL DEFAULT '',
          outcome TEXT NOT NULL,
          ip TEXT NOT NULL DEFAULT '',
          args_digest TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_write_log_ts ON write_log(ts);
        CREATE INDEX IF NOT EXISTS idx_write_log_actor ON write_log(actor_name);

        CREATE TABLE IF NOT EXISTS card_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          card_path TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          kind TEXT NOT NULL DEFAULT '',
          edited_by TEXT NOT NULL DEFAULT '',
          edited_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_card_revisions_path ON card_revisions(card_path);

        CREATE TABLE IF NOT EXISTS admin_sessions (
          sid_hash TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen TEXT NOT NULL
        );
      `)
    }
    if (current() < 2) {
      db.exec(`
        CREATE TABLE agent_tokens_v2 (
          token_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          secret_hash TEXT NOT NULL,
          scopes TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          expires_at TEXT,
          revoked_at TEXT
        );
        INSERT INTO agent_tokens_v2 (token_id, name, secret_hash, scopes, created_at, last_used_at, expires_at, revoked_at)
          SELECT token_id, name, secret_hash, scopes, created_at, last_used_at, expires_at, revoked_at FROM agent_tokens;
        DROP TABLE agent_tokens;
        ALTER TABLE agent_tokens_v2 RENAME TO agent_tokens;
        CREATE UNIQUE INDEX idx_agent_tokens_active_name ON agent_tokens(name) WHERE revoked_at IS NULL;
      `)
    }
    if (current() < 3) {
      // 单一定义源：SCOPE_COLUMNS。新鲜库与老库走同一条路（新鲜库 user_version=0，必经这里）。
      for (const [col, ddl] of Object.entries(SCOPE_COLUMNS)) {
        for (const table of ['cards', 'quarantine', 'agent_tokens']) addColumnIfMissing(db, table, col, ddl)
      }
      addColumnIfMissing(db, 'agent_tokens', 'default_visibility', "TEXT NOT NULL DEFAULT 'team'")
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_cards_scope ON cards(team, owner, visibility);
        CREATE INDEX IF NOT EXISTS idx_quarantine_scope ON quarantine(team, owner, visibility);
      `)
      // 老行归属回填：owner 从署名推断（空署名 = 本机单机，保留空串，走 tierOf 的"本地人"通配）。
      db.exec("UPDATE cards SET owner = submitted_by WHERE owner = '' AND COALESCE(submitted_by,'') <> ''")
      db.exec("UPDATE quarantine SET owner = submitted_by WHERE owner = '' AND COALESCE(submitted_by,'') <> ''")
    }
    if (current() < 4) {
      // 3 → 4：管理界面多用户（docs/decisions/2026-10-19-admin-multi-user-rbac.md）。只加表加列。
      // admin_sessions.user_id 为 NULL = 应急入口（原单管理员口令）会话，升级前的旧会话自然落在这一类。
      db.exec(`
        CREATE TABLE IF NOT EXISTS admin_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          team TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT 'member',
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          disabled_at TEXT,
          last_login_at TEXT
        );
      `)
      // 不假设 admin_sessions 一定已存在：在走捷径升上来的库（比如测试里的合成 v1 库）里它可能没有。
      // 建表语句与 v0→1 一致，只是多了 user_id。
      db.exec(`
        CREATE TABLE IF NOT EXISTS admin_sessions (
          sid_hash TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen TEXT NOT NULL
        );
      `)
      addColumnIfMissing(db, 'admin_sessions', 'user_id', 'INTEGER')
      db.exec('CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(user_id)')
    }
    if (current() < 5) {
      // 4 → 5：owner 一律小写（只改值不改结构）。账号用户名是小写，owner 比较区分大小写，
      // 手填的 GuoyouMa 与账号 guoyouma 会被当成两个人（docs/decisions/2026-10-19-token-owner-from-user-list.md）。
      // team 不动：团队名大小写有意义。
      for (const t of ['cards', 'quarantine', 'agent_tokens']) db.exec(`UPDATE ${t} SET owner = lower(owner) WHERE owner <> lower(owner)`)
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

/** 分配一个新的卡片 id（跨两张表唯一、单调递增）。 */
export function nextCardId(db) {
  // 单语句 UPDATE ... RETURNING：取号与自增在同一个原子写里完成（SQLite >= 3.35），多进程不会拿到同一个 id
  const row = db.prepare("UPDATE card_sequence SET seq = seq + 1 WHERE name = 'card' RETURNING seq").get()
  if (!row) throw new Error('card_sequence 未初始化')
  return row.seq
}

/** 主库里的每一个 status 常量：只有它算「正常区」。 */
export const MAIN_STATUS = 'approved'
/** 隔离区里的三个 status 常量。 */
export const QUARANTINE_STATUSES = ['pending', 'rejected', 'deleted']
/** 状态 → 它应该待在哪张表。 */
export function tableForStatus(status) {
  return String(status) === MAIN_STATUS ? 'cards' : 'quarantine'
}

/**
 * 迁移到两套存储（幂等，可重复执行，每次 getDb 都会跑一遍）：
 * 把主库里所有非 approved 的行搬进隔离区，并带上它们的 card_updates。
 *
 * 关键性质：**绝不删除任何内容**，只换表。老版本代码回滚后看不到隔离区（审核队列会
 * 显示为空），但数据还在同一个 .db 文件里，升级回来即恢复。
 */
export function migrateToQuarantine(db) {
  let pending = []
  try {
    pending = db.prepare("SELECT id, path FROM cards WHERE status <> ?").all(MAIN_STATUS)
  } catch { return 0 }
  if (!pending.length) return 0

  // 老库的 card_updates 有指向 cards(id) 的外键：把卡搬走时 FK 会拒绝删除主库行。
  // 迁移期间**临时关掉外键校验**（SQLite 允许 PRAGMA foreign_keys 在无事务时切换），
  // 搬完立刻恢复 —— 之后建表/写入仍受外键保护。
  let fkWasOn = false
  try {
    fkWasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF')
  } catch { fkWasOn = false }

  const insertQuarantine = db.prepare(`
    INSERT OR IGNORE INTO quarantine
      (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, owner, team, visibility, created_at, updated_at, deleted_at, quarantined_at, quarantine_reason)
    SELECT id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, owner, team, visibility, created_at, updated_at, deleted_at, datetime('now'), '迁移：主库只保留 approved'
    FROM cards WHERE id = ?
  `)
  const dropFromMain = db.prepare('DELETE FROM cards WHERE id = ?')

  let moved = 0
  for (const row of pending) {
    try {
      db.exec('BEGIN IMMEDIATE')
      const info = insertQuarantine.run(row.id)
      // card_updates 按 card_id 关联，id 不变 → 更新记录跟着卡一起走，无需改写
      if (info.changes) moved++
      dropFromMain.run(row.id)
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
      process.stderr.write(`[memory-hub] 隔离迁移失败（${row.path}）：${e?.message || e}\n`)
    }
  }
  if (fkWasOn) { try { db.exec('PRAGMA foreign_keys = ON') } catch { /* 恢复失败：下次 getDb 会再设一次 */ } }
  if (moved) process.stderr.write(`[memory-hub] 已把 ${moved} 张未审核卡搬进隔离区（主库只留 approved）\n`)
  return moved
}

/**
 * 一致性不变量：主库只能有 approved。
 * 供测试与「用量/今日」体检使用 —— 正常永远是 0，非 0 说明有代码绕过写入闸门。
 */
export function checkMainStoreInvariant(root) {
  const db = getDb(root)
  try {
    const bad = db.prepare('SELECT status, COUNT(*) n FROM cards WHERE status <> ? GROUP BY status').all(MAIN_STATUS)
    const total = db.prepare('SELECT COUNT(*) n FROM cards').get().n
    const quarantined = db.prepare('SELECT status, COUNT(*) n FROM quarantine GROUP BY status').all()
    return { ok: bad.length === 0, violations: bad, mainTotal: total, quarantine: quarantined }
  } catch (e) {
    return { ok: false, violations: [], mainTotal: 0, quarantine: [], error: String(e?.message || e) }
  }
}

/**
 * 审核守卫：根据 config 表的审核规则决定新卡 status。
 * 所有写入路径必须经过此函数，杜绝越权。
 *
 * 规则：
 * - config 表无 auditMode 记录 → 用 fallback（调用方传入的 status）
 * - auditMode = 'none' → approved（全部免审）
 * - auditMode = 'all' → 检查免审白名单，命中→approved，否则→pending
 *
 * @param {string} root - vault 根目录
 * @param {string} kind - 卡片类型
 * @param {string} submittedBy - 提交者
 * @param {string} fallback - 调用方传入的 status（无配置时使用）
 * @returns {'pending' | 'approved'}
 */
export function enforceAudit(root, kind, submittedBy, fallback = 'pending') {
  const db = getDb(root)
  const get = (key) => { try { return db.prepare('SELECT value FROM config WHERE key = ?').get(key)?.value } catch { return null } }
  const mode = get('auditMode')
  // 无配置 → 用调用方传入的 status
  if (!mode) return fallback
  if (mode === 'none') return 'approved'
  const agentsRaw = get('auditExemptAgents') || '[]'
  const kindsRaw = get('auditExemptKinds') || '[]'
  let agents = [], kinds = []
  try { agents = JSON.parse(agentsRaw) } catch { agents = agentsRaw.split(',').map(s => s.trim()).filter(Boolean) }
  try { kinds = JSON.parse(kindsRaw) } catch { kinds = kindsRaw.split(',').map(s => s.trim()).filter(Boolean) }
  if (agents.includes('__all__') || agents.includes(submittedBy)) return 'approved'
  if (kinds.includes('__all__') || kinds.includes(kind)) return 'approved'
  return 'pending'
}

/** 写入审核配置到 config 表（供 index.js 同步 DSH settings）。 */
export function setAuditConfig(root, { auditMode, auditExemptAgents, auditExemptKinds }) {
  const db = getDb(root)
  const upsert = db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
  if (auditMode !== undefined) upsert.run('auditMode', String(auditMode))
  if (auditExemptAgents !== undefined) upsert.run('auditExemptAgents', JSON.stringify(auditExemptAgents))
  if (auditExemptKinds !== undefined) upsert.run('auditExemptKinds', JSON.stringify(auditExemptKinds))
}

export function closeDb(root) {
  const resolved = path.resolve(root)
  const db = instances.get(resolved)
  if (db) { db.close(); instances.delete(resolved) }
}

/** 关闭全部缓存连接（测试清理用：Windows 上开着连接删目录会 EBUSY）。 */
export function closeAllDb() {
  for (const db of instances.values()) { try { db.close() } catch {} }
  instances.clear()
}

/**
 * 本机 SQLite 备份：用 node:sqlite 的 backup API 生成一致性副本（不阻塞读写），
 * 备份后对副本做 integrity_check，权限 0600，保留最近 maxKeep 份。
 */
export async function backupDb(root, { maxKeep = 7 } = {}) {
  const resolved = path.resolve(root)
  const backupDir = path.join(resolved, 'backups')
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 })
  const now = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
  const backupPath = path.join(backupDir, `memory-eternal-${stamp}.db`)
  try {
    const db = getDb(root)
    // backup API 自 Node 22.16 / 23.8 起可用；更老的 22.x 回退为 VACUUM INTO（同样产出一致性副本）
    if (typeof sqlite.backup === 'function') await sqlite.backup(db, backupPath)
    else db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
    chmodSync(backupPath, 0o600)
    // 非只读打开：做完检查后切回 DELETE 日志模式，这样副本是单文件、关闭时不留 -wal/-shm 旁路文件
    const copy = new DatabaseSync(backupPath)
    let integrity
    try {
      integrity = copy.prepare('PRAGMA integrity_check').get().integrity_check
      copy.exec('PRAGMA journal_mode=DELETE')
    } finally { copy.close() }
    if (integrity !== 'ok') {
      await fs.unlink(backupPath).catch(() => {})
      return { ok: false, error: `备份 integrity_check 失败：${integrity}` }
    }
    const files = await fs.readdir(backupDir)
    const dbBackups = files.filter((f) => f.startsWith('memory-eternal-') && f.endsWith('.db')).sort().reverse()
    for (const old of dbBackups.slice(maxKeep)) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { await fs.unlink(path.join(backupDir, old + suffix)) } catch { /* 忽略 */ }
      }
    }
    return { ok: true, path: backupPath, bytes: statSync(backupPath).size, kept: Math.min(dbBackups.length, maxKeep) }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}
