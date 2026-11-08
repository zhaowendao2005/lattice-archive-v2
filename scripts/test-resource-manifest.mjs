#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(import.meta.url)('typescript');
const out = mkdtempSync(path.join(tmpdir(), 'lattice-resource-'));
const source = readFileSync(path.join(root, 'src/stores/archive/utils/resourceManifest.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
writeFileSync(path.join(out, 'resourceManifest.mjs'), code);
const {
  migrateExploreManifestV2ToV3,
  materializeResourceMirrors,
  stripResourceMirrors,
  getTileTelegramDedupKey,
} = await import(pathToFileURL(path.join(out, 'resourceManifest.mjs')).href);

const sourceRef = { accountId: 'acc-1', peerId: '123', peerType: 'channel', msgId: 77, accessHash: 'hash' };
const base = {
  type: 'file',
  title: 'same video',
  size: 'medium',
  groupId: 'g',
  x: 0,
  y: 0,
  fileType: 'video',
  extension: 'mp4',
  accountId: 'acc-1',
  peerKey: 'channel-123',
  peerType: 'channel',
  sessionId: 'channel-123',
  sources: [{ kind: 'origin', accountId: 'acc-1', peerKey: 'channel-123', peerId: '123', peerType: 'channel', msgId: 77, documentId: 'doc-9' }],
  videoInfo: { id: 'doc-9' },
  thumb: { status: 'ready', strippedDataUrl: 'data:image/jpeg;base64,abc', retryCount: 0, sourceRef },
  createdAt: '2026-01-01',
  updatedAt: '2026-01-02',
  updatedAtMs: 10,
};
const manifest = {
  schemaVersion: 2,
  revision: 1,
  updatedAtMs: 10,
  deviceId: 'test',
  groups: [],
  tiles: [
    { ...base, id: 'tile-a', x: 0, y: 0 },
    { ...base, id: 'tile-b', x: 2, y: 0, updatedAtMs: 20, title: 'newer title' },
  ],
  tombstones: {},
  tempCredentials: [],
};

const migrated = migrateExploreManifestV2ToV3(manifest);
assert.equal(migrated.schemaVersion, 3);
assert.equal(Object.keys(migrated.resources).length, 1, '同一来源必须只生成一个 resource');
assert.equal(migrated.tiles[0].resourceId, migrated.tiles[1].resourceId, '多个磁贴必须共享 resourceId');
assert.equal(migrated.tiles[0].sources, undefined, 'V3 持久化 tile 不应复制来源');
assert.equal(migrated.tiles[0].thumb, undefined, 'V3 持久化 tile 不应复制封面');
assert.equal(migrated.tiles[0].id, 'tile-a');
assert.equal(migrated.tiles[1].x, 2);

const again = migrateExploreManifestV2ToV3(migrated);
assert.equal(Object.keys(again.resources).length, 1, '再次迁移必须幂等');
assert.equal(again.tiles[0].resourceId, migrated.tiles[0].resourceId);

const hydrated = materializeResourceMirrors(migrated);
assert.equal(hydrated.tiles[0].sources?.[0]?.msgId, 77, '运行时必须恢复资源镜像');
assert.ok(hydrated.tiles[0].thumb?.opfsPath?.includes(migrated.tiles[0].resourceId), '运行时封面路径必须按 resourceId');

const stripped = stripResourceMirrors(hydrated);
assert.equal(stripped.tiles[0].sources, undefined);
assert.equal(stripped.tiles[0].thumb, undefined);
assert.equal(Object.keys(stripped.resources).length, 1);

// 同一会话的不同视频（带 sessionId）必须是不同 resource
const sameChat = (n) => ({
  ...base,
  id: `tile-v${n}`,
  sessionId: 'channel-123',
  sourceResultId: `tg-channel-123-${n}`,
  sources: [{ ...base.sources[0], msgId: n, documentId: `doc-${n}` }],
  videoInfo: { id: `doc-${n}` },
});
const multi = migrateExploreManifestV2ToV3({ ...manifest, tiles: [sameChat(1), sameChat(2), sameChat(3)] });
assert.equal(new Set(multi.tiles.map((t) => t.resourceId)).size, 3, '同会话不同视频必须各有独立 resourceId');

// 旧版被并入 telegram-session 的数据必须拆开，并重置封面
const polluted = JSON.parse(JSON.stringify(multi));
const sessId = 'res-polluted';
polluted.resources = { [sessId]: { ...Object.values(multi.resources)[0], id: sessId, identityKey: 'tg-session:acc-1:channel-123', kind: 'telegram-session' } };
for (const t of polluted.tiles) t.resourceId = sessId;
const repaired = migrateExploreManifestV2ToV3(polluted);
assert.equal(new Set(repaired.tiles.map((t) => t.resourceId)).size, 3, '旧污染数据必须按消息拆分');
assert.ok(repaired.tiles.every((t) => repaired.resources[t.resourceId].thumb?.status === 'pending'), '拆分后封面必须重新拉取');
assert.equal(repaired.resources[repaired.tiles[1].resourceId].sources[0].msgId, 2, '必须由 sourceResultId 还原各自 msgId');

// 跨群相同 document.id / photo.id 与会话 peerKey 的 Telegram 原生 ID 去重键断言
const videoGroupA = {
  ...base,
  id: 'tile-vid-a',
  peerKey: 'channel-100',
  videoInfo: { id: 'doc-shared-777' },
};
const videoGroupB = {
  ...base,
  id: 'tile-vid-b',
  peerKey: 'channel-200',
  videoInfo: { id: 'doc-shared-777' },
};
assert.deepEqual(
  getTileTelegramDedupKey(videoGroupA),
  { key: 'tg-doc:doc-shared-777', kind: 'video' },
  '不同群组的相同 document.id 必须命中同一去重键',
);
assert.deepEqual(getTileTelegramDedupKey(videoGroupA), getTileTelegramDedupKey(videoGroupB));

const photoGroupA = {
  ...base,
  id: 'tile-photo-a',
  fileType: 'image',
  extension: 'jpg',
  videoInfo: undefined,
  photoInfo: { id: 'photo-888' },
};
assert.deepEqual(
  getTileTelegramDedupKey(photoGroupA),
  { key: 'tg-photo:photo-888', kind: 'image' },
);

const sessionTileA = {
  ...base,
  id: 'tile-sess-a',
  isSessionLink: true,
  extension: 'tg',
  peerKey: 'channel-999',
  videoInfo: undefined,
};
assert.deepEqual(
  getTileTelegramDedupKey(sessionTileA),
  { key: 'tg-peer:channel-999', kind: 'session' },
);

const localNoteTile = {
  id: 'tile-local-note',
  type: 'file',
  title: '本地备忘',
  size: 'medium',
  groupId: 'g',
  x: 0,
  y: 0,
  fileType: 'doc',
  extension: 'md',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
assert.equal(getTileTelegramDedupKey(localNoteTile), null, '无 Telegram 原生 ID 的本地磁贴不得生成去重键');

console.log('✓ resource manifest tests passed');
