/**
 * ============================================================================
 * 探索页与会话治理云同步路由（/api/explore/*）
 * ============================================================================
 */
import { AuthError } from '../auth/types';
import { json } from '../shared/http';
import { requireUser } from '../shared/authGuard';
import { getExploreSyncSnapshot, putExploreSyncSnapshot } from './service';

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
    return body as Record<string, unknown>;
  } catch {
    throw new AuthError('INVALID_REQUEST', '请求格式无效');
  }
}

export async function handleExploreRequest(request: Request, env: Env): Promise<Response> {
  try {
    const session = await requireUser(request, env);
    const url = new URL(request.url);
    if (url.pathname === '/api/explore/sync') {
      if (request.method === 'GET') {
        return json(await getExploreSyncSnapshot(env, session.user_id), 200, {
          'Cache-Control': 'no-store',
        });
      }
      if (request.method === 'PUT') {
        const result = await putExploreSyncSnapshot(env, session.user_id, await bodyOf(request));
        return json(result.payload, result.status, { 'Cache-Control': 'no-store' });
      }
    }
    return json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ error: error.code, message: error.message }, error.status);
    }
    throw error;
  }
}
