/**
 * ============================================================================
 * 探索页与治理元数据单行 Gzip 快照 D1 仓储层 (Explore Sync Repository)
 * ============================================================================
 * 严格遵循单行 Gzip 压缩快照策略（Single-Row Gzip Snapshot）：
 * 每次同步仅读写 1 行记录，最大化节省 Cloudflare D1 免费层读写行数配额。
 */

export interface ExploreSyncSnapshotRow {
  user_id: string;
  revision: number;
  manifest_gzip_b64: string;
  manifest_sha256: string;
  device_id: string;
  updated_at: number;
}

export async function findExploreSnapshotByUser(
  db: D1Database,
  userId: string,
): Promise<ExploreSyncSnapshotRow | null> {
  return db
    .prepare(
      `SELECT user_id, revision, manifest_gzip_b64, manifest_sha256, device_id, updated_at
       FROM explore_sync_snapshots
       WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<ExploreSyncSnapshotRow>();
}

export async function insertInitialExploreSnapshot(
  db: D1Database,
  row: {
    userId: string;
    manifestGzipB64: string;
    manifestSha256: string;
    deviceId: string;
    now: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO explore_sync_snapshots (user_id, revision, manifest_gzip_b64, manifest_sha256, device_id, updated_at)
       VALUES (?1, 1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id) DO NOTHING`,
    )
    .bind(row.userId, row.manifestGzipB64, row.manifestSha256, row.deviceId, row.now)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function updateExploreSnapshotCas(
  db: D1Database,
  params: {
    userId: string;
    baseRevision: number;
    nextRevision: number;
    manifestGzipB64: string;
    manifestSha256: string;
    deviceId: string;
    now: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE explore_sync_snapshots
       SET revision = ?3,
           manifest_gzip_b64 = ?4,
           manifest_sha256 = ?5,
           device_id = ?6,
           updated_at = ?7
       WHERE user_id = ?1 AND revision = ?2`,
    )
    .bind(
      params.userId,
      params.baseRevision,
      params.nextRevision,
      params.manifestGzipB64,
      params.manifestSha256,
      params.deviceId,
      params.now,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
