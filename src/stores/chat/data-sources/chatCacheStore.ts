/**
 * [DATA SOURCE] 聊天冷启动缓存
 *
 * - 每个 Telegram 账户一份裁剪后的快照，使用本机不可导出的 AES-GCM 设备密钥加密后写入 IndexedDB；
 * - 只服务启动提速，不是完整历史副本；读取失败（损坏 / 版本不符 / 密钥丢失）一律视为无缓存；
 * - 数据仅存在本设备，不进入 D1 或任何远端。
 */
import { tgSessionVault } from '@/stores/telegram/data-sources/tgSessionVault';
import type { ChatCacheSnapshot } from '../types';

const DB_NAME = 'lattice-telegram-chat-cache';
const STORE_NAME = 'snapshots';
/** key = `${Lattice 用户}:${Telegram 账户}`：同一浏览器的不同 Lattice 用户互相读不到对方的缓存。 */
interface CacheRecord { key: string; savedAt: number; iv: ArrayBuffer; payload: ArrayBuffer }
const recordKey = (ownerId: string, accountId: string) => `${ownerId}:${accountId}`;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = operation(database.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export const chatCacheStore = {
  async read(ownerId: string, accountId: string): Promise<ChatCacheSnapshot | null> {
    try {
      const record = await run<CacheRecord | undefined>('readonly', (store) => store.get(recordKey(ownerId, accountId)));
      if (!record) return null;
      const snapshot = await tgSessionVault.open<ChatCacheSnapshot>(record);
      return snapshot.version === 2 && snapshot.ownerId === ownerId && snapshot.accountId === accountId ? snapshot : null;
    } catch {
      return null;
    }
  },

  async write(snapshot: ChatCacheSnapshot): Promise<void> {
    try {
      const sealed = await tgSessionVault.seal(snapshot);
      await run('readwrite', (store) => store.put({ key: recordKey(snapshot.ownerId, snapshot.accountId), savedAt: snapshot.savedAt, ...sealed } satisfies CacheRecord));
    } catch {
      // 缓存写入失败只影响下次冷启动速度，不能打断在线浏览。
    }
  },

  async remove(ownerId: string, accountId: string): Promise<void> {
    try { await run('readwrite', (store) => store.delete(recordKey(ownerId, accountId))); } catch { /* 无缓存可删 */ }
  },
};
