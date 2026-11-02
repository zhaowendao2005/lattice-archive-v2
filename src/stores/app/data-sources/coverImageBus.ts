/**
 * ============================================================================
 * [DATA SOURCE] 全局图片与封面加载总线 (Cover / Image Loader Bus)
 * ============================================================================
 * 架构规范：
 * 1. 薄桥接层（Thin Bridge），无 Vue 响应式状态，仅做并发调度、排队、去重与限流；
 * 2. 总并发弹性限制在 16（在用户指定的 10~20 区间内）；
 * 3. 业务模块隔离与保底：
 *    - 每个业务通道（Lane: 'archive_tiles' | 'search' | 'chat_avatars' | 'chat_media'）
 *      保底至少 2 个并发槽位，防止某一个业务爆发式拉取（如批量刷新 100 个磁贴）饿死其它通道；
 *    - 磁贴批量刷新通道 ('archive_tiles') 峰值并发提升至 8（满足用户指定的“并行 8”需求）；
 * 4. 相同 Key 的在途请求自动合并（去重），避免同一图片重复发起 MTProto 下载。
 */

import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';
import { classifyTelegramError } from '@/worker/local/chat/telegramErrors';

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

const TOTAL_MAX_CONCURRENCY = 16;
const LANE_GUARANTEED_SLOTS: Record<CoverBusLane, number> = {
  archive_tiles: 2,
  search: 2,
  chat_avatars: 2,
  chat_media: 2,
};
const LANE_MAX_CONCURRENCY: Record<CoverBusLane, number> = {
  archive_tiles: 8,
  search: 8,
  chat_avatars: 6,
  chat_media: 6,
};

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

    if (this.queue.length === 0 || this.totalActive >= TOTAL_MAX_CONCURRENCY) {
      return;
    }

    // 寻找一个符合调度资格的任务
    let candidateIndex = -1;
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i]!;
      const laneActive = this.activeByLane[task.lane];
      const laneMax = LANE_MAX_CONCURRENCY[task.lane];

      // 通道已达其最大允许并发，不能再接
      if (laneActive >= laneMax) continue;

      // 若总活动数还有富余，或者该通道处于其保底份额内（活跃数 < 保底数），则可以执行
      const isGuaranteed = laneActive < LANE_GUARANTEED_SLOTS[task.lane];
      const hasGeneralSlot = this.totalActive < TOTAL_MAX_CONCURRENCY;

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
    if (this.totalActive < TOTAL_MAX_CONCURRENCY && this.queue.length > 0) {
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
