// scripts/cutover.sh：dry-run 默认且零副作用；--execute 缺 --frozen-ack 拒绝；
// 沙箱里（假 systemctl / systemd-run + 真实 hub 服务 + 旧服务替身）完整走一遍 prepare → cutover → 新库写入 → rollback。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { tmpHome, rmrf, rpc, durableText } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(here, '..')
const SCRIPT = path.join(REPO, 'scripts/cutover.sh')
const legacyDb = await import(pathToFileURL(path.join(here, 'fixtures/legacy/db.js')))
const legacyVault = await import(pathToFileURL(path.join(here, 'fixtures/legacy/vault.js')))

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })

/** 搭沙箱：HOME、假 systemctl/systemd-run/ss、旧服务替身、旧库、旧令牌文件、staging.env。 */
async function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cut-'))
  const home = path.join(root, 'home'); const bin = path.join(root, 'bin'); const st = path.join(root, 'state')
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(st)
  const log = path.join(st, 'calls.log'); fs.writeFileSync(log, '')
  const port = await freePort()
  const oldVault = path.join(root, 'old-vault'); fs.mkdirSync(oldVault)
  for (const [kind, title, status] of [['knowledge', '甲', 'approved'], ['project', '乙', 'approved'], ['tool', '丙', 'pending']]) {
    await legacyVault.writeCard(oldVault, { kind, title, tags: [kind], body: `${title} 沙箱合成正文，用于切换演练。`.repeat(3), status, submittedBy: 'fx' }, { dedup: false })
  }
  legacyDb.closeAllDb()
  const oldToken = crypto.randomBytes(24).toString('base64url') + 'OLDTOKEN' + crypto.randomBytes(8).toString('hex')
  fs.writeFileSync(path.join(root, 'old-token'), oldToken + '\n', { mode: 0o600 })
  const llmKey = 'FAKELLMKEY' + crypto.randomBytes(8).toString('hex')
  fs.mkdirSync(path.join(home, '.config/memory-hub'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(home, '.config/memory-hub/staging.env'), `MEMORY_HUB_PORT=1\nMEMORY_LLM_BASE_URL=http://127.0.0.1:9\nMEMORY_LLM_MODEL=m\nMEMORY_LLM_KEY=${llmKey}\n`, { mode: 0o600 })

  // 旧服务替身：healthz 返回 {"ok":true}（无 version）；/memory/mcp 校验旧令牌
  fs.writeFileSync(path.join(root, 'standin.mjs'), `
import http from 'node:http'; import fs from 'node:fs'
const tok = fs.readFileSync(${JSON.stringify(path.join(root, 'old-token'))}, 'utf8').trim()
http.createServer((req, res) => {
  if (req.url === '/memory/healthz') { res.end('{"ok":true}'); return }
  if (req.url === '/memory/mcp') { const ok = req.headers.authorization === 'Bearer ' + tok; res.statusCode = ok ? 200 : 401; res.end('{}'); return }
  res.statusCode = 404; res.end()
}).listen(${port}, '127.0.0.1')`)
  const oldUnit = 'fake-old.service'
  const sh = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }) }
  // 旧服务启动命令（演练里的 CUT_OLD_START_CMD）
  fs.writeFileSync(path.join(root, 'old-start.sh'), `#!/usr/bin/env bash\nnohup ${process.execPath} ${path.join(root, 'standin.mjs')} >/dev/null 2>&1 &\necho $! > ${st}/${oldUnit}.pid\nsleep 0.3\n`, { mode: 0o755 })
  sh('systemctl', `
echo "$*" >> ${log}
shift # --user
cmd=$1; unit=\${2:-}
pf=${st}/$unit.pid
case $cmd in
  is-active) if [ -f $pf ] && kill -0 $(cat $pf) 2>/dev/null; then echo active; else echo inactive; exit 3; fi ;;
  is-enabled) echo enabled ;;
  stop) if [ -f $pf ]; then kill $(cat $pf) 2>/dev/null || true; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 $(cat $pf) 2>/dev/null || break; sleep 0.2; done; rm -f $pf; fi ;;
  *) : ;;
esac`)
  sh('systemd-run', `
echo "systemd-run $*" >> ${log}
unit=""; envf=""; wd=""
while [ $# -gt 0 ]; do case $1 in
  --user|--quiet) shift ;; --unit=*) unit=\${1#--unit=}; shift ;; --property=EnvironmentFile=*) envf=\${1#--property=EnvironmentFile=}; shift ;; --working-directory=*) wd=\${1#--working-directory=}; shift ;; *) break ;; esac; done
( cd $wd; set -a; . $envf; set +a; exec nohup "$@" >> ${st}/$unit.service.log 2>&1 ) &
echo $! > ${st}/$unit.service.pid`)
  sh('ss', `printf '' ; [ -f ${st}/${oldUnit}.pid ] && kill -0 $(cat ${st}/${oldUnit}.pid) 2>/dev/null && echo "LISTEN 0 1 127.0.0.1:${port}"; for f in ${st}/memory-hub-*.service.pid; do [ -f $f ] && kill -0 $(cat $f) 2>/dev/null && echo "LISTEN 0 1 127.0.0.1:${port}"; done; exit 0`)
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: home, NODE: process.execPath,
    CUT_OLD_UNIT: oldUnit, CUT_OLD_DB: path.join(oldVault, 'memory-eternal.db'), CUT_OLD_TOKEN_FILE: path.join(root, 'old-token'),
    CUT_OLD_START_CMD: path.join(root, 'old-start.sh'), CUT_OLD_ENABLEABLE: '0',
    CUT_HUB_UNIT: 'memory-hub-sandbox.service', CUT_HUB_TRANSIENT: '1', CUT_HUB_DIR: REPO,
    CUT_DATA_DIR: path.join(root, 'data'), CUT_STATE_DIR: path.join(root, 'cutover'),
    CUT_CFG_DIR: path.join(home, '.config/memory-hub'), CUT_PORT: String(port), CUT_BASE_PATH: '/memory',
    CUT_CHECK_NGINX: '0',
  }
  const sbx = {
    root, home, st, log, port, env, oldToken, llmKey, oldVault,
    run: (args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...env }, timeout: 120000 }),
    calls: () => fs.readFileSync(log, 'utf8'),
    startOld: () => spawnSync('bash', [path.join(root, 'old-start.sh')], { env }),
    cleanup: () => {
      for (const f of fs.readdirSync(st)) if (f.endsWith('.pid')) { try { process.kill(Number(fs.readFileSync(path.join(st, f), 'utf8')), 'SIGKILL') } catch { /* 已退出 */ } }
      rmrf(root)
    },
  }
  return sbx
}

test('dry-run 是默认：status/preflight/prepare/cutover/rollback 都不改任何东西（无 systemctl 变更调用，不建数据目录/配置）', async () => {
  const s = await sandbox()
  try {
    s.startOld()
    const sizeBefore = fs.statSync(s.env.CUT_OLD_DB).size
    // cutover dry-run 需要 prepare 过的产物；dry-run 的 prepare 不应创建它们
    const p = s.run(['prepare'])
    assert.equal(p.status, 0, p.stderr + p.stdout)
    assert.match(p.stdout, /dry-run/)
    assert.ok(!fs.existsSync(path.join(s.home, '.config/memory-hub/prod.env')), 'dry-run prepare 不应生成 env')
    assert.ok(!fs.existsSync(s.env.CUT_DATA_DIR))
    // 手工补 env/口令文件后跑 cutover / rollback 的 dry-run
    fs.writeFileSync(path.join(s.home, '.config/memory-hub/prod.env'), 'MEMORY_HUB_HOME=x\n', { mode: 0o600 })
    fs.writeFileSync(path.join(s.home, '.config/memory-hub/prod-admin-password'), 'x'.repeat(24), { mode: 0o600 })
    for (const mode of [['status'], ['preflight'], ['cutover', '--frozen-ack'], ['rollback']]) {
      const r = s.run(mode)
      assert.equal(r.status, 0, `${mode.join(' ')}: ${r.stderr}${r.stdout}`)
    }
    const calls = s.calls()
    assert.ok(!/\b(stop|start|enable|disable|daemon-reload)\b/.test(calls.replace(/is-active|is-enabled/g, '')), `dry-run 出现变更调用：\n${calls}`)
    assert.ok(!fs.existsSync(s.env.CUT_DATA_DIR), 'dry-run 不建数据目录')
    assert.ok(!fs.existsSync(s.env.CUT_STATE_DIR) || fs.readdirSync(s.env.CUT_STATE_DIR).length === 0, 'dry-run 不留切换记录')
    assert.equal(fs.statSync(s.env.CUT_OLD_DB).size, sizeBefore)
    const out = s.run(['cutover', '--frozen-ack']).stdout
    assert.match(out, /\[dry-run\] 将执行：systemctl --user stop fake-old\.service/)
  } finally { s.cleanup() }
})

test('--execute 缺 --frozen-ack → 拒绝，且没有停旧服务', async () => {
  const s = await sandbox()
  try {
    s.startOld()
    fs.writeFileSync(path.join(s.home, '.config/memory-hub/prod.env'), 'MEMORY_HUB_HOME=x\n', { mode: 0o600 })
    fs.writeFileSync(path.join(s.home, '.config/memory-hub/prod-admin-password'), 'x'.repeat(24), { mode: 0o600 })
    const r = s.run(['cutover', '--execute'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /frozen-ack/)
    assert.ok(!/\bstop\b/.test(s.calls()))
    const bad = s.run(['cutover', '--bogus'])
    assert.notEqual(bad.status, 0)
  } finally { s.cleanup() }
})

test('沙箱完整演练：prepare → cutover → 旧令牌直接可用 → 新库产生增量 → rollback → 增量回到旧库、旧服务恢复', async () => {
  const s = await sandbox()
  try {
    s.startOld()
    // prepare
    const p = s.run(['prepare', '--execute'])
    assert.equal(p.status, 0, p.stderr + p.stdout)
    const envFile = path.join(s.home, '.config/memory-hub/prod.env')
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600)
    const envText = fs.readFileSync(envFile, 'utf8')
    for (const k of ['MEMORY_HUB_HOME=', 'MEMORY_HUB_PORT=' + s.port, 'MEMORY_HUB_BASE_PATH=/memory', 'MEMORY_HUB_TRUST_PROXY=1', 'MEMORY_HUB_ALLOWED_HOSTS=', 'MEMORY_HUB_ALLOWED_ORIGINS=', 'MEMORY_LLM_KEY=' + s.llmKey]) assert.ok(envText.includes(k), k)
    assert.ok(!p.stdout.includes(s.llmKey) && !p.stderr.includes(s.llmKey), 'prepare 输出不得含 LLM key')
    const pw = path.join(s.home, '.config/memory-hub/prod-admin-password')
    assert.equal(fs.statSync(pw).mode & 0o777, 0o600)
    assert.ok(fs.readFileSync(pw, 'utf8').trim().length >= 20)

    // cutover
    const c = s.run(['cutover', '--execute', '--frozen-ack'])
    assert.equal(c.status, 0, c.stderr + c.stdout)
    assert.ok(!c.stdout.includes(s.oldToken) && !c.stderr.includes(s.oldToken) && !c.stdout.includes(s.llmKey), '输出不得含令牌 / key')
    assert.equal((c.stdout.match(/RESULT: PASS/g) || []).length, 3, c.stdout)
    assert.match(c.stdout, /旧令牌 tools\/list 直连：HTTP 200/)
    assert.match(c.stdout, /模拟 nginx）：HTTP 200/)
    assert.match(c.stdout, /无令牌：HTTP 401/)
    const calls = s.calls()
    assert.ok(calls.indexOf('stop fake-old.service') < calls.indexOf('systemd-run'), '先停旧再起新')
    assert.ok(fs.existsSync(path.join(s.env.CUT_DATA_DIR, 'memory-eternal.db')))
    const snaps = fs.readdirSync(path.join(s.env.CUT_STATE_DIR)).filter((f) => /^\d{8}T/.test(f))
    assert.equal(snaps.length, 1)
    assert.equal(fs.statSync(path.join(s.env.CUT_STATE_DIR, snaps[0], 'final-snapshot.db')).mode & 0o077, 0)
    assert.ok(!fs.readFileSync(path.join(s.env.CUT_STATE_DIR, 'latest/state.env'), 'utf8').includes(s.oldToken))
    // 旧库原件没被碰（新服务写的是 DATA_DIR）
    const oldUv = new DatabaseSync(s.env.CUT_OLD_DB, { readOnly: true })
    assert.equal(oldUv.prepare('PRAGMA user_version').get().user_version, 0)
    oldUv.close()

    // 新服务期间产生增量：用旧令牌（legacy-shared）capture 一张卡，并在库里直接批准一张待审卡
    const url = `http://127.0.0.1:${s.port}/memory`
    const cap = await rpc(url, s.oldToken, 'tools/call', { name: 'memory_capture', arguments: { text: durableText('切换后新增', 3) } })
    assert.equal(cap.status, 200)
    const nd = new DatabaseSync(path.join(s.env.CUT_DATA_DIR, 'memory-eternal.db'))
    nd.exec('PRAGMA busy_timeout=5000')
    const added = nd.prepare("SELECT COUNT(*) n FROM quarantine WHERE submitted_by = 'legacy-shared'").get().n + nd.prepare("SELECT COUNT(*) n FROM cards WHERE submitted_by = 'legacy-shared'").get().n
    nd.close()
    assert.equal(added, 1, '新卡署名应为 legacy-shared')

    // rollback：dry-run 先看计划（不动）
    const rd = s.run(['rollback'])
    assert.equal(rd.status, 0, rd.stderr + rd.stdout)
    assert.match(rd.stdout, /新增 1/)
    assert.ok(fs.existsSync(s.env.CUT_DATA_DIR), 'dry-run 不改名数据目录')
    const rb = s.run(['rollback', '--execute'])
    assert.equal(rb.status, 0, rb.stderr + rb.stdout)
    assert.match(rb.stdout, /旧服务 healthz：\{"ok":true\}/)
    assert.match(rb.stdout, /旧令牌 tools\/list：HTTP 200/)
    assert.ok(!fs.existsSync(s.env.CUT_DATA_DIR) && fs.readdirSync(s.root).some((f) => f === 'data.rolledback-' || f.startsWith('data.rolledback-')), '新数据目录改名保留')
    // 旧库收到了新增卡，仍是旧 schema，留底存在
    const od = new DatabaseSync(s.env.CUT_OLD_DB, { readOnly: true })
    const n = od.prepare("SELECT COUNT(*) n FROM (SELECT submitted_by FROM cards UNION ALL SELECT submitted_by FROM quarantine) WHERE submitted_by = 'legacy-shared'").get().n
    assert.equal(n, 1, '增量回到旧库')
    assert.equal(od.prepare('PRAGMA user_version').get().user_version, 0)
    od.close()
    assert.ok(fs.readdirSync(s.oldVault).some((f) => f.startsWith('pre-reverse-')))
    assert.equal((await fetch(`${url}/healthz`).then((r) => r.json())).version, undefined, '现在响应的是旧服务替身')
  } finally { s.cleanup() }
})
