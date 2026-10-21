/**
 * Phase-5 ops integration tests: staff auth + RBAC, dispatcher-created trips
 * (SMS-driven caller), manual assignment (60 s offer) and FORCE-ACCEPT with
 * standing consent, admin wallet adjustment (balanced + audited), fare-config
 * LATRA-bounds rejection, and the LATRA trip-report outbox.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Role, VehicleClass } from "@rukwaride/shared";
import { api as rest } from "../src/api-client";
import { mintToken } from "../src/auth";
import { loadSimIdentities, loadSimPassengers, SimPassenger } from "../src/fleet";
import { SimDriver } from "../src/sim-driver";
import { TEST_API_URL, TEST_DISPATCH } from "./global-setup";
import { closeHelpers, prisma, resetWorld, waitFor } from "./helpers";

const CENTER = { lat: -7.9667, lng: 31.6167 };
const PICKUP = { lat: CENTER.lat + 0.001, lng: CENTER.lng };
const DROP = { lat: CENTER.lat + 0.005, lng: CENTER.lng + 0.002 };

let drivers: SimDriver[] = [];
let passengers: SimPassenger[] = [];

async function staffLogin(phone: string): Promise<string> {
  const res = await fetch(`${TEST_API_URL}/auth/staff/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password: "ChangeMe123!" }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

const adminToken = () => staffLogin("+255700000001");
const dispatcherToken = () => staffLogin("+255700000002");

async function staffPost(token: string, path: string, body?: unknown) {
  return fetch(`${TEST_API_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

async function staffGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${TEST_API_URL}${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.ok).toBe(true);
  return (await res.json()) as T;
}

async function spawnDriver(behavior: "accept" | "ignore" = "accept"): Promise<SimDriver> {
  const [identity] = await loadSimIdentities(prisma, 1, VehicleClass.BODABODA);
  const driver = new SimDriver({
    apiUrl: TEST_API_URL,
    token: mintToken({ sub: identity!.userId, role: Role.DRIVER, driverProfileId: identity!.driverProfileId }),
    identity: identity!,
    start: { lat: PICKUP.lat + 0.001, lng: PICKUP.lng },
    behavior: behavior === "accept" ? { kind: "accept", delayMs: 400 } : { kind: "ignore" },
    pingIntervalMs: 1000,
    speedMps: 30,
    idleDriftM: 0,
  });
  await driver.goOnline();
  drivers.push(driver);
  await new Promise((r) => setTimeout(r, 1500));
  return driver;
}

beforeEach(async () => {
  await resetWorld();
  passengers = await loadSimPassengers(prisma, 2);
});

afterEach(async () => {
  for (const d of drivers) d.stop();
  drivers = [];
  await resetWorld();
});

afterAll(async () => {
  await closeHelpers();
});

describe("ops", () => {
  it("staff auth: wrong password 401; dispatcher blocked from admin endpoints (RBAC)", async () => {
    const bad = await fetch(`${TEST_API_URL}/auth/staff/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+255700000001", password: "WrongPass99!" }),
    });
    expect(bad.status).toBe(401);

    const dispatcher = await dispatcherToken();
    const forbidden = await fetch(`${TEST_API_URL}/admin/dashboard`, {
      headers: { authorization: `Bearer ${dispatcher}` },
    });
    expect(forbidden.status).toBe(403);

    const admin = await adminToken();
    const dash = await staffGet<{ trips7d: number }>(admin, "/admin/dashboard");
    expect(dash.trips7d).toBeGreaterThanOrEqual(0);
  });

  it("dispatcher books for a phone caller; trip auto-dispatches and completes; LATRA report is ACKED", async () => {
    await spawnDriver("accept");
    const dispatcher = await dispatcherToken();

    const created = await staffPost(dispatcher, "/trips", {
      vehicleClass: "BODABODA",
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: "CASH",
      contactPhone: "+255788000111", // caller without an account (spec §10)
    });
    expect(created.status).toBe(201);
    const trip = (await created.json()) as { id: string };

    await waitFor(
      async () => (await prisma.trip.findUnique({ where: { id: trip.id } }))?.status === "COMPLETED",
      { timeoutMs: 90_000, label: "dispatcher trip completes" },
    );

    // LATRA outbox (spec §12.3): report exists and the mock client acks it.
    const report = await waitFor(
      async () => {
        const r = await prisma.latraReport.findFirst({ where: { tripId: trip.id } });
        return r?.status === "ACKED" ? r : false;
      },
      { timeoutMs: 15_000, label: "LATRA report acked" },
    );
    expect((report.payload as { vehicleRegistrationNumber?: string }).vehicleRegistrationNumber).toBeTruthy();
  });

  it("manual assign sends a 60s offer to a driver the cascade already exhausted", async () => {
    const driver = await spawnDriver("ignore");
    const dispatcher = await dispatcherToken();

    const created = await staffPost(dispatcher, "/trips", {
      vehicleClass: "BODABODA",
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: "CASH",
      contactPhone: "+255788000222",
    });
    const trip = (await created.json()) as { id: string };

    // Let the automatic offer expire (server TTL) so the driver is excluded
    // from the cascade and the trip sits in SEARCHING.
    await waitFor(
      async () => {
        const t = await prisma.trip.findUnique({ where: { id: trip.id } });
        return t?.status === "SEARCHING" && t.offeredDriverIds.length >= 1 ? t : false;
      },
      { timeoutMs: (TEST_DISPATCH.offerTtlS + 10) * 1000, label: "auto offer expired" },
    );

    driver.behavior = { kind: "accept", delayMs: 300 };
    const assign = await staffPost(dispatcher, `/dispatch/trips/${trip.id}/assign`, {
      driverProfileId: driver.id,
      force: false,
    });
    expect(assign.status).toBe(201);

    await waitFor(
      async () => (await prisma.trip.findUnique({ where: { id: trip.id } }))?.driverId === driver.id,
      { timeoutMs: 15_000, label: "driver accepted manual offer" },
    );
    // The manual offer carried the longer dispatcher TTL (~60 s).
    const offer = driver.receivedOffers.at(-1)!;
    expect(new Date(offer.expiresAt).getTime() - Date.now()).toBeGreaterThan(30_000);
  });

  it("FORCE-ACCEPT assigns instantly when the driver holds standing consent", async () => {
    const driver = await spawnDriver("ignore"); // never taps anything
    const admin = await adminToken();
    const dispatcher = await dispatcherToken();

    await staffPost(admin, `/admin/drivers/${driver.id}/consent`, { consent: true });

    const created = await staffPost(dispatcher, "/trips", {
      vehicleClass: "BODABODA",
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: "CASH",
      contactPhone: "+255788000333",
    });
    const trip = (await created.json()) as { id: string };

    await waitFor(
      async () => {
        const t = await prisma.trip.findUnique({ where: { id: trip.id } });
        return t?.status === "SEARCHING" && t.offeredDriverIds.length >= 1 ? t : false;
      },
      { timeoutMs: (TEST_DISPATCH.offerTtlS + 10) * 1000, label: "auto offer expired" },
    );

    const assign = await staffPost(dispatcher, `/dispatch/trips/${trip.id}/assign`, {
      driverProfileId: driver.id,
      force: true,
    });
    expect(assign.status).toBe(201);
    const result = (await assign.json()) as { ok: boolean };
    expect(result.ok).toBe(true);

    const t = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(t!.status).toBe("ACCEPTED");
    expect(t!.driverId).toBe(driver.id);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "TRIP_FORCE_ASSIGNED", entityId: trip.id },
    });
    expect(audit).not.toBeNull();
  });

  it("admin wallet adjustment requires a memo, books a balanced txn, and is audited", async () => {
    const driver = await spawnDriver("accept");
    const admin = await adminToken();
    const before = Number((await prisma.driverProfile.findUnique({ where: { id: driver.id } }))!.walletBalance);

    const noMemo = await staffPost(admin, `/admin/drivers/${driver.id}/wallet-adjust`, { amount: 3000 });
    expect(noMemo.status).toBe(400);

    const ok = await staffPost(admin, `/admin/drivers/${driver.id}/wallet-adjust`, {
      amount: 3000,
      memo: "Refund for disputed trip",
    });
    expect(ok.status).toBe(201);
    const { txnId } = (await ok.json()) as { txnId: string };

    const after = Number((await prisma.driverProfile.findUnique({ where: { id: driver.id } }))!.walletBalance);
    expect(after).toBe(before + 3000);

    const entries = await prisma.ledgerEntry.findMany({ where: { txnId } });
    expect(entries.length).toBe(2);
    expect(entries.reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0)).toBe(0);

    const audit = await prisma.auditLog.findFirst({ where: { action: "WALLET_ADJUSTED", entityId: driver.id } });
    expect(audit).not.toBeNull();
  });

  it("fare-config editor rejects out-of-bounds values naming the violated band, accepts compliant ones with history", async () => {
    const admin = await adminToken();

    const bad = await staffPost(admin, "/admin/fares", {
      vehicleClass: "BODABODA",
      baseFare: 500,
      perKm: 99999, // way above the LATRA band
      perMin: 50,
      bookingFeePct: 3,
      minimumFare: 1000,
      commissionPct: 30, // above the 25% cap
      latraOrderRef: "test-order",
    });
    expect(bad.status).toBe(400);
    const err = (await bad.json()) as { violations: Array<{ field: string }> };
    const fields = err.violations.map((v) => v.field);
    expect(fields).toContain("perKm");
    expect(fields).toContain("commissionPct");

    const good = await staffPost(admin, "/admin/fares", {
      vehicleClass: "BODABODA",
      baseFare: 600,
      perKm: 400,
      perMin: 60,
      bookingFeePct: 3,
      minimumFare: 1100,
      commissionPct: 18,
      latraOrderRef: "LATRA order test-2026-01",
    });
    expect(good.status).toBe(201);

    const fares = await staffGet<{ configs: Array<{ vehicleClass: string; active: boolean; perKm: number }> }>(
      admin,
      "/admin/fares",
    );
    const bodaActive = fares.configs.filter((c) => c.vehicleClass === "BODABODA" && c.active);
    expect(bodaActive.length).toBe(1);
    expect(bodaActive[0]!.perKm).toBe(400);
    // The superseded config remains as history.
    expect(fares.configs.some((c) => c.vehicleClass === "BODABODA" && !c.active)).toBe(true);
  });

  /**
   * CeTS §5 submits COMPLETED trips only ("Each completed trip must be
   * submitted once, immediately after trip completion"). A cancelled trip has
   * no startTime/endTime/rating, so submitting one can only ever be rejected
   * on the required-field checks — we no longer queue it.
   *
   * OPEN WITH LATRA: whether cancellations should be reported at all, and via
   * which endpoint (docs/latra-cets-api-gap-analysis.md §3).
   */
  it("does NOT produce a CeTS trip report for a cancelled trip", async () => {
    await spawnDriver("accept");
    const [passenger] = await loadSimPassengers(prisma, 1);
    const trip = await rest.createTrip(TEST_API_URL, passenger!.token, {
      vehicleClass: VehicleClass.BODABODA,
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: "CASH" as never,
    });
    await waitFor(
      async () => (await prisma.trip.findUnique({ where: { id: trip.id } }))?.status === "ACCEPTED",
      { timeoutMs: 20_000, label: "accepted" },
    );
    await rest.cancelTrip(TEST_API_URL, passenger!.token, trip.id, "changed my mind");

    // Give the outbox the same window a real submission would have had.
    await new Promise((r) => setTimeout(r, 5_000));
    const report = await prisma.latraReport.findFirst({ where: { tripId: trip.id } });
    expect(report).toBeNull();
    const row = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(row?.status).toBe("CANCELLED_BY_PASSENGER");
  });
});
