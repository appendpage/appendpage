/**
 * CORS middleware for the append.page backend.
 *
 * The product's whole architectural pitch is data-layer / presentation-
 * layer disaggregation: the canonical chain is one thing; ANY number of
 * viewers can render it. To make that genuinely true for the most
 * accessible kind of viewer (a static HTML page someone hosts on
 * GitHub Pages, Netlify, their own domain, etc.), we have to actually
 * say so to the browser via Access-Control-Allow-Origin.
 *
 * Policy:
 *
 *   READ ENDPOINTS  — Access-Control-Allow-Origin: *
 *     Every GET, plus POST /p/<slug>/bodies (which is semantically a
 *     bulk-read with an id list in the body, not a write). Anyone can
 *     fetch the chain, the bodies + salts, the LLM-synthesized doc, the
 *     spec, AGENTS.md, the verifier, etc. from any browser at any
 *     origin.
 *
 *   WRITE ENDPOINTS — no CORS headers, preflight is denied with 403.
 *     POST /p/<slug>/entries, POST /pages, POST /p/<slug>/views,
 *     POST /p/<slug>/entries/<id>/flag. This is deliberate: per-IP rate
 *     limits are how we control posting abuse. A third-party in-browser
 *     frontend that proxies user posts to us would either burn its own
 *     IP budget for all of its users or force us to trust an arbitrary
 *     X-Forwarded-For — neither is acceptable. So we channel posts
 *     through append.page itself (same-origin, fine) or through CLI /
 *     server-side HTTP clients (which don't speak CORS and just get the
 *     standard per-IP rate-limit treatment from the real client IP).
 *
 * The matcher below excludes Next.js internal routes so we don't
 * intercept /_next/* asset requests with CORS work they don't need.
 */
import { NextResponse, type NextRequest } from "next/server";

/**
 * POST routes that should be treated as READ endpoints for CORS purposes.
 *
 * /p/<slug>/bodies takes an array of entry ids in its body and returns
 * the matching plaintext + salts; it has no side effects on the server.
 * It's only a POST instead of a GET because URL-length limits on a list
 * of 200 ULIDs are awkward.
 */
const READ_ONLY_POST_PATHS: RegExp[] = [/^\/p\/[^/]+\/bodies$/];

function isReadEndpoint(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  if (method === "POST") {
    return READ_ONLY_POST_PATHS.some((re) => re.test(pathname));
  }
  return false;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const method = req.method;
  const origin = req.headers.get("origin");
  const isCrossOrigin = !!origin;
  const readEndpoint = isReadEndpoint(method, pathname);

  // Preflight: handle CORS-OPTIONS directly without dispatching to the
  // route handler. For read endpoints, respond 204 with the allow
  // headers. For write endpoints (or anything else), respond 403 with
  // no allow header so the browser refuses to send the actual request.
  if (method === "OPTIONS" && isCrossOrigin) {
    if (readEndpoint) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
          // The only request header we need to allow is content-type for
          // POST /bodies. Everything else (auth, custom headers) is
          // intentionally not permitted cross-origin.
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
          vary: "Origin",
        },
      });
    }
    return new NextResponse(null, {
      status: 403,
      headers: { vary: "Origin" },
    });
  }

  // Actual request: pass through to the route handler, but tag the
  // response with CORS headers if it's a cross-origin read.
  const response = NextResponse.next();
  if (readEndpoint && isCrossOrigin) {
    response.headers.set("access-control-allow-origin", "*");
    // `Vary: Origin` is good practice even with `*` so caches don't
    // accidentally serve a same-origin variant to a cross-origin client.
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
