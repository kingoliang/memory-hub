// 只做一件事：对一个（可能全新的）库调用一次 getDb，然后关掉。
// 用法：node tests/e2e/open-once.mjs <dbRoot> [--core <含 db.js 的目录>]
// 输出：'ok' 或 'BUSY:<message>'。供 tests/core/db-concurrent-open.test.mjs 使用。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreIdx = process.argv.indexOf('--core')
const core = coreIdx > 0 ? path.resolve(process.argv[coreIdx + 1]) : path.join(here, '../../src/core')
const root = process.argv[2]

try {
  const { getDb, closeAllDb } = await import(pathToFileURL(path.join(core, 'db.js')))
  getDb(root)
  closeAllDb()
  process.stdout.write('ok')
} catch (e) {
  process.stdout.write('BUSY:' + String(e?.message || e))
}
