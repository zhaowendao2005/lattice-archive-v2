export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

export function clientIp(request: Request): string | undefined {
  return request.headers.get('CF-Connecting-IP') ?? undefined;
}

export function allowedOrigins(env: Env): Set<string> {
  return new Set(env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean));
}
