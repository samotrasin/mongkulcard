-- Ly Chhayly & Ma Meyhuy: mark the wedding as live so guests' RSVP replies are accepted
-- (the database only takes replies for live events with RSVP switched on).
UPDATE events SET status = 'live', rsvp_enabled = 1 WHERE slug = 'lychhayly' AND status IN ('draft','live');
