/**
 * [DATA SOURCE] 探索页与会话治理单行 Gzip 云同步接线器 (ExploreSyncEngine)
 *
 * 职责：
 * 1. 使用原生 CompressionStream('gzip') 压缩 ExploreManifestV2 并编码为 Base64 + SHA-256；
 * 2. 调用 `/api/explore/sync` (GET / PUT)，每次同步始终先拉取云端快照并执行客户端
 *    `mergeExploreManifestsCrdt` 三路合并，再以 CAS 乐观锁推送，确保多设备双向同步 100% 一致；
 * 3. 全链路接入 debugLoggerDataSource 结构化日志（domain: 'archive.sync'），方便 Agent 检索诊断。
 */
import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';
import { authSessionStorage } from '@/stores/auth/data-sources/authSessionStorage';
import { notifyCloudActivity } from '@/stores/telegram/data-sources/tgRemoteDataSource';
import { tgSessionVault } from '@/stores/telegram/data-sources/tgSessionVault';
import type { ExploreManifestV2 } from '../types';
import { mergeExploreManifestsCrdt } from '../utils/crdtMerge';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function sha256Hex(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function compressManifestToGzipB64(manifest: ExploreManifestV2): Promise<{ gzipB64: string; sha256: string }> {
  const jsonText = JSON.stringify(manifest);
  const sha256 = await sha256Hex(jsonText);

  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([jsonText]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressedBuf = await new Response(stream).arrayBuffer();
    return {
      gzipB64: bytesToBase64(new Uint8Array(compressedBuf)),
      sha256,
    };
  }

  return {
    gzipB64: bytesToBase64(new TextEncoder().encode(jsonText)),
    sha256,
  };
}

async function decompressGzipB64ToManifest(gzipB64: string): Promise<ExploreManifestV2> {
  const bytes = base64ToBytes(gzipB64);
  if (typeof DecompressionStream !== 'undefined' && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    return JSON.parse(text) as ExploreManifestV2;
  }
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as ExploreManifestV2;
}

function authHeaders(): HeadersInit {
  const token = authSessionStorage.read()?.token;
  return token
    ? {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      }
    : {
        'Content-Type': 'application/json',
      };
}

export interface SyncCycleResult {
  mergedManifest: ExploreManifestV2;
  revision: number;
  updatedAt: number;
}

class ExploreSyncEngine {
  /** 拉取云端最新单行 Gzip 快照 */
  async pullRemoteSnapshot(traceId?: string): Promise<{ revision: number; manifest: ExploreManifestV2; updatedAt: number } | null> {
    const startMs = Date.now();
    const res = await fetch('/api/explore/sync', {
      method: 'GET',
      headers: authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`拉取云端同步快照失败 (HTTP ${res.status})`);
    }
    const data = (await res.json()) as {
      snapshot: {
        revision: number;
        manifestGzipB64: string;
        manifestSha256: string;
        deviceId: string;
        updatedAt: number;
      } | null;
    };
    if (!data.snapshot) {
      debugLoggerDataSource.emitFrontendLog({
        domain: 'archive.sync',
        action: 'pull_remote_snapshot',
        level: 'INFO',
        traceId,
        spanId: '01.01',
        parentSpanId: '01',
        durMs: Math.max(1, Date.now() - startMs),
        tags: { hasSnapshot: false },
      });
      return null;
    }
    const manifest = await decompressGzipB64ToManifest(data.snapshot.manifestGzipB64);
    debugLoggerDataSource.emitFrontendLog({
      domain: 'archive.sync',
      action: 'pull_remote_snapshot',
      level: 'INFO',
      traceId,
      spanId: '01.01',
      parentSpanId: '01',
      durMs: Math.max(1, Date.now() - startMs),
      tags: {
        hasSnapshot: true,
        remoteRev: data.snapshot.revision,
        remoteTiles: manifest.tiles?.length ?? 0,
        remoteGroups: manifest.groups?.length ?? 0,
        remoteDevice: data.snapshot.deviceId,
      },
    });
    notifyCloudActivity();
    return {
      revision: data.snapshot.revision,
      manifest,
      updatedAt: data.snapshot.updatedAt,
    };
  }

  /**
   * 完整执行一次「拉取云端快照 → 本地 CRDT 三路合并 → 单行 Gzip CAS 推送」同步周期
   */
  async syncNow(localManifest: ExploreManifestV2, baseRevision: number): Promise<SyncCycleResult> {
    const traceId = Date.now().toString(16).slice(-6);
    const rootStart = Date.now();
    let workingManifest = JSON.parse(JSON.stringify(localManifest)) as ExploreManifestV2;
    let workingRevision = baseRevision;

    debugLoggerDataSource.emitFrontendLog({
      domain: 'archive.sync',
      action: 'sync_start',
      level: 'INFO',
      traceId,
      spanId: '01',
      tags: {
        baseRev: baseRevision,
        localTiles: workingManifest.tiles?.length ?? 0,
        localGroups: workingManifest.groups?.length ?? 0,
      },
    });

    try {
      // 始终先拉取一次云端最新快照进行三路合并，确保任何一端点击同步都能双向拉取对方设备的新增内容
      const remote = await this.pullRemoteSnapshot(traceId);
      if (remote) {
        const beforeCount = workingManifest.tiles?.length ?? 0;
        workingManifest = mergeExploreManifestsCrdt(workingManifest, remote.manifest);
        workingRevision = remote.revision;
        debugLoggerDataSource.emitFrontendLog({
          domain: 'archive.sync',
          action: 'crdt_merge',
          level: 'INFO',
          traceId,
          spanId: '01.02',
          parentSpanId: '01',
          relMs: Date.now() - rootStart,
          tags: {
            localTilesBefore: beforeCount,
            remoteTiles: remote.manifest.tiles?.length ?? 0,
            mergedTiles: workingManifest.tiles?.length ?? 0,
            mergedGroups: workingManifest.groups?.length ?? 0,
            baseRev: workingRevision,
          },
        });
      } else {
        workingRevision = 0;
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const pushStart = Date.now();
        const { gzipB64, sha256 } = await compressManifestToGzipB64(workingManifest);
        const res = await fetch('/api/explore/sync', {
          method: 'PUT',
          headers: authHeaders(),
          body: JSON.stringify({
            baseRevision: workingRevision,
            manifestGzipB64: gzipB64,
            manifestSha256: sha256,
            deviceId: tgSessionVault.deviceId(),
          }),
        });

        if (res.status === 200) {
          const body = (await res.json()) as { revision: number; updatedAt: number };
          debugLoggerDataSource.emitFrontendLog({
            domain: 'archive.sync',
            action: 'push_remote_snapshot',
            level: 'INFO',
            traceId,
            spanId: '01.03',
            parentSpanId: '01',
            relMs: Date.now() - rootStart,
            durMs: Math.max(1, Date.now() - pushStart),
            tags: {
              newRev: body.revision,
              mergedTiles: workingManifest.tiles?.length ?? 0,
              gzipChars: gzipB64.length,
            },
          });
          notifyCloudActivity();
          return {
            mergedManifest: workingManifest,
            revision: body.revision,
            updatedAt: body.updatedAt,
          };
        }

        if (res.status === 409) {
          const conflict = (await res.json()) as {
            remoteSnapshot?: {
              revision: number;
              manifestGzipB64: string;
            } | null;
          };
          if (conflict.remoteSnapshot) {
            const remoteManifest = await decompressGzipB64ToManifest(conflict.remoteSnapshot.manifestGzipB64);
            workingManifest = mergeExploreManifestsCrdt(workingManifest, remoteManifest);
            workingRevision = conflict.remoteSnapshot.revision;
            debugLoggerDataSource.emitFrontendLog({
              domain: 'archive.sync',
              action: 'cas_conflict_retry',
              level: 'WARN',
              traceId,
              spanId: '01.04',
              parentSpanId: '01',
              relMs: Date.now() - rootStart,
              tags: {
                conflictRev: workingRevision,
                attempt: attempt + 1,
              },
            });
            continue;
          }
        }

        const errBody = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(errBody.message || `云端同步失败 (HTTP ${res.status})`);
      }

      throw new Error('多端并发同步冲突重试超限，请稍后再试');
    } catch (err) {
      debugLoggerDataSource.emitFrontendLog({
        domain: 'archive.sync',
        action: 'sync_error',
        level: 'ERROR',
        traceId,
        spanId: '01.99',
        parentSpanId: '01',
        relMs: Date.now() - rootStart,
        durMs: Math.max(1, Date.now() - rootStart),
        message: err instanceof Error ? err.message : 'sync_unknown_error',
      });
      throw err;
    }
  }
}

export const exploreSyncEngine = new ExploreSyncEngine();
