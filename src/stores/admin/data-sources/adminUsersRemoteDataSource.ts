/**
 * ============================================================================
 * 管理端用户接口的数据源（/api/admin/users）
 * ============================================================================
 * 与 authRemoteDataSource 的区别：这里每个请求都必须带管理员 Token，
 * 服务端会在每次请求时回 D1 重新校验「会话有效 + 角色为 admin」（无缓存）。
 * 错误同样归一到 RemoteAuthError，方便 Store 统一处理 401。
 */
import type { UsersResult, ManagedUser, UserSort } from '../types';
import { RemoteAuthError } from '@/stores/auth/data-sources/authRemoteDataSource';

const baseUrl = ((import.meta.env.VITE_REMOTE_WORKER_URL as string | undefined) ?? '').replace(/\/$/, '');

/** GET/POST/DELETE 统一入口：自动拼 Authorization，非 2xx 抛 RemoteAuthError */
async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`${baseUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } }); }
  catch { throw new RemoteAuthError('无法连接服务器，请检查网络后重试'); }
  const data = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) throw new RemoteAuthError(data.message || '管理操作失败，请重试', data.error, response.status);
  return data as T;
}
export const adminUsersRemoteDataSource = {
  /** 分页 + 关键字 + 排序的列表查询（参数全部走 query string，便于调试） */
  list(token: string, page: number, pageSize: number, search: string, sort: UserSort, direction: 'asc' | 'desc') {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), search, sort, direction });
    return request<UsersResult>(`/api/admin/users?${params}`, token);
  },
  /** 新建普通用户（密码由服务端 PBKDF2 加密后入库，响应不回传哈希） */
  create(token: string, data: { name: string; email: string; password: string }) { return request<{ user: ManagedUser }>('/api/admin/users', token, { method: 'POST', body: JSON.stringify(data) }); },
  /** 删除普通用户：服务端会同时清理该用户的全部远端会话 */
  remove(token: string, id: string) { return request<{ deleted: true; userId: string }>(`/api/admin/users/${encodeURIComponent(id)}`, token, { method: 'DELETE' }); },
};
