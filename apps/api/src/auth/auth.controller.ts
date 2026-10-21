import { Body, Controller, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthService } from "./auth.service";
import { RateLimit, RateLimitGuard } from "./rate-limit.guard";

const RequestOtpSchema = z.object({ phone: z.string() });
const VerifyOtpSchema = z.object({ phone: z.string(), code: z.string().length(6) });
const RefreshSchema = z.object({ refreshToken: z.string().optional() });
const StaffLoginSchema = z.object({ phone: z.string(), password: z.string().min(8) });

const REFRESH_COOKIE = "rr_refresh";

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/auth",
    maxAge: 30 * 24 * 3600,
  });
}

@Controller("auth")
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("otp/request")
  @RateLimit({ points: 5, windowS: 300, scope: "ip", name: "otp-request-ip" })
  requestOtp(@Body() body: unknown) {
    const { phone } = RequestOtpSchema.parse(body);
    return this.auth.requestOtp(phone);
  }

  @Post("otp/verify")
  @RateLimit({ points: 10, windowS: 900, scope: "phone", name: "otp-verify" })
  async verifyOtp(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { phone, code } = VerifyOtpSchema.parse(body);
    const result = await this.auth.verifyOtp(phone, code);
    // Web keeps the refresh token in an httpOnly cookie; the driver app reads
    // it from the body into SecureStore (spec §4).
    setRefreshCookie(reply, result.refreshToken);
    return result;
  }

  @Post("staff/login")
  @RateLimit({ points: 5, windowS: 900, scope: "ip", name: "staff-login" })
  async staffLogin(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { phone, password } = StaffLoginSchema.parse(body);
    const result = await this.auth.staffLogin(phone, password);
    setRefreshCookie(reply, result.refreshToken);
    return result;
  }

  @Post("refresh")
  async refresh(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { refreshToken } = RefreshSchema.parse(body ?? {});
    const token = refreshToken ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined);
    if (!token) throw new UnauthorizedException("No refresh token");
    const result = await this.auth.refresh(token);
    setRefreshCookie(reply, result.refreshToken);
    return result;
  }
}
