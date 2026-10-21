import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * SHA-256 of the SPKI/DER form of the dev JWT public key committed at
 * `infra/keys/dev-jwt-public.pem`. Shipping that keypair to production would
 * let anyone holding the (public) repo forge access tokens, and "remember to
 * rotate the keys" is not a control — so the boot guard refuses to start in
 * production while this exact key is in use. Regenerate the constant if the
 * committed dev key is ever rotated:
 *   openssl pkey -pubin -in infra/keys/dev-jwt-public.pem -outform DER | sha256sum
 */
const DEV_JWT_PUBLIC_FINGERPRINT = "37bb694cc133e2ef5cd6c5f8f3328913b7a3183adb02ede27ff052de09531908";

function publicKeyFingerprint(pem: string): string | null {
  try {
    const der = createPublicKey(pem).export({ type: "spki", format: "der" });
    return createHash("sha256").update(der).digest("hex");
  } catch {
    return null; // malformed key surfaces elsewhere; don't crash the guard here
  }
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined ? fallback : Number.parseInt(v, 10);
}

/** Parse a JSON-object env var; falls back (rather than crashing boot) if unset
 *  or malformed, since these are optional integration overrides. */
function jsonEnv<T>(name: string, fallback: T): T {
  const v = process.env[name];
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    throw new Error(`Env var ${name} must be valid JSON`);
  }
}

function pem(inlineVar: string, pathVar: string): string {
  const inline = process.env[inlineVar];
  if (inline && inline.includes("BEGIN")) return inline.replace(/\\n/g, "\n");
  const path = process.env[pathVar];
  if (!path) throw new Error(`Set ${inlineVar} (PEM) or ${pathVar} (file path)`);
  return readFileSync(path, "utf8");
}

/** Like `pem`, but returns undefined instead of throwing when unset. */
function optionalPem(inlineVar: string, pathVar: string): string | undefined {
  const inline = process.env[inlineVar];
  if (inline && inline.includes("BEGIN")) return inline.replace(/\\n/g, "\n");
  const path = process.env[pathVar];
  return path ? readFileSync(path, "utf8") : undefined;
}

export const appConfig = {
  port: intEnv("API_PORT", 3001),
  // Public origin for building share links (same-origin behind Caddy in demo).
  appBaseUrl: env("APP_BASE_URL", "http://localhost:3000"),
  databaseUrl: env("DATABASE_URL"),
  redisUrl: env("REDIS_URL", "redis://localhost:6380"),
  jwt: {
    privateKey: pem("JWT_PRIVATE_KEY", "JWT_PRIVATE_KEY_PATH"),
    publicKey: pem("JWT_PUBLIC_KEY", "JWT_PUBLIC_KEY_PATH"),
    accessTtlS: intEnv("JWT_ACCESS_TTL_S", 900),
    issuer: "rukwaride-api",
    audience: "rukwaride",
  },
  otp: {
    pepper: env("OTP_PEPPER", "dev-otp-pepper-change-me"),
    ttlS: 300,
    maxAttempts: 5,
  },
  /**
   * Demo mode (no SMS account): the OTP code is returned in the request
   * response so testers can log in with any phone. NEVER enable in production.
   */
  authDemoMode: process.env.AUTH_DEMO_MODE === "true",
  osrmUrl: process.env.OSRM_URL || undefined,
  /**
   * Namespace for BullMQ keys and the Socket.io Redis adapter. Instances that
   * must NOT cooperate (e.g. an integration-test API next to a dev API on the
   * same Redis) set distinct values; replicas that SHOULD share work keep the
   * default.
   */
  queuePrefix: process.env.QUEUE_PREFIX ?? "bull",
  socketAdapterKey: process.env.SOCKET_ADAPTER_KEY ?? "socket.io",
  dispatch: {
    offerTtlS: intEnv("DISPATCH_OFFER_TTL_S", 25),
    lockTtlS: intEnv("DISPATCH_LOCK_TTL_S", 30),
    maxCandidates: intEnv("DISPATCH_MAX_CANDIDATES", 5),
    maxSearchS: intEnv("DISPATCH_MAX_SEARCH_S", 90),
    radiiKm: (process.env.DISPATCH_RADII_KM ?? "1,3,7").split(",").map(Number),
    /** re-poll interval when no candidate is found, ms */
    searchRetryMs: intEnv("DISPATCH_SEARCH_RETRY_MS", 5000),
    /** scheduled rides promote this many seconds BEFORE the booked time */
    scheduleLeadS: intEnv("SCHEDULE_LEAD_S", 30),
  },
  location: {
    staleExcludeS: intEnv("LOCATION_STALE_EXCLUDE_S", 30),
    offlineS: intEnv("LOCATION_OFFLINE_S", 120),
    flushIntervalMs: intEnv("LOCATION_FLUSH_INTERVAL_MS", 10_000),
  },
  onboarding: {
    /** Document types a driver must have approved (spec §12; tune per LATRA). */
    requiredDocs: env("REQUIRED_DRIVER_DOCS", "NATIONAL_ID,DRIVING_LICENSE,VEHICLE_PHOTO").split(","),
  },
  latra: {
    /** Delay before submitting a trip report, so a post-trip rating is captured. */
    reportDelayS: intEnv("LATRA_REPORT_DELAY_S", 10),
    /**
     * Wire field-name overrides for the Stage-2 trip-report dataset, as
     * {"canonicalKey":"latraWireKey"} JSON. LATRA's public page documents the
     * 11 items and their formats but not literal JSON keys — those arrive with
     * the integration credentials. Defaults are the faithful 1:1 camelCase
     * rendering of LATRA's list; if their spec uses different keys (e.g.
     * snake_case), set this env and NO code changes are needed.
     * Example: LATRA_FIELD_MAP={"tripId":"trip_id","driverEarning":"driver_earning"}
     */
    fieldMap: jsonEnv<Record<string, string>>("LATRA_FIELD_MAP", {}),
    /** LATRA Core e-Ticketing System (CeTS) integration — see docs/LATRA 1.pdf. */
    cets: {
      /** Base URL of CeTS. The API document gives http://41.59.57.164:8080 for
       *  the integration host; confirm the production host + TLS with LATRA. */
      baseUrl: env("LATRA_CETS_BASE_URL", "http://41.59.57.164:8080"),
      /** Our domain as registered with CeTS — used as both `iss` and `sub`. */
      issuer: env("LATRA_CETS_ISSUER", "http://localhost:3001"),
      /** Optional `aud` claim. CeTS validates audience but the document does
       *  not state the expected value — confirm at System Integration. */
      audience: env("LATRA_CETS_AUDIENCE", ""),
      /** Public origin where CeTS reaches our discovery + JWKS endpoints. */
      publicBaseUrl: env("LATRA_CETS_PUBLIC_BASE_URL", env("APP_BASE_URL", "http://localhost:3000")),
      tokenTtlS: intEnv("LATRA_CETS_TOKEN_TTL_S", 300),
      /**
       * Coordinate order for origin/endCoordinates. The API document
       * contradicts itself: the field description says "Longtude and latitude
       * separated by comma", but the worked example "-6.83876250,39.2438527"
       * is Dar es Salaam as LATITUDE,LONGITUDE. Default follows the example;
       * flip to "lng,lat" if LATRA confirms the prose instead. In Sumbawanga
       * (lat -7.9, lng 31.6) a wrong order is not survivable, so this MUST be
       * confirmed before the first live submission.
       */
      coordOrder: env("LATRA_CETS_COORD_ORDER", "lat,lng"),
      /**
       * Dedicated signing keypair for CeTS. Its PUBLIC half is published to the
       * internet at /.well-known/jwks.json for LATRA to fetch, so it must NOT
       * be the keypair that signs user sessions: publishing one key for a third
       * party while it also protects user sessions couples key rotation across
       * two unrelated trust domains (rotating for LATRA would log out every
       * user, and vice versa).
       *
       * Falls back to the auth keypair when unset so local/dev keeps working —
       * but `assertProdSecurity()` refuses to boot production without it.
       */
      privateKey: optionalPem("LATRA_CETS_PRIVATE_KEY", "LATRA_CETS_PRIVATE_KEY_PATH"),
      publicKey: optionalPem("LATRA_CETS_PUBLIC_KEY", "LATRA_CETS_PUBLIC_KEY_PATH"),
    },
  },
  auth: {
    /** App-store review accounts: allowlisted phones + a fixed OTP (≥6 chars)
     *  so store reviewers can log in with SMS off and demo mode off. */
    reviewPhones: env("AUTH_REVIEW_PHONES", "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    reviewOtp: env("AUTH_REVIEW_OTP", ""),
  },
  cancellationFeeFlat: intEnv("CANCELLATION_FEE_FLAT", 500),
  /** Bearer token the Prometheus scraper must present. Empty = open (dev only). */
  metricsToken: env("METRICS_TOKEN", ""),
  /**
   * How long a share-my-trip link keeps working after the trip ends (default
   * 2 h). Long enough that whoever was following the ride can confirm arrival;
   * short enough that the link is not a permanent record of where someone went.
   */
  shareLinkGraceS: intEnv("SHARE_LINK_GRACE_S", 7200),
  /** Origins allowed to open a Socket.IO connection; defaults to WEB_ORIGINS. */
  webOrigins: env("WEB_ORIGINS", "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  payment: {
    provider: process.env.PAYMENT_PROVIDER ?? "mock",
    apiUrl: process.env.PAYMENT_API_URL ?? "",
    apiKey: process.env.PAYMENT_API_KEY ?? "",
    apiSecret: process.env.PAYMENT_API_SECRET ?? "",
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || "dev-webhook-secret-change-me",
    /** Mobile-money trip collection: convert to CASH after this (spec §9: 120 s). */
    timeoutS: intEnv("PAYMENT_TIMEOUT_S", 120),
    minTopUp: intEnv("PAYMENT_MIN_TOPUP", 1000),
  },
} as const;

export type AppConfig = typeof appConfig;

/**
 * Refuse to start production with a development-only fallback still active.
 *
 * Several settings deliberately degrade to something permissive so local dev
 * and the demo work with no configuration. Each of those is a real
 * vulnerability if it reaches production, and "remember to set it" is not a
 * control — so this turns the launch checklist into something the process
 * enforces. Called from main.ts when NODE_ENV=production.
 */
export function assertProdSecurity(): void {
  if (process.env.NODE_ENV !== "production") return;
  const problems: string[] = [];

  if (process.env.AUTH_DEMO_MODE === "true") {
    problems.push("AUTH_DEMO_MODE=true returns the OTP in the API response — anyone can log in as anyone");
  }
  if (!appConfig.metricsToken) {
    problems.push("METRICS_TOKEN is unset — /metrics would be world-readable");
  }
  if (appConfig.payment.webhookSecret === "dev-webhook-secret-change-me") {
    problems.push("PAYMENT_WEBHOOK_SECRET is still the development default — webhooks could be forged");
  }
  if (!process.env.OTP_PEPPER || process.env.OTP_PEPPER === "dev-otp-pepper-change-me") {
    problems.push("OTP_PEPPER is unset or the development default — OTP hashes would be unpeppered/guessable");
  }
  if (publicKeyFingerprint(appConfig.jwt.publicKey) === DEV_JWT_PUBLIC_FINGERPRINT) {
    problems.push(
      "JWT keypair is the committed dev key (infra/keys/dev-jwt-*.pem) — anyone with the repo could forge tokens; " +
        "generate a fresh keypair and set JWT_PRIVATE_KEY/JWT_PUBLIC_KEY",
    );
  }
  if (appConfig.webOrigins.some((o) => o.startsWith("http://") && !o.includes("localhost"))) {
    problems.push("WEB_ORIGINS contains a non-TLS origin");
  }
  if (process.env.LATRA_CLIENT === "real") {
    if (!appConfig.latra.cets.privateKey || !appConfig.latra.cets.publicKey) {
      problems.push(
        "LATRA_CETS_PRIVATE_KEY/_PUBLIC_KEY unset — CeTS would be signed with the user-auth key, " +
          "whose public half is published at /.well-known/jwks.json",
      );
    }
    if (appConfig.latra.cets.publicBaseUrl.startsWith("http://")) {
      problems.push("LATRA_CETS_PUBLIC_BASE_URL is not https — LATRA could not fetch our JWKS securely");
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production with insecure configuration:\n  - ${problems.join("\n  - ")}\n` +
        `See docs/security-assessment.md (M-4).`,
    );
  }
}
