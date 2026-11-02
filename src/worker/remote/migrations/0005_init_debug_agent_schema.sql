-- Phase 6: Agent Debug Access Keys & Single-Row Gzip Log Snapshot
-- 1. agent_debug_keys stores SHA-256 digests of Agent access keys with configurable TTL.
-- 2. user_debug_snapshots stores 1 compressed log bundle row per user (1-row upsert).

CREATE TABLE IF NOT EXISTS agent_debug_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_debug_keys_user_id ON agent_debug_keys(user_id);

CREATE TABLE IF NOT EXISTS user_debug_snapshots (
  user_id TEXT PRIMARY KEY,
  snapshot_gzip_b64 TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  min_time INTEGER NOT NULL DEFAULT 0,
  max_time INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
