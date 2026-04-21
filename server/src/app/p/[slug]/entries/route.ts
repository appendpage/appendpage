/**
 * POST /p/:slug/entries — append an entry to a page's chain.
 *
 * Phase A walking skeleton: no Turnstile, no rate-limit, no provenance hashing.
 * Provenance fields are set to placeholder values; Phase B wires them up.
 */
import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { appendEntry } from "@/lib/chain";
import { checkAll, clientIpFromHeaders } from "@/lib/rate-limit";
import { ChainError, PostEntryRequestSchema } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;

  // Rate-limit first — cheap read-only Redis check before we touch PG.
  const ipNorm = clientIpFromHeaders((h) => req.headers.get(h));
  const rl = await checkAll(ipNorm, "entries", [
    { configKey: "entries_per_minute", windowSeconds: 60 },
    { configKey: "entries_per_hour", windowSeconds: 3600 },
  ]);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: `Too many posts — you can try again in ~${rl.resetAfterSeconds}s.`,
        retry_after_seconds: rl.resetAfterSeconds,
        limit_key: rl.key,
      },
      {
        status: 429,
        headers: { "retry-after": String(rl.resetAfterSeconds) },
      },
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = PostEntryRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const expectedPrevHash = req.headers.get("expect-prev-hash") ?? undefined;
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "0.0.0.0";
  const ua = req.headers.get("user-agent") ?? "";

  // Phase A placeholder provenance — Phase B replaces with proper salted hashes.
  const ipHash =
    "sha256:" + createHash("sha256").update(`devsalt:${ip}`).digest("hex");
  const userAgentHash =
    "sha256:" + createHash("sha256").update(ua).digest("hex");

  try {
    const { entry } = await appendEntry({
      slug,
      body: parsed.data.body,
      parentId: parsed.data.parent_id,
      kind: "entry",
      expectedPrevHash,
      ipHash,
      ipSaltId: 0, // Phase B: real salt id from Redis
      captchaId: parsed.data.turnstile_token ?? "phase-a-no-captcha",
      userAgentHash,
    });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    if (err instanceof ChainError) {
      const httpCode = chainErrorToHttp(err.code);
      return NextResponse.json(
        { error: err.code, message: err.message, detail: err.detail },
        { status: httpCode },
      );
    }
    console.error("[entries.POST] unexpected error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

function chainErrorToHttp(code: ChainError["code"]): number {
  switch (code) {
    case "page_not_found":
    case "parent_not_found":
      return 404;
    case "page_queued_review":
      return 403;
    case "head_mismatch":
      return 409;
    case "body_too_long":
    case "parent_wrong_page":
      return 400;
    case "moderation_only_admin":
      return 403;
    case "concurrent_append_lost":
      return 409;
    default:
      return 500;
  }
}
