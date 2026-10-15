// 管理 API 封装。URL 相对当前页面解析（页面在 {base}/admin/ 下，所以自动适配 MEMORY_HUB_BASE_PATH 前缀）。

export class ApiError extends Error {
  constructor(status, code, message, extra) { super(message || code || `HTTP ${status}`); this.status = status; this.code = code; this.extra = extra || {} }
}

let csrfToken = null
let onUnauthorized = () => {}
export const setCsrf = (t) => { csrfToken = t }
export const setOnUnauthorized = (fn) => { onUnauthorized = fn }

function urlFor(path, params) {
  const u = new URL('./api/' + path, globalThis.location.href)
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue
    u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  return u
}

async function request(method, path, { params, body } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken
  let res
  try {
    res = await fetch(urlFor(path, params), { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (e) {
    throw new ApiError(0, 'network', '无法连接服务器，请检查网络或服务是否在运行')
  }
  let data = null
  try { data = await res.json() } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error, data?.message, data)
    if (res.status === 401 && path !== 'login' && path !== 'session') onUnauthorized(err)
    throw err
  }
  return data
}

export const get = (path, params) => request('GET', path, { params })
export const post = (path, body) => request('POST', path, { body: body ?? {} })
