import { Injectable } from "@nestjs/common";
import { JwtService as NestJwtService } from "@nestjs/jwt";
import { createHash, createPublicKey } from "node:crypto";
import { appConfig } from "../config/app-config";

/**
 * Authentication for the LATRA Core e-Ticketing System (CeTS), per
 * "LATRA-Core e-Ticketing System with Ride Hailing System — API DOCUMENT" §1:
 *
 *   "The core e-Ticketing System and the Ride Hailing system shall authenticate
 *    each other using self-signed JWT [RFC7519] access tokens. Each entity's
 *    signing key will be published at their respective discovery endpoints."
 *
 * So we sign our own RS256 token (iss = sub = our CeTS-registered domain) and
 * CeTS pulls our public key from the discovery endpoint we host. This is NOT
 * OAuth2 — there is no token endpoint and no client secret.
 *
 * The signing key is the API's existing RS256 keypair; `kid` is a stable
 * thumbprint of the public key so the published JWKS and the token agree.
 */
@Injectable()
export class CetsAuthService {
  private readonly jwt = new NestJwtService();
  private cached?: { token: string; expiresAt: number };

  /**
   * The CeTS keypair. Dedicated when configured; falls back to the auth keypair
   * so local/dev works out of the box. `assertProdSecurity()` blocks that
   * fallback in production, because the public half of this key is published
   * to the internet and must not be the one protecting user sessions.
   */
  private get keys(): { privateKey: string; publicKey: string; dedicated: boolean } {
    const { privateKey, publicKey } = appConfig.latra.cets;
    if (privateKey && publicKey) return { privateKey, publicKey, dedicated: true };
    return { privateKey: appConfig.jwt.privateKey, publicKey: appConfig.jwt.publicKey, dedicated: false };
  }

  /** Stable key id: SHA-256 of the DER public key, first 16 hex chars. */
  get kid(): string {
    const der = createPublicKey(this.keys.publicKey).export({ type: "spki", format: "der" });
    return createHash("sha256").update(der).digest("hex").slice(0, 16);
  }

  /**
   * The JWKS document CeTS fetches. `createPublicKey().export({format:"jwk"})`
   * gives n/e/kty; we add the signing metadata CeTS needs to select the key.
   * Public key material only — never the private half.
   */
  jwks(): { keys: Array<Record<string, unknown>> } {
    const jwk = createPublicKey(this.keys.publicKey).export({ format: "jwk" });
    return { keys: [{ ...jwk, kid: this.kid, alg: "RS256", use: "sig" }] };
  }

  /** Discovery document at /.well-known/tz-e-ticketing-server. */
  discovery(): { jwks_uri: string } {
    return { jwks_uri: `${appConfig.latra.cets.publicBaseUrl}/.well-known/jwks.json` };
  }

  /**
   * A self-signed access token for CeTS calls. Cached until shortly before
   * expiry — the token is stateless, so re-minting per request is pure waste.
   */
  token(): string {
    if (this.cached && this.cached.expiresAt > Date.now() + 30_000) return this.cached.token;
    const cets = appConfig.latra.cets;
    const ttlS = cets.tokenTtlS;
    const token = this.jwt.sign(
      {},
      {
        privateKey: this.keys.privateKey,
        algorithm: "RS256",
        keyid: this.kid,
        // iss and sub are both our domain as registered with CeTS (spec §1).
        issuer: cets.issuer,
        subject: cets.issuer,
        ...(cets.audience ? { audience: cets.audience } : {}),
        expiresIn: ttlS,
      },
    );
    this.cached = { token, expiresAt: Date.now() + ttlS * 1000 };
    return token;
  }
}
