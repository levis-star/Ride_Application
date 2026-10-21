/**
 * End-to-end smoke: 3 sim drivers online → passenger books → offer → accept →
 * drive to pickup → ARRIVED → START → drive → COMPLETE → final fare.
 * Time-compressed (1 s pings, 30 m/s) but the same code paths as production.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PaymentMethod, VehicleClass } from "@rukwaride/shared";
import { api } from "./src/api-client";
import { SUMBAWANGA, loadSimPassengers, spawnFleet } from "./src/fleet";

const API = process.env.SIM_API_URL ?? "http://localhost:3001";

async function main() {
  const prisma = new PrismaClient();
  const fleet = await spawnFleet(prisma, {
    apiUrl: API,
    count: 3,
    vehicleClass: VehicleClass.BODABODA,
    behavior: { kind: "accept", delayMs: 1000 },
    spreadM: 400,
    pingIntervalMs: 1000,
    speedMps: 30,
    log: (l) => console.log(l),
  });
  for (const d of fleet) await d.goOnline();

  const [passenger] = await loadSimPassengers(prisma, 1);
  if (!passenger) throw new Error("seed missing");

  await new Promise((r) => setTimeout(r, 2500)); // let pings register in GEO

  const trip = await api.createTrip(API, passenger.token, {
    vehicleClass: VehicleClass.BODABODA,
    pickup: { lat: SUMBAWANGA.lat + 0.001, lng: SUMBAWANGA.lng },
    drop: { lat: SUMBAWANGA.lat + 0.008, lng: SUMBAWANGA.lng + 0.003 },
    paymentMethod: PaymentMethod.CASH,
  });
  console.log(`>>> trip ${trip.id} created, est ${trip.estimatedFare} TZS`);

  const deadline = Date.now() + 180_000;
  let last = "";
  while (Date.now() < deadline) {
    const t = await api.getTrip(API, passenger.token, trip.id);
    if (t.status !== last) {
      last = t.status;
      console.log(`>>> trip status: ${t.status}`);
    }
    if (["COMPLETED", "EXPIRED", "FAILED"].includes(t.status)) {
      console.log(">>> final:", JSON.stringify(t, null, 2));
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await Promise.allSettled(fleet.map((d) => d.goOffline()));
  await prisma.$disconnect();
  process.exit(last === "COMPLETED" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
