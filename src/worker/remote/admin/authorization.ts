import { hashSessionToken } from '../auth/crypto';
import { findSession } from '../auth/repository';
import { AuthError } from '../auth/types';

/** Every protected request checks D1, not a cached client-side role. */
export async function requireAdmin(request: Request, env: Env) {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ') || header.length <= 7 || header.length > 512) {
    throw new AuthError('UNAUTHORIZED', '会话无效，请重新登录', 401);
  }
  const session = await findSession(env.AUTH_DB, await hashSessionToken(header.slice(7)));
  if (!session || session.expires_at <= Date.now() || session.session_role !== session.role) {
    throw new AuthError('UNAUTHORIZED', '会话已失效，请重新登录', 401);
  }
  if (session.role !== 'admin') throw new AuthError('FORBIDDEN', '仅管理员可以执行此操作', 403);
  return session;
}
