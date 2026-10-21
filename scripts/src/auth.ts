import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { Role } from "@rukwaride/shared";

const REPO_ROOT = resolve(__dirname, "..", "..");

export function devPrivateKey(): string {
  const path =
    process.env.JWT_PRIVATE_KEY_PATH ?? resolve(REPO_ROOT, "infra/keys/dev-jwt-private.pem");
  return readFileSync(path, "utf8");
}

export interface TokenClaims {
  sub: string; // userId
  role: Role;
  driverProfileId?: string;
}

/**
 * Mints an RS256 access token with the dev signing key — same claims shape the
 * API's AuthModule issues. Simulator-only: real clients go through phone OTP.
 */
export function mintToken(claims: TokenClaims, ttlS = 3600): string {
  return jwt.sign(
    { role: claims.role, driverProfileId: claims.driverProfileId },
    devPrivateKey(),
    {
      algorithm: "RS256",
      subject: claims.sub,
      expiresIn: ttlS,
      issuer: "rukwaride-api",
      audience: "rukwaride",
    },
  );
}

/** A refresh token (carries `typ: "refresh"`, which the API checks). */
export function mintRefreshToken(claims: TokenClaims, ttlS = 30 * 24 * 3600): string {
  return jwt.sign(
    { role: claims.role, driverProfileId: claims.driverProfileId, typ: "refresh" },
    devPrivateKey(),
    {
      algorithm: "RS256",
      subject: claims.sub,
      expiresIn: ttlS,
      issuer: "rukwaride-api",
      audience: "rukwaride",
    },
  );
}
