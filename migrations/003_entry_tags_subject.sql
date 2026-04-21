-- 003_entry_tags_subject.sql — add subject + relevance to per-entry metadata.
--
-- The previous schema (migration 002) stored only a flat tag list per entry,
-- which made the AI view a tag cloud. The user wants a directory-style view
-- like the source Google Doc: grouped by "Institution · Person" (advisors)
-- or "Company · Internship" (internships) or "Firm name" (lawyers).
--
-- We also want to flag obviously-off-topic / garbage entries so they can be
-- collapsed by default in the UI.
--
-- Strategy: drop and recreate entry_tags. We're early enough that only
-- /p/demo has cached tags; re-extracting it is ~$0.0003 of LLM spend.

BEGIN;

DROP TABLE IF EXISTS entry_tags;

CREATE TABLE entry_tags (
    entry_id          TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    subject           TEXT,                       -- "MIT · Prof. Smith", or null if no clear single subject
    tags              JSONB NOT NULL DEFAULT '[]', -- topical tags, lowercase noun phrases
    relevant          BOOLEAN NOT NULL DEFAULT TRUE,
    relevance_reason  TEXT,                       -- only set when relevant=false
    extracted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    model             TEXT NOT NULL,
    prompt_version    TEXT NOT NULL,
    cost_usd          NUMERIC(10, 6) NOT NULL DEFAULT 0
);

CREATE INDEX entry_tags_tags_gin ON entry_tags USING GIN (tags);
CREATE INDEX entry_tags_subject_idx ON entry_tags (subject)
    WHERE subject IS NOT NULL;
CREATE INDEX entry_tags_relevant_idx ON entry_tags (relevant)
    WHERE relevant = FALSE;

INSERT INTO schema_migrations (version) VALUES ('003_entry_tags_subject');

COMMIT;
