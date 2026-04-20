/**
 * Unit tests for the JCS canonicalization layer.
 *
 * These verify the byte-for-byte properties the chain integrity depends on:
 *   1. Field order doesn't matter — swapping the input field order produces
 *      the same canonical bytes (and therefore the same hash).
 *   2. Body commitment matches the documented formula.
 *   3. Genesis seed matches the documented formula.
 *   4. The same JSON object always serializes to the same bytes.
 */
import { describe, expect, it } from "vitest";
import {
  bodyCommitment,
  entryHash,
  genesisSeed,
  jcsBytes,
  sha256Hex,
} from "../src/lib/jcs";

describe("jcs", () => {
  it("canonicalizes objects with sorted keys regardless of input order", () => {
    const a = { z: 1, a: 2, m: { y: 3, x: 4 } };
    const b = { a: 2, m: { x: 4, y: 3 }, z: 1 };
    expect(jcsBytes(a).toString("utf8")).toEqual(jcsBytes(b).toString("utf8"));
    expect(jcsBytes(a).toString("utf8")).toEqual('{"a":2,"m":{"x":4,"y":3},"z":1}');
  });

  it("entryHash is independent of key insertion order", () => {
    const e1 = {
      id: "01H",
      page: "p",
      seq: 0,
      kind: "entry" as const,
      parent: null,
      body_commitment: "sha256:" + "0".repeat(64),
      created_at: "2026-04-20T00:00:00.000Z",
      prev_hash: "sha256:" + "1".repeat(64),
    };
    const e2 = {
      prev_hash: "sha256:" + "1".repeat(64),
      created_at: "2026-04-20T00:00:00.000Z",
      body_commitment: "sha256:" + "0".repeat(64),
      parent: null,
      kind: "entry" as const,
      seq: 0,
      page: "p",
      id: "01H",
    };
    expect(entryHash(e1).hash).toEqual(entryHash(e2).hash);
  });

  it("body_commitment matches H(salt || body) per AGENTS.md §2", () => {
    const salt = Buffer.alloc(32, 0x42);
    const body = "hello world";
    const expected = sha256Hex(Buffer.concat([salt, Buffer.from(body, "utf8")]));
    expect(bodyCommitment(salt, body)).toEqual(expected);
  });

  it("rejects salts that are not 32 bytes", () => {
    expect(() => bodyCommitment(Buffer.alloc(16), "x")).toThrow(/32 bytes/);
  });

  it("genesis seed matches SHA-256(\"genesis|<slug>|<created_at>\")", () => {
    const slug = "advisors";
    const ts = "2026-04-20T18:00:00.000Z";
    const expected = sha256Hex(Buffer.from(`genesis|${slug}|${ts}`, "utf8"));
    expect(genesisSeed(slug, ts)).toEqual(expected);
  });

  it("sha256Hex format is 'sha256:' + 64 lowercase hex", () => {
    const h = sha256Hex(Buffer.from("anything"));
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
