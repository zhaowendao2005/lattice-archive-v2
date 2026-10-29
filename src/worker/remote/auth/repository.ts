import type { UserRow, UserProfile, Role } from './types';

export function findUser(db: D1Database, email: string, role: Role) {
  return db.prepare('SELECT id, name, email, initials, role, password_hash, password_salt, iterations FROM users WHERE email = ? COLLATE NOCASE AND role = ?').bind(email, role).first<UserRow>();
}

export function findEmail(db: D1Database, email: string) {
  return db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first<{ id: string }>();
}

export async function createUser(db: D1Database, user: UserProfile, password: { hash: string; salt: string; iterations: number }, now: number) {
  await db.prepare('INSERT INTO users (id, name, email, initials, role, password_hash, password_salt, iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(user.id, user.name, user.email, user.initials, user.role, password.hash, password.salt, password.iterations, now, now).run();
}

export async function createSession(db: D1Database, tokenHash: string, user: UserProfile, keepSignedIn: boolean, request: Request, now: number) {
  const expiresAt = now + (keepSignedIn ? 30 : 1) * 86_400_000;
  await db.prepare('INSERT INTO sessions (token_hash, user_id, role, keep_signed_in, client_platform, user_agent, created_at, expires_at, last_connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(tokenHash, user.id, user.role, Number(keepSignedIn), request.headers.get('X-Client-Platform'), request.headers.get('User-Agent'), now, expiresAt, now).run();
  return expiresAt;
}

export async function removeExpiredSessions(db: D1Database, userId: string, now: number) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(userId, now).run();
}

export async function findSession(db: D1Database, tokenHash: string) {
  return db.prepare('SELECT s.user_id, s.role AS session_role, s.expires_at, u.id, u.name, u.email, u.initials, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .bind(tokenHash).first<{ user_id: string; session_role: Role; expires_at: number } & UserProfile>();
}

export async function touchSession(db: D1Database, tokenHash: string, now: number) {
  return db.prepare('UPDATE sessions SET last_connected_at = ? WHERE token_hash = ?').bind(now, tokenHash).run();
}

export async function deleteSession(db: D1Database, tokenHash: string) {
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}
