/**
 * [DATA SOURCE] Telegram 运行监控桥接（薄桥接 + 内存序列 + ECharts 句柄）
 *
 * 职责：
 * 1. 经 mtprotoHub 订阅 Worker BusMonitor：租约续约、页面隐藏自动退订 / 恢复、帧序号断档时请求全量重同步；
 * 2. 高频帧不直接写响应式状态：任务表用普通 Map 增量维护；
 * 3. 每条总线的并发 / 请求速率 / 字节吞吐写入按账号隔离的内存序列（不设时间上限）；
 * 4. 托管 ECharts 实例、降采样与 setOption 节流；曲线数组不进入 Store。
 */
import { mtprotoHub } from './mtprotoBridge';
import {
  MONITOR_LEASE_RENEW_MS,
  MONITOR_MAX_EVENTS,
  type MonitorAccountStats,
  type MonitorEvent,
  type MonitorFrame,
  type MonitorLaneStats,
  type MonitorTask,
} from '@/worker/local/telegram/contracts/monitor';
import {
  aggregateBuses,
  mergeTimedPoints,
  MonitorSeriesStore,
  SERIES_BUSES,
  type SeriesBus,
  type SeriesMetric,
} from './monitorSeries';
import type { EChartsType } from 'echarts/core';

export interface MonitorLaneView extends MonitorLaneStats {
  /** 每秒速率（指数平滑）。 */
  okRate: number;
  errorRate: number;
  cancelledRate: number;
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

export interface MonitorChartState {
  hiddenBuses: readonly SeriesBus[];
  followLive: boolean;
  zoom: { start: number; end: number } | null;
}

export interface MonitorChartHandlers {
  onZoomChange?: (range: { start: number; end: number }) => void;
  onLegendChange?: (hidden: readonly SeriesBus[]) => void;
}

/** X 轴默认跟随窗口：最近 2 分钟。 */
const SERIES_WINDOW_MS = 120_000;
/** 全量概览的桶数：slider 与“看到全程”都靠它。 */
const OVERVIEW_BUCKETS = 600;
const RATE_SMOOTHING = 0.35;
const CHART_GROUP = 'telegram-monitor';

const BUS_COLOR_VAR: Record<SeriesBus, string> = {
  search: '--monitor-search',
  cover: '--monitor-cover',
  mediaAsset: '--monitor-media',
  stream: '--monitor-stream',
  chatRead: '--monitor-chat-read',
  chatCommand: '--monitor-chat-command',
  bot: '--monitor-bot',
  vault: '--monitor-vault',
  account: '--monitor-account',
};
/** 短标签：九条曲线要同时出现在一行可滚动的图例里。顺序与 MONITOR_BUSES 一致。 */
const BUS_LABEL: Record<SeriesBus, string> = {
  search: '搜索',
  cover: '封面与头像',
  mediaAsset: '完整文件',
  stream: '视频流',
  chatRead: 'Chat 读取',
  chatCommand: 'Chat 命令',
  bot: '机器人',
  vault: '保险库',
  account: '账号会话',
};

const seriesStores = new Map<string, MonitorSeriesStore>();
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
const previousTotals = new Map<string, {
  at: number; ok: number; error: number; cancelled: number; bytes: number;
  okRate: number; errorRate: number; cancelledRate: number; bytesRate: number;
}>();

interface ChartEntry {
  element: HTMLElement;
  chart: EChartsType;
  resizeObserver: ResizeObserver | null;
  intersectionObserver: IntersectionObserver | null;
  visible: boolean;
  dirty: boolean;
}
const charts = new Map<SeriesMetric, ChartEntry>();
const pendingElements = new Map<SeriesMetric, HTMLElement | null>();
let chartState: MonitorChartState = { hiddenBuses: [], followLive: true, zoom: null };
let chartHandlers: MonitorChartHandlers = {};
let echartsCore: typeof import('./monitorEcharts')['echarts'] | null = null;
let echartsLoader: Promise<typeof import('./monitorEcharts')['echarts']> | null = null;
let colorCache: { at: number; colors: Record<string, string> } | null = null;
let chartFrame = 0;

function laneKey(lane: MonitorLaneStats) { return `${lane.accountId}:${lane.lane}`; }

function toLaneViews(raw: MonitorLaneStats[], at: number): MonitorLaneView[] {
  return raw.map((lane) => {
    const key = laneKey(lane);
    const prev = previousTotals.get(key);
    let okRate = 0;
    let errorRate = 0;
    let cancelledRate = 0;
    let bytesRate = 0;
    if (prev && at > prev.at) {
      const dt = (at - prev.at) / 1000;
      const smooth = (old: number, next: number) => old + (next - old) * RATE_SMOOTHING;
      okRate = smooth(prev.okRate, Math.max(0, lane.okTotal - prev.ok) / dt);
      errorRate = smooth(prev.errorRate, Math.max(0, lane.errorTotal - prev.error) / dt);
      cancelledRate = smooth(prev.cancelledRate, Math.max(0, lane.cancelledTotal - prev.cancelled) / dt);
      bytesRate = smooth(prev.bytesRate, Math.max(0, lane.bytesTotal - prev.bytes) / dt);
    }
    previousTotals.set(key, {
      at, ok: lane.okTotal, error: lane.errorTotal, cancelled: lane.cancelledTotal, bytes: lane.bytesTotal,
      okRate, errorRate, cancelledRate, bytesRate,
    });
    const frozenSeconds = lane.frozenUntil > at ? Math.ceil((lane.frozenUntil - at) / 1000) : 0;
    const status = frozenSeconds > 0 ? 'frozen' : lane.effective < lane.configured ? 'degraded' : 'normal';
    return { ...lane, okRate, errorRate, cancelledRate, bytesRate, status, frozenSeconds };
  });
}

function resolvedAccountId(): string | null {
  return focusAccountId ?? accounts.find((account) => account.tier === 'P0')?.accountId ?? accounts[0]?.accountId ?? null;
}

function seriesStore(create = true): MonitorSeriesStore | null {
  const accountId = resolvedAccountId();
  if (!accountId) return null;
  let store = seriesStores.get(accountId);
  if (!store && create) { store = new MonitorSeriesStore(); seriesStores.set(accountId, store); }
  return store ?? null;
}

function pushSeries(at: number) {
  const accountId = resolvedAccountId();
  if (!accountId) return;
  const store = seriesStore();
  if (!store) return;
  const own = lanes.filter((lane) => lane.accountId === accountId);
  store.append(at, aggregateBuses(own));
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
    scheduleChartUpdate();
  });
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
  pushSeries(frame.at);
  scheduleCommit();
}

function formatRate(bytesPerSecond: number) {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSecond.toFixed(0)} B/s`;
}

function formatConcurrency(value: number) { return String(Math.round(value)); }
function formatRequests(value: number) { return `${Number(value.toFixed(1))}/s`; }
function formatMetric(metric: SeriesMetric, value: number) {
  return metric === 'concurrency' ? formatConcurrency(value) : metric === 'requests' ? formatRequests(value) : formatRate(value);
}

/** 从语义令牌读取颜色；ECharts 不允许在脚本里写死调色板。 */
function readColors(): Record<string, string> {
  const now = Date.now();
  if (colorCache && now - colorCache.at < 2000) return colorCache.colors;
  const style = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {
    border: style.getPropertyValue('--border').trim() || 'rgba(128,128,128,0.25)',
    muted: style.getPropertyValue('--muted-foreground').trim() || '#888',
  };
  for (const bus of SERIES_BUSES) colors[bus] = style.getPropertyValue(BUS_COLOR_VAR[bus]).trim() || '#888';
  colorCache = { at: now, colors };
  return colors;
}

async function ensureEcharts(): Promise<typeof import('./monitorEcharts')['echarts']> {
  if (echartsCore) return echartsCore;
  if (!echartsLoader) {
    echartsLoader = import('./monitorEcharts').then((module) => {
      echartsCore = module.echarts;
      return module.echarts;
    });
  }
  return echartsLoader;
}

function baseOption(metric: SeriesMetric, colors: Record<string, string>) {
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontSize: 11, fontFamily: 'ui-sans-serif, system-ui, sans-serif' },
    // ECharts reads triggerEmphasis from the global axisPointer model, not tooltip.axisPointer.
    axisPointer: { triggerEmphasis: false },
    grid: { left: 52, right: 14, top: 34, bottom: 56 },
    legend: {
      type: 'scroll',
      top: 0,
      left: 0,
      right: 0,
      itemWidth: 14,
      itemHeight: 2,
      itemGap: 10,
      textStyle: { fontSize: 11, color: colors.muted },
      pageTextStyle: { color: colors.muted },
      data: SERIES_BUSES.map((bus) => BUS_LABEL[bus]),
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      // Keep axis tooltip/crosshair; disable the emphasis action through the global axisPointer option below.
      axisPointer: { type: 'line', lineStyle: { color: colors.muted, opacity: 0.4 } },
      valueFormatter: (value: number) => formatMetric(metric, Number(value)),
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: colors.border } },
      axisTick: { show: false },
      axisLabel: { color: colors.muted, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      minInterval: metric === 'concurrency' ? 1 : 0,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: colors.muted, formatter: (value: number) => formatMetric(metric, Number(value)) },
      splitLine: { lineStyle: { color: colors.border, type: 'solid' } },
    },
    dataZoom: [
      {
        id: 'range', type: 'slider', height: 16, bottom: 8,
        borderColor: 'transparent', backgroundColor: 'transparent',
        fillerColor: 'rgba(128,128,128,0.14)',
        dataBackground: { lineStyle: { color: colors.muted, opacity: 0.45 }, areaStyle: { color: colors.muted, opacity: 0.12 } },
        selectedDataBackground: { lineStyle: { color: colors.search, opacity: 0.7 }, areaStyle: { color: colors.search, opacity: 0.16 } },
        handleStyle: { color: colors.search },
        moveHandleStyle: { color: colors.search, opacity: 0.5 },
        textStyle: { color: colors.muted, fontSize: 10 },
      },
      { id: 'inside-zoom', type: 'inside' },
    ],
    series: SERIES_BUSES.map((bus) => ({
      id: bus,
      name: BUS_LABEL[bus],
      type: 'line',
      showSymbol: false,
      symbol: 'none',
      sampling: 'minmax',
      lineStyle: { width: 1.5, color: colors[bus] },
      itemStyle: { color: colors[bus] },
      data: [] as Array<[number, number]>,
    })),
  };
}

function currentWindow(store: MonitorSeriesStore): { start: number; end: number; first: number; last: number } | null {
  const last = store.latestTime();
  if (!last) return null;
  const first = store.firstTime() || last;
  if (chartState.zoom && !chartState.followLive) {
    const start = Math.max(first, chartState.zoom.start);
    const end = Math.min(last, chartState.zoom.end);
    if (end > start) return { start, end, first, last };
  }
  return { start: Math.max(first, last - SERIES_WINDOW_MS), end: last, first, last };
}

function updateCharts() {
  const core = echartsCore;
  if (!core || charts.size === 0) return;
  const store = seriesStore(false);
  if (!store) return;
  const window = currentWindow(store);
  if (!window) return;
  const colors = readColors();
  const selected: Record<string, boolean> = {};
  for (const bus of SERIES_BUSES) selected[BUS_LABEL[bus]] = !chartState.hiddenBuses.includes(bus);

  for (const [metric, entry] of charts) {
    if (!entry.visible) { entry.dirty = true; continue; }
    const overview = store.buildSeries(metric, window.first, window.last, OVERVIEW_BUCKETS);
    const detailBuckets = Math.max(120, Math.round(entry.element.clientWidth || 600) * 2);
    const detail = store.buildSeries(metric, window.start, window.end, detailBuckets);
    entry.chart.setOption({
      legend: { selected },
      dataZoom: [
        { id: 'range', startValue: window.start, endValue: window.end },
        { id: 'inside-zoom', startValue: window.start, endValue: window.end },
      ],
      series: SERIES_BUSES.map((bus) => ({
        id: bus,
        lineStyle: { width: 1.5, color: colors[bus] },
        itemStyle: { color: colors[bus] },
        data: mergeTimedPoints(overview[bus], detail[bus]),
      })),
    }, { lazyUpdate: true });
    entry.dirty = false;
  }
}

/** 每帧最多重绘一次；隐藏的图表只标记 dirty，重新可见时再补一次。 */
function scheduleChartUpdate() {
  if (chartFrame) return;
  chartFrame = requestAnimationFrame(() => {
    chartFrame = 0;
    updateCharts();
  });
}

function applyInteractionHandlers(chart: EChartsType) {
  chart.on('legendselectchanged', (...args: unknown[]) => {
    const params = (args[0] ?? {}) as { selected?: Record<string, boolean> };
    const selected = params.selected ?? {};
    const hidden = SERIES_BUSES.filter((bus) => selected[BUS_LABEL[bus]] === false);
    chartHandlers.onLegendChange?.(hidden);
  });
  chart.on('datazoom', () => {
    const option = chart.getOption() as { dataZoom?: Array<{ startValue?: number; endValue?: number }> };
    const range = option.dataZoom?.[0];
    const start = typeof range?.startValue === 'number' ? range.startValue : undefined;
    const end = typeof range?.endValue === 'number' ? range.endValue : undefined;
    if (start === undefined || end === undefined || end <= start) return;
    chartHandlers.onZoomChange?.({ start, end });
  });
}

/** 视图通过指令挂载 / 卸载单个指标图表；实例与 DOM 句柄都留在这里。 */
async function attachChart(metric: SeriesMetric, element: HTMLElement | null) {
  pendingElements.set(metric, element);
  if (!element) { detachChart(metric); return; }
  const existing = charts.get(metric);
  if (existing && existing.element === element) return;
  if (existing) detachChart(metric);

  const core = await ensureEcharts();
  // 动态 import 期间组件可能已卸载或换元素。
  if (pendingElements.get(metric) !== element || !element.isConnected) return;

  const colors = readColors();
  const chart = core.init(element, undefined, { renderer: 'canvas', useDirtyRect: true });
  chart.group = CHART_GROUP;
  core.connect(CHART_GROUP);
  chart.setOption(baseOption(metric, colors));
  applyInteractionHandlers(chart);

  const entry: ChartEntry = {
    element,
    chart,
    resizeObserver: null,
    intersectionObserver: null,
    visible: true,
    dirty: true,
  };
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (chartFrame) cancelAnimationFrame(chartFrame);
      chartFrame = requestAnimationFrame(() => {
        chartFrame = 0;
        if (charts.get(metric) !== entry) return;
        chart.resize();
        updateCharts();
      });
    });
    observer.observe(element);
    entry.resizeObserver = observer;
  }
  if (typeof IntersectionObserver !== 'undefined') {
    const observer = new IntersectionObserver((records) => {
      const visible = records.some((record) => record.isIntersecting);
      if (visible === entry.visible) return;
      entry.visible = visible;
      if (visible && entry.dirty) scheduleChartUpdate();
    });
    observer.observe(element);
    entry.intersectionObserver = observer;
  }
  charts.set(metric, entry);
  updateCharts();
}

function detachChart(metric: SeriesMetric) {
  const pending = pendingElements.get(metric);
  // 仍在异步加载且元素已挂载时保留登记，由 attachChart 的过期检查自行收尾。
  if (!pending || !pending.isConnected) pendingElements.delete(metric);
  const entry = charts.get(metric);
  if (!entry) return;
  charts.delete(metric);
  entry.resizeObserver?.disconnect();
  entry.intersectionObserver?.disconnect();
  entry.chart.dispose();
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
  /** 开始订阅：同一时间只有一个订阅；重复调用只更新提交回调与交互处理函数。 */
  start(rate: number, onCommit: (snapshot: MonitorSnapshot) => void, handlers?: MonitorChartHandlers) {
    commit = onCommit;
    if (handlers) chartHandlers = handlers;
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

  /** 曲线跟随的账号；各账号的序列彼此隔离，切换后不会混入其他账号数据。 */
  setFocusAccount(accountId: string | null) {
    if (focusAccountId === accountId) return;
    focusAccountId = accountId;
    updateCharts();
  },

  /** 曲线显隐 / 是否跟随实时 / 固定区间选择。隐藏的曲线照常采样，只是不参与绘制。 */
  setChartState(next: Partial<MonitorChartState>) {
    chartState = { ...chartState, ...next };
    updateCharts();
  },

  setChartHandlers(handlers: MonitorChartHandlers) {
    chartHandlers = handlers;
  },

  attachChart,

  detachChart,

  /** 内存占用估算（全部账号的序列合计）。 */
  estimateMemoryBytes() {
    let total = 0;
    for (const store of seriesStores.values()) total += store.estimateBytes();
    return total;
  },

  /** 用户主动清空：任务、事件与当前账号曲线。 */
  reset() {
    tasks.clear();
    events = [];
    previousTotals.clear();
    seriesStore()?.clear();
    scheduleCommit();
    updateCharts();
  },

  formatRate,
};
