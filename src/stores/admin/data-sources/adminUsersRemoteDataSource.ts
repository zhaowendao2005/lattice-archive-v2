import type { UsersResult, ManagedUser, UserSort } from '../types';
import { RemoteAuthError } from '@/stores/auth/data-sources/authRemoteDataSource';

const baseUrl = ((import.meta.env.VITE_REMOTE_WORKER_URL as string | undefined) ?? '').replace(/\/$/, '');
async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`${baseUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } }); }
  catch { throw new RemoteAuthError('无法连接服务器，请检查网络后重试'); }
  const data = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) throw new RemoteAuthError(data.message || '管理操作失败，请重试', data.error, response.status);
  return data as T;
}
export const adminUsersRemoteDataSource = {
  list(token: string, page: number, pageSize: number, search: string, sort: UserSort, direction: 'asc' | 'desc') {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), search, sort, direction });
    return request<UsersResult>(`/api/admin/users?${params}`, token);
  },
  create(token: string, data: { name: string; email: string; password: string }) { return request<{ user: ManagedUser }>('/api/admin/users', token, { method: 'POST', body: JSON.stringify(data) }); },
  remove(token: string, id: string) { return request<{ deleted: true; userId: string }>(`/api/admin/users/${encodeURIComponent(id)}`, token, { method: 'DELETE' }); },
};
