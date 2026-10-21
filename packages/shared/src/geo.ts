import { VehicleClass } from "./enums";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TracePoint extends LatLng {
  /** epoch milliseconds */
  recordedAt: number;
}

const EARTH_RADIUS_M = 6371008.8;

export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Road-distance estimate when OSRM is unavailable (spec §4: haversine × 1.4). */
export const ROAD_FACTOR = 1.4;

export function roadDistanceFallbackM(a: LatLng, b: LatLng): number {
  return haversineM(a, b) * ROAD_FACTOR;
}

/** GPS-jump speed ceiling per vehicle class (spec §8): segments implying more are discarded. */
export function maxPlausibleSpeedMps(vehicleClass: VehicleClass): number {
  return vehicleClass === "CAR" ? 50 : 40;
}

/** Minimum trace size before we trust it for final distance (spec §8). */
export const MIN_TRACE_POINTS = 10;

/**
 * Final trip distance: sum of segment distances over the recorded GPS trace,
 * discarding segments whose implied speed exceeds the class ceiling.
 * Callers must fall back to OSRM route distance when points.length < MIN_TRACE_POINTS.
 */
export function traceDistanceM(points: readonly TracePoint[], vehicleClass: VehicleClass): number {
  const maxSpeed = maxPlausibleSpeedMps(vehicleClass);
  const sorted = [...points].sort((a, b) => a.recordedAt - b.recordedAt);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const dtS = (curr.recordedAt - prev.recordedAt) / 1000;
    const dM = haversineM(prev, curr);
    if (dtS <= 0) continue; // duplicate timestamp — cannot infer speed, drop
    if (dM / dtS > maxSpeed) continue; // GPS jump
    total += dM;
  }
  return Math.round(total);
}

/** Geofence check for the "Arrived" action (spec §6: within 150 m, warn-only). */
export const ARRIVAL_GEOFENCE_M = 150;

export function withinArrivalGeofence(driver: LatLng, pickup: LatLng): boolean {
  return haversineM(driver, pickup) <= ARRIVAL_GEOFENCE_M;
}
