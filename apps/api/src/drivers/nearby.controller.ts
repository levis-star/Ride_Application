import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { VehicleClass } from "@rukwaride/shared";
import { z } from "zod";
import { AuthGuard } from "../auth/auth.guard";
import { DriversService } from "./drivers.service";

const NearbySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  vehicleClass: z.enum(["BODABODA", "BAJAJI", "CAR"]).optional(),
  radiusKm: z.coerce.number().min(0.5).max(15).optional(),
});

/**
 * Available drivers near a point — shown on the passenger booking screen
 * ("bodaboda karibu nawe") and usable by staff. Any authenticated user.
 */
@Controller("drivers")
@UseGuards(AuthGuard)
export class NearbyController {
  constructor(private readonly drivers: DriversService) {}

  @Get("nearby")
  nearby(@Query() query: unknown) {
    const q = NearbySchema.parse(query);
    return this.drivers.nearbyAvailable(
      { lat: q.lat, lng: q.lng },
      { vehicleClass: q.vehicleClass as VehicleClass | undefined, radiusKm: q.radiusKm },
    );
  }
}
