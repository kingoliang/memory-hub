// M3 写接口测试公共工具
import assert from 'node:assert/strict'
import { withAdminHub } from '../admin/admin-helpers.mjs'
export { PW, FAKE_SK, XSS_TITLE } from '../admin/admin-helpers.mjs'

/** 登录并返回带写方法的客户端：w.patch/post/del 自动带 CSRF。 */
export async function loggedIn(h) {
  const c = h.client()
  const r = await c.login()
  assert.equal(r.status, 200)
  c.patch = (p, body, o) => c.req('PATCH', p, { body, withCsrf: true, ...o })
  c.wpost = (p, body, o) => c.req('POST', p, { body, withCsrf: true, ...o })
  c.del = (p, o) => c.req('DELETE', p, { withCsrf: true, ...o })
  return c
}
export const detail = async (c, p) => (await c.get('/admin/api/card?path=' + encodeURIComponent(p))).json
export const withHubW = withAdminHub
export const rowOf = (h, p) => h.db().prepare('SELECT * FROM cards WHERE path = ?').get(p) || h.db().prepare('SELECT * FROM quarantine WHERE path = ?').get(p)
export const countAll = (h) => ({ cards: h.db().prepare('SELECT COUNT(*) n FROM cards').get().n, quarantine: h.db().prepare('SELECT COUNT(*) n FROM quarantine').get().n })
export const lastLog = (h, action) => h.db().prepare('SELECT * FROM write_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action)
