/**
 * ============================================================================
 * 探索页单行 Gzip 快照同步业务层 (Explore Sync Service)
 * ============================================================================
 */
import { AuthError } from '../auth/types';
import {
  findExploreSnapshotByUser,
  insertInitialExploreSnapshot,
  updateExploreSnapshotCas,
} from './repository';

const MAX_GZIP_B64_LENGTH = 900_000; // ~675 KB 压缩体积上限，确保单行写入安全

export async function getExploreSyncSnapshot(env: Env, userId: string) {
  const row = await findExploreSnapshotByUser(env.AUTH_DB, userId);
  if (!row) {
    return {
      snapshot: null,
    };
  }
  return {
    snapshot: {
      revision: row.revision,
      manifestGzipB64: row.manifest_gzip_b64,
      manifestSha256: row.manifest_sha256,
      deviceId: row.device_id,
      updatedAt: row.updated_at,
    },
  };
}

export async function putExploreSyncSnapshot(
  env: Env,
  userId: string,
  body: Record<string, unknown>,
): Promise<{ status: 200 | 409; payload: Record<string, unknown> }> {
  const baseRevision = typeof body.baseRevision === 'number' ? Math.floor(body.baseRevision) : 0;
  const manifestGzipB64 = typeof body.manifestGzipB64 === 'string' ? body.manifestGzipB64.trim() : '';
  const manifestSha256 = typeof body.manifestSha256 === 'string' ? body.manifestSha256.trim() : '';
  const deviceId = typeof body.deviceId === 'string' && body.deviceId.trim() ? body.deviceId.trim().slice(0, 64) : 'web';

  if (!manifestGzipB64 || !manifestSha256) {
    throw new AuthError('INVALID_REQUEST', '同步快照数据不能为空');
  }
  if (manifestGzipB64.length > MAX_GZIP_B64_LENGTH) {
    throw new AuthError('INVALID_REQUEST', '同步快照体积超出单行安全上限');
  }

  const now = Date.now();
  const current = await findExploreSnapshotByUser(env.AUTH_DB, userId);

  if (!current) {
    const inserted = await insertInitialExploreSnapshot(env.AUTH_DB, {
      userId,
      manifestGzipB64,
      manifestSha256,
      deviceId,
      now,
    });
    if (inserted) {
      return {
        status: 200,
        payload: {
          ok: true,
          revision: 1,
          updatedAt: now,
        },
      };
    }
  }

  const latest = current ?? (await findExploreSnapshotByUser(env.AUTH_DB, userId));
  if (!latest) {
    throw new AuthError('INTERNAL_ERROR', '写入云端同步快照失败', 500);
  }

  // 若哈希完全一致，免写数据库直接幂等返回当前版本
  if (latest.manifest_sha256 === manifestSha256) {
    return {
      status: 200,
      payload: {
        ok: true,
        revision: latest.revision,
        updatedAt: latest.updated_at,
      },
    };
  }

  // CAS 乐观锁版本冲突：返回 409 与云端快照，由客户端执行 CRDT 3-Way Merge 后重试
  if (latest.revision !== baseRevision) {
    return {
      status: 409,
      payload: {
        error: 'SYNC_CONFLICT',
        message: '云端存在更新版本，需在客户端执行三路合并',
        remoteSnapshot: {
          revision: latest.revision,
          manifestGzipB64: latest.manifest_gzip_b64,
          manifestSha256: latest.manifest_sha256,
          deviceId: latest.device_id,
          updatedAt: latest.updated_at,
        },
      },
    };
  }

  const nextRevision = latest.revision + 1;
  const updated = await updateExploreSnapshotCas(env.AUTH_DB, {
    userId,
    baseRevision,
    nextRevision,
    manifestGzipB64,
    manifestSha256,
    deviceId,
    now,
  });

  if (!updated) {
    const refreshed = await findExploreSnapshotByUser(env.AUTH_DB, userId);
    return {
      status: 409,
      payload: {
        error: 'SYNC_CONFLICT',
        message: '并发写入冲突，请合并后重试',
        remoteSnapshot: refreshed
          ? {
              revision: refreshed.revision,
              manifestGzipB64: refreshed.manifest_gzip_b64,
              manifestSha256: refreshed.manifest_sha256,
              deviceId: refreshed.device_id,
              updatedAt: refreshed.updated_at,
            }
          : null,
      },
    };
  }

  return {
    status: 200,
    payload: {
      ok: true,
      revision: nextRevision,
      updatedAt: now,
    },
  };
}
