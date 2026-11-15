-- Self-service invitations: one row per invitation a customer makes in the editor.
-- The design comes from the template; everything the customer chose is in `settings` (JSON).
-- Separate from `events` (0001), which still runs the hand-made Ly Chhayly invitation.

CREATE TABLE invitations (
  id          INTEGER PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE CHECK (length(public_id) = 10 AND public_id NOT GLOB '*[^a-z0-9]*'),
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  template    TEXT NOT NULL CHECK (length(template) BETWEEN 2 AND 40 AND template NOT GLOB '*[^a-z0-9-]*'),
  event_type  TEXT NOT NULL CHECK (event_type IN ('wedding', 'birthday')),
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  settings    TEXT NOT NULL CHECK (json_valid(settings) AND length(settings) <= 32768),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'paid', 'published', 'archived')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX invitations_account_idx ON invitations(account_id, updated_at);
