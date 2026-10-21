/**
 * Fake LATRA Core e-Ticketing System (CeTS), built from "LATRA-Core e-Ticketing
 * System with Ride Hailing System — API DOCUMENT" (docs/LATRA 1.pdf).
 *
 * Simulator-first: this harness exists so the real client is written against
 * something that actually enforces the spec, rather than a mock that agrees
 * with whatever we send. It therefore:
 *
 *   - fetches our JWKS via the discovery endpoint and *verifies* the RS256
 *     self-signed JWT, including iss/sub/exp;
 *   - enforces the documented required fields, types and formats;
 *   - enforces the ordering constraint — a trip referencing an unregistered
 *     driver or vehicle is REJECTED (statusCode 5001);
 *   - answers in CeTS's envelope: statusCode 5000 success / 5001 failure,
 *     with a latraReferenceNumber for accepted trips.
 */
import { createServer, Server } from "node:http";
import { createPublicKey, createVerify } from "node:crypto";

export interface CetsRecord {
  vehicles: Map<string, Record<string, unknown>>;
  drivers: Map<string, Record<string, unknown>>;
  trips: Array<Record<string, unknown>>;
  reports: Array<Record<string, unknown>>;
  rejections: Array<{ path: string; reason: string }>;
  authFailures: string[];
}

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COORD_RE = /^\s*-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?\s*$/;
const VEHICLE_TYPES = new Set(["CAR", "MOTORCYCLE", "TRICYCLE"]);

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Verify an RS256 JWT against a JWKS, per the spec's self-signed JWT model. */
function verifyJwt(
  token: string,
  jwks: { keys: Array<Record<string, string>> },
  expectIss: string,
): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return "malformed JWT";
  const [h, p, s] = parts;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlToBuf(h!).toString("utf8"));
    claims = JSON.parse(b64urlToBuf(p!).toString("utf8"));
  } catch {
    return "unparseable JWT segments";
  }
  if (header.alg !== "RS256") return `alg must be RS256, got ${String(header.alg)}`;

  const jwk = jwks.keys.find((k) => !header.kid || k.kid === header.kid) ?? jwks.keys[0];
  if (!jwk) return "no key in JWKS";
  let key;
  try {
    key = createPublicKey({ key: jwk as never, format: "jwk" });
  } catch (e) {
    return `JWKS key unusable: ${String(e)}`;
  }
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(key, b64urlToBuf(s!));
  if (!ok) return "signature does not verify against JWKS";

  if (claims.iss !== expectIss) return `iss ${String(claims.iss)} != registered ${expectIss}`;
  if (claims.sub !== expectIss) return `sub ${String(claims.sub)} != registered ${expectIss}`;
  if (typeof claims.exp !== "number") return "missing exp";
  if (claims.exp * 1000 < Date.now()) return "token expired";
  if (typeof claims.iat !== "number") return "missing iat";
  return undefined;
}

function req(body: Record<string, unknown>, field: string, type: "string" | "number"): string | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === "") return `${field} is required`;
  if (type === "string" && typeof v !== "string") return `${field} must be a String`;
  if (type === "number" && typeof v !== "number") return `${field} must be numeric`;
  return undefined;
}

/**
 * Starts the fake CeTS. `discoveryUrl` is our /.well-known endpoint — the fake
 * resolves it to a jwks_uri and pulls our public key, exactly as CeTS would.
 */
export async function startFakeCets(opts: {
  discoveryUrl: string;
  expectIss: string;
  port?: number;
}): Promise<{ server: Server; port: number; state: CetsRecord; close: () => Promise<void> }> {
  const state: CetsRecord = {
    vehicles: new Map(),
    drivers: new Map(),
    trips: [],
    reports: [],
    rejections: [],
    authFailures: [],
  };
  let jwksCache: { keys: Array<Record<string, string>> } | undefined;

  async function jwks(): Promise<{ keys: Array<Record<string, string>> } | undefined> {
    if (jwksCache) return jwksCache;
    try {
      const disc = (await (await fetch(opts.discoveryUrl)).json()) as { jwks_uri?: string };
      if (!disc.jwks_uri) return undefined;
      jwksCache = (await (await fetch(disc.jwks_uri)).json()) as { keys: Array<Record<string, string>> };
      return jwksCache;
    } catch {
      return undefined;
    }
  }

  const server = createServer((r, res) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => {
      void (async () => {
        const path = (r.url ?? "").split("?")[0]!;
        const send = (statusCode: number, message: string, data: Record<string, unknown> = {}) => {
          if (statusCode === 5001) state.rejections.push({ path, reason: message });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "MS", trxnId: null, statusCode, message, data }));
        };

        // --- auth: self-signed JWT verified against our published JWKS ---
        const auth = String(r.headers.authorization ?? "");
        if (!auth.startsWith("Bearer ")) {
          state.authFailures.push(`${path}: missing Bearer token`);
          return send(5001, "Failed: missing bearer token");
        }
        const set = await jwks();
        if (!set) {
          state.authFailures.push(`${path}: discovery/JWKS unreachable`);
          return send(5001, "Failed: cannot resolve signer JWKS");
        }
        const authErr = verifyJwt(auth.slice(7), set, opts.expectIss);
        if (authErr) {
          state.authFailures.push(`${path}: ${authErr}`);
          return send(5001, `Failed: ${authErr}`);
        }
        if (r.headers["content-type"] !== "application/json") {
          return send(5001, "Failed: Content-Type must be application/json");
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return send(5001, "Failed: body is not JSON");
        }

        // --- 3. Submit Ride Vehicle ---
        if (path === "/api/v1/ticket-engine/rideVehicle/submitVehicle") {
          const e =
            req(body, "vehicleRegistrationNumber", "string") ??
            req(body, "vehicleTypeEnum", "string") ??
            req(body, "vehicleRegistrationDate", "string");
          if (e) return send(5001, `Failed: ${e}`);
          const vrn = String(body.vehicleRegistrationNumber);
          if (/\s/.test(vrn)) return send(5001, "Failed: vehicleRegistrationNumber must not contain spaces");
          if (!VEHICLE_TYPES.has(String(body.vehicleTypeEnum))) {
            return send(5001, `Failed: vehicleTypeEnum must be CAR|MOTORCYCLE|TRICYCLE`);
          }
          if (!DATE_RE.test(String(body.vehicleRegistrationDate))) {
            return send(5001, "Failed: vehicleRegistrationDate must be YYYY-MM-DD");
          }
          state.vehicles.set(vrn, body);
          return send(5000, "Successful", { vehicleRegistrationNumber: vrn });
        }

        // --- 4. Submit Ride Driver ---
        if (path === "/api/v1/ticket-engine/rideDriver/submitDriver") {
          const e =
            req(body, "driverName", "string") ??
            req(body, "driverEmail", "string") ??
            req(body, "driverPhone", "string") ??
            req(body, "driverLicenseNumber", "string") ??
            req(body, "licenceCategory", "string");
          if (e) return send(5001, `Failed: ${e}`);
          const lic = String(body.driverLicenseNumber);
          if (!/^\d{10}$/.test(lic)) {
            return send(5001, "Failed: driverLicenseNumber must be a valid 10 digit number");
          }
          state.drivers.set(lic, body);
          return send(5000, "Successful", { driverLicenseNumber: lic });
        }

        // --- 5. Submit Trip ---
        if (path === "/api/v1/ticket-engine/rideHailing/submitTrip") {
          for (const f of [
            "tripId",
            "originCoordinates",
            "endCoordinates",
            "startTime",
            "endTime",
            "driverLicenseNumber",
            "vehicleRegistrationNumber",
            "passengerName",
            "passengerPhone",
            "pickupPoint",
            "dropOffPoint",
          ]) {
            const e = req(body, f, "string");
            if (e) return send(5001, `Failed: ${e}`);
          }
          for (const f of ["totalFareAmount", "tripDistance", "rating", "driverEarning"]) {
            const e = req(body, f, "number");
            if (e) return send(5001, `Failed: ${e}`);
          }
          if (!COORD_RE.test(String(body.originCoordinates)) || !COORD_RE.test(String(body.endCoordinates))) {
            return send(5001, "Failed: coordinates must be two numbers separated by a comma");
          }
          if (!TIME_RE.test(String(body.startTime)) || !TIME_RE.test(String(body.endTime))) {
            return send(5001, "Failed: times must be YYYY-MM-DD HH:MM:SS");
          }
          if (!Number.isInteger(body.tripDistance)) return send(5001, "Failed: tripDistance must be an Integer");
          const rating = body.rating as number;
          if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
            return send(5001, "Failed: rating must be an Integer in range 0-5");
          }
          // Ordering constraint from the spec: only registered drivers/vehicles
          // may be referenced by a trip submission.
          const lic = String(body.driverLicenseNumber);
          const vrn = String(body.vehicleRegistrationNumber);
          if (!state.drivers.has(lic)) {
            return send(5001, `Failed: driver ${lic} is not registered`);
          }
          if (!state.vehicles.has(vrn)) {
            return send(5001, `Failed: vehicle ${vrn} is not registered`);
          }
          state.trips.push(body);
          const ref = `M${String(state.trips.length).padStart(4, "0")}REF`;
          return send(5000, "Successful", { tripRef: String(body.tripId), latraReferenceNumber: ref });
        }

        // --- 6. Submit Daily Report ---
        if (path === "/api/v1/ticket-engine/rideReport/submitReport") {
          const e =
            req(body, "totalTrip", "number") ??
            req(body, "totalPaidAmount", "number") ??
            req(body, "reportDate", "string");
          if (e) return send(5001, `Failed: ${e}`);
          if (!Number.isInteger(body.totalTrip) || !Number.isInteger(body.totalPaidAmount)) {
            return send(5001, "Failed: totalTrip and totalPaidAmount must be Integers");
          }
          if (!DATE_RE.test(String(body.reportDate))) {
            return send(5001, "Failed: reportDate must be YYYY-MM-DD");
          }
          state.reports.push(body);
          return send(5000, "Successful", { reportDate: String(body.reportDate) });
        }

        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "MS", statusCode: 5001, message: "Unknown endpoint", data: {} }));
      })();
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });

  return {
    server,
    port,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
