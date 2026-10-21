import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { FastifyReply } from "fastify";
import {
  LandmarkCreateSchema,
  LandmarkMergeSchema,
  LandmarkUpdateSchema,
  Role,
  VehicleClassSchema,
} from "@rukwaride/shared";
import { z } from "zod";
import { AuthGuard, AuthedRequest, Roles } from "../auth/auth.guard";
import { AdminService } from "./admin.service";
import { LatraService } from "../latra/latra.service";
import { DriversService } from "../drivers/drivers.service";
import { OnboardingService } from "../drivers/onboarding.service";

const ReviewSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().max(300).optional(),
});
const BlockSchema = z.object({ blocked: z.boolean() });
const ConsentSchema = z.object({ consent: z.boolean() });
const WalletAdjustSchema = z.object({
  amount: z.number().int().refine((v) => v !== 0, "amount must be non-zero"),
  memo: z.string().min(3).max(300),
});
const FareConfigSchema = z.object({
  vehicleClass: VehicleClassSchema,
  baseFare: z.number().int().nonnegative(),
  perKm: z.number().int().nonnegative(),
  perMin: z.number().int().nonnegative(),
  bookingFeePct: z.number().nonnegative(),
  minimumFare: z.number().int().nonnegative(),
  commissionPct: z.number().nonnegative(),
  latraOrderRef: z.string().min(3).max(200),
});
const VerifyVehicleSchema = z.object({
  override: z.object({ justification: z.string().min(10).max(500) }).optional(),
});
const TicketUpdateSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
  assignedToId: z.string().optional(),
  resolutionNote: z.string().max(1000).optional(),
});

@Controller("admin")
@UseGuards(AuthGuard)
@Roles(Role.ADMIN)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly latra: LatraService,
    private readonly driversService: DriversService,
    private readonly onboarding: OnboardingService,
  ) {}

  @Get("dashboard")
  dashboard() {
    return this.admin.dashboard();
  }

  /** Fleet registration + live availability by vehicle class. */
  @Get("fleet")
  fleet() {
    return this.driversService.fleetCounts();
  }

  @Get("documents")
  documents(@Query("status") status?: string) {
    return this.admin.listDocuments(status as never);
  }

  /** Uploaded document bytes for the review queue (image/pdf preview). */
  @Get("documents/:id/file")
  async documentFile(@Param("id") id: string, @Res() reply: FastifyReply) {
    const file = await this.onboarding.documentFile(id);
    // Driver-supplied bytes rendered to a staff reviewer: nosniff + attachment
    // so a mislabelled file can never execute in the admin origin.
    void reply
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "attachment")
      .type(file.contentType)
      .send(file.data);
  }

  @Post("documents/:id/review")
  review(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const dto = ReviewSchema.parse(body);
    return this.admin.reviewDocument(req.user!.sub, id, dto.decision, dto.rejectionReason);
  }

  @Get("drivers")
  drivers(@Query("q") q?: string) {
    return this.admin.listDrivers(q);
  }

  @Post("drivers/:id/approve")
  approveDriver(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.admin.approveDriver(req.user!.sub, id);
  }

  @Post("drivers/:id/consent")
  consent(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const dto = ConsentSchema.parse(body);
    return this.admin.setDriverConsent(req.user!.sub, id, dto.consent);
  }

  @Post("drivers/:id/wallet-adjust")
  walletAdjust(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const dto = WalletAdjustSchema.parse(body);
    return this.admin.adjustWallet(req.user!.sub, id, dto.amount, dto.memo);
  }

  @Post("users/:id/block")
  block(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const dto = BlockSchema.parse(body);
    return this.admin.setUserBlocked(req.user!.sub, id, dto.blocked);
  }

  @Post("vehicles/:id/verify")
  verifyVehicle(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const dto = VerifyVehicleSchema.parse(body ?? {});
    return this.latra.verifyVehicle(id, req.user!.sub, dto.override);
  }

  @Get("fares")
  fares() {
    return this.admin.getFares();
  }

  @Post("fares")
  saveFare(@Req() req: AuthedRequest, @Body() body: unknown) {
    const dto = FareConfigSchema.parse(body);
    return this.admin.saveFareConfig(req.user!.sub, { ...dto, currency: "TZS" });
  }

  @Get("ledger")
  ledger(
    @Query("account") account?: string,
    @Query("driverId") driverId?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.admin.browseLedger({
      account,
      driverId,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get("audit")
  audit(@Query("entity") entity?: string, @Query("skip") skip?: string, @Query("take") take?: string) {
    return this.admin.listAudit({
      entity,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get("latra-reports")
  latraReports(@Query("status") status?: string) {
    return this.admin.listLatraReports(status);
  }

  @Post("latra-reports/:id/retry")
  retryLatra(@Param("id") id: string) {
    return this.latra.retryReport(id);
  }

  /**
   * Re-submit the CeTS daily operational summary (§6). The nightly job covers
   * this; the manual trigger exists for the day a submission failed, and takes
   * an optional `date` (YYYY-MM-DD, EAT). Defaults to yesterday.
   */
  @Post("latra-daily-report")
  latraDailyReport(@Body() body: unknown) {
    const dto = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(body ?? {});
    return this.latra.submitDailyReport(dto.date ? new Date(`${dto.date}T12:00:00Z`) : undefined);
  }

  /** Which days have actually been filed with LATRA, and which failed. */
  @Get("latra-daily-reports")
  latraDailyReports() {
    return this.latra.listDailyReports();
  }

  /** Drivers/vehicles CeTS has not accepted — their trips cannot be reported. */
  @Get("latra-registration-issues")
  cetsRegistrationIssues() {
    return this.admin.cetsRegistrationIssues();
  }

  @Post("latra-register-driver/:id")
  retryDriverRegistration(@Param("id") id: string) {
    return this.latra.registerDriver(id, true);
  }

  @Post("latra-register-vehicle/:id")
  retryVehicleRegistration(@Param("id") id: string) {
    return this.latra.registerVehicle(id, true);
  }

  // ---------- landmark curation ----------

  @Get("landmarks")
  landmarks(@Query("q") q?: string, @Query("unverified") unverified?: string) {
    return this.admin.listLandmarks({ q, unverifiedOnly: unverified === "true" });
  }

  /** Same-name clusters — the fastest way to spot OSM's duplicate imports. */
  @Get("landmarks/duplicates")
  landmarkDuplicates() {
    return this.admin.landmarkDuplicates();
  }

  @Post("landmarks")
  createLandmark(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.admin.createLandmark(req.user!.sub, LandmarkCreateSchema.parse(body));
  }

  @Patch("landmarks/:id")
  updateLandmark(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.admin.updateLandmark(req.user!.sub, id, LandmarkUpdateSchema.parse(body));
  }

  @Post("landmarks/:id/merge")
  mergeLandmark(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.admin.mergeLandmark(req.user!.sub, id, LandmarkMergeSchema.parse(body).intoId);
  }

  @Delete("landmarks/:id")
  deleteLandmark(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.admin.deleteLandmark(req.user!.sub, id);
  }

  @Get("tickets")
  tickets(@Query("status") status?: string) {
    return this.admin.listTickets(status);
  }

  @Post("tickets/:id")
  updateTicket(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const dto = TicketUpdateSchema.parse(body);
    return this.admin.updateTicket(req.user!.sub, id, dto);
  }
}
