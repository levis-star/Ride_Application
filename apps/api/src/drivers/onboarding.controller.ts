import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { FastifyReply } from "fastify";
import { DriverDocumentUploadSchema, DriverRegisterSchema, Role } from "@rukwaride/shared";
import { AuthGuard, AuthedRequest, Roles } from "../auth/auth.guard";
import { OnboardingService } from "./onboarding.service";

/**
 * Driver self-onboarding endpoints. Registration is open to passengers (the
 * normal path: OTP login → register); everything else requires the DRIVER
 * role the registration response's fresh tokens carry.
 */
@Controller("drivers")
@UseGuards(AuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post("register")
  @Roles(Role.PASSENGER, Role.DRIVER) // DRIVER included so a re-register gets a clean 409, not 403
  async register(@Req() req: AuthedRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const dto = DriverRegisterSchema.parse(body);
    const result = await this.onboarding.register(req.user!.sub, dto);
    // Same cookie contract as /auth: web keeps refresh httpOnly, app reads body.
    reply.setCookie("rr_refresh", result.refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/auth",
      maxAge: 30 * 24 * 3600,
    });
    return result;
  }

  @Get("me/onboarding")
  @Roles(Role.DRIVER)
  status(@Req() req: AuthedRequest) {
    return this.onboarding.onboardingStatus(req.user!.sub);
  }

  @Post("me/documents")
  @Roles(Role.DRIVER)
  async upload(@Req() req: AuthedRequest, @Body() body: unknown) {
    const dto = DriverDocumentUploadSchema.parse(body);
    return this.onboarding.uploadDocument(req.user!.driverProfileId!, dto);
  }

  @Get("me/documents/:id/file")
  @Roles(Role.DRIVER)
  async file(@Req() req: AuthedRequest, @Param("id") id: string, @Res() reply: FastifyReply) {
    const file = await this.onboarding.ownDocumentFile(req.user!.driverProfileId!, id);
    // Never let an uploaded document render in our origin: nosniff stops the
    // browser second-guessing the type, attachment stops inline execution.
    void reply
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "attachment")
      .type(file.contentType)
      .send(file.data);
  }

  /**
   * Approved driver photo, viewable by any authenticated app user — LATRA
   * requires the rider to see the driver's photo. Only the approved photo is
   * exposed (no other documents).
   */
  @Get(":driverProfileId/photo")
  async photo(@Param("driverProfileId") driverProfileId: string, @Res() reply: FastifyReply) {
    const file = await this.onboarding.driverPhoto(driverProfileId);
    // No `attachment` here — this one is meant to be displayed to the rider —
    // but nosniff still stops the browser inferring a different type.
    void reply
      .header("cache-control", "private, max-age=300")
      .header("x-content-type-options", "nosniff")
      .type(file.contentType)
      .send(file.data);
  }
}
