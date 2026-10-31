/**
 * ============================================================================
 * 认证域仓储层（只写 SQL，不含业务判断）
 * ============================================================================
 * 表结构（见 migrations/）：
 *   users    ：id / name / email / initials / role / password_hash / password_salt / iterations
 *   sessions ：token_hash / user_id / role / expires_at / last_connected_at ...
 * 所有查询都用绑定参数（.bind），避免 SQL 注入。
 */
import type { UserRow, UserProfile, Role } from './types';

/** 按「邮箱 + 角色」查用户（COLLATE NOCASE 表示邮箱不区分大小写） */
export function findUser(db: D1Database, email: string, role: Role) {
  return db.prepare('SELECT id, name, email, initials, role, password_hash, password_salt, iterations FROM users WHERE email = ? COLLATE NOCASE AND role = ?').bind(email, role).first<UserRow>();
}

/** 查邮箱是否已被占用（注册时查重，不区分大小写） */
export function findEmail(db: D1Database, email: string) {
  return db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first<{ id: string }>();
}

/** 插入新用户（密码只以哈希/盐/迭代次数三字段入仓） */
export async function createUser(db: D1Database, user: UserProfile, password: { hash: string; salt: string; iterations: number }, now: number) {
  await db.prepare('INSERT INTO users (id, name, email, initials, role, password_hash, password_salt, iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(user.id, user.name, user.email, user.initials, user.role, password.hash, password.salt, password.iterations, now, now).run();
}

/**
 * 创建会话：入参是 Token 的摘要（不是 Token 本身）。
 * 有效期：「保持登录」30 天，否则 1 天（前端会把非持久会话放在 sessionStorage）。
 * 同时记录客户端平台与 UA，便于管理员排查异常登录。
 */
export async function createSession(db: D1Database, tokenHash: string, user: UserProfile, keepSignedIn: boolean, request: Request, now: number) {
  const expiresAt = now + (keepSignedIn ? 30 : 1) * 86_400_000;
  await db.prepare('INSERT INTO sessions (token_hash, user_id, role, keep_signed_in, client_platform, user_agent, created_at, expires_at, last_connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(tokenHash, user.id, user.role, Number(keepSignedIn), request.headers.get('X-Client-Platform'), request.headers.get('User-Agent'), now, expiresAt, now).run();
  return expiresAt;
}

/** 清理该用户已过期的会话（登录成功后异步扫一遍，控制表体积） */
export async function removeExpiredSessions(db: D1Database, userId: string, now: number) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(userId, now).run();
}

/**
 * 用 Token 摘要查会话，并 JOIN 出最新用户资料。
 * 同时返回 s.role（会话签发时的角色）与 u.role（用户当前角色），
 * 调用方通过两者相等来发现「角色被修改」的异常情况。
 */
export async function findSession(db: D1Database, tokenHash: string) {
  return db.prepare('SELECT s.user_id, s.role AS session_role, s.expires_at, u.id, u.name, u.email, u.initials, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .bind(tokenHash).first<{ user_id: string; session_role: Role; expires_at: number } & UserProfile>();
}

/** 刷新会话的最后连接时间（连接校验成功时异步调用，不阻塞响应） */
export async function touchSession(db: D1Database, tokenHash: string, now: number) {
  return db.prepare('UPDATE sessions SET last_connected_at = ? WHERE token_hash = ?').bind(now, tokenHash).run();
}

/** 删除单个会话：退出登录、或发现会话已失效时清理脏数据 */
export async function deleteSession(db: D1Database, tokenHash: string) {
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}
