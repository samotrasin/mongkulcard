-- Photos, music and video that customers upload for their own invitation.
-- Files live in R2 (bucket mongkulcard-photos, under m/<invitation>/...), videos later in Cloudflare Stream.
-- One row per file. The first photo (lowest sort) is the cover.

CREATE TABLE invitation_media (
  id             INTEGER PRIMARY KEY,
  public_id      TEXT NOT NULL UNIQUE CHECK (length(public_id) = 12 AND public_id NOT GLOB '*[^a-z0-9]*'),
  invitation_id  INTEGER NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('photo', 'music', 'video')),
  r2_key         TEXT,                        -- photos and music
  stream_uid     TEXT,                        -- video (Cloudflare Stream)
  mime           TEXT NOT NULL,
  bytes          INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  width          INTEGER,
  height         INTEGER,
  duration       REAL,
  original_name  TEXT,
  sort           INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('uploading', 'processing', 'ready', 'error')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (r2_key IS NOT NULL OR stream_uid IS NOT NULL)
) STRICT;
CREATE INDEX invitation_media_inv_idx ON invitation_media(invitation_id, kind, sort);

-- Stop new events from taking the /m/ address used for these files.
INSERT OR IGNORE INTO reserved_slugs (slug) VALUES ('m'), ('v'), ('media');
