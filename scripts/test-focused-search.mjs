/** Offline regression suite: real search model/orchestrator + encrypted IndexedDB repository. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'lattice-search-tests-'));
const ts = createRequire(import.meta.url)('typescript');
globalThis.indexedDB = indexedDB;
function compile(source, file) {
  writeFileSync(join(out, file), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const load = file => import(pathToFileURL(join(out, file)).href);
const get = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const completed = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
const item = (id, size = 10_000_000) => ({ id: `tg-channel-1-${id}`, msgId: id, category: 'video', extension: 'mp4', sizeBytes: size, sessionId: 'channel-1', title: 'different server-matched title', snippet: 'not a substring match', dateSeconds: id });
const message = (peerKey, id) => ({ id, peerKey, text: 'caption', date: id, media: { video: { size: 10_000_000, fileName: 'clip.mp4', mimeType: 'video/mp4', duration: 30 } } });
const query = (overrides = {}) => ({ keyword: 'server query', preCategories: ['video'], scopeSessionIds: [], pageSize: 50, ...overrides });
try {
  compile(readFileSync(join(root, 'src/worker/local/archive/searchModel.ts'), 'utf8'), 'model.mjs');
  compile(readFileSync(join(root, 'src/worker/local/archive/searchIndexRepository.ts'), 'utf8'), 'repository.mjs');
  const model = await load('model.mjs');
  for (const raw of ['', '  ']) assert.equal(model.parseSearchSize(raw), undefined);
  assert.equal(model.parseSearchSize(0), 0);
  assert.equal(model.parseSearchSize(1.5), 1.5 * 1024 * 1024);
  assert.equal(model.parseSearchSize('2'), 2 * 1024 * 1024);
  for (const raw of [-1, 'bad', Infinity, 1e30]) assert.throws(() => model.parseSearchSize(raw));
  assert.equal(model.matchesSearchFilters(item(1), query()), true, 'blank limits must not suppress videos');
  assert.equal(model.matchesSearchFilters(item(1), query({ preExtensions: ['mkv'] })), false);
  assert.equal(model.matchesSearchFilters(item(1), query({ keyword: 'entirely different words' })), true, 'never reapply substring matching to server results');
  assert.deepEqual(model.candidateFilters([]), ['all']);
  assert.deepEqual(model.candidateFilters(['video']), ['video']);
  assert.deepEqual(model.candidateFilters(['video', 'image']), ['video', 'photo'], 'multi-select splits into one server request per mappable type');
  assert.deepEqual(model.candidateFilters(['video', 'other']), ['all'], 'unmappable categories fall back to a single all request');
  assert.equal(model.searchQueryKey(query({ preExtensions: ['zip'] }), 'video'), model.searchQueryKey(query(), 'video'), 'extensions stay local and never change the server query key');
  assert.notEqual(model.searchQueryKey(query(), 'video'), model.searchQueryKey(query(), 'photo'), 'each server filter keeps its own cache key');
  assert.notEqual(model.searchQueryKey(query(), 'video'), model.searchQueryKey(query({ keyword: 'other' }), 'video'));
  for (const count of [0, 1000, 10000, 50000]) {
    for (const top of [0, 1000, 1e9]) {
      const window = model.searchWindow(count, top, 600);
      assert.ok(window.start >= 0 && window.end <= count);
      assert.ok(window.end - window.start <= Math.ceil(600 / model.SEARCH_ROW_HEIGHT) + model.SEARCH_OVERSCAN * 2);
    }
  }
  const scopeSessions = Array.from({ length: 5000 }, (_, i) => ({ kind: i % 7 === 0 ? 'credential_only' : 'joined', expiresLabel: i % 14 === 0 ? 'x' : undefined }));
  const offsets = [0];
  for (const session of scopeSessions) offsets.push(offsets[offsets.length - 1] + model.scopeRowHeight(session));
  for (const top of [0, 4321, offsets[offsets.length - 1]]) {
    const window = model.variableWindow(offsets, top, 600);
    assert.ok(window.start >= 0 && window.end <= scopeSessions.length && window.start <= window.end);
    assert.equal(window.paddingTop, offsets[window.start]);
    assert.equal(window.paddingTop + offsets[window.end] - offsets[window.start] + window.paddingBottom, offsets[scopeSessions.length], 'padding plus rendered rows covers the whole list');
    assert.ok(offsets[window.start] <= top || window.start === 0, 'window starts at or before the viewport');
  }
  const unknownPhoto = model.mapTgMessageToSearchResult({ ...message('channel-1', 1), media: { photo: { full: { width: 1, height: 1 } } } }, 'title', 'joined');
  assert.equal(unknownPhoto.sizeBytes, undefined, 'never invent a photo size');
  const projection = new model.SearchResultProjection();
  const filters = { categories: [], keyword: 'title', resolution: 'all', duration: 'all', excludeProtected: false, deduplicate: true };
  const appendOnly = [];
  let titleReads = 0;
  for (let batch = 0; batch < 100; batch++) {
    for (let i = 0; i < 50; i++) appendOnly.push({ ...item(batch * 50 + i), get title() { titleReads++; return 'title'; } });
    assert.equal(projection.update(appendOnly, filters).length, appendOnly.length);
  }
  assert.equal(titleReads, 5000, 'historical result predicates must not be re-evaluated on append');
  assert.equal(projection.update(appendOnly, { ...filters, keyword: 'missing' }).length, 0);
  assert.equal(projection.update([item(1)], { ...filters, keyword: '' }).length, 1);
  // Exact size is a post-search condition: it only constrains video/image and never touches other types.
  const postBase = { categories: [], keyword: '', resolution: 'all', duration: 'all', excludeProtected: false, deduplicate: false };
  const sized = (category, sizeBytes) => ({ ...item(1), id: `${category}-${sizeBytes}`, category, sizeBytes });
  const sizedResults = [
    sized('video', 10 * 1024 * 1024),
    sized('image', 200 * 1024 * 1024),
    sized('text', 200 * 1024 * 1024),
    sized('video', undefined),
  ];
  const sizeBounded = new model.SearchResultProjection().update(sizedResults, { ...postBase, minSizeBytes: 50 * 1024 * 1024, maxSizeBytes: 500 * 1024 * 1024 });
  assert.deepEqual(sizeBounded.map(result => result.id), ['image-209715200', 'text-209715200'], 'exact size skips out-of-range video, excludes unknown-size video and leaves text untouched');
  assert.equal(new model.SearchResultProjection().update(sizedResults, postBase).length, 4, 'blank size bounds never filter results');
  compile(readFileSync(join(root, 'src/stores/archive/data-sources/searchResultGestureDataSource.ts'), 'utf8'), 'gestures.mjs');
  const { searchResultGestureDataSource: gestures } = await load('gestures.mjs');
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const pointer = (type, x = 10) => Object.assign(new Event(type), { clientX: x, clientY: 10, button: 0 });
  let started = 0; let finished = 0; let cancelled = 0;
  const callbacks = { start: () => started++, move() {}, finish: () => finished++, cancel: () => cancelled++ };
  gestures.begin('row', pointer('pointerdown'), callbacks);
  window.dispatchEvent(pointer('pointermove', 20));
  window.dispatchEvent(pointer('pointerup', 20));
  assert.equal(started, 1); assert.equal(finished, 1);
  assert.equal(gestures.consumeClick('row'), true, 'drag completion must not also toggle selection');
  gestures.begin('row', pointer('pointerdown'), callbacks);
  window.dispatchEvent(pointer('pointermove', 20));
  gestures.release('row');
  window.dispatchEvent(pointer('pointerup', 20));
  assert.equal(cancelled, 1, 'unmounting a virtual row must clean up an active gesture');
  assert.equal(finished, 1);
  globalThis.window = originalWindow;
  // Cover bus: a viewport-cancelled task must leave the queue and never occupy a slot.
  let coverSource = readFileSync(join(root, 'src/stores/app/data-sources/coverImageBus.ts'), 'utf8');
  coverSource = coverSource
    .replace(/import \{ debugLoggerDataSource \} from '[^']+';/, 'const debugLoggerDataSource = { emitFrontendLog() {} };')
    .replace(/import \{ classifyTelegramError \} from '[^']+';/, "const classifyTelegramError = (e) => ({ bucket: 'UNKNOWN', code: e?.message ?? 'ERR', retryable: false, description: '' });")
    .replace(/import \{ telegramPerformancePreferences \} from '[^']+';/, 'const telegramPerformancePreferences = { read: () => globalThis.coverBusConfig, subscribe() {} };')
    .replace(/import type [^;]+;/g, '');
  compile(coverSource, 'coverbus.mjs');
  globalThis.coverBusConfig = { limits: { cover: 1, avatar: 1, searchCoverReserved: 1 } };
  const { coverImageBus } = await load('coverbus.mjs');
  let fetches = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = coverImageBus.request({ key: 'cover-k1', lane: 'search', fetch: async () => { fetches++; await firstGate; return 1; } });
  const queuedController = new AbortController();
  let queuedRan = false;
  const queued = coverImageBus.request({ key: 'cover-k2', lane: 'search', signal: queuedController.signal, fetch: async () => { queuedRan = true; return 2; } });
  queuedController.abort();
  await assert.rejects(queued, /已取消/);
  releaseFirst();
  assert.equal(await first, 1);
  assert.equal(await coverImageBus.request({ key: 'cover-k2', lane: 'search', fetch: async () => { fetches++; return 2; } }), 2, 're-entering the viewport creates a fresh task after cancellation');
  assert.equal(fetches, 2);
  assert.equal(queuedRan, false, 'an aborted queued task never executes its fetch');
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(coverImageBus.request({ key: 'cover-k3', lane: 'search', signal: preAborted.signal, fetch: async () => { fetches++; return 3; } }));
  assert.equal(fetches, 2, 'an already-aborted signal never enqueues work');
  delete globalThis.coverBusConfig;
  console.log('✓ filter normalization, server-match semantics, unknown sizes, incremental projections and bounded virtual windows');

  // The real encrypted repository upgrades away from the legacy derived snapshot.
  const legacyOpen = indexedDB.open('lattice-aggregate-search-index', 1);
  legacyOpen.onupgradeneeded = () => legacyOpen.result.createObjectStore('snapshots');
  const legacy = await get(legacyOpen); legacy.close();
  const { SearchIndexRepository, SEARCH_CACHE_FRESH_MS } = await load('repository.mjs');
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const repository = new SearchIndexRepository(key);
  const qk = model.searchQueryKey(query(), 'video');
  const coverage = { accountId: 'a', peerKey: 'channel-1', queryKey: qk, complete: true, headMessageId: 10, updatedAt: Date.now(), nextOffsetId: 1 };
  await repository.commit('a', 'channel-1', qk, [item(10)], coverage);
  let lookup = await repository.lookup('a', 'channel-1', qk);
  assert.equal(lookup.coverage.complete, true);
  assert.deepEqual(await repository.page(lookup.pageKeys[0]), [item(10)]);
  assert.equal((await repository.lookup('b', 'channel-1', qk)).coverage, undefined);
  assert.equal((await repository.lookup('a', 'channel-2', qk)).coverage, undefined);
  const db = await get(indexedDB.open('lattice-aggregate-search-index', 2));
  assert.equal(db.objectStoreNames.contains('snapshots'), false);
  const sealed = await get(db.transaction('pages').objectStore('pages').get(lookup.pageKeys[0]));
  assert.ok(sealed.payload instanceof ArrayBuffer);
  assert.equal(JSON.stringify(sealed).includes('different server-matched title'), false);
  assert.equal(sealed.key.includes('server query'), false, 'lookup keys must not expose keywords');
  await repository.commit('a', 'channel-1', qk, [item(9)], { ...coverage, complete: false, nextOffsetId: 9 });
  lookup = await repository.lookup('a', 'channel-1', qk);
  assert.equal(lookup.pageKeys.length, 2, 'commits append pages rather than rewriting snapshots');

  // Abort a transaction after its page put: coverage and page must both roll back.
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(...args) {
    const request = originalPut.apply(this, args);
    if (this.name === 'heads') this.transaction.abort();
    return request;
  };
  try { await assert.rejects(repository.commit('a', 'channel-1', qk, [item(8)], { ...coverage, nextOffsetId: 8 })); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  lookup = await repository.lookup('a', 'channel-1', qk);
  assert.equal(lookup.pageKeys.length, 2);
  assert.equal(lookup.coverage.nextOffsetId, 9);
  const realNow = Date.now;
  Date.now = () => realNow() + SEARCH_CACHE_FRESH_MS + 1000;
  try { assert.equal((await repository.lookup('a', 'channel-1', qk)).coverage, undefined); }
  finally { Date.now = realNow; }
  assert.equal(await get(db.transaction('pages').objectStore('pages').count()), 0, 'expired coverage cannot leave stale pages for a new scan');
  await repository.commit('a', 'channel-1', qk, [item(10)], coverage);
  await repository.remove('a');
  assert.equal((await repository.lookup('a', 'channel-1', qk)).coverage, undefined);
  // Verify both byte and page-count governance using real IDB metadata, without large allocations.
  await repository.commit('a', 'channel-1', qk, [item(10)], coverage);
  lookup = await repository.lookup('a', 'channel-1', qk);
  const template = await get(db.transaction('pages').objectStore('pages').get(lookup.pageKeys[0]));
  let tx = db.transaction('pages', 'readwrite');
  let completion = completed(tx);
  for (let i = 0; i < 4100; i++) tx.objectStore('pages').put({ ...template, key: `quota-${i}`, savedAt: Date.now() - 1000, bytes: 1 });
  await completion;
  await repository.prune();
  assert.ok(await get(db.transaction('pages').objectStore('pages').count()) <= 4096);
  await repository.commit('a', 'channel-1', qk, [item(11)], { ...coverage, headMessageId: 11 });
  assert.equal((await repository.lookup('a', 'channel-1', qk)).coverage, undefined, 'eviction must invalidate coverage, never silently claim completeness');
  await repository.commit('a', 'channel-1', qk, [item(10)], coverage);
  lookup = await repository.lookup('a', 'channel-1', qk);
  tx = db.transaction('pages', 'readwrite'); completion = completed(tx);
  tx.objectStore('pages').put({ ...template, key: lookup.pageKeys[0], savedAt: Date.now(), bytes: 70 * 1024 * 1024 });
  await completion;
  await repository.prune();
  assert.equal((await repository.lookup('a', 'channel-1', qk)).coverage, undefined);
  console.log('✓ encrypted page index, legacy removal, isolation, atomic rollback, expiry, byte/page quotas and eviction invalidation');

  // Compile the actual orchestration with only transport/storage edges replaced by controlled fakes.
  writeFileSync(join(out, 'harness.mjs'), `
    export const useChatStore = () => globalThis.searchHarness.chat;
    export const useSessionManagerStore = () => ({ tempCredentials: globalThis.searchHarness.credentials ?? [] });
    export const telegramBusClient = { search: { searchMessages: (...args) => globalThis.searchHarness.request(...args) } };
    export const debugLoggerDataSource = { emitFrontendLog: log => globalThis.searchHarness.logs.push(log) };
    export const classifyTelegramError = error => ({ bucket: 'UNKNOWN', code: error.message ?? 'ERROR' });
    export const aggregateSearchIndex = { lookup: (...args) => globalThis.searchHarness.index.lookup(...args), page: (...args) => globalThis.searchHarness.index.page(...args), commit: (...args) => globalThis.searchHarness.index.commit(...args), invalidate: (...args) => globalThis.searchHarness.index.invalidate(...args) };
  `);
  let orchestration = readFileSync(join(root, 'src/stores/archive/stores/focusedSearch.ts'), 'utf8');
  orchestration = orchestration.replace(/from ['"][^'"]+['"]/g, match => match.includes('/searchModel') ? "from './model.mjs'" : "from './harness.mjs'");
  compile(orchestration, 'orchestration.mjs');
  const { streamFocusedSearch } = await load('orchestration.mjs');
  function scenario(peers = ['channel-1']) {
    const state = {
      chat: { accountId: 'a', isOnline: true, dialogs: Object.fromEntries(peers.map(key => [key, { peer: { type: 'channel', id: key.split('-')[1] }, title: key }])) },
      logs: [], calls: [], commits: [],
      index: { invalidate: async () => {}, lookup: async () => ({ scopeKey: 'scope', pageKeys: [] }), page: async () => [], commit: async (...args) => state.commits.push(structuredClone(args)) },
      request: async (_accountId, input, options) => {
        state.calls.push({ input, options });
        return { messages: input.offsetId === 0 ? [message('channel-1', 10)] : [], hasMore: input.offsetId === 0, nextOffsetId: input.offsetId === 0 ? 10 : undefined };
      },
    };
    globalThis.searchHarness = state; return state;
  }
  const collect = async (q, signal = new AbortController().signal) => { const chunks = []; for await (const chunk of streamFocusedSearch(q, signal)) chunks.push(chunk); return chunks; };
  let state = scenario();
  let chunks = await collect(query());
  assert.equal(chunks.flatMap(chunk => chunk.items).length, 1);
  assert.equal(state.calls.length, 2, 'continue a short nonempty page until the server is empty');
  assert.equal(state.calls[0].input.filterType, 'video');
  assert.ok(state.calls[0].options.signal);
  assert.equal(state.commits.at(-1)[4].complete, true);

  // Multi-select types are split into one server-filtered request unit each, then merged and deduplicated.
  state = scenario();
  chunks = await collect(query({ preCategories: ['video', 'image'] }));
  assert.deepEqual([...new Set(state.calls.map(call => call.input.filterType))].sort(), ['photo', 'video'], 'each selected type issues its own server-filtered search');
  assert.equal(chunks.flatMap(chunk => chunk.items).length, 1, 'the same message returned by two type requests is emitted once');
  assert.ok(chunks.some(chunk => chunk.peerProgress?.status === 'completed'), 'peer progress completes only after every type unit finishes');

  // Complete cache still probes the newest region, then replays cache in per-peer descending order.
  state = scenario();
  state.index.lookup = async () => ({ scopeKey: 'scope', pageKeys: ['cached'], coverage: { ...coverage } });
  state.index.page = async () => [item(10), item(9)];
  state.request = async (_a, input) => { state.calls.push(input); return { messages: [message('channel-1', 12), message('channel-1', 10)], hasMore: true, nextOffsetId: 10 }; };
  chunks = await collect(query());
  assert.equal(state.calls.length, 1, 'head overlap should reuse completed history');
  assert.deepEqual(chunks.flatMap(chunk => chunk.items).map(item => item.msgId), [12, 10, 9]);
  assert.ok(state.logs.some(log => log.action === 'focused_cache_lookup' && log.tags.headProbe));

  state = scenario();
  let invalidations = 0;
  state.index.invalidate = async () => { invalidations++; };
  state.index.lookup = async () => { throw new Error('forced refresh must not read cache'); };
  await collect(query({ forceRefresh: true }));
  assert.equal(invalidations, 1);
  assert.equal(state.calls.length, 2);

  // Account switch invalidates pending responses before commit and before emitting items.
  state = scenario();
  let finishOld;
  state.request = () => new Promise(resolve => { finishOld = resolve; });
  const oldRun = streamFocusedSearch(query(), new AbortController().signal);
  await oldRun.next();
  const oldResult = oldRun.next();
  while (!finishOld) await new Promise(resolve => setTimeout(resolve, 0));
  state.chat.accountId = 'b';
  finishOld({ messages: [message('channel-1', 10)], hasMore: false });
  assert.equal((await oldResult).done, true);
  assert.equal(state.commits.length, 0);

  // Partial history resumes its saved offset only after refreshing and replaying the known region.
  state = scenario();
  state.index.lookup = async () => ({ scopeKey: 'scope', pageKeys: ['cached'], coverage: { ...coverage, complete: false, nextOffsetId: 8 } });
  state.index.page = async () => [item(10), item(9)];
  state.request = async (_a, input) => { state.calls.push(input); return input.offsetId === 0 ? { messages: [message('channel-1', 11), message('channel-1', 10)], hasMore: true, nextOffsetId: 10 } : { messages: [], hasMore: false }; };
  await collect(query());
  assert.deepEqual(state.calls.map(call => call.offsetId), [0, 8]);

  // A slow peer cannot gate fast peers or their next pages.
  state = scenario(['channel-1', 'channel-2']);
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  state.request = async (_a, input) => {
    if (input.peer.id === '1') return slow;
    return { messages: [message('channel-2', 20)], hasMore: false };
  };
  const controller = new AbortController();
  const iterator = streamFocusedSearch(query(), controller.signal);
  let fastResult;
  for (let i = 0; i < 4; i++) { const next = await iterator.next(); if (next.value?.items.length) { fastResult = next.value; break; } }
  assert.equal(fastResult.items[0].sessionId, 'channel-2');
  controller.abort(); releaseSlow({ messages: [], hasMore: false });
  assert.equal((await iterator.next()).done, true);
  await iterator.return();

  // Half-refreshed cache keeps the old head, so stop/restart cannot skip an unvisited gap.
  state = scenario();
  state.index.lookup = async () => ({ scopeKey: 'scope', pageKeys: ['cached'], coverage: { ...coverage } });
  state.request = async () => ({ messages: [message('channel-1', 30)], hasMore: true, nextOffsetId: 30 });
  const interrupted = new AbortController();
  for await (const chunk of streamFocusedSearch(query(), interrupted.signal)) if (chunk.items.length) interrupted.abort();
  assert.equal(state.commits[0][4].headMessageId, 10);

  // Unavailable local storage degrades to live search, never to zero successful results.
  state = scenario(); state.index.lookup = async () => { throw new Error('QUOTA'); };
  assert.equal((await collect(query())).flatMap(chunk => chunk.items).length, 1);
  state = scenario(['channel-1', 'channel-2']);
  state.request = async (_a, input) => { if (input.peer.id === '1') throw new Error('PERMISSION'); return { messages: [message('channel-2', 20)], hasMore: false }; };
  chunks = await collect(query());
  assert.ok(chunks.some(chunk => chunk.peerProgress?.status === 'error'));
  assert.equal(chunks.flatMap(chunk => chunk.items).length, 1);
  db.close();
  console.log('✓ live video filtering, head freshness, checkpoint resume/order, slow-peer isolation, immediate stop, cache failure, force refresh, account switch and partial failure');
} finally {
  assert.equal(dirname(resolve(out)), resolve(tmpdir()));
  assert.ok(basename(out).startsWith('lattice-search-tests-'));
  rmSync(out, { recursive: true, force: true });
  delete globalThis.searchHarness;
}
