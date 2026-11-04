/**
 * ============================================================================
 * Telegram 并发配额契约（预设 / 保护范围 / 归一化）
 * ============================================================================
 * 纯数据与纯函数：local Worker 的 RequestScheduler 与主线程设置页共用同一份定义，
 * 保证「设置页看到的数字」与「调度器实际使用的上限」来源唯一。
 *
 * 注意：预设数值是工程压测起点，不是 Telegram 官方额度。自定义模式没有固定数值上限，
 * 只有最小值与层级依赖约束（见 TELEGRAM_CONCURRENCY_MINIMUMS / TELEGRAM_CONCURRENCY_PARENT）。
 * 运行时调度器可以在 FloodWait / 超时后临时降速，但不得突破用户配置值。
 *
 * 预设约束：组预算 ≥ 其任一子池（媒体组 ≥ 封面 + 头像，保证封面跑满时头像不被饿死），
 * 总预算 = 媒体组 + 非媒体组，避免总预算反过来压低子池。
 */

export type TelegramConcurrencyMode = 'stable' | 'balanced' | 'aggressive' | 'custom';

export interface TelegramConcurrencyLimits {
  /** 账号级非媒体 RPC（搜索 / Chat 读取 / 命令 / 机器人 / 保险库 / 账号会话共用）。 */
  nonMediaRpc: number;
  /** 账号级媒体 RPC（头像 / 封面 / 完整文件分片 / 流媒体分片共用）。 */
  mediaRpc: number;
  /** 账号级同时活跃的 RPC 任务总数，超出即排队，不新建连接。 */
  totalActiveTasks: number;
  /** messages.Search / SearchGlobal 并发。 */
  search: number;
  /** ChatReadBus：会话列表、历史、补差。 */
  chatRead: number;
  /** ChatCommandBus：归档、加入、退出、发送等写操作。 */
  chatCommand: number;
  /** BotInteractionBus：/start 与 Callback（保持顺序，通常为 1）。 */
  bot: number;
  /** VaultTransferBus：转存与 noforwards 中继（后台低优先级）。 */
  vault: number;
  /** AccountSessionBus：健康探针、槽位派生。 */
  account: number;
  /** 封面细图（照片档位 / 视频封面 / 文档缩略图）并发，Chat 与搜索共用。 */
  cover: number;
  /** 封面池中为搜索结果保留的槽位，避免被 Chat 封面饿死。 */
  searchCoverReserved: number;
  /** 头像并发。 */
  avatar: number;
  /** 同时进行的完整文件下载任务数。 */
  fullMedia: number;
  /** 完整文件下载的分片 RPC 并发（账号内所有文件共享）。 */
  mediaPart: number;
  /** 流媒体播放分片并发。 */
  streamPart: number;
}

export interface TelegramConcurrencyConfig {
  mode: TelegramConcurrencyMode;
  /** 当前生效的用户配置上限（非 custom 模式时等于预设）。 */
  limits: TelegramConcurrencyLimits;
}

export type TelegramConcurrencyKey = keyof TelegramConcurrencyLimits;

export const TELEGRAM_CONCURRENCY_PRESETS: Record<Exclude<TelegramConcurrencyMode, 'custom'>, TelegramConcurrencyLimits> = {
  stable: {
    nonMediaRpc: 3,
    mediaRpc: 6,
    totalActiveTasks: 9,
    search: 2,
    chatRead: 2,
    chatCommand: 1,
    bot: 1,
    vault: 1,
    account: 1,
    cover: 4,
    searchCoverReserved: 2,
    avatar: 2,
    fullMedia: 1,
    mediaPart: 2,
    streamPart: 2,
  },
  balanced: {
    nonMediaRpc: 6,
    mediaRpc: 12,
    totalActiveTasks: 18,
    search: 3,
    chatRead: 3,
    chatCommand: 2,
    bot: 1,
    vault: 1,
    account: 1,
    cover: 8,
    searchCoverReserved: 3,
    avatar: 3,
    fullMedia: 3,
    mediaPart: 4,
    streamPart: 4,
  },
  aggressive: {
    nonMediaRpc: 10,
    mediaRpc: 20,
    totalActiveTasks: 30,
    search: 5,
    chatRead: 4,
    chatCommand: 2,
    bot: 1,
    vault: 2,
    account: 1,
    cover: 14,
    searchCoverReserved: 6,
    avatar: 5,
    fullMedia: 5,
    mediaPart: 8,
    streamPart: 6,
  },
};

/**
 * 各字段最小值：0 并发会让队列永久卡死（保留槽位例外，0 表示不保留）。
 * 不设数值上限；唯一的上界来自下方 TELEGRAM_CONCURRENCY_PARENT 的层级依赖。
 */
export const TELEGRAM_CONCURRENCY_MINIMUMS: Record<TelegramConcurrencyKey, number> = {
  nonMediaRpc: 1,
  mediaRpc: 1,
  totalActiveTasks: 2,
  search: 1,
  chatRead: 1,
  chatCommand: 1,
  bot: 1,
  vault: 1,
  account: 1,
  cover: 1,
  searchCoverReserved: 0,
  avatar: 1,
  fullMedia: 1,
  mediaPart: 1,
  streamPart: 1,
};

export const DEFAULT_TELEGRAM_CONCURRENCY: TelegramConcurrencyConfig = {
  mode: 'balanced',
  limits: { ...TELEGRAM_CONCURRENCY_PRESETS.balanced },
};

/** 计入非媒体 RPC 组预算的子池。 */
export const NON_MEDIA_SUB_POOLS = ['search', 'chatRead', 'chatCommand', 'bot', 'vault', 'account'] as const satisfies readonly TelegramConcurrencyKey[];

/** 计入媒体 RPC 组预算的子池。 */
export const MEDIA_SUB_POOLS = ['cover', 'avatar', 'mediaPart', 'streamPart'] as const satisfies readonly TelegramConcurrencyKey[];

/**
 * 层级依赖：子字段的值不得超过其上级字段（校验与归一化共用，唯一定义）。
 * - 非媒体子池 ≤ nonMediaRpc；媒体子池 ≤ mediaRpc；searchCoverReserved ≤ cover；
 * - 另有 totalActiveTasks ≥ max(nonMediaRpc, mediaRpc)（见 normalizeTelegramConcurrency）；
 * - fullMedia 无上级：它是同时下载的文件数，其分片由 mediaPart 共享限流。
 */
export const TELEGRAM_CONCURRENCY_PARENT: Partial<Record<TelegramConcurrencyKey, TelegramConcurrencyKey>> = {
  ...Object.fromEntries(NON_MEDIA_SUB_POOLS.map((key) => [key, 'nonMediaRpc'])),
  ...Object.fromEntries(MEDIA_SUB_POOLS.map((key) => [key, 'mediaRpc'])),
  searchCoverReserved: 'cover',
};

export const TELEGRAM_CONCURRENCY_KEYS = Object.keys(TELEGRAM_CONCURRENCY_MINIMUMS) as TelegramConcurrencyKey[];

function clampMin(value: unknown, min: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, num);
}

function isMode(value: unknown): value is TelegramConcurrencyMode {
  return value === 'stable' || value === 'balanced' || value === 'aggressive' || value === 'custom';
}

/**
 * 归一化任意来源（持久化 JSON / 跨线程消息）的配置：
 * - 非 custom 模式一律取预设，忽略残留的自定义数值；
 * - custom 模式逐项只夹下限（无数值上限），并按层级依赖修正跨项约束（保留槽位 ≤ 封面池、子池 ≤ 组预算 ≤ 总预算）。
 */
export function normalizeTelegramConcurrency(input: unknown): TelegramConcurrencyConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as { mode?: unknown; limits?: Record<string, unknown> };
  const mode = isMode(raw.mode) ? raw.mode : DEFAULT_TELEGRAM_CONCURRENCY.mode;
  if (mode !== 'custom') return { mode, limits: { ...TELEGRAM_CONCURRENCY_PRESETS[mode] } };

  const source = raw.limits ?? {};
  const fallback = TELEGRAM_CONCURRENCY_PRESETS.balanced;
  const limits = {} as TelegramConcurrencyLimits;
  for (const key of TELEGRAM_CONCURRENCY_KEYS) {
    limits[key] = clampMin(source[key], TELEGRAM_CONCURRENCY_MINIMUMS[key], fallback[key]);
  }
  // 子项不得超过其上级，否则配置值永远达不到、设置页显示会误导用户。先压 cover（媒体子池），再压其下级保留槽位。
  for (const key of NON_MEDIA_SUB_POOLS) limits[key] = Math.min(limits[key], limits.nonMediaRpc);
  for (const key of MEDIA_SUB_POOLS) limits[key] = Math.min(limits[key], limits.mediaRpc);
  limits.searchCoverReserved = Math.min(limits.searchCoverReserved, limits.cover);
  limits.totalActiveTasks = Math.max(limits.totalActiveTasks, Math.max(limits.nonMediaRpc, limits.mediaRpc));
  return { mode, limits };
}
