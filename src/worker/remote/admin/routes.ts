/**
 * ============================================================================
 * 管理域路由（/api/admin/*）
 * ============================================================================
 * 入口第一步就是 requireAdmin：去 D1 重新校验会话 + 角色，无任何缓存。
 * 提供的接口只有三个（只有「普通用户管理」，没有管理员增删）：
 *   GET    /api/admin/users        分页列表
 *   POST   /api/admin/users        新建普通用户
 *   DELETE /api/admin/users/:id    删除普通用户（连带清理其会话）
 */
import { AuthError } from '../auth/types';
import { json } from '../shared/http';
import { requireAdmin } from './authorization';
import { createUser, getUsers, removeUser } from './service';

export async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  try {
    // 每个请求都鉴权（不依赖前端传来的角色），失败直接抛 401/403
    await requireAdmin(request, env);
    const url = new URL(request.url);
    if (url.pathname === '/api/admin/users') {
      // 列表：Cache-Control: no-store 避免用户数据被 CDN/浏览器缓存
      if (request.method === 'GET') return json(await getUsers(env, url), 200, { 'Cache-Control': 'no-store' });
      if (request.method === 'POST') {
        let body: unknown;
        try { body = await request.json(); } catch { throw new AuthError('INVALID_REQUEST', '请求格式无效'); }
        return json(await createUser(body, env), 201); // 201 Created
      }
      return json({ error: 'METHOD_NOT_ALLOWED', message: '请求方法不支持' }, 405);
    }
    // 删除：路径参数只允许 id 字符白名单，避免乱七八糟的注入尝试
    const match = /^\/api\/admin\/users\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
    if (match && request.method === 'DELETE') return json(await removeUser(match[1]!, env));
    return json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
  } catch (error) {
    // 与认证路由同一套错误归一化
    if (error instanceof AuthError) return json({ error: error.code, message: error.message }, error.status);
    if (error instanceof Error && /UNIQUE constraint failed: users.email/i.test(error.message)) return json({ error: 'EMAIL_TAKEN', message: '该邮箱已注册' }, 409);
    throw error;
  }
}
