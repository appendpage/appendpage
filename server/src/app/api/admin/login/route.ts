import { NextRequest } from "next/server";
import { z } from "zod";
import { isAdminWrite, privateJson, signIn, verifyPassword } from "@/lib/admin-auth";
import { limitedJson, reportLimit, reportRoute } from "@/lib/report-http";

export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  return reportRoute(async () => {
    if (!isAdminWrite(req)) return privateJson({ error: "Forbidden" }, 403);
    const limited = await reportLimit(req, true);
    if (limited) return limited;
    const input = z.object({ password: z.string().min(1).max(256) }).strict().safeParse(await limitedJson(req, 2048));
    if (!input.success || !await verifyPassword(input.data.password)) return privateJson({ error: "Incorrect password." }, 401);
    return signIn();
  });
}
