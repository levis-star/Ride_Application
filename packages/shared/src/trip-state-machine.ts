import { Actor, TripStatus } from "./enums";

/**
 * Single source of truth for trip transitions (spec §6).
 *
 * TripService.transition() is the ONLY code path allowed to mutate Trip.status,
 * and it must consult canTransition() first. Idempotency (from === to) is
 * handled by the service as a no-op success, not encoded here.
 *
 * Note on CANCELLED_BY_DRIVER → SEARCHING: the spec requires a driver
 * cancellation to re-dispatch the SAME trip. The service records the
 * cancellation, then SYSTEM moves the trip back to SEARCHING.
 */
const MATRIX: Record<TripStatus, Partial<Record<TripStatus, Actor[]>>> = {
  SCHEDULED: {
    // A timer (SYSTEM) promotes the booking to SEARCHING at its scheduled time.
    SEARCHING: [Actor.SYSTEM, Actor.DISPATCHER, Actor.ADMIN],
    CANCELLED_BY_PASSENGER: [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN],
    FAILED: [Actor.SYSTEM],
  },
  REQUESTED: {
    SEARCHING: [Actor.SYSTEM, Actor.DISPATCHER, Actor.ADMIN],
    CANCELLED_BY_PASSENGER: [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN],
    FAILED: [Actor.SYSTEM],
  },
  SEARCHING: {
    OFFERED: [Actor.SYSTEM, Actor.DISPATCHER],
    EXPIRED: [Actor.SYSTEM],
    CANCELLED_BY_PASSENGER: [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN],
    FAILED: [Actor.SYSTEM],
  },
  OFFERED: {
    SEARCHING: [Actor.SYSTEM, Actor.DRIVER],
    ACCEPTED: [Actor.DRIVER, Actor.DISPATCHER],
    EXPIRED: [Actor.SYSTEM],
    CANCELLED_BY_PASSENGER: [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN],
    FAILED: [Actor.SYSTEM],
  },
  ACCEPTED: {
    ARRIVED: [Actor.DRIVER],
    CANCELLED_BY_PASSENGER: [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN],
    CANCELLED_BY_DRIVER: [Actor.DRIVER, Actor.ADMIN],
  },
  ARRIVED: {
    IN_PROGRESS: [Actor.DRIVER],
    CANCELLED_BY_PASSENGER: [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN],
    CANCELLED_BY_DRIVER: [Actor.DRIVER, Actor.ADMIN],
  },
  IN_PROGRESS: {
    COMPLETED: [Actor.DRIVER],
  },
  COMPLETED: {},
  CANCELLED_BY_PASSENGER: {},
  CANCELLED_BY_DRIVER: {
    // Re-dispatch of the same trip after a driver cancellation.
    SEARCHING: [Actor.SYSTEM, Actor.DISPATCHER],
  },
  EXPIRED: {},
  FAILED: {},
};

export const TERMINAL_STATUSES: readonly TripStatus[] = [
  TripStatus.COMPLETED,
  TripStatus.CANCELLED_BY_PASSENGER,
  TripStatus.EXPIRED,
  TripStatus.FAILED,
];

/** Statuses that count against the one-active-trip-per-driver/passenger rule. */
export const ACTIVE_TRIP_STATUSES: readonly TripStatus[] = [
  TripStatus.REQUESTED,
  TripStatus.SEARCHING,
  TripStatus.OFFERED,
  TripStatus.ACCEPTED,
  TripStatus.ARRIVED,
  TripStatus.IN_PROGRESS,
];

export function canTransition(from: TripStatus, to: TripStatus, actor: Actor): boolean {
  const allowed = MATRIX[from]?.[to];
  return allowed !== undefined && allowed.includes(actor);
}

export function isTerminal(status: TripStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isActiveStatus(status: TripStatus): boolean {
  return ACTIVE_TRIP_STATUSES.includes(status);
}
