// 召回一致性：同一 fixture 库上，新旧 search() 输出逐项相同
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpHome, rmrf } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const legacyDb = await import(pathToFileURL(path.join(here, 'fixtures/legacy/db.js')))
const legacyVault = await import(pathToFileURL(path.join(here, 'fixtures/legacy/vault.js')))
const newDb = await import('../src/core/db.js')
const newVault = await import('../src/core/vault.js')

const FIXTURE = [
  ['knowledge', '数据库选型决策', '我们选择 SQLite 作为本地存储，原因是零依赖与单文件备份方便。', ['db', 'sqlite']],
  ['project', 'Redis 缓存方案', 'Redis cache for session storage, TTL 30 minutes. 缓存穿透用布隆过滤器。', ['redis']],
  ['mistake', '部署踩坑记录', '部署时忘记设置 busy_timeout 导致多进程写入失败，根因是默认超时为零。', ['deploy', 'sqlite']],
  ['tool', 'git 常用命令', 'git rebase -i 与 git reflog 的用法；撤销提交使用 git reset。', ['git']],
  ['knowledge', '用户偏好', '用户偏好简体中文回答，代码注释使用中文，日志使用英文。', []],
]
const QUERIES = ['数据库选型', '数据库', 'sqlite', 'Redis', '缓存', '部署', 'busy_timeout', 'git rebase', '用户偏好', '不存在的词汇xyz', '库选', '偏好 中文']

/**
 * 旧实现产出的字段集（写死，不用 Object.keys(newOut) 推导 —— 后者漏掉一个旧字段也看不出来）。
 * v3 新增的 owner/team/visibility/tier 属于增量字段，不在本对账范围内。
 */
const LEGACY_KEYS = ['path', 'kind', 'title', 'tags', 'summary', 'created', 'updated', 'mtime', 'status', 'submittedBy', 'severity', 'reason', 'deletedAt', 'score', 'excerpt']
const legacyShape = (list) => list.map((h) => Object.fromEntries(LEGACY_KEYS.map((k) => [k, h[k]])))

test('同一份库文件：旧 search() 与新 search() 输出完全一致（含分数与顺序）', async () => {
  const home = tmpHome()
  try {
    for (const [kind, title, body, tags] of FIXTURE) {
      await legacyVault.writeCard(home, { kind, title, tags, body, status: 'approved', submittedBy: 'fx' }, { dedup: false })
    }
    legacyDb.closeAllDb()
    const copy = tmpHome()
    fs.copyFileSync(path.join(home, 'memory-eternal.db'), path.join(copy, 'memory-eternal.db'))
    try {
      for (const q of QUERIES) {
        for (const opts of [{ limit: 5, minScore: 2 }, { limit: 30 }]) {
          const oldOut = await legacyVault.search(home, q, opts)
          const newOut = await newVault.search(copy, q, opts)
          assert.deepEqual(legacyShape(newOut), legacyShape(oldOut), `query=${q} opts=${JSON.stringify(opts)}`)
        }
      }
    } finally { newDb.closeAllDb(); rmrf(copy) }
  } finally { legacyDb.closeAllDb(); rmrf(home) }
})

// 上游缺陷：存在 feedback 记录且查询与反馈词不互相包含时，旧 search() 里
// queryTerms(...).some(...) 因 queryTerms 返回 Set 而抛 TypeError（线上 feedback=0，属潜伏缺陷）。
// 新实现必须修好；在旧实现不抛错的查询上（查询包含反馈词）两者结果仍须一致。
test('feedback 反哺排序：旧实现会崩的查询新实现不崩；旧实现不崩的查询结果逐项一致', async () => {
  const home = tmpHome()
  try {
    for (const [kind, title, body, tags] of FIXTURE) {
      await legacyVault.writeCard(home, { kind, title, tags, body, status: 'approved', submittedBy: 'fx' }, { dedup: false })
    }
    await legacyVault.addFeedback(home, { query: '数据库', path: '03-Knowledge/数据库选型决策.md', useful: 1 })
    legacyDb.closeAllDb()
    const copy = tmpHome()
    fs.copyFileSync(path.join(home, 'memory-eternal.db'), path.join(copy, 'memory-eternal.db'))
    try {
      for (const q of ['数据库选型', '数据库', '数据库 sqlite']) {
        assert.deepEqual(legacyShape(await newVault.search(copy, q, { limit: 5 })), legacyShape(await legacyVault.search(home, q, { limit: 5 })), q)
      }
      await assert.rejects(() => legacyVault.search(home, 'sqlite', { limit: 5 }), TypeError, '前提：旧实现在此查询上崩溃')
      const hits = await newVault.search(copy, 'sqlite', { limit: 5 })
      assert.ok(hits.length >= 1)
    } finally { newDb.closeAllDb(); rmrf(copy) }
  } finally { legacyDb.closeAllDb(); rmrf(home) }
})
