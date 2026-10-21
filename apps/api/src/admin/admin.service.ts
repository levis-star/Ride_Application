import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DocumentStatus, LedgerAccount, Prisma, TripStatus } from "@prisma/client";
import {
  FareConfigInput,
  LandmarkCreateDto,
  LandmarkUpdateDto,
  LatraBoundsInput,
  VehicleClass,
  validateFareConfig,
} from "@rukwaride/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerService } from "../ledger/ledger.service";
import { LatraService } from "../latra/latra.service";

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly latra: LatraService,
  ) {}

  private audit(actorId: string, action: string, entity: string, entityId: string, before?: unknown, after?: unknown) {
    return this.prisma.auditLog.create({
      data: {
        actorId,
        action,
        entity,
        entityId,
        before: before as Prisma.InputJsonValue,
        after: after as Prisma.InputJsonValue,
      },
    });
  }

  // ---------- dashboard ----------

  async dashboard() {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const terminal7d = await this.prisma.trip.groupBy({
      by: ["status"],
      where: { createdAt: { gte: weekAgo } },
      _count: true,
    });
    const count = (s: TripStatus) => terminal7d.find((r) => r.status === s)?._count ?? 0;
    const completed = count(TripStatus.COMPLETED);
    const cancelled = count(TripStatus.CANCELLED_BY_PASSENGER) + count(TripStatus.CANCELLED_BY_DRIVER);
    const expired = count(TripStatus.EXPIRED);
    const settled = completed + cancelled + expired;

    const revenue = await this.prisma.ledgerEntry.aggregate({
      where: { account: LedgerAccount.PLATFORM_REVENUE, createdAt: { gte: weekAgo } },
      _sum: { credit: true, debit: true },
    });

    return {
      tripsToday: await this.prisma.trip.count({ where: { createdAt: { gte: dayStart } } }),
      trips7d: await this.prisma.trip.count({ where: { createdAt: { gte: weekAgo } } }),
      completionRate7d: settled === 0 ? null : Number((completed / settled).toFixed(3)),
      cancellationRate7d: settled === 0 ? null : Number((cancelled / settled).toFixed(3)),
      expiredRate7d: settled === 0 ? null : Number((expired / settled).toFixed(3)),
      activeDriversNow: await this.prisma.driverProfile.count({
        where: { status: { in: ["AVAILABLE", "ON_OFFER", "ON_TRIP"] } },
      }),
      revenue7d: Number(revenue._sum.credit ?? 0) - Number(revenue._sum.debit ?? 0),
      openTickets: await this.prisma.supportTicket.count({ where: { status: "OPEN" } }),
      failedLatraReports: await this.prisma.latraReport.count({ where: { status: "FAILED" } }),
    };
  }

  // ---------- driver onboarding / documents ----------

  async listDocuments(status?: DocumentStatus) {
    const docs = await this.prisma.driverDocument.findMany({
      where: status ? { status } : {},
      include: { driver: { include: { user: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return docs.map((d) => ({
      id: d.id,
      type: d.type,
      status: d.status,
      fileUrl: d.fileUrl,
      expiresAt: d.expiresAt,
      rejectionReason: d.rejectionReason,
      driver: { id: d.driverId, name: d.driver.user.name, phone: d.driver.user.phone },
      createdAt: d.createdAt,
    }));
  }

  async reviewDocument(
    adminId: string,
    documentId: string,
    decision: "APPROVED" | "REJECTED",
    rejectionReason?: string,
  ) {
    const doc = await this.prisma.driverDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException("Document not found");
    if (decision === "REJECTED" && !rejectionReason) {
      throw new BadRequestException("Rejection requires a reason");
    }
    const updated = await this.prisma.driverDocument.update({
      where: { id: documentId },
      data: {
        status: decision,
        reviewedById: adminId,
        rejectionReason: decision === "REJECTED" ? rejectionReason : null,
      },
    });
    // Approving the driver's photo makes it the profile photo the passenger
    // sees (LATRA requires the rider to see the driver's name AND photo).
    if (decision === "APPROVED" && doc.type === "DRIVER_PHOTO") {
      await this.prisma.driverProfile.update({
        where: { id: doc.driverId },
        data: { photoKey: doc.fileUrl },
      });
    }
    await this.audit(adminId, `DOCUMENT_${decision}`, "DriverDocument", documentId, { status: doc.status }, {
      status: decision,
      rejectionReason,
    });
    return updated;
  }

  async listDrivers(query?: string) {
    const drivers = await this.prisma.driverProfile.findMany({
      where: query
        ? {
            user: {
              OR: [
                { name: { contains: query, mode: "insensitive" } },
                { phone: { contains: query } },
              ],
            },
          }
        : {},
      include: { user: true, currentVehicle: true, documents: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return drivers.map((d) => ({
      id: d.id,
      name: d.user.name,
      phone: d.user.phone,
      status: d.status,
      isBlocked: d.user.isBlocked,
      walletBalance: Number(d.walletBalance),
      ratingAvg: Number(d.ratingAvg),
      strikeCount: d.strikeCount,
      manualAssignConsent: d.manualAssignConsent,
      approvedAt: d.approvedAt,
      latraVerifiedAt: d.latraVerifiedAt,
      vehicle: d.currentVehicle
        ? {
            id: d.currentVehicle.id,
            plateNumber: d.currentVehicle.plateNumber,
            class: d.currentVehicle.class,
            latraVerified: d.currentVehicle.latraVerified,
          }
        : null,
      documents: d.documents.map((doc) => ({ id: doc.id, type: doc.type, status: doc.status })),
    }));
  }

  async approveDriver(adminId: string, driverProfileId: string) {
    const driver = await this.prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
    if (!driver) throw new NotFoundException("Driver not found");
    const updated = await this.prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: { approvedAt: new Date() },
    });
    await this.audit(adminId, "DRIVER_APPROVED", "DriverProfile", driverProfileId, {
      approvedAt: driver.approvedAt,
    }, { approvedAt: updated.approvedAt });
    // Register with CeTS — a trip may only reference a driver (and their
    // vehicle) that LATRA has already accepted. Non-fatal here: the trip
    // outbox retries registration before each submission.
    const cets = await this.latra.registerDriver(driverProfileId);
    if (driver.currentVehicleId) await this.latra.registerVehicle(driver.currentVehicleId);
    return { approvedAt: updated.approvedAt, cetsRegistered: cets.registered, cetsError: cets.error };
  }

  async setDriverConsent(adminId: string, driverProfileId: string, consent: boolean) {
    await this.prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: { manualAssignConsent: consent },
    });
    await this.audit(adminId, "DRIVER_CONSENT_SET", "DriverProfile", driverProfileId, undefined, { consent });
    return { manualAssignConsent: consent };
  }

  async setUserBlocked(adminId: string, userId: string, blocked: boolean) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    await this.prisma.user.update({ where: { id: userId }, data: { isBlocked: blocked } });
    await this.audit(adminId, blocked ? "USER_BLOCKED" : "USER_UNBLOCKED", "User", userId, {
      isBlocked: user.isBlocked,
    }, { isBlocked: blocked });
    return { isBlocked: blocked };
  }

  /** Manual wallet adjustment — mandatory memo, booked as a balanced txn (spec §13). */
  async adjustWallet(adminId: string, driverProfileId: string, amount: number, memo: string) {
    if (!Number.isInteger(amount) || amount === 0) {
      throw new BadRequestException("Amount must be a non-zero integer (TZS; negative to deduct)");
    }
    const driver = await this.prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
    if (!driver) throw new NotFoundException("Driver not found");

    const txnId = await this.ledger.postTransaction([
      {
        account: LedgerAccount.DRIVER_WALLET,
        driverId: driverProfileId,
        ...(amount > 0 ? { credit: amount } : { debit: -amount }),
        memo: `Admin adjustment: ${memo}`,
      },
      {
        account: LedgerAccount.PLATFORM_RECEIVABLE,
        ...(amount > 0 ? { debit: amount } : { credit: -amount }),
        memo: `Admin adjustment: ${memo}`,
      },
    ]);
    await this.audit(adminId, "WALLET_ADJUSTED", "DriverProfile", driverProfileId, {
      walletBalance: Number(driver.walletBalance),
    }, { amount, memo, txnId });
    return { txnId, newBalance: Number(driver.walletBalance) + amount };
  }

  // ---------- fare configs (LATRA-bounds validated, spec §8/§13) ----------

  async getFares() {
    const [configs, bounds] = await Promise.all([
      this.prisma.fareConfig.findMany({ orderBy: [{ vehicleClass: "asc" }, { effectiveFrom: "desc" }], take: 60 }),
      this.prisma.latraBounds.findMany(),
    ]);
    return {
      configs: configs.map((c) => ({
        id: c.id,
        vehicleClass: c.vehicleClass,
        active: c.active,
        baseFare: Number(c.baseFare),
        perKm: Number(c.perKm),
        perMin: Number(c.perMin),
        bookingFeePct: Number(c.bookingFeePct),
        minimumFare: Number(c.minimumFare),
        commissionPct: Number(c.commissionPct),
        latraOrderRef: c.latraOrderRef,
        effectiveFrom: c.effectiveFrom,
      })),
      bounds: bounds.map((b) => ({
        vehicleClass: b.vehicleClass,
        minFareFloor: Number(b.minFareFloor),
        perKmMin: Number(b.perKmMin),
        perKmMax: Number(b.perKmMax),
        perMinMin: Number(b.perMinMin),
        perMinMax: Number(b.perMinMax),
        commissionMax: Number(b.commissionMax),
        bookingFeeMax: Number(b.bookingFeeMax),
        sourceRef: b.sourceRef,
      })),
    };
  }

  async saveFareConfig(adminId: string, input: FareConfigInput & { latraOrderRef: string }) {
    const boundsRow = await this.prisma.latraBounds.findUnique({
      where: { vehicleClass: input.vehicleClass },
    });
    if (!boundsRow) throw new BadRequestException(`No LATRA bounds seeded for ${input.vehicleClass}`);
    const bounds: LatraBoundsInput = {
      vehicleClass: boundsRow.vehicleClass as VehicleClass,
      minFareFloor: Number(boundsRow.minFareFloor),
      perKmMin: Number(boundsRow.perKmMin),
      perKmMax: Number(boundsRow.perKmMax),
      perMinMin: Number(boundsRow.perMinMin),
      perMinMax: Number(boundsRow.perMinMax),
      commissionMax: Number(boundsRow.commissionMax),
      bookingFeeMax: Number(boundsRow.bookingFeeMax),
    };
    const result = validateFareConfig(input, bounds);
    if (!result.ok) {
      // Reject with the exact bound violated (spec §8).
      throw new BadRequestException({
        message: "Fare config violates LATRA bounds",
        violations: result.violations,
      });
    }

    const previous = await this.prisma.fareConfig.findFirst({
      where: { vehicleClass: input.vehicleClass, active: true },
    });
    const created = await this.prisma.$transaction(async (tx) => {
      if (previous) {
        await tx.fareConfig.update({ where: { id: previous.id }, data: { active: false } });
      }
      return tx.fareConfig.create({
        data: {
          vehicleClass: input.vehicleClass,
          baseFare: new Prisma.Decimal(input.baseFare),
          perKm: new Prisma.Decimal(input.perKm),
          perMin: new Prisma.Decimal(input.perMin),
          bookingFeePct: new Prisma.Decimal(input.bookingFeePct),
          minimumFare: new Prisma.Decimal(input.minimumFare),
          commissionPct: new Prisma.Decimal(input.commissionPct),
          latraOrderRef: input.latraOrderRef,
        },
      });
    });
    await this.audit(adminId, "FARE_CONFIG_SAVED", "FareConfig", created.id, previous ?? undefined, input);
    return { id: created.id };
  }

  // ---------- ledger browser / audit / LATRA / tickets ----------

  async browseLedger(filter: { account?: string; driverId?: string; skip?: number; take?: number }) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        ...(filter.account ? { account: filter.account as LedgerAccount } : {}),
        ...(filter.driverId ? { driverId: filter.driverId } : {}),
      },
      orderBy: { createdAt: "desc" },
      skip: filter.skip ?? 0,
      take: Math.min(filter.take ?? 50, 200),
    });
    return entries.map((e) => ({
      id: e.id,
      txnId: e.txnId,
      account: e.account,
      driverId: e.driverId,
      debit: Number(e.debit),
      credit: Number(e.credit),
      tripId: e.tripId,
      paymentId: e.paymentId,
      memo: e.memo,
      at: e.createdAt,
    }));
  }

  listAudit(filter: { entity?: string; skip?: number; take?: number }) {
    return this.prisma.auditLog.findMany({
      where: filter.entity ? { entity: filter.entity } : {},
      orderBy: { createdAt: "desc" },
      skip: filter.skip ?? 0,
      take: Math.min(filter.take ?? 50, 200),
    });
  }

  listLatraReports(status?: string) {
    return this.prisma.latraReport.findMany({
      where: status ? { status: status as never } : {},
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  listTickets(status?: string) {
    return this.prisma.supportTicket.findMany({
      where: status ? { status } : {},
      include: { openedBy: { select: { name: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async updateTicket(
    staffId: string,
    ticketId: string,
    data: { status?: string; assignedToId?: string; resolutionNote?: string },
  ) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException("Ticket not found");
    const updated = await this.prisma.supportTicket.update({ where: { id: ticketId }, data });
    await this.audit(staffId, "TICKET_UPDATED", "SupportTicket", ticketId, ticket, data);
    return updated;
  }

  /**
   * Drivers and vehicles CeTS has not accepted. A trip may only reference a
   * registered driver and vehicle, so anything listed here is a driver whose
   * trips cannot be reported to LATRA — previously invisible, since the
   * failure was only stored in a column nothing displayed.
   */
  async cetsRegistrationIssues() {
    const [drivers, vehicles] = await Promise.all([
      this.prisma.driverProfile.findMany({
        where: { approvedAt: { not: null }, cetsRegisteredAt: null },
        include: { user: { select: { name: true, phone: true, email: true } } },
        orderBy: { updatedAt: "desc" },
        take: 200,
      }),
      this.prisma.vehicle.findMany({
        where: { active: true, cetsRegisteredAt: null },
        orderBy: { updatedAt: "desc" },
        take: 200,
      }),
    ]);
    return {
      drivers: drivers.map((d) => ({
        id: d.id,
        name: d.user.name,
        phone: d.user.phone,
        email: d.user.email,
        licenseNumber: d.licenseNumber,
        licenceCategory: d.licenceCategory,
        error: d.cetsLastError,
      })),
      vehicles: vehicles.map((v) => ({
        id: v.id,
        plateNumber: v.plateNumber,
        class: v.class,
        registrationDate: v.registrationDate,
        error: v.cetsLastError,
      })),
    };
  }

  // ---------- landmark curation ----------
  //
  // Our landmarks are imported from OpenStreetMap, which around Sumbawanga
  // labels ATMs as bank branches and maps some places more than once. Staff
  // with local knowledge correct them here; corrections are marked
  // source=STAFF and survive re-imports (see prisma/seed.ts).

  private landmarkDto(l: {
    id: string;
    name: string;
    aliasNames: string[];
    category: string;
    lat: Prisma.Decimal;
    lng: Prisma.Decimal;
    source: string;
    verified: boolean;
    verifiedAt: Date | null;
  }) {
    return {
      id: l.id,
      name: l.name,
      aliasNames: l.aliasNames,
      category: l.category,
      lat: Number(l.lat),
      lng: Number(l.lng),
      source: l.source,
      verified: l.verified,
      verifiedAt: l.verifiedAt?.toISOString() ?? null,
    };
  }

  async listLandmarks(opts: { q?: string; unverifiedOnly?: boolean } = {}) {
    const q = opts.q?.trim();
    const rows = await this.prisma.landmark.findMany({
      where: {
        ...(opts.unverifiedOnly ? { verified: false } : {}),
        ...(q
          ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { aliasNames: { hasSome: [q] } }] }
          : {}),
      },
      orderBy: [{ name: "asc" }],
      take: 200,
    });
    return rows.map((l) => this.landmarkDto(l));
  }

  /**
   * Same-name clusters, so staff can see at a glance that OSM has (say) six
   * separate "NMB Bank" points and decide which is the branch.
   */
  async landmarkDuplicates() {
    const rows = await this.prisma.landmark.findMany({ orderBy: [{ name: "asc" }] });
    const groups = new Map<string, typeof rows>();
    for (const l of rows) {
      const key = l.name.trim().toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), l]);
    }
    return [...groups.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([name, list]) => ({ name, count: list.length, items: list.map((l) => this.landmarkDto(l)) }))
      .sort((a, b) => b.count - a.count);
  }

  async createLandmark(staffId: string, dto: LandmarkCreateDto) {
    const created = await this.prisma.landmark.create({
      data: {
        name: dto.name,
        aliasNames: dto.aliasNames ?? [],
        category: dto.category,
        lat: dto.lat,
        lng: dto.lng,
        // Staff-entered with local knowledge: trusted and protected from
        // being overwritten by the next OSM import.
        source: "STAFF",
        verified: true,
        verifiedAt: new Date(),
        verifiedById: staffId,
      },
    });
    await this.audit(staffId, "LANDMARK_CREATED", "Landmark", created.id, null, dto);
    return this.landmarkDto(created);
  }

  async updateLandmark(staffId: string, id: string, dto: LandmarkUpdateDto) {
    const before = await this.prisma.landmark.findUnique({ where: { id } });
    if (!before) throw new NotFoundException("Landmark not found");
    const verifying = dto.verified === true;
    const updated = await this.prisma.landmark.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.aliasNames !== undefined ? { aliasNames: dto.aliasNames } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.lat !== undefined ? { lat: dto.lat } : {}),
        ...(dto.lng !== undefined ? { lng: dto.lng } : {}),
        ...(dto.verified !== undefined ? { verified: dto.verified } : {}),
        ...(verifying ? { verifiedAt: new Date(), verifiedById: staffId } : {}),
        // Any human edit takes the record out of the replaceable OSM pool.
        source: "STAFF",
      },
    });
    await this.audit(staffId, "LANDMARK_UPDATED", "Landmark", id, before, dto);
    return this.landmarkDto(updated);
  }

  async deleteLandmark(staffId: string, id: string) {
    const before = await this.prisma.landmark.findUnique({ where: { id } });
    if (!before) throw new NotFoundException("Landmark not found");
    // Trips keep their coordinates; only the label reference is cleared.
    await this.prisma.trip.updateMany({ where: { pickupLandmarkId: id }, data: { pickupLandmarkId: null } });
    await this.prisma.trip.updateMany({ where: { dropLandmarkId: id }, data: { dropLandmarkId: null } });
    await this.prisma.landmark.delete({ where: { id } });
    await this.audit(staffId, "LANDMARK_DELETED", "Landmark", id, before, null);
    return { ok: true as const };
  }

  /** Fold a duplicate into the landmark that should survive, keeping aliases. */
  async mergeLandmark(staffId: string, id: string, intoId: string) {
    if (id === intoId) throw new BadRequestException("Cannot merge a landmark into itself");
    const [from, into] = await Promise.all([
      this.prisma.landmark.findUnique({ where: { id } }),
      this.prisma.landmark.findUnique({ where: { id: intoId } }),
    ]);
    if (!from || !into) throw new NotFoundException("Landmark not found");

    const aliases = [...new Set([...into.aliasNames, ...from.aliasNames, from.name])].filter(
      (a) => a.toLowerCase() !== into.name.toLowerCase(),
    );
    await this.prisma.$transaction([
      this.prisma.trip.updateMany({ where: { pickupLandmarkId: id }, data: { pickupLandmarkId: intoId } }),
      this.prisma.trip.updateMany({ where: { dropLandmarkId: id }, data: { dropLandmarkId: intoId } }),
      this.prisma.landmark.update({ where: { id: intoId }, data: { aliasNames: aliases, source: "STAFF" } }),
      this.prisma.landmark.delete({ where: { id } }),
    ]);
    await this.audit(staffId, "LANDMARK_MERGED", "Landmark", id, from, { intoId, name: into.name });
    return { ok: true as const, intoId };
  }
}
