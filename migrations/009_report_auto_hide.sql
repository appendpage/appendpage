BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE entry_bodies ADD COLUMN withheld_pending_review BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE entry_bodies ADD CONSTRAINT pending_review_requires_withholding
    CHECK (NOT withheld_pending_review OR erased_at IS NOT NULL);

-- Recognize temporary containment performed with the previous moderation code.
UPDATE entry_bodies b SET withheld_pending_review = true
 WHERE b.erased_at IS NOT NULL
   AND b.erased_reason = 'Content temporarily hidden pending moderation review.'
   AND EXISTS (SELECT 1 FROM moderation_reports r WHERE r.entry_id = b.entry_id AND r.status = 'pending');

ALTER TABLE moderation_log DROP CONSTRAINT moderation_log_action_check;
ALTER TABLE moderation_log ADD CONSTRAINT moderation_log_action_check
    CHECK (action IN ('erase', 'dismiss', 'deny_takedown', 'temporarily_withhold', 'restore'));

INSERT INTO schema_migrations (version) VALUES ('009_report_auto_hide');
COMMIT;
