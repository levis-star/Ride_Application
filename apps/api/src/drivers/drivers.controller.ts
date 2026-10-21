import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { DriverGoOnlineSchema, LocationBatchSchema, Role } from "@rukwaride/shared";
import { AuthGuard, AuthedRequest, Roles } from "../auth/auth.guard";
import { DriversService } from "./drivers.service";
import { LocationsService } from "../locations/locations.service";

@Controller("drivers")
@UseGuards(AuthGuard)
@Roles(Role.DRIVER)
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly locations: LocationsService,
  ) {}

  @Get("me")
  async me(@Req() req: AuthedRequest) {
    const profile = await this.drivers.getProfileForUser(req.user!.sub);
    return {
      id: profile.id,
      status: profile.status,
      approvedAt: profile.approvedAt,
      walletBalance: Number(profile.walletBalance),
      negativeBalanceLimit: Number(profile.negativeBalanceLimit),
      ratingAvg: Number(profile.ratingAvg),
      strikeCount: profile.strikeCount,
      vehicle: profile.currentVehicle
        ? { plateNumber: profile.currentVehicle.plateNumber, class: profile.currentVehicle.class }
        : null,
    };
  }

  @Post("me/status")
  setStatus(@Req() req: AuthedRequest, @Body() body: unknown) {
    const dto = DriverGoOnlineSchema.parse(body);
    const pos = dto.lat !== undefined && dto.lng !== undefined ? { lat: dto.lat, lng: dto.lng } : undefined;
    return this.drivers.setStatus(req.user!.sub, dto.status, pos);
  }

  /** Day/week earnings summary for the driver app (spec §13). */
  @Get("me/earnings")
  async earnings(@Req() req: AuthedRequest) {
    const profile = await this.drivers.getProfileForUser(req.user!.sub);
    return this.drivers.earningsSummary(profile.id);
  }

  /** Wallet transaction list (ledger entries touching this driver's wallet). */
  @Get("me/ledger")
  async ledger(@Req() req: AuthedRequest) {
    const profile = await this.drivers.getProfileForUser(req.user!.sub);
    return this.drivers.ledgerList(profile.id);
  }

  /** HTTP fallback for queued GPS points when the socket is down (spec §7). */
  @Post("me/locations")
  async locationBatch(@Req() req: AuthedRequest, @Body() body: unknown) {
    const dto = LocationBatchSchema.parse(body);
    await this.locations.ingestBatch(req.user!.driverProfileId!, dto.points);
    return { ok: true, ingested: dto.points.length };
  }
}
