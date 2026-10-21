import { describe, expect, it } from "vitest";
import {
  CETS_VEHICLE_TYPE,
  LATRA_FIELD_KEYS,
  LATRA_TRIP_REPORT_FIELDS,
  applyLatraFieldMap,
  cetsCoordinates,
  cetsLicence,
  cetsPlate,
  cetsRating,
} from "../src";

// The dataset LATRA publishes at
// latra.go.tz/howdois/operate-a-ride-hailing-system — order and labels matter,
// because the wire payload is asserted against this list.
const canonical = {
  tripId: "trip_1",
  originCoordinates: "-7.9657,31.6167",
  endCoordinates: "-7.9587,31.6197",
  startTime: "2026-07-21 00:52:27",
  endTime: "2026-07-21 00:52:55",
  totalFareAmount: 1000,
  tripDistance: 810,
  rating: 4,
  driverEarning: 830,
  driverLicenseNumber: "4000123454",
  vehicleRegistrationNumber: "MC100SIM",
  passengerName: "JUMA ALLY",
  passengerPhone: "0659829835",
  passengerNida: "99876554675456",
  pickupPoint: "Hazina",
  dropOffPoint: "Makulu",
};

describe("LATRA Stage-2 dataset", () => {
  it("lists CeTS's 16 submitTrip items in the document's order", () => {
    expect(LATRA_TRIP_REPORT_FIELDS.map((f) => f.label)).toEqual([
      "Trip ID",
      "Origin Coordinates",
      "End Coordinates",
      "Start Time",
      "End Time",
      "Total Fare Amount",
      "Trip Distance",
      "Rating",
      "Driver's Earning",
      "Driver License Number",
      "Vehicle Registration Number",
      "Passenger Name",
      "Passenger Phone",
      "Passenger NIDA",
      "Pickup Point",
      "Drop Off Point",
    ]);
  });

  it("emits canonical names, in order, when no override is configured", () => {
    expect(Object.keys(applyLatraFieldMap(canonical))).toEqual([...LATRA_FIELD_KEYS]);
  });

  it("renames only the mapped keys and keeps LATRA's field order", () => {
    const wire = applyLatraFieldMap(canonical, {
      tripId: "trip_id",
      driverEarning: "driver_earning",
    });
    expect(Object.keys(wire)).toEqual([
      "trip_id",
      "originCoordinates",
      "endCoordinates",
      "startTime",
      "endTime",
      "totalFareAmount",
      "tripDistance",
      "rating",
      "driver_earning",
      "driverLicenseNumber",
      "vehicleRegistrationNumber",
      "passengerName",
      "passengerPhone",
      "passengerNida",
      "pickupPoint",
      "dropOffPoint",
    ]);
    expect(wire.trip_id).toBe("trip_1");
    expect(wire.driver_earning).toBe(830);
  });

  it("supports a full snake_case remap without touching values", () => {
    const map = Object.fromEntries(
      LATRA_FIELD_KEYS.map((k) => [k, k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]),
    );
    const wire = applyLatraFieldMap(canonical, map);
    expect(Object.keys(wire)).toEqual([
      "trip_id",
      "origin_coordinates",
      "end_coordinates",
      "start_time",
      "end_time",
      "total_fare_amount",
      "trip_distance",
      "rating",
      "driver_earning",
      "driver_license_number",
      "vehicle_registration_number",
      "passenger_name",
      "passenger_phone",
      "passenger_nida",
      "pickup_point",
      "drop_off_point",
    ]);
    expect(Object.values(wire)).toEqual(Object.values(canonical));
  });

  it("omits absent fields rather than emitting undefined", () => {
    const { rating: _rating, ...withoutRating } = canonical;
    expect("rating" in applyLatraFieldMap(withoutRating)).toBe(false);
  });
});

describe("CeTS value normalisation", () => {
  it("strips spaces from the vehicle registration number", () => {
    expect(cetsPlate("MC 100 SIM")).toBe("MC100SIM");
    expect(cetsPlate("t 999 spc")).toBe("T999SPC");
  });

  it("accepts a 10-digit licence and strips formatting", () => {
    expect(cetsLicence("4000123454")).toBe("4000123454");
    expect(cetsLicence("4000-123-454")).toBe("4000123454");
  });

  it("rejects a licence that is not exactly 10 digits", () => {
    // Returning undefined lets the caller refuse to submit rather than have
    // CeTS reject it after a wasted round trip.
    expect(cetsLicence("DL-4457-TZ")).toBeUndefined();
    expect(cetsLicence("123")).toBeUndefined();
    expect(cetsLicence("12345678901")).toBeUndefined();
    expect(cetsLicence(null)).toBeUndefined();
  });

  it("maps our vehicle classes onto CeTS's enum", () => {
    expect(CETS_VEHICLE_TYPE.BODABODA).toBe("MOTORCYCLE");
    expect(CETS_VEHICLE_TYPE.BAJAJI).toBe("TRICYCLE");
    expect(CETS_VEHICLE_TYPE.CAR).toBe("CAR");
  });

  it("clamps rating into CeTS's required 0-5 integer, defaulting unrated to 0", () => {
    expect(cetsRating(null)).toBe(0);
    expect(cetsRating(undefined)).toBe(0);
    expect(cetsRating(4)).toBe(4);
    expect(cetsRating(9)).toBe(5);
    expect(cetsRating(-2)).toBe(0);
    expect(cetsRating(3.6)).toBe(4);
  });

  it("emits coordinates in the configured order", () => {
    // Sumbawanga: lat -7.96, lng 31.61 — the order is not survivable if wrong.
    expect(cetsCoordinates(-7.9657, 31.6167)).toBe("-7.9657,31.6167");
    expect(cetsCoordinates(-7.9657, 31.6167, "lng,lat")).toBe("31.6167,-7.9657");
  });
});
