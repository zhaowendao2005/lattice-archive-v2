/**
 * ============================================================================
 * [STORE] 三端运行日志终端、时间轴视口与 Agent 渐进式查询密钥 Store (debugLoggerStore.ts)
 * ============================================================================
 * 核心特性：
 * 1. 三个无圆角独立采集标签：LOCAL / REMOTE / FRONTEND；
 * 2. RAF 帧合并入队 + 4000 条环形缓冲区 (Ring Buffer) + 24px 定高虚拟列表切片，杜绝卡顿；
 * 3. 时间轴迷你密度图与视口拖拽滑窗 ([viewStartRatio, viewEndRatio]) + LIVE 实时锁定；
 * 4. 云端日志快照管理：按账号开关、手动提交、元数据列表、按快照删除，以及一键复制「渐进式查询接口 + Skills 文档 + 访问密钥」；
 * 5. Agent 访问密钥生命周期管理（1h / 24h / 7d / 30d / 永不过期）。
 */
import { defineStore } from 'pinia';
import { useAuthStore } from '@/stores/auth/stores/authStore';
import {
  debugLoggerDataSource,
  formatLatticeGrepLine,
  type AgentDebugKeyDto,
  type AgentKeyTtlPreset,
  type DebugSnapshotMeta,
  type LatticeLogEntry,
} from '../data-sources/debugLoggerDataSource';

const MAX_RING_BUFFER = 4000;
const MAX_RENDERED_WRAPPED_ROWS = 600;
const TIMELINE_BUCKET_COUNT = 48;
const STORAGE_SOURCES_KEY = 'lattice.debug.sources.v1';
const STORAGE_RAW_KEY_PREFIX = 'lattice.debug.agentRawKey.v2.';
const STORAGE_CLOUD_ENABLED_PREFIX = 'lattice.debug.cloud-recording.v1.';

let pendingIngressQueue: LatticeLogEntry[] = [];
let rafScheduled = false;

function readSavedSources(): { local: boolean; remote: boolean; frontend: boolean } {
  try {
    const raw = window.localStorage.getItem(STORAGE_SOURCES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{ local: boolean; remote: boolean; frontend: boolean }>;
      return {
        local: Boolean(parsed.local),
        remote: Boolean(parsed.remote),
        frontend: Boolean(parsed.frontend),
      };
    }
  } catch {
    // ignore
  }
  return { local: true, remote: true, frontend: true };
}

function writeSavedSources(sources: { local: boolean; remote: boolean; frontend: boolean }): void {
  try {
    window.localStorage.setItem(STORAGE_SOURCES_KEY, JSON.stringify(sources));
  } catch {
    // ignore
  }
}

function readSavedRawKey(userId: string): string {
  if (!userId) return '';
  try {
    return window.localStorage.getItem(`${STORAGE_RAW_KEY_PREFIX}${userId}`) ?? '';
  } catch {
    return '';
  }
}

function writeSavedRawKey(userId: string, rawKey: string): void {
  if (!userId) return;
  try {
    if (rawKey) window.localStorage.setItem(`${STORAGE_RAW_KEY_PREFIX}${userId}`, rawKey);
    else window.localStorage.removeItem(`${STORAGE_RAW_KEY_PREFIX}${userId}`);
  } catch {
    // ignore
  }
}

/** 云端日志记录开关按账号隔离；默认开启，关闭后不阻止查看或删除已有快照。 */
function readCloudLoggingEnabled(userId: string): boolean {
  if (!userId) return false;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_CLOUD_ENABLED_PREFIX}${userId}`);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function writeCloudLoggingEnabled(userId: string, enabled: boolean): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(`${STORAGE_CLOUD_ENABLED_PREFIX}${userId}`, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

export interface TimelineBucketItem {
  index: number;
  count: number;
  heightPercent: number;
  hasError: boolean;
  hasWarn: boolean;
}

export interface TimelineAxisTick {
  index: number;
  ratio: number;
  percent: number;
  label: string;
}

export interface VirtualLogRow {
  lineNumber: number;
  entry: LatticeLogEntry;
  depth: number;
  isRoot: boolean;
  hasChildren: boolean;
  isCollapsed: boolean;
  formattedLine: string;
}

export const useDebugLoggerStore = defineStore('debugLogger', {
  state: () => {
    const saved = typeof window !== 'undefined' ? readSavedSources() : { local: true, remote: true, frontend: true };
    return {
      initialized: false,
      captureLocal: saved.local,
      captureRemote: saved.remote,
      captureFrontend: saved.frontend,

      entries: [] as LatticeLogEntry[],
      grepKeyword: '',
      levelFilter: 'ALL' as 'ALL' | 'INFO' | 'WARN' | 'ERROR',
      collapsedTraceIds: {} as Record<string, true>,

      // 时间轴观察视口状态 (0.0 ~ 1.0)
      viewStartRatio: 0,
      viewEndRatio: 1,
      isFollowLive: true,

      // 定高虚拟列表滚动状态
      terminalScrollTop: 0,
      terminalClientHeight: 360,

      // Hover 提示与反馈状态（零本地 ref）
      isAgentBtnHovered: false,
      statusNotice: null as string | null,
      isPushingSnapshot: false,
      lastSnapshotPushedAt: 0,

      // Agent 访问密钥管理状态
      agentKeys: [] as AgentDebugKeyDto[],
      activeRawKey: '',
      newKeyName: 'Agent 调试密钥',
      newKeyTtlPreset: '24h' as AgentKeyTtlPreset,
      isLoadingKeys: false,
      isCreatingKey: false,

      // 云端日志快照管理状态
      cloudAccountId: '',
      cloudLoggingEnabled: false,
      cloudSnapshots: [] as DebugSnapshotMeta[],
      cloudLoaded: false,
      cloudLoadVersion: 0,
      isLoadingCloudSnapshots: false,
      isDeletingCloudSnapshot: false,
      pendingDeleteSnapshotId: null as string | null,
      cloudNotice: null as string | null,
      cloudError: null as string | null,
    };
  },

  getters: {
    /** 当前已开启通道过滤后的基础日志集 */
    channelFilteredEntries(state): LatticeLogEntry[] {
      return state.entries.filter((e) => {
        if (e.source === 'local' && !state.captureLocal) return false;
        if (e.source === 'remote' && !state.captureRemote) return false;
        if (e.source === 'frontend' && !state.captureFrontend) return false;
        return true;
      });
    },

    /** 当前账号云端快照汇总 */
    cloudSnapshotCount(state): number {
      return state.cloudSnapshots.length;
    },
    cloudSnapshotTotalEntries(state): number {
      return state.cloudSnapshots.reduce((total, item) => total + item.entryCount, 0);
    },
    cloudSnapshotTotalSizeBytes(state): number {
      return state.cloudSnapshots.reduce((total, item) => total + item.sizeBytes, 0);
    },
    cloudSnapshotTotalRows(state): number {
      return state.cloudSnapshots.reduce((total, item) => total + item.chunkCount, 0);
    },
    pendingDeleteSnapshot(state): DebugSnapshotMeta | null {
      if (!state.pendingDeleteSnapshotId) return null;
      return (
        state.cloudSnapshots.find((item) => item.snapshotId === state.pendingDeleteSnapshotId) ??
        null
      );
    },

    /** 当前明文密钥是否仍对应一把未过期、服务端已确认的密钥。 */
    activeAgentKeyUsable(state): boolean {
      if (!state.activeRawKey) return false;
      const prefix = `${state.activeRawKey.slice(0, 14)}…${state.activeRawKey.slice(-4)}`;
      const item = state.agentKeys.find((key) => key.keyPrefix === prefix);
      return !!item && !item.expired;
    },

    /** 缓冲区时间跨度边界 */
    timeBounds(): { minTime: number; maxTime: number; spanMs: number } {
      const list = this.channelFilteredEntries;
      if (list.length === 0) {
        const now = Date.now();
        return { minTime: now, maxTime: now, spanMs: 0 };
      }
      const minTime = list[0]!.timestamp;
      const maxTime = list[list.length - 1]!.timestamp;
      return { minTime, maxTime, spanMs: Math.max(0, maxTime - minTime) };
    },

    /** 当前时间轴视口对应的起止毫秒时间戳 */
    viewportTimeRange(): { startMs: number; endMs: number; startLabel: string; endLabel: string } {
      const { minTime, maxTime, spanMs } = this.timeBounds;
      const startMs = spanMs > 0 ? Math.round(minTime + spanMs * this.viewStartRatio) : minTime;
      const endMs = spanMs > 0 ? Math.round(minTime + spanMs * this.viewEndRatio) : maxTime;
      const fmt = (ms: number) => {
        const d = new Date(ms);
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        const mil = String(d.getMilliseconds()).padStart(3, '0');
        return `${h}:${m}:${s}.${mil}`;
      };
      return {
        startMs,
        endMs,
        startLabel: fmt(startMs),
        endLabel: fmt(endMs),
      };
    },

    /** 48 格时间轴密度柱与异常标记点 */
    timelineBuckets(): TimelineBucketItem[] {
      const list = this.channelFilteredEntries;
      const { minTime, spanMs } = this.timeBounds;
      const buckets: TimelineBucketItem[] = Array.from({ length: TIMELINE_BUCKET_COUNT }, (_, idx) => ({
        index: idx,
        count: 0,
        heightPercent: 10,
        hasError: false,
        hasWarn: false,
      }));
      if (list.length === 0) return buckets;

      let maxBucketCount = 1;
      for (const e of list) {
        const ratio = spanMs > 0 ? (e.timestamp - minTime) / spanMs : 1;
        const idx = Math.max(0, Math.min(TIMELINE_BUCKET_COUNT - 1, Math.floor(ratio * TIMELINE_BUCKET_COUNT)));
        const b = buckets[idx]!;
        b.count += 1;
        if (b.count > maxBucketCount) maxBucketCount = b.count;
        if (e.level === 'ERROR') b.hasError = true;
        if (e.level === 'WARN') b.hasWarn = true;
      }

      for (const b of buckets) {
        b.heightPercent = b.count === 0 ? 8 : Math.max(18, Math.round((b.count / maxBucketCount) * 100));
      }
      return buckets;
    },

    /** 时间轴底部 6 刻度尺（0% ~ 100% 均匀分布的具体时间标签） */
    timelineAxisTicks(): TimelineAxisTick[] {
      const { minTime, spanMs } = this.timeBounds;
      const ratios = [0, 0.2, 0.4, 0.6, 0.8, 1];
      const showMillis = spanMs > 0 && spanMs < 15_000;
      return ratios.map((ratio, idx) => {
        const ms = spanMs > 0 ? Math.round(minTime + spanMs * ratio) : minTime;
        const d = new Date(ms);
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        const mil = String(d.getMilliseconds()).padStart(3, '0');
        return {
          index: idx,
          ratio,
          percent: Math.round(ratio * 100),
          label: showMillis ? `${h}:${m}:${s}.${mil}` : `${h}:${m}:${s}`,
        };
      });
    },

    /** 经过时间轴视口 + Grep 关键字 + 级别 + 树折叠状态过滤后的扁平可见行（附带 1-based 行号） */
    visibleRows(state): VirtualLogRow[] {
      const { startMs, endMs } = this.viewportTimeRange;
      const { spanMs } = this.timeBounds;
      const kw = state.grepKeyword.trim().toLowerCase();

      const childCheck = new Set<string>();
      for (const e of this.channelFilteredEntries) {
        if (e.spanId.includes('.')) {
          childCheck.add(e.traceId);
        }
      }

      const out: VirtualLogRow[] = [];
      for (const entry of this.channelFilteredEntries) {
        if (spanMs > 0 && (entry.timestamp < startMs || entry.timestamp > endMs)) {
          continue;
        }
        if (state.levelFilter !== 'ALL' && entry.level !== state.levelFilter) {
          continue;
        }
        const depth = Math.max(0, entry.spanId.split('.').length - 1);
        const isRoot = depth === 0;
        if (!isRoot && state.collapsedTraceIds[entry.traceId]) {
          continue;
        }
        const formattedLine = formatLatticeGrepLine(entry);
        if (kw && !formattedLine.toLowerCase().includes(kw)) {
          continue;
        }
        out.push({
          lineNumber: out.length + 1,
          entry,
          depth,
          isRoot,
          hasChildren: childCheck.has(entry.traceId),
          isCollapsed: Boolean(state.collapsedTraceIds[entry.traceId]),
          formattedLine,
        });
      }
      return out;
    },

    /** 自适应多行折行终端切片：支持完整自动折行显示且限制最大 DOM 节点数以防卡顿 */
    virtualSlice(): {
      rows: VirtualLogRow[];
      topSpacerPx: number;
      bottomSpacerPx: number;
      totalRows: number;
    } {
      const all = this.visibleRows;
      const totalRows = all.length;
      const rows =
        totalRows > MAX_RENDERED_WRAPPED_ROWS
          ? all.slice(totalRows - MAX_RENDERED_WRAPPED_ROWS)
          : all;

      return {
        rows,
        topSpacerPx: 0,
        bottomSpacerPx: 0,
        totalRows,
      };
    },
  },

  actions: {
    /** 幂等初始化日志采集桥与远端密钥列表 */
    initialize() {
      if (!this.initialized) {
        this.initialized = true;
        debugLoggerDataSource.initBridge((entry) => {
          this.enqueueEntry(entry);
        });
        debugLoggerDataSource.setLocalWorkerDebug(this.captureLocal);
        debugLoggerDataSource.setRemotePiggybackDebug(this.captureRemote);
        this.recordFrontendSpan('debug.logger', 'logger_initialized', {
          local: this.captureLocal,
          remote: this.captureRemote,
          frontend: this.captureFrontend,
        });
      }
      this.syncCloudAccountContext();
      void this.loadAgentKeys();
    },

    /** 从当前登录用户同步云端日志开关；切换账号时清空上一个账号的快照列表。 */
    syncCloudAccountContext() {
      const userId = useAuthStore().user?.id ?? '';
      if (userId === this.cloudAccountId) return;
      this.cloudAccountId = userId;
      this.cloudSnapshots = [];
      this.cloudLoaded = false;
      this.cloudLoadVersion += 1;
      this.isLoadingCloudSnapshots = false;
      this.isLoadingKeys = false;
      this.lastSnapshotPushedAt = 0;
      this.pendingDeleteSnapshotId = null;
      this.cloudNotice = null;
      this.cloudError = null;
      this.cloudLoggingEnabled = userId ? readCloudLoggingEnabled(userId) : false;
      this.agentKeys = [];
      this.activeRawKey = userId ? readSavedRawKey(userId) : '';
    },

    /** 设置页打开时调用：同步账号上下文并拉取云端快照元数据与 Agent 密钥。 */
    initializeCloudPanel() {
      this.syncCloudAccountContext();
      if (!this.cloudAccountId) {
        this.cloudError = '请先登录后再管理云端日志';
        return;
      }
      void this.loadAgentKeys();
      void this.loadCloudSnapshots();
    },

    /** 切换三个无圆角采集源开关 (local / remote / frontend) */
    toggleSource(source: 'local' | 'remote' | 'frontend') {
      if (source === 'local') {
        this.captureLocal = !this.captureLocal;
        debugLoggerDataSource.setLocalWorkerDebug(this.captureLocal);
      } else if (source === 'remote') {
        this.captureRemote = !this.captureRemote;
        debugLoggerDataSource.setRemotePiggybackDebug(this.captureRemote);
      } else {
        this.captureFrontend = !this.captureFrontend;
      }
      writeSavedSources({
        local: this.captureLocal,
        remote: this.captureRemote,
        frontend: this.captureFrontend,
      });
    },

    /** 记录前端 Store / 交互事件 */
    recordFrontendSpan(
      domain: string,
      action: string,
      tags?: Record<string, string | number | boolean>,
      level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' = 'INFO',
    ) {
      if (!this.captureFrontend) return;
      const now = Date.now();
      this.enqueueEntry({
        id: `fe-${now}-${Math.random().toString(36).slice(2, 6)}`,
        traceId: now.toString(16).slice(-6),
        spanId: '01',
        source: 'frontend',
        domain,
        action,
        level,
        timestamp: now,
        relMs: 0,
        tags,
      });
    },

    /** RAF 合并入队：防止高频事件阻塞主线程响应式渲染 */
    enqueueEntry(entry: LatticeLogEntry) {
      if (entry.source === 'local' && !this.captureLocal) return;
      if (entry.source === 'remote' && !this.captureRemote) return;
      if (entry.source === 'frontend' && !this.captureFrontend) return;

      pendingIngressQueue.push(entry);
      if (rafScheduled) return;
      rafScheduled = true;

      const flush = () => {
        rafScheduled = false;
        this.flushPendingIngress();
      };

      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(flush);
      } else {
        setTimeout(flush, 32);
      }
    },

    /** 上传前同步合并尚未经 RAF 刷入的日志，确保快照不会漏掉刚产生的条目。 */
    flushPendingIngress() {
      if (pendingIngressQueue.length === 0) return;
      const batch = pendingIngressQueue;
      pendingIngressQueue = [];
      const combined = [...this.entries, ...batch];
      this.entries =
        combined.length > MAX_RING_BUFFER
          ? combined.slice(combined.length - MAX_RING_BUFFER)
          : combined;

      if (this.isFollowLive) {
        this.viewEndRatio = 1;
        if (typeof window !== 'undefined') {
          window.requestAnimationFrame(() => {
            debugLoggerDataSource.scrollToBottom();
          });
        }
      }
    },

    /** 切换某个根 Trace 的折叠/展开态 */
    toggleTraceCollapse(traceId: string) {
      if (this.collapsedTraceIds[traceId]) {
        delete this.collapsedTraceIds[traceId];
      } else {
        this.collapsedTraceIds[traceId] = true;
      }
    },

    /** 切换 LIVE 实时跟随模式 */
    toggleFollowLive() {
      this.isFollowLive = !this.isFollowLive;
      if (this.isFollowLive) {
        const span = Math.max(0.15, this.viewEndRatio - this.viewStartRatio);
        this.viewEndRatio = 1;
        this.viewStartRatio = Math.max(0, 1 - span);
        window.requestAnimationFrame(() => {
          debugLoggerDataSource.scrollToBottom();
        });
      }
    },

    /** 重置时间轴视口为全量 [0, 1] */
    resetTimelineViewport() {
      this.viewStartRatio = 0;
      this.viewEndRatio = 1;
    },

    /** 拖拽时间轴视口滑窗（支持 'brush' 直接刷选新区域 / 'move' 平移 / 'left' 左边界 / 'right' 右边界） */
    startTimelineDrag(mode: 'brush' | 'move' | 'left' | 'right', event: PointerEvent) {
      this.isFollowLive = false;
      debugLoggerDataSource.beginTimelineDrag(
        mode,
        event.clientX,
        this.viewStartRatio,
        this.viewEndRatio,
        (nextStart, nextEnd) => {
          this.viewStartRatio = nextStart;
          this.viewEndRatio = nextEnd;
        },
      );
    },

    /** 终端滚动事件处理（更新虚拟列表切片偏移，上滚时自动解除 LIVE 跟随） */
    handleTerminalScroll(event: Event) {
      const el = event.target as HTMLElement | null;
      if (!el) return;
      this.terminalScrollTop = el.scrollTop;
      this.terminalClientHeight = el.clientHeight || 360;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 36;
      if (!nearBottom && this.isFollowLive) {
        this.isFollowLive = false;
      }
    },

    setAgentBtnHovered(hovered: boolean) {
      this.isAgentBtnHovered = hovered;
    },

    clearLogs() {
      pendingIngressQueue = [];
      this.entries = [];
      this.collapsedTraceIds = {};
      this.viewStartRatio = 0;
      this.viewEndRatio = 1;
      this.statusNotice = '已清空本地运行日志缓冲区（云端快照不受影响）';
    },

    /** 导出当前可见树状时间轴文本 */
    buildFormattedTreeDump(): string {
      const rows = this.visibleRows;
      const header = `# === LATTICE TRACE TREE DUMP (${new Date().toISOString()} | Rows: ${rows.length}) ===`;
      const lines = rows.map((r) => {
        const lineNo = String(r.lineNumber).padStart(4, '0');
        const indent = r.depth === 0 ? '▼ ' : `${'  '.repeat(r.depth - 1)}├─ `;
        return `${lineNo} | ${indent}${r.formattedLine}`;
      });
      return [header, ...lines].join('\n');
    },

    /** 一键复制当前视口内的分级树状日志 */
    async copyLogsToClipboard() {
      const text = this.buildFormattedTreeDump();
      const ok = await debugLoggerDataSource.copyText(text);
      this.statusNotice = ok
        ? `已复制 ${this.visibleRows.length} 条结构化树状日志到剪贴板`
        : '复制失败，请检查浏览器剪贴板权限';
    },

    /** 一键下载 .log 文件 */
    downloadLogsAsFile() {
      const text = this.buildFormattedTreeDump();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      debugLoggerDataSource.downloadLogFile(`lattice-trace-${stamp}.log`, text);
      this.statusNotice = '已触发下载运行日志 (.log)';
    },

    /** 手动把当前本地日志提交为一条新的云端快照；成功后清理已提交的本地条目。 */
    async pushSnapshotNow(): Promise<DebugSnapshotMeta | null> {
      this.syncCloudAccountContext();
      if (!this.cloudAccountId) {
        this.cloudError = '请先登录后再同步云端日志';
        return null;
      }
      if (!this.cloudLoggingEnabled) {
        this.cloudError = '云端日志记录已关闭，请先开启后再同步';
        return null;
      }
      if (this.isPushingSnapshot) return null;

      this.flushPendingIngress();
      const list = this.channelFilteredEntries;
      if (list.length === 0) {
        this.cloudError = null;
        this.cloudNotice = '暂无可同步的运行日志';
        return null;
      }

      const accountId = this.cloudAccountId;
      this.isPushingSnapshot = true;
      this.cloudError = null;
      this.cloudNotice = null;
      this.statusNotice = null;
      try {
        const meta = await debugLoggerDataSource.pushSnapshotToRemote(list);
        if (this.cloudAccountId !== accountId) {
          this.cloudError = '账号已切换，本次云端日志提交未计入当前账号';
          return null;
        }

        this.cloudLoadVersion += 1;
        this.isLoadingCloudSnapshots = false;
        this.cloudSnapshots = [meta, ...this.cloudSnapshots];
        this.cloudLoaded = true;
        this.lastSnapshotPushedAt = meta.createdAt;
        this.statusNotice = `已同步 ${meta.entryCount} 条日志至云端快照（${meta.chunkCount} 行）`;
        this.cloudNotice = '快照已归属当前账号，本地已提交日志已清理';

        // 只清理本次真正上传的条目；关闭采集源产生的未上传日志继续保留在本地。
        const uploadedIds = new Set(list.map((entry) => entry.id));
        this.entries = this.entries.filter((entry) => !uploadedIds.has(entry.id));
        if (this.entries.length === 0) {
          this.viewStartRatio = 0;
          this.viewEndRatio = 1;
          this.collapsedTraceIds = {};
        }
        return meta;
      } catch (err) {
        this.cloudError = err instanceof Error ? err.message : '同步云端日志失败';
        this.statusNotice = this.cloudError;
        return null;
      } finally {
        this.isPushingSnapshot = false;
      }
    },

    /**
     * 从运行监控跳转：按 traceId 过滤终端并重置时间轴视口。
     * LOCAL 采集关闭时 Worker 的任务 Span 不会进入终端，给出提示而不是静默空列表。
     */
    focusTrace(traceId: string) {
      this.grepKeyword = traceId;
      this.levelFilter = 'ALL';
      this.viewStartRatio = 0;
      this.viewEndRatio = 1;
      this.isFollowLive = false;
      this.statusNotice = this.captureLocal
        ? `已按 ${traceId} 过滤日志`
        : `已按 ${traceId} 过滤；LOCAL 采集未开启，Worker 任务日志不会出现在终端`;
    },

    /**
     * 上传调用方组装的条目为一条独立云端快照（例如运行监控快照），不清理本地终端日志。
     * 与 pushSnapshotNow 共用账号与开关校验，成功后插入快照列表。
     */
    async pushCustomSnapshot(entries: LatticeLogEntry[]): Promise<DebugSnapshotMeta> {
      this.syncCloudAccountContext();
      if (!this.cloudAccountId) throw new Error('请先登录后再同步云端快照');
      if (!this.cloudLoggingEnabled) throw new Error('云端日志记录已关闭，请先在「日志」页开启');
      if (entries.length === 0) throw new Error('暂无可导出的数据');
      const accountId = this.cloudAccountId;
      const meta = await debugLoggerDataSource.pushSnapshotToRemote(entries);
      if (this.cloudAccountId !== accountId) throw new Error('账号已切换，本次快照未计入当前账号');
      this.cloudLoadVersion += 1;
      this.cloudSnapshots = [meta, ...this.cloudSnapshots];
      this.cloudLoaded = true;
      return meta;
    },

    /** 读取当前账号的云端快照元数据列表（不下载压缩正文）。 */
    async loadCloudSnapshots() {
      this.syncCloudAccountContext();
      if (!this.cloudAccountId) {
        this.cloudError = '请先登录后再管理云端日志';
        return;
      }

      const accountId = this.cloudAccountId;
      const version = ++this.cloudLoadVersion;
      this.isLoadingCloudSnapshots = true;
      this.cloudError = null;
      try {
        const snapshots = await debugLoggerDataSource.fetchCloudSnapshots();
        if (version !== this.cloudLoadVersion || this.cloudAccountId !== accountId) return;
        this.cloudSnapshots = snapshots;
        this.cloudLoaded = true;
        this.lastSnapshotPushedAt = snapshots[0]?.createdAt ?? 0;
      } catch (err) {
        if (version !== this.cloudLoadVersion) return;
        this.cloudError = err instanceof Error ? err.message : '读取云端日志快照失败';
      } finally {
        if (version === this.cloudLoadVersion) this.isLoadingCloudSnapshots = false;
      }
    },

    /** 开关当前账号的云端日志记录；关闭不会自动删除已有快照。 */
    setCloudLoggingEnabled(enabled: boolean) {
      this.syncCloudAccountContext();
      if (!this.cloudAccountId) {
        this.cloudError = '请先登录后再修改云端日志记录设置';
        return;
      }
      this.cloudLoggingEnabled = enabled;
      writeCloudLoggingEnabled(this.cloudAccountId, enabled);
      this.cloudError = null;
      this.cloudNotice = enabled
        ? '已开启当前账号的云端日志记录'
        : '已关闭当前账号的云端日志记录；已有快照仍可查看和删除';
    },

    /** 打开删除确认弹窗的目标（弹窗开关属于 UI 态，归 Store）。 */
    requestDeleteCloudSnapshot(snapshotId: string) {
      if (!this.cloudSnapshots.some((item) => item.snapshotId === snapshotId)) return;
      this.pendingDeleteSnapshotId = snapshotId;
      this.cloudError = null;
    },

    cancelDeleteCloudSnapshot() {
      if (this.isDeletingCloudSnapshot) return;
      this.pendingDeleteSnapshotId = null;
      this.cloudError = null;
    },

    /** 确认删除当前账号的一条快照及其全部分片行。 */
    async confirmDeleteCloudSnapshot() {
      const snapshotId = this.pendingDeleteSnapshotId;
      if (!snapshotId || this.isDeletingCloudSnapshot) return;
      const accountId = this.cloudAccountId;

      this.isDeletingCloudSnapshot = true;
      this.cloudError = null;
      try {
        await debugLoggerDataSource.deleteCloudSnapshot(snapshotId);
        if (this.cloudAccountId !== accountId) return;
        this.cloudLoadVersion += 1;
        this.isLoadingCloudSnapshots = false;
        this.cloudSnapshots = this.cloudSnapshots.filter(
          (item) => item.snapshotId !== snapshotId,
        );
        this.pendingDeleteSnapshotId = null;
        this.cloudNotice = '已删除该云端日志快照及其全部分片';
        if (this.cloudSnapshots.length === 0) this.lastSnapshotPushedAt = 0;
      } catch (err) {
        this.cloudError = err instanceof Error ? err.message : '删除云端日志快照失败';
      } finally {
        this.isDeletingCloudSnapshot = false;
      }
    },

    /** 加载当前用户的 Agent 访问密钥列表 */
    async loadAgentKeys() {
      this.syncCloudAccountContext();
      if (!this.cloudAccountId) return;
      const accountId = this.cloudAccountId;
      this.isLoadingKeys = true;
      try {
        const keys = await debugLoggerDataSource.fetchAgentKeys();
        if (this.cloudAccountId !== accountId) return;
        this.agentKeys = keys;
      } catch {
        // 未登录或离线时静默忽略
      } finally {
        if (this.cloudAccountId === accountId) this.isLoadingKeys = false;
      }
    },

    /** 创建新的 Agent 访问密钥并保存当前可用明文凭证 */
    async createNewAgentKey() {
      this.syncCloudAccountContext();
      if (!this.cloudAccountId) {
        this.statusNotice = '请先登录后再创建 Agent 访问密钥';
        return;
      }
      const accountId = this.cloudAccountId;
      this.isCreatingKey = true;
      this.statusNotice = null;
      try {
        const res = await debugLoggerDataSource.createAgentKey(this.newKeyName, this.newKeyTtlPreset);
        if (this.cloudAccountId !== accountId) return;
        this.activeRawKey = res.rawKey;
        writeSavedRawKey(accountId, res.rawKey);
        this.agentKeys = [res.key, ...this.agentKeys];
        this.statusNotice = `已创建密钥「${res.key.name}」并设为当前 Agent 凭证`;
      } catch (err) {
        this.statusNotice = err instanceof Error ? err.message : '创建 Agent 密钥失败';
      } finally {
        this.isCreatingKey = false;
      }
    },

    /** 吊销指定 Agent 访问密钥 */
    async revokeAgentKey(keyId: string) {
      const accountId = this.cloudAccountId;
      try {
        const target = this.agentKeys.find((k) => k.id === keyId);
        const activePrefix = this.activeRawKey
          ? `${this.activeRawKey.slice(0, 14)}…${this.activeRawKey.slice(-4)}`
          : '';
        await debugLoggerDataSource.revokeAgentKey(keyId);
        if (this.cloudAccountId !== accountId) return;
        this.agentKeys = this.agentKeys.filter((k) => k.id !== keyId);
        if (target && target.keyPrefix === activePrefix) {
          this.activeRawKey = '';
          writeSavedRawKey(accountId, '');
        }
        this.statusNotice = '已吊销该 Agent 访问密钥';
      } catch (err) {
        this.statusNotice = err instanceof Error ? err.message : '吊销密钥失败';
      }
    },

    /**
     * 核心交互：点击「使用 Agent 查阅运行日志」按钮
     * 1. 若云端记录关闭或没有可查询数据，停止复制；
     * 2. 若尚无有效 Agent 访问密钥，自动签发一个；
     * 3. 有本地日志时先提交为一条新的云端快照；
     * 4. 将「接口地址 + 渐进式查询 Skills 文档 + 访问密钥」一键复制到剪贴板。
     */
    async copyAgentSkillAndKeyBundle() {
      this.syncCloudAccountContext();
      if (!this.cloudAccountId) {
        this.statusNotice = '请先登录后再生成 Agent 查询凭证';
        return;
      }
      if (!this.cloudLoggingEnabled) {
        this.statusNotice = '云端日志记录已关闭，请先在「云」卡片中开启';
        return;
      }
      const accountId = this.cloudAccountId;

      this.statusNotice = '正在准备云端日志与 Agent 渐进式查询凭证…';
      try {
        this.flushPendingIngress();
        if (this.channelFilteredEntries.length > 0) {
          const pushed = await this.pushSnapshotNow();
          if (!pushed) {
            this.statusNotice = this.cloudError || '同步云端日志快照失败，已停止复制 Agent 凭证';
            return;
          }
        } else {
          if (!this.cloudLoaded) await this.loadCloudSnapshots();
          if (this.cloudSnapshots.length === 0) {
            this.statusNotice = this.cloudError || '暂无可同步的运行日志，也未发现云端快照';
            return;
          }
        }

        if (!this.activeAgentKeyUsable) {
          const created = await debugLoggerDataSource.createAgentKey('Agent 自动签发密钥', this.newKeyTtlPreset);
          if (this.cloudAccountId !== accountId) {
            this.statusNotice = '账号已切换，已停止复制 Agent 凭证';
            return;
          }
          this.activeRawKey = created.rawKey;
          writeSavedRawKey(accountId, created.rawKey);
          this.agentKeys = [created.key, ...this.agentKeys];
        }

        const origin = typeof window !== 'undefined' ? window.location.origin : 'https://lattice-v2.zhaowendao2005.workers.dev';
        const endpoint = `${origin}/api/debug/agent/query`;
        const key = this.activeRawKey;

        const skillDoc = [
          '# Lattice Archive 运行日志渐进式检索 Skill (Progressive Log Explorer)',
          '',
          '你可以通过以下只读 HTTP 接口直接渐进式查询当前系统的运行日志（涵盖 `local` Worker、`remote` Worker 与 `frontend` 状态流）。',
          '所有已提交的云端日志快照会按日志时间戳合并为一条整体时间线，查询结果不按提交记录分组。',
          '请像翻阅系统文件目录与使用 `grep` 一样：先看全局业务域目录树 (`mode=overview`)，再按时间区间 (`from`/`to`)、业务域 (`domain`) 或关键词 (`mode=grep`) 深入，最后展开目标 `traceId` 的完整调用树 (`mode=trace`)。查询次数不受限制，请自主按需检索。',
          '',
          '## 1. 接口与认证密钥',
          `- **Query Endpoint**: \`${endpoint}\``,
          `- **Access Key**: \`${key}\``,
          `- **Auth Header**: \`Authorization: Bearer ${key}\` (或 URL 参数 \`?key=${key}\`)`,
          '',
          '## 2. 通用过滤参数（所有 mode 均支持组合使用）',
          '- `from` / `to`: 时间区间过滤（支持毫秒时间戳、ISO 时间，或相对偏移如 `from=-10m`、`from=-60s`、`from=+1500ms`）',
          '- `source`: 端源过滤，`local` | `remote` | `frontend`（支持逗号分隔，如 `local,frontend`）',
          '- `domain`: 业务域目录前缀（如 `chat.pts`、`tg.gateway`、`bot.callback`、`chat.send`、`chat.updates`、`chat.search`、`chat.media`、`chat.rpc`、`archive.search`、`archive.cover`、`archive.import`、`archive.storage`）',
          '- `level`: 级别过滤，`DEBUG` | `INFO` | `WARN` | `ERROR`（支持逗号分隔，如 `WARN,ERROR`）',
          '- `limit` / `offset`: 分页大小（默认 80，最大 500）与偏移量',
          '',
          '## 3. 四阶渐进式查询步骤 (Skills)',
          '',
          '### Step 1: 查看全局业务域目录树与异常热点 (`mode=overview`，类似 `ls -la /`)',
          '```bash',
          `curl -s -H "Authorization: Bearer ${key}" "${endpoint}?mode=overview"`,
          '```',
          '',
          '### Step 2: 浏览指定业务域与时间区间的时间轴索引 (`mode=timeline`，类似 `ls /local/<domain>`)',
          '```bash',
          `curl -s -H "Authorization: Bearer ${key}" "${endpoint}?mode=timeline&source=local&domain=chat.pts&from=-15m&limit=60"`,
          '```',
          '',
          '### Step 3: 使用 Grep 正则/关键词/键值对精准检索 (`mode=grep`，类似 `grep -rn`)',
          '```bash',
          `curl -s -H "Authorization: Bearer ${key}" "${endpoint}?mode=grep&q=gap|BOT_RESPONSE_TIMEOUT|UpdateShortSentMessage"`,
          '```',
          '',
          '### Step 4: 展开指定 Trace 的完整父子分级树与 +Δms 时间轴 (`mode=trace`，类似 `cat /traces/<id>`)',
          '```bash',
          `curl -s -H "Authorization: Bearer ${key}" "${endpoint}?mode=trace&traceId=<填入上一步查到的traceId>"`,
          '```',
          '',
          '## 4. 封面 / 缩略图排查速查',
          '- 搜索结果：`domain=archive.search` 看 `stream_page_ok` 的 `withThumb/withoutThumb` 与分页游标；再看 `domain=archive.cover` 的 `search_cover_skipped` / `search_cover_error` / `search_cover_ok`。',
          '- 磁贴封面：`domain=archive.cover` 的 `tile_cover_scheduled → tile_cover_ok | tile_cover_skipped | tile_cover_error`；`domain=archive.import` 看导入时的 `withTier0/withoutThumb`。',
          '- 底层下载：`domain=chat.media` 的 `photo_thumb_*` / `document_thumb_*` / `avatar_*` / `reference_expired_retry`。',
          '- 统一错误分桶（日志 tag `bucket`）：`NO_ACCOUNT` / `OFFLINE` / `NO_PEER` / `NO_MEDIA` / `NO_THUMB_SOURCE` / `EMPTY_BYTES` / `REF_EXPIRED` / `FLOOD_WAIT` / `PERMISSION` / `NOT_FOUND` / `AUTH` / `TIMEOUT` / `NETWORK` / `CANCELLED` / `BROKEN_IMAGE` / `STORAGE_QUOTA` / `STORAGE_DENIED` / `UNKNOWN`。',
        ].join('\n');

        const copied = await debugLoggerDataSource.copyText(skillDoc);
        this.statusNotice = copied
          ? '已准备云端日志查询凭证，并将「接口 + 渐进式查询 Skills + 访问密钥」复制到剪贴板！可直接粘贴给 Agent。'
          : '云端日志已就绪，但写入剪贴板失败，请手动复制下方密钥。';
      } catch (err) {
        this.statusNotice = err instanceof Error ? err.message : '生成 Agent 查日志凭证失败';
      }
    },
  },
});
