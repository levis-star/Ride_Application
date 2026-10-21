import { createHash, randomInt } from "node:crypto";
import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { Role } from "@rukwaride/shared";
import { appConfig } from "../config/app-config";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AccessClaims, TokenService } from "./jwt.service";

const E164 = /^\+[1-9]\d{6,14}$/;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly tokens: TokenService,
  ) {}

  private hashCode(code: string): string {
    return createHash("sha256").update(`${code}:${appConfig.otp.pepper}`).digest("hex");
  }

  /**
   * App-store review accounts (Google Play "App access"): allowlisted phones
   * log in with a FIXED code and never touch the SMS pipeline, so reviewers
   * can sign in while production runs with demo mode off. The phones must be
   * throwaway test numbers — never real users'.
   */
  private isReviewPhone(phone: string): boolean {
    return (
      appConfig.auth.reviewOtp.length >= 6 && appConfig.auth.reviewPhones.includes(phone)
    );
  }

  async requestOtp(phone: string): Promise<{ ok: true; demoCode?: string }> {
    if (!E164.test(phone)) throw new BadRequestException("Phone must be E.164 (+255…)");

    if (this.isReviewPhone(phone)) {
      await this.prisma.otpCode.create({
        data: {
          phone,
          codeHash: this.hashCode(appConfig.auth.reviewOtp),
          purpose: "LOGIN",
          expiresAt: new Date(Date.now() + appConfig.otp.ttlS * 1000),
        },
      });
      this.logger.log(`review-account OTP issued for ${phone.slice(0, 7)}…`);
      return { ok: true }; // reviewer has the code from the Play Console notes
    }
    // Resend limits (spec §10): 1/min and 5/day per phone. Relaxed in demo mode
    // so many testers can request codes freely.
    if (!appConfig.authDemoMode) {
      const recent = await this.prisma.otpCode.findFirst({
        where: { phone, createdAt: { gt: new Date(Date.now() - 60_000) } },
      });
      if (recent) throw new HttpException("Wait a minute before requesting another code", 429);
      const today = await this.prisma.otpCode.count({
        where: { phone, createdAt: { gt: new Date(Date.now() - 24 * 3600 * 1000) } },
      });
      if (today >= 5) throw new HttpException("Daily code limit reached — try again tomorrow", 429);
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.prisma.otpCode.create({
      data: {
        phone,
        codeHash: this.hashCode(code),
        purpose: "LOGIN",
        expiresAt: new Date(Date.now() + appConfig.otp.ttlS * 1000),
      },
    });

    if (appConfig.authDemoMode) {
      // No SMS account: surface the code to the caller so the login screen
      // can show/auto-fill it. Logged, not texted.
      this.logger.log(`DEMO OTP for ${phone}: ${code}`);
      return { ok: true, demoCode: code };
    }
    await this.notifications.sendSmsNow(phone, "auth.otp", { code });
    return { ok: true };
  }

  /** Staff (admin/dispatcher) sign-in: phone + Argon2id password (spec §14). */
  async staffLogin(
    phone: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string; role: Role; name: string }> {
    const argon2 = await import("argon2");
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (
      !user ||
      !user.passwordHash ||
      (user.role !== Role.ADMIN && user.role !== Role.DISPATCHER) ||
      user.isBlocked
    ) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!valid) throw new UnauthorizedException("Invalid credentials");
    const claims = { sub: user.id, role: user.role as Role };
    return {
      accessToken: this.tokens.sign(claims),
      refreshToken: this.tokens.signRefresh(claims),
      userId: user.id,
      role: user.role as Role,
      name: user.name,
    };
  }

  /**
   * Rotate a refresh token into a fresh access/refresh pair.
   *
   * Re-reads the user on every refresh. Access tokens are short-lived but the
   * refresh window is 30 days, so without this a blocked, deleted or
   * role-changed account kept working for a month: signature validity alone
   * says nothing about whether the account should still have access.
   *
   * Claims are rebuilt from the database rather than trusted from the token, so
   * a demotion (DRIVER → PASSENGER) or a driver-profile change takes effect at
   * the next refresh instead of persisting until the token finally expires.
   */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    let claims: AccessClaims;
    try {
      claims = this.tokens.verifyRefresh(refreshToken);
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      include: { driverProfile: { select: { id: true } } },
    });
    if (!user || user.deletedAt) throw new UnauthorizedException("Account no longer exists");
    if (user.isBlocked) throw new UnauthorizedException("Account is blocked");

    const fresh: AccessClaims = {
      sub: user.id,
      role: user.role as Role,
      driverProfileId: user.driverProfile?.id,
    };
    return {
      accessToken: this.tokens.sign(fresh),
      refreshToken: this.tokens.signRefresh(fresh), // rotate
    };
  }

  async verifyOtp(
    phone: string,
    code: string,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string; role: Role; name: string }> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { phone, purpose: "LOGIN", consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) throw new UnauthorizedException("No valid code — request a new one");
    if (otp.attempts >= appConfig.otp.maxAttempts) {
      throw new UnauthorizedException("Too many attempts — request a new code");
    }
    if (otp.codeHash !== this.hashCode(code)) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new UnauthorizedException("Wrong code");
    }
    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });

    // Passengers self-provision on first login; drivers/staff must pre-exist.
    let user = await this.prisma.user.findUnique({ where: { phone }, include: { driverProfile: true } });
    if (!user) {
      user = await this.prisma.user.create({
        data: { phone, name: "", role: Role.PASSENGER },
        include: { driverProfile: true },
      });
    }
    if (user.isBlocked) throw new UnauthorizedException("Account blocked — contact support");

    const claims = {
      sub: user.id,
      role: user.role as Role,
      driverProfileId: user.driverProfile?.id,
    };
    return {
      accessToken: this.tokens.sign(claims),
      refreshToken: this.tokens.signRefresh(claims),
      userId: user.id,
      role: user.role as Role,
      name: user.name,
    };
  }
}
