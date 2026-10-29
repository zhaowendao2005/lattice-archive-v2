import type { UserProfile } from '../stores/authStore';

interface AuthResponse { user: UserProfile; session: { token: string; expiresAt: number; serverConnected: true } }
interface ConnectResponse { connected: true; serverTime: number; sessionExpiresAt: number; user: UserProfile }
export class RemoteAuthError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = 'NETWORK_ERROR', status = 0) { super(message); this.code = code; this.status = status; }
}
const baseUrl = ((import.meta.env.VITE_REMOTE_WORKER_URL as string | undefined) ?? '').replace(/\/$/, '');

async function request<T>(path: string, payload?: unknown, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch { throw new RemoteAuthError('无法连接认证服务器，请检查网络后重试'); }
  const data = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) throw new RemoteAuthError(data.message || '认证请求失败，请重试', data.error, response.status);
  return data as T;
}

export const authRemoteDataSource = {
  register: (data: { name: string; email: string; password: string; turnstileToken: string; keepSignedIn: boolean }) => request<AuthResponse>('/api/auth/register', data),
  login: (data: { email: string; password: string; turnstileToken: string; keepSignedIn: boolean }) => request<AuthResponse>('/api/auth/login', data),
  adminLogin: (data: { email: string; password: string; turnstileToken: string; keepSignedIn: boolean }) => request<AuthResponse>('/api/auth/admin/login', data),
  connectSession: (token: string) => request<ConnectResponse>('/api/auth/session/connect', undefined, token),
  logout: (token: string) => request<{ loggedOut: boolean }>('/api/auth/logout', undefined, token),
};
