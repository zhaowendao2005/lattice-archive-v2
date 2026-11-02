/**
 * ============================================================================
 * Cloudflare Worker 入口：前端静态资源 + API 路由分发
 * ============================================================================
 * 一个 Worker 同时干两件事：
 *   1. /api/* 开头的请求 → 交给对应业务路由（auth / admin / tg）；
 *   2. 其他请求 → 交给 Wrangler 配置的静态资源绑定（dist/ 下的 SPA）。
 *
 * 路由速查：
 *   /api/auth/*   登录、注册、会话校准、退出
 *   /api/admin/*  管理员鉴权 + 用户增删查（每次请求都回 D1 验证角色）
 *   /api/tg/*     Telegram 绑定账号的凭据托管
 */
import { json, allowedOrigins } from './shared/http';
import { log, logError } from './shared/logger';
import { handleAuthRequest } from './auth/routes';
import { handleAdminRequest } from './admin/routes';
import { handleTelegramRequest } from './telegram/routes';
import { handleExploreRequest } from './explore/routes';
import { handleDebugRequest } from './debug/routes';

export default {
  /** Worker 的唯一入口（Modules 格式） */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startMs = Date.now();
    const origin = request.headers.get('Origin');
    // CORS 头：只在 Origin 命中白名单时才回写 Allow-Origin，避免任意站点携带凭证调用
    const cors = new Headers({
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Lattice-Debug, X-Lattice-Trace-Id',
      'Access-Control-Expose-Headers': 'X-Lattice-Debug-Trace',
      'Vary': 'Origin', // 告诉缓存：同一 URL 不同 Origin 必须有不同缓存键
    });
    if (origin && allowedOrigins(env).has(origin)) cors.set('Access-Control-Allow-Origin', origin);
    // 预检请求直接 204 返回，不进业务逻辑
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const isDebugPiggyback = request.headers.get('X-Lattice-Debug') === '1';
    const traceId = request.headers.get('X-Lattice-Trace-Id') || startMs.toString(16).slice(-6);
    try {
      // 路由分发；都不匹配则 404。注意这里用 startsWith，子路径由各路由内部再解析
      const response = url.pathname.startsWith('/api/auth/')
        ? await handleAuthRequest(request, env, ctx)
        : url.pathname.startsWith('/api/admin/')
          ? await handleAdminRequest(request, env)
          : url.pathname.startsWith('/api/tg/')
            ? await handleTelegramRequest(request, env)
            : url.pathname.startsWith('/api/explore/')
              ? await handleExploreRequest(request, env)
              : url.pathname.startsWith('/api/debug/')
                ? await handleDebugRequest(request, env)
                : json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
      // 把 CORS 头合并到业务响应上（业务层不关心 CORS）
      const headers = new Headers(response.headers);
      cors.forEach((value, key) => headers.set(key, value));
      const durMs = Math.max(1, Date.now() - startMs);
      if (isDebugPiggyback) {
        const domainSeg = url.pathname.split('/')[2] || 'api';
        const traceHeader = JSON.stringify({
          traceId,
          spanId: '01.01',
          parentSpanId: '01',
          source: 'remote',
          domain: `${domainSeg}.worker`,
          action: `${request.method} ${url.pathname}`,
          level: response.status >= 500 ? 'ERROR' : response.status >= 400 ? 'WARN' : 'INFO',
          timestamp: startMs,
          relMs: 0,
          durMs,
          tags: { status: response.status, path: url.pathname, method: request.method },
        });
        headers.set('X-Lattice-Debug-Trace', encodeURIComponent(traceHeader));
      } else {
        log('request.complete', { method: request.method, path: url.pathname, status: response.status });
      }
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      // 任何未捕获异常都在此兜底：记录结构化日志，对外只给模糊文案，避免泄露内部细节
      logError('request.failed', error, { path: url.pathname });
      const response = json({ error: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' }, 500);
      cors.forEach((value, key) => response.headers.set(key, value));
      return response;
    }
  },
};
