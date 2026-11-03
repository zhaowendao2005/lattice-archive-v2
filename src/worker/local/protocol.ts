import type { TgChatUpdate, TgUpdatesState } from './chatProtocol';
import type { BusName } from './telegram/contracts/buses';
import type { TelegramBusContext, TelegramBusError } from './telegram/contracts/busContext';
import type { TelegramConcurrencyConfig } from './telegram/contracts/concurrency';
import type { MonitorFrame } from './telegram/contracts/monitor';
import type { ParsedImportedSessionItem, SessionBatchParseRequest } from '@/types/sessionBatch';

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

export type TgLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type TgLogSource = 'local' | 'remote' | 'frontend';

export interface TgDebugSpanEntry {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  source: TgLogSource;
  domain: string;
  action: string;
  level: TgLogLevel;
  timestamp: number;
  relMs: number;
  durMs?: number;
  message?: string;
  tags?: Record<string, string | number | boolean>;
}

export type TgCommand =
  | { t: 'init'; deviceId: string; platform: TgPlatform; appVersion: string; debug?: boolean; concurrency?: TelegramConcurrencyConfig }
  | { t: 'setDebug'; enabled: boolean }
  /** 设置页修改并发配额：立即作用于全部账号调度器的后续任务。 */
  | { t: 'setConcurrency'; config: TelegramConcurrencyConfig }
  /** 运行监控订阅 / 续约（同一命令）：带租约，超时未续约 Worker 自动停止推送。 */
  | { t: 'monitorSubscribe'; subscriberId: string; hz: number }
  | { t: 'monitorUnsubscribe'; subscriberId: string }
  /** 帧序号不连续时请求一帧全量数据。 */
  | { t: 'monitorResync'; subscriberId: string }
  | { t: 'validateApp'; requestId: string; apiId: number; apiHash: string }
  | { t: 'beginQrLogin'; apiId: number; apiHash: string; exceptIds: string[]; expectedUserId?: string }
  | { t: 'beginPhoneLogin'; apiId: number; apiHash: string; expectedUserId?: string }
  | { t: 'restoreSession'; apiId: number; apiHash: string; accountId: string; session: string }
  /** 恢复并驻留后台温池账号（P1 Warm Active，不挤占 P0 前台主账号）。 */
  | { t: 'restoreWarmAccount'; apiId: number; apiHash: string; accountId: string; session: string }
  /** 零闪烁瞬切 P0 前台焦点账号（将指定温池账号提升为 P0，原 P0 降级为 P1）。 */
  | { t: 'setForegroundAccount'; accountId: string }
  /** 断开并移除指定账号客户端实例。 */
  | { t: 'disconnectAccount'; accountId: string }
  | { t: 'submit'; stage: 'phone' | 'code' | 'password'; value: string }
  | { t: 'checkConnection'; requestId: string; accountId: string }
  /** 业务总线请求：context.requestId 唯一标识；只能作用于 Worker 已授权（前台或温池）的账户。 */
  | { t: 'busRequest'; context: TelegramBusContext; bus: BusName; op: string; input: unknown }
  /** 取消进行中的总线请求：排队中立即出队，执行中在分片边界停止。 */
  | { t: 'busCancel'; requestId: string }
  /** 在本地 Worker 解析批量导入文本 / 文件；文件原始字节只在本机线程间传递。 */
  | { t: 'sessionBatchParse'; requestId: string; request: SessionBatchParseRequest }
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
  | { t: 'busResponse'; requestId: string; ok: true; data: unknown }
  | { t: 'busResponse'; requestId: string; ok: false; error: TelegramBusError }
  /** 长请求进度（字节）；Worker 端已节流。 */
  | { t: 'busProgress'; requestId: string; loaded: number; total: number }
  | { t: 'sessionBatchParsed'; requestId: string; ok: true; items: ParsedImportedSessionItem[] }
  | { t: 'sessionBatchParsed'; requestId: string; ok: false; message: string }
  /** 实时更新批次，向所有标签页广播；state 为 Worker 跟踪到的最新公共更新状态。 */
  | { t: 'chatUpdates'; accountId: string; updates: TgChatUpdate[]; state?: TgUpdatesState }
  /** 广播 Worker 内部多实例温池状态变化。 */
  | {
      t: 'warmPoolState';
      foregroundAccountId: string | null;
      accounts: { accountId: string; tier: 'P0' | 'P1' | 'P2'; connected: boolean }[];
    }
  | { t: 'debugLog'; entry: TgDebugSpanEntry }
  /** 运行监控帧：只发给对应订阅者（主标签页直达，从标签页经 BroadcastChannel 转发）。 */
  | { t: 'monitorFrame'; subscriberId: string; frame: MonitorFrame }
  | { t: 'error'; code?: string; message: string };
