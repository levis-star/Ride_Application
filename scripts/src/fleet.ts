import { PrismaClient } from "@prisma/client";
import { LatLng, Role, VehicleClass } from "@rukwaride/shared";
import { mintToken } from "./auth";
import { OfferBehavior, SimDriver, SimDriverIdentity } from "./sim-driver";

export const SUMBAWANGA: LatLng = { lat: -7.9667, lng: 31.6167 };

const SIM_DRIVER_PHONE_PREFIX = "+2557100";
const SIM_PASSENGER_PHONE_PREFIX = "+2557200";

export interface FleetOptions {
  apiUrl: string;
  count: number;
  vehicleClass?: VehicleClass;
  behavior?: OfferBehavior;
  center?: LatLng;
  /** max scatter radius from center, metres */
  spreadM?: number;
  pingIntervalMs?: number;
  speedMps?: number;
  /** OSRM base URL → drivers follow real roads (demo). Omit for tests/load. */
  osrmUrl?: string;
  /** Skip the first N sim identities (demo fleet must not share with tests). */
  identityOffset?: number;
  log?: (line: string) => void;
}

export interface SimPassenger {
  userId: string;
  phone: string;
  token: string;
}

/** Deterministic scatter: driver i sits on a spiral around the center. */
export function scatterPosition(center: LatLng, i: number, n: number, spreadM: number): LatLng {
  const angle = (i / Math.max(n, 1)) * 2 * Math.PI * 3;
  const r = ((i + 1) / Math.max(n, 1)) * spreadM;
  const degPerM = 1 / 111_195;
  return {
    lat: center.lat + r * degPerM * Math.sin(angle),
    lng: center.lng + r * degPerM * Math.cos(angle),
  };
}

export async function loadSimIdentities(
  prisma: PrismaClient,
  count: number,
  vehicleClass?: VehicleClass,
  /** Skip the first N identities — lets a long-running demo fleet use a
   *  different slice than the integration tests, which grab the first few
   *  (same DB/Redis: shared identities would clobber each other's GPS). */
  offset = 0,
): Promise<SimDriverIdentity[]> {
  const profiles = await prisma.driverProfile.findMany({
    where: {
      user: { phone: { startsWith: SIM_DRIVER_PHONE_PREFIX } },
      ...(vehicleClass ? { currentVehicle: { class: vehicleClass } } : {}),
    },
    include: { user: true, currentVehicle: true },
    orderBy: { user: { phone: "asc" } },
    skip: offset,
    take: count,
  });
  return profiles
    .filter((p) => p.currentVehicle)
    .map((p) => ({
      userId: p.userId,
      driverProfileId: p.id,
      name: p.user.name,
      phone: p.user.phone,
      vehicleClass: p.currentVehicle!.class as VehicleClass,
      plateNumber: p.currentVehicle!.plateNumber,
    }));
}

export async function loadSimPassengers(prisma: PrismaClient, count: number): Promise<SimPassenger[]> {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: SIM_PASSENGER_PHONE_PREFIX } },
    orderBy: { phone: "asc" },
    take: count,
  });
  return users.map((u) => ({
    userId: u.id,
    phone: u.phone,
    token: mintToken({ sub: u.id, role: Role.PASSENGER }),
  }));
}

export async function spawnFleet(prisma: PrismaClient, opts: FleetOptions): Promise<SimDriver[]> {
  const identities = await loadSimIdentities(prisma, opts.count, opts.vehicleClass, opts.identityOffset ?? 0);
  if (identities.length < opts.count) {
    throw new Error(
      `Only ${identities.length}/${opts.count} sim drivers available` +
        (opts.vehicleClass ? ` for class ${opts.vehicleClass}` : "") +
        ` — run the seed (pnpm db:seed) or lower --drivers`,
    );
  }
  const center = opts.center ?? SUMBAWANGA;
  const spread = opts.spreadM ?? 2000;
  return identities.map(
    (identity, i) =>
      new SimDriver({
        apiUrl: opts.apiUrl,
        token: mintToken({ sub: identity.userId, role: Role.DRIVER, driverProfileId: identity.driverProfileId }),
        identity,
        start: scatterPosition(center, i, identities.length, spread),
        behavior: opts.behavior,
        pingIntervalMs: opts.pingIntervalMs,
        speedMps: opts.speedMps,
        osrmUrl: opts.osrmUrl,
        log: opts.log,
      }),
  );
}
