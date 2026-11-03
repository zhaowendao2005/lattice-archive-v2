/**
 * ============================================================================
 * [DATA SOURCE] 全局图片与封面加载总线 (Cover / Image Loader Bus)
 * ============================================================================
 * 架构规范：
 * 1. 薄桥接层（Thin Bridge），无 Vue 响应式状态，仅做并发调度、排队、去重与限流；
 * 2. 并发上限来自统一的 Telegram 并发配置（设置 → 性能与网络），不在此硬编码：
 *    - 总并发 = 封面 + 头像配额；Worker 内 RequestScheduler 仍按账号预算做最终限流；
 *    - 搜索通道保底 = 搜索封面保留槽位，其余通道保底 2，防止批量刷新饿死其它通道；
 * 4. 相同 Key 的在途请求自动合并（去重），避免同一图片重复发起 MTProto 下载。
 */

import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';
import { classifyTelegramError } from '@/worker/local/chat/telegramErrors';
import type { TelegramConcurrencyConfig } from '@/worker/local/telegram/contracts/concurrency';
import { telegramPerformancePreferences } from '@/stores/telegram/data-sources/telegramPerformancePreferences';

export type CoverBusLane = 'archive_tiles' | 'search' | 'chat_avatars' | 'chat_media';

export interface CoverBusTaskOptions<T> {
  key: string;
  lane: CoverBusLane;
  priority?: number; // 数值越大越优先
  fetch: () => Promise<T>;
}

interface QueuedTask<T> {
  key: string;
  lane: CoverBusLane;
  priority: number;
  fetch: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface CoverBusLimits {
  total: number;
  guaranteed: Record<CoverBusLane, number>;
  max: Record<CoverBusLane, number>;
}

function limitsFrom(config: TelegramConcurrencyConfig): CoverBusLimits {
  const { cover, avatar, searchCoverReserved } = config.limits;
  return {
    total: cover + avatar,
    guaranteed: {
      archive_tiles: Math.min(2, cover),
      search: Math.max(1, searchCoverReserved),
      chat_avatars: Math.min(2, avatar),
      chat_media: Math.min(2, cover),
    },
    max: { archive_tiles: cover, search: cover, chat_avatars: avatar, chat_media: cover },
  };
}

class CoverImageBus {
  private queue: QueuedTask<any>[] = [];
  private activeByLane: Record<CoverBusLane, number> = {
    archive_tiles: 0,
    search: 0,
    chat_avatars: 0,
    chat_media: 0,
  };
  private totalActive = 0;
  private inflightPromises = new Map<string, Promise<any>>();
  private lastSaturatedLogAt = 0;
  private limits: CoverBusLimits = limitsFrom(telegramPerformancePreferences.read());

  constructor() {
    telegramPerformancePreferences.subscribe((config) => {
      this.limits = limitsFrom(config);
      this.processQueue();
    });
  }

  private emit(
    action: string,
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    tags: Record<string, string | number | boolean | undefined>,
    message?: string,
    durMs?: number,
  ): void {
    debugLoggerDataSource.emitFrontendLog({
      domain: 'archive.cover',
      action,
      level,
      durMs,
      message,
      tags,
    });
  }

  /**
   * 提交一个封面/缩略图加载任务到总线
   */
  request<T>(options: CoverBusTaskOptions<T>): Promise<T> {
    const { key, lane, priority = 10, fetch } = options;

    // 1. 在途请求去重：若相同 key 正在下载中，直接复用其 Promise
    const existing = this.inflightPromises.get(key);
    if (existing) {
      this.emit(
        'bus_dedupe',
        'DEBUG',
        { key, lane, queued: this.queue.length, totalActive: this.totalActive },
        '同一封面请求已在途，复用现有任务',
      );
      return existing as Promise<T>;
    }

    const enqueuedAt = Date.now();
    this.emit(
      'bus_enqueue',
      'DEBUG',
      {
        key,
        lane,
        priority,
        queued: this.queue.length + 1,
        totalActive: this.totalActive,
        activeInLane: this.activeByLane[lane],
      },
      '封面任务入队',
    );

    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({
        key,
        lane,
        priority,
        fetch,
        resolve,
        reject,
      });
      // 按优先级从大到小排序
      this.queue.sort((a, b) => b.priority - a.priority);
      this.processQueue();
    })
      .then((value) => {
        this.emit(
          'bus_done',
          'DEBUG',
          {
            key,
            lane,
            priority,
            waitMs: Date.now() - enqueuedAt,
            queued: this.queue.length,
            totalActive: this.totalActive,
          },
          '封面任务完成',
        );
        return value;
      })
      .catch((error: unknown) => {
        const info = classifyTelegramError(error);
        this.emit(
          'bus_error',
          'WARN',
          {
            key,
            lane,
            priority,
            waitMs: Date.now() - enqueuedAt,
            queued: this.queue.length,
            totalActive: this.totalActive,
            bucket: info.bucket,
            code: info.code,
            retryable: info.retryable,
          },
          info.description,
        );
        throw error;
      })
      .finally(() => {
        this.inflightPromises.delete(key);
      });

    this.inflightPromises.set(key, promise);
    return promise;
  }

  /**
   * 并发调度泵：遵循总并发上限与通道保底/突发上限
   */
  private processQueue(): void {
    if (this.queue.length >= 24) {
      const now = Date.now();
      if (now - this.lastSaturatedLogAt > 5_000) {
        this.lastSaturatedLogAt = now;
        this.emit(
          'bus_saturated',
          'WARN',
          {
            queued: this.queue.length,
            totalActive: this.totalActive,
            ...this.activeByLane,
          },
          '封面总线排队积压，已触发弹性调度',
        );
      }
    }

    if (this.queue.length === 0 || this.totalActive >= this.limits.total) {
      return;
    }

    // 寻找一个符合调度资格的任务
    let candidateIndex = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i]!;
      const laneActive = this.activeByLane[task.lane];
      const laneMax = this.limits.max[task.lane];

      // 通道已达其最大允许并发，不能再接
      if (laneActive >= laneMax) continue;

      // 若总活动数还有富余，或者该通道处于其保底份额内（活跃数 < 保底数），则可以执行
      const isGuaranteed = laneActive < this.limits.guaranteed[task.lane];
      const hasGeneralSlot = this.totalActive < this.limits.total;

      if (isGuaranteed || hasGeneralSlot) {
        candidateIndex = i;
        break;
      }
    }

    if (candidateIndex === -1) return;

    const [task] = this.queue.splice(candidateIndex, 1);
    if (!task) return;

    this.totalActive += 1;
    this.activeByLane[task.lane] += 1;

    task.fetch()
      .then((val) => {
        task.resolve(val);
      })
      .catch((err) => {
        task.reject(err);
      })
      .finally(() => {
        this.totalActive = Math.max(0, this.totalActive - 1);
        this.activeByLane[task.lane] = Math.max(0, this.activeByLane[task.lane] - 1);
        // 触发下一次调度
        this.processQueue();
      });

    // 尝试并发填充其余空余槽位
    if (this.totalActive < this.limits.total && this.queue.length > 0) {
      this.processQueue();
    }
  }

  /** 获取当前总线健康状态（供调试终端观察） */
  getMetrics() {
    return {
      totalActive: this.totalActive,
      queued: this.queue.length,
      inflightKeys: this.inflightPromises.size,
      activeByLane: { ...this.activeByLane },
    };
  }
}

export const coverImageBus = new CoverImageBus();
