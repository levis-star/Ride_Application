import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  CreateTripSchema,
  LatLngSchema,
  QuickMessageSchema,
  Role,
  SosRaiseSchema,
  TripActionSchema,
} from "@rukwaride/shared";
import { z } from "zod";
import { AuthGuard, AuthedRequest, Roles } from "../auth/auth.guard";
import { RateLimit, RateLimitGuard } from "../auth/rate-limit.guard";
import { TripsService } from "./trips.service";
import { TripSafetyService } from "./trip-safety.service";

const CancelSchema = z.object({ reason: z.string().max(300).optional() });
const EstimateSchema = z.object({ pickup: LatLngSchema, drop: LatLngSchema });
const RatingSchema = z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(300).optional() });

@Controller("trips")
@UseGuards(AuthGuard, RateLimitGuard)
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly safety: TripSafetyService,
  ) {}

  private actor(req: AuthedRequest) {
    return { userId: req.user!.sub, role: req.user!.role, driverProfileId: req.user!.driverProfileId };
  }

  /** Emergency alert on an active trip (passenger or assigned driver). */
  @Post(":id/sos")
  @Roles(Role.PASSENGER, Role.DRIVER)
  sos(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.safety.raiseSos(this.actor(req), id, SosRaiseSchema.parse(body ?? {}));
  }

  /** Create/return a public share-my-trip link. */
  @Post(":id/share")
  share(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.safety.createShareLink(this.actor(req), id);
  }

  /** Quick pre-written message to the trip counterparty. */
  @Post(":id/message")
  @Roles(Role.PASSENGER, Role.DRIVER)
  message(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.safety.sendQuickMessage(this.actor(req), id, QuickMessageSchema.parse(body).message);
  }

  @Post()
  @Roles(Role.PASSENGER, Role.DISPATCHER, Role.ADMIN)
  @RateLimit({ points: 5, windowS: 60, scope: "user", name: "trip-create" })
  create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const dto = CreateTripSchema.parse(body);
    return this.trips.createTrip(req.user!.sub, req.user!.role, dto);
  }

  @Post("estimate")
  estimate(@Body() body: unknown) {
    const dto = EstimateSchema.parse(body);
    return this.trips.estimateAllClasses(dto.pickup, dto.drop);
  }

  @Get()
  history(@Req() req: AuthedRequest) {
    return this.trips.history(req.user!.sub, req.user!.driverProfileId);
  }

  @Get(":id")
  get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.trips.getTrip(req.user!.sub, req.user!.role, req.user!.driverProfileId, id);
  }

  @Get(":id/snapshot")
  async snapshot(@Req() req: AuthedRequest, @Param("id") id: string) {
    // RBAC via getTrip, then the richer card the trip screen renders
    await this.trips.getTrip(req.user!.sub, req.user!.role, req.user!.driverProfileId, id);
    return this.trips.snapshot(id);
  }

  @Post(":id/rating")
  rate(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const dto = RatingSchema.parse(body);
    return this.trips.rate(req.user!.sub, id, dto.score, dto.comment);
  }

  @Post(":id/action")
  @Roles(Role.DRIVER)
  action(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const dto = TripActionSchema.parse(body);
    const pos = dto.lat !== undefined && dto.lng !== undefined ? { lat: dto.lat, lng: dto.lng } : undefined;
    return this.trips.driverAction(req.user!.driverProfileId!, id, dto.action, pos, dto.reason);
  }

  @Post(":id/cancel")
  @Roles(Role.PASSENGER, Role.DISPATCHER, Role.ADMIN)
  cancel(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const dto = CancelSchema.parse(body ?? {});
    return this.trips.passengerCancel(req.user!.sub, req.user!.role, id, dto.reason);
  }
}
