import { describe, expect, it } from "vitest";
import {
  FareConfigInput,
  LatraBoundsInput,
  VehicleClass,
  cancellationFee,
  estimateFare,
  finalFare,
  roundToNearest100,
  validateFareConfig,
} from "../src";

// Placeholder LATRA-plausible values — golden inputs only; real bands are
// seeded in the DB and VERIFY BEFORE LAUNCH.
const bodaConfig: FareConfigInput = {
  vehicleClass: VehicleClass.BODABODA,
  baseFare: 500,
  perKm: 350,
  perMin: 50,
  bookingFeePct: 3,
  minimumFare: 1000,
  commissionPct: 15,
  currency: "TZS",
};

const bounds: LatraBoundsInput = {
  vehicleClass: VehicleClass.BODABODA,
  minFareFloor: 800,
  perKmMin: 200,
  perKmMax: 600,
  perMinMin: 0,
  perMinMax: 100,
  commissionMax: 25,
  bookingFeeMax: 3,
};

describe("rounding", () => {
  it("rounds to nearest 100 TZS", () => {
    expect(roundToNearest100(1249)).toBe(1200);
    expect(roundToNearest100(1250)).toBe(1300);
    expect(roundToNearest100(1000)).toBe(1000);
    expect(roundToNearest100(49)).toBe(0);
  });
});

describe("estimateFare — golden cases", () => {
  it("typical 3.2 km / 9 min bodaboda ride", () => {
    const fare = estimateFare(bodaConfig, 3200, 540);
    // base 500 + distance 1120 + time 450 = 2070; fee 3% = 62; subtotal 2132 → 2100
    expect(fare).toEqual({
      base: 500,
      distanceCharge: 1120,
      timeCharge: 450,
      bookingFee: 62,
      subtotal: 2132,
      minimumFareApplied: false,
      total: 2100,
      commission: 306, // 15% of (2100 − 62)
      driverEarnings: 1732, // 2100 − 62 − 306
      currency: "TZS",
    });
  });

  it("applies the minimum-fare floor on short hops", () => {
    const fare = estimateFare(bodaConfig, 400, 120);
    // base 500 + 140 + 100 = 740; fee 22; subtotal 762 < min 1000 → total 1000
    expect(fare.minimumFareApplied).toBe(true);
    expect(fare.total).toBe(1000);
    expect(fare.bookingFee).toBe(22);
    expect(fare.commission).toBe(147); // 15% of 978
    expect(fare.driverEarnings).toBe(831);
  });

  it("zero-distance zero-duration trip still charges the minimum", () => {
    const fare = estimateFare(bodaConfig, 0, 0);
    expect(fare.minimumFareApplied).toBe(true);
    expect(fare.total).toBe(1000);
  });

  it("fare components + splits always reconcile: total = earnings + commission + bookingFee", () => {
    for (const [d, s] of [
      [1000, 300],
      [5500, 900],
      [12345, 1800],
      [777, 60],
      [25000, 3600],
    ] as const) {
      const fare = finalFare(bodaConfig, d, s);
      expect(fare.driverEarnings + fare.commission + fare.bookingFee).toBe(fare.total);
      expect(fare.total % 100).toBe(0);
      expect(Number.isInteger(fare.total)).toBe(true);
    }
  });

  it("rejects negative inputs", () => {
    expect(() => estimateFare(bodaConfig, -1, 0)).toThrow();
    expect(() => estimateFare(bodaConfig, 0, -1)).toThrow();
  });
});

// LATRA: "the app should not charge a customer when a trip has not started,
// nor the driver has arrived the pick-up point."
describe("cancellation fee (LATRA rule)", () => {
  it("is 0 while the driver is still en route, however far they have driven", () => {
    expect(cancellationFee({ driverArrived: false, tripStarted: false, flatFee: 500 })).toBe(0);
  });
  it("is the flat fee once the driver has ARRIVED at the pick-up point", () => {
    expect(cancellationFee({ driverArrived: true, tripStarted: false, flatFee: 500 })).toBe(500);
  });
  it("is the flat fee once the trip has started", () => {
    expect(cancellationFee({ driverArrived: false, tripStarted: true, flatFee: 500 })).toBe(500);
  });
});

describe("LATRA bounds validation", () => {
  it("accepts a compliant config", () => {
    expect(validateFareConfig(bodaConfig, bounds)).toEqual({ ok: true });
  });

  it("names the exact bound violated", () => {
    const result = validateFareConfig({ ...bodaConfig, perKm: 700, commissionPct: 30 }, bounds);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const fields = result.violations.map((v) => v.field);
      expect(fields).toContain("perKm");
      expect(fields).toContain("commissionPct");
      expect(result.violations.find((v) => v.field === "perKm")!.message).toMatch(/\[200, 600\]/);
    }
  });

  it("rejects booking fee above cap and minimum fare below floor", () => {
    const result = validateFareConfig({ ...bodaConfig, bookingFeePct: 5, minimumFare: 500 }, bounds);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.field).sort()).toEqual(["bookingFeePct", "minimumFare"]);
    }
  });

  it("rejects a class mismatch", () => {
    const result = validateFareConfig({ ...bodaConfig, vehicleClass: VehicleClass.CAR }, bounds);
    expect(result.ok).toBe(false);
  });
});
