import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { LatLngSchema } from "@rukwaride/shared";
import { z } from "zod";
import { AuthGuard } from "../auth/auth.guard";
import { RoutingService } from "./routing.service";

const DirectionsSchema = z.object({ from: LatLngSchema, to: LatLngSchema });

/**
 * Lightweight road directions (OSRM) for any two points — used by the trip
 * screen to draw the live green route for the current leg (driver→pickup,
 * then pickup→drop). No fare computation, unlike /trips/estimate.
 */
@Controller("routing")
@UseGuards(AuthGuard)
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Post("directions")
  async directions(@Body() body: unknown) {
    const { from, to } = DirectionsSchema.parse(body);
    const route = await this.routing.route(from, to);
    return {
      distanceM: route.distanceM,
      durationS: route.durationS,
      geometry: route.geometry ?? null,
      source: route.source,
    };
  }
}
