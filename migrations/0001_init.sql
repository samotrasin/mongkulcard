-- MongkulCard database, migration 0001 (SQLite, runs on Cloudflare D1)
--
-- Conventions
--   * Every timestamp is UTC text: 2026-12-20T10:00:00Z. Text in this format sorts correctly.
--   * Event-local values (a ceremony's clock time) are stored as local text next to a UTC instant.
--   * Booleans are INTEGER 0/1 with a CHECK.
--   * STRICT tables: SQLite refuses the wrong type instead of quietly accepting it.
--   * Composite foreign keys (id, event_id) make it impossible to link rows of two different events.
--   * Rules that must never break live in the database (CHECKs and triggers), not only in app code.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- who and what

CREATE TABLE customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  telegram    TEXT,
  email       TEXT,
  phone       TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (telegram IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL)
) STRICT;

CREATE TABLE templates (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 3 AND 40 AND code NOT GLOB '*[^a-z0-9-]*'),
  name        TEXT NOT NULL,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

-- Event names that may never be used, because they are addresses of the site itself.
CREATE TABLE reserved_slugs (
  slug TEXT PRIMARY KEY
) STRICT;

INSERT INTO reserved_slugs (slug) VALUES
  ('admin'),('api'),('assets'),('img'),('images'),('media'),('static'),('host'),('hosts'),
  ('login'),('logout'),('www'),('app'),('help'),('contact'),('about'),('terms'),('privacy'),
  ('health'),('status'),('robots'),('sitemap'),('favicon'),('fonts'),('css'),('js'),('qr'),
  ('upload'),('uploads'),('wishes'),('rsvp'),('templates'),('pricing'),('mongkulcard');

CREATE TABLE events (
  id                    INTEGER PRIMARY KEY,
  customer_id           INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  template_id           INTEGER NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  slug                  TEXT NOT NULL UNIQUE
                          CHECK (length(slug) BETWEEN 3 AND 40
                                 AND slug NOT GLOB '*[^a-z0-9-]*'
                                 AND slug NOT GLOB '-*' AND slug NOT GLOB '*-'),
  event_type            TEXT NOT NULL DEFAULT 'wedding'
                          CHECK (event_type IN ('wedding','birthday','housewarming','baby_shower','other')),
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','live','ended','archived')),
  title_km              TEXT,
  title_en              TEXT NOT NULL,
  timezone              TEXT NOT NULL DEFAULT 'Asia/Phnom_Penh',
  event_date            TEXT NOT NULL CHECK (event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  default_language      TEXT NOT NULL DEFAULT 'km' CHECK (default_language IN ('km','en')),
  -- Template specific wording (honorifics, invitation paragraph, lunar date line, thanks text).
  content_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(content_json)),

  -- switches and limits are data, so they change without a code change
  rsvp_enabled          INTEGER NOT NULL DEFAULT 1 CHECK (rsvp_enabled IN (0,1)),
  wishes_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (wishes_enabled IN (0,1)),
  wishes_need_approval  INTEGER NOT NULL DEFAULT 1 CHECK (wishes_need_approval IN (0,1)),
  photos_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (photos_enabled IN (0,1)),
  general_link_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (general_link_enabled IN (0,1)),
  max_wishes_per_guest  INTEGER NOT NULL DEFAULT 3 CHECK (max_wishes_per_guest BETWEEN 1 AND 20),
  max_photos_per_guest  INTEGER NOT NULL DEFAULT 5 CHECK (max_photos_per_guest BETWEEN 1 AND 20),

  -- time windows (UTC)
  wishes_open_at        TEXT,                    -- NULL = open as soon as the event is live
  photos_open_at        TEXT NOT NULL,           -- the day before the event
  links_expire_at       TEXT NOT NULL,           -- event + 7 days
  photos_delete_at      TEXT NOT NULL,           -- event + 30 days

  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

  CHECK (photos_open_at < links_expire_at),
  CHECK (links_expire_at <= photos_delete_at)
) STRICT;

CREATE INDEX events_customer_idx ON events(customer_id);
CREATE INDEX events_expiry_idx   ON events(links_expire_at);
CREATE INDEX events_purge_idx    ON events(photos_delete_at);

CREATE TRIGGER events_slug_not_reserved_ins BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = NEW.slug)
BEGIN SELECT RAISE(ABORT, 'event name is reserved'); END;

CREATE TRIGGER events_slug_not_reserved_upd BEFORE UPDATE OF slug ON events
WHEN EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = NEW.slug)
BEGIN SELECT RAISE(ABORT, 'event name is reserved'); END;

-- Access for the host (couple). Only a hash of the secret address is stored.
CREATE TABLE host_access (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,                   -- for example 'groom', 'bride'
  key_hash     TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_used_at TEXT,
  revoked_at   TEXT
) STRICT;
CREATE INDEX host_access_event_idx ON host_access(event_id);

-- ---------------------------------------------------------------- media of an event

CREATE TABLE event_media (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('cover','crest','gallery','poster','video','music','og_image','map','decor')),
  storage     TEXT NOT NULL DEFAULT 'site' CHECK (storage IN ('site','r2','external')),
  path        TEXT NOT NULL,                    -- file path, R2 key or full URL, depending on storage
  mime        TEXT,
  width       INTEGER CHECK (width  IS NULL OR width  > 0),
  height      INTEGER CHECK (height IS NULL OR height > 0),
  bytes       INTEGER CHECK (bytes  IS NULL OR bytes  > 0),
  alt_km      TEXT,
  alt_en      TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, role, path)
) STRICT;
CREATE INDEX event_media_lookup_idx ON event_media(event_id, role, sort_order);

-- ---------------------------------------------------------------- where and when

CREATE TABLE venues (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name_km     TEXT,
  name_en     TEXT NOT NULL,
  address_km  TEXT,
  address_en  TEXT,
  maps_url    TEXT CHECK (maps_url IS NULL OR maps_url LIKE 'https://%'),
  lat         REAL CHECK (lat IS NULL OR lat BETWEEN -90  AND 90),
  lng         REAL CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  UNIQUE (id, event_id)
) STRICT;
CREATE INDEX venues_event_idx ON venues(event_id);

-- A segment is a part of the event a guest can be invited to,
-- for example "Morning ceremonies" or "Evening reception".
CREATE TABLE segments (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  venue_id    INTEGER,
  code        TEXT NOT NULL CHECK (length(code) BETWEEN 2 AND 30 AND code NOT GLOB '*[^a-z0-9_-]*'),
  title_km    TEXT,
  title_en    TEXT NOT NULL,
  local_date  TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_local TEXT NOT NULL CHECK (start_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_local   TEXT          CHECK (end_local   IS NULL OR end_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  starts_at   TEXT NOT NULL,                    -- the same moment in UTC, used by the countdown
  audience    TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','selected')),
  is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, code),
  UNIQUE (id, event_id),
  FOREIGN KEY (venue_id, event_id) REFERENCES venues(id, event_id)
) STRICT;
CREATE UNIQUE INDEX segments_one_primary_idx ON segments(event_id) WHERE is_primary = 1;

CREATE TABLE program_items (
  id           INTEGER PRIMARY KEY,
  segment_id   INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  start_local  TEXT NOT NULL CHECK (start_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  title_km     TEXT,
  title_en     TEXT NOT NULL,
  note_km      TEXT,
  note_en      TEXT,
  is_tentative INTEGER NOT NULL DEFAULT 0 CHECK (is_tentative IN (0,1)),
  is_highlight INTEGER NOT NULL DEFAULT 0 CHECK (is_highlight IN (0,1)),
  sort_order   INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX program_items_segment_idx ON program_items(segment_id, sort_order);

-- ---------------------------------------------------------------- guests

CREATE TABLE guests (
  id              INTEGER PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- 7 characters from a-z and 2-9 without i, l, o (31 symbols, about 27 billion codes)
  code            TEXT NOT NULL CHECK (length(code) = 7 AND code NOT GLOB '*[^a-hj-km-np-z2-9]*'),
  display_name    TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  honorific       TEXT,
  group_label     TEXT,
  host_note       TEXT,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','admin')),
  is_disabled     INTEGER NOT NULL DEFAULT 0 CHECK (is_disabled IN (0,1)),
  first_opened_at TEXT,
  last_opened_at  TEXT,
  open_count      INTEGER NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at      TEXT,
  UNIQUE (event_id, code),
  UNIQUE (id, event_id)
) STRICT;
CREATE INDEX guests_event_idx ON guests(event_id, deleted_at);

-- Only used for segments whose audience is 'selected'.
CREATE TABLE guest_segments (
  guest_id    INTEGER NOT NULL,
  segment_id  INTEGER NOT NULL,
  event_id    INTEGER NOT NULL,
  PRIMARY KEY (guest_id, segment_id),
  FOREIGN KEY (guest_id,   event_id) REFERENCES guests(id,   event_id) ON DELETE CASCADE,
  FOREIGN KEY (segment_id, event_id) REFERENCES segments(id, event_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX guest_segments_segment_idx ON guest_segments(segment_id);

-- ---------------------------------------------------------------- guest actions

CREATE TABLE rsvps (
  guest_id     INTEGER NOT NULL,
  segment_id   INTEGER NOT NULL,
  event_id     INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('yes','no')),
  party_size   INTEGER NOT NULL CHECK (party_size BETWEEN 0 AND 50),   -- sanity cap against typos, not a seat limit
  responded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (guest_id, segment_id),
  CHECK ((status = 'yes' AND party_size >= 1) OR (status = 'no' AND party_size = 0)),
  FOREIGN KEY (guest_id,   event_id) REFERENCES guests(id,   event_id) ON DELETE CASCADE,
  FOREIGN KEY (segment_id, event_id) REFERENCES segments(id, event_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX rsvps_event_idx ON rsvps(event_id, status);

CREATE TRIGGER rsvps_rules_ins BEFORE INSERT ON rsvps
BEGIN
  SELECT RAISE(ABORT, 'rsvp is not available for this event')
  WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.status = 'live' AND e.rsvp_enabled = 1);
END;

CREATE TRIGGER rsvps_rules_upd BEFORE UPDATE ON rsvps
BEGIN
  SELECT RAISE(ABORT, 'rsvp is not available for this event')
  WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.status = 'live' AND e.rsvp_enabled = 1);
END;

CREATE TABLE wishes (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id     INTEGER,                         -- NULL when sent through a general link
  author_name  TEXT NOT NULL CHECK (length(trim(author_name)) BETWEEN 1 AND 80),
  message      TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 500),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  moderated_at TEXT,
  moderated_by TEXT,
  FOREIGN KEY (guest_id, event_id) REFERENCES guests(id, event_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX wishes_wall_idx  ON wishes(event_id, status, created_at);
CREATE INDEX wishes_guest_idx ON wishes(guest_id);

CREATE TRIGGER wishes_rules BEFORE INSERT ON wishes
BEGIN
  SELECT RAISE(ABORT, 'wishes are closed for this event')
  WHERE NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.id = NEW.event_id AND e.status = 'live' AND e.wishes_enabled = 1
      AND (e.wishes_open_at IS NULL OR e.wishes_open_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      AND e.links_expire_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now'));
  SELECT RAISE(ABORT, 'this guest link cannot send wishes')
  WHERE NEW.guest_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM guests g WHERE g.id = NEW.guest_id AND g.is_disabled = 0 AND g.deleted_at IS NULL);
  SELECT RAISE(ABORT, 'wish limit reached for this guest')
  WHERE NEW.guest_id IS NOT NULL
    AND (SELECT COUNT(*) FROM wishes w WHERE w.guest_id = NEW.guest_id)
        >= (SELECT max_wishes_per_guest FROM events WHERE id = NEW.event_id);
  SELECT RAISE(ABORT, 'a wish must start as pending when approval is required')
  WHERE NEW.status <> 'pending' AND (SELECT wishes_need_approval FROM events WHERE id = NEW.event_id) = 1;
END;

-- The photo files live in R2. This table holds one small record per file.
CREATE TABLE photos (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id      INTEGER,                        -- NULL for uploads from the event QR code
  source        TEXT NOT NULL CHECK (source IN ('guest_link','event_qr')),
  uploader_name TEXT CHECK (uploader_name IS NULL OR length(uploader_name) <= 80),
  uploader_key  TEXT NOT NULL CHECK (length(uploader_key) BETWEEN 16 AND 64),  -- random id kept in the phone's browser
  r2_key        TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL CHECK (mime = 'image/jpeg'),
  bytes         INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 2621440),
  width         INTEGER NOT NULL CHECK (width  > 0),
  height        INTEGER NOT NULL CHECK (height > 0),
  sha256        TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK ((source = 'guest_link' AND guest_id IS NOT NULL) OR (source = 'event_qr' AND guest_id IS NULL)),
  FOREIGN KEY (guest_id, event_id) REFERENCES guests(id, event_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX photos_event_idx    ON photos(event_id, uploaded_at);
CREATE INDEX photos_guest_idx    ON photos(guest_id);
CREATE INDEX photos_uploader_idx ON photos(event_id, uploader_key);

-- The delete date is not copied onto each photo. It comes from events.photos_delete_at,
-- so if an event date moves, its photos follow.
CREATE TRIGGER photos_rules BEFORE INSERT ON photos
BEGIN
  SELECT RAISE(ABORT, 'uploads are closed for this event')
  WHERE NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.id = NEW.event_id AND e.status = 'live' AND e.photos_enabled = 1
      AND e.photos_open_at  <= strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND e.links_expire_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now'));
  SELECT RAISE(ABORT, 'this guest link cannot upload')
  WHERE NEW.guest_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM guests g WHERE g.id = NEW.guest_id AND g.is_disabled = 0 AND g.deleted_at IS NULL);
  SELECT RAISE(ABORT, 'photo limit reached')
  WHERE (NEW.guest_id IS NOT NULL
         AND (SELECT COUNT(*) FROM photos p WHERE p.guest_id = NEW.guest_id)
             >= (SELECT max_photos_per_guest FROM events WHERE id = NEW.event_id))
     OR (NEW.guest_id IS NULL
         AND (SELECT COUNT(*) FROM photos p
              WHERE p.event_id = NEW.event_id AND p.guest_id IS NULL AND p.uploader_key = NEW.uploader_key)
             >= (SELECT max_photos_per_guest FROM events WHERE id = NEW.event_id));
END;

-- ---------------------------------------------------------------- gift QR (security critical)

-- Rows are never edited. A change means a new row, so the history is complete.
CREATE TABLE gift_accounts (
  id                      INTEGER PRIMARY KEY,
  event_id                INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label                   TEXT NOT NULL DEFAULT 'wedding gift',
  bank                    TEXT NOT NULL CHECK (bank IN ('ABA','Wing','ACLEDA','Canadia','Bakong','Other')),
  account_name            TEXT NOT NULL CHECK (length(trim(account_name)) > 0),
  account_number          TEXT,
  qr_key                  TEXT NOT NULL,        -- where the QR image is stored
  qr_sha256               TEXT NOT NULL CHECK (length(qr_sha256) = 64 AND qr_sha256 NOT GLOB '*[^0-9a-f]*'),
  is_active               INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  confirmed_by_customer_at TEXT,                -- when the couple confirmed it from their own number
  confirmed_via           TEXT CHECK (confirmed_via IS NULL OR confirmed_via IN ('call','telegram','in_person','other')),
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  retired_at              TEXT,
  -- a QR cannot go live until the customer has confirmed it
  CHECK (is_active = 0 OR (confirmed_by_customer_at IS NOT NULL AND confirmed_via IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX gift_accounts_one_active_idx ON gift_accounts(event_id, label) WHERE is_active = 1;

CREATE TRIGGER gift_accounts_immutable BEFORE UPDATE OF
  event_id, bank, account_name, account_number, qr_key, qr_sha256, created_at ON gift_accounts
BEGIN SELECT RAISE(ABORT, 'gift account details cannot be edited; add a new row'); END;

CREATE TRIGGER gift_accounts_no_delete BEFORE DELETE ON gift_accounts
BEGIN SELECT RAISE(ABORT, 'gift accounts cannot be deleted; retire them'); END;

-- Result of the daily fingerprint check of the live QR image.
CREATE TABLE qr_checks (
  id               INTEGER PRIMARY KEY,
  gift_account_id  INTEGER NOT NULL REFERENCES gift_accounts(id),
  checked_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  observed_sha256  TEXT NOT NULL CHECK (length(observed_sha256) = 64 AND observed_sha256 NOT GLOB '*[^0-9a-f]*'),
  ok               INTEGER NOT NULL CHECK (ok IN (0,1)),
  alert_sent_at    TEXT
) STRICT;
CREATE INDEX qr_checks_account_idx ON qr_checks(gift_account_id, checked_at);

-- ---------------------------------------------------------------- audit trail

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER REFERENCES events(id),
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('admin','host','guest','system')),
  actor_ref    TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    INTEGER,
  detail       TEXT CHECK (detail IS NULL OR json_valid(detail))
) STRICT;
CREATE INDEX audit_event_idx  ON audit_log(event_id, at);
CREATE INDEX audit_action_idx ON audit_log(action, at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'the audit log is append only'); END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'the audit log is append only'); END;

-- ---------------------------------------------------------------- views the app reads

CREATE VIEW v_guest_list AS
SELECT g.id, g.event_id, g.display_name, g.code, g.group_label, g.is_disabled,
       g.first_opened_at IS NOT NULL AS opened,
       g.open_count,
       (SELECT COALESCE(MAX(r.party_size), 0) FROM rsvps r WHERE r.guest_id = g.id AND r.status = 'yes') AS people_confirmed,
       (SELECT COUNT(*) FROM wishes w WHERE w.guest_id = g.id) AS wishes_sent,
       (SELECT COUNT(*) FROM photos p WHERE p.guest_id = g.id) AS photos_sent
FROM guests g
WHERE g.deleted_at IS NULL;

CREATE VIEW v_wish_wall AS
SELECT id, event_id, author_name, message, created_at
FROM wishes
WHERE status = 'approved';

-- Photos that the daily job must remove from R2 and from this table.
CREATE VIEW v_photos_due_for_deletion AS
SELECT p.id, p.event_id, p.r2_key
FROM photos p
JOIN events e ON e.id = p.event_id
WHERE e.photos_delete_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now');
