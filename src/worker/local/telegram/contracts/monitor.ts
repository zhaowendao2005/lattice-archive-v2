/**
 * ============================================================================
 * Telegram 运行监控契约（Worker BusMonitor ↔ 主线程监控面板共用的纯类型与常量）
 * ============================================================================
 * 帧只携带计数、占用与任务元数据，不含消息正文、会话标题或文件名；
 * peer 只以不可逆短哈希出现在 operation 之外的任何位置都不允许。
 */

/** 调度子池（RequestScheduler 的 lane）。 */
export type SchedulerLane =
  | 'account' | 'chatRead' | 'search' | 'chatCommand' | 'bot' | 'vault'
  | 'avatar' | 'cover' | 'mediaPart' | 'streamPart' | 'fullMedia';
export type SchedulerPriority = 'interactive' | 'visible' | 'prefetch' | 'background';

export type MonitorBusId =
  | 'account'
  | 'chatRead'
  | 'search'
  | 'cover'
  | 'mediaAsset'
  | 'stream'
  | 'chatCommand'
  | 'bot'
  | 'vault';

export const SCHEDULER_LANES: readonly SchedulerLane[] = [
  'account', 'chatRead', 'search', 'chatCommand', 'bot', 'vault',
  'cover', 'avatar', 'fullMedia', 'mediaPart', 'streamPart',
];

/** 子池 → 所属业务总线。 */
export const LANE_BUS: Record<SchedulerLane, MonitorBusId> = {
  account: 'account',
  chatRead: 'chatRead',
  search: 'search',
  chatCommand: 'chatCommand',
  bot: 'bot',
  vault: 'vault',
  cover: 'cover',
  avatar: 'cover',
  fullMedia: 'mediaAsset',
  mediaPart: 'mediaAsset',
  streamPart: 'stream',
};

/** 面板展示顺序与名称；lanes 为空表示该总线尚未接入调度。 */
export const MONITOR_BUSES: readonly { id: MonitorBusId; label: string; lanes: readonly SchedulerLane[] }[] = [
  { id: 'search', label: 'SearchBus 搜索', lanes: ['search'] },
  { id: 'cover', label: 'CoverBus 封面与头像', lanes: ['cover', 'avatar'] },
  { id: 'mediaAsset', label: 'MediaAssetBus 完整文件', lanes: ['fullMedia', 'mediaPart'] },
  { id: 'stream', label: 'StreamBus 视频流', lanes: ['streamPart'] },
  { id: 'chatRead', label: 'ChatReadBus Chat 读取', lanes: ['chatRead'] },
  { id: 'chatCommand', label: 'ChatCommandBus Chat 命令', lanes: ['chatCommand'] },
  { id: 'bot', label: 'BotInteractionBus 机器人', lanes: ['bot'] },
  { id: 'vault', label: 'VaultTransferBus 保险库', lanes: ['vault'] },
  { id: 'account', label: 'AccountSessionBus 账号会话', lanes: ['account'] },
];

export const LANE_LABELS: Record<SchedulerLane, string> = {
  account: '账号会话',
  chatRead: 'Chat 读取',
  search: '搜索',
  chatCommand: 'Chat 命令',
  bot: '机器人',
  vault: '保险库',
  cover: '封面',
  avatar: '头像',
  fullMedia: '完整文件',
  mediaPart: '文件分片',
  streamPart: '流分片',
};

/** 耗时直方图分档上界（毫秒）：1、2、4 … 65536，最后一档为溢出。 */
export const LATENCY_BUCKET_BOUNDS: readonly number[] = Array.from({ length: 17 }, (_, i) => 2 ** i);
export const LATENCY_BUCKET_COUNT = LATENCY_BUCKET_BOUNDS.length + 1;

export const MONITOR_HZ_OPTIONS = [1, 4, 10] as const;
export type MonitorHz = (typeof MONITOR_HZ_OPTIONS)[number];

/** 订阅租约：主线程每 RENEW 毫秒续约一次，Worker 超过 TTL 未收到续约即停止推送。 */
export const MONITOR_LEASE_RENEW_MS = 5_000;
export const MONITOR_LEASE_TTL_MS = 15_000;
/** 单帧最多携带的活跃任务数；最近完成任务保留条数；事件流保留条数。 */
export const MONITOR_MAX_LIVE_TASKS = 200;
export const MONITOR_MAX_RECENT_TASKS = 100;
export const MONITOR_MAX_EVENTS = 200;
/** 增量帧单帧最多携带的任务变化数；其余顺延到后续帧，避免突发变化撑大单帧。 */
export const MONITOR_MAX_DELTA_UPSERTS = 60;

export type MonitorConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'auth-expired' | 'unknown';

export interface MonitorAccountStats {
  accountId: string;
  tier: 'P0' | 'P1';
  connection: MonitorConnectionState;
  dcId?: number;
  lastConnectionChangeAt?: number;
  hasScheduler: boolean;
  total: number;
  totalLimit: number;
  media: number;
  mediaLimit: number;
  nonMedia: number;
  nonMediaLimit: number;
  queued: number;
}

export interface MonitorLaneStats {
  accountId: string;
  lane: SchedulerLane;
  bus: MonitorBusId;
  active: number;
  queued: number;
  configured: number;
  effective: number;
  /** 熔断截止时间戳；0 表示未熔断。 */
  frozenUntil: number;
  /** 以下为累计值，速率由主线程按帧差计算。 */
  okTotal: number;
  errorTotal: number;
  cancelledTotal: number;
  bytesTotal: number;
  /** 搜索封面保留槽位占用（仅 cover）。 */
  reservedActive?: number;
  /** 最近约 10 秒窗口的分位数（毫秒）；无样本时为 0。 */
  queueMsP50: number;
  queueMsP95: number;
  runMsP50: number;
  runMsP95: number;
}

export type MonitorTaskState = 'queued' | 'running' | 'ok' | 'error' | 'cancelled';

export interface MonitorTask {
  id: number;
  accountId: string;
  traceId: string;
  lane: SchedulerLane;
  operation: string;
  priority: SchedulerPriority;
  state: MonitorTaskState;
  enqueuedAt: number;
  startedAt?: number;
  endedAt?: number;
  loaded?: number;
  total?: number;
  bucket?: string;
}

export type MonitorEventKind =
  | 'flood_wait'
  | 'unfreeze'
  | 'backoff'
  | 'recover'
  | 'scheduler_closed'
  | 'config_applied'
  | 'connection'
  | 'account_halted';

export interface MonitorEvent {
  seq: number;
  at: number;
  kind: MonitorEventKind;
  accountId?: string;
  lane?: SchedulerLane;
  message: string;
  traceId?: string;
}

export interface MonitorFrame {
  /** 每个订阅者独立递增；不连续时主线程请求全量重同步。 */
  seq: number;
  at: number;
  /** 全量帧：主线程应清空本地任务表后再应用。 */
  full: boolean;
  hz: number;
  mode: string;
  accounts: MonitorAccountStats[];
  lanes: MonitorLaneStats[];
  taskUpserts: MonitorTask[];
  taskRemovals: number[];
  /** 超出 MONITOR_MAX_LIVE_TASKS 未发送的活跃任务数。 */
  hiddenTaskCount: number;
  events: MonitorEvent[];
}

export interface MonitorAccountInfo {
  accountId: string;
  tier: 'P0' | 'P1';
  dcId?: number;
}
