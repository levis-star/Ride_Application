/**
 * CeTS submitTrip dataset (docs/LATRA 1.pdf §5): verifies the submitted payload
 * matches LATRA's exact 16-field set and formats — comma-separated coordinates
 * in the configured order, local-time timestamps (no "T"), integer-metre
 * distance, 0-5 rating, driver earning, 10-digit licence, space-free vehicle
 * registration, and the passenger/pickup/drop-off fields.
 *
 * Also covers LATRA's cancellation rule: no charge before the driver arrives.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATRA_FIELD_KEYS, PaymentMethod, Role, VehicleClass } from "@rukwaride/shared";
import { api as rest } from "../src/api-client";
import { mintToken } from "../src/auth";
import { loadSimIdentities, loadSimPassengers, SimPassenger } from "../src/fleet";
import { SimDriver } from "../src/sim-driver";
import { TEST_API_URL } from "./global-setup";
import { closeHelpers, prisma, resetWorld, waitFor } from "./helpers";

const PICKUP = { lat: -7.9657, lng: 31.6167 };
const DROP = { lat: -7.9607, lng: 31.6187 };

let driver: SimDriver | undefined;
let passengers: SimPassenger[] = [];

async function spawnDriver(
  opts: { licenseNumber?: string; start?: { lat: number; lng: number } } = {},
): Promise<{ driver: SimDriver; token: string }> {
  const [identity] = await loadSimIdentities(prisma, 1, VehicleClass.BODABODA);
  if (opts.licenseNumber) {
    // A trip is only reported once CeTS has accepted the driver, and that
    // needs a 10-digit licence, a category and an email — so a driver fixture
    // must carry all three or the report never leaves the outbox.
    await prisma.driverProfile.update({
      where: { id: identity!.driverProfileId },
      data: { licenseNumber: opts.licenseNumber, licenceCategory: "A" },
    });
    await prisma.user.update({
      where: { id: identity!.userId },
      data: { email: "latra.sim@rukwaride.test" },
    });
  }
  const token = mintToken({
    sub: identity!.userId,
    role: Role.DRIVER,
    driverProfileId: identity!.driverProfileId,
  });
  const d = new SimDriver({
    apiUrl: TEST_API_URL,
    token,
    identity: identity!,
    start: opts.start ?? { lat: PICKUP.lat + 0.001, lng: PICKUP.lng },
    behavior: { kind: "accept", delayMs: 400 },
    pingIntervalMs: 1000,
    speedMps: 30,
    idleDriftM: 0,
  });
  await d.goOnline();
  await new Promise((r) => setTimeout(r, 1500));
  return { driver: d, token };
}

async function spawnLicensedDriver(licenseNumber: string): Promise<SimDriver> {
  return (await spawnDriver({ licenseNumber })).driver;
}

beforeEach(async () => {
  await resetWorld();
  passengers = await loadSimPassengers(prisma, 1);
});
afterEach(async () => {
  driver?.stop();
  driver = undefined;
  await resetWorld();
});
afterAll(closeHelpers);

describe("LATRA trip-report dataset", () => {
  it("submits the exact LATRA field set with correct formats, incl. rating + licence", async () => {
    driver = await spawnLicensedDriver("4000123454");
    const passenger = passengers[0]!;

    const trip = await rest.createTrip(TEST_API_URL, passenger.token, {
      vehicleClass: VehicleClass.BODABODA,
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: PaymentMethod.CASH,
    });
    await waitFor(
      async () => (await rest.getTrip(TEST_API_URL, passenger.token, trip.id)).status === "COMPLETED",
      { timeoutMs: 90_000, label: "trip completes" },
    );

    // Passenger rates the driver right after completion — must reach the report.
    const rated = await fetch(`${TEST_API_URL}/trips/${trip.id}/rating`, {
      method: "POST",
      headers: { authorization: `Bearer ${passenger.token}`, "content-type": "application/json" },
      body: JSON.stringify({ score: 4 }),
    });
    expect(rated.ok).toBe(true);

    const report = await waitFor(
      async () => {
        const r = await prisma.latraReport.findFirst({ where: { tripId: trip.id } });
        return r?.status === "ACKED" ? r : false;
      },
      { timeoutMs: 20_000, label: "LATRA report acked" },
    );

    const p = report.payload as Record<string, unknown>;

    // Exactly CeTS's dataset — no missing fields and no extras. `ackId` and
    // `latraReferenceNumber` are merged into the stored audit copy only (the
    // payload put on the wire is the clean dataset), so both are excluded
    // here. Key ORDER is asserted in the shared unit test, not here: Postgres
    // jsonb re-orders keys on storage, so a DB round-trip can only prove the
    // field set.
    const AUDIT_KEYS = ["ackId", "latraReferenceNumber"];
    expect(Object.keys(p).filter((k) => !AUDIT_KEYS.includes(k)).sort()).toEqual(
      [...LATRA_FIELD_KEYS].sort(),
    );

    // Coordinates: two comma-separated numbers, in the configured order
    // (default lat,lng per the API document's worked example).
    expect(p.originCoordinates).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
    expect(String(p.originCoordinates).split(",").map(Number)).toEqual([PICKUP.lat, PICKUP.lng]);

    // Local time "YYYY-MM-DD HH:MM:SS" — no "T", no fractional seconds, no "Z".
    expect(p.startTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(p.endTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // Integer-metre distance, licence, rating, earning.
    expect(Number.isInteger(p.tripDistance)).toBe(true);
    // CeTS requires a valid 10-digit licence, and it reaches the payload.
    expect(p.driverLicenseNumber).toBe("4000123454");
    expect(p.vehicleRegistrationNumber).toBeTruthy();
    expect(String(p.vehicleRegistrationNumber)).not.toMatch(/\s/);
    expect(p.rating).toBe(4);
    expect(typeof p.driverEarning).toBe("number");
    expect(p.driverEarning as number).toBeGreaterThan(0);

    // CeTS's five additional required fields (§5).
    expect(p.passengerName).toBeTruthy();
    expect(p.passengerPhone).toBeTruthy();
    expect(p.pickupPoint).toBeTruthy();
    expect(p.dropOffPoint).toBeTruthy();
    expect("passengerNida" in p).toBe(true); // optional value, required key

    // The completed-trip snapshot carries the full itemised receipt (LATRA #10),
    // so the passenger sees it on the completion screen, not only in history.
    const snapRes = await fetch(`${TEST_API_URL}/trips/${trip.id}/snapshot`, {
      headers: { authorization: `Bearer ${passenger.token}` },
    });
    const snap = (await snapRes.json()) as { receipt?: Record<string, unknown> };
    expect(snap.receipt).toBeTruthy();
    expect(snap.receipt!.from).toBeTruthy();
    expect(snap.receipt!.to).toBeTruthy();
    expect(snap.receipt!.total as number).toBeGreaterThan(0);
    expect("startedAt" in snap.receipt!).toBe(true);
    expect("completedAt" in snap.receipt!).toBe(true);
  });

  it("reports a dispatcher's captured caller name as passengerName, not a placeholder", async () => {
    // A phone caller has no passenger account, but the dispatcher captures their
    // name — CeTS must receive that, not the generic "Abiria" fallback.
    driver = await spawnLicensedDriver("4000123455");
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    const adminToken = mintToken({ sub: admin!.id, role: Role.ADMIN });
    const callerName = "Neema Mwakalinga";

    const trip = await rest.createTrip(TEST_API_URL, adminToken, {
      vehicleClass: VehicleClass.BODABODA,
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: PaymentMethod.CASH,
      contactPhone: "+255766000123", // belongs to no account → name must come from contactName
      contactName: callerName,
    });
    await waitFor(
      async () => (await prisma.trip.findUnique({ where: { id: trip.id } }))?.status === "COMPLETED",
      { timeoutMs: 90_000, label: "dispatcher trip completes" },
    );
    const report = await waitFor(
      async () => {
        const r = await prisma.latraReport.findFirst({ where: { tripId: trip.id } });
        return r?.status === "ACKED" ? r : false;
      },
      { timeoutMs: 20_000, label: "LATRA report acked" },
    );

    const p = report.payload as Record<string, unknown>;
    expect(p.passengerName).toBe(callerName);
    expect(p.passengerName).not.toBe("Abiria");
  });

  it("reverse-geocodes a pin-drop pickup to the nearest landmark's area name", async () => {
    // A pin-drop booking carries no landmarkId; CeTS still requires an *area
    // name*, so we resolve the nearest known landmark instead of sending coords.
    const planar = (aLat: number, aLng: number, bLat: number, bLng: number) =>
      Math.hypot((aLat - bLat) * 111_320, (aLng - bLng) * 110_570);
    const landmarks = (await prisma.landmark.findMany({ select: { name: true, lat: true, lng: true } })).map((l) => ({
      name: l.name,
      lat: Number(l.lat),
      lng: Number(l.lng),
    }));
    expect(landmarks.length).toBeGreaterThan(0);
    const nearest = landmarks
      .map((l) => ({ ...l, d: planar(l.lat, l.lng, PICKUP.lat, PICKUP.lng) }))
      .sort((a, b) => a.d - b.d)[0]!;
    // Book with a pin AT that landmark's coordinates but no landmarkId.
    const pinPickup = { lat: nearest.lat, lng: nearest.lng };
    const namesWithin600m = landmarks.filter((l) => planar(l.lat, l.lng, pinPickup.lat, pinPickup.lng) <= 600).map((l) => l.name);

    driver = (await spawnDriver({ licenseNumber: "4000123456", start: pinPickup })).driver;
    const passenger = passengers[0]!;
    const trip = await rest.createTrip(TEST_API_URL, passenger.token, {
      vehicleClass: VehicleClass.BODABODA,
      pickup: pinPickup, // no landmarkId → forces the reverse-geocode path
      drop: DROP,
      paymentMethod: PaymentMethod.CASH,
    });
    await waitFor(
      async () => (await rest.getTrip(TEST_API_URL, passenger.token, trip.id)).status === "COMPLETED",
      { timeoutMs: 90_000, label: "trip completes" },
    );
    const report = await waitFor(
      async () => {
        const r = await prisma.latraReport.findFirst({ where: { tripId: trip.id } });
        return r?.status === "ACKED" ? r : false;
      },
      { timeoutMs: 20_000, label: "LATRA report acked" },
    );

    const p = report.payload as Record<string, unknown>;
    // A real area name, not a bare "lat,lng" coordinate string.
    expect(String(p.pickupPoint)).not.toMatch(/^-?\d+(\.\d+)?,\s*-?\d+/);
    expect(namesWithin600m).toContain(p.pickupPoint);
  });
});

/**
 * LATRA: "the app should not charge a customer when a trip has not started,
 * nor the driver has arrived the pick-up point."
 */
describe("LATRA cancellation policy", () => {
  it("charges nothing when the driver accepted but has not yet arrived", async () => {
    // Driver starts ~1.6 km out, so it is genuinely en route when we cancel.
    const spawned = await spawnDriver({ start: { lat: PICKUP.lat - 0.015, lng: PICKUP.lng } });
    driver = spawned.driver;
    const passenger = passengers[0]!;

    const trip = await rest.createTrip(TEST_API_URL, passenger.token, {
      vehicleClass: VehicleClass.BODABODA,
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: PaymentMethod.CASH,
    });
    await waitFor(
      async () => (await rest.getTrip(TEST_API_URL, passenger.token, trip.id)).status === "ACCEPTED",
      { timeoutMs: 30_000, label: "driver accepts" },
    );
    // Freeze the sim so it cannot reach pickup and flip to ARRIVED mid-assert.
    driver.stop();

    await rest.cancelTrip(TEST_API_URL, passenger.token, trip.id, "changed my mind");

    const row = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(row?.status).toBe("CANCELLED_BY_PASSENGER");
    expect(Number(row?.cancellationFee)).toBe(0);
  });

  it("charges the flat fee once the driver has arrived at the pick-up point", async () => {
    const spawned = await spawnDriver({ start: PICKUP });
    driver = spawned.driver;
    const passenger = passengers[0]!;

    const trip = await rest.createTrip(TEST_API_URL, passenger.token, {
      vehicleClass: VehicleClass.BODABODA,
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: PaymentMethod.CASH,
    });
    await waitFor(
      async () => (await rest.getTrip(TEST_API_URL, passenger.token, trip.id)).status === "ACCEPTED",
      { timeoutMs: 30_000, label: "driver accepts" },
    );
    // Stop the sim, then mark ARRIVED ourselves so the trip parks in ARRIVED
    // instead of auto-starting — a started trip can no longer be cancelled.
    driver.stop();
    await rest.tripAction(TEST_API_URL, spawned.token, trip.id, {
      action: "ARRIVED",
      lat: PICKUP.lat,
      lng: PICKUP.lng,
    });
    await waitFor(
      async () => (await rest.getTrip(TEST_API_URL, passenger.token, trip.id)).status === "ARRIVED",
      { timeoutMs: 15_000, label: "driver arrives" },
    );

    await rest.cancelTrip(TEST_API_URL, passenger.token, trip.id, "changed my mind");

    const row = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(row?.status).toBe("CANCELLED_BY_PASSENGER");
    expect(Number(row?.cancellationFee)).toBe(500);
  });
});
