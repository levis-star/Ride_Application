import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { DriverDocumentUploadDto, DriverRegisterDto, Role } from "@rukwaride/shared";
import { appConfig } from "../config/app-config";
import { TokenService } from "../auth/jwt.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService, StoredFile, magicBytesMatch } from "../storage/storage.service";

/**
 * Driver self-onboarding (spec §12/§13): an OTP-authenticated user registers
 * as a driver (pending), uploads documents into the admin review queue, and
 * goes online only after admin approval — the approval/verification side
 * already lives in AdminService/LatraService.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly storage: StorageService,
  ) {}

  async register(userId: string, dto: DriverRegisterDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { driverProfile: true },
    });
    if (!user) throw new NotFoundException("User not found");
    if (user.role === "ADMIN" || user.role === "DISPATCHER") {
      throw new ForbiddenException("Staff accounts cannot register as drivers");
    }
    if (user.driverProfile) throw new ConflictException("Already registered as a driver");

    const plateNumber = dto.plateNumber.toUpperCase().replace(/\s+/g, " ").trim();
    try {
      const profile = await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { role: "DRIVER", name: dto.name, email: dto.email },
        });
        const created = await tx.driverProfile.create({
          data: {
            userId,
            licenseNumber: dto.licenseNumber,
            licenceCategory: dto.licenceCategory,
            vehicles: {
              create: {
                class: dto.vehicleClass,
                plateNumber,
                make: dto.make,
                model: dto.model,
                color: dto.color,
                chassisNumber: dto.chassisNumber,
                // CeTS submitVehicle requires a registration date; the date the
                // operator registered it here is exactly what it asks for.
                registrationDate: new Date(),
              },
            },
          },
          include: { vehicles: true },
        });
        return tx.driverProfile.update({
          where: { id: created.id },
          data: { currentVehicleId: created.vehicles[0]!.id },
          include: { currentVehicle: true },
        });
      });

      this.logger.log(`driver registered: profile ${profile.id} (${dto.vehicleClass} ${plateNumber})`);
      // Old tokens are PASSENGER-scoped — issue fresh ones with the new role.
      const claims = { sub: userId, role: Role.DRIVER, driverProfileId: profile.id };
      return {
        accessToken: this.tokens.sign(claims),
        refreshToken: this.tokens.signRefresh(claims),
        driverProfileId: profile.id,
        approvedAt: profile.approvedAt,
        vehicle: {
          plateNumber: profile.currentVehicle!.plateNumber,
          class: profile.currentVehicle!.class,
        },
      };
    } catch (e) {
      // P2002 = unique violation (plate or concurrent double-register).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("Plate number already registered");
      }
      throw e;
    }
  }

  async uploadDocument(driverProfileId: string, dto: DriverDocumentUploadDto) {
    const data = Buffer.from(dto.data, "base64");
    if (data.length === 0) throw new BadRequestException("Empty file");
    // The declared content type is attacker-controlled: a driver could label
    // an HTML or SVG payload "image/jpeg" and have staff open it from the
    // review queue. Verify the bytes actually match the claim.
    if (!magicBytesMatch(data, dto.contentType)) {
      throw new BadRequestException("File content does not match its declared type");
    }
    const ext = StorageService.extensionFor(dto.contentType)!;
    const key = `driver-docs/${driverProfileId}/${dto.type}-${Date.now()}.${ext}`;
    await this.storage.put(key, data);
    const doc = await this.prisma.driverDocument.create({
      data: {
        driverId: driverProfileId,
        type: dto.type,
        fileUrl: key,
        expiresAt: dto.expiresAt,
      },
    });
    return { id: doc.id, type: doc.type, status: doc.status, createdAt: doc.createdAt };
  }

  /**
   * Checklist consumed by the driver app + web onboarding page. Mirrors the
   * exact go-online gate in DriversService.setStatus so the UI never lies.
   */
  async onboardingStatus(userId: string) {
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId },
      include: { currentVehicle: true, documents: { orderBy: { createdAt: "desc" } } },
    });
    if (!profile) throw new NotFoundException("No driver profile");

    // Latest upload per type is the one that counts (re-uploads supersede).
    const latestByType = new Map<string, (typeof profile.documents)[number]>();
    for (const d of profile.documents) {
      if (!latestByType.has(d.type)) latestByType.set(d.type, d);
    }
    const documents = [...latestByType.values()].map((d) => ({
      id: d.id,
      type: d.type,
      status: d.status,
      rejectionReason: d.rejectionReason,
      createdAt: d.createdAt,
    }));
    const required = appConfig.onboarding.requiredDocs;
    const missingDocuments = required.filter((t) => {
      const latest = latestByType.get(t);
      return !latest || latest.status === "REJECTED" || latest.status === "EXPIRED";
    });

    const walletOk = Number(profile.walletBalance) >= Number(profile.negativeBalanceLimit);
    return {
      approvedAt: profile.approvedAt,
      status: profile.status,
      requiredDocuments: required,
      documents,
      missingDocuments,
      documentsApproved: required.every((t) => latestByType.get(t)?.status === "APPROVED"),
      vehicle: profile.currentVehicle
        ? {
            plateNumber: profile.currentVehicle.plateNumber,
            class: profile.currentVehicle.class,
            latraVerified: profile.currentVehicle.latraVerified,
          }
        : null,
      wallet: {
        balance: Number(profile.walletBalance),
        limit: Number(profile.negativeBalanceLimit),
        ok: walletOk,
      },
      // Same gate as setStatus(AVAILABLE) — approval + active vehicle + wallet.
      canGoOnline: Boolean(profile.approvedAt && profile.currentVehicle?.active && walletOk),
    };
  }

  /** Driver's own document bytes (scoped by ownership — 404 for others'). */
  async ownDocumentFile(driverProfileId: string, documentId: string): Promise<StoredFile> {
    const doc = await this.prisma.driverDocument.findFirst({
      where: { id: documentId, driverId: driverProfileId },
    });
    if (!doc) throw new NotFoundException("Document not found");
    const file = await this.storage.get(doc.fileUrl);
    if (!file) throw new NotFoundException("Stored file missing");
    return file;
  }

  /** Admin review: any document's bytes. */
  async documentFile(documentId: string): Promise<StoredFile> {
    const doc = await this.prisma.driverDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException("Document not found");
    const file = await this.storage.get(doc.fileUrl);
    if (!file) throw new NotFoundException("Stored file missing");
    return file;
  }

  /** Approved driver photo (shown to riders per LATRA). */
  async driverPhoto(driverProfileId: string): Promise<StoredFile> {
    const profile = await this.prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
    if (!profile?.photoKey) throw new NotFoundException("No driver photo");
    const file = await this.storage.get(profile.photoKey);
    if (!file) throw new NotFoundException("Stored file missing");
    return file;
  }
}
