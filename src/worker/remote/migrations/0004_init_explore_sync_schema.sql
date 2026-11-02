-- Phase 5: Single-Row Gzip Snapshot for Explore Board & Session Governance Sync
-- Keeps D1 Free Tier writes to 1 row per sync operation with CAS optimistic locking.
CREATE TABLE IF NOT EXISTS explore_sync_snapshots (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  manifest_gzip_b64 TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  device_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_explore_sync_updated_at ON explore_sync_snapshots(updated_at);
