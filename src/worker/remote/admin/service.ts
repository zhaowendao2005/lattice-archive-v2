import { hashPassword } from '../auth/crypto';
import { AuthError, type UserProfile } from '../auth/types';
import { createManagedUser, deleteManagedUser, findUserById, listUsers } from './repository';

function text(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new AuthError('INVALID_REQUEST', `${label}格式无效`);
  return value.trim();
}
function credentials(body: Record<string, unknown>) {
  const name = text(body.name, '用户名', 80);
  const email = text(body.email, '邮箱', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('INVALID_EMAIL', '请输入有效的邮箱地址');
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) throw new AuthError('INVALID_PASSWORD', '密码长度需为 8 至 256 位');
  return { name, email, password: body.password };
}
function bodyRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError('INVALID_REQUEST', '请求格式无效');
  return body as Record<string, unknown>;
}
function pageNumber(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(1, Math.floor(parsed))) : fallback;
}
export async function getUsers(env: Env, url: URL) {
  const page = pageNumber(url.searchParams.get('page'), 1, 1_000_000);
  const pageSize = pageNumber(url.searchParams.get('pageSize'), 20, 100);
  const search = (url.searchParams.get('search') ?? '').trim().slice(0, 100);
  const sortValue = url.searchParams.get('sort');
  const sort = sortValue === 'name' || sortValue === 'email' ? sortValue : 'created_at';
  const direction = url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc';
  const result = await listUsers(env.AUTH_DB, search, pageSize, (page - 1) * pageSize, sort, direction);
  return { users: result.rows, pagination: { page, pageSize, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) } };
}
export async function createUser(body: unknown, env: Env) {
  const input = credentials(bodyRecord(body));
  const now = Date.now();
  const user: UserProfile = { id: crypto.randomUUID(), name: input.name, email: input.email, initials: Array.from(input.name).slice(0, 2).join('').toUpperCase(), role: 'user' };
  await createManagedUser(env.AUTH_DB, user, await hashPassword(input.password), now);
  return { user };
}
export async function removeUser(id: string, env: Env) {
  const target = await findUserById(env.AUTH_DB, id);
  if (!target) throw new AuthError('USER_NOT_FOUND', '用户不存在', 404);
  if (target.role !== 'user') throw new AuthError('FORBIDDEN', '管理员账户不可删除', 403);
  const result = await deleteManagedUser(env.AUTH_DB, id);
  if (!result.meta.changes) throw new AuthError('USER_NOT_FOUND', '用户不存在', 404);
  return { deleted: true, userId: id };
}
