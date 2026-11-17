-- Sign-in: the website shows a number; in Telegram the customer taps the same number (stops "tap Yes" phishing).
ALTER TABLE login_requests ADD COLUMN check_num INTEGER;
-- Limit how many sign-in codes one connection can ask for.
ALTER TABLE login_requests ADD COLUMN ip_hash TEXT;
CREATE INDEX IF NOT EXISTS login_requests_ip ON login_requests(ip_hash, created_at);
-- Customer chat: remember the customer's own message, so messages that arrived before Samotra
-- was connected can still be passed to him later (photos included).
ALTER TABLE support_messages ADD COLUMN customer_message_id INTEGER;
ALTER TABLE support_messages ADD COLUMN customer_name TEXT;
CREATE INDEX IF NOT EXISTS support_waiting ON support_messages(direction, admin_message_id);
