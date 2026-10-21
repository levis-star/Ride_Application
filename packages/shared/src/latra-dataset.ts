/**
 * LATRA's Stage-2 trip-report dataset, verbatim from
 * https://www.latra.go.tz/howdois/operate-a-ride-hailing-system
 * ("create an API integrated to LATRA systems with the following dataset").
 *
 * `key` is our canonical wire name — the faithful camelCase rendering of
 * LATRA's published `label`, in LATRA's published order. `format` records the
 * constraint LATRA states, so the payload builder and its tests share one
 * source of truth.
 *
 * LATRA's public page documents the items and their formats but not literal
 * JSON keys; those arrive with the integration credentials. If the issued spec
 * uses different names, set LATRA_FIELD_MAP (appConfig.latra.fieldMap) and the
 * rename happens at the wire edge — nothing else in the codebase changes.
 */
export const LATRA_TRIP_REPORT_FIELDS = [
  { key: "tripId", label: "Trip ID", format: "String, required" },
  { key: "originCoordinates", label: "Origin Coordinates", format: "String, two numbers comma-separated" },
  { key: "endCoordinates", label: "End Coordinates", format: "String, two numbers comma-separated" },
  { key: "startTime", label: "Start Time", format: "YYYY-MM-DD HH:MM:SS (EAT)" },
  { key: "endTime", label: "End Time", format: "YYYY-MM-DD HH:MM:SS (EAT)" },
  { key: "totalFareAmount", label: "Total Fare Amount", format: "Double, TZS" },
  { key: "tripDistance", label: "Trip Distance", format: "Integer, metres" },
  { key: "rating", label: "Rating", format: "Integer, range 0-5, required" },
  { key: "driverEarning", label: "Driver's Earning", format: "Double, TZS" },
  { key: "driverLicenseNumber", label: "Driver License Number", format: "String, 10 digits" },
  { key: "vehicleRegistrationNumber", label: "Vehicle Registration Number", format: "String, no spaces" },
  { key: "passengerName", label: "Passenger Name", format: "String, required" },
  { key: "passengerPhone", label: "Passenger Phone", format: "String, required" },
  { key: "passengerNida", label: "Passenger NIDA", format: "String, optional (NIN)" },
  { key: "pickupPoint", label: "Pickup Point", format: "String, starting area of ride" },
  { key: "dropOffPoint", label: "Drop Off Point", format: "String, end area of ride" },
] as const;

export type LatraFieldKey = (typeof LATRA_TRIP_REPORT_FIELDS)[number]["key"];

/** Canonical keys in LATRA's documented order. */
export const LATRA_FIELD_KEYS: readonly string[] = LATRA_TRIP_REPORT_FIELDS.map((f) => f.key);

/** CeTS vehicle types (§3). Our VehicleClass names are Swahili-first. */
export const CETS_VEHICLE_TYPE: Record<string, "CAR" | "MOTORCYCLE" | "TRICYCLE"> = {
  BODABODA: "MOTORCYCLE",
  BAJAJI: "TRICYCLE",
  CAR: "CAR",
};

/**
 * CeTS requires the VRN "without space" (e.g. T123ABC, MC123ABC). Operators
 * type plates with spaces, so normalise at the wire edge rather than forcing
 * a display format on the rest of the app.
 */
export function cetsPlate(plateNumber: string): string {
  return plateNumber.replace(/\s+/g, "").toUpperCase();
}

/**
 * CeTS requires a "Valid Driver License Number with 10 Digit". Strips
 * formatting so a licence stored as "4000-123-454" still submits; returns
 * undefined when the result is not exactly 10 digits, so the caller can
 * refuse to submit rather than have CeTS reject it.
 */
export function cetsLicence(licenseNumber: string | null | undefined): string | undefined {
  if (!licenseNumber) return undefined;
  const digits = licenseNumber.replace(/\D/g, "");
  return /^\d{10}$/.test(digits) ? digits : undefined;
}

/**
 * `rating` is Required and an Integer in range 0-5 (§5), but a passenger may
 * never rate. Submitting null fails validation, so an unrated trip reports 0 —
 * confirm with LATRA that 0 reads as "not rated" rather than "rated zero".
 */
export function cetsRating(score: number | null | undefined): number {
  if (score === null || score === undefined) return 0;
  return Math.max(0, Math.min(5, Math.round(score)));
}

/**
 * Coordinate pair for CeTS. The API document contradicts itself — the field
 * description says "Longtude and latitude separated by comma" while the worked
 * example ("-6.83876250,39.2438527") is Dar es Salaam as lat,lng. Order is
 * therefore configurable and must be confirmed with LATRA before going live.
 */
export function cetsCoordinates(lat: number, lng: number, order: string = "lat,lng"): string {
  return order === "lng,lat" ? `${lng},${lat}` : `${lat},${lng}`;
}

/**
 * Renames canonical keys to the operator-configured LATRA wire names,
 * preserving LATRA's documented field order. Unmapped keys pass through
 * unchanged, so an empty map (the default) emits our canonical names.
 */
export function applyLatraFieldMap(
  canonical: Record<string, unknown>,
  fieldMap: Record<string, string> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of LATRA_FIELD_KEYS) {
    if (key in canonical) out[fieldMap[key] ?? key] = canonical[key];
  }
  // Any extra keys beyond LATRA's dataset keep their order after it.
  for (const [k, v] of Object.entries(canonical)) {
    if (!LATRA_FIELD_KEYS.includes(k)) out[fieldMap[k] ?? k] = v;
  }
  return out;
}
