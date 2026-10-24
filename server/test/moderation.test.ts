import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "../src/lib/db";
import { appendEntry, createPage } from "../src/lib/chain";
import { bodyCommitment, entryHash } from "../src/lib/jcs";
import { moderationCacheKey, moderationRevision, withholdEntries, withModerationGuard } from "../src/lib/moderation";
import { SECTION_PROMPT_VERSION, INTRO_PROMPT_VERSION } from "../src/lib/docview-v2";
import { TAG_PROMPT_VERSION } from "../src/lib/tags";
import { buildView, promptHash, defaultPromptFor } from "../src/lib/llm";
import { GET as single } from "../src/app/p/[slug]/e/[id]/route";
import { POST as bulk } from "../src/app/p/[slug]/bodies/route";
import { GET as bodiesFile } from "../src/app/p/[slug]/bodies.jsonl/route";
import { GET as archive } from "../src/app/p/[slug]/archive.zip/route";
import { GET as tags } from "../src/app/p/[slug]/tags/route";
import { GET as defaultView } from "../src/app/p/[slug]/views/default/route";
import { GET as docView } from "../src/app/p/[slug]/views/doc/route";
import { GET as section } from "../src/app/p/[slug]/views/doc/sections/[subject_key]/route";

vi.mock("../src/lib/llm", async (original) => ({
  ...await original<typeof import("../src/lib/llm")>(),
  buildView: vi.fn().mockResolvedValue({
    view: { sections: [] }, tokensUsed: 0, costUsd: 0, generationSeconds: 0,
  }),
}));
vi.mock("../src/lib/tags", async (original) => ({
  ...await original<typeof import("../src/lib/tags")>(),
  backgroundExtract: vi.fn(),
}));
// Simulate another worker already holding the doc-regeneration lock. These
// tests inspect visibility and must never call an external model.
vi.mock("../src/lib/redis", () => ({ redis: { set: vi.fn().mockResolvedValue(null) } }));

const testUrl = process.env.APPENDPAGE_TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error("Integration tests require a dedicated database ending in _test");
}

describe.skipIf(!testUrl)("reversible moderation (PostgreSQL integration)", () => {
  const schema = `moderation_test_${process.pid}_${Date.now()}`;
  const slug = "moderation-test";
  const reason = "Content withheld following moderation review.";
  const ctx = { params: Promise.resolve({ slug }) };
  const request = (suffix = "") => new NextRequest(`https://example.test/p/${slug}${suffix}`);
  let first: Awaited<ReturnType<typeof appendEntry>>["entry"];
  let second: typeof first;
  const provenance = { ipHash: "test", ipSaltId: 0, captchaId: "test", userAgentHash: "test" };
  const hide = (actor = "test-operator") => withholdEntries({
    slug, entryIds: [first.id, second.id], reason, actor,
  });

  beforeAll(async () => {
    const url = new URL(testUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.DOC_VIEW_V2 = "1";
    await pool.query(`CREATE SCHEMA ${schema}`);
    const dir = fileURLToPath(new URL("../../migrations/", import.meta.url));
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) {
      await pool.query(await readFile(`${dir}/${name}`, "utf8"));
    }
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE pages CASCADE");
    vi.clearAllMocks();
    await createPage({ slug, description: "test", defaultViewPrompt: null });
    first = (await appendEntry({ ...provenance, slug, body: "private original A", kind: "entry" })).entry;
    second = (await appendEntry({ ...provenance, slug, body: "private original B", kind: "entry", parentId: first.id })).entry;
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  it("retains originals and salts, appends records, and withholds every body download", async () => {
    const before = (await pool.query("SELECT entry_id,body,salt FROM entry_bodies ORDER BY entry_id")).rows;
    const records = await hide();
    expect(records).toHaveLength(2);
    expect(await moderationRevision(slug)).toBe(3);
    const after = (await pool.query("SELECT entry_id,body,salt FROM entry_bodies WHERE entry_id=ANY($1) ORDER BY entry_id", [[first.id, second.id]])).rows;
    expect(after).toEqual(before);
    const rows = (await pool.query("SELECT canonical_bytes FROM entries ORDER BY seq")).rows;
    const chain = rows.map((r) => JSON.parse(r.canonical_bytes.toString()));
    expect(chain.slice(0, 2)).toEqual([first, second]);
    for (let i = 0; i < chain.length; i++) {
      const { hash, ...rest } = chain[i];
      expect(entryHash(rest).hash).toBe(hash);
      if (i) expect(rest.prev_hash).toBe(chain[i - 1].hash);
    }
    expect(chain.slice(2).map((e) => [e.kind, e.parent])).toEqual([
      ["moderation", first.id], ["moderation", second.id],
    ]);
    for (const entry of [first, second]) {
      const res = await single(request(), { params: Promise.resolve({ slug, id: entry.id }) });
      const data = await res.json();
      expect(data).toMatchObject({ body: null, erased: true, erased_reason: reason });
      const original = before.find((row) => row.entry_id === entry.id)!;
      expect(data.salt).toBe(original.salt.toString("hex"));
      expect(bodyCommitment(original.salt, original.body)).toBe(entry.body_commitment);
    }
    const batch = await bulk(new NextRequest(`https://example.test/p/${slug}/bodies`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [first.id, second.id] }),
    }), ctx);
    expect((await batch.json()).entries.every((e: { body: unknown; erased: boolean }) => e.body === null && e.erased)).toBe(true);
    const jsonl = await (await bodiesFile(request(), ctx)).text();
    expect(jsonl).not.toContain("private original");
    const zip = unzipSync(new Uint8Array(await (await archive(request(), ctx)).arrayBuffer()));
    expect(strFromU8(zip["bodies.jsonl"]!)).not.toContain("private original");
    expect(strFromU8(zip["chain.jsonl"]!).trim().split("\n")).toHaveLength(4);
    await expect(hide()).rejects.toThrow("already withheld");
    expect((await pool.query("SELECT count(*)::int AS n FROM entries")).rows[0].n).toBe(4);
  });

  it("rolls back visibility and chain appends together on a midway failure", async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION test_fail_moderation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.actor = 'fail' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_moderation BEFORE INSERT ON moderation_log FOR EACH ROW EXECUTE FUNCTION test_fail_moderation();`);
    try {
      await expect(hide("fail")).rejects.toThrow("forced failure");
      expect((await pool.query("SELECT count(*)::int AS n FROM entries")).rows[0].n).toBe(2);
      expect((await pool.query("SELECT head_hash FROM pages WHERE slug=$1", [slug])).rows[0].head_hash).toBe(second.hash);
      expect((await pool.query("SELECT count(*)::int AS n FROM entry_bodies WHERE erased_at IS NOT NULL")).rows[0].n).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER fail_moderation ON moderation_log; DROP FUNCTION test_fail_moderation()");
    }
  });

  it("does not expose retained text through legacy AI or cached tags", async () => {
    await hide();
    // Simulate an old tagging job writing after moderation committed.
    await pool.query(`INSERT INTO entry_tags(entry_id,subject,tags,relevant,relevance_reason,prompt_version,model)
      VALUES ($1,'hidden subject','["hidden tag"]',true,'private original A',$2,'test')`, [first.id, TAG_PROMPT_VERSION]);
    const tagRes = await tags(request("/tags?stale_ok=1"), ctx);
    expect(await tagRes.json()).toMatchObject({ entries_meta: {}, subject_counts: {}, tag_counts: {} });
    await defaultView(request("/views/default?nocache=1"), ctx);
    expect(vi.mocked(buildView).mock.calls[0]![0].entries).toEqual([]);
  });

  it("never serves pre-moderation page or section caches, including late writes", async () => {
    await hide();
    const docHash = "sha256:" + createHash("sha256").update(`doc-v2|${SECTION_PROMPT_VERSION}|${INTRO_PROMPT_VERSION}`).digest("hex");
    const head = (await pool.query("SELECT head_hash FROM pages WHERE slug=$1", [slug])).rows[0].head_hash;
    for (const key of [docHash, promptHash(defaultPromptFor(slug))]) {
      await pool.query(`INSERT INTO view_cache(page_slug,view_prompt_hash,head_hash,view_json)
        VALUES ($1,$2,$3,'{"title":"private original"}')`, [slug, key, head]);
    }
    const sk = "a".repeat(64);
    await pool.query(`INSERT INTO view_section_cache(page_slug,prompt_version,subject_key,members_hash,view_json,model)
      VALUES ($1,$2,$3,'old','{"heading":"private original"}','test')`, [slug, SECTION_PROMPT_VERSION, sk]);
    expect((await docView(request("/views/doc?stale_ok=1"), ctx)).status).toBe(204);
    expect((await defaultView(request("/views/default?stale_ok=1"), ctx)).status).toBe(204);
    expect((await section(request(), { params: Promise.resolve({ slug, subject_key: sk }) })).status).toBe(404);
    expect(moderationCacheKey(docHash, 3)).not.toBe(docHash);
  });

  it("discards a response generated while moderation occurs", async () => {
    const res = await withModerationGuard(slug, async () => {
      await hide();
      return NextResponse.json({ summary: "private original A" });
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serializes an ordinary append with moderation into one valid chain", async () => {
    await Promise.all([
      hide(),
      appendEntry({ ...provenance, slug, body: "new ordinary post", kind: "entry" }),
    ]);
    const chain = (await pool.query("SELECT canonical_bytes FROM entries ORDER BY seq")).rows.map((r) => JSON.parse(r.canonical_bytes.toString()));
    expect(chain).toHaveLength(5);
    chain.forEach((e, i) => {
      expect(e.seq).toBe(i);
      const { hash, ...rest } = e;
      expect(entryHash(rest).hash).toBe(hash);
      if (i) expect(e.prev_hash).toBe(chain[i - 1].hash);
    });
  });
});
