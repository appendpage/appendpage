import { NextRequest } from "next/server";
import { isAdminWrite, privateJson, signOut } from "@/lib/admin-auth";
import { reportRoute } from "@/lib/report-http";
export async function POST(req: NextRequest) {
  return reportRoute(async () => isAdminWrite(req) ? signOut(req) : privateJson({ error: "Forbidden" }, 403));
}
