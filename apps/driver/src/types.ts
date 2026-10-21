/**
 * Wire types mirrored from packages/shared/src/contracts.ts (the source of
 * truth). Kept local because Expo's Metro bundler doesn't follow pnpm
 * workspace symlinks without extra config; revisit when the monorepo gains a
 * metro.config that watches packages/shared.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface OfferNew {
  tripId: string;
  offerSeq: number;
  vehicleClass: "BODABODA" | "BAJAJI" | "CAR";
  pickup: LatLng;
  drop: LatLng;
  pickupNote?: string;
  estimatedFare: number;
  driverEarningsEstimate: number;
  distanceToPickupM: number;
  etaToPickupS: number;
  paymentMethod: "CASH" | "MOBILE_MONEY";
  expiresAt: string;
}

export interface OfferAcceptResult {
  ok: boolean;
  reason?: string;
  trip?: TripSnapshot;
}

/** A nearby passenger still searching — claimable off the trip board. */
export interface TripBoardItem {
  tripId: string;
  vehicleClass: "BODABODA" | "BAJAJI" | "CAR";
  pickup: LatLng;
  drop: LatLng;
  estimatedFare: number;
  driverEarningsEstimate: number;
  distanceToPickupM: number;
  searchingForS: number;
}

export interface TripSnapshot {
  tripId: string;
  status: string;
  kind?: string;
  vehicleClass: string;
  pickup: LatLng;
  drop: LatLng;
  estimatedFare: number;
  finalFare?: number;
  paymentMethod: string;
  recipient?: { name: string; phone: string };
  packageNote?: string;
}

export interface DriverProfileMe {
  id: string;
  status: "OFFLINE" | "AVAILABLE" | "ON_OFFER" | "ON_TRIP";
  approvedAt: string | null;
  walletBalance: number;
  negativeBalanceLimit: number;
  ratingAvg: number;
  strikeCount: number;
  vehicle: { plateNumber: string; class: string } | null;
}
