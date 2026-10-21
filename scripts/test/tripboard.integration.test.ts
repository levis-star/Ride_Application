/**
 * Trip board integration tests: nearby AVAILABLE drivers are told about a
 * passenger still searching (tripboard:new), can list claimable trips, and
 * can claim one — with the server refusing claims that race the offer
 * cascade (trip OFFERED/ACCEPTED) or come from ineligible drivers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { LatLng, PaymentMethod, Role, TripBoardItemDto, VehicleClass } from "@rukwaride/shared";
import { api } from "../src/api-client";
import { mintToken } from "../src/auth";
import { loadSimIdentities, loadSimPassengers, SimPassenger } from "../src/fleet";
import { OfferBehavior, SimDriver } from "../src/sim-driver";
import { TEST_API_URL, TEST_DISPATCH } from "./global-setup";
import { closeHelpers, prisma, resetWorld, waitFor } from "./helpers";

const CENTER = { lat: -7.9667, lng: 31.6167 };
const PICKUP = { lat: CENTER.lat + 0.001, lng: CENTER.lng };
const DROP = { lat: CENTER.lat + 0.005, lng: CENTER.lng + 0.002 };

/** Offset a point ~metres north (1 deg lat ≈ 111.195 km). */
function north(p: LatLng, m: number): LatLng {
  return { lat: p.lat + m / 111_195, lng: p.lng };
}

let activeDrivers: SimDriver[] = [];
let passengers: SimPassenger[] = [];
const tokens = new Map<string, string>(); // driverProfileId → bearer

async function makeDrivers(
  positions: LatLng[],
  behavior: OfferBehavior,
  vehicleClass = VehicleClass.BODABODA,
): Promise<SimDriver[]> {
  const identities = await loadSimIdentities(prisma, positions.length, vehicleClass);
  expect(identities.length).toBe(positions.length);
  const drivers = identities.map((identity, i) => {
    const token = mintToken({ sub: identity.userId, role: Role.DRIVER, driverProfileId: identity.driverProfileId });
    tokens.set(identity.driverProfileId, token);
    return new SimDriver({
      apiUrl: TEST_API_URL,
      token,
      identity,
      start: positions[i]!,
      behavior,
      pingIntervalMs: 1000,
      speedMps: 30,
      idleDriftM: 0,
    });
  });
  for (const d of drivers) await d.goOnline();
  activeDrivers.push(...drivers);
  await new Promise((r) => setTimeout(r, 1500)); // first pings land in GEO
  return drivers;
}

const driverToken = (d: SimDriver): string => tokens.get(d.id)!;

function createTrip(passenger: SimPassenger, vehicleClass: VehicleClass = VehicleClass.BODABODA) {
  return api.createTrip(TEST_API_URL, passenger.token, {
    vehicleClass,
    pickup: PICKUP,
    drop: DROP,
    paymentMethod: PaymentMethod.CASH,
  });
}

async function board(d: SimDriver): Promise<TripBoardItemDto[]> {
  const res = await fetch(`${TEST_API_URL}/drivers/me/trip-board`, {
    headers: { authorization: `Bearer ${driverToken(d)}` },
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as TripBoardItemDto[];
}

async function claim(d: SimDriver, tripId: string): Promise<Response> {
  return fetch(`${TEST_API_URL}/drivers/me/trip-board/${tripId}/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${driverToken(d)}`, "content-type": "application/json" },
    body: "{}",
  });
}

beforeEach(async () => {
  await resetWorld();
  passengers = await loadSimPassengers(prisma, 2);
});

afterEach(async () => {
  for (const d of activeDrivers) d.stop();
  activeDrivers = [];
  await resetWorld();
});

afterAll(async () => {
  await closeHelpers();
});

describe("trip board", () => {
  it("notifies nearby AVAILABLE drivers and lists the searching trip on their board", async () => {
    // Closest driver gets the direct offer; the further one gets tripboard:new.
    const [nearest, other] = await makeDrivers([north(PICKUP, 100), north(PICKUP, 600)], {
      kind: "ignore",
    });
    const trip = await createTrip(passengers[0]!);

    await waitFor(
      async () => other!.receivedBoardItems.some((i) => i.tripId === trip.id) || false,
      { timeoutMs: 10_000, label: "other driver receives tripboard:new" },
    );
    const item = other!.receivedBoardItems.find((i) => i.tripId === trip.id)!;
    expect(item.distanceToPickupM).toBeGreaterThan(300);
    expect(item.vehicleClass).toBe(VehicleClass.BODABODA);

    // The direct-offer target got a real offer, not a board ping.
    await waitFor(async () => nearest!.receivedOffers.length > 0 || false, {
      timeoutMs: 10_000,
      label: "nearest got the direct offer",
    });
    expect(nearest!.receivedBoardItems.some((i) => i.tripId === trip.id)).toBe(false);

    // While the offer is out (trip OFFERED) a claim is refused…
    const early = await claim(other!, trip.id);
    expect(early.status).toBe(409);
  });

  it("a driver who declined the cascade can still claim while the trip keeps searching", async () => {
    const [driver] = await makeDrivers([north(PICKUP, 100)], { kind: "decline", delayMs: 300 });
    const trip = await createTrip(passengers[0]!);

    // Cascade exhausts (single driver declined) → trip sits in SEARCHING.
    await waitFor(
      async () => {
        if (driver!.declinedOffers === 0) return false;
        const t = await api.getTrip(TEST_API_URL, passengers[0]!.token, trip.id);
        return t.status === "SEARCHING" ? t : false;
      },
      { timeoutMs: 10_000, label: "trip back to SEARCHING after decline" },
    );

    // The board still shows it to the (AVAILABLE again) driver, who claims it.
    await waitFor(
      async () => (await board(driver!)).some((i) => i.tripId === trip.id) || false,
      { timeoutMs: 5000, label: "trip on the board" },
    );
    const res = await claim(driver!, trip.id);
    expect(res.status).toBe(201);
    const result = (await res.json()) as { ok: boolean; trip?: { tripId: string; status: string } };
    expect(result.ok).toBe(true);
    expect(result.trip?.status).toBe("ACCEPTED");

    const t = await api.getTrip(TEST_API_URL, passengers[0]!.token, trip.id);
    expect(t.status).toBe("ACCEPTED");
    expect(t.driverId).toBe(driver!.id);

    // Trip is off the board once taken; a second claim is refused.
    const again = await claim(driver!, trip.id);
    expect(again.status).toBe(409);
  });

  it("refuses ineligible claims: wrong class, busy driver; board filters by class", async () => {
    const [boda] = await makeDrivers([north(PICKUP, 100)], { kind: "decline", delayMs: 300 });
    // A BAJAJI trip with no bajaji drivers online keeps searching.
    const bajajiTrip = await createTrip(passengers[0]!, VehicleClass.BAJAJI);
    await new Promise((r) => setTimeout(r, 1000));

    // Wrong vehicle class → 400, and it never shows on a bodaboda's board.
    const wrongClass = await claim(boda!, bajajiTrip.id);
    expect(wrongClass.status).toBe(400);
    expect((await board(boda!)).some((i) => i.tripId === bajajiTrip.id)).toBe(false);

    // Free the passenger, put the boda driver on a real trip, then have the
    // busy driver try to claim a new searching trip.
    await api.cancelTrip(TEST_API_URL, passengers[0]!.token, bajajiTrip.id);
    boda!.behavior = { kind: "accept", delayMs: 200 };
    const bodaTrip = await createTrip(passengers[1]!);
    await waitFor(
      async () =>
        (await api.getTrip(TEST_API_URL, passengers[1]!.token, bodaTrip.id)).status === "ACCEPTED" || false,
      { timeoutMs: 15_000, label: "boda driver accepted own trip" },
    );
    const secondBoda = await createTrip(passengers[0]!, VehicleClass.BODABODA);
    const busy = await claim(boda!, secondBoda.id);
    expect(busy.status).toBe(409); // ON_TRIP, not AVAILABLE
  });
});
