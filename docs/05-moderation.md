# Moderation policy

## Mechanism

- **Community flag** = a row in the off-chain `flags` table. Rate-limited per IP. Auto-hide threshold: ≥ 3 distinct-IP flags within 24 h on the same target → renderer wraps the entry in a "flagged, click to view" interstitial pending review.
- **Admin queue** at `/admin/queue` (GitHub OAuth, allow-list `da03`).
  - **Dismiss** → `moderation_log` row + auto-hide cleared. Off-chain.
  - **Erase** → on-chain `kind="moderation"` entry + `DELETE FROM entry_bodies WHERE entry_id=?` + `moderation_log` row.
- **Public moderation log** at `/p/<slug>/moderation` lists every action (erasure, dismissal, denied takedown) with reason. The on-chain `kind=moderation` entries are the tamper-evident half; the off-chain `moderation_log` rows are the human-readable index.
- **Visible deletion-rejection log** — the same `/p/<slug>/moderation` page also lists denied takedown requests with the reason for denial, so refusals aren't silent either.

## Slug rules

Per `server/src/lib/slug.ts`:

- Format: `^[a-z0-9][a-z0-9-]{1,48}$`.
- Reserved namespace (see `RESERVED_SLUGS` in slug.ts; matches `AGENTS.md` §8).
- Profanity / lookalike block list (small for v0; expand on encounter).
- **Slugs reserved forever** — no auto-release.
- **Name-shaped manual review:** any newly-claimed slug matching `^[a-z]+-[a-z]+$` (looks like a person's name, e.g. `prof-jane-doe`) is created with `status=queued_review`. Page accepts no entries until an admin promotes it to `live`.

## SLO

- Admin reviews flagged content within **7 days** (research-demo SLO). Production-grade 48 h SLO is a v1 follow-up.
- If the flag queue exceeds 50 in any 24 h window, recruit a 2nd admin.

## Multi-sig

Deferred until a 2nd admin onboards. v0 has bus-factor 1 by acknowledged choice.

## Erasure flow (the operator's runbook)

1. Receive an erasure request via the contact email.
2. Triage:
   - Is the requester the original poster? Was the post about an identifiable third party? Is there evidence of harm (doxing, harassment, illegal content)?
   - For obvious cases (CSAM, doxing, threats of violence), erase immediately with reason = "harassment" / "illegal content" / etc.
   - For ambiguous cases, reply for clarification.
3. Click "Erase" in the admin queue:
   - `DELETE FROM entry_bodies WHERE entry_id = X`.
   - Append on-chain `kind="moderation"` entry with `parent=X`, body explaining the action.
   - Insert `moderation_log` row.
4. Reply to the requester confirming the action.
5. (Phase D) Push the updated `<slug>.jsonl` to the HuggingFace dataset within the next hourly mirror cycle. The HF Git history will still contain the body in past commits — we may force-push to remove it on legitimate erasure requests, depending on the case.

Target SLA: 7 days from request to erasure.

## Denial runbook

For requests we won't act on (e.g. a public figure objecting to legitimate criticism, or content we judge to be substantive feedback even if unflattering):

1. Insert `moderation_log` row with `action='deny_takedown'` and a one-sentence reason.
2. Reply to the requester explaining the decision.
3. The denial appears on `/p/<slug>/moderation` so the refusal isn't silent.
