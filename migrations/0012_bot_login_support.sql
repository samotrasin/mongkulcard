-- MongkulCard: sign in through the MongkulCard bot (works inside Facebook / Messenger),
-- and customer chat through the bot ("MongkulCard Service").

-- A sign-in started on the website. The page opens t.me/<bot>?start=login_<code>;
-- the customer taps Start, then "Yes, sign me in"; the page sees it and signs in.
CREATE TABLE IF NOT EXISTS login_requests (
  id           INTEGER PRIMARY KEY,
  code_hash    TEXT NOT NULL UNIQUE,          -- sha256 of the code in the Telegram link
  nonce_hash   TEXT NOT NULL,                 -- sha256 of the browser's private cookie
  telegram_id  INTEGER,                       -- who confirmed in Telegram
  account_id   INTEGER REFERENCES accounts(id),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','asked','confirmed','used','refused')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_requests_expires ON login_requests(expires_at);

-- Customer chat: each message forwarded to Samotra remembers which customer it came from,
-- so his reply in Telegram goes back to the right person.
CREATE TABLE IF NOT EXISTS support_messages (
  id               INTEGER PRIMARY KEY,
  customer_chat_id INTEGER NOT NULL,
  admin_message_id INTEGER,                   -- the copy in Samotra's chat (NULL if not forwarded)
  direction        TEXT NOT NULL CHECK (direction IN ('in','out')),
  text             TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS support_admin_msg ON support_messages(admin_message_id);
CREATE INDEX IF NOT EXISTS support_customer ON support_messages(customer_chat_id, created_at);
