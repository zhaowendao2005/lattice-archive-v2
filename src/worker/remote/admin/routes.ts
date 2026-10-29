import { AuthError } from '../auth/types';
import { json } from '../shared/http';
import { requireAdmin } from './authorization';
import { createUser, getUsers, removeUser } from './service';

export async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  try {
    await requireAdmin(request, env);
    const url = new URL(request.url);
    if (url.pathname === '/api/admin/users') {
      if (request.method === 'GET') return json(await getUsers(env, url), 200, { 'Cache-Control': 'no-store' });
      if (request.method === 'POST') {
        let body: unknown;
        try { body = await request.json(); } catch { throw new AuthError('INVALID_REQUEST', '请求格式无效'); }
        return json(await createUser(body, env), 201);
      }
      return json({ error: 'METHOD_NOT_ALLOWED', message: '请求方法不支持' }, 405);
    }
    const match = /^\/api\/admin\/users\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
    if (match && request.method === 'DELETE') return json(await removeUser(match[1]!, env));
    return json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
  } catch (error) {
    if (error instanceof AuthError) return json({ error: error.code, message: error.message }, error.status);
    if (error instanceof Error && /UNIQUE constraint failed: users.email/i.test(error.message)) return json({ error: 'EMAIL_TAKEN', message: '该邮箱已注册' }, 409);
    throw error;
  }
}
