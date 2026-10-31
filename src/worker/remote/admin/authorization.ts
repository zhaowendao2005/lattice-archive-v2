/**
 * 管理员鉴权守卫。
 *
 * 与 requireUser 的区别只在最后一步：额外要求 session.role === 'admin'。
 * 注意：角色取自 D1 实时查询结果，而不是客户端声称的身份；
 * 并且同时比对「签发时的角色」与「当前角色」，任一处不匹配即失效。
 */
import { hashSessionToken } from '../auth/crypto';
import { findSession } from '../auth/repository';
import { AuthError } from '../auth/types';

/** Every protected request checks D1, not a cached client-side role. */
export async function requireAdmin(request: Request, env: Env) {
  const header = request.headers.get('Authorization');
  // 快速拒绝：无 Bearer / 空 Token / 超长垃圾串
  if (!header?.startsWith('Bearer ') || header.length <= 7 || header.length > 512) {
    throw new AuthError('UNAUTHORIZED', '会话无效，请重新登录', 401);
  }
  const session = await findSession(env.AUTH_DB, await hashSessionToken(header.slice(7)));
  // 存在 + 未过期 + 会话角色与用户当前角色一致
  if (!session || session.expires_at <= Date.now() || session.session_role !== session.role) {
    throw new AuthError('UNAUTHORIZED', '会话已失效，请重新登录', 401);
  }
  // 最后一道关：必须是管理员（401 = 未登录，403 = 登录了但权限不够）
  if (session.role !== 'admin') throw new AuthError('FORBIDDEN', '仅管理员可以执行此操作', 403);
  return session;
}
