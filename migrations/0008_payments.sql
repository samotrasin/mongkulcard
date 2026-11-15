-- Packages, orders and KHQR payments (checked automatically with Bakong).

-- What customers can buy. A package with no price is not for sale yet.
CREATE TABLE packages (
  code          TEXT PRIMARY KEY CHECK (code NOT GLOB '*[^a-z0-9_-]*' AND length(code) BETWEEN 2 AND 30),
  name_en       TEXT NOT NULL,
  name_km       TEXT NOT NULL,
  price_cents   INTEGER CHECK (price_cents IS NULL OR price_cents BETWEEN 1 AND 100000),  -- USD cents
  named_guests  INTEGER NOT NULL DEFAULT 300 CHECK (named_guests BETWEEN 0 AND 5000),
  photos        INTEGER NOT NULL DEFAULT 10 CHECK (photos BETWEEN 0 AND 100),
  features      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(features)),
  admin_only    INTEGER NOT NULL DEFAULT 0 CHECK (admin_only IN (0,1)),   -- test package: only Samotra sees it
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort          INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO packages (code, name_en, name_km, price_cents, named_guests, photos, features, admin_only, sort) VALUES
  ('essential', 'Essential', 'Essential', NULL, 300,  5,  '["khmer_english","guest_links"]', 0, 1),
  ('premium',   'Premium',   'Premium',   NULL, 600,  10, '["khmer_english","guest_links","cinematic","photo_sharing","music","rsvp"]', 0, 2),
  ('signature', 'Signature', 'Signature', NULL, 1000, 20, '["khmer_english","guest_links","cinematic","photo_sharing","music","rsvp","chinese"]', 0, 3),
  ('test',      'Test payment', 'សាកល្បង', 10, 1000, 20, '["test"]', 1, 9);

CREATE TABLE orders (
  id              INTEGER PRIMARY KEY,
  public_id       TEXT NOT NULL UNIQUE CHECK (length(public_id) = 10 AND public_id NOT GLOB '*[^a-z0-9]*'),
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  invitation_id   INTEGER NOT NULL REFERENCES invitations(id) ON DELETE RESTRICT,
  package_code    TEXT NOT NULL REFERENCES packages(code),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  currency        TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','KHR')),
  bill_no         TEXT NOT NULL UNIQUE,
  to_account      TEXT NOT NULL,                 -- the Bakong account the QR pays into
  qr              TEXT NOT NULL,
  md5             TEXT NOT NULL UNIQUE CHECK (length(md5) = 32),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','paid','expired','rejected','cancelled')),
  -- claimed  = customer pressed "I paid with ABA", waiting for Samotra
  -- rejected = Samotra pressed "Not received"
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at      TEXT NOT NULL,
  paid_at         TEXT,
  paid_by         TEXT CHECK (paid_by IS NULL OR paid_by IN ('bakong','admin')),
  bakong_hash     TEXT,
  from_account    TEXT,
  last_checked_at TEXT,
  check_count     INTEGER NOT NULL DEFAULT 0,
  claimed_at      TEXT
) STRICT;
CREATE INDEX orders_invitation_idx ON orders(invitation_id, status);
CREATE INDEX orders_account_idx ON orders(account_id, created_at);
CREATE INDEX orders_status_idx ON orders(status, expires_at);

-- The package an invitation was bought with (set when its order is paid).
ALTER TABLE invitations ADD COLUMN package_code TEXT REFERENCES packages(code);
ALTER TABLE invitations ADD COLUMN paid_at TEXT;

-- Small settings and reminders (for example: last Bakong token reminder).
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
