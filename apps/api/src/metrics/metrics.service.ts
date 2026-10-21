import { Injectable } from "@nestjs/common";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics (spec §4 observability, §15 NFR verification).
 * Scraped at GET /metrics; the prod proxy keeps that path internal.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "REST request latency",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  /** SEARCHING → first OFFERED (spec §15: p95 < 3 s). */
  readonly dispatchDecision = new Histogram({
    name: "dispatch_decision_seconds",
    help: "Time from search start to first offer",
    buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 30],
    registers: [this.registry],
  });

  readonly tripsCreated = new Counter({
    name: "trips_created_total",
    help: "Trips created",
    registers: [this.registry],
  });

  readonly tripsCompleted = new Counter({
    name: "trips_completed_total",
    help: "Trips completed",
    registers: [this.registry],
  });

  readonly offersSent = new Counter({
    name: "dispatch_offers_sent_total",
    help: "Offers sent to drivers",
    registers: [this.registry],
  });

  readonly locationPings = new Counter({
    name: "location_pings_total",
    help: "Driver GPS pings ingested",
    registers: [this.registry],
  });

  // When Redis is unreachable the rate limiter fails open (availability over
  // strict throttling). That is deliberate but must not be silent: a Redis
  // outage is then also a rate-limit outage, so alert on this series.
  readonly rateLimitFailOpen = new Counter({
    name: "rate_limit_fail_open_total",
    help: "Rate-limit checks that were skipped because the limiter store errored",
    registers: [this.registry],
  });

  readonly rateLimited = new Counter({
    name: "rate_limited_total",
    help: "Requests rejected by the rate limiter",
    labelNames: ["name"],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
