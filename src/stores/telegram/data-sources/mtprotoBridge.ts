import type { TgCommand, TgEvent, TgInitialUser, TgPlatform, TgRestoreFailure, TgValidationReport } from '@/worker/local/protocol';
import { tgSessionVault } from './tgSessionVault';

export type TelegramUser = TgInitialUser;
export type ValidationReport = TgValidationReport;
export type RestoreFailure = TgRestoreFailure;
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
  | { type: 'error'; message: string; code?: string };

type BusMessage =
  | { kind: 'master'; senderId: string }
  | { kind: 'hello'; senderId: string }
  | { kind: 'command'; senderId: string; requestId: string; command: TgCommand }
  | { kind: 'event'; senderId: string; event: TgEvent };

const BUS_NAME = 'lattice.telegram.multitab.v1';
const COMMAND_TIMEOUT_MS = 15_000;
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
  private readonly pendingValidation = new Map<string, { resolve: (report: ValidationReport) => void; reject: (error: Error) => void }>();
  private readonly pendingConnectionChecks = new Map<string, { resolve: (online: boolean) => void; timeout: number }>();
  private readonly pendingCommands = new Map<string, { timeout: number; resolve?: () => void; reject?: (error: Error) => void }>();
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
      this.pendingValidation.set(requestId, { resolve, reject });
      void this.sendCommand({ t: 'validateApp', requestId, apiId, apiHash }, requestId);
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
    this.pendingCommands.forEach(({ timeout, reject }) => { window.clearTimeout(timeout); reject?.(new Error('主标签页连接已关闭')); });
    this.pendingCommands.clear();
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

  private releaseMasterOwnership() {
    if (this.role !== 'master') return;
    this.releaseDeviceLock?.();
  }

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
      this.onEvent({ type: 'error', message: 'Telegram 协议进程异常退出，请等待其他标签页接管' });
      if (this.activeAccountId) this.onEvent({ type: 'sessionStopped', accountId: this.activeAccountId });
      this.activeAccountId = undefined;
      this.worker?.terminate();
      this.worker = null;
      this.releaseDeviceLock?.();
      this.rejectPending(new Error('Telegram 协议进程异常退出'));
    });
    worker.postMessage({ t: 'init', deviceId: this.deviceId, platform: this.getPlatform(), appVersion: '2.0.0', debug: this.isDebugEnabled() } satisfies TgCommand);
  }

  /** 控制台执行 localStorage.setItem('lattice.telegram.debug','1') 后刷新即可开启 gramJS debug 日志。 */
  private isDebugEnabled() {
    try { return window.localStorage.getItem(DEBUG_KEY) === '1'; } catch { return false; }
  }

  private async sendCommand(command: TgCommand, requestId = crypto.randomUUID()) {
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
    const timeout = window.setTimeout(() => {
      const pending = this.pendingCommands.get(requestId);
      this.pendingCommands.delete(requestId);
      pending?.reject?.(new Error('主标签页未响应'));
    }, COMMAND_TIMEOUT_MS);
    this.pendingCommands.set(requestId, { timeout });
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
    if (broadcast) this.channel?.postMessage({ kind: 'event', senderId: this.tabId, event } satisfies BusMessage);
    if (event.t === 'validationReport') {
      const pending = this.pendingValidation.get(event.requestId);
      if (pending) { pending.resolve(event.report); this.pendingValidation.delete(event.requestId); }
      return;
    }
    if (event.t === 'connectionCheck') {
      const pending = this.pendingConnectionChecks.get(event.requestId);
      if (pending) { window.clearTimeout(pending.timeout); pending.resolve(event.online); }
      this.pendingConnectionChecks.delete(event.requestId);
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
      this.releaseMasterOwnership();
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
    } else if (event.t === 'error') this.onEvent({ type: 'error', message: event.message, code: event.code });
  }

  private rejectPending(error: Error) {
    this.pendingValidation.forEach(({ reject }) => reject(error));
    this.pendingValidation.clear();
  }

  private getPlatform(): TgPlatform {
    if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'ios';
    if (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)) return 'electron';
    return 'web';
  }
}
