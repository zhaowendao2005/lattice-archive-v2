/**
 * ============================================================================
 * 远端调试快照与 Agent 访问密钥 D1 仓储层 (src/worker/remote/debug/repository.ts)
 * ============================================================================
 */
import type { AgentDebugKeyRow, DebugSnapshotChunkRow } from './types';

export async function listKeysByUser(db: D1Database, userId: string): Promise<AgentDebugKeyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, name, key_prefix, key_hash, expires_at, created_at, last_used_at
       FROM agent_debug_keys
       WHERE user_id = ?1
       ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<AgentDebugKeyRow>();
  return results;
}

export async function insertAgentKey(
  db: D1Database,
  row: AgentDebugKeyRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_debug_keys (id, user_id, name, key_prefix, key_hash, expires_at, created_at, last_used_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      row.id,
      row.user_id,
      row.name,
      row.key_prefix,
      row.key_hash,
      row.expires_at,
      row.created_at,
      row.last_used_at,
    )
    .run();
}

export async function deleteAgentKeyById(
  db: D1Database,
  userId: string,
  keyId: string,
): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM agent_debug_keys WHERE id = ?1 AND user_id = ?2`)
    .bind(keyId, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function findAgentKeyByHash(
  db: D1Database,
  keyHash: string,
): Promise<AgentDebugKeyRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, name, key_prefix, key_hash, expires_at, created_at, last_used_at
       FROM agent_debug_keys
       WHERE key_hash = ?1`,
    )
    .bind(keyHash)
    .first<AgentDebugKeyRow>();
}

export async function touchAgentKeyLastUsed(
  db: D1Database,
  keyId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(`UPDATE agent_debug_keys SET last_used_at = ?1 WHERE id = ?2`)
    .bind(now, keyId)
    .run();
}

/** 快照元数据只取 chunk_index = 0 一行，绝不把压缩正文带到设置页。 */
export async function listSnapshotMetaByUser(
  db: D1Database,
  userId: string,
): Promise<DebugSnapshotChunkRow[]> {
  const { results } = await db
    .prepare(
      `SELECT snapshot_id, chunk_index, user_id, '' AS chunk_gzip_b64, chunk_count,
              total_size_chars, total_bytes, entry_count, min_time, max_time, created_at
       FROM debug_snapshots
       WHERE user_id = ?1 AND chunk_index = 0
       ORDER BY created_at DESC, snapshot_id DESC`,
    )
    .bind(userId)
    .all<DebugSnapshotChunkRow>();
  return results;
}

/** 按 ID 读取当前账号的一条快照元数据，用于重复提交的幂等判断。 */
export async function findSnapshotMetaById(
  db: D1Database,
  userId: string,
  snapshotId: string,
): Promise<DebugSnapshotChunkRow | null> {
  return db
    .prepare(
      `SELECT snapshot_id, chunk_index, user_id, '' AS chunk_gzip_b64, chunk_count,
              total_size_chars, total_bytes, entry_count, min_time, max_time, created_at
       FROM debug_snapshots
       WHERE user_id = ?1 AND snapshot_id = ?2 AND chunk_index = 0`,
    )
    .bind(userId, snapshotId)
    .first<DebugSnapshotChunkRow>();
}

/** 读取当前账号的全部分片正文，供 Agent 查询合并成一条时间线。 */
export async function listSnapshotChunksByUser(
  db: D1Database,
  userId: string,
): Promise<DebugSnapshotChunkRow[]> {
  const { results } = await db
    .prepare(
      `SELECT snapshot_id, chunk_index, user_id, chunk_gzip_b64, chunk_count,
              total_size_chars, total_bytes, entry_count, min_time, max_time, created_at
       FROM debug_snapshots
       WHERE user_id = ?1
       ORDER BY created_at ASC, snapshot_id ASC, chunk_index ASC`,
    )
    .bind(userId)
    .all<DebugSnapshotChunkRow>();
  return results;
}

/** 判断快照 ID 是否已被任意账号占用，避免跨账号主键冲突落成 500。 */
export async function snapshotIdExists(
  db: D1Database,
  snapshotId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS found FROM debug_snapshots WHERE snapshot_id = ?1 LIMIT 1`)
    .bind(snapshotId)
    .first<{ found: number }>();
  return row !== null;
}

/** 用 D1 batch 原子写入一条快照的全部分片，避免产生半个快照。 */
export async function insertSnapshotChunks(
  db: D1Database,
  rows: DebugSnapshotChunkRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const statements = rows.map((row) =>
    db
      .prepare(
        `INSERT INTO debug_snapshots (
           snapshot_id, chunk_index, user_id, chunk_gzip_b64, chunk_count,
           total_size_chars, total_bytes, entry_count, min_time, max_time, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        row.snapshot_id,
        row.chunk_index,
        row.user_id,
        row.chunk_gzip_b64,
        row.chunk_count,
        row.total_size_chars,
        row.total_bytes,
        row.entry_count,
        row.min_time,
        row.max_time,
        row.created_at,
      ),
  );
  await db.batch(statements);
}

/** 只删除当前账号拥有的快照；返回是否真的删除了记录。 */
export async function deleteSnapshotById(
  db: D1Database,
  userId: string,
  snapshotId: string,
): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM debug_snapshots WHERE user_id = ?1 AND snapshot_id = ?2`)
    .bind(userId, snapshotId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
