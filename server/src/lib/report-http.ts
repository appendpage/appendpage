import { NextRequest, NextResponse } from "next/server";
import { checkAll, clientIpFromHeaders } from "./rate-limit";
import { privateJson } from "./admin-auth";

export async function limitedJson(req: NextRequest, maxBytes = 12_000): Promise<unknown> {
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return null;
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export async function reportLimit(req: NextRequest, login = false): Promise<NextResponse | null> {
  const prefix = login ? "admin_login" : "reports";
  const decision = await checkAll(clientIpFromHeaders((name) => req.headers.get(name)), prefix, [
    { configKey: `${prefix}_per_minute`, windowSeconds: 60, fallback: login ? 5 : 10 },
    { configKey: `${prefix}_per_hour`, windowSeconds: 3600, fallback: login ? 30 : 40 },
  ]);
  if (decision.ok) return null;
  const response = privateJson({ error: "Too many requests. Please try again later." }, 429);
  response.headers.set("retry-after", String(decision.resetAfterSeconds));
  return response;
}

/** Do not echo report text, passwords, database errors, or sessions into responses/logs. */
export async function reportRoute(fn: () => Promise<Response>): Promise<Response> {
  try { return await fn(); }
  catch {
    console.error("[moderation] request failed");
    return privateJson({ error: "Temporarily unavailable. Please try again." }, 503);
  }
}
