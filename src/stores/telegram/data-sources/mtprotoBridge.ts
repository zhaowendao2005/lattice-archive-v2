import type { TgCommand, TgDebugSpanEntry, TgEvent, TgInitialUser, TgPlatform, TgRestoreFailure, TgValidationReport } from '@/worker/local/protocol';
import type { TgChatUpdate, TgUpdatesState } from '@/worker/local/chatProtocol';
import type { BusInput, BusName, BusOpName, BusOutput } from '@/worker/local/telegram/contracts/buses';
import type { TelegramBusContext, TelegramBusError } from '@/worker/local/telegram/contracts/busContext';
import type { TelegramConcurrencyConfig } from '@/worker/local/telegram/contracts/concurrency';
import type { MonitorFrame } from '@/worker/local/telegram/contracts/monitor';
import type { ParsedImportedSessionItem, SessionBatchParseRequest } from '@/types/sessionBatch';
import { tgSessionVault } from './tgSessionVault';
import { telegramPerformancePreferences } from './telegramPerformancePreferences';

export type TelegramUser = TgInitialUser;
export type ValidationReport = TgValidationReport;
export type RestoreFailure = TgRestoreFailure;
export type { TgDebugSpanEntry };
export type LoginEvent =
  | { type: 'qr'; token: string; image: string; expires: number }
  | { type: 'stage'; stage: 'qr' | 'phone' | 'code' | 'password' | 'ready' }
  | { type: 'authorized'; user: TelegramUser; session: string }
  | { type: 'restored'; user: TelegramUser }
  | { type: 'restoreFailed'; accountId: string; reason: RestoreFailure; message: string }
  | { type: 'elected' }
  | { type: 'connectionState'; accountId: string; state: 'connecting' | 'online' | 'reconnecting' | 'offline' | 'auth-expired'; message?: string }
  | { type: 'accountDisconnected'; accountId: string }
  | { type: 'sessionStopped'; accountId?: string }
  | { type: 'chatUpdates'; accountId: string; updates: TgChatUpdate[]; state?: TgUpdatesState }
  | {
      type: 'warmPoolState';
      foregroundAccountId: string | null;
      accounts: { accountId: string; tier: 'P0' | 'P1' | 'P2'; connected: boolean }[];
    }
  | { type: 'debugLog'; entry: TgDebugSpanEntry }
  | { type: 'error'; message: string; code?: string };

/** 业务总线请求失败：携带领域错误码与分桶，便于业务层区分 FLOOD_WAIT / 权限 / 未连接 / 取消。 */
export class TelegramBusRequestError extends Error {
  readonly code: string;
  readonly bucket: TelegramBusError['bucket'] | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  constructor(code: string, message: string, detail: Partial<Pick<TelegramBusError, 'bucket' | 'retryable' | 'retryAfterMs'>> = {}) {
    super(message);
    this.code = code;
    this.bucket = detail.bucket;
    this.retryable = detail.retryable ?? false;
    this.retryAfterMs = detail.retryAfterMs;
  }
}

type BusMessage =
  | { kind: 'master'; senderId: string }
  | { kind: 'hello'; senderId: string }
  | { kind: 'command'; senderId: string; requestId: string; command: TgCommand }
  | { kind: 'event'; senderId: string; event: TgEvent };

export interface BusRequestOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
}

interface PendingBusRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
  onProgress?: (loaded: number, total: number) => void;
  restartTimeout?: () => number;
  cleanup?: () => void;
}

const BUS_NAME = 'lattice.telegram.multitab.v1';
const COMMAND_TIMEOUT_MS = 15_000;
const VALIDATE_TIMEOUT_MS = 25_000;
/** 补差可能连续拉取多个分片、调度器可能排队，给总线请求更宽的超时。 */
const BUS_REQUEST_TIMEOUT_MS = 45_000;
const DEBUG_KEY = 'lattice.telegram.debug';

/**
 * 每个标签页只有一个 Bridge 实例，但只有主标签页创建 local Worker。
 * Web Lock 是唯一的连接所有权裁判，BroadcastChannel 负责命令代理和事件广播。
 */
export class MtprotoBridge {
  private readonly onEvent: (event: LoginEvent) => void;
  private readonly deviceId: string;
  private readonly lockName: string;
  private readonly tabId = crypto.randomUUID();
  private readonly channel: BroadcastChannel | null;
  private readonly pendingValidation = new Map<string, { resolve: (report: ValidationReport) => void; reject: (error: Error) => void; timeout: number }>();
  private readonly pendingConnectionChecks = new Map<string, { resolve: (online: boolean) => void; timeout: number }>();
  private readonly pendingBusRequests = new Map<string, PendingBusRequest>();
  /** 本标签页发起的运行监控订阅 → 帧回调。 */
  private readonly monitorListeners = new Map<string, (frame: MonitorFrame) => void>();
  private readonly pendingSessionParses = new Map<string, { resolve: (items: ParsedImportedSessionItem[]) => void; reject: (error: Error) => void }>();
  private worker: Worker | null = null;
  private activeAccountId?: string;
  private role: 'unknown' | 'master' | 'follower' | 'destroyed' = 'unknown';
  private knownMasterId?: string;
  private releaseDeviceLock?: () => void;
  private lockRequest?: Promise<void>;
  private lockAbort = new AbortController();
  private resolveMasterReady!: () => void;
  private masterReady = new Promise<void>((resolve) => { this.resolveMasterReady = resolve; });
  private destroyPromise?: Promise<void>;
  private resolveDestroy?: () => void;

  constructor(onEvent: (event: LoginEvent) => void) {
    this.onEvent = onEvent;
    this.deviceId = tgSessionVault.deviceId();
    this.lockName = `lattice.telegram.device.${this.deviceId}`;
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(BUS_NAME);
    this.channel?.addEventListener('message', (event: MessageEvent<BusMessage>) => this.handleBusMessage(event.data));
    this.channel?.postMessage({ kind: 'hello', senderId: this.tabId } satisfies BusMessage);
    window.addEventListener('pagehide', this.handlePageHide);
    void this.startElection();
  }

  validateApp(apiId: number, apiHash: string): Promise<ValidationReport> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingValidation.delete(requestId);
        reject(new Error('连接 Telegram 验证超时，请检查网络后重试'));
      }, VALIDATE_TIMEOUT_MS);
      this.pendingValidation.set(requestId, { resolve, reject, timeout });
      this.sendCommand({ t: 'validateApp', requestId, apiId, apiHash }, requestId).catch((error: unknown) => {
        window.clearTimeout(timeout);
        this.pendingValidation.delete(requestId);
        reject(error instanceof Error ? error : new Error('验证应用凭据失败'));
      });
    });
  }

  async beginQrLogin(apiId: number, apiHash: string, exceptIds: string[] = [], expectedUserId?: string) {
    await this.sendCommand({ t: 'beginQrLogin', apiId, apiHash, exceptIds, expectedUserId });
  }

  async beginPhoneLogin(apiId: number, apiHash: string, expectedUserId?: string) {
    await this.sendCommand({ t: 'beginPhoneLogin', apiId, apiHash, expectedUserId });
  }

  async restoreSession(apiId: number, apiHash: string, accountId: string, session: string) {
    await this.sendCommand({ t: 'restoreSession', apiId, apiHash, accountId, session });
  }

  async restoreWarmAccount(apiId: number, apiHash: string, accountId: string, session: string) {
    await this.sendCommand({ t: 'restoreWarmAccount', apiId, apiHash, accountId, session });
  }

  async setForegroundAccount(accountId: string) {
    await this.sendCommand({ t: 'setForegroundAccount', accountId });
  }

  async disconnectAccount(accountId: string) {
    await this.sendCommand({ t: 'disconnectAccount', accountId });
  }

  provide(stage: 'phone' | 'code' | 'password', value: string) {
    void this.sendCommand({ t: 'submit', stage, value });
  }

  checkConnection(accountId: string): Promise<boolean> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        this.pendingConnectionChecks.delete(requestId);
        resolve(false);
      }, COMMAND_TIMEOUT_MS);
      this.pendingConnectionChecks.set(requestId, { resolve, timeout });
      void this.sendCommand({ t: 'checkConnection', requestId, accountId }, requestId);
    });
  }

  cancel() { void this.sendCommand({ t: 'cancel' }); }

  disconnectSession() { void this.sendCommand({ t: 'disconnectSession' }); }

  /**
   * 运行监控订阅 / 续约：同一 subscriberId 重复调用即续约（或切换帧率）。
   * 帧只回给发起订阅的标签页；Worker 超过租约未收到续约会自动停止推送。
   */
  monitorSubscribe(subscriberId: string, hz: number, onFrame: (frame: MonitorFrame) => void) {
    this.monitorListeners.set(subscriberId, onFrame);
    void this.sendCommand({ t: 'monitorSubscribe', subscriberId, hz }).catch(() => undefined);
  }

  monitorUnsubscribe(subscriberId: string) {
    this.monitorListeners.delete(subscriberId);
    void this.sendCommand({ t: 'monitorUnsubscribe', subscriberId }).catch(() => undefined);
  }

  monitorResync(subscriberId: string) {
    void this.sendCommand({ t: 'monitorResync', subscriberId }).catch(() => undefined);
  }

  parseSessionBatch(request: SessionBatchParseRequest): Promise<ParsedImportedSessionItem[]> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pendingSessionParses.set(requestId, { resolve, reject });
      this.sendCommand({ t: 'sessionBatchParse', requestId, request }, requestId).catch((error: unknown) => {
        this.pendingSessionParses.delete(requestId);
        reject(error instanceof Error ? error : new Error('批量解析失败'));
      });
    });
  }

  /** 下发并发配额到 Worker（从标签页经 BroadcastChannel 代理到主标签页）。 */
  setConcurrency(config: TelegramConcurrencyConfig) {
    void this.sendCommand({ t: 'setConcurrency', config }).catch(() => undefined);
  }

  setDebug(enabled: boolean) {
    try { window.localStorage.setItem(DEBUG_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
    void this.sendCommand({ t: 'setDebug', enabled }).catch(() => undefined);
  }

  /**
   * 业务总线请求：主标签页直连 Worker，从标签页经 BroadcastChannel 代理；响应按 requestId 只回给发起方。
   * options.idleTimeoutMs：长请求（完整文件）改为「无进度超时」，每次收到进度事件都会重新计时；
   * options.signal：中止时发送 busCancel，Worker 排队中立即出队、执行中在分片边界停止，并以 TG_CANCELED 拒绝。
   */
  requestBus<B extends BusName, O extends BusOpName<B>>(
    bus: B,
    op: O,
    input: BusInput<B, O>,
    context: TelegramBusContext,
    options: BusRequestOptions = {},
  ): Promise<BusOutput<B, O>> {
    const { requestId } = context;
    const timeoutMs = options.idleTimeoutMs ?? BUS_REQUEST_TIMEOUT_MS;
    return new Promise<BusOutput<B, O>>((resolve, reject) => {
      if (options.signal?.aborted) { reject(new TelegramBusRequestError('TG_CANCELED', '请求已取消', { bucket: 'CANCELLED' })); return; }
      const expire = () => window.setTimeout(() => {
        this.finishBusRequest(requestId);
        void this.sendCommand({ t: 'busCancel', requestId }).catch(() => undefined);
        reject(new TelegramBusRequestError('TG_REQUEST_TIMEOUT', 'Telegram 请求超时，请稍后重试', { bucket: 'TIMEOUT', retryable: true }));
      }, timeoutMs);
      const handleAbort = () => {
        if (!this.pendingBusRequests.has(requestId)) return;
        this.finishBusRequest(requestId);
        void this.sendCommand({ t: 'busCancel', requestId }).catch(() => undefined);
        reject(new TelegramBusRequestError('TG_CANCELED', '请求已取消', { bucket: 'CANCELLED' }));
      };
      options.signal?.addEventListener('abort', handleAbort, { once: true });
      this.pendingBusRequests.set(requestId, {
        resolve: (data) => resolve(data as BusOutput<B, O>),
        reject,
        timeout: expire(),
        onProgress: options.onProgress,
        restartTimeout: options.idleTimeoutMs ? expire : undefined,
        cleanup: () => options.signal?.removeEventListener('abort', handleAbort),
      });
      this.sendCommand({ t: 'busRequest', context, bus, op, input }, requestId).catch((error: unknown) => {
        this.finishBusRequest(requestId);
        reject(error instanceof Error ? error : new Error('Telegram 请求失败'));
      });
    });
  }

  /** 清理挂起表中的总线请求：超时计时器与中止监听一并释放。 */
  private finishBusRequest(requestId: string) {
    const pending = this.pendingBusRequests.get(requestId);
    if (!pending) return undefined;
    window.clearTimeout(pending.timeout);
    pending.cleanup?.();
    this.pendingBusRequests.delete(requestId);
    return pending;
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = new Promise((resolve) => { this.resolveDestroy = resolve; });
    this.role = 'destroyed';
    this.lockAbort.abort();
    this.releaseDeviceLock?.();
    this.worker?.postMessage({ t: 'destroy' } satisfies TgCommand);
    this.worker?.terminate();
    this.worker = null;
    this.rejectPending(new Error('Telegram 连接已关闭'));
    this.pendingConnectionChecks.forEach(({ resolve, timeout }) => { window.clearTimeout(timeout); resolve(false); });
    this.pendingConnectionChecks.clear();
    this.channel?.close();
    window.removeEventListener('pagehide', this.handlePageHide);
    void this.lockRequest?.finally(() => {
      this.resolveDestroy?.();
      this.resolveDestroy = undefined;
    });
    if (!this.lockRequest) {
      this.resolveDestroy?.();
      this.resolveDestroy = undefined;
    }
    return this.destroyPromise;
  }

  private readonly handlePageHide = () => {
    this.releaseDeviceLock?.();
    this.worker?.terminate();
    this.worker = null;
  };

  private async startElection() {
    if (!navigator.locks || !this.channel) {
      this.role = 'follower';
      this.onEvent({ type: 'error', code: 'DEVICE_COORDINATION_UNAVAILABLE', message: '当前浏览器不支持多标签页安全协调，请更新浏览器后重试' });
      return;
    }
    this.lockRequest = navigator.locks.request(this.lockName, { mode: 'exclusive', signal: this.lockAbort.signal }, async (lock) => {
      if (!lock || this.role === 'destroyed') return;
      this.role = 'master';
      this.knownMasterId = this.tabId;
      this.channel?.postMessage({ kind: 'master', senderId: this.tabId } satisfies BusMessage);
      this.createWorker();
      this.resolveMasterReady();
      // 主标签页切换后需要显式通知业务层：恢复会话或重新开始登录。
      this.onEvent({ type: 'elected' });
      await new Promise<void>((resolve) => { this.releaseDeviceLock = resolve; });
      this.releaseDeviceLock = undefined;
      this.worker?.postMessage({ t: 'destroy' } satisfies TgCommand);
      this.worker?.terminate();
      this.worker = null;
      this.role = 'follower';
    }).catch((error: unknown) => {
      if (this.role !== 'destroyed' && (error as DOMException)?.name !== 'AbortError') {
        this.onEvent({ type: 'error', code: 'DEVICE_COORDINATION_FAILED', message: error instanceof Error ? error.message : '无法协调 Telegram 设备连接' });
      }
    });
    await this.lockRequest;
    if (this.role === 'unknown') this.role = 'follower';
  }

  private createWorker() {
    if (this.worker || this.role !== 'master') return;
    const worker = new Worker(new URL('@/worker/local/tg.worker.ts', import.meta.url), { type: 'module', name: 'lattice-telegram' });
    this.worker = worker;
    worker.addEventListener('message', (event: MessageEvent<TgEvent>) => this.handleWorkerEvent(event.data));
    worker.addEventListener('error', () => {
      if (this.role === 'destroyed') return;
      if (this.activeAccountId) this.onEvent({ type: 'sessionStopped', accountId: this.activeAccountId });
      this.activeAccountId = undefined;
      this.worker?.terminate();
      this.worker = null;
      this.rejectPending(new Error('Telegram 协议进程异常退出'));
      // 主标签页保持设备锁并原地重建 Worker，避免单标签页下释放锁后无人接管。
      if (this.role === 'master') {
        this.createWorker();
        this.onEvent({ type: 'elected' });
      }
    });
    worker.postMessage({ t: 'init', deviceId: this.deviceId, platform: this.getPlatform(), appVersion: '2.0.0', debug: this.isDebugEnabled(), concurrency: telegramPerformancePreferences.read() } satisfies TgCommand);
  }

  /** 控制台执行 localStorage.setItem('lattice.telegram.debug','1') 后刷新即可开启 gramJS debug 日志。 */
  private isDebugEnabled() {
    try { return window.localStorage.getItem(DEBUG_KEY) === '1'; } catch { return false; }
  }

  private async sendCommand(command: TgCommand, requestId: string = crypto.randomUUID()) {
    if (this.role === 'destroyed') throw new Error('Telegram 连接已关闭');
    await Promise.race([
      this.masterReady,
      new Promise<void>((_, reject) => window.setTimeout(() => reject(new Error('未找到 Telegram 主标签页，请稍后重试')), COMMAND_TIMEOUT_MS)),
    ]);
    if (this.role === 'master') {
      this.worker?.postMessage(command);
      return;
    }
    if (!this.channel || !this.knownMasterId) throw new Error('未找到 Telegram 主标签页，请稍后重试');
    this.channel.postMessage({ kind: 'command', senderId: this.tabId, requestId, command } satisfies BusMessage);
  }

  private handleBusMessage(message: BusMessage) {
    if (message.senderId === this.tabId || this.role === 'destroyed') return;
    if (message.kind === 'hello' && this.role === 'master') {
      this.channel?.postMessage({ kind: 'master', senderId: this.tabId } satisfies BusMessage);
      return;
    }
    if (message.kind === 'master') {
      this.knownMasterId = message.senderId;
      this.resolveMasterReady();
      return;
    }
    if (message.kind === 'command' && this.role === 'master') {
      this.worker?.postMessage(message.command);
      return;
    }
    if (message.kind === 'event') {
      this.handleWorkerEvent(message.event, false);
    }
  }

  private handleWorkerEvent(event: TgEvent, broadcast = true) {
    // 本标签页自己发起的聊天 RPC 响应 / 进度（含媒体字节）无需广播，只有代理从标签页的请求才需要转发。
    const ownResponse = ((event.t === 'busResponse' || event.t === 'busProgress') && this.pendingBusRequests.has(event.requestId))
      || (event.t === 'monitorFrame' && this.monitorListeners.has(event.subscriberId));
    if (broadcast && !ownResponse) this.channel?.postMessage({ kind: 'event', senderId: this.tabId, event } satisfies BusMessage);
    if (event.t === 'sessionBatchParsed') {
      const pending = this.pendingSessionParses.get(event.requestId);
      if (!pending) return;
      this.pendingSessionParses.delete(event.requestId);
      if (event.ok) pending.resolve(event.items); else pending.reject(new Error(event.message));
      return;
    }
    if (event.t === 'validationReport') {
      const pending = this.pendingValidation.get(event.requestId);
      if (pending) {
        window.clearTimeout(pending.timeout);
        this.pendingValidation.delete(event.requestId);
        if (event.ok) pending.resolve(event.report);
        else pending.reject(new Error(event.message));
      }
      return;
    }
    if (event.t === 'connectionCheck') {
      const pending = this.pendingConnectionChecks.get(event.requestId);
      if (pending) { window.clearTimeout(pending.timeout); pending.resolve(event.online); }
      this.pendingConnectionChecks.delete(event.requestId);
      return;
    }
    if (event.t === 'busResponse') {
      const pending = this.finishBusRequest(event.requestId);
      if (!pending) return;
      if (event.ok) pending.resolve(event.data);
      else pending.reject(new TelegramBusRequestError(event.error.code, event.error.message, event.error));
      return;
    }
    if (event.t === 'busProgress') {
      const pending = this.pendingBusRequests.get(event.requestId);
      if (!pending) return;
      if (pending.restartTimeout) {
        window.clearTimeout(pending.timeout);
        pending.timeout = pending.restartTimeout();
      }
      pending.onProgress?.(event.loaded, event.total);
      return;
    }
    if (event.t === 'monitorFrame') {
      this.monitorListeners.get(event.subscriberId)?.(event.frame);
      return;
    }
    if (event.t === 'chatUpdates') {
      this.onEvent({ type: 'chatUpdates', accountId: event.accountId, updates: event.updates, state: event.state });
      return;
    }
    if (event.t === 'connectionState') {
      this.onEvent({ type: 'connectionState', accountId: event.accountId, state: event.state, message: event.message });
      return;
    }
    if (event.t === 'sessionStopped') {
      const accountId = event.accountId ?? this.activeAccountId;
      this.activeAccountId = undefined;
      this.onEvent({ type: 'sessionStopped', accountId });
      return;
    }
    if (event.t === 'ready') return;
    if (event.t === 'qr') this.onEvent({ type: 'qr', token: event.token, image: event.image, expires: event.expires });
    else if (event.t === 'loginStage') {
      if (event.stage === 'email') return;
      this.onEvent({ type: 'stage', stage: event.stage === 'done' ? 'ready' : event.stage });
    } else if (event.t === 'authorized') {
      this.activeAccountId = event.user.id;
      this.onEvent({ type: 'authorized', user: event.user, session: event.session });
    } else if (event.t === 'restored') {
      // 会话恢复成功必须转发给业务层，否则状态永远停在「连接中」且心跳不会启动。
      this.activeAccountId = event.user.id;
      this.onEvent({ type: 'restored', user: event.user });
    } else if (event.t === 'restoreFailed') {
      this.onEvent({ type: 'restoreFailed', accountId: event.accountId, reason: event.reason, message: event.message });
    } else if (event.t === 'accountDisconnected') {
      if (this.activeAccountId === event.accountId) this.activeAccountId = undefined;
      this.onEvent({ type: 'accountDisconnected', accountId: event.accountId });
    } else if (event.t === 'warmPoolState') {
      this.onEvent({
        type: 'warmPoolState',
        foregroundAccountId: event.foregroundAccountId,
        accounts: event.accounts,
      });
    } else if (event.t === 'debugLog') {
      this.onEvent({ type: 'debugLog', entry: event.entry });
    } else if (event.t === 'error') this.onEvent({ type: 'error', message: event.message, code: event.code });
  }

  private rejectPending(error: Error) {
    this.pendingValidation.forEach(({ reject, timeout }) => { window.clearTimeout(timeout); reject(error); });
    this.pendingValidation.clear();
    this.pendingBusRequests.forEach(({ reject, timeout, cleanup }) => { window.clearTimeout(timeout); cleanup?.(); reject(error); });
    this.pendingBusRequests.clear();
    this.pendingSessionParses.forEach(({ reject }) => reject(error));
    this.pendingSessionParses.clear();
  }

  private getPlatform(): TgPlatform {
    if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'ios';
    if (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)) return 'electron';
    return 'web';
  }
}

type BridgeListener = (event: LoginEvent) => void;
const bridgeListeners = new Set<BridgeListener>();
let sharedBridge: MtprotoBridge | null = null;

/**
 * 每个标签页唯一的 Bridge 单例与事件分发器。
 * telegram 域（登录 / 设备心跳）与 chat 域（会话 / 消息更新）各自订阅，互不持有对方的 Store。
 * 必须先 subscribe 再 bridge()：主标签页选举的 elected 事件在构造后异步派发。
 */
export const mtprotoHub = {
  bridge(): MtprotoBridge {
    if (!sharedBridge) sharedBridge = new MtprotoBridge((event) => { bridgeListeners.forEach((listener) => listener(event)); });
    return sharedBridge;
  },
  subscribe(listener: BridgeListener): () => void {
    bridgeListeners.add(listener);
    return () => { bridgeListeners.delete(listener); };
  },
};
