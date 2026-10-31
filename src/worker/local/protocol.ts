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

export type TgCommand =
  | { t: 'init'; deviceId: string; platform: TgPlatform; appVersion: string }
  | { t: 'validateApp'; requestId: string; apiId: number; apiHash: string }
  | { t: 'beginQrLogin'; apiId: number; apiHash: string; exceptIds: string[] }
  | { t: 'beginPhoneLogin'; apiId: number; apiHash: string }
  | { t: 'submit'; stage: 'phone' | 'code' | 'password'; value: string }
  | { t: 'cancel' }
  | { t: 'destroy' };

export type TgEvent =
  | { t: 'ready' }
  | { t: 'validationReport'; requestId: string; report: TgValidationReport }
  | { t: 'loginStage'; stage: TgLoginStage }
  /** image 是 worker 内本地编码的二维码 data URL，不经过任何第三方渲染服务。 */
  | { t: 'qr'; token: string; image: string; expires: number }
  /** 登录成功：session 是 GramJS StringSession，只在主线程加密落盘，绝不上传远端。 */
  | { t: 'authorized'; user: TgInitialUser; session: string }
  | { t: 'error'; code?: string; message: string };
