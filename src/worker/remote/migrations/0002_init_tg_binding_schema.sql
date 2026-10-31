-- Telegram application credentials, account bindings, and per-device authorization metadata.
CREATE TABLE IF NOT EXISTS tg_apps (
  user_id TEXT PRIMARY KEY,
  api_id INTEGER NOT NULL,
  api_hash_enc TEXT NOT NULL,
  api_hash_mask TEXT NOT NULL,
  validated_at INTEGER,
  last_report TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tg_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tg_user_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  phone_enc TEXT,
  phone_mask TEXT,
  is_premium INTEGER NOT NULL DEFAULT 0,
  home_dc INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, tg_user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tg_accounts_user ON tg_accounts(user_id, updated_at);

CREATE TABLE IF NOT EXISTS tg_authorizations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_label TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('web', 'electron', 'ios')),
  app_version TEXT,
  session_state TEXT NOT NULL DEFAULT 'active' CHECK (session_state IN ('active', 'expired', 'revoked', 'duplicated')),
  reachability TEXT CHECK (reachability IN ('ok', 'degraded', 'blocked')),
  flood_until INTEGER,
  frozen INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (account_id, device_id),
  FOREIGN KEY (account_id) REFERENCES tg_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tg_auth_account_seen ON tg_authorizations(account_id, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_tg_auth_user ON tg_authorizations(account_id);
