import type { TgChatRequest, TgChatUpdate, TgUpdatesState } from './chatProtocol';

export type TgPlatform = 'web' | 'electron' | 'ios';
export type TgLoginStage = 'qr' | 'phone' | 'code' | 'password' | 'email' | 'ready' | 'done';

export interface TgInitialUser {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  premium?: boolean;
  dcId?: number;
}

export interface TgValidationReport { dcId?: number; country?: string; latencyMs: number; layer?: number }
export type TgRestoreFailure = 'auth-invalid' | 'network' | 'error';

export type TgCommand =
  | { t: 'init'; deviceId: string; platform: TgPlatform; appVersion: string; debug?: boolean }
  | { t: 'validateApp'; requestId: string; apiId: number; apiHash: string }
  | { t: 'beginQrLogin'; apiId: number; apiHash: string; exceptIds: string[]; expectedUserId?: string }
  | { t: 'beginPhoneLogin'; apiId: number; apiHash: string; expectedUserId?: string }
  | { t: 'restoreSession'; apiId: number; apiHash: string; accountId: string; session: string }
  | { t: 'submit'; stage: 'phone' | 'code' | 'password'; value: string }
  | { t: 'checkConnection'; requestId: string; accountId: string }
  /** 聊天内容只读请求；只能作用于 Worker 当前已授权的账户。 */
  | { t: 'chatRequest'; requestId: string; accountId: string; request: TgChatRequest }
  /** 中断仍在进行的聊天请求（目前仅完整文件下载响应）。 */
  | { t: 'chatCancel'; requestId: string }
  /** 仅取消进行中的扫码 / 手机号登录，不断开当前已在线的会话。 */
  | { t: 'cancel' }
  /** 主动断开当前已在线的会话（例如切换 Lattice 用户或解绑当前账户）。 */
  | { t: 'disconnectSession' }
  | { t: 'destroy' };

export type TgEvent =
  | { t: 'ready' }
  | { t: 'sessionStopped'; accountId?: string }
  | { t: 'accountDisconnected'; accountId: string }
  | { t: 'connectionState'; accountId: string; state: 'connecting' | 'online' | 'reconnecting' | 'offline' | 'auth-expired'; message?: string }
  | { t: 'connectionCheck'; requestId: string; online: boolean }
  | { t: 'validationReport'; requestId: string; ok: true; report: TgValidationReport }
  | { t: 'validationReport'; requestId: string; ok: false; message: string; code?: string }
  | { t: 'loginStage'; stage: TgLoginStage }
  /** image 是 worker 内本地编码的二维码 data URL，不经过任何第三方渲染服务。 */
  | { t: 'qr'; token: string; image: string; expires: number }
  /** 登录成功：session 是 GramJS StringSession，只在主线程加密落盘，绝不上传远端。 */
  | { t: 'authorized'; user: TgInitialUser; session: string }
  | { t: 'restored'; user: TgInitialUser }
  /**
   * 会话恢复失败。auth-invalid：服务端明确返回 AUTH_KEY_UNREGISTERED / SESSION_REVOKED 等致命错误；
   * network：连接或握手超时 / 网络不可达，可自动退避重试；error：其他异常，可重试。
   */
  | { t: 'restoreFailed'; accountId: string; reason: TgRestoreFailure; message: string }
  | { t: 'chatResponse'; requestId: string; ok: true; data: unknown }
  | { t: 'chatResponse'; requestId: string; ok: false; code: string; message: string }
  /** 长请求进度（字节）；Worker 端已节流。 */
  | { t: 'chatProgress'; requestId: string; loaded: number; total: number }
  /** 实时更新批次，向所有标签页广播；state 为 Worker 跟踪到的最新公共更新状态。 */
  | { t: 'chatUpdates'; accountId: string; updates: TgChatUpdate[]; state?: TgUpdatesState }
  | { t: 'error'; code?: string; message: string };
