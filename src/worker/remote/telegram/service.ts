/**
 * ============================================================================
 * Telegram 绑定业务层
 * ============================================================================
 * 三条业务上限（应产品需求而定，改动需同步前端文案）：
 *   · 每位用户最多绑定 5 个 Telegram 账号；
 *   · 每个 Telegram 账号最多 3 台设备授权；
 *   · 同一设备重复绑定不会报错，而是 upsert（复用已有授权行）。
 * 所有查询都带 userId 条件，防止越权读写别人的账号。
 */
import { AuthError } from '../auth/types';
import { maskSecret } from './mask';

import * as repository from './repository';
import { optionalText, requiredText, validApiId, type AccountInput, type AuthorizationInput, type CredentialInput } from './types';

const MAX_ACCOUNTS = 5;
const MAX_DEVICES = 3;

/** 读取应用凭据；没有则返回 { credentials: null }，让前端展示空态 */
export async function getCredentials(env: Env, userId: string) {
  const app = await repository.getApp(env.AUTH_DB, userId);
  if (!app) return { credentials: null };
  return { credentials: { apiId: app.api_id, apiHash: app.api_hash, apiHashMask: app.api_hash_mask, validatedAt: app.validated_at, report: app.last_report ? JSON.parse(app.last_report) : null } };
}

/** 保存（upsert）应用凭据；report 是客户端连通性报告，可为空 */
export async function saveCredentials(env: Env, userId: string, body: CredentialInput) {
  const apiId = validApiId(body.apiId);
  const apiHash = requiredText(body.apiHash, 'api_hash', 256);
  const report = body.report === undefined ? null : JSON.stringify(body.report);
  await repository.saveApp(env.AUTH_DB, userId, apiId, apiHash, maskSecret(apiHash), report, Date.now());
  return getCredentials(env, userId);
}
/**
 * 删除应用凭据。
 * cascade = true 时先清空该用户全部 tg_accounts（授权行靠外键级联）。
 */
export async function removeCredentials(env: Env, userId: string, cascade: boolean) {
  if (cascade) await env.AUTH_DB.prepare('DELETE FROM tg_accounts WHERE user_id = ?').bind(userId).run();
  await repository.deleteApp(env.AUTH_DB, userId);
  return { deleted: true };
}
/** 账号列表：一次查两张表，再在内存里按 account_id 拼装，避免 N+1 查询 */
export async function getAccounts(env: Env, userId: string) {
  const [accounts, authorizations] = await Promise.all([repository.listAccounts(env.AUTH_DB, userId), repository.listAuthorizations(env.AUTH_DB, userId)]);
  return { accounts: accounts.results.map((account) => ({ ...account, authorizations: authorizations.results.filter((item) => item.account_id === account.id) })) };
}
/**
 * 绑定账号（幂等 upsert）：
 *   1. 账号已存在 → 不占新名额；否则检查上限；
 *   2. 设备已存在 → 视为重连，不占新设备名额；否则检查上限；
 *   3. 账号与授权写在同一个 D1 batch（事务）里，不会只成功一半。
 */
export async function bindAccount(env: Env, userId: string, body: AccountInput) {
  const tgUserId = requiredText(body.tgUserId, 'Telegram 用户 ID', 80);
  const existingAccount = await repository.getAccountByTelegramId(env.AUTH_DB, userId, tgUserId);
  // 名额校验只在「首次绑定这个账号」时执行
  if (!existingAccount) {
    const count = await repository.countAccounts(env.AUTH_DB, userId);
    if ((count?.count ?? 0) >= MAX_ACCOUNTS) throw new AuthError('ACCOUNT_LIMIT', `每位用户最多绑定 ${MAX_ACCOUNTS} 个 Telegram 账户`, 409);
  }
  const device = body.device && typeof body.device === 'object' ? body.device as AuthorizationInput : {};
  const deviceId = requiredText(device.deviceId, '设备 ID', 120);
  const platform = requiredText(device.platform, '设备平台', 20);
  // platform 必须命中枚举，否则落库会撞 CHECK 约束变成 500
  if (!['web', 'electron', 'ios'].includes(platform)) throw new AuthError('INVALID_REQUEST', '设备平台无效');
  const isKnownDevice = existingAccount
    ? Boolean(await repository.getAuthorizationByDeviceId(env.AUTH_DB, existingAccount.id, deviceId))
    : false;
  // 名额校验只在「新设备首次授权」时执行
  if (!isKnownDevice) {
    const deviceCount = await env.AUTH_DB.prepare('SELECT COUNT(*) AS count FROM tg_authorizations WHERE account_id IN (SELECT id FROM tg_accounts WHERE user_id = ? AND tg_user_id = ?)').bind(userId, tgUserId).first<{ count: number }>();
    if ((deviceCount?.count ?? 0) >= MAX_DEVICES) throw new AuthError('DEVICE_LIMIT', `每个 Telegram 账户最多 ${MAX_DEVICES} 台设备`, 409);
  }
  const now = Date.now();
  // 账号元信息 + 设备授权一起提交（batch 是事务性的）
  await repository.bindAccountAndAuthorization(env.AUTH_DB, {
    account: { id: crypto.randomUUID(), userId, tgUserId, username: optionalText(body.username), firstName: optionalText(body.firstName), lastName: optionalText(body.lastName), phoneMask: optionalText(body.phone), isPremium: body.isPremium === true ? 1 : 0, homeDc: typeof body.homeDc === 'number' ? body.homeDc : null, now },
    authorization: { id: crypto.randomUUID(), deviceId, label: requiredText(device.deviceLabel, '设备名称', 160), platform, version: optionalText(device.appVersion, 50), state: 'active', reachability: 'ok', latency: null },
  });
  return getAccounts(env, userId);
}
/**
 * 更新设备授权状态（客户端心跳/重连时上报）。
 * 任何非法枚举值都返回 400，不能让 D1 的 CHECK 约束把它变成 500。
 */
export async function updateAuthorization(env: Env, userId: string, authId: string, body: AuthorizationInput) {
  const state = body.sessionState === undefined ? undefined : requiredText(body.sessionState, '授权状态', 20);
  if (state && !['active', 'expired', 'revoked', 'duplicated'].includes(state)) throw new AuthError('INVALID_REQUEST', '授权状态无效');
  // 必须与 tg_authorizations.reachability 的 CHECK 约束一致；非法值返回 400，不能落到 D1 变成 500。
  const reachability = optionalText(body.reachability, 20);
  if (reachability && !['ok', 'degraded', 'blocked'].includes(reachability)) throw new AuthError('INVALID_REQUEST', '连通状态无效');
  await repository.touchAuthorization(env.AUTH_DB, userId, authId, { state, reachability, latency: typeof body.latencyMs === 'number' ? body.latencyMs : null, now: Date.now() });
  return getAccounts(env, userId);
}
/** 删除单台设备授权（踢下线） */
export async function removeAuthorization(env: Env, userId: string, authId: string) { await repository.deleteAuthorization(env.AUTH_DB, userId, authId); return { deleted: true }; }
/** 解绑整个 Telegram 账号（其授权行随之级联删除） */
export async function removeAccount(env: Env, userId: string, accountId: string) { await repository.deleteAccount(env.AUTH_DB, userId, accountId); return { deleted: true }; }
