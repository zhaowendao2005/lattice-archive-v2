/**
 * ============================================================================
 * 业务总线统一请求上下文与领域错误
 * ============================================================================
 * 每个总线请求都携带 requestId / traceId / accountId / priority / source；
 * 取消通过 busCancel(requestId) 传递到 Worker，映射为调度器的 AbortSignal。
 */
import type { TgErrorBucket } from '../../chat/telegramErrors';
import type { SchedulerPriority } from './monitor';

export type TelegramBusPriority = SchedulerPriority;

export interface TelegramBusContext {
  requestId: string;
  traceId: string;
  accountId: string;
  /** 缺省时由 Worker 路由表按操作决定（写操作 interactive、转存 background 等）。 */
  priority?: TelegramBusPriority;
  /** 发起方（Store / 预加载器名称），仅用于日志与监控。 */
  source: string;
}

/** 跨线程返回的领域错误：不暴露 GramJS 异常对象。 */
export interface TelegramBusError {
  code: string;
  message: string;
  bucket: TgErrorBucket;
  retryable: boolean;
  retryAfterMs?: number;
}
