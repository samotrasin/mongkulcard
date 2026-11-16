-- Ly Chhayly & Ma Meyhuy: open guest photo sharing now so Samotra can test it (it was set to open on 19 Dec 2026).
-- To close it again until the wedding: photos_open_at = '2026-12-18T17:00:00Z' (19 Dec, 00:00 Phnom Penh).
UPDATE events SET photos_enabled = 1, photos_open_at = '2026-11-16T00:00:00Z' WHERE slug = 'lychhayly';
