import { AuthError } from '../auth/types';
import { json } from '../shared/http';
import { requireUser } from '../shared/authGuard';
import { bindAccount, getAccounts, getCredentials, removeAccount, removeAuthorization, removeCredentials, saveCredentials, updateAuthorization } from './service';

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
    return body as Record<string, unknown>;
  } catch { throw new AuthError('INVALID_REQUEST', '请求格式无效'); }
}

export async function handleTelegramRequest(request: Request, env: Env): Promise<Response> {
  try {
    const session = await requireUser(request, env);
    const url = new URL(request.url);
    if (url.pathname === '/api/tg/credentials') {
      if (request.method === 'GET') return json(await getCredentials(env, session.user_id), 200, { 'Cache-Control': 'no-store' });
      if (request.method === 'PUT') return json(await saveCredentials(env, session.user_id, await bodyOf(request)));
      if (request.method === 'DELETE') return json(await removeCredentials(env, session.user_id, url.searchParams.get('cascade') === '1'));
    }
    if (url.pathname === '/api/tg/accounts') {
      if (request.method === 'GET') return json(await getAccounts(env, session.user_id), 200, { 'Cache-Control': 'no-store' });
      if (request.method === 'POST') return json(await bindAccount(env, session.user_id, await bodyOf(request)), 201);
    }
    const accountMatch = /^\/api\/tg\/accounts\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
    if (accountMatch && request.method === 'DELETE') return json(await removeAccount(env, session.user_id, accountMatch[1]!));
    if (url.pathname === '/api/tg/authorizations' && request.method === 'POST') return json(await bindAccount(env, session.user_id, await bodyOf(request)), 201);
    const authMatch = /^\/api\/tg\/authorizations\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
    if (authMatch) {
      if (request.method === 'PATCH') return json(await updateAuthorization(env, session.user_id, authMatch[1]!, await bodyOf(request)));
      if (request.method === 'DELETE') return json(await removeAuthorization(env, session.user_id, authMatch[1]!));
    }
    return json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
  } catch (error) {
    if (error instanceof AuthError) return json({ error: error.code, message: error.message }, error.status);
    throw error;
  }
}
