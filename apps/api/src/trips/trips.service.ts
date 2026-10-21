import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  PaymentMethod as DbPaymentMethod,
  Prisma,
  Trip,
  TripSource,
  TripStatus as DbTripStatus,
} from "@prisma/client";
import {
  ACTIVE_TRIP_STATUSES,
  Actor,
  CreateTripDto,
  DriverStatus,
  FareBreakdown,
  MIN_TRACE_POINTS,
  OfferAcceptResult,
  Role,
  TripSnapshot,
  TripReceipt,
  TripStatus,
  VehicleClass,
  canTransition,
  cancellationFee,
  estimateFare,
  finalFare,
  haversineM,
  traceDistanceM,
  withinArrivalGeofence,
} from "@rukwaride/shared";
import { appConfig } from "../config/app-config";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { rk } from "../redis/redis-keys";
import { SocketEmitter } from "../gateways/socket-emitter.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RoutingService } from "../routing/routing.service";
import { FaresService } from "../fares/fares.service";
import { LocationsService } from "../locations/locations.service";
import { DriversService } from "../drivers/drivers.service";
import { DispatchQueueService } from "../dispatch/dispatch-queue.service";
import { PaymentsService } from "../payments/payments.service";
import { LatraService } from "../latra/latra.service";
import { MetricsService } from "../metrics/metrics.service";

interface TransitionOptions {
  actorId?: string;
  meta?: Record<string, unknown>;
  /** Extra invariants checked inside the transaction, after the row lock. */
  check?: (trip: Trip) => void;
  /** Additional fields written together with the status change. */
  update?: Prisma.TripUncheckedUpdateInput;
}

export interface TransitionResult {
  trip: Trip;
  noop: boolean;
}

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly emitter: SocketEmitter,
    private readonly notifications: NotificationsService,
    private readonly routing: RoutingService,
    private readonly fares: FaresService,
    private readonly locations: LocationsService,
    private readonly drivers: DriversService,
    private readonly dispatchQueue: DispatchQueueService,
    private readonly payments: PaymentsService,
    private readonly latra: LatraService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * THE single write-path for Trip.status (spec §6): row lock, canTransition
   * check, status write + TripStatusEvent append, all in one Postgres
   * transaction. Repeating a transition to the current status is a no-op
   * success (idempotency rule).
   */
  async transition(
    tripId: string,
    to: TripStatus,
    actor: Actor,
    opts: TransitionOptions = {},
  ): Promise<TransitionResult> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Trip" WHERE id = ${tripId} FOR UPDATE
      `;
      if (locked.length === 0) throw new NotFoundException("Trip not found");
      const trip = (await tx.trip.findUnique({ where: { id: tripId } }))!;

      if (trip.status === (to as DbTripStatus)) {
        return { trip, noop: true };
      }
      if (!canTransition(trip.status as TripStatus, to, actor)) {
        throw new ConflictException(`Transition ${trip.status} → ${to} not allowed for ${actor}`);
      }
      opts.check?.(trip);

      const updated = await tx.trip.update({
        where: { id: tripId },
        data: { ...opts.update, status: to as DbTripStatus },
      });
      await tx.tripStatusEvent.create({
        data: {
          tripId,
          fromStatus: trip.status,
          toStatus: to as DbTripStatus,
          actorId: opts.actorId,
          meta: (opts.meta ?? {}) as Prisma.InputJsonValue,
        },
      });
      return { trip: updated, noop: false };
    });
  }

  // ---------- creation ----------

  async createTrip(userId: string, role: Role, dto: CreateTripDto) {
    const isDispatcher = role === Role.DISPATCHER || role === Role.ADMIN;
    if (role !== Role.PASSENGER && !isDispatcher) {
      throw new ForbiddenException("Only passengers or dispatchers create trips");
    }

    let passengerId: string | null = userId;
    if (isDispatcher) {
      passengerId = dto.contactPhone
        ? ((await this.prisma.user.findUnique({ where: { phone: dto.contactPhone } }))?.id ?? null)
        : null;
    }

    if (passengerId) {
      const active = await this.prisma.trip.count({
        where: { passengerId, status: { in: ACTIVE_TRIP_STATUSES as DbTripStatus[] } },
      });
      if (active > 0) throw new ConflictException("Passenger already has an active trip");
    }

    const route = await this.routing.route(dto.pickup, dto.drop);
    const config = await this.fares.activeConfig(dto.vehicleClass);
    const breakdown = estimateFare(config, route.distanceM, route.durationS);

    // Scheduled ride: a scheduledAt comfortably in the future parks the trip in
    // SCHEDULED until a timer promotes it; a past/near time is a normal book-now.
    const scheduleLeadMs = appConfig.dispatch.scheduleLeadS * 1000;
    const isScheduled =
      dto.scheduledAt !== undefined && dto.scheduledAt.getTime() > Date.now() + scheduleLeadMs;
    const initialStatus = isScheduled ? DbTripStatus.SCHEDULED : DbTripStatus.REQUESTED;

    const trip = await this.prisma.trip.create({
      data: {
        passengerId,
        createdById: userId,
        source: isDispatcher ? TripSource.DISPATCHER : TripSource.PASSENGER_APP,
        status: initialStatus,
        kind: dto.kind as never,
        vehicleClass: dto.vehicleClass,
        contactPhone: dto.contactPhone,
        contactName: dto.contactName,
        recipientName: dto.recipient?.name,
        recipientPhone: dto.recipient?.phone,
        packageNote: dto.packageNote,
        scheduledAt: isScheduled ? dto.scheduledAt : null,
        pickupLat: new Prisma.Decimal(dto.pickup.lat),
        pickupLng: new Prisma.Decimal(dto.pickup.lng),
        pickupLandmarkId: dto.pickup.landmarkId,
        pickupNote: dto.pickup.note,
        dropLat: new Prisma.Decimal(dto.drop.lat),
        dropLng: new Prisma.Decimal(dto.drop.lng),
        dropLandmarkId: dto.drop.landmarkId,
        estimatedDistanceM: route.distanceM,
        estimatedDurationS: route.durationS,
        estimatedFare: new Prisma.Decimal(breakdown.total),
        fareBreakdown: breakdown as unknown as Prisma.InputJsonValue,
        paymentMethod: dto.paymentMethod as DbPaymentMethod,
      },
    });
    await this.prisma.tripStatusEvent.create({
      data: { tripId: trip.id, toStatus: initialStatus, actorId: userId },
    });
    this.metrics.tripsCreated.inc();

    if (isScheduled) {
      // Promote a bit before the booked time so a driver is found by then.
      const delayMs = Math.max(0, dto.scheduledAt!.getTime() - Date.now() - scheduleLeadMs);
      await this.dispatchQueue.enqueueScheduledPromotion(trip.id, delayMs);
      return {
        id: trip.id,
        status: TripStatus.SCHEDULED,
        estimatedFare: breakdown.total,
        breakdown,
        scheduledAt: dto.scheduledAt!.toISOString(),
      };
    }

    await this.transition(trip.id, TripStatus.SEARCHING, Actor.SYSTEM, {
      update: { searchStartedAt: new Date() },
    });
    await this.dispatchQueue.enqueueSearch(trip.id);

    return { id: trip.id, status: TripStatus.SEARCHING, estimatedFare: breakdown.total, breakdown };
  }

  /**
   * Scheduled-ride promotion (called by the dispatch queue at the booked time):
   * a still-SCHEDULED trip enters normal dispatch. No-op if it was cancelled.
   */
  async promoteScheduledTrip(tripId: string): Promise<void> {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip || trip.status !== DbTripStatus.SCHEDULED) return;
    await this.transition(tripId, TripStatus.SEARCHING, Actor.SYSTEM, {
      update: { searchStartedAt: new Date() },
    });
    await this.dispatchQueue.enqueueSearch(tripId);
    this.logger.log(`Scheduled trip ${tripId} promoted to SEARCHING`);
  }

  // ---------- offer acceptance (race-safe, spec §7.5) ----------

  async acceptOffer(driverProfileId: string, tripId: string, offerSeq: number): Promise<OfferAcceptResult> {
    return this.acceptCore(driverProfileId, tripId, offerSeq, Actor.DRIVER);
  }

  /** Dispatcher FORCE-ACCEPT for drivers with standing consent (spec §7). */
  async forceAcceptOffer(
    dispatcherUserId: string,
    tripId: string,
    driverProfileId: string,
  ): Promise<OfferAcceptResult> {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) return { ok: false, reason: "NOT_FOUND" };
    return this.acceptCore(driverProfileId, tripId, trip.offerSeq, Actor.DISPATCHER, dispatcherUserId);
  }

  private async acceptCore(
    driverProfileId: string,
    tripId: string,
    offerSeq: number,
    actor: Actor,
    actorUserId?: string,
  ): Promise<OfferAcceptResult> {
    // Fast idempotency path: repeated accept of an already-won trip is success.
    const existing = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!existing) return { ok: false, reason: "NOT_FOUND" };
    if (existing.status === DbTripStatus.ACCEPTED && existing.driverId === driverProfileId) {
      return { ok: true, trip: await this.snapshot(tripId) };
    }

    // The Redis lock holder must be this trip (set when the offer went out).
    const lockHolder = await this.redis.client.get(rk.driverLock(driverProfileId));
    if (lockHolder !== tripId) return { ok: false, reason: "OFFER_EXPIRED" };

    const profile = await this.prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
    if (!profile?.currentVehicleId) return { ok: false, reason: "NO_VEHICLE" };

    try {
      await this.transition(tripId, TripStatus.ACCEPTED, actor, {
        actorId: actorUserId ?? profile.userId,
        check: (trip) => {
          if (trip.offeredDriverId !== driverProfileId || trip.offerSeq !== offerSeq) {
            throw new ConflictException("Offer is stale");
          }
        },
        update: {
          driverId: driverProfileId,
          vehicleId: profile.currentVehicleId,
          acceptedAt: new Date(),
          offeredDriverId: null,
        },
      });
    } catch (err) {
      if (err instanceof ConflictException) {
        const reason = existing.status === DbTripStatus.OFFERED ? "ALREADY_TAKEN" : "OFFER_EXPIRED";
        return { ok: false, reason };
      }
      throw err;
    }

    await this.drivers.applyRuntimeStatus(driverProfileId, DriverStatus.ON_TRIP, { tripId });
    await this.redis.client.del(rk.driverLock(driverProfileId));

    const snapshot = await this.snapshot(tripId);
    this.emitter.tripUpdateToPassenger(tripId, snapshot);
    this.emitter.tripUpdateToDriver(driverProfileId, snapshot);
    await this.notifyPassenger(
      tripId,
      "trip.driver_assigned",
      {
        name: snapshot.driver?.name ?? "",
        plate: snapshot.driver?.plateNumber ?? "",
        phone: snapshot.driver?.phone ?? "",
      },
      true, // LATRA: driver-assigned notification
    );
    this.logger.log(`Trip ${tripId} accepted by driver ${driverProfileId}`);
    return { ok: true, trip: snapshot };
  }

  // ---------- driver trip actions ----------

  async driverAction(
    driverProfileId: string,
    tripId: string,
    action: "ARRIVED" | "START" | "COMPLETE" | "CANCEL",
    pos?: { lat: number; lng: number },
    reason?: string,
  ) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException("Trip not found");
    if (trip.driverId !== driverProfileId) throw new ForbiddenException("Not your trip");

    switch (action) {
      case "ARRIVED": {
        const meta: Record<string, unknown> = {};
        if (pos) {
          const pickup = { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) };
          if (!withinArrivalGeofence(pos, pickup)) {
            meta.geofenceWarning = true; // warn-only (spec §6)
            meta.distanceToPickupM = Math.round(haversineM(pos, pickup));
          }
        }
        const { noop } = await this.transition(tripId, TripStatus.ARRIVED, Actor.DRIVER, {
          actorId: driverProfileId,
          meta,
          update: { arrivedAt: new Date() },
        });
        if (!noop) {
          this.emitter.tripUpdateToPassenger(tripId, { tripId, status: TripStatus.ARRIVED });
          // LATRA requires the arrival notification by SMS, always.
          await this.notifyPassenger(tripId, "trip.driver_arrived", {}, true);
        }
        return { status: TripStatus.ARRIVED };
      }
      case "START": {
        const { noop } = await this.transition(tripId, TripStatus.IN_PROGRESS, Actor.DRIVER, {
          actorId: driverProfileId,
          update: { startedAt: new Date() },
        });
        if (!noop) {
          this.emitter.tripUpdateToPassenger(tripId, { tripId, status: TripStatus.IN_PROGRESS });
          await this.notifyPassenger(tripId, "trip.started", {}, true);
        }
        return { status: TripStatus.IN_PROGRESS };
      }
      case "COMPLETE":
        return this.completeTrip(trip, driverProfileId);
      case "CANCEL":
        return this.driverCancel(trip, driverProfileId, reason);
    }
  }

  private async completeTrip(trip: Trip, driverProfileId: string) {
    // Final distance (spec §8): jump-filtered GPS trace; OSRM/estimate fallback
    // when the trace is too thin.
    await this.locations.flushTripPointsFor(trip.id);
    const startedAt = trip.startedAt ?? new Date();
    const trace = await this.locations.tripTrace(trip.id, startedAt);
    let finalDistanceM: number;
    if (trace.length >= MIN_TRACE_POINTS) {
      finalDistanceM = traceDistanceM(trace, trip.vehicleClass as VehicleClass);
    } else {
      const route = await this.routing.route(
        { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) },
        { lat: Number(trip.dropLat), lng: Number(trip.dropLng) },
      );
      finalDistanceM = route.distanceM;
    }
    const finalDurationS = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));
    const config = await this.fares.activeConfig(trip.vehicleClass as VehicleClass);
    const breakdown = finalFare(config, finalDistanceM, finalDurationS);

    const { noop } = await this.transition(trip.id, TripStatus.COMPLETED, Actor.DRIVER, {
      actorId: driverProfileId,
      update: {
        completedAt: new Date(),
        finalDistanceM,
        finalDurationS,
        finalFare: new Prisma.Decimal(breakdown.total),
        fareBreakdown: breakdown as unknown as Prisma.InputJsonValue,
      },
    });

    if (!noop) {
      if (trip.paymentMethod === DbPaymentMethod.CASH) {
        await this.payments.recordCashSettlement(trip.id, driverProfileId, breakdown);
      } else {
        // Mobile money: collection push + server-side conversion timer (§9).
        await this.payments.initiateTripCollection(trip.id, driverProfileId, breakdown);
      }
      await this.drivers.applyRuntimeStatus(driverProfileId, DriverStatus.AVAILABLE, { tripId: null });
      this.emitter.tripUpdateToPassenger(trip.id, {
        tripId: trip.id,
        status: TripStatus.COMPLETED,
        finalFare: breakdown.total,
      });
      this.emitter.tripUpdateToDriver(driverProfileId, {
        tripId: trip.id,
        status: TripStatus.COMPLETED,
        finalFare: breakdown.total,
      });
      // LATRA e-receipt (trip-end notification), SMS always. Stage-1 #10
      // requires the receipt to carry the starting point, ending point, fares
      // AND time — not just the fare, so all four go into the template.
      const full = await this.prisma.trip.findUnique({
        where: { id: trip.id },
        include: { pickupLandmark: true, dropLandmark: true },
      });
      const label = (name: string | undefined, lat: unknown, lng: unknown) =>
        name ?? `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
      const hhmm = (d: Date | null) =>
        d
          ? new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(11, 16) // EAT
          : "-";
      await this.notifyPassenger(
        trip.id,
        "trip.receipt",
        {
          total: breakdown.total,
          km: (finalDistanceM / 1000).toFixed(1),
          from: label(full?.pickupLandmark?.name, full?.pickupLat, full?.pickupLng),
          to: label(full?.dropLandmark?.name, full?.dropLat, full?.dropLng),
          start: hhmm(full?.startedAt ?? null),
          end: hhmm(full?.completedAt ?? null),
        },
        true,
      );
      // LATRA trip-reporting outbox (spec §12.3).
      await this.latra.enqueueTripReport(trip.id);
      this.metrics.tripsCompleted.inc();
    }
    return { status: TripStatus.COMPLETED, finalFare: breakdown.total, finalDistanceM, finalDurationS };
  }

  private async driverCancel(trip: Trip, driverProfileId: string, reason?: string) {
    const { noop } = await this.transition(trip.id, TripStatus.CANCELLED_BY_DRIVER, Actor.DRIVER, {
      actorId: driverProfileId,
      meta: { reason },
      update: { cancelledAt: new Date(), cancellationReason: reason },
    });
    if (noop) return { status: TripStatus.CANCELLED_BY_DRIVER };

    // Strike counter + free the driver (spec §6).
    await this.prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: { strikeCount: { increment: 1 } },
    });
    await this.latra.enqueueTripReport(trip.id); // CANCELLED report (spec §12.3)
    await this.drivers.applyRuntimeStatus(driverProfileId, DriverStatus.AVAILABLE, { tripId: null });

    // Re-dispatch the SAME trip: back to SEARCHING with assignment cleared.
    // The cancelling driver stays in offeredDriverIds so he is not re-offered.
    await this.transition(trip.id, TripStatus.SEARCHING, Actor.SYSTEM, {
      meta: { reDispatchAfterDriverCancel: true },
      update: {
        driverId: null,
        vehicleId: null,
        acceptedAt: null,
        arrivedAt: null,
        searchStartedAt: new Date(),
        offeredDriverIds: { push: driverProfileId },
      },
    });
    await this.dispatchQueue.enqueueSearch(trip.id);
    this.emitter.tripUpdateToPassenger(trip.id, { tripId: trip.id, status: TripStatus.SEARCHING });
    await this.notifyPassenger(trip.id, "trip.redispatch", {}, false);
    return { status: TripStatus.SEARCHING };
  }

  // ---------- passenger cancel ----------

  async passengerCancel(userId: string, role: Role, tripId: string, reason?: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException("Trip not found");
    const isStaff = role === Role.DISPATCHER || role === Role.ADMIN;
    if (!isStaff && trip.passengerId !== userId && trip.createdById !== userId) {
      throw new ForbiddenException("Not your trip");
    }
    const actor = isStaff ? (role === Role.ADMIN ? Actor.ADMIN : Actor.DISPATCHER) : Actor.PASSENGER;

    // A driver is already assigned (vs. merely offered) — they must be freed.
    const hadAssignedDriver =
      trip.status === DbTripStatus.ACCEPTED || trip.status === DbTripStatus.ARRIVED;

    // LATRA: no charge unless the driver has ARRIVED at pick-up (or the trip
    // already started). Distance driven toward pickup is not a chargeable event.
    let fee = 0;
    if (trip.driverId) {
      fee = cancellationFee({
        driverArrived: trip.status === DbTripStatus.ARRIVED,
        tripStarted: trip.status === DbTripStatus.IN_PROGRESS,
        flatFee: appConfig.cancellationFeeFlat,
      });
    }

    const offeredDriverId = trip.offeredDriverId;
    const { noop } = await this.transition(tripId, TripStatus.CANCELLED_BY_PASSENGER, actor, {
      actorId: userId,
      meta: { reason, fee },
      update: {
        cancelledAt: new Date(),
        cancellationReason: reason,
        cancellationFee: new Prisma.Decimal(fee),
        offeredDriverId: null,
      },
    });
    if (noop) return { status: TripStatus.CANCELLED_BY_PASSENGER, fee };

    // Withdraw an outstanding offer, or free the assigned driver.
    if (trip.status === DbTripStatus.OFFERED && offeredDriverId) {
      await this.redis.client.del(rk.driverLock(offeredDriverId));
      await this.drivers.applyRuntimeStatus(offeredDriverId, DriverStatus.AVAILABLE, { tripId: null });
      this.emitter.offerWithdrawn(offeredDriverId, {
        tripId,
        offerSeq: trip.offerSeq,
        reason: "CANCELLED",
      });
    }
    if (hadAssignedDriver && trip.driverId) {
      await this.drivers.applyRuntimeStatus(trip.driverId, DriverStatus.AVAILABLE, { tripId: null });
      this.emitter.tripUpdateToDriver(trip.driverId, {
        tripId,
        status: TripStatus.CANCELLED_BY_PASSENGER,
      });
    }
    this.emitter.tripUpdateToPassenger(tripId, { tripId, status: TripStatus.CANCELLED_BY_PASSENGER });
    await this.latra.enqueueTripReport(tripId); // CANCELLED report (spec §12.3)
    return { status: TripStatus.CANCELLED_BY_PASSENGER, fee };
  }

  // ---------- estimates, history, ratings ----------

  /** Fare estimate for every vehicle class (class-picker screen, spec §13). */
  async estimateAllClasses(pickup: { lat: number; lng: number }, drop: { lat: number; lng: number }) {
    const route = await this.routing.route(pickup, drop);
    const classes = Object.values(VehicleClass);
    const estimates = await Promise.all(
      classes.map(async (vehicleClass) => {
        try {
          const config = await this.fares.activeConfig(vehicleClass);
          const breakdown = estimateFare(config, route.distanceM, route.durationS);
          return { vehicleClass, fare: breakdown.total, currency: "TZS" };
        } catch {
          return null; // class without an active fare config is not offered
        }
      }),
    );
    return {
      distanceM: route.distanceM,
      durationS: route.durationS,
      geometry: route.geometry ?? null, // road polyline for the map ([lng,lat][])
      estimates: estimates.filter((e) => e !== null),
    };
  }

  /** Own trip history: passenger sees booked trips, driver sees driven ones. */
  async history(userId: string, driverProfileId: string | undefined) {
    const trips = await this.prisma.trip.findMany({
      where: driverProfileId
        ? { driverId: driverProfileId }
        : { OR: [{ passengerId: userId }, { createdById: userId }] },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { pickupLandmark: true, dropLandmark: true },
    });
    return trips.map((t) => ({
      id: t.id,
      status: t.status,
      vehicleClass: t.vehicleClass,
      createdAt: t.createdAt,
      // LATRA Stage-1 #10: the receipt must show starting point, ending point,
      // fares AND time — so the trip's own start/end (not just when it was
      // booked) and the distance travelled go out with it.
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      finalDistanceM: t.finalDistanceM,
      finalDurationS: t.finalDurationS,
      pickupLabel: t.pickupLandmark?.name ?? `${Number(t.pickupLat).toFixed(4)}, ${Number(t.pickupLng).toFixed(4)}`,
      dropLabel: t.dropLandmark?.name ?? `${Number(t.dropLat).toFixed(4)}, ${Number(t.dropLng).toFixed(4)}`,
      estimatedFare: Number(t.estimatedFare),
      finalFare: t.finalFare === null ? null : Number(t.finalFare),
      fareBreakdown: t.fareBreakdown,
      paymentMethod: t.paymentMethod,
    }));
  }

  /** Both-direction ratings (spec §2); driver aggregates update incrementally. */
  async rate(raterUserId: string, tripId: string, score: number, comment?: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: { driver: true },
    });
    if (!trip) throw new NotFoundException("Trip not found");
    if (trip.status !== DbTripStatus.COMPLETED) throw new BadRequestException("Trip is not completed");
    if (!trip.driver) throw new BadRequestException("Trip has no driver");

    const isPassenger = trip.passengerId === raterUserId || trip.createdById === raterUserId;
    const isDriver = trip.driver.userId === raterUserId;
    if (!isPassenger && !isDriver) throw new ForbiddenException("Not your trip");
    const rateeId = isPassenger ? trip.driver.userId : (trip.passengerId ?? trip.createdById);

    const existing = await this.prisma.rating.findUnique({
      where: { tripId_raterId: { tripId, raterId: raterUserId } },
    });
    if (existing) return { ok: true, alreadyRated: true };

    await this.prisma.$transaction(async (tx) => {
      await tx.rating.create({
        data: { tripId, raterId: raterUserId, rateeId, score, comment },
      });
      if (isPassenger) {
        const d = trip.driver!;
        const newCount = d.ratingCount + 1;
        const newAvg = (Number(d.ratingAvg) * d.ratingCount + score) / newCount;
        await tx.driverProfile.update({
          where: { id: d.id },
          data: { ratingAvg: new Prisma.Decimal(newAvg.toFixed(2)), ratingCount: newCount },
        });
      }
    });
    return { ok: true };
  }

  // ---------- reads ----------

  async getTrip(userId: string, role: Role, driverProfileId: string | undefined, tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException("Trip not found");
    const isStaff = role === Role.DISPATCHER || role === Role.ADMIN;
    const isOwner = trip.passengerId === userId || trip.createdById === userId;
    const isAssignedDriver = driverProfileId !== undefined && trip.driverId === driverProfileId;
    if (!isStaff && !isOwner && !isAssignedDriver) throw new ForbiddenException("Not your trip");
    return {
      id: trip.id,
      status: trip.status,
      kind: trip.kind,
      vehicleClass: trip.vehicleClass,
      driverId: trip.driverId,
      offeredDriverIds: trip.offeredDriverIds,
      offerSeq: trip.offerSeq,
      estimatedFare: Number(trip.estimatedFare),
      finalFare: trip.finalFare === null ? null : Number(trip.finalFare),
      finalDistanceM: trip.finalDistanceM,
      finalDurationS: trip.finalDurationS,
      fareBreakdown: trip.fareBreakdown,
      cancellationFee: trip.cancellationFee === null ? null : Number(trip.cancellationFee),
      paymentMethod: trip.paymentMethod,
      scheduledAt: trip.scheduledAt?.toISOString() ?? null,
      recipient:
        trip.recipientName && trip.recipientPhone
          ? { name: trip.recipientName, phone: trip.recipientPhone }
          : null,
      packageNote: trip.packageNote,
    };
  }

  async snapshot(tripId: string): Promise<TripSnapshot> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        driver: { include: { user: true } },
        vehicle: true,
        pickupLandmark: true,
        dropLandmark: true,
      },
    });
    if (!trip) throw new NotFoundException("Trip not found");
    return {
      tripId: trip.id,
      status: trip.status as TripStatus,
      kind: trip.kind as never,
      vehicleClass: trip.vehicleClass as VehicleClass,
      pickup: { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) },
      drop: { lat: Number(trip.dropLat), lng: Number(trip.dropLng) },
      estimatedFare: Number(trip.estimatedFare),
      finalFare: trip.finalFare === null ? undefined : Number(trip.finalFare),
      paymentMethod: trip.paymentMethod as never,
      recipient:
        trip.recipientName && trip.recipientPhone
          ? { name: trip.recipientName, phone: trip.recipientPhone }
          : undefined,
      packageNote: trip.packageNote ?? undefined,
      scheduledAt: trip.scheduledAt?.toISOString(),
      driver:
        trip.driver && trip.vehicle
          ? {
              id: trip.driver.id,
              name: trip.driver.user.name,
              phone: trip.driver.user.phone,
              plateNumber: trip.vehicle.plateNumber,
              vehicleClass: trip.vehicle.class as VehicleClass,
              ratingAvg: Number(trip.driver.ratingAvg),
              photoUrl: trip.driver.photoKey ? `/drivers/${trip.driver.id}/photo` : undefined,
            }
          : undefined,
      // LATRA Stage-1 #10: the full itemised receipt travels with a completed
      // trip so the passenger sees it on the completion screen, not only in
      // history. Same from/to labelling as the history list.
      receipt:
        trip.status === DbTripStatus.COMPLETED
          ? {
              from:
                trip.pickupLandmark?.name ??
                `${Number(trip.pickupLat).toFixed(4)}, ${Number(trip.pickupLng).toFixed(4)}`,
              to:
                trip.dropLandmark?.name ??
                `${Number(trip.dropLat).toFixed(4)}, ${Number(trip.dropLng).toFixed(4)}`,
              startedAt: trip.startedAt?.toISOString() ?? null,
              completedAt: trip.completedAt?.toISOString() ?? null,
              durationS: trip.finalDurationS,
              distanceM: trip.finalDistanceM,
              fareBreakdown: trip.fareBreakdown as TripReceipt["fareBreakdown"],
              total: trip.finalFare === null ? Number(trip.estimatedFare) : Number(trip.finalFare),
            }
          : undefined,
    };
  }

  /**
   * Notify the trip's passenger through the fallback chain (account phone or
   * dispatcher-entered contact). `critical` = LATRA-required → SMS always.
   */
  private async notifyPassenger(
    tripId: string,
    templateKey: string,
    vars: Record<string, string | number>,
    critical: boolean,
  ) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: { passenger: true },
    });
    if (!trip) return;
    this.notifications.notify({
      userId: trip.passengerId,
      phone: trip.passenger?.phone ?? trip.contactPhone,
      templateKey,
      vars,
      critical,
    });
  }
}
