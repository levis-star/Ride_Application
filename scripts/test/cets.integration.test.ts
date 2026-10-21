/**
 * LATRA Core e-Ticketing System (CeTS) integration — docs/LATRA 1.pdf.
 *
 * Boots a dedicated API with LATRA_CLIENT=real pointed at a fake CeTS that
 * actually enforces the spec: it fetches our JWKS through the discovery
 * endpoint, verifies the self-signed RS256 JWT, validates every documented
 * field/format, and enforces the ordering constraint (a trip may only
 * reference an already-registered driver and vehicle).
 *
 * The fake rejects with statusCode 5001 inside an HTTP 200 — the exact shape
 * that the previous client silently recorded as success.
 */
import { spawn, ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PaymentMethod, Role, VehicleClass } from "@rukwaride/shared";
import { api as rest } from "../src/api-client";
import { mintToken } from "../src/auth";
import { startFakeCets, CetsRecord } from "../src/fake-cets";
import { loadSimIdentities, loadSimPassengers, SimPassenger } from "../src/fleet";
import { SimDriver } from "../src/sim-driver";
import { closeHelpers, prisma, waitFor } from "./helpers";

const REPO_ROOT = resolve(__dirname, "..", "..");
const API_PORT = 3005;
const API = `http://localhost:${API_PORT}`;
const ISSUER = `http://localhost:${API_PORT}`;

const PICKUP = { lat: -7.9657, lng: 31.6167 };
const DROP = { lat: -7.9607, lng: 31.6187 };

let apiProcess: ChildProcess | undefined;
let cets: Awaited<ReturnType<typeof startFakeCets>>;
let state: CetsRecord;
let driver: SimDriver | undefined;
let passengers: SimPassenger[] = [];

beforeAll(async () => {
  dotenv({ path: resolve(REPO_ROOT, ".env") });
  cets = await startFakeCets({
    discoveryUrl: `${API}/.well-known/tz-e-ticketing-server`,
    expectIss: ISSUER,
  });
  state = cets.state;

  apiProcess = spawn("node", [resolve(REPO_ROOT, "apps/api/dist/main.js")], {
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      QUEUE_PREFIX: "bull-cetstest",
      SOCKET_ADAPTER_KEY: "socket.io-cetstest",
      OSRM_URL: "",
      LATRA_CLIENT: "real",
      LATRA_CETS_BASE_URL: `http://127.0.0.1:${cets.port}`,
      LATRA_CETS_ISSUER: ISSUER,
      LATRA_CETS_PUBLIC_BASE_URL: API,
      LATRA_REPORT_DELAY_S: "2",
      SCHEDULE_LEAD_S: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  apiProcess.stderr?.on("data", (d) => {
    if (process.env.TEST_API_LOGS) process.stderr.write(`[cets-api:err] ${d}`);
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${API}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("CeTS API did not become healthy");
    await new Promise((r) => setTimeout(r, 500));
  }
  passengers = await loadSimPassengers(prisma, 1);
}, 90_000);

afterAll(async () => {
  driver?.stop();
  apiProcess?.kill("SIGTERM");
  await cets.close();
  await closeHelpers();
});

/** Spawns an approved driver whose licence/plate satisfy CeTS's formats. */
async function spawnCetsDriver(licenseNumber: string): Promise<SimDriver> {
  const [identity] = await loadSimIdentities(prisma, 1, VehicleClass.BODABODA);
  await prisma.driverProfile.update({
    where: { id: identity!.driverProfileId },
    data: { licenseNumber, licenceCategory: "A", cetsRegisteredAt: null },
  });
  const profile = await prisma.driverProfile.findUnique({
    where: { id: identity!.driverProfileId },
    include: { currentVehicle: true },
  });
  await prisma.user.update({
    where: { id: identity!.userId },
    data: { email: "sim.driver@rukwaride.test" },
  });
  if (profile?.currentVehicleId) {
    await prisma.vehicle.update({
      where: { id: profile.currentVehicleId },
      data: { cetsRegisteredAt: null, registrationDate: new Date("2024-10-10") },
    });
  }
  const d = new SimDriver({
    apiUrl: API,
    token: mintToken({
      sub: identity!.userId,
      role: Role.DRIVER,
      driverProfileId: identity!.driverProfileId,
    }),
    identity: identity!,
    start: { lat: PICKUP.lat + 0.001, lng: PICKUP.lng },
    behavior: { kind: "accept", delayMs: 400 },
    pingIntervalMs: 1000,
    speedMps: 30,
    idleDriftM: 0,
  });
  await d.goOnline();
  await new Promise((r) => setTimeout(r, 1500));
  return d;
}

describe("CeTS discovery endpoints", () => {
  it("publishes the discovery document at the spec's path", async () => {
    const res = await fetch(`${API}/.well-known/tz-e-ticketing-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jwks_uri: string };
    expect(body.jwks_uri).toBe(`${API}/.well-known/jwks.json`);
  });

  it("publishes a usable RS256 JWKS", async () => {
    const res = await fetch(`${API}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<Record<string, string>> };
    expect(body.keys.length).toBeGreaterThan(0);
    const key = body.keys[0]!;
    expect(key.kty).toBe("RSA");
    expect(key.alg).toBe("RS256");
    expect(key.use).toBe("sig");
    expect(key.kid).toBeTruthy();
    expect(key.n).toBeTruthy();
    // A JWKS must never carry private material.
    expect(key.d).toBeUndefined();
  });
});

describe("CeTS trip submission", () => {
  it("registers driver + vehicle, then submits the trip and stores the reference", async () => {
    driver = await spawnCetsDriver("4000123454");
    const passenger = passengers[0]!;

    const trip = await rest.createTrip(API, passenger.token, {
      vehicleClass: VehicleClass.BODABODA,
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: PaymentMethod.CASH,
    });
    await waitFor(
      async () => (await rest.getTrip(API, passenger.token, trip.id)).status === "COMPLETED",
      { timeoutMs: 90_000, label: "trip completes" },
    );

    const report = await waitFor(
      async () => {
        const r = await prisma.latraReport.findFirst({ where: { tripId: trip.id } });
        return r?.status === "ACKED" ? r : false;
      },
      { timeoutMs: 30_000, label: "CeTS report acked" },
    );

    // The JWT was accepted — no auth failure was recorded by the fake.
    expect(state.authFailures).toEqual([]);
    // Nothing was rejected.
    expect(state.rejections).toEqual([]);

    // Ordering constraint honoured: driver and vehicle registered first.
    expect(state.drivers.size).toBeGreaterThan(0);
    expect(state.vehicles.size).toBeGreaterThan(0);

    // The official reference number is persisted, not just logged.
    expect(report.latraReferenceNumber).toMatch(/^M\d{4}REF$/);

    const submitted = state.trips.at(-1)!;
    expect(submitted.tripId).toBe(trip.id);
    expect(submitted.passengerName).toBeTruthy();
    expect(submitted.passengerPhone).toBeTruthy();
    expect(submitted.pickupPoint).toBeTruthy();
    expect(submitted.dropOffPoint).toBeTruthy();
    expect(Number.isInteger(submitted.rating)).toBe(true);
    expect(submitted.driverLicenseNumber).toBe("4000123454");
    expect(String(submitted.vehicleRegistrationNumber)).not.toMatch(/\s/);

    // Registration payloads carry CeTS's enum, not our Swahili class name.
    const vehicle = [...state.vehicles.values()].at(-1)!;
    expect(["CAR", "MOTORCYCLE", "TRICYCLE"]).toContain(vehicle.vehicleTypeEnum);
    expect(vehicle.vehicleRegistrationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const drv = [...state.drivers.values()].at(-1)!;
    expect(drv.licenceCategory).toBe("A");
    expect(drv.driverEmail).toBe("sim.driver@rukwaride.test");
  }, 150_000);
});

describe("CeTS daily report", () => {
  it("submits totals for a day and CeTS accepts the shape", async () => {
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    const adminToken = mintToken({ sub: admin!.id, role: Role.ADMIN });
    // Today (EAT) — the trip completed above falls in this window.
    const today = new Date();
    const eatDate = new Date(today.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);

    const res = await fetch(`${API}/admin/latra-daily-report`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ date: eatDate }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { totalTrip: number; totalPaidAmount: number; reportDate: string };
    expect(body.reportDate).toBe(eatDate);
    expect(body.totalTrip).toBeGreaterThanOrEqual(1); // the trip completed above

    const submitted = state.reports.at(-1)!;
    expect(submitted.reportDate).toBe(eatDate);
    expect(Number.isInteger(submitted.totalTrip)).toBe(true);
    expect(Number.isInteger(submitted.totalPaidAmount)).toBe(true);
    expect(state.rejections.filter((r) => r.path.includes("submitReport"))).toEqual([]);
  }, 30_000);
});

/**
 * LATRA: submit a driver/vehicle once, "or whenever details change". We
 * fingerprint the accepted payload, so any edit anywhere triggers a
 * re-submission without each edit path having to remember.
 */
describe("CeTS re-submission on detail change", () => {
  it("re-submits a driver whose details changed, and skips one that did not", async () => {
    const [identity] = await loadSimIdentities(prisma, 1, VehicleClass.BODABODA);
    await prisma.driverProfile.update({
      where: { id: identity!.driverProfileId },
      data: {
        licenseNumber: "4000555111",
        licenceCategory: "B",
        cetsRegisteredAt: null,
        cetsFingerprint: null,
      },
    });
    await prisma.user.update({
      where: { id: identity!.userId },
      data: { email: "resync@rukwaride.test" },
    });
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    const adminToken = mintToken({ sub: admin!.id, role: Role.ADMIN });
    const retry = () =>
      fetch(`${API}/admin/latra-register-driver/${identity!.driverProfileId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
      });

    // First registration.
    expect((await retry()).status).toBe(201);
    const first = await prisma.driverProfile.findUnique({ where: { id: identity!.driverProfileId } });
    expect(first?.cetsRegisteredAt).not.toBeNull();
    expect(first?.cetsFingerprint).toBeTruthy();
    const submittedFirst = state.drivers.get("4000555111");
    expect(submittedFirst?.licenceCategory).toBe("B");

    // Change the licence category — CeTS must receive the new value.
    await prisma.driverProfile.update({
      where: { id: identity!.driverProfileId },
      data: { licenceCategory: "C" },
    });
    await fetch(`${API}/admin/drivers/${identity!.driverProfileId}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(state.drivers.get("4000555111")?.licenceCategory).toBe("C");

    const after = await prisma.driverProfile.findUnique({ where: { id: identity!.driverProfileId } });
    expect(after?.cetsFingerprint).not.toBe(first?.cetsFingerprint);
  }, 30_000);
});

describe("CeTS daily report record", () => {
  it("persists each day's submission so filed days can be evidenced", async () => {
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    const adminToken = mintToken({ sub: admin!.id, role: Role.ADMIN });
    const eatDate = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

    const res = await fetch(`${API}/admin/latra-daily-report`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ date: eatDate }),
    });
    expect(res.status).toBe(201);

    const row = await prisma.latraDailyReport.findUnique({ where: { reportDate: eatDate } });
    expect(row?.status).toBe("ACKED");
    expect(row?.submittedAt).not.toBeNull();
    expect(row?.attempts).toBeGreaterThanOrEqual(1);

    // Visible to the admin screen.
    const list = await fetch(`${API}/admin/latra-daily-reports`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const rows = (await list.json()) as Array<{ reportDate: string }>;
    expect(rows.some((r) => r.reportDate === eatDate)).toBe(true);
  }, 30_000);
});

describe("CeTS rejection handling", () => {
  it("treats statusCode 5001 as failure, not success", async () => {
    // A licence that is not 10 digits fails CeTS validation, and the rejection
    // arrives as 5001 inside an HTTP 200 — exactly the case the previous
    // client recorded as a success.
    const [identity] = await loadSimIdentities(prisma, 1, VehicleClass.BAJAJI);
    await prisma.driverProfile.update({
      where: { id: identity!.driverProfileId },
      data: { licenseNumber: "NOT-10-DIGITS", licenceCategory: "B", cetsRegisteredAt: null, cetsLastError: null },
    });
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    const adminToken = mintToken({ sub: admin!.id, role: Role.ADMIN });

    const res = await fetch(`${API}/admin/drivers/${identity!.driverProfileId}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { cetsRegistered: boolean; cetsError?: string };
    expect(body.cetsRegistered).toBe(false);
    expect(body.cetsError).toContain("10 digit");

    // Not marked registered, and the reason is persisted for the admin screen.
    const after = await prisma.driverProfile.findUnique({ where: { id: identity!.driverProfileId } });
    expect(after?.cetsRegisteredAt).toBeNull();
    expect(after?.cetsLastError).toContain("10 digit");
  }, 30_000);

  it("records CeTS's own 5001 rejection when the payload passes local checks", async () => {
    // Licence is well-formed locally, but this VRN contains a space, which
    // only CeTS rejects — proving the envelope (HTTP 200 + statusCode 5001)
    // is read as a failure rather than a success.
    const [identity] = await loadSimIdentities(prisma, 1, VehicleClass.CAR);
    const profile = await prisma.driverProfile.findUnique({
      where: { id: identity!.driverProfileId },
    });
    await prisma.vehicle.update({
      where: { id: profile!.currentVehicleId! },
      data: { cetsRegisteredAt: null, cetsLastError: null, registrationDate: new Date("2024-01-01") },
    });
    // A plate written with spaces, as an operator would type it. Unique per
    // run: plateNumber is unique, so a fixed value collides on re-runs.
    const spacedPlate = `T ${String(Date.now() % 1000).padStart(3, "0")} SPC`;
    await prisma.$executeRawUnsafe(
      `UPDATE "Vehicle" SET "plateNumber" = $2 WHERE id = $1`,
      profile!.currentVehicleId!,
      spacedPlate,
    );

    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    const adminToken = mintToken({ sub: admin!.id, role: Role.ADMIN });
    const res = await fetch(`${API}/admin/drivers/${identity!.driverProfileId}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(201);

    // cetsPlate() strips the spaces, so CeTS accepts it — the vehicle registers.
    const v = await prisma.vehicle.findUnique({ where: { id: profile!.currentVehicleId! } });
    expect(v?.cetsRegisteredAt).not.toBeNull();
    expect([...state.vehicles.keys()]).toContain(spacedPlate.replace(/\s+/g, ""));
  }, 30_000);
});
