/**
 * HTTP 响应 / 请求元信息的小工具集。
 * 所有接口都返回「JSON + 明确状态码」，错误体形如 { error: 机器码, message: 中文提示 }。
 */

/** 统一 JSON 响应：默认 200，可附加自定义响应头 */
export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

/** 取客户端 IP（Cloudflare 注入的 CF-Connecting-IP）；本地开发时可能不存在 */
export function clientIp(request: Request): string | undefined {
  return request.headers.get('CF-Connecting-IP') ?? undefined;
}

/** 把逗号分隔的 ALLOWED_ORIGINS 解析成集合，用于 CORS 白名单比对 */
export function allowedOrigins(env: Env): Set<string> {
  return new Set(env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean));
}
