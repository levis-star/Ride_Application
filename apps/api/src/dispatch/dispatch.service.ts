import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { TripStatus as DbTripStatus, Trip } from "@prisma/client";
import {
  Actor,
  DriverStatus,
  FareBreakdown,
  LatLng,
  OfferNewDto,
  PaymentMethod,
  TripBoardItemDto,
  TripStatus,
  VehicleClass,
  haversineM,
} from "@rukwaride/shared";
import { appConfig } from "../config/app-config";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { rk } from "../redis/redis-keys";
import { SocketEmitter } from "../gateways/socket-emitter.service";
import { RoutingService } from "../routing/routing.service";
import { TripsService } from "../trips/trips.service";
import { DriversService } from "../drivers/drivers.service";
import { DispatchQueueService } from "./dispatch-queue.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MetricsService } from "../metrics/metrics.service";

interface Candidate {
  driverProfileId: string;
  pos: LatLng;
  etaS: number;
}

/**
 * The dispatch engine (spec §7): expanding-radius GEO search, ETA ranking,
 * offer cascade with Redis locks and server-side BullMQ timeouts.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly emitter: SocketEmitter,
    private readonly routing: RoutingService,
    private readonly trips: TripsService,
    private readonly drivers: DriversService,
    private readonly queue: DispatchQueueService,
    private readonly notifications: NotificationsService,
    private readonly metrics: MetricsService,
  ) {}

  /** One matching pass for a SEARCHING trip. Re-enqueues itself while budget remains. */
  async runSearch(tripId: string): Promise<void> {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip || trip.status !== DbTripStatus.SEARCHING) return;

    const cfg = appConfig.dispatch;
    const elapsedMs = Date.now() - (trip.searchStartedAt ?? trip.createdAt).getTime();
    if (elapsedMs > cfg.maxSearchS * 1000 || trip.offeredDriverIds.length >= cfg.maxCandidates) {
      await this.expireTrip(trip);
      return;
    }

    const pickup = { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) };
    const candidates = await this.findCandidates(trip, pickup);

    // Trip board (spec-plus, Uber "Trip Radar"-style): on the FIRST pass, tell
    // the runner-up candidates a passenger nearby is searching. They may claim
    // the trip whenever the cascade leaves it in SEARCHING.
    if (trip.offeredDriverIds.length === 0 && candidates.length > 1) {
      const item = this.boardItem(trip);
      for (const other of candidates.slice(1, 6)) {
        this.emitter.tripBoardNew(other.driverProfileId, {
          ...item,
          distanceToPickupM: Math.round(haversineM(other.pos, pickup)),
        });
      }
    }

    for (const candidate of candidates) {
      // Redis dispatch lock: one outstanding offer per driver, platform-wide.
      const locked = await this.redis.client.set(
        rk.driverLock(candidate.driverProfileId),
        tripId,
        "EX",
        cfg.lockTtlS,
        "NX",
      );
      if (locked !== "OK") continue;
      try {
        await this.sendOffer(trip, candidate, pickup);
        return;
      } catch (err) {
        // Offer failed (e.g. trip got cancelled between passes) — release and stop.
        await this.redis.client.del(rk.driverLock(candidate.driverProfileId));
        this.logger.warn(`Offer to ${candidate.driverProfileId} for ${tripId} failed: ${String(err)}`);
        return;
      }
    }

    // No offerable candidate this pass — poll again while the budget lasts.
    await this.queue.enqueueSearch(tripId, cfg.searchRetryMs);
  }

  /** Expanding-radius GEO search + freshness/status/wallet filters + ETA ranking. */
  private async findCandidates(trip: Trip, pickup: LatLng): Promise<Candidate[]> {
    const cfg = appConfig.dispatch;
    const geoKey = rk.geoDrivers(trip.vehicleClass);
    const excluded = new Set(trip.offeredDriverIds);
    const staleCutoff = Date.now() - appConfig.location.staleExcludeS * 1000;

    for (const radiusKm of cfg.radiiKm) {
      const found = (await this.redis.client.geosearch(
        geoKey,
        "FROMLONLAT",
        pickup.lng,
        pickup.lat,
        "BYRADIUS",
        radiusKm,
        "km",
        "ASC",
        "COUNT",
        30,
        "WITHCOORD",
      )) as Array<[string, [string, string]]>;

      const inRadius = found
        .map(([id, [lng, lat]]) => ({ driverProfileId: id, pos: { lat: Number(lat), lng: Number(lng) } }))
        .filter((c) => !excluded.has(c.driverProfileId));
      if (inRadius.length === 0) continue;

      // Runtime filter: AVAILABLE + fresh ping (spec: no ping 30 s → excluded).
      const pipeline = this.redis.client.pipeline();
      for (const c of inRadius) pipeline.hmget(rk.driver(c.driverProfileId), "status", "updatedAt");
      const states = (await pipeline.exec()) ?? [];
      const live = inRadius.filter((_, i) => {
        const [err, vals] = states[i] ?? [null, null];
        if (err || !vals) return false;
        const [status, updatedAt] = vals as [string | null, string | null];
        return status === DriverStatus.AVAILABLE && Number(updatedAt ?? 0) >= staleCutoff;
      });
      if (live.length === 0) continue;

      // Durable filter: approved + wallet above the block threshold (spec §7.1).
      const eligibleRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "DriverProfile"
        WHERE id = ANY(${live.map((c) => c.driverProfileId)})
          AND "approvedAt" IS NOT NULL
          AND "walletBalance" >= "negativeBalanceLimit"
      `;
      const eligibleIds = new Set(eligibleRows.map((r) => r.id));
      const eligible = live.filter((c) => eligibleIds.has(c.driverProfileId));
      if (eligible.length === 0) continue;

      const etas = await this.routing.etaToPickupS(
        eligible.map((c) => ({ id: c.driverProfileId, pos: c.pos })),
        pickup,
      );
      return eligible
        .map((c) => ({ ...c, etaS: etas.get(c.driverProfileId) ?? Number.MAX_SAFE_INTEGER }))
        .sort((a, b) => a.etaS - b.etaS);
    }
    return [];
  }

  private async sendOffer(
    trip: Trip,
    candidate: Candidate,
    pickup: LatLng,
    opts: { actor?: Actor; actorId?: string; ttlS?: number } = {},
  ): Promise<void> {
    const actor = opts.actor ?? Actor.SYSTEM;
    const ttlS = opts.ttlS ?? appConfig.dispatch.offerTtlS;
    const offerSeq = trip.offerSeq + 1;
    await this.trips.transition(trip.id, TripStatus.OFFERED, actor, {
      actorId: opts.actorId,
      meta: { driverProfileId: candidate.driverProfileId, etaS: candidate.etaS, manual: actor !== Actor.SYSTEM },
      update: {
        offerSeq,
        offeredDriverId: candidate.driverProfileId,
        offeredDriverIds: { push: candidate.driverProfileId },
      },
    });
    await this.drivers.applyRuntimeStatus(candidate.driverProfileId, DriverStatus.ON_OFFER, {});

    const breakdown = trip.fareBreakdown as unknown as FareBreakdown | null;
    const offer: OfferNewDto = {
      tripId: trip.id,
      offerSeq,
      vehicleClass: trip.vehicleClass as VehicleClass,
      pickup,
      drop: { lat: Number(trip.dropLat), lng: Number(trip.dropLng) },
      pickupNote: trip.pickupNote ?? undefined,
      estimatedFare: Number(trip.estimatedFare),
      driverEarningsEstimate: breakdown?.driverEarnings ?? Number(trip.estimatedFare),
      distanceToPickupM: Math.round(haversineM(candidate.pos, pickup)),
      etaToPickupS: candidate.etaS,
      paymentMethod: trip.paymentMethod as PaymentMethod,
      expiresAt: new Date(Date.now() + ttlS * 1000).toISOString(),
    };
    // Socket first; FCM data push wakes a backgrounded/disconnected app.
    this.emitter.offerNew(candidate.driverProfileId, offer);
    this.notifications.pushOfferToDriver(candidate.driverProfileId, JSON.stringify(offer));
    await this.queue.enqueueOfferTimeout(trip.id, candidate.driverProfileId, offerSeq, ttlS);
    this.metrics.offersSent.inc();
    if (offerSeq === 1 && trip.searchStartedAt) {
      // Dispatch decision NFR (spec §15): SEARCHING → first OFFERED.
      this.metrics.dispatchDecision.observe((Date.now() - trip.searchStartedAt.getTime()) / 1000);
    }
    this.logger.log(
      `Trip ${trip.id}: offer #${offerSeq} → driver ${candidate.driverProfileId} (eta ${candidate.etaS}s)`,
    );
  }

  /** Scheduled-ride promotion job → TripsService (kept here to avoid a cycle). */
  async promoteScheduled(tripId: string): Promise<void> {
    await this.trips.promoteScheduledTrip(tripId);
  }

  /**
   * Manual dispatch (spec §7): dispatcher assigns a specific driver — a 60 s
   * offer, or FORCE-ACCEPT when the driver holds a standing consent flag.
   */
  async manualAssign(
    actor: { userId: string; role: "DISPATCHER" | "ADMIN" },
    tripId: string,
    driverProfileId: string,
    force: boolean,
  ) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException("Trip not found");
    if (trip.status !== DbTripStatus.SEARCHING) {
      throw new ConflictException(`Trip is ${trip.status}, not SEARCHING`);
    }
    const driver = await this.prisma.driverProfile.findUnique({
      where: { id: driverProfileId },
      include: { currentVehicle: true, user: true },
    });
    if (!driver?.approvedAt || !driver.currentVehicle) throw new BadRequestException("Driver not eligible");
    if (driver.currentVehicle.class !== trip.vehicleClass) {
      throw new BadRequestException(
        `Driver rides ${driver.currentVehicle.class}, trip needs ${trip.vehicleClass}`,
      );
    }
    const state = await this.redis.client.hgetall(rk.driver(driverProfileId));
    if (state.status !== DriverStatus.AVAILABLE) {
      throw new ConflictException(`Driver is ${state.status || "offline"}, not AVAILABLE`);
    }

    const ttlS = 60; // dispatcher offers run longer (spec §7)
    const locked = await this.redis.client.set(rk.driverLock(driverProfileId), tripId, "EX", ttlS + 10, "NX");
    if (locked !== "OK") throw new ConflictException("Driver already holds an offer");

    const pickup = { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) };
    const pos =
      state.lat && state.lng ? { lat: Number(state.lat), lng: Number(state.lng) } : pickup;
    const etas = await this.routing.etaToPickupS([{ id: driverProfileId, pos }], pickup);
    const candidate: Candidate = {
      driverProfileId,
      pos,
      etaS: etas.get(driverProfileId) ?? 0,
    };
    try {
      if (force && driver.manualAssignConsent) {
        // FORCE-ACCEPT: offer + immediate acceptance on the driver's behalf.
        await this.sendOffer(trip, candidate, pickup, { actor: Actor.DISPATCHER, actorId: actor.userId, ttlS });
        const result = await this.trips.forceAcceptOffer(actor.userId, tripId, driverProfileId);
        await this.audit(actor.userId, "TRIP_FORCE_ASSIGNED", tripId, { driverProfileId });
        return result;
      }
      await this.sendOffer(trip, candidate, pickup, { actor: Actor.DISPATCHER, actorId: actor.userId, ttlS });
      await this.audit(actor.userId, "TRIP_MANUALLY_OFFERED", tripId, { driverProfileId, ttlS });
      return { status: "OFFERED", driverProfileId, ttlS };
    } catch (err) {
      await this.redis.client.del(rk.driverLock(driverProfileId));
      throw err;
    }
  }

  private boardItem(trip: Trip): TripBoardItemDto {
    const breakdown = trip.fareBreakdown as unknown as FareBreakdown | null;
    return {
      tripId: trip.id,
      vehicleClass: trip.vehicleClass as VehicleClass,
      pickup: { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) },
      drop: { lat: Number(trip.dropLat), lng: Number(trip.dropLng) },
      estimatedFare: Number(trip.estimatedFare),
      driverEarningsEstimate: breakdown?.driverEarnings ?? Number(trip.estimatedFare),
      distanceToPickupM: 0, // per-driver, filled by the caller
      searchingForS: Math.max(
        0,
        Math.round((Date.now() - (trip.searchStartedAt ?? trip.createdAt).getTime()) / 1000),
      ),
    };
  }

  /**
   * Claimable searching trips near this driver (their vehicle class, within
   * the widest dispatch radius), sorted nearest-first. Empty unless the
   * driver is AVAILABLE — busy/offline drivers have nothing to claim.
   */
  async tripBoard(driverProfileId: string): Promise<TripBoardItemDto[]> {
    const state = await this.redis.client.hgetall(rk.driver(driverProfileId));
    if (state.status !== DriverStatus.AVAILABLE || !state.lat || !state.lng) return [];
    const pos = { lat: Number(state.lat), lng: Number(state.lng) };
    const maxM = Math.max(...appConfig.dispatch.radiiKm) * 1000;

    const trips = await this.prisma.trip.findMany({
      where: { status: DbTripStatus.SEARCHING, vehicleClass: state.vehicleClass as VehicleClass },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    return trips
      .map((t) => ({
        ...this.boardItem(t),
        distanceToPickupM: Math.round(
          haversineM(pos, { lat: Number(t.pickupLat), lng: Number(t.pickupLng) }),
        ),
      }))
      .filter((i) => i.distanceToPickupM <= maxM)
      .sort((a, b) => a.distanceToPickupM - b.distanceToPickupM);
  }

  /**
   * Driver claims a SEARCHING trip off the board: same eligibility rules as
   * the cascade, same one-offer-per-driver lock, then offer + self-accept in
   * one step. Any race (cascade offered it, another claim won, passenger
   * cancelled) surfaces as 409 — the server is the only arbiter.
   */
  async claimTrip(driverProfileId: string, tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException("Trip not found");
    if (trip.status !== DbTripStatus.SEARCHING) {
      throw new ConflictException(`Trip is ${trip.status}, not claimable`);
    }
    const driver = await this.prisma.driverProfile.findUnique({
      where: { id: driverProfileId },
      include: { currentVehicle: true },
    });
    if (!driver?.approvedAt || !driver.currentVehicle) throw new BadRequestException("Driver not eligible");
    if (driver.currentVehicle.class !== trip.vehicleClass) {
      throw new BadRequestException(
        `Driver rides ${driver.currentVehicle.class}, trip needs ${trip.vehicleClass}`,
      );
    }
    if (Number(driver.walletBalance) < Number(driver.negativeBalanceLimit)) {
      throw new BadRequestException("Wallet below limit");
    }
    const state = await this.redis.client.hgetall(rk.driver(driverProfileId));
    if (state.status !== DriverStatus.AVAILABLE) {
      throw new ConflictException(`Driver is ${state.status || "offline"}, not AVAILABLE`);
    }

    const cfg = appConfig.dispatch;
    const locked = await this.redis.client.set(rk.driverLock(driverProfileId), tripId, "EX", cfg.lockTtlS, "NX");
    if (locked !== "OK") throw new ConflictException("Driver already holds an offer");

    const pickup = { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) };
    const pos = state.lat && state.lng ? { lat: Number(state.lat), lng: Number(state.lng) } : pickup;
    const etas = await this.routing.etaToPickupS([{ id: driverProfileId, pos }], pickup);
    const claimSeq = trip.offerSeq + 1;
    try {
      await this.sendOffer(trip, { driverProfileId, pos, etaS: etas.get(driverProfileId) ?? 0 }, pickup);
    } catch (err) {
      // No offer went out (e.g. cascade offered it first) — free the driver.
      await this.redis.client.del(rk.driverLock(driverProfileId));
      throw err instanceof ConflictException ? err : new ConflictException("Trip was taken by the cascade");
    }
    const result = await this.trips.acceptOffer(driverProfileId, tripId, claimSeq);
    if (!result.ok) {
      // Lost a race inside the accept — the pending offer-timeout job cleans
      // up the outstanding offer; report the loss to the claimer.
      throw new ConflictException(result.reason ?? "CLAIM_LOST");
    }
    this.logger.log(`Trip ${tripId}: claimed from the board by driver ${driverProfileId}`);
    return result;
  }

  /** Dispatcher pulls the trip back from its current driver and re-searches. */
  async reassign(actorUserId: string, tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException("Trip not found");

    if (trip.status === DbTripStatus.OFFERED && trip.offeredDriverId) {
      const offeredDriverId = trip.offeredDriverId;
      await this.trips.transition(tripId, TripStatus.SEARCHING, Actor.DISPATCHER, {
        actorId: actorUserId,
        meta: { reassign: true },
        update: { offeredDriverId: null },
      });
      this.emitter.offerWithdrawn(offeredDriverId, { tripId, offerSeq: trip.offerSeq, reason: "REASSIGNED" });
      await this.releaseDriverAfterOffer(offeredDriverId, tripId);
    } else if (
      (trip.status === DbTripStatus.ACCEPTED || trip.status === DbTripStatus.ARRIVED) &&
      trip.driverId
    ) {
      const driverId = trip.driverId;
      // Record the pull-back as a driver-side cancellation without a strike,
      // then return the SAME trip to SEARCHING (spec §6 re-dispatch path).
      await this.trips.transition(tripId, TripStatus.CANCELLED_BY_DRIVER, Actor.ADMIN, {
        actorId: actorUserId,
        meta: { reassignedByDispatcher: true },
        update: { cancelledAt: new Date(), cancellationReason: "Reassigned by dispatcher" },
      });
      await this.drivers.applyRuntimeStatus(driverId, DriverStatus.AVAILABLE, { tripId: null });
      this.emitter.tripUpdateToDriver(driverId, { tripId, status: TripStatus.CANCELLED_BY_DRIVER });
      await this.trips.transition(tripId, TripStatus.SEARCHING, Actor.DISPATCHER, {
        actorId: actorUserId,
        meta: { reassign: true },
        update: {
          driverId: null,
          vehicleId: null,
          acceptedAt: null,
          arrivedAt: null,
          searchStartedAt: new Date(),
          offeredDriverIds: { push: driverId },
        },
      });
    } else if (trip.status !== DbTripStatus.SEARCHING) {
      throw new ConflictException(`Cannot reassign a ${trip.status} trip`);
    }

    await this.queue.enqueueSearch(tripId);
    await this.audit(actorUserId, "TRIP_REASSIGNED", tripId, {});
    return { status: "SEARCHING" };
  }

  private audit(actorId: string, action: string, tripId: string, detail: Record<string, unknown>) {
    return this.prisma.auditLog.create({
      data: { actorId, action, entity: "Trip", entityId: tripId, after: detail as never },
    });
  }

  /** Driver explicitly declines an outstanding offer. */
  async declineOffer(driverProfileId: string, tripId: string, offerSeq: number): Promise<{ ok: boolean }> {
    try {
      await this.trips.transition(tripId, TripStatus.SEARCHING, Actor.DRIVER, {
        actorId: driverProfileId,
        meta: { declinedBy: driverProfileId, offerSeq },
        check: (trip) => {
          if (trip.offeredDriverId !== driverProfileId || trip.offerSeq !== offerSeq) {
            throw new Error("stale offer");
          }
        },
        update: { offeredDriverId: null },
      });
    } catch {
      return { ok: false };
    }
    await this.releaseDriverAfterOffer(driverProfileId, tripId);
    await this.queue.enqueueSearch(tripId); // next candidate immediately
    return { ok: true };
  }

  /** BullMQ offer-timeout job: the 25 s TTL elapsed with no driver response. */
  async onOfferTimeout(tripId: string, driverProfileId: string, offerSeq: number): Promise<void> {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (
      !trip ||
      trip.status !== DbTripStatus.OFFERED ||
      trip.offeredDriverId !== driverProfileId ||
      trip.offerSeq !== offerSeq
    ) {
      return; // answered or superseded — timeout is void
    }
    await this.trips.transition(tripId, TripStatus.SEARCHING, Actor.SYSTEM, {
      meta: { offerTimeout: true, driverProfileId, offerSeq },
      update: { offeredDriverId: null },
    });
    this.emitter.offerWithdrawn(driverProfileId, { tripId, offerSeq, reason: "TIMEOUT" });
    await this.releaseDriverAfterOffer(driverProfileId, tripId);
    await this.queue.enqueueSearch(tripId);
    this.logger.log(`Trip ${tripId}: offer #${offerSeq} to ${driverProfileId} timed out`);
  }

  private async releaseDriverAfterOffer(driverProfileId: string, tripId: string): Promise<void> {
    // Only delete the lock if this trip still holds it.
    const holder = await this.redis.client.get(rk.driverLock(driverProfileId));
    if (holder === tripId) await this.redis.client.del(rk.driverLock(driverProfileId));
    const status = await this.redis.client.hget(rk.driver(driverProfileId), "status");
    if (status === DriverStatus.ON_OFFER) {
      await this.drivers.applyRuntimeStatus(driverProfileId, DriverStatus.AVAILABLE, {});
    }
  }

  private async expireTrip(trip: Trip): Promise<void> {
    await this.trips.transition(trip.id, TripStatus.EXPIRED, Actor.SYSTEM, {
      meta: { offeredCount: trip.offeredDriverIds.length },
    });
    this.emitter.tripUpdateToPassenger(trip.id, { tripId: trip.id, status: TripStatus.EXPIRED });
    this.notifications.notify({
      userId: trip.passengerId,
      phone: trip.contactPhone,
      templateKey: "trip.expired",
      critical: false,
    });
    this.logger.warn(`Trip ${trip.id} EXPIRED after ${trip.offeredDriverIds.length} offers`);
  }
}
