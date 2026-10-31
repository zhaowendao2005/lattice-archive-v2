// 必须最先求值：GramJS 在模块初始化阶段就使用 Buffer。
import './polyfills';
import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { StringSession } from 'telegram/sessions';
import { LogLevel } from 'telegram/extensions/Logger';
import type { TgCommand, TgEvent, TgInitialUser, TgRestoreFailure } from './protocol';
import { renderQrDataUrl } from './qr';
import { isChatEngineHealthy, runChatRequest, setChatDebug, startChatEngine, stopChatEngine } from './chat/chatService';
import { downloadDocument, downloadDocumentThumb, downloadPhoto, resetMediaState, type CancelToken } from './chat/mediaService';

const CANCELED = 'AUTH_USER_CANCEL';
const PROGRESS_INTERVAL_MS = 250;
/** 进行中的完整文件下载：requestId → 取消令牌。 */
const cancelTokens = new Map<string, CancelToken>();
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** gramJS 的 connect()/invoke() 均无超时；恢复旧会话或验证凭据时服务端可能不回包，必须自行兜底。 */
const RESTORE_TIMEOUT_MS = 20_000;
const VALIDATE_TIMEOUT_MS = 20_000;
const DISCONNECT_TIMEOUT_MS = 5_000;
const TRANSIENT_CONNECTION_CODES = new Set(['CONNECTION_NOT_INITED', 'CONNECTION_TIMEOUT', 'NETWORK_MIGRATE', 'TIMEOUT']);
const AUTH_FATAL_CODES = new Set(['AUTH_KEY_DUPLICATED', 'AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'USER_DEACTIVATED']);

type Waiter = { resolve: (value: string) => void; reject: (error: Error) => void };

let client: TelegramClient | null = null;
/** 登录流程使用独立客户端，未完成授权前绝不打断已在线的 client；关闭弹窗只销毁 loginClient。 */
let loginClient: TelegramClient | null = null;
let loginGeneration = 0;
let authorizedAccountId: string | undefined;
let currentUser: TgInitialUser | undefined;
let waiters = new Map<string, Waiter>();
/** 进行中的登录（含目标账户），用于多标签页重复触发时复用当前二维码而不是重建连接。 */
let loginInFlight: 'qr' | 'phone' | null = null;
let loginTarget: string | undefined;
/** 进行中的会话恢复，用于合并来自 load() 与主标签选举的重复恢复请求。 */
let restoreInFlight: { accountId: string; promise: Promise<void | undefined> } | undefined;
let lastQr: TgEvent | undefined;

function emit(event: TgEvent, transfer: Transferable[] = []) { self.postMessage(event, { transfer }); }
function errorCode(error: unknown) { return String((error as { errorMessage?: string; code?: string })?.errorMessage ?? (error as { code?: string })?.code ?? (error instanceof Error ? error.message : '')).toUpperCase(); }
function isAuthFatal(error: unknown) { const code = errorCode(error); return [...AUTH_FATAL_CODES].some((item) => code.includes(item)); }
function isTransient(error: unknown) { const code = errorCode(error); return [...TRANSIENT_CONNECTION_CODES].some((item) => code.includes(item)) || code.includes('DISCONNECTED'); }
function wait(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }
function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function isTimeout(error: unknown) { return errorCode(error).includes('TIMEOUT'); }

/** 调试开关由主线程在 init 时下发；只打印阶段与 DC 信息，绝不输出 session / auth_key。 */
let debugEnabled = false;
function debugLog(stage: string, detail?: Record<string, unknown>) {
  if (debugEnabled) console.info(`[lattice-tg] ${stage}`, detail ?? '');
}
function applyLogLevel(telegram: TelegramClient) {
  telegram.setLogLevel(debugEnabled ? LogLevel.DEBUG : LogLevel.INFO);
}
function emitConnection(state: Extract<TgEvent, { t: 'connectionState' }>['state'], message?: string) {
  if (authorizedAccountId) emit({ t: 'connectionState', accountId: authorizedAccountId, state, message });
}
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

async function cancelLogin() {
  loginGeneration += 1;
  waiters.forEach(({ reject }) => reject(new Error(CANCELED)));
  waiters = new Map();
  loginInFlight = null;
  loginTarget = undefined;
  lastQr = undefined;
  const pending = loginClient;
  loginClient = null;
  try { if (pending) await withTimeout(pending.disconnect(), DISCONNECT_TIMEOUT_MS, 'DISCONNECT_TIMEOUT'); } catch { /* 忽略取消登录时的断开异常 */ }
}

async function teardownActiveSession() {
  stopChatEngine();
  const stoppedAccountId = authorizedAccountId;
  authorizedAccountId = undefined;
  currentUser = undefined;
  const current = client;
  client = null;
  // 卡死的客户端 disconnect 也可能挂起，限时后直接放弃，避免阻塞后续恢复/登录。
  try { if (current) await withTimeout(current.disconnect(), DISCONNECT_TIMEOUT_MS, 'DISCONNECT_TIMEOUT'); } catch { /* 断开失败不影响本地状态清理 */ }
  return stoppedAccountId;
}

async function teardown() {
  await cancelLogin();
  return teardownActiveSession();
}

async function stopCurrentSession() {
  const accountId = await teardown();
  emit({ t: 'sessionStopped', accountId });
}

async function replaceActiveSessionWith(nextClient: TelegramClient) {
  const previousAccountId = await teardownActiveSession();
  if (previousAccountId) emit({ t: 'accountDisconnected', accountId: previousAccountId });
  client = nextClient;
}

function createClient(apiId: number, apiHash: string, session: StringSession = new StringSession('')) {
  const telegram = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
    useWSS: true,
    deviceModel: 'Lattice Archive',
    systemVersion: 'Web',
    appVersion: '2.0.0',
  });
  applyLogLevel(telegram);
  return telegram;
}

/**
 * 恢复失败归因：
 * 只有 Telegram 服务端明确返回 AUTH_KEY_UNREGISTERED / SESSION_REVOKED 等致命错误码时才判定为 auth-invalid。
 * 连接或握手超时一律归为 network（可自动退避重连），绝不能因网络抖动误删用户本地加密会话。
 */
function classifyRestoreFailure(error: unknown): TgRestoreFailure {
  if (isAuthFatal(error)) return 'auth-invalid';
  if (isTimeout(error) || isTransient(error)) return 'network';
  return 'error';
}

const RESTORE_FAILURE_MESSAGES: Record<TgRestoreFailure, string> = {
  'auth-invalid': '本地 Telegram 会话已失效，请移除本设备后重新添加',
  network: '无法连接 Telegram 服务器，请检查网络',
  error: 'Telegram 会话恢复失败',
};

/**
 * 带瞬时错误重试的 Telegram 调用。
 * markOfflineOnError=false 用于业务 RPC：PEER_ID_INVALID 之类的业务错误不代表连接断开，不能把设备标为离线。
 */
async function withTelegramConnection<T>(operation: () => Promise<T>, markOfflineOnError = true): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      if (!client) throw new Error('DISCONNECTED');
      if (attempt > 0) {
        emitConnection('reconnecting', 'Telegram 连接短暂中断，正在重连…');
        await client.connect();
      }
      const result = await operation();
      if (authorizedAccountId) emitConnection('online');
      return result;
    } catch (error) {
      lastError = error;
      if (isAuthFatal(error)) {
        emitConnection('auth-expired', 'Telegram 授权已失效，请重新添加设备');
        throw error;
      }
      if (!isTransient(error) || attempt === RETRY_DELAYS_MS.length) {
        if (markOfflineOnError || isTransient(error)) emitConnection('offline', 'Telegram 连接暂时不可用');
        throw error;
      }
      emitConnection('reconnecting', 'Telegram 连接短暂中断，正在重连…');
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Telegram 连接失败');
}

/** 授权完成后挂载聊天更新引擎；更新批次与连接变化都只代表当前持有连接的账户。 */
function attachChatEngine(telegram: TelegramClient, accountId: string) {
  resetMediaState();
  // 账户切换：上一账户仍在进行的完整文件下载一律中断。
  cancelTokens.forEach((token) => { token.canceled = true; });
  startChatEngine(
    telegram,
    accountId,
    accountId,
    (owner, updates, state) => { if (client === telegram) emit({ t: 'chatUpdates', accountId: owner, updates, state }); },
    (state, message) => { if (client === telegram) emitConnection(state, message); },
  );
}

async function handleChatRequest(command: Extract<TgCommand, { t: 'chatRequest' }>) {
  try {
    if (!client || authorizedAccountId !== command.accountId) throw Object.assign(new Error('Telegram 账户尚未连接'), { code: 'TG_NOT_CONNECTED' });
    const telegram = client;
    const request = command.request;
    if (request.method === 'getPhoto' || request.method === 'getDocumentThumb') {
      // 媒体下载走独立 DC 连接，失败不能触发主连接重连或把账户标为离线；重试交给主线程退避。
      const file = request.method === 'getPhoto'
        ? await downloadPhoto(telegram, request.peer, request.messageId, request.photo, request.size)
        : await downloadDocumentThumb(telegram, request.peer, request.messageId, request.document, request.size);
      emit({ t: 'chatResponse', requestId: command.requestId, ok: true, data: file }, [file.bytes]);
      return;
    }
    if (request.method === 'getDocument') {
      const token: CancelToken = { canceled: false };
      cancelTokens.set(command.requestId, token);
      let lastEmit = 0;
      let lastLoaded = 0;
      try {
        const file = await downloadDocument(telegram, request.peer, request.messageId, request.document, request.size, request.mimeType, token, (loaded, total) => {
          // 节流：至少间隔 250 ms 或增长 2%，避免高频事件挤占主线程。
          const now = Date.now();
          if (loaded < total && now - lastEmit < PROGRESS_INTERVAL_MS && loaded - lastLoaded < total * 0.02) return;
          lastEmit = now;
          lastLoaded = loaded;
          emit({ t: 'chatProgress', requestId: command.requestId, loaded, total });
        });
        emit({ t: 'chatResponse', requestId: command.requestId, ok: true, data: file }, [file.bytes]);
      } finally {
        cancelTokens.delete(command.requestId);
      }
      return;
    }
    const data = await withTelegramConnection(() => runChatRequest(telegram, request), false);
    emit({ t: 'chatResponse', requestId: command.requestId, ok: true, data });
  } catch (error) {
    emit({ t: 'chatResponse', requestId: command.requestId, ok: false, code: errorCode(error) || 'TG_REQUEST_FAILED', message: error instanceof Error ? error.message : 'Telegram 请求失败' });
  }
}
async function finishAuthorization(telegram: TelegramClient, user: TgInitialUser, expectedUserId?: string) {
  if (expectedUserId && user.id !== expectedUserId) {
    try { await telegram.invoke(new Api.auth.LogOut()); } catch { /* mismatch session cleanup is best effort */ }
    await cancelLogin();
    emit({ t: 'error', code: 'TG_ACCOUNT_MISMATCH', message: '登录的 Telegram 账号与所选账号不一致，已取消添加设备' });
    return false;
  }

  if (loginClient === telegram) loginClient = null;
  loginInFlight = null;
  loginTarget = undefined;
  lastQr = undefined;
  await replaceActiveSessionWith(telegram);
  authorizedAccountId = user.id;
  currentUser = user;
  attachChatEngine(telegram, user.id);
  emit({ t: 'authorized', user, session: (telegram.session as StringSession).save() });
  emit({ t: 'loginStage', stage: 'done' });
  return true;
}

self.addEventListener('message', (event: MessageEvent<TgCommand>) => { void handle(event.data); });

async function handle(command: TgCommand) {
  try {
    if (command.t === 'init') { debugEnabled = command.debug === true; setChatDebug(debugEnabled); emit({ t: 'ready' }); return; }
    if (command.t === 'cancel') {
      await cancelLogin();
      return;
    }
    if (command.t === 'disconnectSession' || command.t === 'destroy') {
      await stopCurrentSession();
      return;
    }
    if (command.t === 'submit') { resolveWaiter(command.stage, command.value); return; }
    if (command.t === 'chatRequest') { await handleChatRequest(command); return; }
    if (command.t === 'chatCancel') { const token = cancelTokens.get(command.requestId); if (token) token.canceled = true; return; }
    if (command.t === 'checkConnection') {
      let online = false;
      if (client && authorizedAccountId === command.accountId) {
        if (isChatEngineHealthy(command.accountId)) {
          online = true;
        } else {
          try {
            const me = await withTelegramConnection(() => client!.getMe());
            online = String(me.id) === command.accountId;
          } catch { /* 连接探测失败由 connectionState 事件表达，避免伪造在线状态。 */ }
        }
      }
      emit({ t: 'connectionCheck', requestId: command.requestId, online });
      return;
    }

    if (command.t === 'validateApp') {
      const probe = createClient(command.apiId, command.apiHash);
      try {
        await withTimeout(probe.connect(), VALIDATE_TIMEOUT_MS, 'VALIDATE_CONNECT_TIMEOUT');
        // help.getConfig / help.getNearestDc 都不校验 api_hash（initConnection 只带 api_id），
        // 只有 auth.* 系列才会核对这一对凭据，所以必须调一次 exportLoginToken 真正验证配对关系。
        await withTimeout(
          probe.invoke(new Api.auth.ExportLoginToken({ apiId: command.apiId, apiHash: command.apiHash, exceptIds: [] })),
          VALIDATE_TIMEOUT_MS,
          'VALIDATE_AUTH_TIMEOUT',
        );
        // 仅测量建连完成后的单次 RPC 真实网络 RTT，不把首次 2048-bit DH 密钥协商算入延迟。
        const rpcStartedAt = performance.now();
        const nearest = await withTimeout(probe.invoke(new Api.help.GetNearestDc()), VALIDATE_TIMEOUT_MS, 'VALIDATE_DC_TIMEOUT');
        const latencyMs = Math.max(1, Math.round(performance.now() - rpcStartedAt));
        emit({ t: 'validationReport', requestId: command.requestId, ok: true, report: { dcId: nearest.thisDc, country: nearest.country, latencyMs, layer: undefined } });
      } catch (error) {
        const code = errorCode(error) || 'VALIDATE_FAILED';
        const message = code.includes('API_ID_INVALID')
          ? '应用凭据无效（api_id 与 api_hash 不匹配）'
          : code.includes('TIMEOUT')
            ? '连接 Telegram 验证超时，请检查网络后重试'
            : (error instanceof Error ? error.message : '验证应用凭据失败');
        emit({ t: 'validationReport', requestId: command.requestId, ok: false, code, message });
      } finally {
        try { await withTimeout(probe.disconnect(), DISCONNECT_TIMEOUT_MS, 'DISCONNECT_TIMEOUT'); } catch { /* 已断开 */ }
      }
      return;
    }

    if (command.t === 'restoreSession') {
      if (client && authorizedAccountId === command.accountId && currentUser) {
        emit({ t: 'restored', user: currentUser });
        return;
      }
      // 同一账户的恢复正在进行时直接复用，绝不能 teardown 正在握手的客户端再重建：
      // 同一 auth_key 并发建连会被 Telegram 判为 AUTH_KEY_DUPLICATED，且 getMe 会卡死在被断开的连接上。
      if (restoreInFlight && restoreInFlight.accountId === command.accountId) { await restoreInFlight.promise; return; }
      const run = (async () => {
        await teardownActiveSession();
        const saved = new StringSession(command.session);
        debugLog('restore:start', { dc: saved.dcId, server: saved.serverAddress, port: saved.port });
        const restored = createClient(command.apiId, command.apiHash, saved);
        client = restored;
        try {
          await withTimeout(restored.connect(), RESTORE_TIMEOUT_MS, 'RESTORE_CONNECT_TIMEOUT');
          debugLog('restore:connected');
          const me = await withTimeout(restored.getMe(), RESTORE_TIMEOUT_MS, 'RESTORE_GETME_TIMEOUT');
          debugLog('restore:getMe:ok');
          const user = toUser(me, restored.session.dcId);
          if (user.id !== command.accountId) {
            await stopCurrentSession();
            emit({ t: 'error', code: 'TG_SESSION_ACCOUNT_MISMATCH', message: '本地会话与账户记录不一致，已停止恢复' });
            return;
          }
          authorizedAccountId = user.id;
          currentUser = user;
          attachChatEngine(restored, user.id);
          emit({ t: 'restored', user });
        } catch (error) {
          debugLog('restore:failed', { code: errorCode(error) });
          // 只清理本次创建的客户端；期间若已被新的登录替换则不误伤。
          if (client === restored) await teardownActiveSession();
          else try { await withTimeout(restored.disconnect(), DISCONNECT_TIMEOUT_MS, 'DISCONNECT_TIMEOUT'); } catch { /* 已断开 */ }
          const reason = classifyRestoreFailure(error);
          emit({ t: 'restoreFailed', accountId: command.accountId, reason, message: RESTORE_FAILURE_MESSAGES[reason] });
        }
      })();
      restoreInFlight = { accountId: command.accountId, promise: run.catch(() => undefined) };
      try { await run; } finally { restoreInFlight = undefined; }
      return;
    }

    if (command.t === 'beginPhoneLogin') {
      if (loginInFlight === 'phone' && loginTarget === command.expectedUserId) return;
      await cancelLogin();
      const generation = ++loginGeneration;
      loginInFlight = 'phone';
      loginTarget = command.expectedUserId;
      const pending = createClient(command.apiId, command.apiHash);
      loginClient = pending;
      await pending.start({
        phoneNumber: async () => { emit({ t: 'loginStage', stage: 'phone' }); return waitFor('phone'); },
        phoneCode: async () => { emit({ t: 'loginStage', stage: 'code' }); return waitFor('code'); },
        password: async () => { emit({ t: 'loginStage', stage: 'password' }); return waitFor('password'); },
        onError: (error) => { emit({ t: 'error', message: error.message, code: (error as Error & { errorMessage?: string }).errorMessage }); },
      });
      if (generation !== loginGeneration || loginClient !== pending) return;
      const me = await pending.getMe();
      await finishAuthorization(pending, toUser(me, pending.session.dcId), command.expectedUserId);
      return;
    }

    if (command.t === 'beginQrLogin') {
      // 另一个标签页对同一目标重复发起时，直接重发当前二维码，不重建连接。
      if (loginInFlight === 'qr' && loginTarget === command.expectedUserId) {
        if (lastQr) emit(lastQr);
        return;
      }
      await cancelLogin();
      const generation = ++loginGeneration;
      loginInFlight = 'qr';
      loginTarget = command.expectedUserId;
      const pending = createClient(command.apiId, command.apiHash);
      loginClient = pending;
      // signInUserWithQrCode 不会自行建连（只有 start() 会），必须显式 connect。
      await pending.connect();
      if (generation !== loginGeneration || loginClient !== pending) return;
      const me = await pending.signInUserWithQrCode({ apiId: command.apiId, apiHash: command.apiHash }, {
        qrCode: async ({ token, expires }) => {
          if (generation !== loginGeneration) return;
          const uri = `tg://login?token=${base64Url(token)}`;
          const qrEvent: TgEvent = { t: 'qr', token: uri, image: renderQrDataUrl(uri), expires };
          lastQr = qrEvent;
          emit({ t: 'loginStage', stage: 'qr' });
          emit(qrEvent);
        },
        password: async () => { emit({ t: 'loginStage', stage: 'password' }); return waitFor('password'); },
        onError: (error) => { emit({ t: 'error', message: error.message, code: (error as Error & { errorMessage?: string }).errorMessage }); },
      });
      if (generation !== loginGeneration || loginClient !== pending) return;
      await finishAuthorization(pending, toUser(me, pending.session.dcId), command.expectedUserId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Telegram 操作失败';
    // 用户主动取消/切换登录方式不是错误，静默丢弃。
    if (message === CANCELED) return;
    emit({ t: 'error', message, code: (error as Error & { errorMessage?: string }).errorMessage });
  }
}
