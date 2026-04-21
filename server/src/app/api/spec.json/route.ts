/**
 * GET /api/spec.json — machine-readable spec for the v0 wire format and HTTP API.
 *
 * The frontend (`appendpage/web`) codegens types from this at build time, so
 * this is the single source of truth for the wire shape.
 *
 * The schema is hand-written rather than generated from Zod because:
 *   1. Zod-to-JSON-Schema introduces extra fields and is fiddly.
 *   2. The schema is small and stable.
 *   3. Hand-written keeps it human-readable for AGENTS.md cross-references.
 */
import { NextResponse } from "next/server";

const SPEC = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "append.page wire format and HTTP API (v0)",
  version: "0.1.0",
  spec_url: "https://append.page/AGENTS.md",
  source: "https://github.com/appendpage/appendpage",
  definitions: {
    Hash: {
      type: "string",
      pattern: "^sha256:[0-9a-f]{64}$",
      description: "SHA-256 wire format: 'sha256:' + 64 lowercase hex digits.",
    },
    UlidId: {
      type: "string",
      pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
      description: "ULID — 26-char Crockford base32, time-ordered.",
    },
    Slug: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]{1,48}$",
      description: "Per-page slug. Reserved namespace lives in slug.ts.",
    },
    Kind: {
      type: "string",
      enum: ["entry", "moderation"],
      description: "'entry' = anyone-posted; 'moderation' = admin-issued (only for the admin queue).",
    },
    ChainEntry: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "page",
        "seq",
        "kind",
        "parent",
        "body_commitment",
        "created_at",
        "prev_hash",
        "hash",
      ],
      properties: {
        id: { $ref: "#/definitions/UlidId" },
        page: { $ref: "#/definitions/Slug" },
        seq: { type: "integer", minimum: 0 },
        kind: { $ref: "#/definitions/Kind" },
        parent: { oneOf: [{ $ref: "#/definitions/UlidId" }, { type: "null" }] },
        body_commitment: { $ref: "#/definitions/Hash" },
        created_at: {
          type: "string",
          format: "date-time",
          description: "ISO 8601 UTC timestamp; server-stamped.",
        },
        prev_hash: { $ref: "#/definitions/Hash" },
        hash: { $ref: "#/definitions/Hash" },
      },
      description:
        "The on-chain entry. Lines of GET /p/<slug>/raw are JCS-canonicalized instances of this schema.",
    },
  },
  endpoints: [
    {
      method: "POST",
      path: "/p/{slug}/entries",
      summary:
        "Append an entry to a page's chain. Rate-limited per IP; see /AGENTS.md §6.",
      request: {
        type: "object",
        additionalProperties: false,
        required: ["body"],
        properties: {
          body: { type: "string", minLength: 1, maxLength: 4096 },
          parent_id: { $ref: "#/definitions/UlidId" },
        },
      },
      response_201: {
        type: "object",
        properties: { entry: { $ref: "#/definitions/ChainEntry" } },
      },
      headers_in: {
        "Expect-Prev-Hash":
          "Optional; if supplied and != current head, returns 409 with {actual_head_hash}.",
      },
    },
    {
      method: "POST",
      path: "/pages",
      summary: "Create a new page. Rate-limited per IP.",
      request: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { $ref: "#/definitions/Slug" },
          description: { type: "string", maxLength: 280 },
        },
      },
      response_201: {
        type: "object",
        properties: {
          slug: { $ref: "#/definitions/Slug" },
          status: { type: "string", enum: ["live", "queued_review"] },
        },
      },
    },
    {
      method: "GET",
      path: "/p/{slug}/raw",
      summary:
        "Stream the chain as JSONL. Each line is a JCS-canonicalized ChainEntry. nginx-cached.",
      content_type: "application/x-ndjson",
    },
    {
      method: "GET",
      path: "/p/{slug}/anchor.txt",
      summary: "Current head_hash for one page (text/plain, single line).",
    },
    {
      method: "GET",
      path: "/anchor/latest.txt",
      summary:
        "Global {slug head_hash} listing, refreshed every 10 min. text/plain.",
    },
    {
      method: "GET",
      path: "/AGENTS.md",
      summary:
        "Wire format + API + fork-the-frontend guide, served as text/markdown.",
    },
    {
      method: "GET",
      path: "/api/spec.json",
      summary: "This document.",
    },
    {
      method: "GET",
      path: "/status",
      summary: "Liveness + budget + last-anchor JSON.",
    },
  ],
} as const;

export const dynamic = "force-static";
export const revalidate = 3600;

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(SPEC, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}
