/**
 * A virtual driver: connects to the /driver Socket.io namespace, pings GPS on
 * the app's cadence, reacts to offers per its behavior policy, and drives
 * accepted trips through the full lifecycle (to pickup → ARRIVED → START →
 * to drop → COMPLETE) with realistic movement.
 *
 * Built BEFORE the dispatch engine, against packages/shared contracts only —
 * this is the test harness the engine must satisfy, plus the load generator
 * for §15 NFR checks.
 */
import { io, Socket } from "socket.io-client";
import {
  DRIVER_EVENTS,
  LatLng,
  OfferAcceptResult,
  OfferNewDto,
  OfferWithdrawnDto,
  SOCKET_NAMESPACES,
  TripBoardItemDto,
  VehicleClass,
  haversineM,
} from "@rukwaride/shared";
import { api } from "./api-client";

export type OfferBehavior =
  | { kind: "accept"; delayMs?: number }
  | { kind: "decline"; delayMs?: number }
  | { kind: "ignore" }; // let the server-side TTL expire — never rely on client timers

export interface SimDriverIdentity {
  userId: string;
  driverProfileId: string;
  name: string;
  phone: string;
  vehicleClass: VehicleClass;
  plateNumber: string;
}

export interface SimDriverOptions {
  apiUrl: string;
  token: string;
  identity: SimDriverIdentity;
  start: LatLng;
  behavior?: OfferBehavior;
  /** m/s while driving to pickup / on trip. Defaults per vehicle class. */
  speedMps?: number;
  /** GPS ping cadence. Spec: 5000 ms. Tests may compress time. */
  pingIntervalMs?: number;
  /** Random idle drift per ping, metres (0 = stationary). */
  idleDriftM?: number;
  /**
   * OSRM base URL. When set, the driver follows the real road route to its
   * target (queried per leg). Unset → straight-line movement (tests / load).
   */
  osrmUrl?: string;
  log?: (line: string) => void;
}

type Phase = "OFFLINE" | "IDLE" | "CONSIDERING" | "TO_PICKUP" | "AT_PICKUP" | "ON_TRIP";

const DEFAULT_SPEED: Record<VehicleClass, number> = {
  BODABODA: 9,
  BAJAJI: 7,
  CAR: 11,
};

const ARRIVE_THRESHOLD_M = 25;

export interface SimDriverEventLog {
  at: number;
  event: string;
  detail?: unknown;
}

export class SimDriver {
  readonly id: string;
  behavior: OfferBehavior;
  position: LatLng;
  phase: Phase = "OFFLINE";
  readonly events: SimDriverEventLog[] = [];
  completedTrips: string[] = [];
  declinedOffers = 0;
  receivedOffers: OfferNewDto[] = [];
  receivedBoardItems: TripBoardItemDto[] = [];
  receivedMessages: { tripId: string; message: string; from: string }[] = [];

  private socket?: Socket;
  private pingTimer?: NodeJS.Timeout;
  private pendingTimers = new Set<NodeJS.Timeout>();
  private target?: LatLng;
  /** Road waypoints (OSRM geometry) the driver is walking through toward target. */
  private path?: LatLng[];
  private pathIdx = 0;
  private activeTrip?: { tripId: string; pickup: LatLng; drop: LatLng };
  private offlineQueue: Array<{ lat: number; lng: number; recordedAt: number }> = [];
  private readonly speedMps: number;
  private readonly pingIntervalMs: number;
  private readonly idleDriftM: number;
  /** When true, movement continues but no pings are sent (staleness tests). */
  muted = false;

  constructor(private readonly opts: SimDriverOptions) {
    this.id = opts.identity.driverProfileId;
    this.behavior = opts.behavior ?? { kind: "accept", delayMs: 2000 };
    this.position = { ...opts.start };
    this.speedMps = opts.speedMps ?? DEFAULT_SPEED[opts.identity.vehicleClass];
    this.pingIntervalMs = opts.pingIntervalMs ?? 5000;
    this.idleDriftM = opts.idleDriftM ?? 5;
  }

  private log(event: string, detail?: unknown) {
    this.events.push({ at: Date.now(), event, detail });
    this.opts.log?.(
      `[${this.opts.identity.name} ${this.opts.identity.vehicleClass}] ${event}${
        detail !== undefined ? " " + JSON.stringify(detail) : ""
      }`,
    );
  }

  /** Go online: REST status flip, socket connect, start pinging. */
  async goOnline(): Promise<void> {
    await api.setDriverStatus(this.opts.apiUrl, this.opts.token, {
      status: "AVAILABLE",
      lat: this.position.lat,
      lng: this.position.lng,
    });
    this.phase = "IDLE";
    this.connectSocket();
    this.startPinging();
    this.log("online", { at: this.position });
  }

  async goOffline(): Promise<void> {
    this.stop();
    await api.setDriverStatus(this.opts.apiUrl, this.opts.token, { status: "OFFLINE" });
    this.log("offline");
  }

  /** Tear down without telling the server (network-drop simulation). */
  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers.clear();
    this.socket?.disconnect();
    this.socket = undefined;
    this.phase = "OFFLINE";
  }

  private connectSocket() {
    const socket = io(`${this.opts.apiUrl}${SOCKET_NAMESPACES.DRIVER}`, {
      transports: ["websocket"],
      auth: { token: this.opts.token },
      reconnection: true,
      reconnectionDelay: 500,
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.log("socket:connected");
      this.flushOfflineQueue().catch((e) => this.log("flush:error", String(e)));
    });
    socket.on("disconnect", (reason) => this.log("socket:disconnected", reason));
    socket.on("connect_error", (err) => this.log("socket:connect_error", err.message));

    socket.on(DRIVER_EVENTS.OFFER_NEW, (offer: OfferNewDto) => this.onOffer(offer));
    socket.on(DRIVER_EVENTS.TRIPBOARD_NEW, (item: TripBoardItemDto) => {
      this.receivedBoardItems.push(item);
      this.log("tripboard:new", { tripId: item.tripId, distM: item.distanceToPickupM });
    });
    socket.on(DRIVER_EVENTS.QUICK_MESSAGE, (m: { tripId: string; message: string; from: string }) => {
      this.receivedMessages.push(m);
      this.log("trip:message", m);
    });
    socket.on(DRIVER_EVENTS.OFFER_WITHDRAWN, (w: OfferWithdrawnDto) => {
      this.log("offer:withdrawn", w);
      if (this.phase === "CONSIDERING") this.phase = "IDLE";
    });
    socket.on(DRIVER_EVENTS.TRIP_UPDATE, (u: { tripId: string; status: string }) => {
      this.log("trip:update", u);
      if (
        this.activeTrip?.tripId === u.tripId &&
        ["CANCELLED_BY_PASSENGER", "CANCELLED_BY_DRIVER", "FAILED"].includes(u.status)
      ) {
        this.activeTrip = undefined;
        this.clearTarget();
        this.phase = "IDLE";
      }
    });
    socket.on(DRIVER_EVENTS.STATUS_CHANGED, (s: { status: string; reason?: string }) => {
      this.log("status:forced", s);
      if (s.status === "OFFLINE") this.stop();
    });
  }

  private onOffer(offer: OfferNewDto) {
    this.receivedOffers.push(offer);
    this.log("offer:new", {
      tripId: offer.tripId,
      seq: offer.offerSeq,
      distM: offer.distanceToPickupM,
      fare: offer.estimatedFare,
    });
    const behavior = this.behavior;
    if (behavior.kind === "ignore") {
      this.log("offer:ignoring (server TTL must expire it)");
      return;
    }
    this.phase = "CONSIDERING";
    const delay = behavior.delayMs ?? 2000;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (behavior.kind === "accept") this.acceptOffer(offer);
      else this.declineOffer(offer);
    }, delay);
    this.pendingTimers.add(timer);
  }

  private acceptOffer(offer: OfferNewDto) {
    this.socket?.emit(
      DRIVER_EVENTS.OFFER_ACCEPT,
      { tripId: offer.tripId, offerSeq: offer.offerSeq },
      (result: OfferAcceptResult) => {
        this.log("offer:accept:ack", result.ok ? { ok: true } : result);
        if (result.ok && result.trip) {
          this.activeTrip = {
            tripId: offer.tripId,
            pickup: offer.pickup,
            drop: offer.drop,
          };
          this.phase = "TO_PICKUP";
          void this.setDestination(offer.pickup); // drive the roads to pickup
        } else {
          this.phase = "IDLE";
        }
      },
    );
  }

  /** Test hook: raw accept emit, bypassing the behavior policy (idempotency/race tests). */
  emitAccept(tripId: string, offerSeq: number): Promise<OfferAcceptResult> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) return reject(new Error("socket not connected"));
      this.socket.emit(DRIVER_EVENTS.OFFER_ACCEPT, { tripId, offerSeq }, (result: OfferAcceptResult) =>
        resolve(result),
      );
    });
  }

  private declineOffer(offer: OfferNewDto) {
    this.declinedOffers++;
    this.socket?.emit(
      DRIVER_EVENTS.OFFER_DECLINE,
      { tripId: offer.tripId, offerSeq: offer.offerSeq },
      (result: { ok: boolean }) => this.log("offer:decline:ack", result),
    );
    this.phase = "IDLE";
  }

  private startPinging() {
    this.pingTimer = setInterval(() => {
      this.tick().catch((e) => this.log("tick:error", String(e)));
    }, this.pingIntervalMs);
  }

  /** One simulation step: move, then report position. */
  private async tick(): Promise<void> {
    this.move();
    const ping = {
      lat: this.position.lat,
      lng: this.position.lng,
      recordedAt: Date.now(),
    };
    if (this.muted) return;
    if (this.socket?.connected) {
      this.socket.emit(DRIVER_EVENTS.LOCATION, ping);
    } else {
      // Flaky-3G path: queue and flush over HTTP on reconnect (spec §7).
      this.offlineQueue.push(ping);
      if (this.offlineQueue.length >= 12) await this.flushOfflineQueue();
    }
    await this.maybeAdvanceTrip();
  }

  private async flushOfflineQueue(): Promise<void> {
    if (this.offlineQueue.length === 0) return;
    const batch = this.offlineQueue.splice(0, this.offlineQueue.length);
    try {
      await api.postLocationBatch(this.opts.apiUrl, this.opts.token, batch);
      this.log("locations:flushed", { count: batch.length });
    } catch (e) {
      this.offlineQueue.unshift(...batch);
      throw e;
    }
  }

  /**
   * Resolve the road route from the current position to `target` (OSRM) and
   * start following it. Falls back to a straight line when OSRM is unset or
   * unreachable, so tests keep their fast, deterministic movement.
   */
  private async setDestination(target: LatLng): Promise<void> {
    this.target = target;
    const path = await this.fetchRoute(this.position, target);
    // Guard against a cancellation/re-target that happened during the fetch.
    if (this.target === target) {
      this.path = path;
      this.pathIdx = 0;
    }
  }

  private async fetchRoute(from: LatLng, to: LatLng): Promise<LatLng[]> {
    if (!this.opts.osrmUrl) return [to];
    try {
      const url = `${this.opts.osrmUrl}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`OSRM ${res.status}`);
      const json = (await res.json()) as {
        routes?: Array<{ geometry?: { coordinates: [number, number][] } }>;
      };
      const coords = json.routes?.[0]?.geometry?.coordinates;
      if (!coords || coords.length < 2) return [to];
      return coords.map(([lng, lat]) => ({ lat, lng }));
    } catch {
      return [to]; // OSRM down → straight line, movement never blocks
    }
  }

  private clearTarget() {
    this.target = undefined;
    this.path = undefined;
    this.pathIdx = 0;
  }

  private move() {
    if (this.target && this.path && this.path.length > 0) {
      // Walk `step` metres along the road polyline this tick.
      let remaining = this.speedMps * (this.pingIntervalMs / 1000);
      while (remaining > 0 && this.pathIdx < this.path.length) {
        const next = this.path[this.pathIdx]!;
        const d = haversineM(this.position, next);
        if (d <= remaining) {
          this.position = { ...next };
          remaining -= d;
          this.pathIdx++;
        } else {
          const f = remaining / d;
          this.position = {
            lat: this.position.lat + (next.lat - this.position.lat) * f,
            lng: this.position.lng + (next.lng - this.position.lng) * f,
          };
          remaining = 0;
        }
      }
      // Road geometry ends snapped to the nearest road; final hop to the exact
      // target so arrival detection (25 m) fires reliably.
      if (this.pathIdx >= this.path.length) this.position = { ...this.target };
    } else if (this.target) {
      // No road path yet (fetch pending / OSRM off): straight-line toward target.
      const dist = haversineM(this.position, this.target);
      const step = this.speedMps * (this.pingIntervalMs / 1000);
      if (dist <= step || dist <= ARRIVE_THRESHOLD_M) {
        this.position = { ...this.target };
      } else {
        const f = step / dist;
        this.position = {
          lat: this.position.lat + (this.target.lat - this.position.lat) * f,
          lng: this.position.lng + (this.target.lng - this.position.lng) * f,
        };
      }
    } else if (this.idleDriftM > 0 && this.phase === "IDLE") {
      const degPerM = 1 / 111_195;
      this.position = {
        lat: this.position.lat + (Math.random() - 0.5) * 2 * this.idleDriftM * degPerM,
        lng: this.position.lng + (Math.random() - 0.5) * 2 * this.idleDriftM * degPerM,
      };
    }
  }

  private async maybeAdvanceTrip(): Promise<void> {
    if (!this.activeTrip || !this.target) return;
    const arrived = haversineM(this.position, this.target) <= ARRIVE_THRESHOLD_M;
    if (!arrived) return;
    const { tripId, drop } = this.activeTrip;

    if (this.phase === "TO_PICKUP") {
      this.phase = "AT_PICKUP";
      this.clearTarget();
      await api.tripAction(this.opts.apiUrl, this.opts.token, tripId, {
        action: "ARRIVED",
        lat: this.position.lat,
        lng: this.position.lng,
      });
      this.log("trip:arrived", { tripId });
      // Passenger boards after a short wait, then start.
      const timer = setTimeout(async () => {
        this.pendingTimers.delete(timer);
        try {
          await api.tripAction(this.opts.apiUrl, this.opts.token, tripId, {
            action: "START",
            lat: this.position.lat,
            lng: this.position.lng,
          });
          this.log("trip:started", { tripId });
          this.phase = "ON_TRIP";
          void this.setDestination(drop); // drive the roads to the destination
        } catch (e) {
          this.log("trip:start:error", String(e));
        }
      }, this.pingIntervalMs);
      this.pendingTimers.add(timer);
    } else if (this.phase === "ON_TRIP") {
      this.clearTarget();
      await api.tripAction(this.opts.apiUrl, this.opts.token, tripId, {
        action: "COMPLETE",
        lat: this.position.lat,
        lng: this.position.lng,
      });
      this.log("trip:completed", { tripId });
      this.completedTrips.push(tripId);
      this.activeTrip = undefined;
      this.phase = "IDLE";
    }
  }
}
