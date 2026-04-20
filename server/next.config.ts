import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // We're a backend-shaped Next.js app: API routes + a few static markdown
  // routes (AGENTS.md, /api/spec.json) + Phase C will add UI later. Strict
  // mode + no telemetry.
  reactStrictMode: true,
  output: "standalone",
  poweredByHeader: false,
  // Case-variant aliases for AGENTS.md. We can't ship a sibling /agents.md
  // route file because case-insensitive filesystems (macOS) collide it with
  // /AGENTS.md. Rewrite from the URL layer instead.
  async rewrites() {
    return [
      { source: "/agents.md", destination: "/AGENTS.md" },
      { source: "/Agents.md", destination: "/AGENTS.md" },
    ];
  },
  // The frontend lives in a separate repo (appendpage/web); when it codegens
  // types from /api/spec.json against this backend, CORS will need to allow it.
  // For now (Phase A) we don't expose anything cross-origin.
};

export default nextConfig;
