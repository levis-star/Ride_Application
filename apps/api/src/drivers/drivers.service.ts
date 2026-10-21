import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DriverStatus as DbDriverStatus, VehicleClass as DbVehicleClass } from "@prisma/client";
import { DriverStatus, LatLng, VehicleClass } from "@rukwaride/shared";
import { appConfig } from "../config/app-config";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { ALL_VEHICLE_CLASSES, rk } from "../redis/redis-keys";
import { SocketEmitter } from "../gateways/socket-emitter.service";

/**
 * Owns driver runtime state, kept in two places by design (spec §3/§7):
 * Postgres DriverProfile.status is the durable record; the Redis hash + GEO
 * sets are the dispatch working set. Redis is rebuildable from pings.
 */
@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly emitter: SocketEmitter,
  ) {}

  /**
   * Available drivers near a point (passenger booking screen). Reads the Redis
   * GEO sets, filters to AVAILABLE + fresh pings, returns approximate positions
   * (last GPS) and a per-class count — same data the dispatch matcher uses.
   */
  async nearbyAvailable(
    at: LatLng,
    opts: { vehicleClass?: VehicleClass; radiusKm?: number; limit?: number } = {},
  ) {
    const radiusKm = opts.radiusKm ?? 5;
    const limit = opts.limit ?? 30;
    const classes = opts.vehicleClass ? [opts.vehicleClass] : [...ALL_VEHICLE_CLASSES];
    const staleCutoff = Date.now() - appConfig.location.staleExcludeS * 1000;
    const drivers: Array<{ vehicleClass: string; lat: number; lng: number; distanceM: number }> = [];
    const countByClass: Record<string, number> = { BODABODA: 0, BAJAJI: 0, CAR: 0 };

    for (const cls of classes) {
      const found = (await this.redis.client.geosearch(
        rk.geoDrivers(cls),
        "FROMLONLAT",
        at.lng,
        at.lat,
        "BYRADIUS",
        radiusKm,
        "km",
        "ASC",
        "WITHCOORD",
        "WITHDIST",
        "COUNT",
        50,
      )) as Array<[string, string, [string, string]]>;

      for (const [id, dist, [lng, lat]] of found) {
        const [status, updatedAt] = await this.redis.client.hmget(rk.driver(id), "status", "updatedAt");
        if (status !== DriverStatus.AVAILABLE || Number(updatedAt ?? 0) < staleCutoff) continue;
        countByClass[cls] = (countByClass[cls] ?? 0) + 1;
        drivers.push({
          vehicleClass: cls,
          lat: Number(lat),
          lng: Number(lng),
          distanceM: Math.round(Number(dist) * 1000),
        });
      }
    }
    drivers.sort((a, b) => a.distanceM - b.distanceM);
    return { drivers: drivers.slice(0, limit), countByClass };
  }

  /**
   * Fleet registration + live availability by vehicle class (admin view).
   * "How many bodaboda/bajaji do we have, how many are online right now."
   */
  async fleetCounts() {
    const classes = [...ALL_VEHICLE_CLASSES] as DbVehicleClass[];
    const result: Record<string, { registered: number; approved: number; online: number; available: number }> = {};
    for (const cls of classes) {
      const [registered, approved, online, available] = await Promise.all([
        this.prisma.driverProfile.count({ where: { currentVehicle: { class: cls } } }),
        this.prisma.driverProfile.count({ where: { currentVehicle: { class: cls }, approvedAt: { not: null } } }),
        this.prisma.driverProfile.count({
          where: { currentVehicle: { class: cls }, status: { in: ["AVAILABLE", "ON_OFFER", "ON_TRIP"] } },
        }),
        this.prisma.driverProfile.count({ where: { currentVehicle: { class: cls }, status: "AVAILABLE" } }),
      ]);
      result[cls] = { registered, approved, online, available };
    }
    return result;
  }

  async getProfileForUser(userId: string) {
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId },
      include: { currentVehicle: true, user: true },
    });
    if (!profile) throw new NotFoundException("No driver profile");
    return profile;
  }

  /** Driver-initiated online/offline toggle (REST). */
  async setStatus(userId: string, status: "AVAILABLE" | "OFFLINE", pos?: LatLng) {
    const profile = await this.getProfileForUser(userId);

    if (status === "AVAILABLE") {
      if (!profile.approvedAt) throw new ForbiddenException("Onboarding not approved yet");
      if (!profile.currentVehicle || !profile.currentVehicle.active) {
        throw new BadRequestException("No active vehicle assigned");
      }
      if (Number(profile.walletBalance) < Number(profile.negativeBalanceLimit)) {
        throw new ForbiddenException("Wallet below limit — top up to go online");
      }
      if (profile.status === DbDriverStatus.ON_TRIP || profile.status === DbDriverStatus.ON_OFFER) {
        throw new BadRequestException(`Cannot go AVAILABLE while ${profile.status}`);
      }
      await this.applyRuntimeStatus(profile.id, DriverStatus.AVAILABLE, {
        vehicleClass: profile.currentVehicle.class,
        pos,
      });
      return { status: DriverStatus.AVAILABLE };
    }

    if (profile.status === DbDriverStatus.ON_TRIP) {
      throw new BadRequestException("Finish the active trip before going offline");
    }
    await this.applyRuntimeStatus(profile.id, DriverStatus.OFFLINE, {});
    return { status: DriverStatus.OFFLINE };
  }

  async earningsSummary(driverProfileId: string) {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(dayStart);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday

    const summarize = async (since: Date) => {
      const trips = await this.prisma.trip.findMany({
        where: { driverId: driverProfileId, status: "COMPLETED", completedAt: { gte: since } },
        select: { finalFare: true, fareBreakdown: true },
      });
      let gross = 0;
      let earnings = 0;
      for (const t of trips) {
        gross += Number(t.finalFare ?? 0);
        const b = t.fareBreakdown as { driverEarnings?: number } | null;
        earnings += b?.driverEarnings ?? 0;
      }
      return { trips: trips.length, gross, earnings };
    };

    return { day: await summarize(dayStart), week: await summarize(weekStart), currency: "TZS" };
  }

  async ledgerList(driverProfileId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { driverId: driverProfileId, account: "DRIVER_WALLET" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return entries.map((e) => ({
      id: e.id,
      at: e.createdAt,
      // Wallet view: credits increase the driver's balance, debits decrease it.
      amount: Number(e.credit) - Number(e.debit),
      memo: e.memo,
      tripId: e.tripId,
    }));
  }

  /**
   * Single write-path for driver runtime status: updates Postgres, the Redis
   * hash, and GEO membership together. Dispatch and TripService use this too.
   */
  async applyRuntimeStatus(
    driverProfileId: string,
    status: DriverStatus,
    opts: { vehicleClass?: string; pos?: LatLng; tripId?: string | null; notifyReason?: string },
  ): Promise<void> {
    await this.prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: { status: status as DbDriverStatus },
    });

    const key = rk.driver(driverProfileId);
    if (status === DriverStatus.OFFLINE) {
      const pipeline = this.redis.client.pipeline();
      pipeline.hset(key, { status, updatedAt: Date.now() });
      pipeline.hdel(key, "tripId");
      for (const cls of ALL_VEHICLE_CLASSES) pipeline.zrem(rk.geoDrivers(cls), driverProfileId);
      await pipeline.exec();
    } else {
      const fields: Record<string, string | number> = { status, updatedAt: Date.now() };
      if (opts.vehicleClass) fields.vehicleClass = opts.vehicleClass;
      if (opts.tripId !== undefined) {
        if (opts.tripId === null) {
          await this.redis.client.hdel(key, "tripId");
        } else {
          fields.tripId = opts.tripId;
        }
      }
      await this.redis.client.hset(key, fields);
      if (opts.pos && opts.vehicleClass) {
        await this.redis.client.geoadd(rk.geoDrivers(opts.vehicleClass), opts.pos.lng, opts.pos.lat, driverProfileId);
      }
    }
    if (opts.notifyReason) {
      this.emitter.driverStatusChanged(driverProfileId, status, opts.notifyReason);
    }
  }
}
