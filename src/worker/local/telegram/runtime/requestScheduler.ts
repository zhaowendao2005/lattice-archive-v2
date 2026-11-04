/**
 * ============================================================================
 * RequestScheduler：账号级 Telegram 请求调度器
 * ============================================================================
 * 所有经过调度的 GramJS 请求都在同一个 TelegramClient 上受控并发，绝不通过新建连接扩容。
 *
 * 三层预算（全部来自 contracts/concurrency.ts，禁止在业务代码中硬编码数字）：
 *   1. 账号总预算 totalActiveTasks —— 同时在跑的 RPC 任务总数；
 *   2. 组预算 nonMediaRpc / mediaRpc —— 非媒体与媒体 RPC 互相隔离；
 *   3. 业务子池 search / cover / avatar / mediaPart / streamPart / fullMedia。
 *
 * 动态规则：
 *   - FLOOD_WAIT：只冻结「账号 + RPC 方法」桶至服务器给定秒数（冻结期内该方法的新请求直接以 FLOOD_WAIT 拒绝），
 *     同时所在子池有效并发减半；其他方法不受影响；
 *   - TIMEOUT / NETWORK：所在子池有效并发 −1；若任务声明了 dcId，该 DC 的窗口同时 −1（按 DC 降速）；
 *   - 连续成功：子池与 DC 窗口逐步恢复，最多回到用户配置上限，永不超出，也不回写用户配置；
 *   - AUTH_KEY_DUPLICATED / AUTH_KEY_UNREGISTERED / SESSION_REVOKED：停止该账号全部队列并通知运行时；
 *   - 防饿死：排队每满 AGING_STEP_MS 优先级提升一级，后台任务在持续高负载下也能最终执行；
 *   - 账号关闭后仍在执行的任务完成时，结果按 TG_CANCELED 丢弃，不回写旧账号状态。
 *
 * 监控埋点（供 telemetry/busMonitor 采样，自身不发送任何消息）：
 *   - 每个任务一条记录（排队 / 执行中），完成后进入定长「最近任务」环；
 *   - 每个子池累计成功 / 失败 / 取消 / 字节数与固定分档耗时直方图；
 *   - 状态变化事件（限流、降速、恢复、关闭、配置）写入定长事件环。
 */
import {
  DEFAULT_TELEGRAM_CONCURRENCY,
  normalizeTelegramConcurrency,
  type TelegramConcurrencyConfig,
  type TelegramConcurrencyLimits,
} from '../contracts/concurrency';
import {
  LATENCY_BUCKET_BOUNDS,
  LATENCY_BUCKET_COUNT,
  MONITOR_MAX_EVENTS,
  MONITOR_MAX_RECENT_TASKS,
  SCHEDULER_LANES,
  type MonitorEvent,
  type MonitorEventKind,
  type MonitorTaskState,
  type SchedulerLane,
  type SchedulerPriority,
} from '../contracts/monitor';
import { emitLocalSpan } from '../telemetry/localSpans';
import { classifyTelegramError } from '../../chat/telegramErrors';

export type { SchedulerLane, SchedulerPriority };

type LaneGroup = 'nonMedia' | 'media' | 'none';

/** fullMedia 只限制「同时下载的文件数」；文件内部的分片 RPC 走 mediaPart 计入媒体组与总预算，避免双重占槽死锁。 */
const LANE_GROUP: Record<SchedulerLane, LaneGroup> = {
  account: 'nonMedia',
  chatRead: 'nonMedia',
  search: 'nonMedia',
  chatCommand: 'nonMedia',
  bot: 'nonMedia',
  vault: 'nonMedia',
  avatar: 'media',
  cover: 'media',
  mediaPart: 'media',
  streamPart: 'media',
  fullMedia: 'none',
};

const LANE_LIMIT_KEY: Record<SchedulerLane, keyof TelegramConcurrencyLimits> = {
  account: 'account',
  chatRead: 'chatRead',
  search: 'search',
  chatCommand: 'chatCommand',
  bot: 'bot',
  vault: 'vault',
  avatar: 'avatar',
  cover: 'cover',
  mediaPart: 'mediaPart',
  streamPart: 'streamPart',
  fullMedia: 'fullMedia',
};

const PRIORITY_RANK: Record<SchedulerPriority, number> = { interactive: 0, visible: 1, prefetch: 2, background: 3 };
const RECOVER_AFTER_SUCCESSES = 8;
const MAX_FREEZE_MS = 5 * 60_000;
/** 排队每满该时长，有效优先级提升一级（防饿死）。 */
export const AGING_STEP_MS = 2_000;
/** 会话失效类错误：停止该账号全部队列。 */
const ACCOUNT_FATAL_CODES = ['AUTH_KEY_DUPLICATED', 'AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'USER_DEACTIVATED'];
const LANES = SCHEDULER_LANES;

export interface ScheduleOptions {
  priority?: SchedulerPriority;
  /** 搜索结果封面：可使用封面池中为搜索保留的槽位。 */
  searchCover?: boolean;
  signal?: AbortSignal;
  /** 监控与日志用的业务操作名（如 cover.photo / media.part），不得包含会话或文件内容。 */
  operation?: string;
  /** Telegram RPC 方法名（如 messages.Search / upload.GetFile）：FloodWait 按「账号 + 方法」冻结。缺省按子池。 */
  method?: string;
  /** 目标数据中心：超时按 DC 降低并发窗口。 */
  dcId?: number;
  /** 由上游指定的 traceId（总线请求上下文）；缺省自动生成。 */
  traceId?: string;
}

/** 总线请求上下文中传给调度器的部分（优先级、traceId 与取消信号来自上游 TelegramBusContext）。 */
export type BusTaskOptions = Pick<ScheduleOptions, 'priority' | 'traceId' | 'signal'>;

/** 传给任务函数的句柄：上报字节与进度，供监控面板计算吞吐。 */
export interface TaskHandle {
  readonly traceId: string;
  addBytes(bytes: number): void;
  progress(loaded: number, total: number): void;
}

/** 任务记录：排队与执行中的任务都在 live 表中，结束后移入最近任务环。 */
export interface TaskRecord {
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
  method: string;
  dcId?: number;
  /** 全局递增版本号：任何字段变化都会更新，监控按版本做增量。 */
  version: number;
}

export interface LaneMetrics {
  ok: number;
  error: number;
  cancelled: number;
  bytes: number;
  queueHist: Uint32Array;
  runHist: Uint32Array;
}

interface QueuedTask {
  record: TaskRecord;
  rank: number;
  searchCover: boolean;
  start: () => void;
  fail: (error: unknown) => void;
  detach?: () => void;
}

function canceledError(): Error {
  return Object.assign(new Error('请求已取消'), { code: 'TG_CANCELED' });
}

function floodError(retryAfterMs: number): Error {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return Object.assign(new Error(`Telegram 限流中，请在 ${seconds} 秒后重试`), { code: `FLOOD_WAIT_${seconds}`, seconds });
}

function bucketIndex(ms: number): number {
  for (let i = 0; i < LATENCY_BUCKET_BOUNDS.length; i += 1) if (ms <= LATENCY_BUCKET_BOUNDS[i]!) return i;
  return LATENCY_BUCKET_COUNT - 1;
}

function newLaneMetrics(): LaneMetrics {
  return { ok: 0, error: 0, cancelled: 0, bytes: 0, queueHist: new Uint32Array(LATENCY_BUCKET_COUNT), runHist: new Uint32Array(LATENCY_BUCKET_COUNT) };
}

let currentConfig: TelegramConcurrencyConfig = normalizeTelegramConcurrency(DEFAULT_TELEGRAM_CONCURRENCY);
/** 账号级致命错误回调（由 tg.worker 注入：广播 auth-expired 并拆除该账号连接）。 */
let fatalHandler: (accountId: string, code: string) => void = () => undefined;
export function onAccountFatal(handler: (accountId: string, code: string) => void) { fatalHandler = handler; }
const schedulers = new Map<string, AccountRequestScheduler>();
let taskSeq = 0;
let versionSeq = 0;
let eventSeq = 0;
/** 最近结束的任务（跨账号），定长环。 */
const recentTasks: TaskRecord[] = [];
/** 状态变化事件，定长环。 */
const events: MonitorEvent[] = [];

const bump = (record: TaskRecord) => { record.version = versionSeq += 1; };

/** 记录监控事件（Worker 其他模块如连接状态变化也通过它写入）。 */
export function recordMonitorEvent(kind: MonitorEventKind, message: string, extra: Partial<Pick<MonitorEvent, 'accountId' | 'lane' | 'traceId'>> = {}) {
  events.push({ seq: eventSeq += 1, at: Date.now(), kind, message, ...extra });
  if (events.length > MONITOR_MAX_EVENTS) events.splice(0, events.length - MONITOR_MAX_EVENTS);
}

function retire(record: TaskRecord) {
  recentTasks.push(record);
  if (recentTasks.length > MONITOR_MAX_RECENT_TASKS) recentTasks.splice(0, recentTasks.length - MONITOR_MAX_RECENT_TASKS);
}

export class AccountRequestScheduler {
  readonly accountId: string;
  private queue: QueuedTask[] = [];
  private total = 0;
  private readonly groupActive: Record<LaneGroup, number> = { nonMedia: 0, media: 0, none: 0 };
  private readonly laneActive = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<SchedulerLane, number>;
  private searchCoverActive = 0;
  private effective: Record<SchedulerLane, number>;
  /** 方法桶 → 冻结截止时间（FloodWait）。 */
  private readonly frozenMethods = new Map<string, number>();
  /** 子池视角的冻结截止（取该子池内最晚的方法冻结），供监控展示。 */
  private readonly frozenUntil = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<SchedulerLane, number>;
  /** DC → 当前窗口 / 活跃数 / 连续成功次数。 */
  private readonly dcWindow = new Map<number, { limit: number; active: number; streak: number }>();
  private haltedCode: string | null = null;
  private readonly successStreak = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<SchedulerLane, number>;
  private readonly unfreezeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 排队与执行中的任务。 */
  readonly live = new Map<number, TaskRecord>();
  readonly metrics = Object.fromEntries(LANES.map((lane) => [lane, newLaneMetrics()])) as Record<SchedulerLane, LaneMetrics>;
  private closed = false;

  constructor(accountId: string) {
    this.accountId = accountId;
    this.effective = this.configuredLimits();
  }

  /** 用户配置变化：有效并发重置为新上限，冻结状态保留（服务器给的等待时间仍然有效）。 */
  reconfigure() {
    this.effective = this.configuredLimits();
    this.pump();
  }

  /** 账号断开 / 切换：拒绝全部排队任务，阻止旧账号请求继续发出。 */
  close() {
    this.closed = true;
    const pending = this.queue;
    this.queue = [];
    for (const timer of this.unfreezeTimers.values()) clearTimeout(timer);
    this.unfreezeTimers.clear();
    for (const task of pending) this.cancelQueued(task);
    recordMonitorEvent('scheduler_closed', `调度器已关闭，取消排队任务 ${pending.length} 个`, { accountId: this.accountId });
  }

  /** 是否因会话失效而停摆（停摆后所有请求以该错误码拒绝，直到账号重新授权）。 */
  get halted() { return this.haltedCode; }

  run<T>(lane: SchedulerLane, task: (handle: TaskHandle) => Promise<T>, options: ScheduleOptions = {}): Promise<T> {
    if (this.haltedCode) return Promise.reject(Object.assign(new Error('Telegram 授权已失效，请重新添加设备'), { code: this.haltedCode }));
    if (this.closed) return Promise.reject(canceledError());
    if (options.signal?.aborted) return Promise.reject(canceledError());
    const method = options.method ?? lane;
    const frozenMs = (this.frozenMethods.get(method) ?? 0) - Date.now();
    if (frozenMs > 0) return Promise.reject(floodError(frozenMs));

    const id = taskSeq += 1;
    const record: TaskRecord = {
      id,
      accountId: this.accountId,
      traceId: options.traceId ?? `tg-${id.toString(36)}`,
      lane,
      operation: options.operation ?? lane,
      priority: options.priority ?? 'visible',
      state: 'queued',
      enqueuedAt: Date.now(),
      method,
      dcId: options.dcId,
      version: 0,
    };
    bump(record);

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedTask = {
        record,
        rank: PRIORITY_RANK[record.priority],
        searchCover: options.searchCover === true,
        fail: reject,
        start: () => {
          queued.detach?.();
          record.state = 'running';
          record.startedAt = Date.now();
          bump(record);
          this.metrics[lane].queueHist[bucketIndex(record.startedAt - record.enqueuedAt)]! += 1;
          this.acquire(queued);
          const handle: TaskHandle = {
            traceId: record.traceId,
            addBytes: (bytes) => { if (bytes > 0) this.metrics[lane].bytes += bytes; },
            progress: (loaded, total) => { record.loaded = loaded; record.total = total; bump(record); },
          };
          // 先释放槽位再通知调用方，保证调用方续发请求时看到的是准确的占用计数。
          const settle = (failed: boolean, error?: unknown) => {
            this.release(queued);
            this.finish(record, failed, error);
            this.adapt(lane, failed, error, record);
            this.pump();
          };
          let promise: Promise<T>;
          try { promise = task(handle); } catch (error) { promise = Promise.reject(error); }
          promise.then(
            (value) => {
              // 账号已关闭（切换 / 断开）：结果属于旧账号，丢弃而不是回写。
              if (this.closed && !this.haltedCode) { settle(true, canceledError()); reject(canceledError()); return; }
              settle(false);
              resolve(value);
            },
            (error: unknown) => { settle(true, error); reject(error); },
          );
        },
      };
      if (options.signal) {
        const signal = options.signal;
        const onAbort = () => {
          const index = this.queue.indexOf(queued);
          if (index < 0) return;
          this.queue.splice(index, 1);
          this.cancelQueued(queued);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        queued.detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.live.set(id, record);
      this.queue.push(queued);
      this.pump();
    });
  }

  /** 监控采样用的只读视图。 */
  monitorView() {
    const limits = currentConfig.limits;
    return {
      total: this.total,
      queued: this.queue.length,
      groupActive: this.groupActive,
      laneActive: this.laneActive,
      effective: this.effective,
      frozenUntil: this.frozenUntil,
      searchCoverActive: this.searchCoverActive,
      limits,
      queuedByLane: (lane: SchedulerLane) => this.queue.reduce((n, task) => n + (task.record.lane === lane ? 1 : 0), 0),
    };
  }

  get isClosed() { return this.closed; }

  /** 当前调度快照（测试 / 调试）。 */
  snapshot() {
    return {
      accountId: this.accountId,
      total: this.total,
      queued: this.queue.length,
      groupActive: { ...this.groupActive },
      laneActive: { ...this.laneActive },
      effective: { ...this.effective },
    };
  }

  private configuredLimits(): Record<SchedulerLane, number> {
    const limits = currentConfig.limits;
    return Object.fromEntries(LANES.map((lane) => [lane, limits[LANE_LIMIT_KEY[lane]]])) as Record<SchedulerLane, number>;
  }

  private canStart(task: QueuedTask): boolean {
    const limits = currentConfig.limits;
    const { lane, method, dcId } = task.record;
    const group = LANE_GROUP[lane];
    if ((this.frozenMethods.get(method) ?? 0) > Date.now()) return false;
    if (this.laneActive[lane] >= this.effective[lane]) return false;
    if (dcId !== undefined && group !== 'none') {
      const dc = this.dcWindow.get(dcId);
      if (dc && dc.active >= dc.limit) return false;
    }
    if (group === 'none') return true;
    if (this.total >= limits.totalActiveTasks) return false;
    if (group === 'media' && this.groupActive.media >= limits.mediaRpc) return false;
    if (group === 'nonMedia' && this.groupActive.nonMedia >= limits.nonMediaRpc) return false;
    if (lane === 'cover' && !task.searchCover) {
      // 普通封面不得占用仍未被搜索封面使用的保留槽位。
      const reservedIdle = Math.max(0, Math.min(limits.searchCoverReserved, this.effective.cover) - this.searchCoverActive);
      if (this.laneActive.cover >= this.effective.cover - reservedIdle) return false;
    }
    return true;
  }

  private dcEntry(dcId: number) {
    let dc = this.dcWindow.get(dcId);
    if (!dc) { dc = { limit: currentConfig.limits.mediaRpc, active: 0, streak: 0 }; this.dcWindow.set(dcId, dc); }
    return dc;
  }

  private acquire(task: QueuedTask) {
    const { lane, dcId } = task.record;
    const group = LANE_GROUP[lane];
    this.laneActive[lane] += 1;
    if (dcId !== undefined && group !== 'none') this.dcEntry(dcId).active += 1;
    if (group !== 'none') { this.total += 1; this.groupActive[group] += 1; }
    if (task.searchCover) this.searchCoverActive += 1;
  }

  private release(task: QueuedTask) {
    const { lane, dcId } = task.record;
    const group = LANE_GROUP[lane];
    this.laneActive[lane] = Math.max(0, this.laneActive[lane] - 1);
    if (dcId !== undefined && group !== 'none') { const dc = this.dcEntry(dcId); dc.active = Math.max(0, dc.active - 1); }
    if (group !== 'none') { this.total = Math.max(0, this.total - 1); this.groupActive[group] = Math.max(0, this.groupActive[group] - 1); }
    if (task.searchCover) this.searchCoverActive = Math.max(0, this.searchCoverActive - 1);
  }

  /** 排队中被取消（abort / 关闭 / 熔断拒绝）：从未执行，不计入耗时直方图。 */
  private cancelQueued(task: QueuedTask, error: unknown = canceledError()) {
    task.detach?.();
    const { record } = task;
    const flood = classifyTelegramError(error).bucket === 'FLOOD_WAIT';
    record.state = flood ? 'error' : 'cancelled';
    record.bucket = flood ? 'FLOOD_WAIT' : 'CANCELLED';
    record.endedAt = Date.now();
    bump(record);
    if (flood) this.metrics[record.lane].error += 1;
    else this.metrics[record.lane].cancelled += 1;
    this.live.delete(record.id);
    retire(record);
    task.fail(error);
  }

  private finish(record: TaskRecord, failed: boolean, error: unknown) {
    const metrics = this.metrics[record.lane];
    record.endedAt = Date.now();
    const runMs = record.endedAt - (record.startedAt ?? record.endedAt);
    metrics.runHist[bucketIndex(runMs)]! += 1;
    if (!failed) {
      record.state = 'ok';
      metrics.ok += 1;
    } else {
      const info = classifyTelegramError(error);
      record.bucket = info.bucket;
      record.state = info.bucket === 'CANCELLED' ? 'cancelled' : 'error';
      if (record.state === 'cancelled') metrics.cancelled += 1;
      else metrics.error += 1;
    }
    bump(record);
    this.live.delete(record.id);
    retire(record);
    emitLocalSpan({
      traceId: record.traceId,
      domain: 'bus.task',
      action: record.state,
      level: record.state === 'error' ? 'WARN' : 'DEBUG',
      durMs: runMs,
      tags: {
        accountId: record.accountId,
        lane: record.lane,
        operation: record.operation,
        priority: record.priority,
        queueMs: (record.startedAt ?? record.endedAt) - record.enqueuedAt,
        bucket: record.bucket,
        bytes: record.total ?? record.loaded,
      },
    });
  }

  /** 按有效优先级（含排队老化）、再按入队顺序挑选第一个可启动的任务，循环填满空余槽位。 */
  private pump() {
    if (this.closed) return;
    this.rejectFrozen();
    const now = Date.now();
    const rankOf = (task: QueuedTask) => Math.max(0, task.rank - Math.floor((now - task.record.enqueuedAt) / AGING_STEP_MS));
    for (;;) {
      let best: QueuedTask | undefined;
      let bestRank = Infinity;
      for (const task of this.queue) {
        const rank = rankOf(task);
        if (best && (rank > bestRank || (rank === bestRank && task.record.id > best.record.id))) continue;
        if (this.canStart(task)) { best = task; bestRank = rank; }
      }
      if (!best) return;
      this.queue.splice(this.queue.indexOf(best), 1);
      best.start();
    }
  }

  /** 熔断中的方法桶：排队任务立即以 FLOOD_WAIT 返回，交由上游按退避策略重试，避免无限挂起。 */
  private rejectFrozen() {
    const now = Date.now();
    if (this.frozenMethods.size === 0) return;
    const keep: QueuedTask[] = [];
    const rejected: QueuedTask[] = [];
    for (const task of this.queue) {
      if ((this.frozenMethods.get(task.record.method) ?? 0) > now) rejected.push(task); else keep.push(task);
    }
    this.queue = keep;
    for (const task of rejected) this.cancelQueued(task, floodError((this.frozenMethods.get(task.record.method) ?? now) - now));
  }

  /** 会话失效：拒绝全部排队任务，之后的请求以同一错误码拒绝，并通知运行时拆除该账号连接。 */
  private halt(code: string) {
    if (this.haltedCode) return;
    this.haltedCode = code;
    this.closed = true;
    const pending = this.queue;
    this.queue = [];
    const error = Object.assign(new Error('Telegram 授权已失效，请重新添加设备'), { code });
    for (const task of pending) this.cancelQueued(task, error);
    recordMonitorEvent('account_halted', `会话失效（${code}），已停止该账号全部队列 ${pending.length} 个`, { accountId: this.accountId });
    fatalHandler(this.accountId, code);
  }

  private adapt(lane: SchedulerLane, failed: boolean, error: unknown, record: TaskRecord) {
    const configured = currentConfig.limits[LANE_LIMIT_KEY[lane]];
    const dc = record.dcId !== undefined && LANE_GROUP[lane] !== 'none' ? this.dcEntry(record.dcId) : null;
    if (!failed) {
      if (dc && dc.limit < currentConfig.limits.mediaRpc && (dc.streak += 1) >= RECOVER_AFTER_SUCCESSES) { dc.limit += 1; dc.streak = 0; }
      this.successStreak[lane] += 1;
      if (this.successStreak[lane] >= RECOVER_AFTER_SUCCESSES && this.effective[lane] < configured) {
        this.effective[lane] += 1;
        this.successStreak[lane] = 0;
        if (this.effective[lane] === configured) {
          recordMonitorEvent('recover', `${lane} 已恢复到配置上限 ${configured}`, { accountId: this.accountId, lane });
        }
      }
      return;
    }
    this.successStreak[lane] = 0;
    if (dc) dc.streak = 0;
    const info = classifyTelegramError(error);
    if (ACCOUNT_FATAL_CODES.some((code) => info.code.includes(code))) {
      this.halt(info.code);
      return;
    }
    if (info.bucket === 'FLOOD_WAIT') {
      const seconds = Number(/(\d+)$/.exec(info.code)?.[1] ?? 0);
      const freezeMs = Math.min(MAX_FREEZE_MS, Math.max(1, seconds) * 1000);
      const until = Math.max(this.frozenMethods.get(record.method) ?? 0, Date.now() + freezeMs);
      this.frozenMethods.set(record.method, until);
      this.frozenUntil[lane] = Math.max(this.frozenUntil[lane], until);
      this.effective[lane] = Math.max(1, Math.floor(this.effective[lane] / 2));
      this.scheduleUnfreeze(record.method, lane);
      recordMonitorEvent('flood_wait', `${record.method} 触发限流，暂停 ${Math.ceil(freezeMs / 1000)} 秒；${lane} 有效并发降至 ${this.effective[lane]}`, { accountId: this.accountId, lane, traceId: record.traceId });
      this.log('flood_wait', 'WARN', record, { freezeMs, effective: this.effective[lane], code: info.code, method: record.method });
      return;
    }
    if (info.bucket === 'TIMEOUT' || info.bucket === 'NETWORK') {
      this.effective[lane] = Math.max(1, this.effective[lane] - 1);
      if (dc) dc.limit = Math.max(1, dc.limit - 1);
      const dcNote = dc ? `，DC${record.dcId} 窗口降至 ${dc.limit}` : '';
      recordMonitorEvent('backoff', `${lane} 超时 / 网络异常，有效并发降至 ${this.effective[lane]}${dcNote}`, { accountId: this.accountId, lane, traceId: record.traceId });
      this.log('backoff', 'WARN', record, { effective: this.effective[lane], code: info.code, dcLimit: dc?.limit ?? 0 });
    }
  }

  private scheduleUnfreeze(method: string, lane: SchedulerLane) {
    const existing = this.unfreezeTimers.get(method);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, (this.frozenMethods.get(method) ?? 0) - Date.now());
    this.unfreezeTimers.set(method, setTimeout(() => {
      this.unfreezeTimers.delete(method);
      this.frozenMethods.delete(method);
      if (this.closed) return;
      recordMonitorEvent('unfreeze', `${method} 限流暂停结束`, { accountId: this.accountId, lane });
      this.pump();
    }, delay));
  }

  /** DC 窗口快照（监控 / 测试）。 */
  dcSnapshot() {
    return Array.from(this.dcWindow.entries()).map(([dcId, dc]) => ({ dcId, limit: dc.limit, active: dc.active }));
  }

  private log(action: string, level: 'DEBUG' | 'WARN', record: TaskRecord, tags: Record<string, string | number | boolean>) {
    emitLocalSpan({
      traceId: record.traceId,
      domain: 'bus.scheduler',
      action,
      level,
      tags: {
        accountId: this.accountId,
        lane: record.lane,
        operation: record.operation,
        total: this.total,
        queued: this.queue.length,
        laneActive: this.laneActive[record.lane],
        ...tags,
      },
    });
  }
}

/**
 * 每个 Telegram 账号一个调度器（对应唯一 TelegramClient）。
 * 已关闭（非停摆）的调度器会被替换；停摆的调度器保留，直到 reviveScheduler（重新授权）。
 */
export function schedulerFor(accountId: string): AccountRequestScheduler {
  let scheduler = schedulers.get(accountId);
  if (!scheduler || (scheduler.isClosed && !scheduler.halted)) {
    scheduler = new AccountRequestScheduler(accountId);
    schedulers.set(accountId, scheduler);
  }
  return scheduler;
}

/** 账号断开：取消排队任务并移除调度器。 */
export function closeScheduler(accountId: string) {
  schedulers.get(accountId)?.close();
  schedulers.delete(accountId);
}

/** 账号重新授权成功：清除停摆状态，后续请求使用新的调度器。 */
export function reviveScheduler(accountId: string) {
  const scheduler = schedulers.get(accountId);
  if (scheduler?.halted) schedulers.delete(accountId);
}

/** 关闭全部账号调度器（Worker 销毁 / Lattice 用户切换）。 */
export function closeAllSchedulers() {
  for (const scheduler of schedulers.values()) scheduler.close();
  schedulers.clear();
}

/** 应用用户配置（来自主线程 init / setConcurrency 命令），立即作用于后续调度。 */
export function applyConcurrencyConfig(input: unknown): TelegramConcurrencyConfig {
  currentConfig = normalizeTelegramConcurrency(input);
  for (const scheduler of schedulers.values()) scheduler.reconfigure();
  recordMonitorEvent('config_applied', `并发配置已应用：${currentConfig.mode}`);
  emitLocalSpan({
    domain: 'bus.scheduler',
    action: 'config_applied',
    level: 'INFO',
    tags: { mode: currentConfig.mode, ...currentConfig.limits },
  });
  return currentConfig;
}

export function currentConcurrencyConfig(): TelegramConcurrencyConfig {
  return currentConfig;
}

/** 监控采样入口：全部账号调度器、最近任务环与事件环（只读引用，调用方不得修改）。 */
export function schedulerMonitorSource() {
  return { schedulers: schedulers as ReadonlyMap<string, AccountRequestScheduler>, recentTasks: recentTasks as readonly TaskRecord[], events: events as readonly MonitorEvent[] };
}
