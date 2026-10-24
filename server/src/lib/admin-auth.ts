import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { redis } from "./redis";

const derive = promisify(scrypt);
const COOKIE = "__Secure-appendpage-admin";
const SESSION_SECONDS = 8 * 60 * 60;
const sessionKey = (token: string) => `admin-session:${createHash("sha256").update(token).digest("hex")}`;

export function privateJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store", "vary": "Cookie" } });
}

/** Admin writes are same-origin only; the public API's CORS policy does not apply. */
export function isAdminWrite(req: NextRequest): boolean {
  return req.headers.get("origin") === (process.env.ADMIN_ORIGIN ?? "https://append.page") &&
    req.headers.get("content-type")?.split(";")[0]?.trim() === "application/json";
}

export async function verifyPassword(password: string): Promise<boolean> {
  const configured = process.env.ADMIN_PASSWORD_HASH ?? "";
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(configured) || password.length > 256) return false;
  const [salt, expected] = configured.split(":");
  const actual = await derive(password, salt!, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected!, "hex"));
}

export async function adminActor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return redis.get(sessionKey(token));
}

export async function signIn(): Promise<NextResponse> {
  const token = randomBytes(32).toString("hex");
  await redis.set(sessionKey(token), process.env.ADMIN_ACTOR ?? "operator", "EX", SESSION_SECONDS);
  const response = privateJson({ ok: true });
  response.cookies.set(COOKIE, token, {
    httpOnly: true, secure: true, sameSite: "strict", path: "/api/admin", maxAge: SESSION_SECONDS,
  });
  return response;
}

export async function signOut(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(COOKIE)?.value;
  if (token && /^[a-f0-9]{64}$/.test(token)) await redis.del(sessionKey(token));
  const response = privateJson({ ok: true });
  response.cookies.set(COOKIE, "", {
    httpOnly: true, secure: true, sameSite: "strict", path: "/api/admin", maxAge: 0,
  });
  return response;
}
