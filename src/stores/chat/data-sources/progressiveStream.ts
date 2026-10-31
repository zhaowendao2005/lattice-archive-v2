/**
 * [DATA SOURCE] 渐进式视频流桥接器（阶段 7）
 *
 * 职责：
 * 1. 注册并维护 `/sw.js` Service Worker，监听其转发的 HTTP Range 请求（`lattice:stream-part` / `lattice:stream-cancel`）；
 * 2. 将任意 Range 请求映射为 512 KiB 对齐块，做内存块级 LRU（上限 24 块 = 12 MiB）与在途请求去重；
 * 3. 每个视频前 2 MiB（前 4 个 512 KiB 分片）经 `chatMediaCache`（设备密钥 AES-GCM 加密）持久化，二次打开秒起播；
 * 4. 当浏览器因 seek 或关闭播放器取消 Range 请求且无其余等待者时，立即通过 AbortController → `chatCancel` 中止 Worker 分片下载；
 * 5. 对瞬时网络/超时错误按 250ms→4s 指数退避重试最多 5 次。
 */
import { TgChatRequestError } from '@/stores/telegram/data-sources/mtprotoBridge';
import type { TgPeerRef, TgVideoQuality } from '../types';
import { chatDataSource } from './chatDataSource';
import { chatMediaCache } from './chatMediaCache';

const PART_SIZE = 512 * 1024;
/** 仅将每个视频开头的 2 MiB（前 4 个分片）写入加密持久缓存，兼顾秒开与存储配额。 */
const FRONT_CACHE_LIMIT = 2 * 1024 * 1024;
/** 内存中保留的对齐分片上限：24 × 512 KiB = 12 MiB，确保观看超大视频时内存恒定。 */
const MAX_MEMORY_BLOCKS = 24;
const BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000];
const RETRYABLE_PATTERNS = ['TIMEOUT', 'DISCONNECT', 'CONNECTION', 'NETWORK'];

export interface StreamDescriptor {
  ownerId: string;
  accountId: string;
  peer: TgPeerRef;
  messageId: number;
  quality: TgVideoQuality;
  mimeType: string;
}

interface CachedBlock {
  bytes: ArrayBuffer;
  fullSize: number;
}

interface InFlightBlock {
  streamKey: string;
  controller: AbortController;
  waiters: Set<string>;
  promise: Promise<CachedBlock>;
}

const sessionId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID().slice(0, 8)
  : String(Math.floor(Math.random() * 1e8));

const streams = new Map<string, StreamDescriptor>();
const blockCache = new Map<string, CachedBlock>();
const inFlightBlocks = new Map<string, InFlightBlock>();
/** requestId → 所属的 blockKey，用于收到 stream-cancel 时精确定位。 */
const requestToBlock = new Map<string, string>();

let swInstalled = false;
let swControlling = false;
let readyListener: ((ready: boolean) => void) | null = null;

function isRetryable(error: unknown): boolean {
  const raw = `${error instanceof TgChatRequestError ? error.code : ''} ${error instanceof Error ? error.message : ''}`.toUpperCase();
  return RETRYABLE_PATTERNS.some((pattern) => raw.includes(pattern));
}

function rememberBlock(blockKey: string, block: CachedBlock) {
  if (blockCache.has(blockKey)) blockCache.delete(blockKey);
  blockCache.set(blockKey, block);
  while (blockCache.size > MAX_MEMORY_BLOCKS) {
    const oldest = blockCache.keys().next().value;
    if (oldest === undefined) break;
    blockCache.delete(oldest);
  }
}

function touchBlock(blockKey: string): CachedBlock | undefined {
  const block = blockCache.get(blockKey);
  if (!block) return undefined;
  blockCache.delete(blockKey);
  blockCache.set(blockKey, block);
  return block;
}

function postToSw(message: Record<string, unknown>, transfer: Transferable[] = []) {
  navigator.serviceWorker?.controller?.postMessage(message, transfer);
}

async function fetchBlockWithRetry(
  descriptor: StreamDescriptor,
  blockOffset: number,
  signal: AbortSignal,
): Promise<CachedBlock> {
  const scope = chatMediaCache.scopeOf(descriptor.ownerId, descriptor.accountId);
  const blockIndex = Math.floor(blockOffset / PART_SIZE);
  const cacheKey = `vpart:${descriptor.quality.id}:${blockIndex}`;

  if (blockOffset < FRONT_CACHE_LIMIT) {
    const cached = await chatMediaCache.read(scope, cacheKey);
    if (cached && cached.size > 0) {
      const bytes = await cached.arrayBuffer();
      return { bytes, fullSize: descriptor.quality.size };
    }
  }

  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw new Error('TG_CANCELED');
    try {
      const part = await chatDataSource.getDocumentPart(
        descriptor.accountId,
        descriptor.peer,
        descriptor.messageId,
        descriptor.quality,
        blockOffset,
        PART_SIZE,
        { signal },
      );
      if (blockOffset < FRONT_CACHE_LIMIT && part.bytes.byteLength > 0) {
        void chatMediaCache.write(scope, cacheKey, part.bytes, descriptor.mimeType);
      }
      return { bytes: part.bytes, fullSize: part.fullSize || descriptor.quality.size };
    } catch (error) {
      if (signal.aborted || attempt >= BACKOFF_MS.length || !isRetryable(error)) throw error;
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, BACKOFF_MS[attempt]);
        signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
}

function acquireBlock(streamKey: string, descriptor: StreamDescriptor, blockOffset: number, requestId: string): Promise<CachedBlock> {
  const blockIndex = Math.floor(blockOffset / PART_SIZE);
  const blockKey = `${streamKey}:${blockIndex}`;
  const cached = touchBlock(blockKey);
  if (cached) return Promise.resolve(cached);

  requestToBlock.set(requestId, blockKey);
  const existing = inFlightBlocks.get(blockKey);
  if (existing) {
    existing.waiters.add(requestId);
    return existing.promise;
  }

  const controller = new AbortController();
  const waiters = new Set<string>([requestId]);
  const promise = fetchBlockWithRetry(descriptor, blockOffset, controller.signal)
    .then((block) => {
      rememberBlock(blockKey, block);
      return block;
    })
    .finally(() => {
      inFlightBlocks.delete(blockKey);
      waiters.forEach((id) => requestToBlock.delete(id));
    });

  inFlightBlocks.set(blockKey, { streamKey, controller, waiters, promise });
  return promise;
}

function cancelRequest(requestId: string) {
  const blockKey = requestToBlock.get(requestId);
  if (!blockKey) return;
  requestToBlock.delete(requestId);
  const entry = inFlightBlocks.get(blockKey);
  if (!entry) return;
  entry.waiters.delete(requestId);
  if (entry.waiters.size === 0) {
    inFlightBlocks.delete(blockKey);
    entry.controller.abort();
  }
}

async function handleStreamPart(data: { requestId: string; sessionId: string; streamKey: string; start: number; end: number }) {
  if (data.sessionId !== sessionId) return;
  const descriptor = streams.get(data.streamKey);
  if (!descriptor) {
    postToSw({ type: 'lattice:stream-response', requestId: data.requestId, ok: false });
    return;
  }
  const blockOffset = Math.floor(data.start / PART_SIZE) * PART_SIZE;
  try {
    const block = await acquireBlock(data.streamKey, descriptor, blockOffset, data.requestId);
    const relativeStart = data.start - blockOffset;
    const relativeEnd = Math.min(block.bytes.byteLength, data.end - blockOffset + 1);
    if (relativeStart < 0 || relativeStart >= relativeEnd) {
      postToSw({ type: 'lattice:stream-response', requestId: data.requestId, ok: false });
      return;
    }
    const slice = block.bytes.slice(relativeStart, relativeEnd);
    postToSw({
      type: 'lattice:stream-response',
      requestId: data.requestId,
      ok: true,
      bytes: slice,
      mimeType: descriptor.mimeType,
      fullSize: block.fullSize,
    }, [slice]);
  } catch {
    postToSw({ type: 'lattice:stream-response', requestId: data.requestId, ok: false });
  }
}

export const progressiveStream = {
  init(onReadyChange?: (ready: boolean) => void) {
    if (onReadyChange) readyListener = onReadyChange;
    if (swInstalled || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    swInstalled = true;

    const updateControlling = () => {
      const next = Boolean(navigator.serviceWorker.controller);
      if (next !== swControlling) {
        swControlling = next;
        readyListener?.(swControlling);
      }
    };

    navigator.serviceWorker.addEventListener('controllerchange', updateControlling);
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; sessionId?: string; streamKey?: string; start?: number; end?: number } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'lattice:stream-part' && data.requestId && data.streamKey !== undefined) {
        void handleStreamPart({
          requestId: data.requestId,
          sessionId: data.sessionId ?? '',
          streamKey: data.streamKey,
          start: Number(data.start ?? 0),
          end: Number(data.end ?? 0),
        });
      } else if (data.type === 'lattice:stream-cancel' && data.requestId) {
        cancelRequest(data.requestId);
      }
    });

    updateControlling();
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(() => navigator.serviceWorker.ready)
      .then(() => updateControlling())
      .catch(() => { /* 环境不支持 Service Worker 时静默回退到完整 Blob 下载 */ });
  },

  /** 当前页面是否已受渐进式 Service Worker 接管。 */
  isAvailable(): boolean {
    return swControlling && typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller);
  },

  /** 注册流式视频描述符并返回供 `<video src>` 使用的渐进式 URL。 */
  register(streamKey: string, descriptor: StreamDescriptor): string {
    streams.set(streamKey, descriptor);
    const params = new URLSearchParams({
      size: String(descriptor.quality.size),
      mime: descriptor.mimeType,
    });
    return `/__lattice_progressive__/${sessionId}/${encodeURIComponent(streamKey)}?${params.toString()}`;
  },

  /** 取消某个流的所有在途分片下载（离开查看器 / 切换画质 / 切换会话时调用）。 */
  abortStream(streamKey: string) {
    streams.delete(streamKey);
    inFlightBlocks.forEach((entry, blockKey) => {
      if (entry.streamKey !== streamKey) return;
      inFlightBlocks.delete(blockKey);
      entry.waiters.forEach((id) => requestToBlock.delete(id));
      entry.controller.abort();
    });
  },

  /** 切换账户时清空所有流描述符、内存分片与在途请求。 */
  reset() {
    streams.clear();
    blockCache.clear();
    requestToBlock.clear();
    inFlightBlocks.forEach((entry) => entry.controller.abort());
    inFlightBlocks.clear();
  },
};
