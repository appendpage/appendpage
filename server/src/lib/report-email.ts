import { createHash } from "node:crypto";
import { pool, withTx } from "./db";

export interface ReportEmail {
  count: number;
  posts: number;
  message_id: string;
}

export async function previewReportEmail(): Promise<{ reports: number; posts: number }> {
  const result = await pool.query(
    `SELECT count(*)::int AS reports, count(DISTINCT entry_id)::int AS posts
       FROM moderation_reports WHERE status = 'pending' AND notified_at IS NULL`,
  );
  return result.rows[0]!;
}

/** Run separately from request handling. Delivery failures cannot lose a report
 * or slow its submission. A singleton row lock serializes email workers only;
 * posting/reporting/reviewing do not acquire that lock.
 * SMTP acceptance and database commit cannot be atomic: a crash between them
 * can cause a duplicate. A deterministic Message-ID identifies the same batch.
 */
export async function deliverReportEmail(
  send: (email: ReportEmail) => Promise<void>,
  enabled: boolean,
): Promise<"disabled" | "busy" | "idle" | "sent" | "retry"> {
  if (!enabled) return "disabled";
  return withTx(async (client) => {
    const state = await client.query<{ failures: number }>(
      `SELECT failures FROM report_email_state WHERE singleton AND next_attempt_at <= now()
        FOR UPDATE SKIP LOCKED`,
    );
    if (!state.rowCount) return "busy";
    const reports = await client.query<{ id: string; entry_id: string }>(
      `SELECT id, entry_id FROM moderation_reports WHERE status = 'pending' AND notified_at IS NULL
        ORDER BY ordinal LIMIT 500`,
    );
    if (!reports.rowCount) return "idle";
    const ids = reports.rows.map((row) => row.id);
    const digest = createHash("sha256").update(ids.join(",")).digest("hex");
    try {
      await send({
        count: ids.length,
        posts: new Set(reports.rows.map((row) => row.entry_id)).size,
        message_id: `<appendpage-reports-${digest}@append.page>`,
      });
    } catch {
      const delay = Math.min(3600, 60 * 2 ** Math.min(state.rows[0]!.failures, 6));
      await client.query(
        `UPDATE report_email_state SET failures = failures + 1,
          next_attempt_at = now() + $1 * interval '1 second' WHERE singleton`, [delay],
      );
      return "retry";
    }
    // Lock in the same order as moderation decisions. Reports submitted while
    // email was in flight keep notified_at=NULL for the next batch.
    await client.query("SELECT id FROM moderation_reports WHERE id = ANY($1::uuid[]) ORDER BY ordinal FOR UPDATE", [ids]);
    await client.query("UPDATE moderation_reports SET notified_at = now() WHERE id = ANY($1::uuid[])", [ids]);
    await client.query(
      `UPDATE report_email_state SET failures = 0, last_sent_at = now(),
        next_attempt_at = now() + interval '5 minutes' WHERE singleton`,
    );
    return "sent";
  });
}
