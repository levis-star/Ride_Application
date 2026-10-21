import { Controller, ForbiddenException, Get, Header, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { appConfig } from "../config/app-config";
import { MetricsService } from "./metrics.service";

/**
 * Prometheus scrape endpoint.
 *
 * Not behind AuthGuard — Prometheus has no user session — but it must not be
 * world-readable either: the series expose trip volumes, dispatch latency and
 * error rates, which is commercially sensitive and useful for reconnaissance.
 * Set METRICS_TOKEN and have the scraper send `Authorization: Bearer <token>`.
 *
 * When METRICS_TOKEN is unset the endpoint stays open, so local dev and the
 * demo keep working; `assertProdSecurity()` refuses to boot production that
 * way. Note the demo's Caddy also proxies this path — another reason the token
 * matters once anything real is behind it.
 */
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header("content-type", "text/plain; version=0.0.4")
  scrape(@Req() req: FastifyRequest) {
    const expected = appConfig.metricsToken;
    if (expected) {
      const header = String(req.headers.authorization ?? "");
      const given = header.startsWith("Bearer ") ? header.slice(7) : "";
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      // Length check first: timingSafeEqual throws on a length mismatch.
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new ForbiddenException("Invalid metrics token");
      }
    }
    return this.metrics.render();
  }
}
