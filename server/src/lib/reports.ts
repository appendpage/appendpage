import { z } from "zod";
import { acquireSlugLock, pool, withTx } from "./db";
import { withholdInTransaction } from "./moderation";
import { SLUG_REGEX, ULID_REGEX } from "./types";

export const ReportSchema = z.object({
  id: z.string().uuid(),
  page: z.string().regex(SLUG_REGEX),
  entry_id: z.string().regex(ULID_REGEX),
  reason: z.enum(["harassment", "privacy", "misleading", "spam", "other"]),
  details: z.string().trim().max(2000).default(""),
}).strict();

export async function submitReport(report: z.infer<typeof ReportSchema>): Promise<boolean> {
  // No reporter identity, raw IP, or contact details are stored with reports.
  const result = await pool.query(
    `INSERT INTO moderation_reports (id, entry_id, reason, details)
     SELECT $1, e.id, $4, $5 FROM entries e
      WHERE e.id = $2 AND e.page_slug = $3 AND e.kind = 'entry'
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [report.id, report.entry_id, report.page, report.reason, report.details],
  );
  if (result.rowCount) return true;
  // An opaque client UUID makes retries harmless. Never return another report's data.
  const retry = await pool.query("SELECT 1 FROM moderation_reports WHERE id = $1", [report.id]);
  return !!retry.rowCount;
}

export async function pendingReports() {
  const result = await pool.query(
    `WITH queued AS (
       SELECT entry_id, MIN(ordinal) AS first_report FROM moderation_reports
        WHERE status = 'pending' GROUP BY entry_id ORDER BY first_report LIMIT 20
     )
     SELECT e.id, e.page_slug AS page, e.seq, b.body,
            b.erased_at IS NOT NULL AS withheld,
            p.seq AS parent_seq, pb.body AS parent_body,
            COALESCE(r.reports, '[]'::json) AS reports
       FROM queued q JOIN entries e ON e.id = q.entry_id
       JOIN entry_bodies b ON b.entry_id = e.id
       LEFT JOIN entries p ON p.id = e.parent_id
       LEFT JOIN entry_bodies pb ON pb.entry_id = p.id
       LEFT JOIN LATERAL (
         SELECT json_agg(item ORDER BY item.created_at, item.id) AS reports FROM (
           SELECT id, reason, details, created_at FROM moderation_reports
            WHERE entry_id = e.id AND status = 'pending' ORDER BY ordinal LIMIT 100
         ) item
       ) r ON true ORDER BY q.first_report`,
  );
  const count = await pool.query("SELECT COUNT(DISTINCT entry_id)::int AS total FROM moderation_reports WHERE status = 'pending'");
  return { entries: result.rows, total: count.rows[0]!.total };
}

export const DecisionSchema = z.object({
  entry_id: z.string().regex(ULID_REGEX),
  report_ids: z.array(z.string().uuid()).min(1).max(100),
  decision: z.enum(["keep", "withhold"]),
}).strict();

export async function resolveReports(input: z.infer<typeof DecisionSchema>, actor: string) {
  return withTx(async (client) => {
    const target = await client.query("SELECT page_slug FROM entries WHERE id = $1", [input.entry_id]);
    if (!target.rowCount) throw new Error("Unknown entry");
    const slug = target.rows[0]!.page_slug as string;
    await acquireSlugLock(client, slug);
    const reports = await client.query(
      `SELECT id FROM moderation_reports WHERE entry_id = $1 AND id = ANY($2::uuid[])
         AND status = 'pending' ORDER BY ordinal FOR UPDATE`,
      [input.entry_id, input.report_ids],
    );
    // Retrying a completed decision never appends a second moderation record.
    if (!reports.rowCount) return { ok: true, changed: false };
    const body = await client.query("SELECT erased_at FROM entry_bodies WHERE entry_id = $1 FOR UPDATE", [input.entry_id]);
    const withheld = body.rows[0]!.erased_at !== null;
    if (input.decision === "keep" && withheld) {
      // Closing a report never restores content; restoration needs a separate decision.
      await client.query(
        `UPDATE moderation_reports SET status = 'withheld', resolved_at = now(), resolved_by = $2
          WHERE id = ANY($1::uuid[])`, [reports.rows.map((r) => r.id), actor],
      );
    } else {
      if (input.decision === "withhold" && !withheld) {
        await withholdInTransaction(client, {
          slug, entryIds: [input.entry_id], actor,
          reason: "Content withheld following moderation review.",
        });
      }
      await client.query(
        `UPDATE moderation_reports SET status = $2, resolved_at = now(), resolved_by = $3
          WHERE id = ANY($1::uuid[])`,
        [reports.rows.map((r) => r.id), input.decision === "keep" ? "kept" : "withheld", actor],
      );
    }
    return { ok: true, changed: true };
  });
}
