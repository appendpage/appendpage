/**
 * CORS middleware for the append.page backend.
 *
 * The product's whole architectural pitch is data-layer / presentation-
 * layer disaggregation: the canonical chain is one thing; ANY number of
 * viewers can render it. To make that genuinely true for the most
 * accessible kind of viewer (a static HTML page someone hosts on
 * GitHub Pages, Netlify, their own domain, an iframe on their blog,
 * even a file:// page open in a browser tab), we have to say so to the
 * browser via Access-Control-Allow-Origin.
 *
 * Policy: every endpoint is CORS-open (`Access-Control-Allow-Origin: *`).
 *
 * That includes write endpoints (POST /p/<slug>/entries, POST /pages).
 * Why open writes too:
 *
 *   1. We want individuals to be able to build their own viewers AND
 *      compose posts from them — the whole point is that a person with
 *      an AI coding agent can spin up their own UI in an afternoon.
 *
 *   2. The protection that matters here is the per-IP Redis rate limit
 *      (configurable in `rate_limit_config`, see lib/rate-limit.ts).
 *      Every write hits that limit regardless of origin or user-agent,
 *      so:
 *        - An individual posting from their own viewer: their personal
 *          IP, well under the cap. Fine.
 *        - Someone building "AnotherAppendPage" that proxies posts for
 *          many users: the proxy's single IP hits the cap immediately.
 *          The use case is naturally prevented by the rate limit, no
 *          CORS gate needed.
 *        - Drive-by CSRF from a malicious site: bounded — each victim
 *          can only contribute up to the per-IP cap (currently 30
 *          posts/min) before being blocked. The chain still proves
 *          exactly what was posted; cleanup is moderation erasure.
 *
 *   3. If we ever see CSRF-driven spam waves in practice, the right
 *      response is to add a CSRF-token requirement on cross-origin
 *      writes (which only affects browser writes, not CLI/server-side
 *      ones), not to globally close the CORS gate.
 *
 * The matcher below excludes Next.js internal asset routes so we don't
 * intercept /_next/* requests with CORS work they don't need.
 */
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest): NextResponse {
  const origin = req.headers.get("origin");
  const isCrossOrigin = !!origin;

  // Preflight: handle CORS-OPTIONS directly without dispatching to the
  // route handler. Always 204 + open allow headers — every endpoint is
  // open. Same-origin OPTIONS (no Origin header) falls through to the
  // route handler in case any route wants its own OPTIONS handling.
  if (req.method === "OPTIONS" && isCrossOrigin) {
    return new NextResponse(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        vary: "Origin",
      },
    });
  }

  // Actual request: pass through, decorate cross-origin responses with
  // the allow header. `Vary: Origin` is good practice even with `*` so
  // caches don't accidentally serve a same-origin variant to a
  // cross-origin client.
  const response = NextResponse.next();
  if (isCrossOrigin) {
    response.headers.set("access-control-allow-origin", "*");
    response.headers.set("vary", "Origin");
  }
  return response;
}

/**
 * Match every public path EXCEPT Next.js internals + the /verify.py
 * file (which is just a static file response and doesn't need CORS
 * decoration — though if someone wants to fetch() it cross-origin
 * we'd need to add it; for now the convention is `curl -O`).
 *
 * The negative lookahead handles _next, the favicon route stub, and
 * a couple of Next.js-injected paths. Everything else falls through.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
