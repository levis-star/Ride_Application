import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { RateLimit, RateLimitGuard } from "../auth/rate-limit.guard";
import { TripSafetyService } from "./trip-safety.service";

/**
 * Unauthenticated share-my-trip view (Bolt-style). No AuthGuard by design —
 * the opaque token is the capability; the payload is deliberately minimal and
 * carries no passenger PII.
 *
 * Rate-limited because this is one of the few routes reachable with no
 * credential at all. The token is 128 bits so guessing is infeasible; the
 * limit is there to stop scraping and cheap request amplification, and is set
 * generously so a family watching a live trip is never throttled.
 */
@Controller("public")
@UseGuards(RateLimitGuard)
export class PublicController {
  constructor(private readonly safety: TripSafetyService) {}

  @Get("trips/:token")
  @RateLimit({ points: 120, windowS: 60, scope: "ip", name: "public-trip-view" })
  view(@Param("token") token: string) {
    return this.safety.sharedTripView(token);
  }
}
