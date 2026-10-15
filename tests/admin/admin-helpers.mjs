// M2 管理界面测试公共工具：带管理员口令的临时服务、cookie 客户端、合成数据集
import { withHub } from '../hub-helpers.mjs'
import { setAdminPassword } from '../../src/admin/auth.js'
import { writeCard, deleteCard } from '../../src/core/vault.js'
import { createToken, revokeToken } from '../../src/auth/tokens.js'
import { writeLog } from '../../src/core/writelog.js'
import { getDb } from '../../src/core/db.js'

export const PW = 'correct horse battery staple 42'
/** 测试用低成本 scrypt（生产默认成本见 auth.js；格式相同，参数写在哈希里）。 */
export const TEST_COST = { N: 1024, r: 8, p: 1 }

// 合成的假密钥（运行时拼接，避免仓库里出现完整的、会被扫描器当成真密钥的字面量）
export const FAKE_SK = 'sk-' + 'Zq9Xw3Lm7Rt2Vb8Nc4Hd6Jf1Ks5Gp0'
export const FAKE_PW_VALUE = 'Hunter2' + 'Hunter2xyz'
export const FAKE_KEY_BODY = 'MIIFAKE' + 'KEYBODYLINE1'
export const SECRET_NEEDLES = [FAKE_SK, FAKE_PW_VALUE, FAKE_KEY_BODY]

export const XSS_TITLE = '<img src=x onerror=alert(1)> 恶意标题'
export const XSS_BODY = '正文开头\n<script>window.__xss=1</script>\n<img src=x onerror="window.__xss=2">\n[点我](javascript:alert(3))\n**加粗** 与 `code`'

export async function withAdminHub(fn, { env = {}, password = PW, seed = true } = {}) {
  return withHub(async (h) => {
    if (password) setAdminPassword(h.home, password, { cost: TEST_COST })
    if (seed) await seedDataset(h.home)
    h.client = () => makeClient(h)
    return fn(h)
  }, { env })
}

/** 带 cookie 罐的客户端。 */
export function makeClient(h) {
  const jar = {}
  let csrf = null
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
  const absorb = (res) => {
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [pair] = sc.split(';')
      const i = pair.indexOf('=')
      const k = pair.slice(0, i).trim()
      const v = pair.slice(i + 1).trim()
      if (/max-age=0/i.test(sc) || v === '') delete jar[k]; else jar[k] = v
    }
  }
  const api = {
    jar,
    get csrf() { return csrf },
    async req(method, p, { body, headers = {}, withCsrf = false, raw = false } = {}) {
      const hdr = { ...headers }
      if (Object.keys(jar).length && !hdr.cookie) hdr.cookie = cookieHeader()
      if (body !== undefined && !hdr['content-type']) hdr['content-type'] = 'application/json'
      if (withCsrf && csrf) hdr['x-csrf-token'] = csrf
      const res = await fetch(h.url + p, { method, headers: hdr, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' })
      absorb(res)
      const text = await res.text()
      let json = null
      if (!raw) { try { json = JSON.parse(text) } catch { /* 非 JSON */ } }
      return { status: res.status, headers: res.headers, text, json }
    },
    get: (p, o) => api.req('GET', p, o),
    post: (p, body, o) => api.req('POST', p, { body, ...o }),
    async login(password = PW) {
      const r = await api.post('/admin/api/login', { password })
      if (r.status === 200) csrf = r.json.csrfToken
      return r
    },
  }
  return api
}

const iso = (d) => new Date(d).toISOString()
const sqlTs = (d) => iso(d).replace('T', ' ').slice(0, 19) // 旧表默认格式 YYYY-MM-DD HH:MM:SS

/** 合成数据集。返回关键 path，便于断言。 */
export async function seedDataset(home) {
  const db = getDb(home)
  const out = { approved: [], pending: [], rejected: [], deleted: [], paths: {} }
  const mk = async (o) => {
    const r = await writeCard(home, { status: 'approved', ...o }, { dedup: false })
    if (!r.ok) throw new Error('seed 失败：' + JSON.stringify(r))
    return r.path
  }
  const base = Date.parse('2026-09-01T08:00:00.000Z')
  const stamp = (path, i, table = 'cards', fmt = 'iso') => {
    const c = base + i * 86400000
    const u = c + 3600000 * (i % 5)
    const f = fmt === 'sql' ? sqlTs : iso
    db.prepare(`UPDATE ${table} SET created_at = ?, updated_at = ? WHERE path = ?`).run(f(c), f(u), path)
  }
  let i = 0
  for (let n = 0; n < 12; n++, i++) {
    const p = await mk({ kind: 'project', title: `项目决策 ${n}`, tags: ['alpha', 'shared', ...(n < 3 ? ['Node.js'] : [])], body: `项目 ${n} 的背景与结论。关键词 alpha-${n}。`, submittedBy: 'claude-code-a', source: 'claude-code' })
    stamp(p, i, 'cards', n % 2 ? 'sql' : 'iso'); out.approved.push(p)
  }
  for (let n = 0; n < 8; n++, i++) {
    const p = await mk({ kind: 'knowledge', title: `知识条目 ${n}`, tags: ['beta', 'shared', ...(n === 0 ? ['nodejs'] : []), ...(n === 1 ? ['node-js'] : [])], body: `知识 ${n}：数据库选型与索引设计。关键词 beta-${n}。`, submittedBy: 'codex-b', source: 'codex' })
    stamp(p, i); out.approved.push(p)
  }
  for (let n = 0; n < 3; n++, i++) {
    const p = await mk({ kind: 'mistake', title: `历史踩坑 ${n}`, tags: ['legacy'], body: `未署名历史卡 ${n}，来自旧自动沉淀。`, submittedBy: '', source: 'deepseek-harness' })
    stamp(p, i); out.approved.push(p); (out.paths.unsigned ||= []).push(p)
  }
  out.paths.secret = await mk({ kind: 'tool', title: '部署凭据备忘', tags: ['once-only'], body: `部署说明。\nOPENAI key: ${FAKE_SK}\npassword = "${FAKE_PW_VALUE}"\n-----BEGIN RSA PRIVATE KEY-----\n${FAKE_KEY_BODY}\n-----END RSA PRIVATE KEY-----\n结束。`, submittedBy: 'claude-code-a' })
  stamp(out.paths.secret, i++); out.approved.push(out.paths.secret)
  out.paths.xss = await mk({ kind: 'knowledge', title: XSS_TITLE, tags: ['<b>x</b>'], body: XSS_BODY, submittedBy: 'codex-b' })
  stamp(out.paths.xss, i++); out.approved.push(out.paths.xss)

  out.paths.noise = await mk({ kind: 'content', title: '[SCHEDULE REMINDER BATCH] 提醒', tags: ['raw'], body: '[SCHEDULE REMINDER BATCH] 定时提醒', submittedBy: 'claude-code-a' })
  stamp(out.paths.noise, i++); out.approved.push(out.paths.noise)

  for (let n = 0; n < 3; n++) {
    const r = await writeCard(home, { kind: 'knowledge', title: `待审卡 ${n}`, tags: ['pending-tag'], body: `待审正文 ${n} pendingbody`, status: 'pending', submittedBy: 'claude-code-a', source: 'claude-code' }, { dedup: false })
    stamp(r.path, 40 + n, 'quarantine'); out.pending.push(r.path)
  }
  for (let n = 0; n < 2; n++) {
    const r = await writeCard(home, { kind: 'knowledge', title: `驳回卡 ${n}`, tags: [], body: `驳回正文 ${n}`, status: 'rejected', submittedBy: 'codex-b', reason: '内容重复' }, { dedup: false })
    out.rejected.push(r.path)
  }
  for (let n = 0; n < 2; n++) {
    const p = await mk({ kind: 'content', title: `已删卡 ${n}`, tags: ['raw'], body: `回收站正文 ${n}`, submittedBy: 'codex-b' })
    await deleteCard(home, p)
    // 第 0 张删除于 10 天前，第 1 张于 29.5 天前
    const when = Date.now() - (n === 0 ? 10 : 29.5) * 86400000
    db.prepare('UPDATE quarantine SET deleted_at = ? WHERE path = ?').run(iso(when), p)
    out.deleted.push(p)
  }
  // 令牌：a(read,write) b(read) c(read,write 从未调用) d(已吊销)
  createToken(home, { name: 'claude-code-a', scopes: ['read', 'write'] })
  createToken(home, { name: 'codex-b', scopes: ['read'] })
  createToken(home, { name: 'idle-agent', scopes: ['read', 'write'], expiresAt: iso(Date.now() + 5 * 86400000) })
  createToken(home, { name: 'old-agent', scopes: ['read'] }); revokeToken(home, 'old-agent')
  // write_log（actor_type=agent）：a 有 recall+capture；b 只 recall（只读不写）；admin 行不应计入 agent 统计
  const ago = (d) => iso(Date.now() - d * 86400000)
  const wl = (e, ts) => { writeLog(home, e); db.prepare('UPDATE write_log SET ts = ? WHERE id = (SELECT MAX(id) FROM write_log)').run(ts) }
  wl({ actorType: 'agent', actorName: 'claude-code-a', tool: 'memory_recall', action: 'read', outcome: 'ok' }, ago(1))
  wl({ actorType: 'agent', actorName: 'claude-code-a', tool: 'memory_recall', action: 'read', outcome: 'ok' }, ago(2))
  wl({ actorType: 'agent', actorName: 'claude-code-a', tool: 'memory_capture', action: 'create', outcome: 'ok', cardPath: out.pending[0] }, ago(1))
  wl({ actorType: 'agent', actorName: 'claude-code-a', tool: 'memory_capture', action: 'append', outcome: 'dup' }, ago(3))
  wl({ actorType: 'agent', actorName: 'claude-code-a', tool: 'memory_capture', action: 'skip', outcome: 'denied' }, ago(20))
  wl({ actorType: 'agent', actorName: 'codex-b', tool: 'memory_recall', action: 'read', outcome: 'ok' }, ago(1))
  wl({ actorType: 'agent', actorName: 'codex-b', tool: 'memory_recall', action: 'read', outcome: 'ok' }, ago(4))
  wl({ actorType: 'agent', actorName: 'codex-b', tool: 'memory_capture', action: 'create', outcome: 'ok' }, ago(40)) // 窗口外：7 天内零 capture
  wl({ actorType: 'admin', actorName: 'admin', tool: '', action: 'login', outcome: 'ok' }, ago(0))
  return out
}
