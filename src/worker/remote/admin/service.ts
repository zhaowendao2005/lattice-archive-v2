/**
 * ============================================================================
 * 管理端业务层：用户增删查
 * ============================================================================
 * 约束（不可突破）：
 *   · 只能创建 / 删除 role = 'user' 的普通用户；
 *   · 管理员账户由 ADMIN_* 环境变量在部署时 upsert，不能在这里操作；
 *   · 返回体只包含公开字段，绝不带 password_hash / salt；
 *   · 删除用户必须同时清理其 sessions（在 repository 里用 batch 完成）。
 */
import { hashPassword } from '../auth/crypto';
import { AuthError, type UserProfile } from '../auth/types';
import { createManagedUser, deleteManagedUser, findUserById, listUsers } from './repository';

/** 通用文本字段校验：必须是非空字符串且不超长，返回 trim 后的值 */
function text(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new AuthError('INVALID_REQUEST', `${label}格式无效`);
  return value.trim();
}

/** 表单三件套校验：用户名 / 邮箱 / 密码（与注册接口保持同一套规则） */
function credentials(body: Record<string, unknown>) {
  const name = text(body.name, '用户名', 80);
  const email = text(body.email, '邮箱', 254).toLowerCase(); // 统一小写，避免大小写重复注册
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('INVALID_EMAIL', '请输入有效的邮箱地址');
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) throw new AuthError('INVALID_PASSWORD', '密码长度需为 8 至 256 位');
  return { name, email, password: body.password };
}

/** 确保请求体是一个普通对象（非 null / 非数组） */
function bodyRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError('INVALID_REQUEST', '请求格式无效');
  return body as Record<string, unknown>;
}

/**
 * 页码/页大小归一化：非法值 → 回退默认值；超大值 → 截断到上限。
 * 这样前端传 pageSize=999999 也不会把 D1 拖死。
 */
function pageNumber(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(1, Math.floor(parsed))) : fallback;
}

/** 列表查询：解析并约束所有查询参数后交给 repository */
export async function getUsers(env: Env, url: URL) {
  const page = pageNumber(url.searchParams.get('page'), 1, 1_000_000);
  const pageSize = pageNumber(url.searchParams.get('pageSize'), 20, 100); // 单页最多 100 条
  // 搜索词截断到 100 字符，避免超长 LIKE 拖慢查询
  const search = (url.searchParams.get('search') ?? '').trim().slice(0, 100);
  const sortValue = url.searchParams.get('sort');
  // 排序字段必须命中白名单，否则回退 created_at（防御 ORDER BY 注入）
  const sort = sortValue === 'name' || sortValue === 'email' ? sortValue : 'created_at';
  const direction = url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc';
  const result = await listUsers(env.AUTH_DB, search, pageSize, (page - 1) * pageSize, sort, direction);
  return { users: result.rows, pagination: { page, pageSize, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) } };
}

/** 新建普通用户（服务端算哈希；明文口令只在这一次请求里存在，不落库不进日志） */
export async function createUser(body: unknown, env: Env) {
  const input = credentials(bodyRecord(body));
  const now = Date.now();
  // 强制 role: 'user' —— 管理接口不可能造出管理员
  const user: UserProfile = { id: crypto.randomUUID(), name: input.name, email: input.email, initials: Array.from(input.name).slice(0, 2).join('').toUpperCase(), role: 'user' };
  await createManagedUser(env.AUTH_DB, user, await hashPassword(input.password), now);
  return { user };
}

/** 删除普通用户：先查存在性与角色，再由 repository 事务式清理会话 + 删用户 */
export async function removeUser(id: string, env: Env) {
  const target = await findUserById(env.AUTH_DB, id);
  if (!target) throw new AuthError('USER_NOT_FOUND', '用户不存在', 404);
  if (target.role !== 'user') throw new AuthError('FORBIDDEN', '管理员账户不可删除', 403);
  const result = await deleteManagedUser(env.AUTH_DB, id);
  // meta.changes === 0 说明用户在这期间已不存在（并发删除），仍按 404 处理
  if (!result.meta.changes) throw new AuthError('USER_NOT_FOUND', '用户不存在', 404);
  return { deleted: true, userId: id };
}
