// memory-hub · 管理 API 的统一错误：status + 机器可读 code + 中文 message（+ 附加字段，如 count / max / currentUpdatedAt）。
export class HttpError extends Error {
  constructor(status, code, message, headers, extra) { super(message); this.status = status; this.code = code; this.headers = headers; this.extra = extra }
}
