import { Controller, Get, Header } from "@nestjs/common";
import { CetsAuthService } from "./cets-auth.service";

/**
 * Public discovery endpoints CeTS reads to verify our self-signed JWTs
 * (API document §1). Deliberately unauthenticated — publishing a *public* key
 * is the entire point, and CeTS calls these before it has any credential of
 * ours. No AuthGuard, same rationale as PublicController.
 *
 * The path is fixed by the spec:
 *   https://<our-domain>/.well-known/tz-e-ticketing-server  →  { "jwks_uri": … }
 */
@Controller(".well-known")
export class CetsDiscoveryController {
  constructor(private readonly auth: CetsAuthService) {}

  @Get("tz-e-ticketing-server")
  @Header("cache-control", "public, max-age=300")
  discovery() {
    return this.auth.discovery();
  }

  @Get("jwks.json")
  @Header("cache-control", "public, max-age=300")
  jwks() {
    return this.auth.jwks();
  }
}
