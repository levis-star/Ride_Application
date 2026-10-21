import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { config as dotenv } from "dotenv";
import { resolve } from "node:path";
import { Role } from "@rukwaride/shared";
import { mintToken } from "../src/auth";
import { loadSimIdentities } from "../src/fleet";
import { SimDriver } from "../src/sim-driver";

dotenv({ path: resolve(__dirname, "..", "..", ".env") });

export const API_URL = "http://localhost:3001";
export const prisma = new PrismaClient();
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6380", {
  maxRetriesPerRequest: null,
});

/** Same world-reset as the integration suites, plus rate-limit buckets. */
export async function resetWorld(): Promise<void> {
  await prisma.trip.updateMany({
    where: { status: { in: ["REQUESTED", "SEARCHING", "OFFERED", "ACCEPTED", "ARRIVED", "IN_PROGRESS"] } },
    data: { status: "FAILED", cancellationReason: "e2e resetWorld" },
  });
  await prisma.driverProfile.updateMany({ data: { status: "OFFLINE" } });
  for (const pattern of ["driver:*", "geo:drivers:*", "lock:driver:*", "trip:points:*", "rl:*"]) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  }
}

export async function passengerToken(index = 0): Promise<{ token: string; userId: string }> {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: "+2557200000" } },
    orderBy: { phone: "asc" },
    take: index + 1,
  });
  const user = users[index]!;
  return { token: mintToken({ sub: user.id, role: Role.PASSENGER }), userId: user.id };
}

export async function spawnAcceptingDriver(): Promise<SimDriver> {
  const [identity] = await loadSimIdentities(prisma, 1, "BODABODA" as never);
  const driver = new SimDriver({
    apiUrl: API_URL,
    token: mintToken({ sub: identity!.userId, role: Role.DRIVER, driverProfileId: identity!.driverProfileId }),
    identity: identity!,
    start: { lat: -7.9657, lng: 31.6167 },
    behavior: { kind: "accept", delayMs: 800 },
    pingIntervalMs: 1000,
    speedMps: 30,
    idleDriftM: 0,
  });
  await driver.goOnline();
  await new Promise((r) => setTimeout(r, 1500)); // first pings land in GEO
  return driver;
}

/**
 * NOTE: prisma/redis are module singletons shared across spec files in the
 * same Playwright worker — never close them here; the worker process exits
 * after the run.
 */
export async function teardown(driver?: SimDriver): Promise<void> {
  driver?.stop();
  await resetWorld();
}
