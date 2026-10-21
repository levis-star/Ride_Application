import { randomBytes } from "node:crypto";
import { ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, Trip } from "@prisma/client";
import {
  QuickMessage,
  canSendQuickMessage,
  Role,
  SharedTripView,
  SosAlertDto,
  SosRaiseDto,
  TripKind,
  TripStatus,
  VehicleClass,
} from "@rukwaride/shared";
import { appConfig } from "../config/app-config";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { rk } from "../redis/redis-keys";
import { SocketEmitter } from "../gateways/socket-emitter.service";

const LIVE_STATUSES: TripStatus[] = [TripStatus.ACCEPTED, TripStatus.ARRIVED, TripStatus.IN_PROGRESS];

interface Actor {
  userId: string;
  role: Role;
  driverProfileId?: string;
}

/**
 * Rider-safety & comfort features that sit alongside the trip lifecycle:
 * SOS/emergency alerts, share-my-trip public links, and quick pre-written
 * messages. Kept out of the (already large) TripsService but shares its
 * "party to the trip" authorization rule.
 */
@Injectable()
export class TripSafetyService {
  private readonly logger = new Logger(TripSafetyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly emitter: SocketEmitter,
  ) {}

  /** Passenger owner, assigned driver, or staff — otherwise 403/404. */
  private assertParty(trip: Trip, actor: Actor): "PASSENGER" | "DRIVER" | "STAFF" {
    if (actor.role === Role.ADMIN || actor.role === Role.DISPATCHER) return "STAFF";
    if (trip.passengerId === actor.userId || trip.createdById === actor.userId) return "PASSENGER";
    if (actor.driverProfileId && trip.driverId === actor.driverProfileId) return "DRIVER";
    throw new ForbiddenException("Not your trip");
  }

  private async loadTrip(tripId: string): Promise<Trip> {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException("Trip not found");
    return trip;
  }

  private async driverPosition(driverProfileId: string | null): Promise<{ lat: number; lng: number } | null> {
    if (!driverProfileId) return null;
    const s = await this.redis.client.hmget(rk.driver(driverProfileId), "lat", "lng");
    const [lat, lng] = s;
    return lat && lng ? { lat: Number(lat), lng: Number(lng) } : null;
  }

  // ---------- SOS ----------

  async raiseSos(actor: Actor, tripId: string, dto: SosRaiseDto): Promise<{ id: string; status: string }> {
    const trip = await this.loadTrip(tripId);
    const party = this.assertParty(trip, actor);
    // Fall back to the driver's last known position if none supplied.
    const pos =
      dto.lat !== undefined && dto.lng !== undefined
        ? { lat: dto.lat, lng: dto.lng }
        : await this.driverPosition(trip.driverId);

    const alert = await this.prisma.sosAlert.create({
      data: {
        tripId,
        raisedById: actor.userId,
        raisedByRole: actor.role as never,
        lat: pos ? new Prisma.Decimal(pos.lat) : null,
        lng: pos ? new Prisma.Decimal(pos.lng) : null,
        note: dto.note,
      },
    });
    this.logger.warn(`SOS raised on trip ${tripId} by ${party} ${actor.userId} (alert ${alert.id})`);
    return { id: alert.id, status: alert.status };
  }

  async listSosAlerts(status?: string): Promise<SosAlertDto[]> {
    const alerts = await this.prisma.sosAlert.findMany({
      where: status ? { status: status as never } : { status: { not: "RESOLVED" } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        raisedBy: true,
        trip: { include: { driver: { include: { user: true } }, vehicle: true } },
      },
    });
    return alerts.map((a) => ({
      id: a.id,
      tripId: a.tripId,
      status: a.status as never,
      raisedByRole: a.raisedByRole,
      raisedByName: a.raisedBy.name,
      raisedByPhone: a.raisedBy.phone,
      lat: a.lat === null ? null : Number(a.lat),
      lng: a.lng === null ? null : Number(a.lng),
      note: a.note,
      createdAt: a.createdAt.toISOString(),
      acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      driver:
        a.trip.driver && a.trip.vehicle
          ? {
              name: a.trip.driver.user.name,
              phone: a.trip.driver.user.phone,
              plateNumber: a.trip.vehicle.plateNumber,
            }
          : null,
    }));
  }

  async ackSos(adminId: string, alertId: string): Promise<{ status: string }> {
    const alert = await this.prisma.sosAlert.findUnique({ where: { id: alertId } });
    if (!alert) throw new NotFoundException("Alert not found");
    await this.prisma.sosAlert.update({
      where: { id: alertId },
      data: { status: "ACKNOWLEDGED", acknowledgedById: adminId, acknowledgedAt: new Date() },
    });
    return { status: "ACKNOWLEDGED" };
  }

  async resolveSos(adminId: string, alertId: string, note?: string): Promise<{ status: string }> {
    const alert = await this.prisma.sosAlert.findUnique({ where: { id: alertId } });
    if (!alert) throw new NotFoundException("Alert not found");
    await this.prisma.sosAlert.update({
      where: { id: alertId },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolutionNote: note,
        acknowledgedById: alert.acknowledgedById ?? adminId,
        acknowledgedAt: alert.acknowledgedAt ?? new Date(),
      },
    });
    return { status: "RESOLVED" };
  }

  // ---------- share-my-trip ----------

  async createShareLink(actor: Actor, tripId: string): Promise<{ token: string; url: string }> {
    const trip = await this.loadTrip(tripId);
    this.assertParty(trip, actor);
    let token = trip.shareToken;
    if (!token) {
      token = randomBytes(16).toString("base64url");
      await this.prisma.trip.update({ where: { id: tripId }, data: { shareToken: token } });
    }
    return { token, url: `${appConfig.appBaseUrl}/track/${token}` };
  }

  /**
   * Public, unauthenticated — deliberately minimal, no passenger PII.
   *
   * The link stops working a while after the trip ends. It used to work
   * forever, which meant anyone who was ever sent a link could keep reading
   * that trip's pickup and drop coordinates plus the driver's name and plate
   * indefinitely. A share link is for the journey, not a permanent record.
   */
  async sharedTripView(token: string): Promise<SharedTripView> {
    const trip = await this.prisma.trip.findUnique({
      where: { shareToken: token },
      include: { driver: { include: { user: true } }, vehicle: true },
    });
    if (!trip) throw new NotFoundException("Link not found");
    const live = LIVE_STATUSES.includes(trip.status as TripStatus);
    if (!live) {
      const endedAt = trip.completedAt ?? trip.cancelledAt ?? trip.updatedAt;
      const ageS = (Date.now() - endedAt.getTime()) / 1000;
      if (ageS > appConfig.shareLinkGraceS) throw new NotFoundException("Link has expired");
    }
    return {
      status: trip.status as TripStatus,
      kind: trip.kind as TripKind,
      vehicleClass: trip.vehicleClass as VehicleClass,
      pickup: { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) },
      drop: { lat: Number(trip.dropLat), lng: Number(trip.dropLng) },
      driver:
        trip.driver && trip.vehicle
          ? {
              name: trip.driver.user.name,
              plateNumber: trip.vehicle.plateNumber,
              vehicleClass: trip.vehicle.class as VehicleClass,
            }
          : null,
      driverPosition: live ? await this.driverPosition(trip.driverId) : null,
    };
  }

  // ---------- quick messages ----------

  async sendQuickMessage(actor: Actor, tripId: string, message: QuickMessage): Promise<{ ok: true }> {
    const trip = await this.loadTrip(tripId);
    const party = this.assertParty(trip, actor);
    if (party === "STAFF") throw new ForbiddenException("Staff use the dispatcher tools");
    // Driver-informational phrases ("on my way", "I'm outside") are the
    // driver's to send; the passenger has its own short set.
    if (!canSendQuickMessage(party, message)) {
      throw new ForbiddenException(`A ${party.toLowerCase()} cannot send "${message}"`);
    }
    const ev = { tripId, from: party, message, at: new Date().toISOString() } as const;
    if (party === "PASSENGER") {
      if (trip.driverId) this.emitter.quickMessageToDriver(trip.driverId, ev);
    } else {
      this.emitter.quickMessageToPassenger(tripId, ev);
    }
    return { ok: true };
  }
}
