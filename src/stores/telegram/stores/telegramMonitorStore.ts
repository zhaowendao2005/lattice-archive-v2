/**
 * [STORE] Telegram 运行监控（设置 → 开发者选项 → Telegram 连接监控）
 *
 * 唯一真相来源：选中账号、总线 / 状态筛选、帧率、暂停态、任务表滚动位置、导出状态，
 * 以及 Data Source 每个动画帧最多提交一次的浅层快照（shallowRef 整体替换，不做深层代理）。
 * 连接与账号身份只读 telegramStore，并发模式只读 telegramPerformanceStore，不在此复制。
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  LANE_LABELS,
  MONITOR_BUSES,
  type MonitorBusId,
  type MonitorHz,
  type MonitorTask,
} from '@/worker/local/telegram/contracts/monitor';
import {
  EMPTY_MONITOR_SNAPSHOT,
  telegramMonitorDataSource,
  type MonitorLaneView,
  type MonitorSnapshot,
} from '../data-sources/telegramMonitorDataSource';
import type { SeriesBus } from '../data-sources/monitorSeries';
import { useTelegramPerformanceStore } from './telegramPerformanceStore';
import { useTelegramStore } from './telegramStore';
import { useDebugLoggerStore } from '@/stores/app/stores/debugLoggerStore';
import type { LatticeLogEntry } from '@/stores/app/data-sources/debugLoggerDataSource';

export type MonitorStateFilter = 'all' | 'live' | 'done' | 'failed';
export type MonitorBusFilter = 'all' | MonitorBusId;

/** 任务表固定行高与可视行数（虚拟列表）。 */
export const MONITOR_TASK_ROW_PX = 28;
export const MONITOR_TASK_VIEWPORT_ROWS = 12;
const OVERSCAN_ROWS = 6;

const MODE_LABELS: Record<string, string> = { stable: '稳定', balanced: '均衡', aggressive: '积极', custom: '自定义' };

export interface MonitorBusCard {
  id: MonitorBusId;
  label: string;
  wired: boolean;
  lanes: MonitorLaneView[];
  active: number;
  queued: number;
  bytesRate: number;
  okRate: number;
  errorRate: number;
  /** 终态请求速率（成功 + 失败 + 取消）。 */
  requestsRate: number;
  status: 'idle' | 'normal' | 'degraded' | 'frozen';
}

export const useTelegramMonitorStore = defineStore('telegramMonitor', () => {
  const snapshot = shallowRef<MonitorSnapshot>(EMPTY_MONITOR_SNAPSHOT);
  const selectedAccountId = ref<string | null>(null);
  const busFilter = ref<MonitorBusFilter>('all');
  const stateFilter = ref<MonitorStateFilter>('all');
  const hz = ref<MonitorHz>(4);
  const paused = ref(false);
  const isOpen = ref(false);
  const taskScrollTop = ref(0);
  const isExporting = ref(false);
  const exportNotice = ref('');
  const exportError = ref('');
  /** 图表显隐与区间选择；曲线原始数据留在 Data Source 的内存序列里，不进入响应式状态。 */
  const hiddenBuses = ref<SeriesBus[]>([]);
  const followLive = ref(true);
  const zoomRange = ref<{ start: number; end: number } | null>(null);
  const showTable = ref(false);

  const accounts = computed(() => snapshot.value.accounts);
  const effectiveAccountId = computed(() => {
    const list = accounts.value;
    if (selectedAccountId.value && list.some((a) => a.accountId === selectedAccountId.value)) return selectedAccountId.value;
    return list.find((a) => a.tier === 'P0')?.accountId ?? list[0]?.accountId ?? null;
  });
  const account = computed(() => accounts.value.find((a) => a.accountId === effectiveAccountId.value) ?? null);
  const accountLanes = computed(() => snapshot.value.lanes.filter((lane) => lane.accountId === effectiveAccountId.value));
  /** 账号显示名只读 telegramStore（SSOT），不在此复制账号资料。 */
  const accountNames = computed<Record<string, string>>(() => {
    const names: Record<string, string> = {};
    for (const item of useTelegramStore().accounts) {
      const full = [item.first_name, item.last_name].filter(Boolean).join(' ');
      names[item.tg_user_id] = item.username ? `@${item.username}` : full || item.tg_user_id;
    }
    return names;
  });
  const modeLabel = computed(() => MODE_LABELS[useTelegramPerformanceStore().mode] ?? '');

  const busCards = computed<MonitorBusCard[]>(() => MONITOR_BUSES.map((bus) => {
    const lanes = accountLanes.value.filter((lane) => bus.lanes.includes(lane.lane));
    const rpcLanes = lanes.filter((lane) => lane.lane !== 'fullMedia');
    const status = lanes.some((l) => l.status === 'frozen')
      ? 'frozen'
      : lanes.some((l) => l.status === 'degraded')
        ? 'degraded'
        : lanes.some((l) => l.active > 0 || l.queued > 0) ? 'normal' : 'idle';
    return {
      id: bus.id,
      label: bus.label,
      wired: bus.lanes.length > 0,
      lanes,
      active: rpcLanes.reduce((n, l) => n + l.active, 0),
      queued: lanes.reduce((n, l) => n + l.queued, 0),
      bytesRate: rpcLanes.reduce((n, l) => n + l.bytesRate, 0),
      okRate: rpcLanes.reduce((n, l) => n + l.okRate, 0),
      errorRate: rpcLanes.reduce((n, l) => n + l.errorRate, 0),
      requestsRate: rpcLanes.reduce((n, l) => n + l.okRate + l.errorRate + l.cancelledRate, 0),
      status,
    };
  }));

  const filteredTasks = computed<MonitorTask[]>(() => {
    const accountId = effectiveAccountId.value;
    const bus = busFilter.value;
    const state = stateFilter.value;
    const busLanes = bus === 'all' ? null : new Set(MONITOR_BUSES.find((b) => b.id === bus)?.lanes ?? []);
    return snapshot.value.tasks.filter((task) => {
      if (accountId && task.accountId !== accountId) return false;
      if (busLanes && !busLanes.has(task.lane)) return false;
      if (state === 'live') return task.state === 'queued' || task.state === 'running';
      if (state === 'done') return task.state === 'ok';
      if (state === 'failed') return task.state === 'error' || task.state === 'cancelled';
      return true;
    });
  });

  const taskSlice = computed(() => {
    const all = filteredTasks.value;
    const first = Math.max(0, Math.floor(taskScrollTop.value / MONITOR_TASK_ROW_PX) - OVERSCAN_ROWS);
    const last = Math.min(all.length, first + MONITOR_TASK_VIEWPORT_ROWS + OVERSCAN_ROWS * 2);
    return {
      rows: all.slice(first, last),
      topPx: first * MONITOR_TASK_ROW_PX,
      bottomPx: (all.length - last) * MONITOR_TASK_ROW_PX,
      total: all.length,
    };
  });

  const accountEvents = computed(() => snapshot.value.events.filter((event) => !event.accountId || event.accountId === effectiveAccountId.value));

  function applySnapshot(next: MonitorSnapshot) {
    snapshot.value = next;
  }

  function syncChartState() {
    telegramMonitorDataSource.setChartState({
      hiddenBuses: hiddenBuses.value,
      followLive: followLive.value,
      zoom: zoomRange.value,
    });
  }

  /** 图例与图表联动：隐藏的曲线照常采样，只是不绘制。 */
  function setHiddenBuses(next: readonly SeriesBus[]) {
    if (next.length === hiddenBuses.value.length && next.every((bus, index) => hiddenBuses.value[index] === bus)) return;
    hiddenBuses.value = [...next];
    syncChartState();
  }

  function toggleBus(bus: SeriesBus) {
    setHiddenBuses(hiddenBuses.value.includes(bus)
      ? hiddenBuses.value.filter((item) => item !== bus)
      : [...hiddenBuses.value, bus]);
  }

  function showAllBuses() { setHiddenBuses([]); }

  /** 手动拖到历史区间后固定查看；数据仍在继续采样，点这里恢复跟随最新帧。 */
  function setZoomFromChart(range: { start: number; end: number }) {
    const current = zoomRange.value;
    // 三张图通过 echarts.connect 联动，同一次拖动会触发多次回调；只有范围实质变化才写状态。
    if (!followLive.value && current
      && Math.abs(current.start - range.start) < 500
      && Math.abs(current.end - range.end) < 500) return;
    followLive.value = false;
    zoomRange.value = { ...range };
    syncChartState();
  }

  function returnToLive() {
    followLive.value = true;
    zoomRange.value = null;
    syncChartState();
  }

  function toggleTable() { showTable.value = !showTable.value; }

  const zoomLabel = computed(() => {
    if (followLive.value || !zoomRange.value) return '跟随实时';
    const format = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
    return `固定区间 ${format(zoomRange.value.start)} – ${format(zoomRange.value.end)}`;
  });

  /** 内存占用估算：随每次快照更新刷新。 */
  const chartMemoryLabel = computed(() => {
    void snapshot.value;
    const bytes = telegramMonitorDataSource.estimateMemoryBytes();
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  });

  /** 进入监控页（含 KeepAlive 激活）：未暂停时订阅。 */
  function open() {
    isOpen.value = true;
    telegramMonitorDataSource.setChartHandlers({
      onZoomChange: setZoomFromChart,
      onLegendChange: setHiddenBuses,
    });
    if (!paused.value) telegramMonitorDataSource.start(hz.value, applySnapshot);
    telegramMonitorDataSource.setFocusAccount(effectiveAccountId.value);
    syncChartState();
  }

  /** 离开监控页 / 被 KeepAlive 隐藏 / 关闭开发者模式：退订，Worker 停止推送。 */
  function close() {
    isOpen.value = false;
    telegramMonitorDataSource.stop();
  }

  /** 暂停只冻结界面并退订；恢复时重新订阅并先收到一帧全量数据。 */
  function togglePause() {
    paused.value = !paused.value;
    if (paused.value) telegramMonitorDataSource.stop();
    else if (isOpen.value) telegramMonitorDataSource.start(hz.value, applySnapshot);
  }

  function setHz(next: MonitorHz) {
    hz.value = next;
    telegramMonitorDataSource.setHz(next);
  }

  function selectAccount(accountId: string) {
    selectedAccountId.value = accountId;
    taskScrollTop.value = 0;
    telegramMonitorDataSource.setFocusAccount(accountId);
  }

  function setBusFilter(next: MonitorBusFilter) { busFilter.value = next; taskScrollTop.value = 0; }
  function setStateFilter(next: MonitorStateFilter) { stateFilter.value = next; taskScrollTop.value = 0; }

  function handleTaskScroll(event: Event) {
    taskScrollTop.value = (event.target as HTMLElement).scrollTop;
  }

  function clear() {
    telegramMonitorDataSource.reset();
  }

  /** 跳转日志前调用：日志终端按该任务的 traceId 过滤。 */
  function focusTrace(traceId: string) {
    useDebugLoggerStore().focusTrace(traceId);
  }

  /** 导出当前监控快照为一条云端日志快照（不含消息正文、会话标题与文件名）。 */
  async function exportToCloud() {
    if (isExporting.value) return;
    const snap = snapshot.value;
    exportNotice.value = '';
    exportError.value = '';
    if (snap.seq === 0) { exportError.value = '尚未收到监控数据，无法导出'; return; }
    isExporting.value = true;
    try {
      const now = Date.now();
      const traceId = `monitor-${now.toString(36)}`;
      const base = { traceId, source: 'frontend' as const, domain: 'telegram.monitor', timestamp: now, relMs: 0 };
      const entries: LatticeLogEntry[] = [
        {
          ...base,
          id: `${traceId}-summary`,
          spanId: '1',
          action: 'snapshot',
          level: 'INFO',
          message: JSON.stringify({ mode: snap.mode, hz: snap.hz, accounts: snap.accounts, hiddenTaskCount: snap.hiddenTaskCount }),
          tags: { accounts: snap.accounts.length, lanes: snap.lanes.length, tasks: snap.tasks.length, events: snap.events.length },
        },
        ...snap.lanes.map((lane, index): LatticeLogEntry => ({
          ...base,
          id: `${traceId}-lane-${index}`,
          spanId: `1.${index + 1}`,
          parentSpanId: '1',
          action: 'lane',
          level: lane.status === 'frozen' ? 'WARN' : 'INFO',
          message: `${LANE_LABELS[lane.lane]} ${lane.active}/${lane.effective}（配置 ${lane.configured}）排队 ${lane.queued}`,
          tags: {
            accountId: lane.accountId, lane: lane.lane, bus: lane.bus, active: lane.active, queued: lane.queued,
            configured: lane.configured, effective: lane.effective, status: lane.status,
            ok: lane.okTotal, error: lane.errorTotal, cancelled: lane.cancelledTotal, bytes: lane.bytesTotal,
            queueP50: lane.queueMsP50, queueP95: lane.queueMsP95, runP50: lane.runMsP50, runP95: lane.runMsP95,
          },
        })),
        {
          ...base,
          id: `${traceId}-tasks`,
          spanId: `1.${snap.lanes.length + 1}`,
          parentSpanId: '1',
          action: 'tasks',
          level: 'INFO',
          message: JSON.stringify(snap.tasks.slice(0, 300)),
        },
        {
          ...base,
          id: `${traceId}-events`,
          spanId: `1.${snap.lanes.length + 2}`,
          parentSpanId: '1',
          action: 'events',
          level: 'INFO',
          message: JSON.stringify(snap.events),
        },
      ];
      const meta = await useDebugLoggerStore().pushCustomSnapshot(entries);
      exportNotice.value = `已导出监控快照（${meta.entryCount} 条记录）`;
    } catch (error) {
      exportError.value = error instanceof Error ? error.message : '导出监控快照失败';
    } finally {
      isExporting.value = false;
    }
  }

  return {
    snapshot,
    selectedAccountId,
    busFilter,
    stateFilter,
    hz,
    paused,
    isOpen,
    taskScrollTop,
    isExporting,
    exportNotice,
    exportError,
    hiddenBuses,
    followLive,
    zoomRange,
    showTable,
    zoomLabel,
    chartMemoryLabel,
    toggleBus,
    showAllBuses,
    returnToLive,
    toggleTable,
    accounts,
    effectiveAccountId,
    account,
    accountLanes,
    accountNames,
    modeLabel,
    busCards,
    filteredTasks,
    taskSlice,
    accountEvents,
    open,
    close,
    togglePause,
    setHz,
    selectAccount,
    setBusFilter,
    setStateFilter,
    handleTaskScroll,
    clear,
    focusTrace,
    exportToCloud,
  };
});
