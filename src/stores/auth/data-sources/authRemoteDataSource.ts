/**
 * ============================================================================
 * 认证远端数据源（唯一允许直接 fetch 认证接口的地方）
 * ============================================================================
 * 分层职责：View 不碰网络 → Store 调本文件 → 本文件发 HTTP → Worker 处理。
 * 约定：
 *   · 所有请求都是 POST + JSON（包括「查询当前会话」也是 POST，避免 Token 落进 URL/日志）；
 *   · 统一 12s 超时，避免弱网下按钮永远转圈；
 *   · 失败一律抛 RemoteAuthError，携带后端错误码 + HTTP 状态码，供 Store 区分 401 与其他错误。
 */
import type { UserProfile } from '../stores/authStore';

/** 登录/注册成功的返回体：用户资料 + 会话凭据 */
interface AuthResponse { user: UserProfile; session: { token: string; expiresAt: number; serverConnected: true } }
/** 冷启动校准会话的返回体：服务端时间与最新用户资料 */
interface ConnectResponse { connected: true; serverTime: number; sessionExpiresAt: number; user: UserProfile }

/**
 * 认证类错误的统一载体。
 * code   ：后端返回的机器可读错误码（如 INVALID_CREDENTIALS），用于分支处理；
 * status ：HTTP 状态码，0 表示根本没连上（网络层失败）。
 */
export class RemoteAuthError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = 'NETWORK_ERROR', status = 0) { super(message); this.code = code; this.status = status; }
}

// 远端 Worker 地址：生产环境留空表示「同源」，开发时由 VITE_REMOTE_WORKER_URL 指向本机 / 线上
const baseUrl = ((import.meta.env.VITE_REMOTE_WORKER_URL as string | undefined) ?? '').replace(/\/$/, '');
// 单个认证请求的超时上限（毫秒）
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * 底层请求封装（带超时、错误归一化、JSON 解析）。
 * @param path    /api/auth/* 路径
 * @param payload 请求体；undefined 表示不带 body
 * @param token   会话 Token，存在时放 Authorization: Bearer
 */
async function request<T>(path: string, payload?: unknown, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      // AbortSignal.timeout：超时自动中断，抛出 TimeoutError 被下面 catch 捕获
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch { throw new RemoteAuthError('无法连接认证服务器，请检查网络后重试'); }
  // 响应不一定是 JSON（网关错误页等），解析失败时退化为空对象
  const data = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) throw new RemoteAuthError(data.message || '认证请求失败，请重试', data.error, response.status);
  return data as T;
}

export const authRemoteDataSource = {
  /** 注册普通用户：服务端会在 D1 建号并直接签发会话（不用再次登录） */
  register: (data: { name: string; email: string; password: string; turnstileToken: string; keepSignedIn: boolean }) => request<AuthResponse>('/api/auth/register', data),
  /** 普通用户登录 */
  login: (data: { email: string; password: string; turnstileToken: string; keepSignedIn: boolean }) => request<AuthResponse>('/api/auth/login', data),
  /** 管理员登录：独立接口，账户表与普通用户物理隔离 */
  adminLogin: (data: { email: string; password: string; turnstileToken: string; keepSignedIn: boolean }) => request<AuthResponse>('/api/auth/admin/login', data),
  /** 冷启动校准：拿本地 Token 换最新用户资料；401 说明会话已被撤销/过期 */
  connectSession: (token: string) => request<ConnectResponse>('/api/auth/session/connect', undefined, token),
  /** 退出登录：服务端删除会话记录（本地无论成败都会清理） */
  logout: (token: string) => request<{ loggedOut: boolean }>('/api/auth/logout', undefined, token),
};
