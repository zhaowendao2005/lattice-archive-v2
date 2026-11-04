/** Store-domain orchestration. Telegram requests only use the existing business bus and scheduler. */
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { telegramBusClient } from '@/stores/telegram/data-sources/telegramBusClient';
import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';
import { classifyTelegramError } from '@/worker/local/chat/telegramErrors';
import { useSessionManagerStore } from './sessionManagerStore';
import { aggregateSearchIndex } from '../data-sources/aggregateSearchIndex';
import { candidateFilters, mapTgMessageToSearchResult, matchesSearchFilters, searchQueryKey } from '@/worker/local/archive/searchModel';
import type { SearchServerFilter } from '@/worker/local/archive/searchModel';
import type { AggregateSearchResultItem, SearchIndexCoverage, SearchIndexLookup, SearchPeerProgress, StreamingSearchChunk, StreamingSearchQuery } from '@/worker/local/archive/searchContracts';
import type { TgPeerKey, TgPeerRef } from '@/worker/local/chatProtocol';

type Peer = { key: TgPeerKey; peer: TgPeerRef; title: string; kind: 'joined' | 'credential_only' };
type Cursor = {
  id: string; peer: Peer; filter: SearchServerFilter; offsetId: number; phase: 'head' | 'cache' | 'history' | 'done';
  lookup: SearchIndexLookup; queryKey: string;
  pageIndex: number; pages: number; checked: number; matched: number; newestId: number; cacheAvailable: boolean;
  coverage: SearchIndexCoverage; failed: boolean; errorCode?: string;
};
type Page = { cursor: Cursor; items: AggregateSearchResultItem[]; error?: unknown; cache: boolean };
function log(action: string, tags: Record<string, string | number | boolean | undefined>, warning = false) {
  debugLoggerDataSource.emitFrontendLog({ domain: 'archive.search', action, level: warning ? 'WARN' : 'DEBUG', tags });
}

export async function* streamFocusedSearch(query: StreamingSearchQuery, signal: AbortSignal): AsyncGenerator<StreamingSearchChunk> {
  const chat = useChatStore();
  const accountId = chat.accountId;
  if (!accountId || !chat.isOnline) { log('focused_skipped', { reason: 'OFFLINE' }, true); throw new Error('Telegram 未连接，请连接后重试'); }
  const credentials = useSessionManagerStore().tempCredentials;
  const selected = new Set(query.scopeSessionIds.length ? query.scopeSessionIds : [...Object.keys(chat.dialogs), ...credentials.filter(item => item.accountId === accountId).map(item => item.peerKey)]);
  const peers: Peer[] = [];
  for (const key of selected) {
    const dialog = chat.dialogs[key];
    if (dialog) peers.push({ key: key as TgPeerKey, peer: dialog.peer, title: dialog.title, kind: 'joined' });
    else {
      const credential = credentials.find(item => item.peerKey === key && item.accountId === accountId);
      if (credential) peers.push({ key: key as TgPeerKey, peer: { type: credential.peerType, id: credential.peerId, accessHash: credential.accessHash }, title: credential.title, kind: 'credential_only' });
    }
  }
  // 每种可映射类型一个请求单元；无法映射的类别整体退回一次 all 请求。
  const filters = candidateFilters(query.preCategories);
  const useBroadFallback = filters.length === 1;
  log('focused_scope_resolved', { peerCount: peers.length, scopeCount: selected.size, filters: filters.join(','), extensionCount: query.preExtensions?.length ?? 0 });
  if (!peers.length) throw new Error('所选范围没有可搜索的会话，请重新选择范围');
  const active = () => !signal.aborted && chat.accountId === accountId;
  const broadQueryKey = searchQueryKey(query, 'all');
  const emitted = new Set<string>();
  let total = 0;

  const cursors: Cursor[] = [];
  const byPeer = new Map<string, Cursor[]>();
  for (const peer of peers) {
    const list = filters.map((filter): Cursor => ({
      id: `${peer.key}::${filter}`, peer, filter, offsetId: 0, phase: 'history',
      lookup: { scopeKey: '', pageKeys: [] }, queryKey: searchQueryKey(query, filter),
      pageIndex: 0, pages: 0, checked: 0, matched: 0, newestId: 0, cacheAvailable: true,
      coverage: { accountId, peerKey: peer.key, queryKey: searchQueryKey(query, filter), headMessageId: 0, complete: false, updatedAt: Date.now() },
      failed: false,
    }));
    cursors.push(...list);
    byPeer.set(peer.key, list);
  }

  /** 一个会话的进度是它全部类型单元的总和；任一单元失败即把该会话标为失败。 */
  const progressOf = (peerKey: string): SearchPeerProgress => {
    const list = byPeer.get(peerKey) ?? [];
    const failed = list.find(cursor => cursor.failed);
    const status: SearchPeerProgress['status'] = failed
      ? 'error'
      : list.every(cursor => cursor.phase === 'done') ? 'completed' : 'searching';
    return {
      accountId, peerKey, status,
      pages: list.reduce((n, cursor) => n + cursor.pages, 0),
      checked: list.reduce((n, cursor) => n + cursor.checked, 0),
      matched: list.reduce((n, cursor) => n + cursor.matched, 0),
      errorCode: failed?.errorCode,
    };
  };
  const chunk = (items: AggregateSearchResultItem[], cursor?: Cursor): StreamingSearchChunk => ({
    items, totalMatched: total, hasMore: true,
    peerProgress: cursor ? progressOf(cursor.peer.key) : undefined,
  });

  // One outstanding page per (peer × type) unit, with actual RPC admission exclusively owned by RequestScheduler.
  const pending = new Map<string, Promise<Page>>();
  const step = async (cursor: Cursor): Promise<Page> => {
    try {
      if (!active()) return { cursor, items: [], cache: false };
      if (cursor.phase === 'cache') {
        const key = cursor.lookup.pageKeys[cursor.pageIndex++];
        const items = key ? await aggregateSearchIndex.page(key) : [];
        if (cursor.pageIndex >= cursor.lookup.pageKeys.length) {
          cursor.phase = cursor.coverage.complete ? 'done' : 'history';
          cursor.offsetId = cursor.coverage.nextOffsetId ?? 0;
        }
        return { cursor, items, cache: true };
      }
      const offsetId = cursor.offsetId;
      const response = await telegramBusClient.search.searchMessages(accountId, {
        peer: cursor.peer.peer, query: query.keyword.trim(), filterType: cursor.filter,
        offsetId, minDate: query.minDate, maxDate: query.maxDate, limit: query.pageSize,
      }, { signal, source: 'archive.focused-search' });
      if (!active()) return { cursor, items: [], cache: false };
      cursor.pages++;
      const items = response.messages.map(message => mapTgMessageToSearchResult(message, cursor.peer.title, cursor.peer.kind, { accountId, peerRef: cursor.peer.peer })).sort((a, b) => (b.msgId ?? 0) - (a.msgId ?? 0));
      cursor.newestId = Math.max(cursor.newestId, ...items.map(item => item.msgId ?? 0));
      const next = response.nextOffsetId;
      if (response.hasMore && (!next || (offsetId > 0 && next >= offsetId))) throw new Error('SEARCH_CURSOR_STALLED');
      cursor.offsetId = next ?? offsetId;
      if (cursor.phase === 'head') {
        // Do not advance the saved head until the entire new region overlaps the old head.
        // Stopping halfway through refresh must never create a false complete checkpoint.
        if (!response.hasMore || (next !== undefined && next <= cursor.coverage.headMessageId)) {
          cursor.coverage.headMessageId = cursor.newestId;
          cursor.phase = cursor.lookup.pageKeys.length ? 'cache' : cursor.coverage.complete ? 'done' : 'history';
          cursor.offsetId = cursor.coverage.nextOffsetId ?? 0;
        }
      } else {
        cursor.coverage.headMessageId = cursor.newestId;
        cursor.coverage.nextOffsetId = next;
        cursor.coverage.updatedAt = Date.now();
        cursor.coverage.complete = !response.hasMore;
        if (!response.hasMore) cursor.phase = 'done';
      }
      if (active() && cursor.cacheAvailable) {
        try {
          await aggregateSearchIndex.commit(accountId, cursor.peer.key, cursor.queryKey, items, { ...cursor.coverage });
        } catch {
          cursor.cacheAvailable = false;
          log('focused_index_write_failed', { peerKey: cursor.peer.key, filter: cursor.filter }, true);
        }
      }
      log('focused_page_ok', { peerKey: cursor.peer.key, filter: cursor.filter, rawCount: items.length, hasMore: response.hasMore, nextOffsetId: next ?? 0 });
      return { cursor, items, cache: false };
    } catch (error) { return { cursor, items: [], error, cache: false }; }
  };
  const initialize = async (cursor: Cursor): Promise<Page> => {
    let lookup: SearchIndexLookup = { scopeKey: '', pageKeys: [] };
    let cacheAvailable = true;
    try {
      if (query.forceRefresh) await aggregateSearchIndex.invalidate(accountId, cursor.peer.key, cursor.queryKey);
      else lookup = await aggregateSearchIndex.lookup(accountId, cursor.peer.key, cursor.queryKey);
      if (!query.forceRefresh && !lookup.coverage && cursor.filter !== 'all' && useBroadFallback) {
        const broad = await aggregateSearchIndex.lookup(accountId, cursor.peer.key, broadQueryKey);
        if (broad.coverage?.complete) { lookup = broad; cursor.filter = 'all'; cursor.queryKey = broadQueryKey; }
      }
    } catch { cacheAvailable = false; log('focused_index_read_failed', { peerKey: cursor.peer.key, filter: cursor.filter }, true); }
    cursor.lookup = lookup;
    cursor.cacheAvailable = cacheAvailable;
    cursor.phase = lookup.coverage?.headMessageId ? 'head' : 'history';
    cursor.newestId = lookup.coverage?.headMessageId ?? 0;
    cursor.coverage = lookup.coverage
      ? { ...lookup.coverage }
      : { accountId, peerKey: cursor.peer.key, queryKey: cursor.queryKey, headMessageId: 0, complete: false, updatedAt: Date.now() };
    log('focused_cache_lookup', { peerKey: cursor.peer.key, filter: cursor.filter, hit: Boolean(lookup.coverage), complete: lookup.coverage?.complete ?? false, cachedPages: lookup.pageKeys.length, headProbe: Boolean(lookup.coverage?.headMessageId) });
    return step(cursor);
  };
  for (const peer of peers) {
    if (!active()) return;
    yield { ...chunk([]), peerProgress: { accountId, peerKey: peer.key, status: 'queued', pages: 0, checked: 0, matched: 0 } };
    for (const cursor of byPeer.get(peer.key) ?? []) pending.set(cursor.id, initialize(cursor));
  }
  while (pending.size && active()) {
    const page = await Promise.race(pending.values());
    if (!active()) return;
    const cursor = page.cursor;
    pending.delete(cursor.id);
    if (page.error) {
      cursor.failed = true;
      const info = classifyTelegramError(page.error);
      cursor.errorCode = info.code;
      log('focused_peer_error', { peerKey: cursor.peer.key, filter: cursor.filter, bucket: info.bucket, code: info.code }, true);
      yield { ...chunk([], cursor), peerProgress: progressOf(cursor.peer.key) };
      continue;
    }
    cursor.checked += page.items.length;
    const visible = page.items.filter(item => {
      if (emitted.has(item.id) || !matchesSearchFilters(item, query)) return false;
      emitted.add(item.id); return true;
    });
    cursor.matched += visible.length;
    total += visible.length;
    log('focused_page_filtered', { peerKey: cursor.peer.key, filter: cursor.filter, candidateCount: page.items.length, visibleCount: visible.length, cache: page.cache });
    yield chunk(visible, cursor);
    if (cursor.phase !== 'done' && active()) pending.set(cursor.id, step(cursor));
    // Let paint/input/stop events run even during a large cached replay.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (active()) yield { ...chunk([]), hasMore: false };
}
