import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { LatraReportStatus, Prisma, TripStatus as DbTripStatus } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import { createHash } from "node:crypto";
import Redis from "ioredis";
import { appConfig } from "../config/app-config";
import { PrismaService } from "../prisma/prisma.service";
import {
  CETS_VEHICLE_TYPE,
  applyLatraFieldMap,
  cetsCoordinates,
  cetsLicence,
  cetsPlate,
  cetsRating,
} from "@rukwaride/shared";
import { LATRA_CLIENT, LatraClient } from "./latra.client";

type LatraJob = { kind: "submit-report"; reportId: string } | { kind: "daily-report" };

/**
 * A landmark within this many metres of a pickup/drop counts as its "area" for
 * CeTS. ~600 m suits a small town (Sumbawanga): close enough to be the same
 * neighbourhood, far enough to still find a name for most bookings.
 */
const AREA_NAME_RADIUS_M = 600;

/**
 * LATRA trip-reporting outbox (spec §12.3): COMPLETED/CANCELLED trips create
 * a LatraReport row and a queued submission with retry/backoff. FAILED
 * reports surface on the admin screen with a manual retry.
 */
@Injectable()
export class LatraService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LatraService.name);
  private connection!: Redis;
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LATRA_CLIENT) private readonly client: LatraClient,
  ) {}

  async onModuleInit() {
    if (this.client.name !== "mock" && !this.cetsTransportIsEncrypted()) {
      this.logger.warn(
        `CeTS endpoint ${appConfig.latra.cets.baseUrl} is NOT https — passenger name and phone ` +
          `will cross the network in clear text, and passengerNida is being withheld. ` +
          `Request a TLS endpoint from LATRA before going live.`,
      );
    }
    this.connection = new Redis(appConfig.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue("latra", { connection: this.connection, prefix: appConfig.queuePrefix });
    this.worker = new Worker(
      "latra",
      async (job) => {
        const data = job.data as LatraJob;
        if (data.kind === "submit-report") await this.submitReport(data.reportId);
        else if (data.kind === "daily-report") await this.submitDailyReport();
      },
      { connection: this.connection.duplicate(), concurrency: 3, prefix: appConfig.queuePrefix },
    );
    this.worker.on("failed", async (job, err) => {
      const data = job?.data as LatraJob | undefined;
      this.logger.error(`latra job failed (${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`);
      // Out of retries → durable FAILED for the admin screen.
      if (data?.kind === "submit-report" && job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        await this.prisma.latraReport
          .update({
            where: { id: data.reportId },
            data: { status: LatraReportStatus.FAILED, lastError: err.message },
          })
          .catch(() => undefined);
      }
    });

    // CeTS §6: one operational summary per day. Runs at 00:30 EAT (21:30 UTC)
    // and reports the day that just closed.
    await this.queue.upsertJobScheduler(
      "cets-daily-report",
      { pattern: "30 21 * * *" },
      { name: "daily-report", data: { kind: "daily-report" }, opts: { attempts: 5, backoff: { type: "exponential", delay: 60_000 } } },
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit().catch(() => this.connection.disconnect());
  }

  /** Outbox write — call after a trip reaches COMPLETED or CANCELLED_*. */
  /** Tanzania local time (EAT = UTC+3, no DST) as "YYYY-MM-DD HH:MM:SS" —
   *  LATRA's Stage-2 dataset requires local time with no "T" or sub-seconds. */
  private latraLocalTime(d: Date | null): string | null {
    if (!d) return null;
    const eat = new Date(d.getTime() + 3 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return (
      `${eat.getUTCFullYear()}-${p(eat.getUTCMonth() + 1)}-${p(eat.getUTCDate())} ` +
      `${p(eat.getUTCHours())}:${p(eat.getUTCMinutes())}:${p(eat.getUTCSeconds())}`
    );
  }

  /** Date-only in EAT, "YYYY-MM-DD" — vehicleRegistrationDate and reportDate. */
  private latraDate(d: Date): string {
    return this.latraLocalTime(d)!.slice(0, 10);
  }

  /**
   * Is the CeTS link encrypted? LATRA's API document gives the endpoint as
   * plain `http://` to a bare IP. Trip payloads carry passenger name, phone
   * and national ID, so this gates what we are willing to put on the wire.
   */
  private cetsTransportIsEncrypted(): boolean {
    return appConfig.latra.cets.baseUrl.startsWith("https://");
  }

  /**
   * Stable hash of a registration payload. LATRA wants a driver/vehicle
   * re-submitted "whenever details change"; storing this and comparing it
   * catches every edit path, instead of relying on each one to remember to
   * force a re-sync.
   */
  private fingerprint(payload: Record<string, unknown>): string {
    const canonical = Object.keys(payload)
      .sort()
      .map((k) => `${k}=${String(payload[k] ?? "")}`)
      .join("|");
    return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  }

  /**
   * Builds CeTS's submitTrip dataset (docs/LATRA 1.pdf §5) — 16 fields, all
   * required except passengerNida. Rebuilt at submission time so a rating that
   * lands just after the trip is included.
   *
   * Area names: CeTS wants pickup/drop as *areas*, and our landmarks are
   * optional (pin-drop bookings have coordinates only), so we fall back to the
   * pickup note and finally to the coordinate pair — never empty, since both
   * fields are required.
   */
  private async buildLatraPayload(tripId: string): Promise<Prisma.InputJsonValue | null> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        vehicle: true,
        driver: { include: { user: true } },
        ratings: true,
        passenger: true,
        pickupLandmark: true,
        dropLandmark: true,
      },
    });
    if (!trip) return null;
    // CeTS §5 defines submission for COMPLETED trips only — a cancelled trip
    // has no startTime/endTime/rating and would fail the required-field checks.
    if (trip.status !== DbTripStatus.COMPLETED) {
      this.logger.log(`skipping CeTS report for ${tripId}: status ${trip.status} is not COMPLETED`);
      return null;
    }
    const breakdown = trip.fareBreakdown as { driverEarnings?: number } | null;
    const driverRating = trip.driver
      ? trip.ratings.find((r) => r.rateeId === trip.driver!.userId)
      : undefined;
    const order = appConfig.latra.cets.coordOrder;
    const pickup = cetsCoordinates(Number(trip.pickupLat), Number(trip.pickupLng), order);
    const drop = cetsCoordinates(Number(trip.dropLat), Number(trip.dropLng), order);

    // CeTS wants pickup/drop as *area names*, not coordinates. Prefer the booked
    // landmark; for pin-drop / GPS bookings with none, reverse-geocode to the
    // nearest known landmark before falling back to the pickup note and finally
    // the raw coordinates (a required field is never empty).
    const pickupArea =
      trip.pickupLandmark?.name ??
      (await this.nearestLandmarkName(Number(trip.pickupLat), Number(trip.pickupLng))) ??
      trip.pickupNote ??
      pickup;
    const dropArea =
      trip.dropLandmark?.name ??
      (await this.nearestLandmarkName(Number(trip.dropLat), Number(trip.dropLng))) ??
      drop;

    // Canonical dataset, in CeTS's documented item order (see
    // LATRA_TRIP_REPORT_FIELDS for the label each key corresponds to).
    const canonical: Record<string, unknown> = {
      tripId: trip.id,
      originCoordinates: pickup,
      endCoordinates: drop,
      startTime: this.latraLocalTime(trip.startedAt),
      endTime: this.latraLocalTime(trip.completedAt),
      totalFareAmount: trip.finalFare === null ? Number(trip.estimatedFare) : Number(trip.finalFare),
      tripDistance: trip.finalDistanceM ?? trip.estimatedDistanceM, // integer metres
      rating: cetsRating(driverRating?.score),
      driverEarning: breakdown?.driverEarnings ?? 0,
      driverLicenseNumber: cetsLicence(trip.driver?.licenseNumber) ?? null,
      vehicleRegistrationNumber: trip.vehicle ? cetsPlate(trip.vehicle.plateNumber) : null,
      // Passenger identity. Dispatcher-created trips have no passenger account,
      // only a callback number — fall back to that rather than omitting a
      // required field.
      // Real name where we have one: the passenger account, else the caller name
      // a dispatcher captured; only then the generic "passenger" placeholder.
      passengerName: trip.passenger?.name ?? trip.contactName ?? "Abiria", // "passenger" (sw)
      passengerPhone: trip.passenger?.phone ?? trip.contactPhone ?? "",
      // National ID. CeTS marks this OPTIONAL, and LATRA's documented endpoint
      // is plain HTTP — sending a NIN in clear text over an unencrypted link is
      // not defensible under the PDPA, so we withhold it unless the transport
      // is TLS. Everything else in this payload is already disclosed to the
      // driver; a NIN is not.
      passengerNida: this.cetsTransportIsEncrypted() ? (trip.passenger?.nida ?? null) : null,
      pickupPoint: pickupArea,
      dropOffPoint: dropArea,
    };
    return applyLatraFieldMap(canonical, appConfig.latra.fieldMap) as Prisma.InputJsonValue;
  }

  /**
   * Nearest landmark name to a coordinate, for CeTS area naming when a booking
   * has no landmark attached. Bounded box + planar distance (accurate enough
   * under ~1 km); returns null when nothing sits within AREA_NAME_RADIUS_M so
   * the caller can fall back rather than label a trip by a landmark far away.
   */
  private async nearestLandmarkName(lat: number, lng: number): Promise<string | null> {
    const dLat = AREA_NAME_RADIUS_M / 111_320;
    const dLng = AREA_NAME_RADIUS_M / (111_320 * Math.cos((lat * Math.PI) / 180));
    const candidates = await this.prisma.landmark.findMany({
      where: {
        lat: { gte: lat - dLat, lte: lat + dLat },
        lng: { gte: lng - dLng, lte: lng + dLng },
      },
      select: { name: true, lat: true, lng: true },
    });
    let best: { name: string; d: number } | null = null;
    for (const c of candidates) {
      const dy = (Number(c.lat) - lat) * 111_320;
      const dx = (Number(c.lng) - lng) * 111_320 * Math.cos((lat * Math.PI) / 180);
      const d = Math.hypot(dx, dy);
      if (d <= AREA_NAME_RADIUS_M && (!best || d < best.d)) best = { name: c.name, d };
    }
    return best?.name ?? null;
  }

  /** CeTS §3 payload for a vehicle. */
  private vehiclePayload(v: {
    plateNumber: string;
    model: string | null;
    chassisNumber: string | null;
    class: string;
    registrationDate: Date | null;
    createdAt: Date;
  }): Record<string, unknown> {
    return {
      vehicleRegistrationNumber: cetsPlate(v.plateNumber),
      vehicleModel: v.model ?? undefined,
      vehicleChasisNumber: v.chassisNumber ?? undefined,
      vehicleTypeEnum: CETS_VEHICLE_TYPE[v.class] ?? "CAR",
      vehicleRegistrationDate: this.latraDate(v.registrationDate ?? v.createdAt),
    };
  }

  /** CeTS §4 payload for a driver. */
  private driverPayload(d: {
    licenseNumber: string | null;
    licenceCategory: string | null;
    user: { name: string; phone: string; email: string | null };
  }): Record<string, unknown> {
    return {
      driverName: d.user.name,
      driverEmail: d.user.email ?? "",
      driverPhone: d.user.phone,
      driverLicenseNumber: cetsLicence(d.licenseNumber) ?? "",
      licenceCategory: d.licenceCategory ?? "",
    };
  }

  /**
   * Outbox write. CeTS §5 defines submission for **completed** trips only
   * ("Each completed trip must be submitted once, immediately after trip
   * completion") — a cancelled trip has no startTime/endTime/rating and would
   * be rejected on the required-field checks. We therefore skip non-completed
   * trips rather than queue submissions that can only ever fail.
   *
   * OPEN WITH LATRA: whether CeTS wants cancellations reported at all, and if
   * so through which endpoint (see docs/latra-cets-api-gap-analysis.md §3).
   */
  async enqueueTripReport(tripId: string): Promise<void> {
    // Single query: buildLatraPayload already loads the trip and returns null
    // for anything that is not COMPLETED. This runs inside the driver's
    // COMPLETE request, so an extra round-trip here directly delays that
    // response.
    const payload = await this.buildLatraPayload(tripId);
    if (!payload) return;
    const report = await this.prisma.latraReport.create({ data: { tripId, payload } });
    await this.enqueueSubmission(report.id);
  }

  private async enqueueSubmission(reportId: string, delayMs = appConfig.latra.reportDelayS * 1000): Promise<void> {
    const job: LatraJob = { kind: "submit-report", reportId };
    await this.queue.add("submit-report", job, {
      delay: delayMs,
      attempts: 5,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  /**
   * Registers a vehicle with CeTS (§3). Idempotent: skips when already
   * registered unless `force` is set (details changed). CeTS treats a
   * registered vehicle as a prerequisite for trip submission.
   */
  async registerVehicle(vehicleId: string, force = false): Promise<{ registered: boolean; error?: string }> {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) throw new NotFoundException("Vehicle not found");
    const payload = this.vehiclePayload(vehicle);
    const fingerprint = this.fingerprint(payload);
    // LATRA: submit once, "or whenever vehicle details are updated".
    if (vehicle.cetsRegisteredAt && vehicle.cetsFingerprint === fingerprint && !force) {
      return { registered: true };
    }
    try {
      await this.client.submitVehicle(payload);
      await this.prisma.vehicle.update({
        where: { id: vehicleId },
        data: { cetsRegisteredAt: new Date(), cetsLastError: null, cetsFingerprint: fingerprint },
      });
      return { registered: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error(`CeTS submitVehicle ${vehicle.plateNumber} failed: ${error}`);
      await this.prisma.vehicle.update({ where: { id: vehicleId }, data: { cetsLastError: error } });
      return { registered: false, error };
    }
  }

  /** Registers a driver with CeTS (§4). Same idempotency as registerVehicle. */
  async registerDriver(driverProfileId: string, force = false): Promise<{ registered: boolean; error?: string }> {
    const driver = await this.prisma.driverProfile.findUnique({
      where: { id: driverProfileId },
      include: { user: true },
    });
    if (!driver) throw new NotFoundException("Driver not found");
    const fingerprint = this.fingerprint(this.driverPayload(driver));
    // LATRA: submit once, "or whenever driver details change".
    if (driver.cetsRegisteredAt && driver.cetsFingerprint === fingerprint && !force) {
      return { registered: true };
    }
    // Pre-flight: CeTS requires a valid 10-digit licence and a category. Fail
    // locally with an actionable message rather than round-tripping a payload
    // we already know CeTS will reject.
    const problem = !cetsLicence(driver.licenseNumber)
      ? `driver licence must be a valid 10 digit number (got ${driver.licenseNumber ?? "none"})`
      : !driver.licenceCategory
        ? "driver licence category is required"
        : !driver.user.email
          ? "driver email is required"
          : undefined;
    if (problem) {
      await this.prisma.driverProfile.update({
        where: { id: driverProfileId },
        data: { cetsLastError: problem },
      });
      return { registered: false, error: problem };
    }
    try {
      await this.client.submitDriver(this.driverPayload(driver));
      await this.prisma.driverProfile.update({
        where: { id: driverProfileId },
        data: { cetsRegisteredAt: new Date(), cetsLastError: null, cetsFingerprint: fingerprint },
      });
      return { registered: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error(`CeTS submitDriver ${driver.id} failed: ${error}`);
      await this.prisma.driverProfile.update({
        where: { id: driverProfileId },
        data: { cetsLastError: error },
      });
      return { registered: false, error };
    }
  }

  /**
   * CeTS §6 — one operational summary per day, covering completed trips for
   * the given date (EAT).
   *
   * The outcome is persisted (LatraDailyReport, one row per date) so we can
   * evidence which days were filed and retry the ones that were not. A
   * fire-and-forget job that exhausts its retries would otherwise leave a
   * silently unreported day, which is exactly the kind of hole a regulator
   * asks about.
   */
  async submitDailyReport(forDate = new Date(Date.now() - 24 * 3600 * 1000)): Promise<{
    totalTrip: number;
    totalPaidAmount: number;
    reportDate: string;
    status: LatraReportStatus;
  }> {
    const reportDate = this.latraDate(forDate);
    // Day boundaries in EAT, expressed as UTC instants.
    const startUtc = new Date(`${reportDate}T00:00:00.000Z`).getTime() - 3 * 3600 * 1000;
    const trips = await this.prisma.trip.findMany({
      where: {
        status: DbTripStatus.COMPLETED,
        completedAt: { gte: new Date(startUtc), lt: new Date(startUtc + 24 * 3600 * 1000) },
      },
      select: { finalFare: true, estimatedFare: true },
    });
    const totalPaidAmount = Math.round(
      trips.reduce((sum, t) => sum + Number(t.finalFare ?? t.estimatedFare), 0),
    );
    const payload = { totalTrip: trips.length, totalPaidAmount, reportDate };

    const base = { totalTrip: trips.length, totalPaidAmount };
    await this.prisma.latraDailyReport.upsert({
      where: { reportDate },
      create: { reportDate, ...base, status: LatraReportStatus.PENDING, attempts: 1 },
      update: { ...base, attempts: { increment: 1 } },
    });

    try {
      await this.client.submitDailyReport(payload);
      await this.prisma.latraDailyReport.update({
        where: { reportDate },
        data: { status: LatraReportStatus.ACKED, lastError: null, submittedAt: new Date() },
      });
      this.logger.log(`CeTS daily report ${reportDate}: ${trips.length} trips, ${totalPaidAmount} TZS`);
      return { ...payload, status: LatraReportStatus.ACKED };
    } catch (e) {
      const lastError = e instanceof Error ? e.message : String(e);
      await this.prisma.latraDailyReport.update({
        where: { reportDate },
        data: { status: LatraReportStatus.FAILED, lastError },
      });
      this.logger.error(`CeTS daily report ${reportDate} failed: ${lastError}`);
      throw e; // let BullMQ retry; the row records why it failed
    }
  }

  /** Filed daily reports, newest first — for the admin LATRA screen. */
  async listDailyReports(limit = 60) {
    return this.prisma.latraDailyReport.findMany({ orderBy: { reportDate: "desc" }, take: limit });
  }

  private async submitReport(reportId: string): Promise<void> {
    const report = await this.prisma.latraReport.findUnique({
      where: { id: reportId },
      include: { trip: true },
    });
    if (!report || report.status === LatraReportStatus.ACKED) return;

    // Ordering constraint (§3/§4): CeTS rejects a trip whose driver or vehicle
    // it has not already accepted, so register them first. Failures here throw
    // into the retry/backoff path rather than burning the trip submission.
    if (report.trip.driverId) {
      const r = await this.registerDriver(report.trip.driverId);
      if (!r.registered) throw new Error(`driver not registered with CeTS: ${r.error}`);
    }
    if (report.trip.vehicleId) {
      const r = await this.registerVehicle(report.trip.vehicleId);
      if (!r.registered) throw new Error(`vehicle not registered with CeTS: ${r.error}`);
    }

    // Rebuild fresh so a post-trip rating is captured in the submitted dataset.
    const payload = (await this.buildLatraPayload(report.tripId)) ?? (report.payload as Prisma.InputJsonValue);
    await this.prisma.latraReport.update({
      where: { id: reportId },
      data: { attempts: { increment: 1 }, payload },
    });
    const { ackId, latraReferenceNumber } = await this.client.submitTripReport(
      payload as Record<string, unknown>,
    );
    await this.prisma.latraReport.update({
      where: { id: reportId },
      data: {
        status: LatraReportStatus.ACKED,
        lastError: null,
        latraReferenceNumber,
        payload: {
          ...(payload as Record<string, unknown>),
          ackId,
          ...(latraReferenceNumber ? { latraReferenceNumber } : {}),
        } as Prisma.InputJsonValue,
      },
    });
  }

  /** Admin manual retry for FAILED reports. */
  async retryReport(reportId: string): Promise<{ ok: true }> {
    const report = await this.prisma.latraReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException("Report not found");
    await this.prisma.latraReport.update({
      where: { id: reportId },
      data: { status: LatraReportStatus.PENDING, lastError: null },
    });
    await this.enqueueSubmission(reportId);
    return { ok: true };
  }

  /**
   * Vehicle verification hook (spec §12.2): called during vehicle approval.
   * Admin may override with a logged justification while credentials pend.
   */
  async verifyVehicle(vehicleId: string, adminUserId: string, override?: { justification: string }) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { driver: true },
    });
    if (!vehicle) throw new NotFoundException("Vehicle not found");

    if (override) {
      await this.prisma.$transaction([
        this.prisma.vehicle.update({ where: { id: vehicleId }, data: { latraVerified: true } }),
        this.prisma.driverProfile.update({
          where: { id: vehicle.driverId },
          data: { latraVerifiedAt: new Date() },
        }),
        this.prisma.auditLog.create({
          data: {
            actorId: adminUserId,
            action: "LATRA_VERIFY_OVERRIDE",
            entity: "Vehicle",
            entityId: vehicleId,
            after: { justification: override.justification },
          },
        }),
      ]);
      return { verified: true, overridden: true };
    }

    const result = await this.client.verifyVehicle(vehicle.plateNumber, vehicle.latraLicenseNumber ?? "");
    await this.prisma.$transaction([
      this.prisma.vehicle.update({ where: { id: vehicleId }, data: { latraVerified: result.verified } }),
      ...(result.verified
        ? [
            this.prisma.driverProfile.update({
              where: { id: vehicle.driverId },
              data: { latraVerifiedAt: new Date() },
            }),
          ]
        : []),
      this.prisma.auditLog.create({
        data: {
          actorId: adminUserId,
          action: "LATRA_VERIFY_VEHICLE",
          entity: "Vehicle",
          entityId: vehicleId,
          after: { verified: result.verified, detail: result.detail ?? null },
        },
      }),
    ]);
    return { verified: result.verified, detail: result.detail };
  }
}
