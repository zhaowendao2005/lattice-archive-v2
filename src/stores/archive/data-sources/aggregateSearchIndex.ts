import { tgSessionVault } from '@/stores/telegram/data-sources/tgSessionVault';
import type { AggregateSearchResultItem } from '../types';

const DB_NAME = 'lattice-aggregate-search-index';
const STORE_NAME = 'snapshots';
const VERSION = 1;

export interface SearchIndexCoverage {
  peerKey: string;
  accountId: string;
  queryKey: string;
  minDate?: number;
  maxDate?: number;
  /** The oldest history position that has been committed for this peer. */
  oldestDate?: number;
  oldestMessageId?: number;
  nextOffsetId?: number;
  complete: boolean;
  updatedAt: number;
}

export interface SearchIndexSnapshot {
  version: 1;
  accountId: string;
  savedAt: number;
  records: AggregateSearchResultItem[];
  coverage: SearchIndexCoverage[];
}

interface EncryptedRecord {
  key: string;
  iv: ArrayBuffer;
  payload: ArrayBuffer;
}

const keyOf = (accountId: string) => `account:${accountId}`;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRecord(accountId: string): Promise<EncryptedRecord | undefined> {
  const database = await openDb();
  try {
    return await new Promise<EncryptedRecord | undefined>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(keyOf(accountId));
      request.onsuccess = () => resolve(request.result as EncryptedRecord | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function writeRecord(_accountId: string, record: EncryptedRecord): Promise<void> {
  const database = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

function mergeRecords(previous: AggregateSearchResultItem[], next: AggregateSearchResultItem[]) {
  const byId = new Map(previous.map((item) => [item.id, item]));
  for (const item of next) byId.set(item.id, item);
  return Array.from(byId.values());
}

function mergeCoverage(previous: SearchIndexCoverage[], next: SearchIndexCoverage[]) {
  const byKey = new Map(previous.map((item) => [`${item.accountId}:${item.peerKey}:${item.queryKey}`, item]));
  for (const item of next) {
    const key = `${item.accountId}:${item.peerKey}:${item.queryKey}`;
    const old = byKey.get(key);
    byKey.set(key, old && old.updatedAt > item.updatedAt ? old : item);
  }
  return Array.from(byKey.values());
}

export const aggregateSearchIndex = {
  async read(accountId: string): Promise<SearchIndexSnapshot> {
    try {
      const record = await readRecord(accountId);
      if (!record) return { version: 1, accountId, savedAt: 0, records: [], coverage: [] };
      const snapshot = await tgSessionVault.open<SearchIndexSnapshot>(record);
      if (snapshot.version !== 1 || snapshot.accountId !== accountId) {
        return { version: 1, accountId, savedAt: 0, records: [], coverage: [] };
      }
      return snapshot;
    } catch {
      return { version: 1, accountId, savedAt: 0, records: [], coverage: [] };
    }
  },

  async commit(
    accountId: string,
    records: AggregateSearchResultItem[],
    coverage: SearchIndexCoverage[],
  ): Promise<void> {
    const previous = await this.read(accountId);
    const snapshot: SearchIndexSnapshot = {
      version: 1,
      accountId,
      savedAt: Date.now(),
      records: mergeRecords(previous.records, records),
      coverage: mergeCoverage(previous.coverage, coverage),
    };
    const sealed = await tgSessionVault.seal(snapshot);
    await writeRecord(accountId, { key: keyOf(accountId), ...sealed });
  },

  findCoverage(snapshot: SearchIndexSnapshot, accountId: string, peerKey: string, queryKey: string) {
    return snapshot.coverage.find((item) =>
      item.accountId === accountId && item.peerKey === peerKey && item.queryKey === queryKey,
    );
  },

  async remove(accountId: string): Promise<void> {
    const database = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(keyOf(accountId));
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  },
};
