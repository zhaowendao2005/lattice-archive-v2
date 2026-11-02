-- Phase 7: 日志快照记录化 + D1 单行上限分片
-- 每次上传生成一条快照记录；快照按约 1.9 MB 的 Base64 分片预算拆成尽可能少的连续行。
-- 旧 user_debug_snapshots 的每个账号快照迁移为一条 chunk_index = 0 的历史快照，避免数据丢失。

CREATE TABLE IF NOT EXISTS debug_snapshots (
  snapshot_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  chunk_gzip_b64 TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  total_size_chars INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  min_time INTEGER NOT NULL DEFAULT 0,
  max_time INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, chunk_index),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_debug_snapshots_user_created ON debug_snapshots(user_id, created_at DESC);
-- 设置页只读取 chunk_index = 0 的元数据行；部分索引避免扫描该账号的全部分片正文。
CREATE INDEX IF NOT EXISTS idx_debug_snapshots_user_meta
  ON debug_snapshots(user_id, created_at DESC)
  WHERE chunk_index = 0;

INSERT INTO debug_snapshots (
  snapshot_id,
  chunk_index,
  user_id,
  chunk_gzip_b64,
  chunk_count,
  total_size_chars,
  total_bytes,
  entry_count,
  min_time,
  max_time,
  created_at
)
SELECT
  'legacy_' || user_id,
  0,
  user_id,
  snapshot_gzip_b64,
  1,
  length(snapshot_gzip_b64),
  (length(snapshot_gzip_b64) * 3) / 4,
  entry_count,
  min_time,
  max_time,
  updated_at
FROM user_debug_snapshots;

DROP TABLE IF EXISTS user_debug_snapshots;
