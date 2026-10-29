import type { Role, UserProfile } from '../auth/types';

export interface AdminUserRow extends UserProfile { created_at: number; updated_at: number }

export function listUsers(db: D1Database, search: string, limit: number, offset: number, sort: 'created_at' | 'name' | 'email', direction: 'asc' | 'desc') {
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const order = `${sort} ${direction === 'asc' ? 'ASC' : 'DESC'}`;
  return Promise.all([
    db.prepare(`SELECT id, name, email, initials, role, created_at, updated_at FROM users WHERE role = ? AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ORDER BY ${order}, id ASC LIMIT ? OFFSET ?`).bind('user', pattern, pattern, limit, offset).all<AdminUserRow>(),
    db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'user' AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')").bind(pattern, pattern).first<{ total: number }>(),
  ]).then(([rows, count]) => ({ rows: rows.results, total: count?.total ?? 0 }));
}

export function findUserById(db: D1Database, id: string) {
  return db.prepare('SELECT id, name, email, initials, role, created_at, updated_at FROM users WHERE id = ?').bind(id).first<AdminUserRow>();
}

export function createManagedUser(db: D1Database, user: UserProfile, password: { hash: string; salt: string; iterations: number }, now: number) {
  return db.prepare('INSERT INTO users (id, name, email, initials, role, password_hash, password_salt, iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(user.id, user.name, user.email, user.initials, 'user' satisfies Role, password.hash, password.salt, password.iterations, now, now).run();
}

export function deleteManagedUser(db: D1Database, id: string) {
  return db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'user')").bind(id, id),
    db.prepare("DELETE FROM users WHERE id = ? AND role = 'user'").bind(id),
  ]).then((results) => results[1]!);
}
