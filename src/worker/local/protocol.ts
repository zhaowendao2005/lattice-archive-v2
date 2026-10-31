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
  | { t: 'cancel' }
  | { t: 'destroy' };

export type TgEvent =
  | { t: 'ready' }
  | { t: 'sessionStopped'; accountId?: string }
  | { t: 'accountDisconnected'; accountId: string }
  | { t: 'connectionState'; accountId: string; state: 'connecting' | 'online' | 'reconnecting' | 'offline' | 'auth-expired'; message?: string }
  | { t: 'connectionCheck'; requestId: string; online: boolean }
  | { t: 'validationReport'; requestId: string; report: TgValidationReport }
  | { t: 'loginStage'; stage: TgLoginStage }
  /** image 是 worker 内本地编码的二维码 data URL，不经过任何第三方渲染服务。 */
  | { t: 'qr'; token: string; image: string; expires: number }
  /** 登录成功：session 是 GramJS StringSession，只在主线程加密落盘，绝不上传远端。 */
  | { t: 'authorized'; user: TgInitialUser; session: string }
  | { t: 'restored'; user: TgInitialUser }
  /**
   * 会话恢复失败。auth-invalid：空会话探测同一 DC 成功而旧会话不通，判定本地 auth_key 失效；
   * network：空会话同样不通，属于网络 / DC 不可达，可重试；error：其他异常，可重试。
   */
  | { t: 'restoreFailed'; accountId: string; reason: TgRestoreFailure; message: string }
  | { t: 'error'; code?: string; message: string };
