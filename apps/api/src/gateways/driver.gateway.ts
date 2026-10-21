import { Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Namespace, Socket } from "socket.io";
import {
  DRIVER_EVENTS,
  LocationPingSchema,
  OfferAcceptResult,
  OfferResponseSchema,
  Role,
} from "@rukwaride/shared";
import { TokenService } from "../auth/jwt.service";
import { LocationsService } from "../locations/locations.service";
import { TripsService } from "../trips/trips.service";
import { DispatchService } from "../dispatch/dispatch.service";
import { SocketEmitter } from "./socket-emitter.service";
import { appConfig } from "../config/app-config";

interface DriverSocket extends Socket {
  data: { driverProfileId: string; userId: string };
}

// See PassengerGateway: restricted to our origins, not any origin.
@WebSocketGateway({ namespace: "/driver", cors: { origin: appConfig.webOrigins, credentials: true } })
export class DriverGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(DriverGateway.name);

  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly emitter: SocketEmitter,
    private readonly locations: LocationsService,
    private readonly trips: TripsService,
    private readonly dispatch: DispatchService,
  ) {}

  afterInit(ns: Namespace) {
    this.emitter.registerDriverNamespace(ns);
  }

  handleConnection(socket: DriverSocket) {
    try {
      const token = (socket.handshake.auth?.token ?? "") as string;
      const claims = this.tokens.verify(token);
      if (claims.role !== Role.DRIVER || !claims.driverProfileId) throw new Error("not a driver");
      socket.data.driverProfileId = claims.driverProfileId;
      socket.data.userId = claims.sub;
      void socket.join(SocketEmitter.driverRoom(claims.driverProfileId));
    } catch {
      this.logger.warn(`Rejected /driver socket ${socket.id}`);
      socket.disconnect(true);
    }
  }

  @SubscribeMessage(DRIVER_EVENTS.LOCATION)
  async onLocation(@ConnectedSocket() socket: DriverSocket, @MessageBody() body: unknown) {
    const parsed = LocationPingSchema.safeParse(body);
    if (!parsed.success) return { ok: false };
    await this.locations.ingest(socket.data.driverProfileId, parsed.data);
    return { ok: true };
  }

  @SubscribeMessage(DRIVER_EVENTS.OFFER_ACCEPT)
  async onOfferAccept(
    @ConnectedSocket() socket: DriverSocket,
    @MessageBody() body: unknown,
  ): Promise<OfferAcceptResult> {
    const parsed = OfferResponseSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "BAD_PAYLOAD" };
    return this.trips.acceptOffer(socket.data.driverProfileId, parsed.data.tripId, parsed.data.offerSeq);
  }

  @SubscribeMessage(DRIVER_EVENTS.OFFER_DECLINE)
  async onOfferDecline(@ConnectedSocket() socket: DriverSocket, @MessageBody() body: unknown) {
    const parsed = OfferResponseSchema.safeParse(body);
    if (!parsed.success) return { ok: false };
    return this.dispatch.declineOffer(socket.data.driverProfileId, parsed.data.tripId, parsed.data.offerSeq);
  }
}
