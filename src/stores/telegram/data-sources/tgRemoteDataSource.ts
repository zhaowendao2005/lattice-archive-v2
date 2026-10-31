export interface TelegramCredentials { apiId: number; apiHash: string; apiHashMask: string; validatedAt: number | null; report: unknown }
export interface TelegramAuthorization { id: string; account_id: string; device_id: string; device_label: string; platform: string; session_state: string; reachability: string | null; latency_ms: number | null; last_seen_at: number }
export interface TelegramAccount { id: string; tg_user_id: string; username: string | null; first_name: string | null; last_name: string | null; phone_mask: string | null; is_premium: number; authorizations: TelegramAuthorization[] }
interface Envelope { credentials?: TelegramCredentials | null; accounts?: TelegramAccount[] }
const baseUrl = ((import.meta.env.VITE_REMOTE_WORKER_URL as string | undefined) ?? '').replace(/\/$/, '');

async function request<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
  const auth = localStorage.getItem('lattice.auth.session');
  let token: string | undefined;
  try { token = auth ? (JSON.parse(auth) as { token?: string }).token : undefined; } catch { /* auth store owns invalid-session cleanup */ }
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
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
  removeAccount: (id: string) => request(`/api/tg/accounts/${id}`, 'DELETE'),
  removeAuthorization: (id: string) => request(`/api/tg/authorizations/${id}`, 'DELETE'),
};
