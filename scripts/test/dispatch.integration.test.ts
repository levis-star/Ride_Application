/**
 * Dispatch engine integration tests (spec §16): real API instance, real Redis,
 * real Postgres, virtual drivers from the simulator. Scenarios: full
 * lifecycle, cascade on decline, offer timeout, lock contention (two trips /
 * one driver), stale-driver exclusion, accept idempotency.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { LatLng, PaymentMethod, Role, VehicleClass } from "@rukwaride/shared";
import { api } from "../src/api-client";
import { mintToken } from "../src/auth";
import { loadSimIdentities, loadSimPassengers, SimPassenger } from "../src/fleet";
import { OfferBehavior, SimDriver } from "../src/sim-driver";
import { TEST_API_URL, TEST_DISPATCH } from "./global-setup";
import { closeHelpers, prisma, redis, resetWorld, waitFor } from "./helpers";

const CENTER: LatLng = { lat: -7.9667, lng: 31.6167 };
const PICKUP: LatLng = { lat: CENTER.lat + 0.001, lng: CENTER.lng };
const DROP: LatLng = { lat: CENTER.lat + 0.006, lng: CENTER.lng + 0.002 };

/** Offset a point ~metres north (1 deg lat ≈ 111.195 km). */
function north(p: LatLng, m: number): LatLng {
  return { lat: p.lat + m / 111_195, lng: p.lng };
}

let activeDrivers: SimDriver[] = [];
let passengers: SimPassenger[] = [];

async function makeDrivers(
  positions: LatLng[],
  behavior: OfferBehavior,
): Promise<SimDriver[]> {
  const identities = await loadSimIdentities(prisma, positions.length, VehicleClass.BODABODA);
  expect(identities.length).toBe(positions.length);
  const drivers = identities.map(
    (identity, i) =>
      new SimDriver({
        apiUrl: TEST_API_URL,
        token: mintToken({ sub: identity.userId, role: Role.DRIVER, driverProfileId: identity.driverProfileId }),
        identity,
        start: positions[i]!,
        behavior,
        pingIntervalMs: 1000,
        speedMps: 30,
        idleDriftM: 0,
        log: process.env.TEST_API_LOGS ? (l) => console.log(l) : undefined,
      }),
  );
  for (const d of drivers) await d.goOnline();
  activeDrivers.push(...drivers);
  // Let first pings land in Redis GEO before any trip is created.
  await new Promise((r) => setTimeout(r, 1500));
  return drivers;
}

function createTrip(passenger: SimPassenger, pickup = PICKUP, drop = DROP) {
  return api.createTrip(TEST_API_URL, passenger.token, {
    vehicleClass: VehicleClass.BODABODA,
    pickup,
    drop,
    paymentMethod: PaymentMethod.CASH,
  });
}

function tripStatus(passenger: SimPassenger, tripId: string) {
  return api.getTrip(TEST_API_URL, passenger.token, tripId);
}

beforeEach(async () => {
  await resetWorld();
  passengers = await loadSimPassengers(prisma, 4);
  expect(passengers.length).toBeGreaterThanOrEqual(4);
});

afterEach(async () => {
  for (const d of activeDrivers) d.stop();
  activeDrivers = [];
  await resetWorld();
});

afterAll(async () => {
  await closeHelpers();
});

describe("dispatch engine", () => {
  it("runs the full lifecycle: search → offer → accept → arrive → start → complete, with balanced ledger", async () => {
    const [driver] = await makeDrivers([north(PICKUP, 200)], { kind: "accept", delayMs: 500 });
    const trip = await createTrip(passengers[0]!);

    // Dispatch decision NFR (spec §15): SEARCHING → OFFERED must be fast.
    const offeredAt = await waitFor(
      async () => ((await tripStatus(passengers[0]!, trip.id)).status !== "SEARCHING" ? Date.now() : false),
      { timeoutMs: 5000, intervalMs: 100, label: "first offer" },
    );
    expect(offeredAt).toBeDefined();

    const final = await waitFor(
      async () => {
        const t = await tripStatus(passengers[0]!, trip.id);
        return t.status === "COMPLETED" ? t : false;
      },
      { timeoutMs: 90_000, label: "trip completion" },
    );

    expect(final.driverId).toBe(driver!.id);
    expect(final.finalFare).toBeGreaterThan(0);
    expect(final.finalFare! % 100).toBe(0); // rounded to nearest 100 TZS
    const breakdown = final.fareBreakdown as {
      total: number;
      commission: number;
      bookingFee: number;
      driverEarnings: number;
    };
    expect(breakdown.driverEarnings + breakdown.commission + breakdown.bookingFee).toBe(breakdown.total);

    // Cash settlement: one Payment + a balanced ledger txn (spec §9/§16).
    const payment = await prisma.payment.findUnique({
      where: { idempotencyKey: `trip-${trip.id}-cash-settlement` },
    });
    expect(payment?.status).toBe("CONFIRMED");
    const entries = await prisma.ledgerEntry.findMany({ where: { tripId: trip.id } });
    expect(entries.length).toBe(4);
    const sum = entries.reduce((s, e) => s + Number(e.debit) - Number(e.credit), 0);
    expect(sum).toBe(0);

    // Driver is AVAILABLE again and their GPS trace was recorded.
    await waitFor(
      async () =>
        (await prisma.driverProfile.findUnique({ where: { id: driver!.id } }))?.status === "AVAILABLE",
      { timeoutMs: 5000, label: "driver available after completion" },
    );
    const points = await prisma.tripLocationPoint.count({ where: { tripId: trip.id } });
    expect(points).toBeGreaterThan(0);
  });

  it("cascades to the next candidate when drivers decline", async () => {
    // Three drivers at increasing distance; the closest two decline.
    const drivers = await makeDrivers(
      [north(PICKUP, 100), north(PICKUP, 400), north(PICKUP, 800)],
      { kind: "decline", delayMs: 400 },
    );
    drivers[2]!.behavior = { kind: "accept", delayMs: 400 };

    const trip = await createTrip(passengers[0]!);
    const final = await waitFor(
      async () => {
        const t = await tripStatus(passengers[0]!, trip.id);
        return t.status === "ACCEPTED" || t.status === "ARRIVED" || t.status === "IN_PROGRESS" ? t : false;
      },
      { timeoutMs: 30_000, label: "third driver accepts" },
    );

    expect(final.driverId).toBe(drivers[2]!.id);
    // Cascade order followed ETA ranking: closest first.
    expect(final.offeredDriverIds).toEqual([drivers[0]!.id, drivers[1]!.id, drivers[2]!.id]);
    expect(drivers[0]!.declinedOffers).toBe(1);
    expect(drivers[1]!.declinedOffers).toBe(1);
  });

  it("expires an ignored offer via the server-side TTL and moves on; trip EXPIRES when cascade exhausts", async () => {
    const drivers = await makeDrivers([north(PICKUP, 100), north(PICKUP, 300)], { kind: "ignore" });

    const trip = await createTrip(passengers[0]!);
    const final = await waitFor(
      async () => {
        const t = await tripStatus(passengers[0]!, trip.id);
        return t.status === "EXPIRED" ? t : false;
      },
      { timeoutMs: (TEST_DISPATCH.maxSearchS + 20) * 1000, label: "trip expiry" },
    );

    // Each driver was offered exactly once and saw the TIMEOUT withdrawal.
    expect(final.offeredDriverIds.sort()).toEqual([drivers[0]!.id, drivers[1]!.id].sort());
    for (const d of drivers) {
      expect(d.receivedOffers.length).toBe(1);
      expect(d.events.some((e) => e.event === "offer:withdrawn")).toBe(true);
    }
    // Locks are released after the cascade.
    for (const d of drivers) {
      expect(await redis.get(`lock:driver:${d.id}`)).toBeNull();
    }
  });

  it("never double-books one driver across two concurrent trips (lock contention)", async () => {
    // One driver, two simultaneous trips. Depending on timing the second trip
    // either EXPIRES, or is legally served AFTER the first completes (the
    // driver frees up within its search budget). Both outcomes are valid; the
    // invariant is that the driver never holds two offers/trips at once.
    const [driver] = await makeDrivers([north(PICKUP, 150)], { kind: "accept", delayMs: 800 });

    const [tripA, tripB] = await Promise.all([
      createTrip(passengers[0]!),
      createTrip(passengers[1]!, north(PICKUP, 50), DROP),
    ]);

    const settled = await waitFor(
      async () => {
        const [a, b] = await Promise.all([
          tripStatus(passengers[0]!, tripA.id),
          tripStatus(passengers[1]!, tripB.id),
        ]);
        const terminal = (s: string) => s === "COMPLETED" || s === "EXPIRED";
        return terminal(a.status) && terminal(b.status) ? { a, b } : false;
      },
      { timeoutMs: 180_000, label: "both trips terminal" },
    );

    // At least one trip was served; nothing hangs in limbo.
    expect([settled.a.status, settled.b.status]).toContain("COMPLETED");

    // Core invariant: the driver's busy windows (OFFERED → terminal-for-them)
    // never overlap across the two trips.
    const events = await prisma.tripStatusEvent.findMany({
      where: { tripId: { in: [tripA.id, tripB.id] } },
      orderBy: { at: "asc" },
    });
    const windows: Array<{ tripId: string; from: number; to: number }> = [];
    for (const tripId of [tripA.id, tripB.id]) {
      const mine = events.filter((e) => e.tripId === tripId);
      const offered = mine.find((e) => e.toStatus === "OFFERED");
      if (!offered) continue;
      const released = mine.find(
        (e) => offered.at <= e.at && ["COMPLETED", "EXPIRED", "SEARCHING"].includes(e.toStatus) && e.fromStatus !== "REQUESTED",
      );
      windows.push({
        tripId,
        from: offered.at.getTime(),
        to: (released ?? mine[mine.length - 1]!).at.getTime(),
      });
    }
    if (windows.length === 2) {
      const [w1, w2] = windows.sort((a, b) => a.from - b.from);
      expect(w2!.from).toBeGreaterThanOrEqual(w1!.to);
    }

    // And every offer the driver saw was for one trip at a time (no
    // interleaving): offers arrive grouped by trip.
    const sequence = driver!.receivedOffers.map((o) => o.tripId);
    const collapsed = sequence.filter((id, i) => sequence[i - 1] !== id);
    expect(new Set(collapsed).size).toBe(collapsed.length);
  });

  it("excludes drivers with stale pings from matching (spec: silent > staleExcludeS)", async () => {
    // A is closest but goes silent; B keeps pinging.
    const [driverA, driverB] = await makeDrivers(
      [north(PICKUP, 100), north(PICKUP, 900)],
      { kind: "accept", delayMs: 500 },
    );
    driverA!.muted = true;
    await new Promise((r) => setTimeout(r, (TEST_DISPATCH.staleExcludeS + 2) * 1000));

    const trip = await createTrip(passengers[0]!);
    const final = await waitFor(
      async () => {
        const t = await tripStatus(passengers[0]!, trip.id);
        return t.driverId !== null ? t : false;
      },
      { timeoutMs: 20_000, label: "fresh driver assigned" },
    );

    expect(final.driverId).toBe(driverB!.id);
    expect(driverA!.receivedOffers.length).toBe(0);
  });

  it("treats a repeated accept as idempotent success and rejects a stale accept", async () => {
    const [driver] = await makeDrivers([north(PICKUP, 200)], { kind: "accept", delayMs: 300 });
    const trip = await createTrip(passengers[0]!);

    await waitFor(
      async () => (await tripStatus(passengers[0]!, trip.id)).driverId !== null,
      { timeoutMs: 15_000, label: "accept" },
    );
    const offer = driver!.receivedOffers[0]!;

    // Same driver repeats the accept → no-op success (spec §6 idempotency).
    const repeat = await driver!.emitAccept(offer.tripId, offer.offerSeq);
    expect(repeat.ok).toBe(true);

    // A stale/madeup accept for another trip id fails safely.
    const bogus = await driver!.emitAccept("nonexistent-trip", 1);
    expect(bogus.ok).toBe(false);
  });
});
