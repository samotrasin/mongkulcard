-- Guests can also get their invitation in Chinese (中文).
-- SQLite cannot change the old km/en check on guests.language without rebuilding the table (and every table that points to it),
-- so a separate flag marks a Chinese link: lang_zh = 1 means the invitation opens in Chinese.
ALTER TABLE guests ADD COLUMN lang_zh INTEGER NOT NULL DEFAULT 0 CHECK (lang_zh IN (0,1));
