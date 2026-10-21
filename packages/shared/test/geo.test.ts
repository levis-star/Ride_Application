import { describe, expect, it } from "vitest";
import { TracePoint, VehicleClass, haversineM, traceDistanceM, withinArrivalGeofence } from "../src";

// Sumbawanga town centre-ish coordinates
const A = { lat: -7.9667, lng: 31.6167 };

describe("haversine", () => {
  it("zero for identical points", () => {
    expect(haversineM(A, A)).toBe(0);
  });
  it("~111 km per degree of latitude", () => {
    const d = haversineM(A, { lat: A.lat + 1, lng: A.lng });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

function makeTrace(speedMps: number, seconds: number, startAt = 0): TracePoint[] {
  // Move due north at speedMps, one point per 5 s (matches the app's ping rate).
  const points: TracePoint[] = [];
  const mPerDegLat = 111_195;
  for (let t = 0; t <= seconds; t += 5) {
    points.push({
      lat: A.lat + (speedMps * t) / mPerDegLat,
      lng: A.lng,
      recordedAt: startAt + t * 1000,
    });
  }
  return points;
}

describe("traceDistanceM", () => {
  it("sums a clean 10 m/s trace to ~distance travelled", () => {
    const trace = makeTrace(10, 300); // 10 m/s for 5 min = 3000 m
    const d = traceDistanceM(trace, VehicleClass.BODABODA);
    expect(d).toBeGreaterThan(2950);
    expect(d).toBeLessThan(3050);
  });

  it("discards GPS jumps implying > 40 m/s for bodaboda", () => {
    const trace = makeTrace(10, 100);
    // Inject a teleport: 5 km jump in one 5 s segment (1000 m/s)
    trace.splice(10, 0, { lat: A.lat + 0.05, lng: A.lng, recordedAt: trace[9]!.recordedAt + 1 });
    const clean = traceDistanceM(makeTrace(10, 100), VehicleClass.BODABODA);
    const withJump = traceDistanceM(trace, VehicleClass.BODABODA);
    // The jump segment (out and back) must not add ~10 km to the total.
    expect(withJump).toBeLessThan(clean + 100);
  });

  it("keeps 45 m/s segments for CAR (limit 50) but drops them for BAJAJI (limit 40)", () => {
    const trace = makeTrace(45, 60);
    expect(traceDistanceM(trace, VehicleClass.CAR)).toBeGreaterThan(2500);
    expect(traceDistanceM(trace, VehicleClass.BAJAJI)).toBe(0);
  });

  it("is order-insensitive (sorts by recordedAt)", () => {
    const trace = makeTrace(10, 100);
    const shuffled = [...trace].reverse();
    expect(traceDistanceM(shuffled, VehicleClass.BODABODA)).toBe(traceDistanceM(trace, VehicleClass.BODABODA));
  });

  it("returns 0 for empty or single-point traces", () => {
    expect(traceDistanceM([], VehicleClass.CAR)).toBe(0);
    expect(traceDistanceM([{ ...A, recordedAt: 1 }], VehicleClass.CAR)).toBe(0);
  });
});

describe("arrival geofence", () => {
  it("150 m warn-only boundary", () => {
    expect(withinArrivalGeofence(A, A)).toBe(true);
    const far = { lat: A.lat + 0.002, lng: A.lng }; // ~222 m north
    expect(withinArrivalGeofence(far, A)).toBe(false);
  });
});
