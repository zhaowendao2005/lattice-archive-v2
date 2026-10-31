import { AuthError } from '../auth/types';
import { maskSecret } from './mask';

import * as repository from './repository';
import { optionalText, requiredText, validApiId, type AccountInput, type AuthorizationInput, type CredentialInput } from './types';

const MAX_ACCOUNTS = 5;
const MAX_DEVICES = 3;

export async function getCredentials(env: Env, userId: string) {
  const app = await repository.getApp(env.AUTH_DB, userId);
  if (!app) return { credentials: null };
  return { credentials: { apiId: app.api_id, apiHash: app.api_hash, apiHashMask: app.api_hash_mask, validatedAt: app.validated_at, report: app.last_report ? JSON.parse(app.last_report) : null } };
}
export async function saveCredentials(env: Env, userId: string, body: CredentialInput) {
  const apiId = validApiId(body.apiId);
  const apiHash = requiredText(body.apiHash, 'api_hash', 256);
  const report = body.report === undefined ? null : JSON.stringify(body.report);
  await repository.saveApp(env.AUTH_DB, userId, apiId, apiHash, maskSecret(apiHash), report, Date.now());
  return getCredentials(env, userId);
}
export async function removeCredentials(env: Env, userId: string, cascade: boolean) {
  if (cascade) await env.AUTH_DB.prepare('DELETE FROM tg_accounts WHERE user_id = ?').bind(userId).run();
  await repository.deleteApp(env.AUTH_DB, userId);
  return { deleted: true };
}
export async function getAccounts(env: Env, userId: string) {
  const [accounts, authorizations] = await Promise.all([repository.listAccounts(env.AUTH_DB, userId), repository.listAuthorizations(env.AUTH_DB, userId)]);
  return { accounts: accounts.results.map((account) => ({ ...account, authorizations: authorizations.results.filter((item) => item.account_id === account.id) })) };
}
export async function bindAccount(env: Env, userId: string, body: AccountInput) {
  const tgUserId = requiredText(body.tgUserId, 'Telegram 用户 ID', 80);
  const existingAccount = await repository.getAccountByTelegramId(env.AUTH_DB, userId, tgUserId);
  if (!existingAccount) {
    const count = await repository.countAccounts(env.AUTH_DB, userId);
    if ((count?.count ?? 0) >= MAX_ACCOUNTS) throw new AuthError('ACCOUNT_LIMIT', `每位用户最多绑定 ${MAX_ACCOUNTS} 个 Telegram 账户`, 409);
  }
  const device = body.device && typeof body.device === 'object' ? body.device as AuthorizationInput : {};
  const deviceId = requiredText(device.deviceId, '设备 ID', 120);
  const platform = requiredText(device.platform, '设备平台', 20);
  if (!['web', 'electron', 'ios'].includes(platform)) throw new AuthError('INVALID_REQUEST', '设备平台无效');
  const isKnownDevice = existingAccount
    ? Boolean(await repository.getAuthorizationByDeviceId(env.AUTH_DB, existingAccount.id, deviceId))
    : false;
  if (!isKnownDevice) {
    const deviceCount = await env.AUTH_DB.prepare('SELECT COUNT(*) AS count FROM tg_authorizations WHERE account_id IN (SELECT id FROM tg_accounts WHERE user_id = ? AND tg_user_id = ?)').bind(userId, tgUserId).first<{ count: number }>();
    if ((deviceCount?.count ?? 0) >= MAX_DEVICES) throw new AuthError('DEVICE_LIMIT', `每个 Telegram 账户最多 ${MAX_DEVICES} 台设备`, 409);
  }
  const now = Date.now();
  await repository.bindAccountAndAuthorization(env.AUTH_DB, {
    account: { id: crypto.randomUUID(), userId, tgUserId, username: optionalText(body.username), firstName: optionalText(body.firstName), lastName: optionalText(body.lastName), phoneMask: optionalText(body.phone), isPremium: body.isPremium === true ? 1 : 0, homeDc: typeof body.homeDc === 'number' ? body.homeDc : null, now },
    authorization: { id: crypto.randomUUID(), deviceId, label: requiredText(device.deviceLabel, '设备名称', 160), platform, version: optionalText(device.appVersion, 50), state: 'active', reachability: 'ok', latency: null },
  });
  return getAccounts(env, userId);
}
export async function updateAuthorization(env: Env, userId: string, authId: string, body: AuthorizationInput) {
  const state = body.sessionState === undefined ? undefined : requiredText(body.sessionState, '授权状态', 20);
  if (state && !['active', 'expired', 'revoked', 'duplicated'].includes(state)) throw new AuthError('INVALID_REQUEST', '授权状态无效');
  await repository.touchAuthorization(env.AUTH_DB, userId, authId, { state, reachability: optionalText(body.reachability, 20), latency: typeof body.latencyMs === 'number' ? body.latencyMs : null, now: Date.now() });
  return getAccounts(env, userId);
}
export async function removeAuthorization(env: Env, userId: string, authId: string) { await repository.deleteAuthorization(env.AUTH_DB, userId, authId); return { deleted: true }; }
export async function removeAccount(env: Env, userId: string, accountId: string) { await repository.deleteAccount(env.AUTH_DB, userId, accountId); return { deleted: true }; }
