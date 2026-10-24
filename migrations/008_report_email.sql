BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The saved report is also its durable notification job. No report text is
-- copied into a separate queue or email payload.
ALTER TABLE moderation_reports ADD COLUMN notified_at TIMESTAMPTZ;
CREATE INDEX moderation_reports_email_pending ON moderation_reports (ordinal)
    WHERE status = 'pending' AND notified_at IS NULL;

CREATE TABLE report_email_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    last_sent_at TIMESTAMPTZ
);
INSERT INTO report_email_state (singleton) VALUES (true);

INSERT INTO schema_migrations (version) VALUES ('008_report_email');
COMMIT;
