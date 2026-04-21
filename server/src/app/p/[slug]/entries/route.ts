/**
 * POST /p/:slug/entries — append an entry to a page's chain.
 *
 * Provenance: ip_hash (fixed internal salt + normalized IP) and
 * user_agent_hash are written to entry_provenance for rate-limiting and
 * abuse triage. Per-IP rate limit is enforced via the lib/rate-limit.ts
 * Redis counter before any DB work happens.
 */
import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { appendEntry } from "@/lib/chain";
import { checkAll, clientIpFromHeaders } from "@/lib/rate-limit";
import { ChainError, PostEntryRequestSchema } from "@/lib/types";

const IP_HASH_SALT = process.env.APPENDPAGE_IP_HASH_SALT ?? "appendpage-v0";

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

  // Fixed-salt IP and user-agent hashes for abuse triage. We do not store
  // the raw IP or UA anywhere; only the hashes land in entry_provenance.
  const ipHash =
    "sha256:" + createHash("sha256").update(`${IP_HASH_SALT}:${ip}`).digest("hex");
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
      ipSaltId: 0,
      captchaId: "none",
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
