// 对 hub POST /api/ingest 的一次调用，只负责 HTTP 与结果分类；不含水位逻辑。
// 令牌只出现在 Authorization 头里，绝不进入返回值 / 错误信息。

/**
 * @returns {Promise<
 *   {kind:'ok', body:object} |            // HTTP 200 且 body 是 JSON 对象
 *   {kind:'http', code:number, body:object|null, retryAfterS?:number} |   // 非 200
 *   {kind:'net', reason:string}           // 超时 / 连接失败 / 响应非 JSON
 * >}
 */
export async function postIngest({ url, token, payload, timeoutMs, signal, fetchImpl = globalThis.fetch }) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      redirect: 'error', // 不跟随重定向，避免令牌被带到别处
      signal: AbortSignal.any(signals),
    })
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || (e?.name === 'AbortError' && signals[0].aborted)
    return { kind: 'net', reason: timedOut ? `请求超时（${timeoutMs}ms）` : `网络错误：${shortErr(e)}` }
  }
  let body = null
  try { body = await res.json() } catch { /* 非 JSON */ }
  if (res.status === 200) {
    return body && typeof body === 'object' && !Array.isArray(body) ? { kind: 'ok', body } : { kind: 'net', reason: '响应不是 JSON 对象' }
  }
  const ra = Number(res.headers.get('retry-after'))
  return { kind: 'http', code: res.status, body, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterS: ra } : {}) }
}

function shortErr(e) {
  // fetch 失败的 message 常是 "fetch failed"，真实原因在 cause 里；只取 code/message，不带请求头
  const c = e?.cause
  return String(c?.code || c?.message || e?.message || e).slice(0, 120)
}
