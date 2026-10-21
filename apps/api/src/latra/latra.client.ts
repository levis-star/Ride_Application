import { Injectable, Logger } from "@nestjs/common";
import { appConfig } from "../config/app-config";
import { CetsAuthService } from "./cets-auth.service";

/**
 * LATRA Core e-Ticketing System (CeTS) client, implementing
 * "LATRA-Core e-Ticketing System with Ride Hailing System — API DOCUMENT"
 * (docs/LATRA 1.pdf); gaps tracked in docs/latra-cets-api-gap-analysis.md.
 *
 * Four endpoints, all POST, all returning the same envelope:
 *   { status, trxnId, statusCode, message, data }
 * with statusCode 5000 = success and 5001 = failure. The failure comes back
 * inside an HTTP 200 — checking the HTTP status alone silently accepts
 * rejections, which is the bug this client replaces.
 *
 * Ordering constraint (§3/§4): a trip may only reference a driver and vehicle
 * CeTS has already accepted via submitDriver / submitVehicle.
 */
export interface VehicleVerification {
  verified: boolean;
  detail?: string;
}

export interface TripSubmissionResult {
  /** Acknowledgement id for the existing outbox. */
  ackId: string;
  /** CeTS's official confirmation that the trip was recorded. */
  latraReferenceNumber?: string;
}

export interface LatraClient {
  readonly name: string;
  /** Local admin feature; not part of the CeTS API document. */
  verifyVehicle(plateNumber: string, latraLicenseNumber: string): Promise<VehicleVerification>;
  /** §3 — register a vehicle. Prerequisite for referencing it in a trip. */
  submitVehicle(payload: Record<string, unknown>): Promise<void>;
  /** §4 — register a driver. Prerequisite for referencing them in a trip. */
  submitDriver(payload: Record<string, unknown>): Promise<void>;
  /** §5 — submit one completed trip. Throws on statusCode 5001. */
  submitTripReport(payload: Record<string, unknown>): Promise<TripSubmissionResult>;
  /** §6 — one operational summary per day. */
  submitDailyReport(payload: Record<string, unknown>): Promise<void>;
}

export const LATRA_CLIENT = "LATRA_CLIENT_TOKEN";

/** CeTS paths, verbatim from the API document. */
export const CETS_PATHS = {
  submitVehicle: "/api/v1/ticket-engine/rideVehicle/submitVehicle",
  submitDriver: "/api/v1/ticket-engine/rideDriver/submitDriver",
  submitTrip: "/api/v1/ticket-engine/rideHailing/submitTrip",
  submitReport: "/api/v1/ticket-engine/rideReport/submitReport",
} as const;

export const CETS_SUCCESS = 5000;

@Injectable()
export class MockLatraClient implements LatraClient {
  readonly name = "mock";
  private readonly logger = new Logger("MockLatra");
  private seq = 0;

  async verifyVehicle(plateNumber: string, latraLicenseNumber: string): Promise<VehicleVerification> {
    this.logger.log(`verifyVehicle(${plateNumber}, ${latraLicenseNumber}) → verified (mock)`);
    return { verified: true, detail: "mock verification — replace before launch" };
  }

  async submitVehicle(payload: Record<string, unknown>): Promise<void> {
    this.logger.log(`submitVehicle ${String(payload.vehicleRegistrationNumber)} → accepted (mock)`);
  }

  async submitDriver(payload: Record<string, unknown>): Promise<void> {
    this.logger.log(`submitDriver ${String(payload.driverLicenseNumber)} → accepted (mock)`);
  }

  async submitTripReport(payload: Record<string, unknown>): Promise<TripSubmissionResult> {
    this.seq += 1;
    this.logger.log(`submitTrip ${String(payload.tripId)} → acked (mock)`);
    return {
      ackId: `mock-ack-${Date.now()}`,
      latraReferenceNumber: `MOCK${String(this.seq).padStart(4, "0")}`,
    };
  }

  async submitDailyReport(payload: Record<string, unknown>): Promise<void> {
    this.logger.log(`submitDailyReport ${String(payload.reportDate)} → accepted (mock)`);
  }
}

/**
 * Real CeTS client. Authentication is a self-signed RS256 JWT (§1) — there is
 * no OAuth2 token exchange and no client secret; CeTS fetches our public key
 * from the discovery endpoint we host (see CetsDiscoveryController).
 *
 * TODO-OPERATOR: set LATRA_CETS_BASE_URL, LATRA_CETS_ISSUER (the domain
 * registered with CeTS), LATRA_CETS_PUBLIC_BASE_URL, and LATRA_CETS_AUDIENCE
 * if LATRA specifies one; then set LATRA_CLIENT=real.
 */
@Injectable()
export class CetsLatraClient implements LatraClient {
  readonly name = "cets";
  private readonly logger = new Logger("CetsLatra");

  constructor(private readonly auth: CetsAuthService) {}

  /**
   * POSTs to CeTS and unwraps the envelope. A statusCode other than 5000 is a
   * failure even though the transport returned 200 — we throw so the caller's
   * retry/outbox handles it instead of recording a rejection as a success.
   */
  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${appConfig.latra.cets.baseUrl}${path}`, {
      method: "POST",
      headers: {
        accept: "*/*",
        authorization: `Bearer ${this.auth.token()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`CeTS ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`CeTS ${path}: response was not JSON: ${text.slice(0, 200)}`);
    }
    const statusCode = Number(json.statusCode);
    if (statusCode !== CETS_SUCCESS) {
      throw new Error(`CeTS ${path} rejected (statusCode ${statusCode}): ${String(json.message ?? "")}`);
    }
    return (json.data as Record<string, unknown>) ?? {};
  }

  async verifyVehicle(plateNumber: string, latraLicenseNumber: string): Promise<VehicleVerification> {
    // Not part of the CeTS API document — submitVehicle registration is what
    // CeTS actually offers. Kept so the admin screen keeps working.
    this.logger.warn(
      `verifyVehicle(${plateNumber}, ${latraLicenseNumber}) has no CeTS endpoint — treat as unverified`,
    );
    return { verified: false, detail: "CeTS exposes no vehicle-verification endpoint" };
  }

  async submitVehicle(payload: Record<string, unknown>): Promise<void> {
    await this.post(CETS_PATHS.submitVehicle, payload);
  }

  async submitDriver(payload: Record<string, unknown>): Promise<void> {
    await this.post(CETS_PATHS.submitDriver, payload);
  }

  async submitTripReport(payload: Record<string, unknown>): Promise<TripSubmissionResult> {
    const data = await this.post(CETS_PATHS.submitTrip, payload);
    const ref = data.latraReferenceNumber ? String(data.latraReferenceNumber) : undefined;
    if (!ref) this.logger.warn(`CeTS accepted trip ${String(payload.tripId)} without a reference number`);
    return { ackId: ref ?? "no-ack", latraReferenceNumber: ref };
  }

  async submitDailyReport(payload: Record<string, unknown>): Promise<void> {
    await this.post(CETS_PATHS.submitReport, payload);
  }
}
