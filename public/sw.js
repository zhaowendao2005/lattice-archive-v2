/**
 * Lattice Archive v2 —— 渐进式媒体流 Service Worker（阶段 7）。
 *
 * 仅拦截 `/__lattice_progressive__/:sessionId/:streamKey` 的 GET Range 请求：
 * - 将任意字节区间对齐并夹紧到单个 512 KiB 分片边界内，确保每次向页面请求的数据块不跨 1 MiB 边界；
 * - Safari 探测（bytes=0-1）直接秒回 206，减少首帧握手往返；
 * - 浏览器取消 Range 请求（seek / 关闭播放器）时立即通知主线程中止底层 MTProto 分片下载；
 * - 绝不缓存明文媒体字节（前段 2 MiB 持久缓存由主线程经设备密钥 AES-GCM 加密后写入 chatMediaCache）。
 */

const PART_SIZE = 512 * 1024;
const PART_TIMEOUT_MS = 60_000;
const PREFIX = '/__lattice_progressive__/';

/** @type {Map<string, { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout> }>} */
const pending = new Map();
let nextSeq = 1;

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'lattice:stream-ping') {
    event.source?.postMessage({ type: 'lattice:stream-pong' });
    return;
  }
  if (data.type === 'lattice:stream-response') {
    const entry = pending.get(data.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(data.requestId);
    entry.resolve(data);
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(PREFIX)) return;
  event.respondWith(handleProgressiveFetch(event, url));
});

/**
 * @param {FetchEvent} event
 * @param {URL} url
 */
async function handleProgressiveFetch(event, url) {
  const rest = url.pathname.slice(PREFIX.length).split('/');
  const sessionId = rest[0] || '';
  const streamKey = decodeURIComponent(rest.slice(1).join('/'));
  const fileSize = Number(url.searchParams.get('size') || 0);
  const mimeType = url.searchParams.get('mime') || 'video/mp4';

  const rangeHeader = event.request.headers.get('range') || '';
  const match = /^bytes=(\d+)-(\d+)?$/i.exec(rangeHeader.trim());
  const start = match ? Number(match[1]) : 0;
  const originalEnd = match && match[2] !== undefined ? Number(match[2]) : undefined;

  if (!Number.isFinite(start) || start < 0 || (fileSize > 0 && start >= fileSize)) {
    return new Response('', {
      status: 416,
      headers: fileSize > 0 ? { 'Content-Range': `bytes */${fileSize}` } : {},
    });
  }

  // Safari 在开始流式播放前常先探测 bytes=0-1，已知文件总大小与 MIME 时直接响应 206。
  if (start === 0 && originalEnd === 1 && fileSize > 0 && mimeType) {
    return new Response(new Uint8Array(2).buffer, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Range': `bytes 0-1/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': '2',
        'Content-Type': mimeType,
        'Cache-Control': 'no-store',
      },
    });
  }

  // 将单次响应夹紧在当前 512 KiB 对齐块内，保证底层只需一次对齐的 upload.getFile。
  const blockStart = Math.floor(start / PART_SIZE) * PART_SIZE;
  const maxBlockEnd = fileSize > 0 ? Math.min(fileSize - 1, blockStart + PART_SIZE - 1) : blockStart + PART_SIZE - 1;
  const end = originalEnd !== undefined ? Math.min(originalEnd, maxBlockEnd) : maxBlockEnd;

  const client = await resolveTargetClient(event.clientId);
  if (!client) {
    return new Response('', { status: 503, statusText: 'No active client for progressive stream' });
  }

  const requestId = `${sessionId}-${Date.now()}-${nextSeq++}`;
  const response = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(null);
    }, PART_TIMEOUT_MS);

    pending.set(requestId, { resolve, timer });

    const onAbort = () => {
      const current = pending.get(requestId);
      if (!current) return;
      clearTimeout(current.timer);
      pending.delete(requestId);
      client.postMessage({ type: 'lattice:stream-cancel', requestId });
      resolve(null);
    };

    if (event.request.signal) {
      if (event.request.signal.aborted) {
        onAbort();
        return;
      }
      event.request.signal.addEventListener('abort', onAbort, { once: true });
    }

    client.postMessage({
      type: 'lattice:stream-part',
      requestId,
      sessionId,
      streamKey,
      start,
      end,
    });
  });

  if (!response || !response.ok || !(response.bytes instanceof ArrayBuffer) || response.bytes.byteLength === 0) {
    return new Response('', { status: 500, statusText: 'Failed to fetch progressive part' });
  }

  const fullSize = Number(response.fullSize) || fileSize || start + response.bytes.byteLength;
  const partSize = Math.min(end - start + 1, response.bytes.byteLength);
  const actualEnd = start + partSize - 1;
  const body = response.bytes.byteLength === partSize ? response.bytes : response.bytes.slice(0, partSize);

  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Range': `bytes ${start}-${actualEnd}/${fullSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(partSize),
      'Content-Type': response.mimeType || mimeType,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * @param {string} clientId
 */
async function resolveTargetClient(clientId) {
  if (clientId) {
    const direct = await self.clients.get(clientId);
    if (direct) return direct;
  }
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all[0] || null;
}
