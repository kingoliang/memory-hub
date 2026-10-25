// scripts/deploy-remote.sh：沙箱里用假 ssh（本机 bash -c）+ 假 systemctl / npm + 临时 git 仓库完整走一遍
// 部署 → 备份 → 换目录 → 重启 → 核对 revision；以及重启后 revision 不符时打印回滚命令、--rollback 还原。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rmrf } from './helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(here, '../scripts/deploy-remote.sh')
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }

/** 假"线上"：HOME 沙箱、假 ssh/systemctl/npm、healthz 替身（读代码目录里的 REVISION，启动时读一次）。 */
async function sandbox({ staleHealth = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-dep-'))
  const home = path.join(root, 'home'); const bin = path.join(root, 'bin'); const repo = path.join(root, 'repo')
  for (const d of [home, bin, repo, path.join(home, '.config')]) fs.mkdirSync(d, { recursive: true })
  const port = await freePort()
  const envFile = path.join(home, '.config/prod.env')
  fs.writeFileSync(envFile, `MEMORY_HUB_HOST=127.0.0.1\nMEMORY_HUB_PORT=${port}\nMEMORY_HUB_BASE_PATH=/memory\n`, { mode: 0o600 })
  const sh = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
  sh('ssh', 'while [ "$1" = -o ]; do shift 2; done; shift   # 丢掉选项与主机\nexec env HOME="$MH_HOME" bash -c "$1"')
  sh('npm', 'mkdir -p node_modules; echo "added 0 packages"')
  // 假 systemctl restart：杀掉旧替身，起新的；替身启动时读一次 REVISION（与真服务一致）
  sh('systemctl', `
[ "$2" = restart ] || exit 0
pidf="$MH_HOME/healthz.pid"; [ -f "$pidf" ] && kill "$(cat "$pidf")" 2>/dev/null || true
echo "$3" >> "$MH_HOME/systemctl.log"
if [ -n "$MH_FAIL_RESTART" ]; then exit 0; fi   # 模拟"重启了但跑的还是旧版本/没起来"
nohup node "$MH_STANDIN" >/dev/null 2>&1 &
echo $! > "$pidf"`)
  fs.writeFileSync(path.join(root, 'standin.mjs'), `
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'
const txt = fs.readFileSync(path.join(process.env.HOME, 'memory-hub/REVISION'), 'utf8')
const sha = (/^sha=(.*)$/m.exec(txt) || [])[1] || txt.trim()
http.createServer((q, r) => { if (q.url === '/memory/healthz') r.end(JSON.stringify({ ok: true, revision: sha })); else { r.statusCode = 404; r.end() } }).listen(${port}, '127.0.0.1')`)

  // 临时 git 仓库：最小可导入的"memory-hub"，bin 的 backup now 往 $HOME/backups 写一个文件
  fs.mkdirSync(path.join(repo, 'bin')); fs.mkdirSync(path.join(repo, 'src'))
  const commit = (n) => {
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"x","type":"module","version":"0.0.0"}')
    fs.writeFileSync(path.join(repo, 'src/server.js'), `export const v = ${n}\n`)
    fs.writeFileSync(path.join(repo, 'bin/memory-hub.mjs'), `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
if (process.argv[2] === 'backup') { const d = path.join(os.homedir(), 'backups'); fs.mkdirSync(d, { recursive: true }); const f = path.join(d, 'b-${n}.db'); fs.writeFileSync(f, 'x'); console.log(f) }\n`)
    git(repo, 'add', '-A'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `c${n}`)
    return git(repo, 'rev-parse', 'HEAD')
  }
  git(repo, 'init', '-q', '-b', 'main')
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: path.join(root, 'localhome'), MH_HOME: home, MH_STANDIN: path.join(root, 'standin.mjs'), MEMORY_HUB_DEPLOY_REPO: repo, MEMORY_HUB_DEPLOY_HEALTH_WAIT: '3' }
  const run = (args, extra = {}) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...extra } })
  const cleanup = () => { try { const p = fs.readFileSync(path.join(home, 'healthz.pid'), 'utf8').trim(); process.kill(Number(p)) } catch { /* ignore */ } rmrf(root) }
  void staleHealth
  return { root, home, repo, envFile, run, commit, cleanup, hubDir: path.join(home, 'memory-hub') }
}

const common = (sb) => ['--env-file', sb.envFile, '--restart', 'user@fake']

test('部署：REVISION 含完整 sha / 提交时间 / describe；旧目录留在 .prev；重启后 revision 核对通过', async () => {
  const sb = await sandbox()
  try {
    const sha1 = sb.commit(1)
    let r = sb.run(common(sb))
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /没有 REVISION|首次/)
    assert.match(r.stdout, /跳过备份/, '首次部署远端没有旧代码，应跳过备份')
    const rev1 = fs.readFileSync(path.join(sb.hubDir, 'REVISION'), 'utf8')
    assert.match(rev1, new RegExp(`^sha=${sha1}$`, 'm')); assert.match(rev1, /^time=\d{4}-\d\d-\d\dT/m); assert.match(rev1, /^describe=\S+/m)
    assert.ok(fs.existsSync(path.join(sb.hubDir, 'node_modules')))

    const sha2 = sb.commit(2)
    r = sb.run(common(sb))
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, new RegExp(`REVISION  sha=${sha1}`), '部署前应打印远端当前 revision')
    assert.match(r.stdout, /备份完成：.*b-1\.db/, '备份用的是旧代码')
    assert.match(r.stdout, new RegExp(`/healthz revision=${sha2}，与部署一致`))
    assert.match(fs.readFileSync(path.join(sb.hubDir, 'REVISION'), 'utf8'), new RegExp(sha2))
    assert.match(fs.readFileSync(path.join(sb.hubDir + '.prev', 'REVISION'), 'utf8'), new RegExp(sha1))
    assert.ok(!fs.existsSync(sb.hubDir + '.new'))
  } finally { sb.cleanup() }
})

test('重启后 revision 不符 → 退出 1、打印回滚命令；--rollback --restart 还原旧版本', async () => {
  const sb = await sandbox()
  try {
    const sha1 = sb.commit(1)
    assert.equal(sb.run(common(sb)).status, 0)
    const sha2 = sb.commit(2)
    // 假 systemctl "重启成功但没起来"：旧替身已被杀，healthz 无响应
    let r = sb.run(common(sb), { MH_FAIL_RESTART: '1' })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /健康检查未通过/)
    assert.match(r.stderr, /scripts\/deploy-remote\.sh --rollback --restart --env-file \S+ --unit memory-hub\.service --dir \S+ user@fake/)
    assert.match(r.stderr, /部署前备份：.*b-1\.db/)
    assert.match(fs.readFileSync(path.join(sb.hubDir, 'REVISION'), 'utf8'), new RegExp(sha2))

    r = sb.run(['--rollback', ...common(sb)])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(fs.readFileSync(path.join(sb.hubDir, 'REVISION'), 'utf8'), new RegExp(sha1))
    assert.match(fs.readFileSync(path.join(sb.hubDir + '.failed', 'REVISION'), 'utf8'), new RegExp(sha2))
    assert.match(r.stdout, new RegExp(`/healthz revision=${sha1}`))
  } finally { sb.cleanup() }
})

test('备份失败 → 中止，线上目录不动；缺 --env-file 拒绝；--skip-backup 可显式跳过', async () => {
  const sb = await sandbox()
  try {
    const sha1 = sb.commit(1)
    assert.equal(sb.run(common(sb)).status, 0)
    sb.commit(2)
    fs.writeFileSync(path.join(sb.hubDir, 'bin/memory-hub.mjs'), 'process.exit(7)\n') // 让旧代码的 backup 失败
    const r = sb.run(common(sb))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /备份失败，已中止/)
    assert.match(fs.readFileSync(path.join(sb.hubDir, 'REVISION'), 'utf8'), new RegExp(sha1), '备份失败时不得换代码')
    assert.ok(!fs.existsSync(sb.hubDir + '.new'))

    const noEnv = sb.run(['user@fake'])
    assert.equal(noEnv.status, 1); assert.match(noEnv.stderr, /--env-file/)
    const skip = sb.run(['--skip-backup', 'user@fake'])
    assert.equal(skip.status, 0, skip.stdout + skip.stderr)
    assert.match(skip.stdout, /跳过部署前备份/); assert.match(skip.stdout, /未加 --restart/)
  } finally { sb.cleanup() }
})

test('--dry-run 不连远端；工作区不干净时真实部署拒绝', async () => {
  const sb = await sandbox()
  try {
    sb.commit(1)
    const d = sb.run(['--dry-run', ...common(sb)], { PATH: '/usr/bin:/bin' }) // PATH 里没有假 ssh：碰远端就会失败
    assert.equal(d.status, 0, d.stderr); assert.match(d.stdout, /dry-run/); assert.match(d.stdout, /核对 \/healthz\.revision/)
    fs.writeFileSync(path.join(sb.repo, 'dirty.txt'), 'x')
    const r = sb.run(common(sb))
    assert.equal(r.status, 1); assert.match(r.stderr, /工作区不干净/)
  } finally { sb.cleanup() }
})
