-- Account and session schema. Provision the first admin through a trusted local
-- bootstrap script using the same PBKDF2 format; never expose public admin signup.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  initials TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 25000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email_role ON users(email, role);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  keep_signed_in INTEGER NOT NULL DEFAULT 0,
  client_platform TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_connected_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
