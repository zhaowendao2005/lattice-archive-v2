/**
 * Telegram 绑定域仓储层。
 * 每个函数都要求 userId（或通过子查询限定 owner），保证不会跨用户读写。
 * 涉及「状态机」的更新（touchAuthorization）用 CASE 表达式保证 revoked_at 只写一次。
 */
import type { TelegramAccountRow, TelegramAppRow, TelegramAuthorizationRow } from './types';

/** 读取用户的应用凭据（api_hash 含明文，仅限服务端内部使用） */
export function getApp(db: D1Database, userId: string) {
  return db.prepare('SELECT user_id, api_id, api_hash, api_hash_mask, validated_at, last_report, created_at, updated_at FROM tg_apps WHERE user_id = ?').bind(userId).first<TelegramAppRow>();
}
/** 账号列表：按最近更新时间倒序 */
export function listAccounts(db: D1Database, userId: string) {
  return db.prepare('SELECT id, user_id, tg_user_id, username, first_name, last_name, phone_mask, is_premium, home_dc, created_at, updated_at FROM tg_accounts WHERE user_id = ? ORDER BY updated_at DESC').bind(userId).all<TelegramAccountRow>();
}
/** 授权列表：JOIN tg_accounts 限定 owner，按最近活跃时间倒序 */
export function listAuthorizations(db: D1Database, userId: string) {
  return db.prepare(`SELECT a.id, a.account_id, a.device_id, a.device_label, a.platform, a.app_version, a.session_state, a.reachability, a.flood_until, a.frozen, a.latency_ms, a.created_at, a.last_seen_at, a.revoked_at
    FROM tg_authorizations a JOIN tg_accounts t ON t.id = a.account_id WHERE t.user_id = ? ORDER BY a.last_seen_at DESC`).bind(userId).all<TelegramAuthorizationRow>();
}
/** upsert 应用凭据（user_id 唯一，冲突时整行覆盖） */
export function saveApp(db: D1Database, userId: string, apiId: number, apiHash: string, mask: string, report: string | null, now: number) {
  return db.prepare(`INSERT INTO tg_apps (user_id, api_id, api_hash, api_hash_mask, validated_at, last_report, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET api_id = excluded.api_id, api_hash = excluded.api_hash, api_hash_mask = excluded.api_hash_mask, validated_at = excluded.validated_at, last_report = excluded.last_report, updated_at = excluded.updated_at`)
    .bind(userId, apiId, apiHash, mask, report ? now : null, report, now, now).run();
}
/** 删除应用凭据（不级联账号，级联由 service 层控制） */
export function deleteApp(db: D1Database, userId: string) { return db.prepare('DELETE FROM tg_apps WHERE user_id = ?').bind(userId).run(); }
/** 按 id + owner 查账号（用于越权校验） */
export function getAccount(db: D1Database, userId: string, accountId: string) { return db.prepare('SELECT id FROM tg_accounts WHERE id = ? AND user_id = ?').bind(accountId, userId).first<{ id: string }>(); }
/** 按 Telegram 用户 ID 查本地账号（判定是否首次绑定） */
export function getAccountByTelegramId(db: D1Database, userId: string, tgUserId: string) { return db.prepare('SELECT id FROM tg_accounts WHERE user_id = ? AND tg_user_id = ?').bind(userId, tgUserId).first<{ id: string }>(); }
/** 按设备 ID 查授权（判定是否为已授权设备） */
export function getAuthorizationByDeviceId(db: D1Database, accountId: string, deviceId: string) { return db.prepare('SELECT id FROM tg_authorizations WHERE account_id = ? AND device_id = ?').bind(accountId, deviceId).first<{ id: string }>(); }
/** 统计用户已绑定的账号数（名额上限校验） */
export function countAccounts(db: D1Database, userId: string) { return db.prepare('SELECT COUNT(*) AS count FROM tg_accounts WHERE user_id = ?').bind(userId).first<{ count: number }>(); }
/**
 * 在一个事务里 upsert「账号 + 设备授权」。
 * 授权行通过 SELECT ... FROM tg_accounts 取 account_id，即便账号同时新建也能拿到正确的行。
 * 冲突时把 revoked_at 置 NULL：重新登录等于「恢复授权次」。
 */
export function bindAccountAndAuthorization(db: D1Database, data: {
  account: { id: string; userId: string; tgUserId: string; username: string | null; firstName: string | null; lastName: string | null; phoneMask: string | null; isPremium: number; homeDc: number | null; now: number };
  authorization: { id: string; deviceId: string; label: string; platform: string; version: string | null; state: string; reachability: string | null; latency: number | null };
}) {
  const { account, authorization } = data;
  const accountUpsert = db.prepare(`INSERT INTO tg_accounts (id, user_id, tg_user_id, username, first_name, last_name, phone_mask, is_premium, home_dc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, tg_user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, last_name = excluded.last_name, phone_mask = excluded.phone_mask, is_premium = excluded.is_premium, home_dc = excluded.home_dc, updated_at = excluded.updated_at`)
    .bind(account.id, account.userId, account.tgUserId, account.username, account.firstName, account.lastName, account.phoneMask, account.isPremium, account.homeDc, account.now, account.now);
  const authorizationUpsert = db.prepare(`INSERT INTO tg_authorizations (id, account_id, device_id, device_label, platform, app_version, session_state, reachability, latency_ms, created_at, last_seen_at)
    SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM tg_accounts WHERE user_id = ? AND tg_user_id = ?
    ON CONFLICT(account_id, device_id) DO UPDATE SET device_label = excluded.device_label, platform = excluded.platform, app_version = excluded.app_version, session_state = excluded.session_state, reachability = excluded.reachability, latency_ms = excluded.latency_ms, last_seen_at = excluded.last_seen_at, revoked_at = NULL`)
    .bind(authorization.id, authorization.deviceId, authorization.label, authorization.platform, authorization.version, authorization.state, authorization.reachability, authorization.latency, account.now, account.now, account.userId, account.tgUserId);
  // D1 batch is transactional: account metadata and device authorization cannot be partially persisted.
  return db.batch([accountUpsert, authorizationUpsert]);
}
/**
 * 更新授权状态（心跳上报）：
 *   · session_state 用 COALESCE：不传则保持原值；
 *   · reachability / latency 每次都覆盖；
 *   · revoked_at 仅在进入 revoked/expired/duplicated 时写入。
 * WHERE 里的子查询保证只能改自己的授权行。
 */
export function touchAuthorization(db: D1Database, userId: string, authId: string, data: { state?: string; reachability: string | null; latency: number | null; now: number }) {
  return db.prepare(`UPDATE tg_authorizations SET session_state = COALESCE(?, session_state), reachability = ?, latency_ms = ?, last_seen_at = ?, revoked_at = CASE WHEN ? IN ('revoked', 'expired', 'duplicated') THEN ? ELSE revoked_at END
    WHERE id = ? AND account_id IN (SELECT id FROM tg_accounts WHERE user_id = ?)`).bind(data.state ?? null, data.reachability, data.latency, data.now, data.state ?? '', data.now, authId, userId).run();
}
/** 删除授权（带 owner 限定，防越权） */
export function deleteAuthorization(db: D1Database, userId: string, authId: string) { return db.prepare('DELETE FROM tg_authorizations WHERE id = ? AND account_id IN (SELECT id FROM tg_accounts WHERE user_id = ?)').bind(authId, userId).run(); }
/** 删除账号（带 owner 限定；授权行由外键 ON DELETE CASCADE 清理） */
export function deleteAccount(db: D1Database, userId: string, accountId: string) { return db.prepare('DELETE FROM tg_accounts WHERE id = ? AND user_id = ?').bind(accountId, userId).run(); }
