/**
 * [DATA SOURCE] Telegram 运行监控桥接（薄桥接 + 高频缓冲 + Canvas 句柄）
 *
 * 职责：
 * 1. 经 mtprotoHub 订阅 Worker BusMonitor：租约续约、页面隐藏自动退订 / 恢复、帧序号断档时请求全量重同步；
 * 2. 高频帧不直接写响应式状态：任务表用普通 Map 增量维护，时间序列写入定长 Float64Array 环形缓冲；
 * 3. 每个 requestAnimationFrame 最多向 Store 提交一次整体替换的浅层快照，并在同一回调内重绘 Canvas；
 * 4. 托管 Canvas DOM 句柄（视图零 ref）。曲线数据不进入 Store。
 */
import { mtprotoHub } from './mtprotoBridge';
import {
  LANE_BUS,
  MONITOR_LEASE_RENEW_MS,
  MONITOR_MAX_EVENTS,
  type MonitorAccountStats,
  type MonitorBusId,
  type MonitorEvent,
  type MonitorFrame,
  type MonitorLaneStats,
  type MonitorTask,
} from '@/worker/local/telegram/contracts/monitor';

export interface MonitorLaneView extends MonitorLaneStats {
  /** 每秒速率（指数平滑）。 */
  okRate: number;
  errorRate: number;
  bytesRate: number;
  status: 'normal' | 'degraded' | 'frozen';
  frozenSeconds: number;
}

export interface MonitorSnapshot {
  seq: number;
  receivedAt: number;
  hz: number;
  mode: string;
  /** 超过 3 个帧间隔未收到数据。 */
  stale: boolean;
  accounts: MonitorAccountStats[];
  lanes: MonitorLaneView[];
  /** 执行中 → 排队中 → 最近完成（新的在前）。 */
  tasks: MonitorTask[];
  hiddenTaskCount: number;
  /** 新的在前。 */
  events: MonitorEvent[];
}

export const EMPTY_MONITOR_SNAPSHOT: MonitorSnapshot = {
  seq: 0,
  receivedAt: 0,
  hz: 4,
  mode: '',
  stale: false,
  accounts: [],
  lanes: [],
  tasks: [],
  hiddenTaskCount: 0,
  events: [],
};

/** 曲线：最近 120 秒，最高 10 帧/秒。 */
const SERIES_WINDOW_MS = 120_000;
const SERIES_CAPACITY = 1200;
const CHART_BUSES: MonitorBusId[] = ['search', 'cover', 'mediaAsset', 'stream'];
const BUS_COLOR_VAR: Record<string, string> = {
  search: '--monitor-search',
  cover: '--monitor-cover',
  mediaAsset: '--monitor-media',
  stream: '--monitor-stream',
};
const RATE_SMOOTHING = 0.35;

/** 定长数值环：写入 O(1)，读取时按时间顺序遍历。 */
class Ring {
  readonly data = new Float64Array(SERIES_CAPACITY);
  head = 0;
  size = 0;
  push(value: number) {
    this.data[this.head] = value;
    this.head = (this.head + 1) % SERIES_CAPACITY;
    if (this.size < SERIES_CAPACITY) this.size += 1;
  }
  at(i: number) { return this.data[(this.head - this.size + i + SERIES_CAPACITY) % SERIES_CAPACITY]!; }
  clear() { this.head = 0; this.size = 0; }
}

const series = {
  time: new Ring(),
  queued: new Ring(),
  bytesRate: new Ring(),
  flood: new Ring(),
  active: Object.fromEntries(CHART_BUSES.map((bus) => [bus, new Ring()])) as Record<string, Ring>,
};

let subscriberId: string | null = null;
let hz = 4;
let leaseTimer: number | null = null;
let watchdogTimer: number | null = null;
let suspended = false;
let commit: ((snapshot: MonitorSnapshot) => void) | null = null;
let rafPending = false;
let lastSeq = 0;
let lastFrameAt = 0;
let focusAccountId: string | null = null;

const tasks = new Map<number, MonitorTask>();
let events: MonitorEvent[] = [];
let accounts: MonitorAccountStats[] = [];
let lanes: MonitorLaneView[] = [];
let hiddenTaskCount = 0;
let mode = '';
const previousTotals = new Map<string, { at: number; ok: number; error: number; bytes: number; okRate: number; errorRate: number; bytesRate: number }>();

let canvas: HTMLCanvasElement | null = null;
/** 尺寸变化时重绘（暂停或无新帧时也保持曲线清晰）。 */
let resizeObserver: ResizeObserver | null = null;
let colorCache: { at: number; colors: Record<string, string> } | null = null;

function laneKey(lane: MonitorLaneStats) { return `${lane.accountId}:${lane.lane}`; }

function toLaneViews(raw: MonitorLaneStats[], at: number): MonitorLaneView[] {
  return raw.map((lane) => {
    const key = laneKey(lane);
    const prev = previousTotals.get(key);
    let okRate = 0;
    let errorRate = 0;
    let bytesRate = 0;
    if (prev && at > prev.at) {
      const dt = (at - prev.at) / 1000;
      const smooth = (old: number, next: number) => old + (next - old) * RATE_SMOOTHING;
      okRate = smooth(prev.okRate, Math.max(0, lane.okTotal - prev.ok) / dt);
      errorRate = smooth(prev.errorRate, Math.max(0, lane.errorTotal - prev.error) / dt);
      bytesRate = smooth(prev.bytesRate, Math.max(0, lane.bytesTotal - prev.bytes) / dt);
    }
    previousTotals.set(key, { at, ok: lane.okTotal, error: lane.errorTotal, bytes: lane.bytesTotal, okRate, errorRate, bytesRate });
    const frozenSeconds = lane.frozenUntil > at ? Math.ceil((lane.frozenUntil - at) / 1000) : 0;
    const status = frozenSeconds > 0 ? 'frozen' : lane.effective < lane.configured ? 'degraded' : 'normal';
    return { ...lane, okRate, errorRate, bytesRate, status, frozenSeconds };
  });
}

function pushSeries(at: number, frameEvents: MonitorEvent[]) {
  const accountId = focusAccountId ?? accounts.find((a) => a.tier === 'P0')?.accountId ?? accounts[0]?.accountId;
  if (!accountId) return;
  const own = lanes.filter((lane) => lane.accountId === accountId);
  series.time.push(at);
  for (const bus of CHART_BUSES) {
    // MediaAssetBus 以分片 RPC 衡量真实并发（fullMedia 只是文件数）。
    const active = own.filter((lane) => LANE_BUS[lane.lane] === bus && lane.lane !== 'fullMedia').reduce((n, lane) => n + lane.active, 0);
    series.active[bus]!.push(active);
  }
  series.queued.push(own.reduce((n, lane) => n + lane.queued, 0));
  series.bytesRate.push(own.reduce((n, lane) => n + lane.bytesRate, 0));
  series.flood.push(frameEvents.filter((event) => event.kind === 'flood_wait' && event.accountId === accountId).length);
}

function clearSeries() {
  series.time.clear();
  series.queued.clear();
  series.bytesRate.clear();
  series.flood.clear();
  for (const ring of Object.values(series.active)) ring.clear();
}

function handleFrame(frame: MonitorFrame) {
  const gap = !frame.full && lastSeq !== 0 && frame.seq !== lastSeq + 1;
  lastSeq = frame.seq;
  lastFrameAt = Date.now();
  hz = frame.hz;
  mode = frame.mode;
  accounts = frame.accounts;
  lanes = toLaneViews(frame.lanes, frame.at);
  hiddenTaskCount = frame.hiddenTaskCount;
  if (gap) {
    // 帧丢失：增量任务不可信，等待全量帧后再更新任务表与事件流。
    if (subscriberId) mtprotoHub.bridge().monitorResync(subscriberId);
  } else {
    if (frame.full) { tasks.clear(); events = []; }
    for (const task of frame.taskUpserts) tasks.set(task.id, task);
    for (const id of frame.taskRemovals) tasks.delete(id);
    if (frame.events.length) {
      events = events.concat(frame.events);
      if (events.length > MONITOR_MAX_EVENTS) events = events.slice(events.length - MONITOR_MAX_EVENTS);
    }
  }
  pushSeries(frame.at, gap ? [] : frame.events);
  scheduleCommit();
}

const STATE_ORDER: Record<MonitorTask['state'], number> = { running: 0, queued: 1, ok: 2, error: 2, cancelled: 2 };

function buildSnapshot(): MonitorSnapshot {
  const list = Array.from(tasks.values());
  list.sort((a, b) => {
    const order = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (order !== 0) return order;
    if (a.state === 'running' || a.state === 'queued') return a.enqueuedAt - b.enqueuedAt;
    return (b.endedAt ?? 0) - (a.endedAt ?? 0);
  });
  return {
    seq: lastSeq,
    receivedAt: lastFrameAt,
    hz,
    mode,
    stale: lastFrameAt > 0 && Date.now() - lastFrameAt > (3000 / hz) + 1000,
    accounts,
    lanes,
    tasks: list,
    hiddenTaskCount,
    events: events.slice().reverse(),
  };
}

function scheduleCommit() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    commit?.(buildSnapshot());
    draw();
  });
}

function readColors(el: HTMLElement): Record<string, string> {
  const now = Date.now();
  if (colorCache && now - colorCache.at < 2000) return colorCache.colors;
  const style = getComputedStyle(el);
  const colors: Record<string, string> = {
    border: style.getPropertyValue('--border').trim(),
    muted: style.getPropertyValue('--muted-foreground').trim(),
    destructive: style.getPropertyValue('--destructive').trim(),
    foreground: style.getPropertyValue('--foreground').trim(),
  };
  for (const [bus, variable] of Object.entries(BUS_COLOR_VAR)) colors[bus] = style.getPropertyValue(variable).trim();
  colorCache = { at: now, colors };
  return colors;
}

function formatRate(bytesPerSecond: number) {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSecond.toFixed(0)} B/s`;
}

/** 三段曲线：并发（按总线分色）、排队、吞吐；限流事件以竖线标记。 */
function draw() {
  const el = canvas;
  if (!el || !el.isConnected) return;
  const dpr = window.devicePixelRatio || 1;
  const width = el.clientWidth;
  const height = el.clientHeight;
  if (width === 0 || height === 0) return;
  if (el.width !== Math.round(width * dpr) || el.height !== Math.round(height * dpr)) {
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
  }
  const ctx = el.getContext('2d');
  if (!ctx) return;
  const colors = readColors(el);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'top';

  const now = series.time.size ? series.time.at(series.time.size - 1) : Date.now();
  const start = now - SERIES_WINDOW_MS;
  const labelW = 64;
  const plotW = Math.max(10, width - labelW);
  const rows = [
    { title: '并发', rings: CHART_BUSES.map((bus) => ({ ring: series.active[bus]!, color: colors[bus]! })), format: (v: number) => String(Math.round(v)) },
    { title: '排队', rings: [{ ring: series.queued, color: colors.muted! }], format: (v: number) => String(Math.round(v)) },
    { title: '吞吐', rings: [{ ring: series.bytesRate, color: colors.mediaAsset! }], format: formatRate },
  ];
  const rowH = height / rows.length;
  const xOf = (t: number) => labelW + ((t - start) / SERIES_WINDOW_MS) * plotW;

  rows.forEach((row, index) => {
    const top = index * rowH + 4;
    const plotH = rowH - 12;
    let max = 1;
    for (const { ring } of row.rings) for (let i = 0; i < ring.size; i += 1) {
      if (series.time.at(i) >= start) max = Math.max(max, ring.at(i));
    }
    // 网格与标签
    ctx.strokeStyle = colors.border!;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(labelW, top + plotH + 0.5);
    ctx.lineTo(width, top + plotH + 0.5);
    ctx.stroke();
    ctx.fillStyle = colors.muted!;
    ctx.fillText(row.title, 0, top);
    ctx.fillText(row.format(max), 0, top + 14);
    // 曲线
    for (const { ring, color } of row.rings) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < ring.size; i += 1) {
        const t = series.time.at(i);
        if (t < start) continue;
        const x = xOf(t);
        const y = top + plotH - (ring.at(i) / max) * plotH;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });

  // 限流标记贯穿三段
  ctx.strokeStyle = colors.destructive!;
  ctx.lineWidth = 1;
  for (let i = 0; i < series.flood.size; i += 1) {
    if (series.flood.at(i) <= 0) continue;
    const t = series.time.at(i);
    if (t < start) continue;
    const x = Math.round(xOf(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function subscribe() {
  if (!subscriberId || suspended) return;
  mtprotoHub.bridge().monitorSubscribe(subscriberId, hz, handleFrame);
}

function onVisibilityChange() {
  if (!subscriberId) return;
  if (document.visibilityState === 'hidden') {
    suspended = true;
    mtprotoHub.bridge().monitorUnsubscribe(subscriberId);
  } else if (suspended) {
    suspended = false;
    lastSeq = 0;
    subscribe();
  }
}

export const telegramMonitorDataSource = {
  /** 开始订阅：同一时间只有一个订阅；重复调用只更新提交回调。 */
  start(rate: number, onCommit: (snapshot: MonitorSnapshot) => void) {
    commit = onCommit;
    hz = rate;
    if (subscriberId) return;
    subscriberId = crypto.randomUUID();
    lastSeq = 0;
    suspended = document.visibilityState === 'hidden';
    subscribe();
    leaseTimer = window.setInterval(subscribe, MONITOR_LEASE_RENEW_MS);
    // 停止收帧时也要刷新「数据过期」标记。
    watchdogTimer = window.setInterval(() => { if (lastFrameAt > 0) scheduleCommit(); }, 1000);
    document.addEventListener('visibilitychange', onVisibilityChange);
  },

  /** 退订并停止全部定时器；保留最后一帧数据，便于暂停后查看。 */
  stop() {
    if (!subscriberId) return;
    mtprotoHub.bridge().monitorUnsubscribe(subscriberId);
    subscriberId = null;
    suspended = false;
    if (leaseTimer !== null) window.clearInterval(leaseTimer);
    if (watchdogTimer !== null) window.clearInterval(watchdogTimer);
    leaseTimer = null;
    watchdogTimer = null;
    document.removeEventListener('visibilitychange', onVisibilityChange);
  },

  isRunning() { return subscriberId !== null; },

  /** 切换帧率：立即续约，Worker 重建定时器并下发全量帧。 */
  setHz(rate: number) {
    hz = rate;
    lastSeq = 0;
    subscribe();
  },

  /** 曲线跟随的账号；切换后清空曲线，避免混入其他账号数据。 */
  setFocusAccount(accountId: string | null) {
    if (focusAccountId === accountId) return;
    focusAccountId = accountId;
    clearSeries();
    draw();
  },

  attachCanvas(el: HTMLCanvasElement | null) {
    resizeObserver?.disconnect();
    resizeObserver = null;
    canvas = el;
    colorCache = null;
    if (!el) return;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => requestAnimationFrame(draw));
      resizeObserver.observe(el);
    }
    draw();
  },

  /** 用户主动清空：任务、事件、曲线与速率基线。 */
  reset() {
    tasks.clear();
    events = [];
    previousTotals.clear();
    clearSeries();
    scheduleCommit();
  },

  formatRate,
};
