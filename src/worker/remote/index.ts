import { json, allowedOrigins } from './shared/http';
import { log, logError } from './shared/logger';
import { handleAuthRequest } from './auth/routes';
import { handleAdminRequest } from './admin/routes';
import { handleTelegramRequest } from './telegram/routes';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = new Headers({
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Vary': 'Origin',
    });
    if (origin && allowedOrigins(env).has(origin)) cors.set('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    try {
      const response = url.pathname.startsWith('/api/auth/')
        ? await handleAuthRequest(request, env, ctx)
        : url.pathname.startsWith('/api/admin/')
          ? await handleAdminRequest(request, env)
          : url.pathname.startsWith('/api/tg/')
            ? await handleTelegramRequest(request, env)
            : json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
      const headers = new Headers(response.headers);
      cors.forEach((value, key) => headers.set(key, value));
      log('request.complete', { method: request.method, path: url.pathname, status: response.status });
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      logError('request.failed', error, { path: url.pathname });
      const response = json({ error: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' }, 500);
      cors.forEach((value, key) => response.headers.set(key, value));
      return response;
    }
  },
};
