// 必须最先求值：GramJS 在模块初始化阶段就使用 Buffer。
import './polyfills';
import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { StringSession } from 'telegram/sessions';
import type { TgCommand, TgEvent, TgInitialUser } from './protocol';
import { renderQrDataUrl } from './qr';

const CANCELED = 'AUTH_USER_CANCEL';

type Waiter = { resolve: (value: string) => void; reject: (error: Error) => void };

let client: TelegramClient | null = null;
let waiters = new Map<string, Waiter>();

const emit = (event: TgEvent) => self.postMessage(event);
const base64Url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

function toUser(user: { id: unknown; username?: string; firstName?: string; lastName?: string; phone?: string; premium?: boolean }, dcId?: number): TgInitialUser {
  return { id: String(user.id), username: user.username, firstName: user.firstName, lastName: user.lastName, phone: user.phone, premium: user.premium, dcId };
}

/** 挂起式等待主线程提交输入；cancel 时统一 reject，避免协程永久悬挂。 */
function waitFor(stage: string): Promise<string> {
  return new Promise<string>((resolve, reject) => { waiters.set(stage, { resolve, reject }); });
}

function resolveWaiter(stage: string, value: string) {
  const waiter = waiters.get(stage);
  waiters.delete(stage);
  waiter?.resolve(value);
}

async function teardown() {
  waiters.forEach(({ reject }) => reject(new Error(CANCELED)));
  waiters = new Map();
  const current = client;
  client = null;
  try { await current?.disconnect(); } catch { /* 断开失败不影响本地状态清理 */ }
}

function createClient(apiId: number, apiHash: string) {
  return new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
    useWSS: true,
    deviceModel: 'Lattice Archive',
    systemVersion: 'Web',
    appVersion: '2.0.0',
  });
}

async function finishAuthorization(telegram: TelegramClient, user: TgInitialUser) {
  emit({ t: 'authorized', user, session: (telegram.session as StringSession).save() });
  emit({ t: 'loginStage', stage: 'done' });
}

self.addEventListener('message', (event: MessageEvent<TgCommand>) => { void handle(event.data); });

async function handle(command: TgCommand) {
  try {
    if (command.t === 'init') { emit({ t: 'ready' }); return; }
    if (command.t === 'destroy') { await teardown(); return; }
    if (command.t === 'cancel') { await teardown(); return; }
    if (command.t === 'submit') { resolveWaiter(command.stage, command.value); return; }

    if (command.t === 'validateApp') {
      const startedAt = performance.now();
      const probe = createClient(command.apiId, command.apiHash);
      try {
        await probe.connect();
        // help.getConfig / help.getNearestDc 都不校验 api_hash（initConnection 只带 api_id），
        // 任何垃圾 api_hash 都能「验证通过」。只有 auth.* 系列才会核对这一对凭据，
        // 所以这里必须调一次 exportLoginToken 才能真正验证配对关系。
        await probe.invoke(new Api.auth.ExportLoginToken({ apiId: command.apiId, apiHash: command.apiHash, exceptIds: [] }));
        const nearest = await probe.invoke(new Api.help.GetNearestDc());
        emit({ t: 'validationReport', requestId: command.requestId, report: { dcId: nearest.thisDc, country: nearest.country, latencyMs: Math.round(performance.now() - startedAt), layer: undefined } });
      } finally {
        try { await probe.disconnect(); } catch { /* 已断开 */ }
      }
      return;
    }

    if (command.t === 'beginPhoneLogin') {
      await teardown();
      client = createClient(command.apiId, command.apiHash);
      await client.start({
        phoneNumber: async () => { emit({ t: 'loginStage', stage: 'phone' }); return waitFor('phone'); },
        phoneCode: async () => { emit({ t: 'loginStage', stage: 'code' }); return waitFor('code'); },
        password: async () => { emit({ t: 'loginStage', stage: 'password' }); return waitFor('password'); },
        onError: (error) => { emit({ t: 'error', message: error.message, code: (error as Error & { errorMessage?: string }).errorMessage }); },
      });
      const me = await client.getMe();
      await finishAuthorization(client, toUser(me, client.session.dcId));
      return;
    }

    if (command.t === 'beginQrLogin') {
      await teardown();
      client = createClient(command.apiId, command.apiHash);
      // signInUserWithQrCode 不会自行建连（只有 start() 会），必须显式 connect。
      await client.connect();
      const me = await client.signInUserWithQrCode({ apiId: command.apiId, apiHash: command.apiHash }, {
        qrCode: async ({ token, expires }) => {
          const uri = `tg://login?token=${base64Url(token)}`;
          emit({ t: 'loginStage', stage: 'qr' });
          emit({ t: 'qr', token: uri, image: renderQrDataUrl(uri), expires });
        },
        password: async () => { emit({ t: 'loginStage', stage: 'password' }); return waitFor('password'); },
        onError: (error) => { emit({ t: 'error', message: error.message, code: (error as Error & { errorMessage?: string }).errorMessage }); },
      });
      await finishAuthorization(client, toUser(me, client.session.dcId));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Telegram 操作失败';
    // 用户主动取消/切换登录方式不是错误，静默丢弃。
    if (message === CANCELED) return;
    emit({ t: 'error', message, code: (error as Error & { errorMessage?: string }).errorMessage });
  }
}
