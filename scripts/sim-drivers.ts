/**
 * Fake-driver simulator (spec §18 phase 2) — N virtual drivers that go online,
 * ping GPS on the real cadence, accept/decline offers, and drive trips end to
 * end. This is the primary test harness for the dispatch engine and the socket
 * load generator for §15 NFR checks.
 *
 * Usage:
 *   pnpm sim -- --drivers 10 [--class BODABODA] [--behavior accept|decline|ignore|mixed]
 *              [--accept-delay 3000] [--spread 2000] [--ping 5000]
 *              [--api http://localhost:3001] [--trips 0]
 *
 * --trips N > 0 additionally creates N passenger trips (one every 10 s) so the
 * whole dispatch → complete loop runs without a separate client.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PaymentMethod, VehicleClass } from "@rukwaride/shared";
import { api } from "./src/api-client";
import { SUMBAWANGA, loadSimPassengers, scatterPosition, spawnFleet } from "./src/fleet";
import { OfferBehavior } from "./src/sim-driver";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const apiUrl = arg("api", process.env.SIM_API_URL ?? "http://localhost:3001")!;
  const count = Number(arg("drivers", "10"));
  const vehicleClass = arg("class") as VehicleClass | undefined;
  const behaviorKind = arg("behavior", "accept")!;
  const acceptDelay = Number(arg("accept-delay", "3000"));
  const spreadM = Number(arg("spread", "2000"));
  const pingIntervalMs = Number(arg("ping", "5000"));
  const tripCount = Number(arg("trips", "0"));
  const speedArg = arg("speed");
  const speedMps = speedArg === undefined ? undefined : Number(speedArg);
  // Long-running fleets (demo) must not reuse the identities the integration
  // tests grab (the first few) — shared IDs fight over the same Redis GEO.
  const identityOffset = Number(arg("offset", "0"));

  const prisma = new PrismaClient();
  const behaviorFor = (i: number): OfferBehavior => {
    switch (behaviorKind) {
      case "decline":
        return { kind: "decline", delayMs: acceptDelay };
      case "ignore":
        return { kind: "ignore" };
      case "mixed":
        // 60% accept, 25% decline, 15% ignore — roughly what a real fleet does.
        return i % 20 < 12
          ? { kind: "accept", delayMs: acceptDelay }
          : i % 20 < 17
            ? { kind: "decline", delayMs: acceptDelay }
            : { kind: "ignore" };
      default:
        return { kind: "accept", delayMs: acceptDelay };
    }
  };

  console.log(`Spawning ${count} sim drivers against ${apiUrl} (behavior=${behaviorKind})`);
  const fleet = await spawnFleet(prisma, {
    apiUrl,
    count,
    vehicleClass,
    spreadM,
    pingIntervalMs,
    speedMps,
    // Follow real roads when OSRM is configured (set OSRM_URL, or pass --osrm).
    osrmUrl: arg("osrm", process.env.OSRM_URL || undefined),
    identityOffset,
    log: (line) => console.log(new Date().toISOString(), line),
  });
  fleet.forEach((d, i) => (d.behavior = behaviorFor(i)));

  // One driver failing (e.g. left ON_TRIP by an aborted run) must not kill the fleet.
  let online = 0;
  for (const driver of fleet) {
    try {
      await driver.goOnline();
      online++;
    } catch (e) {
      console.error(`driver failed to go online — skipped: ${String(e)}`);
    }
    await new Promise((r) => setTimeout(r, 150)); // stagger connects
  }
  if (online === 0) throw new Error("no drivers could go online");
  console.log(`${online}/${fleet.length} drivers online. Ctrl-C to stop.`);

  let tripTimer: NodeJS.Timeout | undefined;
  if (tripCount > 0) {
    // Round-robin passengers — one passenger may only hold one active trip.
    const simPassengers = await loadSimPassengers(prisma, 10);
    if (simPassengers.length === 0) throw new Error("No sim passengers — run the seed");
    let created = 0;
    tripTimer = setInterval(async () => {
      if (created >= tripCount) {
        clearInterval(tripTimer);
        return;
      }
      created++;
      const passenger = simPassengers[created % simPassengers.length]!;
      const pickup = scatterPosition(SUMBAWANGA, created * 3, 20, 1500);
      const drop = scatterPosition(SUMBAWANGA, created * 7 + 5, 20, 3000);
      try {
        const trip = await api.createTrip(apiUrl, passenger.token, {
          vehicleClass: (vehicleClass ?? VehicleClass.BODABODA) as VehicleClass,
          pickup,
          drop,
          paymentMethod: PaymentMethod.CASH,
        });
        console.log(`>>> created trip ${trip.id} (est ${trip.estimatedFare} TZS)`);
      } catch (e) {
        console.error(">>> trip creation failed:", String(e));
      }
    }, 10_000);
  }

  const shutdown = async () => {
    console.log("\nShutting down fleet…");
    if (tripTimer) clearInterval(tripTimer);
    await Promise.allSettled(fleet.map((d) => d.goOffline()));
    await prisma.$disconnect();
    const completed = fleet.reduce((n, d) => n + d.completedTrips.length, 0);
    const offers = fleet.reduce((n, d) => n + d.receivedOffers.length, 0);
    console.log(`Summary: ${offers} offers received, ${completed} trips completed.`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
