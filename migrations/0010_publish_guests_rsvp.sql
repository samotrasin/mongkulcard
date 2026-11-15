-- Publishing self-service invitations, their guest links, and RSVP replies.
-- Separate from events/guests/rsvps (0001), which keep running the Ly Chhayly invitation.

-- mongkulcard.com/<slug> (shared "Dear guest" link) and mongkulcard.com/<slug>/<code> (one guest).
ALTER TABLE invitations ADD COLUMN slug TEXT CHECK (slug IS NULL OR (length(slug) BETWEEN 3 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'));
ALTER TABLE invitations ADD COLUMN published_at TEXT;
CREATE UNIQUE INDEX invitations_slug_idx ON invitations(slug) WHERE slug IS NOT NULL;

CREATE TABLE inv_guests (
  id             INTEGER PRIMARY KEY,
  invitation_id  INTEGER NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  code           TEXT NOT NULL CHECK (length(code) = 7 AND code NOT GLOB '*[^abcdefghjkmnpqrstuvwxyz23456789]*'),
  name           TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  lang           TEXT NOT NULL DEFAULT 'km' CHECK (lang IN ('km', 'en', 'zh')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  first_opened_at TEXT,
  last_opened_at  TEXT,
  open_count     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (invitation_id, code)
) STRICT;
CREATE INDEX inv_guests_inv_idx ON inv_guests(invitation_id, id);

-- One reply per guest link (changeable); several from the shared link, each with a name.
CREATE TABLE inv_rsvps (
  id             INTEGER PRIMARY KEY,
  invitation_id  INTEGER NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  guest_id       INTEGER UNIQUE REFERENCES inv_guests(id) ON DELETE CASCADE,
  name           TEXT CHECK (name IS NULL OR length(name) <= 80),
  attending      INTEGER NOT NULL CHECK (attending IN (0, 1)),
  party          INTEGER NOT NULL DEFAULT 1 CHECK (party BETWEEN 0 AND 50),
  message        TEXT CHECK (message IS NULL OR length(message) <= 300),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (guest_id IS NOT NULL OR name IS NOT NULL)
) STRICT;
CREATE INDEX inv_rsvps_inv_idx ON inv_rsvps(invitation_id, updated_at);
