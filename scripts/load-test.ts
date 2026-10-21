/**
 * NFR load test (spec §15 / §18.6): 300 concurrent online drivers pinging GPS
 * every 3 s (= 100 location msgs/sec), ~60 concurrent active trips sustained,
 * plus an HTTP load loop on hot REST endpoints. Sockets are driven by the
 * simulator; results are measured from the database (dispatch decision
 * latency SEARCHING→first OFFERED) and client-side HTTP timings.
 *
 * Usage:
 *   SEED_SIM_DRIVERS=320 SEED_SIM_PASSENGERS=120 pnpm --filter @rukwaride/api prisma:seed
 *   pnpm --filter @rukwaride/scripts load-test   # ~6 minutes
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PaymentMethod, VehicleClass } from "@rukwaride/shared";
import { api } from "./src/api-client";
import { SUMBAWANGA, loadSimPassengers, scatterPosition, spawnFleet } from "./src/fleet";

const API_URL = process.env.SIM_API_URL ?? "http://localhost:3001";
const DRIVER_COUNT = Number(process.env.LOAD_DRIVERS ?? 300);
const TARGET_ACTIVE_TRIPS = Number(process.env.LOAD_ACTIVE_TRIPS ?? 60);
const PING_MS = Number(process.env.LOAD_PING_MS ?? 3000); // 300 drivers / 3 s = 100 msg/s
const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 300);
const HTTP_RPS = Number(process.env.LOAD_HTTP_RPS ?? 30);

const TRIP_CLASSES = [VehicleClass.BODABODA, VehicleClass.BODABODA, VehicleClass.BAJAJI, VehicleClass.CAR];

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function main() {
  const prisma = new PrismaClient();
  console.log(`Load test: ${DRIVER_COUNT} drivers, ping ${PING_MS} ms, target ${TARGET_ACTIVE_TRIPS} active trips, ${DURATION_S}s`);

  // --- fleet up ---
  const fleet = await spawnFleet(prisma, {
    apiUrl: API_URL,
    count: DRIVER_COUNT,
    behavior: { kind: "accept", delayMs: 2000 },
    spreadM: 4000,
    pingIntervalMs: PING_MS,
    // Fast enough that trips churn and passengers free up, still under the
    // 40 m/s GPS-jump filter.
    speedMps: 20,
  });
  let online = 0;
  for (const d of fleet) {
    await d.goOnline().catch((e) => console.error("goOnline failed:", String(e)));
    if (++online % 50 === 0) console.log(`${online} drivers online…`);
    await new Promise((r) => setTimeout(r, 25));
  }
  console.log(`${fleet.length} drivers online.`);

  const passengers = await loadSimPassengers(prisma, 120);
  if (passengers.length < TARGET_ACTIVE_TRIPS + 20) {
    throw new Error(`Need ≥${TARGET_ACTIVE_TRIPS + 20} sim passengers — reseed with SEED_SIM_PASSENGERS=120`);
  }

  const startedAt = new Date();
  const endAt = Date.now() + DURATION_S * 1000;
  const busyPassengers = new Set<string>();
  let created = 0;
  let createFailed = 0;
  let classRotation = 0;

  // --- trip generator: hold ~TARGET_ACTIVE_TRIPS in flight ---
  const generator = setInterval(() => {
    void (async () => {
      if (Date.now() > endAt) return;
      const active = await prisma.trip.count({
        where: {
          createdAt: { gte: startedAt },
          status: { in: ["REQUESTED", "SEARCHING", "OFFERED", "ACCEPTED", "ARRIVED", "IN_PROGRESS"] },
        },
      });
      const deficit = TARGET_ACTIVE_TRIPS - active;
      for (let i = 0; i < Math.min(deficit, 10); i++) {
        const passenger = passengers.find((p) => !busyPassengers.has(p.userId));
        if (!passenger) break;
        busyPassengers.add(passenger.userId);
        const cls = TRIP_CLASSES[classRotation++ % TRIP_CLASSES.length]!;
        const pickup = scatterPosition(SUMBAWANGA, Math.floor(Math.random() * 40), 40, 3000);
        const drop = scatterPosition(SUMBAWANGA, Math.floor(Math.random() * 40), 40, 4500);
        api
          .createTrip(API_URL, passenger.token, { vehicleClass: cls, pickup, drop, paymentMethod: PaymentMethod.CASH })
          .then(() => created++)
          .catch(() => createFailed++)
          .finally(() => setTimeout(() => busyPassengers.delete(passenger.userId), 90_000));
      }
    })();
  }, 2000);

  // --- HTTP load on hot endpoints (client-side latency record) ---
  const httpLatencies: number[] = [];
  let httpErrors = 0;
  const httpToken = passengers[passengers.length - 1]!.token;
  const httpLoop = setInterval(() => {
    for (let i = 0; i < HTTP_RPS / 5; i++) {
      const target =
        i % 2 === 0
          ? { method: "POST", path: "/trips/estimate", body: { pickup: SUMBAWANGA, drop: { lat: SUMBAWANGA.lat + 0.02, lng: SUMBAWANGA.lng + 0.01 } } }
          : { method: "GET", path: "/landmarks?q=soko", body: undefined };
      const t0 = performance.now();
      void fetch(`${API_URL}${target.path}`, {
        method: target.method,
        headers: { authorization: `Bearer ${httpToken}`, "content-type": "application/json" },
        body: target.body ? JSON.stringify(target.body) : undefined,
      })
        .then((res) => {
          if (!res.ok && res.status !== 429) httpErrors++;
          httpLatencies.push(performance.now() - t0);
          return res.arrayBuffer();
        })
        .catch(() => httpErrors++);
    }
  }, 200);

  // --- progress ---
  const progress = setInterval(() => {
    void (async () => {
      const active = await prisma.trip.count({
        where: { createdAt: { gte: startedAt }, status: { in: ["SEARCHING", "OFFERED", "ACCEPTED", "ARRIVED", "IN_PROGRESS"] } },
      });
      const completed = await prisma.trip.count({ where: { createdAt: { gte: startedAt }, status: "COMPLETED" } });
      console.log(
        `t+${Math.round((Date.now() - (endAt - DURATION_S * 1000)) / 1000)}s  active=${active}  created=${created}  completed=${completed}  httpN=${httpLatencies.length}`,
      );
    })();
  }, 20_000);

  await new Promise((r) => setTimeout(r, DURATION_S * 1000));
  clearInterval(generator);
  clearInterval(httpLoop);
  console.log("Load window over — 45 s grace for in-flight trips…");
  await new Promise((r) => setTimeout(r, 45_000));
  clearInterval(progress);

  // --- results ---
  const trips = await prisma.trip.findMany({
    where: { createdAt: { gte: startedAt } },
    select: { id: true, status: true, searchStartedAt: true },
  });
  const tripIds = trips.map((t) => t.id);
  const offers = await prisma.tripStatusEvent.findMany({
    where: { tripId: { in: tripIds }, toStatus: "OFFERED" },
    orderBy: { at: "asc" },
  });
  const firstOfferByTrip = new Map<string, Date>();
  for (const e of offers) if (!firstOfferByTrip.has(e.tripId)) firstOfferByTrip.set(e.tripId, e.at);

  const decisions: number[] = [];
  for (const t of trips) {
    const offerAt = firstOfferByTrip.get(t.id);
    if (t.searchStartedAt && offerAt) decisions.push((offerAt.getTime() - t.searchStartedAt.getTime()) / 1000);
  }
  decisions.sort((a, b) => a - b);
  httpLatencies.sort((a, b) => a - b);

  const statusCounts: Record<string, number> = {};
  for (const t of trips) statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;

  const metricsText = await (await fetch(`${API_URL}/metrics`)).text();
  const pings = Number(/location_pings_total (\d+)/.exec(metricsText)?.[1] ?? 0);

  const report = {
    config: { drivers: fleet.length, pingMs: PING_MS, targetActive: TARGET_ACTIVE_TRIPS, durationS: DURATION_S },
    trips: { created, createFailed, byStatus: statusCounts },
    dispatchDecisionSeconds: {
      n: decisions.length,
      p50: quantile(decisions, 0.5),
      p95: quantile(decisions, 0.95),
      max: decisions.at(-1),
      target: "p95 < 3s (spec §15)",
      pass: quantile(decisions, 0.95) < 3,
    },
    httpMs: {
      n: httpLatencies.length,
      errors: httpErrors,
      p50: Math.round(quantile(httpLatencies, 0.5)),
      p95: Math.round(quantile(httpLatencies, 0.95)),
      target: "p95 < 300ms (spec §15)",
      pass: quantile(httpLatencies, 0.95) < 300,
    },
    locationPingsTotalOnServer: pings,
  };
  console.log("\n=== LOAD TEST REPORT ===\n" + JSON.stringify(report, null, 2));

  console.log("\nShutting down fleet…");
  for (const d of fleet) d.stop();
  await prisma.$disconnect();
  process.exit(report.dispatchDecisionSeconds.pass && report.httpMs.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
