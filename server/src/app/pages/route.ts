/**
 * POST /pages — create a new page.
 *
 * Phase A: no Turnstile yet. Slug rules already enforced via classifySlug().
 * Name-shaped slugs land in `queued_review` and aren't accepting entries until
 * an admin promotes them.
 */
import { NextResponse, type NextRequest } from "next/server";

import { createPage } from "@/lib/chain";
import { classifySlug } from "@/lib/slug";
import { CreatePageRequestSchema } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const json = await req.json().catch(() => null);
  const parsed = CreatePageRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const decision = classifySlug(parsed.data.slug);
  if (!decision.ok) {
    return NextResponse.json(
      { error: "slug_invalid", message: decision.reason },
      { status: 400 },
    );
  }

  try {
    await createPage({
      slug: parsed.data.slug,
      description: parsed.data.description ?? "",
      defaultViewPrompt: parsed.data.default_view_prompt ?? null,
      status: decision.status,
    });
  } catch (err: unknown) {
    if (err instanceof Error && /duplicate key value/.test(err.message)) {
      return NextResponse.json(
        { error: "slug_taken", message: `slug "${parsed.data.slug}" is already taken` },
        { status: 409 },
      );
    }
    console.error("[pages.POST] unexpected error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  return NextResponse.json(
    { slug: parsed.data.slug, status: decision.status },
    { status: 201 },
  );
}
