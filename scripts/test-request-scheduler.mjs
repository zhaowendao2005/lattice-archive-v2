#!/usr/bin/env node
/**
 * RequestScheduler 行为测试（零依赖：用仓库自带的 typescript 把调度器转译到临时目录后运行）。
 * 覆盖：子池上限、搜索封面保留槽位、媒体组预算、优先级、排队取消、FloodWait 熔断、关闭、配置归一化，
 * 以及监控埋点（计数 / 字节 / 最近任务 / 事件）与 BusMonitor 帧（全量、增量、重同步、退订），
 * 方法级 FloodWait 冻结、DC 窗口降速、排队老化防饿死、关闭后丢弃旧结果、会话失效停摆与恢复。
 *
 * 用法：pnpm test:scheduler
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ts = createRequire(import.meta.url)('typescript');
const out = mkdtempSync(join(tmpdir(), 'lattice-scheduler-'));

function transpile(src, dst) {
  const code = ts.transpileModule(readFileSync(join(ROOT, src), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from (['"])(\.[^'"]+)\1/g, (_m, q, p) => `from ${q}${p}.mjs${q}`);
  mkdirSync(join(out, dst, '..'), { recursive: true });
  writeFileSync(join(out, dst), code);
}

transpile('src/worker/local/telegram/contracts/concurrency.ts', 'telegram/contracts/concurrency.mjs');
transpile('src/worker/local/telegram/contracts/monitor.ts', 'telegram/contracts/monitor.mjs');
transpile('src/worker/local/telegram/telemetry/busMonitor.ts', 'telegram/telemetry/busMonitor.mjs');
transpile('src/worker/local/telegram/runtime/requestScheduler.ts', 'telegram/runtime/requestScheduler.mjs');
transpile('src/worker/local/chat/telegramErrors.ts', 'chat/telegramErrors.mjs');
// 结构化日志在测试中替换为空实现。
mkdirSync(join(out, 'telegram/telemetry'), { recursive: true });
writeFileSync(join(out, 'telegram/telemetry/localSpans.mjs'), 'export function emitLocalSpan() {}\n');

const { applyConcurrencyConfig, schedulerFor, closeScheduler, schedulerMonitorSource, onAccountFatal, reviveScheduler, AGING_STEP_MS } = await import(pathToFileURL(join(out, 'telegram/runtime/requestScheduler.mjs')).href);
const monitor = await import(pathToFileURL(join(out, 'telegram/telemetry/busMonitor.mjs')).href);

try {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

  // 1. cover lane respects limit and reserved search slots (balanced: cover 8, reserved 3)
  applyConcurrencyConfig({ mode: 'balanced' });
  let s = schedulerFor('a1');
  let g = gate(); let running = 0; let peak = 0;
  const job = () => s.run('cover', async () => { running++; peak = Math.max(peak, running); await g.p; running--; });
  const chatJobs = Array.from({ length: 20 }, job);
  await tick();
  assert.equal(s.snapshot().laneActive.cover, 5, 'chat covers leave 3 reserved slots idle');
  const searchJobs = Array.from({ length: 5 }, () => s.run('cover', async () => { await g.p; }, { searchCover: true }));
  await tick();
  assert.equal(s.snapshot().laneActive.cover, 8, 'search covers take reserved slots, cap at cover=8');
  g.open(); await Promise.all([...chatJobs, ...searchJobs]);
  assert.equal(peak <= 8, true);
  assert.equal(s.snapshot().total, 0);

  // 2. media group budget (mediaRpc 6) caps cover+avatar+streamPart combined
  g = gate();
  const mixed = [
    ...Array.from({ length: 6 }, () => s.run('cover', () => g.p, { searchCover: true })),
    ...Array.from({ length: 4 }, () => s.run('avatar', () => g.p)),
    ...Array.from({ length: 4 }, () => s.run('streamPart', () => g.p, { priority: 'interactive' })),
  ];
  await tick();
  assert.equal(s.snapshot().groupActive.media, 12, 'media RPC group budget enforced (6 cover + 3 avatar + 4 stream = 13 > 12)');
  g.open(); await Promise.all(mixed);

  // 3. priority: interactive jumps ahead when slot frees
  applyConcurrencyConfig({ mode: 'custom', limits: { ...{ nonMediaRpc: 1, mediaRpc: 1, totalActiveTasks: 2, search: 1, cover: 1, searchCoverReserved: 0, avatar: 1, fullMedia: 1, mediaPart: 1, streamPart: 1 } } });
  g = gate(); const order = [];
  const first = s.run('cover', () => g.p);
  const low = s.run('cover', async () => { order.push('prefetch'); }, { priority: 'prefetch' });
  const high = s.run('streamPart', async () => { order.push('interactive'); }, { priority: 'interactive' });
  await tick(); g.open(); await Promise.all([first, low, high]);
  assert.deepEqual(order, ['interactive', 'prefetch']);

  // 4. abort while queued rejects with TG_CANCELED and frees nothing
  g = gate(); const ac = new AbortController();
  const blocker = s.run('cover', () => g.p);
  const queued = s.run('cover', async () => 'ran', { signal: ac.signal });
  ac.abort();
  await assert.rejects(queued, (e) => e.code === 'TG_CANCELED');
  g.open(); await blocker;

  // 5. FloodWait freezes the lane and fast-fails new requests; other lanes unaffected
  await assert.rejects(s.run('search', async () => { throw Object.assign(new Error('FLOOD_WAIT_30'), { errorMessage: 'FLOOD_WAIT', seconds: 30 }); }));
  await assert.rejects(s.run('search', async () => 'x'), (e) => String(e.code).startsWith('FLOOD_WAIT_'));
  assert.equal(await s.run('cover', async () => 'ok'), 'ok');

  // 6. closing scheduler rejects queued work
  g = gate();
  const b2 = s.run('avatar', () => g.p);
  const q2 = assert.rejects(s.run('avatar', async () => 'never'), (e) => e.code === 'TG_CANCELED');
  closeScheduler('a1');
  await q2;
  await assert.rejects(s.run('avatar', async () => 'x'), (e) => e.code === 'TG_CANCELED', 'closed scheduler refuses new work');
  g.open(); await assert.rejects(b2, (e) => e.code === 'TG_CANCELED', 'in-flight result of closed account is discarded');

  // 7. normalization: custom clamps and cross-field constraints
  const cfg = applyConcurrencyConfig({ mode: 'custom', limits: { cover: 999, searchCoverReserved: 50, search: 12, nonMediaRpc: 2, totalActiveTasks: 1 } });
  assert.equal(cfg.limits.cover, 12, 'cover limited by parent mediaRpc (balanced fallback 12)'); assert.equal(cfg.limits.searchCoverReserved, 12);
  assert.equal(cfg.limits.search, 2); assert.ok(cfg.limits.totalActiveTasks >= cfg.limits.mediaRpc);
  assert.deepEqual(applyConcurrencyConfig({ mode: 'aggressive', limits: { cover: 1 } }).limits.cover, 14);
  // 无固定数值上限：父级放开后子项可远超旧上限；下限仍生效
  const big = applyConcurrencyConfig({ mode: 'custom', limits: { mediaRpc: 500, cover: 300, searchCoverReserved: 100, nonMediaRpc: 200, search: 150, totalActiveTasks: 10 } });
  assert.equal(big.limits.cover, 300); assert.equal(big.limits.searchCoverReserved, 100); assert.equal(big.limits.search, 150);
  assert.equal(big.limits.totalActiveTasks, 500, 'total raised to max(nonMedia, media)');
  assert.equal(applyConcurrencyConfig({ mode: 'custom', limits: { search: 0, totalActiveTasks: 0 } }).limits.search, 1, 'minimum still enforced');

  // 8. 监控埋点：成功 / 失败计数、字节、最近任务环、事件
  applyConcurrencyConfig({ mode: 'balanced' });
  s = schedulerFor('m1');
  await s.run('cover', async (h) => { h.addBytes(1000); return 1; }, { operation: 'cover.photo' });
  await assert.rejects(s.run('cover', async () => { throw Object.assign(new Error('x'), { code: 'TIMEOUT' }); }));
  assert.equal(s.metrics.cover.ok, 1);
  assert.equal(s.metrics.cover.error, 1);
  assert.equal(s.metrics.cover.bytes, 1000);
  assert.equal(s.live.size, 0, 'finished tasks leave live table');
  const src = schedulerMonitorSource();
  const last = src.recentTasks[src.recentTasks.length - 1];
  assert.equal(last.state, 'error'); assert.equal(last.bucket, 'TIMEOUT'); assert.equal(last.accountId, 'm1');
  assert.ok(src.events.some((e) => e.kind === 'backoff' && e.accountId === 'm1'), 'backoff event recorded');
  assert.ok(src.recentTasks.length <= 100, 'recent ring bounded');

  // 9. BusMonitor：订阅即全量帧；增量只发变化；退订后不再推送
  const frames = [];
  monitor.configureBusMonitor({ sink: (id, frame) => frames.push({ id, frame }), accounts: () => [{ accountId: 'm1', tier: 'P0', dcId: 2 }] });
  monitor.recordConnectionState('m1', 'online');
  monitor.subscribeMonitor('sub-1', 10);
  assert.equal(frames.length, 1, 'immediate frame on subscribe');
  const firstFrame = frames[0].frame;
  assert.equal(firstFrame.full, true); assert.equal(firstFrame.seq, 1);
  assert.equal(firstFrame.accounts[0].connection, 'online');
  assert.equal(firstFrame.lanes.filter((l) => l.accountId === 'm1').length, 11, 'all 9 buses report their 11 lanes');
  assert.ok(firstFrame.taskUpserts.length >= 2, 'full frame carries recent tasks');
  g = gate();
  const pending = s.run('search', () => g.p, { operation: 'search.messages' });
  await new Promise((r) => setTimeout(r, 130));
  const delta = frames[frames.length - 1].frame;
  assert.equal(delta.full, false);
  assert.equal(delta.seq, frames.length);
  assert.deepEqual(delta.taskUpserts.map((t) => t.operation), ['search.messages'], 'only changed task in delta');
  assert.equal(delta.lanes.find((l) => l.accountId === 'm1' && l.lane === 'search').active, 1);
  g.open(); await pending;
  await new Promise((r) => setTimeout(r, 130));
  const done = frames[frames.length - 1].frame.taskUpserts.find((t) => t.operation === 'search.messages');
  assert.equal(done?.state, 'ok', 'state change re-sent');
  monitor.resyncMonitor('sub-1');
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(frames[frames.length - 1].frame.full, true, 'resync yields full frame');
  monitor.unsubscribeMonitor('sub-1');
  const count = frames.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(frames.length, count, 'no frames after unsubscribe');
  assert.equal(monitor.monitorSubscriberCount(), 0);

  
  // 10. FloodWait 只冻结「账号 + 方法」：同子池的其他方法不受影响
  applyConcurrencyConfig({ mode: 'balanced' });
  s = schedulerFor('f1');
  const flood = () => Promise.reject(Object.assign(new Error('FLOOD_WAIT_20'), { errorMessage: 'FLOOD_WAIT', seconds: 20 }));
  await assert.rejects(s.run('chatCommand', flood, { method: 'messages.SendMessage' }));
  await assert.rejects(s.run('chatCommand', async () => 'x', { method: 'messages.SendMessage' }), (e) => String(e.code).startsWith('FLOOD_WAIT_'));
  assert.equal(await s.run('chatCommand', async () => 'ok', { method: 'channels.JoinChannel' }), 'ok', 'other method in same lane still runs');
  closeScheduler('f1');

  // 11. 超时按 DC 降低窗口：DC4 降到 mediaRpc-1，DC2 不受影响
  s = schedulerFor('d1');
  const timeout = () => Promise.reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' }));
  await assert.rejects(s.run('cover', timeout, { dcId: 4, method: 'upload.GetFile' }));
  await s.run('cover', async () => 1, { dcId: 2, method: 'upload.GetFile' });
  const dcs = Object.fromEntries(s.dcSnapshot().map((d) => [d.dcId, d.limit]));
  assert.equal(dcs[4], 11, 'DC4 window reduced (balanced mediaRpc 12 → 11)');
  assert.equal(dcs[2], 12, 'DC2 window untouched');
  closeScheduler('d1');

  // 12. 排队老化防饿死：等待足够久的后台任务排在新到的交互任务之前
  applyConcurrencyConfig({ mode: 'custom', limits: { nonMediaRpc: 1, mediaRpc: 1, totalActiveTasks: 2, search: 1, chatRead: 1, chatCommand: 1, bot: 1, vault: 1, account: 1, cover: 1, searchCoverReserved: 0, avatar: 1, fullMedia: 1, mediaPart: 1, streamPart: 1 } });
  s = schedulerFor('a2');
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    g = gate(); const seen = [];
    const holder = s.run('vault', () => g.p);
    const old = s.run('vault', async () => { seen.push('background'); }, { priority: 'background' });
    fakeNow += AGING_STEP_MS * 4; // 后台任务已等待 4 个老化周期 → 有效优先级提升到 interactive
    const fresh = s.run('vault', async () => { seen.push('interactive'); }, { priority: 'interactive' });
    await tick(); g.open(); await Promise.all([holder, old, fresh]);
    assert.deepEqual(seen, ['background', 'interactive'], 'aged background task not starved');
  } finally { Date.now = realNow; }
  closeScheduler('a2');

  // 13. 账号关闭后仍在执行的任务：结果被丢弃（TG_CANCELED），不回写旧账号
  applyConcurrencyConfig({ mode: 'balanced' });
  s = schedulerFor('c1');
  g = gate();
  const inflight = assert.rejects(s.run('chatRead', () => g.p.then(() => 'stale')), (e) => e.code === 'TG_CANCELED');
  await tick();
  closeScheduler('c1');
  g.open(); await inflight;
  assert.notEqual(schedulerFor('c1'), s, 'closed scheduler replaced on next use');
  closeScheduler('c1');

  // 14. AUTH_KEY_DUPLICATED：停摆该账号全部队列并通知运行时，重新授权后恢复
  const fatal = [];
  onAccountFatal((accountId, code) => fatal.push([accountId, code]));
  s = schedulerFor('h1');
  g = gate();
  const blocked = s.run('chatRead', () => g.p);
  const queuedBehind = assert.rejects(Promise.all(Array.from({ length: 5 }, () => s.run('chatRead', async () => 1))), (e) => e.code === 'AUTH_KEY_DUPLICATED');
  await assert.rejects(s.run('search', () => Promise.reject(Object.assign(new Error('AUTH_KEY_DUPLICATED'), { errorMessage: 'AUTH_KEY_DUPLICATED' }))));
  await queuedBehind;
  assert.deepEqual(fatal, [['h1', 'AUTH_KEY_DUPLICATED']]);
  assert.equal(schedulerFor('h1'), s, 'halted scheduler kept until re-authorization');
  await assert.rejects(s.run('cover', async () => 1), (e) => e.code === 'AUTH_KEY_DUPLICATED', 'halted account rejects new work');
  g.open(); await blocked.catch(() => undefined);
  reviveScheduler('h1');
  assert.equal(await schedulerFor('h1').run('cover', async () => 'back'), 'back', 'revived after re-auth');
  closeScheduler('h1');

    console.log('✓ RequestScheduler 行为测试通过');
} finally {
  rmSync(out, { recursive: true, force: true });
}
