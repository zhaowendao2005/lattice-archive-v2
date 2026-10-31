import type { TgCommand, TgEvent, TgInitialUser, TgValidationReport } from '@/worker/local/protocol';

export type TelegramUser = TgInitialUser;
export type ValidationReport = TgValidationReport;
export type LoginEvent =
  | { type: 'qr'; token: string; image: string; expires: number }
  | { type: 'stage'; stage: 'qr' | 'phone' | 'code' | 'password' | 'ready' }
  | { type: 'authorized'; user: TelegramUser; session: string }
  | { type: 'error'; message: string; code?: string };

/**
 * 主线程 ↔ local worker 的唯一接线器。
 *
 * MTProto、二维码编码、会话导出全部发生在 worker 内部；
 * 这里只转发强类型命令与事件，不持有任何协议对象。
 */
export class MtprotoBridge {
  private readonly worker: Worker;
  private readonly onEvent: (event: LoginEvent) => void;
  private readonly pendingValidation = new Map<string, { resolve: (report: ValidationReport) => void; reject: (error: Error) => void }>();

  constructor(onEvent: (event: LoginEvent) => void) {
    this.onEvent = onEvent;
    this.worker = new Worker(new URL('@/worker/local/tg.worker.ts', import.meta.url), { type: 'module', name: 'lattice-telegram' });
    this.worker.addEventListener('message', (event: MessageEvent<TgEvent>) => this.handle(event.data));
    this.worker.addEventListener('error', () => this.onEvent({ type: 'error', message: 'Telegram 协议进程异常退出，请重试' }));
    this.worker.postMessage({ t: 'init', deviceId: crypto.randomUUID(), platform: 'web', appVersion: '2.0.0' } satisfies TgCommand);
  }

  validateApp(apiId: number, apiHash: string): Promise<ValidationReport> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pendingValidation.set(requestId, { resolve, reject });
      this.worker.postMessage({ t: 'validateApp', requestId, apiId, apiHash } satisfies TgCommand);
    });
  }

  beginQrLogin(apiId: number, apiHash: string, exceptIds: string[] = []) {
    this.worker.postMessage({ t: 'beginQrLogin', apiId, apiHash, exceptIds } satisfies TgCommand);
  }

  beginPhoneLogin(apiId: number, apiHash: string) {
    this.worker.postMessage({ t: 'beginPhoneLogin', apiId, apiHash } satisfies TgCommand);
  }

  provide(stage: 'phone' | 'code' | 'password', value: string) {
    this.worker.postMessage({ t: 'submit', stage, value } satisfies TgCommand);
  }

  cancel() { this.worker.postMessage({ t: 'cancel' } satisfies TgCommand); }

  destroy() {
    this.worker.postMessage({ t: 'destroy' } satisfies TgCommand);
    this.worker.terminate();
    this.pendingValidation.forEach(({ reject }) => reject(new Error('Telegram 协议进程已关闭')));
    this.pendingValidation.clear();
  }

  private handle(event: TgEvent) {
    if (event.t === 'validationReport') {
      const pending = this.pendingValidation.get(event.requestId);
      if (pending) { pending.resolve(event.report); this.pendingValidation.delete(event.requestId); }
      return;
    }
    if (event.t === 'qr') this.onEvent({ type: 'qr', token: event.token, image: event.image, expires: event.expires });
    else if (event.t === 'loginStage') {
      // 邮件验证码分支尚未实现，显式忽略而不是假装进入了该状态。
      if (event.stage === 'email') return;
      this.onEvent({ type: 'stage', stage: event.stage === 'done' ? 'ready' : event.stage });
    }
    else if (event.t === 'authorized') this.onEvent({ type: 'authorized', user: event.user, session: event.session });
    else if (event.t === 'error') this.onEvent({ type: 'error', message: event.message, code: event.code });
  }
}
