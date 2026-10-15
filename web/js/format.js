// 展示用格式化：时间、体积、中文标签。

export const KIND_LABEL = { project: '项目', knowledge: '知识', content: '内容', prompt: '提示词', business: '业务', tool: '工具', mistake: '踩坑' }
export const STATUS_LABEL = { approved: '已批准', pending: '待审', rejected: '已驳回', deleted: '回收站' }
export const OUTCOME_LABEL = { ok: '成功', dup: '重复', denied: '拒绝', error: '错误' }
export const SECRET_TYPE_LABEL = {
  'private-key': '私钥', 'aws-access-key': 'AWS 密钥', 'github-token': 'GitHub 令牌', 'slack-token': 'Slack 令牌', 'openai-style-key': 'API Key（sk-）',
  'google-api-key': 'Google API Key', jwt: 'JWT', 'url-embedded-credentials': 'URL 内嵌口令', 'bearer-token': 'Bearer 令牌', 'credential-assignment': '口令/密钥赋值',
}

export const kindLabel = (k) => KIND_LABEL[k] || k || '—'
export const statusLabel = (s) => STATUS_LABEL[s] || s || '—'

const pad = (n) => String(n).padStart(2, '0')

export function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDay(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function relTime(iso, now = Date.now()) {
  if (!iso) return '从未'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return String(iso)
  const sec = Math.round((now - t) / 1000)
  if (sec < 0) return fmtDate(iso)
  if (sec < 60) return '刚刚'
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)} 天前`
  if (sec < 86400 * 365) return `${Math.floor(sec / 86400 / 30)} 个月前`
  return `${Math.floor(sec / 86400 / 365)} 年前`
}

export function fmtBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`
  return `${(v / 1024 ** 3).toFixed(2)} GB`
}

export const fmtNum = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('zh-CN') : '—')
export const fmtPct = (x) => `${Math.round(x * 100)}%`
export const secretLabel = (t) => SECRET_TYPE_LABEL[t] || t
