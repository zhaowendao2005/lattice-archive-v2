import { json } from '../shared/http';
import { AuthError, type AuthBody } from './types';
import { authenticate, connectSession, logout, register } from './service';

async function bodyOf(request: Request): Promise<AuthBody> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
    return body as AuthBody;
  } catch { throw new AuthError('INVALID_REQUEST', '请求格式无效'); }
}

export async function handleAuthRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED', message: '请求方法不支持' }, 405);
  const path = new URL(request.url).pathname;
  try {
    let result: unknown;
    if (path === '/api/auth/register') result = await register(request, env, await bodyOf(request));
    else if (path === '/api/auth/login') result = await authenticate(request, env, 'login', 'user', await bodyOf(request), ctx);
    else if (path === '/api/auth/admin/login') result = await authenticate(request, env, 'admin_login', 'admin', await bodyOf(request), ctx);
    else if (path === '/api/auth/session/connect') result = await connectSession(request, env);
    else if (path === '/api/auth/logout') result = await logout(request, env);
    else return json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
    return json(result);
  } catch (error) {
    if (error instanceof AuthError) return json({ error: error.code, message: error.message }, error.status);
    if (error instanceof Error && /UNIQUE constraint failed: users.email/i.test(error.message)) return json({ error: 'EMAIL_TAKEN', message: '该邮箱已注册' }, 409);
    throw error;
  }
}
