-- Tong's Information — Comment Image Attachments Schema
-- Managed via: cf d1 migrations apply <database-id> --dir migrations

CREATE TABLE IF NOT EXISTS comment_images (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  slug TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'visible',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comment_images_comment
  ON comment_images (site, comment_id, status, sort_order ASC);

CREATE INDEX IF NOT EXISTS idx_comment_images_slug
  ON comment_images (site, slug, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_comment_images_r2_key
  ON comment_images (r2_key);
