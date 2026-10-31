/**
 * 管理端仓储层。
 * 注意 listUsers 里的 ORDER BY 是模板字符串拼接：因为 SQL 不支持参数化列名。
 * 安全前提：sort / direction 在 service 层已被白名单校验过，调用方不得直接传外部字符串。
 */
import type { Role, UserProfile } from '../auth/types';

/** 管理表格里的用户行（比 UserProfile 多了时间戳） */
export interface AdminUserRow extends UserProfile { created_at: number; updated_at: number }

/** 分页 + 模糊搜索（name/email）+ 排序；同时查总数用于分页器 */
export function listUsers(db: D1Database, search: string, limit: number, offset: number, sort: 'created_at' | 'name' | 'email', direction: 'asc' | 'desc') {
  // ESCAPE '\' 配合手动转义，保证用户输入的 % _ 被当成普通字符而非通配符
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const order = `${sort} ${direction === 'asc' ? 'ASC' : 'DESC'}`;
  return Promise.all([
    db.prepare(`SELECT id, name, email, initials, role, created_at, updated_at FROM users WHERE role = ? AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ORDER BY ${order}, id ASC LIMIT ? OFFSET ?`).bind('user', pattern, pattern, limit, offset).all<AdminUserRow>(),
    db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'user' AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')").bind(pattern, pattern).first<{ total: number }>(),
  ]).then(([rows, count]) => ({ rows: rows.results, total: count?.total ?? 0 }));
}

/** 按 id 查用户（用于删除前确认存在性与角色） */
export function findUserById(db: D1Database, id: string) {
  return db.prepare('SELECT id, name, email, initials, role, created_at, updated_at FROM users WHERE id = ?').bind(id).first<AdminUserRow>();
}

/** 插入一个普通用户（role 硬编码为 'user'，satisfies 让 TS 帮忙检查类型） */
export function createManagedUser(db: D1Database, user: UserProfile, password: { hash: string; salt: string; iterations: number }, now: number) {
  return db.prepare('INSERT INTO users (id, name, email, initials, role, password_hash, password_salt, iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(user.id, user.name, user.email, user.initials, 'user' satisfies Role, password.hash, password.salt, password.iterations, now, now).run();
}

/**
 * 删除用户 + 清理其全部会话（batch = 一个事务里的多条语句）。
 * 两条 DELETE 都带 role = 'user' 条件：即使上游判断被绕过，也删不掉管理员。
 * 返回第二条（删用户）的结果，用于判断是否真的删到了行。
 */
export function deleteManagedUser(db: D1Database, id: string) {
  return db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'user')").bind(id, id),
    db.prepare("DELETE FROM users WHERE id = ? AND role = 'user'").bind(id),
  ]).then((results) => results[1]!);
}
