import type { TelegramAccountRow, TelegramAppRow, TelegramAuthorizationRow } from './types';

export function getApp(db: D1Database, userId: string) {
  return db.prepare('SELECT user_id, api_id, api_hash, api_hash_mask, validated_at, last_report, created_at, updated_at FROM tg_apps WHERE user_id = ?').bind(userId).first<TelegramAppRow>();
}
export function listAccounts(db: D1Database, userId: string) {
  return db.prepare('SELECT id, user_id, tg_user_id, username, first_name, last_name, phone_mask, is_premium, home_dc, created_at, updated_at FROM tg_accounts WHERE user_id = ? ORDER BY updated_at DESC').bind(userId).all<TelegramAccountRow>();
}
export function listAuthorizations(db: D1Database, userId: string) {
  return db.prepare(`SELECT a.id, a.account_id, a.device_id, a.device_label, a.platform, a.app_version, a.session_state, a.reachability, a.flood_until, a.frozen, a.latency_ms, a.created_at, a.last_seen_at, a.revoked_at
    FROM tg_authorizations a JOIN tg_accounts t ON t.id = a.account_id WHERE t.user_id = ? ORDER BY a.last_seen_at DESC`).bind(userId).all<TelegramAuthorizationRow>();
}
export function saveApp(db: D1Database, userId: string, apiId: number, apiHash: string, mask: string, report: string | null, now: number) {
  return db.prepare(`INSERT INTO tg_apps (user_id, api_id, api_hash, api_hash_mask, validated_at, last_report, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET api_id = excluded.api_id, api_hash = excluded.api_hash, api_hash_mask = excluded.api_hash_mask, validated_at = excluded.validated_at, last_report = excluded.last_report, updated_at = excluded.updated_at`)
    .bind(userId, apiId, apiHash, mask, report ? now : null, report, now, now).run();
}
export function deleteApp(db: D1Database, userId: string) { return db.prepare('DELETE FROM tg_apps WHERE user_id = ?').bind(userId).run(); }
export function getAccount(db: D1Database, userId: string, accountId: string) { return db.prepare('SELECT id FROM tg_accounts WHERE id = ? AND user_id = ?').bind(accountId, userId).first<{ id: string }>(); }
export function getAccountByTelegramId(db: D1Database, userId: string, tgUserId: string) { return db.prepare('SELECT id FROM tg_accounts WHERE user_id = ? AND tg_user_id = ?').bind(userId, tgUserId).first<{ id: string }>(); }
export function getAuthorizationByDeviceId(db: D1Database, accountId: string, deviceId: string) { return db.prepare('SELECT id FROM tg_authorizations WHERE account_id = ? AND device_id = ?').bind(accountId, deviceId).first<{ id: string }>(); }
export function countAccounts(db: D1Database, userId: string) { return db.prepare('SELECT COUNT(*) AS count FROM tg_accounts WHERE user_id = ?').bind(userId).first<{ count: number }>(); }
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
export function touchAuthorization(db: D1Database, userId: string, authId: string, data: { state?: string; reachability: string | null; latency: number | null; now: number }) {
  return db.prepare(`UPDATE tg_authorizations SET session_state = COALESCE(?, session_state), reachability = ?, latency_ms = ?, last_seen_at = ?, revoked_at = CASE WHEN ? IN ('revoked', 'expired', 'duplicated') THEN ? ELSE revoked_at END
    WHERE id = ? AND account_id IN (SELECT id FROM tg_accounts WHERE user_id = ?)`).bind(data.state ?? null, data.reachability, data.latency, data.now, data.state ?? '', data.now, authId, userId).run();
}
export function deleteAuthorization(db: D1Database, userId: string, authId: string) { return db.prepare('DELETE FROM tg_authorizations WHERE id = ? AND account_id IN (SELECT id FROM tg_accounts WHERE user_id = ?)').bind(authId, userId).run(); }
export function deleteAccount(db: D1Database, userId: string, accountId: string) { return db.prepare('DELETE FROM tg_accounts WHERE id = ? AND user_id = ?').bind(accountId, userId).run(); }
