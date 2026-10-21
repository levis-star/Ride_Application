import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { randomBytes } from "node:crypto";
import { FastifyRequest } from "fastify";
import { appConfig } from "../config/app-config";
import { MetricsService } from "../metrics/metrics.service";
import { RedisService } from "../redis/redis.service";
import { AuthedRequest } from "./auth.guard";

export interface RateLimitSpec {
  /** requests allowed per window */
  points: number;
  windowS: number;
  /** bucket key: caller IP, authed user id, or the phone in the body */
  scope: "ip" | "user" | "phone";
  name?: string;
}

const RATE_LIMIT_KEY = "rate-limit";
export const RateLimit = (spec: RateLimitSpec) => SetMetadata(RATE_LIMIT_KEY, spec);

/**
 * Redis **sliding-window** rate limiter (spec §14: auth, OTP, trip creation).
 *
 * A sliding window rather than a fixed one: a fixed-window counter lets a
 * caller send up to 2× the limit by straddling the reset boundary (full quota
 * at 0:59, full quota again at 1:00). The window here always looks back
 * exactly `windowS` from now, so the limit holds continuously — which matters
 * most for the auth/OTP routes this guards.
 *
 * Implemented as a sorted set of request timestamps: trim everything older
 * than the window, add this request, count what remains. Run in a MULTI so the
 * trim/add/count are atomic.
 *
 * Fail-open on Redis errors — throttling must never take the platform down —
 * but every fail-open is counted (rate_limit_fail_open_total) and logged, so a
 * Redis outage that silently disables throttling is visible on the dashboard.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.get<RateLimitSpec | undefined>(RATE_LIMIT_KEY, context.getHandler());
    if (!spec) return true;
    if (appConfig.authDemoMode) return true; // relaxed for open demo testing

    const req = context.switchToHttp().getRequest<FastifyRequest & AuthedRequest>();
    let subject: string;
    switch (spec.scope) {
      case "user":
        subject = req.user?.sub ?? req.ip;
        break;
      case "phone":
        subject = (req.body as { phone?: string } | undefined)?.phone ?? req.ip;
        break;
      default:
        subject = req.ip;
    }
    const name = spec.name ?? context.getHandler().name;
    const bucket = `rl:${name}:${subject}`;
    const now = Date.now();
    const windowStart = now - spec.windowS * 1000;
    // Unique member per request so two calls in the same millisecond both count.
    const member = `${now}-${randomBytes(6).toString("hex")}`;

    try {
      const results = await this.redis.client
        .multi()
        .zremrangebyscore(bucket, 0, windowStart) // drop entries outside the window
        .zadd(bucket, now, member) // record this request
        .zcard(bucket) // how many in the window now
        .expire(bucket, spec.windowS) // let idle buckets self-clean
        .exec();

      // exec() → [[err, res], …]; the ZCARD is the third command.
      const count = Number(results?.[2]?.[1] ?? 0);
      if (count > spec.points) {
        // This request is over the limit — undo its own record so a caller
        // hammering the endpoint cannot keep the window permanently full.
        await this.redis.client.zrem(bucket, member).catch(() => undefined);
        this.metrics.rateLimited.inc({ name });
        const retry = Math.max(1, Math.ceil(spec.windowS));
        throw new HttpException(`Too many requests — retry in ${retry}s`, 429);
      }
      return true;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Redis hiccup → fail open, but make it visible rather than silent.
      this.metrics.rateLimitFailOpen.inc();
      this.logger.warn(`rate limiter failed open for ${name}: ${(err as Error).message}`);
      return true;
    }
  }
}
