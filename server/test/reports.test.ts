import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID, scryptSync } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { pool } from "../src/lib/db";
import { appendEntry, createPage } from "../src/lib/chain";
import { pendingReports, resolveReports, submitReport } from "../src/lib/reports";
import { POST as report } from "../src/app/api/reports/route";
import { POST as login } from "../src/app/api/admin/login/route";
import { POST as logout } from "../src/app/api/admin/logout/route";
import { GET as queue, POST as decision } from "../src/app/api/admin/reports/route";
import { GET as bodiesFile } from "../src/app/p/[slug]/bodies.jsonl/route";
import { middleware } from "../src/middleware";
import { clientIpFromHeaders, normalizeIp } from "../src/lib/rate-limit";

// Exercise the real limiter and routes with deterministic Redis storage. The
// PostgreSQL transactions and migrations below use a dedicated real database.
const redisState = vi.hoisted(() => ({ values: new Map<string, string>(), fail: false }));
vi.mock("../src/lib/redis", () => ({ redis: {
  get: async (key: string) => { if (redisState.fail) throw Error("offline"); return redisState.values.get(key) ?? null; },
  set: async (key: string, value: string) => { redisState.values.set(key, value); return "OK"; },
  del: async (key: string) => redisState.values.delete(key),
  eval: async (_script: string, _keys: number, key: string) => {
    if (redisState.fail) throw Error("offline");
    const value = Number(redisState.values.get(key) ?? 0) + 1;
    redisState.values.set(key, String(value)); return value;
  },
} }));

const testUrl = process.env.APPENDPAGE_TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith("_test")) throw Error("Dedicated _test database required");

describe("proxy and browser boundaries", () => {
  it("uses nginx's real address instead of spoofable forwarded prefixes", () => {
    const headers = new Headers({ "x-real-ip": "192.0.2.9", "x-forwarded-for": "1.1.1.1, 192.0.2.9" });
    expect(clientIpFromHeaders((name) => headers.get(name))).toBe("192.0.2.9/32");
    headers.delete("x-real-ip");
    expect(clientIpFromHeaders((name) => headers.get(name))).toBe("192.0.2.9/32");
  });
  it("normalizes compressed and mapped IPv6 consistently", () => {
    expect(normalizeIp("2001:db8::1")).toBe(normalizeIp("2001:0db8:0000:0000:abcd::2"));
    expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1/32");
    expect(normalizeIp("::ffff:c000:201")).toBe("192.0.2.1/32");
    expect(normalizeIp("2001:db8:1:2::1")).not.toBe(normalizeIp("2001:db8:1:3::1"));
  });
  it("keeps public reporting CORS-open and admin CORS-closed", () => {
    const publicResponse = middleware(new NextRequest("https://append.page/api/reports", { method: "OPTIONS", headers: { origin: "https://viewer.test" } }));
    expect(publicResponse.headers.get("access-control-allow-origin")).toBe("*");
    const privateResponse = middleware(new NextRequest("https://append.page/api/admin/reports", { method: "OPTIONS", headers: { origin: "https://viewer.test" } }));
    expect(privateResponse.status).toBe(403);
    expect(privateResponse.headers.has("access-control-allow-origin")).toBe(false);
  });
});

describe.skipIf(!testUrl)("private report workflow (PostgreSQL integration)", () => {
  const schema = `reports_test_${process.pid}_${Date.now()}`;
  const slug = "reports-test";
  let entry: Awaited<ReturnType<typeof appendEntry>>["entry"];
  const request = (path: string, body?: unknown, cookie?: string, origin = "https://append.page") => new NextRequest(`https://append.page${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, "content-type": "application/json", "x-real-ip": "192.0.2.10", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const input = () => ({ id: randomUUID(), page: slug, entry_id: entry.id, reason: "harassment" as const, details: "PRIVATE REPORT EXPLANATION" });

  beforeAll(async () => {
    const url = new URL(testUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const salt = "a".repeat(32);
    process.env.ADMIN_PASSWORD_HASH = `${salt}:${scryptSync("test-only-password", salt, 64).toString("hex")}`;
    process.env.ADMIN_ORIGIN = "https://append.page";
    await pool.query(`CREATE SCHEMA ${schema}`);
    const dir = fileURLToPath(new URL("../../migrations/", import.meta.url));
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) await pool.query(await readFile(`${dir}/${name}`, "utf8"));
  });
  beforeEach(async () => {
    redisState.values.clear(); redisState.fail = false;
    await pool.query("TRUNCATE pages CASCADE");
    await createPage({ slug, description: "test", defaultViewPrompt: null });
    entry = (await appendEntry({ slug, kind: "entry", body: "Original post", ipHash: "test", ipSaltId: 0, captchaId: "test", userAgentHash: "test" })).entry;
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

  it("accepts private reports without accounts and deduplicates retries without changing public data", async () => {
    const data = input();
    expect((await report(request("/api/reports", data))).status).toBe(202);
    expect((await report(request("/api/reports", data))).status).toBe(202);
    expect((await pool.query("SELECT * FROM moderation_reports")).rows).toHaveLength(1);
    expect((await pool.query("SELECT * FROM entries")).rows).toHaveLength(1);
    const jsonl = await (await bodiesFile(request(`/p/${slug}/bodies.jsonl`), { params: Promise.resolve({ slug }) })).text();
    expect(jsonl).toContain("Original post");
    expect(jsonl).not.toContain(data.details);
    const pending = await pendingReports();
    expect(pending.entries[0].reports[0].details).toBe(data.details);
  });

  it("validates targets, reasons, sizes, and enforces per-IP limits", async () => {
    expect((await report(request("/api/reports", { ...input(), page: "absent" }))).status).toBe(404);
    expect((await report(request("/api/reports", { ...input(), reason: "unknown" }))).status).toBe(400);
    expect((await report(request("/api/reports", { ...input(), details: "x".repeat(12001) }))).status).toBe(400);
    for (let i = 0; i < 7; i++) expect((await report(request("/api/reports", input()))).status).toBe(202);
    const limited = await report(request("/api/reports", input()));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("denies unauthorized review and mutations; checks origin; revokes sessions on logout", async () => {
    const data = input(); await submitReport(data);
    expect((await queue(request("/api/admin/reports"))).status).toBe(401);
    expect((await decision(request("/api/admin/reports", {}))).status).toBe(401);
    expect((await login(request("/api/admin/login", { password: "test-only-password" }, undefined, "https://evil.test"))).status).toBe(403);
    expect((await login(request("/api/admin/login", { password: "wrong" }))).status).toBe(401);
    const auth = await login(request("/api/admin/login", { password: "test-only-password" }));
    expect(auth.status).toBe(200);
    const cookieHeader = auth.headers.get("set-cookie")!;
    expect(cookieHeader).toContain("HttpOnly"); expect(cookieHeader).toContain("Secure"); expect(cookieHeader.toLowerCase()).toContain("samesite=strict");
    const cookie = cookieHeader.split(";")[0]!;
    const visible = await queue(request("/api/admin/reports", undefined, cookie));
    expect((await visible.json()).entries[0].reports[0].details).toBe(data.details);
    expect(visible.headers.get("cache-control")).toBe("no-store");
    expect((await decision(request("/api/admin/reports", { entry_id: entry.id, report_ids: [data.id], decision: "withhold" }, cookie, "https://evil.test"))).status).toBe(403);
    expect((await logout(request("/api/admin/logout", {}, cookie))).status).toBe(200);
    expect((await queue(request("/api/admin/reports", undefined, cookie))).status).toBe(401);
    expect((await pool.query("SELECT status FROM moderation_reports")).rows[0].status).toBe("pending");
  });

  it("keeps content visible when a report is dismissed and does not publish private explanations", async () => {
    const data = input(); await submitReport(data);
    await resolveReports({ entry_id: entry.id, report_ids: [data.id], decision: "keep" }, "reviewer");
    expect((await pool.query("SELECT erased_at FROM entry_bodies")).rows[0].erased_at).toBeNull();
    expect((await pool.query("SELECT * FROM entries")).rows).toHaveLength(1);
    expect((await pendingReports()).total).toBe(0);
  });

  it("withholds atomically, preserves originals, and concurrent retries append only one public action", async () => {
    const data = input(); await submitReport(data);
    const before = (await pool.query("SELECT body,salt FROM entry_bodies WHERE entry_id=$1", [entry.id])).rows[0];
    const action = { entry_id: entry.id, report_ids: [data.id], decision: "withhold" as const };
    await Promise.all([resolveReports(action, "reviewer"), resolveReports(action, "reviewer")]);
    expect((await pool.query("SELECT body,salt FROM entry_bodies WHERE entry_id=$1", [entry.id])).rows[0]).toEqual(before);
    expect((await pool.query("SELECT * FROM entries")).rows).toHaveLength(2);
    expect((await pool.query("SELECT status FROM moderation_reports")).rows[0].status).toBe("withheld");
    const exported = await (await bodiesFile(request(`/p/${slug}/bodies.jsonl`), { params: Promise.resolve({ slug }) })).text();
    expect(exported).not.toContain("Original post"); expect(exported).not.toContain(data.details);
    expect(exported).toContain("Content withheld following moderation review.");
    const late = input(); await submitReport(late);
    await resolveReports({ entry_id: entry.id, report_ids: [late.id], decision: "keep" }, "reviewer");
    expect((await pool.query("SELECT erased_at FROM entry_bodies WHERE entry_id=$1", [entry.id])).rows[0].erased_at).not.toBeNull();
  });

  it("leaves reports arriving after the review snapshot pending", async () => {
    const first = input(); await submitReport(first);
    const later = input(); await submitReport(later);
    await resolveReports({ entry_id: entry.id, report_ids: [first.id], decision: "keep" }, "reviewer");
    expect((await pendingReports()).entries[0].reports.map((r: {id: string}) => r.id)).toEqual([later.id]);
  });

  it("rolls back withholding and the chain if saving the private decision fails", async () => {
    const data = input(); await submitReport(data);
    await pool.query(`CREATE FUNCTION fail_report_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER fail_report BEFORE UPDATE ON moderation_reports FOR EACH ROW EXECUTE FUNCTION fail_report_update()`);
    try {
      await expect(resolveReports({ entry_id: entry.id, report_ids: [data.id], decision: "withhold" }, "reviewer")).rejects.toThrow("test failure");
      expect((await pool.query("SELECT * FROM entries")).rows).toHaveLength(1);
      expect((await pool.query("SELECT erased_at FROM entry_bodies")).rows[0].erased_at).toBeNull();
      expect((await pool.query("SELECT status FROM moderation_reports")).rows[0].status).toBe("pending");
    } finally { await pool.query("DROP TRIGGER fail_report ON moderation_reports; DROP FUNCTION fail_report_update()"); }
  });

  it("fails closed when the rate-limit store is unavailable", async () => {
    redisState.fail = true;
    expect((await report(request("/api/reports", input()))).status).toBe(503);
    expect((await pool.query("SELECT * FROM moderation_reports")).rows).toHaveLength(0);
  });
});
