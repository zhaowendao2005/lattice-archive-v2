/**
 * ============================================================================
 * TelegramRuntime：账号运行时与 AccountSessionBus 连接生命周期（local Worker）
 * ============================================================================
 * - 每个 Telegram 账号只有一个 TelegramClient：P0 前台在线会话 + 最多若干 P1 温池会话；
 * - 登录（二维码 / 手机号）、恢复、前台切换、断开、凭据校验在此管理；登录中的临时客户端完成授权后合并到单一运行时；
 * - 业务请求一律经 BusRouter → RequestScheduler → 业务总线，本文件不承载任何 Chat / 媒体 / 搜索业务；
 * - session 字符串（≈账户控制权）只存在于本线程与本地加密仓库，绝不经过任何远端。
 *
 * 通信协议：主线程 postMessage(TgCommand) → tg.worker.ts → handle() 分发 → 回传 TgEvent（见 ../../protocol.ts）。
 */
// 必须最先求值：GramJS 在模块初始化阶段就使用 Buffer。
import '../../polyfills';
import { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { StringSession } from 'telegram/sessions';
import { LogLevel } from 'telegram/extensions/Logger';
import type { TgCommand, TgEvent, TgInitialUser, TgRestoreFailure } from '../../protocol';
import { renderQrDataUrl } from '../../qr';
import { isChatEngineHealthy, setChatDebug, startChatEngine, stopChatEngine } from './updateEngine';
import { emitLocalSpan } from '../telemetry/localSpans';
import { resetMediaState } from './entityReferenceStore';
import { applyConcurrencyConfig, closeScheduler, onAccountFatal, reviveScheduler } from './requestScheduler';
import { cancelAllBusRequests, cancelBusRequest, routeBusRequest, toBusError, type BusRuntime } from './busRouter';
import { parseSessionFiles, parseSessionTextLines } from '../../sessionBatchParser';
import { configureBusMonitor, forgetAccountConnection, recordConnectionState, resyncMonitor, subscribeMonitor, unsubscribeMonitor } from '../telemetry/busMonitor';

const CANCELED = 'AUTH_USER_CANCEL';
// 文件下载进度向主线程汇报的最小间隔（毫秒），避免高频 postMessage 挤占主线程
const PROGRESS_INTERVAL_MS = 250;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]; // 指数退避：最多重试 5 次
/** gramJS 的 connect()/invoke() 均无超时；恢复旧会话或验证凭据时服务端可能不回包，必须自行兜底。 */
const RESTORE_TIMEOUT_MS = 20_000;
const VALIDATE_TIMEOUT_MS = 20_000;
const DISCONNECT_TIMEOUT_MS = 5_000;
// 瞬时错误：可重试（网络抖动、连接未初始化、迁移 DC）
const TRANSIENT_CONNECTION_CODES = new Set(['CONNECTION_NOT_INITED', 'CONNECTION_TIMEOUT', 'NETWORK_MIGRATE', 'TIMEOUT']);
// 致命错误：会话已废，只能重新登录（不能再重试）
const AUTH_FATAL_CODES = new Set(['AUTH_KEY_DUPLICATED', 'AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'USER_DEACTIVATED']);
/** 登录过程中挂起的「等主线程输入」的等候者（手机号 / 验证码 / 二步密码） */
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

/**
 * Phase 2: 多实例客户端温池 (AccountClientPool)
 * 支持 1 个 P0 前台焦点账号 + 最多 2 个 P1 后台温驻留账号同时保持 WebSocket 在线，
 * 实现 <16ms 零握手秒级切号与多账号并发聚合搜索/机器人收割。
 */
const MAX_WARM_POOL_SIZE = 3;
interface WarmPoolEntry {
  client: TelegramClient;
  user: TgInitialUser;
  lastUsedAt: number;
}
const warmClientPool = new Map<string, WarmPoolEntry>();

function emitWarmPoolState() {
  const accounts = Array.from(warmClientPool.entries()).map(([accountId, entry]) => ({
    accountId,
    tier: (accountId === authorizedAccountId ? 'P0' : 'P1') as 'P0' | 'P1' | 'P2',
    connected: Boolean(entry.client.connected),
  }));
  emit({
    t: 'warmPoolState',
    foregroundAccountId: authorizedAccountId ?? null,
    accounts,
  });
}

async function evictColdestWarmClientIfNeeded(excludeAccountId?: string) {
  if (warmClientPool.size <= MAX_WARM_POOL_SIZE) return;
  let oldestKey: string | null = null;
  let oldestTime = Number.POSITIVE_INFINITY;
  for (const [accId, entry] of warmClientPool.entries()) {
    if (accId === authorizedAccountId || accId === excludeAccountId) continue;
    if (entry.lastUsedAt < oldestTime) {
      oldestTime = entry.lastUsedAt;
      oldestKey = accId;
    }
  }
  if (oldestKey) {
    const victim = warmClientPool.get(oldestKey);
    warmClientPool.delete(oldestKey);
    closeScheduler(oldestKey);
    if (victim) {
      try {
        await withTimeout(victim.client.disconnect(), DISCONNECT_TIMEOUT_MS, 'DISCONNECT_TIMEOUT');
      } catch {
        // ignore
      }
    }
  }
}

/** 向主线程发消息；transfer 用于零拷贝移交 ArrayBuffer（大文件必须走它） */
function emit(event: TgEvent, transfer: Transferable[] = []) {
  if (event.t === 'connectionState') recordConnectionState(event.accountId, event.state, event.message);
  if (event.t === 'accountDisconnected') forgetAccountConnection(event.accountId);
  self.postMessage(event, { transfer });
}

// 运行监控：帧只在有订阅时由 BusMonitor 定时生成；账号来源为前台 P0 + 温池 P1。
configureBusMonitor({
  sink: (subscriberId, frame) => emit({ t: 'monitorFrame', subscriberId, frame }),
  accounts: () => {
    const list: { accountId: string; tier: 'P0' | 'P1'; dcId?: number }[] = [];
    if (authorizedAccountId) list.push({ accountId: authorizedAccountId, tier: 'P0', dcId: currentUser?.dcId });
    for (const [accountId, entry] of warmClientPool) if (accountId !== authorizedAccountId) list.push({ accountId, tier: 'P1', dcId: entry.user.dcId });
    return list;
  },
});
function errorCode(error: unknown) { return String((error as { errorMessage?: string; code?: string })?.errorMessage ?? (error as { code?: string })?.code ?? (error instanceof Error ? error.message : '')).toUpperCase(); }
function isAuthFatal(error: unknown) { const code = errorCode(error); return [...AUTH_FATAL_CODES].some((item) => code.includes(item)); }
function isTransient(error: unknown) {
  const code = errorCode(error);
  if (code.includes('BOT_RESPONSE_TIMEOUT')) return false;
  return [...TRANSIENT_CONNECTION_CODES].some((item) => code.includes(item)) || code.includes('DISCONNECTED');
}
function wait(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }
/** 统一超时包装：超时后抛一个带 code 的错误，方便上层归因 */
function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function isTimeout(error: unknown) {
  const code = errorCode(error);
  if (code.includes('BOT_RESPONSE_TIMEOUT')) return false;
  return code.includes('TIMEOUT');
}

/** 调试开关由主线程在 init 或 setDebug 时下发；只回传结构化阶段与 DC 信息，绝不输出 session / auth_key。 */
let debugEnabled = false;
function syncDebugState(enabled: boolean) {
  debugEnabled = enabled;
  setChatDebug(enabled, (entry) => emit({ t: 'debugLog', entry }));
  if (client) applyLogLevel(client);
  for (const [, warm] of warmClientPool) applyLogLevel(warm.client);
}
function debugLog(stage: string, detail?: Record<string, unknown>) {
  if (!debugEnabled) return;
  emitLocalSpan({
    domain: 'tg.worker',
    action: stage,
    level: stage.includes('failed') || stage.includes('error') ? 'ERROR' : 'INFO',
    tags: detail as Record<string, string | number | boolean | undefined>,
  });
}
function applyLogLevel(telegram: TelegramClient) {
  telegram.setLogLevel(debugEnabled ? LogLevel.DEBUG : LogLevel.INFO);
}
const lastEmittedConnection = new Map<string, { state: Extract<TgEvent, { t: 'connectionState' }>['state']; message?: string }>();
function emitConnection(state: Extract<TgEvent, { t: 'connectionState' }>['state'], message?: string) {
  if (!authorizedAccountId) return;
  const prev = lastEmittedConnection.get(authorizedAccountId);
  if (prev && prev.state === state && (prev.message ?? '') === (message ?? '')) return;
  lastEmittedConnection.set(authorizedAccountId, { state, message });
  emit({ t: 'connectionState', accountId: authorizedAccountId, state, message });
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

/**
 * 取消登录：序号 +1 让所有在飞的异步回调失效，并拒掉所有等候者。
 * 特别注意：只断开 loginClient，绝不动在线的 client。
 */
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

/** 断开并清空当前在线会话（解绑、销毁全部时使用） */
async function teardownActiveSession(preserveInWarmPool = false) {
  stopChatEngine();
  const stoppedAccountId = authorizedAccountId;
  const current = client;
  if (preserveInWarmPool && stoppedAccountId && current && currentUser) {
    warmClientPool.set(stoppedAccountId, {
      client: current,
      user: currentUser,
      lastUsedAt: Date.now(),
    });
    authorizedAccountId = undefined;
    currentUser = undefined;
    client = null;
    await evictColdestWarmClientIfNeeded();
    return stoppedAccountId;
  }
  if (stoppedAccountId) {
    warmClientPool.delete(stoppedAccountId);
    closeScheduler(stoppedAccountId);
  }
  authorizedAccountId = undefined;
  currentUser = undefined;
  client = null;
  try { if (current) await withTimeout(current.disconnect(), DISCONNECT_TIMEOUT_MS, 'DISCONNECT_TIMEOUT'); } catch { /* 断开失败不影响本地状态清理 */ }
  emitWarmPoolState();
  return stoppedAccountId;
}

/** 完整拆除：先取消登录，再断开所有温池与在线会话 */
async function teardown() {
  await cancelLogin();
  for (const [accountId, entry] of warmClientPool) {
    closeScheduler(accountId);
    try { await withTimeout(entry.client.disconnect(), DISCONNECT_TIMEOUT_MS, 'DISCONNECT_TIMEOUT'); } catch { /* ignore */ }
  }
  warmClientPool.clear();
  return teardownActiveSession(false);
}

/** 停止当前会话并通知主线程（sessionStopped 携带被停掉的 accountId） */
async function stopCurrentSession() {
  const accountId = await teardown();
  emit({ t: 'sessionStopped', accountId });
}

/** 用新客户端替换当前前台会话（旧会话保留在温池以支持秒级切回） */
async function replaceActiveSessionWith(nextClient: TelegramClient) {
  await teardownActiveSession(true);
  client = nextClient;
}

/** 创建 GramJS 客户端；传入空 StringSession 即为「尚未登录」 */
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
  // 账户切换：上一账户仍在进行的总线请求一律中断；重新授权后解除会话失效停摆。
  cancelAllBusRequests();
  reviveScheduler(accountId);
  startChatEngine(
    telegram,
    accountId,
    accountId,
    (owner, updates, state) => { if (client === telegram) emit({ t: 'chatUpdates', accountId: owner, updates, state }); },
    (state, message) => { if (client === telegram) emitConnection(state, message); },
  );
}

/** 业务总线运行环境：账号客户端查找（P0 前台或 P1 温池）、连接重试、进度回传。 */
const progressThrottle = new Map<string, { at: number; loaded: number }>();
const busRuntime: BusRuntime = {
  clientFor(accountId) {
    if (client && authorizedAccountId === accountId) return client;
    const warm = warmClientPool.get(accountId);
    if (!warm) return null;
    warm.lastUsedAt = Date.now();
    return warm.client;
  },
  // 前台账号沿用自动重连；温池账号只执行一次（其连接状态不影响前台指示）。
  withConnection(accountId, operation) {
    return authorizedAccountId === accountId ? withTelegramConnection(operation, false) : operation();
  },
  progress(requestId, loaded, total) {
    const now = Date.now();
    const last = progressThrottle.get(requestId);
    if (last && loaded < total && now - last.at < PROGRESS_INTERVAL_MS && loaded - last.loaded < total * 0.02) return;
    progressThrottle.set(requestId, { at: now, loaded });
    emit({ t: 'busProgress', requestId, loaded, total });
  },
};

/** 会话失效（AUTH_KEY_DUPLICATED 等）：调度器已停止该账号全部队列，这里广播授权失效。 */
onAccountFatal((accountId, code) => {
  emit({ t: 'connectionState', accountId, state: 'auth-expired', message: `Telegram 授权已失效（${code}），请重新添加设备` });
});

async function handleSessionBatchParse(command: Extract<TgCommand, { t: 'sessionBatchParse' }>) {
  try {
    const items = command.request.mode === 'text'
      ? parseSessionTextLines(command.request.rawText)
      : await parseSessionFiles(command.request.files.map((file) => new File([file.bytes], file.name, { type: file.type, lastModified: file.lastModified })));
    emit({ t: 'sessionBatchParsed', requestId: command.requestId, ok: true, items });
  } catch (error) {
    emit({ t: 'sessionBatchParsed', requestId: command.requestId, ok: false, message: error instanceof Error ? error.message : '批量解析失败' });
  }
}

async function handleBusRequest(command: Extract<TgCommand, { t: 'busRequest' }>) {
  const { requestId } = command.context;
  try {
    const data = await routeBusRequest(busRuntime, command.bus, command.op as never, command.input as never, command.context);
    const bytes = (data as { bytes?: unknown } | null)?.bytes;
    emit({ t: 'busResponse', requestId, ok: true, data }, bytes instanceof ArrayBuffer ? [bytes] : []);
  } catch (error) {
    emit({ t: 'busResponse', requestId, ok: false, error: toBusError(error) });
  } finally {
    progressThrottle.delete(requestId);
  }
}

/**
 * 授权成功后的收尾：校验目标账户 → 替换在线会话 → 挂载聊天引擎 → 回传 session。
 * expectedUserId 用于「给已有账户重新授权」场景，防止扫了别人的码导致串号。
 */
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


/** 命令分发器（switch 的替身：用提前 return 保持每个分支扁平） */
export async function handle(command: TgCommand) {
  try {
    if (command.t === 'init') { syncDebugState(command.debug === true); applyConcurrencyConfig(command.concurrency); emit({ t: 'ready' }); return; }
    if (command.t === 'setConcurrency') { applyConcurrencyConfig(command.config); return; }
    if (command.t === 'monitorSubscribe') { subscribeMonitor(command.subscriberId, command.hz); return; }
    if (command.t === 'monitorUnsubscribe') { unsubscribeMonitor(command.subscriberId); return; }
    if (command.t === 'monitorResync') { resyncMonitor(command.subscriberId); return; }
    if (command.t === 'setDebug') { syncDebugState(command.enabled); debugLog('debug:toggled', { enabled: command.enabled }); return; }
    if (command.t === 'cancel') {
      await cancelLogin();
      return;
    }
    if (command.t === 'disconnectSession' || command.t === 'destroy') {
      await stopCurrentSession();
      return;
    }
    if (command.t === 'submit') { resolveWaiter(command.stage, command.value); return; }
    if (command.t === 'busRequest') { await handleBusRequest(command); return; }
    if (command.t === 'busCancel') { cancelBusRequest(command.requestId); return; }
    if (command.t === 'sessionBatchParse') { await handleSessionBatchParse(command); return; }
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
        emitWarmPoolState();
        return;
      }
      // 若目标账号已在温池 (warmClientPool) 中在线，直接 <16ms 零握手提升为 P0 前台焦点账号！
      const warmHit = warmClientPool.get(command.accountId);
      if (warmHit && warmHit.client.connected) {
        await teardownActiveSession(true);
        client = warmHit.client;
        authorizedAccountId = warmHit.user.id;
        currentUser = warmHit.user;
        warmHit.lastUsedAt = Date.now();
        attachChatEngine(warmHit.client, warmHit.user.id);
        emit({ t: 'restored', user: warmHit.user });
        emitConnection('online');
        emitWarmPoolState();
        return;
      }

      if (restoreInFlight && restoreInFlight.accountId === command.accountId) { await restoreInFlight.promise; return; }
      const run = (async () => {
        await teardownActiveSession(true);
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
          warmClientPool.set(user.id, { client: restored, user, lastUsedAt: Date.now() });
          reviveScheduler(user.id);
          await evictColdestWarmClientIfNeeded(user.id);
          attachChatEngine(restored, user.id);
          emit({ t: 'restored', user });
          emitWarmPoolState();
        } catch (error) {
          debugLog('restore:failed', { code: errorCode(error) });
          if (client === restored) await teardownActiveSession(false);
          else try { await withTimeout(restored.disconnect(), DISCONNECT_TIMEOUT_MS, 'DISCONNECT_TIMEOUT'); } catch { /* 已断开 */ }
          const reason = classifyRestoreFailure(error);
          emit({ t: 'restoreFailed', accountId: command.accountId, reason, message: RESTORE_FAILURE_MESSAGES[reason] });
        }
      })();
      restoreInFlight = { accountId: command.accountId, promise: run.catch(() => undefined) };
      try { await run; } finally { restoreInFlight = undefined; }
      return;
    }

    if (command.t === 'restoreWarmAccount') {
      if (warmClientPool.has(command.accountId)) {
        emitWarmPoolState();
        return;
      }
      try {
        const saved = new StringSession(command.session);
        const warmClient = createClient(command.apiId, command.apiHash, saved);
        await withTimeout(warmClient.connect(), RESTORE_TIMEOUT_MS, 'RESTORE_CONNECT_TIMEOUT');
        const me = await withTimeout(warmClient.getMe(), RESTORE_TIMEOUT_MS, 'RESTORE_GETME_TIMEOUT');
        const user = toUser(me, warmClient.session.dcId);
        if (user.id === command.accountId) {
          warmClientPool.set(user.id, { client: warmClient, user, lastUsedAt: Date.now() });
          reviveScheduler(user.id);
          await evictColdestWarmClientIfNeeded(user.id);
          emitWarmPoolState();
        } else {
          await warmClient.disconnect();
        }
      } catch {
        // 后台温池恢复失败静默忽略，不打断前台 P0 会话
      }
      return;
    }

    if (command.t === 'setForegroundAccount') {
      if (authorizedAccountId === command.accountId && client && currentUser) {
        emit({ t: 'restored', user: currentUser });
        emitWarmPoolState();
        return;
      }
      const warmHit = warmClientPool.get(command.accountId);
      if (warmHit && warmHit.client.connected) {
        await teardownActiveSession(true);
        client = warmHit.client;
        authorizedAccountId = warmHit.user.id;
        currentUser = warmHit.user;
        warmHit.lastUsedAt = Date.now();
        attachChatEngine(warmHit.client, warmHit.user.id);
        emit({ t: 'restored', user: warmHit.user });
        emitConnection('online');
        emitWarmPoolState();
      }
      return;
    }

    if (command.t === 'disconnectAccount') {
      if (authorizedAccountId === command.accountId) {
        await teardownActiveSession(false);
        emit({ t: 'accountDisconnected', accountId: command.accountId });
      } else {
        const warm = warmClientPool.get(command.accountId);
        warmClientPool.delete(command.accountId);
        closeScheduler(command.accountId);
        if (warm) {
          try { await withTimeout(warm.client.disconnect(), DISCONNECT_TIMEOUT_MS, 'DISCONNECT_TIMEOUT'); } catch { /* ignore */ }
        }
        emitWarmPoolState();
      }
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
