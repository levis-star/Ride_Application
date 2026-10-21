import { VehicleClass } from "@rukwaride/shared";

/** Every Redis key the platform uses, in one place. */
export const rk = {
  /** GEO set of available drivers per vehicle class */
  geoDrivers: (vehicleClass: VehicleClass | string) => `geo:drivers:${vehicleClass}`,
  /** Hash: status, vehicleClass, lat, lng, heading, updatedAt, tripId */
  driver: (driverProfileId: string) => `driver:${driverProfileId}`,
  /** Dispatch lock — holder value is the tripId (SET NX EX) */
  driverLock: (driverProfileId: string) => `lock:driver:${driverProfileId}`,
  /** List of pending GPS points for an active trip, flushed to Postgres in batches */
  tripPoints: (tripId: string) => `trip:points:${tripId}`,
} as const;

export const ALL_VEHICLE_CLASSES = ["BODABODA", "BAJAJI", "CAR"] as const;
