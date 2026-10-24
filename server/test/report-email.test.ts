import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/lib/db";
import { appendEntry, createPage } from "../src/lib/chain";
import { submitReport } from "../src/lib/reports";
import { deliverReportEmail } from "../src/lib/report-email";

const testUrl = process.env.APPENDPAGE_TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith("_test")) throw Error("Dedicated _test database required");

describe.skipIf(!testUrl)("durable report email notifications", () => {
  const schema = `report_email_test_${process.pid}_${Date.now()}`;
  let entryId: string;
  const report = () => submitReport({ id: randomUUID(), page: "email-test", entry_id: entryId, reason: "other", details: "PRIVATE DETAILS NEVER EMAILED" });

  beforeAll(async () => {
    const url = new URL(testUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    await pool.query(`CREATE SCHEMA ${schema}`);
    const dir = fileURLToPath(new URL("../../migrations/", import.meta.url));
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) await pool.query(await readFile(`${dir}/${name}`, "utf8"));
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE pages CASCADE");
    await pool.query("UPDATE report_email_state SET failures=0, next_attempt_at=now(), last_sent_at=NULL");
    await createPage({ slug: "email-test", description: "test", defaultViewPrompt: null });
    entryId = (await appendEntry({ slug: "email-test", kind: "entry", body: "Public test post", ipHash: "test", ipSaltId: 0, captchaId: "test", userAgentHash: "test" })).entry.id;
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

  it("does not send or mark reports when disabled, and stays quiet for an empty queue", async () => {
    const send = vi.fn();
    expect(await deliverReportEmail(send, true)).toBe("idle");
    await report();
    expect(await deliverReportEmail(send, false)).toBe("disabled");
    expect(send).not.toHaveBeenCalled();
    expect((await pool.query("SELECT notified_at FROM moderation_reports")).rows[0].notified_at).toBeNull();
  });

  it("batches reports, excludes private text, and does not resend already notified reports", async () => {
    await report(); await report();
    const send = vi.fn();
    expect(await deliverReportEmail(send, true)).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ count: 2, posts: 1 });
    expect(Object.keys(send.mock.calls[0]![0]).sort()).toEqual(["count", "message_id", "posts"]);
    expect((await pool.query("SELECT notified_at FROM moderation_reports")).rows.every((r) => r.notified_at !== null)).toBe(true);
    await pool.query("UPDATE report_email_state SET next_attempt_at=now()");
    expect(await deliverReportEmail(send, true)).toBe("idle");
    expect(send).toHaveBeenCalledOnce();
  });

  it("retries delivery failures with the same message ID and a persisted delay", async () => {
    await report();
    const failed = vi.fn().mockRejectedValue(Error("SMTP down"));
    expect(await deliverReportEmail(failed, true)).toBe("retry");
    expect((await pool.query("SELECT notified_at FROM moderation_reports")).rows[0].notified_at).toBeNull();
    const state = (await pool.query("SELECT failures, next_attempt_at > now() AS delayed FROM report_email_state")).rows[0];
    expect(state).toEqual({ failures: 1, delayed: true });
    const success = vi.fn();
    expect(await deliverReportEmail(success, true)).toBe("busy");
    expect(success).not.toHaveBeenCalled();
    await pool.query("UPDATE report_email_state SET next_attempt_at=now()");
    expect(await deliverReportEmail(success, true)).toBe("sent");
    expect(success.mock.calls[0]![0].message_id).toBe(failed.mock.calls[0]![0].message_id);
  });

  it("serializes workers while accepting new reports during delivery", async () => {
    await report();
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const first = deliverReportEmail(async () => { entered(); await waiting; }, true);
    await started;
    try {
      const second = vi.fn();
      expect(await deliverReportEmail(second, true)).toBe("busy");
      expect(second).not.toHaveBeenCalled();
      await report();
    } finally { finish(); }
    expect(await first).toBe("sent");
    expect((await pool.query("SELECT count(*)::int AS n FROM moderation_reports WHERE notified_at IS NULL")).rows[0].n).toBe(1);
    const cooldown = vi.fn();
    expect(await deliverReportEmail(cooldown, true)).toBe("busy");
    expect(cooldown).not.toHaveBeenCalled();
  });

  it("skips reports already resolved before notification", async () => {
    await report();
    await pool.query("UPDATE moderation_reports SET status='kept',resolved_at=now(),resolved_by='test'");
    const send = vi.fn();
    expect(await deliverReportEmail(send, true)).toBe("idle");
    expect(send).not.toHaveBeenCalled();
  });
});
