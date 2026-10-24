BEGIN;

-- Private requests, deliberately separate from the public append-only chain.
CREATE TABLE moderation_reports (
    id UUID PRIMARY KEY,
    ordinal BIGSERIAL UNIQUE NOT NULL,
    entry_id TEXT NOT NULL REFERENCES entries(id),
    reason TEXT NOT NULL CHECK (reason IN ('harassment', 'privacy', 'misleading', 'spam', 'other')),
    details TEXT NOT NULL DEFAULT '' CHECK (char_length(details) <= 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'kept', 'withheld')),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,
    CHECK ((status = 'pending') = (resolved_at IS NULL AND resolved_by IS NULL))
);
CREATE INDEX moderation_reports_pending ON moderation_reports (entry_id, ordinal) WHERE status = 'pending';

INSERT INTO rate_limit_config (key, value, description) VALUES
    ('reports_per_minute', 10, 'Moderation reports per IP per 60s'),
    ('reports_per_hour', 40, 'Moderation reports per IP per 3600s'),
    ('admin_login_per_minute', 5, 'Admin sign-in attempts per IP per 60s'),
    ('admin_login_per_hour', 30, 'Admin sign-in attempts per IP per 3600s');

INSERT INTO schema_migrations (version) VALUES ('007_moderation_reports');
COMMIT;
