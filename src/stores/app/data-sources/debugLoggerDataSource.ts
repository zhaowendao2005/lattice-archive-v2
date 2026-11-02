/**
 * ============================================================================
 * [DATA SOURCE] 三端调试日志、时间轴视口 DOM 句柄与远端快照桥接器 (debugLoggerDataSource.ts)
 * ============================================================================
 * 职责（纯薄桥接层 + 零 ref 视图 DOM 句柄托管）：
 * 1. 订阅 mtprotoHub 的 LOCAL 调试日志与 FRONTEND 状态事件；
 * 2. 拦截 /api/* 请求，在开启 REMOTE 采集时自动附带 X-Lattice-Debug: 1 并解析响应头中的顺风车耗时树（0 额外请求）；
 * 3. 调用 /api/debug/keys 与 /api/debug/snapshots（使用原生 CompressionStream('gzip') 压缩，并按 D1 单行预算分片）；
 * 4. 托管终端虚拟列表滚动容器与时间轴滑轨拖拽事件，确保 DeveloperSettingsView 100% 零本地 ref。
 */
import { authSessionStorage } from '@/stores/auth/data-sources/authSessionStorage';
import { mtprotoHub } from '@/stores/telegram/data-sources/mtprotoBridge';
import {
  DEBUG_SNAPSHOT_CHUNK_CHARS,
  DEBUG_SNAPSHOT_MAX_TOTAL_B64_CHARS,
  type AgentDebugKeyDto,
  type AgentKeyTtlPreset,
  type DebugSnapshotMeta,
  type LatticeLogEntry,
} from '@/worker/remote/debug/types';

export type { AgentDebugKeyDto, AgentKeyTtlPreset, DebugSnapshotMeta, LatticeLogEntry };

/** 带 HTTP 状态码的远端错误，便于 Store 区分 401 与普通网络错误。 */
export class DebugApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DebugApiError';
    this.status = status;
  }
}

async function readApiError(res: Response, fallback: string): Promise<DebugApiError> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return new DebugApiError(body.message || `${fallback} (${res.status})`, res.status);
}

function createSnapshotId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `snap_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function compressEntriesToGzipB64(
  entries: LatticeLogEntry[],
): Promise<{ b64: string; bytes: number }> {
  const jsonText = JSON.stringify(entries);
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([jsonText]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return {
      b64: bytesToBase64(new Uint8Array(buf)),
      bytes: buf.byteLength,
    };
  }
  const raw = new TextEncoder().encode(jsonText);
  return {
    b64: bytesToBase64(raw),
    bytes: raw.byteLength,
  };
}

/** 按 D1 单行安全预算切分 Base64；非末片长度始终是 4 的倍数，拼接后仍是合法 Base64。 */
function splitBase64Payload(b64: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < b64.length; offset += DEBUG_SNAPSHOT_CHUNK_CHARS) {
    chunks.push(b64.slice(offset, offset + DEBUG_SNAPSHOT_CHUNK_CHARS));
  }
  return chunks;
}

function authHeaders(): HeadersInit {
  const token = authSessionStorage.read()?.token;
  return token
    ? {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      }
    : {
        'Content-Type': 'application/json',
      };
}

export function formatLatticeGrepLine(entry: LatticeLogEntry): string {
  const iso = new Date(entry.timestamp).toISOString();
  const durPart = entry.durMs !== undefined ? `[dur:${entry.durMs}ms]` : '';
  const srcUpper = entry.source.toUpperCase();
  const tagPairs = entry.tags
    ? Object.entries(entry.tags)
        .map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? `"${v}"` : String(v)}`)
        .join(' ')
    : '';
  const msgPart = entry.message ? `msg="${entry.message}" ` : '';
  const tail = `${msgPart}${tagPairs}`.trim();
  return `[LATTICE][T:${entry.traceId}][S:${entry.spanId}][${iso}][+${entry.relMs}ms]${durPart}[${entry.level}][${srcUpper}:${entry.domain}] ${entry.action}${tail ? ` | ${tail}` : ''}`;
}

class DebugLoggerDataSource {
  private terminalEl: HTMLElement | null = null;
  private timelineTrackEl: HTMLElement | null = null;
  private fetchPatched = false;
  private remoteCaptureEnabled = false;
  private onEntryCallback: ((entry: LatticeLogEntry) => void) | null = null;
  private hubUnsub: (() => void) | null = null;
  private dragCleanup: (() => void) | null = null;

  /** 初始化监听桥（幂等） */
  initBridge(onEntry: (entry: LatticeLogEntry) => void): void {
    this.onEntryCallback = onEntry;
    if (!this.hubUnsub) {
      this.hubUnsub = mtprotoHub.subscribe((event) => {
        if (event.type === 'debugLog') {
          this.onEntryCallback?.(event.entry);
        } else if (event.type === 'connectionState') {
          this.onEntryCallback?.({
            id: `fe-conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            traceId: Date.now().toString(16).slice(-6),
            spanId: '01',
            source: 'frontend',
            domain: 'telegram.store',
            action: 'connection_state',
            level: event.state === 'online' ? 'INFO' : 'WARN',
            timestamp: Date.now(),
            relMs: 0,
            tags: { accountId: event.accountId, state: event.state, msg: event.message ?? '' },
          });
        } else if (event.type === 'chatUpdates') {
          this.onEntryCallback?.({
            id: `fe-upd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            traceId: Date.now().toString(16).slice(-6),
            spanId: '01',
            source: 'frontend',
            domain: 'chat.store',
            action: 'apply_live_updates',
            level: event.updates.some((u) => u.type === 'gap') ? 'WARN' : 'INFO',
            timestamp: Date.now(),
            relMs: 0,
            tags: {
              accountId: event.accountId,
              count: event.updates.length,
              types: event.updates.map((u) => u.type).join(','),
              pts: event.state?.pts ?? 0,
            },
          });
        }
      });
    }
    this.ensureFetchInterceptor();
  }

  /** 供前端各业务域 Store / DataSource（如云同步、磁贴归档、会话管理）上报结构化日志 */
  emitFrontendLog(params: {
    domain: string;
    action: string;
    level?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    relMs?: number;
    durMs?: number;
    message?: string;
    tags?: Record<string, string | number | boolean | undefined>;
  }): void {
    const cleanTags: Record<string, string | number | boolean> = {};
    if (params.tags) {
      for (const [k, v] of Object.entries(params.tags)) {
        if (v !== undefined) cleanTags[k] = v;
      }
    }
    this.onEntryCallback?.({
      id: `fe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      traceId: params.traceId || Date.now().toString(16).slice(-6),
      spanId: params.spanId || '01',
      parentSpanId: params.parentSpanId,
      source: 'frontend',
      domain: params.domain,
      action: params.action,
      level: params.level || 'INFO',
      timestamp: Date.now(),
      relMs: params.relMs ?? 0,
      durMs: params.durMs,
      message: params.message,
      tags: Object.keys(cleanTags).length > 0 ? cleanTags : undefined,
    });
  }

  /** 控制 Local Worker 是否回传底层 MTProto 与 PTS 调试日志 */
  setLocalWorkerDebug(enabled: boolean): void {
    mtprotoHub.bridge().setDebug(enabled);
  }

  /** 控制 Remote 请求是否顺风车携带 X-Lattice-Debug: 1 */
  setRemotePiggybackDebug(enabled: boolean): void {
    this.remoteCaptureEnabled = enabled;
    this.ensureFetchInterceptor();
  }

  private ensureFetchInterceptor(): void {
    if (this.fetchPatched || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    this.fetchPatched = true;
    const rawFetch = window.fetch.bind(window);

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const isApiCall = urlStr.includes('/api/') && !urlStr.includes('/api/debug/snapshot');

      if (!this.remoteCaptureEnabled || !isApiCall) {
        return rawFetch(input, init);
      }

      const traceId = Date.now().toString(16).slice(-6);
      const startMs = Date.now();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('X-Lattice-Debug', '1');
      headers.set('X-Lattice-Trace-Id', traceId);

      try {
        const res = await rawFetch(input, { ...init, headers });
        const durMs = Math.max(1, Date.now() - startMs);
        const traceHeader = res.headers.get('X-Lattice-Debug-Trace');
        if (traceHeader) {
          try {
            const parsed = JSON.parse(decodeURIComponent(traceHeader)) as LatticeLogEntry;
            this.onEntryCallback?.({
              ...parsed,
              id: `rem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            });
          } catch {
            // fallback if header parse fails
          }
        } else {
          this.onEntryCallback?.({
            id: `rem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            traceId,
            spanId: '01',
            source: 'remote',
            domain: 'http.api',
            action: `${init?.method ?? 'GET'} ${urlStr}`,
            level: res.status >= 500 ? 'ERROR' : res.status >= 400 ? 'WARN' : 'INFO',
            timestamp: startMs,
            relMs: 0,
            durMs,
            tags: { status: res.status, url: urlStr },
          });
        }
        return res;
      } catch (err) {
        const durMs = Math.max(1, Date.now() - startMs);
        this.onEntryCallback?.({
          id: `rem-err-${Date.now()}`,
          traceId,
          spanId: '01',
          source: 'remote',
          domain: 'http.api',
          action: `${init?.method ?? 'GET'} ${urlStr}`,
          level: 'ERROR',
          timestamp: startMs,
          relMs: 0,
          durMs,
          message: err instanceof Error ? err.message : 'network_error',
        });
        throw err;
      }
    };
  }

  /** 绑定终端滚动容器 DOM 句柄 */
  attachTerminalContainer(el: HTMLElement | null): void {
    this.terminalEl = el;
  }

  scrollToBottom(): void {
    if (!this.terminalEl) return;
    this.terminalEl.scrollTop = this.terminalEl.scrollHeight;
  }

  /** 绑定时间轴轨道 DOM 句柄 */
  attachTimelineTrack(el: HTMLElement | null): void {
    this.timelineTrackEl = el;
  }

  /**
   * 启动时间轴视口滑块拖拽（支持 'brush' 直接刷选新区域 / 'move' 整体平移 / 'left' 左边界缩放 / 'right' 右边界缩放）
   */
  beginTimelineDrag(
    mode: 'brush' | 'move' | 'left' | 'right',
    initialClientX: number,
    initialStartRatio: number,
    initialEndRatio: number,
    onUpdate: (nextStart: number, nextEnd: number) => void,
  ): void {
    this.dragCleanup?.();
    const track = this.timelineTrackEl;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const span = Math.max(0.02, initialEndRatio - initialStartRatio);
    const anchorRatio = Math.max(0, Math.min(1, (initialClientX - rect.left) / width));

    if (mode === 'brush') {
      const start = Math.max(0, Math.min(0.98, anchorRatio - 0.01));
      onUpdate(start, Math.min(1, start + 0.02));
    }

    const onMove = (ev: PointerEvent) => {
      if (mode === 'brush') {
        const curRatio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / width));
        const rawStart = Math.min(anchorRatio, curRatio);
        const rawEnd = Math.max(anchorRatio, curRatio);
        const nextStart = Math.max(0, Math.min(0.98, rawStart));
        const nextEnd = Math.min(1, Math.max(nextStart + 0.02, rawEnd));
        onUpdate(nextStart, nextEnd);
        return;
      }
      const deltaRatio = (ev.clientX - initialClientX) / width;
      if (mode === 'move') {
        let nextStart = Math.max(0, Math.min(1 - span, initialStartRatio + deltaRatio));
        let nextEnd = nextStart + span;
        if (nextEnd > 1) {
          nextEnd = 1;
          nextStart = 1 - span;
        }
        onUpdate(nextStart, nextEnd);
      } else if (mode === 'left') {
        const nextStart = Math.max(0, Math.min(initialEndRatio - 0.02, initialStartRatio + deltaRatio));
        onUpdate(nextStart, initialEndRatio);
      } else {
        const nextEnd = Math.min(1, Math.max(initialStartRatio + 0.02, initialEndRatio + deltaRatio));
        onUpdate(initialStartRatio, nextEnd);
      }
    };

    const onUp = () => {
      this.dragCleanup?.();
      this.dragCleanup = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    this.dragCleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }

  /** 复制文本到剪贴板 */
  async copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** 触发浏览器下载 .log 文件 */
  downloadLogFile(filename: string, content: string): void {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  /** 拉取当前用户的 Agent 访问密钥列表 */
  async fetchAgentKeys(): Promise<AgentDebugKeyDto[]> {
    const res = await fetch('/api/debug/keys', {
      method: 'GET',
      headers: authHeaders(),
    });
    if (!res.ok) throw await readApiError(res, '读取密钥列表失败');
    const data = (await res.json()) as { keys: AgentDebugKeyDto[] };
    return data.keys ?? [];
  }

  /** 创建新的 Agent 访问密钥 */
  async createAgentKey(
    name: string,
    ttlPreset: AgentKeyTtlPreset,
  ): Promise<{ rawKey: string; key: AgentDebugKeyDto }> {
    const res = await fetch('/api/debug/keys', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name, ttlPreset }),
    });
    if (!res.ok) throw await readApiError(res, '创建密钥失败');
    return (await res.json()) as { rawKey: string; key: AgentDebugKeyDto };
  }

  /** 吊销指定 Agent 访问密钥 */
  async revokeAgentKey(keyId: string): Promise<void> {
    const res = await fetch(`/api/debug/keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) throw await readApiError(res, '吊销密钥失败');
  }

  /** 读取当前账号的云端快照元数据列表；响应不包含压缩正文。 */
  async fetchCloudSnapshots(): Promise<DebugSnapshotMeta[]> {
    const res = await fetch('/api/debug/snapshots', {
      method: 'GET',
      headers: authHeaders(),
    });
    if (!res.ok) throw await readApiError(res, '读取云端日志快照失败');
    const data = (await res.json()) as { snapshots: DebugSnapshotMeta[] };
    return data.snapshots ?? [];
  }

  /** 删除当前账号的一条云端日志快照（其全部分片行）。 */
  async deleteCloudSnapshot(snapshotId: string): Promise<boolean> {
    const res = await fetch(`/api/debug/snapshots/${encodeURIComponent(snapshotId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) throw await readApiError(res, '删除云端日志快照失败');
    const data = (await res.json()) as { deleted?: boolean };
    return data.deleted === true;
  }

  /**
   * 将当前内存中的运行日志压缩为一条新的云端快照。
   * Base64 载荷按 D1 单行安全预算拆成尽可能少的连续分片，一次请求原子提交。
   */
  async pushSnapshotToRemote(entries: LatticeLogEntry[]): Promise<DebugSnapshotMeta> {
    if (entries.length === 0) {
      throw new Error('暂无可同步的运行日志');
    }

    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
      minTime = Math.min(minTime, entry.timestamp);
      maxTime = Math.max(maxTime, entry.timestamp);
    }

    const { b64, bytes } = await compressEntriesToGzipB64(entries);
    if (b64.length > DEBUG_SNAPSHOT_MAX_TOTAL_B64_CHARS) {
      throw new Error(
        `日志快照体积超出上限（${DEBUG_SNAPSHOT_MAX_TOTAL_B64_CHARS} Base64 字符），请减少日志范围后重试`,
      );
    }

    const chunks = splitBase64Payload(b64);
    const snapshotId = createSnapshotId();
    const res = await fetch('/api/debug/snapshots', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        snapshotId,
        chunks,
        chunkCount: chunks.length,
        entryCount: entries.length,
        minTime,
        maxTime,
        sizeBytes: bytes,
      }),
    });
    if (!res.ok) throw await readApiError(res, '上传云端日志快照失败');
    return (await res.json()) as DebugSnapshotMeta;
  }
}

export const debugLoggerDataSource = new DebugLoggerDataSource();
