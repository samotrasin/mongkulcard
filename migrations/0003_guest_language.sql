-- Each guest link opens in the language the host chose for that guest (the guest can still switch inside the invitation).
ALTER TABLE guests ADD COLUMN language TEXT NOT NULL DEFAULT 'km' CHECK (language IN ('km','en'));
