-- Tong's Information — Comment Image Integrity Trigger, Durable Cleanup Outbox & Idempotency Key
-- Managed via: cf d1 migrations apply <database-id> --dir migrations
-- Additive migration upgrading both original 0002_comment_images.sql and intermediate 0002 schemas cleanly.

CREATE TABLE IF NOT EXISTS comment_image_deletions (
  r2_key TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  site TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

ALTER TABLE comment_image_deletions ADD COLUMN reason TEXT NOT NULL DEFAULT 'deleted';

CREATE INDEX IF NOT EXISTS idx_comment_image_deletions_site
  ON comment_image_deletions (site, created_at ASC);

-- Atomically prevent a reply from committing if its top-level parent was deleted concurrently
CREATE TRIGGER IF NOT EXISTS trg_comments_visible_parent
BEFORE INSERT ON comments
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
        FROM comments
       WHERE id = NEW.parent_id
         AND site = NEW.site
         AND slug = NEW.slug
         AND parent_id IS NULL
         AND status = 'visible'
    )
    THEN RAISE(ABORT, 'parent_not_found')
  END;
END;

-- Optional client-generated idempotency key for safe retry recovery after lost HTTP acknowledgements
ALTER TABLE comments ADD COLUMN client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_client_req
  ON comments (site, slug, client_request_id)
  WHERE client_request_id IS NOT NULL;
