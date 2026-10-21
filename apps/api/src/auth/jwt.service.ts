import { Injectable } from "@nestjs/common";
import { JwtService as NestJwtService } from "@nestjs/jwt";
import { Role } from "@rukwaride/shared";
import { appConfig } from "../config/app-config";

export interface AccessClaims {
  sub: string; // userId
  role: Role;
  driverProfileId?: string;
}

@Injectable()
export class TokenService {
  private readonly jwt = new NestJwtService();

  sign(claims: AccessClaims): string {
    const { sub, ...rest } = claims;
    return this.jwt.sign(rest, {
      privateKey: appConfig.jwt.privateKey,
      algorithm: "RS256",
      subject: sub,
      expiresIn: appConfig.jwt.accessTtlS,
      issuer: appConfig.jwt.issuer,
      audience: appConfig.jwt.audience,
    });
  }

  verify(token: string): AccessClaims {
    const payload = this.jwt.verify<Record<string, unknown>>(token, {
      publicKey: appConfig.jwt.publicKey,
      algorithms: ["RS256"],
      issuer: appConfig.jwt.issuer,
      audience: appConfig.jwt.audience,
    });
    if (payload.typ === "refresh") throw new Error("refresh token used as access token");
    return {
      sub: payload.sub as string,
      role: payload.role as Role,
      driverProfileId: payload.driverProfileId as string | undefined,
    };
  }

  /**
   * Stateless rotating refresh token (30 d). Web keeps it in an httpOnly
   * cookie; the driver app in SecureStore (spec §4).
   */
  signRefresh(claims: AccessClaims): string {
    const { sub, ...rest } = claims;
    return this.jwt.sign(
      { ...rest, typ: "refresh" },
      {
        privateKey: appConfig.jwt.privateKey,
        algorithm: "RS256",
        subject: sub,
        expiresIn: "30d",
        issuer: appConfig.jwt.issuer,
        audience: appConfig.jwt.audience,
      },
    );
  }

  verifyRefresh(token: string): AccessClaims {
    const payload = this.jwt.verify<Record<string, unknown>>(token, {
      publicKey: appConfig.jwt.publicKey,
      algorithms: ["RS256"],
      issuer: appConfig.jwt.issuer,
      audience: appConfig.jwt.audience,
    });
    if (payload.typ !== "refresh") throw new Error("not a refresh token");
    return {
      sub: payload.sub as string,
      role: payload.role as Role,
      driverProfileId: payload.driverProfileId as string | undefined,
    };
  }
}
