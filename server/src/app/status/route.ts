/**
 * GET /status — liveness + minimal status JSON.
 *
 * Phase A: just confirms the server is up and PG is reachable.
 * Phase D adds: free disk, llm_budget_remaining, last_anchor_at.
 */
import { statfs } from "node:fs/promises";
import { NextResponse } from "next/server";

import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

const BOOT_TIME = Date.now();

export async function GET(): Promise<NextResponse> {
  // Liveness probe: a trivial round-trip to PG.
  let pgOk = false;
  try {
    await pool.query("SELECT 1");
    pgOk = true;
  } catch {
    pgOk = false;
  }

  let freeDiskBytes: number | null = null;
  try {
    const fs = await statfs(process.env.PAGES_DIR ?? "/var/lib/appendpage/pages");
    freeDiskBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    /* directory may not exist yet in dev */
  }

  return NextResponse.json(
    {
      ok: pgOk,
      uptime_seconds: Math.floor((Date.now() - BOOT_TIME) / 1000),
      last_anchor_at: null, // Phase D
      free_disk_bytes: freeDiskBytes,
      llm_budget_remaining_today_usd: null, // Phase B
      version: "0.1.0",
    },
    {
      status: pgOk ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
