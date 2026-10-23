-- Host login: one username + password per customer. Sessions keep only a hash of the cookie value.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  username      TEXT NOT NULL UNIQUE
                  CHECK (length(username) BETWEEN 3 AND 30 AND username NOT GLOB '*[^a-z0-9._-]*'),
  pw_hash       TEXT NOT NULL,                 -- pbkdf2$iterations$salt$hash
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  pw_changed_at TEXT,
  last_login_at TEXT,
  disabled_at   TEXT
) STRICT;
CREATE INDEX users_customer_idx ON users(customer_id);

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
) STRICT;
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Failed sign-ins only. Used to slow down password guessing.
CREATE TABLE login_attempts (
  id       INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  ip       TEXT NOT NULL,
  at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX login_attempts_user_idx ON login_attempts(username, at);
CREATE INDEX login_attempts_ip_idx   ON login_attempts(ip, at);

INSERT OR IGNORE INTO reserved_slugs (slug) VALUES
  ('manage'),('session'),('account'),('dashboard'),('signup'),('register'),('password'),('settings');
