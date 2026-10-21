import { NextRequest, NextResponse } from "next/server";

/**
 * Content-Security-Policy for the passenger PWA and staff console (security
 * assessment L-3). Defence-in-depth against XSS: even a script-injection bug
 * cannot load or exfiltrate to an off-list origin, which also protects the
 * access token that lives in localStorage (L-1).
 *
 * Script execution is locked to Next.js's own bundles via a per-request nonce
 * plus `strict-dynamic` — Next applies the nonce to the scripts it emits when
 * it sees it on the request's CSP header, so there is no `'unsafe-inline'` for
 * scripts. Styles keep `'unsafe-inline'` (Tailwind/Next inject inline styles;
 * nonce-ing every one is impractical and style injection is low-risk).
 *
 * The allow-lists are derived from the same env the app uses at runtime, so
 * pointing NEXT_PUBLIC_API_URL / _MAP_STYLE / _SENTRY_DSN at real hosts keeps
 * the CSP correct without a second place to edit.
 */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// NEXT_PUBLIC_* are inlined at build time, so this resolves once per build.
//
// Mirror lib/api.ts EXACTLY, or the CSP and the app disagree about where the
// API is: api.ts uses `NEXT_PUBLIC_API_URL ?? "http://localhost:3001"`, so an
// UNSET var means the app calls localhost:3001 (dev), while an explicit EMPTY
// string means same-origin (the Caddy demo). Getting this wrong makes the CSP
// block the app's own API calls.
const RAW_API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const API_ORIGIN = RAW_API === "" ? null : originOf(RAW_API); // null = same origin ('self')
const MAP_ORIGIN = originOf(process.env.NEXT_PUBLIC_MAP_STYLE) ?? "https://tiles.openfreemap.org";
const SENTRY_ORIGIN = originOf(process.env.NEXT_PUBLIC_SENTRY_DSN);

// fetch/XHR + WebSocket targets: the API (http+ws) and the map tile host.
//
// Dev quirk: Next inlines an unset NEXT_PUBLIC_API_URL as `undefined` in the
// client bundle (so lib/api.ts falls back to localhost:3001) but as `""` in
// the Edge/middleware bundle. So when the var is fully unset — i.e. local dev —
// the client talks to localhost:3001 while API_ORIGIN here is null. Allow the
// localhost API only in that dev case; the demo (NEXT_PUBLIC_API_URL="",
// same-origin) and production (a real https origin) both resolve cleanly.
const localApi =
  process.env.NODE_ENV !== "production" && !API_ORIGIN
    ? ["http://localhost:3001", "ws://localhost:3001"]
    : [];
const connectSrc = [
  "'self'",
  MAP_ORIGIN,
  ...(API_ORIGIN ? [API_ORIGIN, API_ORIGIN.replace(/^http/, "ws")] : []),
  ...localApi,
  ...(SENTRY_ORIGIN ? [SENTRY_ORIGIN] : []),
]
  .filter(Boolean)
  .join(" ");

function cspFor(nonce: string): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    // strict-dynamic: only Next's nonced bootstrap and what it loads may run.
    // 'unsafe-eval' is dev-only (Next's HMR needs it; production build omits).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${MAP_ORIGIN}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    // MapLibre GL builds its render workers from blob: URLs.
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = cspFor(nonce);

  // Next reads the CSP off the *request* header to nonce the scripts it emits.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  return response;
}

export const config = {
  // Everything except Next's static assets and the image optimiser — those
  // are static bytes and need no CSP, and skipping them avoids per-asset cost.
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
