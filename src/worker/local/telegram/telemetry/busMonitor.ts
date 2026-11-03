/**
 * ============================================================================
 * BusMonitor：Telegram 运行监控采样器（local Worker）
 * ============================================================================
 * 设计要点（见 docs/research/gramjs-business-bus-rearchitecture.md 第 14 章）：
 *   1. 调度器只维护内存计数，本模块按订阅者的频率定时采样组帧，绝不逐事件 postMessage；
 *   2. 有订阅才推送：订阅带租约，超过 MONITOR_LEASE_TTL_MS 未续约自动停止（防标签页崩溃后空推）；
 *   3. 任务表增量：按任务版本号只发送变化的任务与已移除的任务 ID，活跃任务最多 MONITOR_MAX_LIVE_TASKS 个；
 *   4. 耗时分位数基于固定分档直方图的「当前 − 约 10 秒前」差值，代价恒定，不保存原始样本；
 *   5. 帧内不含消息正文、会话标题或文件名。
 */
import {
  LANE_BUS,
  LATENCY_BUCKET_BOUNDS,
  LATENCY_BUCKET_COUNT,
  MONITOR_HZ_OPTIONS,
  MONITOR_LEASE_TTL_MS,
  MONITOR_MAX_DELTA_UPSERTS,
  MONITOR_MAX_LIVE_TASKS,
  SCHEDULER_LANES,
  type MonitorAccountInfo,
  type MonitorAccountStats,
  type MonitorConnectionState,
  type MonitorFrame,
  type MonitorLaneStats,
  type MonitorTask,
} from '../contracts/monitor';
import {
  currentConcurrencyConfig,
  recordMonitorEvent,
  schedulerMonitorSource,
  type TaskRecord,
} from '../runtime/requestScheduler';

const PERCENTILE_WINDOW_MS = 10_000;

interface HistSample { at: number; queue: Uint32Array; run: Uint32Array }

interface Subscriber {
  id: string;
  hz: number;
  timer: ReturnType<typeof setInterval> | null;
  leaseUntil: number;
  seq: number;
  needFull: boolean;
  /** 已发送给该订阅者的任务 → 版本号。 */
  sent: Map<number, number>;
  lastEventSeq: number;
  /** accountId:lane → 直方图历史（用于窗口分位数）。 */
  history: Map<string, HistSample[]>;
}

type FrameSink = (subscriberId: string, frame: MonitorFrame) => void;

const subscribers = new Map<string, Subscriber>();
const connectionStates = new Map<string, { state: MonitorConnectionState; at: number }>();
let sink: FrameSink = () => undefined;
let accountProvider: () => MonitorAccountInfo[] = () => [];

/** tg.worker 启动时注入：帧发送函数与当前账号（前台 P0 + 温池 P1）提供者。 */
export function configureBusMonitor(options: { sink: FrameSink; accounts: () => MonitorAccountInfo[] }) {
  sink = options.sink;
  accountProvider = options.accounts;
}

/** 连接状态变化：记录到账号栏并写入事件流。 */
export function recordConnectionState(accountId: string, state: MonitorConnectionState, message?: string) {
  const previous = connectionStates.get(accountId);
  if (previous?.state === state) return;
  connectionStates.set(accountId, { state, at: Date.now() });
  recordMonitorEvent('connection', message ? `连接状态：${state}（${message}）` : `连接状态：${state}`, { accountId });
}

export function forgetAccountConnection(accountId: string) {
  connectionStates.delete(accountId);
}

function normalizeHz(hz: unknown): number {
  return MONITOR_HZ_OPTIONS.includes(hz as (typeof MONITOR_HZ_OPTIONS)[number]) ? (hz as number) : 4;
}

/** 订阅或续约（同一命令）：首次订阅 / 频率变化时重建定时器，并下发一帧全量数据。 */
export function subscribeMonitor(subscriberId: string, hz: unknown) {
  const rate = normalizeHz(hz);
  let sub = subscribers.get(subscriberId);
  if (!sub) {
    sub = { id: subscriberId, hz: rate, timer: null, leaseUntil: 0, seq: 0, needFull: true, sent: new Map(), lastEventSeq: 0, history: new Map() };
    subscribers.set(subscriberId, sub);
  }
  sub.leaseUntil = Date.now() + MONITOR_LEASE_TTL_MS;
  if (!sub.timer || sub.hz !== rate) {
    if (sub.timer) clearInterval(sub.timer);
    sub.hz = rate;
    sub.history.clear();
    const target = sub;
    target.timer = setInterval(() => tick(target), Math.round(1000 / rate));
    target.needFull = true;
    tick(target);
  }
}

export function unsubscribeMonitor(subscriberId: string) {
  const sub = subscribers.get(subscriberId);
  if (!sub) return;
  if (sub.timer) clearInterval(sub.timer);
  subscribers.delete(subscriberId);
}

/** 主线程检测到帧序号不连续时请求全量帧。 */
export function resyncMonitor(subscriberId: string) {
  const sub = subscribers.get(subscriberId);
  if (sub) sub.needFull = true;
}

export function monitorSubscriberCount() {
  return subscribers.size;
}

function tick(sub: Subscriber) {
  if (Date.now() > sub.leaseUntil) { unsubscribeMonitor(sub.id); return; }
  sink(sub.id, buildFrame(sub));
}

function percentile(diff: Uint32Array, total: number, p: number): number {
  if (total <= 0) return 0;
  const target = Math.ceil(total * p);
  let acc = 0;
  for (let i = 0; i < diff.length; i += 1) {
    acc += diff[i]!;
    if (acc >= target) return i < LATENCY_BUCKET_BOUNDS.length ? LATENCY_BUCKET_BOUNDS[i]! : LATENCY_BUCKET_BOUNDS[LATENCY_BUCKET_BOUNDS.length - 1]! * 2;
  }
  return 0;
}

/** 当前直方图减去窗口起点的直方图，得到最近约 10 秒的分布。 */
function windowPercentiles(sub: Subscriber, key: string, queue: Uint32Array, run: Uint32Array, now: number) {
  let samples = sub.history.get(key);
  if (!samples) { samples = []; sub.history.set(key, samples); }
  samples.push({ at: now, queue: queue.slice(), run: run.slice() });
  while (samples.length > 2 && now - samples[1]!.at >= PERCENTILE_WINDOW_MS) samples.shift();
  const base = samples[0]!;
  const qDiff = new Uint32Array(LATENCY_BUCKET_COUNT);
  const rDiff = new Uint32Array(LATENCY_BUCKET_COUNT);
  let qTotal = 0;
  let rTotal = 0;
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i += 1) {
    qDiff[i] = queue[i]! - base.queue[i]!;
    rDiff[i] = run[i]! - base.run[i]!;
    qTotal += qDiff[i]!;
    rTotal += rDiff[i]!;
  }
  // 窗口内无样本时退回累计分布，避免空闲时分位数归零造成误读。
  const useQ = qTotal > 0 ? qDiff : queue;
  const useR = rTotal > 0 ? rDiff : run;
  const qSum = qTotal > 0 ? qTotal : queue.reduce((a, b) => a + b, 0);
  const rSum = rTotal > 0 ? rTotal : run.reduce((a, b) => a + b, 0);
  return {
    queueMsP50: percentile(useQ, qSum, 0.5),
    queueMsP95: percentile(useQ, qSum, 0.95),
    runMsP50: percentile(useR, rSum, 0.5),
    runMsP95: percentile(useR, rSum, 0.95),
  };
}

function toMonitorTask(record: TaskRecord): MonitorTask {
  return {
    id: record.id,
    accountId: record.accountId,
    traceId: record.traceId,
    lane: record.lane,
    operation: record.operation,
    priority: record.priority,
    state: record.state,
    enqueuedAt: record.enqueuedAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    loaded: record.loaded,
    total: record.total,
    bucket: record.bucket,
  };
}

function buildFrame(sub: Subscriber): MonitorFrame {
  const now = Date.now();
  const { schedulers, recentTasks, events } = schedulerMonitorSource();
  const config = currentConcurrencyConfig();
  const full = sub.needFull;
  sub.needFull = false;

  // 账号：前台 / 温池账号 ∪ 仍有调度器的账号。
  const infos = new Map<string, MonitorAccountInfo>();
  for (const info of accountProvider()) infos.set(info.accountId, info);
  for (const accountId of schedulers.keys()) if (!infos.has(accountId)) infos.set(accountId, { accountId, tier: 'P1' });

  const accounts: MonitorAccountStats[] = [];
  const lanes: MonitorLaneStats[] = [];
  const liveCandidates: TaskRecord[] = [];

  for (const info of infos.values()) {
    const scheduler = schedulers.get(info.accountId);
    const connection = connectionStates.get(info.accountId);
    const view = scheduler?.monitorView();
    const limits = config.limits;
    accounts.push({
      accountId: info.accountId,
      tier: info.tier,
      dcId: info.dcId,
      connection: connection?.state ?? 'unknown',
      lastConnectionChangeAt: connection?.at,
      hasScheduler: Boolean(scheduler),
      total: view?.total ?? 0,
      totalLimit: limits.totalActiveTasks,
      media: view?.groupActive.media ?? 0,
      mediaLimit: limits.mediaRpc,
      nonMedia: view?.groupActive.nonMedia ?? 0,
      nonMediaLimit: limits.nonMediaRpc,
      queued: view?.queued ?? 0,
    });
    if (!scheduler || !view) continue;
    for (const lane of SCHEDULER_LANES) {
      const metrics = scheduler.metrics[lane];
      lanes.push({
        accountId: info.accountId,
        lane,
        bus: LANE_BUS[lane],
        active: view.laneActive[lane],
        queued: view.queuedByLane(lane),
        configured: limits[lane],
        effective: view.effective[lane],
        frozenUntil: view.frozenUntil[lane] > now ? view.frozenUntil[lane] : 0,
        okTotal: metrics.ok,
        errorTotal: metrics.error,
        cancelledTotal: metrics.cancelled,
        bytesTotal: metrics.bytes,
        reservedActive: lane === 'cover' ? view.searchCoverActive : undefined,
        ...windowPercentiles(sub, `${info.accountId}:${lane}`, metrics.queueHist, metrics.runHist, now),
      });
    }
    for (const record of scheduler.live.values()) liveCandidates.push(record);
  }

  // 活跃任务：执行中优先，其次按入队先后；超出上限只报数量。
  liveCandidates.sort((a, b) => (a.state === b.state ? a.enqueuedAt - b.enqueuedAt : a.state === 'running' ? -1 : 1));
  const shownLive = liveCandidates.slice(0, MONITOR_MAX_LIVE_TASKS);
  const candidates = [...shownLive, ...recentTasks];

  const taskUpserts: MonitorTask[] = [];
  const nextSent = new Map<number, number>();
  for (const record of candidates) {
    const sentVersion = sub.sent.get(record.id);
    if (!full && sentVersion === record.version) { nextSent.set(record.id, sentVersion); continue; }
    if (!full && taskUpserts.length >= MONITOR_MAX_DELTA_UPSERTS) {
      // 顺延：保留旧版本号（或不登记新任务），下一帧继续发送。
      if (sentVersion !== undefined) nextSent.set(record.id, sentVersion);
      continue;
    }
    nextSent.set(record.id, record.version);
    taskUpserts.push(toMonitorTask(record));
  }
  const taskRemovals: number[] = [];
  if (!full) for (const id of sub.sent.keys()) if (!nextSent.has(id)) taskRemovals.push(id);
  sub.sent = nextSent;

  const newEvents = full ? events.slice() : events.filter((event) => event.seq > sub.lastEventSeq);
  if (events.length > 0) sub.lastEventSeq = events[events.length - 1]!.seq;

  sub.seq += 1;
  return {
    seq: sub.seq,
    at: now,
    full,
    hz: sub.hz,
    mode: config.mode,
    accounts,
    lanes,
    taskUpserts,
    taskRemovals,
    hiddenTaskCount: liveCandidates.length - shownLive.length,
    events: newEvents,
  };
}
