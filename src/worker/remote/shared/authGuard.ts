/**
 * 普通登录用户的凭证守卫（非管理员域使用）。
 *
 * 做法：把 Authorization 里的 Token 做 SHA-256 拿摘要，再回 D1 查会话行——
 * 数据库里只存摘要，所以即使库被读走也拿不到可用的 Token。
 * 还会校验 session.session_role === session.role，防止角色被中途篡改。
 */
import { hashSessionToken } from '../auth/crypto';
import { findSession } from '../auth/repository';
import { AuthError } from '../auth/types';

/** Shared user guard for ordinary authenticated API domains. */
export async function requireUser(request: Request, env: Env) {
  const header = request.headers.get('Authorization');
  // 三层快速拒绝：头不存在 / 不是 Bearer / 长度异常（空 Token 或超长垃圾）
  if (!header?.startsWith('Bearer ') || header.length <= 7 || header.length > 512) {
    throw new AuthError('UNAUTHORIZED', '会话无效，请重新登录', 401);
  }
  const session = await findSession(env.AUTH_DB, await hashSessionToken(header.slice(7)));
  // 三重校验：会话存在 + 未过期 + 会话中记录的角色与用户当前角色一致
  if (!session || session.expires_at <= Date.now() || session.session_role !== session.role) {
    throw new AuthError('UNAUTHORIZED', '会话已失效，请重新登录', 401);
  }
  return session;
}
