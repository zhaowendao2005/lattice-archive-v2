/**
 * [DATA SOURCE] 本机媒体持久缓存（Cache Storage）
 *
 * - 图片字节使用与会话保险箱相同的不可导出 AES-GCM 设备密钥加密后写入，缓存键按「Lattice 用户 / Telegram 账户」隔离；
 * - 参考实现的策略：常规媒体保留 5 天；单个文件超过 512 KiB 不进入持久缓存；条目总数超限时淘汰最旧的；
 * - Cache Storage 不可用（非安全上下文 / 隐私模式）或任何读写异常一律静默降级为仅内存缓存；
 * - 媒体只存在本设备，不进入 D1 或任何远端。
 */
import { tgSessionVault } from '@/stores/telegram/data-sources/tgSessionVault';

const CACHE_NAME = 'lattice-tg-media-v1';
/** 仅作为 Cache Storage 的键，不会发起任何网络请求。 */
const KEY_ORIGIN = 'https://lattice-media.invalid';
const TTL_MS = 5 * 24 * 60 * 60 * 1000;
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_ENTRIES = 2_000;
const PRUNE_DELAY_MS = 30_000;

let pruneScheduled = false;

function cacheAvailable() {
  return typeof caches !== 'undefined' && typeof window !== 'undefined' && window.isSecureContext;
}

function requestUrl(scope: string, key: string) {
  return `${KEY_ORIGIN}/${scope.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(key)}`;
}

function toBase64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
function fromBase64(value: string) { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }

async function prune() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    const now = Date.now();
    const alive: { request: Request; savedAt: number }[] = [];
    for (const request of requests) {
      const response = await cache.match(request);
      const savedAt = Number(response?.headers.get('x-saved-at') ?? 0);
      if (!response || !savedAt || now - savedAt > TTL_MS) await cache.delete(request);
      else alive.push({ request, savedAt });
    }
    if (alive.length <= MAX_ENTRIES) return;
    alive.sort((a, b) => a.savedAt - b.savedAt);
    for (const item of alive.slice(0, alive.length - MAX_ENTRIES)) await cache.delete(item.request);
  } catch {
    // 清理失败不影响浏览，下次启动再试。
  }
}

export const chatMediaCache = {
  /** 缓存隔离范围：同一浏览器的不同 Lattice 用户 / Telegram 账户互相读不到对方的媒体。 */
  scopeOf(ownerId: string, accountId: string) { return `${ownerId}/${accountId}`; },

  async read(scope: string, key: string): Promise<Blob | null> {
    if (!cacheAvailable()) return null;
    try {
      const cache = await caches.open(CACHE_NAME);
      const response = await cache.match(requestUrl(scope, key));
      if (!response) return null;
      const savedAt = Number(response.headers.get('x-saved-at') ?? 0);
      const iv = response.headers.get('x-iv');
      if (!iv || Date.now() - savedAt > TTL_MS) { await cache.delete(requestUrl(scope, key)); return null; }
      const plain = await tgSessionVault.openBytes(fromBase64(iv), await response.arrayBuffer());
      return new Blob([plain], { type: response.headers.get('x-mime') ?? 'application/octet-stream' });
    } catch {
      return null;
    }
  },

  async write(scope: string, key: string, bytes: ArrayBuffer, mimeType: string): Promise<void> {
    if (!cacheAvailable() || bytes.byteLength > MAX_ENTRY_BYTES) return;
    try {
      const sealed = await tgSessionVault.sealBytes(bytes);
      const cache = await caches.open(CACHE_NAME);
      await cache.put(requestUrl(scope, key), new Response(sealed.payload, {
        headers: { 'x-iv': toBase64(sealed.iv), 'x-mime': mimeType, 'x-saved-at': String(Date.now()) },
      }));
      this.schedulePrune();
    } catch {
      // 写入失败（配额不足等）只影响下次加载速度。
    }
  },

  /** 授权失效 / 移除账户时清除该账户的全部本机媒体。 */
  async removeScope(scope: string): Promise<void> {
    if (!cacheAvailable()) return;
    try {
      const cache = await caches.open(CACHE_NAME);
      const prefix = requestUrl(scope, '');
      const requests = await cache.keys();
      await Promise.all(requests.filter((request) => request.url.startsWith(prefix)).map((request) => cache.delete(request)));
    } catch { /* 无缓存可删 */ }
  },

  /** 清空本机全部 Telegram 媒体缓存（设置页手动操作）。 */
  async clearAll(): Promise<void> {
    if (!cacheAvailable()) return;
    try { await caches.delete(CACHE_NAME); } catch { /* 忽略 */ }
  },

  /** 统计条目数与占用字节（加密后大小），用于设置页展示。 */
  async usage(): Promise<{ entries: number; bytes: number } | null> {
    if (!cacheAvailable()) return null;
    try {
      const cache = await caches.open(CACHE_NAME);
      const requests = await cache.keys();
      let bytes = 0;
      for (const request of requests) {
        const response = await cache.match(request);
        if (response) bytes += (await response.blob()).size;
      }
      return { entries: requests.length, bytes };
    } catch {
      return null;
    }
  },

  /** 每次会话运行只在空闲后清理一次过期条目，避免与首屏加载争抢 I/O。 */
  schedulePrune() {
    if (pruneScheduled || !cacheAvailable()) return;
    pruneScheduled = true;
    window.setTimeout(() => { void prune(); }, PRUNE_DELAY_MS);
  },
};
