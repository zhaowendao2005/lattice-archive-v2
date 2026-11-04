import { SearchIndexRepository } from './searchIndexRepository';
import type { SearchIndexRequest, SearchIndexReply } from './searchContracts';
let repository: SearchIndexRepository | undefined;
// Serialize mutations so pages and coverage cannot race across rapid stop/restart cycles.
let chain = Promise.resolve();
self.onmessage = (event: MessageEvent<SearchIndexRequest>) => {
  const { id, command } = event.data;
  chain = chain.then(async () => {
    try {
      let value: unknown;
      if (command.op === 'init') repository = new SearchIndexRepository(command.key);
      else {
        if (!repository) throw new Error('INDEX_NOT_INITIALIZED');
        switch (command.op) {
          case 'lookup': value = await repository.lookup(command.accountId, command.peerKey, command.queryKey); break;
          case 'invalidate': await repository.invalidate(command.accountId, command.peerKey, command.queryKey); break;
          case 'page': value = await repository.page(command.key); break;
          case 'commit': await repository.commit(command.accountId, command.peerKey, command.queryKey, command.items, command.coverage); break;
          case 'remove': await repository.remove(command.accountId); break;
        }
      }
      self.postMessage({ id, value } satisfies SearchIndexReply);
    } catch {
      self.postMessage({ id, error: '本地搜索索引不可用' } satisfies SearchIndexReply);
    }
  });
};
