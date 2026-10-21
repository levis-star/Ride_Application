import { Injectable } from "@nestjs/common";
import { Namespace } from "socket.io";
import {
  DRIVER_EVENTS,
  DriverLocationBroadcast,
  OfferNewDto,
  OfferWithdrawnDto,
  PASSENGER_EVENTS,
  QuickMessageEvent,
  TripBoardItemDto,
  TripSnapshot,
} from "@rukwaride/shared";

/**
 * Central emit surface. Gateways register their namespaces here on init;
 * services emit through this instead of importing gateways (avoids cyclic DI).
 */
@Injectable()
export class SocketEmitter {
  private driverNs?: Namespace;
  private passengerNs?: Namespace;

  registerDriverNamespace(ns: Namespace) {
    this.driverNs = ns;
  }

  registerPassengerNamespace(ns: Namespace) {
    this.passengerNs = ns;
  }

  static driverRoom(driverProfileId: string): string {
    return `driver:${driverProfileId}`;
  }

  static tripRoom(tripId: string): string {
    return `trip:${tripId}`;
  }

  static userRoom(userId: string): string {
    return `user:${userId}`;
  }

  /** Cluster-wide (Redis adapter) check: does this user have a live socket? */
  async isUserConnected(userId: string, driverProfileId?: string): Promise<boolean> {
    try {
      if (driverProfileId && this.driverNs) {
        const sockets = await this.driverNs.in(SocketEmitter.driverRoom(driverProfileId)).fetchSockets();
        if (sockets.length > 0) return true;
      }
      if (this.passengerNs) {
        const sockets = await this.passengerNs.in(SocketEmitter.userRoom(userId)).fetchSockets();
        return sockets.length > 0;
      }
    } catch {
      /* adapter hiccup → treat as offline so the fallback chain fires */
    }
    return false;
  }

  offerNew(driverProfileId: string, offer: OfferNewDto) {
    this.driverNs?.to(SocketEmitter.driverRoom(driverProfileId)).emit(DRIVER_EVENTS.OFFER_NEW, offer);
  }

  offerWithdrawn(driverProfileId: string, payload: OfferWithdrawnDto) {
    this.driverNs?.to(SocketEmitter.driverRoom(driverProfileId)).emit(DRIVER_EVENTS.OFFER_WITHDRAWN, payload);
  }

  tripBoardNew(driverProfileId: string, item: TripBoardItemDto) {
    this.driverNs?.to(SocketEmitter.driverRoom(driverProfileId)).emit(DRIVER_EVENTS.TRIPBOARD_NEW, item);
  }

  quickMessageToDriver(driverProfileId: string, ev: QuickMessageEvent) {
    this.driverNs?.to(SocketEmitter.driverRoom(driverProfileId)).emit(DRIVER_EVENTS.QUICK_MESSAGE, ev);
  }

  quickMessageToPassenger(tripId: string, ev: QuickMessageEvent) {
    this.passengerNs?.to(SocketEmitter.tripRoom(tripId)).emit(PASSENGER_EVENTS.QUICK_MESSAGE, ev);
  }

  tripUpdateToDriver(driverProfileId: string, snapshot: Partial<TripSnapshot> & { tripId: string }) {
    this.driverNs?.to(SocketEmitter.driverRoom(driverProfileId)).emit(DRIVER_EVENTS.TRIP_UPDATE, snapshot);
  }

  driverStatusChanged(driverProfileId: string, status: string, reason?: string) {
    this.driverNs?.to(SocketEmitter.driverRoom(driverProfileId)).emit(DRIVER_EVENTS.STATUS_CHANGED, { status, reason });
  }

  tripUpdateToPassenger(tripId: string, snapshot: Partial<TripSnapshot> & { tripId: string }) {
    this.passengerNs?.to(SocketEmitter.tripRoom(tripId)).emit(PASSENGER_EVENTS.TRIP_UPDATE, snapshot);
  }

  driverLocationToPassenger(tripId: string, loc: DriverLocationBroadcast) {
    this.passengerNs?.to(SocketEmitter.tripRoom(tripId)).emit(PASSENGER_EVENTS.DRIVER_LOCATION, loc);
  }
}
