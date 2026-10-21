import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Role, SosResolveSchema, TripStatus } from "@rukwaride/shared";
import { z } from "zod";
import { AuthGuard, AuthedRequest, Roles } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { DispatchService } from "./dispatch.service";
import { TripSafetyService } from "../trips/trip-safety.service";

const AssignSchema = z.object({
  driverProfileId: z.string().min(1),
  force: z.boolean().default(false),
});

/** Dispatcher console backend (spec §13): staff-only. */
@Controller("dispatch")
@UseGuards(AuthGuard)
@Roles(Role.DISPATCHER, Role.ADMIN)
export class DispatchController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly safety: TripSafetyService,
  ) {}

  /** Open/active emergency alerts for the welfare-response panel. */
  @Get("sos-alerts")
  sosAlerts(@Query("status") status?: string) {
    return this.safety.listSosAlerts(status);
  }

  @Post("sos-alerts/:id/ack")
  ackSos(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.safety.ackSos(req.user!.sub, id);
  }

  @Post("sos-alerts/:id/resolve")
  resolveSos(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.safety.resolveSos(req.user!.sub, id, SosResolveSchema.parse(body ?? {}).resolutionNote);
  }

  /** Live map data: every driver with a Redis runtime hash + fresh position. */
  @Get("drivers/online")
  async onlineDrivers() {
    const results: Array<Record<string, unknown>> = [];
    let cursor = "0";
    const ids: string[] = [];
    const states: Array<Record<string, string>> = [];
    do {
      const [next, keys] = await this.redis.client.scan(cursor, "MATCH", "driver:*", "COUNT", 200);
      cursor = next;
      for (const key of keys) {
        const state = await this.redis.client.hgetall(key);
        if (!state.status || state.status === "OFFLINE") continue;
        ids.push(key.slice("driver:".length));
        states.push(state);
      }
    } while (cursor !== "0");

    const profiles = await this.prisma.driverProfile.findMany({
      where: { id: { in: ids } },
      include: { user: true, currentVehicle: true },
    });
    const byId = new Map(profiles.map((p) => [p.id, p]));
    ids.forEach((id, i) => {
      const p = byId.get(id);
      const s = states[i]!;
      results.push({
        driverProfileId: id,
        name: p?.user.name ?? id,
        phone: p?.user.phone,
        plateNumber: p?.currentVehicle?.plateNumber,
        vehicleClass: s.vehicleClass ?? p?.currentVehicle?.class,
        status: s.status,
        lat: s.lat ? Number(s.lat) : null,
        lng: s.lng ? Number(s.lng) : null,
        manualAssignConsent: p?.manualAssignConsent ?? false,
        lastPingAgoS: s.updatedAt ? Math.round((Date.now() - Number(s.updatedAt)) / 1000) : null,
      });
    });
    return results;
  }

  /** Active trips board. */
  @Get("trips/active")
  async activeTrips() {
    const trips = await this.prisma.trip.findMany({
      where: {
        status: {
          in: [
            TripStatus.REQUESTED,
            TripStatus.SEARCHING,
            TripStatus.OFFERED,
            TripStatus.ACCEPTED,
            TripStatus.ARRIVED,
            TripStatus.IN_PROGRESS,
          ] as never[],
        },
      },
      include: {
        passenger: { select: { name: true, phone: true } },
        driver: { include: { user: { select: { name: true, phone: true } } } },
        pickupLandmark: true,
        dropLandmark: true,
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return trips.map((t) => ({
      id: t.id,
      status: t.status,
      vehicleClass: t.vehicleClass,
      source: t.source,
      createdAt: t.createdAt,
      passenger: t.passenger ? { name: t.passenger.name, phone: t.passenger.phone } : { phone: t.contactPhone },
      driver: t.driver ? { id: t.driverId, name: t.driver.user.name, phone: t.driver.user.phone } : null,
      pickup: { lat: Number(t.pickupLat), lng: Number(t.pickupLng), label: t.pickupLandmark?.name },
      drop: { lat: Number(t.dropLat), lng: Number(t.dropLng), label: t.dropLandmark?.name },
      estimatedFare: Number(t.estimatedFare),
      offeredCount: t.offeredDriverIds.length,
      cancellationFee: t.cancellationFee === null ? null : Number(t.cancellationFee),
    }));
  }

  @Post("trips/:id/assign")
  assign(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const dto = AssignSchema.parse(body);
    return this.dispatch.manualAssign(
      { userId: req.user!.sub, role: req.user!.role as "DISPATCHER" | "ADMIN" },
      id,
      dto.driverProfileId,
      dto.force,
    );
  }

  @Post("trips/:id/reassign")
  reassign(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.dispatch.reassign(req.user!.sub, id);
  }

  /** Waive a cancellation fee (spec §8: waivable by dispatcher/admin). */
  @Post("trips/:id/waive-fee")
  async waiveFee(@Req() req: AuthedRequest, @Param("id") id: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id } });
    if (!trip) return { ok: false };
    const before = trip.cancellationFee === null ? null : Number(trip.cancellationFee);
    await this.prisma.$transaction([
      this.prisma.trip.update({ where: { id }, data: { cancellationFee: 0 } }),
      this.prisma.auditLog.create({
        data: {
          actorId: req.user!.sub,
          action: "CANCELLATION_FEE_WAIVED",
          entity: "Trip",
          entityId: id,
          before: { cancellationFee: before },
          after: { cancellationFee: 0 },
        },
      }),
    ]);
    return { ok: true, previousFee: before };
  }
}
