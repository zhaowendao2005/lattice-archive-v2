import { authSessionStorage } from '@/stores/auth/data-sources/authSessionStorage';

export interface TelegramCredentials { apiId: number; apiHash: string; apiHashMask: string; validatedAt: number | null; report: unknown }
/** 与远端 tg_authorizations.reachability 的 CHECK 约束一一对应，不得发送其他取值。 */
export type TelegramReachability = 'ok' | 'degraded' | 'blocked';
export interface TelegramAuthorization { id: string; account_id: string; device_id: string; device_label: string; platform: string; session_state: string; reachability: TelegramReachability | null; latency_ms: number | null; last_seen_at: number }
export interface TelegramAccount { id: string; tg_user_id: string; username: string | null; first_name: string | null; last_name: string | null; phone_mask: string | null; is_premium: number; authorizations: TelegramAuthorization[] }
interface Envelope { credentials?: TelegramCredentials | null; accounts?: TelegramAccount[] }
const baseUrl = ((import.meta.env.VITE_REMOTE_WORKER_URL as string | undefined) ?? '').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 12_000;

async function request<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
  const token = authSessionStorage.read()?.token;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('无法连接服务器，请检查网络后重试');
  }
  const data = await response.json().catch(() => ({})) as { message?: string } & T;
  if (!response.ok) throw new Error(data.message ?? 'Telegram 请求失败');
  return data;
}
export const tgRemoteDataSource = {
  getCredentials: async () => (await request<Envelope>('/api/tg/credentials')).credentials ?? null,
  saveCredentials: async (payload: { apiId: number; apiHash: string; report?: unknown }) => (await request<Envelope>('/api/tg/credentials', 'PUT', payload)).credentials!,
  removeCredentials: (cascade: boolean) => request('/api/tg/credentials?cascade=' + (cascade ? '1' : '0'), 'DELETE'),
  getAccounts: async () => (await request<Envelope>('/api/tg/accounts')).accounts ?? [],
  bindAccount: (payload: unknown) => request<Envelope>('/api/tg/accounts', 'POST', payload),
  updateAuthorization: (id: string, payload: { sessionState?: string; reachability: TelegramReachability; latencyMs?: number }) => request<Envelope>(`/api/tg/authorizations/${id}`, 'PATCH', payload),
  removeAccount: (id: string) => request(`/api/tg/accounts/${id}`, 'DELETE'),
  removeAuthorization: (id: string) => request(`/api/tg/authorizations/${id}`, 'DELETE'),
};
