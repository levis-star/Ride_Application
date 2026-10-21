import { describe, expect, it } from "vitest";
import {
  Actor,
  TripStatus,
  canTransition,
  isActiveStatus,
  isTerminal,
} from "../src";

const ALL_STATUSES = Object.values(TripStatus);
const ALL_ACTORS = Object.values(Actor);

/**
 * Exhaustive allow-list (spec §16: every from/to pair asserts allow/deny).
 * Anything not listed here must be denied for every actor.
 */
const ALLOWED: Array<[TripStatus, TripStatus, Actor[]]> = [
  // Scheduled rides: a timer (SYSTEM) promotes the booking at its booked time.
  ["SCHEDULED", "SEARCHING", [Actor.SYSTEM, Actor.DISPATCHER, Actor.ADMIN]],
  ["SCHEDULED", "CANCELLED_BY_PASSENGER", [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN]],
  ["SCHEDULED", "FAILED", [Actor.SYSTEM]],
  ["REQUESTED", "SEARCHING", [Actor.SYSTEM, Actor.DISPATCHER, Actor.ADMIN]],
  ["REQUESTED", "CANCELLED_BY_PASSENGER", [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN]],
  ["REQUESTED", "FAILED", [Actor.SYSTEM]],
  ["SEARCHING", "OFFERED", [Actor.SYSTEM, Actor.DISPATCHER]],
  ["SEARCHING", "EXPIRED", [Actor.SYSTEM]],
  ["SEARCHING", "CANCELLED_BY_PASSENGER", [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN]],
  ["SEARCHING", "FAILED", [Actor.SYSTEM]],
  ["OFFERED", "SEARCHING", [Actor.SYSTEM, Actor.DRIVER]],
  ["OFFERED", "ACCEPTED", [Actor.DRIVER, Actor.DISPATCHER]],
  ["OFFERED", "EXPIRED", [Actor.SYSTEM]],
  ["OFFERED", "CANCELLED_BY_PASSENGER", [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN]],
  ["OFFERED", "FAILED", [Actor.SYSTEM]],
  ["ACCEPTED", "ARRIVED", [Actor.DRIVER]],
  ["ACCEPTED", "CANCELLED_BY_PASSENGER", [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN]],
  ["ACCEPTED", "CANCELLED_BY_DRIVER", [Actor.DRIVER, Actor.ADMIN]],
  ["ARRIVED", "IN_PROGRESS", [Actor.DRIVER]],
  ["ARRIVED", "CANCELLED_BY_PASSENGER", [Actor.PASSENGER, Actor.DISPATCHER, Actor.ADMIN]],
  ["ARRIVED", "CANCELLED_BY_DRIVER", [Actor.DRIVER, Actor.ADMIN]],
  ["IN_PROGRESS", "COMPLETED", [Actor.DRIVER]],
  ["CANCELLED_BY_DRIVER", "SEARCHING", [Actor.SYSTEM, Actor.DISPATCHER]],
];

describe("canTransition — exhaustive matrix", () => {
  const allowedMap = new Map<string, Actor[]>();
  for (const [from, to, actors] of ALLOWED) {
    allowedMap.set(`${from}->${to}`, actors);
  }

  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      for (const actor of ALL_ACTORS) {
        const expected = allowedMap.get(`${from}->${to}`)?.includes(actor) ?? false;
        it(`${from} -> ${to} by ${actor}: ${expected ? "allow" : "deny"}`, () => {
          expect(canTransition(from, to, actor)).toBe(expected);
        });
      }
    }
  }
});

describe("terminality", () => {
  it("terminal statuses have no outgoing transitions except driver-cancel re-dispatch", () => {
    for (const status of [TripStatus.COMPLETED, TripStatus.CANCELLED_BY_PASSENGER, TripStatus.EXPIRED, TripStatus.FAILED]) {
      expect(isTerminal(status)).toBe(true);
      for (const to of ALL_STATUSES) {
        for (const actor of ALL_ACTORS) {
          expect(canTransition(status, to, actor)).toBe(false);
        }
      }
    }
  });

  it("active statuses are exactly the pre-terminal lifecycle", () => {
    expect(ALL_STATUSES.filter(isActiveStatus)).toEqual([
      "REQUESTED",
      "SEARCHING",
      "OFFERED",
      "ACCEPTED",
      "ARRIVED",
      "IN_PROGRESS",
    ]);
  });
});
