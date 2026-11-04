/** Offline regression suite: monitor series storage, per-bus aggregation and min/max downsampling. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'lattice-monitor-tests-'));
const ts = createRequire(import.meta.url)('typescript');
function compile(source, file) {
  writeFileSync(join(out, file), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}

try {
  compile(readFileSync(join(root, 'src/stores/telegram/data-sources/monitorSeries.ts'), 'utf8'), 'series.mjs');
  const model = await import(pathToFileURL(join(out, 'series.mjs')).href);
  const lane = (overrides) => ({ lane: 'search', bus: 'search', active: 0, okRate: 0, errorRate: 0, cancelledRate: 0, bytesRate: 0, ...overrides });

  assert.equal(model.SERIES_BUSES.length, 9, 'all nine business buses are plotted');

  // Concurrency never double-counts fullMedia (file tasks) against mediaPart (RPC).
  const aggregated = model.aggregateBuses([
    lane({ lane: 'search', bus: 'search', active: 2, okRate: 1, errorRate: 0.5, cancelledRate: 0.5, bytesRate: 0 }),
    lane({ lane: 'mediaPart', bus: 'mediaAsset', active: 3, okRate: 2, cancelledRate: 1, bytesRate: 1024 }),
    lane({ lane: 'fullMedia', bus: 'mediaAsset', active: 4, bytesRate: 2048 }),
  ]);
  assert.equal(aggregated.search.concurrency, 2);
  assert.equal(aggregated.search.requests, 2, 'requests count terminal states including cancelled');
  assert.equal(aggregated.mediaAsset.concurrency, 3, 'fullMedia is a file task, not an RPC slot');
  assert.equal(aggregated.mediaAsset.requests, 3);
  assert.equal(aggregated.mediaAsset.throughput, 3072);
  assert.equal(aggregated.bot.concurrency, 0, 'unwired buses still report a zero sample');
  assert.equal(model.aggregateBuses([lane({ okRate: -1, errorRate: -2, bytesRate: -3 })]).search.requests, 0, 'negative deltas never produce negative rates');

  const store = new model.MonitorSeriesStore();
  assert.equal(store.size, 0);
  assert.equal(store.latestTime(), 0);
  assert.equal(store.buildSeries('concurrency', 0, 1, 10).search.length, 0);

  const sample = (concurrency) => {
    const values = model.emptySample();
    values.search.concurrency = concurrency;
    values.cover.requests = concurrency / 2;
    return values;
  };
  // Cross the 4096-sample chunk boundary to prove the store keeps every point.
  for (let i = 0; i < 5000; i += 1) store.append(1_000 + i, sample(i % 7));
  assert.equal(store.size, 5000);
  assert.equal(store.firstTime(), 1_000);
  assert.equal(store.latestTime(), 5_999);
  assert.ok(store.estimateBytes() > 0);

  const overview = store.buildSeries('concurrency', 1_000, 5_999, 100);
  assert.ok(overview.search.length > 0, 'downsampled series is not empty');
  assert.ok(overview.search.length <= 200, 'each bus emits at most two points per bucket');
  for (let i = 1; i < overview.search.length; i += 1) {
    assert.ok(overview.search[i][0] >= overview.search[i - 1][0], 'points stay ordered by time');
  }
  assert.equal(Math.max(...overview.search.map((point) => point[1])), 6, 'the peak value survives downsampling');

  // A single spike inside an otherwise flat window must still be visible.
  store.clear();
  for (let i = 0; i < 1000; i += 1) store.append(10_000 + i, sample(0));
  store.append(10_500.5, sample(99));
  const spike = store.buildSeries('concurrency', 10_000, 11_000, 20);
  assert.equal(Math.max(...spike.search.map((point) => point[1])), 99, 'min/max sampling preserves short spikes');
  assert.equal(new Set(spike.search.map((point) => point[0])).size, spike.search.length, 'no duplicated timestamps inside a bus');

  // Empty window and zero-bucket guard.
  assert.equal(store.buildSeries('concurrency', 20_000, 30_000, 20).search.length, 0);
  assert.equal(store.buildSeries('concurrency', 10_000, 11_000, 0).search.length, 0);

  const merged = model.mergeTimedPoints([[1, 1], [3, 3], [5, 5]], [[2, 2], [3, 9], [6, 6]]);
  assert.deepEqual(merged, [[1, 1], [2, 2], [3, 9], [5, 5], [6, 6]], 'detail points win on shared timestamps and order is preserved');

  store.clear();
  assert.equal(store.size, 0);
  assert.equal(store.latestTime(), 0);
  console.log('✓ per-bus aggregation, unbounded chunked storage, min/max downsampling and timeline merge');
} finally {
  assert.equal(dirname(resolve(out)), resolve(tmpdir()));
  assert.ok(basename(out).startsWith('lattice-monitor-tests-'));
  rmSync(out, { recursive: true, force: true });
}
