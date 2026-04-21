-- 002_entry_tags.sql — per-entry LLM-extracted tags.
--
-- Replaces the page-level view_json approach (table view_cache stays for
-- backward compat but is no longer the primary AI view source).
--
-- Tags never expire: an entry's body is immutable once posted, so its tags
-- are too. On first AI-view render of a page, any uncached entries get
-- batch-extracted in the background; subsequent renders are instant.

BEGIN;

CREATE TABLE entry_tags (
    entry_id        TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    tags            JSONB NOT NULL,             -- ["Prof. Marlow", "Westgate", "advising"]
    extracted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    model           TEXT NOT NULL,
    prompt_version  TEXT NOT NULL,
    cost_usd        NUMERIC(10, 6) NOT NULL DEFAULT 0
);

-- GIN index on the tags JSONB so "tag = X across this page" is fast.
CREATE INDEX entry_tags_tags_gin ON entry_tags USING GIN (tags);

INSERT INTO schema_migrations (version) VALUES ('002_entry_tags');

COMMIT;
