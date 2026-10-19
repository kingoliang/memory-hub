// schema v5：owner 一律小写（账号用户名是小写，owner 比较区分大小写；大小写不一致 = 同一个人被当成两个人）。
// 事故：线上账号 guoyouma，令牌 owner 写成了 GuoyouMa。见 docs/decisions/2026-10-19-token-owner-from-user-list.md。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getDb, closeDb, SCHEMA_VERSION } from '../../src/core/db.js'

test('v4 → v5：cards / quarantine / agent_tokens 的 owner 转小写，team 不动，幂等', () => {
  const home = mkdtempSync(join(tmpdir(), 'mh-v5-'))
  try {
    mkdirSync(home, { recursive: true })
    getDb(home); closeDb(home)
    const raw = new DatabaseSync(join(home, 'memory-eternal.db'))
    raw.exec('PRAGMA user_version = 4')
    raw.prepare("INSERT INTO agent_tokens (token_id, name, secret_hash, scopes, created_at, owner, team) VALUES ('t1','guoyou-agent','h1','[\"read\"]','2026-10-19T00:00:00Z','GuoyouMa','PayTool')").run()
    raw.prepare("INSERT INTO agent_tokens (token_id, name, secret_hash, scopes, created_at, owner, team) VALUES ('t2','bot','h2','[\"read\"]','2026-10-19T00:00:00Z','','')").run()
    raw.close()
    assert.equal(SCHEMA_VERSION, 5)
    const db = getDb(home)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5)
    assert.deepEqual(db.prepare('SELECT token_id, owner, team FROM agent_tokens ORDER BY token_id').all().map((r) => [r.token_id, r.owner, r.team]), [['t1', 'guoyouma', 'PayTool'], ['t2', '', '']])
    closeDb(home)
    const again = getDb(home)
    assert.deepEqual(again.prepare('SELECT owner FROM agent_tokens ORDER BY token_id').all().map((r) => r.owner), ['guoyouma', ''])
    closeDb(home)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
