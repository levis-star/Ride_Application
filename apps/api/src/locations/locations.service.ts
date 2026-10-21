import { Injectable, Logger } from "@nestjs/common";
import { DriverStatus as DbDriverStatus, Prisma, TripStatus as DbTripStatus } from "@prisma/client";
import { DriverStatus, LocationPingDto } from "@rukwaride/shared";
import { appConfig } from "../config/app-config";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { rk } from "../redis/redis-keys";
import { SocketEmitter } from "../gateways/socket-emitter.service";
import { DriversService } from "../drivers/drivers.service";
import { MetricsService } from "../metrics/metrics.service";

/**
 * GPS ingestion (spec §7): socket pings (or HTTP batches) → Redis GEO + driver
 * hash. Points for ACTIVE trips are buffered in a Redis list and flushed to
 * TripLocationPoint in batches; idle-driver history is never persisted.
 */
@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly emitter: SocketEmitter,
    private readonly drivers: DriversService,
    private readonly metrics: MetricsService,
  ) {}

  async ingest(driverProfileId: string, ping: LocationPingDto): Promise<void> {
    this.metrics.locationPings.inc();
    const key = rk.driver(driverProfileId);
    const state = await this.redis.client.hgetall(key);
    if (!state.status || state.status === DriverStatus.OFFLINE) return; // ignore pings while offline

    const pipeline = this.redis.client.pipeline();
    pipeline.hset(key, {
      lat: ping.lat,
      lng: ping.lng,
      heading: ping.heading ?? "",
      updatedAt: Date.now(),
    });
    if (state.vehicleClass) {
      pipeline.geoadd(rk.geoDrivers(state.vehicleClass), ping.lng, ping.lat, driverProfileId);
    }
    if (state.tripId) {
      pipeline.rpush(
        rk.tripPoints(state.tripId),
        JSON.stringify({ lat: ping.lat, lng: ping.lng, recordedAt: ping.recordedAt }),
      );
      pipeline.expire(rk.tripPoints(state.tripId), 6 * 3600);
    }
    await pipeline.exec();

    if (state.tripId) {
      this.emitter.driverLocationToPassenger(state.tripId, {
        tripId: state.tripId,
        lat: ping.lat,
        lng: ping.lng,
        heading: ping.heading,
      });
    }
  }

  async ingestBatch(driverProfileId: string, points: LocationPingDto[]): Promise<void> {
    // Offline-queue flush: replay in order; only the freshest point matters
    // for GEO, all of them matter for an active trip trace.
    const sorted = [...points].sort((a, b) => a.recordedAt - b.recordedAt);
    for (const p of sorted) {
      await this.ingest(driverProfileId, p);
    }
  }

  /** Moves buffered trace points from Redis into Postgres. Runs every 10 s. */
  async flushTripPoints(): Promise<number> {
    let flushed = 0;
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.client.scan(cursor, "MATCH", "trip:points:*", "COUNT", 100);
      cursor = next;
      for (const key of keys) {
        const tripId = key.slice("trip:points:".length);
        const raw = await this.redis.client.lpop(key, 500);
        if (!raw || raw.length === 0) continue;
        const rows = raw.map((r) => {
          const p = JSON.parse(r) as { lat: number; lng: number; recordedAt: number };
          return {
            tripId,
            lat: new Prisma.Decimal(p.lat),
            lng: new Prisma.Decimal(p.lng),
            recordedAt: new Date(p.recordedAt),
          };
        });
        await this.prisma.tripLocationPoint.createMany({ data: rows });
        flushed += rows.length;
      }
    } while (cursor !== "0");
    return flushed;
  }

  /** Force-flush one trip's buffer (called at completion before final-fare calc). */
  async flushTripPointsFor(tripId: string): Promise<void> {
    const key = rk.tripPoints(tripId);
    const raw = await this.redis.client.lpop(key, 5000);
    if (!raw || raw.length === 0) return;
    await this.prisma.tripLocationPoint.createMany({
      data: raw.map((r) => {
        const p = JSON.parse(r) as { lat: number; lng: number; recordedAt: number };
        return {
          tripId,
          lat: new Prisma.Decimal(p.lat),
          lng: new Prisma.Decimal(p.lng),
          recordedAt: new Date(p.recordedAt),
        };
      }),
    });
  }

  /**
   * Staleness sweep (spec §7): drivers silent > 120 s are auto-set OFFLINE and
   * notified. (The 30 s matching exclusion happens at candidate-filter time.)
   */
  async sweepStaleDrivers(): Promise<number> {
    const cutoff = Date.now() - appConfig.location.offlineS * 1000;
    let swept = 0;
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.client.scan(cursor, "MATCH", "driver:*", "COUNT", 200);
      cursor = next;
      for (const key of keys) {
        const state = await this.redis.client.hgetall(key);
        if (!state.status) continue;
        if (state.status !== DriverStatus.AVAILABLE && state.status !== DriverStatus.ON_OFFER) continue;
        if (Number(state.updatedAt ?? 0) > cutoff) continue;
        const driverProfileId = key.slice("driver:".length);
        // Double-check durable state so we never knock an ON_TRIP driver offline.
        const profile = await this.prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
        if (!profile || profile.status === DbDriverStatus.ON_TRIP) continue;
        await this.drivers.applyRuntimeStatus(driverProfileId, DriverStatus.OFFLINE, {
          notifyReason: "STALE_LOCATION",
        });
        swept++;
        this.logger.warn(`Driver ${driverProfileId} auto-OFFLINE (no ping > ${appConfig.location.offlineS}s)`);
      }
    } while (cursor !== "0");
    return swept;
  }

  /** Trace for final-fare calculation (flushed points only; call flushTripPointsFor first). */
  async tripTrace(tripId: string, since?: Date) {
    const points = await this.prisma.tripLocationPoint.findMany({
      where: { tripId, ...(since ? { recordedAt: { gte: since } } : {}) },
      orderBy: { recordedAt: "asc" },
    });
    return points.map((p) => ({
      lat: Number(p.lat),
      lng: Number(p.lng),
      recordedAt: p.recordedAt.getTime(),
    }));
  }
}
