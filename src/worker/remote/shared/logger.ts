/**
 * 结构化日志：每行一条 JSON，方便 Cloudflare 控制台 / Logpush 检索。
 * 铁律：绝不把密码、Token、盐、密钥写进日志——只记事件名与低敏感元信息。
 */

/** 正常事件（如 request.complete） */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

/** 异常事件：把 Error 压成 message 字符串，避免打印堆栈里的敏感上下文 */
export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), event, error: error instanceof Error ? error.message : 'unknown', ...fields }));
}
