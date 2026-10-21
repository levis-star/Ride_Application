import "./instrument"; // Sentry first — patches happen before anything loads
import "reflect-metadata";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { appConfig, assertProdSecurity } from "./config/app-config";
import { MetricsService } from "./metrics/metrics.service";
import { RedisIoAdapter } from "./redis-io.adapter";
import { ZodExceptionFilter } from "./zod-exception.filter";

async function bootstrap() {
  // Fail fast rather than serve production with a dev-only fallback active
  // (demo OTP mode, open /metrics, default webhook secret …). No-op outside
  // production. See docs/security-assessment.md (M-4).
  assertProdSecurity();

  // Sentry (spec §4): only active when a DSN is supplied by the operator.
  if (process.env.SENTRY_DSN_API) {
    const Sentry = await import("@sentry/node");
    Sentry.init({ dsn: process.env.SENTRY_DSN_API, tracesSampleRate: 0.1 });
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Behind Caddy + Cloudflare Tunnel: read X-Forwarded-* for correct
      // client IP and HTTPS detection.
      trustProxy: true,
      // Driver document uploads arrive as base64 JSON (~5 MB decoded max).
      bodyLimit: 8 * 1024 * 1024,
      // pino structured logs with PII redaction (spec §4/§14).
      logger: {
        level: process.env.LOG_LEVEL ?? "info",
        /*
         * PII redaction (spec §4/§14). `nida` is a Tanzanian National ID —
         * among the most sensitive identifiers a citizen has — and licence
         * numbers identify a driver uniquely, so neither may reach a log
         * aggregator. Both the camelCase (our models) and the CeTS wire names
         * are listed, because LATRA payloads are logged on failure.
         */
        redact: [
          "req.headers.authorization",
          "req.headers.cookie",
          "*.phone",
          "*.password",
          "*.nida",
          "*.email",
          "*.licenseNumber",
          "*.licenceCategory",
          "*.passengerNida",
          "*.passengerPhone",
          "*.passengerName",
          "*.driverLicenseNumber",
          "*.driverPhone",
          "*.driverEmail",
        ],
      },
    }),
    // rawBody: webhook signatures verify against the exact bytes the
    // aggregator sent (spec §14) — Nest exposes them as request.rawBody.
    { rawBody: true },
  );
  const fastify = app.getHttpAdapter().getInstance();
  await app.register(cookie as never);
  await app.register(helmet as never, { contentSecurityPolicy: false });
  app.useGlobalFilters(new ZodExceptionFilter());

  // CORS locked to app origins (spec §14). Native apps send no Origin header
  // and bypass CORS by design.
  const origins = (process.env.WEB_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim());
  app.enableCors({ origin: origins, credentials: true });
  app.enableShutdownHooks();

  // REST latency histogram (spec §15: p95 < 300 ms).
  const metrics = app.get(MetricsService);
  fastify.addHook("onResponse", (req, reply, done) => {
    const route = req.routeOptions?.url ?? req.url.split("?")[0] ?? "unknown";
    if (route !== "/metrics" && route !== "/health") {
      metrics.httpDuration.observe(
        { method: req.method, route, status: String(reply.statusCode) },
        reply.elapsedTime / 1000,
      );
    }
    done();
  });

  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  await app.listen(appConfig.port, "0.0.0.0");
  console.log(`RukwaRide API listening on :${appConfig.port}`);
}

void bootstrap();
