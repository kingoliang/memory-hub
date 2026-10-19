// 门禁口径自检：生产文件清单必须包含各目录顶层文件（防 pathspec `**` 不匹配零层目录导致分母缩水）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gitFiles } from '../scripts/quality/lib.mjs'

test('gitFiles 包含顶层文件（src/server.js、web/js/dom.js、bin/memory-hub.mjs）与深层文件', () => {
  const files = gitFiles()
  assert.deepEqual(
    ['src/server.js', 'src/config.js', 'web/js/dom.js', 'web/js/graph-spider.js', 'bin/memory-hub.mjs', 'src/admin/rbac.js', 'web/js/views/graph.js'].map((f) => files.includes(f)),
    [true, true, true, true, true, true, true],
  )
})
