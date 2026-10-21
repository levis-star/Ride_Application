// Mirrors the Prisma enums (spec §5). Shared code must not import @prisma/client,
// so these are the canonical TypeScript-side definitions.

export const Role = {
  PASSENGER: "PASSENGER",
  DRIVER: "DRIVER",
  DISPATCHER: "DISPATCHER",
  ADMIN: "ADMIN",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const VehicleClass = {
  BODABODA: "BODABODA",
  BAJAJI: "BAJAJI",
  CAR: "CAR",
} as const;
export type VehicleClass = (typeof VehicleClass)[keyof typeof VehicleClass];

export const DriverStatus = {
  OFFLINE: "OFFLINE",
  AVAILABLE: "AVAILABLE",
  ON_OFFER: "ON_OFFER",
  ON_TRIP: "ON_TRIP",
} as const;
export type DriverStatus = (typeof DriverStatus)[keyof typeof DriverStatus];

export const TripStatus = {
  SCHEDULED: "SCHEDULED",
  REQUESTED: "REQUESTED",
  SEARCHING: "SEARCHING",
  OFFERED: "OFFERED",
  ACCEPTED: "ACCEPTED",
  ARRIVED: "ARRIVED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED_BY_PASSENGER: "CANCELLED_BY_PASSENGER",
  CANCELLED_BY_DRIVER: "CANCELLED_BY_DRIVER",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
} as const;
export type TripStatus = (typeof TripStatus)[keyof typeof TripStatus];

export const TripSource = {
  PASSENGER_APP: "PASSENGER_APP",
  DISPATCHER: "DISPATCHER",
} as const;
export type TripSource = (typeof TripSource)[keyof typeof TripSource];

export const TripKind = {
  RIDE: "RIDE",
  PARCEL: "PARCEL",
} as const;
export type TripKind = (typeof TripKind)[keyof typeof TripKind];

export const SosStatus = {
  OPEN: "OPEN",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  RESOLVED: "RESOLVED",
} as const;
export type SosStatus = (typeof SosStatus)[keyof typeof SosStatus];

/**
 * Pre-written quick messages (Uber-style), relayed passenger↔driver during an
 * active trip. Enum keys keep it low-data and translatable client-side; the
 * server only relays the key, never free text.
 */
export const QuickMessage = {
  ARRIVED_OUTSIDE: "ARRIVED_OUTSIDE",
  ON_MY_WAY: "ON_MY_WAY",
  WAIT_5_MIN: "WAIT_5_MIN",
  CANT_FIND_YOU: "CANT_FIND_YOU",
  CALL_ME: "CALL_ME",
  OK_THANKS: "OK_THANKS",
} as const;
export type QuickMessage = (typeof QuickMessage)[keyof typeof QuickMessage];

/**
 * Quick messages are not symmetric: most of them are the *driver* telling the
 * passenger what is happening ("Naja sasa hivi", "Nipo nje", "Nipigie simu").
 * Offering those to a waiting passenger makes no sense, so each party gets
 * only the phrases it can meaningfully send. Enforced server-side too — the
 * UI list is a convenience, not the rule.
 */
export const DRIVER_QUICK_MESSAGES: readonly QuickMessage[] = [
  QuickMessage.ON_MY_WAY,
  QuickMessage.ARRIVED_OUTSIDE,
  QuickMessage.CANT_FIND_YOU,
  QuickMessage.CALL_ME,
  QuickMessage.WAIT_5_MIN,
];

/**
 * WAIT_5_MIN is deliberately in both sets — it reads naturally either way
 * ("wait, I'm nearly there" / "wait, I'm coming down"). Everything else is
 * one-directional.
 */
export const PASSENGER_QUICK_MESSAGES: readonly QuickMessage[] = [
  QuickMessage.WAIT_5_MIN,
  QuickMessage.OK_THANKS,
];

export function canSendQuickMessage(party: "PASSENGER" | "DRIVER", message: QuickMessage): boolean {
  return (party === "DRIVER" ? DRIVER_QUICK_MESSAGES : PASSENGER_QUICK_MESSAGES).includes(message);
}

export const PaymentMethod = {
  CASH: "CASH",
  MOBILE_MONEY: "MOBILE_MONEY",
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PaymentStatus = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const LedgerAccount = {
  DRIVER_WALLET: "DRIVER_WALLET",
  PLATFORM_REVENUE: "PLATFORM_REVENUE",
  PLATFORM_RECEIVABLE: "PLATFORM_RECEIVABLE",
  PASSENGER_ESCROW: "PASSENGER_ESCROW",
  AGGREGATOR_CLEARING: "AGGREGATOR_CLEARING",
} as const;
export type LedgerAccount = (typeof LedgerAccount)[keyof typeof LedgerAccount];

export const DocumentType = {
  NATIONAL_ID: "NATIONAL_ID",
  DRIVING_LICENSE: "DRIVING_LICENSE",
  LATRA_VEHICLE_LICENSE: "LATRA_VEHICLE_LICENSE",
  INSURANCE: "INSURANCE",
  VEHICLE_PHOTO: "VEHICLE_PHOTO",
  DRIVER_PHOTO: "DRIVER_PHOTO",
} as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];

export const DocumentStatus = {
  PENDING_REVIEW: "PENDING_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
} as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

/** Who is attempting a trip transition. SYSTEM = dispatch engine / BullMQ jobs. */
export const Actor = {
  PASSENGER: "PASSENGER",
  DRIVER: "DRIVER",
  DISPATCHER: "DISPATCHER",
  ADMIN: "ADMIN",
  SYSTEM: "SYSTEM",
} as const;
export type Actor = (typeof Actor)[keyof typeof Actor];
