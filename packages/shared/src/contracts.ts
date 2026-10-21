/**
 * Wire contracts between clients (driver app / passenger PWA / simulator) and
 * the API. Both the simulator and the dispatch engine are built against THIS
 * file — it is the single source of truth for event names and payload shapes.
 */

import { z } from "zod";
import { DocumentType, PaymentMethod, QuickMessage, SosStatus, TripKind, TripStatus, VehicleClass } from "./enums";

export const SOCKET_NAMESPACES = {
  DRIVER: "/driver",
  PASSENGER: "/passenger",
  DISPATCH: "/dispatch",
} as const;

// ---------- primitives ----------

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLngDto = z.infer<typeof LatLngSchema>;

export const VehicleClassSchema = z.nativeEnum(VehicleClass);
export const PaymentMethodSchema = z.nativeEnum(PaymentMethod);
export const TripStatusSchema = z.nativeEnum(TripStatus);

// ---------- driver namespace: client → server ----------

export const DRIVER_EVENTS = {
  /** driver → server, every 5 s while online */
  LOCATION: "driver:location",
  /** driver → server, accept an offer (ack: OfferAcceptResult) */
  OFFER_ACCEPT: "offer:accept",
  /** driver → server, decline an offer (ack: { ok: boolean }) */
  OFFER_DECLINE: "offer:decline",
  /** server → driver, new trip offer */
  OFFER_NEW: "offer:new",
  /** server → driver, offer no longer valid (timeout / cancelled / raced) */
  OFFER_WITHDRAWN: "offer:withdrawn",
  /** server → driver, trip state change on their assigned trip */
  TRIP_UPDATE: "trip:update",
  /** server → driver, driver status forced (e.g. auto-OFFLINE on staleness) */
  STATUS_CHANGED: "driver:status",
  /** server → driver, a passenger nearby is still searching (claimable) */
  TRIPBOARD_NEW: "tripboard:new",
  /** server → driver, a quick pre-written message from the passenger */
  QUICK_MESSAGE: "trip:message",
} as const;

export const LocationPingSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).lt(360).optional(),
  /** epoch ms as recorded on device (offline queue replays keep original time) */
  recordedAt: z.number().int().positive(),
});
export type LocationPingDto = z.infer<typeof LocationPingSchema>;

/** HTTP fallback: POST /drivers/me/locations — queued pings flushed on reconnect. */
export const LocationBatchSchema = z.object({
  points: z.array(LocationPingSchema).min(1).max(500),
});
export type LocationBatchDto = z.infer<typeof LocationBatchSchema>;

export const OfferResponseSchema = z.object({
  tripId: z.string().min(1),
  /** monotonically increasing per trip; guards against stale accept/decline */
  offerSeq: z.number().int().nonnegative(),
});
export type OfferResponseDto = z.infer<typeof OfferResponseSchema>;

export interface OfferAcceptResult {
  ok: boolean;
  /** set when ok=false, e.g. "OFFER_EXPIRED" | "ALREADY_TAKEN" | "NOT_OFFERED" */
  reason?: string;
  trip?: TripSnapshot;
}

// ---------- driver namespace: server → client payloads ----------

export const OfferNewSchema = z.object({
  tripId: z.string(),
  offerSeq: z.number().int().nonnegative(),
  vehicleClass: VehicleClassSchema,
  pickup: LatLngSchema,
  drop: LatLngSchema,
  pickupNote: z.string().optional(),
  estimatedFare: z.number().int(),
  driverEarningsEstimate: z.number().int(),
  distanceToPickupM: z.number().int(),
  etaToPickupS: z.number().int(),
  paymentMethod: PaymentMethodSchema,
  /** ISO timestamp; the driver app shows a countdown but the SERVER owns the timeout */
  expiresAt: z.string(),
});
export type OfferNewDto = z.infer<typeof OfferNewSchema>;

export const OfferWithdrawnSchema = z.object({
  tripId: z.string(),
  offerSeq: z.number().int().nonnegative(),
  reason: z.enum(["TIMEOUT", "CANCELLED", "TAKEN", "REASSIGNED"]),
});
export type OfferWithdrawnDto = z.infer<typeof OfferWithdrawnSchema>;

/**
 * Trip board (driver-claimable searching trips): pushed to nearby AVAILABLE
 * drivers when a trip starts searching, and listed via GET
 * /drivers/me/trip-board. Claiming races the normal offer cascade — the
 * server arbitrates; a claim on a non-SEARCHING trip is refused.
 */
export const TripBoardItemSchema = z.object({
  tripId: z.string(),
  vehicleClass: VehicleClassSchema,
  pickup: LatLngSchema,
  drop: LatLngSchema,
  estimatedFare: z.number().int(),
  driverEarningsEstimate: z.number().int(),
  distanceToPickupM: z.number().int(),
  /** seconds this trip has been searching (drivers judge urgency) */
  searchingForS: z.number().int().nonnegative(),
});
export type TripBoardItemDto = z.infer<typeof TripBoardItemSchema>;

// ---------- passenger namespace ----------

export const PASSENGER_EVENTS = {
  /** passenger → server, subscribe to own trip updates */
  TRIP_SUBSCRIBE: "trip:subscribe",
  /** server → passenger */
  TRIP_UPDATE: "trip:update",
  /** server → passenger, live driver marker */
  DRIVER_LOCATION: "driver:location",
  /** server → passenger, a quick pre-written message from the driver */
  QUICK_MESSAGE: "trip:message",
} as const;

export const TripSubscribeSchema = z.object({ tripId: z.string().min(1) });

export interface TripSnapshot {
  tripId: string;
  status: TripStatus;
  kind: TripKind;
  vehicleClass: VehicleClass;
  pickup: LatLngDto;
  drop: LatLngDto;
  estimatedFare: number;
  finalFare?: number;
  paymentMethod: PaymentMethod;
  /** parcel courier trips (kind = PARCEL) */
  recipient?: { name: string; phone: string };
  packageNote?: string;
  /** scheduled rides: ISO time the trip is booked for (status = SCHEDULED) */
  scheduledAt?: string;
  driver?: {
    id: string;
    name: string;
    phone: string;
    plateNumber: string;
    vehicleClass: VehicleClass;
    ratingAvg: number;
    /** relative path to the driver's approved photo, when present (LATRA) */
    photoUrl?: string;
  };
  /**
   * Completed-trip receipt (LATRA Stage-1 #10: start point, end point, fares,
   * time). Present only once the trip is COMPLETED, so the passenger sees the
   * full itemised receipt on the completion screen — not only in history.
   */
  receipt?: TripReceipt;
}

export interface TripReceipt {
  from: string;
  to: string;
  startedAt: string | null;
  completedAt: string | null;
  durationS: number | null;
  distanceM: number | null;
  fareBreakdown: { base?: number; distanceCharge?: number; timeCharge?: number; bookingFee?: number } | null;
  total: number;
}

export interface DriverLocationBroadcast {
  tripId: string;
  lat: number;
  lng: number;
  heading?: number;
}

// ---------- REST DTOs ----------

const E164 = /^\+[1-9]\d{6,14}$/;

export const CreateTripSchema = z
  .object({
    vehicleClass: VehicleClassSchema,
    kind: z.nativeEnum(TripKind).default(TripKind.RIDE),
    pickup: LatLngSchema.extend({
      landmarkId: z.string().optional(),
      note: z.string().max(200).optional(),
    }),
    drop: LatLngSchema.extend({
      landmarkId: z.string().optional(),
    }),
    paymentMethod: PaymentMethodSchema.default(PaymentMethod.CASH),
    /** dispatcher-created trips: the caller's phone (E.164); passenger may have no account */
    contactPhone: z.string().regex(E164).optional(),
    /** dispatcher-created trips: the caller's name, reported to LATRA as passengerName */
    contactName: z.string().trim().min(2).max(80).optional(),
    /** parcel courier (kind = PARCEL): who collects the package at the drop */
    recipient: z
      .object({ name: z.string().trim().min(2).max(80), phone: z.string().regex(E164) })
      .optional(),
    packageNote: z.string().trim().max(200).optional(),
    /** scheduled ride: ISO time in the future; omit for book-now */
    scheduledAt: z.coerce.date().optional(),
  })
  .refine((v) => v.kind !== TripKind.PARCEL || !!v.recipient, {
    message: "Parcel trips require recipient name and phone",
    path: ["recipient"],
  });
export type CreateTripDto = z.infer<typeof CreateTripSchema>;
/**
 * Caller-side shape: fields with a schema default (kind, paymentMethod) are
 * optional here, because the server applies the default when parsing. API
 * clients should build request bodies against this, not the parsed output type.
 */
export type CreateTripInput = z.input<typeof CreateTripSchema>;

// ---------- SOS / emergency (Bolt/Uber-style) ----------

export const SosRaiseSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  note: z.string().trim().max(300).optional(),
});
export type SosRaiseDto = z.infer<typeof SosRaiseSchema>;

export const SosResolveSchema = z.object({ resolutionNote: z.string().trim().max(500).optional() });

export interface SosAlertDto {
  id: string;
  tripId: string;
  status: SosStatus;
  raisedByRole: string;
  raisedByName: string;
  raisedByPhone: string;
  lat: number | null;
  lng: number | null;
  note: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  driver?: { name: string; phone: string; plateNumber: string } | null;
}

// ---------- quick pre-written messages ----------

export const QuickMessageSchema = z.object({ message: z.nativeEnum(QuickMessage) });
export type QuickMessageDto = z.infer<typeof QuickMessageSchema>;

export interface QuickMessageEvent {
  tripId: string;
  from: "PASSENGER" | "DRIVER";
  message: QuickMessage;
  at: string;
}

// ---------- admin landmark curation ----------

export const LANDMARK_CATEGORIES = [
  "market",
  "hospital",
  "school",
  "stand",
  "office",
  "other",
] as const;

const LandmarkCoreSchema = {
  name: z.string().trim().min(2).max(120),
  aliasNames: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  category: z.enum(LANDMARK_CATEGORIES),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
};

export const LandmarkCreateSchema = z.object(LandmarkCoreSchema);
export type LandmarkCreateDto = z.infer<typeof LandmarkCreateSchema>;

export const LandmarkUpdateSchema = z.object({
  name: LandmarkCoreSchema.name.optional(),
  aliasNames: LandmarkCoreSchema.aliasNames,
  category: LandmarkCoreSchema.category.optional(),
  lat: LandmarkCoreSchema.lat.optional(),
  lng: LandmarkCoreSchema.lng.optional(),
  verified: z.boolean().optional(),
});
export type LandmarkUpdateDto = z.infer<typeof LandmarkUpdateSchema>;

/** Fold a duplicate landmark into the one that should survive. */
export const LandmarkMergeSchema = z.object({ intoId: z.string().min(1) });
export type LandmarkMergeDto = z.infer<typeof LandmarkMergeSchema>;

export interface AdminLandmarkDto {
  id: string;
  name: string;
  aliasNames: string[];
  category: string;
  lat: number;
  lng: number;
  source: string;
  verified: boolean;
  verifiedAt: string | null;
}

// ---------- public share-my-trip ----------

export interface SharedTripView {
  status: TripStatus;
  kind: TripKind;
  vehicleClass: VehicleClass;
  pickup: LatLngDto;
  drop: LatLngDto;
  driver?: { name: string; plateNumber: string; vehicleClass: VehicleClass } | null;
  /** last known driver position, if the trip is live */
  driverPosition?: LatLngDto | null;
}

export const DriverGoOnlineSchema = z.object({
  status: z.enum(["AVAILABLE", "OFFLINE"]),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
export type DriverGoOnlineDto = z.infer<typeof DriverGoOnlineSchema>;

export const TripActionSchema = z.object({
  /** idempotent driver actions on the assigned trip */
  action: z.enum(["ARRIVED", "START", "COMPLETE", "CANCEL"]),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  reason: z.string().max(300).optional(),
});
export type TripActionDto = z.infer<typeof TripActionSchema>;

// ---------- driver self-onboarding (spec §12/§13) ----------

/**
 * A driving licence as LATRA's CeTS wants it: "Valid Driver License Number
 * with 10 Digit". Operators write it with spaces or dashes, so accept those
 * and normalise — but reject anything that isn't ten digits, because CeTS
 * will, and a driver whose licence CeTS refuses can never have a trip
 * reported (a trip may only reference a registered driver).
 */
export const DriverLicenceSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ""))
  .refine((s) => /^\d{10}$/.test(s), { message: "Driving licence must be 10 digits" });

export const DriverRegisterSchema = z.object({
  name: z.string().trim().min(2).max(80),
  vehicleClass: VehicleClassSchema,
  plateNumber: z.string().trim().min(4).max(16).regex(/^[A-Za-z0-9 -]+$/),
  // The next three are all Required by CeTS submitDriver (docs/LATRA 1.pdf §4).
  // Collect them up front: a driver missing any of them cannot be registered
  // with LATRA, so they could never legally carry a passenger.
  licenseNumber: DriverLicenceSchema,
  /** licence category, e.g. "A" (motorcycle), "B", "C", "D" */
  licenceCategory: z.string().trim().min(1).max(8),
  email: z.string().trim().email().max(120),
  make: z.string().trim().max(40).optional(),
  model: z.string().trim().max(40).optional(),
  color: z.string().trim().max(20).optional(),
  /** optional in CeTS submitVehicle, but collect it when the driver knows it */
  chassisNumber: z.string().trim().max(40).optional(),
});
export type DriverRegisterDto = z.infer<typeof DriverRegisterSchema>;

/** Allowed upload formats — everything else is rejected server-side. */
export const DOCUMENT_UPLOAD_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export const DriverDocumentUploadSchema = z.object({
  type: z.nativeEnum(DocumentType),
  contentType: z.enum(DOCUMENT_UPLOAD_CONTENT_TYPES),
  /** base64 payload; ~5 MB decoded ceiling enforced by length */
  data: z.string().min(1).max(7_000_000),
  expiresAt: z.coerce.date().optional(),
});
export type DriverDocumentUploadDto = z.infer<typeof DriverDocumentUploadSchema>;
