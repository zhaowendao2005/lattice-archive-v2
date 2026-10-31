/**
 * 认证域的类型与错误定义（服务端与前端共享的形状）
 * 注意：UserRow 含密码哈希/盐，只在 Worker 内部流转，绝不能返回给客户端。
 */

/** 角色：普通用户 / 管理员，两者在 users 表里用 role 列区分，登录入口也分开 */
export type Role = 'user' | 'admin';
/** Turnstile 的 action 值，必须与前端 render 时传的 action 完全一致 */
export type TurnstileAction = 'login' | 'register' | 'admin_login';

/** 对外暴露的用户资料（无敏感字段） */
export interface UserProfile { id: string; name: string; email: string; initials: string; role: Role }
/** 数据库行：在资料基础上多了口令哈希三件套 */
export interface UserRow extends UserProfile { password_hash: string; password_salt: string; iterations: number }
/** 登录/注册请求体（字段全部 unknown，必须在 service 里逐项校验后再用） */
export interface AuthBody { email?: unknown; password?: unknown; name?: unknown; turnstileToken?: unknown; keepSignedIn?: unknown }
/** 签发成功的返回体 */
export interface SessionResult { user: UserProfile; session: { token: string; expiresAt: number; serverConnected: true } }

/**
 * 业务错误：code 给前端做分支判定，message 是可直接展示的中文，status 是 HTTP 码。
 * 路由层统一 catch 它并转成 JSON 响应。
 */
export class AuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
