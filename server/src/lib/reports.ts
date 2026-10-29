import { z } from "zod";
import { acquireSlugLock, pool, withTx } from "./db";
import { restoreInTransaction, temporarilyWithholdInTransaction, withholdInTransaction, REVIEWED_WITHHOLD_REASON } from "./moderation";
import { SLUG_REGEX, ULID_REGEX } from "./types";

export const ReportSchema = z.object({
  id: z.string().uuid(),
  page: z.string().regex(SLUG_REGEX),
  entry_id: z.string().regex(ULID_REGEX),
  reason: z.enum(["harassment", "privacy", "misleading", "spam", "other"]),
  details: z.string().trim().max(2000).default(""),
}).strict();

export async function submitReport(report: z.infer<typeof ReportSchema>): Promise<{ withheld: boolean } | null> {
  return withTx(async (client) => {
    // Serialize report insertion, public visibility and moderator decisions.
    // Every NEW report can hide a restored post; retries cannot hide it again.
    await acquireSlugLock(client, report.page);
    const target = await client.query(
      `SELECT b.erased_at FROM entries e JOIN entry_bodies b ON b.entry_id=e.id
        WHERE e.id=$1 AND e.page_slug=$2 AND e.kind='entry' FOR UPDATE OF b`,
      [report.entry_id, report.page],
    );
    if (!target.rowCount) return null;
    const result = await client.query(
      `INSERT INTO moderation_reports (id, entry_id, reason, details) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [report.id, report.entry_id, report.reason, report.details],
    );
    if (!result.rowCount) {
      const retry = await client.query("SELECT 1 FROM moderation_reports WHERE id=$1 AND entry_id=$2", [report.id, report.entry_id]);
      return retry.rowCount ? { withheld: target.rows[0].erased_at !== null } : null;
    }
    if (target.rows[0].erased_at === null) {
      await temporarilyWithholdInTransaction(client, { slug: report.page, entryIds: [report.entry_id], actor: "automatic-report" });
    }
    return { withheld: true };
  });
}

/** Bring reports saved before automatic hiding into the same workflow. */
export async function hidePendingReports(): Promise<number> {
  const pages = await pool.query(
    `SELECT DISTINCT e.page_slug FROM moderation_reports r JOIN entries e ON e.id=r.entry_id
      JOIN entry_bodies b ON b.entry_id=e.id WHERE r.status='pending' AND b.erased_at IS NULL`,
  );
  let hidden = 0;
  for (const page of pages.rows) {
    hidden += await withTx(async (client) => {
      await acquireSlugLock(client, page.page_slug);
      const targets = await client.query(
        `SELECT DISTINCT e.id FROM moderation_reports r JOIN entries e ON e.id=r.entry_id
          JOIN entry_bodies b ON b.entry_id=e.id
          WHERE e.page_slug=$1 AND r.status='pending' AND b.erased_at IS NULL`, [page.page_slug],
      );
      if (!targets.rowCount) return 0;
      await temporarilyWithholdInTransaction(client, {
        slug: page.page_slug, entryIds: targets.rows.map((row) => row.id), actor: "automatic-report",
      });
      return targets.rowCount;
    });
  }
  return hidden;
}

export async function pendingReports() {
  const result = await pool.query(
    `WITH queued AS (
       SELECT entry_id, MIN(ordinal) AS first_report FROM moderation_reports
        WHERE status = 'pending' GROUP BY entry_id ORDER BY first_report LIMIT 20
     )
     SELECT e.id, e.page_slug AS page, e.seq, b.body,
            b.erased_at IS NOT NULL AS withheld, b.withheld_pending_review,
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
  decision: z.enum(["keep", "withhold", "restore"]),
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
    const body = await client.query("SELECT erased_at, withheld_pending_review FROM entry_bodies WHERE entry_id = $1 FOR UPDATE", [input.entry_id]);
    const withheld = body.rows[0]!.erased_at !== null;
    const ids = reports.rows.map((r) => r.id);
    const status = input.decision === "restore" || (input.decision === "keep" && !withheld) ? "kept" : "withheld";
    await client.query(
      `UPDATE moderation_reports SET status=$2, resolved_at=now(), resolved_by=$3 WHERE id=ANY($1::uuid[])`,
      [ids, status, actor],
    );
    if (input.decision === "restore") {
      // A report arriving since the admin loaded this snapshot still needs
      // review. Never expose its target by resolving older reports.
      const remaining = await client.query("SELECT 1 FROM moderation_reports WHERE entry_id=$1 AND status='pending' LIMIT 1", [input.entry_id]);
      if (remaining.rowCount) return { ok: true, changed: true, pending_reports_remaining: true };
      if (withheld) await restoreInTransaction(client, { slug, entryIds: [input.entry_id], actor });
    } else if (status === "withheld") {
      if (!withheld || body.rows[0]!.withheld_pending_review) {
        await withholdInTransaction(client, {
          slug, entryIds: [input.entry_id], actor,
          reason: REVIEWED_WITHHOLD_REASON,
        });
      }
    }
    return { ok: true, changed: true };
  });
}
