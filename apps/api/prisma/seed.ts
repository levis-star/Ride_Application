/**
 * Seed: admin user, LATRA bounds + fare configs (placeholder values marked
 * VERIFY BEFORE LAUNCH), Sumbawanga landmarks (placeholder coordinates marked
 * TODO-OPERATOR), and a simulation cohort (drivers + passengers) used by
 * scripts/sim-drivers.ts and the dispatch integration tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient, Role, VehicleClass } from "@prisma/client";

const prisma = new PrismaClient();

// Sumbawanga town centre. Sim drivers/landmarks are placed around this point.
export const SUMBAWANGA = { lat: -7.9667, lng: 31.6167 };

// Scale via env for load testing (spec §15: 300 concurrent drivers).
const SIM_DRIVER_COUNT = Number(process.env.SEED_SIM_DRIVERS ?? 20);
const SIM_PASSENGER_COUNT = Number(process.env.SEED_SIM_PASSENGERS ?? 10);

async function seedLatraBoundsAndFares() {
  // VERIFY BEFORE LAUNCH: placeholder bands. Operator must replace with the
  // current LATRA fare order values before going live (spec §20).
  const bounds = [
    { vehicleClass: VehicleClass.BODABODA, minFareFloor: 500, perKmMin: 200, perKmMax: 600, perMinMin: 0, perMinMax: 100, commissionMax: 25, bookingFeeMax: 3, sourceRef: "PLACEHOLDER — VERIFY BEFORE LAUNCH" },
    { vehicleClass: VehicleClass.BAJAJI, minFareFloor: 800, perKmMin: 300, perKmMax: 900, perMinMin: 0, perMinMax: 150, commissionMax: 25, bookingFeeMax: 3, sourceRef: "PLACEHOLDER — VERIFY BEFORE LAUNCH" },
    { vehicleClass: VehicleClass.CAR, minFareFloor: 1500, perKmMin: 600, perKmMax: 1800, perMinMin: 0, perMinMax: 300, commissionMax: 25, bookingFeeMax: 3, sourceRef: "PLACEHOLDER — VERIFY BEFORE LAUNCH" },
  ];
  for (const b of bounds) {
    await prisma.latraBounds.upsert({
      where: { vehicleClass: b.vehicleClass },
      create: b,
      update: b,
    });
  }

  const fares = [
    { vehicleClass: VehicleClass.BODABODA, baseFare: 500, perKm: 350, perMin: 50, bookingFeePct: 3, minimumFare: 1000, commissionPct: 15 },
    { vehicleClass: VehicleClass.BAJAJI, baseFare: 800, perKm: 500, perMin: 80, bookingFeePct: 3, minimumFare: 1500, commissionPct: 15 },
    { vehicleClass: VehicleClass.CAR, baseFare: 2000, perKm: 1000, perMin: 150, bookingFeePct: 3, minimumFare: 3500, commissionPct: 15 },
  ];
  for (const f of fares) {
    const existing = await prisma.fareConfig.findFirst({
      where: { vehicleClass: f.vehicleClass, active: true },
    });
    if (existing) {
      await prisma.fareConfig.update({ where: { id: existing.id }, data: f });
    } else {
      await prisma.fareConfig.create({
        data: { ...f, latraOrderRef: "PLACEHOLDER — VERIFY BEFORE LAUNCH" },
      });
    }
  }
}

interface LandmarkSeed {
  name: string;
  aliasNames: string[];
  lat: number;
  lng: number;
  category: string;
}

async function seedLandmarks() {
  // Real Sumbawanga POIs from OpenStreetMap (coordinates match OSRM's road
  // graph, so search + routing hit the actual place). Regenerate with:
  //   tsx prisma/fetch-landmarks.ts   (see that script)
  // Falls back to a small placeholder set if the JSON isn't present.
  const jsonPath = resolve(__dirname, "landmarks-sumbawanga.json");
  let landmarks: LandmarkSeed[];
  let verified: boolean;
  if (existsSync(jsonPath)) {
    landmarks = JSON.parse(readFileSync(jsonPath, "utf8")) as LandmarkSeed[];
    // NOT verified: these are crowd-sourced OSM imports, and OSM around
    // Sumbawanga mislabels ATMs as bank branches and maps some places twice.
    // `verified` means a human confirmed it in the admin landmark editor —
    // claiming it here also pushed unchecked data to the top of search.
    verified = false;
    console.log(`Seeding ${landmarks.length} OSM landmarks (unverified — confirm in admin).`);
  } else {
    console.warn("landmarks-sumbawanga.json missing — using placeholder landmarks (run fetch-landmarks.ts).");
    const base: Array<[string, string, string[]]> = [
      ["Soko Kuu la Sumbawanga", "market", ["Soko Kuu", "Central Market"]],
      ["Hospitali ya Rufaa Sumbawanga", "hospital", ["Regional Hospital"]],
      ["Stendi Kuu ya Mabasi", "stand", ["Bus Stand", "Stendi"]],
    ];
    landmarks = base.map(([name, category, aliasNames], i) => {
      const angle = (i / base.length) * 2 * Math.PI;
      const r = 0.005 + (i % 5) * 0.005;
      return {
        name,
        category,
        aliasNames,
        lat: SUMBAWANGA.lat + r * Math.sin(angle),
        lng: SUMBAWANGA.lng + r * Math.cos(angle),
      };
    });
    verified = false;
  }

  /*
   * Refresh the OSM import WITHOUT touching anything a human has curated.
   * This used to `deleteMany({})` the whole table, which was fine when
   * landmarks were pure reference data — but the demo re-seeds on every
   * launch, so once staff can correct places in the admin editor that would
   * erase every local correction. Only untouched OSM rows are replaced.
   */
  const curated = await prisma.landmark.findMany({
    where: { OR: [{ source: "STAFF" }, { verified: true }] },
    select: { name: true, lat: true, lng: true },
  });
  await prisma.trip.updateMany({
    where: { pickupLandmark: { source: "OSM", verified: false } },
    data: { pickupLandmarkId: null },
  });
  await prisma.trip.updateMany({
    where: { dropLandmark: { source: "OSM", verified: false } },
    data: { dropLandmarkId: null },
  });
  await prisma.landmark.deleteMany({ where: { source: "OSM", verified: false } });

  // Skip an import that duplicates a curated place (same name, within 120 m) —
  // the staff version wins. Distinct places sharing a name are both kept: OSM
  // has six separate "NMB Bank" points in Sumbawanga and collapsing them by
  // name alone hid the real branch.
  const sameSpot = (aLat: number, aLng: number, bLat: number, bLng: number) =>
    Math.hypot((aLat - bLat) * 111_320, (aLng - bLng) * 110_570) <= 120;
  let skipped = 0;
  for (const l of landmarks) {
    const clash = curated.some(
      (c) =>
        c.name.toLowerCase() === l.name.toLowerCase() &&
        sameSpot(Number(c.lat), Number(c.lng), l.lat, l.lng),
    );
    if (clash) {
      skipped += 1;
      continue;
    }
    await prisma.landmark.create({
      data: {
        name: l.name,
        category: l.category,
        aliasNames: l.aliasNames ?? [],
        lat: l.lat,
        lng: l.lng,
        source: "OSM",
        verified,
      },
    });
  }
  if (curated.length > 0) {
    console.log(`Kept ${curated.length} curated landmark(s); skipped ${skipped} duplicate import(s).`);
  }
}

async function seedNotificationTemplates() {
  // Spec §10: all messages templated sw + en, stored in DB. {{var}} substitution.
  const templates: Array<[string, string, string]> = [
    ["auth.otp", "RukwaRide: nambari yako ya uthibitisho ni {{code}}. Inaisha baada ya dakika 5.", "RukwaRide: your verification code is {{code}}. Expires in 5 minutes."],
    ["trip.driver_assigned", "RukwaRide: dereva {{name}} ({{plate}}) anakuja. Simu: {{phone}}", "RukwaRide: driver {{name}} ({{plate}}) is on the way. Phone: {{phone}}"],
    ["trip.driver_arrived", "RukwaRide: dereva wako amefika.", "RukwaRide: your driver has arrived."],
    ["trip.started", "RukwaRide: safari imeanza.", "RukwaRide: your trip has started."],
    // LATRA Stage-1 #10: a receipt must show starting point, ending point,
    // fares and time.
    ["trip.receipt", "RukwaRide risiti: {{from}} -> {{to}}, {{start}}-{{end}}, umbali {{km}} km, nauli TZS {{total}}. Asante!", "RukwaRide receipt: {{from}} -> {{to}}, {{start}}-{{end}}, {{km}} km, fare TZS {{total}}. Thank you!"],
    ["trip.redispatch", "RukwaRide: dereva amejitoa, tunakutafutia dereva mwingine.", "RukwaRide: the driver withdrew, we are finding you another one."],
    ["trip.expired", "RukwaRide: samahani, hatukupata dereva kwa sasa. Tafadhali jaribu tena.", "RukwaRide: sorry, no driver is available right now. Please try again."],
    ["trip.cancelled_by_passenger", "RukwaRide: safari imefutwa.", "RukwaRide: the trip was cancelled."],
    ["payment.topup_ok", "RukwaRide: salio la TZS {{amount}} limeingia kwenye pochi yako.", "RukwaRide: TZS {{amount}} has been added to your wallet."],
    ["trip.momo_failed_pay_cash", "RukwaRide: malipo ya simu hayakukamilika. Tafadhali mlipe dereva TZS {{total}} taslimu.", "RukwaRide: mobile payment did not complete. Please pay the driver TZS {{total}} in cash."],
    ["trip.momo_failed_driver", "RukwaRide: malipo ya simu hayakukamilika. Pokea TZS {{total}} taslimu kutoka kwa abiria.", "RukwaRide: mobile payment failed. Collect TZS {{total}} in cash from the passenger."],
  ];
  for (const [key, sw, en] of templates) {
    await prisma.notificationTemplate.upsert({
      where: { key },
      create: { key, sw, en },
      update: { sw, en },
    });
  }
}

const DEFAULT_STAFF_PASSWORD = "ChangeMe123!";

/**
 * "Remember to set a strong password" is not a control: refuse to seed a
 * production database with the known default staff password. Runs at the very
 * top of main() so it aborts before any rows are written.
 */
function assertProdStaffPasswords(): void {
  if (process.env.NODE_ENV !== "production") return;
  for (const name of ["SEED_ADMIN_PASSWORD", "SEED_DISPATCHER_PASSWORD"]) {
    if ((process.env[name] ?? DEFAULT_STAFF_PASSWORD) === DEFAULT_STAFF_PASSWORD) {
      throw new Error(`Refusing to seed production: ${name} is unset/the dev default. Set a strong password.`);
    }
  }
}

async function seedStaff() {
  const argon2 = await import("argon2");
  // Dev credentials — override with SEED_ADMIN_PASSWORD / SEED_DISPATCHER_PASSWORD.
  // Production is guarded up-front by assertProdStaffPasswords().
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? DEFAULT_STAFF_PASSWORD;
  const dispatcherPassword = process.env.SEED_DISPATCHER_PASSWORD ?? DEFAULT_STAFF_PASSWORD;
  const adminHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
  const dispatcherHash = await argon2.hash(dispatcherPassword, { type: argon2.argon2id });
  await prisma.user.upsert({
    where: { phone: "+255700000001" },
    create: {
      phone: "+255700000001",
      name: "Admin",
      role: Role.ADMIN,
      passwordHash: adminHash,
      language: "sw",
    },
    update: { passwordHash: adminHash },
  });
  await prisma.user.upsert({
    where: { phone: "+255700000002" },
    create: {
      phone: "+255700000002",
      name: "Dispatcher",
      role: Role.DISPATCHER,
      passwordHash: dispatcherHash,
      language: "sw",
    },
    update: { passwordHash: dispatcherHash },
  });
}

export interface SimDriverSeed {
  userId: string;
  driverProfileId: string;
  phone: string;
  name: string;
  vehicleClass: VehicleClass;
  plateNumber: string;
}

async function seedSimCohort(): Promise<void> {
  const classes = [VehicleClass.BODABODA, VehicleClass.BODABODA, VehicleClass.BAJAJI, VehicleClass.CAR];
  for (let i = 0; i < SIM_DRIVER_COUNT; i++) {
    // Same numbers as the old 2-digit scheme for i < 100, scales to 99999.
    const phone = `+2557100${String(i).padStart(5, "0")}`;
    const cls = classes[i % classes.length]!;
    const user = await prisma.user.upsert({
      where: { phone },
      create: { phone, name: `Sim Driver ${i}`, role: Role.DRIVER, language: "sw" },
      update: {},
    });
    const profile = await prisma.driverProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        approvedAt: new Date(),
        latraVerifiedAt: new Date(),
        walletBalance: 5000,
      },
      update: {},
    });
    // The wallet cache must be backed by the ledger (reconciliation is
    // ledger-authoritative): post the 5000 TZS opening float as a balanced
    // txn once. No cache update here — the cache already starts at 5000.
    const opening = await prisma.ledgerEntry.findFirst({
      where: { driverId: profile.id, memo: "Opening balance (seed)" },
    });
    if (!opening) {
      const txnId = `seed-opening-${profile.id}`;
      await prisma.ledgerEntry.createMany({
        data: [
          {
            txnId,
            account: "DRIVER_WALLET",
            driverId: profile.id,
            debit: 0,
            credit: 5000,
            memo: "Opening balance (seed)",
          },
          {
            txnId,
            account: "PLATFORM_RECEIVABLE",
            debit: 5000,
            credit: 0,
            memo: "Opening balance (seed)",
          },
        ],
      });
    }
    const plateNumber = `MC ${String(100 + i)} SIM`;
    const vehicle = await prisma.vehicle.upsert({
      where: { plateNumber },
      create: {
        driverId: profile.id,
        class: cls,
        plateNumber,
        make: cls === VehicleClass.CAR ? "Toyota" : "Bajaj",
        model: cls === VehicleClass.CAR ? "Probox" : cls === VehicleClass.BAJAJI ? "RE" : "Boxer",
        color: "nyekundu",
        latraVerified: true,
      },
      update: {},
    });
    if (profile.currentVehicleId !== vehicle.id) {
      await prisma.driverProfile.update({
        where: { id: profile.id },
        data: { currentVehicleId: vehicle.id },
      });
    }
  }

  // Sim passengers for trip creation in tests.
  for (let i = 0; i < SIM_PASSENGER_COUNT; i++) {
    const phone = `+2557200${String(i).padStart(5, "0")}`;
    await prisma.user.upsert({
      where: { phone },
      create: { phone, name: `Sim Passenger ${i}`, role: Role.PASSENGER, language: "sw" },
      update: {},
    });
  }
}

async function main() {
  assertProdStaffPasswords();
  await seedLatraBoundsAndFares();
  await seedLandmarks();
  await seedNotificationTemplates();
  await seedStaff();
  await seedSimCohort();
  console.log("Seed complete: LATRA bounds, fare configs, landmarks, templates, admin, sim cohort.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
