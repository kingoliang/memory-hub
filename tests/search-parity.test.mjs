// 召回对照：BM25 打分（GH #3）替换了旧的「整句 +3 / 每词 +1」打分，分数与顺序有意不同。
// 这里锁住不变的部分：同一 fixture 库上，宽松模式（不加 strict / minScore）不丢旧实现的任何命中（新实现额外检索标签）——
// 即换打分不丢召回；排序质量由 tests/core/relevance.test.mjs 用合成数据回归。
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

test('同一份库文件：新 search()（宽松模式）命中 ⊇ 旧实现（多出的只来自标签）；分数降序', async () => {
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
        const oldOut = await legacyVault.search(home, q, { limit: 30 })
        const newOut = await newVault.search(copy, q, { limit: 30 })
        // 旧实现不检索标签；新实现标签加权 → 新命中 ⊇ 旧命中，多出来的只能是靠标签命中的卡
        const oldPaths = new Set(oldOut.map((h) => h.path))
        for (const p of oldPaths) assert.ok(newOut.some((h) => h.path === p), `query=${q} 丢了旧命中 ${p}`)
        for (const h of newOut.filter((x) => !oldPaths.has(x.path))) {
          const terms = [...newVault.queryTerms(q.toLowerCase())]
          assert.ok(h.tags.some((t) => terms.some((w) => t.toLowerCase().includes(w))), `query=${q} 多出的 ${h.path} 必须是标签命中`)
        }
        const scores = newOut.map((h) => h.score)
        assert.deepEqual(scores, [...scores].sort((a, b) => b - a), `query=${q} 分数降序`)
        for (const h of newOut) {
          for (const k of ['path', 'kind', 'title', 'tags', 'summary', 'created', 'updated', 'mtime', 'status', 'score', 'excerpt', 'snippet']) assert.ok(k in h, `${q} 缺字段 ${k}`)
        }
      }
    } finally { newDb.closeAllDb(); rmrf(copy) }
  } finally { legacyDb.closeAllDb(); rmrf(home) }
})

// 上游缺陷：存在 feedback 记录且查询与反馈词不互相包含时，旧 search() 里
// queryTerms(...).some(...) 因 queryTerms 返回 Set 而抛 TypeError（线上 feedback=0，属潜伏缺陷）。新实现必须不崩，且有用反馈会把卡往前提。
test('feedback 反哺排序：旧实现会崩的查询新实现不崩；有用反馈提升排名、无关反馈降低排名', async () => {
  const home = tmpHome()
  try {
    for (const [kind, title, body, tags] of FIXTURE) {
      await legacyVault.writeCard(home, { kind, title, tags, body, status: 'approved', submittedBy: 'fx' }, { dedup: false })
    }
    await legacyVault.addFeedback(home, { query: '数据库', path: '03-Knowledge/数据库选型决策.md', useful: 1 })
    await assert.rejects(() => legacyVault.search(home, 'sqlite', { limit: 5 }), TypeError, '前提：旧实现在此查询上崩溃')
    legacyDb.closeAllDb()
    const copy = tmpHome()
    fs.copyFileSync(path.join(home, 'memory-eternal.db'), path.join(copy, 'memory-eternal.db'))
    try {
      const hits = await newVault.search(copy, 'sqlite', { limit: 5 })
      assert.ok(hits.length >= 1)
      const before = (await newVault.search(copy, 'sqlite 部署', { limit: 5 })).map((h) => h.path)
      assert.equal(before[0], '08-Mistakes/部署踩坑记录.md', '前提：两词都命中的卡排第一')
      for (let i = 0; i < 4; i++) await newVault.addFeedback(copy, { query: 'sqlite 部署', path: '08-Mistakes/部署踩坑记录.md', useful: 0 })
      await newVault.addFeedback(copy, { query: 'sqlite 部署', path: '03-Knowledge/数据库选型决策.md', useful: 1 })
      const after = (await newVault.search(copy, 'sqlite 部署', { limit: 5 })).map((h) => h.path)
      assert.equal(after[0], '03-Knowledge/数据库选型决策.md', '反馈应改变排序')
    } finally { newDb.closeAllDb(); rmrf(copy) }
  } finally { legacyDb.closeAllDb(); rmrf(home) }
})
