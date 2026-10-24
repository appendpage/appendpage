import { NextRequest } from "next/server";
import { ReportSchema, submitReport } from "@/lib/reports";
import { limitedJson, reportLimit, reportRoute } from "@/lib/report-http";
import { privateJson } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  return reportRoute(async () => {
    const limited = await reportLimit(req);
    if (limited) return limited;
    const input = ReportSchema.safeParse(await limitedJson(req));
    if (!input.success) return privateJson({ error: "Choose a reason and keep details under 2,000 characters." }, 400);
    if (!await submitReport(input.data)) return privateJson({ error: "Post not found." }, 404);
    return privateJson({ ok: true }, 202);
  });
}
