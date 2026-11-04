import type { AggregateSearchResultItem, SearchIndexCoverage, SearchIndexLookup } from './searchContracts';

export const SEARCH_CACHE_FRESH_MS = 5 * 60_000;
const RETAIN_MS = 7 * 24 * 60 * 60_000;
const MAX_PAGES = 4096;
const MAX_BYTES = 64 * 1024 * 1024;
interface Sealed { iv: ArrayBuffer; payload: ArrayBuffer }
interface PageRow extends Sealed { key: string; scopeKey: string; accountKey: string; savedAt: number; bytes: number }
interface HeadRow extends Sealed { key: string; accountKey: string; invalid?: boolean }
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('INDEX_TRANSACTION_ABORTED'));
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
/** Only encrypted, bounded pages live on disk. Message data and checkpoint commit atomically. */
export class SearchIndexRepository {
  private database?: Promise<IDBDatabase>;
  private writes = 0;
  private readonly encryptionKey: CryptoKey;
  constructor(encryptionKey: CryptoKey) { this.encryptionKey = encryptionKey; }
  private db() {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lattice-aggregate-search-index', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        // The v1 derived snapshot is intentionally discarded, never dual-read or migrated as truth.
        if (db.objectStoreNames.contains('snapshots')) db.deleteObjectStore('snapshots');
        const pages = db.createObjectStore('pages', { keyPath: 'key' });
        pages.createIndex('scope', 'scopeKey');
        pages.createIndex('account', 'accountKey');
        pages.createIndex('age', 'savedAt');
        pages.createIndex('bytes', 'bytes');
        const heads = db.createObjectStore('heads', { keyPath: 'key' });
        heads.createIndex('account', 'accountKey');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); this.database = undefined; };
        resolve(request.result);
      };
      request.onerror = () => { this.database = undefined; reject(request.error); };
    });
  }
  private async hash(text: string) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join('');
  }
  private async seal(value: unknown): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return { iv: iv.buffer, payload: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.encryptionKey, new TextEncoder().encode(JSON.stringify(value))) };
  }
  private async open<T>(value: Sealed): Promise<T> {
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: value.iv }, this.encryptionKey, value.payload))) as T;
  }
  async lookup(accountId: string, peerKey: string, queryKey: string): Promise<SearchIndexLookup> {
    const scopeKey = await this.hash(JSON.stringify([accountId, peerKey, queryKey]));
    const db = await this.db();
    const tx = db.transaction(['heads', 'pages']);
    const [head, pageKeys] = await Promise.all([
      result(tx.objectStore('heads').get(scopeKey)) as Promise<HeadRow | undefined>,
      result(tx.objectStore('pages').index('scope').getAllKeys(scopeKey)) as Promise<string[]>,
    ]);
    if (!head || head.invalid) { await this.dropScope(scopeKey); return { scopeKey, pageKeys: [] }; }
    let coverage: SearchIndexCoverage;
    try { coverage = await this.open<SearchIndexCoverage>(head); }
    catch { await this.dropScope(scopeKey); return { scopeKey, pageKeys: [] }; }
    if (Date.now() - coverage.updatedAt > SEARCH_CACHE_FRESH_MS) {
      await this.dropScope(scopeKey);
      return { scopeKey, pageKeys: [] };
    }
    if (coverage.headMessageId > 0 && !pageKeys.length) {
      await this.dropScope(scopeKey);
      return { scopeKey, pageKeys: [] };
    }
    // Only keys are read here; large encrypted payloads are read one page at a time.
    pageKeys.sort((a, b) => Number(b.slice(scopeKey.length + 1)) - Number(a.slice(scopeKey.length + 1)));
    return { scopeKey, coverage, pageKeys };
  }
  async invalidate(accountId: string, peerKey: string, queryKey: string): Promise<void> {
    await this.dropScope(await this.hash(JSON.stringify([accountId, peerKey, queryKey])));
  }
  async page(key: string): Promise<AggregateSearchResultItem[]> {
    const db = await this.db();
    const row = await result(db.transaction('pages').objectStore('pages').get(key)) as PageRow | undefined;
    // A concurrent eviction must not turn a missing page into an apparently complete scan.
    if (!row) throw new Error('INDEX_PAGE_EVICTED');
    return this.open<AggregateSearchResultItem[]>(row);
  }
  async commit(accountId: string, peerKey: string, queryKey: string, items: AggregateSearchResultItem[], coverage: SearchIndexCoverage): Promise<void> {
    const scopeKey = await this.hash(JSON.stringify([accountId, peerKey, queryKey]));
    const accountKey = await this.hash(accountId);
    const [page, head] = await Promise.all([this.seal(items), this.seal(coverage)]);
    const newestId = Math.max(0, ...items.map(item => item.msgId ?? 0));
    const db = await this.db();
    const tx = db.transaction(['pages', 'heads'], 'readwrite');
    const completion = done(tx);
    if (items.length) tx.objectStore('pages').put({ ...page, key: `${scopeKey}:${newestId}`, scopeKey, accountKey, savedAt: Date.now(), bytes: page.payload.byteLength + page.iv.byteLength } satisfies PageRow);
    const heads = tx.objectStore('heads');
    const current = heads.get(scopeKey);
    current.onsuccess = () => {
      // An active scan must not recreate a complete head after quota eviction removed its earlier pages.
      if (!(current.result as HeadRow | undefined)?.invalid) heads.put({ ...head, key: scopeKey, accountKey } satisfies HeadRow);
    };
    await completion;
    if (++this.writes % 32 === 0) await this.prune();
  }
  private async dropScope(scopeKey: string) {
    const db = await this.db();
    const tx = db.transaction(['pages', 'heads'], 'readwrite');
    const completion = done(tx);
    tx.objectStore('heads').delete(scopeKey);
    const cursor = tx.objectStore('pages').index('scope').openCursor(scopeKey);
    cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
    await completion;
  }
  private async prune() {
    const db = await this.db();
    const count = await result(db.transaction('pages').objectStore('pages').count());
    let excess = count - MAX_PAGES;
    let totalBytes = 0;
    await new Promise<void>((resolve, reject) => {
      const keys = db.transaction('pages').objectStore('pages').index('bytes').openKeyCursor();
      keys.onsuccess = () => { const item = keys.result; if (!item) resolve(); else { totalBytes += Number(item.key); item.continue(); } };
      keys.onerror = () => reject(keys.error);
    });
    const tx = db.transaction(['pages', 'heads'], 'readwrite');
    const completion = done(tx);
    const cursor = tx.objectStore('pages').index('age').openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      const row = item.value as PageRow;
      if (excess-- > 0 || totalBytes > MAX_BYTES || Date.now() - row.savedAt > RETAIN_MS) {
        totalBytes -= row.bytes;
        item.delete();
        tx.objectStore('heads').put({ key: row.scopeKey, accountKey: row.accountKey, iv: new ArrayBuffer(0), payload: new ArrayBuffer(0), invalid: true } satisfies HeadRow);
        item.continue();
      }
    };
    await completion;
  }
  async remove(accountId: string): Promise<void> {
    const accountKey = await this.hash(accountId);
    const db = await this.db();
    const tx = db.transaction(['pages', 'heads'], 'readwrite');
    const completion = done(tx);
    for (const store of ['pages', 'heads']) {
      const cursor = tx.objectStore(store).index('account').openCursor(accountKey);
      cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
    }
    await completion;
  }
}
