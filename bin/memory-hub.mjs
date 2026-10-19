#!/usr/bin/env node
// memory-hub CLI
//   memory-hub serve                         起 HTTP 服务（默认 127.0.0.1:7990）
//   memory-hub mcp                           stdio MCP（本地单 Agent，身份取 MEMORY_HUB_AGENT）
//   memory-hub token create --name N --scope read,write [--owner 人] [--team 团队] [--visibility private|team|public] [--expires 14d|ISO时间]   明文只显示这一次（stdout）
//   memory-hub token list [--json]
//   memory-hub token revoke <name|tokenId>
//   memory-hub token import-hash --name N --scope read,write [--expires 14d] (--from-file <旧令牌文件> | --hash <sha256>)   导入旧共享令牌（只存哈希，不打印）
//   memory-hub migrate verify --source <旧库/快照> --target <新库> [--allow-target-extra] [--json]    对账（PLAN 6.3.2），FAIL 退出码 1
//   memory-hub migrate reverse --from <新库> --target <旧库> [--execute] [--prune-purged] [--export f.json]   反向增量（默认 dry-run）
//   memory-hub backup now
//   memory-hub admin set-password            设置/更换管理界面口令：从 stdin 读取（终端里交互输入不回显；管道则读第一行），绝不经命令行参数、不打印

import { loadConfig, validateBind, ConfigError } from '../src/config.js'
import { createLogger, setDefaultLogger } from '../src/logger.js'
import { createToken, importLegacyToken, listTokens, revokeToken, TokenError } from '../src/auth/tokens.js'
import fs from 'node:fs'
import { backupDb, closeAllDb } from '../src/core/db.js'
import { setAdminPassword, AdminAuthError, MIN_PASSWORD_LENGTH } from '../src/admin/auth.js'
import { createUser, listUsers, updateUser, setUserPassword, disableUser, enableUser, UserError } from '../src/admin/users.js'

const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const flag = (name) => argv.includes('--' + name)

const bootLog = createLogger({ level: process.env.MEMORY_HUB_LOG_LEVEL || 'info' })

function parseExpires(v) {
  if (!v) return null
  const m = /^(\d+)([mhd])$/.exec(v)
  if (m) return new Date(Date.now() + Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]]).toISOString()
  if (Number.isNaN(Date.parse(v))) throw new TokenError(`--expires 需要形如 30m / 12h / 14d 或 ISO 时间：${v}`)
  return new Date(v).toISOString()
}

/** 读取口令：TTY 下交互输入（不回显、输入两次确认）；否则读 stdin 第一行。口令不进入 argv、日志或输出。 */
async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    const first = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]
    if (!first) throw new AdminAuthError('没有从 stdin 读到口令')
    return first
  }
  const ask = (label) => new Promise((resolve, reject) => {
    process.stderr.write(label)
    const stdin = process.stdin
    let buf = ''
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8')
    const done = (fn, v) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); fn(v) }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') return done(reject, new AdminAuthError('已取消'))
        if (ch === '\r' || ch === '\n') return done(resolve, buf)
        if (ch === '\u007f' || ch === '\b') buf = [...buf].slice(0, -1).join('')
        else buf += ch
      }
    }
    stdin.on('data', onData)
  })
  const a = await ask(`新的管理员口令（至少 ${MIN_PASSWORD_LENGTH} 个字符，不回显）：`)
  const b = await ask('再输入一次：')
  if (a !== b) throw new AdminAuthError('两次输入不一致')
  return a
}

function usage() {
  process.stderr.write(`用法：
  memory-hub serve
  memory-hub mcp
  memory-hub token create --name <名字> --scope read,write[,tidy:apply] [--owner <人>] [--team <团队>] [--visibility private|team|public] [--expires 14d]
  memory-hub token list [--json]        # 文本输出列为：名字 owner team 可见性 tokenId scopes 状态 …
  memory-hub token revoke <名字|tokenId>
  memory-hub token import-hash --name <名字> --scope read,write [--expires 14d] (--from-file <旧令牌文件> | --hash <sha256十六进制>)
  memory-hub migrate verify --source <旧库或快照(目录或.db)> --target <新库> [--allow-target-extra] [--json]
  memory-hub migrate reverse --from <新库> --target <旧库> [--execute] [--prune-purged] [--export <文件.json>]
  memory-hub backup now
  memory-hub admin set-password          （应急入口口令；从 stdin 读取，终端交互输入两次，不回显）
  memory-hub user create --username <名> --team <团队> --role member|lead|admin   （口令从 stdin 读取）
  memory-hub user list [--json]
  memory-hub user set-role <名> member|lead|admin  |  user set-team <名> <团队>
  memory-hub user set-password <名>      （从 stdin 读取）
  memory-hub user disable <名>  |  user enable <名>
环境变量：MEMORY_HUB_HOME MEMORY_HUB_DB MEMORY_HUB_HOST MEMORY_HUB_PORT MEMORY_HUB_BASE_PATH MEMORY_HUB_ALLOW_REMOTE
  MEMORY_HUB_ALLOWED_ORIGINS MEMORY_HUB_ALLOWED_HOSTS MEMORY_HUB_TRUST_PROXY MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY MEMORY_HUB_AGENT
  MEMORY_LLM_BASE_URL MEMORY_LLM_MODEL MEMORY_LLM_KEY
`)
}

async function main() {
  const [cmd, sub] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return cmd ? 0 : 1 }
  const config = loadConfig(process.env, { warn: (m) => bootLog.warn(m) })
  const log = createLogger({ level: config.logLevel })
  setDefaultLogger(log)

  if (cmd === 'serve') {
    validateBind(config)
    const { startServer } = await import('../src/server.js')
    const srv = await startServer(config, { logger: log })
    const stop = async (sig) => {
      log.info('收到退出信号，正在关闭', { signal: sig })
      await srv.close().catch(() => {})
      closeAllDb()
      process.exit(0)
    }
    process.on('SIGTERM', () => stop('SIGTERM'))
    process.on('SIGINT', () => stop('SIGINT'))
    return null // 保持运行
  }

  if (cmd === 'mcp') {
    const { runStdio } = await import('../src/transport/stdio.js')
    const handle = runStdio(config, { log })
    const stop = async () => { try { await handle.close() } catch { /* ignore */ } closeAllDb(); process.exit(0) }
    process.stdin.on('end', stop)
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
    return null
  }

  if (cmd === 'token') {
    if (sub === 'create') {
      const t = createToken(config.dbRoot, {
        name: opt('name'), scopes: opt('scope'), expiresAt: parseExpires(opt('expires')),
        owner: opt('owner'), team: opt('team'), defaultVisibility: opt('visibility'),
      })
      log.info('令牌已创建', { name: t.name, id: t.tokenId, scopes: t.scopes, owner: t.owner, team: t.team, visibility: t.defaultVisibility, expiresAt: t.expiresAt })
      process.stderr.write(`令牌名：${t.name}\nowner：${t.owner || '(空)'}\nteam：${t.team || '(空)'}\n默认可见性：${t.defaultVisibility}\nscope：${t.scopes.join(',')}\n过期：${t.expiresAt || '不过期'}\n以下为令牌明文，只显示这一次，请立即保存（库里只存哈希）：\n`)
      process.stdout.write(t.token + '\n')
      return 0
    }
    if (sub === 'list') {
      const rows = listTokens(config.dbRoot)
      if (flag('json')) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return 0 }
      if (!rows.length) { process.stdout.write('（没有令牌）\n'); return 0 }
      for (const r of rows) {
        const state = r.revokedAt ? '已撤销' : r.expiresAt && Date.parse(r.expiresAt) <= Date.now() ? '已过期' : '有效'
        process.stdout.write(`${r.name}\t${r.owner || '-'}\t${r.team || '-'}\t${r.defaultVisibility}\t${r.tokenId}\t${r.scopes.join(',')}\t${state}\t创建 ${r.createdAt}\t最近使用 ${r.lastUsedAt || '-'}\t过期 ${r.expiresAt || '-'}\n`)
      }
      return 0
    }
    if (sub === 'revoke') {
      const target = argv[2]
      if (!target) throw new TokenError('用法：memory-hub token revoke <名字|tokenId>')
      const r = revokeToken(config.dbRoot, target)
      log.info('令牌已撤销', { name: r.name, id: r.tokenId })
      process.stdout.write(`已撤销：${r.name}（${r.tokenId}）\n`)
      return 0
    }
    if (sub === 'import-hash') {
      const file = opt('from-file'), hash = opt('hash')
      if ((file === undefined) === (hash === undefined)) throw new TokenError('--from-file 与 --hash 必须二选一')
      let token
      if (file !== undefined) {
        try { token = fs.readFileSync(file, 'utf8').trim() } catch (e) { throw new TokenError(`读不到令牌文件：${file}（${e.code || 'error'}）`) }
      }
      const t = importLegacyToken(config.dbRoot, {
        name: opt('name'), token, hash, scopes: opt('scope'), expiresAt: parseExpires(opt('expires')),
        owner: opt('owner'), team: opt('team'), defaultVisibility: opt('visibility'),
      })
      log.info('旧令牌已导入（仅哈希）', { name: t.name, id: t.tokenId, scopes: t.scopes, owner: t.owner, team: t.team, visibility: t.defaultVisibility, expiresAt: t.expiresAt })
      process.stdout.write(`已导入：${t.name}（${t.tokenId}） owner=${t.owner || '-'} team=${t.team || '-'} scope=${t.scopes.join(',')} 过期=${t.expiresAt || '不过期'}\n只保存了 sha256；旧令牌明文未被打印或存储。\n`)
      return 0
    }
    usage(); return 1
  }

  if (cmd === 'migrate') {
    const { verifyMigration, formatChecks, planReverse, applyReverse, formatPlan } = await import('../src/migrate.js')
    if (sub === 'verify') {
      const source = opt('source'), target = opt('target')
      if (!source || !target) throw new TokenError('用法：memory-hub migrate verify --source <旧库> --target <新库> [--allow-target-extra] [--json]')
      const r = verifyMigration({ source, target, allowTargetExtra: flag('allow-target-extra') })
      process.stdout.write(flag('json') ? JSON.stringify(r, null, 2) + '\n' : formatChecks(r))
      log.info('migrate verify', { ok: r.ok })
      return r.ok ? 0 : 1
    }
    if (sub === 'reverse') {
      const from = opt('from'), target = opt('target')
      if (!from || !target) throw new TokenError('用法：memory-hub migrate reverse --from <新库> --target <旧库> [--execute] [--prune-purged] [--export <文件.json>]')
      const r = await applyReverse({ from, target, execute: flag('execute'), pruneMissing: flag('prune-purged'), exportFile: opt('export') })
      process.stdout.write(formatPlan(r))
      log.info('migrate reverse', { executed: !!r.executed, ok: r.ok, add: r.plan.add, change: r.plan.change })
      return r.ok ? 0 : 1
    }
    usage(); return 1
  }

  if (cmd === 'backup' && sub === 'now') {
    const r = await backupDb(config.dbRoot)
    if (!r.ok) throw new Error(`备份失败：${r.error}`)
    log.info('备份完成', { file: r.path, bytes: r.bytes })
    process.stdout.write(r.path + '\n')
    return 0
  }

  if (cmd === 'user') {
    // 管理界面账号（docs/decisions/2026-10-19-admin-multi-user-rbac.md）。口令一律从 stdin 读，不经命令行参数。
    if (sub === 'create') {
      if (argv.includes('--password')) throw new UserError('口令不能通过命令行参数传入：从 stdin 读取')
      const pw = await readPassword()
      const u = createUser(config.dbRoot, { username: opt('username'), team: opt('team') || '', role: opt('role') || 'member', password: pw })
      log.info('管理界面账号已创建', { username: u.username, team: u.team, role: u.role })
      process.stdout.write(`已创建：${u.username}（团队 ${u.team || '-'}，角色 ${u.role}）\n`)
      return 0
    }
    if (sub === 'list') {
      const rows = listUsers(config.dbRoot)
      if (flag('json')) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return 0 }
      if (!rows.length) { process.stdout.write('（没有账号）\n'); return 0 }
      for (const u of rows) process.stdout.write(`${u.username}\t${u.team || '-'}\t${u.role}\t${u.disabled ? '已停用' : '正常'}\t最近登录 ${u.lastLoginAt || '-'}\n`)
      return 0
    }
    const target = argv[2]
    if (!target) throw new UserError('缺少用户名')
    if (sub === 'set-role') { const r = updateUser(config.dbRoot, target, { role: argv[3] }); process.stdout.write(`${r.username}：${r.changed.length ? '已修改' : '无变化'}\n`); return 0 }
    if (sub === 'set-team') { const r = updateUser(config.dbRoot, target, { team: argv[3] ?? '' }); process.stdout.write(`${r.username}：${r.changed.length ? '已修改' : '无变化'}\n`); return 0 }
    if (sub === 'set-password') {
      if (argv.length > 3) throw new UserError('口令不能通过命令行参数传入：从 stdin 读取')
      setUserPassword(config.dbRoot, target, await readPassword())
      process.stdout.write(`${target}：口令已重置，该用户的会话已全部失效\n`)
      return 0
    }
    if (sub === 'disable') { disableUser(config.dbRoot, target); process.stdout.write(`${target}：已停用并踢下线\n`); return 0 }
    if (sub === 'enable') { enableUser(config.dbRoot, target); process.stdout.write(`${target}：已启用\n`); return 0 }
    usage(); return 1
  }

  if (cmd === 'admin' && sub === 'set-password') {
    if (argv.length > 2) throw new AdminAuthError('口令不能通过命令行参数传入：请直接运行 `memory-hub admin set-password`（从 stdin 读取）')
    const pw = await readPassword()
    setAdminPassword(config.dbRoot, pw)
    log.info('管理员口令已设置', { db: config.dbRoot, note: '既有管理会话已全部失效' })
    process.stdout.write('管理员口令已设置；既有登录会话已全部失效。\n')
    return 0
  }

  usage(); return 1
}

main().then((code) => { if (code !== null) { closeAllDb(); process.exit(code) } }).catch((e) => {
  const known = e instanceof ConfigError || e instanceof TokenError || e instanceof AdminAuthError || e instanceof UserError
  bootLog.error(known ? e.message : '未预期的错误', known ? undefined : { error: String(e?.stack || e).slice(0, 800) })
  process.exit(1)
})
