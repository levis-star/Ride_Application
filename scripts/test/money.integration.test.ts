/**
 * Money integration tests (spec §16): balanced ledger txns for every money
 * write, webhook duplicate-delivery idempotency + bad-signature rejection,
 * mobile-money trip settlement, timeout→CASH conversion (never limbo), and
 * admin-approved payouts — against a real API + Postgres + Redis.
 */
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaymentMethod, Role, VehicleClass } from "@rukwaride/shared";
import { api as rest } from "../src/api-client";
import { mintToken } from "../src/auth";
import { loadSimIdentities, loadSimPassengers, SimPassenger } from "../src/fleet";
import { SimDriver } from "../src/sim-driver";
import { TEST_API_URL } from "./global-setup";
import { closeHelpers, prisma, resetWorld, waitFor } from "./helpers";

const CENTER = { lat: -7.9667, lng: 31.6167 };
const PICKUP = { lat: CENTER.lat + 0.001, lng: CENTER.lng };
const DROP = { lat: CENTER.lat + 0.005, lng: CENTER.lng + 0.002 };
const WEBHOOK_SECRET = "dev-webhook-secret-change-me";

let drivers: SimDriver[] = [];
let passengers: SimPassenger[] = [];

function sign(payload: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
}

async function postWebhook(body: Record<string, unknown>, opts: { badSignature?: boolean } = {}) {
  const payload = JSON.stringify(body);
  return fetch(`${TEST_API_URL}/payments/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rukwaride-signature": opts.badSignature ? "deadbeef" : sign(payload),
    },
    body: payload,
  });
}

async function assertTxnsBalanced(paymentId: string) {
  const entries = await prisma.ledgerEntry.findMany({ where: { paymentId } });
  expect(entries.length).toBeGreaterThanOrEqual(2);
  const byTxn = new Map<string, number>();
  for (const e of entries) {
    byTxn.set(e.txnId, (byTxn.get(e.txnId) ?? 0) + Number(e.debit) - Number(e.credit));
  }
  for (const [txnId, sum] of byTxn) {
    expect(sum, `txn ${txnId} must sum to zero`).toBe(0);
  }
  return entries;
}

async function spawnDriver(): Promise<{ driver: SimDriver; token: string }> {
  const identities = await loadSimIdentities(prisma, 1, VehicleClass.BODABODA);
  const identity = identities[0]!;
  const token = mintToken({ sub: identity.userId, role: Role.DRIVER, driverProfileId: identity.driverProfileId });
  const driver = new SimDriver({
    apiUrl: TEST_API_URL,
    token,
    identity,
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

async function runTripToCompletion(passenger: SimPassenger, paymentMethod: PaymentMethod): Promise<string> {
  const trip = await rest.createTrip(TEST_API_URL, passenger.token, {
    vehicleClass: VehicleClass.BODABODA,
    pickup: PICKUP,
    drop: DROP,
    paymentMethod,
  });
  await waitFor(
    async () => (await rest.getTrip(TEST_API_URL, passenger.token, trip.id)).status === "COMPLETED",
    { timeoutMs: 90_000, label: "trip completion" },
  );
  return trip.id;
}

async function adminToken(): Promise<string> {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  expect(admin).not.toBeNull();
  return mintToken({ sub: admin!.id, role: Role.ADMIN });
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

afterAll(async () => {
  await closeHelpers();
});

describe("money", () => {
  it("wallet top-up: collection webhook credits the wallet with a balanced txn; duplicates and bad signatures do nothing", async () => {
    const { driver, token } = await spawnDriver();

    const me = await fetch(`${TEST_API_URL}/drivers/me`, { headers: { authorization: `Bearer ${token}` } });
    const before = ((await me.json()) as { walletBalance: number }).walletBalance;

    const topup = (await (
      await fetch(`${TEST_API_URL}/payments/topup`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ amount: 4000 }),
      })
    ).json()) as { paymentId: string; providerRef: string };

    // Bad signature first: rejected, no effect.
    const bad = await postWebhook(
      { kind: "collection", reference: topup.providerRef, result: "SUCCESS", amount: 4000 },
      { badSignature: true },
    );
    expect(bad.status).toBe(401);

    // Valid delivery.
    const ok = await postWebhook({ kind: "collection", reference: topup.providerRef, result: "SUCCESS", amount: 4000 });
    expect(ok.status).toBe(200);
    await waitFor(
      async () => (await prisma.payment.findUnique({ where: { id: topup.paymentId } }))?.status === "CONFIRMED",
      { timeoutMs: 10_000, label: "topup confirmed" },
    );

    // Duplicate delivery: absorbed.
    await postWebhook({ kind: "collection", reference: topup.providerRef, result: "SUCCESS", amount: 4000 });
    await new Promise((r) => setTimeout(r, 1500));

    const profile = await prisma.driverProfile.findUnique({ where: { id: driver.id } });
    expect(Number(profile!.walletBalance)).toBe(before + 4000);

    const entries = await assertTxnsBalanced(topup.paymentId);
    expect(entries.filter((e) => e.account === "DRIVER_WALLET" && Number(e.credit) === 4000).length).toBe(1);
    expect(entries.filter((e) => e.account === "AGGREGATOR_CLEARING" && Number(e.debit) === 4000).length).toBe(1);
  });

  it("mobile-money trip: confirmed collection splits earnings/commission/clearing in one balanced txn", async () => {
    const { driver } = await spawnDriver();
    const tripId = await runTripToCompletion(passengers[0]!, PaymentMethod.MOBILE_MONEY);

    const payment = await waitFor(
      async () => (await prisma.payment.findUnique({ where: { idempotencyKey: `trip-${tripId}-momo` } })) ?? false,
      { timeoutMs: 10_000, label: "momo payment created" },
    );
    expect(payment.status).toBe("PENDING");

    const balanceBefore = Number(
      (await prisma.driverProfile.findUnique({ where: { id: driver.id } }))!.walletBalance,
    );

    await postWebhook({
      kind: "collection",
      reference: payment.providerRef!,
      result: "SUCCESS",
      amount: Number(payment.amount),
    });
    await waitFor(
      async () => (await prisma.payment.findUnique({ where: { id: payment.id } }))?.status === "CONFIRMED",
      { timeoutMs: 10_000, label: "momo confirmed" },
    );

    const trip = await prisma.trip.findUnique({ where: { id: tripId } });
    const breakdown = trip!.fareBreakdown as { total: number; driverEarnings: number; commission: number; bookingFee: number };
    const entries = await assertTxnsBalanced(payment.id);
    expect(
      entries.find((e) => e.account === "AGGREGATOR_CLEARING")!,
    ).toMatchObject({});
    expect(Number(entries.find((e) => e.account === "AGGREGATOR_CLEARING")!.debit)).toBe(breakdown.total);
    expect(Number(entries.find((e) => e.account === "DRIVER_WALLET")!.credit)).toBe(breakdown.driverEarnings);
    expect(Number(entries.find((e) => e.account === "PLATFORM_REVENUE")!.credit)).toBe(
      breakdown.commission + breakdown.bookingFee,
    );

    const balanceAfter = Number(
      (await prisma.driverProfile.findUnique({ where: { id: driver.id } }))!.walletBalance,
    );
    expect(balanceAfter).toBe(balanceBefore + breakdown.driverEarnings);
    // Trip stays MOBILE_MONEY — no conversion happened.
    expect(trip!.paymentMethod).toBe("MOBILE_MONEY");
  });

  it("mobile-money timeout: unpaid collection converts the trip to CASH with the cash settlement booked (no limbo)", async () => {
    await spawnDriver();
    const tripId = await runTripToCompletion(passengers[0]!, PaymentMethod.MOBILE_MONEY);

    // Send no webhook: the server-side timer (PAYMENT_TIMEOUT_S=3 in tests)
    // must fail the payment and convert the trip.
    const converted = await waitFor(
      async () => {
        const t = await prisma.trip.findUnique({ where: { id: tripId } });
        return t?.paymentMethod === "CASH" ? t : false;
      },
      { timeoutMs: 20_000, label: "conversion to cash" },
    );

    const momo = await prisma.payment.findUnique({ where: { idempotencyKey: `trip-${tripId}-momo` } });
    expect(momo!.status).toBe("FAILED");

    const cash = await prisma.payment.findUnique({ where: { idempotencyKey: `trip-${tripId}-cash-settlement` } });
    expect(cash!.status).toBe("CONFIRMED");
    const entries = await assertTxnsBalanced(cash!.id);
    const breakdown = converted.fareBreakdown as { commission: number; bookingFee: number };
    const walletDebits = entries
      .filter((e) => e.account === "DRIVER_WALLET")
      .reduce((s, e) => s + Number(e.debit), 0);
    expect(walletDebits).toBe(breakdown.commission + breakdown.bookingFee);
    // A late webhook for the failed payment must be a no-op now.
    await postWebhook({ kind: "collection", reference: momo!.providerRef!, result: "SUCCESS", amount: Number(momo!.amount) });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await prisma.payment.findUnique({ where: { id: momo!.id } }))!.status).toBe("FAILED");
  });

  it("payout: request → admin approve reserves with a balanced txn → disbursement webhook marks PAID", async () => {
    const { driver, token } = await spawnDriver();
    const admin = await adminToken();

    const payout = (await (
      await fetch(`${TEST_API_URL}/payments/payouts`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ amount: 2000 }),
      })
    ).json()) as { id: string };
    expect(payout.id).toBeDefined();

    const before = Number((await prisma.driverProfile.findUnique({ where: { id: driver.id } }))!.walletBalance);

    const approve = await fetch(`${TEST_API_URL}/payments/payouts/${payout.id}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(approve.status).toBe(201);
    const approved = (await approve.json()) as { paymentId: string };

    const after = Number((await prisma.driverProfile.findUnique({ where: { id: driver.id } }))!.walletBalance);
    expect(after).toBe(before - 2000);
    await assertTxnsBalanced(approved.paymentId);

    // Audit trail exists for the admin action (spec §14).
    const audit = await prisma.auditLog.findFirst({
      where: { action: "PAYOUT_APPROVED", entityId: payout.id },
    });
    expect(audit).not.toBeNull();

    const payment = await prisma.payment.findUnique({ where: { id: approved.paymentId } });
    await postWebhook({
      kind: "disbursement",
      reference: payment!.providerRef!,
      result: "SUCCESS",
      amount: 2000,
    });
    await waitFor(
      async () => (await prisma.payoutRequest.findUnique({ where: { id: payout.id } }))?.status === "PAID",
      { timeoutMs: 10_000, label: "payout PAID" },
    );
  });

  it("ledger stays globally sum-zero after the whole mixed sequence, and reconciliation reports no drift", async () => {
    const agg = await prisma.ledgerEntry.aggregate({ _sum: { debit: true, credit: true } });
    expect(Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0)).toBe(0);

    const admin = await adminToken();
    const res = await fetch(`${TEST_API_URL}/payments/admin/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(res.status).toBe(201);
    const report = (await res.json()) as { globalSum: number; driftFixed: number };
    expect(report.globalSum).toBe(0);
    expect(report.driftFixed).toBe(0);
  });
});
