-- 004_rate_limit_config.sql — runtime-editable rate limit thresholds.
--
-- Rows here are read by the app every 30s and applied in the Redis-based
-- limiter. Update any value via UPDATE; the app picks it up without a
-- restart. Keep keys stable; lib/rate-limit.ts references them.

BEGIN;

CREATE TABLE rate_limit_config (
    key         TEXT PRIMARY KEY,
    value       INTEGER NOT NULL CHECK (value >= 0),
    description TEXT NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO rate_limit_config (key, value, description) VALUES
    ('entries_per_minute', 30,  'POST /p/<slug>/entries per IP per 60s'),
    ('entries_per_hour',   300, 'POST /p/<slug>/entries per IP per 3600s'),
    ('pages_per_hour',     10,  'POST /pages per IP per 3600s'),
    ('pages_per_day',      40,  'POST /pages per IP per 86400s');

INSERT INTO schema_migrations (version) VALUES ('004_rate_limit_config');

COMMIT;
