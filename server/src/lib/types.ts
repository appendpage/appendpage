/**
 * Shared types and Zod schemas for the v0 wire format.
 *
 * The on-chain entry has 9 fields. Posters write the body; the server fills
 * everything else. See AGENTS.md §2 for the human-readable spec.
 */
import { z } from "zod";

// ---------- on-chain entry (the canonical wire format) ----------

export const KIND = ["entry", "moderation"] as const;
export type Kind = (typeof KIND)[number];

/** Pattern for the per-page slug. Matches the SQL CHECK constraint. */
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** Pattern for entry IDs (ULID). */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Pattern for our wire-format hashes: "sha256:" + 64 lowercase hex. */
export const HASH_REGEX = /^sha256:[0-9a-f]{64}$/;

/**
 * The public on-chain entry. This is the JSON object stored in `entries.canonical_bytes`
 * (with the `hash` field appended) and emitted as one line of `/p/<slug>/raw`.
 */
export const ChainEntrySchema = z.object({
  id: z.string().regex(ULID_REGEX),
  page: z.string().regex(SLUG_REGEX),
  seq: z.number().int().nonnegative(),
  kind: z.enum(KIND),
  parent: z.string().regex(ULID_REGEX).nullable(),
  body_commitment: z.string().regex(HASH_REGEX),
  created_at: z.string().datetime({ offset: false }), // ISO 8601 UTC, no offset
  prev_hash: z.string().regex(HASH_REGEX),
  hash: z.string().regex(HASH_REGEX),
});
export type ChainEntry = z.infer<typeof ChainEntrySchema>;

// ---------- API request/response schemas ----------

/** Body of POST /p/:slug/entries. Single-textarea compose. */
export const PostEntryRequestSchema = z.object({
  body: z.string().min(1).max(4096),
  parent_id: z.string().regex(ULID_REGEX).optional(),
});
export type PostEntryRequest = z.infer<typeof PostEntryRequestSchema>;

/** Body of POST /pages. */
export const CreatePageRequestSchema = z.object({
  slug: z.string().regex(SLUG_REGEX),
  description: z.string().max(280).optional(),
  default_view_prompt: z.string().max(2000).optional(),
});
export type CreatePageRequest = z.infer<typeof CreatePageRequestSchema>;

/** Response from /status. */
export const StatusResponseSchema = z.object({
  ok: z.literal(true),
  uptime_seconds: z.number().nonnegative(),
  last_anchor_at: z.string().datetime({ offset: false }).nullable(),
  free_disk_bytes: z.number().int().nonnegative().nullable(),
  llm_budget_remaining_today_usd: z.number().nonnegative().nullable(),
  version: z.string(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ---------- internal helpers ----------

/**
 * Construct the on-chain entry from its components. The result is byte-stable
 * if the inputs are — the field order is enforced by JCS canonicalization at
 * hash time, so it doesn't matter that JavaScript object literal order is
 * not part of the language spec for non-numeric keys (it is in practice but
 * we never rely on it).
 */
export function buildChainEntry(args: {
  id: string;
  page: string;
  seq: number;
  kind: Kind;
  parent: string | null;
  bodyCommitment: string;
  createdAtIso: string;
  prevHash: string;
}): Omit<ChainEntry, "hash"> {
  return {
    id: args.id,
    page: args.page,
    seq: args.seq,
    kind: args.kind,
    parent: args.parent,
    body_commitment: args.bodyCommitment,
    created_at: args.createdAtIso,
    prev_hash: args.prevHash,
  };
}

/** Errors thrown by the chain layer that map to specific HTTP responses. */
export class ChainError extends Error {
  constructor(
    public readonly code:
      | "page_not_found"
      | "page_queued_review"
      | "parent_not_found"
      | "parent_wrong_page"
      | "head_mismatch"
      | "body_too_long"
      | "moderation_only_admin"
      | "concurrent_append_lost",
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ChainError";
  }
}
