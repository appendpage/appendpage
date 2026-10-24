import { NextRequest } from "next/server";
import { adminActor, isAdminWrite, privateJson } from "@/lib/admin-auth";
import { limitedJson, reportRoute } from "@/lib/report-http";
import { DecisionSchema, pendingReports, resolveReports } from "@/lib/reports";

export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  return reportRoute(async () => {
    if (!await adminActor(req)) return privateJson({ error: "Sign in to review reports." }, 401);
    return privateJson(await pendingReports());
  });
}
export async function POST(req: NextRequest) {
  return reportRoute(async () => {
    if (!isAdminWrite(req)) return privateJson({ error: "Forbidden" }, 403);
    const actor = await adminActor(req);
    if (!actor) return privateJson({ error: "Sign in to review reports." }, 401);
    const input = DecisionSchema.safeParse(await limitedJson(req));
    if (!input.success) return privateJson({ error: "Invalid decision." }, 400);
    return privateJson(await resolveReports(input.data, actor));
  });
}
