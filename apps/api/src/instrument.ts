import * as Sentry from "@sentry/nestjs";

/**
 * Sentry (spec §17 monitoring). Must be imported before anything else in
 * main.ts so auto-instrumentation can patch modules. With SENTRY_DSN unset
 * the SDK disables itself — zero overhead in dev/demo.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? "development",
  // Errors always; performance tracing only if the operator opts in.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE ?? 0),
});
