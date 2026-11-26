-- Tong's Information — Comments & Single-Use Anti-Abuse Gate Schema
-- Managed via: cf d1 migrations apply <database-id> --dir migrations

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id TEXT DEFAULT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  author_url TEXT DEFAULT NULL,
  is_author INTEGER NOT NULL DEFAULT 0,
  lang TEXT NOT NULL DEFAULT 'zh',
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  verification_mode TEXT NOT NULL DEFAULT 'turnstile',
  status TEXT NOT NULL DEFAULT 'visible',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_thread
  ON comments (site, slug, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_comments_parent
  ON comments (parent_id);

CREATE INDEX IF NOT EXISTS idx_comments_rate_ip
  ON comments (site, ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_dedupe
  ON comments (site, slug, body_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS comment_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comment_nonces_exp
  ON comment_nonces (expires_at);
