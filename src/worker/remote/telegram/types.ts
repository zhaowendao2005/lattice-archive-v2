/**
 * ============================================================================
 * Telegram 绑定域的类型与入参校验器
 * ============================================================================
 * 三张表的关系：tg_apps（每用户一份 api_id/api_hash）
 *               └── tg_accounts（绑定的 Telegram 账号）
 *                    └── tg_authorizations（每个账号在不同设备上的授权记录）
 * 所有 *Input 字段都是 unknown：请求体不可信，必须经下面的校验器转型后才能用。
 */
import { AuthError } from '../auth/types';
import type { UserProfile } from '../auth/types';

/** 用户的 Telegram 应用凭据（api_hash 同时存明文与脱敏版，列表只返回脱敏版） */
export interface TelegramAppRow {
  user_id: string; api_id: number; api_hash: string; api_hash_mask: string;
  validated_at: number | null; last_report: string | null; created_at: number; updated_at: number;
}
/** 已绑定的 Telegram 账号（手机号只存掩码） */
export interface TelegramAccountRow {
  id: string; user_id: string; tg_user_id: string; username: string | null;
  first_name: string | null; last_name: string | null; phone_mask: string | null;
  is_premium: number; home_dc: number | null; created_at: number; updated_at: number;
}
/** 一条设备授权记录：session 状态、连通性、限流与冻结标记 */
export interface TelegramAuthorizationRow {
  id: string; account_id: string; device_id: string; device_label: string; platform: 'web' | 'electron' | 'ios';
  app_version: string | null; session_state: 'active' | 'expired' | 'revoked' | 'duplicated';
  reachability: 'ok' | 'degraded' | 'blocked' | null; flood_until: number | null; frozen: number;
  latency_ms: number | null; created_at: number; last_seen_at: number; revoked_at: number | null;
}
/** 客户端回传的连通性报告（DC、延迟、协议层等，用于后续排障） */
export interface TelegramReport { dcId?: number; country?: string; latencyMs?: number; layer?: number; serverTimeOffset?: number }
export interface CredentialInput { apiId?: unknown; apiHash?: unknown; report?: unknown }
export interface AccountInput { tgUserId?: unknown; username?: unknown; firstName?: unknown; lastName?: unknown; phone?: unknown; isPremium?: unknown; homeDc?: unknown; device?: unknown }
export interface AuthorizationInput { accountId?: unknown; deviceId?: unknown; deviceLabel?: unknown; platform?: unknown; appVersion?: unknown; sessionState?: unknown; reachability?: unknown; latencyMs?: unknown }
export interface TelegramUserSession extends UserProfile { expires_at: number }

/** 必须存在且不超长的文本字段；不合法直接 400 */
export function requiredText(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AuthError('INVALID_REQUEST', `${label}格式无效`);
  return value.trim();
}
/** 可选文本字段：空 / 类型不对 / 超长 → 一律返回 null（不报错） */
export function optionalText(value: unknown, max = 500): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
}
/** api_id 必须是在 32 位正整数范围内的整数 */
export function validApiId(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > 2_147_483_647) throw new AuthError('INVALID_REQUEST', 'api_id 格式无效');
  return value as number;
}
