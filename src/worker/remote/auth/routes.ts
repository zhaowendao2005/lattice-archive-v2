/**
 * ============================================================================
 * 认证路由层（只做「路径分发 + 错误转 JSON」）
 * ============================================================================
 * 分发规则：只接受 POST；路径固定五个：
 *   /api/auth/register       注册
 *   /api/auth/login          普通用户登录
 *   /api/auth/admin/login    管理员登录
 *   /api/auth/session/connect 冷启动会话校准
 *   /api/auth/logout          退出登录
 * 业务细节全部在 service.ts，本文件不写任何业务判断。
 */
import { json } from '../shared/http';
import { AuthError, type AuthBody } from './types';
import { authenticate, connectSession, logout, register } from './service';

/** 安全地解析 JSON 请求体：非对象/数组/非法 JSON 一律转成 400 */
async function bodyOf(request: Request): Promise<AuthBody> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
    return body as AuthBody;
  } catch { throw new AuthError('INVALID_REQUEST', '请求格式无效'); }
}

export async function handleAuthRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // 认证接口一律 POST：避免 Token / 密码进入 URL、浏览器历史与访问日志
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED', message: '请求方法不支持' }, 405);
  const path = new URL(request.url).pathname;
  try {
    let result: unknown;
    // 意图：路径 → service 函数。注意登录时传入的 action / role 是两个独立参数：
    // action 给 Turnstile 比对，role 决定查哪一类账户
    if (path === '/api/auth/register') result = await register(request, env, await bodyOf(request));
    else if (path === '/api/auth/login') result = await authenticate(request, env, 'login', 'user', await bodyOf(request), ctx);
    else if (path === '/api/auth/admin/login') result = await authenticate(request, env, 'admin_login', 'admin', await bodyOf(request), ctx);
    else if (path === '/api/auth/session/connect') result = await connectSession(request, env, ctx);
    else if (path === '/api/auth/logout') result = await logout(request, env);
    else return json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
    return json(result);
  } catch (error) {
    // 业务错误 → 带机器码 + 中文文案的 JSON；其余往上抛给入口统一兜底 500
    if (error instanceof AuthError) return json({ error: error.code, message: error.message }, error.status);
    // 并发注册时两个请求可能都通过了查重，最后靠数据库唯一索引兜底
    if (error instanceof Error && /UNIQUE constraint failed: users.email/i.test(error.message)) return json({ error: 'EMAIL_TAKEN', message: '该邮箱已注册' }, 409);
    throw error;
  }
}
