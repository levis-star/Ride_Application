/**
 * Rider-experience features (Bolt/Uber parity): SOS + share-my-trip, parcel
 * courier trips, quick pre-written messages, and scheduled (book-ahead) rides.
 * Each drives the real API against a live sim driver.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaymentMethod, QuickMessage, Role, TripKind, VehicleClass } from "@rukwaride/shared";
import { api as rest } from "../src/api-client";
import { mintToken } from "../src/auth";
import { loadSimIdentities, loadSimPassengers, SimPassenger } from "../src/fleet";
import { SimDriver } from "../src/sim-driver";
import { TEST_API_URL } from "./global-setup";
import { closeHelpers, prisma, resetWorld, waitFor } from "./helpers";

const CENTER = { lat: -7.9667, lng: 31.6167 };
const PICKUP = { lat: CENTER.lat + 0.001, lng: CENTER.lng };
const DROP = { lat: CENTER.lat + 0.005, lng: CENTER.lng + 0.002 };

let drivers: SimDriver[] = [];
let passengers: SimPassenger[] = [];

async function spawnDriver(): Promise<{ driver: SimDriver; token: string }> {
  const [identity] = await loadSimIdentities(prisma, 1, VehicleClass.BODABODA);
  const token = mintToken({ sub: identity!.userId, role: Role.DRIVER, driverProfileId: identity!.driverProfileId });
  const driver = new SimDriver({
    apiUrl: TEST_API_URL,
    token,
    identity: identity!,
    start: { lat: PICKUP.lat + 0.001, lng: PICKUP.lng },
    behavior: { kind: "accept", delayMs: 400 },
    pingIntervalMs: 1000,
    speedMps: 30,
    idleDriftM: 0,
  });
  await driver.goOnline();
  drivers.push(driver);
  await new Promise((r) => setTimeout(r, 1500));
  return { driver, token };
}

async function req(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  const isGet = method === "GET" || method === "HEAD";
  return fetch(`${TEST_API_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: isGet ? undefined : body === undefined ? "{}" : JSON.stringify(body),
  });
}

async function adminToken(): Promise<string> {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  return mintToken({ sub: admin!.id, role: Role.ADMIN });
}

/** Create a normal ride and wait until the sim driver has accepted it. */
async function acceptedTrip(passenger: SimPassenger): Promise<string> {
  const trip = await rest.createTrip(TEST_API_URL, passenger.token, {
    vehicleClass: VehicleClass.BODABODA,
    pickup: PICKUP,
    drop: DROP,
    paymentMethod: PaymentMethod.CASH,
  });
  await waitFor(
    async () => {
      const t = await rest.getTrip(TEST_API_URL, passenger.token, trip.id);
      return ["ACCEPTED", "ARRIVED", "IN_PROGRESS"].includes(t.status) ? t : false;
    },
    { timeoutMs: 20_000, label: "trip accepted" },
  );
  return trip.id;
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
afterAll(closeHelpers);

describe("SOS + share-my-trip", () => {
  it("passenger raises SOS → dispatcher sees it, acknowledges, resolves", async () => {
    await spawnDriver();
    const tripId = await acceptedTrip(passengers[0]!);

    const raise = await req(passengers[0]!.token, "POST", `/trips/${tripId}/sos`, {
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      note: "driver took a wrong turn",
    });
    expect(raise.status).toBe(201);
    const alert = (await raise.json()) as { id: string; status: string };
    expect(alert.status).toBe("OPEN");

    const admin = await adminToken();
    const list = (await (await req(admin, "GET", "/dispatch/sos-alerts")).json()) as {
      id: string;
      status: string;
      raisedByRole: string;
      driver?: { plateNumber: string } | null;
    }[];
    const found = list.find((a) => a.id === alert.id)!;
    expect(found).toBeTruthy();
    expect(found.raisedByRole).toBe("PASSENGER");
    expect(found.driver?.plateNumber).toBeTruthy(); // dispatcher sees who the driver is

    expect((await req(admin, "POST", `/dispatch/sos-alerts/${alert.id}/ack`)).status).toBe(201);
    let row = await prisma.sosAlert.findUnique({ where: { id: alert.id } });
    expect(row!.status).toBe("ACKNOWLEDGED");
    expect(row!.acknowledgedAt).not.toBeNull();

    expect(
      (await req(admin, "POST", `/dispatch/sos-alerts/${alert.id}/resolve`, { resolutionNote: "welfare call ok" }))
        .status,
    ).toBe(201);
    row = await prisma.sosAlert.findUnique({ where: { id: alert.id } });
    expect(row!.status).toBe("RESOLVED");
  });

  it("driver can also raise SOS; a stranger cannot raise on someone else's trip", async () => {
    const { token: driverToken } = await spawnDriver();
    const tripId = await acceptedTrip(passengers[0]!);

    expect((await req(driverToken, "POST", `/trips/${tripId}/sos`, {})).status).toBe(201);
    // A different passenger has no relation to this trip.
    expect((await req(passengers[1]!.token, "POST", `/trips/${tripId}/sos`, {})).status).toBe(403);
  });

  it("share link exposes vehicle + live position but no passenger PII, and 404s on bad token", async () => {
    await spawnDriver();
    const tripId = await acceptedTrip(passengers[0]!);

    const shareRes = await req(passengers[0]!.token, "POST", `/trips/${tripId}/share`);
    expect(shareRes.status).toBe(201);
    const { token: shareToken, url } = (await shareRes.json()) as { token: string; url: string };
    expect(shareToken).toBeTruthy();
    expect(url).toContain(shareToken);

    // Public — no auth header.
    const view = await fetch(`${TEST_API_URL}/public/trips/${shareToken}`);
    expect(view.status).toBe(200);
    const body = (await view.json()) as Record<string, unknown>;
    expect(body.driver).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(passengers[0]!.phone); // no passenger phone leaked
    expect(body).not.toHaveProperty("passengerId");

    expect((await fetch(`${TEST_API_URL}/public/trips/does-not-exist`)).status).toBe(404);
  });
});

describe("parcel courier trips", () => {
  it("creates, dispatches and completes a parcel trip with recipient details", async () => {
    const { driver } = await spawnDriver();
    const trip = await rest.createTrip(TEST_API_URL, passengers[0]!.token, {
      vehicleClass: VehicleClass.BODABODA,
      kind: TripKind.PARCEL,
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: PaymentMethod.CASH,
      recipient: { name: "Aisha Mrisho", phone: "+255766111222" },
      packageNote: "documents envelope",
    });

    const snap = await rest.getTrip(TEST_API_URL, passengers[0]!.token, trip.id);
    expect(snap.kind).toBe("PARCEL");
    expect(snap.recipient).toMatchObject({ name: "Aisha Mrisho", phone: "+255766111222" });

    await waitFor(
      async () => (await rest.getTrip(TEST_API_URL, passengers[0]!.token, trip.id)).status === "COMPLETED",
      { timeoutMs: 90_000, label: "parcel completed" },
    );
    // The trip's status flips when the COMPLETE transaction commits, but the
    // sim only records it once that request's response lands — wait for the
    // driver side rather than racing it.
    await waitFor(async () => driver.completedTrips.includes(trip.id), {
      timeoutMs: 10_000,
      label: "sim driver records completion",
    });
    // Cash ledger booked like any trip.
    const entries = await prisma.ledgerEntry.count({ where: { tripId: trip.id } });
    expect(entries).toBeGreaterThan(0);
  });

  it("rejects a parcel trip with no recipient", async () => {
    const res = await req(passengers[0]!.token, "POST", "/trips", {
      vehicleClass: VehicleClass.BODABODA,
      kind: TripKind.PARCEL,
      pickup: PICKUP,
      drop: DROP,
    });
    expect(res.status).toBe(400);
  });
});

describe("quick messages", () => {
  it("relays a passenger message to the driver and a driver message to the passenger", async () => {
    const { driver, token: driverToken } = await spawnDriver();
    const tripId = await acceptedTrip(passengers[0]!);

    const sent = await req(passengers[0]!.token, "POST", `/trips/${tripId}/message`, {
      message: QuickMessage.WAIT_5_MIN,
    });
    expect(sent.status).toBe(201);
    await waitFor(async () => driver.receivedMessages.some((m) => m.tripId === tripId) || false, {
      timeoutMs: 5000,
      label: "driver received quick message",
    });
    expect(driver.receivedMessages[0]).toMatchObject({ message: "WAIT_5_MIN", from: "PASSENGER" });

    // Driver → passenger direction is accepted by the API.
    expect(
      (await req(driverToken, "POST", `/trips/${tripId}/message`, { message: QuickMessage.ARRIVED_OUTSIDE }))
        .status,
    ).toBe(201);

    // A stranger cannot message on this trip.
    expect(
      (await req(passengers[1]!.token, "POST", `/trips/${tripId}/message`, { message: QuickMessage.OK_THANKS }))
        .status,
    ).toBe(403);
  });

  /**
   * "Naja sasa hivi" / "Nipo nje" / "Nipigie simu" are the DRIVER telling the
   * passenger what is happening. A waiting passenger was being offered them,
   * which reads backwards. The server enforces the split so hiding the buttons
   * is not the only defence.
   */
  it("rejects driver-only phrases sent by a passenger, and passenger-only phrases by a driver", async () => {
    const { token: driverToken } = await spawnDriver();
    const tripId = await acceptedTrip(passengers[0]!);

    for (const message of [QuickMessage.ON_MY_WAY, QuickMessage.ARRIVED_OUTSIDE, QuickMessage.CALL_ME]) {
      const res = await req(passengers[0]!.token, "POST", `/trips/${tripId}/message`, { message });
      expect(res.status, `passenger must not send ${message}`).toBe(403);
    }

    // …and the driver cannot send the passenger's acknowledgement.
    expect(
      (await req(driverToken, "POST", `/trips/${tripId}/message`, { message: QuickMessage.OK_THANKS })).status,
    ).toBe(403);

    // WAIT_5_MIN reads naturally either way, so both parties may send it.
    expect(
      (await req(passengers[0]!.token, "POST", `/trips/${tripId}/message`, { message: QuickMessage.WAIT_5_MIN }))
        .status,
    ).toBe(201);
    expect(
      (await req(driverToken, "POST", `/trips/${tripId}/message`, { message: QuickMessage.WAIT_5_MIN })).status,
    ).toBe(201);
  });
});

describe("scheduled rides", () => {
  it("holds a future booking in SCHEDULED, then promotes it to be picked up", async () => {
    await spawnDriver();
    const scheduledAt = new Date(Date.now() + 3000);
    const trip = await rest.createTrip(TEST_API_URL, passengers[0]!.token, {
      vehicleClass: VehicleClass.BODABODA,
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: PaymentMethod.CASH,
      scheduledAt,
    });

    // Immediately: parked in SCHEDULED, not dispatching.
    const early = await rest.getTrip(TEST_API_URL, passengers[0]!.token, trip.id);
    expect(early.status).toBe("SCHEDULED");
    expect(early.scheduledAt).toBeTruthy();

    // After the scheduled time the promoter moves it into dispatch → accepted.
    await waitFor(
      async () => {
        const t = await rest.getTrip(TEST_API_URL, passengers[0]!.token, trip.id);
        return ["ACCEPTED", "ARRIVED", "IN_PROGRESS", "COMPLETED"].includes(t.status) ? t : false;
      },
      { timeoutMs: 30_000, label: "scheduled trip promoted and accepted" },
    );
  });

  it("a scheduled trip can be cancelled before promotion", async () => {
    const scheduledAt = new Date(Date.now() + 60_000);
    const trip = await rest.createTrip(TEST_API_URL, passengers[0]!.token, {
      vehicleClass: VehicleClass.BODABODA,
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: PaymentMethod.CASH,
      scheduledAt,
    });
    expect((await rest.getTrip(TEST_API_URL, passengers[0]!.token, trip.id)).status).toBe("SCHEDULED");

    const cancel = await req(passengers[0]!.token, "POST", `/trips/${trip.id}/cancel`, {});
    expect(cancel.status).toBe(201);
    expect((await rest.getTrip(TEST_API_URL, passengers[0]!.token, trip.id)).status).toBe("CANCELLED_BY_PASSENGER");
  });

  it("a past scheduledAt is treated as book-now (dispatches immediately)", async () => {
    await spawnDriver();
    const trip = await rest.createTrip(TEST_API_URL, passengers[0]!.token, {
      vehicleClass: VehicleClass.BODABODA,
      pickup: PICKUP,
      drop: DROP,
      paymentMethod: PaymentMethod.CASH,
      scheduledAt: new Date(Date.now() - 1000),
    });
    const t = await rest.getTrip(TEST_API_URL, passengers[0]!.token, trip.id);
    expect(["SEARCHING", "OFFERED", "ACCEPTED"]).toContain(t.status);
  });
});
