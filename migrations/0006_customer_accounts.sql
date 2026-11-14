-- Self-service customer accounts (the couples who make their own invitation on mongkulcard.com).
-- Separate from the host login in 0002 (users/sessions), which keeps serving /login and /manage.
-- Sign-in is with Telegram for now; Google can be added later (google_sub).

CREATE TABLE accounts (
  id                INTEGER PRIMARY KEY,
  telegram_id       INTEGER UNIQUE,                 -- Telegram's numeric user id (never changes)
  telegram_username TEXT,                           -- @name, can change, may be empty
  google_sub        TEXT UNIQUE,                    -- for Google sign-in later
  name              TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  photo_url         TEXT,
  phone             TEXT CHECK (phone IS NULL OR (length(phone) BETWEEN 6 AND 20 AND phone NOT GLOB '*[^0-9+]*')),
  phone_verified_at TEXT,                           -- set when the customer shares it with the MongkulCard bot
  bot_can_message   INTEGER NOT NULL DEFAULT 0 CHECK (bot_can_message IN (0,1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_login_at     TEXT,
  disabled_at       TEXT,
  CHECK (telegram_id IS NOT NULL OR google_sub IS NOT NULL)
) STRICT;

-- One row per signed-in browser. Only a hash of the cookie value is stored.
CREATE TABLE account_sessions (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
) STRICT;
CREATE INDEX account_sessions_account_idx ON account_sessions(account_id);

-- Addresses the website uses, so no event can take them.
INSERT OR IGNORE INTO reserved_slugs (slug) VALUES
  ('signin'),('auth'),('tg'),('preview'),('site'),('me'),('my'),('create'),('editor'),('checkout'),
  ('order'),('orders'),('pay'),('payment'),('invitations'),('invite'),('blog'),('faq'),('t');
