import { AuthError } from '../auth/types';
import type { UserProfile } from '../auth/types';

export interface TelegramAppRow {
  user_id: string; api_id: number; api_hash: string; api_hash_mask: string;
  validated_at: number | null; last_report: string | null; created_at: number; updated_at: number;
}
export interface TelegramAccountRow {
  id: string; user_id: string; tg_user_id: string; username: string | null;
  first_name: string | null; last_name: string | null; phone_mask: string | null;
  is_premium: number; home_dc: number | null; created_at: number; updated_at: number;
}
export interface TelegramAuthorizationRow {
  id: string; account_id: string; device_id: string; device_label: string; platform: 'web' | 'electron' | 'ios';
  app_version: string | null; session_state: 'active' | 'expired' | 'revoked' | 'duplicated';
  reachability: 'ok' | 'degraded' | 'blocked' | null; flood_until: number | null; frozen: number;
  latency_ms: number | null; created_at: number; last_seen_at: number; revoked_at: number | null;
}
export interface TelegramReport { dcId?: number; country?: string; latencyMs?: number; layer?: number; serverTimeOffset?: number }
export interface CredentialInput { apiId?: unknown; apiHash?: unknown; report?: unknown }
export interface AccountInput { tgUserId?: unknown; username?: unknown; firstName?: unknown; lastName?: unknown; phone?: unknown; isPremium?: unknown; homeDc?: unknown; device?: unknown }
export interface AuthorizationInput { accountId?: unknown; deviceId?: unknown; deviceLabel?: unknown; platform?: unknown; appVersion?: unknown; sessionState?: unknown; reachability?: unknown; latencyMs?: unknown }
export interface TelegramUserSession extends UserProfile { expires_at: number }

export function requiredText(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AuthError('INVALID_REQUEST', `${label}格式无效`);
  return value.trim();
}
export function optionalText(value: unknown, max = 500): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
}
export function validApiId(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > 2_147_483_647) throw new AuthError('INVALID_REQUEST', 'api_id 格式无效');
  return value as number;
}
