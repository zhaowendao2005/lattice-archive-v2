/**
 * ============================================================================
 * B1 AccountSessionBus · 账号健康探针与预备槽位派生
 * ============================================================================
 * 登录 / 恢复 / 前台切换的连接生命周期由 telegramRuntime 管理；本总线负责已授权账号上的会话类 RPC。
 * 账号级致命错误（AUTH_KEY_DUPLICATED 等）由 BusRouter 统一处理：停止该账号全部队列。
 */
import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import { returnBigInt } from 'telegram/Helpers';
import type { TgAccountHealthReport, TgSpawnedSlotResult } from '../../chatProtocol';
import type { SpawnPendingSlotInput } from '../contracts/buses';
import { selfUserId } from '../converters/converters';

/**
 * 账号健康探针与自动续期（GetAuthorizations + GetState + SetAccountTTL + SetAuthorizationTTL）
 */
export async function probeAccountHealth(
  client: TelegramClient,
  ensureTtlDays = 365,
): Promise<TgAccountHealthReport> {
  let accountTtlDays = ensureTtlDays;
  const authorizationTtlDays = ensureTtlDays;

  if (ensureTtlDays >= 365) {
    try {
      await client.invoke(
        new Api.account.SetAccountTTL({
          ttl: new Api.AccountDaysTTL({ days: 365 }),
        }),
      );
      await client.invoke(
        new Api.account.SetAuthorizationTTL({
          authorizationTtlDays: 365,
        }),
      );
    } catch {
      // ignore if restricted by <24h probation
    }
  }

  try {
    const ttlRes = await client.invoke(new Api.account.GetAccountTTL());
    accountTtlDays = ttlRes.days;
  } catch {
    // ignore
  }

  let activeSessionsCount = 1;
  let currentSessionCreatedAt: number | undefined;
  let currentSessionOfficial = false;

  try {
    const auths = await client.invoke(new Api.account.GetAuthorizations());
    activeSessionsCount = auths.authorizations.length;
    const current = auths.authorizations.find((a) => a.current);
    if (current) {
      currentSessionCreatedAt = current.dateCreated * 1000;
      currentSessionOfficial = Boolean(current.officialApp);
    }
  } catch {
    // ignore if <24h probation blocks GetAuthorizations
  }

  const stateRes = await client.invoke(new Api.updates.GetState());
  return {
    ok: true,
    accountId: selfUserId() || '',
    dcId: client.session.dcId,
    activeSessionsCount,
    currentSessionCreatedAt,
    currentSessionOfficial,
    accountTtlDays,
    authorizationTtlDays,
    pts: stateRes.pts,
    date: stateRes.date,
  };
}

/**
 * Worker 内环回接力派生预备槽位（ExportLoginToken <-> AcceptLoginToken + ChangeAuthorizationSettings）
 * 严格遵循架构规范 §3.2 的 6 步全自动环回接力链。
 */
export async function spawnPendingSlot(
  motherClient: TelegramClient,
  req: SpawnPendingSlotInput,
): Promise<TgSpawnedSlotResult> {
  const fp = req.deviceFingerprint;
  const childSession = new StringSession('');
  const childClient = new TelegramClient(childSession, req.apiId, req.apiHash, {
    connectionRetries: 2,
    useWSS: true,
    deviceModel: fp.deviceModel || 'Desktop',
    systemVersion: fp.systemVersion || 'Mac OS X',
    appVersion: fp.appVersion || '5.12.3',
    langCode: fp.langCode || 'zh-hans',
    systemLangCode: fp.systemLangCode || 'zh-CN',
  });

  try {
    await childClient.connect();

    // Step 1: Child 申请二维码登录令牌
    const exportRes = await childClient.invoke(
      new Api.auth.ExportLoginToken({
        apiId: req.apiId,
        apiHash: req.apiHash,
        exceptIds: [],
      }),
    );

    if (!(exportRes instanceof Api.auth.LoginToken)) {
      throw new Error('申请预备槽位登录令牌失败');
    }

    // Step 2: Mother 内部秒级代签 AcceptLoginToken
    const authorization = await motherClient.invoke(
      new Api.auth.AcceptLoginToken({
        token: exportRes.token,
      }),
    );

    // Step 3: Child 再次调用 ExportLoginToken 完成确认（处理跨 DC 迁移与 2FA）
    let confirmRes: Api.auth.TypeLoginToken;
    try {
      confirmRes = await childClient.invoke(
        new Api.auth.ExportLoginToken({
          apiId: req.apiId,
          apiHash: req.apiHash,
          exceptIds: [],
        }),
      );
    } catch (err) {
      const code = String((err as { errorMessage?: string })?.errorMessage ?? '');
      if (code.includes('SESSION_PASSWORD_NEEDED')) {
        if (!req.twoFaPassword) {
          throw new Error('该账号开启了两步验证密码 (2FA)，请输入两步验证密码以派生预备槽位');
        }
        const pwdInfo = await childClient.invoke(new Api.account.GetPassword());
        const srpCheck = await computeCheck(pwdInfo, req.twoFaPassword);
        await childClient.invoke(new Api.auth.CheckPassword({ password: srpCheck }));
        confirmRes = new Api.auth.LoginTokenSuccess({
          authorization: new Api.auth.Authorization({
            user: new Api.UserEmpty({ id: returnBigInt(0) }),
          }),
        });
      } else {
        throw err;
      }
    }

    if (confirmRes instanceof Api.auth.LoginTokenMigrateTo) {
      await childClient._switchDC(confirmRes.dcId);
      await childClient.invoke(
        new Api.auth.ImportLoginToken({
          token: confirmRes.token,
        }),
      );
    }

    // Step 5: Mother 立即确认新设备（消除 Unconfirmed 状态）
    let confirmedOfficial = false;
    if (authorization instanceof Api.Authorization && authorization.hash) {
      try {
        await motherClient.invoke(
          new Api.account.ChangeAuthorizationSettings({
            hash: authorization.hash,
            confirmed: true,
          }),
        );
        confirmedOfficial = true;
      } catch {
        // best-effort confirmation
      }
    }

    const savedSession = (childClient.session as StringSession).save();
    const dcId = childClient.session.dcId;
    return {
      ok: true,
      session: savedSession,
      confirmedOfficial,
      dcId,
      createdAtMs: Date.now(),
    };
  } finally {
    try {
      await childClient.disconnect();
    } catch {
      // ignore disconnect error
    }
  }
}
