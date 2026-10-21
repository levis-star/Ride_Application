/**
 * LATRA-compliant fare engine (spec §8). Pure, deterministic, integer TZS.
 *
 * total = max(base + km*perKm + min*perMin + bookingFee, minimumFare), rounded
 * to the nearest 100 TZS. bookingFee is bookingFeePct of (base + distance + time)
 * and accrues to the platform. commission = commissionPct * (total − bookingFee).
 */

import { VehicleClass } from "./enums";

export interface FareConfigInput {
  vehicleClass: VehicleClass;
  /** TZS */
  baseFare: number;
  /** TZS per km */
  perKm: number;
  /** TZS per minute */
  perMin: number;
  /** percent, e.g. 3 for 3% */
  bookingFeePct: number;
  /** TZS */
  minimumFare: number;
  /** percent, e.g. 20 for 20% */
  commissionPct: number;
  currency: "TZS";
}

export interface LatraBoundsInput {
  vehicleClass: VehicleClass;
  minFareFloor: number;
  perKmMin: number;
  perKmMax: number;
  perMinMin: number;
  perMinMax: number;
  /** percent cap */
  commissionMax: number;
  /** percent cap */
  bookingFeeMax: number;
}

export interface FareBreakdown {
  base: number;
  distanceCharge: number;
  timeCharge: number;
  bookingFee: number;
  subtotal: number;
  minimumFareApplied: boolean;
  total: number;
  commission: number;
  driverEarnings: number;
  currency: "TZS";
}

export function roundToNearest100(amount: number): number {
  return Math.round(amount / 100) * 100;
}

function computeFare(config: FareConfigInput, distanceM: number, durationS: number): FareBreakdown {
  if (distanceM < 0 || durationS < 0) {
    throw new Error("distanceM and durationS must be non-negative");
  }
  const base = Math.round(config.baseFare);
  const distanceCharge = Math.round((distanceM / 1000) * config.perKm);
  const timeCharge = Math.round((durationS / 60) * config.perMin);
  const meterSubtotal = base + distanceCharge + timeCharge;
  const bookingFee = Math.round((config.bookingFeePct / 100) * meterSubtotal);
  const subtotal = meterSubtotal + bookingFee;
  const minimumFareApplied = subtotal < config.minimumFare;
  const total = roundToNearest100(Math.max(subtotal, config.minimumFare));
  const commission = Math.round((config.commissionPct / 100) * (total - bookingFee));
  const driverEarnings = total - bookingFee - commission;
  return {
    base,
    distanceCharge,
    timeCharge,
    bookingFee,
    subtotal,
    minimumFareApplied,
    total,
    commission,
    driverEarnings,
    currency: "TZS",
  };
}

/** Pre-booking estimate ("Kadirio" — the final fare governs). */
export function estimateFare(config: FareConfigInput, distanceM: number, durationS: number): FareBreakdown {
  return computeFare(config, distanceM, durationS);
}

/** Final fare from actuals (trace distance / recorded duration). */
export function finalFare(config: FareConfigInput, actualDistanceM: number, actualDurationS: number): FareBreakdown {
  return computeFare(config, actualDistanceM, actualDurationS);
}

export interface CancellationFeeInput {
  /** Driver had reached the pick-up point (status ARRIVED) when cancelled. */
  driverArrived: boolean;
  /** Trip was already under way (status IN_PROGRESS) when cancelled. */
  tripStarted: boolean;
  /** Admin-editable flat fee (default TZS 500), already LATRA-bounds-checked. */
  flatFee: number;
}

/**
 * LATRA rule (latra.go.tz — "operate a ride-hailing system"): the app
 * "should not charge a customer when a trip has not started, nor the driver has
 * arrived the pick-up point".
 *
 * A cancellation fee is therefore only permissible once the driver has actually
 * ARRIVED at the pick-up point, or the trip has already started. Distance driven
 * toward pickup is deliberately NOT a trigger — a driver 5 km along but not yet
 * arrived is still a free cancellation for the passenger.
 */
export function cancellationFee(input: CancellationFeeInput): number {
  if (!input.driverArrived && !input.tripStarted) return 0;
  return Math.round(input.flatFee);
}

export interface BoundsViolation {
  field: string;
  message: string;
}

/**
 * Validates a fare config against LATRA bounds. Rejections name the exact
 * bound violated (spec §8) so the admin UI can surface them verbatim.
 */
export function validateFareConfig(
  config: FareConfigInput,
  bounds: LatraBoundsInput,
): { ok: true } | { ok: false; violations: BoundsViolation[] } {
  const violations: BoundsViolation[] = [];
  if (config.vehicleClass !== bounds.vehicleClass) {
    violations.push({
      field: "vehicleClass",
      message: `config is for ${config.vehicleClass} but bounds are for ${bounds.vehicleClass}`,
    });
  }
  if (config.perKm < bounds.perKmMin || config.perKm > bounds.perKmMax) {
    violations.push({
      field: "perKm",
      message: `perKm ${config.perKm} outside LATRA band [${bounds.perKmMin}, ${bounds.perKmMax}] TZS/km`,
    });
  }
  if (config.perMin < bounds.perMinMin || config.perMin > bounds.perMinMax) {
    violations.push({
      field: "perMin",
      message: `perMin ${config.perMin} outside LATRA band [${bounds.perMinMin}, ${bounds.perMinMax}] TZS/min`,
    });
  }
  if (config.minimumFare < bounds.minFareFloor) {
    violations.push({
      field: "minimumFare",
      message: `minimumFare ${config.minimumFare} below LATRA floor ${bounds.minFareFloor} TZS`,
    });
  }
  if (config.commissionPct > bounds.commissionMax) {
    violations.push({
      field: "commissionPct",
      message: `commissionPct ${config.commissionPct}% exceeds LATRA cap ${bounds.commissionMax}%`,
    });
  }
  if (config.bookingFeePct > bounds.bookingFeeMax) {
    violations.push({
      field: "bookingFeePct",
      message: `bookingFeePct ${config.bookingFeePct}% exceeds LATRA cap ${bounds.bookingFeeMax}%`,
    });
  }
  const negatives = (["baseFare", "perKm", "perMin", "bookingFeePct", "minimumFare", "commissionPct"] as const).filter(
    (f) => config[f] < 0,
  );
  for (const f of negatives) {
    violations.push({ field: f, message: `${f} must be non-negative` });
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
