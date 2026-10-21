"use client";

import { useEffect } from "react";

/**
 * Browser-side crash reporting (spec §17). Deliberately the thin
 * @sentry/browser client, not the full Next.js integration: the PWA is a
 * light shell over the API (which has its own Sentry) and doesn't warrant
 * build-plugin/source-map machinery. No NEXT_PUBLIC_SENTRY_DSN → no-op.
 */
export default function SentryInit() {
  useEffect(() => {
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (!dsn) return;
    void import("@sentry/browser").then((Sentry) =>
      Sentry.init({ dsn, environment: process.env.NODE_ENV }),
    );
  }, []);
  return null;
}
