import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { config as dotenv } from "dotenv";
import { resolve } from "node:path";

dotenv({ path: resolve(__dirname, "..", "..", ".env") });

export const prisma = new PrismaClient();
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6380", {
  maxRetriesPerRequest: null,
});

/**
 * Resets sim-world state between tests: terminates leftover active trips
 * (direct DB write — test-only bypass of TripService), forces sim drivers
 * OFFLINE, and clears dispatch keys in Redis. BullMQ keys are left alone;
 * stale jobs no-op against terminal trips by design.
 */
export async function resetWorld(): Promise<void> {
  await prisma.trip.updateMany({
    where: { status: { in: ["REQUESTED", "SEARCHING", "OFFERED", "ACCEPTED", "ARRIVED", "IN_PROGRESS"] } },
    data: { status: "FAILED", cancellationReason: "test resetWorld" },
  });
  await prisma.driverProfile.updateMany({ data: { status: "OFFLINE" } });
  // Money state: no pending payments or open payout requests may leak
  // between tests/runs (payout requests are one-open-per-driver).
  await prisma.payment.updateMany({
    where: { status: "PENDING" },
    data: { status: "FAILED" },
  });
  await prisma.payoutRequest.updateMany({
    where: { status: { in: ["REQUESTED", "APPROVED"] } },
    data: { status: "REJECTED", rejectReason: "test resetWorld" },
  });

  // rl:* — the suites hammer staff login/trip creation from one IP; each test
  // starts with fresh rate-limit buckets (the limiter itself is tested via
  // apps' behavior in production config, not here).
  for (const pattern of ["driver:*", "geo:drivers:*", "lock:driver:*", "trip:points:*", "rl:*"]) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  }
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  opts: { timeoutMs: number; intervalMs?: number; label?: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined && result !== false) return result;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 300));
  }
  throw new Error(`waitFor timed out: ${opts.label ?? "condition"}`);
}

export async function closeHelpers(): Promise<void> {
  await prisma.$disconnect();
  await redis.quit().catch(() => redis.disconnect());
}
