/** Thin bridge: all IndexedDB, JSON and encryption work runs in the local index Worker. */
import { tgSessionVault } from '@/stores/telegram/data-sources/tgSessionVault';
import type { AggregateSearchResultItem, SearchIndexCommand, SearchIndexCoverage, SearchIndexLookup, SearchIndexReply } from '@/worker/local/archive/searchContracts';
export type { SearchIndexCoverage } from '@/worker/local/archive/searchContracts';
let worker: Worker | undefined;
let ready: Promise<void> | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function fail() {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('本地搜索索引不可用')); }
  pending.clear(); worker?.terminate(); worker = undefined; ready = undefined;
}
function send<T>(command: SearchIndexCommand): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(fail, 30_000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    try { worker!.postMessage({ id, command }); } catch { fail(); }
  });
}
async function call<T>(command: SearchIndexCommand): Promise<T> {
  if (!ready) ready = (async () => {
    const key = await tgSessionVault.localEncryptionKey();
    worker = new Worker(new URL('../../../worker/local/archive/searchIndex.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<SearchIndexReply>) => {
      const item = pending.get(event.data.id);
      if (!item) return;
      pending.delete(event.data.id); clearTimeout(item.timer);
      if (event.data.error) item.reject(new Error(event.data.error)); else item.resolve(event.data.value);
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    await send<void>({ op: 'init', key });
  })().catch(error => { fail(); throw error; });
  await ready;
  return send<T>(command);
}
export const aggregateSearchIndex = {
  lookup(accountId: string, peerKey: string, queryKey: string) { return call<SearchIndexLookup>({ op: 'lookup', accountId, peerKey, queryKey }); },
  invalidate(accountId: string, peerKey: string, queryKey: string) { return call<void>({ op: 'invalidate', accountId, peerKey, queryKey }); },
  page(key: string) { return call<AggregateSearchResultItem[]>({ op: 'page', key }); },
  commit(accountId: string, peerKey: string, queryKey: string, items: AggregateSearchResultItem[], coverage: SearchIndexCoverage) {
    return call<void>({ op: 'commit', accountId, peerKey, queryKey, items, coverage });
  },
  remove(accountId: string) { return call<void>({ op: 'remove', accountId }); },
};
